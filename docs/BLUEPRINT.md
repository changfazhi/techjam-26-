# Handoff Gate — Architecture Blueprint

**Purpose of this document.** A precise, self-contained specification of what we are
building, written so that a teammate *or an AI coding assistant* can be handed one section
and produce correct code without reading the rest of the codebase first.

Conventions used here:
- File paths are repo-relative and exact.
- `file.ts:NN` means a specific line in the current code.
- Type definitions are copy-pasteable and authoritative.
- **INVARIANT n** statements are testable and must never be violated.

---

## 1. Orientation

### 1.1 What this repo is

`volc-agent-launchpad` — a single-node Agent platform. A React UI talks to a Fastify control
plane, which stores everything in one JSON file and runs each agent turn as a disposable
container executing the Codex CLI.

```
apps/web/      React 19 + Vite UI              (~730 lines of TS/TSX)
apps/server/   Fastify control plane           (~1,100 lines of TS)
workspaces/    One directory per agent
codex-home/    Codex config + resumable sessions
.data/         launchpad.json — the entire database
```

### 1.2 What we are adding

One new subsystem, `apps/server/src/session/`, that coordinates several agents through a
staged pipeline and validates every handoff between them.

### 1.3 What is off-limits

Do not modify these files beyond the single lines named in §7.1. They are the starter kit's
baseline and the hackathon brief forbids rebuilding them:

- `apps/server/src/agent-service.ts` — **zero changes**
- `apps/server/src/codex-runner.ts` — **zero changes**
- `apps/server/src/container-codex-runner.ts` — **zero changes**
- `apps/server/src/workspace.ts` — **zero changes**
- `apps/web/src/App.tsx` — one insertion point only

### 1.4 Dependency policy

**No new npm dependencies.** `zod` (v4) is already a dependency of `@launchpad/server` and is
all the validation we need. Adding packages creates `package-lock.json` merge conflicts, which
is the single most disruptive thing a five-person team can do to itself in three days.

---

## 2. Facts about the existing code

These five facts constrain every design decision. Verify them before contradicting them.

**F1 — Agent workspaces are sealed from each other.**
`apps/server/src/container-codex-runner.ts:79-84` bind-mounts exactly two paths into the
runtime container: the acting agent's own workspace at `/workspace`, and `codex-home` at
`/codex-home`. Agent B cannot read Agent A's files by any means.

**F2 — The server never calls a model API.**
`spawn(containerEngine, args)` at `container-codex-runner.ts:145` launches Codex CLI, which
talks to Ark itself using `codex-home/config.toml` written by `config.ts:103`. The server only
parses NDJSON from stdout.

**F3 — Agent replies are free text.**
`parseCodexEventLine` (`codex-runner.ts:44-87`) collects `item.completed` events of type
`agent_message`. `RunnerResult.output` is the last such message, unstructured.

**F4 — One run per agent is already enforced atomically.**
`agent-service.ts:185-203` performs the status check and the `busy` transition inside a single
`store.mutate` callback. A second concurrent `sendMessage` throws `HttpError(409)`.

**F5 — Runs are asynchronous and fire-and-forget.**
`sendMessage` returns `{ run, message }` immediately with `run.status === "queued"`. There is
no promise to await. Completion is observed by polling `getRun(runId)` until `status` leaves
`{"queued","running"}`. `agent-service.test.ts:76` uses exactly this pattern.

**F7 — `RUNTIME_PROVIDER=mock` reports itself inaccurately in `/api/system`.**
`agent-service.ts:228` branches only on `"container"`, so mock mode is described as
"Codex CLI in application container". Cosmetic, dev-only, and not worth an edit to a
baseline file we have committed to leaving alone.

**F6 — `JsonStore` is a single-process, whole-file, serialized store.**
`store.ts:39-50` clones, mutates, persists, then swaps. `store.ts:23` rejects any file whose
`version !== 1`.

---

## 3. Module map

