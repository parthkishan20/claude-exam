# Refund Agent Web App — Agent Orchestration Plan

## Context

`refund-agent-spec.md` is a design document with no code behind it. It specifies a customer-support refund agent: four tools (one deliberately confusable pair), a structured error contract with three retry semantics, and a programmatic business-rule hook that gates refunds over $500. The spec's own thesis is that **a tool description is advisory — enforcement must be a programmatic check that runs regardless of model intent.**

We are building a **Next.js 15 (TypeScript) web app** that implements the spec and, critically, *makes the enforcement visible*. A chat window alone would leave the hook, the error contract, and the confusable-pair disambiguation invisible — exactly the things the spec says are most worth being able to articulate. So the UI is chat **plus** a live agent-trace panel **plus** a scenario runner that asserts on structured traces.

The build is decomposed into **three waves of subagents**: one solo contract-freeze wave, one four-way parallel wave, one sequential integration wave. Parallelism is safe only because Wave 0 freezes every shared type first and Wave 1 agents own disjoint file sets.

**Working directory:** `/Users/parthkumarpatel/Downloads/claude-exam` (currently contains only `refund-agent-spec.md`). Not a git repo — Wave 0 runs `git init`.

---

## Decisions already made (do not re-litigate)

| Decision | Choice | Rationale |
|---|---|---|
| Stack | Next.js 15 App Router, TypeScript, one repo | One language, no cross-process contract; Route Handler streams SSE |
| Agent loop | Manual streaming loop (`client.messages.stream()` + `finalMessage()`) | The hook must intercept every `tool_use` *before* dispatch — a hand-written loop makes that choke point explicit and auditable |
| Model | `claude-opus-5`, `thinking: {type:"adaptive", display:"summarized"}`, `max_tokens: 64000` | Summarized thinking feeds the trace panel; streaming required at that `max_tokens` |
| Redirect philosophy | **System-driven** for `refund_threshold` | Spec §3 — hard financial threshold, no model discretion |
| Transient retries | **System-driven, 2 attempts**, with an `agent` mode behind a flag | Same reasoning as the hook; the flag lets the UI demo both and measure the difference empirically |
| Limits | Both in `lib/config.ts`, env-overridable | The $500-block vs $2000-reject asymmetry is the point — keep the two numbers adjacent and commented |
| `blocked_reason` | **Hook-populated only; stripped from the model-facing schema** | If present, it provably came from a rule trigger. Unambiguous audit provenance |
| Evals | Live API, assertions on **structured trace**, plus a recorded-fixture replay mode | Never assert on prose; fixtures keep CI free and offline-capable |
| UI scope | Chat + trace panel + scenario runner (no order inspector) | — |

---

## The one thing most likely to be implemented wrong

