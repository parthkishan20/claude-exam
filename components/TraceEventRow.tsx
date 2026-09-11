"use client";

/**
 * TraceEventRow — renders one grouped item of the trace stream, plus buildTurns,
 * which folds the flat TraceEvent[] into per-turn groups and attaches each
 * hook_verdict / attempt / tool_result / escalation_injected to the tool_use it
 * belongs to.
 *
 * The single most important distinction this file encodes:
 *   BLOCKED  — governance (the hook) stopped the call before it ran.  rose + lock icon.
 *   FAILED   — the handler ran and returned an error envelope.        amber/orange + alert icon.
 * Different colour, different icon, different label, different verb ("block" vs "failure").
 */
import type { ToolName, ToolResultEnvelope, TraceEvent } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * model
 * ------------------------------------------------------------------ */

export interface ToolResultLike {
  ok: boolean;
  envelope: ToolResultEnvelope;
  ms: number;
}

export interface ToolBlock {
  id: string;
  name: ToolName;
  input: unknown;
  verdict?: { ruleId: string | null; action: "allow" | "block_and_escalate" };
  attempts: { n: number; of: number; retryAfterMs?: number }[];
  results: ToolResultLike[];
  escalation?: { escalationId: string; blockedReason: string };
}

export type TraceItem =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; block: ToolBlock }
  | { kind: "turn_end"; stopReason: string | null; usage: { input: number; output: number } }
  | { kind: "done" }
  | { kind: "error"; message: string };

export interface TurnGroup {
  turn: number | null;
  items: TraceItem[];
}

export function buildTurns(events: TraceEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const blocks = new Map<string, ToolBlock>();
  let cur: TurnGroup | null = null;

  const ensure = (): TurnGroup => {
    if (!cur) {
      cur = { turn: null, items: [] };
      groups.push(cur);
    }
    return cur;
  };

  for (const ev of events) {
    switch (ev.t) {
      case "turn_start": {
        cur = { turn: ev.turn, items: [] };
        groups.push(cur);
        break;
      }
      case "thinking_delta": {
        const items = ensure().items;
        const last = items[items.length - 1];
        if (last && last.kind === "thinking") last.text += ev.text;
        else items.push({ kind: "thinking", text: ev.text });
        break;
      }
      case "text_delta": {
        const items = ensure().items;
        const last = items[items.length - 1];
        if (last && last.kind === "text") last.text += ev.text;
        else items.push({ kind: "text", text: ev.text });
        break;
      }
      case "tool_use": {
        const block: ToolBlock = {
          id: ev.id,
          name: ev.name,
          input: ev.input,
          attempts: [],
          results: [],
        };
        blocks.set(ev.id, block);
        ensure().items.push({ kind: "tool", block });
        break;
      }
      case "hook_verdict": {
        const b = blocks.get(ev.toolUseId);
        if (b) b.verdict = { ruleId: ev.ruleId, action: ev.action };
        break;
      }
      case "attempt": {
        const b = blocks.get(ev.toolUseId);
        if (b) b.attempts.push({ n: ev.n, of: ev.of, retryAfterMs: ev.retryAfterMs });
        break;
      }
      case "tool_result": {
        const b = blocks.get(ev.toolUseId);
        if (b) b.results.push({ ok: ev.ok, envelope: ev.envelope, ms: ev.ms });
        break;
      }
      case "escalation_injected": {
        const b = blocks.get(ev.toolUseId);
        if (b) b.escalation = { escalationId: ev.escalationId, blockedReason: ev.blockedReason };
        break;
      }
      case "turn_end": {
        ensure().items.push({
          kind: "turn_end",
          stopReason: ev.stopReason,
          usage: ev.usage,
        });
        break;
      }
      case "done": {
        ensure().items.push({ kind: "done" });
        break;
      }
      case "error": {
        ensure().items.push({ kind: "error", message: ev.message });
        break;
      }
    }
  }
  return groups;
}

/* ------------------------------------------------------------------ *
 * icons
 * ------------------------------------------------------------------ */

type IconName = "lock" | "alert" | "check" | "route" | "dot";

