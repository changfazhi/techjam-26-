/**
 * Fastify plugin: the five session routes.
 * Owned by W3 (API). See docs/BLUEPRINT.md section 5.5.
 *
 * STUB — W3 implements. Registered once from app.ts; app.ts is frozen after the
 * foundation commit, so every route change happens in this file.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AgentService } from "../agent-service.js";
import type { ArtifactBroker } from "./broker.js";
import type { SessionCoordinator } from "./coordinator.js";
import type { SessionStore } from "./session-store.js";


const sessionIdParams = z.object({ id: z.string().uuid() });

const eventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
});

export interface SessionRouteDeps {
  sessions: SessionStore;
  coordinator: SessionCoordinator;
  agents: Pick<AgentService, "getAgent">;
  broker: Pick<ArtifactBroker, "seed">;
  workspacePathFor(agentId: string): string;
}

export async function sessionRoutes(
  app: FastifyInstance,
  deps: SessionRouteDeps,
): Promise<void> {
  // W3: replace with the five documented routes.
  // POST   /api/sessions
  // GET    /api/sessions
  // GET    /api/sessions/:id
  // POST   /api/sessions/:id/start
  // POST   /api/sessions/:id/stop
  // GET    /api/sessions/:id/events?after=<seq>
  app.get("/api/sessions/:id", async (request) => {
  const { id } = sessionIdParams.parse(request.params);
  return { session: deps.sessions.require(id) };
});

app.post("/api/sessions/:id/start", async (request, reply) => {
  const { id } = sessionIdParams.parse(request.params);
  const session = await deps.coordinator.start(id);
  return reply.code(202).send({ session });
});

app.post("/api/sessions/:id/stop", async (request) => {
  const { id } = sessionIdParams.parse(request.params);
  return { session: await deps.coordinator.stop(id) };
});

app.get("/api/sessions/:id/events", async (request) => {
  const { id } = sessionIdParams.parse(request.params);
  const { after } = eventsQuery.parse(request.query);

  deps.sessions.require(id); // ensures an unknown session is 404
  return { events: deps.sessions.events(id, after) };
});
  app.get("/api/sessions", async () => ({ sessions: deps.sessions.list() }));
}
