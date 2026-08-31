/**
 * Deterministic AgentRunner for development and coordinator tests.
 * Owned by W5 (Runtime & UI).
 *
 * Selected with RUNTIME_PROVIDER=mock. It produces stage-shaped artifacts and
 * supports deliberate failure modes used by coordinator tests.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { RunCancelledError } from "./errors.js";
import { SOURCE_MANIFEST_HEADING } from "./session/prompt.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

export type MisbehaviourMode =
  | "NONE"
  | "WRONG_CITATION"
  | "NO_FILE_WRITTEN"
  | "HANG_PAST_DEADLINE";

export interface MockRunnerConfig {
  misbehaviour: MisbehaviourMode;
  hangDurationMs?: number;
}

export interface RunResult {
  status: "SUCCESS" | "FAILED" | "TIMEOUT";
  artifact?: string;
  citations?: string[];
  violations?: string[];
}

const DEFAULT_CONFIG: MockRunnerConfig = { misbehaviour: "NONE" };
const VALID_CITATIONS = ["claim-1"];
/** Used only when no session seeded any source, so a run still produces something. */
const FALLBACK_SOURCE_ID = "source-1.txt";
const DEFAULT_KEY_POINT = "Validated handoffs preserve provenance.";
/** Files WorkspaceManager creates; never a source document. */
const WORKSPACE_SCAFFOLD = new Set(["README.md", "AGENTS.md", "CLAUDE.md"]);
/** This pipeline's own stage outputs; never a source document either. */
const STAGE_OUTPUTS = new Set(["research.json", "summary.json", "report.md"]);

interface ActiveRun {
  cancelled: boolean;
  releaseHang: (() => void) | null;
  settled: Promise<void>;
  settle: () => void;
}

