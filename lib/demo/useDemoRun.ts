"use client";

/**
 * useDemoRun — the data side of Demo Mode: the act list, and one run per act.
 *
 * The agenda (the acts, plus whether a live run is even possible on this host)
 * and one whole DemoRun per act, trace included; usePlayback does the revealing
 * from there. WHERE those come from is lib/demo/source.ts's problem, not this
 * hook's: `/api/demo` when there is a server, prebuilt JSON when the site is a
 * static export. Everything below is identical either way.
 *
 * Everything here exists for one situation: a presenter mid-talk who jumps back
 * to act 2 to answer a question. That jump has to be instant and free, so runs
 * are cached by `${actId}:${mode}` for the life of the page, the next act can be
 * warmed in the background while the current one plays, and a run the presenter
 * navigated away from is aborted rather than left to land on a dead act.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchIndex, fetchRun, IS_STATIC } from "@/lib/demo/source";
import type { DemoAct, DemoMode, DemoRun } from "@/lib/demo/types";

/** Only used in error copy, so the message names something the reader can check. */
const SOURCE_LABEL = IS_STATIC ? "the prebuilt demo data" : "/api/demo";

const cacheKey = (actId: string, mode: DemoMode): string => `${actId}:${mode}`;

function messageFor(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface DemoRunController {
  acts: DemoAct[];
  /** Whether this machine can run an act live (an API key is configured). */
  live: boolean;
  run: DemoRun | null;
  actId: string | null;
  isLoading: boolean;
  /** Short and human — it goes on a screen in front of a room. */
  error: string | null;
  /** Switch acts. Re-selecting the current act retries it. */
  select: (actId: string, mode?: DemoMode) => void;
  setMode: (m: DemoMode) => void;
  mode: DemoMode;
  /** Warm the cache for an upcoming act. Failures are swallowed. */
  prefetch: (actId: string) => void;
}

export function useDemoRun(): DemoRunController {
  const [acts, setActs] = useState<DemoAct[]>([]);
  const [live, setLive] = useState(false);
  const [run, setRun] = useState<DemoRun | null>(null);
  const [actId, setActId] = useState<string | null>(null);
  const [mode, setModeState] = useState<DemoMode>("replay");
  const [actsLoading, setActsLoading] = useState(true);
  const [runLoading, setRunLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped when the current act is re-selected — that gesture means "retry". */
  const [reloadTick, setReloadTick] = useState(0);

  const cacheRef = useRef(new Map<string, DemoRun>());
  /** Keys with a prefetch already in flight — warming twice is wasted money. */
  const warmingRef = useRef(new Set<string>());
  // Lets `select` stay referentially stable while still seeing the current act.
  const actIdRef = useRef<string | null>(null);
  useEffect(() => {
    actIdRef.current = actId;
  }, [actId]);

  const isLoading = actsLoading || runLoading;

  /* The agenda. One request, on mount. */
  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const body = await fetchIndex(ac.signal);
        if (!Array.isArray(body.acts)) {
          throw new Error(`${SOURCE_LABEL} returned no acts.`);
        }
        setActs(body.acts);
        // A static export has no server to hold a key, so live is never
        // possible there and the index says so outright.
        setLive(!IS_STATIC && body.live === true);
      } catch (err) {
        if (ac.signal.aborted) return;
        setError(messageFor(err, `Could not reach ${SOURCE_LABEL}.`));
      } finally {
        if (!ac.signal.aborted) setActsLoading(false);
      }
    })();
    return () => ac.abort();
  }, []);

  /* The selected run. Re-runs when the presenter switches act or mode; the
   * cleanup aborts whatever the previous selection had in flight. */
  useEffect(() => {
    if (!actId) return;

    const key = cacheKey(actId, mode);
    const cached = cacheRef.current.get(key);
    if (cached) {
      setRun(cached);
      setError(null);
      setRunLoading(false);
      return;
    }

    const ac = new AbortController();
    setRun(null);
    setError(null);
    setRunLoading(true);
    (async () => {
      try {
        const fresh = await fetchRun(actId, mode, ac.signal);
        if (ac.signal.aborted) return;
        // A run that carries its own error is not cached: the presenter must be
        // able to retry it (a live run that hit a rate limit usually works next
        // time), and caching a failure makes the act permanently broken.
        //
        // A run carrying a `notice` is not cached either, for the same reason
        // one step further in: it succeeded only by DOWNGRADING — live was
        // asked for and replay came back. Remembering it under the live key
        // means a presenter who fixes the key or waits out a rate limit gets
        // the stale fallback forever, with no request ever leaving the page.
        if (!fresh.error && !fresh.notice) cacheRef.current.set(key, fresh);
        setRun(fresh);
        if (fresh.error) setError(fresh.error);
      } catch (err) {
        // An abort is the presenter moving on, not a failure to report.
        if (ac.signal.aborted) return;
        setError(messageFor(err, `Could not reach ${SOURCE_LABEL}.`));
      } finally {
        if (!ac.signal.aborted) setRunLoading(false);
      }
    })();

    return () => ac.abort();
  }, [actId, mode, reloadTick]);

  const select = useCallback((id: string, m?: DemoMode) => {
    if (id === actIdRef.current) setReloadTick((t) => t + 1);
    setActId(id);
    if (m) setModeState(m);
  }, []);

  const setMode = useCallback((m: DemoMode) => setModeState(m), []);

  /** Warm the cache for an act the presenter has not reached yet. Silent. */
  const prefetch = useCallback(
    (id: string) => {
      const key = cacheKey(id, mode);
      if (cacheRef.current.has(key) || warmingRef.current.has(key)) return;
      warmingRef.current.add(key);
      void fetchRun(id, mode)
        .then((fresh) => {
          // Same rule as the main effect: never cache a failure or a downgrade.
          if (!fresh.error && !fresh.notice) cacheRef.current.set(key, fresh);
        })
        .catch(() => {
          /* a prefetch that fails costs nothing — select() will surface it */
        })
        .finally(() => warmingRef.current.delete(key));
    },
    [mode],
  );

  return useMemo(
    () => ({
      acts,
      live,
      run,
      actId,
      isLoading,
      error,
      select,
      setMode,
      mode,
      prefetch,
    }),
    [acts, live, run, actId, isLoading, error, select, setMode, mode, prefetch],
  );
}
