import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { FileArtifactBroker } from "./broker.js";
import { SessionCoordinator } from "./coordinator.js";
import type { SchemaRegistry } from "./schemas/index.js";
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

/** Accepts any parseable JSON. W4's real schemas are not needed to prove the loop. */
const permissiveSchemas: SchemaRegistry = {
  get: () => ({
    id: "fake",
    describe: () => "any json object",
    validate: (raw: string) => {
      try {
        return { ok: true as const, value: JSON.parse(raw) as unknown };
      } catch {
        return { ok: false as const, violations: ["not valid json"] };
      }
    },
  }),
};

interface Harness {
  service: AgentService;
  sessions: SessionStore;
  workspaces: WorkspaceManager;
  /** agentId -> what that agent writes when it runs. Populated after agents exist. */
  scripted: Map<string, { fileName: string; content: string } | "prose-only">;
}

async function makeHarness(): Promise<Harness> {
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

  // The fake agent writes a real file into its own workspace, exercising the
  // broker's file path rather than the reply fallback.
  const runner: AgentRunner = {
    isAvailable: async () => true,
    cancel: async () => false,
    run: async (request: RunnerRequest): Promise<RunnerResult> => {
      const script = scripted.get(request.agentId);
      if (script && script !== "prose-only") {
        await writeFile(
          path.join(request.workspacePath, script.fileName),
          script.content,
          "utf8",
        );
        return { output: "wrote " + script.fileName, threadId: "thread", usage: null };
      }
      return {
        output: "No file this time.\n\n```json\n{\"fromReply\":true}\n```\n",
        threadId: "thread",
        usage: null,
      };
    },
  };

  // One JsonStore shared by both. Two stores over the same file would clobber.
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const service = new AgentService(config, store, workspaces, runner);
  await service.initialize();

  return { service, sessions: new SessionStore(store), workspaces, scripted };
}

function twoStageInput(researcherId: string, summarizerId: string): CreateSessionInput {
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
      },
      {
        id: "summary",
        role: "Summarizer",
        agentId: summarizerId,
        schemaId: "summary",
        outputPath: "summary.json",
        inputFileName: "research.json",
        instruction: "Condense the claims into cited key points.",
      },
    ],
    sources: [{ name: "source-1.md", content: "# Source one" }],
  };
}

const RESEARCH_PAYLOAD = JSON.stringify({
  claims: [{ id: "claim-1", text: "Recycling recovers lithium.", sourceId: "source-1.md" }],
});
const SUMMARY_PAYLOAD = JSON.stringify({
  keyPoints: [{ text: "Lithium is recoverable.", citedClaimIds: ["claim-1"] }],
});

describe("SessionCoordinator — happy path", () => {
  it("admits every stage and brokers each artifact into the next workspace", async () => {
    const harness = await makeHarness();
    const researcher = await harness.service.createAgent({ name: "Researcher" });
    const summarizer = await harness.service.createAgent({ name: "Summarizer" });
    harness.scripted.set(researcher.id, {
      fileName: "research.json",
      content: RESEARCH_PAYLOAD,
    });
    harness.scripted.set(summarizer.id, {
      fileName: "summary.json",
      content: SUMMARY_PAYLOAD,
    });

    const session = await harness.sessions.create(
      twoStageInput(researcher.id, summarizer.id),
    );
    const coordinator = new SessionCoordinator({
      agents: harness.service,
      sessions: harness.sessions,
      schemas: permissiveSchemas,
      broker: new FileArtifactBroker(),
      workspacePathFor: (agentId) => harness.workspaces.workspacePath(agentId),
      pollIntervalMs: 5,
      buildPrompt: (input) => input.stage.instruction,
    });

    await coordinator.start(session.id);
    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");

    const finished = harness.sessions.require(session.id);
    expect(finished.version).toBe(2);
    expect(Object.keys(finished.sharedState.artifacts).sort()).toEqual([
      "research",
      "summary",
    ]);
    expect(finished.sharedState.currentStageIndex).toBe(2);
    for (const artifact of Object.values(finished.sharedState.artifacts)) {
      expect(artifact.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.bytes).toBeGreaterThan(0);
    }

    // The claim the whole design rests on: stage 1's output physically reached
    // stage 2's sealed workspace, and only the coordinator could have put it there.
    const delivered = await readFile(
      path.join(harness.workspaces.workspacePath(summarizer.id), "research.json"),
      "utf8",
    );
    expect(delivered).toBe(RESEARCH_PAYLOAD);

    const events = harness.sessions.events(session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "stage.assigned",
      "stage.completed",
      "stage.assigned",
      "stage.completed",
      "session.completed",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(events[2]?.payload.artifactHash).toBe(
      finished.sharedState.artifacts["research"]?.hash,
    );
  });

  it("refuses a second concurrent start with a 409", async () => {
    const harness = await makeHarness();
    const researcher = await harness.service.createAgent({ name: "Researcher" });
    const summarizer = await harness.service.createAgent({ name: "Summarizer" });
    harness.scripted.set(researcher.id, {
      fileName: "research.json",
      content: RESEARCH_PAYLOAD,
    });
    harness.scripted.set(summarizer.id, {
      fileName: "summary.json",
      content: SUMMARY_PAYLOAD,
    });

    const session = await harness.sessions.create(
      twoStageInput(researcher.id, summarizer.id),
    );
    const coordinator = new SessionCoordinator({
      agents: harness.service,
      sessions: harness.sessions,
      schemas: permissiveSchemas,
      broker: new FileArtifactBroker(),
      workspacePathFor: (agentId) => harness.workspaces.workspacePath(agentId),
      pollIntervalMs: 5,
      buildPrompt: (input) => input.stage.instruction,
    });

    await coordinator.start(session.id);
    await expect(coordinator.start(session.id)).rejects.toMatchObject({ statusCode: 409 });

    await expect
      .poll(() => harness.sessions.get(session.id)?.state, { timeout: 5_000 })
      .toBe("completed");
    const started = harness.sessions
      .events(session.id)
      .filter((event) => event.type === "session.started");
    expect(started).toHaveLength(1);
  });
});

describe("FileArtifactBroker", () => {
  it("falls back to a fenced json block when no file was written", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Prose" });
    const broker = new FileArtifactBroker();

    const collected = await broker.collect(
      harness.workspaces.workspacePath(agent.id),
      "research.json",
      'Here you go.\n\n```json\n{"claims":[]}\n```\n',
    );

    expect(collected).toMatchObject({ found: true, source: "reply" });
    expect(collected.found && JSON.parse(collected.raw)).toEqual({ claims: [] });
  });

  it("reports not found when there is neither a file nor a fenced block", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Empty" });
    const broker = new FileArtifactBroker();

    const collected = await broker.collect(
      harness.workspaces.workspacePath(agent.id),
      "research.json",
      "I could not complete the task.",
    );

    expect(collected).toEqual({ found: false });
  });

  it("refuses a stage output path that escapes the workspace", async () => {
    const harness = await makeHarness();
    const agent = await harness.service.createAgent({ name: "Escapee" });
    const broker = new FileArtifactBroker();

    await expect(
      broker.collect(harness.workspaces.workspacePath(agent.id), "../../etc/passwd", ""),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
