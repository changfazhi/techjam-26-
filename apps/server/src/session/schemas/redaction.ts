/**
 * Cross-cutting credential scan applied to every artifact before admission.
 * Owned by W4 (Schemas). See docs/PLAN.md, "A fourth rule".
 *
 * STUB — W4 implements. The runtime container receives ARK_API_KEY, so an agent
 * can read its own environment; without this scan the broker would carry a
 * leaked credential into the next workspace and render it in the UI.
 */

export interface RedactionFinding {
  kind: "ark-key" | "token-like";
  hint: string;
}

/** Returns one finding per suspected credential. Never includes the value itself. */
export function scanForSecrets(_raw: string): RedactionFinding[] {
  throw new Error("not implemented: W4 (schemas/redaction.ts)");
}
