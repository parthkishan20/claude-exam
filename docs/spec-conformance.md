# Spec conformance review

Every normative clause of `refund-agent-spec.md` mapped to the code that
implements it and the scenario/test that pins it. Reviewer: senior eng, Wave 2
step G. Verdict per row: **✓ implemented**, **~ implemented with a noted
deviation**, **✗ gap**.

## §1 Tool schemas

| Clause | Where | Pinned by | Verdict |
|---|---|---|---|
| Four tools, model-facing schemas, descriptions verbatim | `lib/tools/schemas.ts` | build | ✓ |
| `check_order_status` read-only, no side effects, never hook-gated | `lib/tools/checkOrderStatus.ts`; `RULES` has no entry for it | `__tests__/handlers.test.ts`, `hook.test.ts` "read-only … never gated" | ✓ |
| `check_order_status` success fields | `checkOrderStatus.ts` | handlers test | ~ adds `remaining_refundable` + `non_refundable` so the agent can tell "wrong tool" from "wrong amount" without a second call. Superset of the spec list. |
| unknown `order_id` → validation error | all three write/read handlers | `unknown-order` scenario, handlers test | ✓ |
| `issue_refund` amount > remaining refundable balance → validation, `details.max_allowed` | `issueRefund.ts` step 2 (uses `remainingRefundable`, not `amount_paid`) | handlers test incl. partial-refund `ORD-3300` | ✓ |
| `issue_refund` outside window → validation, message points to `issue_store_credit` | `issueRefund.ts` step 3, `suggested_tool` in details | `outside-window` scenario | ✓ |
| `issue_refund` amount > $500 → **blocked by the hook**, permission error, escalation | `lib/hooks/rules.ts` `refund_threshold`; `lib/dispatch.ts` `blockAndEscalate` | `over-threshold-refund`, `money-back-big-order` scenarios; `hook.test.ts` | ✓ |
| No $500 logic in the refund handler | `issueRefund.ts` (explicit comment; handlers test asserts a $900 refund succeeds at the handler layer) | `hook.test.ts` "no-prompt $900 enforcement" | ✓ enforcement is provably single-layer |
| `issue_store_credit` same input shape, different governance | `schemas.ts`, `issueStoreCredit.ts` | — | ✓ |
| `issue_store_credit` amount > $2000 → validation error, **not** escalation | `issueStoreCredit.ts` step 2, `details.escalatable: false`; no rule entry for the tool | `credit-ceiling` scenario asserts zero escalations + no permission error; `hook.test.ts` "credit at 2500 NOT hook-blocked" | ✓ the asymmetry is explicit and tested |
| `escalate_to_human` always succeeds, no failure mode | `escalateToHuman.ts` (only malformed input is rejected) | handlers test | ~ malformed input still returns a `validation` envelope rather than filing a garbage ticket. "Never throws" holds; "always succeeds" applies to well-formed calls. |
| `escalate_to_human.blocked_reason` auto-populated on hook redirect | `deriveEscalationInput` in `dispatch.ts`; `escalateToHuman.ts` stamps `source:"hook"` | `over-threshold-refund` asserts `source==="hook" && blocked_reason` | ✓ |

## §2 Structured error contract

| Clause | Where | Pinned by | Verdict |
|---|---|---|---|
| Failures returned as `tool_result`, not thrown | every handler wraps its body; `dispatch.ts` `handlerThrew` contains any escape | `handlers.test.ts` (never-throws cases) | ✓ |
| Envelope shape (`success`,`errorCategory`,`isRetryable`,`message`,`details?`,`retryAfterMs?`) | `lib/types.ts` `ToolFailure`; constructors in `lib/errors.ts` | tsc | ✓ |
| `transient` → retry with backoff, cap 2, then surface, never loop | `dispatch.ts` retry loop + `retryGuard` + `retriesExhausted`; `LIMITS.maxTransientAttempts` | `transient-retry` (2 attempts, succeeds), `transient-exhausted` (surfaces, no loop); `hook.test.ts` | ✓ |
| `validation` → explain, ask for corrected input, never retry identical params | `SYSTEM_PROMPT` "READING TOOL RESULTS"; `retryGuard` also blocks identical re-dispatch | `unknown-order` asserts ≤1 check attempt, no write | ✓ |
| `permission` → never retry, route to `escalate_to_human` | system-driven: `dispatch.ts` does the routing in code; `SYSTEM_PROMPT` tells the model to stop | `over-threshold-refund` | ✓ |
| Worked-example message wording | `issueRefund.ts` transient msg, `dispatch.ts` permission msg, `errors.ts` | — | ✓ close paraphrase |

## §3 Business rule hook

