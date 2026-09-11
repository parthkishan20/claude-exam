/**
 * THE SINGLE CHOKE POINT. Every tool_use block in the system passes through
 * here, and there is no other route from a model request to a side effect.
 *
 *   dispatch = hook gate → (block+escalate) | (retry policy → real handler)
 *
 * WAVE 1 — AGENT B owns this file.
 *
 * CRITICAL — how the system-driven redirect actually works:
 * A system-driven redirect CANNOT fabricate a tool_use block. The assistant
 * turn is whatever the model produced; you cannot append a synthetic assistant
 * message carrying an invented escalate_to_human call (two consecutive
 * assistant turns are invalid, and it would corrupt audit provenance).
 *
 * So when the hook blocks, THIS function calls escalate_to_human itself, in
 * code, and returns ONE envelope for the blocked tool_use_id carrying both the
 * permission error and the escalation receipt. The model never chooses to
 * escalate — it is told the escalation already happened and reports that.
 */
import type { HandlerContext, ToolName, ToolResultEnvelope } from "./types";

export interface ToolUseRequest {
  id: string;
  name: ToolName;
  input: unknown;
}

export async function dispatch(
  _req: ToolUseRequest,
  _ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  throw new Error("not implemented — Wave 1 Agent B");
}