function Icon({ name }: { name: IconName }) {
  const c = "h-3.5 w-3.5 shrink-0";
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
 * tool block
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

const STATUS_STYLE: Record<
  BlockStatus,
  { wrap: string; badge: string; label: string; icon: IconName }
> = {
  blocked: {
    wrap: "border-rose-300 bg-rose-50",
    badge: "bg-rose-100 text-rose-700 ring-rose-200",
    label: "Blocked by policy",
    icon: "lock",
  },
  "failed-validation": {
    wrap: "border-amber-300 bg-amber-50",
    badge: "bg-amber-100 text-amber-800 ring-amber-200",
    label: "Tool failed — validation",
    icon: "alert",
  },
  "failed-transient": {
    wrap: "border-orange-300 bg-orange-50",
    badge: "bg-orange-100 text-orange-800 ring-orange-200",
    label: "Tool failed — transient",
    icon: "alert",
  },
  ok: {
    wrap: "border-emerald-300 bg-emerald-50",
    badge: "bg-emerald-100 text-emerald-800 ring-emerald-200",
    label: "OK",
    icon: "check",
  },
  pending: {
    wrap: "border-slate-300 bg-white",
    badge: "bg-slate-100 text-slate-600 ring-slate-200",
    label: "Running",
    icon: "dot",
  },
};

function ToolBlockView({ block }: { block: ToolBlock }) {
  const status = blockStatus(block);
  const s = STATUS_STYLE[status];
  const lastResult = block.results[block.results.length - 1];
  const permResult = block.results.find(
    (r) => !r.envelope.success && r.envelope.errorCategory === "permission",
  );
  const receipt =
    permResult && !permResult.envelope.success ? permResult.envelope.escalation : undefined;
  const retried = block.attempts.length > 1 || (block.attempts[0]?.of ?? 1) > 1;

  return (
    <div className={`overflow-hidden rounded-lg border ${s.wrap}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <Icon name={s.icon} />
        <code className="font-mono text-xs font-semibold text-slate-900">{block.name}</code>
        <span
          className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset ${s.badge}`}
        >
          {s.label}
        </span>
        {block.verdict?.action === "allow" && (
          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
            policy check ✓
          </span>
        )}
        {status === "blocked" && block.verdict?.ruleId && (
          <code className="rounded bg-rose-100 px-1.5 py-0.5 font-mono text-[10px] text-rose-700">
            rule: {block.verdict.ruleId}
          </code>
        )}
        {lastResult && (
          <span className="ml-auto font-mono text-[10px] text-slate-400">{lastResult.ms} ms</span>
        )}
      </div>

      <div className="px-3 pb-2">
        <pre className="overflow-x-auto rounded-md bg-slate-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100">{JSON.stringify(block.input, null, 2)}</pre>
      </div>

      {block.attempts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          {block.attempts.map((a, i) => (
            <span
              key={i}
              className={`rounded-full px-2 py-0.5 font-mono text-[10px] ring-1 ring-inset ${
                retried
                  ? "bg-orange-100 text-orange-800 ring-orange-200"
                  : "bg-slate-100 text-slate-600 ring-slate-200"
              }`}
            >
              attempt {a.n}/{a.of}
              {a.retryAfterMs ? ` · waited ${a.retryAfterMs}ms` : ""}
            </span>
          ))}
          {retried && (
            <span className="text-[10px] font-medium uppercase tracking-wide text-orange-700">
              transient retry
            </span>
          )}
        </div>
      )}

      <div className="space-y-1.5 px-3 pb-2">
        {block.results.map((r, i) => (
          <ResultRow key={i} result={r} blocked={status === "blocked"} />
        ))}
      </div>

      {(block.escalation || receipt) && (
        <div className="mb-3 ml-3 mr-3 rounded-md border-l-4 border-violet-400 bg-violet-50 px-3 py-2">
          <div className="flex items-center gap-2">
            <Icon name="route" />
            <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-700">
              System routed this to a human
            </span>
          </div>
          <div className="mt-1 space-y-0.5 font-mono text-[11px] text-violet-800">
            {block.escalation && <div>escalation_id: {block.escalation.escalationId}</div>}
            {block.escalation && <div>blocked_reason: {block.escalation.blockedReason}</div>}
            {receipt && (
              <div>
                queue: {receipt.assigned_queue} · eta {receipt.eta_hours}h · {receipt.status}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ResultRow({ result, blocked }: { result: ToolResultLike; blocked: boolean }) {
  const env = result.envelope;

  if (env.success) {
    const { success: _ok, ...fields } = env;
    void _ok;
    return (
      <div className="rounded-md border border-emerald-200 bg-white px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
          <Icon name="check" /> result · {result.ms} ms
        </div>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-[11px]">
          {Object.entries(fields).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-slate-400">{k}</dt>
              <dd className="break-all text-slate-800">
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  const tone = blocked
    ? "border-rose-200 text-rose-800"
    : env.errorCategory === "transient"
      ? "border-orange-200 text-orange-800"
      : "border-amber-200 text-amber-800";

  return (
    <div className={`rounded-md border bg-white px-3 py-2 ${tone}`}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
        <Icon name={blocked ? "lock" : "alert"} />
        {env.errorCategory} {blocked ? "block" : "failure"} · {result.ms} ms
      </div>
      <p className="mt-1 text-xs leading-relaxed text-slate-700">{env.message}</p>
      {env.details && (
        <pre className="mt-1 overflow-x-auto rounded bg-slate-100 px-2 py-1 font-mono text-[10px] text-slate-600">{JSON.stringify(env.details)}</pre>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * row dispatch
 * ------------------------------------------------------------------ */

export function TraceEventRow({ item }: { item: TraceItem }) {
  switch (item.kind) {
    case "thinking":
      return (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            thinking
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-500">
            {item.text}
          </p>
        </div>
      );
    case "text":
      return (
        <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            assistant
          </div>
          <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-slate-700">
            {item.text}
          </p>
        </div>
      );
    case "tool":
      return <ToolBlockView block={item.block} />;
    case "turn_end":
      return (
        <div className="flex items-center gap-2 py-1 text-[10px] uppercase tracking-wide text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          turn ended · stop {item.stopReason ?? "—"} · tok {item.usage.input}→{item.usage.output}
          <span className="h-px flex-1 bg-slate-200" />
        </div>
      );
    case "done":
      return (
        <div className="text-center text-[10px] uppercase tracking-wide text-slate-300">
          stream complete
        </div>
      );
    case "error":
      return (
        <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
          error: {item.message}
        </div>
      );
    default:
      return null;
  }
}
