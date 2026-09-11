/**
 * Internal audit log. FULL detail, never model-facing.
 *
 * Spec §3: the hook logs full detail internally but returns a redacted,
 * model-facing error. Keeping those two payloads in separate modules is what
 * stops internal detail leaking into the conversation.
 *
 * WAVE 1 — AGENT B owns this file.
 *
 * ── THE REDACTION BOUNDARY ─────────────────────────────────────────────────
 * This module is one side of it. The rule is mechanical:
 *
 *   AuditEvent (this file)        → internal only. Raw unredacted tool input
 *                                   exactly as the model emitted it, session
 *                                   id, rule id, wall-clock time. Written by
 *                                   lib/dispatch.ts. Read by operators, tests
 *                                   and (later) a compliance export.
 *
 *   ToolFailure (lib/errors.ts)   → model-facing. Only what the model needs to
 *                                   act correctly: what happened, that it is
 *                                   not retryable, and the escalation receipt.
 *
 * Nothing in this module is ever serialized into a tool_result, a system
 * prompt, or a TraceEvent envelope. The two payloads are constructed from the
 * same facts in two different places on purpose: if they shared a builder,
 * every future field added for auditors would silently become model-visible.
 * The `escalation_injected` TraceEvent carries ids only — enough for the UI to
 * correlate, never the raw input.
 *
 * Storage is in-memory and cached on globalThis, mirroring lib/store/db.ts, so
 * Next's dev hot-reload cannot silently discard the log mid-conversation.
 * ───────────────────────────────────────────────────────────────────────────
 */
export interface AuditEvent {
  at: string;
  ruleId: string;
  toolName: string;
  /** Raw, unredacted tool input as the model emitted it. */
  input: unknown;
  sessionId: string;
  outcome: "blocked" | "allowed";
  escalationId?: string;
}

const g = globalThis as unknown as { __refundAuditLog?: AuditEvent[] };
const auditLog: AuditEvent[] = (g.__refundAuditLog ??= []);

/**
 * Append one event. Called by the dispatcher BEFORE the escalation runs, so a
 * crash mid-redirect still leaves a record that the rule fired; the escalation
 * id is patched on afterwards via `attachEscalationId`.
 */
export function logAuditEvent(ev: Omit<AuditEvent, "at">): AuditEvent {
  const full: AuditEvent = { at: new Date().toISOString(), ...ev };
  auditLog.push(full);
  return full;
}

/** Records the escalation this block produced, once it has one. */
export function attachEscalationId(ev: AuditEvent, escalationId: string): void {
  ev.escalationId = escalationId;
}

/** Oldest first. Pass a sessionId to scope to one conversation. */
export function readAuditLog(sessionId?: string): AuditEvent[] {
  return sessionId === undefined
    ? [...auditLog]
    : auditLog.filter((e) => e.sessionId === sessionId);
}

/** Test/dev helper. Clears one session's events, or the whole log. */
export function clearAuditLog(sessionId?: string): void {
  if (sessionId === undefined) {
    auditLog.length = 0;
    return;
  }
  for (let i = auditLog.length - 1; i >= 0; i--) {
    if (auditLog[i].sessionId === sessionId) auditLog.splice(i, 1);
  }
}
