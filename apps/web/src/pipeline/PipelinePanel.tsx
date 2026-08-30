import { useEffect, useRef, useState } from "react";
import { pipelineApi } from "../api";
import type { Artifact, Session, SessionEvent, Stage } from "../types";
import "./pipeline.css";

type PipelineSession = Omit<Session, "sharedState"> & { sharedState: Session["sharedState"] & { artifactValues?: Record<string, unknown> } };
const POLL_INTERVAL_MS = 900;
/** Consecutive failed polls tolerated before live updates give up. */
const MAX_POLL_FAILURES = 5;
export interface PipelinePanelProps { agentId: string; onClose: () => void; }

export function PipelinePanel({ agentId, onClose }: PipelinePanelProps) {
  const afterSeq = useRef(0);
  const [session, setSession] = useState<PipelineSession>(() => makeFixture(agentId).session);
  const [events, setEvents] = useState<SessionEvent[]>(() => makeFixture(agentId).events);
  const [live, setLive] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let active = true;
    const nextFixture = makeFixture(agentId);
    afterSeq.current = nextFixture.events.at(-1)?.seq ?? 0;
    setSession(nextFixture.session); setEvents(nextFixture.events); setLive(false); setNote(null);
    void (async () => {
      try {
        const { sessions } = await pipelineApi.list();
        const match = sessions.filter((item) => item.stages.some((stage) => stage.agentId === agentId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (!match) {
          if (active) setNote("No pipeline session found for agent " + agentId + ".");
          return;
        }
        const [{ session: current }, { events: currentEvents }] = await Promise.all([pipelineApi.get(match.id), pipelineApi.events(match.id)]);
        if (!active) return;
        afterSeq.current = currentEvents.at(-1)?.seq ?? 0;
        setSession(current as PipelineSession); setEvents(currentEvents); setLive(true);
      } catch (error) {
        if (active) setNote(error instanceof Error ? "Live data unavailable: " + error.message : "Live data unavailable.");
      }
    })();
    return () => { active = false; };
  }, [agentId]);

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
          setSession(refreshed as PipelineSession);
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
    return () => { active = false; };
  }, [live, session.id, session.state]);

  const stop = async () => {
    if (!live || session.state !== "running") return;
    setStopping(true);
    try { const { session: stopped } = await pipelineApi.stop(session.id); setSession(stopped as PipelineSession); }
    catch (error) { setNote(error instanceof Error ? "Could not stop pipeline: " + error.message : "Could not stop pipeline."); }
    finally { setStopping(false); }
  };

  return <section className="pipeline-panel" aria-labelledby="pipeline-title">
    <header className="pipeline-panel-head"><div><span className="eyebrow">Handoff Gate</span><h2 id="pipeline-title">Pipeline</h2><p>{session.title}</p></div><div className="pipeline-actions"><button className="button pipeline-stop" type="button" onClick={stop} disabled={!live || session.state !== "running" || stopping}>{stopping ? "Stopping..." : "Stop"}</button><button type="button" onClick={onClose}>Close</button></div></header>
    <div className="pipeline-status"><strong>{session.state}</strong><span>{session.version} / {session.stages.length} admitted</span>{!live && <span className="fixture-badge">Demo fixture</span>}</div>
    {note && <p className="pipeline-note">{note}{!live ? " Showing the demo fixture." : ""}</p>}
    <p className="pipeline-invariant">three stages, in order, each admitted exactly once, no held artifact propagated.</p>
    <StageTimeline stages={session.stages} events={events} attempts={session.sharedState.attempts} />
    <ArtifactViewer stages={session.stages} artifacts={session.sharedState.artifacts} values={session.sharedState.artifactValues} />
  </section>;
}

function StageTimeline({ stages, events, attempts }: { stages: Stage[]; events: SessionEvent[]; attempts: Record<string, number> }) {
  return <section className="pipeline-section"><h3>Stage timeline</h3><ol className="pipeline-timeline">{stages.map((stage, index) => {
    const stageEvents = events.filter((event) => event.stageId === stage.id);
    const held = stageEvents.filter((event) => event.type === "stage.rejected" || event.type === "stage.timeout");
    const admitted = stageEvents.some((event) => event.type === "stage.completed");
    const count = Math.max(attempts[stage.id] ?? 0, ...stageEvents.map((event) => event.attempt ?? 0));
    return <li className={"pipeline-stage " + (admitted ? "admitted" : held.length ? "held" : "waiting")} key={stage.id}><span className="stage-mark">{admitted ? "\u2713" : index + 1}</span><div className="stage-content"><div className="stage-title"><div><small>{stage.role}</small><h4>{stage.id}</h4></div><span>{count} attempt{count === 1 ? "" : "s"} - {admitted ? "Admitted" : held.length ? "Held" : "Waiting"}</span></div>{held.length > 0 && <details className="pipeline-violations" open><summary>Held on attempt {held.map((event) => event.attempt ?? "?").join(", ")}</summary><ul>{held.flatMap((event) => (event.payload.violations ?? []).map((violation) => <li key={event.id + violation}>{violation}</li>))}</ul></details>}</div></li>;
  })}</ol></section>;
}

