# Refund Agent — Design Spec

Domain: customer support / refunds. Four tools, one deliberately confusable pair, one business-rule hook. This doc is the reference to implement against — no code yet.

---

## 1. Tool Schemas

### `check_order_status`
Read-only. Always call this first when an order is referenced, to establish ground truth before any write action.

```json
{
  "name": "check_order_status",
  "description": "Retrieves current status and details for an order. Read-only — does not modify anything. Call this before issue_refund or issue_store_credit to confirm refund eligibility, amount paid, and purchase date. Returns an error if the order_id does not exist.",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string", "pattern": "^ORD-[0-9]{4,}$", "description": "Order identifier, e.g. ORD-7788" }
    },
    "required": ["order_id"]
  }
}
```
**Success output:** `{ order_id, status, item_description, amount_paid, currency, purchase_date, refund_eligible: bool, refund_window_days_remaining: int }`
**Boundary conditions:** unknown `order_id` → validation error. Never has side effects, never blocked by the hook.

---

### `issue_refund`
Writes money back to the original payment method. This is the tool the business rule gates.

```json
{
  "name": "issue_refund",
  "description": "Refunds money to the customer's original payment method for a specific order. Use only when the order is within its refund-eligibility window and was paid in real currency (confirm both via check_order_status first). This reverses the original charge. Do NOT use for orders outside the refund window, or as a goodwill gesture on a non-refundable item — use issue_store_credit instead in those cases. amount must not exceed the order's remaining refundable balance.",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string", "pattern": "^ORD-[0-9]{4,}$" },
      "amount": { "type": "number", "exclusiveMinimum": 0 },
      "reason": { "type": "string", "enum": ["damaged", "wrong_item", "not_as_described", "customer_changed_mind", "other"] }
    },
    "required": ["order_id", "amount", "reason"]
  }
}
```
**Success output:** `{ refund_id, order_id, amount_refunded, status: "processed" | "pending_gateway", estimated_days_to_reflect }`
**Boundary conditions:**
- `amount` > remaining refundable balance → validation error
- order outside refund window → validation error, message should point the caller toward `issue_store_credit`
- `amount` > $500 → **blocked by the hook**, permission error, redirected to escalation (see §3)

---

### `issue_store_credit` — the confusable sibling of `issue_refund`
Same-shaped input, different effect and different governance. The description has to do the disambiguation work.

