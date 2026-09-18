/**
 * The demo script, checked against the system it narrates.
 *
 * Act data is prose pinned to trace positions, and prose does not fail to
 * compile. The failure mode that matters is silent: a scenario changes shape,
 * a beat's anchor stops resolving, and the narration for that moment simply
 * does not appear — on stage, in front of an audience, with no error anywhere.
 * These tests run every act through the REAL scripted pipeline and assert that
 * every authored beat still lands.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The retry act really does back off; we do not need to spend that time here.
process.env.RETRY_SLEEP_SCALE = "0";

// These tests must never reach the network, on any machine, including one with
// a working key exported. Stripping every credential source makes
// `credentialsAvailable()` deterministically false, so a "live" request here
// always takes the fallback path — which is precisely the path under test.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_PROFILE;
delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
delete process.env.ANTHROPIC_ORGANIZATION_ID;
process.env.ANTHROPIC_CONFIG_DIR = "/nonexistent/demo-test-no-credentials";

import { DEMO_ACTS, actById } from "../lib/demo/acts";
import { currentBeat, resolveAnchor, resolveBeats } from "../lib/demo/anchors";
import { SCENARIOS, scenarioById } from "../evals/scenarios";
import { SCRIPTS } from "../evals/scriptedModel";
import { runScripted } from "../evals/harness";
import { POST } from "../app/api/demo/route";
import type { TraceEvent } from "../lib/types";
import type { Beat, DemoRun } from "../lib/demo/types";

/* ------------------------------------------------------------------ *
 * Act data integrity
 * ------------------------------------------------------------------ */

test("act ids are unique and resolvable", () => {
  const ids = DEMO_ACTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate act id in ${ids.join(", ")}`);
  for (const act of DEMO_ACTS) {
    assert.equal(actById(act.id), act);
  }
  assert.equal(actById("no-such-act"), undefined);
});

test("every act names a real scenario that has a script", () => {
  for (const act of DEMO_ACTS) {
    assert.ok(act.scenarioId, `act "${act.id}" must name a scenario`);
    const scenario = SCENARIOS.find((s) => s.id === act.scenarioId);
    assert.ok(scenario, `act "${act.id}" names unknown scenario "${act.scenarioId}"`);
    assert.equal(scenarioById(act.scenarioId!), scenario);
    // Replay is the default path on stage; an act without a script cannot run
    // offline, which is the one guarantee the demo actually makes.
    assert.ok(SCRIPTS[scenario.id], `scenario "${scenario.id}" has no script for replay`);
  }
});

test("beat ids are unique within an act and at most one moment", () => {
  for (const act of DEMO_ACTS) {
    const ids = act.beats.map((b) => b.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate beat id in act "${act.id}"`);
    assert.ok(act.beats.length >= 3 && act.beats.length <= 5, `act "${act.id}" has ${act.beats.length} beats`);
    const moments = act.beats.filter((b) => b.kind === "moment");
    assert.ok(moments.length <= 1, `act "${act.id}" has ${moments.length} moment beats`);
  }
});

test("acts mirror their scenario's spec refs", () => {
  for (const act of DEMO_ACTS) {
    const scenario = SCENARIOS.find((s) => s.id === act.scenarioId)!;
    assert.deepEqual(act.refs, scenario.refs, `act "${act.id}" refs drifted from the scenario`);
  }
});

/* ------------------------------------------------------------------ *
 * Every beat resolves against the trace it narrates.
 * This is the test that stops narration from vanishing on stage.
 * ------------------------------------------------------------------ */

const traces = new Map<string, TraceEvent[]>();

async function traceFor(scenarioId: string): Promise<TraceEvent[]> {
  const cached = traces.get(scenarioId);
  if (cached) return cached;
  const run = await runScripted(scenarioById(scenarioId)!);
  traces.set(scenarioId, run.events);
  return run.events;
}

