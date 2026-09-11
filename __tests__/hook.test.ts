/**
 * The business-rule hook and the dispatcher choke point. Spec §2 and §3.
 *
 * These tests never involve a prompt, a system message, or the model. That is
 * the point: enforcement is a programmatic check over (tool_name, parsed_input)
 * and nothing else, so it is testable — and true — without an LLM in the loop.
 */
import test from "node:test";
import assert from "node:assert/strict";

// Backoff waits are real time we do not need to spend proving the loop waited.
process.env.RETRY_SLEEP_SCALE = "0";

import { dispatch, resetRetryGuard, type ToolUseRequest } from "../lib/dispatch";
import { runHook } from "../lib/hooks/gate";
import { lookupRule, getRuleById, RULES } from "../lib/hooks/rules";
import { clearAuditLog, readAuditLog } from "../lib/audit";
import { LIMITS } from "../lib/config";
import { resetSession, type SessionStore } from "../lib/store/db";
import type { HandlerContext, ToolFailure, ToolName, TraceEvent } from "../lib/types";

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let seq = 0;

interface Harness {
  ctx: HandlerContext;
  events: TraceEvent[];
  store: SessionStore;
  sessionId: string;
}

function harness(label: string): Harness {
  const sessionId = `test-${label}-${++seq}`;
  const events: TraceEvent[] = [];
  clearAuditLog(sessionId);
  resetRetryGuard(sessionId);
  return {
    sessionId,
    events,
    store: resetSession(sessionId),
    ctx: { sessionId, emit: (ev) => events.push(ev) },
  };
}

let useSeq = 0;
function call(name: ToolName, input: unknown): ToolUseRequest {
  return { id: `toolu_${++useSeq}`, name, input };
}

function of<T extends TraceEvent["t"]>(
  events: TraceEvent[],
  t: T,
): Extract<TraceEvent, { t: T }>[] {
  return events.filter((e) => e.t === t) as Extract<TraceEvent, { t: T }>[];
}

function asFailure(env: { success: boolean }): ToolFailure {
  assert.equal(env.success, false, "expected a failure envelope");
  return env as ToolFailure;
}

/* ------------------------------------------------------------------ *
 * The rule table
 * ------------------------------------------------------------------ */

test("the rule table matches the spec §3 entry", () => {
  const rule = lookupRule("issue_refund");
  assert.ok(rule, "issue_refund must have a rule");
  assert.equal(rule.rule_id, "refund_threshold");
  assert.equal(rule.applies_to, "issue_refund");
  assert.equal(rule.action, "block_and_escalate");
  assert.equal(rule.blocked_reason, "refund_amount_exceeds_threshold");
  assert.equal(getRuleById("refund_threshold"), rule);
  // No rule gates reads, credits or the escalation itself.
  assert.deepEqual(
    RULES.filter((r) => r.applies_to !== "issue_refund"),
    [],
  );
});

test("the boundary is `>`, not `>=`", () => {
  const t = LIMITS.refundEscalationThreshold; // 500
  assert.equal(runHook("issue_refund", { amount: t + 1 }).action, "block_and_escalate");
  assert.equal(runHook("issue_refund", { amount: t + 0.01 }).action, "block_and_escalate");
  assert.equal(runHook("issue_refund", { amount: t }).action, "allow");
  assert.equal(runHook("issue_refund", { amount: t - 1 }).action, "allow");
  assert.equal(runHook("issue_refund", { amount: t + 1 }).ruleId, "refund_threshold");
  assert.equal(runHook("issue_refund", { amount: t }).ruleId, null);
});

test("malformed input never throws, and is never a threshold breach", () => {
  const malformed: unknown[] = [
    undefined,
    null,
    "not an object",
    42,
    [],
    {},
    { amount: "900" }, // a string is bad input, not a breach — the handler's job
    { amount: null },
    { amount: NaN },
    { amount: Infinity },
    { amount: { value: 900 } },
    Object.create(null),
  ];
  for (const input of malformed) {
    assert.doesNotThrow(() => runHook("issue_refund", input));
    assert.equal(
      runHook("issue_refund", input).action,
      "allow",
      `malformed input must fall through to the handler: ${JSON.stringify(input)}`,
    );
  }
});

