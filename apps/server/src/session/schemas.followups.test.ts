/**
 * Regression tests for the three W4 follow-up fixes.
 * See the review on PR #7: prompt instruction, stage-3 admission rule,
 * and the fail-open provenance check.
 */

import { describe, it, expect } from "vitest";
import { buildStagePrompt } from "./prompt.js";
import { researchSchema } from "./schemas/index.js";
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