for (const act of DEMO_ACTS) {
  test(`act "${act.id}": every beat anchor resolves`, async () => {
    const events = await traceFor(act.scenarioId!);
    for (const beat of act.beats) {
      const i = resolveAnchor(beat.at, events);
      assert.notEqual(
        i,
        null,
        `beat "${beat.id}" (${JSON.stringify(beat.at)}) does not occur in the ${act.scenarioId} trace`,
      );
    }
    const resolved = resolveBeats(act.beats, events);
    assert.equal(resolved.length, act.beats.length, `act "${act.id}" dropped a beat`);
    // Sorted ascending, so the narration never jumps backwards as the playhead
    // advances.
    for (let n = 1; n < resolved.length; n++) {
      assert.ok(resolved[n].index >= resolved[n - 1].index, `act "${act.id}" beats are out of order`);
    }
    // The first beat is reachable and the last one lands before the trace ends.
    assert.ok(resolved[resolved.length - 1].index <= events.length - 1);
  });
}

/* ------------------------------------------------------------------ *
 * The two acts whose whole point is a specific event being present or absent
 * ------------------------------------------------------------------ */

test("act 2's trace really is hook-blocked and escalated", async () => {
  const events = await traceFor("over-threshold-refund");
  assert.ok(
    events.some((e) => e.t === "hook_verdict" && e.action === "block_and_escalate"),
    "over-threshold-refund must contain a block_and_escalate verdict",
  );
  assert.equal(events.filter((e) => e.t === "escalation_injected").length, 1);
  // The moment beat must sit on the block itself — that is the one frame the
  // audience is asked to look at.
  const moment = DEMO_ACTS.find((a) => a.id === "over-threshold-refund")!.beats.find((b) => b.kind === "moment")!;
  assert.deepEqual(moment.at, { kind: "hook_block" });
});

test("act 3's trace has zero escalations — rejection is not blocking", async () => {
  const events = await traceFor("credit-ceiling");
  assert.equal(events.filter((e) => e.t === "escalation_injected").length, 0);
  assert.equal(resolveAnchor({ kind: "hook_block" }, events), null);
  assert.ok(
    events.some((e) => e.t === "tool_result" && !e.envelope.success && e.envelope.errorCategory === "validation"),
    "credit-ceiling must reject with a validation error",
  );
});

/* ------------------------------------------------------------------ *
 * resolveAnchor / resolveBeats / currentBeat units
 * ------------------------------------------------------------------ */

const ok = { success: true } as const;
const fail = { success: false, errorCategory: "validation", isRetryable: false, message: "no" } as const;

/** A miniature trace: two issue_refund calls, the first failing, the second not. */
const FIXTURE: TraceEvent[] = [
  { t: "turn_start", turn: 1 },
  { t: "tool_use", id: "a", name: "issue_refund", input: { amount: 10 } },
  { t: "attempt", toolUseId: "a", n: 1, of: 2 },
  { t: "tool_result", toolUseId: "a", ok: false, envelope: fail, ms: 1 },
  { t: "tool_use", id: "b", name: "issue_refund", input: { amount: 20 } },
  { t: "attempt", toolUseId: "b", n: 1, of: 2 },
  { t: "attempt", toolUseId: "b", n: 2, of: 2 },
  { t: "tool_result", toolUseId: "b", ok: true, envelope: ok, ms: 1 },
  { t: "done" },
];

test("start and end bracket the trace, and an empty trace has no positions", () => {
  assert.equal(resolveAnchor({ kind: "start" }, FIXTURE), 0);
  assert.equal(resolveAnchor({ kind: "end" }, FIXTURE), FIXTURE.length - 1);
  assert.equal(resolveAnchor({ kind: "start" }, []), null);
  assert.equal(resolveAnchor({ kind: "end" }, []), null);
  assert.equal(resolveAnchor({ kind: "index", i: 3 }, []), null);
});

test("index anchors clamp instead of vanishing", () => {
  assert.equal(resolveAnchor({ kind: "index", i: 2 }, FIXTURE), 2);
  assert.equal(resolveAnchor({ kind: "index", i: 999 }, FIXTURE), FIXTURE.length - 1);
  assert.equal(resolveAnchor({ kind: "index", i: -5 }, FIXTURE), 0);
});

test("nth selection picks the right occurrence", () => {
  assert.equal(resolveAnchor({ kind: "tool_use", name: "issue_refund" }, FIXTURE), 1);
  assert.equal(resolveAnchor({ kind: "tool_use", name: "issue_refund", nth: 2 }, FIXTURE), 4);
  assert.equal(resolveAnchor({ kind: "tool_use", name: "issue_refund", nth: 3 }, FIXTURE), null);
  assert.equal(resolveAnchor({ kind: "tool_use", name: "issue_store_credit" }, FIXTURE), null);
});

