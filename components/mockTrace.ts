/**
 * Hand-written TraceEvent fixtures — one per preset scenario.
 *
 * The whole UI renders from these arrays with ZERO backend. `mockTrace` is the
 * canonical scenario-2 fixture (the over-threshold block) referenced by
 * lib/useAgentStream.ts's "Load sample trace" affordance; `mockTraceFor` is the
 * offline fallback for components/ScenarioRunner.tsx when /api/scenarios 404s.
 *
 * Every event here is a variant of the frozen TraceEvent union in lib/types.ts.
 */
import type {
  EscalationReceipt,
  ToolName,
  ToolResultEnvelope,
  TraceEvent,
} from "@/lib/types";

/* ------------------------------------------------------------------ *
 * envelope builders
 * ------------------------------------------------------------------ */

function okEnv(payload: Record<string, unknown>): ToolResultEnvelope {
  return { success: true, ...payload } as ToolResultEnvelope;
}

function failEnv(
  errorCategory: "transient" | "validation" | "permission",
  message: string,
  opts: {
    details?: Record<string, unknown>;
    retryAfterMs?: number;
    escalation?: EscalationReceipt;
  } = {},
): ToolResultEnvelope {
  return {
    success: false,
    errorCategory,
    isRetryable: errorCategory === "transient",
    message,
    ...(opts.details ? { details: opts.details } : {}),
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
    ...(opts.escalation ? { escalation: opts.escalation } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * event builders
 * ------------------------------------------------------------------ */

function chunk(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out.length ? out : [s];
}

const say = (s: string): TraceEvent[] =>
  chunk(s, 34).map((text) => ({ t: "text_delta", text }));

const think = (s: string): TraceEvent[] =>
  chunk(s, 48).map((text) => ({ t: "thinking_delta", text }));

/** A tool call the hook allows: tool_use → allow verdict → one attempt → result. */
function call(
  id: string,
  name: ToolName,
  input: unknown,
  envelope: ToolResultEnvelope,
  ms = 40,
): TraceEvent[] {
  return [
    { t: "tool_use", id, name, input },
    { t: "hook_verdict", toolUseId: id, ruleId: null, action: "allow" },
    { t: "attempt", toolUseId: id, n: 1, of: 1 },
    { t: "tool_result", toolUseId: id, ok: envelope.success === true, envelope, ms },
  ];
}

/** issue_refund the hook BLOCKS: verdict block_and_escalate → escalation injected
 *  in code → single permission envelope carrying the receipt. */
function blockedRefund(id: string, order_id: string, amount: number): TraceEvent[] {
  const escalation: EscalationReceipt = {
    escalation_id: "ESC-4471",
    status: "queued",
    assigned_queue: "refund-approvals",
    eta_hours: 2,
    blocked_reason: "refund_amount_exceeds_threshold",
  };
  return [
    {
      t: "tool_use",
      id,
      name: "issue_refund",
      input: { order_id, amount, reason: "damaged" },
    },
    {
      t: "hook_verdict",
      toolUseId: id,
      ruleId: "refund_threshold",
      action: "block_and_escalate",
    },
    {
      t: "escalation_injected",
      toolUseId: id,
      escalationId: escalation.escalation_id,
      blockedReason: "refund_amount_exceeds_threshold",
    },
    {
      t: "tool_result",
      toolUseId: id,
      ok: false,
      ms: 6,
      envelope: failEnv(
        "permission",
        `Refunds above $500 require manager approval. This $${amount} refund has been ` +
          `automatically routed to a human manager — no further action is needed for this order.`,
        { details: { threshold: 500, requested_amount: amount }, escalation },
      ),
    },
  ];
}

/* ------------------------------------------------------------------ *
 * scenarios
 * ------------------------------------------------------------------ */

function scenario1(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "Customer wants a $120 refund on ORD-1234, reason damaged. Verify the order is " +
        "eligible first, then issue the cash refund. $120 is well under the $500 gate.",
    ),
    ...say("Let me pull up ORD-1234 to confirm it's eligible."),
    ...call(
      "ck1",
      "check_order_status",
      { order_id: "ORD-1234" },
      okEnv({
        order_id: "ORD-1234",
        status: "delivered",
        item_description: "Ceramic pour-over coffee dripper",
        amount_paid: 120,
        currency: "USD",
        purchase_date: "2026-08-31",
        refund_eligible: true,
        refund_window_days_remaining: 20,
        remaining_refundable: 120,
        non_refundable: false,
      }),
      36,
    ),
    ...say("Confirmed — it's within the refund window. Processing your $120 refund now."),
    ...call(
      "rf1",
      "issue_refund",
      { order_id: "ORD-1234", amount: 120, reason: "damaged" },
      okEnv({
        refund_id: "REF-8801",
        order_id: "ORD-1234",
        amount_refunded: 120,
        status: "processed",
        estimated_days_to_reflect: 5,
      }),
      52,
    ),
    ...say(
      "Your $120 refund is processed and should reflect on your original payment method " +
        "within about 5 days. Sorry the dripper arrived damaged!",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 940, output: 210 } },
    { t: "done" },
  ];
}

