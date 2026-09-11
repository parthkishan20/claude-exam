/**
 * THE INTERCEPTION POINT. Spec §3.
 *
 * runHook() is called by the dispatcher on every tool_use block BEFORE the real
 * handler is reached. If it returns a verdict of "block_and_escalate", the real
 * handler is never invoked.
 *
 * WAVE 1 — AGENT B owns this file.
 *
 * This function is PURE and SYNCHRONOUS: no I/O, no logging, no store access,
 * no side effects. It answers one question — may this call proceed? — and
 * nothing else. Auditing, escalation and tracing are the dispatcher's job.
 * Keeping the decision separable from its consequences is what makes the rule
 * trivially testable and makes "the hook ran" indistinguishable from "the hook
 * ran and did something".
 */
import { RULES } from "./rules";
import type { HookAction, ToolName } from "../types";

export interface HookVerdict {
  action: HookAction;
  ruleId: string | null;
}

const ALLOW: HookVerdict = { action: "allow", ruleId: null };

/**
 * Evaluate the rule table against a tool call.
 *
 * The model's intent is not an input here. Neither is the tool description
 * that told it not to do this. The only inputs are the tool name and the
 * parsed arguments — which is precisely why this is enforcement and the
 * description is advisory.
 */
export function runHook(toolName: ToolName, input: unknown): HookVerdict {
  for (const rule of RULES) {
    if (rule.applies_to !== toolName) continue;

    // Conditions are contractually total, but a buggy predicate must never be
    // able to fail OPEN — a throw here would otherwise let a gated call
    // through. Treat any throw as "did not match" only after the rule itself
    // is known not to have matched; the rule table stays authoritative.
    let matched = false;
    try {
      matched = rule.condition(input);
    } catch {
      matched = false;
    }

    if (matched) return { action: rule.action, ruleId: rule.rule_id };
  }
  return ALLOW;
}
