# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this project is

`volc-agent-launchpad` — the TechJam 2026 Agent Launchpad starter kit, plus our team's
middleware submission for **Track 1, Multi-Agent Coordination**.

Our addition is **Handoff Gate**: a staged pipeline of Codex agents (Researcher → Summarizer →
Formatter) where every handoff is a schema-checked artifact, and the coordinator refuses to
pass an artifact that fails its stage's contract. The headline property is that **no uncited
claim can reach the final report**, enforced in the control plane rather than by the model.

## Read these before writing code

| Document | What it gives you |
|---|---|
| [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) | **Start here.** Exact types, module map, interfaces, control flow, invariants, "where to make change X" |
| [`docs/PLAN.md`](docs/PLAN.md) | Why the design is shaped this way, the three-day plan, tests, demo script |
| [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md) | File ownership across five people, and the rules that keep merges clean |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The starter kit's own architecture (not ours) |

## Current status

Update this section when the picture changes — it is the fastest way for a cold session to
orient.

**Every module in BLUEPRINT.md §3 is now written.** No stub remains: `grep -r "not
implemented" apps/server/src` returns nothing. What is missing is not code — it is that none of
it has ever run.

| Area | State |
|---|---|
| Data model, `SessionStore`, `JsonStore` wiring | **Done** (`session/types.ts`, `session/session-store.ts`) |
| `MockRunner` (`RUNTIME_PROVIDER=mock`) | **Done**, including the misbehaviour modes W2's tests drive |
| `SessionCoordinator` + `FileArtifactBroker` | **Done** — dispatch, validate, admit/hold, retry budget, timeout recovery, stop |
| Stage schemas and the citation gate | **Done** — `session/schemas/*.ts`, including the cross-cutting credential scan in `redaction.ts` |
| Prompt assembly | **Done** — `session/prompt.ts` |
| HTTP routes | **Done** — all six in `session/routes.ts`, 18 tests in `routes.test.ts` |
| Pipeline UI | **Done, fixture-backed** — `apps/web/src/pipeline/PipelinePanel.tsx`. Its live paths (polling, terminal-event pull, Stop) became reachable only when the routes landed and **have never been exercised against a real session** |
| Baseline acceptance test | **Never run.** `.data/`, `workspaces/`, `codex-home/` are empty; no real model call has ever been made |

`npm run check` on `main` passes: 111 tests, both typechecks, both production builds.

### What is actually left

The risk has moved from "unwritten" to "unverified". In rough order of how likely each is to
surprise you:

1. **No end-to-end run has ever happened.** Whether a real Codex agent writes to `outputPath` in
   a form `FileArtifactBroker` collects, and whether a real model clears the schemas inside
   `maxAttempts`, are both untested assumptions. `scripts/demo-pipeline.sh` drives the whole API
   for this; it has never been run and is referenced from no npm script or doc.
2. **The panel's live paths.** Everything visible today is the demo fixture. A panel showing the
   fixture is deliberately marked (dashed border, watermark, "not live data" badge) — if you see
   that during a demo, the routes did not answer.
3. **UI module split.** BLUEPRINT §3 lists `StageTimeline.tsx`, `ArtifactViewer.tsx` and
   `usePipeline.ts`. The first two exist as functions inside `PipelinePanel.tsx`; the hook was
   never extracted and polling lives in inline `useEffect`s. Cosmetic against the blueprint's
   intent, worth knowing before you go looking for the files.

## Hard rules

1. **No new npm dependencies.** `zod` v4 is already in `@launchpad/server` and covers all
   validation. New packages cause `package-lock.json` conflicts across a five-person team.
2. **Do not modify the baseline.** `agent-service.ts`, `codex-runner.ts`,
   `container-codex-runner.ts`, and `workspace.ts` take **zero** changes. `config.ts` has taken
   its one allowed change (the `mock` enum member) and is now frozen too.
3. **Respect file ownership** (WORKSTREAMS §1). Never edit a file you do not own, not even an
   import line. Shared files were all edited once in the foundation commit and are frozen.
4. **`main` must always pass `npm run check`** (typecheck + tests + production build).
5. **Never commit a secret.** `.env` is gitignored and has never been committed. Artifacts and
   events store hashes and violation strings, never values.
6. **Never force push.** Stack a follow-up branch instead of rewriting a pushed one.

## Landmines — all verified against the current code

