/**
 * The manual streaming agentic loop.
 *
 * WAVE 1 — AGENT C owns this file.
 *
 * Non-negotiable rules:
 *  - append the FULL `message.content` to messages (preserves tool_use blocks)
 *  - return ALL tool_result blocks in ONE user message (splitting them trains
 *    the model out of parallel tool calls)
 *  - set `is_error: true` on every failure envelope
 *  - handle stop_reason "pause_turn" by re-sending
 *  - break at LIMITS.maxLoopIterations
 *  - route every tool_use through dispatch() — never call a handler directly
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Emit } from "./types";

export interface RunAgentOptions {
  sessionId: string;
  messages: Anthropic.MessageParam[];
  emit: Emit;
  signal?: AbortSignal;
}

export interface RunAgentResult {
  messages: Anthropic.MessageParam[];
  finalText: string;
  turns: number;
}

export async function runAgent(_opts: RunAgentOptions): Promise<RunAgentResult> {
  throw new Error("not implemented — Wave 1 Agent C");
}
