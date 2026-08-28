/**
 * Handoff Gate — session and pipeline types.
 *
 * Owned by W1 (Foundation). See docs/BLUEPRINT.md section 4.
 * This module deliberately does not import from ../types.js so that the root
 * Database type can reference it without creating an import cycle.
 */

export type SessionState =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

export type SessionEventType =
  | "session.started"
  | "stage.assigned"
  | "stage.completed"
  | "stage.rejected"
  | "stage.timeout"
  | "session.completed";

/** One step of the pipeline. Declared at session creation, never mutated. */
export interface Stage {
  /** Stable identifier, for example "research". */
  id: string;
  /** Human label, for example "Researcher". */
  role: string;
  /** The Agent that performs this stage. */
  agentId: string;
  /** Key into the SchemaRegistry. */
  schemaId: string;
  /** Path inside the agent workspace, for example "research.json". */
  outputPath: string;
  /** Filename the previous stage's artifact is delivered as, or null for the first stage. */
  inputFileName: string | null;
  /** Instruction text prepended to every prompt for this stage. */
  instruction: string;
  /** Attempts allowed before the session fails. */
  maxAttempts: number;
}

/** A validated artifact produced by a stage. */
export interface Artifact {
  stageId: string;
  /** Absolute path inside the producing agent's workspace. */
  path: string;
  /** sha256 hex of the raw bytes. */
  hash: string;
  bytes: number;
  validatedAt: string;
}

/** The only state the coordinator advances. Guarded by Session.version. */
export interface SharedState {
  currentStageIndex: number;
  /** stageId -> Artifact. */
  artifacts: Record<string, Artifact>;
  /** stageId -> attempts consumed. */
  attempts: Record<string, number>;
}

export interface Session {
  id: string;
  title: string;
  topic: string;
  stages: Stage[];
  /** Filenames seeded into the first stage's workspace. */
  sourceManifest: string[];
  state: SessionState;
  sharedState: SharedState;
  /** Monotonic. Incremented once per admitted artifact. */
  version: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEventPayload {
  violations?: string[] | undefined;
  artifactHash?: string | undefined;
  durationMs?: number | undefined;
  message?: string | undefined;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  /** 1-based, monotonic and gapless within one session. */
  seq: number;
  stageId: string | null;
  agentId: string | null;
  runId: string | null;
  type: SessionEventType;
  /** 1-based attempt number for stage.* events, null otherwise. */
  attempt: number | null;
  payload: SessionEventPayload;
  createdAt: string;
}

/** A source document seeded into the first stage's workspace. */
export interface SessionSource {
  name: string;
  content: string;
}

export interface CreateStageInput {
  id: string;
  role: string;
  agentId: string;
  schemaId: string;
  outputPath: string;
  inputFileName: string | null;
  instruction: string;
  maxAttempts?: number | undefined;
}

export interface CreateSessionInput {
  title: string;
  topic: string;
  stages: CreateStageInput[];
  sources: SessionSource[];
}

/** Event shape accepted by SessionStore.appendEvent; seq and id are assigned by the store. */
export type NewSessionEvent = Omit<SessionEvent, "id" | "seq" | "createdAt">;
