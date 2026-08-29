/**
 * The stage loop: dispatch, validate, admit or hold, retry within budget.
 * Owned by W2 (Coordinator). See docs/BLUEPRINT.md section 6.
 *
 * Step 1 implements the happy path. Retries, timeouts, and stop() are step 2 and
 * are marked below.
 *
 * Invariants this module must uphold:
 *   5. On a HOLD, sharedState and version are unchanged; only attempts[] moves.
 *   6. version increases by exactly 1 per admitted artifact.
 *   7. A stage runs only once its predecessor has an entry in sharedState.artifacts.
 *   8. No secret value reaches a SessionEvent, an artifact record, or a response.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentService } from "../agent-service.js";
import { HttpError } from "../errors.js";
import type { AgentRun } from "../types.js";
import { hashArtifact, type ArtifactBroker } from "./broker.js";
import { buildStagePrompt, type PromptInput } from "./prompt.js";
import type { SchemaRegistry } from "./schemas/index.js";
import type { SessionStore } from "./session-store.js";
import type { Artifact, Session, SessionEventType, Stage } from "./types.js";

type Outcome = "ADMIT" | "HOLD";

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_STAGE_TIMEOUT_MS = 90_000;

export interface CoordinatorDeps {
  agents: AgentService;
  sessions: SessionStore;
  schemas: SchemaRegistry;
  broker: ArtifactBroker;
  workspacePathFor(agentId: string): string;
  /** How often to poll getRun while a stage is in flight. Default 500. */
  pollIntervalMs?: number | undefined;
  /** Deadline for one stage attempt before cancel + hold. Default 90_000. */
  stageTimeoutMs?: number | undefined;
  /**
   * Prompt assembly. Defaults to W4's buildStagePrompt; injectable so the
   * coordinator's tests do not depend on W4's implementation landing first.
   */
  buildPrompt?: ((input: PromptInput) => string) | undefined;
}

export class SessionCoordinator {
  private readonly running = new Set<string>();

