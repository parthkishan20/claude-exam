"use client";

/**
 * TraceStage — the revealed trace, as a timeline, at presentation scale.
 *
 * Grouping is NOT re-implemented here: `buildTurns` from components/TraceEventRow
 * is the one authority on how a flat TraceEvent[] folds into turns and how
 * hook_verdict / attempt / tool_result / escalation_injected attach to the
 * tool_use they belong to. What this file adds is scale and a playhead.
 *
 * Finding the playhead without re-deriving buildTurns: buildTurns is
 * prefix-monotonic (a longer prefix only appends items or grows the last one),
 * so the item an event index lands on is simply the LAST item produced by
 * buildTurns over events.slice(0, index + 1). Two extra O(n) passes, zero
 * duplicated grouping logic.
 *
 * Three levels of emphasis, in increasing strength:
 *   normal  — revealed, settled.
 *   cursor  — the playhead is here right now (ink rail and ring).
 *   moment  — the point of the act (outcome-coloured rail, raised, persistent).
 *
 * Emphasis is ink, never a hue, so "you are here" can never be mistaken for
 * "this row failed" from the back of a room.
 */
import { useEffect, useMemo, useRef } from "react";
import type { TraceStageProps } from "@/lib/demo/types";
import type { ToolResultEnvelope, TraceEvent } from "@/lib/types";
import { buildTurns, type ToolBlock, type TraceItem } from "@/components/TraceEventRow";
import { TRACE_TOKENS } from "./FlowDiagram";

/* ------------------------------------------------------------------ *
 * playhead position
 * ------------------------------------------------------------------ */

