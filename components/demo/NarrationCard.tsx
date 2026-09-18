"use client";

/**
 * NarrationCard — the current beat, set like something meant to be read aloud.
 *
 * A `moment` beat is categorically different, not slightly different: it is the
 * only beat on a raised surface, the only one with a filled label, the only one
 * with a 2px lit border, and its title jumps a full step in scale. setup /
 * insight / payoff sit flat on the stage and differ only in rail colour and
 * label, because they are all the same kind of thing.
 *
 * No enter transition here: DemoShell wraps this component in `.demo-swap`,
 * keyed on act + beat, and two transitions on one element fight each other.
 *
 * The null state is the opening shot of every act, not an edge case: playback
 * starts paused at cursor -1, so this is what the room looks at while the
 * presenter talks. It is therefore the populated card with its words not yet
 * written, not a placeholder: same surface, same weight, same geometry, so
 * nothing jumps or re-flows when the first beat lands. The act's `watchFor`
 * line is already on screen above, so it says nothing instructional.
 */
import type { BeatKind, NarrationCardProps } from "@/lib/demo/types";
import { TRACE_TOKENS } from "./FlowDiagram";

interface KindStyle {
  label: string;
  card: string;
  rail: string;
  eyebrow: string;
  body: string;
}

const KIND: Record<BeatKind, KindStyle> = {
  setup: {
    label: "Setup",
    card: "border border-[var(--t-line-soft)] bg-[var(--t-panel)]",
    rail: "bg-[var(--t-line)]",
    eyebrow: "text-[var(--t-ink-2)]",
    body: "text-[var(--t-ink-2)]",
  },
  insight: {
    label: "Insight",
    card: "border border-[var(--t-line)] bg-[var(--t-panel)]",
    rail: "bg-[var(--t-ink-2)]",
    eyebrow: "text-[var(--t-ink-2)]",
    body: "text-[var(--t-ink-2)]",
  },
  moment: {
    label: "The moment",
    card: "demo-beat-moment border-2 border-[var(--t-now)] bg-[var(--t-raise)]",
    rail: "bg-[var(--t-now)]",
    eyebrow: "",
    body: "text-[var(--t-ink)]",
  },
  payoff: {
    label: "Payoff",
    card: "border border-[var(--t-line)] bg-[var(--t-panel)]",
    rail: "bg-[var(--t-ok)]",
    eyebrow: "text-[var(--t-ok)]",
    body: "text-[var(--t-ink-2)]",
  },
};

/**
 * Short-viewport compaction.
 *
 * At 720p the card sits in a ~173px slot, and the payoff variant at full scale
 * is ~260px, so the takeaway scrolls away inside the card at exactly the moment
 * the act lands. Below 800px of viewport HEIGHT (not width: this is a vertical
 * budget) the type drops a step, the measure widens so the same body costs
 * fewer lines, and the vertical rhythm tightens. The moment variant compacts
 * too but keeps its lead over the others, since its whole job is to dominate.
 *
 * Selectors are doubled up under .demo-trace so they outrank Tailwind's md:
 * utilities regardless of which stylesheet the browser sees first.
 */
const CSS = `
.demo-beat-moment {
  box-shadow: 0 0 0 5px color-mix(in srgb, var(--t-now) 8%, transparent),
              0 18px 44px rgba(0, 0, 0, 0.55);
}
@media (max-height: 800px) {
  .demo-trace.demo-beat {
    min-height: 0;
    padding-top: 0.75rem;
    padding-bottom: 0.75rem;
  }
  .demo-trace .demo-beat-label { font-size: 10px; }
  .demo-trace .demo-beat-title {
    font-size: 1.3125rem;
    line-height: 1.15;
    margin-top: 0.25rem;
  }
  .demo-trace .demo-beat-body {
    font-size: 0.875rem;
    line-height: 1.42;
    margin-top: 0.4375rem;
    max-width: 92ch;
  }
  .demo-trace .demo-beat-foot { margin-top: 0.5rem; }
  .demo-trace .demo-beat-count { font-size: 0.75rem; }
  /* The moment is the only variant with border-2 rather than border. In a slot
     sized to the others it clips by exactly that 2px, so give it back here. */
  .demo-trace.demo-beat-moment {
    padding-top: calc(0.75rem - 1px);
    padding-bottom: calc(0.75rem - 1px);
  }
  .demo-trace.demo-beat-moment .demo-beat-title { font-size: 1.6875rem; }
  .demo-trace.demo-beat-moment .demo-beat-body { font-size: 1rem; line-height: 1.38; }
}
`;

