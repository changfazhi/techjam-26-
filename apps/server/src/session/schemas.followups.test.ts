/**
 * Regression tests for the three W4 follow-up fixes.
 * See the review on PR #7: prompt instruction, stage-3 admission rule,
 * and the fail-open provenance check.
 */

import { describe, it, expect } from "vitest";
import { buildStagePrompt } from "./prompt.js";
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
