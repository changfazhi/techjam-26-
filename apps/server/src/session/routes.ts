/**
 * Fastify plugin: the five session routes.
 * Owned by W3 (API). See docs/BLUEPRINT.md section 5.5.
 *
 * STUB — W3 implements. Registered once from app.ts; app.ts is frozen after the
 * foundation commit, so every route change happens in this file.
 */

import type { FastifyInstance } from "fastify";
import type { SessionCoordinator } from "./coordinator.js";
import type { SessionStore } from "./session-store.js";

export interface SessionRouteDeps {
  sessions: SessionStore;
  coordinator: SessionCoordinator;
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
  app.get("/api/sessions", async () => ({ sessions: deps.sessions.list() }));
}
