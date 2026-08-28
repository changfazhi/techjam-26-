export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}

// ---------------------------------------------------------------------------
// Handoff Gate — session pipeline types.
// APPEND-ONLY. Mirrors apps/server/src/session/types.ts. Do not edit above.
// ---------------------------------------------------------------------------

export type SessionState = "idle" | "running" | "completed" | "failed" | "stopped";

export type SessionEventType =
  | "session.started"
  | "stage.assigned"
  | "stage.completed"
  | "stage.rejected"
  | "stage.timeout"
  | "session.completed";

export interface Stage {
  id: string;
  role: string;
  agentId: string;
  schemaId: string;
  outputPath: string;
  inputFileName: string | null;
  instruction: string;
  maxAttempts: number;
}

export interface Artifact {
  stageId: string;
  path: string;
  hash: string;
  bytes: number;
  validatedAt: string;
}

export interface SharedState {
  currentStageIndex: number;
  artifacts: Record<string, Artifact>;
  attempts: Record<string, number>;
}

export interface Session {
  id: string;
  title: string;
  topic: string;
  stages: Stage[];
  sourceManifest: string[];
  state: SessionState;
  sharedState: SharedState;
  version: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  seq: number;
  stageId: string | null;
  agentId: string | null;
  runId: string | null;
  type: SessionEventType;
  attempt: number | null;
  payload: {
    violations?: string[];
    artifactHash?: string;
    durationMs?: number;
    message?: string;
  };
  createdAt: string;
}

export interface CreateSessionInput {
  title: string;
  topic: string;
  stages: Array<Omit<Stage, "maxAttempts"> & { maxAttempts?: number }>;
  sources: Array<{ name: string; content: string }>;
}
