/**
 * Scenario runner — runs one named scenario server-side and returns its FULL
 * TraceEvent[] plus the canonical assertion results as JSON (not SSE), so the
 * UI's runner asserts on trace shape rather than on prose.
 *
 *   GET  /api/scenarios                     -> { scenarios: ScenarioSummary[] }
 *   POST /api/scenarios { scenarioId }      -> ScenarioRunResult
 *
 * The scenario list and every assertion come from the single source of truth,
 * `evals/scenarios.ts` (the SWAP POINT Agent C left for this wave). The eval
 * CLI (`npm run eval`) and this endpoint therefore check the exact same things.
 *
 * The session store is reset before every run, so a scenario never sees refunds
 * or escalations left behind by an earlier one — that isolation is what makes
 * the suite repeatable.
 */
import { snapshotWorld, type Assertion, type EvalWorld } from "@/evals/assertions";
import { SCENARIOS } from "@/evals/scenarios";
import {
  credentialsAvailable,
  describeError,
  MISSING_CREDENTIALS_MESSAGE,
  runAgent,
} from "@/lib/loop";
import { getSession, resetSession } from "@/lib/store/db";
import type { Emit, TraceEvent } from "@/lib/types";
import { SCRIPTS } from "@/evals/scriptedModel";
import { runScripted } from "@/evals/harness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ScenarioSummary {
  id: string;
  title: string;
  prompt: string;
  turns: string[];
  refs: string[];
  hasScript: boolean;
}

export interface ScenarioRunResult {
  scenarioId: string;
  title: string;
  prompt: string;
  sessionId: string;
  mode: "live" | "scripted";
  events: TraceEvent[];
  assertions: Assertion[];
  passed: boolean;
  finalText: string;
  turns: number;
  /** Store snapshot AFTER the run: refunds, credits, escalations. */
  world: EvalWorld | null;
  error: string | null;
}

function summarize(): ScenarioSummary[] {
  return SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    prompt: s.turns[0],
    turns: s.turns,
    refs: s.refs,
    hasScript: !!SCRIPTS[s.id],
  }));
}

export function GET(): Response {
  return Response.json({ scenarios: summarize() });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    scenarioId?: unknown;
    sessionId?: unknown;
    forceScripted?: unknown;
  };

  const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : "";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    return Response.json(
      { error: `Unknown scenarioId ${JSON.stringify(scenarioId)}.`, known: SCENARIOS.map((s) => s.id) },
      { status: 400 },
    );
  }

  const live = body.forceScripted === true ? false : await credentialsAvailable();

  // ---- scripted path: real backend, canned model, no credentials ----
  if (!live) {
    try {
      const run = await runScripted(scenario);
      const assertions = scenario.expect(run.events, run.world);
      return Response.json(
        {
          scenarioId: scenario.id,
          title: scenario.title,
          prompt: scenario.turns[0],
          sessionId: `eval:scripted:${scenario.id}`,
          mode: "scripted",
          events: run.events,
          assertions,
          passed: assertions.every((a) => a.pass),
          finalText: run.finalText,
          turns: run.events.filter((e) => e.t === "turn_start").length,
          world: run.world,
          error: SCRIPTS[scenario.id] ? null : MISSING_CREDENTIALS_MESSAGE,
        } satisfies ScenarioRunResult,
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      return Response.json(
        {
          scenarioId: scenario.id,
          title: scenario.title,
          prompt: scenario.turns[0],
          sessionId: "",
          mode: "scripted",
          events: [{ t: "error", message: describeError(err) }, { t: "done" }],
          assertions: [],
          passed: false,
          finalText: "",
          turns: 0,
          world: null,
          error: describeError(err),
        } satisfies ScenarioRunResult,
        { headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // ---- live path: the real model drives the real loop ----
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId.trim()
      : `scenario:${scenario.id}`;
  resetSession(sessionId);

  const events: TraceEvent[] = [];
  const emit: Emit = (ev) => events.push(ev);
  let finalText = "";
  let turns = 0;
  let error: string | null = null;

  try {
    let messages: Parameters<typeof runAgent>[0]["messages"] = [];
    for (const turn of scenario.turns) {
      messages = [...messages, { role: "user", content: turn }];
      const result = await runAgent({ sessionId, messages, emit, signal: req.signal });
      messages = result.messages;
      finalText = result.finalText || finalText;
      turns += result.turns;
    }
  } catch (err) {
    error = describeError(err);
    emit({ t: "error", message: error });
  }
  emit({ t: "done" });

  const world = snapshotWorld(getSession(sessionId));
  const assertions = error ? [] : scenario.expect(events, world);

  return Response.json(
    {
      scenarioId: scenario.id,
      title: scenario.title,
      prompt: scenario.turns[0],
      sessionId,
      mode: "live",
      events,
      assertions,
      passed: !error && assertions.every((a) => a.pass),
      finalText,
      turns,
      world,
      error,
    } satisfies ScenarioRunResult,
    { headers: { "Cache-Control": "no-store" } },
  );
}
