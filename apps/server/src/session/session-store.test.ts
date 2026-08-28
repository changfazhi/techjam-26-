import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
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

async function makeStore(): Promise<{ sessions: SessionStore; filePath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "handoff-gate-test-"));
  temporaryDirectories.push(root);
  const filePath = path.join(root, "launchpad.json");
  const store = new JsonStore(filePath);
  await store.initialize();
  return { sessions: new SessionStore(store), filePath };
}

const input = (overrides: Partial<CreateSessionInput> = {}): CreateSessionInput => ({
  title: "Provenance run",
  topic: "battery recycling",
  stages: [
    {
      id: "research",
      role: "Researcher",
      agentId: "agent-a",
      schemaId: "research",
      outputPath: "research.json",
      inputFileName: null,
      instruction: "Extract claims from the seeded sources.",
    },
    {
      id: "summary",
      role: "Summarizer",
      agentId: "agent-b",
      schemaId: "summary",
      outputPath: "summary.json",
      inputFileName: "research.json",
      instruction: "Condense the claims into cited key points.",
      maxAttempts: 3,
    },
  ],
  sources: [{ name: "source-1.md", content: "# Source one" }],
  ...overrides,
});

describe("SessionStore", () => {
  it("creates a session with defaulted attempts and an empty artifact chain", async () => {
    const { sessions } = await makeStore();
    const session = await sessions.create(input());

    expect(session.state).toBe("idle");
    expect(session.version).toBe(0);
    expect(session.sharedState).toEqual({
      currentStageIndex: 0,
      artifacts: {},
      attempts: {},
    });
    expect(session.sourceManifest).toEqual(["source-1.md"]);
    expect(session.stages[0]?.maxAttempts).toBe(2);
    expect(session.stages[1]?.maxAttempts).toBe(3);
    expect(sessions.list()).toHaveLength(1);
    expect(sessions.get(session.id)?.title).toBe("Provenance run");
  });

  it("assigns gapless sequence numbers scoped to one session", async () => {
    const { sessions } = await makeStore();
    const first = await sessions.create(input());
    const second = await sessions.create(input({ title: "Second run" }));

    for (const sessionId of [first.id, first.id, second.id, first.id]) {
      await sessions.appendEvent({
        sessionId,
        stageId: null,
        agentId: null,
        runId: null,
        type: "session.started",
        attempt: null,
        payload: {},
      });
    }

    expect(sessions.events(first.id).map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(sessions.events(second.id).map((event) => event.seq)).toEqual([1]);
    expect(sessions.events(first.id, 2).map((event) => event.seq)).toEqual([3]);
  });

  it("persists a session across a restart of the store", async () => {
    const { sessions, filePath } = await makeStore();
    const created = await sessions.create(input());
    await sessions.update(created.id, (session) => {
      session.state = "running";
    });

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    const session = new SessionStore(reopened).get(created.id);

    expect(session?.state).toBe("running");
    expect(session?.stages).toHaveLength(2);
  });

  it("loads a database file written before the session tables existed", async () => {
    const { filePath } = await makeStore();
    const legacy = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy["sessions"];
    delete legacy["sessionEvents"];
    await writeFile(filePath, JSON.stringify(legacy, null, 2), "utf8");

    const reopened = new JsonStore(filePath);
    await reopened.initialize();
    const sessions = new SessionStore(reopened);

    expect(sessions.list()).toEqual([]);
    await expect(sessions.create(input())).resolves.toMatchObject({ state: "idle" });
  });

  it("rejects an unknown session id with a 404", async () => {
    const { sessions } = await makeStore();
    expect(() => sessions.require("missing")).toThrow(/not found/i);
    await expect(
      sessions.update("missing", (session) => {
        session.state = "failed";
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
