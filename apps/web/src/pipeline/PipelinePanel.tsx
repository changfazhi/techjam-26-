import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, pipelineApi } from "../api";
import type { Agent, Artifact, Session, SessionEvent, Stage } from "../types";
import "./pipeline.css";

const POLL_INTERVAL_MS = 900;
/** Consecutive failed polls tolerated before live updates give up. */
const MAX_POLL_FAILURES = 5;

export interface PipelinePanelProps {
  agentId: string;
  onClose: () => void;
}

export function PipelinePanel({ agentId, onClose }: PipelinePanelProps) {
  const titleId = useId();
  const afterSeq = useRef(0);
  const fixture = useMemo(() => makeFixture(agentId), [agentId]);
  const [session, setSession] = useState<Session>(fixture.session);
  const [events, setEvents] = useState<SessionEvent[]>(fixture.events);
  const [availableSessions, setAvailableSessions] = useState<Session[]>([]);
  const [live, setLive] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let active = true;
    afterSeq.current = fixture.events.at(-1)?.seq ?? 0;
    setSession(fixture.session);
    setEvents(fixture.events);
    setAvailableSessions([]);
    setLive(false);
    setNote(null);

    void (async () => {
      try {
        const { sessions } = await pipelineApi.list();
        const matches = sessions
          .filter((item) => item.stages.some((stage) => stage.agentId === agentId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const match = matches[0];

        if (active) setAvailableSessions(matches);

        if (!match) {
          if (active) setNote("No pipeline session found for agent " + agentId + ".");
          return;
        }

        const [{ session: current }, { events: currentEvents }] = await Promise.all([
          pipelineApi.get(match.id),
          pipelineApi.events(match.id),
        ]);
        if (!active) return;

        afterSeq.current = currentEvents.at(-1)?.seq ?? 0;
        setSession(current);
        setEvents(currentEvents);
        setLive(true);
      } catch (error) {
        if (!active) return;
        setNote(
          error instanceof Error
            ? "Live data unavailable: " + error.message
            : "Live data unavailable.",
        );
      }
    })();

    return () => {
      active = false;
    };
  }, [agentId, fixture]);

  useEffect(() => {
    if (!live || session.state !== "running") return;
    let active = true;

    void (async () => {
      const pullEvents = async (): Promise<void> => {
        const { events: incoming } = await pipelineApi.events(session.id, afterSeq.current);
        if (!active || !incoming.length) return;
        afterSeq.current = incoming.at(-1)?.seq ?? afterSeq.current;
        setEvents((current) => mergeEvents(current, incoming));
      };

      let failures = 0;
      while (active) {
        await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          await pullEvents();
          if (!active) return;

          const { session: refreshed } = await pipelineApi.get(session.id);
          if (!active) return;
          setSession(refreshed);

          if (refreshed.state !== "running") {
            // The coordinator commits the terminal state before it emits the
            // closing events, so the last stage.completed and session.completed
            // land after the read above. One more pull or they are lost.
            await pullEvents();
            return;
          }

          failures = 0;
          setNote(null);
        } catch (error) {
          if (!active) return;
          failures += 1;
          const detail = error instanceof Error ? " " + error.message : "";
          if (failures >= MAX_POLL_FAILURES) {
            setNote("Live updates stopped after " + String(failures) + " failed polls." + detail);
            return;
          }
          setNote("Live updates interrupted, retrying." + detail);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [live, session.id, session.state]);

  const stop = async () => {
    if (!live || session.state !== "running") return;
    setStopping(true);
    try {
      const { session: stopped } = await pipelineApi.stop(session.id);
      setSession(stopped);
    } catch (error) {
      setNote(
        error instanceof Error
          ? "Could not stop pipeline: " + error.message
          : "Could not stop pipeline.",
      );
    } finally {
      setStopping(false);
    }
  };

  const selectSession = async (sessionId: string) => {
    if (!sessionId) {
      afterSeq.current = fixture.events.at(-1)?.seq ?? 0;
      setSession(fixture.session);
      setEvents(fixture.events);
      setLive(false);
      setNote("Showing the built-in walkthrough, not persisted data.");
      return;
    }

    setNote("Loading the selected live session...");
    try {
      const [{ session: selected }, { events: selectedEvents }] = await Promise.all([
        pipelineApi.get(sessionId),
        pipelineApi.events(sessionId),
      ]);
      afterSeq.current = selectedEvents.at(-1)?.seq ?? 0;
      setSession(selected);
      setEvents(selectedEvents);
      setLive(true);
      setNote(null);
    } catch (error) {
      setNote(
        error instanceof Error
          ? "Could not load the selected session: " + error.message
          : "Could not load the selected session.",
      );
    }
  };

  const startDemo = async () => {
    if (starting || session.state === "running") return;
    setStarting(true);
    setNote("Preparing a live three-agent session...");

    try {
      const { agents } = await api.listAgents();
      const researcher = await ensureDemoAgent("Researcher", agents, agentId);
      const summarizer = await ensureDemoAgent("Summarizer", agents);
      const formatter = await ensureDemoAgent("Formatter", agents);

      for (const agent of [researcher, summarizer, formatter]) {
        if (agent.status === "busy") {
          throw new Error(agent.name + " is already running another task.");
        }
        if (agent.status === "stopped") await api.startAgent(agent.id);
      }

      const { session: created } = await pipelineApi.create(
        demoSessionInput(researcher.id, summarizer.id, formatter.id),
      );
      const { session: running } = await pipelineApi.start(created.id);

      afterSeq.current = 0;
      setEvents([]);
      setSession(running);
      setAvailableSessions((current) => [
        running,
        ...current.filter((item) => item.id !== running.id),
      ]);
      setLive(true);
      setNote("Live demo started. Events and admitted artifacts update automatically.");
    } catch (error) {
      setNote(
        error instanceof Error
          ? "Could not start the live demo: " + error.message
          : "Could not start the live demo.",
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <section
      className={"pipeline-panel" + (live ? "" : " is-fixture")}
      aria-labelledby={titleId}
    >
      <header className="pipeline-panel-head">
        <div>
          <span className="eyebrow">Handoff Gate</span>
          <h2 id={titleId}>Pipeline</h2>
          <p>{session.title}</p>
        </div>
        <div className="pipeline-actions">
          <button
            className="button button-primary"
            type="button"
            onClick={startDemo}
            disabled={starting || session.state === "running"}
          >
            {starting ? "Starting..." : live ? "New live demo" : "Start live demo"}
          </button>
          <button
            className="button button-danger"
            type="button"
            onClick={stop}
            disabled={!live || session.state !== "running" || stopping}
          >
            {stopping ? "Stopping..." : "Stop"}
          </button>
          <button className="button button-ghost" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </header>

      <div className="pipeline-status">
        <strong>{session.state}</strong>
        <span>{session.version} / {session.stages.length} admitted</span>
        {!live && <span className="fixture-badge">Demo fixture &mdash; not live data</span>}
        {availableSessions.length > 0 && (
          <label className="pipeline-session-picker">
            Session
            <select
              value={live ? session.id : ""}
              onChange={(event) => void selectSession(event.target.value)}
            >
              <option value="">Built-in walkthrough</option>
              {availableSessions.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.title} - {item.state} - {new Date(item.createdAt).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {session.error && <p className="pipeline-error" role="alert">{session.error}</p>}
      {note && <p className="pipeline-note">{note}{!live ? " Showing the demo fixture." : ""}</p>}

      <p className="pipeline-invariant">
        three stages, in order, each admitted exactly once, no held artifact propagated.
      </p>

      <StageTimeline
        stages={session.stages}
        events={events}
        attempts={session.sharedState.attempts}
      />
      {/*
        A session persisted before artifactValues existed arrives without the
        field; the coordinator tolerates that the same way (coordinator.ts:358).
      */}
      <ArtifactViewer
        stages={session.stages}
        artifacts={session.sharedState.artifacts}
        values={session.sharedState.artifactValues ?? {}}
      />
    </section>
  );
}

function StageTimeline({
  stages,
  events,
  attempts,
}: {
  stages: Stage[];
  events: SessionEvent[];
  attempts: Record<string, number>;
}) {
  return (
    <section className="pipeline-section">
      <h3>Stage timeline</h3>
      <ol className="pipeline-timeline">
        {stages.map((stage, index) => {
          const stageEvents = events.filter((event) => event.stageId === stage.id);
          const held = stageEvents.filter(
            (event) => event.type === "stage.rejected" || event.type === "stage.timeout",
          );
          const admitted = stageEvents.some((event) => event.type === "stage.completed");
          // Events arrive ordered by seq, so the newest one decides: a stage whose
          // last word was stage.assigned is dispatched and still in flight.
          const running = !admitted && stageEvents.at(-1)?.type === "stage.assigned";
          const state = admitted ? "admitted" : running ? "running" : held.length ? "held" : "waiting";
          const label = admitted ? "Admitted" : running ? "Running" : held.length ? "Held" : "Waiting";
          const count = Math.max(
            attempts[stage.id] ?? 0,
            ...stageEvents.map((event) => event.attempt ?? 0),
          );

          return (
            <li className={"pipeline-stage " + state} key={stage.id}>
              <span className="stage-mark">{admitted ? "\u2713" : index + 1}</span>
              <div className="stage-content">
                <div className="stage-title">
                  <div>
                    <small>{stage.role}</small>
                    <h4>{stage.id}</h4>
                  </div>
                  <span>{count} attempt{count === 1 ? "" : "s"} - {label}</span>
                </div>
                {held.length > 0 && (
                  <details className="pipeline-violations" open>
                    <summary>Held on attempt {held.map((event) => event.attempt ?? "?").join(", ")}</summary>
                    <ul>
                      {held.flatMap((event) =>
                        (event.payload.violations ?? []).map((violation, violationIndex) => (
                          <li key={event.id + "#" + violationIndex}>{violation}</li>
                        )),
                      )}
                    </ul>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ArtifactViewer({
  stages,
  artifacts,
  values,
}: {
  stages: Stage[];
  artifacts: Record<string, Artifact>;
  values: Record<string, unknown>;
}) {
  return (
    <section className="pipeline-section">
      <h3>Artifact chain</h3>
      <ol className="pipeline-artifact-chain">
        {stages.map((stage) => {
          const artifact = artifacts[stage.id];

          return (
            <li key={stage.id}>
              <strong>{stage.outputPath}</strong>
              {artifact ? (
                <>
                  <span>Hash: {artifact.hash}</span>
                  <time dateTime={artifact.validatedAt}>
                    Validated: {new Date(artifact.validatedAt).toLocaleString()}
                  </time>
                  <details>
                    <summary>Gate-admitted value</summary>
                    <pre>{formatValue(values[stage.id])}</pre>
                  </details>
                </>
              ) : (
                <em>Not admitted - no artifact propagated.</em>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

async function ensureDemoAgent(
  role: "Researcher" | "Summarizer" | "Formatter",
  agents: Agent[],
  preferredId?: string,
): Promise<Agent> {
  const preferred = preferredId
    ? agents.find(
        (agent) => agent.id === preferredId && agent.name.toLowerCase() === role.toLowerCase(),
      )
    : undefined;
  const existing = preferred ?? agents.find(
    (agent) => agent.name.toLowerCase() === role.toLowerCase(),
  );
  if (existing) return existing;

  const { agent } = await api.createAgent({
    name: role,
    description: "Handoff Gate " + role + " stage",
    instructions: "Act as the " + role + " stage of the Handoff Gate pipeline.",
  });
  agents.push(agent);
  return agent;
}

function demoSessionInput(
  researcherId: string,
  summarizerId: string,
  formatterId: string,
) {
  return {
    title: "Battery recycling provenance demo",
    topic: "What can be recovered from lithium-ion batteries?",
    sources: [
      {
        name: "recycling-notes.md",
        content: "# Recycling notes\nLithium-ion battery recycling can recover lithium and nickel.",
      },
      {
        name: "safety-notes.md",
        content: "# Safety notes\nRecovering materials requires controlled processing.",
      },
      {
        name: "market-notes.md",
        content: "# Market notes\nRecycled materials can reduce demand for virgin extraction.",
      },
    ],
    stages: [
      {
        id: "research",
        role: "Researcher",
        agentId: researcherId,
        schemaId: "research",
        outputPath: "research.json",
        inputFileName: null,
        instruction: "Extract sourced claims from the seeded documents.",
      },
      {
        id: "summary",
        role: "Summarizer",
        agentId: summarizerId,
        schemaId: "summary",
        outputPath: "summary.json",
        inputFileName: "research.json",
        instruction: "Write cited key points using only the supplied claims.",
      },
      {
        id: "report",
        role: "Formatter",
        agentId: formatterId,
        schemaId: "report",
        outputPath: "report.md",
        inputFileName: "summary.json",
        instruction: "Format the cited key points as a concise Markdown report.",
      },
    ],
  };
}

function makeFixture(agentId: string): { session: Session; events: SessionEvent[] } {
  const stages: Stage[] = [
    stage("research", "Researcher", agentId, "research.json", null),
    stage("summary", "Summarizer", "fixture-summary", "summary.json", "research.json"),
    stage("report", "Formatter", "fixture-report", "report.md", "summary.json"),
  ];

  const event = (
    seq: number,
    type: SessionEvent["type"],
    stageId: string | null,
    agent: string | null,
    attempt: number | null,
    violations?: string[],
  ): SessionEvent => ({
    id: "fixture-" + seq,
    sessionId: "fixture-session",
    seq,
    stageId,
    agentId: agent,
    runId: stageId ? "run-" + seq : null,
    type,
    attempt,
    payload: violations ? { violations } : {},
    createdAt: "2026-08-30T09:00:0" + Math.min(seq, 9) + ".000Z",
  });

  const artifacts: Record<string, Artifact> = {
    research: artifact("research", "research.json", 482, "2026-08-30T09:00:02.000Z"),
    summary: artifact("summary", "summary.json", 186, "2026-08-30T09:00:05.000Z"),
    report: artifact("report", "report.md", 319, "2026-08-30T09:00:07.000Z"),
  };

  return {
    session: {
      id: "00000000-0000-4000-8000-000000000005",
      title: "Cited handoff demo",
      topic: "Validated handoffs",
      stages,
      sourceManifest: ["source-1.txt"],
      state: "completed",
      sharedState: {
        currentStageIndex: 3,
        attempts: { research: 1, summary: 2, report: 1 },
        artifacts,
        artifactValues: {
          research: { claims: [{ id: "claim-1" }] },
          summary: { keyPoints: [{ citedClaimIds: ["claim-1"] }] },
          report: "# Handoff Gate report",
        },
      },
      version: 3,
      error: null,
      createdAt: "2026-08-30T09:00:00.000Z",
      updatedAt: "2026-08-30T09:00:07.000Z",
    },
    events: [
      event(1, "session.started", null, null, null),
      event(2, "stage.completed", "research", agentId, 1),
      event(3, "stage.rejected", "summary", "fixture-summary", 1, [
        "cited claims not in stage 1: claim-99",
      ]),
      event(4, "stage.completed", "summary", "fixture-summary", 2),
      event(5, "stage.completed", "report", "fixture-report", 1),
      event(6, "session.completed", null, null, null),
    ],
  };
}

function stage(
  id: string,
  role: string,
  agentId: string,
  outputPath: string,
  inputFileName: string | null,
): Stage {
  return {
    id,
    role,
    agentId,
    schemaId: id,
    outputPath,
    inputFileName,
    instruction: "Fixture",
    maxAttempts: 2,
  };
}

function artifact(
  stageId: string,
  file: string,
  bytes: number,
  validatedAt: string,
): Artifact {
  return {
    stageId,
    path: "/workspace/" + file,
    hash: "hash-" + stageId + "-a3f9c6e8d2b7514c",
    bytes,
    validatedAt,
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "No parsed value supplied.";
}

function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const map = new Map(current.map((item) => [item.seq, item]));
  for (const item of incoming) map.set(item.seq, item);
  return [...map.values()].sort((a, b) => a.seq - b.seq);
}

export default PipelinePanel;
