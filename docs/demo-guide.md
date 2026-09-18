# Demo Mode — presenter's guide

`/demo` is a guided walkthrough of this agent for an audience. Five acts, about
**5 minutes 40 seconds** of playback, driven from the keyboard.

Each act replays one scenario from `evals/scenarios.ts` one trace event at a
time, with narration pinned to positions in the trace, a pipeline diagram that
shows where the call actually got to, and the same machine-checked assertions
`npm run eval` uses.

---

## The one claim you are making

Everything on the screen is the shipping enforcement path. Replay scripts the
**model's turn only** — which tools it calls, with what arguments. The hook, the
retry policy, the handlers, the audit log and the store are the real modules,
running for real, for every event the audience watches.

So a blocked refund in the demo is blocked by the same pure function that blocks
it in production (`lib/hooks/gate.ts`), and the empty ledger in act 2 is empty
because the handler genuinely was never reached.

Say this out loud at the start. It is the difference between a demo and an
advert, and someone in the room is already wondering.

---

## Running it

```bash
npm run dev                    # http://localhost:3000/demo
```

For an actual presentation, prefer a production build — it is faster and has no
dev overlays:

```bash
npm run build && npm start     # http://localhost:3000/demo
```

Replay needs **no API key** and makes no network calls. Nothing about the demo
can fail because of the venue's wifi.

Deep-link straight to an act: `/demo?act=over-threshold-refund`.

---

## Running order

| # | Act | Scenario | Time |
|---|---|---|---|
| 1 | The shape of a good turn | `happy-refund` | 0:50 |
| 2 | **The model tries. The code says no.** | `over-threshold-refund` | 1:30 |
| 3 | Blocking and rejecting differ | `credit-ceiling` | 1:15 |
| 4 | Failure has a budget | `transient-retry` | 1:00 |
| 5 | Escalation is scoped, not contagious | `two-concerns-one-message` | 1:05 |

The order is an argument, not a list:

- **Act 1** establishes a normal turn so act 2 has something to violate. It is
  deliberately unexciting. Do not apologise for it or rush it.
- **Act 2** is the headline. The model *attempts* a $900 refund — the tool
  description saying refunds over $500 need approval does not stop it, because a
  description is advisory. The gate stops it, before the handler exists to be
  called, and files the escalation in code.
- **Act 3** exists to stop the room concluding that "the system refused it"
  always means one mechanism. $2500 of store credit is **rejected** by the
  handler as a validation error, with **zero** escalations, because there is no
  human approval path for credit. Cash blocks and escalates; credit rejects.
- **Acts 4 and 5** close the two objections that act 2 provokes: *does a
  failure loop forever?* (no — attempts are capped at two) and *does one blocked
  call poison the turn?* (no — the $120 refund in the same message still goes
  through).

If you have only two minutes, run act 2 and act 3. That pair is the whole thesis.

---

## Driving it

| Key | Action |
|---|---|
| `Space` | play / pause |
| `→` / `←` | step one event forward / back |
| `↓` `J` / `↑` `K` | next / previous act |
| `1`–`5` | jump to act |
| `R` | restart the act |
| `?` | shortcuts overlay |

Step with `→` rather than letting it play when you want to talk over a specific
event — the playhead waits for you. Speed is on the transport (0.5× for a
rehearsal, 4× to skim an act during Q&A).

---

## Answering the hard questions

**"Isn't the model just told to escalate?"**
Open `lib/systemPrompt.ts` and `lib/tools/issueRefund.ts` on the spot. Both
mention the $500 rule; both are advisory. Then open `lib/hooks/gate.ts` — a pure
function whose only inputs are the tool name and the parsed arguments. Rewrite
the system prompt to say refunds are unlimited, re-run act 2, and the trace does
not change.

**"Is the trace real?"**
`npm run eval` in a terminal beside the demo runs the same scenarios through the
same assertions and prints the same tool sequences. The checklist in the right
rail is those assertions.

**"Why is the escalation trustworthy?"**
`escalation.blocked_reason` is absent from the model-facing `escalate_to_human`
schema, so a value in that field can only have come from the hook. In the ledger
the act 2 escalation reads `source: hook`; a model-initiated one reads
`source: model`. The provenance is not a convention, it is unforgeable through
the tool surface.

**"What happens when the gateway is down?"**
That is act 4, and its sibling `transient-exhausted` runs the same code to the
cap and surfaces the failure rather than looping.

---

## If something goes wrong

**The Live toggle fails.** Live mode needs a valid `ANTHROPIC_API_KEY`. If the
key is missing, rejected or rate-limited, the act falls back to replay and shows
a one-line notice — the talk continues. Nothing is lost; replay is the honest
default anyway.

**An assertion goes red.** Do not skip past it. A red check means the trace
genuinely violated a spec clause, and it is more interesting than anything you
had planned to say. `npm run eval` will reproduce it in the terminal.

**The stage is empty.** The error panel carries the reason verbatim and a
"Run it again" button. If the dev server died, restart it — the act refetches.

---

## Where this lives

```
lib/demo/
  types.ts        the contract: acts, beats, anchors, playback, component props
  acts.ts         the five acts and their narration
  anchors.ts      resolves a beat to a position in a real trace
  usePlayback.ts  the playhead — play/pause/step/seek/speed
  pacing.ts       how long the playhead rests on each kind of event
  useDemoRun.ts   fetches and caches act runs
app/demo/         the stage
app/api/demo/     replay + live, returning a DemoRun
components/demo/  flow diagram, trace stage, narration, checklist, ledger
```

Narration is pinned to the trace by **anchor**, never by event index — "the
hook block", "the second `issue_refund` result" — so the same act narrates
correctly whether it is replaying or running live, where the model's exact
sequence differs run to run.
