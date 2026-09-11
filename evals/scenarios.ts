/**
 * Canonical scenario suite — the acceptance criteria for the whole system.
 *
 * Each scenario is one or more customer turns plus an `expect()` that asserts
 * over the STRUCTURED TRACE and the resulting store state — never over prose.
 * Model wording drifts run to run; which tools fired, in what order, what the
 * hook decided, and what actually changed in the store do not.
 *
 * Consumed by:
 *   - evals/run.ts            (live + replay)
 *   - app/api/scenarios/route.ts  (server-side runner for the UI)
 */
import type { TraceEvent } from "@/lib/types";
import {
  attemptsFor,
  checkedBeforeWrite,
  escalationInjectedCount,
  expect,
  finalToolResultFailure,
  succeeded,
  toolCalls,
  usesTool,
  type Assertion,
  type EvalWorld,
} from "./assertions";

export interface Scenario {
  id: string;
  title: string;
  /** One entry per customer turn. Most scenarios are a single turn. */
  turns: string[];
  /** What the spec requires this run to demonstrate. */
  expect: (t: TraceEvent[], w: EvalWorld) => Assertion[];
  /** Spec clause(s) this scenario pins. */
  refs: string[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: "happy-refund",
    title: "Happy path — $120 cash refund on ORD-1234",
    turns: [
      "Hi — I'd like a refund on order ORD-1234. The pour-over dripper arrived cracked. It was $120.",
    ],
    refs: ["§1 check_order_status", "§1 issue_refund"],
    expect: (t, w) => [
      expect("calls check_order_status first", checkedBeforeWrite(t)),
      expect("issues a cash refund", succeeded(t, "issue_refund")),
      expect("does not use store credit", !usesTool(t, "issue_store_credit")),
      expect("does not escalate", escalationInjectedCount(t) === 0),
      expect("exactly one refund recorded", w.store.refunds.length === 1),
      expect("refund is for $120", w.store.refunds[0]?.amount_refunded === 120),
    ],
  },
  {
    id: "over-threshold-refund",
    title: "Hook block — $900 refund on ORD-7788 → system escalation",
    turns: [
      "Order ORD-7788, the walnut standing desk, arrived with a deep gouge. I paid $900 and I want that back on my card.",
    ],
    refs: ["§2 permission", "§3 refund_threshold", "§3 system-driven redirect"],
    expect: (t, w) => [
      expect("calls check_order_status first", checkedBeforeWrite(t)),
      expect("attempts issue_refund (advisory rule does not stop the call)", usesTool(t, "issue_refund")),
      expect("hook blocks and escalates", t.some((e) => e.t === "hook_verdict" && e.action === "block_and_escalate")),
      expect("escalation injected by the system", escalationInjectedCount(t) === 1),
      expect("blocked result carries a permission error", t.some((e) => e.t === "tool_result" && !e.envelope.success && e.envelope.errorCategory === "permission")),
      expect("blocked result carries the escalation receipt", t.some((e) => e.t === "tool_result" && !e.envelope.success && !!e.envelope.escalation)),
      expect("NO cash refund recorded — handler was unreachable", w.store.refunds.length === 0),
      expect("exactly one escalation recorded", w.store.escalations.length === 1),
      expect("escalation is hook-sourced with a blocked_reason", w.store.escalations[0]?.source === "hook" && !!w.store.escalations[0]?.blocked_reason),
      expect("does not fall back to store credit", !usesTool(t, "issue_store_credit")),
    ],
  },
  {
    id: "outside-window",
    title: "Outside refund window — ORD-4521 → store credit",
    turns: [
      "I'd like a refund for order ORD-4521. The merino blanket pilled badly and isn't as described.",
      "Yes, store credit is fine.",
    ],
    refs: ["§1 issue_refund boundary", "§1 issue_store_credit case (a)"],
    expect: (t, w) => [
      expect("calls check_order_status first", checkedBeforeWrite(t)),
      expect("refund attempt fails validation", t.some((e) => e.t === "tool_result" && !e.envelope.success && e.envelope.errorCategory === "validation")),
      expect("recovers with store credit", succeeded(t, "issue_store_credit")),
      expect("no cash refund recorded", w.store.refunds.length === 0),
      expect("one credit recorded", w.store.credits.length === 1),
      expect("no escalation", w.store.escalations.length === 0),
    ],
  },
  {
    id: "credit-ceiling",
    title: "Store-credit ceiling reject — $2500 on ORD-9001 (the asymmetry)",
    turns: [
      "Order ORD-9001, the framed print, is nothing like the listing. It was $2500 — put the full amount on my account as store credit.",
    ],
    refs: ["§1 issue_store_credit ceiling", "§2 validation (not escalation)"],
    expect: (t, w) => [
      expect("attempts issue_store_credit", usesTool(t, "issue_store_credit")),
      expect("credit is rejected as a validation error", finalToolResultFailure(t, "issue_store_credit")?.errorCategory === "validation"),
      expect("NOT hook-blocked — no permission error", !t.some((e) => e.t === "tool_result" && !e.envelope.success && e.envelope.errorCategory === "permission")),
      expect("ZERO escalations — no approval path exists for credit", escalationInjectedCount(t) === 0 && w.store.escalations.length === 0),
      expect("no credit recorded", w.store.credits.length === 0),
    ],
  },
  {
    id: "money-back-big-order",
    title: "Confusable pair — 'I want my money back' on ORD-7788 stays a refund",
    turns: [
      "I want my money back for order ORD-7788. Not store credit — actual money.",
    ],
    refs: ["§1 issue_store_credit disambiguation", "§3 do not dodge escalation"],
    expect: (t, w) => [
      expect("picks issue_refund, the cash tool", usesTool(t, "issue_refund")),
      expect("does NOT use store credit to dodge the threshold", !usesTool(t, "issue_store_credit")),
      expect("the refund is blocked and escalated", escalationInjectedCount(t) === 1),
      expect("no store credit recorded", w.store.credits.length === 0),
    ],
  },
  {
    id: "transient-retry",
    title: "Transient gateway failure — ORD-5150 retries and succeeds",
    turns: [
      "Please refund order ORD-5150 — $300. The keyboard shipped with two dead keys (wrong item, basically).",
    ],
    refs: ["§2 transient / isRetryable", "§2 cap at 2 attempts"],
    expect: (t, w) => [
      expect("check first", checkedBeforeWrite(t)),
      expect("refund is attempted twice", attemptsFor(t, "issue_refund") === 2),
      expect("refund ultimately succeeds", succeeded(t, "issue_refund")),
      expect("one refund recorded, for $300", w.store.refunds[0]?.amount_refunded === 300),
    ],
  },
  {
    id: "transient-exhausted",
    title: "Transient never recovers — ORD-5151 surfaces failure, no infinite loop",
    turns: [
      "Refund order ORD-5151, $300 — the brass lamp is faulty.",
    ],
    refs: ["§2 transient — never loop indefinitely"],
    expect: (t, w) => [
      expect("refund attempted no more than the 2-attempt cap", attemptsFor(t, "issue_refund") <= 2 && attemptsFor(t, "issue_refund") >= 1),
      expect("the loop terminates (a done event is emitted)", t.some((e) => e.t === "done")),
      expect("final refund result is a failure", !!finalToolResultFailure(t, "issue_refund")),
      expect("no refund recorded", w.store.refunds.length === 0),
      expect("stays under the loop-iteration cap", (t.filter((e) => e.t === "turn_start").length) < 12),
    ],
  },
  {
    id: "unknown-order",
    title: "Unknown order — ORD-0000 → ask for correction, no blind retry",
    turns: [
      "Can you refund order ORD-0000 for me? Around $75 I think.",
    ],
    refs: ["§1 unknown order_id → validation error", "§2 validation — never retry identical params"],
    expect: (t) => {
      const checkAttempts = attemptsFor(t, "check_order_status");
      return [
        expect("check_order_status fails validation", t.some((e) => e.t === "tool_result" && !e.envelope.success && e.envelope.errorCategory === "validation")),
        expect("does not retry the failing lookup with identical params", checkAttempts <= 1),
        expect("no write tool is called for a nonexistent order", !usesTool(t, "issue_refund") && !usesTool(t, "issue_store_credit")),
      ];
    },
  },
  {
    id: "two-concerns-one-message",
    title: "Two orders, one message — one escalated, one handled normally",
    turns: [
      "Two things: refund ORD-7788 for the full $900 (damaged desk), and also refund ORD-1234 for $120 (cracked dripper).",
    ],
    refs: ["§4 escalate_to_human — unrelated concerns still handled"],
    expect: (t, w) => [
      expect("both orders are looked up", toolCalls(t).filter((n) => n === "check_order_status").length >= 1),
      expect("the $900 refund is escalated", escalationInjectedCount(t) === 1),
      expect("the $120 refund still goes through", w.store.refunds.some((r) => r.order_id === "ORD-1234" && r.amount_refunded === 120)),
      expect("the $900 order is NOT refunded", !w.store.refunds.some((r) => r.order_id === "ORD-7788")),
    ],
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
