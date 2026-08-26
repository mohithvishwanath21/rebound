# Architecture

The [README](../README.md) has the diagram and the summary. This is the longer version: what each
module is responsible for, and — more usefully — the four or five structural decisions that would be
expensive to reverse, with the reason each one was made that way.

## One decision, end to end

A case arrives as a gateway event: a declined payment, a failed subscription charge, or an invoice
that has gone unpaid. Everything that follows happens once per case per cycle, and a cycle is twelve
simulated hours.

**`src/agent/diagnose.js` decides what went wrong, and is allowed to say it doesn't know.** It runs
rule tables over the event and returns both a root cause from `src/core/taxonomy.js` and a `matchTier`
— an ordinal fact about *how* the match was made. The precedence is written into the file because it
is a real decision: `humanOnly > REASON > STATE > SOURCE_STEP > TEXT > abstain`. A provider's
machine-readable enum beats our own system state, because the enum describes the transaction that just
failed while our state describes the world in general. But our own system state beats the provider's
free text, because `mandateStatus` is a field we control and an error description is a sentence a
payments company can reword in any release without telling anyone. That ordering was not a hunch: five
revoked mandates in a 600-event batch produced error text no rule matched, abstained to `UNKNOWN`, and
`UNKNOWN` permits one cautious retry — which is not a wasted API call but a charge against an
authorisation the customer had explicitly withdrawn. The observable status said `revoked` the whole
time and nothing was reading it.

The tier matters downstream because the free-text tier was measured at **0% accuracy on both splits**.
A system that reports a cause without reporting how it got there is hiding its worst tier inside its
average.

**`src/agent/observe.js` builds the feature vector, and can only see what a merchant could see.** No
field originating in the simulator's latent state is reachable from here. This is enforced, not
intended — see the quarantine below.

**`src/agent/recoveryModel.js`, over `src/ml/`, turns that into a probability.** Logistic and GBM
implementations live in `src/ml/`, calibration in `src/ml/calibration.js`. The probability is of
*recovery given this case and this action*, not a generic risk score, because the action is the thing
being chosen.

**`src/agent/expectedValue.js` prices every candidate.** The ladder is the cross product of eight
action kinds (`src/core/actions.js`) with channels and future time slots, which for a typical case
comes to 23 priced candidates:

```
EV(action) = P(recover | case, action) × amount × margin − cost(action) − patience_penalty
```

EV is linear in `p`, which is worth stating because it is load-bearing in one place: on a single live
case, two evaluations at `p = 0` and `p = 1` give an *exact* break-even. That is why the live command
quotes "beats the retry at any p > 1.35%" rather than a point estimate. Quoting a probability on one
real case would mean extrapolating from generated training data and presenting it as a measurement.
A break-even says what would have to be true for the decision to be wrong, which is a claim a viewer
can check.

**`src/agent/guardrails.js` returns one of three verdicts, not a boolean.** `ALLOW`, `DEFER` or
`FORBID`, and `DEFER` carries the instant to reconsider. The distinction is the whole point:
"you may never charge this revoked mandate" and "it is 02:40 in Kolkata, do not message yet" are not
the same sentence. A budget is a countable resource, so exhausting it is `FORBID`; a quiet-hours
window is a timing constraint, so it is `DEFER` with an instant attached. Collapsing `DEFER` into
`FORBID` would throw away recoverable money and, worse, would record a permanent refusal where the
truth was a wait.

Approval is deliberately *not* folded into `FORBID`. An action can be `ALLOW` and still require a
human, which routes it to a queue instead of to the gateway. Folding the two together would silently
convert "a human should look at this ₹80,000 action" into "this action is forbidden".

**`src/agent/stopping.js` decides whether the best action is worth doing at all.** The bar is
`max(POLICY.minEvToActPaise, k · σ(EV))` with `k = 1`, floored at 200 paise — a support-scaled bar, so
a case with a wide spread of option values has to clear more before the agent spends. Stop reasons are
separate codes on purpose. An early version returned `NEGATIVE_EV` for everything, which meant a case
blocked by a contact cap and a case that was genuinely hopeless produced the same audit line; the
`TOO_OLD` and `BUDGET_EXHAUSTED` branches were unreachable and the audit trail was quietly lying about
why the agent had stopped.

**`src/agent/decide.js` returns one of `ACT`, `WAIT`, `AWAIT_APPROVAL`, `ESCALATE_HUMAN` or
`STOP_PERMANENT`,** and `annotateRejections` writes, onto every losing candidate, the sentence
explaining why it lost. Those sentences are the audit trail. They are written at decision time, by the
thing that made the decision.

**`src/agent/orchestrator.js` runs the cycles**, wakes scheduled actions, re-decides on wakeup rather
than replaying a stale intent, holds approvals, and writes everything to the store.

## The quarantine, which is the load-bearing wall

`test/boundary.test.js` holds this line:

```js
const RESTRICTED = ['agent', 'api', 'razorpay', 'ml'];
```

Nothing under those four directories may import anything from `src/sim/**`. The simulator knows why
each payment failed and whether it would have recovered on its own; `src/sim/latentTruth.js` is
literally the answer key. Only `src/eval/` may read it, and only to score.

