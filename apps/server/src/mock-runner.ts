/**
 * Deterministic AgentRunner for development and coordinator tests.
 * Owned by W5 (Runtime & UI).
 *
 * Selected with RUNTIME_PROVIDER=mock. It produces stage-shaped artifacts and
 * supports deliberate failure modes used by coordinator tests.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { RunCancelledError } from "./errors.js";
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

    const artifact = this.artifactFor(request?.prompt ?? "");

    if (this.config.misbehaviour === "NO_FILE_WRITTEN") {
      return {
        status: "SUCCESS",
        citations: [...VALID_CITATIONS],
      };
    }

    if (this.config.misbehaviour === "WRONG_CITATION") {
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

  private artifactFor(prompt: string): string {
    const outputPath = this.outputPath(prompt);

    if (outputPath?.endsWith("summary.json")) {
      return this.summaryArtifact(VALID_CITATIONS);
    }

    if (outputPath?.endsWith("report.md")) {
      return "# Handoff Gate report\n\nValidated handoffs preserve provenance.\n\n## References\n\n- source-1.txt\n";
    }

    const sourceId = prompt.match(/\b[\w.-]+\.txt\b/)?.[0] ?? "source-1.txt";

    return JSON.stringify(
      {
        claims: [
          {
            id: "claim-1",
            text: "Validated artifacts preserve provenance.",
            confidence: 0.95,
            sourceId,
          },
          {
            id: "claim-2",
            text: "Admission occurs before delivery.",
            confidence: 0.9,
            sourceId,
          },
          {
            id: "claim-3",
            text: "The event log supports auditability.",
            confidence: 0.85,
            sourceId,
          },
        ],
      },
      null,
      2,
    );
  }

  private summaryArtifact(citedClaimIds: string[]): string {
    return JSON.stringify(
      {
        keyPoints: [
          {
            text: "Validated handoffs preserve provenance.",
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
}
