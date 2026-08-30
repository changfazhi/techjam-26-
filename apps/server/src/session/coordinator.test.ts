import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { RunCancelledError } from "../errors.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { FileArtifactBroker } from "./broker.js";
import { SessionCoordinator, type CoordinatorDeps } from "./coordinator.js";
import {
  createSchemaRegistry,
  type SchemaRegistry,
  type ValidationResult,
} from "./schemas/index.js";
import { SessionStore } from "./session-store.js";
import type { CreateSessionInput } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

/** What a scripted agent does on one turn. */
type Script =
  | { write: { fileName: string; content: string } }
  /** Answers without writing the declared file. */
  | { replyOnly: string };

/**
 * Decides validity per schema, receiving a 0-based call index so a test can
 * reject the first attempt and admit the retry.
 */
type Decide = (schemaId: string, raw: string, call: number) => ValidationResult;

/** Stage 3 emits markdown; every other stage emits JSON. */
const acceptDefault: Decide = (schemaId, raw) => {
  if (schemaId === "report") {
    return raw.trim().length > 0
      ? { ok: true, value: raw }
      : { ok: false, violations: ["empty report"] };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, violations: ["not valid json"] };
  }
};

function schemasThat(decide: Decide): SchemaRegistry {
  const calls = new Map<string, number>();
  return {
    get: (schemaId: string) => ({
      id: schemaId,
      describe: () => "schema for " + schemaId,
      validate: (raw: string) => {
        const call = calls.get(schemaId) ?? 0;
        calls.set(schemaId, call + 1);
        return decide(schemaId, raw, call);
      },
    }),
  };
}

/** Never settles on its own; a cancel rejects it the way a real runner does. */
function hangingRunner(): AgentRunner {
  let rejectActive: ((reason: unknown) => void) | null = null;
  return {
    isAvailable: async () => true,
    cancel: async () => {
      rejectActive?.(new RunCancelledError());
      rejectActive = null;
      return true;
    },
    run: () =>
      new Promise<RunnerResult>((_resolve, reject) => {
        rejectActive = reject;
      }),
  };
}

interface Harness {
  service: AgentService;
  sessions: SessionStore;
  workspaces: WorkspaceManager;
  /** agentId -> the script for each successive turn; the last one repeats. */
  scripted: Map<string, Script[]>;
}

async function makeHarness(customRunner?: AgentRunner): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "handoff-coordinator-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    // sendMessage throws 503 unless Ark looks configured, even under a fake runner.
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });

  const scripted: Harness["scripted"] = new Map();
  const turns = new Map<string, number>();

  // The scripted agent writes a real file into its own workspace, exercising
  // the broker's file path rather than the reply fallback.
  const scriptedRunner: AgentRunner = {
    isAvailable: async () => true,
    cancel: async () => false,
    run: async (request: RunnerRequest): Promise<RunnerResult> => {
      const scripts = scripted.get(request.agentId) ?? [];
      const turn = turns.get(request.agentId) ?? 0;
      turns.set(request.agentId, turn + 1);
      const script = scripts[Math.min(turn, scripts.length - 1)];

      if (script && "write" in script) {
        await writeFile(
          path.join(request.workspacePath, script.write.fileName),
          script.write.content,
          "utf8",
        );
        return { output: "wrote " + script.write.fileName, threadId: "thread", usage: null };
      }
      return {
        output: script && "replyOnly" in script ? script.replyOnly : "nothing to say",
        threadId: "thread",
        usage: null,
      };
    },
  };

  // One JsonStore shared by both. Two stores over the same file would clobber.
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(
    config,
    store,
    workspaces,
    customRunner ?? scriptedRunner,
  );
  await service.initialize();

  return { service, sessions: new SessionStore(store), workspaces, scripted };
}

function coordinatorFor(
  harness: Harness,
  overrides: Partial<CoordinatorDeps> = {},
): SessionCoordinator {
  return new SessionCoordinator({
    agents: harness.service,
    sessions: harness.sessions,
    schemas: schemasThat(acceptDefault),
    broker: new FileArtifactBroker(),
    workspacePathFor: (agentId) => harness.workspaces.workspacePath(agentId),
    pollIntervalMs: 5,
    buildPrompt: (input) =>
      input.stage.instruction +
      (input.violations.length ? "\nFix: " + input.violations.join("; ") : ""),
    ...overrides,
  });
}

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const RESEARCH = JSON.stringify({
  claims: [{ id: "claim-1", text: "Recycling recovers lithium.", sourceId: "source-1.md" }],
});
const GOOD_SUMMARY = JSON.stringify({
  keyPoints: [{ text: "Lithium is recoverable.", citedClaimIds: ["claim-1"] }],
});
const HALLUCINATED_SUMMARY = JSON.stringify({
  keyPoints: [{ text: "Cobalt is recoverable.", citedClaimIds: ["claim-99"] }],
});
const REPORT = "# Report\n\nLithium is recoverable [claim-1].\n";

