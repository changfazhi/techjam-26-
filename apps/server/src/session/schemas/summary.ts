/**
 * Stage schema: summary.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 *
 * This is the Citation Gate: no key point can be admitted without citations,
 * and every citation must resolve to a real claim id from stage 1 research.
 */

import { z } from "zod";
import type { StageSchema, ValidationContext, ValidationResult } from "./index.js";
import { scanForSecrets } from "./redaction.js";

const keyPointSchema = z.object({
  text: z.string().trim().min(1, "Key point text cannot be empty"),
  citedClaimIds: z
    .array(z.string().trim().min(1, "Claim citation cannot be empty"))
    .min(1, "Every key point must have at least one citation"),
});

const summaryArtifactSchema = z.object({
  keyPoints: z.array(keyPointSchema).min(1, "At least 1 key point is required"),
});

export type SummaryArtifact = z.infer<typeof summaryArtifactSchema>;

export const summarySchema: StageSchema = {
  id: "summary",

  describe(): string {
    return JSON.stringify(
      {
        keyPoints: [
          {
            text: "A clear, concise key summary point synthesizing the findings.",
            citedClaimIds: ["claim-1", "claim-2"],
          },
        ],
      },
      null,
      2,
    ) +
      "\n\nRequirements:\n" +
      "- Output must be valid JSON with a top-level 'keyPoints' array.\n" +
      "- Must contain at least 1 key point.\n" +
      "- Every key point MUST include:\n" +
      "  * 'text': Non-empty summary text.\n" +
      "  * 'citedClaimIds': Non-empty array of claim IDs from stage 1 research (e.g. ['claim-1']).\n" +
      "- CRITICAL: Citing nonexistent claim IDs will cause immediate rejection.";
  },

  validate(raw: string, context: ValidationContext): ValidationResult {
    // INVARIANT 2: Run credential scan before own checks
    const secretFindings = scanForSecrets(raw);
    if (secretFindings.length > 0) {
      return {
        ok: false,
        violations: secretFindings.map((f) => `Credential leak detected: ${f.hint}`),
      };
    }

    // INVARIANT 1: Never throw on malformed JSON
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        violations: [`Invalid JSON syntax: ${msg}`],
      };
    }

    // Validate structure against Zod schema
    const result = summaryArtifactSchema.safeParse(parsedJson);
    if (!result.success) {
      const violations = result.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      );
      return {
        ok: false,
        violations,
      };
    }

    // Citation Gate: verify cited claim IDs against stage 1 research
    const priorResearch = context.priorArtifacts?.["research"] as
      | { claims?: Array<{ id?: string }> }
      | undefined;

    const validClaimIds = new Set<string>();
    if (priorResearch && Array.isArray(priorResearch.claims)) {
      for (const claim of priorResearch.claims) {
        if (claim && typeof claim.id === "string") {
          validClaimIds.add(claim.id);
        }
      }
    }

    const bad = result.data.keyPoints
      .flatMap((p) => p.citedClaimIds)
      .filter((id) => !validClaimIds.has(id));

    if (bad.length > 0) {
      return {
        ok: false,
        violations: [`cited claims not in stage 1: ${bad.join(", ")}`],
      };
    }

    return {
      ok: true,
      value: result.data,
    };
  },
};