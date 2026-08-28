/**
 * The stage loop: dispatch, validate, admit or hold, retry within budget.
 * Owned by W2 (Coordinator). See docs/BLUEPRINT.md section 6.
 *
 * STUB — W2 implements.
 *
 * Invariants this module must uphold:
 *   5. On a HOLD, sharedState and version are unchanged; only attempts[] moves.
 *   6. version increases by exactly 1 per admitted artifact.
 *   7. A stage runs only once its predecessor has an entry in sharedState.artifacts.
 *   8. No secret value reaches a SessionEvent, an artifact record, or a response.
 */

import type { AgentService } from "../agent-service.js";
import type { ArtifactBroker } from "./broker.js";
import type { SchemaRegistry } from "./schemas/index.js";
import type { SessionStore } from "./session-store.js";
import type { Session } from "./types.js";

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
}

export class SessionCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /** Fire-and-forget. Throws HttpError(409) when the session is already running. */
  async start(_sessionId: string): Promise<Session> {
    throw new Error("not implemented: W2 (coordinator.ts)");
  }

  /** Cancels the in-flight run and parks the session as "stopped". */
  async stop(_sessionId: string): Promise<Session> {
    throw new Error("not implemented: W2 (coordinator.ts)");
  }

  isRunning(_sessionId: string): boolean {
    return false;
  }
}
