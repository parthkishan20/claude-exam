/**
 * Handler for `escalate_to_human`. See docs/refund-agent-spec.md §1.
 *
 * Contract: NEVER throws. Validates its own input and returns a `validation`
 * envelope on bad input, so every failure reaches the model as tool_result
 * content it can reason over (spec §2).
 *
 * WAVE 1 — AGENT A owns this file.
 */
import type { HandlerContext, ToolResultEnvelope } from "../types";

export async function escalateToHuman(
  _input: unknown,
  _ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  throw new Error("not implemented — Wave 1 Agent A");
}
