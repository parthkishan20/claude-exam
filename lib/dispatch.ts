/**
 * THE SINGLE CHOKE POINT. Every tool_use block in the system passes through
 * here, and there is no other route from a model request to a side effect.
 *
 *   dispatch = hook gate → (block+escalate) | (retry policy → real handler)
 *
 * WAVE 1 — AGENT B owns this file.
 *
 * CRITICAL — how the system-driven redirect actually works:
 * A system-driven redirect CANNOT fabricate a tool_use block. The assistant
 * turn is whatever the model produced; you cannot append a synthetic assistant
 * message carrying an invented escalate_to_human call (two consecutive
 * assistant turns are invalid, and it would corrupt audit provenance).
 *
 * So when the hook blocks, THIS function calls escalate_to_human itself, in
 * code, and returns ONE envelope for the blocked tool_use_id carrying both the
 * permission error and the escalation receipt. The model never chooses to
 * escalate — it is told the escalation already happened and reports that.
 */
import { attachEscalationId, logAuditEvent } from "./audit";
import { LIMITS, RETRY_MODE } from "./config";
import { permissionError } from "./errors";
import { runHook } from "./hooks/gate";
import { getRuleById, numericField, stringField, type Rule } from "./hooks/rules";
import { HANDLERS } from "./tools";
import type {
  EscalationReceipt,
  HandlerContext,
  ToolFailure,
  ToolName,
  ToolResultEnvelope,
} from "./types";

export interface ToolUseRequest {
  id: string;
  name: ToolName;
  input: unknown;
}

export interface DispatchOptions {
  /**
   * Overrides lib/config's RETRY_MODE for this call. Exists so the UI can demo
   * both philosophies side by side in one process, and so tests can exercise
   * both without re-importing the module. Defaults to the configured mode.
   */
  retryMode?: "system" | "agent";
}

/* ------------------------------------------------------------------ *
 * Retry-loop guard — "never loop indefinitely" (spec §2), in BOTH modes.
 *
 * system mode: the dispatcher owns the retry loop, so a single dispatch()
 *   already caps itself at LIMITS.maxTransientAttempts.
 * agent mode: the dispatcher does NOT retry — the transient envelope goes
 *   straight back to the model, which decides whether to call again. Nothing
 *   in that path is bounded by construction, so the bound has to be kept here:
 *   a per-session counter keyed on (tool, canonical input). It counts only
 *   dispatches that ENDED transiently, and is cleared the moment that exact
 *   call succeeds. Once a key has burned maxTransientAttempts real attempts,
 *   the next identical call is refused WITHOUT touching the handler and the
 *   model is told, in the envelope, that retrying is pointless.
 *
 * The same counter also stops a system-mode model from re-issuing a call that
 * already exhausted its retries internally.
 * ------------------------------------------------------------------ */
const g = globalThis as unknown as { __refundRetryGuard?: Map<string, number> };
const retryGuard: Map<string, number> = (g.__refundRetryGuard ??= new Map());

