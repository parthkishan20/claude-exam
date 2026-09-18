"use client";

/**
 * FlowDiagram — the spine of the demo: the request path, drawn once so the
 * audience can hold it in their head.
 *
 *     model -> hook -> retry -> handler -> store
 *
 * The one thing it exists to make unmissable is the asymmetry documented at the
 * top of lib/config.ts. When the hook BLOCKS, the path does not merely change
 * colour, it TERMINATES: a wall is drawn across the track at the hook, every
 * stage downstream reads "not reached", and the status band underneath starts
 * at the wall's own grid column and runs to the end of the diagram, so the
 * region that never happened is literally underlined, with the rule id sitting
 * at the band's left edge, directly below the wall.
 *
 * A handler-side REJECT is deliberately drawn differently. The handler ran, so
 * there is no wall; the track runs out of road in amber. Blocking and rejecting
 * are different outcomes with different governance, and this diagram refuses to
 * collapse them into "another colour".
 *
 * FIXED HEIGHT BY CONSTRUCTION (94px, 118px when the band wraps; measured). It sits shrink-0 between the narration
 * card and the trace stage, and every pixel it takes comes out of TraceStage, so
 * it is always two rows: the spine, and one status line that is always present
 * (the block band, the reject band, or the in-flight tool). It never stacks
 * vertically either; below its natural width it scrolls horizontally rather than
 * growing taller.
 */
import type { FlowDiagramProps, FlowStage, FlowStageState } from "@/lib/demo/types";

/* ------------------------------------------------------------------ *
 * Shared stage tokens.
 *
 * Emitted by all five components under one href, so React hoists and dedupes
 * to a single <style> in head (this is what `precedence` buys). Aliases
 * demo.css where it defines a token, with a literal fallback so a component
 * still renders correctly outside .demo-root.
 *
 * The outcome palette is components/TraceEventRow.tsx's, translated to dark
 * surfaces: rose = the hook blocked it, amber = the handler rejected it,
 * orange = transient, emerald = ok, violet = escalation. The demo and the
 * dev-tool must not disagree about what "blocked" looks like.
 *
 * "Now" (--t-now) is deliberately NOT a hue: it is bright ink. Amber in this
 * codebase already means "the handler returned a failure", so an amber playhead
 * would compete with it under a projector lamp, where hue is the first thing to
 * go. Ink for emphasis and hue for outcome can never be confused from the back
 * of a room, and it leaves the shell's --signal free for transport chrome.
 * ------------------------------------------------------------------ */
export const TRACE_TOKENS = `
.demo-trace {
  --t-panel: var(--stage-panel, #12161c);
  --t-raise: var(--stage-raise, #171c24);
  --t-line: var(--stage-line, #242c38);
  --t-line-soft: var(--stage-line-soft, #1a212a);
  --t-ink: var(--stage-ink, #eef2f7);
  --t-ink-2: var(--stage-ink-2, #9aa5b5);
  --t-ink-3: var(--stage-ink-3, #5f6a79);
  --t-on-fill: var(--stage-bg, #0b0d11);
  --t-r: var(--r, 6px);

  /* "happening now" — ink, so emphasis can never be read as an outcome */
  --t-now: var(--stage-ink, #eef2f7);
  --t-now-soft: rgba(238, 242, 247, 0.09);

  /* outcomes, from TraceEventRow */
  --t-ok: #34d399;
  --t-ok-soft: rgba(52, 211, 153, 0.12);
  --t-block: #fb7185;
  --t-block-hot: #f43f5e;
  --t-block-soft: rgba(244, 63, 94, 0.15);
  --t-reject: #e9a13b;
  --t-reject-soft: rgba(233, 161, 59, 0.13);
  --t-transient: #ef8b53;
  --t-transient-soft: rgba(239, 139, 83, 0.13);
  --t-route: #a78bfa;
  --t-route-soft: rgba(167, 139, 250, 0.14);
}
`;

/* ------------------------------------------------------------------ *
 * stage metadata
 * ------------------------------------------------------------------ */

const STAGES: ReadonlyArray<{ id: FlowStage; label: string; role: string }> = [
  { id: "model", label: "model", role: "picks a tool" },
  { id: "hook", label: "hook", role: "policy gate" },
  { id: "retry", label: "retry", role: "transient policy" },
  { id: "handler", label: "handler", role: "the tool code" },
  { id: "store", label: "store", role: "the world" },
];

/* ------------------------------------------------------------------ *
 * glyphs — same paths as TraceEventRow so blocked/failed/ok read identically
 * ------------------------------------------------------------------ */

type GlyphName = "lock" | "alert" | "check" | "dot" | "ring";

