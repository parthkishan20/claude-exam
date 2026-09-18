"use client";

/**
 * StoreLedger — what actually CHANGED in the world after the run: refunds,
 * credits, escalations. The payoff of an act is the diff, so the ledger stays
 * withheld (dimmed and defocused) until `revealed`.
 *
 * The distinction this component exists to prove is escalation provenance.
 * `blocked_reason` is deliberately absent from the model-facing
 * escalate_to_human schema (see EscalationReceipt in lib/types.ts) and is
 * stamped only by the dispatcher on a rule-triggered redirect. So
 * `source: "hook"` plus a blocked_reason is proof the system routed the call,
 * and `source: "model"` with no blocked_reason is proof the model chose to.
 * Both are labelled in words, and the absent field is shown as absent rather
 * than hidden, because the absence is the evidence.
 *
 * Empty states carry meaning here. "No refund recorded" next to a hook-sourced
 * escalation is not a blank table, it is the point of the act, so it says why.
 */
import type { StoreLedgerProps } from "@/lib/demo/types";
import type { EscalationRecord } from "@/lib/types";
import { TRACE_TOKENS } from "./FlowDiagram";

/* ------------------------------------------------------------------ *
 * glyphs
 * ------------------------------------------------------------------ */

/** Same path as TraceEventRow's "route": the system redirecting a call. */
function Route({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 ${className}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path d="M7 3a3 3 0 00-3 3v6.17a3.001 3.001 0 101.5 0V6A1.5 1.5 0 017 4.5h4.879l-1.44 1.44a.75.75 0 101.061 1.06l2.75-2.75a.75.75 0 000-1.06l-2.75-2.75a.75.75 0 10-1.06 1.06L11.878 3H7z" />
    </svg>
  );
}

/** A speech mark: the model asking for help of its own accord. */
function Speak({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 ${className}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M10 2c-4.418 0-8 2.91-8 6.5 0 1.9 1.003 3.61 2.6 4.79V17a.5.5 0 00.77.42l2.62-1.7c.65.12 1.33.18 2.01.18 4.418 0 8-2.91 8-6.5S14.418 2 10 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * pieces
 * ------------------------------------------------------------------ */

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number | null;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-3">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-[var(--t-ink-2)]">
          {title}
        </h4>
        {count !== null && (
          <span className="font-mono text-sm text-[var(--t-ink-3)]">{count}</span>
        )}
        <span className="h-px flex-1 bg-[var(--t-line-soft)]" />
      </div>
      {children}
    </section>
  );
}

function Empty({ headline, note }: { headline: string; note?: string }) {
  return (
    <div className="rounded-[var(--t-r)] border border-dashed border-[var(--t-line)] px-4 py-3">
      <p className="text-base font-medium text-[var(--t-ink-2)]">{headline}</p>
      {note && <p className="mt-1 text-sm leading-relaxed text-[var(--t-ink-2)]">{note}</p>}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-[var(--t-r)] border border-[var(--t-line)] bg-[var(--t-raise)] px-4 py-3">
      {children}
    </li>
  );
}

