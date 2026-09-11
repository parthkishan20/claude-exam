/**
 * THE INTERCEPTION POINT. Spec §3.
 *
 * runHook() is called by the dispatcher on every tool_use block BEFORE the real
 * handler is reached. If it returns a verdict of "block_and_escalate", the real
 * handler is never invoked.
 *
 * WAVE 1 — AGENT B owns this file.
 */
import type { HookAction, ToolName } from "../types";

export interface HookVerdict {
  action: HookAction;
  ruleId: string | null;
}

export function runHook(_toolName: ToolName, _input: unknown): HookVerdict {
  throw new Error("not implemented — Wave 1 Agent B");
}
