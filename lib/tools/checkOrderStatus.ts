/**
 * Handler for `check_order_status`. See docs/refund-agent-spec.md §1.
 *
 * Contract: NEVER throws. Validates its own input and returns a `validation`
 * envelope on bad input, so every failure reaches the model as tool_result
 * content it can reason over (spec §2).
 *
 * WAVE 1 — AGENT A owns this file.
 */
import { z } from "zod";
import { ok, validationError } from "../errors";
import { getSession, remainingRefundable } from "../store/db";
import type { HandlerContext, ToolResultEnvelope } from "../types";

const ORDER_ID = /^ORD-[0-9]{4,}$/;

const InputSchema = z.object({
  order_id: z
    .string({ message: "order_id is required and must be a string." })
    .regex(ORDER_ID, "order_id must look like ORD-1234 (^ORD-[0-9]{4,}$)."),
});

/** Read-only. No side effects, ever — the hook never blocks this tool. */
export async function checkOrderStatus(
  input: unknown,
  ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  try {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return validationError(
        `Invalid input for check_order_status: ${issue?.message ?? "malformed input"}`,
        { field: issue?.path.join(".") || "input" },
      );
    }

    const { order_id } = parsed.data;
    const store = getSession(ctx.sessionId);
    const order = store.orders.get(order_id);

    if (!order) {
      return validationError(
        `No order found with id ${order_id}. Ask the customer to confirm the order number.`,
        { field: "order_id", order_id },
      );
    }

    return ok({
      order_id: order.order_id,
      status: order.status,
      item_description: order.item_description,
      amount_paid: order.amount_paid,
      currency: order.currency,
      purchase_date: order.purchase_date,
      refund_eligible: order.refund_eligible,
      refund_window_days_remaining: order.refund_window_days_remaining,
      // Not in the spec's literal success list, but the agent cannot choose a
      // valid refund amount without it (see ORD-3300, the partial-refund case).
      remaining_refundable: remainingRefundable(order),
      non_refundable: order.non_refundable,
    });
  } catch (err) {
    // Belt and braces: a handler must never throw (spec §2).
    return validationError(
      `check_order_status could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
