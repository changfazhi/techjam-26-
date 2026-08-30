/**
 * Stage schema: report.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 *
 * Validates the final formatted markdown report against the stage-3 admission
 * rule in docs/PLAN.md section 2: every key point appears in the body, every
 * cited source appears in a References section, and the report is under 8,000
 * characters. Plus the cross-cutting secret scan.
 */

import type { StageSchema, ValidationContext, ValidationResult } from "./index.js";
import { scanForSecrets } from "./redaction.js";

const MAX_REPORT_LENGTH = 8000;

export const reportSchema: StageSchema = {
  id: "report",

  describe(): string {
    return `# Executive Report Title

A comprehensive and well-structured markdown report synthesizing the key findings.

## Key Findings
- Detailed discussion of key points...

## References
- Source document references...

Requirements:
- Output must be formatted Markdown text.
- Must be under 8,000 characters in total length.
- Must end with a '## References' section.
- Every key point from the summary stage MUST appear in the body, before the
  References heading. Reproduce each key point's wording.
- The References section MUST list the source document of every claim the
  summary cited. Missing a source will cause immediate rejection.`;
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

    // Check non-empty content
    if (!raw.trim()) {
      return { ok: false, violations: ["Report content cannot be empty"] };
    }

    const violations: string[] = [];

    // Length constraint. PLAN.md says "under 8,000", so 8,000 exactly is over.
    if (raw.length >= MAX_REPORT_LENGTH) {
      violations.push(
        `Report must be under 8,000 characters (current: ${raw.length})`,
      );
    }

    // Locate the References heading, ignoring anything inside a fenced code
    // block so a heading quoted in an example cannot satisfy the rule.
    const headingIndex = findReferencesHeading(raw);
    if (headingIndex === null) {
      violations.push(
        "Report must end with a '## References' section listing source documents",
      );
      // Without the split there is nothing to check the remaining rules against.
      return { ok: false, violations };
    }

    const body = raw.slice(0, headingIndex);
    const references = raw.slice(headingIndex);

    // Every key point must appear in the body. Fails closed: if the summary
    // artifact is not available in parsed form there is nothing to trace the
    // report back to, and an unverifiable report is not an admissible one.
    const summary = asSummary(context.priorArtifacts?.["summary"]);
    if (!summary) {
      violations.push(
        "cannot verify key point coverage: stage 2 summary artifact unavailable",
      );
    } else {
      const haystack = normalize(body);
      const missing = summary.keyPoints
        .map((point) => point.text)
        .filter((text) => !haystack.includes(normalize(text)));

      if (missing.length > 0) {
        violations.push(
          `key points missing from the report body: ${missing
            .map((t) => JSON.stringify(truncate(t)))
            .join(", ")}`,
        );
      }
    }

    // Every source behind a cited claim must appear in the References section.
    // Needs both prior artifacts: summary supplies the cited claim ids, research
    // maps those ids to source documents.
    const research = asResearch(context.priorArtifacts?.["research"]);
    if (summary && !research) {
      violations.push(
        "cannot verify source coverage: stage 1 research artifact unavailable",
      );
    } else if (summary && research) {
      const sourceByClaimId = new Map(
        research.claims.map((claim) => [claim.id, claim.sourceId] as const),
      );
      const citedSources = new Set<string>();
      for (const point of summary.keyPoints) {
        for (const claimId of point.citedClaimIds) {
          const sourceId = sourceByClaimId.get(claimId);
          if (sourceId) citedSources.add(sourceId);
        }
      }

      const referencesText = normalize(references);
      const uncited = [...citedSources].filter(
        (sourceId) => !referencesText.includes(normalize(sourceId)),
      );

      if (uncited.length > 0) {
        violations.push(
          `cited sources missing from the References section: ${uncited
            .map((s) => JSON.stringify(s))
            .join(", ")}`,
        );
      }
    }

    if (violations.length > 0) {
      return { ok: false, violations };
    }

    return { ok: true, value: raw };
  },
};

/** Collapses whitespace and case so matching survives reflowing and rewrapping. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function truncate(text: string, limit = 60): string {
  return text.length <= limit ? text : text.slice(0, limit - 1) + "\u2026";
}

/**
 * Index of the References heading, or null. Fenced code blocks are masked first
 * so a heading shown inside an example does not count as the real section.
 */
function findReferencesHeading(raw: string): number | null {
  let masked = raw;
  for (const fence of raw.matchAll(/^[ \t]*(`{3,}|~{3,})[\s\S]*?^[ \t]*\1[ \t]*$/gm)) {
    const start = fence.index;
    if (start === undefined) continue;
    masked =
      masked.slice(0, start) +
      " ".repeat(fence[0].length) +
      masked.slice(start + fence[0].length);
  }

  const match = masked.match(/(?:^|\n)[ \t]*#{1,6}[ \t]+References\b/i);
  if (!match || match.index === undefined) return null;

  // Point at the "#" rather than the newline preceding it.
  return match.index + match[0].indexOf("#");
}

interface SummaryShape {
  keyPoints: Array<{ text: string; citedClaimIds: string[] }>;
}

interface ResearchShape {
  claims: Array<{ id: string; sourceId: string }>;
}

function asSummary(value: unknown): SummaryShape | null {
  if (!value || typeof value !== "object") return null;
  const points = (value as { keyPoints?: unknown }).keyPoints;
  if (!Array.isArray(points) || points.length === 0) return null;

  const keyPoints: SummaryShape["keyPoints"] = [];
  for (const point of points) {
    if (!point || typeof point !== "object") return null;
    const { text, citedClaimIds } = point as {
      text?: unknown;
      citedClaimIds?: unknown;
    };
    if (typeof text !== "string") return null;
    if (!Array.isArray(citedClaimIds)) return null;
    keyPoints.push({
      text,
      citedClaimIds: citedClaimIds.filter(
        (id): id is string => typeof id === "string",
      ),
    });
  }
  return { keyPoints };
}

function asResearch(value: unknown): ResearchShape | null {
  if (!value || typeof value !== "object") return null;
  const claims = (value as { claims?: unknown }).claims;
  if (!Array.isArray(claims) || claims.length === 0) return null;

  const parsed: ResearchShape["claims"] = [];
  for (const claim of claims) {
    if (!claim || typeof claim !== "object") return null;
    const { id, sourceId } = claim as { id?: unknown; sourceId?: unknown };
    if (typeof id !== "string" || typeof sourceId !== "string") return null;
    parsed.push({ id, sourceId });
  }
  return { claims: parsed };
}
