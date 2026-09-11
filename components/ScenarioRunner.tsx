"use client";

/**
 * ScenarioRunner — preset requests, each with a per-scenario expectation checked
 * against the returned TraceEvent[]. POSTs { scenarioId } to /api/scenarios and
 * falls back to components/mockTrace.ts's mockTraceFor when that 404s.
 *
 * The expectations lean on the spec's key asymmetry:
 *   - over-threshold refund  → expects hook_verdict:block_and_escalate + escalation, NO store credit
 *   - store-credit ceiling   → expects a validation failure + ZERO escalations, NO hook block
 */
import { useState } from "react";
import type { TraceEvent } from "@/lib/types";
import { mockTraceFor } from "./mockTrace";
import TracePanel from "./TracePanel";

interface Check {
  label: string;
  pass: boolean;
}

interface Scenario {
  id: string;
  /** Best-effort id for /api/scenarios (owned by another agent, different naming). */
  apiId?: string;
  title: string;
  prompt: string;
  expects: string;
  check: (e: TraceEvent[]) => Check[];
}

/** A trace with no real activity (no key / stub) — treat as "use the mock". */
function isUsableTrace(e: TraceEvent[]): boolean {
  return e.some((x) => x.t !== "error" && x.t !== "done" && x.t !== "turn_start");
}

/** /api/scenarios may return TraceEvent[] directly or { events: TraceEvent[] }. */
function extractEvents(data: unknown): TraceEvent[] | null {
  if (Array.isArray(data)) return data as TraceEvent[];
  if (data && typeof data === "object" && Array.isArray((data as { events?: unknown }).events)) {
    return (data as { events: TraceEvent[] }).events;
  }
  return null;
}

/* ---- assertions over the TraceEvent contract ---- */

const toolUseIds = (e: TraceEvent[], n: string): string[] =>
  e.flatMap((x) => (x.t === "tool_use" && x.name === n ? [x.id] : []));

const usesTool = (e: TraceEvent[], n: string) => toolUseIds(e, n).length > 0;

const hookBlocked = (e: TraceEvent[]) =>
  e.some((x) => x.t === "hook_verdict" && x.action === "block_and_escalate");

const escalationCount = (e: TraceEvent[]) =>
  e.filter((x) => x.t === "escalation_injected").length;

const hasFailure = (e: TraceEvent[], cat: "validation" | "transient" | "permission") =>
  e.some(
    (x) => x.t === "tool_result" && !x.envelope.success && x.envelope.errorCategory === cat,
  );

const maxAttemptOf = (e: TraceEvent[]) =>
  e.reduce((m, x) => (x.t === "attempt" ? Math.max(m, x.of) : m), 0);

const succeeds = (e: TraceEvent[], n: string) => {
  const ids = new Set(toolUseIds(e, n));
  return e.some(
    (x) => x.t === "tool_result" && ids.has(x.toolUseId) && x.envelope.success === true,
  );
};

/* ---- the preset list (later wired to evals/scenarios.ts) ---- */

const SCENARIOS: Scenario[] = [
  {
    id: "happy-refund",
    apiId: "happy-refund",
    title: "Happy refund",
    prompt: "Refund my order ORD-1234, $120, it was damaged",
    expects: "check_order_status then issue_refund succeeds; no hook block, no escalation.",
    check: (e) => [
      { label: "checks order status", pass: usesTool(e, "check_order_status") },
      { label: "issues a cash refund", pass: usesTool(e, "issue_refund") },
      { label: "refund succeeds", pass: succeeds(e, "issue_refund") },
      { label: "no policy block", pass: !hookBlocked(e) },
      { label: "no escalation", pass: escalationCount(e) === 0 },
    ],
  },
  {
    id: "over-threshold",
    apiId: "over-threshold-refund",
    title: "Over-threshold refund",
    prompt: "I need a $900 refund on ORD-7788, it arrived broken",
    expects: "hook blocks issue_refund and escalates; store credit is NOT substituted.",
    check: (e) => [
      { label: "attempts issue_refund", pass: usesTool(e, "issue_refund") },
      { label: "hook blocks + escalates", pass: hookBlocked(e) },
      { label: "escalation injected", pass: escalationCount(e) >= 1 },
      { label: "did NOT substitute store credit", pass: !usesTool(e, "issue_store_credit") },
      { label: "permission error surfaced", pass: hasFailure(e, "permission") },
    ],
  },
  {
    id: "outside-window",
    apiId: "outside-window",
    title: "Outside refund window",
    prompt: "Refund ORD-4521 please",
    expects: "issue_refund fails validation and steers to issue_store_credit; no hook, no escalation.",
    check: (e) => [
      { label: "checks order status", pass: usesTool(e, "check_order_status") },
      { label: "refund rejected (validation)", pass: hasFailure(e, "validation") },
      { label: "falls back to store credit", pass: usesTool(e, "issue_store_credit") },
      { label: "no policy block", pass: !hookBlocked(e) },
      { label: "no escalation", pass: escalationCount(e) === 0 },
    ],
  },
  {
    id: "store-credit-ceiling",
    apiId: "credit-ceiling",
    title: "Store-credit ceiling",
    prompt: "Give me $2500 store credit for ORD-9001",
    expects: "credit above $2000 is REJECTED as validation — never escalated (the asymmetry).",
    check: (e) => [
      { label: "attempts issue_store_credit", pass: usesTool(e, "issue_store_credit") },
      { label: "rejected as validation (ceiling)", pass: hasFailure(e, "validation") },
      { label: "NOT escalated", pass: escalationCount(e) === 0 },
      { label: "no hook block", pass: !hookBlocked(e) },
    ],
  },
  {
    id: "money-back-big",
    apiId: "money-back-big-order",
    title: "Money-back on a big order",
    prompt: "I want my money back for ORD-7788",
    expects: "routed to issue_refund (cash), which the hook blocks + escalates — not store credit.",
    check: (e) => [
      { label: "routes to issue_refund", pass: usesTool(e, "issue_refund") },
      { label: "not store credit", pass: !usesTool(e, "issue_store_credit") },
      { label: "hook blocks + escalates", pass: hookBlocked(e) },
      { label: "escalation injected", pass: escalationCount(e) >= 1 },
    ],
  },
  {
    id: "transient-gateway",
    apiId: "transient-retry",
    title: "Transient gateway",
    prompt: "Refund ORD-5150, $300, wrong item",
    expects: "gateway fails once, retries (attempt 1/2 → 2/2), refund ultimately succeeds; no escalation.",
    check: (e) => [
      { label: "issues refund", pass: usesTool(e, "issue_refund") },
      { label: "retried (attempt n of ≥ 2)", pass: maxAttemptOf(e) >= 2 },
      { label: "refund ultimately succeeds", pass: succeeds(e, "issue_refund") },
      { label: "no escalation", pass: escalationCount(e) === 0 },
    ],
  },
  {
    id: "unknown-order",
    apiId: "unknown-order",
    title: "Unknown order",
    prompt: "Refund ORD-0000",
    expects: "check_order_status returns a validation error; no writes, no escalation.",
    check: (e) => [
      { label: "checks order status", pass: usesTool(e, "check_order_status") },
      { label: "validation error (unknown order)", pass: hasFailure(e, "validation") },
      { label: "no refund succeeded", pass: !succeeds(e, "issue_refund") },
      { label: "no escalation", pass: escalationCount(e) === 0 },
    ],
  },
];