function scenario2(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "The customer wants a $900 refund on ORD-7788 for a broken item. Verify the order, " +
        "then issue the refund. $900 is over the $500 threshold, so the hook will gate this.",
    ),
    ...say("Let me pull up ORD-7788 to confirm the details."),
    ...call(
      "ck2",
      "check_order_status",
      { order_id: "ORD-7788" },
      okEnv({
        order_id: "ORD-7788",
        status: "delivered",
        item_description: 'Standing desk, 60" walnut',
        amount_paid: 900,
        currency: "USD",
        purchase_date: "2026-08-23",
        refund_eligible: true,
        refund_window_days_remaining: 12,
        remaining_refundable: 900,
        non_refundable: false,
      }),
      44,
    ),
    ...say(
      "The order is confirmed and within its refund window. Requesting the full $900 refund now.",
    ),
    ...blockedRefund("rf2", "ORD-7788", 900),
    ...say(
      "This refund is above the $500 limit that can be auto-approved, so it's been routed " +
        "to a human manager for approval. You don't need to do anything else — the approvals " +
        "queue has about a 2-hour response target and someone will follow up about the broken desk.",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 1420, output: 340 } },
    { t: "done" },
  ];
}

function scenario3(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "They want a refund on ORD-4521 with no amount given. Check the order — if it's " +
        "outside the window a cash refund will fail and I should offer store credit.",
    ),
    ...say("Checking ORD-4521 now."),
    ...call(
      "ck3",
      "check_order_status",
      { order_id: "ORD-4521" },
      okEnv({
        order_id: "ORD-4521",
        status: "delivered",
        item_description: "Merino wool blanket",
        amount_paid: 180,
        currency: "USD",
        purchase_date: "2026-06-06",
        refund_eligible: false,
        refund_window_days_remaining: 0,
        remaining_refundable: 180,
        non_refundable: false,
      }),
      39,
    ),
    ...say("This order is past its refund window. Let me confirm the policy by attempting the refund."),
    ...call(
      "rf3",
      "issue_refund",
      { order_id: "ORD-4521", amount: 180, reason: "not_as_described" },
      failEnv(
        "validation",
        "Order ORD-4521 is outside its refund-eligibility window (0 days remaining), so a cash " +
          "refund cannot be issued. Use issue_store_credit instead if a goodwill gesture is appropriate.",
        { details: { field: "order_id", suggested_tool: "issue_store_credit" } },
      ),
      21,
    ),
    ...say("A cash refund isn't available on this order, but I can offer store credit instead."),
    ...call(
      "sc3",
      "issue_store_credit",
      { order_id: "ORD-4521", amount: 180, reason: "goodwill — outside refund window" },
      okEnv({
        credit_id: "CRD-3310",
        account_id: "acct_1002",
        amount_credited: 180,
        new_account_balance: 180,
        expires_at: "2027-09-10",
      }),
      46,
    ),
    ...say(
      "I've added $180 in store credit to your account — it's available immediately and valid for a year.",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 1260, output: 380 } },
    { t: "done" },
  ];
}

function scenario4(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "They want $2500 store credit for ORD-9001. The store-credit ceiling is $2000 and there " +
        "is NO approval path for credit, so anything above it is simply rejected — this must NOT be escalated.",
    ),
    ...say("Let me look at ORD-9001."),
    ...call(
      "ck4",
      "check_order_status",
      { order_id: "ORD-9001" },
      okEnv({
        order_id: "ORD-9001",
        status: "delivered",
        item_description: "Bespoke framed print (final sale)",
        amount_paid: 2500,
        currency: "USD",
        purchase_date: "2026-08-01",
        refund_eligible: false,
        refund_window_days_remaining: 0,
        remaining_refundable: 2500,
        non_refundable: true,
      }),
      40,
    ),
    ...say("Issuing the store credit now."),
    ...call(
      "sc4",
      "issue_store_credit",
      { order_id: "ORD-9001", amount: 2500, reason: "customer request" },
      failEnv(
        "validation",
        "Store credit is capped at $2000 per order (a hard system ceiling). The requested $2500 " +
          "exceeds it and cannot be issued — there is no manager-approval path for store credit above the ceiling.",
        { details: { field: "amount", max_allowed: 2000 } },
      ),
      11,
    ),
    ...say(
      "I can't issue $2500 in store credit — our per-order limit is $2000, and unlike a cash " +
        "refund there's no approval path above that. I can issue $2000 now, or connect you with a manager.",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 1100, output: 300 } },
    { t: "done" },
  ];
}