test("result anchors follow the toolUseId back to the tool name, and filter on ok", () => {
  assert.equal(resolveAnchor({ kind: "result", name: "issue_refund" }, FIXTURE), 3);
  assert.equal(resolveAnchor({ kind: "result", name: "issue_refund", nth: 2 }, FIXTURE), 7);
  assert.equal(resolveAnchor({ kind: "result", name: "issue_refund", ok: true }, FIXTURE), 7);
  assert.equal(resolveAnchor({ kind: "result", name: "issue_refund", ok: false }, FIXTURE), 3);
  assert.equal(resolveAnchor({ kind: "result", name: "issue_refund", ok: true, nth: 2 }, FIXTURE), null);
  assert.equal(resolveAnchor({ kind: "result", name: "check_order_status" }, FIXTURE), null);
});

test("attempt anchors find the first attempt with that n", () => {
  assert.equal(resolveAnchor({ kind: "attempt", n: 1 }, FIXTURE), 2);
  assert.equal(resolveAnchor({ kind: "attempt", n: 2 }, FIXTURE), 6);
  assert.equal(resolveAnchor({ kind: "attempt", n: 3 }, FIXTURE), null);
});

test("hook_block and escalation are absent from an unblocked trace", () => {
  // Absence is the normal answer here, not an error — most traces never block.
  assert.equal(resolveAnchor({ kind: "hook_block" }, FIXTURE), null);
  assert.equal(resolveAnchor({ kind: "escalation" }, FIXTURE), null);

  const blocked: TraceEvent[] = [
    ...FIXTURE.slice(0, 4),
    { t: "hook_verdict", toolUseId: "b", ruleId: null, action: "allow" },
    { t: "hook_verdict", toolUseId: "b", ruleId: "refund_threshold", action: "block_and_escalate" },
    { t: "escalation_injected", toolUseId: "b", escalationId: "ESC-1", blockedReason: "r" },
  ];
  // An "allow" verdict must not satisfy a hook_block anchor.
  assert.equal(resolveAnchor({ kind: "hook_block" }, blocked), 5);
  assert.equal(resolveAnchor({ kind: "escalation" }, blocked), 6);
});

test("resolveBeats drops unresolvable beats and sorts by trace position", () => {
  const beats: Beat[] = [
    { id: "last", at: { kind: "end" }, kind: "payoff", title: "last", body: "" },
    { id: "gone", at: { kind: "hook_block" }, kind: "insight", title: "gone", body: "" },
    { id: "first", at: { kind: "start" }, kind: "setup", title: "first", body: "" },
    { id: "tie", at: { kind: "index", i: 0 }, kind: "insight", title: "tie", body: "" },
  ];
  const resolved = resolveBeats(beats, FIXTURE);
  // "gone" is dropped; "first" precedes "tie" on index 0 by authored order.
  assert.deepEqual(resolved.map((b) => b.id), ["first", "tie", "last"]);
  assert.deepEqual(resolved.map((b) => b.index), [0, 0, FIXTURE.length - 1]);
  assert.deepEqual(resolveBeats(beats, []), []);
});

test("currentBeat is the last beat the playhead has passed", () => {
  const resolved = resolveBeats(
    [
      { id: "a", at: { kind: "index", i: 1 }, kind: "setup", title: "a", body: "" },
      { id: "b", at: { kind: "index", i: 4 }, kind: "insight", title: "b", body: "" },
    ],
    FIXTURE,
  );
  assert.equal(currentBeat(resolved, -1), null);
  assert.equal(currentBeat(resolved, 0), null);
  assert.equal(currentBeat(resolved, 1)?.id, "a");
  assert.equal(currentBeat(resolved, 3)?.id, "a");
  assert.equal(currentBeat(resolved, 4)?.id, "b");
  assert.equal(currentBeat(resolved, 99)?.id, "b");
  assert.equal(currentBeat([], 5), null);
});

/* ------------------------------------------------------------------ *
 * POST /api/demo — the run contract the stage depends on.
 *
 * The invariant that matters on stage: whenever `error` is null there is
 * something playable on screen. Live is the fragile path, so every one of its
 * failure modes has to land here as a replay, not as an empty stage.
 * ------------------------------------------------------------------ */

