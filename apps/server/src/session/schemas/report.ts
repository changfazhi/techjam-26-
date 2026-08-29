/**
 * Stage schema: report.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 *
 * Validates the final formatted markdown report: length limit,
 * structural integrity, presence of a references section, and secret scan.
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
- Must not exceed 8,000 characters in total length.
- Must contain a '## References' section at the end.
- Must thoroughly incorporate key points from the summary stage.`;
  },

  validate(raw: string, _context: ValidationContext): ValidationResult {
    // INVARIANT 2: Run credential scan before own checks
    const secretFindings = scanForSecrets(raw);
    if (secretFindings.length > 0) {
      return {
        ok: false,
        violations: secretFindings.map((f) => `Credential leak detected: ${f.hint}`),
      };
    }

    // Check non-empty content
    if (!raw || typeof raw !== "string" || !raw.trim()) {
      return {
        ok: false,
        violations: ["Report content cannot be empty"],
      };
    }

    const violations: string[] = [];

    // Length constraint
    if (raw.length > MAX_REPORT_LENGTH) {
      violations.push(
        `Report exceeds 8,000 characters limit (current: ${raw.length} characters)`,
      );
    }

    // Required References section
    const hasReferencesSection = /(?:^|\n)#{1,6}\s+References\b/i.test(raw);
    if (!hasReferencesSection) {
      violations.push(
        "Report must contain a '## References' section listing source documents",
      );
    }

    if (violations.length > 0) {
      return {
        ok: false,
        violations,
      };
    }

    return {
      ok: true,
      value: raw,
    };
  },
};