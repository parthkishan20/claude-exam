/**
 * Handler for `escalate_to_human`. See docs/refund-agent-spec.md §1.
 *
 * Contract: NEVER throws. Validates its own input and returns a `validation`
 * envelope on bad input, so every failure reaches the model as tool_result
 * content it can reason over (spec §2). Otherwise it always succeeds — filing
 * a ticket has no failure mode worth modelling.
 *
 * TWO CALLERS:
 *   - the MODEL, self-escalating            → source "model", no blocked_reason
 *   - the HOOK, redirecting programmatically → source "hook", blocked_reason set
 * `blocked_reason` is absent from the model-facing schema in schemas.ts, so a
 * value present here is proof of a rule trigger rather than a model-invented
 * string. We accept it on input for exactly that reason.
 *
 * WAVE 1 — AGENT A owns this file.
 */
import { z } from "zod";
import { ok, validationError } from "../errors";
import { getSession, nextId } from "../store/db";
import type {
  EscalationRecord,
  HandlerContext,
  ToolResultEnvelope,
} from "../types";

const URGENCIES = ["low", "medium", "high"] as const;
type Urgency = (typeof URGENCIES)[number];

const InputSchema = z.object({
  order_id: z
    .string({ message: "order_id is required and must be a string." })
    .min(1, "order_id must not be empty."),
  issue_summary: z
    .string({ message: "issue_summary is required and must be a string." })
    .min(1, "issue_summary must not be empty."),
  requested_action: z
    .string({ message: "requested_action is required and must be a string." })
    .min(1, "requested_action must not be empty."),
  urgency: z.enum(URGENCIES, {
    message: `urgency must be one of: ${URGENCIES.join(", ")}.`,
  }),
  /** Hook-only. Never settable by the model (omitted from its schema). */
  blocked_reason: z.string().min(1).optional(),
  /** Hook-only override, so a rule can name its own queue. */
  assigned_queue: z.string().min(1).optional(),
});

const ETA_BY_URGENCY: Record<Urgency, number> = { high: 2, medium: 8, low: 24 };

function deriveQueue(
  urgency: Urgency,
  blockedReason: string | undefined,
  text: string,
): string {
  const haystack = `${blockedReason ?? ""} ${text}`.toLowerCase();
  if (blockedReason) {
    // A rule-triggered block over a money threshold needs an approver, not
    // general support.
    if (haystack.includes("refund") || haystack.includes("threshold")) {
      return "refund-approvals";
    }
    return "policy-exceptions";
  }
  if (haystack.includes("refund") && haystack.includes("approval")) {
    return "refund-approvals";
  }
  return urgency === "high" ? "support-priority" : "support-general";
}

export async function escalateToHuman(
  input: unknown,
  ctx: HandlerContext,
): Promise<ToolResultEnvelope> {
  try {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return validationError(
        `Invalid input for escalate_to_human: ${issue?.message ?? "malformed input"}`,
        { field: issue?.path.join(".") || "input" },
      );
    }

    const {
      order_id,
      issue_summary,
      requested_action,
      urgency,
      blocked_reason,
      assigned_queue,
    } = parsed.data;

    const store = getSession(ctx.sessionId);
    const escalation_id = nextId(store, "ESC");

    const source: "hook" | "model" = blocked_reason ? "hook" : "model";
    const queue =
      assigned_queue ??
      deriveQueue(urgency, blocked_reason, `${issue_summary} ${requested_action}`);
    // Approval queues are staffed continuously; general support is not.
    const eta_hours =
      queue === "refund-approvals"
        ? Math.min(ETA_BY_URGENCY[urgency], 4)
        : ETA_BY_URGENCY[urgency];

    const record: EscalationRecord = {
      escalation_id,
      status: "queued",
      assigned_queue: queue,
      eta_hours,
      ...(blocked_reason ? { blocked_reason } : {}),
      order_id,
      issue_summary,
      requested_action,
      urgency,
      source,
      at: new Date().toISOString(),
    };
    store.escalations.push(record);

    return ok({
      escalation_id,
      status: "queued" as const,
      assigned_queue: queue,
      eta_hours,
      ...(blocked_reason ? { blocked_reason } : {}),
    });
  } catch (err) {
    return validationError(
      `escalate_to_human could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
