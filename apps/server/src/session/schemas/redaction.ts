/**
 * Cross-cutting credential scan applied to every artifact before admission.
 * Owned by W4 (Schemas). See docs/PLAN.md, "A fourth rule".
 *
 * Scans raw content for Ark API keys, generic LLM API keys (sk-*, ep-*),
 * Bearer tokens, and private keys.
 * INVARIANT 8: Never includes the secret value in the finding or hint.
 */

export interface RedactionFinding {
  kind: "ark-key" | "token-like";
  hint: string;
}

/**
 * Patterns matching potential secrets.
 * Each pattern has an associated kind and sanitized hint.
 */
const SECRET_PATTERNS: Array<{
  regex: RegExp;
  kind: "ark-key" | "token-like";
  hint: string;
}> = [
  {
    // Ark endpoint or resource ID tokens, e.g. ep-20240830-xxxxx. The lookahead
    // requires a digit somewhere in the token, which every real endpoint id has
    // (they carry a timestamp) and doc slugs like ep-getting-started-guide do
    // not. Known gap, accepted: a purely alphabetic ep-abcdefghijkl is
    // indistinguishable from a doc slug without that digit signal.
    regex: /\bep-(?=[a-zA-Z0-9_\-]*\d)[a-zA-Z0-9_\-]{8,}\b/g,
    kind: "ark-key",
    hint: "Artifact contains an Ark endpoint key (ep-...)",
  },
  {
    // Explicit Ark API key variable or assignment
    regex: /\b(?:ARK_API_KEY|ark_api_key)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\..]{8,}['"]?/g,
    kind: "ark-key",
    hint: "Artifact contains an Ark API key assignment",
  },
  {
    // OpenAI / general provider style secret keys: sk-...
    regex: /\bsk-[a-zA-Z0-9_\-]{20,}\b/g,
    kind: "token-like",
    hint: "Artifact contains a secret token (sk-...)",
  },
  {
    // Authorization Bearer tokens, in any case: HTTP auth schemes are
    // case-insensitive (RFC 7235) and clients routinely emit "bearer".
    // The lookahead requires a digit in the token, which every real bearer
    // credential (JWT, base64) has and hyphenated English prose does not —
    // that is what keeps "the bearer of-the-standard-responsibility-set" out.
    regex: /\bbearer\s+(?=[a-zA-Z0-9_\-.]*\d)[a-zA-Z0-9_\-.]{20,}\b/gi,
    kind: "token-like",
    hint: "Artifact contains a Bearer authorization token",
  },
  {
    // Private key block headers
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    kind: "token-like",
    hint: "Artifact contains a private key header",
  },
  {
    // Common API key / secret key variable assignments
    regex: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9_\-\..]{16,}['"]/gi,
    kind: "token-like",
    hint: "Artifact contains an API key or auth token assignment",
  },
];

/**
 * Returns one finding per suspected credential.
 * Never includes the raw secret value in the finding.
 */
export function scanForSecrets(raw: string): RedactionFinding[] {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  const findings: RedactionFinding[] = [];
  const seenMatchedSecrets = new Set<string>();

  // Check if current process.env.ARK_API_KEY is present in raw text.
  // The length floor keeps short placeholders from matching ordinary prose as
  // substrings: "devkey" is 6, and "test-key" — the value agent-service.test.ts
  // and coordinator.test.ts configure — is 8. Twelve clears both while staying
  // far below any real Ark key, so a short real key is still protected.
  const envArkKey = process.env.ARK_API_KEY?.trim();
  if (envArkKey && envArkKey.length >= 12 && raw.includes(envArkKey)) {
    seenMatchedSecrets.add(envArkKey);
    findings.push({
      kind: "ark-key",
      hint: "Artifact contains the runtime environment ARK_API_KEY",
    });
  }

  for (const { regex, kind, hint } of SECRET_PATTERNS) {
    // Reset stateful regexes
    regex.lastIndex = 0;
    const matches = raw.matchAll(regex);
    for (const match of matches) {
      const matchedText = match[0];
      if (!seenMatchedSecrets.has(matchedText)) {
        seenMatchedSecrets.add(matchedText);
        findings.push({ kind, hint });
      }
    }
  }

  return findings;
}