```
apps/server/src/
├── types.ts                      MODIFIED once (Database gains 2 arrays) — then frozen
├── store.ts                      MODIFIED once (defaulting fix)          — then frozen
├── app.ts                        MODIFIED once (one register() call)     — then frozen
├── index.ts                      MODIFIED once (construct + inject)      — then frozen
├── runner-factory.ts             MODIFIED once (mock branch)             — then frozen
├── config.ts                     MODIFIED once (RUNTIME_PROVIDER=mock)   — then frozen
├── mock-runner.ts                NEW  — deterministic runner for dev and tests
└── session/                      NEW  — the entire middleware
    ├── types.ts                  Session, SessionEvent, Stage, artifacts, inputs
    ├── session-store.ts          Typed accessors over JsonStore
    ├── coordinator.ts            The stage loop
    ├── broker.ts                 Artifact collection, hashing, delivery
    ├── prompt.ts                 Prompt assembly (instruction + schema + digest)
    ├── routes.ts                 Fastify plugin: 5 routes
    ├── schemas/
    │   ├── index.ts              SchemaRegistry
    │   ├── research.ts           Stage 1 schema + admission rule
    │   ├── summary.ts            Stage 2 schema + admission rule  ← the citation gate
    │   ├── report.ts             Stage 3 schema + admission rule
    │   └── redaction.ts          Cross-cutting credential scan
    ├── coordinator.test.ts
    ├── schemas.test.ts
    └── routes.test.ts

apps/web/src/
├── App.tsx                       MODIFIED once (button + state + mount)  — then frozen
├── api.ts                        APPEND-ONLY (new `pipelineApi` export)
├── types.ts                      APPEND-ONLY (mirror of session types)
└── pipeline/                     NEW
    ├── PipelinePanel.tsx
    ├── StageTimeline.tsx
    ├── ArtifactViewer.tsx
    ├── usePipeline.ts
    └── pipeline.css
```

---

## 4. Data model

All of the following lives in `apps/server/src/session/types.ts`.

```ts
export type SessionState = "idle" | "running" | "completed" | "failed" | "stopped";

export type SessionEventType =
  | "session.started"
  | "stage.assigned"
  | "stage.completed"
  | "stage.rejected"
  | "stage.timeout"
  | "session.completed";

/** One step of the pipeline. Declared at session creation, never mutated. */
export interface Stage {
  id: string;            // "research" | "summary" | "report"
  role: string;          // human label, e.g. "Researcher"
  agentId: string;       // the Agent that performs this stage
  schemaId: string;      // key into SchemaRegistry
  outputPath: string;    // path inside the agent workspace, e.g. "research.json"
  inputFileName: string | null; // filename the PREVIOUS artifact is delivered as, or null
  maxAttempts: number;   // default 2
}

/** A validated artifact produced by a stage. */
export interface Artifact {
  stageId: string;
  path: string;          // absolute path inside the producing agent's workspace
  hash: string;          // sha256 hex of the raw bytes
  bytes: number;
  validatedAt: string;   // ISO 8601
}

/** The only state the coordinator advances. Guarded by `version`. */
export interface SharedState {
  currentStageIndex: number;
  artifacts: Record<string, Artifact>;   // stageId -> Artifact
  attempts: Record<string, number>;      // stageId -> attempts consumed
}

export interface Session {
  id: string;
  title: string;
  topic: string;
  stages: Stage[];
  sourceManifest: string[];   // filenames seeded into stage 1's workspace
  state: SessionState;
  sharedState: SharedState;
  version: number;            // monotonic; incremented on every admitted artifact
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  seq: number;                // 1-based, monotonic PER SESSION
  stageId: string | null;
  agentId: string | null;
  runId: string | null;
  type: SessionEventType;
  attempt: number | null;     // 1-based attempt number for stage.* events
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
```

### 4.1 Persistence

`apps/server/src/types.ts` gains exactly two fields:

```ts
export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  sessions: Session[];            // ADDED
  sessionEvents: SessionEvent[];  // ADDED
}
```

**Required fix in `apps/server/src/store.ts`.** `initialize()` currently assigns the parsed
file directly. An existing `launchpad.json` has no `sessions` array, so `database.sessions.push`
would throw on `undefined`. Change the assignment at `store.ts:26` to spread over defaults:

