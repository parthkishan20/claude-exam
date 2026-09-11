/**
 * Handler-level tests (Wave 1, Agent A). These exercise the four tool handlers
 * DIRECTLY — no hook, no dispatcher, no model. Anything to do with the $500
 * refund threshold belongs to the hook layer and is deliberately not asserted
 * here beyond confirming this layer does NOT enforce it.
 *
 * Run: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkOrderStatus } from "../lib/tools/checkOrderStatus";
import { issueRefund } from "../lib/tools/issueRefund";
import { issueStoreCredit } from "../lib/tools/issueStoreCredit";
import { escalateToHuman } from "../lib/tools/escalateToHuman";
import { HANDLERS } from "../lib/tools/index";
import { getSession, resetSession, remainingRefundable } from "../lib/store/db";
import { LIMITS } from "../lib/config";
import type { HandlerContext, ToolFailure, ToolResultEnvelope } from "../lib/types";

const SESSION = "test-session";

function ctx(): HandlerContext {
  resetSession(SESSION);
  return { sessionId: SESSION, emit: () => {} };
}

function failure(env: ToolResultEnvelope): ToolFailure {
  assert.equal(env.success, false, `expected failure, got ${JSON.stringify(env)}`);
  return env as ToolFailure;
}

function success(env: ToolResultEnvelope): Record<string, unknown> {
  assert.equal(env.success, true, `expected success, got ${JSON.stringify(env)}`);
  return env as unknown as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * check_order_status
 * ------------------------------------------------------------------ */

test("check_order_status returns the full success payload", async () => {
  const c = ctx();
  const res = success(await checkOrderStatus({ order_id: "ORD-1234" }, c));
  assert.deepEqual(Object.keys(res).sort(), [
    "amount_paid",
    "currency",
    "item_description",
    "non_refundable",
    "order_id",
    "purchase_date",
    "refund_eligible",
    "refund_window_days_remaining",
    "remaining_refundable",
    "status",
    "success",
  ]);
  assert.equal(res.order_id, "ORD-1234");
  assert.equal(res.amount_paid, 120);
  assert.equal(res.refund_eligible, true);
  assert.equal(res.remaining_refundable, 120);
});

test("check_order_status reports remaining_refundable net of prior refunds", async () => {
  const c = ctx();
  const res = success(await checkOrderStatus({ order_id: "ORD-3300" }, c));
  assert.equal(res.amount_paid, 400);
  assert.equal(res.remaining_refundable, 150); // 400 - 250 already refunded
});

test("check_order_status: unknown order is a validation error", async () => {
  const c = ctx();
  const f = failure(await checkOrderStatus({ order_id: "ORD-0000" }, c));
  assert.equal(f.errorCategory, "validation");
  assert.equal(f.isRetryable, false);
  assert.match(f.message, /ORD-0000/);
});

test("check_order_status: malformed order_id never throws", async () => {
  const c = ctx();
  for (const bad of [{}, { order_id: 12 }, { order_id: "nope" }, { order_id: "ORD-12" }, null]) {
    const f = failure(await checkOrderStatus(bad, c));
    assert.equal(f.errorCategory, "validation");
    assert.equal(f.isRetryable, false);
  }
});

test("check_order_status has no side effects", async () => {
  const c = ctx();
  await checkOrderStatus({ order_id: "ORD-1234" }, c);
  const store = getSession(SESSION);
  assert.equal(store.refunds.length, 0);
  assert.equal(store.credits.length, 0);
  assert.equal(store.escalations.length, 0);
  assert.equal(store.seq, 0);
});

/* ------------------------------------------------------------------ *
 * issue_refund — boundary conditions in order
 * ------------------------------------------------------------------ */

test("issue_refund (1): unknown order → validation error", async () => {
  const c = ctx();
  const f = failure(
    await issueRefund({ order_id: "ORD-0000", amount: 10, reason: "damaged" }, c),
  );
  assert.equal(f.errorCategory, "validation");
  assert.match(f.message, /ORD-0000/);
});

