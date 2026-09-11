/**
 * ★ CONTRACT — frozen in Wave 0.
 * Every fixture exists to drive one named scenario. Do not add or edit orders
 * without adding the scenario that consumes them.
 */
import type { Account, Order } from "../types";

const iso = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

export const SEED_ORDERS: Order[] = [
  {
    // Scenario 1 — happy path. Small, eligible, well under the threshold.
    order_id: "ORD-1234",
    account_id: "acct_1001",
    status: "delivered",
    item_description: "Ceramic pour-over coffee dripper",
    amount_paid: 120,
    currency: "USD",
    purchase_date: iso(10),
    refund_eligible: true,
    refund_window_days_remaining: 20,
    refunded_to_date: 0,
    non_refundable: false,
    gateway_behavior: "ok",
  },
  {
    // Scenario 2 & 5 — THE hook case. Eligible in every way except the amount,
    // so the ONLY thing that can stop it is the programmatic rule.
    order_id: "ORD-7788",
    account_id: "acct_1001",
    status: "delivered",
    item_description: 'Standing desk, 60" walnut',
    amount_paid: 900,
    currency: "USD",
    purchase_date: iso(18),
    refund_eligible: true,
    refund_window_days_remaining: 12,
    refunded_to_date: 0,
    non_refundable: false,
    gateway_behavior: "ok",
  },
  {
    // Scenario 3 — outside the window. Refund must fail validation and the
    // error must steer the agent to issue_store_credit.
    order_id: "ORD-4521",
    account_id: "acct_1002",
    status: "delivered",
    item_description: "Merino wool blanket",
    amount_paid: 180,
    currency: "USD",
    purchase_date: iso(96),
    refund_eligible: false,
    refund_window_days_remaining: 0,
    refunded_to_date: 0,
    non_refundable: false,
    gateway_behavior: "ok",
  },
  {
    // Scenario 4 — THE asymmetry case. A credit above the ceiling is REJECTED,
    // never escalated. Contrast with ORD-7788 above.
    order_id: "ORD-9001",
    account_id: "acct_1003",
    status: "delivered",
    item_description: "Bespoke framed print (final sale)",
    amount_paid: 2500,
    currency: "USD",
    purchase_date: iso(40),
    refund_eligible: false,
    refund_window_days_remaining: 0,
    refunded_to_date: 0,
    non_refundable: true,
    gateway_behavior: "ok",
  },
  {
    // Scenario 6a — gateway times out once, then succeeds on attempt 2.
    order_id: "ORD-5150",
    account_id: "acct_1002",
    status: "delivered",
    item_description: "Mechanical keyboard, tactile switches",
    amount_paid: 300,
    currency: "USD",
    purchase_date: iso(5),
    refund_eligible: true,
    refund_window_days_remaining: 25,
    refunded_to_date: 0,
    non_refundable: false,
    gateway_behavior: "fail_once",
  },
  {
    // Scenario 6b — gateway never recovers. Must surface failure after the
    // attempt cap, and must NOT loop.
    order_id: "ORD-5151",
    account_id: "acct_1002",
    status: "delivered",
    item_description: "Desk lamp, brass",
    amount_paid: 300,
    currency: "USD",
    purchase_date: iso(5),
    refund_eligible: true,
    refund_window_days_remaining: 25,
    refunded_to_date: 0,
    non_refundable: false,
    gateway_behavior: "always_fail",
  },
  {
    // Partial-refund case — proves `amount > remaining refundable balance`
    // is computed from refunded_to_date, not from amount_paid.
    order_id: "ORD-3300",
    account_id: "acct_1003",
    status: "delivered",
    item_description: "Cast iron skillet set",
    amount_paid: 400,
    currency: "USD",
    purchase_date: iso(8),
    refund_eligible: true,
    refund_window_days_remaining: 22,
    refunded_to_date: 250,
    non_refundable: false,
    gateway_behavior: "ok",
  },
];

// Scenario 7 uses ORD-0000, which is deliberately absent above.

export const SEED_ACCOUNTS: Account[] = [
  { account_id: "acct_1001", email: "dana@example.com", credit_balance: 0 },
  { account_id: "acct_1002", email: "sam@example.com", credit_balance: 25 },
  { account_id: "acct_1003", email: "rio@example.com", credit_balance: 0 },
];