```json
{
  "name": "issue_store_credit",
  "description": "Issues account credit (not cash) redeemable on future purchases. Use when: (a) the order is outside its refund-eligibility window but a goodwill gesture is appropriate, (b) the item is non-refundable per policy, or (c) the customer explicitly agrees to credit instead of cash back. This does NOT reverse the original payment and does NOT require escalation regardless of amount, since no cash leaves the business — do not use it as a way to avoid escalating a large cash refund. If the customer expects money back, use issue_refund instead, even if that means the request gets escalated.",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string", "pattern": "^ORD-[0-9]{4,}$" },
      "amount": { "type": "number", "exclusiveMinimum": 0, "maximum": 2000 },
      "reason": { "type": "string" }
    },
    "required": ["order_id", "amount", "reason"]
  }
}
```
**Success output:** `{ credit_id, account_id, amount_credited, new_account_balance, expires_at }`
**Boundary conditions:** `amount` > $2000 → validation error (hard system ceiling, distinct from the escalation path — no human approval flow exists for credit, so above the ceiling it's simply rejected, not escalated). This asymmetry with `issue_refund` is intentional and worth calling out explicitly when you test tool selection.

---

### `escalate_to_human`
Terminal handoff. Always succeeds (it just files a ticket) — there's no failure mode worth modeling here.

```json
{
  "name": "escalate_to_human",
  "description": "Hands off the current issue to a human agent or manager. Use when: a business rule blocks an automated action, the request can't be resolved with the other tools, or the customer explicitly asks for a person. Terminal for the concern it's called on — don't call another tool for that same concern afterward, though unrelated concerns in the same message can still be handled normally.",
  "input_schema": {
    "type": "object",
    "properties": {
      "order_id": { "type": "string" },
      "issue_summary": { "type": "string" },
      "requested_action": { "type": "string" },
      "urgency": { "type": "string", "enum": ["low", "medium", "high"] },
      "blocked_reason": { "type": "string", "description": "Populated automatically when this call is a hook-triggered redirect, e.g. refund_amount_exceeds_threshold" }
    },
    "required": ["order_id", "issue_summary", "requested_action", "urgency"]
  }
}
```
**Success output:** `{ escalation_id, status: "queued", assigned_queue, eta_hours }`

---

## 2. Structured Error Contract

Every tool handler returns this shape on failure — as a `tool_result`, so the model reasons over it, not as a thrown exception:

```json
{
  "success": false,
  "errorCategory": "transient | validation | permission",
  "isRetryable": true,
  "message": "human-readable, safe to relay to the user or feed back to the model",
  "details": { "...machine-readable specifics, optional" },
  "retryAfterMs": 2000
}
```

**Category semantics and retry policy:**

| Category | Example | isRetryable | Agent behavior |
|---|---|---|---|
| `transient` | payment gateway timeout on `issue_refund` | `true` | Retry with backoff, cap at 2 attempts, then surface failure — never loop indefinitely |
| `validation` | amount exceeds refundable balance; unknown order_id | `false` | Explain to user, ask for corrected input — never retry with identical params |
| `permission` | hook-blocked refund over $500 | `false` | Never retry — route to `escalate_to_human` |

**Worked examples:**
- Transient: `{success:false, errorCategory:"transient", isRetryable:true, message:"Payment gateway timed out processing the refund. Retrying shortly.", retryAfterMs:2000}`
- Validation: `{success:false, errorCategory:"validation", isRetryable:false, message:"Requested refund ($650) exceeds the order's refundable balance ($400).", details:{field:"amount", max_allowed:400}}`
- Permission: `{success:false, errorCategory:"permission", isRetryable:false, message:"Refunds above $500 require manager approval. Routed for escalation.", details:{threshold:500, requested_amount:900}}`

---

## 3. Business Rule Hook

**Core principle:** the tool description ("refunds over $500 need approval") is advisory only — the model can still emit that call. Enforcement has to be a programmatic check that runs regardless of model intent. This is the single point most worth being able to articulate clearly.

**Where it sits:** intercepts every `tool_use` block *before* it reaches the real handler, inside the agentic loop's tool-dispatch step.

**Logic (pseudocode, not implementation):**
```
before dispatching a tool_use block:
  rule = rules_table.lookup(tool_name)
  if rule exists and rule.condition(parsed_input) is true:
      do NOT call the real handler
      log_audit_event(tool_name, input, rule.id, timestamp)   # full detail, internal only
      return permission_error(rule)                            # model-facing, redacted to what's needed
  else:
      return real_handler(parsed_input)
```

**Rule table for this exercise (one entry):**
```json
{
  "rule_id": "refund_threshold",
  "applies_to": "issue_refund",
  "condition": "input.amount > 500",
  "action": "block_and_escalate"
}
```

**Two redirect philosophies — pick one and be ready to justify it:**
- **Agent-driven:** hook returns a `permission` error; the model is left to decide to call `escalate_to_human` next. More flexible, but only as reliable as the model's follow-through — must be empirically tested, not assumed.
- **System-driven:** hook itself constructs and injects the `escalate_to_human` call deterministically, no model discretion involved. Less flexible, but auditable and guaranteed — recommended default for a hard financial threshold like this one.

For this spec: use **system-driven** for `refund_threshold` specifically, since it's gating real money. An agent-driven approach is more defensible for softer, non-financial policy rules where some model judgment is actually useful.

---

## Open design decisions to confirm before building
- Confirm max retry count for `transient` errors (spec assumes 2)
- Confirm whether `issue_store_credit`'s $2000 ceiling should be configurable or hardcoded
- Decide whether `escalate_to_human`'s `blocked_reason` field is *only* ever hook-populated, or also settable by the model directly when it self-escalates without a rule trigger
