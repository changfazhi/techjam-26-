import { describe, expect, it } from "vitest";
import {
  createSchemaRegistry,
  reportSchema,
  researchSchema,
  scanForSecrets,
  summarySchema,
} from "./schemas/index.js";
import { buildStagePrompt } from "./prompt.js";
import type { SessionEvent, Stage } from "./types.js";

describe("W4: Credential Redaction Scanner (redaction.ts)", () => {
  it("returns no findings for clean text", () => {
    const findings = scanForSecrets("This is clean text with no credentials or secrets.");
    expect(findings).toEqual([]);
  });

  it("detects Ark API keys without leaking the value", () => {
    const text = "Configuration: ARK_API_KEY=ark-secret-1234567890abcdef";
    const findings = scanForSecrets(text);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].kind).toBe("ark-key");
    expect(findings[0].hint).not.toContain("ark-secret-1234567890abcdef");
  });

  it("detects Ark endpoint tokens (ep-*)", () => {
    const text = "Connecting to endpoint ep-20240830-xyz987654321";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("ark-key");
    expect(findings[0].hint).not.toContain("ep-20240830-xyz987654321");
  });

  it("does not flag ordinary URLs with ep- prefix as Ark endpoint keys", () => {
    const findings = scanForSecrets(
      "Refer to documentation at https://example.com/docs/ep-getting-started-guide for more info.",
    );
    expect(findings).toEqual([]);
  });

  it("detects sk-* tokens", () => {
    const text = "OpenAI key: sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("token-like");
    expect(findings[0].hint).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
  });

  it("detects Bearer authorization tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("token-like");
  });

  it("does not flag lowercase bearer in ordinary English text", () => {
    const text = "The individual was the bearer of-the-standard-responsibility-set across the organization.";
    const findings = scanForSecrets(text);
    expect(findings).toEqual([]);
  });

  it("produces distinct findings for distinct leaked credentials", () => {
    const text = "Key 1: sk-11111111111111111111 and Key 2: sk-22222222222222222222";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(2);
    expect(findings.every((f) => f.kind === "token-like")).toBe(true);
  });

  it("produces only one finding for repeated identical credentials", () => {
    const text = "Duplicate: sk-11111111111111111111 and repeated: sk-11111111111111111111";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
  });

  it("detects private key headers", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("token-like");
  });

  it("detects runtime process.env.ARK_API_KEY if present", () => {
    process.env.ARK_API_KEY = "test-runtime-ark-key-12345";
    const findings = scanForSecrets("leaked test-runtime-ark-key-12345 in text");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.hint.includes("runtime environment ARK_API_KEY"))).toBe(true);
    delete process.env.ARK_API_KEY;
  });

  it("does not flag short process.env.ARK_API_KEY dev values as substring match", () => {
    process.env.ARK_API_KEY = "devkey";
    const findings = scanForSecrets("Ordinary text containing devkey substring");
    expect(findings).toEqual([]);
    delete process.env.ARK_API_KEY;
  });
});

