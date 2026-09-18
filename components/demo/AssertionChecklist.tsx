"use client";

/**
 * AssertionChecklist — the act's canonical assertions, the same ones
 * `npm run eval` runs (evals/assertions.ts computes them from the real trace).
 *
 * Before `revealed` the verdicts are withheld, not guessed: every row shows its
 * claim next to an explicitly unresolved slot, so the audience reads them as
 * predictions about to be tested. On reveal they resolve in sequence.
 *
 * A failure is never swallowed: the panel border and header turn to the block
 * colour, the count is stated in words, and the failing row is filled rather
 * than merely ticked differently.
 */
import type { AssertionChecklistProps } from "@/lib/demo/types";
import { TRACE_TOKENS } from "./FlowDiagram";

const CSS = `
@keyframes demo-check-in {
  from { opacity: 0.3; transform: translateX(-6px); }
  to { opacity: 1; transform: translateX(0); }
}
@media (prefers-reduced-motion: no-preference) {
  .demo-check-row { animation: demo-check-in 300ms cubic-bezier(0.16, 1, 0.3, 1) both; }
}
`;

function Check({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 ${className}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.052-.143z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function Cross({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`h-5 w-5 shrink-0 ${className}`}
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M5.28 4.22a.75.75 0 00-1.06 1.06L8.94 10l-4.72 4.72a.75.75 0 101.06 1.06L10 11.06l4.72 4.72a.75.75 0 101.06-1.06L11.06 10l4.72-4.72a.75.75 0 00-1.06-1.06L10 8.94 5.28 4.22z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function AssertionChecklist({ assertions, revealed }: AssertionChecklistProps) {
  const total = assertions.length;
  const passed = assertions.filter((a) => a.pass).length;
  const failed = total - passed;
  const anyFailed = revealed && failed > 0;

  return (
    <section
      aria-label="Assertions"
      className={`demo-trace flex h-full flex-col overflow-hidden rounded-[var(--t-r)] border-2 motion-safe:transition-colors motion-safe:duration-500 ${
        anyFailed ? "border-[var(--t-block)]" : "border-[var(--t-line-soft)]"
      }`}
    >
      <style href="demo-trace-tokens" precedence="medium">
        {TRACE_TOKENS}
      </style>
      <style href="demo-assertion-checklist" precedence="medium">
        {CSS}
      </style>

      <header
        className={`shrink-0 px-5 py-3 motion-safe:transition-colors motion-safe:duration-500 ${
          anyFailed
            ? "bg-[var(--t-block-soft)]"
            : revealed
              ? "bg-[var(--t-ok-soft)]"
              : "bg-[var(--t-raise)]"
        }`}
      >
        <h3 className="text-base font-semibold tracking-tight text-[var(--t-ink)]">
          {total === 0
            ? "No assertions for this act"
            : !revealed
              ? `${total} machine checks, pending`
              : anyFailed
                ? `${passed} of ${total} passed. ${failed} failed.`
                : `${passed} of ${total} passed`}
        </h3>
        <p
          className={`mt-0.5 text-xs leading-snug ${
            anyFailed ? "text-[var(--t-block)]" : "text-[var(--t-ink-2)]"
          }`}
        >
          {total === 0
            ? "No machine-checked claims in this act."
            : "Machine-checked by npm run eval, not narration."}
        </p>
      </header>

      {total > 0 && (
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[var(--t-panel)]">
          {assertions.map((a, i) => {
            const failing = revealed && !a.pass;
            return (
              <li
                key={`${revealed ? "r" : "p"}-${i}-${a.label}`}
                className={`demo-check-row flex gap-3 border-t border-[var(--t-line-soft)] px-5 first:border-t-0 ${
                  revealed ? "items-start py-3.5" : "items-center py-2"
                } ${
                  failing ? "bg-[var(--t-block-soft)]" : ""
                }`}
                style={{ animationDelay: revealed ? `${i * 70}ms` : "0ms" }}
              >
                {/* hairline rail — square, and present only on a failure */}
                <span
                  aria-hidden
                  className={`mt-0.5 w-1 self-stretch ${
                    failing ? "bg-[var(--t-block)]" : "bg-transparent"
                  }`}
                />
                {!revealed ? (
                  <span
                    aria-hidden
                    className="mt-0.5 h-5 w-5 shrink-0 rounded-[var(--t-r)] border-2 border-dashed border-[var(--t-line)]"
                  />
                ) : a.pass ? (
                  <Check className="mt-0.5 text-[var(--t-ok)]" />
                ) : (
                  <Cross className="mt-0.5 text-[var(--t-block)]" />
                )}

                <span
                  title={a.label}
                  className={`min-w-0 flex-1 text-sm ${
                    !revealed
                      ? "truncate text-[var(--t-ink-2)]"
                      : failing
                        ? "leading-snug font-semibold text-[var(--t-ink)]"
                        : "leading-snug text-[var(--t-ink)]"
                  }`}
                >
                  {a.label}
                </span>

                <span
                  className={`shrink-0 rounded-[var(--t-r)] px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wide ${
                    !revealed
                      ? "bg-[var(--t-raise)] text-[var(--t-ink-2)]"
                      : a.pass
                        ? "bg-[var(--t-ok)] text-[var(--t-on-fill)]"
                        : "bg-[var(--t-block-hot)] text-white"
                  }`}
                >
                  {!revealed ? "pending" : a.pass ? "pass" : "fail"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