function threeStageInput(
  researcherId: string,
  summarizerId: string,
  formatterId: string,
  maxAttempts = 2,
): CreateSessionInput {
  return {
    title: "Provenance run",
    topic: "battery recycling",
    stages: [
      {
        id: "research",
        role: "Researcher",
        agentId: researcherId,
        schemaId: "research",
        outputPath: "research.json",
        inputFileName: null,
        instruction: "Extract claims from the seeded sources.",
        maxAttempts,
      },
      {
        id: "summary",
        role: "Summarizer",
        agentId: summarizerId,
        schemaId: "summary",
        outputPath: "summary.json",
        inputFileName: "research.json",
        instruction: "Condense the claims into cited key points.",
        maxAttempts,
      },
      {
        id: "report",
        role: "Formatter",
        agentId: formatterId,
        schemaId: "report",
        outputPath: "report.md",
        inputFileName: "summary.json",
        instruction: "Format the summary into a cited report.",
        maxAttempts,
      },
    ],
    sources: [{ name: "source-1.md", content: "# Source one" }],
  };
}

async function threeAgents(harness: Harness) {
  const researcher = await harness.service.createAgent({ name: "Researcher" });
  const summarizer = await harness.service.createAgent({ name: "Summarizer" });
  const formatter = await harness.service.createAgent({ name: "Formatter" });
  harness.scripted.set(researcher.id, [{ write: { fileName: "research.json", content: RESEARCH } }]);
  harness.scripted.set(formatter.id, [{ write: { fileName: "report.md", content: REPORT } }]);
  return { researcher, summarizer, formatter };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("SessionCoordinator — happy path", () => {
  it("admits every stage and brokers each artifact into the next workspace", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    harness.scripted.set(summarizer.id, [
      { write: { fileName: "summary.json", content: GOOD_SUMMARY } },
    ]);

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    await coordinatorFor(harness).start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");

    const finished = harness.sessions.require(session.id);
    expect(finished.version).toBe(3);
    expect(Object.keys(finished.sharedState.artifacts).sort()).toEqual([
      "report",
      "research",
      "summary",
    ]);
    expect(finished.sharedState.currentStageIndex).toBe(3);
    for (const artifact of Object.values(finished.sharedState.artifacts)) {
      expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/);
    }

    // The claim the whole design rests on: each stage's output physically
    // reached the next agent's sealed workspace, and only the coordinator
    // could have put it there.
    await expect(
      readFile(path.join(harness.workspaces.workspacePath(summarizer.id), "research.json"), "utf8"),
    ).resolves.toBe(RESEARCH);
    await expect(
      readFile(path.join(harness.workspaces.workspacePath(formatter.id), "summary.json"), "utf8"),
    ).resolves.toBe(GOOD_SUMMARY);

    expect(harness.sessions.events(session.id).map((event) => event.type)).toEqual([
      "session.started",
      "stage.assigned",
      "stage.completed",
      "stage.assigned",
      "stage.completed",
      "stage.assigned",
      "stage.completed",
      "session.completed",
    ]);
  });

  it("refuses a second concurrent start with a 409", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    harness.scripted.set(summarizer.id, [
      { write: { fileName: "summary.json", content: GOOD_SUMMARY } },
    ]);
    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    const coordinator = coordinatorFor(harness);

    await coordinator.start(session.id);
    await expect(coordinator.start(session.id)).rejects.toMatchObject({ statusCode: 409 });

    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");
    expect(
      harness.sessions.events(session.id).filter((e) => e.type === "session.started"),
    ).toHaveLength(1);
  });
});

