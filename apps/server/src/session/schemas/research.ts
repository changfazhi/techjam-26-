/**
 * Stage schema: research.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 */

import { z } from "zod";
import type { StageSchema, ValidationContext, ValidationResult } from "./index.js";
import { scanForSecrets } from "./redaction.js";

const researchClaimSchema = z.object({
  id: z.string().trim().min(1, "Claim id cannot be empty"),
  text: z.string().trim().min(1, "Claim text cannot be empty"),
  confidence: z
    .number({ message: "Confidence must be a number" })
    .min(0, "Confidence must be between 0.0 and 1.0")
    .max(1, "Confidence must be between 0.0 and 1.0"),
  sourceId: z.string().trim().min(1, "sourceId cannot be empty"),
});

const researchArtifactSchema = z.object({
  claims: z.array(researchClaimSchema).min(3, "At least 3 claims are required"),
});

export type ResearchArtifact = z.infer<typeof researchArtifactSchema>;

export const researchSchema: StageSchema = {
  id: "research",

  describe(): string {
    return JSON.stringify(
      {
        claims: [
          {
            id: "claim-1",
            text: "A specific factual claim extracted from the source document.",
            confidence: 0.95,
            sourceId: "document-name.txt",
          },
        ],
      },
      null,
      2,
    ) +
      "\n\nRequirements:\n" +
      "- Output must be valid JSON with a top-level 'claims' array.\n" +
      "- Must contain at least 3 claims.\n" +
      "- Each claim must have:\n" +
      "  * 'id': Unique string identifier (e.g. 'claim-1', 'claim-2').\n" +
      "  * 'text': Non-empty extracted claim text.\n" +
      "  * 'confidence': Number between 0.0 and 1.0 representing extraction confidence.\n" +
      "  * 'sourceId': Exact filename of the seeded source document the claim came from.";
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
    const result = researchArtifactSchema.safeParse(parsedJson);
    if (!result.success) {
      const violations = result.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      );
      return {
        ok: false,
        violations,
      };
    }

    // Validate sourceId provenance against sourceManifest
    if (context.sourceManifest && context.sourceManifest.length > 0) {
      const allowedSources = new Set(context.sourceManifest);
      const invalidSources = [
        ...new Set(
          result.data.claims
            .map((c) => c.sourceId)
            .filter((sourceId) => !allowedSources.has(sourceId)),
        ),
      ];

      if (invalidSources.length > 0) {
        return {
          ok: false,
          violations: [
            `unknown sourceId: ${invalidSources.map((s) => `"${s}"`).join(", ")}. Allowed sources: ${context.sourceManifest.map((s) => `"${s}"`).join(", ")}`,
          ],
        };
      }
    }

    return {
      ok: true,
      value: result.data,
    };
  },
};