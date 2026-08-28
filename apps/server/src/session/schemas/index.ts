/**
 * Stage schema registry.
 * Owned by W4 (Schemas). See docs/BLUEPRINT.md section 5.1.
 *
 * STUB — signatures are frozen; implementations belong to W4.
 */

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

/** Populated by W4 as the three stage schemas land. */
export function createSchemaRegistry(): StaticSchemaRegistry {
  return new StaticSchemaRegistry();
}
