/**
 * ★ DEMO CONTRACT — frozen before the demo build wave. Do not edit during the wave.
 *
 * Demo Mode is a presenter-driven walkthrough of the agent at /demo. Every piece
 * of it (act data, playback engine, shell, visualisation components) compiles
 * against the vocabulary in this file, so the pieces can be built in parallel
 * and still fit together.
 *
 * The one idea worth holding onto: a demo run is NOT a re-enactment. Replay
 * drives the REAL dispatch pipeline (hook gate -> retry policy -> handlers ->
 * audit -> store) with a canned model, so the enforcement the audience watches
 * is the enforcement that ships. Only the model's turn is scripted.
 */
import type { Assertion, EvalWorld } from "@/evals/assertions";
import type { ToolName, TraceEvent } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Narration anchors
 *
 * A beat is pinned to a POSITION IN THE TRACE, never to a raw index —
 * indices differ between replay and live, and a demo that mis-times its
 * narration in front of an audience is worse than no narration. Anchors are
 * resolved against the actual events at run time by lib/demo/anchors.ts.
 * ------------------------------------------------------------------ */

export type BeatAnchor =
  | { kind: "start" }
  | { kind: "end" }
  | { kind: "index"; i: number }
  | { kind: "tool_use"; name: ToolName; nth?: number }
  | { kind: "result"; name: ToolName; ok?: boolean; nth?: number }
  | { kind: "attempt"; n: number }
  | { kind: "hook_block" }
  | { kind: "escalation" };

/** `resolveAnchor` returns the event index an anchor lands on, or null if absent. */
export type AnchorResolver = (anchor: BeatAnchor, events: TraceEvent[]) => number | null;

export type BeatKind =
  /** Frames what is about to happen. */
  | "setup"
  /** Explains a mechanism as it fires. */
  | "insight"
  /** THE point of the act — rendered with emphasis. At most one per act. */
  | "moment"
  /** Lands the takeaway after the mechanism has played out. */
  | "payoff";

export interface Beat {
  id: string;
  at: BeatAnchor;
  kind: BeatKind;
  /** Short — it is read aloud, or read off a screen from the back of a room. */
  title: string;
  body: string;
}

/** A beat whose anchor has been resolved against a concrete trace. */
export interface ResolvedBeat extends Beat {
  /** Event index this beat becomes current at. */
  index: number;
}

/* ------------------------------------------------------------------ *
 * Acts
 * ------------------------------------------------------------------ */

export interface DemoAct {
  /** Stable slug used in the URL: /demo?act=<id>. */
  id: string;
  /** Scenario in evals/scenarios.ts this act replays. null = a static act. */
  scenarioId: string | null;
  /** Presenter headline. */
  title: string;
  /** One line under the headline. */
  subtitle: string;
  /** What the audience should watch for, said before playback starts. */
  watchFor: string;
  /** The sentence to land after playback ends. */
  takeaway: string;
  /** Spec clauses this act pins, mirrored from the scenario. */
  refs: string[];
  beats: Beat[];
  /** Rough time on stage, used for the agenda view. */
  durationHintSec: number;
}

/* ------------------------------------------------------------------ *
 * A run of one act — the payload of GET/POST /api/demo
 * ------------------------------------------------------------------ */

export type DemoMode = "replay" | "live";

export interface DemoRun {
  actId: string;
  scenarioId: string;
  title: string;
  /** The customer turns, in order — shown as the chat side of the stage. */
  turns: string[];
  mode: DemoMode;
  events: TraceEvent[];
  assertions: Assertion[];
  passed: boolean;
  finalText: string;
  /** Store snapshot AFTER the run: refunds, credits, escalations. */
  world: EvalWorld | null;
  /**
   * Fatal: there is no run to show, and the stage must say so. A live attempt
   * that FELL BACK to replay is not fatal — see `notice`.
   */
  error: string | null;
  /**
   * Non-blocking. Something was downgraded but the act is still playable, so
   * the stage shows this beside the act rather than instead of it.
   *
   * The case that matters: `mode: "live"` was requested, the key turned out to
   * be absent or rejected, and the run came back as replay. Mid-talk the
   * correct behaviour is to keep going and be honest about what is on screen —
   * `mode` always reports what actually ran, and this says why it differs.
   */
  notice: string | null;
}

/* ------------------------------------------------------------------ *
 * Playback engine (lib/demo/usePlayback.ts)
 * ------------------------------------------------------------------ */

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlaybackState {
  /** The full trace. */
  events: TraceEvent[];
  /** events.slice(0, cursor + 1) — what the stage may render. */
  visible: TraceEvent[];
  /** Index of the last revealed event; -1 before anything is revealed. */
  cursor: number;
  isPlaying: boolean;
  isFinished: boolean;
  speed: Speed;
}

export interface PlaybackControls {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Reveal the next event. Pauses first if playing. */
  stepForward: () => void;
  stepBack: () => void;
  /** Jump the playhead to an absolute event index (clamped). */
  seek: (i: number) => void;
  restart: () => void;
  setSpeed: (s: Speed) => void;
}

export type Playback = PlaybackState & { controls: PlaybackControls };

/* ------------------------------------------------------------------ *
 * Component prop contracts — so the shell and the visualisations compile
 * against each other without either having been written yet.
 * ------------------------------------------------------------------ */

/** The five stages of the dispatch pipeline, in order. */
export type FlowStage =
  | "model"
  | "hook"
  | "retry"
  | "handler"
  | "store";

export type FlowStageState = "idle" | "active" | "passed" | "blocked" | "failed";

export interface FlowDiagramProps {
  /** Per-stage state derived from the events revealed so far. */
  stages: Record<FlowStage, FlowStageState>;
  /** Tool currently in flight, if any. */
  toolName: ToolName | null;
  /** Rule id when the hook blocked, e.g. "refund_threshold". */
  blockedRuleId: string | null;
}

export interface AssertionChecklistProps {
  assertions: Assertion[];
  /** True once playback has reached the end; before that, show them pending. */
  revealed: boolean;
}

export interface StoreLedgerProps {
  world: EvalWorld | null;
  /** Dim the ledger until playback finishes — the payoff is the diff. */
  revealed: boolean;
}

export interface TraceStageProps {
  /** Only the events the playhead has reached. */
  visible: TraceEvent[];
  /** Index of the event the playhead is on, for emphasis. */
  cursor: number;
  /** Index of the "moment" beat's event, highlighted hard. */
  momentIndex: number | null;
}

export interface NarrationCardProps {
  beat: ResolvedBeat | null;
  /** Position within the act's beats, for the progress dots. */
  n: number;
  total: number;
}
