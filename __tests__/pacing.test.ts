/**
 * Demo pacing — lib/demo/pacing.ts.
 *
 * These tests never touch React. That is the point of keeping the rhythm in a
 * pure module: the thing that decides whether an audience can actually SEE the
 * hook verdict land is arithmetic, and arithmetic can be pinned.
 *
 * What is worth protecting here is not the exact millisecond of any one dwell —
 * those get tuned on stage — but the RELATIONSHIPS: the beats that carry the
 * argument outlast the prose, the timeline only ever moves forward, the scrubber
 * maps back to the event it came from, and a whole act still fits the slot.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { dwellMs, elapsedAt, indexAt, totalMs } from "../lib/demo/pacing";
import type { ToolResultEnvelope, TraceEvent } from "../lib/types";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const okEnv: ToolResultEnvelope = { success: true, order_id: "ORD-7788" };
const failEnv: ToolResultEnvelope = {
  success: false,
  errorCategory: "permission",
  isRetryable: false,
  message: "Refunds above $500 require a human.",
};

/** One of every arm of the TraceEvent union — the exhaustiveness net. */
const EVERY_KIND: TraceEvent[] = [
  { t: "turn_start", turn: 1 },
  { t: "thinking_delta", text: "..." },
  { t: "text_delta", text: "..." },
  { t: "tool_use", id: "t1", name: "issue_refund", input: {} },
  { t: "hook_verdict", toolUseId: "t1", ruleId: null, action: "allow" },
  { t: "hook_verdict", toolUseId: "t1", ruleId: "refund_threshold", action: "block_and_escalate" },
  { t: "attempt", toolUseId: "t1", n: 1, of: 2 },
  { t: "attempt", toolUseId: "t1", n: 2, of: 2, retryAfterMs: 400 },
  { t: "tool_result", toolUseId: "t1", ok: true, envelope: okEnv, ms: 40 },
  { t: "tool_result", toolUseId: "t1", ok: false, envelope: failEnv, ms: 40 },
  { t: "escalation_injected", toolUseId: "t1", escalationId: "ESC-1", blockedReason: "x" },
  { t: "turn_end", stopReason: "end_turn", usage: { input: 10, output: 20 } },
  { t: "done" },
  { t: "error", message: "boom" },
];

/**
 * A realistic act: the over-threshold refund, as it actually streams. Prose
 * arrives from the model API in small chunks, so the delta COUNT — not the
 * structural events — is what dominates a real act's length, and a fixture that
 * hand-waves it with three text_deltas would tell us nothing about the slot.
 */
function streamed(text: string, t: "text_delta" | "thinking_delta"): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (let i = 0; i < text.length; i += 12) out.push({ t, text: text.slice(i, i + 12) });
  return out;
}

