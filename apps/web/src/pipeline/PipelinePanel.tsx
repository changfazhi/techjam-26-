import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, pipelineApi } from "../api";
import type {
  Agent,
  Artifact,
  CreateSessionInput,
  Session,
  SessionEvent,
  Stage,
} from "../types";
import { extractPdfText } from "./pdf-text";
import "./pipeline.css";

const POLL_INTERVAL_MS = 900;
/** Consecutive failed polls tolerated before live updates give up. */
const MAX_POLL_FAILURES = 5;
const MAX_SOURCE_FILES = 10;
const MAX_SOURCE_BYTES = 100_000;
const MAX_PDF_BYTES = 10_000_000;
const TEXT_DOCUMENT_NAME = /\.(?:txt|md|markdown|csv|json|xml|html?|ya?ml|log)$/i;
const PDF_DOCUMENT_NAME = /\.pdf$/i;

interface UploadedSource {
  name: string;
  content: string;
  bytes: number;
}

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
  const [researchTopic, setResearchTopic] = useState("");
  const [uploadedSources, setUploadedSources] = useState<UploadedSource[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
          setAvailableSessions((current) => current.map((item) =>
            item.id === refreshed.id ? refreshed : item
          ));

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
      setAvailableSessions((current) => current.map((item) =>
        item.id === stopped.id ? stopped : item
      ));
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

  const startPipeline = async (
    inputForAgents: (
      researcherId: string,
      summarizerId: string,
      formatterId: string,
    ) => CreateSessionInput,
    preparingMessage: string,
    startedMessage: string,
  ) => {
    if (starting || session.state === "running") return;
    setStarting(true);
    setNote(preparingMessage);

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
        inputForAgents(researcher.id, summarizer.id, formatter.id),
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
      setNote(startedMessage);
    } catch (error) {
      setNote(
        error instanceof Error
          ? "Could not start the research pipeline: " + error.message
          : "Could not start the research pipeline.",
      );
    } finally {
      setStarting(false);
    }
  };

  const startDemo = () => startPipeline(
    (researcherId, summarizerId, formatterId) => pipelineSessionInput(
      researcherId,
      summarizerId,
      formatterId,
      "Battery recycling provenance demo",
      "What can be recovered from lithium-ion batteries?",
      DEMO_SOURCES,
    ),
    "Preparing a live three-agent session...",
    "Live demo started. Events and admitted artifacts update automatically.",
  );

  const addSourceFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadError(null);

    const selected = Array.from(files);
    const invalidName = selected.find(
      (file) =>
        file.name.length > 255 ||
        file.name.includes("..") ||
        file.name.includes("/") ||
        file.name.includes("\\") ||
        !TEXT_DOCUMENT_NAME.test(file.name) && !PDF_DOCUMENT_NAME.test(file.name),
    );
    if (invalidName) {
      setUploadError(
        invalidName.name + " is not supported. Use PDF, TXT, Markdown, CSV, JSON, XML, HTML, YAML, or LOG files.",
      );
      return;
    }

    const oversized = selected.find((file) =>
      file.size > (PDF_DOCUMENT_NAME.test(file.name) ? MAX_PDF_BYTES : MAX_SOURCE_BYTES)
    );
    if (oversized) {
      const limit = PDF_DOCUMENT_NAME.test(oversized.name) ? "10 MB PDF" : "100 KB source";
      setUploadError(oversized.name + " is larger than the " + limit + " limit.");
      return;
    }

    try {
      const loaded = await Promise.all(
        selected.map(async (file): Promise<UploadedSource> => {
          const content = PDF_DOCUMENT_NAME.test(file.name)
            ? await extractPdfText(await file.arrayBuffer())
            : await file.text();
          if (content.length > MAX_SOURCE_BYTES) {
            throw new Error(
              file.name + " contains more than 100,000 extracted characters. Use a shorter PDF or split it into sections.",
            );
          }
          return { name: file.name, content, bytes: file.size };
        }),
      );

      const nextNames = new Set([
        ...uploadedSources.map((source) => source.name),
        ...loaded.map((source) => source.name),
      ]);
      if (nextNames.size > MAX_SOURCE_FILES) {
        setUploadError("A research session can contain at most 10 source documents.");
        return;
      }

      setUploadedSources((current) => {
        const byName = new Map(current.map((source) => [source.name, source]));
        for (const source of loaded) byName.set(source.name, source);
        return [...byName.values()];
      });
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : "The selected documents could not be read.",
      );
    }
  };

  const startUploadedResearch = () => {
    const topic = researchTopic.trim();
    if (!topic) {
      setUploadError("Enter the research question the documents should answer.");
      return;
    }
    if (!uploadedSources.length) {
      setUploadError("Choose at least one source document.");
      return;
    }

    setUploadError(null);
    void startPipeline(
      (researcherId, summarizerId, formatterId) => pipelineSessionInput(
        researcherId,
        summarizerId,
        formatterId,
        "Document research: " + topic.slice(0, 181),
        topic,
        uploadedSources.map(({ name, content }) => ({ name, content })),
      ),
      "Uploading the sources and preparing the research agents...",
      "Document research started. The Researcher is reading the uploaded source set.",
    );
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
            onClick={() => void startDemo()}
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

      <section className="pipeline-upload" aria-labelledby="pipeline-upload-title">
        <div className="pipeline-upload-head">
          <div>
            <span className="eyebrow">Your source material</span>
            <h3 id="pipeline-upload-title">Research your documents</h3>
          </div>
          <span>{uploadedSources.length} / {MAX_SOURCE_FILES} files</span>
        </div>
        <label className="pipeline-topic-field">
          Research question
          <textarea
            value={researchTopic}
            onChange={(event) => setResearchTopic(event.target.value)}
            placeholder="What should the agents determine from these documents?"
            maxLength={10_000}
            rows={2}
            disabled={starting || session.state === "running"}
          />
        </label>
        <label className="pipeline-file-field">
          Source documents
          <input
            type="file"
            multiple
            accept=".pdf,.txt,.md,.markdown,.csv,.json,.xml,.html,.htm,.yaml,.yml,.log,application/pdf,text/plain,text/markdown,text/csv,application/json"
            disabled={starting || session.state === "running"}
            onChange={(event) => {
              void addSourceFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <small>Up to 10 files. PDFs can be 10 MB; extracted text is limited to 100,000 characters. Scanned PDFs need OCR first.</small>
        </label>
        {uploadedSources.length > 0 && (
          <ul className="pipeline-source-list">
            {uploadedSources.map((source) => (
              <li key={source.name}>
                <div>
                  <strong>{source.name}</strong>
                  <span>{formatBytes(source.bytes)}</span>
                </div>
                <button
                  className="button button-ghost"
                  type="button"
                  aria-label={"Remove " + source.name}
                  disabled={starting || session.state === "running"}
                  onClick={() => setUploadedSources((current) =>
                    current.filter((item) => item.name !== source.name)
                  )}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {uploadError && <p className="pipeline-upload-error" role="alert">{uploadError}</p>}
        <button
          className="button button-primary pipeline-research-button"
          type="button"
          disabled={starting || session.state === "running"}
          onClick={startUploadedResearch}
        >
          {starting ? "Starting research..." : "Research uploaded documents"}
        </button>
      </section>

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
  const [expandedStageId, setExpandedStageId] = useState<string | null>(null);
  const expandedStage = stages.find((stage) => stage.id === expandedStageId);
  const expandedValue = expandedStage ? values[expandedStage.id] : undefined;

  useEffect(() => {
    if (!expandedStageId) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpandedStageId(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expandedStageId]);

  return (
    <section className="pipeline-section">
      <h3>Artifact chain</h3>
      <ol className="pipeline-artifact-chain">
        {stages.map((stage) => {
          const artifact = artifacts[stage.id];
          const isMarkdownReport = stage.outputPath.toLowerCase().endsWith(".md");

          return (
            <li className={isMarkdownReport ? "is-report" : undefined} key={stage.id}>
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
                  {isMarkdownReport && typeof values[stage.id] === "string" && (
                    <button
                      className="button button-primary artifact-expand-button"
                      type="button"
                      onClick={() => setExpandedStageId(stage.id)}
                    >
                      Open large report view
                    </button>
                  )}
                </>
              ) : (
                <em>Not admitted - no artifact propagated.</em>
              )}
            </li>
          );
        })}
      </ol>
      {expandedStage && typeof expandedValue === "string" && (
        <div
          className="artifact-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setExpandedStageId(null);
          }}
        >
          <section
            className="artifact-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="artifact-modal-title"
          >
            <header className="artifact-modal-head">
              <div>
                <span className="eyebrow">Completed report</span>
                <h3 id="artifact-modal-title">{expandedStage.outputPath}</h3>
              </div>
              <button
                className="button button-ghost"
                type="button"
                autoFocus
                onClick={() => setExpandedStageId(null)}
              >
                Close
              </button>
            </header>
            <pre className="artifact-report-content">{expandedValue}</pre>
          </section>
        </div>
      )}
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

const DEMO_SOURCES: CreateSessionInput["sources"] = [
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
];

function pipelineSessionInput(
  researcherId: string,
  summarizerId: string,
  formatterId: string,
  title: string,
  topic: string,
  sources: CreateSessionInput["sources"],
): CreateSessionInput {
  return {
    title,
    topic,
    sources,
    stages: [
      {
        id: "research",
        role: "Researcher",
        agentId: researcherId,
        schemaId: "research",
        outputPath: "research.json",
        inputFileName: null,
        instruction: "Read the seeded source documents and extract sourced claims that answer the session topic.",
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

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return String(bytes) + " B";
  return (bytes / 1_000).toFixed(1) + " KB";
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
