/**
 * ★ CONTRACT — frozen in Wave 0. Do not edit during Wave 1.
 * Every other module imports its shared vocabulary from here.
 */

export type ToolName =
  | "check_order_status"
  | "issue_refund"
  | "issue_store_credit"
  | "escalate_to_human";

export const TOOL_NAMES: readonly ToolName[] = [
  "check_order_status",
  "issue_refund",
  "issue_store_credit",
  "escalate_to_human",
] as const;

/* ------------------------------------------------------------------ *
 * Structured error contract (spec §2)
 * ------------------------------------------------------------------ */

export type ErrorCategory = "transient" | "validation" | "permission";

export interface EscalationReceipt {
  escalation_id: string;
  status: "queued";
  assigned_queue: string;
  eta_hours: number;
  /**
   * Populated ONLY by the hook on a rule-triggered redirect. It is deliberately
   * absent from the model-facing escalate_to_human schema, so a value here is
   * proof of a rule trigger — audit provenance is unambiguous.
   */
  blocked_reason?: string;
}

export type ToolSuccess<T = Record<string, unknown>> = { success: true } & T;

export interface ToolFailure {
  success: false;
  errorCategory: ErrorCategory;
  isRetryable: boolean;
  /** Human-readable, safe to relay to the user or feed back to the model. */
  message: string;
  details?: Record<string, unknown>;
  retryAfterMs?: number;
  /**
   * Present only on a hook-driven block. The escalation ALREADY HAPPENED,
   * deterministically, in code — this is the receipt, not a suggestion.
   */
  escalation?: EscalationReceipt;
}

export type ToolResultEnvelope<T = Record<string, unknown>> = ToolSuccess<T> | ToolFailure;

export function isFailure(e: ToolResultEnvelope): e is ToolFailure {
  return e.success === false;
}

/* ------------------------------------------------------------------ *
 * Domain
 * ------------------------------------------------------------------ */

export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

/** How the payment gateway behaves for this order — drives transient tests. */
export type GatewayBehavior = "ok" | "fail_once" | "always_fail";

export interface Order {
  order_id: string;
  account_id: string;
  status: OrderStatus;
  item_description: string;
  amount_paid: number;
  currency: string;
  purchase_date: string;
  refund_eligible: boolean;
  refund_window_days_remaining: number;
  /** Cash already refunded. Remaining refundable balance = amount_paid - this. */
  refunded_to_date: number;
  /** Non-refundable per policy: goodwill credit is the only remedy. */
  non_refundable: boolean;
  gateway_behavior: GatewayBehavior;
}

export interface Account {
  account_id: string;
  email: string;
  credit_balance: number;
}

export interface RefundRecord {
  refund_id: string;
  order_id: string;
  amount_refunded: number;
  reason: string;
  status: "processed" | "pending_gateway";
  estimated_days_to_reflect: number;
  at: string;
}

export interface CreditRecord {
  credit_id: string;
  account_id: string;
  order_id: string;
  amount_credited: number;
  new_account_balance: number;
  expires_at: string;
  at: string;
}

export interface EscalationRecord extends EscalationReceipt {
  order_id: string;
  issue_summary: string;
  requested_action: string;
  urgency: "low" | "medium" | "high";
  /** Server-stamped. "hook" = rule-triggered redirect, "model" = self-escalation. */
  source: "hook" | "model";
  at: string;
}

/* ------------------------------------------------------------------ *
 * Trace event stream — the ONLY interface between backend and UI.
 * One event per SSE frame: `data: ${JSON.stringify(ev)}\n\n`
 * ------------------------------------------------------------------ */

export type HookAction = "allow" | "block_and_escalate";

export type TraceEvent =
  | { t: "turn_start"; turn: number }
  | { t: "thinking_delta"; text: string }
  | { t: "text_delta"; text: string }
  | { t: "tool_use"; id: string; name: ToolName; input: unknown }
  | { t: "hook_verdict"; toolUseId: string; ruleId: string | null; action: HookAction }
  | { t: "attempt"; toolUseId: string; n: number; of: number; retryAfterMs?: number }
  | { t: "tool_result"; toolUseId: string; ok: boolean; envelope: ToolResultEnvelope; ms: number }
  | { t: "escalation_injected"; toolUseId: string; escalationId: string; blockedReason: string }
  | { t: "turn_end"; stopReason: string | null; usage: { input: number; output: number } }
  | { t: "done" }
  | { t: "error"; message: string };

export type Emit = (ev: TraceEvent) => void;

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

export interface HandlerContext {
  sessionId: string;
  emit: Emit;
}

/**
 * Handlers take UNVALIDATED input and validate it themselves, returning a
 * `validation` envelope on bad input. They must never throw — spec §2 requires
 * failures to come back as tool_result content the model can reason over.
 */
export type ToolHandler = (
  input: unknown,
  ctx: HandlerContext,
) => Promise<ToolResultEnvelope>;

export type HandlerRegistry = Record<ToolName, ToolHandler>;
