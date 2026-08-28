/**
 * Prompt assembly: instruction + schema description + event digest + violations.
 * Owned by W4 (Schemas). See docs/BLUEPRINT.md section 6.3.
 *
 * STUB — W4 implements.
 */

import type { SessionEvent, Stage } from "./types.js";

export interface PromptInput {
  stage: Stage;
  /** Output of StageSchema.describe(), injected verbatim. */
  schemaDescription: string;
  /** Prior events for this session, used to build the digest. */
  priorEvents: SessionEvent[];
  /** Contents of the delivered input file, or null for the first stage. */
  inputContents: string | null;
  /** Violations from the previous attempt; empty on the first attempt. */
  violations: string[];
}

export function buildStagePrompt(_input: PromptInput): string {
  throw new Error("not implemented: W4 (prompt.ts)");
}
