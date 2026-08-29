/**
 * Prompt assembly: instruction + schema description + event digest + violations.
 * Owned by W4 (Schemas). See docs/BLUEPRINT.md section 6.3.
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

/**
 * Builds an LLM-actionable prompt string for the given stage attempt.
 */
export function buildStagePrompt(input: PromptInput): string {
  const { stage, schemaDescription, priorEvents, inputContents, violations } = input;

  const sections: string[] = [];

  // Stage role instruction header
  sections.push(
    `You are acting as the **${stage.role}** for this session.\nFollow the requirements below carefully.`,
  );

  // Required output specification
  sections.push(
    `## Required output\n` +
      `Write your answer to \`${stage.outputPath}\` in this workspace.\n` +
      `It MUST match this schema exactly:\n` +
      `${schemaDescription}\n\n` +
      `If you cannot write the file, output the same content in a single fenced code block in your response.`,
  );

  // Session so far (event digest)
  const digest = formatEventDigest(priorEvents);
  sections.push(`## Session so far\n${digest}`);

  // Input delivered from previous stage
  if (stage.inputFileName && inputContents !== null && inputContents.trim().length > 0) {
    sections.push(
      `## Input (\`${stage.inputFileName}\`)\n` +
        `\`\`\`\n` +
        `${inputContents.trim()}\n` +
        `\`\`\``,
    );
  }

  // Previous attempt rejected (only present on retry)
  if (violations.length > 0) {
    const violationList = violations.map((v) => `- ${v}`).join("\n");
    sections.push(
      `## Previous attempt was rejected\n` +
        `Your previous output for this stage failed validation with the following violations:\n` +
        `${violationList}\n\n` +
        `Please fix these violations in this attempt.`,
    );
  }

  return sections.join("\n\n");
}

/**
 * Formats prior session events into a readable chronological digest for the model.
 */
function formatEventDigest(events: SessionEvent[]): string {
  if (!events || events.length === 0) {
    return "No prior events in this session.";
  }

  return events
    .map((e) => {
      switch (e.type) {
        case "session.started":
          return `- Session started.`;
        case "stage.assigned":
          return `- Stage '${e.stageId}' assigned to agent (attempt ${e.attempt ?? 1}).`;
        case "stage.completed":
          return `- Stage '${e.stageId}' admitted successfully.`;
        case "stage.rejected": {
          const reason = e.payload?.violations?.length
            ? `: ${e.payload.violations.join("; ")}`
            : "";
          return `- Stage '${e.stageId}' attempt ${e.attempt ?? 1} held${reason}`;
        }
        case "stage.timeout":
          return `- Stage '${e.stageId}' attempt ${e.attempt ?? 1} timed out.`;
        case "session.completed":
          return `- Session completed.`;
        default:
          return `- Event: ${e.type}`;
      }
    })
    .join("\n");
}