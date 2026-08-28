/**
 * Artifact collection, hashing, and delivery between sealed agent workspaces.
 * Owned by W2 (Coordinator). See docs/BLUEPRINT.md section 5.3.
 *
 * STUB — W2 implements.
 *
 * Why this exists: container-codex-runner.ts:79-84 bind-mounts only the acting
 * agent's own workspace, so agents cannot read each other's files. Every
 * cross-agent byte moves through here, which is why the gate has somewhere to sit.
 */

import type { Artifact, SessionSource } from "./types.js";

export type CollectResult =
  | { found: true; raw: string; source: "file" | "reply" }
  | { found: false };

export interface ArtifactBroker {
  /** Read `outputPath` from the workspace; fall back to a fenced json block in the reply. */
  collect(workspacePath: string, outputPath: string, reply: string): Promise<CollectResult>;
  /**
   * Write an admitted artifact into the next agent's workspace.
   * INVARIANT 4: only ever called after a ValidationResult with ok: true.
   */
  deliver(
    raw: string,
    stageId: string,
    sourcePath: string,
    targetWorkspacePath: string,
    targetFileName: string,
  ): Promise<Artifact>;
  /** Write the seeded source documents into the first stage's workspace. */
  seed(workspacePath: string, sources: SessionSource[]): Promise<void>;
}

export class FileArtifactBroker implements ArtifactBroker {
  async collect(
    _workspacePath: string,
    _outputPath: string,
    _reply: string,
  ): Promise<CollectResult> {
    throw new Error("not implemented: W2 (broker.ts)");
  }

  async deliver(
    _raw: string,
    _stageId: string,
    _sourcePath: string,
    _targetWorkspacePath: string,
    _targetFileName: string,
  ): Promise<Artifact> {
    throw new Error("not implemented: W2 (broker.ts)");
  }

  async seed(_workspacePath: string, _sources: SessionSource[]): Promise<void> {
    throw new Error("not implemented: W2 (broker.ts)");
  }
}