test("runHook is pure — same input, same verdict, no side effects", () => {
  const before = readAuditLog().length;
  const input = { order_id: "ORD-7788", amount: 900, reason: "damaged" };
  const a = runHook("issue_refund", input);
  const b = runHook("issue_refund", input);
  assert.deepEqual(a, b);
  assert.equal(readAuditLog().length, before, "the gate must not write audit events");
});

/* ------------------------------------------------------------------ *
 * ENFORCEMENT IS REAL — no prompt was involved
 * ------------------------------------------------------------------ */

test("a $900 refund the model 'intended' to succeed is blocked anyway", async () => {
  const h = harness("enforcement");

  // This is the whole argument. There is no system prompt here, no tool
  // description, no model. A tool_use block that a model emitted in perfect
  // good faith goes into the choke point and is refused by code.
  const envelope = await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 900, reason: "damaged" }),
    h.ctx,
  );

  const fail = asFailure(envelope);
  assert.equal(fail.errorCategory, "permission");
  assert.equal(fail.isRetryable, false);
  assert.equal(h.store.refunds.length, 0, "no money may move on a blocked call");

  const verdicts = of(h.events, "hook_verdict");
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0].action, "block_and_escalate");
  assert.equal(verdicts[0].ruleId, "refund_threshold");
  assert.equal(of(h.events, "attempt").length, 0, "the handler was never attempted");
});

/* ------------------------------------------------------------------ *
 * The blocked path, end to end
 * ------------------------------------------------------------------ */

test("$501 blocks and $500 does not, through the real dispatcher", async () => {
  const over = harness("over");
  const overEnv = await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 501, reason: "damaged" }),
    over.ctx,
  );
  assert.equal(asFailure(overEnv).errorCategory, "permission");
  assert.equal(over.store.refunds.length, 0);

  const at = harness("at");
  const atEnv = await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 500, reason: "damaged" }),
    at.ctx,
  );
  assert.equal(of(at.events, "hook_verdict")[0].action, "allow");
  assert.equal(atEnv.success, true, "exactly $500 is auto-approvable");
  assert.equal(at.store.refunds.length, 1, "the handler ran and moved money");
  assert.equal(at.store.refunds[0].amount_refunded, 500);
  assert.equal(at.store.escalations.length, 0, "an allowed call escalates nothing");
});

test("a blocked call never reaches the handler", async () => {
  const h = harness("no-handler");
  await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 900, reason: "damaged" }),
    h.ctx,
  );
  assert.equal(h.store.refunds.length, 0);
  assert.equal(h.store.orders.get("ORD-7788")!.refunded_to_date, 0);
});

test("the envelope carries an escalation receipt with blocked_reason set", async () => {
  const h = harness("receipt");
  const envelope = await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 900, reason: "damaged" }),
    h.ctx,
  );

  const fail = asFailure(envelope);
  assert.ok(fail.escalation, "the escalation already happened — this is its receipt");
  assert.equal(fail.escalation.blocked_reason, "refund_amount_exceeds_threshold");
  assert.equal(fail.escalation.status, "queued");
  assert.ok(fail.escalation.escalation_id.length > 0);
  assert.equal(typeof fail.escalation.eta_hours, "number");
  assert.deepEqual(fail.details?.threshold, LIMITS.refundEscalationThreshold);
  assert.deepEqual(fail.details?.requested_amount, 900);
  assert.deepEqual(fail.details?.rule_id, "refund_threshold");

  // The escalation is a real, recorded side effect — not a suggestion.
  assert.equal(h.store.escalations.length, 1);
  assert.equal(h.store.escalations[0].blocked_reason, "refund_amount_exceeds_threshold");
  assert.equal(h.store.escalations[0].escalation_id, fail.escalation.escalation_id);
});

test("the blocked path emits every trace event the UI and evals read", async () => {
  const h = harness("trace");
  const req = call("issue_refund", { order_id: "ORD-7788", amount: 900, reason: "damaged" });
  await dispatch(req, h.ctx);

  // Note what is NOT here: a second `tool_use` event for the escalation. The
  // dispatcher ran escalate_to_human in code, and the model emitted no such
  // block — inventing a tool_use for it would misreport provenance to the UI
  // and to the evals. `escalation_injected` is the event that says "the system
  // did this", and it is deliberately a different shape.
  const kinds = h.events.map((e) => e.t);
  assert.deepEqual(kinds, [
    "tool_use",
    "hook_verdict",
    "escalation_injected",
    "tool_result",
  ]);
  assert.equal(of(h.events, "tool_use").length, 1);

  const injected = of(h.events, "escalation_injected")[0];
  assert.equal(injected.toolUseId, req.id, "correlates to the BLOCKED tool_use_id");
  assert.equal(injected.blockedReason, "refund_amount_exceeds_threshold");
  assert.ok(injected.escalationId);

  const result = of(h.events, "tool_result").at(-1)!;
  assert.equal(result.toolUseId, req.id);
  assert.equal(result.ok, false);
  assert.equal(typeof result.ms, "number");
});