| Clause | Where | Pinned by | Verdict |
|---|---|---|---|
| Description is advisory; the model can still emit the call | `SYSTEM_PROMPT` states the threshold as "handled for you", never "don't call" | `over-threshold-refund` asserts `issue_refund` **is** attempted then blocked | ✓ |
| Enforcement is a programmatic check independent of model intent | `lib/hooks/gate.ts` `runHook` — pure, inputs are only tool name + parsed args | `hook.test.ts` blocks a $900 refund dispatched directly, no prompt involved | ✓ |
| Hook intercepts every `tool_use` before the real handler, in the dispatch step | `dispatch.ts` — `runHook` is the first thing after the `tool_use` event; blocked path has no code route to `HANDLERS[req.name]` | `hook.test.ts` `store.refunds.length === 0` on block | ✓ |
| Pseudocode: lookup rule → if match, don't call handler, log audit (full), return permission error (redacted) | `dispatch.ts` `blockAndEscalate`: `logAuditEvent` (raw input) → emit verdict → escalate → `permissionError` (redacted) | `hook.test.ts` audit-written + redaction-boundary tests | ✓ |
| Rule table: `refund_threshold` / `issue_refund` / `amount > 500` / `block_and_escalate` | `lib/hooks/rules.ts` | `hook.test.ts` $501 blocks, $500 does not | ✓ boundary is strict `>` |
| **System-driven** redirect for `refund_threshold` (hook constructs the escalation, no model discretion) | `dispatch.ts` `blockAndEscalate` calls `HANDLERS.escalate_to_human(deriveEscalationInput(...))` itself; every field derived | `over-threshold-refund` asserts exactly one escalation, hook-sourced | ✓ |
| Audit event: full detail, internal only | `lib/audit.ts` — separate module, cached on globalThis, never serialized into any `tool_result`/prompt/TraceEvent | `hook.test.ts` asserts sessionId + timestamp absent from the envelope | ✓ |
| Model-facing error redacted to what's needed | `permissionError` in `blockAndEscalate` — threshold, requested amount, rule id, receipt only | same test | ✓ |

### Note on `deriveEscalationInput` and the API

The spec's pseudocode says the hook "constructs and injects the
`escalate_to_human` call". A system-driven redirect **cannot** fabricate a
`tool_use` block — two consecutive assistant turns are invalid and it would
misreport provenance. The implementation expresses the same intent correctly:
the dispatcher runs `escalate_to_human` in code and returns **one**
`tool_result` for the blocked `issue_refund` id carrying both the permission
error and the escalation receipt. `escalation_injected` (a distinct TraceEvent,
not a synthetic `tool_use`) tells the UI the system did this. This is a
faithful realisation of the spec within the Messages API's constraints, not a
deviation.

## Open design decisions (spec tail) — resolved

| Decision | Resolution | Where |
|---|---|---|
| Max retry count for `transient` (spec assumes 2) | Confirmed 2; `LIMITS.maxTransientAttempts`, env-overridable | `lib/config.ts` |
| `issue_store_credit` $2000 ceiling configurable or hardcoded | Configurable via `LIMITS.storeCreditCeiling` (env `STORE_CREDIT_CEILING`), default 2000; schema keeps `maximum: 2000` as the model-facing hint | `lib/config.ts`, `schemas.ts` |
| `blocked_reason` hook-only or model-settable | **Hook-only** — stripped from the model-facing schema, accepted on the handler's input, stamped with `source` | `schemas.ts`, `escalateToHuman.ts` |

## Deviations from the approved plan

1. **Next.js 16.3.4**, not 15 — `create-next-app@latest`. App Router API used is identical; no code affected.
2. **Model responses in offline evals are scripted.** No Anthropic credentials in the build environment, so `npm run eval` runs the scripted-model path (real hook/dispatcher/handlers/retry/audit, canned tool-call sequences). `RECORD=1 LIVE=1 npm run eval` regenerates fixtures from the real model — run it once credentials exist. The live path (`lib/loop.ts`, `/api/chat`, `/api/scenarios` live branch) is complete and was smoke-tested against `next start` (correct SSE framing, graceful missing-credential handling, a bogus key reaches the API and returns a mapped 401).
3. **No `order/account inspector` UI** — per the plan's UI-scope decision (chat + trace + scenario runner only).

## Residual observations (non-blocking)

- `gate.ts::runHook` treats a *throwing* rule condition as "did not match" (fail-open). All current conditions are total (`numericField` never throws), so this is theoretical; a money gate arguably should fail closed. One-line change if desired.
- `escalateToHuman` derives `assigned_queue`/`eta_hours` heuristically; not specified anywhere. `refund-approvals` / ETA ≤ 4h for threshold blocks.
- The UI's `ScenarioRunner` hardcodes 7 of the 9 scenarios and does its own client-side assertions; the `/api/scenarios` route now serves all 9 with canonical assertions. Harmless drift — worth aligning the component to the `GET /api/scenarios` list in a follow-up.