describe("SessionCoordinator — a held stage never propagates", () => {
  it("rejects a hallucinated citation, keeps the chain intact, then admits the retry", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    // Attempt 1 cites a claim stage 1 never produced; attempt 2 is correct.
    harness.scripted.set(summarizer.id, [
      { write: { fileName: "summary.json", content: HALLUCINATED_SUMMARY } },
      { write: { fileName: "summary.json", content: GOOD_SUMMARY } },
    ]);

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );

    const formatterWorkspace = harness.workspaces.workspacePath(formatter.id);
    let versionAtRejection: number | null = null;

    const coordinator = coordinatorFor(harness, {
      schemas: schemasThat((schemaId, raw, call) => {
        if (schemaId !== "summary") return acceptDefault(schemaId, raw, call);
        const parsed = JSON.parse(raw) as {
          keyPoints: Array<{ citedClaimIds: string[] }>;
        };
        const known = new Set(
          (JSON.parse(RESEARCH) as { claims: Array<{ id: string }> }).claims.map((c) => c.id),
        );
        const bad = parsed.keyPoints
          .flatMap((point) => point.citedClaimIds)
          .filter((id) => !known.has(id));
        if (bad.length > 0) {
          versionAtRejection = harness.sessions.require(session.id).version;
          return { ok: false, violations: ["cited claims not in stage 1: " + bad.join(", ")] };
        }
        return { ok: true, value: parsed };
      }),
    });

    await coordinator.start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");

    const events = harness.sessions.events(session.id);
    const rejected = events.find((event) => event.type === "stage.rejected");
    expect(rejected?.stageId).toBe("summary");
    expect(rejected?.attempt).toBe(1);
    expect(rejected?.payload.violations?.[0]).toContain("claim-99");

    // INVARIANT 5: the hold left version exactly where stage 1 put it.
    expect(versionAtRejection).toBe(1);
    const finished = harness.sessions.require(session.id);
    expect(finished.sharedState.attempts["summary"]).toBe(1);
    expect(finished.version).toBe(3);

    // The bad summary never reached stage 3. Only the admitted one did.
    await expect(
      readFile(path.join(formatterWorkspace, "summary.json"), "utf8"),
    ).resolves.toBe(GOOD_SUMMARY);
  });

  it("holds when the agent writes no artifact and offers no fenced block", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    harness.scripted.set(summarizer.id, [{ replyOnly: "I was unable to complete this." }]);

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id, 1),
    );
    await coordinatorFor(harness).start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("failed");

    const rejected = harness.sessions
      .events(session.id)
      .find((event) => event.type === "stage.rejected");
    expect(rejected?.payload.violations?.[0]).toContain("artifact missing");
    expect(harness.sessions.require(session.id).version).toBe(1);
  });

  it("fails the session when the attempt budget is spent, keeping earlier artifacts", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    harness.scripted.set(summarizer.id, [
      { write: { fileName: "summary.json", content: HALLUCINATED_SUMMARY } },
    ]);

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    await coordinatorFor(harness, {
      schemas: schemasThat((schemaId, raw, call) =>
        schemaId === "summary"
          ? { ok: false, violations: ["cited claims not in stage 1: claim-99"] }
          : acceptDefault(schemaId, raw, call),
      ),
    }).start(session.id);

    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("failed");

    const finished = harness.sessions.require(session.id);
    expect(finished.sharedState.attempts["summary"]).toBe(2);
    expect(finished.error).toContain("claim-99");
    // Stage 1's artifact survives the failure and is still readable.
    expect(finished.version).toBe(1);
    expect(finished.sharedState.artifacts["research"]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.sharedState.artifacts["summary"]).toBeUndefined();
  });
});

describe("SessionCoordinator — recovery and control", () => {
  it("times out a hung stage, then restores the agent so it can be dispatched again", async () => {
    const harness = await makeHarness(hangingRunner());
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id, 1),
    );

    await coordinatorFor(harness, { stageTimeoutMs: 60 }).start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("failed");

    const timedOut = harness.sessions
      .events(session.id)
      .find((event) => event.type === "stage.timeout");
    expect(timedOut?.stageId).toBe("research");
    expect(timedOut?.payload.violations?.[0]).toContain("deadline exceeded");

    // The landmine: stopAgent alone would leave this agent "stopped", and
    // sendMessage rejects a stopped agent, bricking it for the rest of the run.
    expect(harness.service.getAgent(researcher.id).status).toBe("ready");
    expect(harness.sessions.require(session.id).sharedState.attempts["research"]).toBe(1);
  });

  it("stops a running session on request and keeps what was already admitted", async () => {
    const harness = await makeHarness(hangingRunner());
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    const coordinator = coordinatorFor(harness, { stageTimeoutMs: 10_000 });

    await coordinator.start(session.id);
    await expect.poll(() => coordinator.isRunning(session.id), { timeout: 2_000 }).toBe(true);

    const stopped = await coordinator.stop(session.id);

    expect(stopped.state).toBe("stopped");
    expect(coordinator.isRunning(session.id)).toBe(false);
    expect(harness.service.getAgent(researcher.id).status).toBe("ready");
  });
});