async function run(body: unknown): Promise<{ status: number; body: DemoRun }> {
  const res = await POST(
    new Request("http://demo.test/api/demo", { method: "POST", body: JSON.stringify(body) }),
  );
  return { status: res.status, body: (await res.json()) as DemoRun };
}

/** The shape every caller may rely on, whatever happened server-side. */
function assertPlayable(r: DemoRun, label: string) {
  assert.equal(r.error, null, `${label}: expected a playable run, got error ${r.error}`);
  assert.ok(r.events.length > 0, `${label}: no events`);
  assert.equal(r.events[r.events.length - 1].t, "done", `${label}: trace does not terminate`);
  assert.ok(r.events.some((e) => e.t === "tool_use"), `${label}: nothing for the stage to show`);
  assert.ok(!r.events.some((e) => e.t === "error"), `${label}: playable run carries an error event`);
  assert.notEqual(r.world, null, `${label}: no world snapshot`);
  assert.ok(r.assertions.length > 0, `${label}: no assertions`);
  assert.ok(r.turns.length > 0, `${label}: no customer turns`);
}

test("a replay run is playable, and reports nothing it does not need to", async () => {
  for (const act of DEMO_ACTS) {
    const { status, body } = await run({ actId: act.id });
    assert.equal(status, 200);
    assertPlayable(body, act.id);
    assert.equal(body.mode, "replay");
    assert.equal(body.notice, null, `${act.id}: a plain replay has nothing to notice`);
    assert.equal(body.passed, true, `${act.id}: scenario assertions must pass on replay`);
    assert.equal(body.actId, act.id);
    assert.equal(body.scenarioId, act.scenarioId);
  }
});

test("mode defaults to replay, and an unrecognised mode is not live", async () => {
  assert.equal((await run({ actId: "happy-refund" })).body.mode, "replay");
  assert.equal((await run({ actId: "happy-refund", mode: "REPLAY" })).body.mode, "replay");
  assert.equal((await run({ actId: "happy-refund", mode: 7 })).body.mode, "replay");
});

test("live without working credentials falls back to a full replay, with a notice", async () => {
  for (const act of DEMO_ACTS) {
    const { status, body } = await run({ actId: act.id, mode: "live" });
    assert.equal(status, 200, `${act.id}: a fallback is not an error status`);
    // Everything the stage needs is present — this is a real run, not a stub.
    assertPlayable(body, `${act.id} (live fallback)`);
    assert.equal(body.passed, true);
    // `mode` reports what RAN, never what was asked for. A Live badge over a
    // replayed trace is the one lie this endpoint must not tell.
    assert.equal(body.mode, "replay", `${act.id}: mode must report the run that happened`);
    assert.ok(body.notice, `${act.id}: a downgraded run must say so`);
    assert.match(body.notice!, /^Live run failed \(.+\)\. Showing replay\.$/);
    // Read off a screen mid-talk: one sentence, not a stack trace.
    assert.ok(body.notice!.length <= 120, `${act.id}: notice is too long to read aloud`);
    assert.equal(body.notice!.split(". ").length, 2);
  }
});

test("notice and error are never both set — one is fatal, the other is not", async () => {
  const runs = [
    (await run({ actId: "happy-refund" })).body,
    (await run({ actId: "happy-refund", mode: "live" })).body,
    (await run({ actId: "no-such-act" })).body,
  ];
  for (const r of runs) {
    assert.ok(r.error === null || r.notice === null);
    // Both fields are required, not optional — the stage reads them directly.
    assert.ok("error" in r && "notice" in r);
  }
});

test("an unshowable request is a fatal error, with no notice", async () => {
  const { status, body } = await run({ actId: "no-such-act" });
  assert.equal(status, 400);
  assert.match(body.error ?? "", /Unknown actId/);
  assert.equal(body.notice, null);
  assert.equal(body.world, null);
  assert.deepEqual(body.assertions, []);
  assert.equal(body.passed, false);
  // Even a fatal run carries a terminated trace, so the stage renders the
  // error rather than crashing on an empty array.
  assert.equal(body.events[body.events.length - 1].t, "done");
  assert.equal(body.events[0].t, "error");
});

test("a malformed body is an error, not a throw", async () => {
  const res = await POST(new Request("http://demo.test/api/demo", { method: "POST", body: "{not json" }));
  const body = (await res.json()) as DemoRun;
  assert.equal(res.status, 400);
  assert.ok(body.error);
  assert.equal(body.notice, null);
});
