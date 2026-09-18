"use client";

/**
 * ActNav - the agenda rail.
 *
 * Doubles as the run-of-show the presenter reads off and as the navigation.
 * Each row carries its keyboard number, because that number IS the shortcut
 * (press 3, land on act 3), not decoration.
 */
import type { DemoAct } from "@/lib/demo/types";

export interface ActNavProps {
  acts: DemoAct[];
  currentId: string | null;
  /** Acts whose playback has reached the end at least once this session. */
  completed: ReadonlySet<string>;
  onSelect: (actId: string) => void;
  /** Called on hover / focus so the shell can warm the next act. */
  onIntent?: (actId: string) => void;
  disabled?: boolean;
}

export default function ActNav({
  acts,
  currentId,
  completed,
  onSelect,
  onIntent,
  disabled = false,
}: ActNavProps) {
  const totalSec = acts.reduce((sum, a) => sum + (a.durationHintSec || 0), 0);

  return (
    <nav
      aria-label="Demo agenda"
      className="flex h-full min-h-0 flex-col border-r"
      style={{ borderColor: "var(--stage-line-soft)" }}
    >
      <div className="px-4 pt-4 pb-3">
        <h2
          className="text-[11px] font-semibold uppercase tracking-[0.16em]"
          style={{ color: "var(--stage-ink-3)" }}
        >
          Run of show
        </h2>
      </div>

      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {acts.map((act, i) => {
          const isCurrent = act.id === currentId;
          const isDone = completed.has(act.id);
          return (
            <li key={act.id}>
              <button
                type="button"
                disabled={disabled}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onSelect(act.id)}
                onMouseEnter={() => onIntent?.(act.id)}
                onFocus={() => onIntent?.(act.id)}
                className="group relative block w-full rounded-[var(--r)] px-3 py-3 text-left transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: isCurrent ? "var(--signal-soft)" : "transparent",
                }}
              >
                {/* Current-act bar. Square by the radius rule: it is an indicator. */}
                <span
                  aria-hidden
                  className="absolute top-2 bottom-2 left-0 w-[3px] transition-opacity duration-200"
                  style={{
                    background: "var(--signal)",
                    opacity: isCurrent ? 1 : 0,
                  }}
                />
                <span className="flex items-baseline gap-2.5">
                  <span
                    className="font-mono text-[11px] tabular-nums"
                    style={{
                      color: isCurrent ? "var(--signal)" : "var(--stage-ink-3)",
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    className="flex-1 text-[15px] leading-snug font-medium transition-colors duration-200 group-hover:text-[var(--stage-ink)]"
                    style={{
                      color: isCurrent ? "var(--stage-ink)" : "var(--stage-ink-2)",
                    }}
                  >
                    {act.title}
                  </span>
                </span>
                <span className="mt-1 flex items-center gap-2 pl-[22px]">
                  <span
                    className="font-mono text-[10px] tabular-nums"
                    style={{ color: "var(--stage-ink-3)" }}
                  >
                    {formatDuration(act.durationHintSec)}
                  </span>
                  {isDone ? (
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.1em]"
                      style={{ color: "var(--stage-ink-3)" }}
                    >
                      played
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div
        className="space-y-1.5 border-t px-4 py-3 text-[11px] leading-relaxed"
        style={{
          borderColor: "var(--stage-line-soft)",
          color: "var(--stage-ink-3)",
        }}
      >
        {acts.length > 0 ? (
          <p className="font-mono tabular-nums">
            {acts.length} acts, about {formatDuration(totalSec)}
          </p>
        ) : null}
        <p>
          Press <span className="demo-key mx-0.5">?</span> for the full key map.
        </p>
      </div>
    </nav>
  );
}

/** Run-of-show format: one unit for every row, so the rail scans as a rundown. */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00";
  const total = Math.round(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
