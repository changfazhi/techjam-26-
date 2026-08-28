# Handoff Gate — Build Plan

**TechJam 2026 · Agent Launchpad · Track 1 (Multi-Agent Coordination)**

A staged pipeline of Codex agents — Researcher, Summarizer, Formatter — where every
handoff between them is a schema-checked artifact, and **no uncited claim can reach the
final report** because the coordinator refuses to pass it on.

| | |
|---|---|
| New surface | 1 module, 5 routes |
| Enforcement | Control plane |
| Judging path | Local Docker |
| Guarantee | Every claim sourced |
| New dependencies | **None** (`zod` is already present) |

---

## 1. The problem

Chaining three agents is a `for` loop. The part that is genuinely middleware is deciding
whether one agent's output is fit to become the next agent's input.

Three facts in the starter kit shape the answer:

1. **Agents are sealed from each other.** `apps/server/src/container-codex-runner.ts:80`
   bind-mounts only the acting agent's own workspace to `/workspace`. Agent B physically
   cannot read Agent A's files. Something has to carry the bytes across — and whatever
   carries them can inspect them.

2. **The reply is free text.** `parseCodexEventLine` (`apps/server/src/codex-runner.ts:56`)
   returns the last `agent_message`, whatever it says. Prose is not checkable. If the gate
   degenerates to "did it return something", there is no middleware left.

3. **The per-agent lock already exists.** `apps/server/src/agent-service.ts:193` rejects a
   second concurrent run with a 409 inside one serialized `store.mutate`. Ordering *within*
   an agent is solved; admission *between* agents is the gap.

**Thesis.** Because agent workspaces are sealed, every cross-agent byte must pass through
the coordinator — so the coordinator is the natural place to enforce a contract, and the
pipeline gets a property the model cannot violate: nothing enters stage *k+1* that failed
stage *k*'s schema.

---

## 2. The pipeline

A session is created with a topic and 3–5 seeded source documents, which the coordinator
writes into the Researcher's workspace. Each stage produces one artifact with an admission
rule checked by zod.

| Stage | Role | Artifact | Admitted only if |
|---|---|---|---|
| 1 | **Researcher** — extracts claims from the seeded sources | `research.json` | ≥ 3 claims; every claim has non-empty `text`, a `confidence` in [0,1], and a `sourceId` present in the seeded manifest |
| 2 | **Summarizer** — condenses into key points | `summary.json` | ≥ 1 key point; **every `citedClaimId` resolves to a claim id produced in stage 1**; no key point without a citation |
| 3 | **Formatter** — writes the deliverable | `report.md` | every key point appears in the body; every cited source appears in a References section; under 8,000 characters |

The stage-2 rule is the project:

```ts
// the whole idea, in one check
const claimIds = new Set(research.claims.map(c => c.id));
const bad = summary.keyPoints
  .flatMap(p => p.citedClaimIds)
  .filter(id => !claimIds.has(id));

if (bad.length) return reject(`cited claims not in stage 1: ${bad.join(", ")}`);
```

A hallucinated citation is the most common and most damaging failure of an LLM pipeline.
Here it is caught **outside the model** by about fifteen lines of schema, then handed back
to the agent as a specific violation to fix. Nothing is rigged; it happens on its own.

### A fourth rule, applied to every stage

`container-codex-runner.ts:71` passes `ARK_API_KEY` into the agent's container, so an agent
can read its own environment. The broker then copies whatever it produced into the next
workspace — meaning a credential written into `research.json` would be carried forward and
rendered in the artifact viewer.

So the gate also scans every artifact for the Ark key and for `sk-`/`ep-`-shaped strings,
and holds the stage if it finds one. Ten lines; it closes a hole our own design opens; and
*redaction* is named explicitly in the 20% verification criterion.

### Scope "research" honestly

The Runtime container has network (`--network bridge`), but Codex has no search tool and no
key — open-ended web research means flaky `curl`, or worse, invented sources. **Seed the
documents at session creation** and scope stage 1 to extraction from those files. This is
also the stronger product: document processing with enforced provenance is a real shape, and
it makes the `sourceId` rule meaningful rather than decorative.

---

## 3. The stage loop

1. Look up stage *k* in `session.stages` and its role agent. Emit `stage.assigned`.
2. Build the prompt: the stage instruction, the **schema stated literally**, the exact output
   path, and the previous artifact as input. On a retry, append the violations from the last
   attempt.
3. Append a **digest of the session's prior events** — what earlier stages admitted, and why
   any attempt was held. Agents genuinely read shared state rather than only being written to.
4. Call `agentService.sendMessage(agentId, prompt)`, then poll `getRun(runId)` every 500 ms
   against a 90-second deadline.
5. Collect the artifact: read the declared path in the agent's workspace; if missing, fall
   back to a fenced JSON block in the reply. Both paths validate identically.