test("an audit event is written with the full unredacted input", async () => {
  const h = harness("audit");
  const input = { order_id: "ORD-7788", amount: 900, reason: "damaged" };
  const envelope = await dispatch(call("issue_refund", input), h.ctx);

  const log = readAuditLog(h.sessionId);
  assert.equal(log.length, 1);
  assert.equal(log[0].ruleId, "refund_threshold");
  assert.equal(log[0].toolName, "issue_refund");
  assert.equal(log[0].outcome, "blocked");
  assert.equal(log[0].sessionId, h.sessionId);
  assert.deepEqual(log[0].input, input, "internal side of the boundary: raw input");
  assert.ok(Date.parse(log[0].at) > 0);
  assert.equal(log[0].escalationId, asFailure(envelope).escalation!.escalation_id);

  // The redaction boundary: nothing internal leaks into the model-facing side.
  const modelFacing = JSON.stringify(envelope);
  assert.ok(!modelFacing.includes(h.sessionId), "session id must not reach the model");
  assert.ok(!modelFacing.includes(log[0].at), "audit timestamp must not reach the model");

  // An allowed call writes nothing — the log records rule triggers only.
  const clean = harness("audit-allow");
  await dispatch(call("check_order_status", { order_id: "ORD-1234" }), clean.ctx);
  assert.equal(readAuditLog(clean.sessionId).length, 0);
});

/* ------------------------------------------------------------------ *
 * THE ASYMMETRY: block (approval path exists) vs reject (none does)
 * ------------------------------------------------------------------ */

test("issue_store_credit at 2500 is NOT hook-blocked — it is rejected by the handler", async () => {
  const h = harness("asymmetry");
  const envelope = await dispatch(
    call("issue_store_credit", {
      order_id: "ORD-9001",
      amount: 2500,
      reason: "final sale goodwill",
    }),
    h.ctx,
  );

  // The hook let it through: no cash leaves the business, so no rule applies.
  const verdict = of(h.events, "hook_verdict")[0];
  assert.equal(verdict.action, "allow");
  assert.equal(verdict.ruleId, null);
  assert.equal(of(h.events, "attempt").length, 1, "it reached the handler");

  // The handler rejected it: above the ceiling there is no approval path at all.
  const fail = asFailure(envelope);
  assert.equal(fail.errorCategory, "validation", "rejected, not blocked");
  assert.equal(fail.isRetryable, false);
  assert.equal(fail.escalation, undefined, "a ceiling breach is never escalated");
  assert.equal(h.store.credits.length, 0);
  assert.equal(h.store.escalations.length, 0);
  assert.equal(readAuditLog(h.sessionId).length, 0, "no rule fired, so nothing to audit");

  // Same shape, same amount, the other tool: blocked and escalated instead.
  const cash = harness("asymmetry-cash");
  const refund = await dispatch(
    call("issue_refund", { order_id: "ORD-7788", amount: 900, reason: "damaged" }),
    cash.ctx,
  );
  assert.equal(asFailure(refund).errorCategory, "permission");
  assert.equal(cash.store.escalations.length, 1);
});

/* ------------------------------------------------------------------ *
 * Retry policy — spec §2
 * ------------------------------------------------------------------ */

