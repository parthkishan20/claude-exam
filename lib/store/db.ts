/**
 * ★ CONTRACT — frozen in Wave 0.
 *
 * In-memory, per-session store. Each session gets a deep clone of the seed so
 * scenarios never contaminate each other — that isolation is what makes the
 * eval suite repeatable. Cached on globalThis so Next's dev hot-reload doesn't
 * silently reset state mid-conversation.
 */
import type {
  Account,
  CreditRecord,
  EscalationRecord,
  Order,
  RefundRecord,
} from "../types";
import { SEED_ACCOUNTS, SEED_ORDERS } from "./seed";

export interface SessionStore {
  sessionId: string;
  orders: Map<string, Order>;
  accounts: Map<string, Account>;
  refunds: RefundRecord[];
  credits: CreditRecord[];
  escalations: EscalationRecord[];
  /** Gateway attempt counter per order — drives `fail_once` behaviour. */
  gatewayAttempts: Map<string, number>;
  seq: number;
}

const g = globalThis as unknown as { __refundSessions?: Map<string, SessionStore> };
const sessions: Map<string, SessionStore> = (g.__refundSessions ??= new Map());

function freshStore(sessionId: string): SessionStore {
  return {
    sessionId,
    orders: new Map(SEED_ORDERS.map((o) => [o.order_id, { ...o }])),
    accounts: new Map(SEED_ACCOUNTS.map((a) => [a.account_id, { ...a }])),
    refunds: [],
    credits: [],
    escalations: [],
    gatewayAttempts: new Map(),
    seq: 0,
  };
}

export function getSession(sessionId: string): SessionStore {
  let s = sessions.get(sessionId);
  if (!s) {
    s = freshStore(sessionId);
    sessions.set(sessionId, s);
  }
  return s;
}

export function resetSession(sessionId: string): SessionStore {
  const s = freshStore(sessionId);
  sessions.set(sessionId, s);
  return s;
}

/** Monotonic per-session id generator — keeps traces readable and comparable. */
export function nextId(store: SessionStore, prefix: string): string {
  store.seq += 1;
  return `${prefix}-${String(4000 + store.seq)}`;
}

/** Cash still refundable on this order. NOT the same as amount_paid. */
export function remainingRefundable(order: Order): number {
  return Math.round((order.amount_paid - order.refunded_to_date) * 100) / 100;
}