**A system-driven redirect cannot fabricate a `tool_use` block.** The Messages API assistant turn is whatever the model produced; you cannot append a second, synthetic assistant message carrying an invented `escalate_to_human` call (two consecutive assistant turns are invalid, and it would put words in the model's mouth and corrupt audit provenance).

The correct shape: when the hook blocks, the dispatcher **executes `escalate_to_human` itself in code**, then returns *one* `tool_result` for the blocked `issue_refund` `tool_use_id` carrying both the permission error and the escalation receipt:

```jsonc
// tool_result content for the blocked issue_refund call, is_error: true
{
  "success": false,
  "errorCategory": "permission",
  "isRetryable": false,
  "message": "Refunds above $500 require manager approval. This has been automatically routed to a human manager — no further action is needed for this order.",
  "details": { "threshold": 500, "requested_amount": 900, "rule_id": "refund_threshold" },
  "escalation": {                              // ← already done, deterministically, by the hook
    "escalation_id": "ESC-4417", "status": "queued",
    "assigned_queue": "refund-approvals", "eta_hours": 4,
    "blocked_reason": "refund_amount_exceeds_threshold"
  }
}
```

The model never chooses to escalate — it is told the escalation already happened and reports that to the user. That *is* the system-driven philosophy, correctly expressed within the API's constraints. Every Wave 1 and Wave 2 agent must be handed this paragraph.

---

## Target file layout

```
app/
  layout.tsx  page.tsx
  api/chat/route.ts            ← SSE: model deltas + trace events
  api/scenarios/route.ts       ← runs an eval scenario, returns its trace
components/
  Chat.tsx  TracePanel.tsx  TraceEventRow.tsx  ScenarioRunner.tsx
lib/
  types.ts          ← ★ CONTRACT: ToolResultEnvelope, TraceEvent, ToolName
  config.ts         ← ★ CONTRACT: LIMITS
  errors.ts         ← ★ CONTRACT: envelope constructors
  systemPrompt.ts
  tools/
    schemas.ts      ← ★ CONTRACT: 4 model-facing Anthropic.Tool definitions
    checkOrderStatus.ts  issueRefund.ts  issueStoreCredit.ts  escalateToHuman.ts
    index.ts        ← handler registry: Record<ToolName, Handler>
  hooks/
    rules.ts        ← the rule table
    gate.ts         ← runHook() — the interception point
  dispatch.ts       ← hook → retry → handler; emits every TraceEvent
  loop.ts           ← manual streaming agentic loop
  audit.ts          ← internal audit log (full detail, never model-facing)
  store/
    db.ts  orders.ts  accounts.ts   ← seeded in-memory fixtures
evals/
  scenarios.ts  run.ts  fixtures/
__tests__/
```

`★ CONTRACT` files are written in Wave 0 and **frozen** — Wave 1 agents import from them and may not edit them. A contract change requires stopping the wave.

---

## The shared contract (Wave 0 output, verbatim targets)

```ts
// lib/config.ts — the asymmetry lives here, side by side, on purpose
export const LIMITS = {
  refundEscalationThreshold: Number(process.env.REFUND_ESCALATION_THRESHOLD ?? 500),
  //   > threshold  → hook BLOCKS and escalates (a human approval path exists)
  storeCreditCeiling: Number(process.env.STORE_CREDIT_CEILING ?? 2000),
  //   > ceiling    → handler REJECTS outright (no approval path exists for credit)
  maxTransientAttempts: 2,
  maxLoopIterations: 12,
} as const;
export const RETRY_MODE: "system" | "agent" =
  (process.env.RETRY_MODE as "system" | "agent") ?? "system";
```

```ts
// lib/types.ts
export type ToolName =
  | "check_order_status" | "issue_refund" | "issue_store_credit" | "escalate_to_human";

export type ToolResultEnvelope =
  | { success: true; [k: string]: unknown }
  | { success: false; errorCategory: "transient" | "validation" | "permission";
      isRetryable: boolean; message: string;
      details?: Record<string, unknown>; retryAfterMs?: number;
      escalation?: EscalationReceipt };          // present only on hook redirects

export type TraceEvent =
  | { t: "turn_start"; turn: number }
  | { t: "thinking_delta"; text: string }
  | { t: "text_delta"; text: string }
  | { t: "tool_use"; id: string; name: ToolName; input: unknown }
  | { t: "hook_verdict"; toolUseId: string; ruleId: string | null;
      action: "allow" | "block_and_escalate" }
  | { t: "attempt"; toolUseId: string; n: number; of: number; retryAfterMs?: number }
  | { t: "tool_result"; toolUseId: string; ok: boolean;
      envelope: ToolResultEnvelope; ms: number }
  | { t: "escalation_injected"; toolUseId: string; escalationId: string;
      blockedReason: string }
  | { t: "turn_end"; stopReason: string | null; usage: { input: number; output: number } }
  | { t: "done" } | { t: "error"; message: string };
```

**SSE framing:** one `TraceEvent` per frame, `data: ${JSON.stringify(ev)}\n\n`. This union is the only interface between backend and UI — the UI agent builds against a mock emitter that replays a hand-written array of these, so it never blocks on the backend.

**Dispatcher pseudocode** (`lib/dispatch.ts`) — the single choke point all four tools pass through:

```
dispatch(toolUse, emit):
  emit({t:"tool_use", ...})
  rule = rules.lookup(toolUse.name)
  if rule && rule.condition(toolUse.input):
      audit.log(full detail, internal only)        # never model-facing
      emit({t:"hook_verdict", action:"block_and_escalate", ruleId: rule.id})
      receipt = handlers.escalate_to_human({ ...derived, blocked_reason: rule.blockedReason })
      emit({t:"escalation_injected", ...})
      return permissionEnvelope(rule, receipt)     # ONE tool_result, is_error:true
  emit({t:"hook_verdict", action:"allow", ruleId:null})
  for n in 1..(RETRY_MODE=="system" ? LIMITS.maxTransientAttempts : 1):
      emit({t:"attempt", n, of})
      res = await handlers[toolUse.name](toolUse.input)
      if res.success or res.errorCategory != "transient": break
      await backoff(res.retryAfterMs)
  emit({t:"tool_result", ...}); return res
```

**Loop rules the loop agent must honour:** append the full `message.content` to preserve `tool_use` blocks; return **all** `tool_result` blocks in a **single** user message (splitting them trains the model out of parallel calls); set `is_error: true` on every failure envelope; handle `stop_reason: "pause_turn"`; break at `LIMITS.maxLoopIterations`.

---

## Seed fixtures (Wave 0) — each exists to drive one scenario

| Order | Amount | State | Drives |
|---|---|---|---|
| `ORD-1234` | $120 | eligible, 20d left | happy-path refund |
| `ORD-7788` | $900 | eligible, 12d left | **hook block + escalation** |
| `ORD-4521` | $180 | outside window, 0d | validation error → store credit |
| `ORD-9001` | $2500 | non-refundable | **store-credit ceiling reject** (no escalation) |
| `ORD-5150` | $300 | eligible; gateway fails attempt 1 | transient retry succeeds on attempt 2 |
| `ORD-5151` | $300 | eligible; gateway always fails | transient exhausts 2 attempts, surfaces failure |
| `ORD-0000` | — | does not exist | unknown-order validation error |

---

## Wave 0 — Contract freeze (1 agent, solo, blocking)

**Brief:** `git init`; scaffold Next.js 15 + TS + Tailwind; `npm i @anthropic-ai/sdk zod`; write every `★ CONTRACT` file above plus `lib/store/*` fixtures; write **stub** `dispatch.ts`, `loop.ts`, `tools/*.ts` (correct signatures, `throw new Error("not implemented")` bodies) so the whole tree typechecks.

**Owns:** everything. **Gate:** `npx tsc --noEmit` clean, `npm run build` succeeds, all seven fixtures present. Do not proceed to Wave 1 until this passes — every parallel agent depends on it.

## Wave 1 — Four agents in parallel (disjoint file ownership)

Every brief includes: the frozen contract files, the "one thing most likely to be implemented wrong" section above, and an explicit *do not edit any file outside your owned set* instruction. That disjointness is the whole safety property of this wave.

| Agent | Owns | Must deliver |
|---|---|---|
| **A — Tool handlers** | `lib/tools/{checkOrderStatus,issueRefund,issueStoreCredit,escalateToHuman,index}.ts` | Four pure handlers over `lib/store`. Every boundary condition from spec §1 as a typed envelope: unknown order → validation; amount > refundable balance → validation; outside window → validation *whose message points at `issue_store_credit`*; credit > ceiling → validation **reject, never escalate**; `ORD-515x` → transient with `retryAfterMs`. `escalate_to_human` always succeeds. |
| **B — Hook + dispatcher** | `lib/hooks/{rules,gate}.ts`, `lib/dispatch.ts`, `lib/audit.ts` | The rule table, `runHook()`, the dispatcher pseudocode above, system/agent retry modes, and the audit log (full internal detail; model sees only the redacted envelope). **This is the spec's centerpiece — assign the strongest agent here.** |
| **C — Loop + API** | `lib/loop.ts`, `lib/systemPrompt.ts`, `app/api/chat/route.ts`, `app/api/scenarios/route.ts` | Manual streaming loop per the rules above; SSE `ReadableStream` Route Handler with `export const runtime = "nodejs"`; system prompt that states the check-first rule and the refund-vs-credit distinction **without** restating the $500 threshold as if it were enforcement. |
| **D — UI** | `app/{layout,page}.tsx`, `components/*` | Two-column chat + trace panel; blocked calls rendered distinctly from failed ones; scenario runner with per-scenario pass/fail. Builds against a **mock `TraceEvent[]` emitter** — must not wait on Agent C. |

## Wave 2 — Integration (sequential)

| Step | Work | Gate |
|---|---|---|
| **E — Wire up** | Swap D's mock emitter for the live SSE route; run each scenario by hand; fix seams. | All 9 scenarios run end-to-end against the live API |
| **F — Evals** | `evals/scenarios.ts` + `run.ts`; assert on trace shape only; record fixtures for replay mode. | `npm run eval` green live **and** in replay |
| **G — Review** | Clause-by-clause table: every spec requirement → the file and line implementing it. Flag anything unimplemented rather than quietly dropping it. | No unexplained gaps |

**Dispatch mechanics:** use `superpowers:dispatching-parallel-agents` for Wave 1 (four `Agent` calls in a single message). No git worktrees — file ownership is already disjoint, and worktrees would fragment the shared `node_modules` and the frozen contract.

---

## Scenario suite (the acceptance criteria)

| # | Input | Required trace |
|---|---|---|
| 1 | Refund $120 on `ORD-1234` | `check_order_status` → `issue_refund` → success |
| 2 | Refund $900 on `ORD-7788` | `check` → `issue_refund` → `hook_verdict: block_and_escalate` → `escalation_injected` → **no `issue_store_credit` call** |
| 3 | Refund on `ORD-4521` (outside window) | `check` → validation error → `issue_store_credit` |
| 4 | $2500 credit on `ORD-9001` | validation reject, **zero escalations** — the asymmetry |
| 5 | "I want my money back" on `ORD-7788` | picks `issue_refund` and accepts escalation; does **not** dodge to store credit |
| 6a / 6b | `ORD-5150` / `ORD-5151` | 2 `attempt` events; 6a succeeds on attempt 2, 6b surfaces failure without looping |
| 7 | `ORD-0000` | validation error → asks user for correction, **no retry with identical params** |
| 8 | Any escalated concern | no further tool call on that concern after `escalate_to_human` |
| 9 | Two orders, one message | one escalated, the other handled normally in the same turn |

Scenario 5 is the confusable-pair test and scenario 4 is the asymmetry test — the two the spec singles out. Both must be in the suite.

---

## Verification

```bash
npx tsc --noEmit && npm run build     # after every wave
npm test                              # handler + hook unit tests (no API calls)
npm run dev                           # → http://localhost:3000
npm run eval                          # live
REPLAY=1 npm run eval                 # recorded fixtures, offline
```

**Credentials:** run `ant auth status` first — if a profile is active, the zero-arg `new Anthropic()` picks it up and no `ANTHROPIC_API_KEY` is needed. Only export a key if no credential source is active.

**Manual end-to-end check (the money shot):** open the app, send *"I need a refund for order ORD-7788, it arrived damaged — that's $900"*, and confirm the trace panel shows `issue_refund` attempted → **blocked** by `refund_threshold` → escalation injected by the system, with the chat reply telling the customer it went to a manager. Then flip `RETRY_MODE=agent` and re-run scenario 6a to see the retry move from the dispatcher into the model's own decisions.

**Hook-is-real check:** temporarily edit the system prompt to say refunds are unlimited, re-run scenario 2, and confirm the $900 refund is *still* blocked. That demonstrates the spec's core claim — enforcement is programmatic, not prompt-dependent.
