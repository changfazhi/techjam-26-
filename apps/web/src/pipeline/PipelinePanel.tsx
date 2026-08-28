/**
 * Handoff Gate — pipeline panel.
 * Owned by W5 (Runtime & UI).
 *
 * STUB — W5 implements. This is the only component App.tsx mounts, so every
 * subsequent UI change happens inside apps/web/src/pipeline/ and App.tsx stays
 * frozen. Split into StageTimeline, ArtifactViewer, and usePipeline as it grows.
 */

import "./pipeline.css";

export interface PipelinePanelProps {
  agentId: string;
  onClose: () => void;
}

export default function PipelinePanel({ agentId, onClose }: PipelinePanelProps) {
  return (
    <section className="pipeline-panel">
      <header className="pipeline-panel-head">
        <div>
          <span className="eyebrow">Handoff Gate</span>
          <h2>Pipeline</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close pipeline panel">
          ×
        </button>
      </header>
      <p className="pipeline-placeholder">
        Not built yet. W5 renders the stage timeline, the artifact chain, and the
        violations on a held stage here.
      </p>
      <code className="pipeline-placeholder-meta">agent {agentId}</code>
    </section>
  );
}