interface RunState {
  source: "api" | "mock";
  events: TraceEvent[];
  checks: Check[];
  pass: boolean;
}

export default function ScenarioRunner() {
  const [results, setResults] = useState<Record<string, RunState>>({});
  const [running, setRunning] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const run = async (s: Scenario) => {
    setRunning(s.id);
    let events: TraceEvent[];
    let source: "api" | "mock";
    try {
      const res = await fetch("/api/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenarioId: s.apiId ?? s.id }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const extracted = extractEvents(await res.json());
      // Fall back to the mock on a 404, a non-array payload, or a trace with no
      // real activity (e.g. the backend has no Anthropic key configured).
      if (!extracted || !isUsableTrace(extracted)) throw new Error("no usable trace");
      events = extracted;
      source = "api";
    } catch {
      events = mockTraceFor(s.id);
      source = "mock";
    }
    const checks = s.check(events);
    setResults((r) => ({
      ...r,
      [s.id]: { source, events, checks, pass: checks.every((c) => c.pass) },
    }));
    setRunning(null);
  };

  const runAll = async () => {
    for (const s of SCENARIOS) {
      // eslint-disable-next-line no-await-in-loop
      await run(s);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-slate-50 px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Scenario runner
        </h2>
        <button
          onClick={runAll}
          disabled={running !== null}
          className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          Run all
        </button>
      </div>

      <div className="space-y-2">
        {SCENARIOS.map((s) => {
          const r = results[s.id];
          return (
            <div key={s.id} className="rounded-lg border border-slate-200 bg-white">
              <div className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-900">{s.title}</span>
                    {r && (
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset ${
                          r.pass
                            ? "bg-emerald-100 text-emerald-800 ring-emerald-200"
                            : "bg-rose-100 text-rose-700 ring-rose-200"
                        }`}
                      >
                        {r.pass ? "pass" : "fail"}
                      </span>
                    )}
                    {r && (
                      <span className="text-[10px] uppercase tracking-wide text-slate-400">
                        via {r.source}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">{s.prompt}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{s.expects}</p>
                </div>
                <button
                  onClick={() => run(s)}
                  disabled={running !== null}
                  className="rounded-md border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  {running === s.id ? "Running…" : "Run"}
                </button>
              </div>

              {r && (
                <div className="border-t border-slate-100 px-3 py-2">
                  <ul className="space-y-0.5">
                    {r.checks.map((c, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-xs">
                        <span className={c.pass ? "text-emerald-600" : "text-rose-600"}>
                          {c.pass ? "✓" : "✕"}
                        </span>
                        <span className={c.pass ? "text-slate-600" : "font-medium text-rose-700"}>
                          {c.label}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => setOpen(open === s.id ? null : s.id)}
                    className="mt-1.5 text-[11px] font-medium text-indigo-600 hover:underline"
                  >
                    {open === s.id ? "Hide trace" : `View trace (${r.events.length} events)`}
                  </button>
                  {open === s.id && (
                    <div className="mt-2 h-80 overflow-hidden rounded-md border border-slate-200">
                      <TracePanel events={r.events} />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
