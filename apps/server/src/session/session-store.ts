/**
 * Typed accessors over JsonStore for sessions and their event log.
 * Owned by W1 (Foundation). See docs/BLUEPRINT.md section 5.2.
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "../errors.js";
import type { JsonStore } from "../store.js";
import type {
  CreateSessionInput,
  NewSessionEvent,
  Session,
  SessionEvent,
  Stage,
} from "./types.js";

const now = (): string => new Date().toISOString();

const DEFAULT_MAX_ATTEMPTS = 2;

export class SessionStore {
  constructor(private readonly store: JsonStore) {}

  async create(input: CreateSessionInput): Promise<Session> {
    const timestamp = now();
    const stages: Stage[] = input.stages.map((stage) => ({
      id: stage.id,
      role: stage.role,
      agentId: stage.agentId,
      schemaId: stage.schemaId,
      outputPath: stage.outputPath,
      inputFileName: stage.inputFileName,
      instruction: stage.instruction,
      maxAttempts: stage.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    }));
    const session: Session = {
      id: randomUUID(),
      title: input.title.trim(),
      topic: input.topic.trim(),
      stages,
      sourceManifest: input.sources.map((source) => source.name),
      state: "idle",
      sharedState: { currentStageIndex: 0, artifacts: {}, artifactValues: {}, attempts: {} },
      version: 0,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.store.mutate((database) => {
      database.sessions.push(session);
    });
    return session;
  }

  get(id: string): Session | undefined {
    return this.store.snapshot().sessions.find((session) => session.id === id);
  }

  /** Throws HttpError(404) instead of returning undefined. */
  require(id: string): Session {
    const session = this.get(id);
    if (!session) {
      throw new HttpError(404, "Session not found");
    }
    return session;
  }

  list(): Session[] {
    return this.store
      .snapshot()
      .sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /**
   * Serialized read-modify-write. The mutation runs inside JsonStore.mutate, so
   * concurrent callers are queued rather than interleaved.
   */
  async update(id: string, mutation: (session: Session) => void): Promise<Session> {
    return this.store.mutate((database) => {
      const session = database.sessions.find((item) => item.id === id);
      if (!session) {
        throw new HttpError(404, "Session not found");
      }
      mutation(session);
      session.updatedAt = now();
      return structuredClone(session);
    });
  }

  /**
   * Appends one event. `seq` is assigned inside the same mutate callback that
   * writes the event, so sequence numbers are gapless and unique per session.
   */
  async appendEvent(event: NewSessionEvent): Promise<SessionEvent> {
    return this.store.mutate((database) => {
      const highest = database.sessionEvents.reduce(
        (max, item) => (item.sessionId === event.sessionId && item.seq > max ? item.seq : max),
        0,
      );
      const stored: SessionEvent = {
        ...event,
        id: randomUUID(),
        seq: highest + 1,
        createdAt: now(),
      };
      database.sessionEvents.push(stored);
      return structuredClone(stored);
    });
  }

  events(sessionId: string, afterSeq = 0): SessionEvent[] {
    return this.store
      .snapshot()
      .sessionEvents.filter((event) => event.sessionId === sessionId && event.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq);
  }
}
