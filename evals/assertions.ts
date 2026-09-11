/**
 * Assertion helpers over the TraceEvent contract + the resulting store state.
 * Pure functions — no I/O — so the same checks run against a live trace and a
 * replayed fixture.
 */
import type { SessionStore } from "@/lib/store/db";
import type { ToolFailure, ToolName, TraceEvent } from "@/lib/types";

export interface Assertion {
  label: string;
  pass: boolean;
}

export function expect(label: string, pass: boolean): Assertion {
  return { label, pass };
}

/** A frozen snapshot of the store after a scenario run. */
export interface EvalWorld {
  store: Pick<SessionStore, "refunds" | "credits" | "escalations">;
}

export function snapshotWorld(store: SessionStore): EvalWorld {
  return {
    store: {
      refunds: [...store.refunds],
      credits: [...store.credits],
      escalations: [...store.escalations],
    },
  };
}

/* ---- trace queries ---- */

export function toolCalls(t: TraceEvent[]): ToolName[] {
  return t.flatMap((e) => (e.t === "tool_use" ? [e.name] : []));
}

export function usesTool(t: TraceEvent[], name: ToolName): boolean {
  return t.some((e) => e.t === "tool_use" && e.name === name);
}

function idsOf(t: TraceEvent[], name: ToolName): Set<string> {
  return new Set(t.flatMap((e) => (e.t === "tool_use" && e.name === name ? [e.id] : [])));
}

export function succeeded(t: TraceEvent[], name: ToolName): boolean {
  const ids = idsOf(t, name);
  return t.some((e) => e.t === "tool_result" && ids.has(e.toolUseId) && e.envelope.success === true);
}

export function finalToolResultFailure(t: TraceEvent[], name: ToolName): ToolFailure | null {
  const ids = idsOf(t, name);
  let last: ToolFailure | null = null;
  for (const e of t) {
    if (e.t === "tool_result" && ids.has(e.toolUseId) && !e.envelope.success) {
      last = e.envelope;
    }
  }
  return last;
}

/** Number of `attempt` events recorded for a given tool. */
export function attemptsFor(t: TraceEvent[], name: ToolName): number {
  const ids = idsOf(t, name);
  return t.filter((e) => e.t === "attempt" && ids.has(e.toolUseId)).length;
}

export function escalationInjectedCount(t: TraceEvent[]): number {
  return t.filter((e) => e.t === "escalation_injected").length;
}

/**
 * True iff every write tool_use is preceded by at least one check_order_status
 * tool_use. Spec §1: "Always call this first when an order is referenced."
 */
export function checkedBeforeWrite(t: TraceEvent[]): boolean {
  let checked = false;
  for (const e of t) {
    if (e.t !== "tool_use") continue;
    if (e.name === "check_order_status") checked = true;
    else if ((e.name === "issue_refund" || e.name === "issue_store_credit") && !checked) {
      return false;
    }
  }
  return true;
}