function realisticAct(): TraceEvent[] {
  const evs: TraceEvent[] = [];

  // Turn 1 — look the order up before touching anything.
  evs.push({ t: "turn_start", turn: 1 });
  evs.push(
    ...streamed(
      "The customer is asking for a $900 refund on ORD-7788 and says the desk arrived damaged. Before I promise anything I should check the order: status, amount paid, whether it is still inside the refund window, and whether it is flagged non-refundable.",
      "thinking_delta",
    ),
  );
  evs.push(
    ...streamed(
      "I'm sorry the desk turned up gouged — let me pull up ORD-7788 and see what we can do.",
      "text_delta",
    ),
  );
  evs.push({ t: "tool_use", id: "t1", name: "check_order_status", input: { order_id: "ORD-7788" } });
  evs.push({ t: "hook_verdict", toolUseId: "t1", ruleId: null, action: "allow" });
  evs.push({ t: "attempt", toolUseId: "t1", n: 1, of: 1 });
  evs.push({ t: "tool_result", toolUseId: "t1", ok: true, envelope: okEnv, ms: 38 });
  evs.push({ t: "turn_end", stopReason: "tool_use", usage: { input: 1800, output: 210 } });

  // Turn 2 — the refund the hook refuses.
  evs.push({ t: "turn_start", turn: 2 });
  evs.push(
    ...streamed(
      "Delivered four days ago, $900 paid, inside the window, refund eligible and nothing refunded so far. The customer asked for cash back on the card they paid with, so issue_refund is the right tool and $900 is the right amount — the full purchase price for an item that arrived damaged.",
      "thinking_delta",
    ),
  );
  evs.push(
    ...streamed(
      "That order is still well inside the refund window, so I'll put the full $900 back on the card you paid with.",
      "text_delta",
    ),
  );
  evs.push({
    t: "tool_use",
    id: "t2",
    name: "issue_refund",
    input: { order_id: "ORD-7788", amount: 900, reason: "damaged on arrival" },
  });
  evs.push({
    t: "hook_verdict",
    toolUseId: "t2",
    ruleId: "refund_threshold",
    action: "block_and_escalate",
  });
  evs.push({
    t: "escalation_injected",
    toolUseId: "t2",
    escalationId: "ESC-4417",
    blockedReason: "refund_amount_exceeds_threshold",
  });
  evs.push({ t: "tool_result", toolUseId: "t2", ok: false, envelope: failEnv, ms: 12 });
  evs.push({ t: "turn_end", stopReason: "tool_use", usage: { input: 2400, output: 260 } });

  // Turn 3 — the model explains what the system already did, and offers a remedy
  // it is allowed to give. (The customer's second turn lands after this.)
  evs.push({ t: "turn_start", turn: 3 });
  evs.push(
    ...streamed(
      "The refund was blocked and an escalation was already filed by the system, with a receipt. I should not try a smaller refund to slip under the threshold, and I should not quietly substitute store credit for the cash the customer explicitly asked for. The honest move is to say it is with a human, give them the reference, and offer credit as something they can take today if they would rather not wait.",
      "thinking_delta",
    ),
  );
  evs.push(
    ...streamed(
      "A refund of this size needs a person to approve it, so I've sent it straight to our resolutions team rather than leaving you to chase it — the reference is ESC-4417 and they typically pick these up within four hours. Nothing has been taken off the table: the full $900 is what has been requested on your behalf, and you'll get an email as soon as it is approved. If you'd rather not wait on that, I can put $900 of store credit on your account right now, and the refund still goes through if it is approved.",
      "text_delta",
    ),
  );
  evs.push({ t: "turn_end", stopReason: "end_turn", usage: { input: 3100, output: 420 } });

  // Turn 4 — "yes, credit is fine": the remedy that IS inside the agent's
  // authority, including a transient gateway wobble it retries through.
  evs.push({ t: "turn_start", turn: 4 });
  evs.push(
    ...streamed(
      "They have accepted store credit. That is inside my authority — no cash leaves the business, and $900 is under the credit ceiling, so no rule applies here.",
      "thinking_delta",
    ),
  );
  evs.push(
    ...streamed("Done — putting that on your account now.", "text_delta"));
  evs.push({
    t: "tool_use",
    id: "t3",
    name: "issue_store_credit",
    input: { order_id: "ORD-7788", amount: 900, reason: "damaged on arrival" },
  });
  evs.push({ t: "hook_verdict", toolUseId: "t3", ruleId: null, action: "allow" });
  evs.push({ t: "attempt", toolUseId: "t3", n: 1, of: 2 });
  evs.push({ t: "attempt", toolUseId: "t3", n: 2, of: 2, retryAfterMs: 2000 });
  evs.push({ t: "tool_result", toolUseId: "t3", ok: true, envelope: okEnv, ms: 61 });
  evs.push({ t: "turn_end", stopReason: "tool_use", usage: { input: 3600, output: 180 } });

  // Turn 5 — the close.
  evs.push({ t: "turn_start", turn: 5 });
  evs.push(
    ...streamed(
      "$900 of store credit is on your account and available immediately — it expires in twelve months. The $900 cash refund is still queued with the resolutions team under ESC-4417; if they approve it, we'll take the credit back off so you aren't paid twice. Anything else I can sort out on this order?",
      "text_delta",
    ),
  );
  evs.push({ t: "turn_end", stopReason: "end_turn", usage: { input: 4000, output: 240 } });
  evs.push({ t: "done" });

  return evs;
}

const ACT = realisticAct();

/* ------------------------------------------------------------------ *
 * dwellMs — the relationships that make the demo readable
 * ------------------------------------------------------------------ */

test("every event kind gets a positive dwell — the playhead can never stall", () => {
  for (const ev of EVERY_KIND) {
    const ms = dwellMs(ev);
    assert.ok(Number.isFinite(ms) && ms > 0, `${ev.t} must have a positive dwell, got ${ms}`);
  }
});

test("the beats that carry the argument outlast the prose", () => {
  const delta = dwellMs({ t: "text_delta", text: "..." });
  assert.equal(dwellMs({ t: "thinking_delta", text: "..." }), delta);

  const block = dwellMs({
    t: "hook_verdict",
    toolUseId: "t1",
    ruleId: "refund_threshold",
    action: "block_and_escalate",
  });
  const escalation = dwellMs({
    t: "escalation_injected",
    toolUseId: "t1",
    escalationId: "ESC-1",
    blockedReason: "refund_amount_exceeds_threshold",
  });
  const failure = dwellMs({ t: "tool_result", toolUseId: "t1", ok: false, envelope: failEnv, ms: 5 });

  for (const [label, ms] of [["block", block], ["escalation", escalation], ["failure", failure]] as const) {
    assert.ok(ms >= 1600 && ms <= 2200, `${label} should hold the room: ${ms}ms`);
    assert.ok(ms > delta * 8, `${label} (${ms}ms) must dwarf a text delta (${delta}ms)`);
  }
});