test("fail_once: exactly 2 attempts in system mode, 1 in agent mode", async () => {
  const sys = harness("retry-system");
  const sysEnv = await dispatch(
    call("issue_refund", { order_id: "ORD-5150", amount: 300, reason: "damaged" }),
    sys.ctx,
    { retryMode: "system" },
  );
  const sysAttempts = of(sys.events, "attempt");
  assert.equal(sysAttempts.length, 2, "the dispatcher retried once, itself");
  assert.deepEqual(
    sysAttempts.map((a) => [a.n, a.of]),
    [
      [1, 2],
      [2, 2],
    ],
  );
  assert.equal(sysAttempts[0].retryAfterMs, undefined);
  assert.ok(sysAttempts[1].retryAfterMs, "the retry attempt records the backoff it waited");
  assert.equal(sysEnv.success, true, "attempt 2 succeeded");
  assert.equal(sys.store.refunds.length, 1);

  const agent = harness("retry-agent");
  const agentEnv = await dispatch(
    call("issue_refund", { order_id: "ORD-5150", amount: 300, reason: "damaged" }),
    agent.ctx,
    { retryMode: "agent" },
  );
  assert.equal(of(agent.events, "attempt").length, 1, "agent mode never retries in code");
  const agentFail = asFailure(agentEnv);
  assert.equal(agentFail.errorCategory, "transient");
  assert.equal(agentFail.isRetryable, true, "the model is handed the decision");
  assert.equal(agent.store.refunds.length, 0);
});

test("system mode: an exhausted transient failure comes back non-retryable", async () => {
  const h = harness("exhaust-system");
  const envelope = await dispatch(
    call("issue_refund", { order_id: "ORD-5151", amount: 300, reason: "damaged" }),
    h.ctx,
    { retryMode: "system" },
  );

  assert.equal(of(h.events, "attempt").length, LIMITS.maxTransientAttempts);
  const fail = asFailure(envelope);
  assert.equal(fail.isRetryable, false, "retrying again is pointless — say so in the flag");
  assert.equal(fail.retryAfterMs, undefined, "no wait hint on a call that must not repeat");
  assert.equal(fail.details?.retry_exhausted, true);
  assert.equal(fail.details?.max_attempts, LIMITS.maxTransientAttempts);
  assert.match(fail.message, /not succeed|must not be attempted again/i);
  assert.equal(h.store.refunds.length, 0);
});

test("agent mode: the loop guard caps identical (tool, input) calls", async () => {
  const h = harness("loop-guard");
  const input = { order_id: "ORD-5151", amount: 300, reason: "damaged" };
  const run = () => dispatch(call("issue_refund", input), h.ctx, { retryMode: "agent" });

  const first = asFailure(await run());
  assert.equal(first.isRetryable, true, "attempt 1 of 2 — the model may try again");

  const second = asFailure(await run());
  assert.equal(second.isRetryable, false, "budget spent");
  assert.equal(second.details?.retry_exhausted, true);

  const before = h.events.length;
  const third = asFailure(await run());
  assert.equal(third.isRetryable, false);
  assert.equal(third.details?.retry_exhausted, true);
  assert.equal(
    of(h.events.slice(before), "attempt").length,
    0,
    "a refused call must not touch the handler at all",
  );

  assert.equal(
    of(h.events, "attempt").length,
    LIMITS.maxTransientAttempts,
    "the handler ran exactly maxTransientAttempts times across the whole session",
  );

  // A different input is a different call and gets its own budget.
  const other = await dispatch(
    call("issue_refund", { ...input, amount: 299 }),
    h.ctx,
    { retryMode: "agent" },
  );
  assert.equal(asFailure(other).isRetryable, true);
});

test("a non-transient failure never consumes the retry budget", async () => {
  const h = harness("no-burn");
  const bad = call("issue_refund", { order_id: "ORD-0000", amount: 50, reason: "damaged" });
  for (let i = 0; i < 3; i++) {
    const envelope = await dispatch({ ...bad, id: `${bad.id}-${i}` }, h.ctx);
    const fail = asFailure(envelope);
    assert.equal(fail.errorCategory, "validation", "unknown order is a validation error");
    assert.equal(fail.details?.retry_exhausted, undefined);
  }
  assert.equal(of(h.events, "attempt").length, 3, "the guard never fired");
});

test("read-only and escalation tools are never gated", async () => {
  const h = harness("ungated");
  const status = await dispatch(call("check_order_status", { order_id: "ORD-7788" }), h.ctx);
  assert.equal(status.success, true);

  const esc = await dispatch(
    call("escalate_to_human", {
      order_id: "ORD-7788",
      issue_summary: "customer wants a manager",
      requested_action: "call back",
      urgency: "low",
    }),
    h.ctx,
  );
  assert.equal(esc.success, true);
  assert.deepEqual(
    of(h.events, "hook_verdict").map((v) => v.action),
    ["allow", "allow"],
  );
  assert.equal(readAuditLog(h.sessionId).length, 0);
});
