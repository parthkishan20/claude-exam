/**
 * ★ CONTRACT — frozen in Wave 0. Do not edit during Wave 1.
 *
 * Constructors for the spec §2 error envelope. Use these instead of building
 * object literals so `isRetryable` can never drift out of step with
 * `errorCategory` — that pairing is the whole retry policy.
 */
import type { EscalationReceipt, ToolFailure, ToolSuccess } from "./types";

/** Retryable. Infrastructure hiccup — the same call may well succeed next time. */
export function transientError(
  message: string,
  retryAfterMs = 2000,
  details?: Record<string, unknown>,
): ToolFailure {
  return {
    success: false,
    errorCategory: "transient",
    isRetryable: true,
    message,
    ...(details ? { details } : {}),
    retryAfterMs,
  };
}

/**
 * Not retryable. The input was wrong, so identical params will fail identically.
 * The agent must explain and ask for corrected input — never retry as-is.
 */
export function validationError(
  message: string,
  details?: Record<string, unknown>,
): ToolFailure {
  return {
    success: false,
    errorCategory: "validation",
    isRetryable: false,
    message,
    ...(details ? { details } : {}),
  };
}

/**
 * Not retryable. A business rule blocked the call before the handler ran.
 * Under the system-driven philosophy the escalation has ALREADY been performed
 * in code, and `escalation` is its receipt — the model is informed, not asked.
 */
export function permissionError(
  message: string,
  details?: Record<string, unknown>,
  escalation?: EscalationReceipt,
): ToolFailure {
  return {
    success: false,
    errorCategory: "permission",
    isRetryable: false,
    message,
    ...(details ? { details } : {}),
    ...(escalation ? { escalation } : {}),
  };
}

export function ok<T extends Record<string, unknown>>(payload: T): ToolSuccess<T> {
  return { success: true, ...payload };
}