test("a block outlasts an allow, and a failure outlasts a success", () => {
  const allow = dwellMs({ t: "hook_verdict", toolUseId: "t1", ruleId: null, action: "allow" });
  const block = dwellMs({
    t: "hook_verdict",
    toolUseId: "t1",
    ruleId: "refund_threshold",
    action: "block_and_escalate",
  });
  assert.ok(block > allow, "the verdict that stops money is the one to linger on");

  const ok = dwellMs({ t: "tool_result", toolUseId: "t1", ok: true, envelope: okEnv, ms: 5 });
  const bad = dwellMs({ t: "tool_result", toolUseId: "t1", ok: false, envelope: failEnv, ms: 5 });
  assert.ok(bad > ok);

  // A retry is a mechanism the audience came to watch, not a repeated frame.
  const first = dwellMs({ t: "attempt", toolUseId: "t1", n: 1, of: 2 });
  const retry = dwellMs({ t: "attempt", toolUseId: "t1", n: 2, of: 2, retryAfterMs: 400 });
  assert.ok(retry > first);
});

/* ------------------------------------------------------------------ *
 * The timeline
 * ------------------------------------------------------------------ */

test("elapsedAt is zero before the first event and strictly increasing after", () => {
  assert.equal(elapsedAt(ACT, -1, 1), 0);
  assert.equal(elapsedAt(ACT, -5, 1), 0, "any pre-roll position costs nothing");

  let prev = 0;
  for (let i = 0; i < ACT.length; i++) {
    const at = elapsedAt(ACT, i, 1);
    assert.ok(at > prev, `elapsedAt must advance at ${i}: ${at} <= ${prev}`);
    prev = at;
  }
  assert.equal(elapsedAt(ACT, ACT.length - 1, 1), totalMs(ACT, 1));
  assert.equal(elapsedAt(ACT, ACT.length + 99, 1), totalMs(ACT, 1), "index clamps to the end");
});

test("speed scales the whole timeline linearly", () => {
  const base = totalMs(ACT, 1);
  for (const speed of [0.5, 2, 4] as const) {
    assert.equal(totalMs(ACT, speed), base / speed);
    for (const i of [0, 7, 40, ACT.length - 1]) {
      assert.equal(elapsedAt(ACT, i, speed), elapsedAt(ACT, i, 1) / speed);
    }
  }
});

test("indexAt inverts elapsedAt exactly, at every speed", () => {
  for (const speed of [0.5, 1, 2, 4] as const) {
    for (let i = 0; i < ACT.length; i++) {
      assert.equal(
        indexAt(ACT, elapsedAt(ACT, i, speed), speed),
        i,
        `round trip failed at index ${i}, speed ${speed}`,
      );
    }
  }
});

test("indexAt holds the pre-roll and the end of the timeline", () => {
  assert.equal(indexAt(ACT, -1, 1), -1);
  assert.equal(indexAt(ACT, 0, 1), -1, "nothing is revealed until the first dwell is spent");
  assert.equal(indexAt(ACT, elapsedAt(ACT, 0, 1) - 1, 1), -1);
  assert.equal(indexAt(ACT, totalMs(ACT, 1), 1), ACT.length - 1);
  assert.equal(indexAt(ACT, totalMs(ACT, 1) * 10, 1), ACT.length - 1, "overshoot parks at the end");

  // Scrubbing to an arbitrary millisecond lands on the event in view at that moment.
  const mid = totalMs(ACT, 1) / 2;
  const i = indexAt(ACT, mid, 1);
  assert.ok(elapsedAt(ACT, i, 1) <= mid && mid < elapsedAt(ACT, i + 1, 1));
});

test("an empty act has no timeline", () => {
  assert.equal(totalMs([], 1), 0);
  assert.equal(elapsedAt([], 0, 1), 0);
  assert.equal(indexAt([], 0, 1), -1);
});

/* ------------------------------------------------------------------ *
 * The slot
 * ------------------------------------------------------------------ */

test("a realistic act fits the 40-70s slot at speed 1", () => {
  const seconds = totalMs(ACT, 1) / 1000;
  assert.ok(
    seconds >= 40 && seconds <= 70,
    `a full act should run 40-70s on stage, this one runs ${seconds.toFixed(1)}s ` +
      `over ${ACT.length} events`,
  );
});

test("the speed dial covers both a rehearsal and a Q&A skim", () => {
  assert.ok(totalMs(ACT, 4) / 1000 < 20, "4x must get through an act while a question is live");
  assert.ok(totalMs(ACT, 0.5) / 1000 > 80, "0.5x must be slow enough to talk over every beat");
});