6. **Admitted** — hash the artifact, record `{ path, hash, validatedAt }` in
   `sharedState.artifacts[k]`, bump `version`, write it into stage *k+1*'s workspace as a
   read-only input, emit `stage.completed`.
7. **Held** — violations, missing artifact, run failure, or deadline. The artifact chain is
   left exactly as it was; `attempts[k]` increments and the stage retries with the violations
   in the prompt. On timeout, cancel via `agentService.stopAgent` first.
8. Budget spent (`maxAttempts = 2`) → `session.failed`, holding every artifact admitted so
   far. Last stage admitted → `session.completed`.

### Stretch goal — build last

Add a fourth role, **Critic**, between stages 2 and 3. It reads the summary plus the claims
and emits `{ approved, violations[] }`. Approved advances; rejected routes back to the
Summarizer with the critique attached. It costs one more schema and one more edge, and it is
what turns the coordinator from a sequencer into a genuine router.

---

## 4. Three days

### Day 1 — Baseline, schemas, plumbing
- Pass the baseline acceptance test end to end (create, task, follow-up, restart).
- Add `MockRunner` behind `RUNTIME_PROVIDER=mock`.
- Write the three zod schemas and their admission rules. Test standalone — no agents involved.
- Land the foundation commit (see `WORKSTREAMS.md`).

**Exit evidence:** a unit test proves a summary citing a nonexistent claim id is rejected
with a readable violation.

### Day 2 — The coordinator
- The stage loop, the artifact broker, the retry budget.
- File-first collection with the fenced-JSON fallback.
- The five tests below.
- Wire the five routes.

**Exit evidence:** `curl` alone drives all three stages and prints a clean event log with
artifact hashes.

### Day 3 — UI, real agents, rehearsal
- Pipeline panel: stage timeline, artifact viewer, violations on a held stage, Stop.
- Switch to the container runner; run the real three-stage pipeline.
- README, architecture diagram, demo steps, limitations.
- Rehearse against a stopwatch. Twice.

**Exit evidence:** the demo fits in three minutes and includes a live rejection.

### If you run out of time, cut in this order

| Order | Cut | What survives |
|---|---|---|
| **never** | The stage loop, the stage-2 citation gate, the event log, the tests | This is the submission |
| 1st | The Critic stage | Already the stretch goal |
| 2nd | Credential redaction | Rubric points, not the core story |
| 3rd | Collapse to two stages (Researcher → Formatter) | Still multi-agent, still gated, still passes every checklist item |

### Before you start

`.data/`, `workspaces/`, and `codex-home/` being empty means the baseline has never run.
Check `.env` for trailing spaces first: `ARK_BASE_URL` is validated by `z.string().url()` at
`apps/server/src/config.ts:43`, and the loader in `scripts/start-local-poc.sh` strips neither
whitespace nor quotes — one trailing space kills startup with a confusing error.

---

## 5. Verification

All five tests use the `FakeRunner` pattern already in
`apps/server/src/agent-service.test.ts:11`, run in under a second, and need no container
engine.

| Test | Setup | Assertion |
|---|---|---|
| Clean pipeline | Three agents, all valid | Three `stage.completed` in order, three hashes recorded, `session.state === "completed"` |
| **Hallucinated citation** | Summarizer cites `claim-99`, never produced | `stage.rejected` carries the id; `version` unchanged; stage 3's workspace never receives the file; the retry succeeds |
| No artifact written | Agent replies in prose, writes no file | Fenced-JSON fallback runs; with neither present, held with "artifact missing" rather than crashing |
| Budget exhausted | Summarizer fails every attempt | `session.failed` after 2 attempts; stage 1's artifact still recorded |
| Double start | Two concurrent `start` calls | One succeeds, other gets 409; exactly one `session.started` event |

Two questions judges will ask, with the answers:

- *Why does the coordinator move the files instead of sharing a folder?* Because agent
  workspaces are sealed by the Runtime, so mediation is forced — and mediation is where a
  contract can be enforced.
- *What stops a bad summary from shipping?* The stage-2 gate. The coordinator, never the
  model, decides what enters the next workspace.

---

## 6. Demo — three minutes, on a stopwatch

Each stage is a fresh container plus a long generation with file I/O — 60 to 120 seconds. A
clean three-stage pass is 3–6 minutes and will not fit live. **Pre-run one complete pipeline
before presenting**, and let a second run in the background while narrating the first.

