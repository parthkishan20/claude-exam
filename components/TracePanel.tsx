"use client";

/**
 * TracePanel — a live, auto-scrolling list of the current turn's trace events,
 * grouped under their turn (turn_start … turn_end). Row treatments live in
 * TraceEventRow; grouping / event-to-tool attachment lives in buildTurns.
 */
import { useEffect, useRef } from "react";
import type { TraceEvent } from "@/lib/types";
import { buildTurns, TraceEventRow } from "./TraceEventRow";

export default function TracePanel({ events }: { events: TraceEvent[] }) {
  const turns = buildTurns(events);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div ref={ref} className="h-full overflow-y-auto bg-slate-50 px-4 py-4">
      {turns.length === 0 ? (
        <div className="mx-auto mt-10 max-w-sm text-center text-sm text-slate-400">
          No trace yet. Send a message or run a scenario — tool calls, hook verdicts,
          retries and escalations stream in here.
        </div>
      ) : (
        <div className="space-y-5">
          {turns.map((g, i) => (
            <section key={i}>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                  Turn {g.turn ?? "—"}
                </span>
                <span className="h-px flex-1 bg-slate-200" />
              </div>
              <div className="space-y-2">
                {g.items.map((item, j) => (
                  <TraceEventRow key={j} item={item} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
