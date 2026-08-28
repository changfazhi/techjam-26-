/**
 * Stage schema: summary.
 * Owned by W4 (Schemas). See docs/PLAN.md section 2 for the admission rule.
 *
 * STUB — W4 implements.
 */

import type { StageSchema, ValidationContext, ValidationResult } from "./index.js";

export const summarySchema: StageSchema = {
  id: "summary",
  describe(): string {
    throw new Error("not implemented: W4 (schemas/summary.ts)");
  },
  validate(_raw: string, _context: ValidationContext): ValidationResult {
    throw new Error("not implemented: W4 (schemas/summary.ts)");
  },
};
