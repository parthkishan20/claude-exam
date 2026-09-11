/**
 * ★ CONTRACT — frozen in Wave 0. Do not edit during Wave 1.
 *
 * The MODEL-FACING tool definitions. Descriptions are verbatim from the spec:
 * they do the disambiguation work for the confusable issue_refund /
 * issue_store_credit pair, which is the hardest part of tool selection here.
 *
 * NOTE: escalate_to_human deliberately OMITS the spec's `blocked_reason` field.
 * It is hook-populated only. Because the model cannot set it, a value in the
 * audit log is proof of a rule trigger rather than a model-invented string.
 */
import type Anthropic from "@anthropic-ai/sdk";

const ORDER_ID = {
  type: "string" as const,
  pattern: "^ORD-[0-9]{4,}$",
  description: "Order identifier, e.g. ORD-7788",
};

export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: "check_order_status",
    description:
      "Retrieves current status and details for an order. Read-only — does not modify anything. " +
      "Call this before issue_refund or issue_store_credit to confirm refund eligibility, amount paid, " +
      "and purchase date. Returns an error if the order_id does not exist.",
    input_schema: {
      type: "object",
      properties: { order_id: ORDER_ID },
      required: ["order_id"],
    },
  },
  {
    name: "issue_refund",
    description:
      "Refunds money to the customer's original payment method for a specific order. Use only when the " +
      "order is within its refund-eligibility window and was paid in real currency (confirm both via " +
      "check_order_status first). This reverses the original charge. Do NOT use for orders outside the " +
      "refund window, or as a goodwill gesture on a non-refundable item — use issue_store_credit instead " +
      "in those cases. amount must not exceed the order's remaining refundable balance.",
    input_schema: {
      type: "object",
      properties: {
        order_id: ORDER_ID,
        amount: { type: "number", exclusiveMinimum: 0 },
        reason: {
          type: "string",
          enum: ["damaged", "wrong_item", "not_as_described", "customer_changed_mind", "other"],
        },
      },
      required: ["order_id", "amount", "reason"],
    },
  },
  {
    name: "issue_store_credit",
    description:
      "Issues account credit (not cash) redeemable on future purchases. Use when: (a) the order is outside " +
      "its refund-eligibility window but a goodwill gesture is appropriate, (b) the item is non-refundable " +
      "per policy, or (c) the customer explicitly agrees to credit instead of cash back. This does NOT " +
      "reverse the original payment and does NOT require escalation regardless of amount, since no cash " +
      "leaves the business — do not use it as a way to avoid escalating a large cash refund. If the " +
      "customer expects money back, use issue_refund instead, even if that means the request gets escalated.",
    input_schema: {
      type: "object",
      properties: {
        order_id: ORDER_ID,
        amount: { type: "number", exclusiveMinimum: 0, maximum: 2000 },
        reason: { type: "string" },
      },
      required: ["order_id", "amount", "reason"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hands off the current issue to a human agent or manager. Use when: a business rule blocks an " +
      "automated action, the request can't be resolved with the other tools, or the customer explicitly " +
      "asks for a person. Terminal for the concern it's called on — don't call another tool for that same " +
      "concern afterward, though unrelated concerns in the same message can still be handled normally.",
    input_schema: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        issue_summary: { type: "string" },
        requested_action: { type: "string" },
        urgency: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["order_id", "issue_summary", "requested_action", "urgency"],
    },
  },
];
