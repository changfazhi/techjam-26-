/**
 * Deterministic AgentRunner for development and tests.
 * Owned by W5 (Runtime & UI).
 *
 * Selected with RUNTIME_PROVIDER=mock. Needs no container engine and no Ark key,
 * which turns a 90-second feedback loop into a sub-second one. W5 extends this
 * with misbehaviour modes (wrong citation, no file written, hang) as the
 * coordinator tests need them.
 */

import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

export interface MockRunnerOptions {
  /** Artificial latency per turn, in milliseconds. */
  delayMs?: number | undefined;
  /** Overrides the canned reply. Receives the request, returns the agent message. */
  reply?: ((request: RunnerRequest) => string) | undefined;
}

export class MockRunner implements AgentRunner {
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: MockRunnerOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(agentId: string): Promise<boolean> {
    this.cancelled.add(agentId);
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const delay = this.options.delayMs ?? 50;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const reply = this.options.reply
      ? this.options.reply(request)
      : "mock runner acknowledged: " + request.prompt.slice(0, 120);
    return {
      output: reply,
      threadId: request.threadId ?? "mock-thread-" + request.agentId,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
