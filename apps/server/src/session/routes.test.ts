import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import type { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { HttpError } from "../errors.js";
import type { SessionCoordinator } from "./coordinator.js";
import type { SessionStore } from "./session-store.js";
import type { Session, SessionEvent } from "./types.js";

const session: Session = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  title: "Test session",
  topic: "Route tests",
  stages: [],
  sourceManifest: [],
  state: "idle",
  sharedState: { currentStageIndex: 0, artifacts: {}, attempts: {} },
  version: 0,
  error: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const event: SessionEvent = {
  id: "4f8fad5b-d9cb-469f-a165-70867728950e",
  sessionId: session.id,
  seq: 8,
  stageId: null,
  agentId: null,
  runId: null,
  type: "session.started",
  attempt: null,
  payload: {},
  createdAt: "2026-08-30T00:00:01.000Z",
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function makeHarness() {
  const list = vi.fn(() => [session]);
  const require = vi.fn(() => session);
  const events = vi.fn(() => [event]);
  const start = vi.fn(async () => ({ ...session, state: "running" as const }));
  const stop = vi.fn(async () => ({ ...session, state: "stopped" as const }));

  const sessions = { list, require, events } as unknown as SessionStore;
  const coordinator = { start, stop } as unknown as SessionCoordinator;
  const service = {} as AgentService;
  const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, {
    sessions,
    coordinator,
  });
  apps.push(app);

  return { app, list, require, events, start, stop };
}

describe("session routes", () => {
  it("lists sessions", async () => {
    const { app, list } = await makeHarness();

    const response = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessions: [session] });
    expect(list).toHaveBeenCalledOnce();
  });

  it("gets a session by id", async () => {
    const { app, require } = await makeHarness();

    const response = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session });
    expect(require).toHaveBeenCalledWith(session.id);
  });

  it("starts a session asynchronously", async () => {
    const { app, start } = await makeHarness();

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/start`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ session: Session }>().session.state).toBe("running");
    expect(start).toHaveBeenCalledWith(session.id);
  });

  it("stops a session", async () => {
    const { app, stop } = await makeHarness();

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/stop`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ session: Session }>().session.state).toBe("stopped");
    expect(stop).toHaveBeenCalledWith(session.id);
  });

  it("returns events after a sequence number", async () => {
    const { app, require, events } = await makeHarness();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events?after=7`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [event] });
    expect(require).toHaveBeenCalledWith(session.id);
    expect(events).toHaveBeenCalledWith(session.id, 7);
  });

  it("rejects an invalid event cursor", async () => {
    const { app } = await makeHarness();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events?after=-1`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a non-numeric event cursor", async () => {
    const { app } = await makeHarness();

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events?after=not-a-number`,
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a malformed session id", async () => {
    const { app } = await makeHarness();

    const response = await app.inject({ method: "GET", url: "/api/sessions/not-a-uuid" });

    expect(response.statusCode).toBe(400);
  });

  it("preserves a missing-session error", async () => {
    const { app, require } = await makeHarness();
    require.mockImplementation(() => {
      throw new HttpError(404, "Session not found");
    });

    const response = await app.inject({ method: "GET", url: `/api/sessions/${session.id}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Session not found" });
  });

  it("preserves a missing-session start error", async () => {
    const { app, start } = await makeHarness();
    start.mockRejectedValueOnce(new HttpError(404, "Session not found"));

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/start`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Session not found" });
  });

  it("preserves a missing-session stop error", async () => {
    const { app, stop } = await makeHarness();
    stop.mockRejectedValueOnce(new HttpError(404, "Session not found"));

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/stop`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Session not found" });
  });

  it("returns 404 when requesting events for a missing session", async () => {
    const { app, require } = await makeHarness();
    require.mockImplementation(() => {
      throw new HttpError(404, "Session not found");
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/events`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Session not found" });
  });

  it("returns one accepted response and one conflict for concurrent starts", async () => {
    const { app, start } = await makeHarness();
    start
      .mockResolvedValueOnce({ ...session, state: "running" as const })
      .mockRejectedValueOnce(new HttpError(409, "This session is already running"));

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/api/sessions/${session.id}/start` }),
      app.inject({ method: "POST", url: `/api/sessions/${session.id}/start` }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    const conflict = [first, second].find((response) => response.statusCode === 409);
    expect(conflict?.json()).toEqual({ error: "This session is already running" });
    expect(start).toHaveBeenCalledTimes(2);
  });
});