function ArtifactViewer({ stages, artifacts, values }: { stages: Stage[]; artifacts: Record<string, Artifact>; values: Record<string, unknown> | undefined }) {
  return <section className="pipeline-section"><h3>Artifact chain</h3><ol className="pipeline-artifact-chain">{stages.map((stage) => {
    const artifact = artifacts[stage.id];
    return <li key={stage.id}><strong>{stage.outputPath}</strong>{artifact ? <><span>Hash: {artifact.hash}</span><time dateTime={artifact.validatedAt}>Validated: {new Date(artifact.validatedAt).toLocaleString()}</time><details><summary>Gate-admitted value</summary><pre>{formatValue(values?.[stage.id])}</pre></details></> : <em>Not admitted - no artifact propagated.</em>}</li>;
  })}</ol></section>;
}

function makeFixture(agentId: string): { session: PipelineSession; events: SessionEvent[] } {
  const stages: Stage[] = [stage("research", "Researcher", agentId, "research.json", null), stage("summary", "Summarizer", "fixture-summary", "summary.json", "research.json"), stage("report", "Formatter", "fixture-report", "report.md", "summary.json")];
  const event = (seq: number, type: SessionEvent["type"], stageId: string | null, agent: string | null, attempt: number | null, violations?: string[]): SessionEvent => ({ id: "fixture-" + seq, sessionId: "fixture-session", seq, stageId, agentId: agent, runId: stageId ? "run-" + seq : null, type, attempt, payload: violations ? { violations } : {}, createdAt: "2026-08-30T09:00:0" + Math.min(seq, 9) + ".000Z" });
  const artifacts: Record<string, Artifact> = { research: artifact("research", "research.json", 482, "2026-08-30T09:00:02.000Z"), summary: artifact("summary", "summary.json", 186, "2026-08-30T09:00:05.000Z"), report: artifact("report", "report.md", 319, "2026-08-30T09:00:07.000Z") };
  return { session: { id: "00000000-0000-4000-8000-000000000005", title: "Cited handoff demo", topic: "Validated handoffs", stages, sourceManifest: ["source-1.txt"], state: "completed", sharedState: { currentStageIndex: 3, attempts: { research: 1, summary: 2, report: 1 }, artifacts, artifactValues: { research: { claims: [{ id: "claim-1" }] }, summary: { keyPoints: [{ citedClaimIds: ["claim-1"] }] }, report: "# Handoff Gate report" } }, version: 3, error: null, createdAt: "2026-08-30T09:00:00.000Z", updatedAt: "2026-08-30T09:00:07.000Z" }, events: [event(1, "session.started", null, null, null), event(2, "stage.completed", "research", agentId, 1), event(3, "stage.rejected", "summary", "fixture-summary", 1, ["cited claims not in stage 1: claim-99"]), event(4, "stage.completed", "summary", "fixture-summary", 2), event(5, "stage.completed", "report", "fixture-report", 1), event(6, "session.completed", null, null, null)] };
}
function stage(id: string, role: string, agentId: string, outputPath: string, inputFileName: string | null): Stage { return { id, role, agentId, schemaId: id, outputPath, inputFileName, instruction: "Fixture", maxAttempts: 2 }; }
function artifact(stageId: string, file: string, bytes: number, validatedAt: string): Artifact { return { stageId, path: "/workspace/" + file, hash: "hash-" + stageId + "-a3f9c6e8d2b7514c", bytes, validatedAt }; }
function formatValue(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "No parsed value supplied."; }
function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] { const map = new Map(current.map((item) => [item.seq, item])); for (const item of incoming) map.set(item.seq, item); return [...map.values()].sort((a, b) => a.seq - b.seq); }
export default PipelinePanel;
