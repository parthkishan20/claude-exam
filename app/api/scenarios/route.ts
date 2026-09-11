/**
 * Scenario runner — runs one named scenario server-side and returns its FULL
 * TraceEvent[] as JSON (not SSE) so the UI's runner can assert on trace shape
 * rather than on prose.
 *
 * WAVE 1 — AGENT C owns this file.
 *
 *   GET  /api/scenarios                     -> { scenarios: ScenarioDef[] }
 *   POST /api/scenarios { scenarioId }      -> ScenarioRunResult
 *
 * The session store is reset before every run, so a scenario never sees refunds
 * or escalations left behind by an earlier one — that isolation is what makes
 * the suite repeatable.
 *
 * SWAP POINT: `evals/scenarios.ts` does not exist yet (a later wave writes it).
 * When it lands, delete LOCAL_SCENARIOS below and replace it with
 *   import { SCENARIOS } from "@/evals/scenarios";
 * The only shape this file depends on is `{ id: string; prompt: string }` plus
 * an optional `title`; anything else on the objects is passed through untouched.
 */
import {
  credentialsAvailable,
  describeError,
  MISSING_CREDENTIALS_MESSAGE,
  runAgent,
} from "@/lib/loop";
import { resetSession } from "@/lib/store/db";
import type { TraceEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ScenarioDef {
  id: string;
  title: string;
  prompt: string;
}

/** Minimal placeholder suite — see SWAP POINT above. */
const LOCAL_SCENARIOS: ScenarioDef[] = [
  {
    id: "happy-refund",
    title: "Happy path — $120 refund on ORD-1234",
    prompt:
      "Hi — I'd like a refund on order ORD-1234. The pour-over dripper arrived with a crack in it. It was $120.",
  },
  {
    id: "over-threshold-refund",
    title: "Hook block — $900 refund on ORD-7788",
    prompt:
      "Order ORD-7788, the walnut standing desk, turned up with a deep gouge across the top. I paid $900 and I want that money back on my card.",
  },
  {
    id: "outside-window",
    title: "Outside refund window — ORD-4521",
    prompt:
      "I want a refund for order ORD-4521. The merino blanket pilled badly and it's not what was described.",
  },
  {
    id: "credit-ceiling",
    title: "Store-credit ceiling reject — $2500 on ORD-9001",
    prompt:
      "Order ORD-9001, the framed print, is nothing like the listing. It was $2500 — please put the full amount on my account as store credit.",
  },
  {
    id: "transient-retry",
    title: "Transient gateway failure — ORD-5150",
    prompt:
      "Please refund order ORD-5150 — $300. The keyboard has two dead keys straight out of the box.",
  },
  {
    id: "unknown-order",
    title: "Unknown order — ORD-0000",
    prompt: "Can you refund order ORD-0000 for me? It was around $75 I think.",
  },
];

const SCENARIOS: ScenarioDef[] = LOCAL_SCENARIOS;

export interface ScenarioRunResult {
  scenarioId: string;
  title: string;
  prompt: string;
  sessionId: string;
  events: TraceEvent[];
  finalText: string;
  turns: number;
  error: string | null;
}

export function GET(): Response {
  return Response.json({ scenarios: SCENARIOS });
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    scenarioId?: unknown;
    sessionId?: unknown;
  };

  const scenarioId = typeof body.scenarioId === "string" ? body.scenarioId : "";
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) {
    return Response.json(
      {
        error: `Unknown scenarioId ${JSON.stringify(scenarioId)}.`,
        known: SCENARIOS.map((s) => s.id),
      },
      { status: 400 },
    );
  }

  // Deterministic, per-scenario namespace; override only if a caller insists.
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.trim()
      ? body.sessionId.trim()
      : `scenario:${scenario.id}`;

  // Clean fixtures for every run — no contamination between scenarios.
  resetSession(sessionId);

  const events: TraceEvent[] = [];
  const emit = (ev: TraceEvent): void => {
    events.push(ev);
  };

  let finalText = "";
  let turns = 0;
  let error: string | null = null;

  try {
    if (!(await credentialsAvailable())) throw new Error(MISSING_CREDENTIALS_MESSAGE);
    const result = await runAgent({
      sessionId,
      messages: [{ role: "user", content: scenario.prompt }],
      emit,
      signal: req.signal,
    });
    finalText = result.finalText;
    turns = result.turns;
  } catch (err) {
    error = describeError(err);
    emit({ t: "error", message: error });
  }

  // Terminate the event list the same way the SSE stream does, so the UI can
  // feed either source through one reducer.
  emit({ t: "done" });

  const payload: ScenarioRunResult = {
    scenarioId: scenario.id,
    title: scenario.title,
    prompt: scenario.prompt,
    sessionId,
    events,
    finalText,
    turns,
    error,
  };
  return Response.json(payload, {
    headers: { "Cache-Control": "no-store" },
  });
}
