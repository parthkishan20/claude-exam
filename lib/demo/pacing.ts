/**
 * Pacing — how long the playhead rests on an event before it advances.
 *
 * Pure, React-free and therefore testable: the demo's credibility rests on the
 * audience being able to SEE the hook verdict land, and that is a timing
 * property, not a rendering one. Keeping it here means __tests__/pacing.test.ts
 * can pin the rhythm without a browser.
 *
 * The rhythm we are after, and why:
 *
 *   - `hook_verdict` (block), `escalation_injected` and a FAILING `tool_result`
 *     are the beats the whole demo exists for. They get ~1.8–2.2s — long enough
 *     for a presenter to say a sentence over them and for the back row to read
 *     the rule id off the screen.
 *   - `tool_use` and `attempt` are medium (~0.85–1.0s): the audience needs to
 *     register WHICH tool with WHAT input, but nothing is decided yet. A retry
 *     (`attempt` with n > 1) is an exception — it IS the point of the retry act,
 *     so it gets a long beat of its own.
 *   - `text_delta` / `thinking_delta` are quick (~120ms). They arrive by the
 *     hundred from a real stream; anything slower and the prose crawls, anything
 *     faster and it stops reading like the model is talking.
 *   - `turn_start` / `turn_end` / `done` are short punctuation, not content.
 *
 * Calibration: a full streamed act — five model turns, ~180 prose deltas, three
 * tool calls, a retry, one block and one escalation — lands just under 50s at
 * speed 1, inside the 40–70s the act gets on stage (__tests__/pacing.test.ts
 * pins that). Short hand-written fixtures run faster, and that is fine: these
 * numbers are tuned for what a real run actually streams.
 */
import type { TraceEvent } from "@/lib/types";

const DWELL = {
  turnStart: 600,
  turnEnd: 800,
  done: 1100,
  /**
   * Prose, per chunk. lib/loop.ts forwards the model API's own text deltas, so
   * a chunk is a few tokens and there are ~180 of them in a full act — this is
   * the one number that moves an act's total length appreciably.
   */
  delta: 140,
  toolUse: 1100,
  attempt: 900,
  /** A retry is a mechanism the audience came to see, not a repeat. */
  retryAttempt: 1300,
  verdictAllow: 700,
  verdictBlock: 2000,
  resultOk: 1100,
  resultFail: 1800,
  escalation: 2200,
  error: 2000,
} as const;

/** Dwell for one event at speed 1, in ms. Always > 0 so the playhead can't stall. */
export function dwellMs(ev: TraceEvent): number {
  switch (ev.t) {
    case "turn_start":
      return DWELL.turnStart;
    case "turn_end":
      return DWELL.turnEnd;
    case "done":
      return DWELL.done;
    case "text_delta":
    case "thinking_delta":
      return DWELL.delta;
    case "tool_use":
      return DWELL.toolUse;
    case "attempt":
      return ev.n > 1 ? DWELL.retryAttempt : DWELL.attempt;
    case "hook_verdict":
      return ev.action === "block_and_escalate" ? DWELL.verdictBlock : DWELL.verdictAllow;
    case "tool_result":
      return ev.ok ? DWELL.resultOk : DWELL.resultFail;
    case "escalation_injected":
      return DWELL.escalation;
    case "error":
      return DWELL.error;
  }
}

/**
 * Time from the start of playback (cursor -1) until event `index` is revealed.
 *
 * The playhead waits the dwell of the event it is ABOUT to reveal — the same
 * rule usePlayback schedules on — so the elapsed time at index i is the sum of
 * dwells 0..i. `index < 0` is the pre-roll position and costs nothing.
 */
export function elapsedAt(events: TraceEvent[], index: number, speed: number): number {
  const last = Math.min(Math.floor(index), events.length - 1);
  if (last < 0 || speed <= 0) return 0;
  let ms = 0;
  for (let i = 0; i <= last; i++) ms += dwellMs(events[i]);
  return ms / speed;
}

/** Wall-clock length of the whole act at `speed`. */
export function totalMs(events: TraceEvent[], speed: number): number {
  return elapsedAt(events, events.length - 1, speed);
}

/**
 * Inverse of `elapsedAt`, for a scrubber: the index the playhead is on at `ms`.
 * Returns -1 before the first event is due, and the last index once time is up.
 */
export function indexAt(events: TraceEvent[], ms: number, speed: number): number {
  if (speed <= 0 || events.length === 0) return -1;
  const target = ms * speed;
  if (target < 0) return -1;
  let acc = 0;
  for (let i = 0; i < events.length; i++) {
    acc += dwellMs(events[i]);
    // `>` not `>=`: at exactly elapsedAt(i) the playhead has just landed on i,
    // which is what makes indexAt(elapsedAt(i)) === i a round trip.
    if (acc > target) return i - 1;
  }
  return events.length - 1;
}
