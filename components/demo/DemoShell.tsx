"use client";

/**
 * DemoShell - the stage.
 *
 * Owns layout, act navigation, transport, keyboard driving and the URL. The
 * visualisations (flow diagram, trace stage, narration, checklist, ledger) and
 * the playback engine are separate modules; this file is the frame they hang in
 * plus the small glue that turns revealed events into pipeline stage states.
 *
 * Layout is fixed to the viewport with no page scroll: a presenter should never
 * have to hunt for a control mid-sentence, and the transport must stay put.
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IS_STATIC } from "@/lib/demo/source";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AssertionChecklist from "@/components/demo/AssertionChecklist";
import FlowDiagram from "@/components/demo/FlowDiagram";
import NarrationCard from "@/components/demo/NarrationCard";
import StoreLedger from "@/components/demo/StoreLedger";
import TraceStage from "@/components/demo/TraceStage";
import { currentBeat, resolveBeats } from "@/lib/demo/anchors";
import type {
  DemoMode,
  FlowDiagramProps,
  FlowStage,
  FlowStageState,
} from "@/lib/demo/types";
import { useDemoRun } from "@/lib/demo/useDemoRun";
import { usePlayback } from "@/lib/demo/usePlayback";
import type { ToolName, TraceEvent } from "@/lib/types";
import ActNav from "./ActNav";
import TransportBar from "./TransportBar";
import "./demo.css";

const NO_EVENTS: TraceEvent[] = [];

/**
 * The claim the screen makes about itself. It has to stay exactly this honest:
 * replay swaps the model's turn for a script and nothing else. Every gate,
 * retry, handler and store write the audience watches is the shipping code.
 */
const REPLAY_NOTE =
  "Replay scripts the model's turn only. The hook, the retries, the handlers and the store are the shipping code.";

/**
 * Why Live is off. The two hosts are unavailable for different reasons and a
 * presenter may well be asked which one applies: a static export (GitHub Pages)
 * has no server to hold a key or call the API from, whereas a server build
 * simply has not been given a key.
 */
const LIVE_UNAVAILABLE = IS_STATIC
  ? "Live is unavailable on this hosted copy: it is a static site with no server to call the API from."
  : "Live is unavailable: the server has no ANTHROPIC_API_KEY.";