/** "<groupIndex>:<itemIndex>" of the last item buildTurns produces, or null. */
function lastPos(events: TraceEvent[]): string | null {
  const groups = buildTurns(events);
  for (let g = groups.length - 1; g >= 0; g--) {
    const n = groups[g].items.length;
    if (n > 0) return `${g}:${n - 1}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * glyphs — same paths as TraceEventRow, so the vocabulary is literally shared
 * ------------------------------------------------------------------ */

type GlyphName = "lock" | "alert" | "check" | "route" | "dot";

function Glyph({ name, className = "" }: { name: GlyphName; className?: string }) {
  const c = `h-5 w-5 shrink-0 ${className}`;
  switch (name) {
    case "lock":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M10 1a4 4 0 00-4 4v2H5a2 2 0 00-2 2v7a2 2 0 002 2h10a2 2 0 002-2V9a2 2 0 00-2-2h-1V5a4 4 0 00-4-4zm2 6V5a2 2 0 10-4 0v2h4z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "alert":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "check":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path
            fillRule="evenodd"
            d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.052-.143z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "route":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <path d="M7 3a3 3 0 00-3 3v6.17a3.001 3.001 0 101.5 0V6A1.5 1.5 0 017 4.5h4.879l-1.44 1.44a.75.75 0 101.061 1.06l2.75-2.75a.75.75 0 000-1.06l-2.75-2.75a.75.75 0 10-1.06 1.06L11.878 3H7z" />
        </svg>
      );
    case "dot":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <circle cx="10" cy="10" r="4" />
        </svg>
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * tool block status — mirrors TraceEventRow's taxonomy exactly
 * ------------------------------------------------------------------ */

type BlockStatus = "blocked" | "failed-validation" | "failed-transient" | "ok" | "pending";

function blockStatus(b: ToolBlock): BlockStatus {
  if (b.verdict?.action === "block_and_escalate") return "blocked";
  const last = b.results[b.results.length - 1];
  if (!last) return "pending";
  if (last.envelope.success) return "ok";
  const cat = last.envelope.errorCategory;
  if (cat === "permission") return "blocked";
  if (cat === "transient") return "failed-transient";
  return "failed-validation";
}

const STATUS: Record<
  BlockStatus,
  { wrap: string; badge: string; label: string; icon: GlyphName; tint: string; rail: string }
> = {
  blocked: {
    wrap: "border-[var(--t-block)] bg-[var(--t-block-soft)]",
    badge: "bg-[var(--t-block-hot)] text-white",
    label: "Blocked by policy",
    icon: "lock",
    tint: "text-[var(--t-block)]",
    rail: "bg-[var(--t-block)]",
  },
  "failed-validation": {
    wrap: "border-[var(--t-reject)] bg-[var(--t-reject-soft)]",
    badge: "bg-[var(--t-reject)] text-[var(--t-on-fill)]",
    label: "Rejected by the handler",
    icon: "alert",
    tint: "text-[var(--t-reject)]",
    rail: "bg-[var(--t-reject)]",
  },
  "failed-transient": {
    wrap: "border-[var(--t-transient)] bg-[var(--t-transient-soft)]",
    badge: "bg-[var(--t-transient)] text-[var(--t-on-fill)]",
    label: "Transient failure",
    icon: "alert",
    tint: "text-[var(--t-transient)]",
    rail: "bg-[var(--t-transient)]",
  },
  ok: {
    wrap: "border-[var(--t-ok)] bg-[var(--t-ok-soft)]",
    badge: "bg-[var(--t-ok)] text-[var(--t-on-fill)]",
    label: "OK",
    icon: "check",
    tint: "text-[var(--t-ok)]",
    rail: "bg-[var(--t-ok)]",
  },
  pending: {
    wrap: "border-[var(--t-line)] bg-[var(--t-panel)]",
    badge: "bg-[var(--t-line)] text-[var(--t-ink-2)]",
    label: "Running",
    icon: "dot",
    tint: "text-[var(--t-ink-2)]",
    rail: "bg-[var(--t-now)]",
  },
};

/* ------------------------------------------------------------------ *
 * pieces
 * ------------------------------------------------------------------ */

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  return String(v);
}

/** Tool arguments as chips. At projector distance a wrapped key/value strip
 *  reads far better than a pretty-printed JSON block. */
function Arguments({ input }: { input: unknown }) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return (
      <code className="block overflow-x-auto rounded-[var(--t-r)] bg-[var(--t-raise)] px-3 py-2 font-mono text-sm text-[var(--t-ink-2)]">
        {JSON.stringify(input)}
      </code>
    );
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) {
    return <span className="text-sm text-[var(--t-ink-3)]">no arguments</span>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex max-w-full items-baseline gap-2 rounded-[var(--t-r)] bg-[var(--t-raise)] px-3 py-1.5"
        >
          <span className="font-mono text-xs text-[var(--t-ink-2)]">{k}</span>
          <span className="truncate font-mono text-sm font-semibold text-[var(--t-ink)]">
            {fmtValue(v)}
          </span>
        </span>
      ))}
    </div>
  );
}

function ResultRow({
  envelope,
  ms,
  blocked,
}: {
  envelope: ToolResultEnvelope;
  ms: number;
  blocked: boolean;
}) {
  if (envelope.success) {
    const { success: _ok, ...fields } = envelope;
    void _ok;
    return (
      <div className="rounded-[var(--t-r)] border border-[var(--t-line)] bg-[var(--t-panel)] px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--t-ok)]">
          <Glyph name="check" className="h-4 w-4" />
          result
          <span className="font-mono normal-case tracking-normal text-[var(--t-ink-3)]">
            {ms} ms
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
          {Object.entries(fields).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--t-ink-2)]">{k}</dt>
              <dd className="break-all text-[var(--t-ink)]">{fmtValue(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const tint = blocked
    ? "text-[var(--t-block)]"
    : envelope.errorCategory === "transient"
      ? "text-[var(--t-transient)]"
      : "text-[var(--t-reject)]";

  return (
    <div className="rounded-[var(--t-r)] border border-[var(--t-line)] bg-[var(--t-panel)] px-4 py-3">
      <div className={`flex items-center gap-2 text-xs font-semibold uppercase tracking-wide ${tint}`}>
        <Glyph name={blocked ? "lock" : "alert"} className="h-4 w-4" />
        {envelope.errorCategory} {blocked ? "block" : "failure"}
        <span className="font-mono normal-case tracking-normal text-[var(--t-ink-3)]">
          {ms} ms
        </span>
      </div>
      <p className="mt-1.5 max-w-[70ch] text-base leading-relaxed text-[var(--t-ink-2)]">
        {envelope.message}
      </p>
    </div>
  );
}

function ToolCard({ block }: { block: ToolBlock }) {
  const status = blockStatus(block);
  const s = STATUS[status];
  const permResult = block.results.find(
    (r) => !r.envelope.success && r.envelope.errorCategory === "permission",
  );
  const receipt =
    permResult && !permResult.envelope.success ? permResult.envelope.escalation : undefined;
  const retried = block.attempts.length > 1 || (block.attempts[0]?.of ?? 1) > 1;

  return (
    <div className={`overflow-hidden rounded-[var(--t-r)] border-2 ${s.wrap}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Glyph name={s.icon} className={s.tint} />
        <code className="font-mono text-lg font-semibold text-[var(--t-ink)]">{block.name}</code>
        <span
          className={`rounded-[var(--t-r)] px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${s.badge}`}
        >
          {s.label}
        </span>
        {block.verdict?.action === "allow" && (
          <span className="rounded-[var(--t-r)] bg-[var(--t-raise)] px-2.5 py-1 text-xs font-medium text-[var(--t-ink-2)]">
            policy check passed
          </span>
        )}
        {status === "blocked" && block.verdict?.ruleId && (
          <code className="rounded-[var(--t-r)] bg-[var(--t-block-hot)] px-2.5 py-1 font-mono text-xs font-semibold text-white">
            rule: {block.verdict.ruleId}
          </code>
        )}
      </div>

      <div className="px-4 pb-3">
        <Arguments input={block.input} />
      </div>

      {block.attempts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {block.attempts.map((a, i) => (
            <span
              key={i}
              className={`rounded-[var(--t-r)] px-2.5 py-1 font-mono text-xs ${
                retried
                  ? "bg-[var(--t-transient-soft)] text-[var(--t-transient)]"
                  : "bg-[var(--t-raise)] text-[var(--t-ink-2)]"
              }`}
            >
              attempt {a.n}/{a.of}
              {a.retryAfterMs ? ` · waited ${a.retryAfterMs}ms` : ""}
            </span>
          ))}
          {retried && (
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--t-transient)]">
              transient retry
            </span>
          )}
        </div>
      )}

      {block.results.length > 0 && (
        <div className="space-y-2 px-4 pb-3">
          {block.results.map((r, i) => (
            <ResultRow key={i} envelope={r.envelope} ms={r.ms} blocked={status === "blocked"} />
          ))}
        </div>
      )}

      {(block.escalation || receipt) && (
        <div className="mx-4 mb-4 border-l-[3px] border-[var(--t-route)] bg-[var(--t-route-soft)] px-4 py-3">
          <div className="flex items-center gap-2 text-[var(--t-route)]">
            <Glyph name="route" className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">
              System routed this to a human
            </span>
          </div>
          <div className="mt-1.5 space-y-0.5 font-mono text-sm text-[var(--t-ink)]">
            {block.escalation && <div>escalation_id: {block.escalation.escalationId}</div>}
            {block.escalation && <div>blocked_reason: {block.escalation.blockedReason}</div>}
            {receipt && (
              <div>
                queue: {receipt.assigned_queue} · eta {receipt.eta_hours}h
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ItemBody({ item }: { item: TraceItem }) {
  switch (item.kind) {
    case "thinking":
      return (
        <div className="rounded-[var(--t-r)] border border-[var(--t-line-soft)] bg-[var(--t-panel)] px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--t-ink-3)]">
            thinking
          </div>
          <p className="mt-1 max-w-[70ch] whitespace-pre-wrap text-base leading-relaxed text-[var(--t-ink-2)]">
            {item.text}
          </p>
        </div>
      );
    case "text":
      return (
        <div className="rounded-[var(--t-r)] border border-[var(--t-line)] bg-[var(--t-panel)] px-4 py-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--t-ink-3)]">
            assistant
          </div>
          <p className="mt-1 max-w-[70ch] whitespace-pre-wrap text-lg leading-relaxed text-[var(--t-ink)]">
            {item.text}
          </p>
        </div>
      );
    case "tool":
      return <ToolCard block={item.block} />;
    case "turn_end":
      return (
        <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-wide text-[var(--t-ink-3)]">
          <span className="h-px flex-1 bg-[var(--t-line-soft)]" />
          turn ended · stop {item.stopReason ?? "none"} · tok {item.usage.input} to{" "}
          {item.usage.output}
          <span className="h-px flex-1 bg-[var(--t-line-soft)]" />
        </div>
      );
    case "done":
      return (
        <div className="text-center text-xs uppercase tracking-wide text-[var(--t-ink-3)]">
          stream complete
        </div>
      );
    case "error":
      return (
        <div className="rounded-[var(--t-r)] border-2 border-[var(--t-block)] bg-[var(--t-block-soft)] px-4 py-3 text-base font-semibold text-[var(--t-ink)]">
          error: {item.message}
        </div>
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * component
 * ------------------------------------------------------------------ */

const CSS = `
@keyframes demo-stage-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
.demo-stage-moment {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--t-ink) 14%, transparent),
              0 18px 44px rgba(0, 0, 0, 0.55);
}
.demo-stage-cursor {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--t-now) 65%, transparent);
}
@media (prefers-reduced-motion: no-preference) {
  .demo-stage-item { animation: demo-stage-in 320ms cubic-bezier(0.16, 1, 0.3, 1) both; }
}
`;

export default function TraceStage({ visible, cursor, momentIndex }: TraceStageProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  const turns = useMemo(() => buildTurns(visible), [visible]);
  const cursorPos = useMemo(() => lastPos(visible), [visible]);
  const momentPos = useMemo(() => {
    if (momentIndex === null || momentIndex < 0 || momentIndex > cursor) return null;
    return lastPos(visible.slice(0, momentIndex + 1)) ?? "0:0";
  }, [visible, cursor, momentIndex]);

  // Keep the playhead in view. Scoped to this scroller (never the page) and
  // only when the cursor has drifted out of the comfortable band, so the
  // viewport is nudged rather than yanked.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const el = cursorRef.current;
    if (!scroller || !el) return;

    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduce ? "auto" : "smooth";

    const box = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 32;

    if (r.bottom > box.bottom - pad) {
      scroller.scrollTo({ top: scroller.scrollTop + (r.bottom - box.bottom) + pad, behavior });
    } else if (r.top < box.top + pad) {
      scroller.scrollTo({ top: scroller.scrollTop + (r.top - box.top) - pad, behavior });
    }
  }, [cursorPos, visible.length]);

  return (
    <div
      ref={scrollerRef}
      className="demo-trace h-full overflow-y-auto overscroll-contain px-1 py-2"
    >
      <style href="demo-trace-tokens" precedence="medium">
        {TRACE_TOKENS}
      </style>
      <style href="demo-trace-stage" precedence="medium">
        {CSS}
      </style>

      {turns.length === 0 ? (
        <div className="mx-auto mt-16 max-w-md text-center">
          <p className="text-lg font-medium text-[var(--t-ink-2)]">Nothing revealed yet.</p>
          <p className="mt-2 text-base leading-relaxed text-[var(--t-ink-3)]">
            The real trace fills in one event at a time: the tool the model picks, the hook&apos;s
            verdict on it, every retry, and what the handler returned.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {turns.map((group, g) => (
            <section key={g}>
              <div className="mb-3 flex items-center gap-3">
                <span className="rounded-[var(--t-r)] bg-[var(--t-raise)] px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--t-ink-2)]">
                  Turn {group.turn ?? "?"}
                </span>
                <span className="h-px flex-1 bg-[var(--t-line-soft)]" />
              </div>

              <div className="space-y-3">
                {group.items.map((item, i) => {
                  const pos = `${g}:${i}`;
                  const isCursor = pos === cursorPos;
                  const isMoment = pos === momentPos;
                  const rail = isMoment
                    ? item.kind === "tool"
                      ? STATUS[blockStatus(item.block)].rail
                      : "bg-[var(--t-route)]"
                    : isCursor
                      ? "bg-[var(--t-now)]"
                      : "bg-transparent";

                  return (
                    <div
                      key={pos}
                      ref={isCursor ? cursorRef : undefined}
                      className={`demo-stage-item flex gap-3 rounded-[var(--t-r)] p-2 motion-safe:transition-shadow motion-safe:duration-300 ${
                        isMoment
                          ? "demo-stage-moment bg-[var(--t-raise)]"
                          : isCursor
                            ? "demo-stage-cursor"
                            : ""
                      }`}
                    >
                      {/* hairline playhead / moment rail — square, per the stage radius rule */}
                      <span
                        aria-hidden
                        className={`shrink-0 ${rail} ${
                          isMoment ? "w-1.5" : "w-1"
                        } motion-safe:transition-colors`}
                      />
                      {/* No "this is the moment" label here. When the moment
                          beat is current, NarrationCard is already carrying
                          those words 250px up the same screen, and saying it
                          twice cheapens it. The raised surface, the ring and
                          the thick outcome rail carry it on their own, and
                          unlike the narration they persist after the playhead
                          moves on. */}
                      <div className="min-w-0 flex-1">
                        <ItemBody item={item} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