```ts
this.data = { ...emptyDatabase(), ...parsed };
```

and add the two empty arrays to `emptyDatabase()`. Keep `version: 1` — this is not a schema
migration, it is defaulting for forward compatibility.

---

## 5. Interfaces between modules

These are the contracts. Each is owned by exactly one workstream and consumed by others. Once
published (day 1), a signature change requires telling the whole team.

### 5.1 `SchemaRegistry` — owned by the Schemas workstream

```ts
// apps/server/src/session/schemas/index.ts

export interface ValidationContext {
  /** stageId -> the parsed artifact admitted for that stage. */
  priorArtifacts: Record<string, unknown>;
  /** Filenames seeded into stage 1's workspace. */
  sourceManifest: string[];
}

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; violations: string[] };

export interface StageSchema {
  id: string;
  /** Human- and LLM-readable description injected verbatim into the prompt. */
  describe(): string;
  /** Parse and check. MUST NOT throw; return violations instead. */
  validate(raw: string, ctx: ValidationContext): ValidationResult;
}

export interface SchemaRegistry {
  get(schemaId: string): StageSchema;
}
```

**INVARIANT 1.** `validate` never throws. Malformed JSON, wrong types, and missing fields all
return `{ ok: false, violations: [...] }` with messages a model can act on.

**INVARIANT 2.** Every `StageSchema.validate` runs the credential scan from
`schemas/redaction.ts` before its own checks and returns a violation if it matches.

### 5.2 `SessionStore` — owned by the Foundation workstream

```ts
// apps/server/src/session/session-store.ts

export interface SessionStore {
  create(input: CreateSessionInput): Promise<Session>;
  get(id: string): Session | undefined;
  list(): Session[];
  /** Serialized read-modify-write over JsonStore.mutate. */
  update(id: string, fn: (session: Session) => void): Promise<Session>;
  appendEvent(event: Omit<SessionEvent, "id" | "seq" | "createdAt">): Promise<SessionEvent>;
  events(sessionId: string, afterSeq?: number): SessionEvent[];
}
```

**INVARIANT 3.** `appendEvent` assigns `seq` as `max(seq for this session) + 1` inside the same
`JsonStore.mutate` callback that writes the event. Sequence numbers are gapless and unique per
session.

### 5.3 `ArtifactBroker` — owned by the Coordinator workstream

```ts
// apps/server/src/session/broker.ts

export type CollectResult =
  | { found: true; raw: string; source: "file" | "reply" }
  | { found: false };

/** Record an artifact without delivering it — used for the final stage. */
export function hashArtifact(raw: string, stageId: string, sourcePath: string): Artifact;

export interface ArtifactBroker {
  /** Read `stage.outputPath` from the agent workspace; fall back to a fenced JSON block. */
  collect(workspacePath: string, outputPath: string, reply: string): Promise<CollectResult>;
  /** Write an admitted artifact into the next agent's workspace. Returns the Artifact record. */
  deliver(
    raw: string,
    stageId: string,
    sourcePath: string,
    targetWorkspacePath: string,
    targetFileName: string,
  ): Promise<Artifact>;
  /** Write the seeded source documents into stage 1's workspace at session creation. */
  seed(workspacePath: string, sources: Array<{ name: string; content: string }>): Promise<void>;
}
```

**INVARIANT 4.** `deliver` is called only after a `ValidationResult` with `ok: true`. There is
no code path that writes an unvalidated artifact into another agent's workspace.

### 5.4 `SessionCoordinator` — owned by the Coordinator workstream

