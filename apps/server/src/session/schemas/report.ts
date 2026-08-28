/**
 * Stage schema: report.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 *
 * STUB — W4 implements.
 */

import type { StageSchema, ValidationContext, ValidationResult } from "./index.js";

export const reportSchema: StageSchema = {
  id: "report",
  describe(): string {
    throw new Error("not implemented: W4 (schemas/report.ts)");
  },
  validate(_raw: string, _context: ValidationContext): ValidationResult {
    throw new Error("not implemented: W4 (schemas/report.ts)");
  },
};
