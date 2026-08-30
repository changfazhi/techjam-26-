/**
 * Stage schema registry.
 * Owned by W4 (Schemas). See docs/BLUEPRINT.md section 5.1.
 */

import { researchSchema } from "./research.js";
import { summarySchema } from "./summary.js";
import { reportSchema } from "./report.js";

export * from "./redaction.js";
export * from "./research.js";
export * from "./summary.js";
export * from "./report.js";

export interface ValidationContext {
  /** stageId -> the parsed artifact admitted for that stage. */
  priorArtifacts: Record<string, unknown>;
  /** Filenames seeded into the first stage's workspace. */
  sourceManifest: string[];
}

export type ValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; violations: string[] };

export interface StageSchema {
  id: string;
  /** Human- and LLM-readable description injected verbatim into the prompt. */
  describe(): string;
  /**
   * Parse and check one raw artifact.
   * INVARIANT 1: never throws. Malformed input returns violations instead.
   * INVARIANT 2: runs the credential scan before its own checks.
   */
  validate(raw: string, context: ValidationContext): ValidationResult;
}

export interface SchemaRegistry {
  get(schemaId: string): StageSchema;
}

export class StaticSchemaRegistry implements SchemaRegistry {
  constructor(private readonly schemas: Map<string, StageSchema> = new Map()) {}

  register(schema: StageSchema): void {
    this.schemas.set(schema.id, schema);
  }

  get(schemaId: string): StageSchema {
    const schema = this.schemas.get(schemaId);
    if (!schema) {
      throw new Error("Unknown stage schema: " + schemaId);
    }
    return schema;
  }
}

/** Populated by W4 with all three stage schemas. */
export function createSchemaRegistry(): StaticSchemaRegistry {
  const registry = new StaticSchemaRegistry();
  registry.register(researchSchema);
  registry.register(summarySchema);
  registry.register(reportSchema);
  return registry;
}