# Handoff — what W2 needs from everyone else

Written after W2's two slices landed. This is the "you can start now" list: what is
already real and safe to build against, and exactly what each workstream still owes.

Interfaces referenced here are frozen and live in [`BLUEPRINT.md`](./BLUEPRINT.md) §5.

---

## What is already done, and safe to depend on

| Thing | Where | Notes |
|---|---|---|
| `Session`, `SessionEvent`, `Stage`, `Artifact`, `SharedState` | `session/types.ts` | Complete. Do not edit — ask W1. |
| `SessionStore` | `session/session-store.ts` | `create` · `get` · `require` · `list` · `update` · `appendEvent` · `events(sessionId, afterSeq)` |
| `SessionCoordinator` | `session/coordinator.ts` | `start` · `stop` · `isRunning`. Retries, timeouts, and cancel-recovery all work. |
| `FileArtifactBroker` | `session/broker.ts` | `collect` · `deliver` · `seed`, plus `hashArtifact` |
| `MockRunner` | `mock-runner.ts` | `RUNTIME_PROVIDER=mock` — sub-second turns, no container engine, no Ark key |
| `pipelineApi` | `apps/web/src/api.ts` | All five routes already wired. **W5 never needs to open this file.** |

`npm run check` is green: 27 tests, both production builds.

---

## W4 — Schemas and prompts · **critical path**

**This is the headline feature and it is the only thing standing between us and a demo.**
The coordinator enforces a rule perfectly; nobody has written the rule yet. Right now every
inspection passes, which means the submission's central claim is unproven.

**Files:** `session/schemas/{research,summary,report,redaction}.ts`, `session/prompt.ts`

### What to implement

`StageSchema` (BLUEPRINT §5.1) has two methods:

- `describe()` — returns the schema as text, injected verbatim into the agent's prompt. This is
  what tells the model what shape to produce, so write it for a reader, not a parser.
- `validate(raw, context)` — **must never throw.** Malformed JSON, wrong types, and missing
  fields all return `{ ok: false, violations: [...] }`. The violation strings go straight back
  into the retry prompt, so write them as instructions a model can act on:
  `"cited claims not in stage 1: claim-99"`, not `"validation failed"`.

`context.priorArtifacts` gives you the earlier stages' admitted artifacts, keyed by stage id.
That is how stage 2 reaches stage 1's claim ids.

The admission rules are in [`PLAN.md`](./PLAN.md) §2. The stage-2 rule is the one that matters.

### Also yours

`redaction.ts` — `ARK_API_KEY` is passed into the agent container
(`container-codex-runner.ts:71`), so an agent can read its own environment, and the broker will
faithfully copy whatever it produced into the next workspace. Scan every artifact for the Ark
key and `sk-`/`ep-`-shaped strings before admitting it.

`prompt.ts` — `buildStagePrompt(input)`. The template is in BLUEPRINT §6.3. `input.violations`
is non-empty on a retry; put it under a clear heading so the model sees what to fix.

### Done when

A summary citing a claim id stage 1 never produced is rejected with a violation string a model
can act on, and a credential in an artifact is rejected.

**Blocked by:** nothing. Everything you need exists. Start now.

---

## W3 — Routes

**File:** `session/routes.ts` (currently one placeholder `GET /api/sessions`)

Five routes, shapes in BLUEPRINT §5.5. Copy the style from `app.ts:75-129` — each is about five
lines. Validate params with `z.object({ id: z.string().uuid() })` and throw `HttpError`; the
existing handler at `app.ts:145` formats it.

The coordinator behaves the way `AgentService.sendMessage` does: `start` returns immediately and
throws `HttpError(409)` if the session is already running, so `POST /start` returns `202` and
the 409 falls out on its own.

`POST /api/sessions` also has to seed the source documents into stage 1's workspace —
`broker.seed(workspacePath, sources)` does it.

**Done when:** every route returns its documented status code, and two concurrent `start` calls
produce exactly one `session.started` event.

**Blocked by:** nothing. `app.ts` already registers your plugin — never open it.

---

## W5 — Runtime and UI

**Files:** `mock-runner.ts`, `apps/web/src/pipeline/**`

### MockRunner

No longer blocking W2 — the coordinator tests use inline fakes. Still worth adding misbehaviour
modes for manual demo runs: cite a nonexistent claim, write no file at all, hang past the
deadline. Model the hanging one on `coordinator.test.ts`'s `hangingRunner`, which rejects with
`RunCancelledError` when cancelled — a runner that ignores `cancel` will deadlock `stopAgent`.

### Pipeline panel

`App.tsx` already mounts `PipelinePanel`; `pipelineApi` is already written. Work only inside
`apps/web/src/pipeline/`.

What the demo needs on screen:

- A **stage timeline** — one row per stage, a green check when admitted, the attempt count
  beside it.
- The **artifact chain** — `research.json` → `summary.json` → `report.md`, each with its hash
  and validated timestamp.
- **A held stage's violations**, expanded. This is the 1:15 beat of the demo; it has to be
  readable at a glance.
- A **Stop** button wired to `POST /stop`.
- One line stating the invariant: *three stages, in order, each admitted exactly once, no held
  artifact propagated.* A reviewer anchored on the brief's countdown example is looking for the
  equivalent of "no duplicate or missing number".

Poll events with `pipelineApi.events(id, afterSeq)`; copy the loop at `App.tsx:204`.

**Blocked by:** W3 for live data. Build against a fixture array of `SessionEvent` first — the
shape is in `apps/web/src/types.ts`.

---

## W1 — Foundation and integration

1. **Run the baseline acceptance test.** `.data/`, `workspaces/`, and `codex-home/` are still
   empty, so the platform has never started and the Ark key has never been used. Everything
   built so far was verified with fakes. If the key is wrong, we want to know now, with one
   person blocked, not on day 3 with four.
2. **Fill in the Owner column** in [`WORKSTREAMS.md`](./WORKSTREAMS.md) §1.
3. **Own the contract changes.** W2 added `buildPrompt` to `CoordinatorDeps` and `hashArtifact`
   to the broker's exports; BLUEPRINT §5.3 and §5.4 are updated to match. Any further signature
   change goes through you and gets announced before the code is written.
4. **Keep `main` green** and review PRs.

---

## The one risk worth watching

Everything works against fakes. The first real Codex run will produce output nobody has seen —
prose where JSON was asked for, a file written to the wrong path, a schema description the model
ignores. That is normal, and it is why W4's day 3 is reserved for tuning prompts against real
output rather than writing new features.

Get one real end-to-end run as early as possible, even a bad one.
