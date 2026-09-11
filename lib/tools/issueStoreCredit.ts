/**
 * Handler for `issue_store_credit`. See docs/refund-agent-spec.md §1.
 *
 * Contract: NEVER throws. Validates its own input and returns a `validation`
 * envelope on bad input, so every failure reaches the model as tool_result
 * content it can reason over (spec §2).
 *
 * THE ASYMMETRY (lib/config.ts): the store-credit ceiling is a SYSTEM INVARIANT,
 * not a business rule. No cash leaves the business and no human approval flow
 * exists for credit, so exceeding the ceiling is REJECTED here as a validation
 * error — it is never blocked-and-escalated the way an over-threshold refund is.
 *
 * WAVE 1 — AGENT A owns this file.
 */
import { z } from "zod";
import { LIMITS } from "../config";
import { ok, validationError } from "../errors";
import { getSession, nextId } from "../store/db";
import type { CreditRecord, HandlerContext, ToolResultEnvelope } from "../types";

const ORDER_ID = /^ORD-[0-9]{4,}$/;

const InputSchema = z.object({
  order_id: z
    .string({ message: "order_id is required and must be a string." })
    .regex(ORDER_ID, "order_id must look like ORD-1234 (^ORD-[0-9]{4,}$)."),
  amount: z
    .number({ message: "amount is required and must be a number." })
    .finite("amount must be a finite number.")
    .positive("amount must be greater than 0."),
  reason: z
    .string({ message: "reason is required and must be a string." })
    .min(1, "reason must not be empty."),
});

/** Credit expires 12 months from issue. */
function expiryFrom(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export async function issueStoreCredit(
  input: unknown,
  ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  try {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return validationError(
        `Invalid input for issue_store_credit: ${issue?.message ?? "malformed input"}`,
        { field: issue?.path.join(".") || "input" },
      );
    }

    // `reason` is validated above (required, non-empty) but CreditRecord has no
    // field for it, so it is not carried onto the record.
    const { order_id, amount } = parsed.data;
    const store = getSession(ctx.sessionId);

    // (1) unknown order
    const order = store.orders.get(order_id);
    if (!order) {
      return validationError(
        `No order found with id ${order_id}. Ask the customer to confirm the order number.`,
        { field: "order_id", order_id },
      );
    }

    // (2) hard system ceiling — a REJECTION, not an escalation. There is no
    // human approval path for store credit, so this is the end of the road:
    // the only remedy is a smaller credit amount.
    if (amount > LIMITS.storeCreditCeiling) {
      return validationError(
        `Store credit of $${amount} cannot be issued: the system ceiling for store credit is $${LIMITS.storeCreditCeiling} per credit. ` +
          `There is no manager-approval path for store credit, so this cannot be escalated — issue $${LIMITS.storeCreditCeiling} or less, or handle the remainder another way.`,
        {
          field: "amount",
          max_allowed: LIMITS.storeCreditCeiling,
          ceiling: LIMITS.storeCreditCeiling,
          requested_amount: amount,
          escalatable: false,
        },
      );
    }

    const account = store.accounts.get(order.account_id);
    if (!account) {
      return validationError(
        `No account found for order ${order_id} (account ${order.account_id}). Store credit cannot be applied.`,
        { field: "order_id", order_id, account_id: order.account_id },
      );
    }

    // (3) success — credit the account.
    const credit_id = nextId(store, "CRD");
    const now = new Date();
    const new_account_balance =
      Math.round((account.credit_balance + amount) * 100) / 100;
    account.credit_balance = new_account_balance;

    const expires_at = expiryFrom(now);
    const record: CreditRecord = {
      credit_id,
      account_id: account.account_id,
      order_id,
      amount_credited: amount,
      new_account_balance,
      expires_at,
      at: now.toISOString(),
    };
    store.credits.push(record);

    return ok({
      credit_id,
      account_id: account.account_id,
      amount_credited: amount,
      new_account_balance,
      expires_at,
    });
  } catch (err) {
    return validationError(
      `issue_store_credit could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
