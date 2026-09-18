/**
 * Demo Mode's server side.
 *
 *   GET  /api/demo                          -> { acts, live }
 *   POST /api/demo { actId, mode? }         -> DemoRun
 *
 * This endpoint deliberately owns no agent machinery of its own. An act names a
 * scenario, and the scenario is run by exactly the same two paths the scenario
 * runner and `npm run eval` use — `runScripted` for replay, `runAgent` for live
 * — with the same `scenario.expect()` producing the assertions. A demo that ran
 * its own slightly different pipeline would be demonstrating itself rather than
 * the system.
 *
 * One rule governs every branch below: NEVER leave the stage with nothing to
 * play. Live is the fragile path — the key can be absent, expired, rejected,
 * rate-limited, or the network can drop halfway through a turn — and ALL of
 * those degrade to a replay of the same act rather than to an error. `mode`
 * reports what actually ran and `notice` says why it differs from what was
 * asked for; `error` is reserved for the genuinely unshowable.
 *
 * There is deliberately no up-front credential probe. `credentialsAvailable()`
 * answers "does a key exist", not "does it work", and no cheap pre-flight can
 * answer the second question without paying a round trip on every page load
 * and still racing the real request. Failing over at failure time is the only
 * layer where the answer is actually known.
 */
import { snapshotWorld } from "@/evals/assertions";
import { runScripted } from "@/evals/harness";
import { SCENARIOS, type Scenario } from "@/evals/scenarios";
import { DEMO_ACTS, actById } from "@/lib/demo/acts";
import type { DemoAct, DemoMode, DemoRun } from "@/lib/demo/types";
import { credentialsAvailable, describeError, runAgent } from "@/lib/loop";
import { getSession, resetSession } from "@/lib/store/db";
import type { Emit, TraceEvent } from "@/lib/types";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** A DemoRun that carries an error instead of a trace. Fatal, so no notice. */
function failed(actId: string, scenarioId: string, title: string, message: string): DemoRun {
  return {
    actId,
    scenarioId,
    title,
    turns: [],
    mode: "replay",
    events: [{ t: "error", message }, { t: "done" }],
    assertions: [],
    passed: false,
    finalText: "",
    world: null,
    error: message,
    notice: null,
  };
}

/**
 * One short clause naming why live did not happen, for the middle of the
 * fallback sentence. `describeError` is right for a log and far too long for a
 * screen read from the back of a room, so this classifies the error instead of
 * quoting it — the full text is still in the server log if anyone wants it.
 */
function liveFailureReason(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "the API rejected the current credentials";
  }
  if (err instanceof Anthropic.RateLimitError) return "the API rate-limited the request";
  if (err instanceof Anthropic.APIConnectionError) return "the API could not be reached";
  if (err instanceof Anthropic.APIError) {
    return err.status === undefined ? "the API returned an error" : `the API returned ${err.status}`;
  }
  if (err instanceof Error && /could not resolve authentication method/i.test(err.message)) {
    return "no credentials were found";
  }
  return "the live run did not complete";
}

function fallbackNotice(reason: string): string {
  return `Live run failed (${reason}). Showing replay.`;
}

/** Replay: canned model, real hook + dispatcher + handlers + retry + store. */
async function replay(act: DemoAct, scenario: Scenario, notice: string | null): Promise<DemoRun> {
  try {
    const run = await runScripted(scenario);
    const assertions = scenario.expect(run.events, run.world);
    return {
      actId: act.id,
      scenarioId: scenario.id,
      title: act.title,
      turns: scenario.turns,
      mode: "replay",
      events: run.events,
      assertions,
      passed: assertions.every((a) => a.pass),
      finalText: run.finalText,
      world: run.world,
      error: null,
      notice,
    };
  } catch (err) {
    // Replay is the floor. If it fails there is genuinely nothing to show, so
    // this is fatal even when we got here by falling back from live.
    return failed(act.id, scenario.id, act.title, describeError(err));
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ acts: DEMO_ACTS, live: await credentialsAvailable() }, { headers: NO_STORE });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { actId?: unknown; mode?: unknown };

  const actId = typeof body.actId === "string" ? body.actId : "";
  const act = actById(actId);
  if (!act) {
    return Response.json(
      failed(actId, "", "", `Unknown actId ${JSON.stringify(actId)}.`),
      { status: 400, headers: NO_STORE },
    );
  }

  // A static act (scenarioId null) is legal in the contract but has nothing to
  // run — the shell renders its beats without a trace.
  if (act.scenarioId === null) {
    return Response.json(
      failed(act.id, "", act.title, `Act "${act.id}" is a static act and has no scenario to run.`),
      { status: 400, headers: NO_STORE },
    );
  }

  const scenario = SCENARIOS.find((s) => s.id === act.scenarioId);
  if (!scenario) {
    return Response.json(
      failed(act.id, act.scenarioId, act.title, `Act "${act.id}" names an unknown scenario "${act.scenarioId}".`),
      { status: 400, headers: NO_STORE },
    );
  }

  const requested: DemoMode = body.mode === "live" ? "live" : "replay";
  if (requested === "replay") {
    return Response.json(await replay(act, scenario, null), { headers: NO_STORE });
  }

  // A missing key is knowable without a request, so skip the doomed call — but
  // report it through the same fallback as a rejected one. To the audience the
  // two are the same event: the Live toggle did not produce a live run.
  if (!(await credentialsAvailable())) {
    return Response.json(await replay(act, scenario, fallbackNotice("no credentials were found")), {
      headers: NO_STORE,
    });
  }

  /* ---- live: the real model drives the real loop ---- */
  // Reset first so the ledger the audience sees is this run's, not the last
  // rehearsal's — the store diff is half the payoff.
  const sessionId = `demo:${act.id}`;
  resetSession(sessionId);

  const events: TraceEvent[] = [];
  const emit: Emit = (ev) => events.push(ev);
  let finalText = "";

  try {
    let messages: Parameters<typeof runAgent>[0]["messages"] = [];
    for (const turn of scenario.turns) {
      messages = [...messages, { role: "user", content: turn }];
      const result = await runAgent({ sessionId, messages, emit, signal: req.signal });
      messages = result.messages;
      finalText = result.finalText || finalText;
    }
  } catch (err) {
    // Whatever partial trace we collected is discarded: a half-finished live
    // turn renders as a broken act, and the beats are authored against a
    // complete one. Replay the same act instead and say so.
    console.error(`[demo] live run of "${act.id}" failed, falling back to replay:`, describeError(err));
    return Response.json(await replay(act, scenario, fallbackNotice(liveFailureReason(err))), {
      headers: NO_STORE,
    });
  }

  emit({ t: "done" });
  const world = snapshotWorld(getSession(sessionId));
  const assertions = scenario.expect(events, world);

  return Response.json(
    {
      actId: act.id,
      scenarioId: scenario.id,
      title: act.title,
      turns: scenario.turns,
      mode: "live",
      events,
      assertions,
      passed: assertions.every((a) => a.pass),
      finalText,
      world,
      error: null,
      notice: null,
    } satisfies DemoRun,
    { headers: NO_STORE },
  );
}