describe("W4: Stage 1 Schema (research.ts)", () => {
  const validManifest = ["doc1.txt", "doc2.pdf"];
  const validResearch = {
    claims: [
      { id: "claim-1", text: "Revenue increased by 14% year over year.", confidence: 0.95, sourceId: "doc1.txt" },
      { id: "claim-2", text: "Active user count reached 5 million.", confidence: 0.88, sourceId: "doc1.txt" },
      { id: "claim-3", text: "Gross margin remained steady at 62%.", confidence: 0.75, sourceId: "doc2.pdf" },
    ],
  };

  it("admits valid research output matching schema and source manifest", () => {
    const result = researchSchema.validate(JSON.stringify(validResearch), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(true);
  });

  it("never throws on invalid JSON syntax", () => {
    const result = researchSchema.validate("invalid { json [", {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations[0]).toContain("Invalid JSON syntax");
    }
  });

  it("rejects when fewer than 3 claims are provided", () => {
    const invalid = {
      claims: [
        { id: "claim-1", text: "Only one claim.", confidence: 0.9, sourceId: "doc1.txt" },
        { id: "claim-2", text: "Second claim.", confidence: 0.8, sourceId: "doc1.txt" },
      ],
    };
    const result = researchSchema.validate(JSON.stringify(invalid), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("At least 3 claims"))).toBe(true);
    }
  });

  it("rejects claims with duplicate claim IDs", () => {
    const duplicateClaims = {
      claims: [
        { id: "claim-1", text: "Claim 1", confidence: 0.9, sourceId: "doc1.txt" },
        { id: "claim-1", text: "Claim 2 duplicate id", confidence: 0.8, sourceId: "doc1.txt" },
        { id: "claim-2", text: "Claim 3", confidence: 0.7, sourceId: "doc2.pdf" },
      ],
    };
    const result = researchSchema.validate(JSON.stringify(duplicateClaims), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain('duplicate claim id: "claim-1"');
    }
  });

  it("rejects confidence outside [0, 1]", () => {
    const invalid = {
      claims: [
        { id: "claim-1", text: "Claim 1", confidence: 1.5, sourceId: "doc1.txt" },
        { id: "claim-2", text: "Claim 2", confidence: -0.1, sourceId: "doc1.txt" },
        { id: "claim-3", text: "Claim 3", confidence: 0.5, sourceId: "doc1.txt" },
      ],
    };
    const result = researchSchema.validate(JSON.stringify(invalid), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("between 0.0 and 1.0"))).toBe(true);
    }
  });

  it("rejects sourceId not present in sourceManifest", () => {
    const invalid = {
      claims: [
        { id: "claim-1", text: "Claim 1", confidence: 0.9, sourceId: "doc1.txt" },
        { id: "claim-2", text: "Claim 2", confidence: 0.8, sourceId: "hallucinated-doc.txt" },
        { id: "claim-3", text: "Claim 3", confidence: 0.7, sourceId: "doc2.pdf" },
      ],
    };
    const result = researchSchema.validate(JSON.stringify(invalid), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes('unknown sourceId: "hallucinated-doc.txt"'))).toBe(true);
    }
  });

  it("rejects research containing leaked secrets", () => {
    const withSecret = {
      ...validResearch,
      claims: [
        ...validResearch.claims,
        { id: "claim-4", text: "Secret key is sk-12345678901234567890abcdef", confidence: 0.9, sourceId: "doc1.txt" },
      ],
    };
    const result = researchSchema.validate(JSON.stringify(withSecret), {
      priorBySchemaId: {},
      sourceManifest: validManifest,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("Credential leak detected"))).toBe(true);
    }
  });

  it("provides human and LLM-actionable describe() string", () => {
    const desc = researchSchema.describe();
    expect(desc).toContain("claims");
    expect(desc).toContain("confidence");
  });
});