| Time | Beat |
|---|---|
| 0:00 | Three agents in the sidebar with distinct roles. Select the Summarizer; show its lifecycle state and configuration. |
| 0:12 | Open the Pipeline panel. Start a live session on the seeded sources — it runs in the background. Switch to the pre-run session. |
| 0:35 | Walk the artifact chain: `research.json` → `summary.json` → `report.md`, each with a hash and validated timestamp. Open the report; click a sentence back to its source. |
| **1:15** | **The denial.** Summarizer attempt 1 sits in the timeline as held. Open it: `cited claims not in stage 1: claim-99`. Show stage 3's workspace has no file from that attempt. |
| **1:40** | **Proof it is real.** Open the Summarizer's *Playground*. Both dispatched turns are in its own message history — attempt 1, then attempt 2 with violations appended. Same `sendMessage` path the baseline uses. |
| 2:05 | Attempt 2 admitted, report ships. Timeline reads 3 / 3 admitted, attempts 1 · 2 · 1. |
| **2:20** | **The stop control.** Stop the live session mid-stage. Run cancelled, admitted artifacts kept, agents return to `ready`. |
| 2:40 | Cut to the architecture diagram. Trace one artifact up through a gate and back down. Fifteen seconds. |
| 2:52 | `npm run check` green in a second terminal. Close on the limitations. |

**Make the invariant legible.** A reviewer anchored on the brief's countdown example looks
for "no duplicate or missing number". Put the analog on screen: a green check per admitted
stage, the attempt count beside each, and one line reading *three stages, in order, each
admitted exactly once, no held artifact propagated*.

### Limitations to state out loud

- Schemas are hand-written per stage. A general contract language is the next seam, unbuilt.
- Validation is **structural, not semantic**: the gate proves a citation *resolves*, not that
  the claim *supports* the key point. The Critic stage is the first step toward that.
- The `JsonStore` is single-process, so the coordinator is a single-node scheduler.
- Stages are a fixed list. No branching, no fan-out, no parallel stages.
- Ordinary containers are not a hardened multi-tenant boundary — inherited, unchanged.

---

## 7. Alignment with the brief

### The multi-agent coordination layer

| The brief asks for | Handoff Gate provides |
|---|---|
| A shared session or topic all agents can read and write | The `Session` record and its artifact chain. Agents read it as a prompt digest and write to it as artifacts and events — **mediated, never direct**, because the Runtime seals workspaces |
| A turn-selection or message-routing rule | Stage sequencing, plus routing on the validation result: admit and advance, or hold and retry |
| Shared state preventing duplicate or skipped turns | `version` guards the commit, `attempts[]` bounds retries, a held artifact is never written onward |
| Visible event history showing which agent produced what | Append-only `SessionEvent` log keyed by `stageId`, `agentId`, `runId`, `seq` |
| A timeout, retry, or stop rule | All three: 90-second deadline, `maxAttempts = 2`, administrative stop |

### Three recommended directions, not one

- **Multi-agent coordination** — the primary story.
- **Trace, audit and observability** — nearly free. The event log carries stable ids, status,
  duration, retry relationships, artifact hashes, redacted payloads. Claim it explicitly.
- **Threat modeling and safety** — typed schemas and output validation against tool misuse;
  redaction against credential exposure; deadline and attempt budget against runaway execution.

Identity and authorization is deliberately **not** addressed. Say so — a stated non-goal
reads as scoping, an unstated one reads as an oversight.

### Optional evidence claimed

| Checklist item | Status | Evidence |
|---|---|---|
| A correlated trace across model, tool, sandbox and policy events | **yes** | The event log for one session, every attempt and its decision |
| A defined threat blocked, protected asset unchanged, cleanup shown | **yes** | The hallucinated citation is held; stage 3's workspace never receives the file; the retry recovers |
| A team-defined coordination capability works as described | **yes** | Three stages, in order, each admitted exactly once |
| A delegated permission, scoped or revocable, enforced outside the UI | no | Out of scope, listed as a non-goal |

### The one gap engineered around

Required demo step 2 is "invoke the Agent through the Playground", and the pipeline is driven
from its own panel. The coordinator calls the same `sendMessage` path the Playground does, so
every dispatched turn **already appears in that agent's own message history**. Show it at
1:40, and send one manual Playground message to prove the baseline still works. It turns a
checklist gap into the strongest evidence that the coordination is real rather than staged.

---

## 8. Why no framework

The server makes **no outbound model calls**. Codex CLI is spawned as a subprocess and talks
to Ark itself, configured by `codex-home/config.toml`. LangChain's surface — model
abstraction, prompt templates, chains, output parsers, agent executors — operates at a layer
this codebase does not have. Using it would mean replacing the Codex runtime, which the brief
lists as out of scope, and LangGraph would compete with the very coordinator that *is* our
submission.

The one worthwhile idea: generate the prompt's schema text from the zod schema with
`zod-to-json-schema` rather than hand-writing it twice. That is a small standalone package,
not a framework.

---

See also: [`BLUEPRINT.md`](./BLUEPRINT.md) for the implementation spec, and
[`WORKSTREAMS.md`](./WORKSTREAMS.md) for the five-person split.