  constructor(private readonly deps: CoordinatorDeps) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Fire-and-forget, mirroring AgentService.sendMessage. */
  async start(sessionId: string): Promise<Session> {
    this.deps.sessions.require(sessionId);
    if (this.running.has(sessionId)) {
      throw new HttpError(409, "This session is already running");
    }
    this.running.add(sessionId);

    const session = await this.deps.sessions.update(sessionId, (current) => {
      current.state = "running";
      current.error = null;
    });
    await this.emit(sessionId, "session.started", {});

    void this.drive(sessionId)
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.sessions
          .update(sessionId, (current) => {
            current.state = "failed";
            current.error = message;
          })
          .catch(() => undefined);
      })
      .finally(() => {
        this.running.delete(sessionId);
      });

    return session;
  }

  /** Cancels the in-flight run and parks the session as "stopped". */
  async stop(_sessionId: string): Promise<Session> {
    throw new Error("not implemented: W2 step 2 (coordinator.stop)");
  }

  /** Walks the stage list. One attempt per stage in step 1. */
  private async drive(sessionId: string): Promise<void> {
    const stageCount = this.deps.sessions.require(sessionId).stages.length;

    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      const outcome = await this.runStage(sessionId, stageIndex, 1);
      if (outcome !== "ADMIT") {
        await this.deps.sessions.update(sessionId, (current) => {
          current.state = "failed";
          current.error = "Stage " + String(stageIndex) + " was not admitted";
        });
        return;
      }
    }

    await this.deps.sessions.update(sessionId, (current) => {
      current.state = "completed";
    });
    await this.emit(sessionId, "session.completed", {});
  }

  private async runStage(
    sessionId: string,
    stageIndex: number,
    attempt: number,
  ): Promise<Outcome> {
    const session = this.deps.sessions.require(sessionId);
    const stage = session.stages[stageIndex];
    if (!stage) {
      throw new Error("No stage at index " + String(stageIndex));
    }
    const schema = this.deps.schemas.get(stage.schemaId);
    const workspacePath = this.deps.workspacePathFor(stage.agentId);
    const startedAt = Date.now();

    await this.emit(sessionId, "stage.assigned", {}, stage, attempt, null);

    const inputContents = await this.readInput(workspacePath, stage.inputFileName);
    const prompt = (this.deps.buildPrompt ?? buildStagePrompt)({
      stage,
      schemaDescription: schema.describe(),
      priorEvents: this.deps.sessions.events(sessionId),
      inputContents,
      violations: [],
    });

    const { run } = await this.deps.agents.sendMessage(stage.agentId, prompt);
    const finished = await this.awaitRun(
      run.id,
      startedAt + (this.deps.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS),
    );

    // Step 2 replaces this branch with stopAgent + startAgent recovery and a
    // stage.timeout event. agent-service.ts:190 rejects a stopped agent, so the
    // restart is mandatory there.
    if (finished === "TIMEOUT") {
      await this.hold(sessionId, stage, attempt, run.id, ["stage deadline exceeded"]);
      return "HOLD";
    }
    if (finished.status !== "completed") {
      await this.hold(sessionId, stage, attempt, run.id, [
        finished.error ?? "run " + finished.status,
      ]);
      return "HOLD";
    }

    const collected = await this.deps.broker.collect(
      workspacePath,
      stage.outputPath,
      finished.output ?? "",
    );
    if (!collected.found) {
      await this.hold(sessionId, stage, attempt, run.id, [
        "artifact missing: expected " + stage.outputPath,
      ]);
      return "HOLD";
    }

    const validation = schema.validate(collected.raw, {
      priorArtifacts: this.priorArtifacts(sessionId),
      sourceManifest: session.sourceManifest,
    });
    if (!validation.ok) {
      await this.hold(sessionId, stage, attempt, run.id, validation.violations);
      return "HOLD";
    }

    const artifact = await this.admitArtifact(
      collected.raw,
      stage,
      session.stages[stageIndex + 1],
      path.resolve(workspacePath, stage.outputPath),
    );

    // INVARIANT 5 and 6: the only place artifacts and version are written.
    await this.deps.sessions.update(sessionId, (current) => {
      current.sharedState.artifacts[stage.id] = artifact;
      current.sharedState.currentStageIndex = stageIndex + 1;
      current.version += 1;
    });

    await this.emit(
      sessionId,
      "stage.completed",
      { artifactHash: artifact.hash, durationMs: Date.now() - startedAt },
      stage,
      attempt,
      run.id,
    );
    return "ADMIT";
  }

  /**
   * Deliver into the next stage's workspace, or merely record the artifact when
   * this was the final stage. INVARIANT 4: reached only after a valid result.
   */
  private async admitArtifact(
    raw: string,
    stage: Stage,
    nextStage: Stage | undefined,
    sourcePath: string,
  ): Promise<Artifact> {
    if (!nextStage || !nextStage.inputFileName) {
      return hashArtifact(raw, stage.id, sourcePath);
    }
    return this.deps.broker.deliver(
      raw,
      stage.id,
      sourcePath,
      this.deps.workspacePathFor(nextStage.agentId),
      nextStage.inputFileName,
    );
  }

  /** Poll getRun until it settles or the deadline passes. */
  private async awaitRun(runId: string, deadlineAt: number): Promise<AgentRun | "TIMEOUT"> {
    const interval = this.deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    for (;;) {
      const run = this.deps.agents.getRun(runId);
      if (run.status !== "queued" && run.status !== "running") {
        return run;
      }
      if (Date.now() >= deadlineAt) {
        return "TIMEOUT";
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  private async readInput(
    workspacePath: string,
    inputFileName: string | null,
  ): Promise<string | null> {
    if (!inputFileName) {
      return null;
    }
    try {
      return await readFile(path.resolve(workspacePath, inputFileName), "utf8");
    } catch {
      return null;
    }
  }

  private priorArtifacts(sessionId: string): Record<string, unknown> {
    const session = this.deps.sessions.require(sessionId);
    const result: Record<string, unknown> = {};
    for (const [stageId, artifact] of Object.entries(session.sharedState.artifacts)) {
      result[stageId] = artifact;
    }
    return result;
  }

  /** INVARIANT 5: records the refusal without touching the artifact chain. */
  private async hold(
    sessionId: string,
    stage: Stage,
    attempt: number,
    runId: string,
    violations: string[],
  ): Promise<void> {
    await this.emit(sessionId, "stage.rejected", { violations }, stage, attempt, runId);
  }

  private async emit(
    sessionId: string,
    type: SessionEventType,
    payload: { violations?: string[]; artifactHash?: string; durationMs?: number },
    stage?: Stage,
    attempt?: number,
    runId?: string | null,
  ): Promise<void> {
    await this.deps.sessions.appendEvent({
      sessionId,
      stageId: stage?.id ?? null,
      agentId: stage?.agentId ?? null,
      runId: runId ?? null,
      type,
      attempt: attempt ?? null,
      payload,
    });
  }
}