function scenario5(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "The customer wants their money back for ORD-7788. 'Money back' means a cash refund — " +
        "issue_refund, not store credit, even though the amount will trip the escalation threshold.",
    ),
    ...say("Checking ORD-7788 so I can process your refund."),
    ...call(
      "ck5",
      "check_order_status",
      { order_id: "ORD-7788" },
      okEnv({
        order_id: "ORD-7788",
        status: "delivered",
        item_description: 'Standing desk, 60" walnut',
        amount_paid: 900,
        currency: "USD",
        purchase_date: "2026-08-23",
        refund_eligible: true,
        refund_window_days_remaining: 12,
        remaining_refundable: 900,
        non_refundable: false,
      }),
      43,
    ),
    ...say("You paid $900, so I'll request a full $900 refund to your original payment method."),
    ...blockedRefund("rf5", "ORD-7788", 900),
    ...say(
      "Because you asked for money back rather than store credit, this goes through the refund " +
        "path — and a $900 refund is over the auto-approval limit, so it's now with a manager for approval.",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 1380, output: 330 } },
    { t: "done" },
  ];
}

function scenario6(): TraceEvent[] {
  const t2 = "rf6";
  return [
    { t: "turn_start", turn: 1 },
    ...think(
      "$300 refund on ORD-5150, wrong item. Under the $500 gate. Verify then refund; the gateway may be flaky.",
    ),
    ...say("Checking ORD-5150."),
    ...call(
      "ck6",
      "check_order_status",
      { order_id: "ORD-5150" },
      okEnv({
        order_id: "ORD-5150",
        status: "delivered",
        item_description: "Mechanical keyboard, tactile switches",
        amount_paid: 300,
        currency: "USD",
        purchase_date: "2026-09-05",
        refund_eligible: true,
        refund_window_days_remaining: 25,
        remaining_refundable: 300,
        non_refundable: false,
      }),
      37,
    ),
    ...say("Eligible. Processing the $300 refund."),
    {
      t: "tool_use",
      id: t2,
      name: "issue_refund",
      input: { order_id: "ORD-5150", amount: 300, reason: "wrong_item" },
    },
    { t: "hook_verdict", toolUseId: t2, ruleId: null, action: "allow" },
    { t: "attempt", toolUseId: t2, n: 1, of: 2 },
    {
      t: "tool_result",
      toolUseId: t2,
      ok: false,
      ms: 2011,
      envelope: failEnv(
        "transient",
        "Payment gateway timed out processing the refund. Retrying shortly.",
        { retryAfterMs: 2000, details: { order_id: "ORD-5150", attempt: 1 } },
      ),
    },
    { t: "attempt", toolUseId: t2, n: 2, of: 2, retryAfterMs: 2000 },
    {
      t: "tool_result",
      toolUseId: t2,
      ok: true,
      ms: 58,
      envelope: okEnv({
        refund_id: "REF-5150",
        order_id: "ORD-5150",
        amount_refunded: 300,
        status: "processed",
        estimated_days_to_reflect: 5,
      }),
    },
    ...say(
      "The gateway timed out once, but the automatic retry went through. Your $300 refund is " +
        "processed and should reflect in about 5 days.",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 1180, output: 300 } },
    { t: "done" },
  ];
}

function scenario7(): TraceEvent[] {
  return [
    { t: "turn_start", turn: 1 },
    ...think("ORD-0000 — check it exists before doing anything else."),
    ...say("Looking up ORD-0000."),
    ...call(
      "ck7",
      "check_order_status",
      { order_id: "ORD-0000" },
      failEnv(
        "validation",
        "No order found with id ORD-0000. Ask the customer to confirm the order number.",
        { details: { field: "order_id", order_id: "ORD-0000" } },
      ),
      9,
    ),
    ...say(
      "I couldn't find an order with the number ORD-0000. Could you double-check it — order " +
        "numbers look like ORD-1234?",
    ),
    { t: "turn_end", stopReason: "end_turn", usage: { input: 720, output: 150 } },
    { t: "done" },
  ];
}

/* ------------------------------------------------------------------ *
 * exports
 * ------------------------------------------------------------------ */

export function mockTraceFor(scenarioId: string): TraceEvent[] {
  switch (scenarioId) {
    case "happy-refund":
      return scenario1();
    case "over-threshold":
      return scenario2();
    case "outside-window":
      return scenario3();
    case "store-credit-ceiling":
      return scenario4();
    case "money-back-big":
      return scenario5();
    case "transient-gateway":
      return scenario6();
    case "unknown-order":
      return scenario7();
    default:
      return scenario2();
  }
}

/** Canonical hand-written trace for scenario 2 — the over-threshold block. */
export const mockTrace: TraceEvent[] = scenario2();