test("issue_refund: malformed input → validation error, never throws", async () => {
  const c = ctx();
  const bad: unknown[] = [
    {},
    { order_id: "ORD-1234", reason: "damaged" }, // missing amount
    { order_id: "ORD-1234", amount: "50", reason: "damaged" }, // non-number amount
    { order_id: "ORD-1234", amount: 0, reason: "damaged" }, // not > 0
    { order_id: "ORD-1234", amount: -5, reason: "damaged" },
    { order_id: "ORD-1234", amount: Number.NaN, reason: "damaged" },
    { order_id: "ORD-1234", amount: 50, reason: "because_i_said_so" }, // out of enum
    { order_id: "ORD1234", amount: 50, reason: "damaged" }, // bad pattern
    "not an object",
  ];
  for (const input of bad) {
    const f = failure(await issueRefund(input, c));
    assert.equal(f.errorCategory, "validation");
    assert.equal(f.isRetryable, false);
  }
  assert.equal(getSession(SESSION).refunds.length, 0);
});

test("issue_refund (2): amount over remaining refundable → details {field, max_allowed}", async () => {
  const c = ctx();
  const f = failure(
    await issueRefund({ order_id: "ORD-3300", amount: 400, reason: "damaged" }, c),
  );
  assert.equal(f.errorCategory, "validation");
  assert.equal(f.isRetryable, false);
  assert.deepEqual(f.details, { field: "amount", max_allowed: 150 });
  assert.equal(getSession(SESSION).refunds.length, 0);
});

test("issue_refund: partial refund on ORD-3300 caps at 150", async () => {
  const c = ctx();
  const okRes = success(
    await issueRefund({ order_id: "ORD-3300", amount: 150, reason: "damaged" }, c),
  );
  assert.equal(okRes.amount_refunded, 150);
  const order = getSession(SESSION).orders.get("ORD-3300")!;
  assert.equal(order.refunded_to_date, 400);
  assert.equal(remainingRefundable(order), 0);

  // A second dollar is now over the (zero) balance.
  const f = failure(
    await issueRefund({ order_id: "ORD-3300", amount: 1, reason: "damaged" }, c),
  );
  assert.deepEqual(f.details, { field: "amount", max_allowed: 0 });
});

test("issue_refund (3): outside the refund window → message points at issue_store_credit", async () => {
  const c = ctx();
  const f = failure(
    await issueRefund({ order_id: "ORD-4521", amount: 180, reason: "damaged" }, c),
  );
  assert.equal(f.errorCategory, "validation");
  assert.equal(f.isRetryable, false);
  assert.match(f.message, /issue_store_credit/);
  assert.equal(getSession(SESSION).refunds.length, 0);
});

test("issue_refund (3): non-refundable item → message points at issue_store_credit", async () => {
  const c = ctx();
  const f = failure(
    await issueRefund({ order_id: "ORD-9001", amount: 100, reason: "other" }, c),
  );
  assert.equal(f.errorCategory, "validation");
  assert.match(f.message, /issue_store_credit/);
  assert.match(f.message, /non-refundable/i);
});

test("issue_refund (4): fail_once is transient on attempt 1 and succeeds on attempt 2", async () => {
  const c = ctx();
  const first = failure(
    await issueRefund({ order_id: "ORD-5150", amount: 300, reason: "damaged" }, c),
  );
  assert.equal(first.errorCategory, "transient");
  assert.equal(first.isRetryable, true);
  assert.equal(first.retryAfterMs, 2000);
  assert.equal(getSession(SESSION).refunds.length, 0);
  assert.equal(getSession(SESSION).orders.get("ORD-5150")!.refunded_to_date, 0);

  const second = success(
    await issueRefund({ order_id: "ORD-5150", amount: 300, reason: "damaged" }, c),
  );
  assert.equal(second.status, "processed");
  assert.equal(second.amount_refunded, 300);
  assert.match(String(second.refund_id), /^REF-\d+$/);
  assert.equal(getSession(SESSION).refunds.length, 1);
});

test("issue_refund (4): always_fail never succeeds", async () => {
  const c = ctx();
  for (let i = 0; i < 5; i++) {
    const f = failure(
      await issueRefund({ order_id: "ORD-5151", amount: 300, reason: "damaged" }, c),
    );
    assert.equal(f.errorCategory, "transient");
    assert.equal(f.isRetryable, true);
  }
  assert.equal(getSession(SESSION).refunds.length, 0);
  assert.equal(getSession(SESSION).orders.get("ORD-5151")!.refunded_to_date, 0);
});