/** Progress through the act's beats. Square, per the stage radius rule. */
function Dots({ pos, total }: { pos: number; total: number }) {
  if (total <= 0) return null;
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-1.5 motion-safe:transition-all motion-safe:duration-300 ${
            i < pos ? "w-6 bg-[var(--t-ink)]" : "w-1.5 bg-[var(--t-line)]"
          }`}
        />
      ))}
    </div>
  );
}

function Footer({ pos, total }: { pos: number; total: number }) {
  return (
    <div className="demo-beat-foot mt-6 flex items-center justify-between gap-4">
      <Dots pos={pos} total={total} />
      <span className="demo-beat-count font-mono text-sm text-[var(--t-ink-3)]">
        {pos} / {total}
      </span>
    </div>
  );
}

export default function NarrationCard({ beat, n, total }: NarrationCardProps) {
  // `n` is 1-based, 0 means no beat yet, `total` is beats.length (confirmed
  // against DemoShell). Clamped so an out-of-range value can never render as a
  // broken counter mid-presentation.
  const pos = beat ? Math.min(Math.max(n, 1), Math.max(total, 1)) : 0;

  if (!beat) {
    const s = KIND.setup;
    return (
      <div
        className={`demo-trace demo-beat flex min-h-[9rem] gap-5 rounded-[var(--t-r)] px-6 py-6 ${s.card}`}
      >
        <style href="demo-trace-tokens" precedence="medium">
          {TRACE_TOKENS}
        </style>
        <style href="demo-narration-card" precedence="medium">
          {CSS}
        </style>

        <span aria-hidden className="w-1.5 shrink-0 bg-[var(--t-line)]" />

        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <p className="demo-beat-title text-xl leading-snug text-[var(--t-ink-3)] md:text-2xl">
            No beat yet.
          </p>
          <Footer pos={0} total={total} />
        </div>
      </div>
    );
  }

  const s = KIND[beat.kind];
  const isMoment = beat.kind === "moment";

  return (
    <div
      className={`demo-trace demo-beat flex min-h-[9rem] gap-5 rounded-[var(--t-r)] px-6 py-6 ${s.card}`}
    >
      <style href="demo-trace-tokens" precedence="medium">
        {TRACE_TOKENS}
      </style>
      <style href="demo-narration-card" precedence="medium">
        {CSS}
      </style>

      {/* hairline rail — square, per the stage radius rule */}
      <span aria-hidden className={`w-1.5 shrink-0 ${s.rail}`} />

      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div>
          {isMoment ? (
            <span className="demo-beat-label inline-block rounded-[var(--t-r)] bg-[var(--t-now)] px-2.5 py-1 text-xs font-semibold uppercase tracking-widest text-[var(--t-on-fill)]">
              {s.label}
            </span>
          ) : (
            <div className={`demo-beat-label text-xs font-semibold uppercase tracking-widest ${s.eyebrow}`}>
              {s.label}
            </div>
          )}

          <h2
            className={`demo-beat-title mt-2 text-balance font-semibold tracking-tight text-[var(--t-ink)] ${
              isMoment ? "text-3xl leading-[1.1] md:text-5xl" : "text-2xl leading-[1.15] md:text-3xl"
            }`}
          >
            {beat.title}
          </h2>
          <p
            className={`demo-beat-body mt-3 max-w-[58ch] leading-relaxed ${s.body} ${
              isMoment ? "text-lg md:text-2xl" : "text-base md:text-xl"
            }`}
          >
            {beat.body}
          </p>
        </div>

        <Footer pos={pos} total={total} />
      </div>
    </div>
  );
}
