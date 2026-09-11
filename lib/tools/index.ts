/**
 * Handler registry. The dispatcher resolves tools through this map only —
 * there is no other path from a tool_use block to a side effect.
 *
 * WAVE 1 — AGENT A owns this file.
 */
import type { HandlerRegistry } from "../types";
import { checkOrderStatus } from "./checkOrderStatus";
import { issueRefund } from "./issueRefund";
import { issueStoreCredit } from "./issueStoreCredit";
import { escalateToHuman } from "./escalateToHuman";

export const HANDLERS: HandlerRegistry = {
  check_order_status: checkOrderStatus,
  issue_refund: issueRefund,
  issue_store_credit: issueStoreCredit,
  escalate_to_human: escalateToHuman,
};

export { checkOrderStatus, issueRefund, issueStoreCredit, escalateToHuman };
