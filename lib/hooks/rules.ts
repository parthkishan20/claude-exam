/**
 * The rule table. Spec §3.
 *
 * A rule is a programmatic predicate over PARSED tool input. It runs regardless
 * of what the model intended or what any tool description said — that is the
 * entire point of the mechanism.
 *
 * WAVE 1 — AGENT B owns this file.
 */
import type { ToolName } from "../types";

export interface Rule {
  rule_id: string;
  applies_to: ToolName;
  /** Pure predicate over parsed input. Must not throw on malformed input. */
  condition: (input: unknown) => boolean;
  action: "block_and_escalate";
  /** Stamped onto the escalation as `blocked_reason`. Model can never set this. */
  blocked_reason: string;
  /** Redacted, model-facing explanation. */
  message: (input: unknown) => string;
  urgency: "low" | "medium" | "high";
  queue: string;
}

export const RULES: Rule[] = [];

export function lookupRule(_toolName: ToolName): Rule | undefined {
  throw new Error("not implemented — Wave 1 Agent B");
}