1. **`stopAgent` leaves the agent `stopped`, and `sendMessage` then rejects it with a 409**
   (`agent-service.ts:123` and `:190`). Any cancel path must call `startAgent` afterwards or
   that agent is unusable for the rest of the session. `SessionCoordinator.recoverAgent` does
   this; copy the pattern rather than reinventing it.
2. **`sendMessage` throws 503 unless Ark looks configured** (`agent-service.ts:157`), even under
   `RUNTIME_PROVIDER=mock`. Test configs must pass `ARK_API_KEY: "test-key"` and
   `ARK_MODEL: "ep-test"`.
3. **`status === "error"` does not block a retry** — only `stopped` and `busy` do.
4. **`getRun` is synchronous and throws 404** (`agent-service.ts:137`). Runs are fire-and-forget;
   poll `getRun` until the status leaves `queued`/`running`.
5. **`JsonStore.initialize` spreads over `emptyDatabase()`** so a file written before a table
   existed still loads. Keep `version: 1` and add defaults rather than bumping the version.
6. **A dispatch can fail legitimately** (operator stopped the agent, a `stop()` raced the
   dispatch). Treat it as a held stage, never as a crashed session.

## Invariants

`SessionCoordinator` has exactly two writers of shared state, and they must not overlap:

| Location | Writes | When |
|---|---|---|
| the admit commit | `artifacts`, `currentStageIndex`, `version` | a stage is admitted |
| `hold()` | `attempts` | a stage is held |

That separation is what makes "a held artifact never propagates" hold structurally rather than
by convention. If you add a third writer, you have probably broken it.

## Conventions

- **TypeScript is strict**, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
  Array and `Record` access yields `T | undefined` — guard every index. Optional properties need
  an explicit `| undefined` in their type.
- **Server imports use `.js` extensions** (NodeNext). **Web imports do not** (Bundler resolution).
- **Server tests are excluded from `tsc`** but run under vitest, so a type error in a `.test.ts`
  will not fail `npm run typecheck`. Run the tests.
- **Test harness pattern**: `agent-service.test.ts:38` builds a temp-dir `AgentService`. When a
  test needs both `AgentService` and `SessionStore`, **hoist the `JsonStore` into a variable and
  share the one instance** — two stores over the same file silently clobber each other.
- **Awaiting async work in tests**: `await expect.poll(() => ..., { timeout }).toBe(...)`, the
  idiom already used at `agent-service.test.ts:76`.
- **Fake runners can write real files.** `RunnerRequest.workspacePath` is a real directory, so a
  fake agent can produce an artifact the broker then collects.
- Prefer string concatenation over template literals in server code, matching the existing style.

## Git and GitHub

- Two remotes: **`origin`** is our repo (`changfazhi/techjam-26-`), **`upstream`** is the
  organizers' (`RrankPyramid/CodeJam`). `gh` defaults to `upstream` unless told otherwise, which
  produces a confusing "No commits between main and ..." error. The repo default is now set;
  if `gh` misbehaves, pass `--repo changfazhi/techjam-26-`.
- Branch per workstream (`feat/coordinator`, `feat/schemas`, ...). Merge to `main` at least
  twice a day. Rebase rather than merge when picking up others' work.
- Stack dependent work on the branch it depends on and open the PR against that branch; GitHub
  retargets to `main` when the base merges.

## Key facts about the codebase

- The server **never calls a model API**. It spawns Codex CLI as a subprocess; Codex talks to
  BytePlus Ark itself using `codex-home/config.toml`.
- Agent workspaces are **sealed from each other** — the runtime container bind-mounts only the
  acting agent's own workspace (`container-codex-runner.ts:79`). This is why the coordinator
  must broker every cross-agent byte, and why the gate has somewhere to live.
- `ARK_API_KEY` **is passed into the agent container** (`container-codex-runner.ts:71`), so an
  agent can read its own environment. The broker copies artifacts between workspaces, so the
  gate must scan for credentials before admitting one.
- All state is one JSON file, `.data/launchpad.json`, written by a single-process serialized
  store.

## Commands

```bash
npm run poc      # full local POC (needs Docker/Colima/Podman + .env)
npm run dev      # server + web with hot reload
npm run check    # typecheck + tests + build — must pass before any merge
npm run test     # server tests only (fast; no container engine needed)

npx vitest run --root apps/server src/session          # just the middleware tests
npx tsc --noEmit -p apps/server/tsconfig.json          # fastest type feedback
```

Set `RUNTIME_PROVIDER=mock` in `.env` for sub-second iteration with no container engine and no
real Ark calls.
