import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockRunner } from "./mock-runner.js";
import type { RunnerRequest } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function request(workspacePath: string, prompt: string): RunnerRequest {
  return {
    agentId: "mock-agent",
    workspacePath,
    prompt,
    threadId: null,
  };
}

describe("MockRunner WRONG_CITATION", () => {
  it("corrupts only the initial summary attempt and repairs the retry", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "mock-runner-"));
    temporaryDirectories.push(workspacePath);
    const runner = new MockRunner({ misbehaviour: "WRONG_CITATION" });

    await runner.run(
      request(
        workspacePath,
        "Write your answer to `research.json` in this workspace.",
      ),
    );
    const research = JSON.parse(
      await readFile(path.join(workspacePath, "research.json"), "utf8"),
    ) as { claims: Array<{ id: string }> };
    expect(research.claims[0]?.id).toBe("claim-1");

    await runner.run(
      request(
        workspacePath,
        "Write your answer to `summary.json` in this workspace.",
      ),
    );
    const heldSummary = JSON.parse(
      await readFile(path.join(workspacePath, "summary.json"), "utf8"),
    ) as { keyPoints: Array<{ citedClaimIds: string[] }> };
    expect(heldSummary.keyPoints[0]?.citedClaimIds).toEqual(["claim-99"]);

    await runner.run(
      request(
        workspacePath,
        [
          "Write your answer to `summary.json` in this workspace.",
          "## Previous attempt was rejected",
          "- cited claims not in stage 1: claim-99",
        ].join("\n\n"),
      ),
    );
    const admittedSummary = JSON.parse(
      await readFile(path.join(workspacePath, "summary.json"), "utf8"),
    ) as { keyPoints: Array<{ citedClaimIds: string[] }> };
    expect(admittedSummary.keyPoints[0]?.citedClaimIds).toEqual(["claim-1"]);

    await runner.run(
      request(
        workspacePath,
        "Read summary.json and write the report to report.md.",
      ),
    );
    await expect(readFile(path.join(workspacePath, "report.md"), "utf8")).resolves.toContain(
      "# Handoff Gate report",
    );
  });
});