export default function DemoShell({ initialActId }: { initialActId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { acts, live, run, actId, isLoading, error, select, setMode, mode, prefetch } =
    useDemoRun();

  const events = useMemo(() => run?.events ?? NO_EVENTS, [run]);
  const playback = usePlayback(events, { autoPlay: false, speed: 1 });
  const { cursor, visible, isPlaying, isFinished, speed, controls } = playback;

  const actIndex = acts.findIndex((a) => a.id === actId);
  const act = actIndex >= 0 ? acts[actIndex] : null;

  const beats = useMemo(
    () => (act ? resolveBeats(act.beats, events) : []),
    [act, events],
  );
  const beat = useMemo(() => currentBeat(beats, cursor), [beats, cursor]);
  const beatN = beat ? beats.indexOf(beat) + 1 : 0;
  const momentIndex = useMemo(() => {
    const moment = beats.find((b) => b.kind === "moment");
    return moment ? moment.index : null;
  }, [beats]);

  const flow = useMemo(() => deriveFlow(visible), [visible]);

  const runError = error ?? run?.error ?? null;
  // `loaded` is the run only when it is safe to render: it narrows `run` for
  // every consumer below, so the stage can never half-render a stale act.
  const loaded = !isLoading && !runError ? run : null;
  const ready = loaded != null && act != null;

  /* ---------------- act selection, completion, prefetch ---------------- */

  const [completed, setCompleted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!isFinished || !actId) return;
    setCompleted((prev) => (prev.has(actId) ? prev : new Set(prev).add(actId)));
  }, [isFinished, actId]);

  /**
   * What actually ran, which after a live fallback is not what was requested.
   * While a run is in flight there is nothing authoritative yet, so the
   * requested mode stands in.
   */
  const shownMode = loaded?.mode ?? mode;

  /**
   * Re-picking the mode already requested is the retry gesture: after a
   * fallback the presenter's only way to say "try live again" is to press Live
   * again, and a rate limit or a corrected key can make the next attempt work.
   */
  const chooseMode = useCallback(
    (m: DemoMode) => {
      if (m === mode) {
        if (actId) select(actId, m);
        return;
      }
      setMode(m);
    },
    [mode, actId, select, setMode],
  );

  const goToAct = useCallback(
    (id: string) => {
      if (id !== actId) select(id);
    },
    [actId, select],
  );

  const stepAct = useCallback(
    (delta: number) => {
      if (actIndex < 0) return;
      const next = acts[actIndex + delta];
      if (next) goToAct(next.id);
    },
    [acts, actIndex, goToAct],
  );

  // Warm the next act the moment this one starts playing, so the hand-off at
  // the end of an act is instant.
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (isPlaying && !wasPlaying.current) {
      const next = acts[actIndex + 1];
      if (next) prefetch(next.id);
    }
    wasPlaying.current = isPlaying;
  }, [isPlaying, acts, actIndex, prefetch]);

  /* ---------------- URL <-> act, both directions ---------------- */

  const urlAct = searchParams.get("act") ?? initialActId;

  /**
   * The URL is the source of truth for WHICH act, and this effect is the only
   * thing that acts on it. `honoured` records the URL value already applied, so
   * a click that has changed `actId` but whose router.replace has not landed
   * yet does not get dragged back to the old act by a stale search param.
   * useDemoRun starts with nothing selected, so this is also what picks act 1.
   */
  const honoured = useRef<string | null>(null);
  useEffect(() => {
    if (acts.length === 0) return;
    const wanted =
      urlAct && acts.some((a) => a.id === urlAct) ? urlAct : acts[0].id;
    if (honoured.current === wanted) return;
    honoured.current = wanted;
    if (wanted !== actId) select(wanted);
  }, [urlAct, actId, acts, select]);

  // State to URL: replace, not push, so back leaves /demo instead of walking
  // the act history one entry at a time.
  useEffect(() => {
    if (!actId) return;
    if (searchParams.get("act") === actId) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("act", actId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [actId, pathname, router, searchParams]);

  /* ---------------- keyboard: how this is actually driven ---------------- */

  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase() ?? "";
      const inputType = tag === "input" ? (el as HTMLInputElement).type : "";
      const isTextEntry =
        tag === "textarea" ||
        tag === "select" ||
        el?.isContentEditable === true ||
        (tag === "input" && !["range", "checkbox", "radio", "button"].includes(inputType));
      if (isTextEntry) return;

      // The scrub bar owns the arrow keys while it has focus.
      const onScrub = inputType === "range";

      switch (e.key) {
        case " ":
        case "Spacebar":
          e.preventDefault();
          controls.toggle();
          return;
        case "ArrowRight":
          if (onScrub) return;
          e.preventDefault();
          controls.stepForward();
          return;
        case "ArrowLeft":
          if (onScrub) return;
          e.preventDefault();
          controls.stepBack();
          return;
        case "ArrowDown":
        case "j":
        case "J":
          e.preventDefault();
          stepAct(1);
          return;
        case "ArrowUp":
        case "k":
        case "K":
          e.preventDefault();
          stepAct(-1);
          return;
        case "r":
        case "R":
          e.preventDefault();
          controls.restart();
          return;
        case "?":
          e.preventDefault();
          setShowHelp((v) => !v);
          return;
        case "Escape":
          setShowHelp(false);
          return;
        default:
          break;
      }

      if (/^[1-9]$/.test(e.key)) {
        const target = acts[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          goToAct(target.id);
        }
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [acts, controls, goToAct, stepAct]);

  /* ---------------- render ---------------- */

  const noActs = acts.length === 0;

  return (
    <div className="demo-root flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden font-sans">
      <header
        className="shrink-0 border-b px-5 pt-2.5 pb-0"
        style={{ borderColor: "var(--stage-line-soft)" }}
      >
        <div className="flex items-start gap-5">
          <div className="min-w-0 flex-1">
            <p
              className="font-mono text-[11px] tracking-[0.18em] uppercase"
              style={{ color: "var(--stage-ink-3)" }}
            >
              {actIndex >= 0 ? `Act ${actIndex + 1} of ${acts.length}` : "Demo mode"}
            </p>
            <h1
              key={act?.id ?? "no-act"}
              className="demo-swap mt-1 truncate text-2xl leading-tight font-semibold tracking-tight xl:text-3xl 2xl:text-[2.5rem]"
            >
              {act?.title ?? "Watching the refund agent get told no"}
            </h1>
            <p
              className="mt-0.5 truncate text-sm xl:text-base 2xl:text-lg"
              style={{ color: "var(--stage-ink-2)" }}
            >
              {act?.subtitle ??
                "Five acts, each replaying one canonical scenario one event at a time."}
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
            <div className="flex items-center gap-2">
              <ModeToggle
                mode={shownMode}
                live={live}
                downgraded={shownMode !== mode}
                onChange={chooseMode}
              />
              <button
                type="button"
                className="demo-btn"
                onClick={() => setShowHelp(true)}
                aria-haspopup="dialog"
              >
                Shortcuts
                <span className="demo-key">?</span>
              </button>
            </div>
            {loaded?.notice ? (
              <p
                role="status"
                className="max-w-[26rem] text-right text-[11px] leading-snug"
                style={{ color: "var(--signal)" }}
              >
                {loaded.notice}
              </p>
            ) : (
              <p
                className="max-w-[26rem] text-right text-[11px] leading-snug"
                style={{ color: "var(--stage-ink-3)" }}
              >
                {live ? REPLAY_NOTE : `${REPLAY_NOTE} ${LIVE_UNAVAILABLE}`}
              </p>
            )}
          </div>
        </div>

        {/* One line that changes exactly once per act: the thing to watch for,
            then the thing it proved. */}
        <div className="mt-2 flex items-baseline gap-4 py-1.5">
          <span
            className="shrink-0 text-[11px] font-semibold tracking-[0.16em] uppercase"
            style={{ color: isFinished ? "var(--signal)" : "var(--stage-ink-3)" }}
          >
            {isFinished ? "Takeaway" : "Watch for"}
          </span>
          <p
            key={`${act?.id ?? ""}-${isFinished}`}
            className="demo-swap min-w-0 flex-1 truncate text-sm xl:text-base"
            style={{ color: "var(--stage-ink-2)" }}
          >
            {(isFinished ? act?.takeaway : act?.watchFor) ?? ""}
          </p>
          {act && act.refs.length > 0 ? (
            <p
              className="hidden shrink-0 font-mono text-[11px] 2xl:block"
              style={{ color: "var(--stage-ink-3)" }}
            >
              {act.refs.join("  ")}
            </p>
          ) : null}
        </div>
      </header>

      {/* Three columns on a projector. Below 1280 the payoff rail moves under
          the stage rather than vanishing: the checklist and the ledger ARE the
          point of each act. */}
      <div className="grid min-h-0 flex-1 grid-cols-[224px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] xl:grid-cols-[228px_minmax(0,1fr)_316px] xl:grid-rows-[minmax(0,1fr)] 2xl:grid-cols-[268px_minmax(0,1fr)_380px]">
        <aside className="row-span-2 min-h-0 xl:row-span-1">
          <ActNav
            acts={acts}
            currentId={actId}
            completed={completed}
            onSelect={goToAct}
            onIntent={prefetch}
            disabled={noActs}
          />
        </aside>

        <main className="col-start-2 row-start-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-5 py-3">
          {isLoading ? (
            <StageSkeleton />
          ) : runError ? (
            <StageError
              message={runError}
              onRetry={actId ? () => select(actId, mode) : undefined}
            />
          ) : noActs ? (
            <StageEmpty
              title="No acts are loaded"
              body="The demo reads its acts from the acts module. Nothing came back, so there is nothing to walk through yet."
            />
          ) : !loaded || !act ? (
            <StageEmpty
              title="Pick an act to begin"
              body="Choose one from the run of show on the left, or press a number key."
            />
          ) : (
            <>
              {loaded.turns.length > 0 && !isFinished ? (
                <div className="demo-panel flex shrink-0 items-baseline gap-3 px-4 py-2.5">
                  <p
                    className="shrink-0 text-[11px] font-semibold tracking-[0.16em] uppercase"
                    style={{ color: "var(--stage-ink-3)" }}
                  >
                    Customer
                  </p>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    {loaded.turns.map((turn, i) => (
                      <p
                        key={i}
                        title={turn}
                        className="truncate text-sm leading-snug xl:text-base 2xl:text-lg"
                      >
                        {turn}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}

              <div
                key={`${act.id}-${beat?.id ?? "pre"}`}
                className="demo-swap max-h-[36%] shrink-0 overflow-y-auto"
              >
                <NarrationCard beat={beat} n={beatN} total={beats.length} />
              </div>

              <div className="shrink-0">
                <FlowDiagram
                  stages={flow.stages}
                  toolName={flow.toolName}
                  blockedRuleId={flow.blockedRuleId}
                />
              </div>

              <div className="min-h-[140px] flex-1">
                <TraceStage visible={visible} cursor={cursor} momentIndex={momentIndex} />
              </div>
            </>
          )}
        </main>

        <aside
          aria-label="What this act proved"
          className="col-start-2 row-start-2 flex gap-3 overflow-x-auto px-5 pb-4 xl:col-start-3 xl:row-start-1 xl:min-h-0 xl:flex-col xl:overflow-x-visible xl:overflow-y-hidden xl:border-l xl:px-4 xl:py-4"
          style={{ borderColor: "var(--stage-line-soft)" }}
        >
          {loaded ? (
            <>
              <div className="demo-scrollbox min-w-[280px] flex-1 xl:min-w-0">
                <div className="demo-rail-slot">
                  <AssertionChecklist assertions={loaded.assertions} revealed={isFinished} />
                </div>
              </div>
              <div className="demo-scrollbox min-w-[280px] flex-1 xl:min-w-0">
                <div className="demo-rail-slot">
                  <StoreLedger world={loaded.world} revealed={isFinished} />
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="demo-skeleton h-32 min-w-[280px] flex-1 xl:min-w-0" />
              <div className="demo-skeleton h-32 min-w-[280px] flex-1 xl:min-w-0" />
            </>
          )}
        </aside>
      </div>

      <TransportBar
        cursor={cursor}
        total={events.length}
        isPlaying={isPlaying}
        isFinished={isFinished}
        speed={speed}
        momentIndex={momentIndex}
        beatN={beatN}
        beatTotal={beats.length}
        disabled={!ready}
        controls={controls}
      />

      {showHelp ? <ShortcutsOverlay onClose={() => setShowHelp(false)} live={live} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Header controls
 * ------------------------------------------------------------------ */

function ModeToggle({
  mode,
  live,
  downgraded,
  onChange,
}: {
  /** What actually ran, never what was requested. */
  mode: DemoMode;
  live: boolean;
  /** True when live was asked for and replay came back. */
  downgraded: boolean;
  onChange: (m: DemoMode) => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        role="group"
        aria-label="Run mode"
        className="flex items-center gap-1 rounded-[var(--r)] p-1"
        style={{ background: "var(--stage-raise)" }}
      >
        {(["replay", "live"] as const).map((m) => {
          const active = mode === m;
          const off = m === "live" && !live;
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              disabled={off}
              title={
                off
                  ? (IS_STATIC ? "Live needs a server — this is a static site" : "Live needs ANTHROPIC_API_KEY on the server")
                  : m === "live" && downgraded
                    ? "The last live run fell back to replay. Press to try it again."
                    : undefined
              }
              onClick={() => onChange(m)}
              className="rounded-[var(--r)] px-3 py-1 text-xs font-medium capitalize transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                background: active ? "var(--signal)" : "transparent",
                color: active ? "#17120a" : "var(--stage-ink-2)",
                fontWeight: active ? 600 : 500,
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stage states. A blank screen mid-talk is the failure mode to design
 * against, so each of these is a composed panel, not a spinner.
 * ------------------------------------------------------------------ */

function StageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-busy="true" aria-live="polite">
      <div className="demo-skeleton h-16 w-full shrink-0" />
      <div className="demo-skeleton h-32 w-full shrink-0" />
      <div className="demo-skeleton h-24 w-full shrink-0" />
      <div className="demo-skeleton min-h-0 w-full flex-1" />
      <p className="sr-only">Loading the act.</p>
    </div>
  );
}

function StageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col justify-center rounded-[var(--r)] border px-8 py-10"
      style={{ borderColor: "var(--alarm)", background: "rgba(226, 112, 94, 0.06)" }}
      role="alert"
    >
      <p
        className="text-[11px] font-semibold tracking-[0.16em] uppercase"
        style={{ color: "var(--alarm)" }}
      >
        This act did not run
      </p>
      <p className="mt-3 max-w-[60ch] text-xl leading-snug">
        The run came back with an error, so there is no trace to play.
      </p>
      <p
        className="mt-3 max-w-[70ch] font-mono text-sm break-words"
        style={{ color: "var(--stage-ink-2)" }}
      >
        {message}
      </p>
      <div className="mt-6 flex items-center gap-3">
        {onRetry ? (
          <button type="button" className="demo-btn demo-btn--primary" onClick={onRetry}>
            Run it again
          </button>
        ) : null}
        <p className="text-sm" style={{ color: "var(--stage-ink-3)" }}>
          Or press a number key and move to the next act.
        </p>
      </div>
    </div>
  );
}

function StageEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="demo-panel flex min-h-0 flex-1 flex-col justify-center px-8 py-10">
      <p className="text-2xl leading-snug font-medium">{title}</p>
      <p
        className="mt-3 max-w-[62ch] text-base leading-relaxed"
        style={{ color: "var(--stage-ink-2)" }}
      >
        {body}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shortcuts
 * ------------------------------------------------------------------ */

const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ["Space", "Play or pause"],
  ["→", "Reveal the next event"],
  ["←", "Step back one event"],
  ["↓  /  J", "Next act"],
  ["↑  /  K", "Previous act"],
  ["1 - 5", "Jump straight to an act"],
  ["R", "Restart this act"],
  ["?", "Open or close this panel"],
];

function ShortcutsOverlay({ onClose, live }: { onClose: () => void; live: boolean }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: "rgba(6, 8, 11, 0.82)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="demo-swap demo-panel w-full max-w-[42rem] px-8 py-7"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-2xl font-semibold tracking-tight">Driving this from the keyboard</h2>
        <dl className="mt-6 grid grid-cols-2 gap-x-10 gap-y-3">
          {SHORTCUTS.map(([key, what]) => (
            <div key={key} className="flex items-center gap-3">
              <dt className="demo-key shrink-0">{key}</dt>
              <dd className="text-sm" style={{ color: "var(--stage-ink-2)" }}>
                {what}
              </dd>
            </div>
          ))}
        </dl>
        <p
          className="mt-7 border-t pt-5 text-sm leading-relaxed"
          style={{ borderColor: "var(--stage-line-soft)", color: "var(--stage-ink-2)" }}
        >
          {REPLAY_NOTE} A blocked refund in replay is blocked by the same pure function that
          blocks it in production.
          {live ? "" : ` ${LIVE_UNAVAILABLE}`}
        </p>
        <button ref={closeRef} type="button" className="demo-btn mt-6" onClick={onClose}>
          Close
          <span className="demo-key">Esc</span>
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Glue: revealed events -> pipeline stage states.
 *
 * Pure, and deliberately narrow. The diagram always describes the MOST RECENT
 * tool call (that is what the audience is looking at), while the store stage is
 * cumulative over the whole run, because a write does not get un-written.
 * ------------------------------------------------------------------ */

const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "issue_refund",
  "issue_store_credit",
  "escalate_to_human",
]);

function deriveFlow(visible: TraceEvent[]): FlowDiagramProps {
  const stages: Record<FlowStage, FlowStageState> = {
    model: "idle",
    hook: "idle",
    retry: "idle",
    handler: "idle",
    store: "idle",
  };
  if (visible.length === 0) return { stages, toolName: null, blockedRuleId: null };

  const toolOf = new Map<string, ToolName>();
  let storeWritten = false;
  let lastUse = -1;
  let sawModelOutput = false;
  let failed = false;
  let done = false;

  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    switch (e.t) {
      case "tool_use":
        toolOf.set(e.id, e.name);
        lastUse = i;
        break;
      case "thinking_delta":
      case "text_delta":
        sawModelOutput = true;
        break;
      case "escalation_injected":
        storeWritten = true;
        break;
      case "tool_result": {
        const name = toolOf.get(e.toolUseId);
        if (e.ok && name && WRITE_TOOLS.has(name)) storeWritten = true;
        break;
      }
      case "error":
        failed = true;
        break;
      case "done":
        done = true;
        break;
      default:
        break;
    }
  }

  stages.store = storeWritten ? "passed" : "idle";

  if (lastUse < 0) {
    // No tool call yet: the model is the only stage in play.
    stages.model = failed ? "failed" : done ? "passed" : sawModelOutput ? "active" : "idle";
    return { stages, toolName: null, blockedRuleId: null };
  }

  const use = visible[lastUse];
  const toolUseId = use.t === "tool_use" ? use.id : "";
  const toolName = use.t === "tool_use" ? use.name : null;

  let blockedRuleId: string | null = null;
  let verdictSeen = false;
  let attempts = 0;
  let resolved = false;
  let resultOk = false;
  let modelSpeaksAgain = false;

  for (let i = lastUse + 1; i < visible.length; i++) {
    const e = visible[i];
    switch (e.t) {
      case "hook_verdict":
        if (e.toolUseId !== toolUseId) break;
        verdictSeen = true;
        if (e.action === "block_and_escalate") blockedRuleId = e.ruleId;
        break;
      case "attempt":
        if (e.toolUseId === toolUseId) attempts = e.n;
        break;
      case "tool_result":
        if (e.toolUseId !== toolUseId) break;
        resolved = true;
        resultOk = e.ok;
        break;
      case "thinking_delta":
      case "text_delta":
        if (resolved) modelSpeaksAgain = true;
        break;
      default:
        break;
    }
  }

  stages.model = failed
    ? "failed"
    : modelSpeaksAgain && !done
      ? "active"
      : "passed";

  stages.hook = verdictSeen ? (blockedRuleId ? "blocked" : "passed") : "active";

  if (blockedRuleId) {
    // The whole point of the demo: a blocked call never reaches the handler,
    // so the retry policy and the handler stay dark.
    return { stages, toolName, blockedRuleId };
  }

  if (!verdictSeen) return { stages, toolName, blockedRuleId: null };

  stages.retry = !resolved
    ? "active"
    : resultOk
      ? "passed"
      : attempts > 1
        ? "failed"
        : "passed";

  stages.handler = !resolved ? "active" : resultOk ? "passed" : "failed";

  if (stages.store === "idle" && resultOk && toolName && WRITE_TOOLS.has(toolName)) {
    stages.store = "active";
  }

  return { stages, toolName, blockedRuleId: null };
}
