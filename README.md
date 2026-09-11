# Refund Agent

A customer-support refund agent, implemented against `docs/refund-agent-spec.md`,
with a web UI that makes the agent's decisions — and the business-rule
enforcement — visible.

Four tools (`check_order_status`, `issue_refund`, `issue_store_credit`,
`escalate_to_human`), a structured error contract with three retry semantics,
and a programmatic hook that blocks refunds over $500 and routes them to a human
**regardless of what the model intends**.

## Run it

```bash
npm install
npm run dev            # http://localhost:3000
```

Set credentials for the live agent (either one):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or:  ant auth login
```

Without credentials the chat shows a clear message; the **scenario runner**
still works offline (scripted model, real backend).

## Verify

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # 43 unit tests — handlers + hook, no API
npm run eval                      # 9 scenarios; live if creds exist, else scripted
REPLAY=1  npm run eval            # force offline (scripted model, real backend)
FIXTURES=1 npm run eval           # replay recorded traces, no backend
RECORD=1 LIVE=1 npm run eval      # re-record fixtures from the real model
```

## Layout

```
lib/
  config.ts          the $500-block / $2000-reject asymmetry, documented
  types.ts           ToolResultEnvelope, TraceEvent (the SSE contract)
  errors.ts          envelope constructors
  tools/             the four handlers + model-facing schemas
  hooks/             rules.ts (the rule table) + gate.ts (the pure check)
  dispatch.ts        the single choke point: hook → retry → handler
  loop.ts            manual streaming agentic loop
  audit.ts           internal audit log (never model-facing)
  store/             seeded in-memory fixtures, one order per scenario
app/
  page.tsx           chat + trace panel + scenario runner
  api/chat           SSE: one TraceEvent per frame
  api/scenarios      server-side scenario runs with canonical assertions
evals/               scenarios.ts + assertions + scripted model + harness
docs/
  refund-agent-spec.md    the spec
  orchestration-plan.md   how this was built (3 waves of agents)
  spec-conformance.md     clause-by-clause review
```

## The one thing worth understanding

`issue_refund`'s description says refunds over $500 need approval. That sentence
is **advisory** — the model can and sometimes will call the tool anyway.
Enforcement is `lib/hooks/gate.ts`, a pure function whose only inputs are the
tool name and the parsed arguments. When it blocks, `lib/dispatch.ts` files the
escalation **in code** and hands the model one `tool_result` saying it already
happened. The model never decides to escalate.

To see it: send *"I need a $900 refund on ORD-7788, it arrived damaged"* and
watch the trace panel — `issue_refund` attempted → blocked by `refund_threshold`
→ escalation injected by the system. Then edit `SYSTEM_PROMPT` to say refunds
are unlimited and re-run: still blocked.
