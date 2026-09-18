"use client";

/**
 * usePlayback — the playhead.
 *
 * A demo act arrives as a COMPLETE TraceEvent[] (the run already happened; see
 * lib/demo/types.ts). This hook is what turns that array back into something an
 * audience can watch: it holds a cursor and reveals `events[0..cursor]`, one
 * event at a time, resting on each for `dwellMs(ev) / speed`.
 *
 * Two decisions worth stating, because both have bitten demos before:
 *
 * 1. The timer is a CHAINED setTimeout, not a setInterval. Each event gets its
 *    own dwell (a hook block lingers, prose does not), and each hop corrects for
 *    the drift the previous one accumulated — otherwise a minute of playback
 *    ends up seconds adrift of the narration the presenter is reading.
 * 2. The dwell in flight is tracked as REMAINING speed-1 milliseconds in a ref,
 *    not as a deadline. Nudging the speed dial two seconds into a slow beat must
 *    stretch or squeeze what is left of that beat — not restart it, and not
 *    leave the playhead parked.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dwellMs } from "@/lib/demo/pacing";
import type { Playback, Speed } from "@/lib/demo/types";
import type { TraceEvent } from "@/lib/types";

interface Options {
  autoPlay?: boolean;
  /** Initial speed only — the dial afterwards belongs to `controls.setSpeed`. */
  speed?: Speed;
  onFinish?: () => void;
}

/**
 * A single late timer (a backgrounded tab, a stalled main thread) must not
 * repay itself by firing the next few events back to back — that reads as a
 * glitch from the audience's side. Carry at most this much drift forward.
 */
const MAX_DRIFT_CARRY_MS = 250;

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function usePlayback(events: TraceEvent[], opts: Options = {}): Playback {
  const { autoPlay = false, speed: initialSpeed = 1 } = opts;

  const [cursor, setCursor] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [speed, setSpeedState] = useState<Speed>(initialSpeed);

  // Read through refs so a caller's inline `onFinish` / changing `autoPlay`
  // never re-arms a timer or re-fires a completion. Declared first so the sync
  // lands before the effects below read them in the same commit.
  const onFinishRef = useRef(opts.onFinish);
  const autoPlayRef = useRef(autoPlay);
  useEffect(() => {
    onFinishRef.current = opts.onFinish;
    autoPlayRef.current = autoPlay;
  });

  /** Which index the pending dwell belongs to, and how much of it is left. */
  const pendingIndexRef = useRef(-2);
  const remainingRef = useRef(0);
  /** Overshoot owed by the previous hop, subtracted from the next one. */
  const driftRef = useRef(0);

  const isFinished = cursor === events.length - 1;

  const resetDwell = useCallback(() => {
    pendingIndexRef.current = -2;
    driftRef.current = 0;
  }, []);

  /* A new array means the presenter switched acts: rewind, drop any dwell left
   * over from the old trace, and honour autoPlay for the new one. */
  useEffect(() => {
    resetDwell();
    setCursor(-1);
    setIsPlaying(autoPlayRef.current);
  }, [events, resetDwell]);

  /* The playhead itself. Re-runs on every hop (cursor), on play/pause, and on a
   * speed change — which is why `remainingRef` lives outside it. */
  useEffect(() => {
    if (!isPlaying) return;

    const next = cursor + 1;
    if (next >= events.length) {
      setIsPlaying(false);
      return;
    }

    if (pendingIndexRef.current !== next) {
      pendingIndexRef.current = next;
      remainingRef.current = dwellMs(events[next]);
    }

    const wait = Math.max(0, remainingRef.current / speed - driftRef.current);
    const startedAt = now();
    const timer = setTimeout(() => {
      driftRef.current = Math.min(MAX_DRIFT_CARRY_MS, Math.max(0, now() - startedAt - wait));
      remainingRef.current = 0;
      setCursor(next);
    }, wait);

    return () => {
      clearTimeout(timer);
      // Bank the part of the dwell that was actually spent, in speed-1 ms, so a
      // pause or a speed change resumes where the beat left off.
      if (remainingRef.current > 0) {
        remainingRef.current = Math.max(0, remainingRef.current - (now() - startedAt) * speed);
      }
    };
  }, [isPlaying, cursor, speed, events]);

  /* onFinish fires once per completion, not once per render. */
  const finishedFiredRef = useRef(false);
  useEffect(() => {
    if (!isFinished || events.length === 0) {
      finishedFiredRef.current = false;
      return;
    }
    if (finishedFiredRef.current) return;
    finishedFiredRef.current = true;
    onFinishRef.current?.();
  }, [isFinished, events]);

  const play = useCallback(() => {
    // Hitting play on a finished act replays it — the presenter reaching for the
    // button at the end of a beat means "again", never "do nothing".
    setCursor((c) => (c === events.length - 1 && events.length > 0 ? -1 : c));
    resetDwell();
    setIsPlaying(true);
  }, [events, resetDwell]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  const stepForward = useCallback(() => {
    setIsPlaying(false);
    resetDwell();
    setCursor((c) => Math.min(c + 1, events.length - 1));
  }, [events, resetDwell]);

  const stepBack = useCallback(() => {
    setIsPlaying(false);
    resetDwell();
    setCursor((c) => Math.max(c - 1, -1));
  }, [resetDwell]);

  const seek = useCallback(
    (i: number) => {
      resetDwell();
      setCursor(Math.max(-1, Math.min(Math.floor(i), events.length - 1)));
    },
    [events, resetDwell],
  );

  /** Rewind. Keeps playing if it was playing — a restart mid-talk is a redo. */
  const restart = useCallback(() => {
    resetDwell();
    setCursor(-1);
  }, [resetDwell]);

  const setSpeed = useCallback((s: Speed) => setSpeedState(s), []);

  // Stable between renders where the cursor did not move: TraceStage renders one
  // row per event, and a fresh array every tick would re-render all of them.
  const visible = useMemo(() => events.slice(0, cursor + 1), [events, cursor]);

  const controls = useMemo(
    () => ({ play, pause, toggle, stepForward, stepBack, seek, restart, setSpeed }),
    [play, pause, toggle, stepForward, stepBack, seek, restart, setSpeed],
  );

  return { events, visible, cursor, isPlaying, isFinished, speed, controls };
}