This is the reason any accuracy number in this project means anything. A fake encodes the beliefs of
whoever wrote it, so it cannot falsify them — and that is not an abstract worry here. On Day 11, 694
green tests all agreed about a Razorpay flag that had never once worked in the real API: every
payment-method switch the live gateway attempted had been impossible since Day 3, because the fake
gateway accepted a parameter the real endpoint rejects. The test suite was agreeing with its author.
The boundary test is the same idea applied structurally: it stops the agent from being able to grade
its own homework even by accident.

## The gateway is a parameter, never an import

`src/agent/orchestrator.js` imports no gateway. It receives one:

```js
executeDecision({ store, gateway, runId, decision, ... })
```

`src/razorpay/gateway.js` provides the real test-mode client and `src/sim/simGateway.js` the simulated
counterparty, and the caller decides which. `src/eval/harness.js` injects the simulated one; the live
CLI injects the real one. This is what lets the same decision loop run against both without the agent
ever being able to see the simulator's internals — the two claims in the README stay separable because
the code cannot mix them.

One consequence worth naming: every baseline arm runs through *this same loop*. A baseline implemented
as its own separate loop would measure the loop, not the policy.

Attempt rows are written `PENDING` before the gateway call and settled after it, so a crash between
the two is recoverable rather than invisible. If the process dies mid-call we do not know whether the
call happened, so the next cycle asks (`reconcilePendingAttempt`) rather than assuming.

## Approval is an envelope, not a password

A signature is checked at `grantClears` in `src/agent/guardrails.js` and names how far the agent may
go, using `InvasivenessLevel = { NONE: 0, CONTACT: 1, MONEY: 2 }`. Approval to contact a customer is
not approval to move their money. A denial is terminal. An unanswered request expires after
`approvalValidForHours: 72` and the case closes unactioned; the agent never escalates itself into an
action nobody approved. `AWAIT_APPROVAL` and `ESCALATE_HUMAN` are different outcomes and are not
interchangeable.

## The trail, and the rule that the screen may not rewrite it

`src/db/store.js` holds cases, decisions, attempts and receipts, keyed by `runId` so several runs can
coexist. `src/api/readModel.js` shapes that into what the console renders, and `web/` displays it with
no build step — React and htm are committed UMD files under `web/vendor/`.

The rule the browser code follows is narrow and worth stating: **a screen may omit a stored sentence,
but it may never rewrite one.** The hero view hides one redundant rejection line via a `terse` flag;
the drawer prints every `rejectedBecause` string verbatim, paise and raw signatures included, because
the drawer is the record. Rewriting an audit string on screen for readability is how a screen starts
telling a different story from the trail it is supposed to be showing. Relatedly, explanatory prose in
the console counts its figures from the rows on screen rather than having them passed in, so the
sentence cannot drift from the table above it.

Money is integer paise everywhere in `src/`. The browser divides by 100 in exactly one function, and
`test/web.test.js` enforces that there is only one such place — it also bans `.reduce(` from
`web/app.js` outright, so no total can be quietly recomputed in the view.

## What is held identical when arms are compared

`src/eval/` compares five arms, and five things are pinned across all of them: the same world, the same
model, the same luck, the same clock, and the same scorer. Comparisons are paired within worlds, never
pooled across them, and the reported money is **incremental** — what the do-nothing baseline recovers
anyway is subtracted from every arm, because gross overstates this project by roughly two thirds on the
most favourable seed.

The horizon is 21 cycles of 12 hours, which is 10 days. That number is not cosmetic: at 3.5 days, 67 of
80 cases are still mid-flight, and self-recovery needs about 10 days to show up at all. A run that stops
early is biased twice in this project's favour, since cases in flight have had less time to fail and
frozen approvals are money the policy never spent. That is why the operator console — which pauses
mid-horizon so a human can approve things — prints **no money figures at all**.

## Directory map

| Path | What lives there |
| --- | --- |
| `src/core/` | taxonomy, action kinds, config, money, RNG, stats — no logic that decides anything |
| `src/agent/` | diagnose, observe, recoveryModel, expectedValue, guardrails, stopping, decide, orchestrator |
| `src/ml/` | logistic, GBM, features, calibration |
| `src/razorpay/` | httpClient, gateway, liveGateway, errors, webhook, and the live CLIs |
| `src/sim/` | generator, latentTruth, payerTypes, responseModel, approver, simGateway — quarantined |
| `src/eval/` | harness, baselines, dataset, metrics, perturbations, sweep, and the report CLIs |
| `src/db/` | store (in-memory), connect |
| `src/api/` | readModel, server |
| `src/demo/` | session — wires a world, a store and an approver into one runnable console batch |
| `web/` | the operator console: `app.js` plus committed React/htm, no build step |
| `test/` | 20 suites, 735 tests, including `boundary.test.js` and `web.test.js` |

`web/app.js` is a classic script, not a module — every component is a top-level function declaration so
the test harness can reach it by name in a `vm` context and render it without a browser.

## What would have to change for production

The store is in-memory; `createStore({ kind: 'MONGO' })` is an interface with no implementation behind
it. The recovery model is fitted offline on simulated outcomes and frozen, so its coefficients describe
the simulator rather than the Indian payments market — the pipeline is the transferable part, not the
weights. There is no learning from realised outcomes. And the webhook normaliser exists but no live
receiver is running.

Nothing in this section is a surprise discovered at write-up time; each is a scope decision, and
`ENGINEERING_LOG.md` records where each was made.
