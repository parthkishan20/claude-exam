/**
 * Internal audit log. FULL detail, never model-facing.
 *
 * Spec §3: the hook logs full detail internally but returns a redacted,
 * model-facing error. Keeping those two payloads in separate modules is what
 * stops internal detail leaking into the conversation.
 *
 * WAVE 1 — AGENT B owns this file.
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

export function logAuditEvent(_ev: Omit<AuditEvent, "at">): void {
  throw new Error("not implemented — Wave 1 Agent B");
}

export function readAuditLog(_sessionId?: string): AuditEvent[] {
  throw new Error("not implemented — Wave 1 Agent B");
}