```ts
// apps/server/src/session/coordinator.ts

export interface CoordinatorDeps {
  agents: AgentService;
  sessions: SessionStore;
  schemas: SchemaRegistry;
  broker: ArtifactBroker;
  workspacePathFor(agentId: string): string;
  pollIntervalMs?: number;   // default 500
  stageTimeoutMs?: number;   // default 90_000
  /**
   * Prompt assembly. Defaults to W4's buildStagePrompt; injectable so the
   * coordinator and its tests do not depend on W4's implementation landing first.
   */
  buildPrompt?: (input: PromptInput) => string;
}

export class SessionCoordinator {
  constructor(deps: CoordinatorDeps);
  /** Fire-and-forget. Throws HttpError(409) if already running. */
  start(sessionId: string): Promise<Session>;
  /** Cancels the in-flight run and parks the session as "stopped". */
  stop(sessionId: string): Promise<Session>;
  isRunning(sessionId: string): boolean;
}
```

### 5.5 HTTP API — owned by the API workstream

| Method | Path | Body / Query | Success | Errors |
|---|---|---|---|---|
| POST | `/api/sessions` | `CreateSessionInput` | `201 { session }` | 400 validation, 404 unknown agentId |
| GET | `/api/sessions` | — | `200 { sessions }` | — |
| GET | `/api/sessions/:id` | — | `200 { session }` | 404 |
| POST | `/api/sessions/:id/start` | — | `202 { session }` | 404, 409 already running |
| POST | `/api/sessions/:id/stop` | — | `200 { session }` | 404 |
| GET | `/api/sessions/:id/events` | `?after=<seq>` | `200 { events }` | 404 |

All routes validate params with `z.object({ id: z.string().uuid() })`, matching `app.ts:11`.
Errors are thrown as `HttpError` from `errors.ts` and formatted by the existing handler at
`app.ts:145`.

---

## 6. Control flow

### 6.1 One stage attempt, step by step

```
coordinator.runStage(session, stageIndex, attempt)
 1. stage      := session.stages[stageIndex]
 2. agent      := agents.getAgent(stage.agentId)
 3. appendEvent("stage.assigned", { stageId, agentId, attempt })
 4. prompt     := buildPrompt(stage, schema.describe(), priorDigest, violationsFromLastAttempt)
 5. { run }    := agents.sendMessage(stage.agentId, prompt)      // F5: async
 6. loop every pollIntervalMs until run.status leaves {queued,running}
       └── if elapsed > stageTimeoutMs:
             agents.stopAgent(stage.agentId)
             appendEvent("stage.timeout"); return HOLD
 7. if run.status !== "completed":  appendEvent("stage.rejected", {run error}); return HOLD
 8. collected  := broker.collect(agentWorkspace, stage.outputPath, run.output)
       └── if !collected.found: appendEvent("stage.rejected", ["artifact missing"]); return HOLD
 9. result     := schema.validate(collected.raw, ctx)
       └── if !result.ok: appendEvent("stage.rejected", result.violations); return HOLD
10. artifact   := broker.deliver(collected.raw, stage.id, srcPath, nextWorkspace, nextFileName)
11. sessions.update(id, s => {
        s.sharedState.artifacts[stage.id] = artifact;
        s.sharedState.currentStageIndex   = stageIndex + 1;
        s.version += 1;
     })
12. appendEvent("stage.completed", { artifactHash, durationMs }); return ADMIT
```

### 6.2 Session lifecycle

```
start(id)
  ├── guard: isRunning(id) → 409
  ├── session.state = "running"; appendEvent("session.started")
  └── for stageIndex in 0..stages.length-1:
        for attempt in 1..stage.maxAttempts:
            outcome := runStage(session, stageIndex, attempt)
            if outcome == ADMIT: break to next stage
        if no attempt admitted:
            session.state = "failed"; return
      session.state = "completed"; appendEvent("session.completed")
```

**INVARIANT 5.** On a HOLD, `session.sharedState` and `session.version` are unchanged. The only
field that moves is `sharedState.attempts[stageId]`.

**INVARIANT 6.** `session.version` increases by exactly 1 per admitted artifact. After a
completed 3-stage session, `version === 3`.

**INVARIANT 7.** A stage is dispatched only when the previous stage has an entry in
`sharedState.artifacts`. Stages never run out of order and never run concurrently within one
session.

**INVARIANT 8.** No secret value is ever written to a `SessionEvent`, an artifact record, or an
HTTP response. Only hashes, sizes, and violation strings.

### 6.3 Prompt assembly (`session/prompt.ts`)

