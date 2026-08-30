/**
 * Regression tests for W4 follow-up fixes.
 * Covers: prompt instruction, stage-3 admission rule, provenance fail-closed,
 * redaction false positives, multi-key deduplication, claim id uniqueness,
 * and report References section heading/position rules.
 */

import { describe, it, expect } from "vitest";
import { buildStagePrompt } from "./prompt.js";
import { researchSchema, reportSchema, scanForSecrets } from "./schemas/index.js";
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
      priorBySchemaId: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.violations[0]).toMatch(/unverifiable/);
  });

  it("still admits claims whose sourceId is in a real manifest", () => {
    const result = researchSchema.validate(claims, {
      priorBySchemaId: {},
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
  const ctx = { priorBySchemaId: { research, summary }, sourceManifest: ["q3.txt", "margins.txt"] };

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
      priorBySchemaId: {
        research: { stageId: "research", path: "/w/research.json", hash: "a", bytes: 1, validatedAt: "" },
        summary: { stageId: "summary", path: "/w/summary.json", hash: "b", bytes: 1, validatedAt: "" },
      },
      sourceManifest: ["q3.txt"],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/unavailable/);
  });

  it("rejects report with non-level-2 References heading", () => {
    const badHeading = goodReport.replace("## References", "### References");
    const r = reportSchema.validate(badHeading, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/## References/);
  });

  it("rejects report when References is followed by subsequent section heading", () => {
    const misplaced = `# Q3 Report\n\n## References\n- q3.txt\n- margins.txt\n\n## Future Outlook\nRevenue will grow.\n`;
    const r = reportSchema.validate(misplaced, ctx);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/no subsequent headings/);
  });
});

describe("redaction fixes: false positive regression & deduplication", () => {
  it("does not flag ordinary URLs like ep-getting-started-guide", () => {
    const text = "See https://example.com/docs/ep-getting-started-guide for documentation.";
    expect(scanForSecrets(text)).toEqual([]);
  });

  it("does not flag normal English phrase 'the bearer of-the-standard-responsibility-set'", () => {
    const text = "the bearer of-the-standard-responsibility-set";
    expect(scanForSecrets(text)).toEqual([]);
  });

  it("flags a lowercase bearer token in an Authorization header", () => {
    const findings = scanForSecrets("authorization: bearer abcdefghijklmnopqrstuvwxyz123");
    expect(findings.length).toBe(1);
    expect(findings[0]?.kind).toBe("token-like");
    expect(findings[0]?.hint).not.toContain("abcdefghijklmnopqrstuvwxyz123");
  });

  it("flags an uppercase BEARER token", () => {
    const findings = scanForSecrets("BEARER abcdefghijklmnopqrstuvwxyz123");
    expect(findings.length).toBe(1);
  });

  it("still ignores lowercase bearer in ordinary English prose", () => {
    const text =
      "The individual was the bearer of-the-standard-responsibility-set across the organization.";
    expect(scanForSecrets(text)).toEqual([]);
  });

  it("emits one finding per distinct secret credential without collapsing hints", () => {
    const text = "Key A: sk-11111111111111111111\nKey B: sk-22222222222222222222";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(2);
  });

  it("collapses duplicate occurrences of the exact same secret credential", () => {
    const text = "Key A: sk-11111111111111111111\nKey A again: sk-11111111111111111111";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
  });
});

describe("research fixes: claim ID uniqueness", () => {
  it("rejects claims with duplicate IDs", () => {
    const dupes = JSON.stringify({
      claims: [
        { id: "claim-1", text: "Text A", confidence: 0.9, sourceId: "doc1.txt" },
        { id: "claim-1", text: "Text B", confidence: 0.8, sourceId: "doc1.txt" },
        { id: "claim-2", text: "Text C", confidence: 0.7, sourceId: "doc1.txt" },
      ],
    });
    const r = researchSchema.validate(dupes, {
      priorBySchemaId: {},
      sourceManifest: ["doc1.txt"],
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.violations.join(" ")).toMatch(/duplicate claim id/);
  });
});