test("issue_refund (5): success records a RefundRecord and moves refunded_to_date", async () => {
  const c = ctx();
  const res = success(
    await issueRefund({ order_id: "ORD-1234", amount: 120, reason: "wrong_item" }, c),
  );
  assert.deepEqual(Object.keys(res).sort(), [
    "amount_refunded",
    "estimated_days_to_reflect",
    "order_id",
    "refund_id",
    "status",
    "success",
  ]);
  assert.equal(res.status, "processed");
  assert.ok(typeof res.estimated_days_to_reflect === "number");

  const store = getSession(SESSION);
  assert.equal(store.refunds.length, 1);
  assert.equal(store.refunds[0].refund_id, res.refund_id);
  assert.equal(store.refunds[0].reason, "wrong_item");
  assert.equal(store.orders.get("ORD-1234")!.refunded_to_date, 120);
});

test("issue_refund does NOT enforce the $500 threshold — that is the hook's job", async () => {
  const c = ctx();
  const res = success(
    await issueRefund({ order_id: "ORD-7788", amount: 900, reason: "damaged" }, c),
  );
  assert.equal(res.amount_refunded, 900);
  assert.equal(getSession(SESSION).escalations.length, 0);
  assert.ok(900 > LIMITS.refundEscalationThreshold);
});

/* ------------------------------------------------------------------ *
 * issue_store_credit
 * ------------------------------------------------------------------ */

test("issue_store_credit: unknown order → validation error", async () => {
  const c = ctx();
  const f = failure(
    await issueStoreCredit({ order_id: "ORD-0000", amount: 50, reason: "goodwill" }, c),
  );
  assert.equal(f.errorCategory, "validation");
});

test("issue_store_credit: malformed input → validation error, never throws", async () => {
  const c = ctx();
  for (const bad of [
    {},
    { order_id: "ORD-1234", amount: 50 }, // missing reason
    { order_id: "ORD-1234", amount: "50", reason: "goodwill" },
    { order_id: "ORD-1234", amount: 0, reason: "goodwill" },
    { order_id: "bad", amount: 50, reason: "goodwill" },
    undefined,
  ]) {
    const f = failure(await issueStoreCredit(bad, c));
    assert.equal(f.errorCategory, "validation");
  }
  assert.equal(getSession(SESSION).credits.length, 0);
});

test("issue_store_credit: 2500 on ORD-9001 is REJECTED with no escalation", async () => {
  const c = ctx();
  const f = failure(
    await issueStoreCredit(
      { order_id: "ORD-9001", amount: 2500, reason: "final sale goodwill" },
      c,
    ),
  );
  assert.equal(f.errorCategory, "validation"); // NOT permission
  assert.equal(f.isRetryable, false);
  assert.equal(f.escalation, undefined);
  assert.match(f.message, /cannot be escalated/i);
  assert.equal(f.details?.max_allowed, LIMITS.storeCreditCeiling);
  assert.equal(f.details?.escalatable, false);

  const store = getSession(SESSION);
  assert.equal(store.escalations.length, 0, "credit over ceiling must never escalate");
  assert.equal(store.credits.length, 0);
  assert.equal(store.accounts.get("acct_1003")!.credit_balance, 0);
});

test("issue_store_credit: exactly at the ceiling is allowed", async () => {
  const c = ctx();
  const res = success(
    await issueStoreCredit(
      { order_id: "ORD-9001", amount: LIMITS.storeCreditCeiling, reason: "goodwill" },
      c,
    ),
  );
  assert.equal(res.amount_credited, LIMITS.storeCreditCeiling);
});

test("issue_store_credit: success credits the account and sets a 12-month expiry", async () => {
  const c = ctx();
  const res = success(
    await issueStoreCredit({ order_id: "ORD-4521", amount: 180, reason: "goodwill" }, c),
  );
  assert.deepEqual(Object.keys(res).sort(), [
    "account_id",
    "amount_credited",
    "credit_id",
    "expires_at",
    "new_account_balance",
    "success",
  ]);
  assert.equal(res.account_id, "acct_1002");
  assert.equal(res.new_account_balance, 205); // 25 seeded + 180
  assert.match(String(res.credit_id), /^CRD-\d+$/);

  // ~12 months out (leap-day tolerant).
  const days = (new Date(String(res.expires_at)).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 363 && days < 367, `expiry should be ~12 months out, got ${days} days`);

  const store = getSession(SESSION);
  assert.equal(store.credits.length, 1);
  assert.equal(store.accounts.get("acct_1002")!.credit_balance, 205);
});

