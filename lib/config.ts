/**
 * ★ CONTRACT — frozen in Wave 0. Do not edit during Wave 1.
 *
 * The two money limits live side by side on purpose: their ASYMMETRY is the
 * single most important thing to understand about this system.
 *
 *   refundEscalationThreshold — a BUSINESS RULE. Cash is leaving the business,
 *     and a human approval path exists, so exceeding it BLOCKS the call and
 *     deterministically routes to escalate_to_human. Enforced by the hook in
 *     lib/hooks/gate.ts, BEFORE the handler is ever reached.
 *
 *   storeCreditCeiling — a SYSTEM INVARIANT. No cash leaves the business and
 *     NO human approval flow exists for credit, so exceeding it is simply
 *     REJECTED as a validation error. It is never escalated. Enforced inside
 *     the handler (lib/tools/issueStoreCredit.ts), not by the hook.
 *
 * Blocking and rejecting are different outcomes with different governance.
 * Anything that collapses them has misunderstood the spec.
 */
export const LIMITS = {
  /** > threshold → hook BLOCKS and escalates (human approval path exists) */
  refundEscalationThreshold: Number(process.env.REFUND_ESCALATION_THRESHOLD ?? 500),
  /** > ceiling → handler REJECTS outright (no approval path exists) */
  storeCreditCeiling: Number(process.env.STORE_CREDIT_CEILING ?? 2000),
  /** Cap on attempts for a `transient` failure. Spec §2 assumes 2. */
  maxTransientAttempts: Number(process.env.MAX_TRANSIENT_ATTEMPTS ?? 2),
  /** Hard stop on the agentic loop so a misbehaving turn can never spin. */
  maxLoopIterations: Number(process.env.MAX_LOOP_ITERATIONS ?? 12),
} as const;

/**
 * Where transient retries happen.
 *   "system" — the dispatcher retries with backoff; the model sees one final
 *              tool_result. Deterministic, cannot depend on model follow-through.
 *   "agent"  — the transient envelope is handed to the model, which decides to
 *              retry. A loop guard still caps identical calls at maxTransientAttempts.
 * Same axis as the hook's system-driven vs agent-driven redirect, and for the
 * same reason. Default "system"; flip it to demonstrate the difference.
 */
export const RETRY_MODE: "system" | "agent" =
  process.env.RETRY_MODE === "agent" ? "agent" : "system";

/**
 * Sonnet tier — ~5x cheaper input / ~1.7x cheaper output than Opus 5
 * ($3/$15 vs $5/$25 per MTok). Every Sonnet tier is priced the same, so
 * "cheapest Sonnet" comes down to which one still works with the codebase:
 * `claude-sonnet-4-6` is the oldest that supports `thinking: {type:"adaptive"}`
 * (Sonnet 4 / 4.5 need the removed `budget_tokens` form; Sonnet 3.x is retired).
 * For genuinely minimal cost, `claude-haiku-4-5` is $1/$5.
 */
export const MODEL = process.env.REFUND_AGENT_MODEL ?? "claude-sonnet-4-6";
export const MAX_TOKENS = 64000;
