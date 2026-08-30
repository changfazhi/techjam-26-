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
    // Ark endpoint or resource ID tokens: ep- followed by timestamp/id (e.g. ep-20240830-xxxxx)
    // Anchored to date/numeric segment so URLs like ep-getting-started-guide do not match.
    regex: /\bep-\d{8,}[a-zA-Z0-9_\-]*\b/g,
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
    // Authorization Bearer tokens (strictly capitalized Bearer followed by token chars)
    regex: /\bBearer\s+[a-zA-Z0-9_\-\..]{20,}\b/g,
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

  // Check if current process.env.ARK_API_KEY is present in raw text
  // Safer check: require key length >= 16 to avoid short dev key false positives
  const envArkKey = process.env.ARK_API_KEY?.trim();
  if (envArkKey && envArkKey.length >= 16 && raw.includes(envArkKey)) {
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