```
[stage.role instruction]

## Required output
Write your answer to `{stage.outputPath}` in this workspace.
It MUST match this schema exactly:
{schema.describe()}
If you cannot write the file, output the same JSON in a single fenced `json` block.

## Session so far
{digest of prior events: which stages were admitted, what was held and why}

## Input
{contents of the delivered input file, if stage.inputFileName is not null}

## Previous attempt was rejected      ← only present on a retry
{violations, one per line}
```

---

## 7. Where to make a change

| I want to… | Touch this | Do not touch |
|---|---|---|
| Add or change a stage's admission rule | `session/schemas/<stage>.ts` | the coordinator |
| Add a new stage type | a new file in `session/schemas/`, register in `schemas/index.ts` | `Stage` shape |
| Change turn ordering or retry policy | `session/coordinator.ts` | schemas, routes |
| Change what an artifact carries | `session/types.ts` `Artifact` | anything in `apps/server/src/*.ts` |
| Add an API route | `session/routes.ts` | `app.ts` |
| Change the UI | `apps/web/src/pipeline/**` | `App.tsx` |
| Make agent turns fast for dev | `RUNTIME_PROVIDER=mock` in `.env` | the real runners |

### 7.1 The complete list of edits to pre-existing files

Five lines in the server, three in the web app. These all land in **one foundation commit** on
day 1 (see `WORKSTREAMS.md`), after which the files are frozen.

1. `apps/server/src/types.ts` — 2 fields on `Database`, 1 import.
2. `apps/server/src/store.ts` — `emptyDatabase()` gains 2 arrays; `initialize()` spreads
   defaults so a file written before the session tables existed still loads.
3. `apps/server/src/config.ts` — `"mock"` added to the `RUNTIME_PROVIDER` enum.
4. `apps/server/src/runner-factory.ts` — a `mock` branch returning `MockRunner`.
5. `apps/server/src/index.ts` — construct `SessionStore`, `SchemaRegistry`, `ArtifactBroker`,
   `SessionCoordinator`; pass them to `createApp`.
6. `apps/server/src/app.ts` — an optional third parameter `sessionDeps?: SessionRouteDeps`, and
   a guarded `await app.register(sessionRoutes, sessionDeps)` after the last existing route. The
   parameter is optional so the existing `app.test.ts` calls keep compiling unchanged.
7. `apps/web/src/api.ts` — a new `pipelineApi` export appended at the end, fully populated with
   all five routes so W5 never needs to reopen this file. **The existing `api` object is untouched.**
8. `apps/web/src/types.ts` — session type mirrors appended at the end of the file.
9. `apps/web/src/App.tsx` — one import, one `useState`, one button in `header-actions`, one
   conditional mount. 16 added lines, zero deletions.

---

## 8. Glossary

| Term | Meaning here |
|---|---|
| **Stage** | One step of the pipeline, bound to one agent and one schema |
| **Artifact** | The validated file a stage produces; the only thing that crosses between agents |
| **Admit** | The coordinator accepted an artifact: hashed, recorded, delivered onward, `version++` |
| **Hold** | The coordinator rejected an attempt: chain unchanged, an attempt consumed |
| **Gate** | The validation step between producing an artifact and delivering it |
| **Broker** | The component that physically moves bytes between sealed workspaces |
| **Digest** | A short summary of prior session events injected into a stage's prompt |
| **Run** | Starter-kit concept: one `sendMessage` → one Codex turn. One stage attempt = one Run |
| **Session** | Our concept: one pipeline execution across several agents |

---

## 9. Non-goals

Stated explicitly so reviewers read them as scoping rather than oversight.

- No identity, authentication, or authorization. The starter kit's bearer token is unchanged.
- No semantic validation. The gate proves a citation *resolves*, not that the claim *supports*
  the point.
- No branching, fan-out, or parallel stages. `stages` is a linear list.
- No distributed coordination. `JsonStore` is single-process by design.
- No new sandbox or container hardening beyond the starter kit's defaults.
- No cloud deployment. Local Docker is the judging path.