/* ------------------------------------------------------------------ *
 * escalate_to_human
 * ------------------------------------------------------------------ */

const ESC_INPUT = {
  order_id: "ORD-7788",
  issue_summary: "Customer wants a $900 refund on a standing desk.",
  requested_action: "Approve and issue the refund.",
  urgency: "medium" as const,
};

test("escalate_to_human: model self-escalation stamps source=model, no blocked_reason", async () => {
  const c = ctx();
  const res = success(await escalateToHuman(ESC_INPUT, c));
  assert.equal(res.status, "queued");
  assert.match(String(res.escalation_id), /^ESC-\d+$/);
  assert.ok(typeof res.assigned_queue === "string" && res.assigned_queue.length > 0);
  assert.ok(typeof res.eta_hours === "number" && res.eta_hours > 0);
  assert.equal(res.blocked_reason, undefined);

  const store = getSession(SESSION);
  assert.equal(store.escalations.length, 1);
  assert.equal(store.escalations[0].source, "model");
  assert.equal(store.escalations[0].blocked_reason, undefined);
  assert.equal(store.escalations[0].escalation_id, res.escalation_id);
});

test("escalate_to_human: hook-driven call stamps source=hook and echoes blocked_reason", async () => {
  const c = ctx();
  const res = success(
    await escalateToHuman(
      { ...ESC_INPUT, blocked_reason: "refund_amount_exceeds_threshold" },
      c,
    ),
  );
  assert.equal(res.blocked_reason, "refund_amount_exceeds_threshold");
  assert.equal(res.assigned_queue, "refund-approvals");
  assert.equal(res.status, "queued");

  const rec = getSession(SESSION).escalations[0];
  assert.equal(rec.source, "hook");
  assert.equal(rec.blocked_reason, "refund_amount_exceeds_threshold");
  assert.equal(rec.assigned_queue, "refund-approvals");
});

test("escalate_to_human: urgency drives eta_hours", async () => {
  const c = ctx();
  const high = success(await escalateToHuman({ ...ESC_INPUT, urgency: "high" }, c));
  const low = success(await escalateToHuman({ ...ESC_INPUT, urgency: "low" }, c));
  assert.ok((high.eta_hours as number) < (low.eta_hours as number));
  assert.equal(getSession(SESSION).escalations.length, 2);
});

test("escalate_to_human: malformed input → validation error, never throws", async () => {
  const c = ctx();
  for (const bad of [
    {},
    { ...ESC_INPUT, urgency: "catastrophic" },
    { ...ESC_INPUT, issue_summary: "" },
    { order_id: "ORD-7788", urgency: "low" },
    42,
  ]) {
    const f = failure(await escalateToHuman(bad, c));
    assert.equal(f.errorCategory, "validation");
  }
  assert.equal(getSession(SESSION).escalations.length, 0);
});

/* ------------------------------------------------------------------ *
 * registry + the universal "never throws" guarantee
 * ------------------------------------------------------------------ */

test("HANDLERS registry wires all four tools", async () => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), [
    "check_order_status",
    "escalate_to_human",
    "issue_refund",
    "issue_store_credit",
  ]);
});

test("no handler ever throws on hostile input", async () => {
  const c = ctx();
  const hostile: unknown[] = [
    undefined,
    null,
    0,
    "",
    [],
    { order_id: { nested: true }, amount: [], reason: {} },
    Object.create(null),
  ];
  for (const [name, handler] of Object.entries(HANDLERS)) {
    for (const input of hostile) {
      const env = await handler(input, c);
      assert.equal(env.success, false, `${name} should reject ${JSON.stringify(input)}`);
      assert.equal((env as ToolFailure).errorCategory, "validation");
    }
  }
});

test("resetSession isolates state between tests", async () => {
  const c = ctx();
  await issueRefund({ order_id: "ORD-1234", amount: 120, reason: "damaged" }, c);
  assert.equal(getSession(SESSION).refunds.length, 1);
  resetSession(SESSION);
  assert.equal(getSession(SESSION).refunds.length, 0);
  assert.equal(getSession(SESSION).orders.get("ORD-1234")!.refunded_to_date, 0);
});
