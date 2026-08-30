/**
 * Regression tests for the three W4 follow-up fixes.
 * See the review on PR #7: prompt instruction, stage-3 admission rule,
 * and the fail-open provenance check.
 */

import { describe, it, expect } from "vitest";
import { buildStagePrompt } from "./prompt.js";
import { researchSchema, reportSchema } from "./schemas/index.js";
import type { Stage } from "./types.js";

const stage: Stage = {
  id: "research",
  role: "Researcher",
  agentId: "agent-1",
  schemaId: "research",
  outputPath: "research.json",
  inputFileName: null,
  instruction: "Extract every factual claim about Q3 revenue from the seeded sources.",
  maxAttempts: 3,
};

describe("fix 1: prompt carries stage.instruction", () => {
  it("includes the instruction text verbatim", () => {
    const prompt = buildStagePrompt({
      stage,
      schemaDescription: "{...}",
      priorEvents: [],
      inputContents: null,
      violations: [],
    });
    expect(prompt).toContain(stage.instruction);
  });

  it("omits the task section when the instruction is blank", () => {
    const prompt = buildStagePrompt({
      stage: { ...stage, instruction: "   " },
      schemaDescription: "{...}",
      priorEvents: [],
      inputContents: null,
      violations: [],
    });
    expect(prompt).not.toContain("## Your task");
  });
});

describe("fix 4: provenance fails closed on an empty manifest", () => {
  const claims = JSON.stringify({
    claims: [
      { id: "c1", text: "a", confidence: 0.9, sourceId: "totally-made-up.txt" },
      { id: "c2", text: "b", confidence: 0.9, sourceId: "totally-made-up.txt" },
      { id: "c3", text: "c", confidence: 0.9, sourceId: "totally-made-up.txt" },
    ],
  });

  it("rejects unverifiable claims when no sources were seeded", () => {
    const result = researchSchema.validate(claims, {
      priorArtifacts: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations[0]).toMatch(/unverifiable/);
  });

  it("still admits claims whose sourceId is in a real manifest", () => {
    const result = researchSchema.validate(claims, {
      priorArtifacts: {},
      sourceManifest: ["totally-made-up.txt"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("fix 2: stage-3 admission rule", () => {
  const research = {
    claims: [
      { id: "claim-1", text: "Revenue rose 14%.", confidence: 0.9, sourceId: "q3.txt" },
      { id: "claim-2", text: "Margin at 62%.", confidence: 0.8, sourceId: "margins.txt" },
    ],
  };
  const summary = {
    keyPoints: [
      { text: "Revenue grew strongly in Q3.", citedClaimIds: ["claim-1"] },
      { text: "Margins held above sixty percent.", citedClaimIds: ["claim-2"] },
    ],
  };
  const ctx = { priorArtifacts: { research, summary }, sourceManifest: ["q3.txt", "margins.txt"] };

  const goodReport = `# Q3 Report

Revenue grew strongly in Q3. Margins held above sixty percent.

## References
- q3.txt
- margins.txt
`;

  it("admits a report that covers every key point and cites every source", () => {
    expect(reportSchema.validate(goodReport, ctx).ok).toBe(true);
  });

  it("rejects invented content that omits the key points", () => {
    const invented = "# Report\n\nCompletely unrelated invented content.\n\n## References\n- q3.txt\n- margins.txt\n";
    const r = reportSchema.validate(invented, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/key points missing/);
  });

  it("rejects a report whose References omit a cited source", () => {
    const partial = goodReport.replace("- margins.txt\n", "");
    const r = reportSchema.validate(partial, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/margins\.txt/);
  });

  it("survives reflowed whitespace in the body", () => {
    const reflowed = goodReport.replace(
      "Revenue grew strongly in Q3.",
      "Revenue grew\n   strongly in Q3.",
    );
    expect(reportSchema.validate(reflowed, ctx).ok).toBe(true);
  });

  it("does not accept a References heading inside a fenced code block", () => {
    const fenced = "# Report\n\nRevenue grew strongly in Q3. Margins held above sixty percent.\n\n```\n## References\n```\n";
    const r = reportSchema.validate(fenced, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/References/);
  });

  it("rejects a report of exactly 8000 characters (spec says under)", () => {
    const filler = "x".repeat(8000 - goodReport.length);
    const exact = goodReport.replace("# Q3 Report", "# Q3 Report" + filler);
    expect(exact.length).toBe(8000);
    const r = reportSchema.validate(exact, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/under 8,000/);
  });

  it("fails closed when the summary artifact is unavailable (Blocker 1 seam)", () => {
    const r = reportSchema.validate(goodReport, {
      priorArtifacts: {
        research: { stageId: "research", path: "/w/research.json", hash: "a", bytes: 1, validatedAt: "" },
        summary: { stageId: "summary", path: "/w/summary.json", hash: "b", bytes: 1, validatedAt: "" },
      },
      sourceManifest: ["q3.txt"],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/unavailable/);
  });
});
