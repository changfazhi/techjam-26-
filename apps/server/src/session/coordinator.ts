/**
 * The stage loop: dispatch, validate, admit or hold, retry within budget.
 * Owned by W2 (Coordinator). See docs/BLUEPRINT.md section 6.
 *
 * Invariants this module upholds:
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

type StageResult = { outcome: "ADMIT" } | { outcome: "HOLD"; violations: string[] };

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
   * coordinator and its tests do not depend on W4's implementation landing first.
   */
  buildPrompt?: ((input: PromptInput) => string) | undefined;
}

export class SessionCoordinator {
  /** sessionId -> a promise that settles when its drive loop finishes. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly stopRequests = new Set<string>();

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

    // Reserve synchronously, before the first await, so two concurrent starts
    // cannot both pass the guard above.
    let release!: () => void;
    this.running.set(
      sessionId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

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
        release();
      });

    return session;
  }

  /**
   * Administrative stop. Cancels the in-flight run, waits for the drive loop to
   * notice, and parks the session. Artifacts admitted so far are kept.
   */
  async stop(sessionId: string): Promise<Session> {
    const session = this.deps.sessions.require(sessionId);
    this.stopRequests.add(sessionId);
    try {
      // Settle whatever run is in flight so the poll loop returns promptly.
      const inFlightStage = session.stages[session.sharedState.currentStageIndex];
      if (inFlightStage) {
        await this.recoverAgent(inFlightStage.agentId);
      }
      const inFlight = this.running.get(sessionId);
      if (inFlight) {
        await inFlight;
      }
    } finally {
      this.stopRequests.delete(sessionId);
    }

    return this.deps.sessions.update(sessionId, (current) => {
      if (current.state === "running" || current.state === "idle") {
        current.state = "stopped";
      }
    });
  }

  /** Walks the stage list, retrying each stage within its own budget. */
  private async drive(sessionId: string): Promise<void> {
    const stageCount = this.deps.sessions.require(sessionId).stages.length;

    for (let stageIndex = 0; stageIndex < stageCount; stageIndex += 1) {
      if (this.stopRequests.has(sessionId)) return;

      const stage = this.deps.sessions.require(sessionId).stages[stageIndex];
      if (!stage) {
        throw new Error("No stage at index " + String(stageIndex));
      }

      let admitted = false;
      let violations: string[] = [];
      for (let attempt = 1; attempt <= stage.maxAttempts; attempt += 1) {
        if (this.stopRequests.has(sessionId)) return;
        const result = await this.runStage(sessionId, stageIndex, attempt, violations);
        if (result.outcome === "ADMIT") {
          admitted = true;
          break;
        }
        violations = result.violations;
      }

      if (this.stopRequests.has(sessionId)) return;
      if (!admitted) {
        await this.deps.sessions.update(sessionId, (current) => {
          current.state = "failed";
          current.error =
            "Stage " +
            stage.id +
            " was not admitted in " +
            String(stage.maxAttempts) +
            " attempts: " +
            violations.join("; ");
        });
        return;
      }
    }

    if (this.stopRequests.has(sessionId)) return;
    await this.deps.sessions.update(sessionId, (current) => {
      current.state = "completed";
    });
    await this.emit(sessionId, "session.completed", {});
  }

  private async runStage(
    sessionId: string,
    stageIndex: number,
    attempt: number,
    priorViolations: string[],
  ): Promise<StageResult> {
    const session = this.deps.sessions.require(sessionId);
    const stage = session.stages[stageIndex];
    if (!stage) {
      throw new Error("No stage at index " + String(stageIndex));
    }
    const schema = this.deps.schemas.get(stage.schemaId);
    const workspacePath = this.deps.workspacePathFor(stage.agentId);
    const timeoutMs = this.deps.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    const startedAt = Date.now();

    await this.emit(sessionId, "stage.assigned", {}, stage, attempt, null);

    const inputContents = await this.readInput(workspacePath, stage.inputFileName);
    const prompt = (this.deps.buildPrompt ?? buildStagePrompt)({
      stage,
      schemaDescription: schema.describe(),
      priorEvents: this.deps.sessions.events(sessionId),
      inputContents,
      // What the previous attempt got wrong, so the agent can fix it.
      violations: priorViolations,
    });

    // A dispatch can legitimately fail — an operator stopped the agent, or a
    // stop() landed in the window before this call. That is a held stage, not a
    // reason to take the whole session down.
    let run: AgentRun;
    try {
      ({ run } = await this.deps.agents.sendMessage(stage.agentId, prompt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.hold(sessionId, stage, attempt, null, ["dispatch failed: " + message]);
    }

    const finished = await this.awaitRun(run.id, startedAt + timeoutMs);

    if (finished === "TIMEOUT") {
      await this.recoverAgent(stage.agentId);
      return this.hold(
        sessionId,
        stage,
        attempt,
        run.id,
        ["stage deadline exceeded after " + String(timeoutMs) + " ms"],
        "stage.timeout",
      );
    }
    if (finished.status !== "completed") {
      return this.hold(sessionId, stage, attempt, run.id, [
        finished.error ?? "run " + finished.status,
      ]);
    }

    const collected = await this.deps.broker.collect(
      workspacePath,
      stage.outputPath,
      finished.output ?? "",
    );
    if (!collected.found) {
      return this.hold(sessionId, stage, attempt, run.id, [
        "artifact missing: expected " + stage.outputPath,
      ]);
    }

    const validation = schema.validate(collected.raw, {
      priorArtifacts: this.priorArtifacts(sessionId),
      sourceManifest: session.sourceManifest,
    });
    if (!validation.ok) {
      return this.hold(sessionId, stage, attempt, run.id, validation.violations);
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
    return { outcome: "ADMIT" };
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

  /**
   * Cancel whatever the agent is doing and put it back in service.
   *
   * stopAgent leaves the agent "stopped" (agent-service.ts:123) and sendMessage
   * then rejects a stopped agent with a 409 (agent-service.ts:190). Without the
   * restart, one timeout would make that agent unusable for the rest of the run.
   */
  private async recoverAgent(agentId: string): Promise<void> {
    try {
      await this.deps.agents.stopAgent(agentId);
      await this.deps.agents.startAgent(agentId);
    } catch {
      // A failed recovery must not take the session down with it; the next
      // dispatch to this agent will surface the problem as a hold.
    }
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

  /**
   * Record a refusal. INVARIANT 5: attempts is the only sharedState field a hold
   * may touch, so a held artifact can never reach the next workspace.
   */
  private async hold(
    sessionId: string,
    stage: Stage,
    attempt: number,
    runId: string | null,
    violations: string[],
    type: "stage.rejected" | "stage.timeout" = "stage.rejected",
  ): Promise<StageResult> {
    await this.deps.sessions.update(sessionId, (current) => {
      current.sharedState.attempts[stage.id] =
        (current.sharedState.attempts[stage.id] ?? 0) + 1;
    });
    await this.emit(sessionId, type, { violations }, stage, attempt, runId);
    return { outcome: "HOLD", violations };
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