describe("W4: Stage 2 Schema — Citation Gate (summary.ts)", () => {
  const stage1Research = {
    claims: [
      { id: "claim-1", text: "Revenue rose 14%.", confidence: 0.9, sourceId: "doc1.txt" },
      { id: "claim-2", text: "User count at 5M.", confidence: 0.8, sourceId: "doc1.txt" },
      { id: "claim-3", text: "Gross margin 62%.", confidence: 0.7, sourceId: "doc2.pdf" },
    ],
  };

  it("admits summary when all cited claims resolve to stage 1", () => {
    const validSummary = {
      keyPoints: [
        { text: "Strong financial growth driven by margin and revenue expansion.", citedClaimIds: ["claim-1", "claim-3"] },
        { text: "User adoption expanding rapidly.", citedClaimIds: ["claim-2"] },
      ],
    };
    const result = summarySchema.validate(JSON.stringify(validSummary), {
      priorBySchemaId: { research: stage1Research },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects hallucinated citation with exact actionable violation string", () => {
    const hallucinatedSummary = {
      keyPoints: [
        { text: "Unsubstantiated market rumor.", citedClaimIds: ["claim-99"] },
      ],
    };
    const result = summarySchema.validate(JSON.stringify(hallucinatedSummary), {
      priorBySchemaId: { research: stage1Research },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain("cited claims not in stage 1: claim-99");
    }
  });

  it("rejects multiple hallucinated citations listing all bad ids", () => {
    const badSummary = {
      keyPoints: [
        { text: "Point 1", citedClaimIds: ["claim-1", "claim-88"] },
        { text: "Point 2", citedClaimIds: ["claim-99"] },
      ],
    };
    const result = summarySchema.validate(JSON.stringify(badSummary), {
      priorBySchemaId: { research: stage1Research },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain("cited claims not in stage 1: claim-88, claim-99");
    }
  });

  it("rejects key points with empty citations", () => {
    const emptyCitation = {
      keyPoints: [
        { text: "Uncited claim point.", citedClaimIds: [] },
      ],
    };
    const result = summarySchema.validate(JSON.stringify(emptyCitation), {
      priorBySchemaId: { research: stage1Research },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("at least one citation"))).toBe(true);
    }
  });

  it("rejects summary with leaked credentials", () => {
    const withSecret = {
      keyPoints: [
        { text: "Secret key: sk-12345678901234567890abcdef", citedClaimIds: ["claim-1"] },
      ],
    };
    const result = summarySchema.validate(JSON.stringify(withSecret), {
      priorBySchemaId: { research: stage1Research },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("Credential leak detected"))).toBe(true);
    }
  });
});

describe("W4: Stage 3 Schema (report.ts)", () => {
  const validReport = `# Q3 Market Performance Report

## Executive Summary
The company experienced strong financial results and customer acquisition.

## Key Findings
- Revenue grew 14% year over year.
- Customer accounts reached 5 million.

## References
- doc1.txt: Financial Statements 2025
- doc2.pdf: Customer Operations Review
`;

  it("admits valid markdown report containing a References section", () => {
    const result = reportSchema.validate(validReport, {
      // Stage 3 now traces the report back to the admitted stage 1 and 2
      // artifacts, so both must be supplied for a report to be admissible.
      priorBySchemaId: {
        research: {
          claims: [
            { id: "claim-1", text: "Revenue rose.", confidence: 0.9, sourceId: "doc1.txt" },
          ],
        },
        summary: {
          keyPoints: [
            { text: "Revenue grew 14% year over year.", citedClaimIds: ["claim-1"] },
          ],
        },
      },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects report using single-hash '# References' heading (must be level 2 '## References')", () => {
    const level1Ref = validReport.replace("## References", "# References");
    const result = reportSchema.validate(level1Ref, {
      priorBySchemaId: {
        research: {
          claims: [
            { id: "claim-1", text: "Revenue rose.", confidence: 0.9, sourceId: "doc1.txt" },
          ],
        },
        summary: {
          keyPoints: [
            { text: "Revenue grew 14% year over year.", citedClaimIds: ["claim-1"] },
          ],
        },
      },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("## References"))).toBe(true);
    }
  });

  it("rejects report where '## References' is followed by subsequent section headings", () => {
    const misplacedRef = `# Q3 Market Performance Report

## References
- doc1.txt: Financial Statements 2025
- doc2.pdf: Customer Operations Review

## Key Findings
- Revenue grew 14% year over year.
- Customer accounts reached 5 million.
`;
    const result = reportSchema.validate(misplacedRef, {
      priorBySchemaId: {
        research: {
          claims: [
            { id: "claim-1", text: "Revenue rose.", confidence: 0.9, sourceId: "doc1.txt" },
          ],
        },
        summary: {
          keyPoints: [
            { text: "Revenue grew 14% year over year.", citedClaimIds: ["claim-1"] },
          ],
        },
      },
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("no subsequent headings"))).toBe(true);
    }
  });

  it("rejects a report it cannot trace back to the summary stage", () => {
    const result = reportSchema.validate(validReport, {
      priorBySchemaId: {},
      sourceManifest: ["doc1.txt", "doc2.pdf"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("unavailable"))).toBe(true);
    }
  });

  it("rejects empty or whitespace report", () => {
    const result = reportSchema.validate("   \n\n  ", {
      priorBySchemaId: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain("Report content cannot be empty");
    }
  });

  it("rejects report missing a References section", () => {
    const noRef = `# Report Title\n\nSome body text without any reference section.`;
    const result = reportSchema.validate(noRef, {
      priorBySchemaId: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("References"))).toBe(true);
    }
  });

  it("rejects report exceeding 8,000 characters", () => {
    const largeReport = `# Large Report\n\n${"A".repeat(8100)}\n\n## References\n- doc1.txt`;
    const result = reportSchema.validate(largeReport, {
      priorBySchemaId: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("under 8,000 characters"))).toBe(true);
    }
  });

  it("rejects report with leaked credentials", () => {
    const secretReport = `# Report\n\nKey is sk-12345678901234567890abcdef\n\n## References\n- doc1.txt`;
    const result = reportSchema.validate(secretReport, {
      priorBySchemaId: {},
      sourceManifest: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.some((v) => v.includes("Credential leak detected"))).toBe(true);
    }
  });
});

describe("W4: Schema Registry (index.ts)", () => {
  it("registers and resolves all three stages", () => {
    const registry = createSchemaRegistry();
    expect(registry.get("research")).toBeDefined();
    expect(registry.get("summary")).toBeDefined();
    expect(registry.get("report")).toBeDefined();
  });

  it("throws for unknown schema IDs", () => {
    const registry = createSchemaRegistry();
    expect(() => registry.get("unknown_stage")).toThrow("Unknown stage schema: unknown_stage");
  });
});

describe("W4: Prompt Assembly (prompt.ts)", () => {
  const stage: Stage = {
    id: "summary",
    role: "Summarizer",
    agentId: "agent-123",
    schemaId: "summary",
    outputPath: "summary.json",
    inputFileName: "research.json",
    instruction: "Condense the research claims into cited key points.",
    maxAttempts: 2,
  };

  const priorEvents: SessionEvent[] = [
    {
      id: "ev-1",
      sessionId: "sess-1",
      seq: 1,
      stageId: null,
      agentId: null,
      runId: null,
      type: "session.started",
      attempt: null,
      payload: {},
      createdAt: new Date().toISOString(),
    },
    {
      id: "ev-2",
      sessionId: "sess-1",
      seq: 2,
      stageId: "research",
      agentId: "agent-research",
      runId: "run-1",
      type: "stage.completed",
      attempt: 1,
      payload: { artifactHash: "abcd1234ef56" },
      createdAt: new Date().toISOString(),
    },
  ];

  it("assembles clean stage prompt for first attempt", () => {
    const prompt = buildStagePrompt({
      stage,
      schemaDescription: summarySchema.describe(),
      priorEvents,
      inputContents: '{"claims": [{"id": "claim-1"}]}',
      violations: [],
    });

    expect(prompt).toContain("You are acting as the **Summarizer**");
    expect(prompt).toContain("Write your answer to `summary.json`");
    expect(prompt).toContain("## Session so far");
    expect(prompt).toContain("Stage 'research' admitted successfully");
    expect(prompt).toContain("## Input (`research.json`)");
    expect(prompt).not.toContain("## Previous attempt was rejected");
  });

  it("includes rejection section with violations on retry attempt", () => {
    const prompt = buildStagePrompt({
      stage,
      schemaDescription: summarySchema.describe(),
      priorEvents: [
        ...priorEvents,
        {
          id: "ev-3",
          sessionId: "sess-1",
          seq: 3,
          stageId: "summary",
          agentId: "agent-123",
          runId: "run-2",
          type: "stage.rejected",
          attempt: 1,
          payload: { violations: ["cited claims not in stage 1: claim-99"] },
          createdAt: new Date().toISOString(),
        },
      ],
      inputContents: '{"claims": [{"id": "claim-1"}]}',
      violations: ["cited claims not in stage 1: claim-99"],
    });

    expect(prompt).toContain("## Previous attempt was rejected");
    expect(prompt).toContain("cited claims not in stage 1: claim-99");
    expect(prompt).toContain("Stage 'summary' attempt 1 held: cited claims not in stage 1: claim-99");
  });
});