function EscalationRow({ e }: { e: EscalationRecord }) {
  const byHook = e.source === "hook";
  return (
    <li
      className={`rounded-[var(--t-r)] border-2 px-4 py-3 ${
        byHook
          ? "border-[var(--t-route)] bg-[var(--t-route-soft)]"
          : "border-[var(--t-line)] bg-[var(--t-raise)]"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={`inline-flex items-center gap-1.5 rounded-[var(--t-r)] px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
            byHook
              ? "bg-[var(--t-route)] text-[var(--t-on-fill)]"
              : "bg-[var(--t-line)] text-[var(--t-ink-2)]"
          }`}
        >
          {byHook ? <Route /> : <Speak />}
          {byHook ? "raised by the hook" : "raised by the model"}
        </span>
        <code className="font-mono text-sm font-semibold text-[var(--t-ink)]">
          {e.escalation_id}
        </code>
        <code className="font-mono text-sm text-[var(--t-ink-2)]">{e.order_id}</code>
      </div>

      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
        <span className="text-[var(--t-ink-2)]">blocked_reason</span>
        {byHook && e.blocked_reason ? (
          <span className="break-all font-semibold text-[var(--t-route)]">{e.blocked_reason}</span>
        ) : (
          <span className="text-[var(--t-ink-3)]">absent, the model cannot set this field</span>
        )}
        <span className="text-[var(--t-ink-2)]">queue</span>
        <span className="text-[var(--t-ink)]">
          {e.assigned_queue} · eta {e.eta_hours}h · {e.urgency} urgency
        </span>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * component
 * ------------------------------------------------------------------ */

export default function StoreLedger({ world, revealed }: StoreLedgerProps) {
  if (!world) {
    return (
      <section
        aria-label="Store"
        className="demo-trace rounded-[var(--t-r)] border border-dashed border-[var(--t-line)] px-5 py-6"
      >
        <style href="demo-trace-tokens" precedence="medium">
          {TRACE_TOKENS}
        </style>
        <h3 className="text-lg font-semibold tracking-tight text-[var(--t-ink-2)] md:text-xl">
          The store has not been read yet
        </h3>
        <p className="mt-1 max-w-[52ch] text-sm leading-relaxed text-[var(--t-ink-3)]">
          Refunds, credits and escalations are snapshotted after the run finishes.
        </p>
      </section>
    );
  }

  const { refunds, credits, escalations } = world.store;
  // A refund that was never recorded, next to a hook-sourced escalation, is
  // proof the handler was never reached. That is not an empty table.
  const blockedByHook = escalations.some((e) => e.source === "hook");
  const changes = refunds.length + credits.length + escalations.length;

  return (
    <section
      aria-label="Store"
      className="demo-trace flex h-full flex-col overflow-hidden rounded-[var(--t-r)] border border-[var(--t-line-soft)] bg-[var(--t-panel)]"
    >
      <style href="demo-trace-tokens" precedence="medium">
        {TRACE_TOKENS}
      </style>

      <header className="shrink-0 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-3">
        <h3 className="text-base font-semibold tracking-tight text-[var(--t-ink)]">
          What changed in the world
        </h3>
        <span className="font-mono text-xs text-[var(--t-ink-2)]">
          {revealed
            ? changes === 1
              ? "1 record written"
              : `${changes} records written`
            : "shown when the run finishes"}
        </span>
      </header>

      <div
        className={`min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 pb-4 motion-safe:transition-all motion-safe:duration-500 ${
          revealed ? "opacity-100 blur-0" : "select-none opacity-40 blur-[3px]"
        }`}
        aria-hidden={!revealed}
      >
        <Section title="Refunds" count={revealed ? refunds.length : null}>
          {refunds.length === 0 ? (
            <Empty
              headline="No refund recorded."
              note={
                blockedByHook
                  ? "The hook blocked the call, so the refund handler was never reached."
                  : undefined
              }
            />
          ) : (
            <ul className="space-y-2">
              {refunds.map((r) => (
                <Row key={r.refund_id}>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--t-ok)]">
                    {money(r.amount_refunded)}
                  </span>
                  <code className="font-mono text-sm text-[var(--t-ink-2)]">{r.order_id}</code>
                  <code className="font-mono text-sm text-[var(--t-ink-3)]">{r.refund_id}</code>
                  <span className="ml-auto font-mono text-sm text-[var(--t-ink-2)]">
                    {r.status} · {r.estimated_days_to_reflect} days
                  </span>
                </Row>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Store credits" count={revealed ? credits.length : null}>
          {credits.length === 0 ? (
            <Empty headline="No store credit issued." />
          ) : (
            <ul className="space-y-2">
              {credits.map((c) => (
                <Row key={c.credit_id}>
                  <span className="font-mono text-2xl font-semibold tabular-nums text-[var(--t-ink)]">
                    {money(c.amount_credited)}
                  </span>
                  <code className="font-mono text-sm text-[var(--t-ink-2)]">{c.order_id}</code>
                  <code className="font-mono text-sm text-[var(--t-ink-3)]">{c.credit_id}</code>
                  <span className="ml-auto font-mono text-sm text-[var(--t-ink-2)]">
                    balance {money(c.new_account_balance)} · expires {c.expires_at.slice(0, 10)}
                  </span>
                </Row>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Escalations" count={revealed ? escalations.length : null}>
          {escalations.length === 0 ? (
            <Empty headline="No escalation raised." />
          ) : (
            <ul className="space-y-2">
              {escalations.map((e) => (
                <EscalationRow key={e.escalation_id} e={e} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </section>
  );
}
