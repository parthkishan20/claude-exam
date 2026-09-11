/**
 * The rule table. Spec §3.
 *
 * A rule is a programmatic predicate over PARSED tool input. It runs regardless
 * of what the model intended or what any tool description said — that is the
 * entire point of the mechanism.
 *
 * WAVE 1 — AGENT B owns this file.
 *
 * DATA-DRIVEN BY DESIGN: adding a second rule means appending one entry to
 * RULES. The gate iterates the table and the dispatcher reads the matched rule
 * back by id, so neither has a rule name compiled into it.
 */
import { LIMITS } from "../config";
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

/* ------------------------------------------------------------------ *
 * Total accessors. Tool input arrives UNVALIDATED — it is whatever the
 * model emitted. A condition that throws on a malformed field would turn a
 * bad-input bug into a crash at the choke point, so every read is total and
 * returns null rather than throwing.
 * ------------------------------------------------------------------ */

function field(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

/**
 * A finite number, or null. Deliberately does NOT coerce strings: `"900"` is
 * malformed input, not a threshold breach. Letting the handler's validation
 * reject it keeps the two concerns separate — the hook decides *permission*,
 * the handler decides *well-formedness*.
 */
export function numericField(input: unknown, key: string): number | null {
  const v = field(input, key);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function stringField(input: unknown, key: string): string | null {
  const v = field(input, key);
  return typeof v === "string" && v.length > 0 ? v : null;
}

/* ------------------------------------------------------------------ *
 * The table
 * ------------------------------------------------------------------ */

export const RULES: Rule[] = [
  {
    rule_id: "refund_threshold",
    applies_to: "issue_refund",
    /**
     * Spec §3: `input.amount > 500`. STRICTLY greater — exactly $500 is
     * auto-approvable, $500.01 is not. The boundary is part of the rule.
     */
    condition: (input) => {
      const amount = numericField(input, "amount");
      return amount !== null && amount > LIMITS.refundEscalationThreshold;
    },
    action: "block_and_escalate",
    blocked_reason: "refund_amount_exceeds_threshold",
    message: (input) => {
      const amount = numericField(input, "amount");
      const requested = amount === null ? "This refund" : `This $${amount} refund`;
      return (
        `Refunds above $${LIMITS.refundEscalationThreshold} require manager approval. ` +
        `${requested} has been automatically routed to a human manager — no further ` +
        `action is needed for this order. Tell the customer it is with a manager for ` +
        `approval and do not attempt another refund or a store credit for it.`
      );
    },
    urgency: "high",
    queue: "refund-approvals",
  },
];

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/** Every rule registered against a tool, in table order. */
export function rulesFor(toolName: ToolName): Rule[] {
  return RULES.filter((r) => r.applies_to === toolName);
}

/** Spec §3's `rules_table.lookup(tool_name)` — the first rule for a tool. */
export function lookupRule(toolName: ToolName): Rule | undefined {
  return RULES.find((r) => r.applies_to === toolName);
}

/**
 * Resolve a rule from a verdict's `ruleId`. The gate returns a plain data
 * verdict (no closures), so the dispatcher rehydrates the rule this way.
 */
export function getRuleById(ruleId: string): Rule | undefined {
  return RULES.find((r) => r.rule_id === ruleId);
}
