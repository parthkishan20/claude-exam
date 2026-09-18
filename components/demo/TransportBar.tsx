"use client";

/**
 * TransportBar - the tape deck.
 *
 * Buttons carry word labels, not glyphs: a 16px triangle is unreadable from the
 * back of a room, and "Pause" is unambiguous on a projector. The keycap next to
 * each label teaches the shortcut that actually drives the talk.
 */
import type { PlaybackControls, Speed } from "@/lib/demo/types";
import { SPEEDS } from "@/lib/demo/types";

export interface TransportBarProps {
  /** Index of the last revealed event; -1 before anything is revealed. */
  cursor: number;
  /** events.length. */
  total: number;
  isPlaying: boolean;
  isFinished: boolean;
  speed: Speed;
  /** Event index of the act's "moment" beat, marked on the scrub bar. */
  momentIndex: number | null;
  /** Beat position, shown large so the room can follow the argument. */
  beatN: number;
  beatTotal: number;
  disabled: boolean;
  controls: PlaybackControls;
}

export default function TransportBar({
  cursor,
  total,
  isPlaying,
  isFinished,
  speed,
  momentIndex,
  beatN,
  beatTotal,
  disabled,
  controls,
}: TransportBarProps) {
  // The playhead sits on a track of `total + 1` slots: one for "nothing
  // revealed yet" (cursor -1), then one per event.
  const slots = Math.max(total, 1);
  const pct = (i: number) => ((i + 1) / slots) * 100;
  const progress = total > 0 ? pct(cursor) : 0;
  const momentPct = momentIndex != null && total > 0 ? pct(momentIndex) : null;
  const atMoment = momentIndex != null && cursor >= momentIndex;

  return (
    <section
      aria-label="Playback transport"
      className="border-t px-5 pt-2 pb-3"
      style={{
        borderColor: "var(--stage-line-soft)",
        background: "var(--stage-panel)",
      }}
    >
      <div className="relative">
        {/* Track */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-[6px] -translate-y-1/2 overflow-hidden"
          style={{ background: "var(--stage-line-soft)" }}
        >
          <div
            className="h-full transition-[width] duration-200 ease-out"
            style={{
              width: `${progress}%`,
              background: disabled ? "var(--stage-ink-3)" : "var(--signal)",
            }}
          />
        </div>

        {/* The one beat the whole act exists for. */}
        {momentPct != null ? (
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 flex flex-col items-center justify-center"
            style={{ left: `${momentPct}%`, transform: "translateX(-50%)" }}
          >
            <span
              className="h-5 w-[2px] transition-colors duration-300"
              style={{
                background: atMoment ? "var(--stage-ink)" : "var(--stage-ink-3)",
              }}
            />
          </div>
        ) : null}

        <input
          type="range"
          className="demo-scrub relative"
          min={-1}
          max={Math.max(total - 1, 0)}
          step={1}
          value={Math.min(cursor, total - 1)}
          disabled={disabled || total === 0}
          aria-label="Position in trace"
          aria-valuetext={
            cursor < 0 ? "Before the first event" : `Event ${cursor + 1} of ${total}`
          }
          onChange={(e) => controls.seek(Number(e.target.value))}
        />
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="demo-btn demo-btn--primary min-w-[8.5rem] justify-center"
            disabled={disabled || total === 0}
            onClick={controls.toggle}
          >
            {isPlaying ? "Pause" : isFinished ? "Replay act" : "Play"}
            <span className="demo-key">Space</span>
          </button>
          <button
            type="button"
            className="demo-btn"
            disabled={disabled || cursor < 0}
            onClick={controls.stepBack}
          >
            Back
            <span className="demo-key">{"←"}</span>
          </button>
          <button
            type="button"
            className="demo-btn"
            disabled={disabled || total === 0 || cursor >= total - 1}
            onClick={controls.stepForward}
          >
            Step
            <span className="demo-key">{"→"}</span>
          </button>
          <button
            type="button"
            className="demo-btn"
            disabled={disabled || total === 0}
            onClick={controls.restart}
          >
            Restart
            <span className="demo-key">R</span>
          </button>
        </div>

        {/* Progress the room can read: beats are the argument, events are the proof. */}
        <div className="flex items-baseline gap-4">
          <p className="text-lg leading-none font-medium tabular-nums">
            {beatTotal > 0 ? (
              <>
                Beat{" "}
                <span style={{ color: "var(--signal)" }}>
                  {Math.max(beatN, 0)}
                </span>
                <span style={{ color: "var(--stage-ink-3)" }}> / {beatTotal}</span>
              </>
            ) : (
              <span style={{ color: "var(--stage-ink-3)" }}>No beats</span>
            )}
          </p>
          <p
            className="font-mono text-xs tabular-nums"
            style={{ color: "var(--stage-ink-3)" }}
          >
            {total === 0 ? "0 events" : `event ${Math.max(cursor + 1, 0)} / ${total}`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{ color: "var(--stage-ink-3)" }}
          >
            Speed
          </span>
          <div
            className="flex items-center gap-1 rounded-[var(--r)] p-1"
            style={{ background: "var(--stage-raise)" }}
            role="group"
            aria-label="Playback speed"
          >
            {SPEEDS.map((s) => {
              const active = s === speed;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={disabled}
                  aria-pressed={active}
                  onClick={() => controls.setSpeed(s)}
                  className="rounded-[var(--r)] px-2.5 py-1 font-mono text-xs tabular-nums transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{
                    background: active ? "var(--signal)" : "transparent",
                    color: active ? "#17120a" : "var(--stage-ink-2)",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {s}x
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
