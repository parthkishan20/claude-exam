/**
 * Anchor resolution — where a narration beat lands in a concrete trace.
 *
 * A beat never carries a raw event index. Replay and live produce different
 * traces for the same act (the model may narrate more, retry differently, or
 * batch its tool calls), and a beat pinned to index 12 would drift onto the
 * wrong event the first time that happens. So beats name a POSITION ("the
 * hook's block", "the second attempt") and this module turns that into an
 * index against the events actually in hand.
 *
 * Absence is a legitimate answer, not a failure: a `hook_block` anchor on a
 * trace where nothing was blocked resolves to null and the beat is simply not
 * shown. Narration that silently disappears is better than narration that
 * confidently points at the wrong line in front of a room.
 *
 * Pure module — no React, no I/O. The playback engine and the server both
 * import it.
 */
import type { AnchorResolver, Beat, BeatAnchor, ResolvedBeat } from "./types";
import type { ToolName, TraceEvent } from "@/lib/types";

/** tool_use ids belonging to calls of `name`, so results can be traced back. */
function toolUseIds(events: TraceEvent[], name: ToolName): Set<string> {
  const ids = new Set<string>();
  for (const e of events) if (e.t === "tool_use" && e.name === name) ids.add(e.id);
  return ids;
}

/**
 * `nth` is 1-based because beats are authored by a human reading a trace, and
 * "the 2nd issue_refund" is how they say it. Anything below 1 is coerced to
 * the first match rather than rejected — a typo in act data must not be able
 * to throw during a demo.
 */
function nthIndex(events: TraceEvent[], nth: number | undefined, match: (e: TraceEvent) => boolean): number | null {
  const want = Math.max(1, Math.trunc(nth ?? 1));
  let seen = 0;
  for (let i = 0; i < events.length; i++) {
    if (!match(events[i])) continue;
    seen += 1;
    if (seen === want) return i;
  }
  return null;
}

export const resolveAnchor: AnchorResolver = (anchor: BeatAnchor, events: TraceEvent[]): number | null => {
  // An empty trace has no positions at all — not even "start". Every branch
  // below would otherwise have to guard this separately.
  if (events.length === 0) return null;

  switch (anchor.kind) {
    case "start":
      return 0;

    case "end":
      return events.length - 1;

    case "index":
      // Clamped, not validated: a beat authored against a longer trace should
      // land on the last event rather than vanish.
      return Math.min(Math.max(0, Math.trunc(anchor.i)), events.length - 1);

    case "tool_use":
      return nthIndex(events, anchor.nth, (e) => e.t === "tool_use" && e.name === anchor.name);

    case "result": {
      // Results carry only a toolUseId, so the tool name has to come from the
      // matching tool_use earlier in the trace.
      const ids = toolUseIds(events, anchor.name);
      if (ids.size === 0) return null;
      return nthIndex(
        events,
        anchor.nth,
        (e) =>
          e.t === "tool_result" &&
          ids.has(e.toolUseId) &&
          (anchor.ok === undefined || e.envelope.success === anchor.ok),
      );
    }

    case "attempt":
      return nthIndex(events, 1, (e) => e.t === "attempt" && e.n === anchor.n);

    case "hook_block":
      return nthIndex(events, 1, (e) => e.t === "hook_verdict" && e.action === "block_and_escalate");

    case "escalation":
      return nthIndex(events, 1, (e) => e.t === "escalation_injected");
  }
};

/**
 * Resolve a whole act's beats against one trace.
 *
 * Beats whose anchor is absent are DROPPED — see the module note. The result
 * is sorted by trace position rather than by authored order, because the
 * playhead moves through the trace and a beat list that is not monotonic in
 * `index` would make the narration jump backwards. Ties keep authored order,
 * which is the only ordering information left when two beats share an event.
 */
export function resolveBeats(beats: Beat[], events: TraceEvent[]): ResolvedBeat[] {
  const resolved: { beat: ResolvedBeat; authored: number }[] = [];
  beats.forEach((beat, authored) => {
    const index = resolveAnchor(beat.at, events);
    if (index === null) return;
    resolved.push({ beat: { ...beat, index }, authored });
  });
  // Explicit tiebreak rather than relying on sort stability — the ordering of
  // two beats on the same event is a presentation decision, not an accident.
  resolved.sort((a, b) => a.beat.index - b.beat.index || a.authored - b.authored);
  return resolved.map((r) => r.beat);
}

/**
 * The beat the presenter should be reading at this playhead position: the last
 * one the playhead has passed. Before the first beat's event is revealed there
 * is no current beat, which is why the cursor starts at -1.
 */
export function currentBeat(resolved: ResolvedBeat[], cursor: number): ResolvedBeat | null {
  let current: ResolvedBeat | null = null;
  for (const beat of resolved) {
    if (beat.index > cursor) break;
    current = beat;
  }
  return current;
}
