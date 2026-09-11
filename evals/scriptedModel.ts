/**
 * A deterministic stand-in for the model, used ONLY by the replay/offline eval
 * path. Each entry is the sequence of assistant turns a competent agent SHOULD
 * produce for that scenario — the tool calls it makes and, between them, how it
 * reacts to the structured results it gets back.
 *
 * This lets the eval suite exercise the REAL hook, dispatcher, handlers, retry
 * policy and audit log with zero API credentials. It does NOT test the model's
 * own tool selection — that is what `RECORD=1 npm run eval` (live) is for.
 * Regenerate fixtures against the real model whenever the schemas or system
 * prompt change materially.
 */
import type { ToolName } from "@/lib/types";

export interface ScriptedToolUse {
  name: ToolName;
  input: Record<string, unknown>;
}
export interface ScriptedTurn {
  /** Assistant prose for this turn (kept short — traces don't assert on it). */
  text?: string;
  toolUses?: ScriptedToolUse[];
}

export const SCRIPTS: Record<string, ScriptedTurn[]> = {
  "happy-refund": [
    { text: "Let me pull up that order.", toolUses: [{ name: "check_order_status", input: { order_id: "ORD-1234" } }] },
    { text: "It's within the refund window — processing your $120 refund now.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-1234", amount: 120, reason: "damaged" } }] },
    { text: "Your $120 refund is on its way back to your card." },
  ],

  "over-threshold-refund": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-7788" } }] },
    { text: "This is eligible — issuing the $900 refund.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-7788", amount: 900, reason: "damaged" } }] },
    { text: "A refund of this size needs manager sign-off, so it's already been routed to a human — you don't need to do anything else." },
  ],

  "outside-window": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-4521" } }] },
    { text: "Trying the refund.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-4521", amount: 180, reason: "not_as_described" } }] },
    { text: "This order is past its refund window, but I can offer store credit instead — shall I?" },
    { text: "Applying $180 in store credit.", toolUses: [{ name: "issue_store_credit", input: { order_id: "ORD-4521", amount: 180, reason: "goodwill — outside refund window" } }] },
    { text: "$180 in store credit is on your account." },
  ],

  "credit-ceiling": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-9001" } }] },
    { text: "Issuing $2500 in store credit.", toolUses: [{ name: "issue_store_credit", input: { order_id: "ORD-9001", amount: 2500, reason: "item not as described, final sale" } }] },
    { text: "I can't issue store credit above our $2000 limit, and there's no approval path to raise it. I'd suggest splitting the resolution or speaking with our team about the difference." },
  ],

  "money-back-big-order": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-7788" } }] },
    { text: "Understood — you want cash back, not credit. Submitting the refund.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-7788", amount: 900, reason: "customer_changed_mind" } }] },
    { text: "Because it's over our auto-approval limit it's gone to a manager for sign-off. You'll hear back shortly." },
  ],

  "transient-retry": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-5150" } }] },
    { text: "Processing your $300 refund.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-5150", amount: 300, reason: "wrong_item" } }] },
    { text: "The payment gateway hiccuped once but the $300 refund went through on retry." },
  ],

  "transient-exhausted": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-5151" } }] },
    { text: "Processing your $300 refund.", toolUses: [{ name: "issue_refund", input: { order_id: "ORD-5151", amount: 300, reason: "damaged" } }] },
    { text: "The payment gateway is failing repeatedly right now. I wasn't able to complete the refund — please try again later or I can have someone follow up." },
  ],

  "unknown-order": [
    { toolUses: [{ name: "check_order_status", input: { order_id: "ORD-0000" } }] },
    { text: "I can't find an order ORD-0000 — could you double-check the number? It should look like ORD-1234." },
  ],

  "two-concerns-one-message": [
    {
      text: "Looking up both orders.",
      toolUses: [
        { name: "check_order_status", input: { order_id: "ORD-7788" } },
        { name: "check_order_status", input: { order_id: "ORD-1234" } },
      ],
    },
    {
      text: "Submitting both refunds.",
      toolUses: [
        { name: "issue_refund", input: { order_id: "ORD-7788", amount: 900, reason: "damaged" } },
        { name: "issue_refund", input: { order_id: "ORD-1234", amount: 120, reason: "damaged" } },
      ],
    },
    { text: "The $120 refund on ORD-1234 is done. The $900 refund on ORD-7788 exceeds our auto-approval limit and has been routed to a manager." },
  ],
};