export class MockRunner implements AgentRunner {
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly config: MockRunnerConfig = DEFAULT_CONFIG) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(agentId: string): Promise<boolean> {
    const active = this.active.get(agentId);
    if (!active) return false;

    active.cancelled = true;
    active.releaseHang?.();
    await active.settled;
    return true;
  }

  async run(): Promise<RunResult>;
  async run(request: RunnerRequest): Promise<RunnerResult>;
  async run(request?: RunnerRequest): Promise<RunResult | RunnerResult> {
    if (!request) return this.runResult();

    return this.runRequest(request);
  }

  private async runRequest(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.agentId)) {
      throw new Error("Agent already has an active mock run");
    }

    let resolveSettled: () => void = () => undefined;
    const active: ActiveRun = {
      cancelled: false,
      releaseHang: null,
      settled: new Promise<void>((resolveSettledPromise) => {
        resolveSettled = resolveSettledPromise;
      }),
      settle: () => resolveSettled(),
    };
    this.active.set(request.agentId, active);

    try {
      const result = await this.runResult(request, active);
      this.throwIfCancelled(active);

      if (result.status === "TIMEOUT") {
        throw new Error("Mock runner timed out after the configured deadline");
      }

      if (result.status === "FAILED") {
        throw new Error(result.violations?.join("; ") ?? "Mock runner failed");
      }

      if (result.artifact) {
        await this.writeArtifact(request, result.artifact);
      }
      this.throwIfCancelled(active);

      return {
        output: result.artifact
          ? "```json\n" + result.artifact + "\n```"
          : "mock runner completed without writing an artifact",
        threadId: request.threadId ?? "mock-thread-" + request.agentId,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } finally {
      active.releaseHang?.();
      active.releaseHang = null;
      active.settle();
      this.active.delete(request.agentId);
    }
  }

  private async runResult(
    request?: RunnerRequest,
    active?: ActiveRun,
  ): Promise<RunResult> {
    if (this.config.misbehaviour === "HANG_PAST_DEADLINE") {
      await this.waitPastDeadline(active);
      return {
        status: "TIMEOUT",
        violations: ["Mock runner exceeded the configured deadline."],
      };
    }

    const artifact = await this.artifactFor(request);

    if (this.config.misbehaviour === "NO_FILE_WRITTEN") {
      return {
        status: "SUCCESS",
        citations: [...VALID_CITATIONS],
      };
    }

    if (
      this.config.misbehaviour === "WRONG_CITATION" &&
      this.shouldReturnWrongCitation(request)
    ) {
      return {
        status: "SUCCESS",
        artifact: this.summaryArtifact(["claim-99"]),
        citations: ["[Citation Error: undefined reference]"],
      };
    }

    return {
      status: "SUCCESS",
      artifact,
      citations: [...VALID_CITATIONS],
    };
  }

  private throwIfCancelled(active: ActiveRun): void {
    if (active.cancelled) {
      throw new RunCancelledError();
    }
  }

  private async waitPastDeadline(active?: ActiveRun): Promise<void> {
    if (!active) {
      const durationMs = this.config.hangDurationMs ?? 3_000;
      await new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
      return;
    }

    await new Promise<void>((resolveWait) => {
      const timer =
        this.config.hangDurationMs === undefined
          ? null
          : setTimeout(resolveWait, this.config.hangDurationMs);

      active.releaseHang = () => {
        if (timer) clearTimeout(timer);
        resolveWait();
      };
    });
    active.releaseHang = null;
  }

  private async artifactFor(request?: RunnerRequest): Promise<string> {
    const prompt = request?.prompt ?? "";
    const outputPath = this.outputPath(prompt);

    if (outputPath?.endsWith("summary.json")) {
      const claim = await this.deliveredClaim(request);
      return this.summaryArtifact(VALID_CITATIONS, claim);
    }

    const sources = await this.resolveSources(request);

    if (outputPath?.endsWith("report.md")) {
      const keyPoints = await this.deliveredKeyPoints(request);
      return this.reportArtifact(keyPoints, sources);
    }

    return this.researchArtifact(request, sources);
  }

  private async researchArtifact(
    request: RunnerRequest | undefined,
    sources: string[],
  ): Promise<string> {
    const extracted: Array<{ text: string; sourceId: string }> = [];

    if (request?.workspacePath) {
      for (const sourceId of sources) {
        try {
          const raw = await readFile(resolve(request.workspacePath, sourceId), "utf8");
          const lines = raw
            .split(/\r?\n/)
            .filter((line) => !/^\s*#{1,6}\s/.test(line))
            .map((line) => line.replace(/^\s*(?:#{1,6}|[-*])\s*/, "").trim())
            .filter((line) => line.length >= 8);
          for (const text of lines) {
            extracted.push({ text, sourceId });
            if (extracted.length === 3) break;
          }
        } catch {
          // The source manifest is authoritative; an unreadable file simply
          // contributes no mock claim and the deterministic fallbacks below
          // keep the development pipeline usable.
        }
        if (extracted.length === 3) break;
      }
    }

    const fallbackSource = sources[0] ?? FALLBACK_SOURCE_ID;
    const fallbacks = [
      "The source set was supplied for document-grounded research.",
      "Claims must retain the filename of the document they came from.",
      "Only admitted claims can be passed to the summarizer.",
    ];
    while (extracted.length < 3) {
      const text = fallbacks[extracted.length];
      if (!text) break;
      extracted.push({ text, sourceId: fallbackSource });
    }

    return JSON.stringify(
      {
        claims: extracted.map((claim, index) => ({
          id: "claim-" + String(index + 1),
          text: claim.text,
          confidence: Number(Math.max(0.85, 0.95 - index * 0.05).toFixed(2)),
          sourceId: claim.sourceId,
        })),
      },
      null,
      2,
    );
  }

  /**
   * The seeded source filenames this run may claim provenance from, in
   * preference order: the prompt's own manifest section, then whatever is
   * actually sitting in the workspace, then a last-resort placeholder.
   *
   * It must never be guessed from the prompt's prose. It used to be scraped
   * with /\b[\w.-]+\.txt\b/, which matched "document-name.txt" — the example
   * filename inside the research schema's description — so every mock run
   * claimed a source that no session had ever seeded, and the provenance gate
   * correctly rejected all three attempts.
   */
  private async resolveSources(request?: RunnerRequest): Promise<string[]> {
    const fromPrompt = this.sourcesFromPrompt(request?.prompt ?? "");
    if (fromPrompt.length > 0) return fromPrompt;

    const fromWorkspace = await this.sourcesFromWorkspace(request?.workspacePath);
    if (fromWorkspace.length > 0) return fromWorkspace;

    return [FALLBACK_SOURCE_ID];
  }

  /** Reads the bullet list under the prompt's source manifest heading. */
  private sourcesFromPrompt(prompt: string): string[] {
    const headingIndex = prompt.indexOf(SOURCE_MANIFEST_HEADING);
    if (headingIndex === -1) return [];

    const names: string[] = [];
    const lines = prompt.slice(headingIndex + SOURCE_MANIFEST_HEADING.length).split("\n");
    for (const line of lines) {
      const bullet = /^[ \t]*-[ \t]+(\S.*)$/.exec(line);
      if (bullet?.[1]) {
        names.push(bullet[1].trim());
        continue;
      }
      // Stop at the next section; a blank line still sits between the heading
      // and its list, so only a heading ends the run.
      if (/^[ \t]*#{1,6}[ \t]+\S/.test(line)) break;
    }

    return names;
  }

  /** Seeded documents on disk, ignoring workspace scaffold and stage outputs. */
  private async sourcesFromWorkspace(workspacePath?: string): Promise<string[]> {
    if (!workspacePath) return [];

    try {
      const entries = await readdir(workspacePath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => !name.startsWith("."))
        .filter((name) => !WORKSPACE_SCAFFOLD.has(name))
        .filter((name) => !STAGE_OUTPUTS.has(name))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Key point text from the summary the broker delivered into this workspace.
   * The report gate requires each one to reappear verbatim in the body.
   */
  private async deliveredKeyPoints(request?: RunnerRequest): Promise<string[]> {
    if (!request?.workspacePath) return [DEFAULT_KEY_POINT];

    try {
      const raw = await readFile(resolve(request.workspacePath, "summary.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const keyPoints = (parsed as { keyPoints?: Array<{ text?: unknown }> }).keyPoints;
      const texts = (keyPoints ?? [])
        .map((point) => point.text)
        .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
      return texts.length > 0 ? texts : [DEFAULT_KEY_POINT];
    } catch {
      return [DEFAULT_KEY_POINT];
    }
  }

  private async deliveredClaim(request?: RunnerRequest): Promise<string> {
    if (!request?.workspacePath) return DEFAULT_KEY_POINT;

    try {
      const raw = await readFile(resolve(request.workspacePath, "research.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const claims = (parsed as { claims?: Array<{ text?: unknown }> }).claims;
      const text = claims?.find(
        (claim) => typeof claim.text === "string" && claim.text.trim().length > 0,
      )?.text;
      return typeof text === "string" ? text : DEFAULT_KEY_POINT;
    } catch {
      return DEFAULT_KEY_POINT;
    }
  }

  /**
   * Stage 3 never receives research.json, so it cannot know which subset of
   * sources the summary actually cited. Listing every seeded source is a valid
   * superset: report.ts checks that each cited source *appears* in References.
   */
  private reportArtifact(keyPoints: string[], sources: string[]): string {
    return (
      "# Handoff Gate report\n\n" +
      keyPoints.join("\n\n") +
      "\n\n## References\n\n" +
      sources.map((name) => "- " + name).join("\n") +
      "\n"
    );
  }

  private summaryArtifact(
    citedClaimIds: string[],
    text = DEFAULT_KEY_POINT,
  ): string {
    return JSON.stringify(
      {
        keyPoints: [
          {
            text,
            citedClaimIds,
          },
        ],
      },
      null,
      2,
    );
  }

  private async writeArtifact(
    request: RunnerRequest,
    artifact: string,
  ): Promise<void> {
    const outputPath = this.outputPath(request.prompt);
    if (!outputPath) return;

    const workspacePath = resolve(request.workspacePath);
    const targetPath = resolve(workspacePath, outputPath);
    const pathFromWorkspace = relative(workspacePath, targetPath);

    if (pathFromWorkspace.startsWith("..") || pathFromWorkspace === "") {
      return;
    }

    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, artifact, "utf8");
  }

  private outputPath(prompt: string): string | null {
    const explicitPath = this.explicitOutputPath(prompt);

    if (explicitPath) return explicitPath;

    const fallbackPaths = [...prompt.matchAll(/\b(?:research\.json|summary\.json|report\.md)\b/gi)];
    return fallbackPaths.at(-1)?.[0] ?? null;
  }

  private explicitOutputPath(prompt: string): string | null {
    const instruction =
      /(?:\bwrite\b(?:\s+[\w.-]+){0,4}\s+\bto\b|\boutput\s+path\s*[:=])\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+\.(?:json|md))(?=[\s.,;:!?)]|$))/gi;
    let outputPath: string | null = null;

    for (const match of prompt.matchAll(instruction)) {
      const candidate = match[1] ?? match[2] ?? match[3] ?? match[4];
      const normalised = candidate ? this.normaliseOutputPath(candidate) : null;
      if (normalised) outputPath = normalised;
    }

    return outputPath;
  }

  private normaliseOutputPath(candidate: string): string | null {
    const outputPath = candidate.trim().replace(/[.,;:!?]+$/, "");
    return /\.(?:json|md)$/i.test(outputPath) ? outputPath : null;
  }

  /**
   * Corrupt only the summary's initial output. Coordinator retries include a
   * rejection section, which is the available per-session attempt signal.
   * Keep the no-request overload's focused-misbehaviour contract unchanged.
   */
  private shouldReturnWrongCitation(request?: RunnerRequest): boolean {
    if (!request) return true;

    return (
      this.outputPath(request.prompt)?.endsWith("summary.json") === true &&
      !request.prompt.includes("## Previous attempt was rejected")
    );
  }
}