/** Key-order-independent serialization, so {a,b} and {b,a} are one call. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

function guardKey(sessionId: string, name: ToolName, input: unknown): string {
  return `${sessionId}\u0000${name}\u0000${canonical(input)}`;
}

/** Test/dev helper — the guard is process-wide state, like the store. */
export function resetRetryGuard(sessionId?: string): void {
  if (sessionId === undefined) {
    retryGuard.clear();
    return;
  }
  for (const key of [...retryGuard.keys()]) {
    if (key.startsWith(`${sessionId}\u0000`)) retryGuard.delete(key);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  // Test-only knob: RETRY_SLEEP_SCALE=0 makes backoff instantaneous so the
  // suite does not spend real seconds proving the loop waited.
  const scale = Number(process.env.RETRY_SLEEP_SCALE ?? 1);
  const delay = Math.max(0, Math.round(ms * (Number.isFinite(scale) ? scale : 1)));
  if (delay === 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function isTransient(res: ToolResultEnvelope): res is ToolFailure {
  return res.success === false && res.errorCategory === "transient";
}

/**
 * A tool_result envelope for a call that blew through its attempt cap.
 *
 * Deliberate exception to "always build envelopes with lib/errors constructors":
 * this is a `transient` failure whose `isRetryable` has been flipped to false.
 * The category is diagnostic (the gateway really did time out) but the retry
 * policy has been spent, and the model must not try again. Category and flag
 * carry different information here, and the message says so in words too — a
 * model that reads only prose and a model that reads only fields both get it.
 */
function retriesExhausted(
  last: ToolFailure | null,
  attemptsMade: number,
  cap: number,
  req: ToolUseRequest,
  mode: "system" | "agent",
): ToolFailure {
  const base = last?.message ?? `The ${req.name} call failed transiently.`;
  const envelope: ToolFailure = {
    success: false,
    errorCategory: "transient",
    isRetryable: false,
    message:
      `${base} This call has now failed ${attemptsMade} time(s) and the retry cap ` +
      `of ${cap} is exhausted — retrying ${req.name} with identical parameters will ` +
      `NOT succeed and must not be attempted again. Tell the customer the payment ` +
      `processor is currently unavailable, and use escalate_to_human if they need ` +
      `this resolved now.`,
    details: {
      ...(last?.details ?? {}),
      retry_exhausted: true,
      attempts_made: attemptsMade,
      max_attempts: cap,
      retry_mode: mode,
      original_category: "transient",
      original_retryable: true,
    },
  };
  // retryAfterMs is intentionally dropped: a wait hint on a call that must not
  // be repeated is an invitation to repeat it.
  return envelope;
}

/** A handler that throws breaks its contract — contain it, never crash the loop. */
function handlerThrew(name: string, err: unknown): ToolFailure {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    success: false,
    errorCategory: "transient",
    isRetryable: false,
    message:
      `The ${name} tool failed unexpectedly and could not be completed. This is a ` +
      `system fault, not a problem with the request — do not retry it. Apologise to ` +
      `the customer and use escalate_to_human if they need this resolved now.`,
    details: { internal_error: true, tool: name, cause: detail },
  };
}

/* ------------------------------------------------------------------ *
 * The system-driven redirect
 * ------------------------------------------------------------------ */

/**
 * Build the escalate_to_human input from the blocked call. Every field is
 * DERIVED — from the tool input and the rule that fired. No model discretion
 * is involved anywhere in this function, which is the whole point: the same
 * blocked call always produces the same escalation.
 */
function deriveEscalationInput(
  req: ToolUseRequest,
  rule: Rule,
): Record<string, unknown> {
  const orderId = stringField(req.input, "order_id") ?? "unknown";
  const amount = numericField(req.input, "amount");
  const reason = stringField(req.input, "reason");
  const amountText = amount === null ? "an unstated amount" : `$${amount}`;

  return {
    order_id: orderId,
    issue_summary:
      `Automated ${req.name} of ${amountText} on ${orderId} was blocked by business ` +
      `rule "${rule.rule_id}" (${rule.blocked_reason}); the amount exceeds the ` +
      `$${LIMITS.refundEscalationThreshold} auto-approval threshold.` +
      (reason ? ` Customer-stated reason: ${reason}.` : ""),
    requested_action:
      `Review and approve or deny a ${amountText} refund to the original payment ` +
      `method for ${orderId}.`,
    urgency: rule.urgency,
    // Hook-populated ONLY. It is absent from the model-facing schema, so its
    // presence on a record is proof the redirect came from a rule trigger.
    blocked_reason: rule.blocked_reason,
  };
}

function receiptFrom(res: ToolResultEnvelope, rule: Rule): EscalationReceipt | null {
  if (res.success !== true) return null;
  const raw = res as unknown as Record<string, unknown>;
  const id = raw.escalation_id;
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    escalation_id: id,
    status: "queued",
    assigned_queue: typeof raw.assigned_queue === "string" ? raw.assigned_queue : rule.queue,
    eta_hours: typeof raw.eta_hours === "number" ? raw.eta_hours : 4,
    blocked_reason:
      typeof raw.blocked_reason === "string" ? raw.blocked_reason : rule.blocked_reason,
  };
}

/* ------------------------------------------------------------------ *
 * dispatch
 * ------------------------------------------------------------------ */

export async function dispatch(
  req: ToolUseRequest,
  ctx: HandlerContext,
  opts: DispatchOptions = {},
): Promise<ToolResultEnvelope> {
  const mode = opts.retryMode ?? RETRY_MODE;
  const started = Date.now();

  ctx.emit({ t: "tool_use", id: req.id, name: req.name, input: req.input });

  /* ---- 1. The gate. Runs before anything can happen, on every call. ---- */
  const verdict = runHook(req.name, req.input);

  if (verdict.action === "block_and_escalate" && verdict.ruleId) {
    const rule = getRuleById(verdict.ruleId);
    if (rule) return blockAndEscalate(req, ctx, rule, started);

    // A verdict naming a rule the table cannot resolve is a programming error.
    // FAIL CLOSED: letting the call through would silently disable enforcement,
    // so refuse it — a blocked legitimate call is recoverable, an unblocked
    // gated one is not.
    ctx.emit({
      t: "hook_verdict",
      toolUseId: req.id,
      ruleId: verdict.ruleId,
      action: "block_and_escalate",
    });
    const failClosed = permissionError(
      `This action was blocked by a business rule and could not be completed ` +
        `automatically. Use escalate_to_human so a person can take it from here.`,
      { rule_id: verdict.ruleId, rule_unresolved: true },
    );
    ctx.emit({
      t: "tool_result",
      toolUseId: req.id,
      ok: false,
      envelope: failClosed,
      ms: Date.now() - started,
    });
    return failClosed;
  }

  ctx.emit({ t: "hook_verdict", toolUseId: req.id, ruleId: null, action: "allow" });

  /* ---- 2. Retry policy, then the real handler. ---- */
  const cap = Math.max(1, LIMITS.maxTransientAttempts);
  const key = guardKey(ctx.sessionId, req.name, req.input);
  const burned = retryGuard.get(key) ?? 0;

  if (burned >= cap) {
    // Identical (tool, input) has already spent the budget in this session.
    // Refuse WITHOUT calling the handler — no side effect, no attempt event,
    // because no attempt was made.
    const envelope = retriesExhausted(null, burned, cap, req, mode);
    ctx.emit({
      t: "tool_result",
      toolUseId: req.id,
      ok: false,
      envelope,
      ms: Date.now() - started,
    });
    return envelope;
  }

  // system mode retries here; agent mode hands the transient envelope straight
  // back to the model and lets IT decide — bounded by the guard above.
  const attempts = mode === "system" ? cap - burned : 1;

  let res: ToolResultEnvelope = handlerThrew(req.name, "dispatch made no attempt");
  let pendingDelay: number | undefined;
  let attemptsMade = 0;

  for (let n = 1; n <= attempts; n++) {
    ctx.emit({
      t: "attempt",
      toolUseId: req.id,
      n,
      of: attempts,
      ...(pendingDelay !== undefined ? { retryAfterMs: pendingDelay } : {}),
    });
    pendingDelay = undefined;
    attemptsMade++;

    try {
      res = await HANDLERS[req.name](req.input, ctx);
    } catch (err) {
      res = handlerThrew(req.name, err);
    }

    if (!isTransient(res)) break;
    if (n < attempts) {
      pendingDelay = res.retryAfterMs ?? 2000;
      await sleep(pendingDelay);
    }
  }

  /* ---- 3. Guard bookkeeping + final envelope. ---- */
  if (isTransient(res)) {
    const total = burned + attemptsMade;
    retryGuard.set(key, total);
    if (total >= cap) {
      // The budget is gone. Convert to a non-retryable failure so the model
      // stops here, in either mode.
      res = retriesExhausted(res, total, cap, req, mode);
    }
  } else {
    // A definitive answer — success, validation or permission — ends the
    // transient story for this call. Let the budget reset.
    retryGuard.delete(key);
  }

  ctx.emit({
    t: "tool_result",
    toolUseId: req.id,
    ok: res.success === true,
    envelope: res,
    ms: Date.now() - started,
  });
  return res;
}

/**
 * The blocked path. The real handler is NEVER invoked — there is no code path
 * from here to HANDLERS[req.name].
 */
async function blockAndEscalate(
  req: ToolUseRequest,
  ctx: HandlerContext,
  rule: Rule,
  started: number,
): Promise<ToolResultEnvelope> {
  // INTERNAL side of the redaction boundary: full, unredacted input.
  const audit = logAuditEvent({
    ruleId: rule.rule_id,
    toolName: req.name,
    input: req.input,
    sessionId: ctx.sessionId,
    outcome: "blocked",
  });

  ctx.emit({
    t: "hook_verdict",
    toolUseId: req.id,
    ruleId: rule.rule_id,
    action: "block_and_escalate",
  });

  // The system-driven redirect, expressed within the API's constraints: WE
  // call escalate_to_human, in code, right now. No synthetic tool_use block is
  // fabricated and the model is never asked whether to escalate.
  let escalationResult: ToolResultEnvelope;
  try {
    escalationResult = await HANDLERS.escalate_to_human(deriveEscalationInput(req, rule), ctx);
  } catch (err) {
    escalationResult = handlerThrew("escalate_to_human", err);
  }

  const receipt = receiptFrom(escalationResult, rule);
  if (receipt) {
    attachEscalationId(audit, receipt.escalation_id);
    ctx.emit({
      t: "escalation_injected",
      toolUseId: req.id,
      escalationId: receipt.escalation_id,
      blockedReason: receipt.blocked_reason ?? rule.blocked_reason,
    });
  }

  // MODEL-FACING side of the boundary: only what the model needs to report
  // accurately. The raw input, the session id and the audit timestamp stay in
  // lib/audit.ts and never appear here.
  const envelope = permissionError(
    receipt
      ? rule.message(req.input)
      : `${rule.message(req.input)} (The escalation ticket could not be filed ` +
        `automatically — tell the customer a manager will follow up and do not ` +
        `retry the refund.)`,
    {
      threshold: LIMITS.refundEscalationThreshold,
      requested_amount: numericField(req.input, "amount") ?? null,
      rule_id: rule.rule_id,
      ...(receipt ? {} : { escalation_failed: true }),
    },
    receipt ?? undefined,
  );

  ctx.emit({
    t: "tool_result",
    toolUseId: req.id,
    ok: false,
    envelope,
    ms: Date.now() - started,
  });
  return envelope;
}
