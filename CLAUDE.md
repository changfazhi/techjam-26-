# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this project is

`volc-agent-launchpad` — the TechJam 2026 Agent Launchpad starter kit, plus our team's
middleware submission for **Track 1, Multi-Agent Coordination**.

Our addition is called **Handoff Gate**: a staged pipeline of Codex agents (Researcher →
Summarizer → Formatter) where every handoff between agents is a schema-checked artifact, and
the coordinator refuses to pass an artifact that fails its stage's contract. The headline
property is that **no uncited claim can reach the final report**, enforced in the control
plane rather than by the model.

## Read these before writing code

| Document | What it gives you |
|---|---|
| [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md) | **Start here.** Exact types, module map, interfaces, control flow, invariants, and a "where to make change X" table |
| [`docs/PLAN.md`](docs/PLAN.md) | Why the design is shaped this way, the three-day plan, tests, demo script |
| [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md) | File ownership across five people, and the rules that keep merges clean |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The starter kit's own architecture (not ours) |

## Hard rules

1. **No new npm dependencies.** `zod` v4 is already available in `@launchpad/server` and covers
   all validation. New packages cause `package-lock.json` conflicts across a five-person team.
2. **Do not modify the baseline.** `agent-service.ts`, `codex-runner.ts`,
   `container-codex-runner.ts`, `workspace.ts`, and `config.ts` take **zero** changes. The
   hackathon brief forbids rebuilding the provided platform.
3. **Respect file ownership.** Each path has exactly one owner (WORKSTREAMS §1). Never edit a
   file you do not own, not even an import line.
4. **`main` must always pass `npm run check`** (typecheck + tests + production build).
5. **Never commit a secret.** `.env` is gitignored and has never been committed — keep it that
   way. Artifacts and events store hashes and violation strings, never values.

## Key facts about the codebase

- The server **never calls a model API**. It spawns Codex CLI as a subprocess; Codex talks to
  BytePlus Ark itself using `codex-home/config.toml`.
- Agent workspaces are **sealed from each other** — the runtime container bind-mounts only the
  acting agent's own workspace. This is why the coordinator must broker every cross-agent byte,
  and why the gate has somewhere to live.
- Runs are **asynchronous**: `sendMessage` returns immediately; poll `getRun(runId)` until its
  status leaves `queued`/`running`.
- All state is one JSON file, `.data/launchpad.json`, written by a single-process serialized
  store.

## Commands

```bash
npm run poc      # start the full local POC (needs Docker/Colima/Podman + .env)
npm run dev      # server + web with hot reload
npm run check    # typecheck + tests + build — must pass before any merge
npm run test     # server tests only (fast; no container engine needed)
```

For fast iteration without containers or an Ark key, set `RUNTIME_PROVIDER=mock` in `.env` —
`MockRunner` returns deterministic artifacts and can be told to misbehave for tests.
