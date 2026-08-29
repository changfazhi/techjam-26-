/**
 * Artifact collection, hashing, and delivery between sealed agent workspaces.
 * Owned by W2 (Coordinator). See docs/BLUEPRINT.md section 5.3.
 *
 * Why this exists: container-codex-runner.ts:79-84 bind-mounts only the acting
 * agent's own workspace, so agents cannot read each other's files. Every
 * cross-agent byte moves through here, which is why the gate has somewhere to sit.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
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

/**
 * Resolve `relative` inside `workspacePath`, refusing anything that escapes.
 * Stage output paths and source filenames both originate in session input, so
 * this is a real traversal guard rather than ceremony.
 */
function resolveInside(workspacePath: string, relative: string): string {
  const root = path.resolve(workspacePath);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new HttpError(400, "Path escapes the agent workspace: " + relative);
  }
  return target;
}

/** The first fenced block in an agent reply, used when no file was written. */
const FENCED_BLOCK = /```(?:json)?\s*\n([\s\S]*?)```/;

/** Record an artifact without delivering it — used for the final stage. */
export function hashArtifact(raw: string, stageId: string, sourcePath: string): Artifact {
  return {
    stageId,
    path: sourcePath,
    hash: createHash("sha256").update(raw, "utf8").digest("hex"),
    bytes: Buffer.byteLength(raw, "utf8"),
    validatedAt: new Date().toISOString(),
  };
}

export class FileArtifactBroker implements ArtifactBroker {
  async collect(
    workspacePath: string,
    outputPath: string,
    reply: string,
  ): Promise<CollectResult> {
    const absolute = resolveInside(workspacePath, outputPath);
    try {
      const raw = await readFile(absolute, "utf8");
      return { found: true, raw, source: "file" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    // The agent answered in prose without writing the file. Accept a fenced
    // block so one missing `Write` does not cost an attempt.
    const match = FENCED_BLOCK.exec(reply);
    const block = match?.[1];
    if (block !== undefined && block.trim().length > 0) {
      return { found: true, raw: block, source: "reply" };
    }
    return { found: false };
  }

  async deliver(
    raw: string,
    stageId: string,
    sourcePath: string,
    targetWorkspacePath: string,
    targetFileName: string,
  ): Promise<Artifact> {
    const destination = resolveInside(targetWorkspacePath, targetFileName);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, raw, "utf8");
    return hashArtifact(raw, stageId, sourcePath);
  }

  async seed(workspacePath: string, sources: SessionSource[]): Promise<void> {
    await mkdir(path.resolve(workspacePath), { recursive: true });
    for (const source of sources) {
      const destination = resolveInside(workspacePath, source.name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, source.content, "utf8");
    }
  }
}
