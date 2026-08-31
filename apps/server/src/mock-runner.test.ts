import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockRunner } from "./mock-runner.js";
import { SOURCE_MANIFEST_HEADING } from "./session/prompt.js";
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

describe("MockRunner provenance", () => {
  const manifestPrompt = [
    "Write your answer to `research.json` in this workspace.",
    SOURCE_MANIFEST_HEADING,
    "",
    "- recycling-notes.md",
    "- safety-notes.md",
  ].join("\n\n");

  it("claims sourceIds from the prompt manifest, not the schema's example", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "mock-runner-"));
    temporaryDirectories.push(workspacePath);

    await new MockRunner().run(request(workspacePath, manifestPrompt));

    const research = JSON.parse(
      await readFile(path.join(workspacePath, "research.json"), "utf8"),
    ) as { claims: Array<{ sourceId: string }> };

    expect(research.claims.map((claim) => claim.sourceId)).toEqual([
      "recycling-notes.md",
      "recycling-notes.md",
      "recycling-notes.md",
    ]);
    // The regression: "document-name.txt" is the example inside the research
    // schema's own description, and the mock used to scrape it out of the prompt.
    expect(JSON.stringify(research)).not.toContain("document-name.txt");
  });

  it("falls back to the seeded files on disk when the prompt has no manifest", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "mock-runner-"));
    temporaryDirectories.push(workspacePath);
    await writeFile(path.join(workspacePath, "market-notes.md"), "# Market\n", "utf8");
    await writeFile(path.join(workspacePath, "README.md"), "scaffold\n", "utf8");

    await new MockRunner().run(
      request(workspacePath, "Write your answer to `research.json` in this workspace."),
    );

    const research = JSON.parse(
      await readFile(path.join(workspacePath, "research.json"), "utf8"),
    ) as { claims: Array<{ sourceId: string }> };

    expect(research.claims[0]?.sourceId).toBe("market-notes.md");
  });

  it("extracts mock claims from user-supplied source documents", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "mock-runner-"));
    temporaryDirectories.push(workspacePath);
    await writeFile(
      path.join(workspacePath, "earnings.md"),
      "# Earnings\nRevenue increased by 14 percent.\nOperating margin reached 22 percent.\n",
      "utf8",
    );
    await writeFile(
      path.join(workspacePath, "outlook.txt"),
      "Management expects demand to remain stable.\n",
      "utf8",
    );

    await new MockRunner().run(
      request(
        workspacePath,
        [
          "Write your answer to `research.json` in this workspace.",
          SOURCE_MANIFEST_HEADING,
          "",
          "- earnings.md",
          "- outlook.txt",
        ].join("\n\n"),
      ),
    );

    const research = JSON.parse(
      await readFile(path.join(workspacePath, "research.json"), "utf8"),
    ) as { claims: Array<{ text: string; sourceId: string }> };

    expect(research.claims).toMatchObject([
      { text: "Revenue increased by 14 percent.", sourceId: "earnings.md" },
      { text: "Operating margin reached 22 percent.", sourceId: "earnings.md" },
      { text: "Management expects demand to remain stable.", sourceId: "outlook.txt" },
    ]);

    await new MockRunner().run(
      request(workspacePath, "Write your answer to `summary.json` in this workspace."),
    );
    const summary = JSON.parse(
      await readFile(path.join(workspacePath, "summary.json"), "utf8"),
    ) as { keyPoints: Array<{ text: string }> };
    expect(summary.keyPoints[0]?.text).toBe("Revenue increased by 14 percent.");
  });

  it("reports the delivered key points and lists the seeded sources", async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), "mock-runner-"));
    temporaryDirectories.push(workspacePath);
    await writeFile(
      path.join(workspacePath, "summary.json"),
      JSON.stringify({
        keyPoints: [{ text: "Recycling recovers lithium.", citedClaimIds: ["claim-1"] }],
      }),
      "utf8",
    );

    await new MockRunner().run(
      request(
        workspacePath,
        [
          "Write your answer to `report.md` in this workspace.",
          SOURCE_MANIFEST_HEADING,
          "",
          "- recycling-notes.md",
        ].join("\n\n"),
      ),
    );

    const report = await readFile(path.join(workspacePath, "report.md"), "utf8");
    const references = report.slice(report.indexOf("## References"));

    expect(report).toContain("# Handoff Gate report");
    // report.ts requires every key point to reappear verbatim before References.
    expect(report.slice(0, report.indexOf("## References"))).toContain(
      "Recycling recovers lithium.",
    );
    expect(references).toContain("- recycling-notes.md");
    expect(references).not.toContain("source-1.txt");
  });
});

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
