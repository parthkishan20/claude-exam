/**
 * Handler for `issue_refund`. See docs/refund-agent-spec.md §1.
 *
 * Contract: NEVER throws. Validates its own input and returns a `validation`
 * envelope on bad input, so every failure reaches the model as tool_result
 * content it can reason over (spec §2).
 *
 * NOTE — there is deliberately NO $500 check in this file. That threshold is a
 * BUSINESS RULE enforced by the hook in lib/dispatch.ts / lib/hooks/gate.ts
 * BEFORE this handler is ever reached. Duplicating it here would obscure which
 * layer actually enforces it (lib/config.ts explains the asymmetry).
 *
 * WAVE 1 — AGENT A owns this file.
 */
import { z } from "zod";
import { ok, transientError, validationError } from "../errors";
import { getSession, nextId, remainingRefundable } from "../store/db";
import type { HandlerContext, RefundRecord, ToolResultEnvelope } from "../types";

const ORDER_ID = /^ORD-[0-9]{4,}$/;

const REASONS = [
  "damaged",
  "wrong_item",
  "not_as_described",
  "customer_changed_mind",
  "other",
] as const;

const InputSchema = z.object({
  order_id: z
    .string({ message: "order_id is required and must be a string." })
    .regex(ORDER_ID, "order_id must look like ORD-1234 (^ORD-[0-9]{4,}$)."),
  amount: z
    .number({ message: "amount is required and must be a number." })
    .finite("amount must be a finite number.")
    .positive("amount must be greater than 0."),
  reason: z.enum(REASONS, {
    message: `reason must be one of: ${REASONS.join(", ")}.`,
  }),
});

/** Gateway retry hint, matching the spec §2 worked example. */
const GATEWAY_RETRY_MS = 2000;
const ESTIMATED_DAYS_TO_REFLECT = 5;

export async function issueRefund(
  input: unknown,
  ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  try {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return validationError(
        `Invalid input for issue_refund: ${issue?.message ?? "malformed input"}`,
        { field: issue?.path.join(".") || "input" },
      );
    }

    const { order_id, amount, reason } = parsed.data;
    const store = getSession(ctx.sessionId);

    // (1) unknown order
    const order = store.orders.get(order_id);
    if (!order) {
      return validationError(
        `No order found with id ${order_id}. Ask the customer to confirm the order number.`,
        { field: "order_id", order_id },
      );
    }

    // (2) amount exceeds the REMAINING refundable balance (not amount_paid)
    const remaining = remainingRefundable(order);
    if (amount > remaining) {
      return validationError(
        `Requested refund ($${amount}) exceeds the order's refundable balance ($${remaining}).`,
        { field: "amount", max_allowed: remaining },
      );
    }

    // (3) outside the refund window, or non-refundable per policy. The message
    // is what steers tool re-selection, so it names issue_store_credit outright.
    if (!order.refund_eligible || order.non_refundable) {
      const why = order.non_refundable
        ? `Order ${order_id} (${order.item_description}) is non-refundable per policy`
        : `Order ${order_id} is outside its refund-eligibility window (${order.refund_window_days_remaining} days remaining)`;
      return validationError(
        `${why}, so a cash refund cannot be issued. Use issue_store_credit instead if a goodwill gesture is appropriate.`,
        {
          field: "order_id",
          order_id,
          refund_eligible: order.refund_eligible,
          non_refundable: order.non_refundable,
          refund_window_days_remaining: order.refund_window_days_remaining,
          suggested_tool: "issue_store_credit",
        },
      );
    }

    // (4) payment gateway simulation, driven by the per-order attempt counter.
    const attempt = (store.gatewayAttempts.get(order_id) ?? 0) + 1;
    store.gatewayAttempts.set(order_id, attempt);

    const gatewayFails =
      order.gateway_behavior === "always_fail" ||
      (order.gateway_behavior === "fail_once" && attempt === 1);

    if (gatewayFails) {
      return transientError(
        "Payment gateway timed out processing the refund. Retrying shortly.",
        GATEWAY_RETRY_MS,
        { order_id, attempt },
      );
    }

    // (5) success — record the refund and move the money.
    const refund_id = nextId(store, "REF");
    const record: RefundRecord = {
      refund_id,
      order_id,
      amount_refunded: amount,
      reason,
      status: "processed",
      estimated_days_to_reflect: ESTIMATED_DAYS_TO_REFLECT,
      at: new Date().toISOString(),
    };
    store.refunds.push(record);
    order.refunded_to_date =
      Math.round((order.refunded_to_date + amount) * 100) / 100;

    return ok({
      refund_id,
      order_id,
      amount_refunded: amount,
      status: "processed" as const,
      estimated_days_to_reflect: ESTIMATED_DAYS_TO_REFLECT,
    });
  } catch (err) {
    return validationError(
      `issue_refund could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
