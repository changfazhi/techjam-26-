/**
 * Deterministic AgentRunner for development and tests.
 * Owned by W5 (Runtime & UI).
 *
 * Selected with RUNTIME_PROVIDER=mock. Needs no container engine and no Ark key,
 * which turns a 90-second feedback loop into a sub-second one. W5 extends this
 * with misbehaviour modes (wrong citation, no file written, hang) as the
 * coordinator tests need them.
 */

/**
 * Deterministic AgentRunner for development and coordinator tests.
 * Owned by W5 (Runtime & UI).
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

export class MockRunner implements AgentRunner {
  private readonly cancelled = new Set<string>();
  private readonly hanging = new Map<string, () => void>();

  constructor(private readonly config: MockRunnerConfig = DEFAULT_CONFIG) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(agentId: string): Promise<boolean> {
    const release = this.hanging.get(agentId);
    if (!release) return false;

    this.cancelled.add(agentId);
    this.hanging.delete(agentId);
    release();
    return true;
  }

  async run(): Promise<RunResult>;
  async run(request: RunnerRequest): Promise<RunnerResult>;
  async run(request?: RunnerRequest): Promise<RunResult | RunnerResult> {
    const result = await this.runResult(request);
    if (!request) return result;

    if (this.cancelled.delete(request.agentId)) {
      throw new RunCancelledError();
    }

    if (result.status === "TIMEOUT") {
      throw new Error("Mock runner timed out after the configured deadline");
    }

    if (result.status === "FAILED") {
      throw new Error(result.violations?.join("; ") ?? "Mock runner failed");
    }

    if (result.artifact) {
      await this.writeArtifact(request, result.artifact);
    }

    return {
      output: result.artifact
        ? "```json\n" + result.artifact + "\n```"
        : "mock runner completed without writing an artifact",
      threadId: request.threadId ?? "mock-thread-" + request.agentId,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  private async runResult(request?: RunnerRequest): Promise<RunResult> {
    if (this.config.misbehaviour === "HANG_PAST_DEADLINE") {
      await this.waitPastDeadline(request?.agentId);
      return {
        status: "TIMEOUT",
        violations: ["Mock runner exceeded the configured deadline."],
      };
    }

    const artifact = this.artifactFor(request?.prompt ?? "");

    if (this.config.misbehaviour === "NO_FILE_WRITTEN") {
      return {
        status: "SUCCESS",
        citations: VALID_CITATIONS,
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
      citations: VALID_CITATIONS,
    };
  }

  private async waitPastDeadline(agentId?: string): Promise<void> {
    const durationMs = this.config.hangDurationMs ?? 3_000;

    if (!agentId) {
      await new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
      return;
    }

    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(() => {
        this.hanging.delete(agentId);
        resolveWait();
      }, durationMs);

      this.hanging.set(agentId, () => {
        clearTimeout(timer);
        resolveWait();
      });
    });
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
    const explicitPath = prompt.match(
      /(?:write\s+(?:your\s+answer\s+)?to|output\s+path\s*[:=])\s*[`"']?([^`"'\s]+)[`"']?/i,
    )?.[1];

    if (explicitPath) return explicitPath;

    return (
      prompt.match(/research\.json|summary\.json|report\.md/i)?.[0] ?? null
    );
  }
}