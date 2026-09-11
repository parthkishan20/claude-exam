/**
 * Two ways to produce a scenario trace, one assertion path.
 *
 *   runLive     — drives the real model through lib/loop.ts::runAgent
 *   runScripted — drives evals/scriptedModel.ts through the REAL dispatch()
 *                 pipeline (hook + handlers + retry + audit), no credentials
 *
 * Both return `{ events, world }`; evals/scenarios.ts::expect() consumes either.
 */
import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { dispatch } from "@/lib/dispatch";
import { credentialsAvailable, runAgent } from "@/lib/loop";
import { getSession, resetSession } from "@/lib/store/db";
import type { Emit, ToolResultEnvelope, TraceEvent } from "@/lib/types";
import { isFailure } from "@/lib/types";
import { snapshotWorld, type EvalWorld } from "./assertions";
import { SCRIPTS, type ScriptedTurn } from "./scriptedModel";
import type { Scenario } from "./scenarios";

export interface TraceRun {
  events: TraceEvent[];
  world: EvalWorld;
  finalText: string;
}

/* ------------------------------------------------------------------ *
 * Scripted (offline) path
 * ------------------------------------------------------------------ */

export async function runScripted(scenario: Scenario): Promise<TraceRun> {
  const script = SCRIPTS[scenario.id];
  if (!script) throw new Error(`No script for scenario "${scenario.id}"`);

  const sessionId = `eval:scripted:${scenario.id}`;
  resetSession(sessionId);

  const events: TraceEvent[] = [];
  const emit: Emit = (ev) => events.push(ev);
  let finalText = "";

  let turnNo = 0;
  for (const turn of script) {
    turnNo += 1;
    emit({ t: "turn_start", turn: turnNo });
    if (turn.text) {
      emit({ t: "text_delta", text: turn.text });
      finalText = turn.text;
    }

    // Deterministic ids so recorded fixtures are byte-stable across runs and a
    // fixture diff only ever reflects a real behaviour change.
    const toolUses = (turn.toolUses ?? []).map((tu, i) => ({
      id: `toolu_${scenario.id}_${turnNo}_${i}`,
      ...tu,
    }));

    emit({
      t: "turn_end",
      stopReason: toolUses.length ? "tool_use" : "end_turn",
      usage: { input: 0, output: 0 },
    });

    // A text-only turn is an end_turn pause in a real run — here the script
    // already encodes the whole sequence, so just move to the next turn.
    if (toolUses.length === 0) continue;

    // Same shape as lib/loop.ts: parallel blocks buffer, flush in order.
    const parallel = toolUses.length > 1;
    const buffers: TraceEvent[][] = toolUses.map(() => []);
    const envelopes: ToolResultEnvelope[] = await Promise.all(
      toolUses.map((block, i) => {
        const localEmit: Emit = parallel ? (ev) => buffers[i].push(ev) : emit;
        return dispatch(
          { id: block.id, name: block.name, input: block.input },
          { sessionId, emit: localEmit },
        );
      }),
    );
    if (parallel) for (const buf of buffers) for (const ev of buf) emit(ev);
    void envelopes.map(isFailure); // touch the guard so the import is load-bearing
  }

  emit({ t: "done" });
  return { events, world: snapshotWorld(getSession(sessionId)), finalText };
}

/* ------------------------------------------------------------------ *
 * Live path
 * ------------------------------------------------------------------ */

export async function liveAvailable(): Promise<boolean> {
  return credentialsAvailable();
}

export async function runLive(scenario: Scenario): Promise<TraceRun> {
  const sessionId = `eval:live:${scenario.id}:${randomUUID().slice(0, 8)}`;
  resetSession(sessionId);

  const events: TraceEvent[] = [];
  const emit: Emit = (ev) => events.push(ev);

  // Multi-turn scenarios: the customer's later turns are appended as the
  // conversation progresses.
  let messages: Anthropic.MessageParam[] = [];
  let finalText = "";
  for (const turn of scenario.turns) {
    messages = [...messages, { role: "user", content: turn }];
    const res = await runAgent({ sessionId, messages, emit });
    messages = res.messages;
    finalText = res.finalText || finalText;
  }
  emit({ t: "done" });
  return { events, world: snapshotWorld(getSession(sessionId)), finalText };
}

/* ------------------------------------------------------------------ *
 * Fixture (pure regression) path — asserts against a recorded trace,
 * runs no backend code at all.
 * ------------------------------------------------------------------ */

export function runFromFixture(scenarioId: string, raw: unknown): TraceRun {
  const f = raw as { events?: TraceEvent[]; world?: EvalWorld; finalText?: string };
  if (!f || !Array.isArray(f.events) || !f.world) {
    throw new Error(`Fixture for "${scenarioId}" is malformed`);
  }
  return { events: f.events, world: f.world, finalText: f.finalText ?? "" };
}

/** Convenience wrapper — scripted turn count, for logging. */
export function scriptTurnCount(scenarioId: string): number {
  return (SCRIPTS[scenarioId] as ScriptedTurn[] | undefined)?.length ?? 0;
}
