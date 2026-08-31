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
/**
 * One stage attempt against a real container is a fresh container plus a long
 * generation with file I/O — PLAN.md section 6 budgets 60 to 120 seconds. The
 * old 90s default sat inside that range, so a merely slow stage was cancelled
 * and held, and with maxAttempts 2 a session could fail on timing alone while
 * saying nothing about whether the schemas were satisfiable. Five minutes
 * leaves headroom for the slow end without letting a truly hung stage sit
 * forever; tests inject their own value and are unaffected.
 */
const DEFAULT_STAGE_TIMEOUT_MS = 300_000;
/**
 * Pause before re-dispatching a held stage, doubled per attempt.
 *
 * Retries used to fire with no gap at all: a real run against Ark returned 429
 * Too Many Requests, the second attempt went out 1 ms later, drew the same 429,
 * and the whole session was dead in 1.5 seconds. A transient upstream fault
 * must not be able to burn the entire retry budget faster than the API can
 * recover. This does not apply to a schema rejection needing no wait — but the
 * coordinator cannot tell the two apart, and waiting two seconds on a genuine
 * violation costs nothing next to failing a demo.
 */
const DEFAULT_RETRY_BACKOFF_MS = 2_000;
/** How often the backoff wakes to notice a stop(). */
const BACKOFF_POLL_MS = 100;

export interface CoordinatorDeps {
  agents: AgentService;
  sessions: SessionStore;
  schemas: SchemaRegistry;
  broker: ArtifactBroker;
  workspacePathFor(agentId: string): string;
  /** How often to poll getRun while a stage is in flight. Default 500. */
  pollIntervalMs?: number | undefined;
  /** Deadline for one stage attempt before cancel + hold. Default 300_000. */
  stageTimeoutMs?: number | undefined;
  /**
   * Pause before re-dispatching a held stage, doubled per attempt. Default
   * 2_000. Set 0 to retry immediately, which is what the tests do.
   */
  retryBackoffMs?: number | undefined;
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

        // Give a struggling upstream room to recover before spending the next
        // attempt. Skipped after the final one, which has nothing to wait for.
        if (attempt < stage.maxAttempts) {
          await this.backoff(sessionId, attempt);
        }
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
      // The only sourceIds the schemas will accept.
      sourceManifest: session.sourceManifest,
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
      priorBySchemaId: this.priorBySchemaId(sessionId),
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
      // The value the gate actually admitted. Later stages validate against
      // this, never against the workspace's current contents.
      // Tolerates sessions persisted before this field existed.
      current.sharedState.artifactValues ??= {};
      current.sharedState.artifactValues[stage.id] = validation.value;
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
   * Waits before the next attempt on a held stage, doubling per attempt.
   *
   * Wakes every BACKOFF_POLL_MS so a stop() lands promptly instead of sitting
   * out the whole pause — a session being cancelled must not appear hung.
   */
  private async backoff(sessionId: string, attempt: number): Promise<void> {
    const base = this.deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    if (base <= 0) return;

    const totalMs = base * Math.pow(2, attempt - 1);
    for (let waited = 0; waited < totalMs; waited += BACKOFF_POLL_MS) {
      if (this.stopRequests.has(sessionId)) return;
      const remaining = Math.min(BACKOFF_POLL_MS, totalMs - waited);
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
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

  /**
   * ValidationContext.priorBySchemaId, which schemas/index.ts documents as
   * "schemaId -> the parsed artifact admitted by the stage that used that schema".
   *
   * This previously returned the Artifact metadata records instead, so a schema
   * reaching for admitted content (summary.ts for stage 1's claim ids,
   * report.ts for stage 2's key points) found undefined and, failing closed,
   * rejected every input. Sessions could never get past stage 2.
   */
  private priorBySchemaId(sessionId: string): Record<string, unknown> {
    const session = this.deps.sessions.require(sessionId);
    const values = session.sharedState.artifactValues ?? {};
    const result: Record<string, unknown> = {};
    // sharedState is keyed by stage id, but a schema depends on an upstream
    // shape, not on this pipeline's naming. Walking stages in order also means
    // a reused schema resolves to its most recently admitted artifact.
    for (const stage of session.stages) {
      if (stage.id in values) {
        result[stage.schemaId] = values[stage.id];
      }
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