describe("FileArtifactBroker", () => {
  it("falls back to a fenced json block when no file was written", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Prose" });
    const collected = await new FileArtifactBroker().collect(
      harness.workspaces.workspacePath(agent.id),
      "research.json",
      'Here you go.\n\n```json\n{"claims":[]}\n```\n',
    );
    expect(collected).toMatchObject({ found: true, source: "reply" });
    expect(collected.found && (JSON.parse(collected.raw) as unknown)).toEqual({ claims: [] });
  });

  it("reports not found when there is neither a file nor a fenced block", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Empty" });
    const collected = await new FileArtifactBroker().collect(
      harness.workspaces.workspacePath(agent.id),
      "research.json",
      "I could not complete the task.",
    );
    expect(collected).toEqual({ found: false });
  });

  it("refuses a stage output path that escapes the workspace", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Escapee" });
    await expect(
      new FileArtifactBroker().collect(
        harness.workspaces.workspacePath(agent.id),
        "../../etc/passwd",
        "",
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// --------------------------------------------------------------------------
// Integration: the real schema registry, not a fake
// --------------------------------------------------------------------------

/**
 * Every other test in this file substitutes schemasThat(...), whose validate
 * ignores ValidationContext entirely. That is why the coordinator could hand
 * schemas Artifact metadata instead of admitted values for as long as it did:
 * no test on either side crossed the seam. These drive the real registry.
 */
describe("SessionCoordinator + the real schema registry", () => {
  const REAL_RESEARCH = JSON.stringify({
    claims: [
      { id: "claim-1", text: "Recycling recovers lithium.", confidence: 0.9, sourceId: "source-1.md" },
      { id: "claim-2", text: "Recovery rates are rising.", confidence: 0.8, sourceId: "source-1.md" },
      { id: "claim-3", text: "Cost per cell is falling.", confidence: 0.7, sourceId: "source-1.md" },
    ],
  });
  const REAL_SUMMARY = JSON.stringify({
    keyPoints: [{ text: "Lithium is recoverable at rising rates.", citedClaimIds: ["claim-1", "claim-2"] }],
  });
  const REAL_REPORT =
    "# Battery Recycling\n\nLithium is recoverable at rising rates.\n\n## References\n- source-1.md\n";

  function scriptAll(
    harness: Harness,
    ids: { researcher: string; summarizer: string; formatter: string },
    summary = REAL_SUMMARY,
  ): void {
    harness.scripted.set(ids.researcher, [{ write: { fileName: "research.json", content: REAL_RESEARCH } }]);
    harness.scripted.set(ids.summarizer, [{ write: { fileName: "summary.json", content: summary } }]);
    harness.scripted.set(ids.formatter, [{ write: { fileName: "report.md", content: REAL_REPORT } }]);
  }

  it("completes all three stages with every gate actually enforced", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    scriptAll(harness, { researcher: researcher.id, summarizer: summarizer.id, formatter: formatter.id });

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    await coordinatorFor(harness, { schemas: createSchemaRegistry() }).start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");

    const finished = harness.sessions.require(session.id);
    expect(finished.version).toBe(3);

    // The seam: later stages receive the parsed value that was admitted,
    // not the Artifact metadata record.
    const admitted = finished.sharedState.artifactValues["research"] as { claims: unknown[] };
    expect(admitted.claims).toHaveLength(3);
    expect(finished.sharedState.artifacts["research"]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds the summary stage when a citation resolves to no admitted claim", async () => {
    const harness = await makeHarness();
    const { researcher, summarizer, formatter } = await threeAgents(harness);
    scriptAll(
      harness,
      { researcher: researcher.id, summarizer: summarizer.id, formatter: formatter.id },
      JSON.stringify({ keyPoints: [{ text: "Cobalt is recoverable.", citedClaimIds: ["claim-99"] }] }),
    );

    const session = await harness.sessions.create(
      threeStageInput(researcher.id, summarizer.id, formatter.id),
    );
    await coordinatorFor(harness, { schemas: createSchemaRegistry() }).start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("failed");

    const finished = harness.sessions.require(session.id);
    expect(finished.sharedState.artifacts["research"]).toBeDefined();
    expect(finished.sharedState.artifacts["summary"]).toBeUndefined();

    const violations = harness.sessions
      .events(session.id)
      .filter((event) => event.type === "stage.rejected")
      .flatMap((event) => event.payload.violations ?? []);
    expect(violations.join(" ")).toMatch(/claim-99/);
  });
});