function Glyph({ name, className = "" }: { name: GlyphName; className?: string }) {
  const c = `shrink-0 ${className || "h-4 w-4"}`;
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
    case "dot":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          <circle cx="10" cy="10" r="4.5" />
        </svg>
      );
    case "ring":
      return (
        <svg className={c} viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden>
          <circle cx="10" cy="10" r="4.5" strokeWidth="1.75" strokeDasharray="3 2.5" />
        </svg>
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * node treatments
 * ------------------------------------------------------------------ */

interface NodeStyle {
  box: string;
  label: string;
  role: string;
  mark: string;
  icon: GlyphName;
  pulse: boolean;
}

const NODE: Record<FlowStageState, NodeStyle> = {
  idle: {
    box: "border-dashed border-[var(--t-line)] bg-transparent",
    label: "text-[var(--t-ink-3)]",
    role: "text-[var(--t-ink-3)]",
    mark: "text-[var(--t-line)]",
    icon: "ring",
    pulse: false,
  },
  active: {
    // ink + pulse, not a hue: "live" must not look like "the handler failed"
    box: "border-solid border-[var(--t-now)] bg-[var(--t-now-soft)]",
    label: "text-[var(--t-ink)]",
    role: "text-[var(--t-ink)]",
    mark: "text-[var(--t-ink)]",
    icon: "dot",
    pulse: true,
  },
  passed: {
    box: "border-solid border-[var(--t-ok)] bg-[var(--t-ok-soft)]",
    label: "text-[var(--t-ink)]",
    role: "text-[var(--t-ok)]",
    mark: "text-[var(--t-ok)]",
    icon: "check",
    pulse: false,
  },
  blocked: {
    box: "demo-flow-blocked border-solid border-[var(--t-block)] bg-[var(--t-block-soft)]",
    label: "text-[var(--t-ink)]",
    role: "text-[var(--t-block)]",
    mark: "text-[var(--t-block)]",
    icon: "lock",
    pulse: false,
  },
  failed: {
    box: "border-solid border-[var(--t-reject)] bg-[var(--t-reject-soft)]",
    label: "text-[var(--t-ink)]",
    role: "text-[var(--t-reject)]",
    mark: "text-[var(--t-reject)]",
    icon: "alert",
    pulse: false,
  },
};

/* ------------------------------------------------------------------ *
 * connectors
 *
 * `severed` is the whole point of this component and is the only variant that
 * draws a wall. `spent` (the track after a handler failure) runs out instead:
 * the call was not stopped by governance, it just came back with an error.
 * ------------------------------------------------------------------ */

type ConnState = "dormant" | "march" | "live" | "spent" | "severed";

function connState(left: FlowStageState, right: FlowStageState): ConnState {
  if (left === "blocked") return "severed";
  if (left === "failed") return "spent";
  if (right === "active") return "march";
  if (left === "passed" && right !== "idle") return "live";
  return "dormant";
}

function Connector({ state }: { state: ConnState }) {
  if (state === "severed") {
    return (
      <div className="flex items-center">
        <span className="h-[2px] flex-1 bg-[var(--t-block)]" />
        {/* the wall. the path physically stops here. */}
        <span className="demo-flow-wall mx-1 h-8 w-[5px]" />
        <span className="demo-flow-track h-[2px] flex-1 text-[var(--t-line)]" />
      </div>
    );
  }

  if (state === "spent") {
    return (
      <div className="flex items-center">
        <span className="demo-flow-track h-[2px] flex-1 text-[var(--t-reject)]" />
        <Glyph name="alert" className="mx-1 h-3.5 w-3.5 text-[var(--t-reject)]" />
        <span className="demo-flow-track h-[2px] flex-1 text-[var(--t-line)]" />
      </div>
    );
  }

  const tone =
    state === "live"
      ? "bg-[var(--t-ok)]"
      : state === "march"
        ? "demo-flow-track demo-flow-march text-[var(--t-now)]"
        : "demo-flow-track text-[var(--t-line)]";

  return (
    <div className="flex items-center">
      <span className={`h-[2px] flex-1 ${tone}`} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * node
 * ------------------------------------------------------------------ */

function Node({
  label,
  role,
  state,
  unreached,
}: {
  label: string;
  role: string;
  state: FlowStageState;
  unreached: boolean;
}) {
  const s = NODE[state];
  return (
    <div
      className={`flex flex-col items-center gap-0.5 whitespace-nowrap rounded-[var(--t-r)] border-2 px-3 py-1.5 text-center motion-safe:transition-colors motion-safe:duration-300 ${s.box} ${
        unreached ? "opacity-40" : ""
      } ${s.pulse ? "demo-flow-pulse" : ""}`}
    >
      <div className="flex items-center gap-1.5">
        <Glyph name={s.icon} className={`h-4 w-4 ${s.mark}`} />
        <span className={`font-mono text-base font-semibold leading-tight ${s.label}`}>
          {label}
        </span>
      </div>
      <span
        className={`text-[11px] leading-tight ${
          unreached ? "font-semibold text-[var(--t-block)]" : s.role
        }`}
      >
        {unreached ? "not reached" : role}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * component
 * ------------------------------------------------------------------ */

const CSS = `
.demo-flow-track {
  background-image: repeating-linear-gradient(to right, currentColor 0 6px, transparent 6px 14px);
}
.demo-flow-wall {
  background: var(--t-block-hot);
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--t-block) 22%, transparent);
}
.demo-flow-blocked {
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--t-block) 45%, transparent),
              0 8px 26px color-mix(in srgb, var(--t-block) 18%, transparent);
}
.demo-flow-band { grid-column: var(--band-start, 1) / -1; grid-row: 2; }
@keyframes demo-flow-march { to { background-position: 14px 0; } }
@keyframes demo-flow-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--t-now) 30%, transparent); }
  50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--t-now) 0%, transparent); }
}
@media (prefers-reduced-motion: no-preference) {
  .demo-flow-march { animation: demo-flow-march 900ms linear infinite; }
  .demo-flow-pulse { animation: demo-flow-pulse 1.8s ease-in-out infinite; }
}
`;

export default function FlowDiagram({ stages, toolName, blockedRuleId }: FlowDiagramProps) {
  const states = STAGES.map((s) => stages[s.id]);

  // First stage that stopped the path. Everything after it that is still idle
  // was never reached, and says so in words.
  const stopIdx = states.findIndex((s) => s === "blocked" || s === "failed");
  const stopped = stopIdx >= 0 ? states[stopIdx] : null;
  const unreachedFrom = stopIdx >= 0 ? stopIdx + 1 : STAGES.length;

  // The band starts at the connector leaving the stage that stopped, so it
  // physically spans the part of the path that never happened. Columns of the
  // 9-column template: nodes are odd, connectors even.
  //
  // This spanning treatment belongs to the BLOCK. A handler failure only has
  // `store` downstream, so an exact span would be one narrow column and would
  // read as a stray chip rather than as a statement; it gets a full-width
  // status line instead. Reserving the span for the block is also the point:
  // only the block claims a region of the path that never happened.
  const exactSpan = stopIdx * 2 + 2;
  const bandStart = stopped === "blocked" && exactSpan <= 6 ? exactSpan : 1;

  return (
    <section aria-label="Request path" className="demo-trace w-full overflow-x-auto">
      <style href="demo-trace-tokens" precedence="medium">
        {TRACE_TOKENS}
      </style>
      <style href="demo-flow-diagram" precedence="medium">
        {CSS}
      </style>

      <div className="grid min-w-[620px] grid-cols-[auto_1fr_auto_1fr_auto_1fr_auto_1fr_auto] items-center gap-y-2">
        {STAGES.map((stage, i) => (
          <div key={stage.id} className="contents">
            <Node
              label={stage.label}
              role={stage.role}
              state={states[i]}
              unreached={i >= unreachedFrom && states[i] === "idle"}
            />
            {i < STAGES.length - 1 && <Connector state={connState(states[i], states[i + 1])} />}
          </div>
        ))}

        {/* Row 2 is always present, so the diagram's height never changes. */}
        {stopped === "blocked" ? (
          <div
            className="demo-flow-band flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[var(--t-r)] border border-[var(--t-block)] bg-[var(--t-block-soft)] px-3 py-1.5"
            style={{ ["--band-start" as string]: bandStart }}
          >
            {/* the rule, at the left edge of the band, directly under the wall */}
            <span className="inline-flex items-center gap-1.5 rounded-[var(--t-r)] bg-[var(--t-block-hot)] px-2 py-0.5 text-white">
              <Glyph name="lock" className="h-3.5 w-3.5" />
              <code className="font-mono text-xs font-semibold">
                {blockedRuleId ?? "blocked"}
              </code>
            </span>
            <span className="text-sm leading-snug text-[var(--t-ink)]">
              {toolName ? <code className="font-mono font-semibold">{toolName}</code> : "The tool"}{" "}
              never ran. Escalated in code.
            </span>
          </div>
        ) : stopped === "failed" ? (
          <div
            className="demo-flow-band flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[var(--t-r)] border border-[var(--t-reject)] bg-[var(--t-reject-soft)] px-3 py-1.5"
            style={{ ["--band-start" as string]: 1 }}
          >
            <span className="inline-flex items-center gap-1.5 text-[var(--t-reject)]">
              <Glyph name="alert" className="h-3.5 w-3.5" />
              <span className="text-xs font-semibold uppercase tracking-wide">
                rejected, not blocked
              </span>
            </span>
            <span className="text-sm leading-snug text-[var(--t-ink)]">
              The handler ran and refused the call. No rule fired, so nothing was escalated.
            </span>
          </div>
        ) : (
          <div
            className="demo-flow-band flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-[var(--t-r)] border border-[var(--t-line-soft)] px-3 py-1.5"
            style={{ ["--band-start" as string]: 1 }}
          >
            <span className="text-xs uppercase tracking-wide text-[var(--t-ink-3)]">in flight</span>
            {toolName ? (
              <code className="font-mono text-sm font-semibold text-[var(--t-ink)]">
                {toolName}
              </code>
            ) : (
              <span className="font-mono text-sm text-[var(--t-ink-3)]">no tool</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
