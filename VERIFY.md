# How to verify this repo

Nothing here asks you to take a number on trust. Every figure in the README, the pitch and the
engineering log comes out of a command in this file, and the commands need no credentials, no
database and no network. There is no `npm install` step because there are no dependencies to install.

Requires Node 22 or newer (`node --version`).

    cd C:\MohithFiles\OldLaptopFiles\Rebound\rebound

---

## 1. The whole thing, one command

    npm run check

Runs the test suite, the simulator self-check, the diagnosis report, the model report, the batch
decision report and the orchestrated multi-cycle run in sequence. Under a minute — 23 s on the machine
it was last measured on, and it was ~40 s on the reference Windows box before the decision report was
added, so expect that range. If this passes, everything below passes.

The last two look similar and are not. `decide-report` prices a batch and stops — nothing is executed,
so its money column is what the policy *expects*. `orchestrate-report` runs the loop against the
gateway across eight cycles and reports only what a receipt confirmed. Expected money and collected
money are different claims and this repo never prints one under the other's name.

Verify the six commands it runs, rather than trusting the label:

    npm pkg get scripts.check

---

## 2. The test suite

    npm test

Expect `# pass 619`, `# fail 0`, `# todo 0`, across 25 files. Roughly 16 seconds. Section 8 explains why
the count moved and why there are no longer any `todo` entries.

The tests are in three deliberately separate categories, and the distinction matters more than the
count:

- **Hand-computed** — a metric is checked against a value worked out on paper. `test/ml.test.js` uses
  `Y = [1,0,1,0]`, `P = [0.8,0.3,0.6,0.1]` and asserts Brier is exactly 0.075. If the implementation
  and the test are both wrong they have to be wrong in the same way, which hand arithmetic makes hard.
- **Mathematical identities** — properties that must hold for any correct implementation. A constant
  predictor must score exactly `p̄(1−p̄)`. Platt scaling cannot change AUC, because two parameters can
  stretch the probability scale but cannot reorder anything.
- **Regression pins** — one test per bug in `ENGINEERING_LOG.md`, so a fixed bug cannot return quietly.

Run one file at a time if you want to read the names:

    node --test test/ml.test.js
    node --test test/rng.test.js
    node --test test/boundary.test.js
    node --test test/guardrails.test.js
    node --test test/expectedValue.test.js
    node --test test/decide.test.js
    node --test test/retryTiming.test.js
    node --test test/orchestrator.test.js

The Day 6 files are worth reading for the names alone. Several are regression pins whose titles state
the bug: "the approval queue and the escalation queue are separate, and their totals reconcile", "a
revoked mandate is refused, not priced", "an unprofitable deferred action does not buy a WAIT — and the
stop still knows its evidence".

Two Day 7 pins are worth singling out, because both exist to stop a *silent* failure rather than a
loud one. "the trail's delay agrees with the delayDays feature, now that the feature is alive" began
life asserting the feature was zero *and* that the printed sentence was not — pinning a defect it had
been decided not to fix yet, which is the right thing to do, but it also means the test fails the
moment the defect is fixed. That is exactly what #51 did to it, and the failure was the fix reporting
itself. It now asserts the two agree, which is the stronger claim. And the stub gateway in
`test/orchestrator.test.js` now runs the same `validateActionRequest` production runs — it previously
accepted more than production accepted, which is how a crash-on-first-run defect survived 417 green
tests. Section 9 has that story.

---

## 3. The claim most worth attacking: that the model never sees the answer

The response simulator holds latent variables — payer type, patience budget, whether the rails
actually work — that decide the true recovery probability. If any of that leaked into the features,
every accuracy number in this repo would be meaningless.

    node --test test/boundary.test.js

This is a static check, not a runtime one: it walks the import graph of `src/agent/**`, `src/api/**`,
`src/razorpay/**` and `src/ml/**` and fails if any of them can reach the truth module by any path.
Only `src/eval/**` is permitted to, because measuring accuracy requires knowing the answer.

A second, independent check lives in `test/ml.test.js`: it asserts no feature *name* matches a latent
field. Two mechanisms that fail differently — one on intent at build time, one on the data.

---

## 4. Reproducibility — run it twice

In PowerShell (the default terminal on Windows):

    node src/eval/cli/model-report.js *> "$env:TEMP\run1.txt"
    node src/eval/cli/model-report.js *> "$env:TEMP\run2.txt"
    Compare-Object (Get-Content "$env:TEMP\run1.txt") (Get-Content "$env:TEMP\run2.txt")

In bash or cmd:

    node src/eval/cli/model-report.js > run1.txt
    node src/eval/cli/model-report.js > run2.txt
    diff run1.txt run2.txt          # or: fc.exe run1.txt run2.txt

Expect no differences except the trailing timing line. Verified on 2026-08-24: the only lines that
differed were the echoed command and `(16.1s)` versus `(16.2s)`. Every number was identical.

This is not free: it required pinning an evaluation clock, because the generator's `now` defaults to
wall-clock time and two features read the calendar. See the Day 5 entry "The same report, run twice,
two minutes apart, printed different numbers."

Then check that seeds actually do something, which is a different property and was broken for four
days:

    node src/eval/cli/model-report.js --seed=day6

Different numbers, in every column. If they were identical, the seed would be decorative — see the
Day 5 entry "Four days of 'different seeds' were all the same seed."

Note the `=`. `--seed day6` written with a space **now exits 2 with a message naming the correct
form.** It used to be accepted silently, fall back to `day5`, and then print `seed day6` in its own
header — a report labelled with data it had not used. That was the third instance of one failure mode
in this project, so the parser was rewritten to refuse rather than guess: unknown flags, spaced flags
and values on switches are all fatal. Verify the guard is live:

    node src/eval/cli/model-report.js --seed day6      # exits 2, names --seed=VALUE
    node src/eval/cli/model-report.js --tress=500      # exits 2, "Did you mean --trees?"

Both should print one clean line, not a stack trace.

---

## 5. The model comparison

    npm run model-report

About 15 seconds. Five arms scored on three splits. What to look at, in order:

**The floor.** Each split prints `floor`, the exact expected Brier of a perfectly-informed predictor,
`mean(p(1-p))`. It is a closed form, not an estimate, and it is why "Brier 0.08220" is reported as
"30.8% of the learnable gap captured" instead. Without it the raw number is unreadable.

**The lookup table.** A `(cause, action)` GROUP BY with no model in it. It is the baseline most ML
write-ups omit, and omitting it is how a project takes credit for a lookup table. It captures 89.1% of
recoverable value on TEST. Any claim the ML layer makes has to be measured against this, not against
zero.

**The oracle.** An arm that reads the latent truth. It cannot be shipped; it exists to bound the
problem. It captures 81.5% of the learnable Brier gap and still only picks the best action 70.8% of
the time, which says how much of the remaining error is irreducible rather than unmodelled. That it
picks the best action barely two cases in three is the most quietly informative number in the report:
even perfect knowledge of the latent state leaves a hard decision.

**The two columns that disagree.** On TEST, `gbm` has the better Brier (0.08163 vs 0.08220) and AUC
(0.7556 vs 0.7499), while `logistic` leaves less money on the table (regret ₹4,39,267 vs ₹4,44,516)
and picks the best action more often (61.1% vs 59.6%). Brier and AUC are pooled over all rows; an
action is chosen by ranking candidates within a single case. A pooled metric cannot see within-case
ordering, and only within-case ordering spends money.

> **The rupee gap here is ₹5,249 and you should not lean on it.** An earlier version of this file
> reported this same disagreement as a ₹1,50,102 gap and warned that the 20-world sweep in section 6
> did not reproduce it. After the retry-timing fix in section 8 the gap on this seed collapsed to
> ₹5,249 — 1.2% of regret — which is what the sweep had been saying all along. Two independent routes
> to the same correction. The *mechanism* (pooled metrics cannot see within-case ordering) is real and
> is demonstrated far more strongly by the timing fix itself, where Brier improved and regret tripled
> at the same time. The rupee figure on any single seed is not the evidence for it.

**The coefficient table.** Fifteen lines of log-odds with support counts. This is the audit surface —
each line is a falsifiable claim about the world that a reviewer can disagree with without reading
code. It is also the reason a linear model is in the running at all.

**The findings section.** Generated from the numbers, including the verdicts. To check that, change a
number and confirm the prose changes with it — see the Day 5 entry "The report generated its own
numbers and hard-coded its own conclusions" for the version where it did not.

---

## 6. The arm selection sweep — the honesty check on how the model was chosen

    npm run select-arm

About 50 seconds. **Ten** independently generated worlds by default, and it is the only command
allowed to decide which model the Day 6 decision engine is built on.

The figures quoted below are from **twenty** worlds, which is the design the comparison was
pre-registered at, so reproduce them with:

    node src/eval/cli/select-arm.js --seeds=20

About 95 seconds. Note that an earlier version of this file said the command itself ran twenty — it
does not, and running the ten-world default first, before noticing, is written up as a process defect
in the Day 6 addendum. Fewer worlds are noisier in the *flattering* direction here: a six-world run
separates on both scoring sets where twenty separates on only one.

**Why it exists.** The Day 5 report picked an arm by reading the held-out TEST batch. That is
selection on the test set, and it silently converts a held-out number into a fitted one. The report
also contradicted itself: one finding concluded `logistic` from TEST while another used `lookup` from
VALID. Neither the choice nor the disagreement was legitimate.

**Why "just use VALID" was not the fix.** VALID is 120 events, and on it four arms sit within ₹1,650
of each other. A single split that small cannot separate them; it will name a winner anyway, which is
worse than admitting it cannot.

**What it does instead.** Each world is split 64% fit / 16% tune / 20% select. The tune split exists
so `gbm`'s early stopping has somewhere to look that is not the scoring set — otherwise it would be
consulting data the other three arms had not seen. Regret is normalised per world as
`regret / best-available`, because absolute rupees are not comparable across worlds of different total
value. Every comparison is **paired within a world**: between-world regret ranges from under 1% to
about 15%, and that spread is shared by all arms, so a difference of means would mostly measure which
worlds got drawn.

**What to check in the output.**

The line reading `SELECTED: logistic — BY TIEBREAK, NOT BY MEASUREMENT`. That wording is the point.
Three arms — `logistic`, `gbm`, `lookup` — cannot be separated at the pre-declared |t| ≥ 2.0 bar, so
the choice fell to a preference order written into `src/eval/armSelection.js` before the sweep was
first run. A preference is labelled as a preference and never as a finding.

The `logistic vs lookup` rows, of which there are two and they **disagree**:

    In distribution: logistic − lookup = -0.42% regret, t = -1.36, logistic won 14-6 of 20 worlds.
      NOT separable at the pre-declared bar — on this evidence the two are equivalent.
    Under shift    : logistic − lookup = -1.51% regret, t = -2.46, logistic won 15-4 of 20 worlds.
      Separable at the pre-declared bar, in favour of logistic.

In distribution the ML layer still does **not** measurably beat a GROUP BY — the opposite of what the
Day 5 write-up claimed. Under shift it does. Before the retry-timing fix neither separated (−1.14%,
t = −1.68, 10-9 — a coin flip), so the fix is what made the second row detectable.

The asymmetry is the evidence, not a nuisance. The fallback rate is 0.00% on both sets with 66 of 66
cells populated, so the advantage cannot be coverage — it is a stale cell mean. `TEST_PARAM_SHIFT`
moves `TEMPORARILY_SHORT` from 0.24 to 0.27, and that is the *only* payer type whose recovery
probability depends on when a retry lands, so the shift adds 12.5% more of exactly the payers whose
outcome is slot-dependent. A `(cause, action)` cell averages over the changed mix and cannot follow it;
a model reading `salaryWindow` can. In distribution the cells are fitted on the mix they are scored on,
so there is little staleness to exploit — which is why the effect shows up on one set and not the other.

> **What this does not establish.** That ML beats a GROUP BY. This shift moves the population along
> the one axis the features can see and the cell key cannot, which is close to the best case for the ML
> arms. The supported claim is conditional: when the population moves in a way the features can
> represent and the key cannot, the ML layer earns its place.

The coverage block: `0.00% of scored rows on a fallback` on both scoring sets, 66 of 66 cells
populated. That number falsified my original explanation, and the correction is worth following
because two hypotheses were hiding inside one sentence.

I had predicted the GROUP BY degrades under shift because its stored cells **go missing** — new
situations arrive, the table has no row, it serves a base rate. That is coverage loss, and it is
flatly false here: the shift moves payer mix, error-text vagueness and amounts, but adds no new cause
and no new action, so the cell *set* is identical either side and there is nothing to lose. More
worlds would not have helped; the hypothesis was wrong, not underpowered.

The version that survived is different and sharper: the cells are all present, but each one now
**averages over a different internal mix**, so a stored mean is stale rather than absent. `select-arm`
had been printing that narrower hypothesis about itself since Day 5 with the note that the sweep could
not test it. After the retry-timing fix it can, and it is what the separable under-shift row above is
measuring. "The lookup has no row" and "the lookup's row is now the wrong number" are different
failures, only one of them is visible in a coverage statistic, and I had been treating them as one.

**Verify it cannot cheat.** The reserved batch is `seed: 'day4'`, and the sweep has no expression that
could produce it:

    node --test test/armSelection.test.js

Twenty-one tests. The structural one scans the source and fails if `armSelection.js` references the
reserved seed in executable code or passes an un-prefixed seed to the generator — the same static
approach as the ground-truth boundary in section 3, and for the same reason: a behavioural test only
covers the paths someone thought to exercise. It ships with a negative control that proves the
detector can fail.

Every statistic in the file is checked against arithmetic done on paper, including the `n − 1`
denominator, and one of those tests caught my own addition error rather than a code defect.

---

## 7. The decision engine — what it decided, and why, for a whole batch

    npm run decide-report

This is the Day 6 deliverable and the closest thing in the repo to the product. It fits the recovery
model on TRAIN, decides all 200 cases at a fixed instant, and prints the outcome mix, the stop
reasons, both human queues, and a full audit trail for one case.

Read the two share columns against each other first:

    outcome             cases   share       at risk   share   exp. recovery
    ACT                   152   76.0%      ₹3,46,506  16.6%        ₹40,691
    AWAIT_APPROVAL         28   14.0%     ₹15,46,865  74.3%      ₹2,08,210
    ESCALATE_HUMAN         12    6.0%      ₹1,87,933   9.0%             ₹0
    STOP_PERMANENT          8    4.0%         ₹1,535   0.1%             ₹0

They disagree on purpose. 76.0% of *cases* are acted on automatically and they carry 16.6% of the
*money*; the 14.0% held for approval carry 74.3%. A recovery agent that treated cases as
interchangeable would show these columns tracking each other. Value, not count, is the entire thesis.

**The column most worth attacking.** `exp. recovery` is the agent's own arithmetic — the sum of the
expected values of the actions it chose. It is not money, and it is not a measurement. It is what the
policy *believes*, and it is printed next to a sentence saying so. Measured recovery against baselines
belongs to Days 8-9.

**Three things to check that would each falsify a claim this project makes.**

`--explain=5` prints five full audit trails. Every non-chosen action carries a `rejectedBecause`; a
forbidden action shows `priced: false, evPaise: null` rather than a number, because pricing an action
you may not take invites someone to override the guardrail on the strength of its EV. Every chosen
action satisfies `evPaise === grossPaise − totalCostPaise` exactly, in integer paise.

    npm run decide-report -- --split=TEST
    npm run decide-report -- --seed other-seed

The model is always fitted on TRAIN, even when deciding TEST. Fitting on the split being decided would
make every cell well-supported and the support asymmetry structurally impossible to observe.

    npm run decide-report -- --json --quiet | node -e "..."

Machine-readable, exit 0, nothing on stderr. `--quiet` suppresses progress so the JSON is parseable.

**A limitation the report prints about itself.** The support asymmetry — the rule that a low
probability may close a case when it rests on observations but must escalate when it rests on a
base-rate fallback — almost never fires on this generator. At the shipped key `(cause, action)` there
are 66 cells and every one is dense: 0.0% unseen, 0.0% fallback. The report says this rather than
implying a demonstration it cannot give, and prints a measured diagnostic beside it: at a granularity
a real merchant would have (`cause | action | matchTier | touchesUsed`, 408 cells) held-out rows are
0.3% unseen and 4.3% fallback. The mechanism is carried by `test/recoveryModel.test.js`, not by this
batch.

**The defect this section used to describe, and what closing it changed.** Until Day 6 the audit trail
printed seven `RETRY_SCHEDULED` candidates tied to the paise, spanning a week, resolved by an
alphabetical tiebreak on the action signature. Chasing that tie found the simulator bug in §8. Fixing
the simulator was only half of it: the engine scored with the lookup table, whose key is
`(diagnosed cause, action kind)`, so two slots sharing a kind shared a cell and one rate — while the
fixed ground truth separated them by up to 25x. The engine is now wired to the arm the selection
procedure actually names, and the ranking separates:

    rank  action                                      EV   verdict
    1     RETRY_NOW                                  ₹12   ALLOW  <- chosen
    2     RETRY_SCHEDULED:2026-08-24T15:30:          ₹11   ALLOW
    3     RETRY_SCHEDULED:2026-08-24T21:30:          ₹11   ALLOW
    4     RETRY_SCHEDULED:2026-08-25T09:30:          ₹10   ALLOW
    5     SWITCH_RAIL_NUDGE:WHATSAPP                 ₹10   ALLOW
    6     RETRY_SCHEDULED:2026-08-26T09:30:           ₹9   ALLOW

Monotone in the slot, and a non-retry action now interleaves at rank 5 instead of sitting below a
block of ties. The header names the arm it used, and `--json` reports `model.arm` and
`model.support.arm` separately.

**Two things worth checking rather than believing here.** First, the probability and the support come
from *different models*: a logistic over 140 observable features estimates `p`, and the `(cause,
action)` table reports how many rows back that region. That is not a workaround — a logistic will
return a confident number for a cell it never saw, which is exactly what the stopping rules exist to
catch. Second, `STOP_PERMANENT` went from 2 cases to 8 and `NEGATIVE_EV` now closes 8 cases worth
₹1,535 in total. That is the new arm pricing small, old, hopeless cases below the cost of touching
them, which is the intended behaviour and shows up as *more* stopping, not less.

**How this was allowed to happen, since that is the more useful thing to record.** `select-arm` printed
`SELECTED: logistic` and this command used `lookup`, for six days, with a full green suite. The choice
of `lookup` *was* documented — in `src/agent/recoveryModel.js`, on the good grounds that a 20-world
sweep had found no arm measurably beating a GROUP BY. What made it a defect was that the sweep
predated the simulator fix, so it had been run in a world where the one thing a feature model can
express and a GROUP BY cannot was switched off. A justification can expire without anyone editing it.
No test failed, because every test asserted the seam *could* carry a timing distinction and none
asserted that the shipped entry point *did*. `test/recoveryModel.test.js` now closes that with a
source-level assertion, and its docblock says plainly why a brittle test is the right instrument here.

**Reproducibility.** `DEFAULT_NOW` is fixed at `2026-08-24T09:30:00Z`. Using `new Date()` would make
quiet hours, case age and retry gaps irreproducible — the same command would give different answers
before and after 21:00 IST. Pass `--now` to move it deliberately.

---

## 8. The defect that was pinned, then fixed — and what fixing it did to every other number

    node src/eval/cli/probe-timing.js

The simulator's `recoveryProbability` used to ignore `action.scheduledFor`. It computed the
salary-window timing boost from `now` — the decision instant — which is identical for every candidate
being compared against each other. For a cash-flow-constrained payer whose salary lands in two days,
all three scheduled offsets were labelled `p = 0.032094`. Honouring the instant the retry actually
lands gives 0.031 / **0.801** / 0.244: a 25× effect, invisible to the ground truth, on the decision
this product is most distinctive about.

The probe prints the case priced both ways. **Both blocks now agree** — that is the point of running
it, and it is why the file is kept rather than deleted. Its second block was always what the comments
claimed; the first block is what the code did.

The three `todo` tests in `test/retryTiming.test.js` are now live assertions, joined by two more the
fix itself demanded, and four in `test/recoveryModel.test.js` covering the second half of the fix.
Day 7 added fourteen more, so the current total is **420 tests, 420 pass, 0 fail, 0 todo.**

    node --test test/retryTiming.test.js

The test worth reading is `waiting longer is not free, so the optimum is interior rather than "wait
forever"`. Moving only the funds branch to the landing instant would have made waiting free — the
boost arrives if you wait and nothing charges you for waiting — so the optimal policy would have been
to schedule as late as the guardrails permit. Age decay had to move too. With both moved, +3d beats
both +6h and +9d, which is the shape a timing decision has to have to be a decision.

**What this did to the rest of the repo, which is the part worth attacking.** Normalised regret
roughly *tripled for every arm* (logistic 3.52% → 12.00% in distribution), while Brier slightly
*improved* (0.09518 → 0.09056). Before the fix, every scheduled slot carried an identical true
probability, so picking the wrong slot cost nothing and regret was low because the hardest decision in
the product had been deleted from the problem. Restoring it did not degrade the models; it restored a
decision they can get wrong.

So every regret figure this repo printed before that commit was computed on an easier problem. The
arithmetic was right and the question was wrong. The full write-up, including four pre-registered
predictions and how they scored — one of them on a **falsified premise** — is the Day 6 addendum in
`ENGINEERING_LOG.md`.

---

## 9. The whole loop, executed rather than priced — Day 7

    npm run orchestrate-report

Section 7 prints what the policy *expects* to recover. That is arithmetic over the policy's own
estimates: nothing is executed, no outcome is drawn, and a large number there is a claim rather than a
result. This command runs the loop — decide, guardrail, execute against the gateway, persist, settle
receipts, schedule wakeups, advance the clock, repeat — and prints only what a receipt actually said
was `CAPTURED`. About seven seconds, no database, no network, no API key.

With the defaults (`seed=day7`, 80 cases, 8 cycles 12 hours apart from 2026-08-24T09:30:00Z):

> **THE FIGURES IN THIS TABLE ARE HISTORICAL AND WILL NOT REPRODUCE.** They were measured on generator
> **g100** with an 8-cycle horizon, before the deferral spin loop (#67), the approval gate (#60/#61), the
> generator RNG fix (#64), the train/serve skew (#51), the σ bar (#52) and the phantom retry recovery
> (#68) were closed. Running the command today prints different and larger numbers. The table is kept
> because the **exposure-split reasoning below it** is the durable part and is what the command is worth
> running for. **Do not quote ₹4,311 as a result anywhere** — measured against the same world with the
> spin loop fixed, the same arm recovers roughly 19x that. Current figures live in section 12.

| | |
|---|---|
| total at risk | ₹11,20,352 |
| **recovered (SIMULATED)** | **₹4,311** |
| attempts that returned a receipt | 73 |
| ledger check | receipts and case records agree |
| worst per-customer message count | 2, against a cap of 2 — no breach |

**Read the exposure split before reading the recovery rate.** Of the money at risk, 77.0% is parked
awaiting human approval and 7.1% is escalated, leaving 15.9% (₹1,78,203) the agent was actually
permitted to act on. So the same ₹4,311 is *2.4% of what it was allowed to chase* and *0.4% of
everything at risk*. The report prints both, because either alone misleads: divide by everything and
you are measuring the ₹25,000 approval threshold rather than the policy, since a handful of large
invoices park most of the exposure with a person; divide only by the autonomous slice and you hide how
much of the book needed one. The approval and escalation rows are not failures — they are the
compliant-escalation half of what Track 03 asks for.

**Neither rate says the policy beats anything.** There is no baseline and no counterfactual here.
`checkSelfRecovery` exists in the response model and this command does not call it, so the money that
would have come back with no agent at all has not been subtracted from anything. The only honest
reading is "the loop runs, and this is what it did" — not "this is what it was worth". That comparison
is Day 8.

Three things in the output are deliberately measured rather than asserted:

- **The ledger check.** Two independent code paths produce the recovered figure — the per-cycle
  receipts, and the patch `settleAttempt` writes onto the case record. They are reconciled and the
  result printed. A disagreement would mean money credited with no receipt behind it.
- **Compliance is counted from the action ledger, by customer** — not from the guardrail's own
  verdicts. Asking a rule whether it was obeyed is circular; counting what was actually sent is not.
- **The timing line** in the audit trail reads its delay from `effectiveAt - decidedAt`, never from the
  `delayDays` feature. See below.

Determinism, which is the claim most worth attacking on a command that draws random outcomes:

    node src/eval/cli/orchestrate-report.js --seed=day7 --count=30 --cycles=5 --json > a.json
    node src/eval/cli/orchestrate-report.js --seed=day7 --count=30 --cycles=5 --json > b.json
    fc.exe a.json b.json

Identical apart from `elapsedMs`. The JSON also names its denominators explicitly
(`exposure.totalPaise`, `awaitingHumanPaise`, `escalatedPaise`, `autonomousPaise`) and carries
`recoveryIsSimulated: true`, `hasBaseline: false`, `selfRecoveryCounterfactualIncluded: false`, so a
dashboard cannot quietly pick the flattering denominator or drop the caveat.

Bad flags fail loudly rather than being ignored:

    node src/eval/cli/orchestrate-report.js --split=MIDDLE
    node src/eval/cli/orchestrate-report.js --seed day7

Both exit non-zero with an explanation. The second matters because an earlier version of this CLI
silently ignored the spaced form and then printed a report labelled with a seed it had not used.

### The defect this command found, and why 417 passing tests had missed it

Running the loop for real crashed immediately: `executeDecision` built its gateway request with
`customer` but no `event`, and the simulated gateway prices outcomes against the loss's own physics, so
it was resolving every outcome against `undefined`.

The reason the suite missed it is the part worth keeping. `stubGateway` in `test/orchestrator.test.js`
never called `validateActionRequest` and never read `event` — **it accepted more than the real seam
accepts.** A double that is more permissive than production is not a double; it is a second
implementation with a weaker contract, and the only thing it can prove is that the code agrees with
itself. Fixed in three places rather than one: the orchestrator now passes the event, the double now
validates exactly as production does, and `simGateway` raises an explicit error for a missing event or
an unparsable `occurredAt` — because the failure without it was an `undefined` dereference four frames
deep, and a *missing* `occurredAt` was worse still, silently making the case age `NaN` and filling the
report with plausible numbers computed from nothing.

### A train/serve skew, printed rather than hidden — and closed on Day 8 (#51)

While making the audit trail explain its timing, the line read *"landing in 0.0 days"* about a slot six
hours out. A probe that builds the feature vector both ways found **3 of 140 columns differ** between
the dataset and the engine: `delayDays` was always 0 at serving, and `ageDays` / `ageDecayProxy`
described the case at the decision instant in training but at the landing instant at serving.
`salaryWindow` was the control — it reads `action.scheduledFor` directly in both paths, so passing the
landing instant into the scorer was never what made the salary window visible.

Day 7 left this open on purpose and described it as two internally coherent conventions needing a
choice. **That framing was wrong, and Day 8 says why: there was no choice to make, because a third
party had already made it.** `src/sim/responseModel.js` draws the outcome label against LANDING-time
age. So the training-side `ageDays` was not one defensible convention among two — it was measuring a
different quantity than the label it was being fitted against. #51 gives `buildFeatures` both instants
and derives the landing one from the same `effectiveAt` the guardrails use, so the two sides cannot
drift apart again by restating a rule.

    node src/eval/cli/probe-coefficients.js

Read the `TRAIN/SERVE SKEW (closed by #51)` block. It featurises one scheduled action under both
conventions and prints `delayDays ... was 0.000 under the old convention, now 2.000`, with the age
columns reported `consistent across both conventions`. Those statuses used to be hardcoded strings,
which meant the probe would have gone on announcing a defect after the defect was fixed; they are now
computed, because a probe that keeps reporting a failure it no longer detects is worse than no probe.

**The fix cost money, and the number is stated here rather than left for a reader to find.** A/B on a
fixed g130 generator at commit `e99c28d`, TRAIN seeds 1-3, count 80, incremental recovery: seed 1
unchanged at ₹5,61,016, seed 2 unchanged at ₹42,108, seed 3 **down from ₹1,74,521 to ₹50,799**. Pooled,
closing the seam cost **₹1,23,722**, about 16% — and the pre-registered prediction said money would go
UP by less than 10%, so that prediction is falsified in both direction and size. The fix stays, on the
ground that a feature fitted against a different quantity than its own label is a defect whether or not
it happens to pay: training on decision-time age fed the model a systematically *younger* case than the
one its label described, which is an optimistic view of every scheduled retry, and losing an optimistic
view costs money by construction.

**And the defect was named after the wrong column.** `delayDays` — the column the whole task was about
— carries a weight of −0.0014 over a training range of [0, 9], a swing of −0.0125 log-odds. Nothing that
small moves an argmax. The money came from `ageDays` (weight −0.4316, swing −1.18), whose *training*
clock was the misaligned one. The chain is: age becomes correct, the fitted decay sharpens, stale cases
score lower, EV drops under the ₹2 bar sooner, the agent stops earlier, and in seed 3 stopping earlier
was expensive (1,278 fewer decisions). That makes the seed-3 decline a story about the EV floor, not
about features — which is task #52.

One unlooked-for confirmation fell out of it: seed 1's **gross** fell ₹73,518 while its **incremental**
held identical to the paise. The entire gross decline was credit for cases that would have recovered on
their own. An unrelated change reduced the gross by exactly the amount the incremental column was
already refusing to count. Quote incremental.

    node --test test/decide.test.js

**Expect 38 tests, 38 pass.** The three worth reading are the timing-line tests at the end. One of
them covers a case that is easy to get wrong: when the scoring arm is a `GROUP BY`, which structurally
cannot see when a slot lands, the trail has to *say so* rather than printing nothing — an absent timing
line and a timing line showing the slot did not matter look identical to a reader, and they are
opposite claims.

---

## 10. Diagnosis accuracy

    npm run diagnose-report

Per-tier hit rates against latent truth, on TRAIN and held-out TEST. The row worth reading is
`TEXT`, at 0.0% on both splits — free-text matching is wrong every single time it fires. It was kept
rather than deleted, and now sets `requiresApprovalForMoneyMovement`. Also read the abstention rate:
a rule table that never says "I don't know" looks identical to one that is always right.

---

## 11. The simulator's assumptions, stated

    npm run describe-sim
    npm run verify-sim

`describe-sim` prints every hand-set parameter in the response model. These are assumptions, not
measurements, and the honest version of this project prints them rather than burying them.
`verify-sim` checks the generator's distributions against those declared parameters.

---

## 12. The five-arm comparison — the Track 03 headline

    npm run eval

Five policies run against the **same worlds, the same trained model, the same random luck and the same
clock**, scored by one function. 5 worlds x 80 cases on the held-out TEST split, 21 cycles x 12h =
10 simulated days. Takes about a minute. **Exit code 1 if any invariant fails**, and in that case the
headline is suppressed rather than printed with a warning — a number nobody can trust should not be
available to copy.

Read the output in this order.

**First, the four things held identical.** The run prints them. If any of the four drifted between
arms the comparison means nothing, so the harness asserts them rather than documenting them:
same world (same seed, same generator version), same model (one fit, shared), same luck (the same
`runId` in separate stores, so identical coin flips), same clock.

**Second, the compliance columns.** `quiet!`, `cap!` and `ABS!` count rules actually broken by actions
actually taken. Pooled over the five worlds, expect **B2_AGGRESSIVE at 2,836 quiet-hours messages and
5,095 contact-cap breaches across 278 distinct customers, and exactly zero of both for B1, B3 and
Rebound.** The `worst7d` column is the one to read out loud: B2 reaches **45 messages to a single
customer inside seven days against a cap of 2** (58 to one customer over the whole run), while Rebound
sits at **exactly 2 of 2 — the cap binds and is never crossed**. That is the point of the comparison:
B2 is what "just retry harder" looks like when nobody is counting.

One honest qualification, because the overreaching version of this claim is tempting: **`ABS!` is 0 for
every arm including B2.** B2 is not breaking the absolute prohibitions — it is repeatedly breaking the
per-customer window cap that sits below them. Say the specific thing.

Do **not** read `refused` as a cross-arm number. It counts refused *candidates*, and the arms enumerate
completely different numbers of candidates per cycle — Rebound prices the whole action space, B1
considers one thing. Its only honest use is the zero test: non-zero means the guardrail engine binds on
that arm at all.

**Third, the money, on the incremental basis.** Both money columns net out B0_DO_NOTHING's
counterfactual, so **B0 sits at exactly ₹0 in both by construction** — that zero is the check that the
subtraction is happening on the basis it was measured on. Gross recovery is not printed as a headline
anywhere, because an arm that reaches a case on day 2 which would have paid unprompted on day 9 books
the full amount as its own.

**The claim to lead with, because it is clean on every basis at once: Rebound recovers 1.8728x
B3_FIXED_LADDER's incremental money using 14% FEWER attempts** — 1,379 against 1,610, which is 2.19x
the money per action (45,501 paise per attempt against B3's 20,810). That sentence needs no argument
about whether rule-breaking counts and no choice of denominator to make it work.

Against **B3_FIXED_LADDER** (the compliant, competently-designed baseline — the comparison that matters,
and it was designated in the harness before any result came in): mean **+₹58,483** incremental, range
**−₹83,034 to +₹3,86,987**, sd **₹1,88,613**, **ahead in 3 of 5 worlds**, pooled **1.8728x**.

**Quote the sign count, not the ratio.** The sd is more than three times the mean, the range crosses
zero, and the pooled figure is carried almost entirely by seed 1. "Ahead in 3 of 5 worlds, two negative,
sd three times the mean" is the honest sentence. There is no p-value at n=5 and the run does not print
one; it prints the mean with the range, the sd, the sign count and the n.

**And against B2_AGGRESSIVE, the rule-breaker, Rebound loses: mean −₹50,358 incremental, ahead in 2 of 5
worlds, pooled 0.7136x** (₹6,27,454 against ₹8,79,244). This is stated here rather than left for a
reader to find, and it got **worse** than the previously recorded figure, not better — earlier runs on
the g130 generator showed 4-of-5 against B3 and 0.79x against B2. Two fixes landed between those runs
(#51's train/serve skew and #68's phantom retry recovery) and the regression is attributed to them
together rather than pinned on either, because they were not measured in isolation.

On money alone, over ten days, on held-out worlds, the rule-breaking baseline beats us. What the same
table also shows is the price of being B2: **6,609 attempts and 5,664 messages against Rebound's 1,379
and 691 — 4.8x the volume for 1.40x the money** — with the quiet-hours and contact-cap counts above.
B2's figure is not one a merchant could run; it is what you get with the compliance rules switched off.
B3 is therefore the comparison the experiment was built around, which was its stated design before this
result came in, not a line drawn after seeing it.

**A number worth checking because it is the least flattering one here.** Rebound's gross recovery is
₹7,01,973 and its incremental is ₹6,27,454, so **₹74,519 — a tenth of what it recovers — is money the
customer would have paid anyway.** That is the largest counterfactual deduction of any arm (B3 loses
13.2% of gross, Rebound 10.6%, B2 only 5.4%). It also means the basis is not neutral: switching gross →
incremental improves Rebound against B3 and worsens it against B2, so choosing a basis per comparison
would be choosing a winner. The harness quotes incremental for both.


**Fourth, the horizon.** If you shorten the run you will make Rebound look better, which is why the
report prints a HORIZON TRUNCATION block with per-arm `pendingActions` whenever the horizon is under
10 days. See it for yourself:

    node src/eval/cli/run.js --seeds=1 --count=40 --cycles=7

Every baseline reports ₹0 and Rebound reports money, because 3.5 days cuts off the arms that *space*
their attempts. To run a fast smoke test, cut worlds and cases and keep all 21 cycles:

    npm run eval-smoke

**Two bugs found by reading this output rather than trusting it**, both of which had been inflating
Rebound. B3's retry ladder anchored its "+24h" rung to `now`, so each re-decision at wakeup produced a
fresh +24h and the ladder never advanced — 65 of 80 cases got exactly one action in ten days. And
`netPaise` was gross-minus-costs printed beside an incremental column, so one arm showed a net larger
than the money it was derived from. Both are described in `ENGINEERING_LOG.md` under Day 8. The
trajectory tests that would have caught the first one now exist:

    node --test test/baselines.test.js

**Expect 35 tests, 35 pass.** The ones that matter run an arm for a full horizon and assert that cases
*progress* — no test of a single decision can see a policy that never advances.

### 12a. The approval gate, and the human on the other side of it

Actions on cases above ₹25,000 do not execute without a named human. Until Day 8 the gate was
write-only: cases went in and nothing came out, which stranded roughly **72% of Rebound's exposure** in
`AWAITING_APPROVAL` at the horizon. Every money figure measured before the reviewer existed was measured
in a world where the merchant installed an approval queue and hired nobody to answer it — not a
conservative world, an incoherent one. `src/sim/approver.js` answers it. Look at the queue directly:

    node src/eval/cli/run.js --seeds=1,2,3,4,5 --count=80 --split=TEST

The **HUMAN APPROVAL** section prints, per world and per arm: how many authorisations were asked for,
granted, denied and still pending; the exposure frozen at the horizon; the exposure a human **refused**;
and the realised p50 and p90 wait. Three things in it are worth checking on purpose.

**The reviewer is a property of the world, not of the policy.** Its disposition is seeded from the world
seed and the `eventId` — deliberately **not** from the arm, the cycle, or the request time. If the arm
entered that seed, two policies queueing the same case would meet different reviewers, the high-value
cases would be granted to one and refused to another, and the difference would land in the money column
with nothing else noticing. The `approverIsArmBlind` invariant compares every case the reviewer answered
across all five arms and **suppresses the entire headline** if any case got two different verdicts.

**`asked` can exceed granted + denied + pending, and that is correct.** A grant is an envelope that
expires after 72 hours, so a case whose authorisation lapsed comes back for a fresh signature instead of
acting on a stale one. In seed 1, Rebound's reviewer logged 19 grants while only 9 cases *ended* in
GRANTED, because 7 cases returned to the queue — one of them four times. This is also where an invariant
of mine was wrong: it compared the reviewer's tally to the per-case census, which counts different
things, and failed in all five worlds until it was pointed at the audit event counts.

**`refused` is printed beside `frozen` on purpose.** Denials are terminal, so refused exposure is money
the policy is permanently barred from by a decision it does not control — a ceiling on our own headline,
₹30,488 to ₹2,65,328 per world. It is printed so `frozen: 0` cannot be misread as "nothing was blocked".

The reviewer's two parameters are **declared assumptions, not measurements**: an 18-hour mean SLA and a
0.7 grant rate, both marked `JUDGEMENT` in `src/sim/responseModel.js` with their sweep ranges. The grant
rate sweep tops out at 0.9 and never reaches 1.0, so no run in the sensitivity analysis is handed a
rubber stamp. The reviewer has **no capacity limit** — 40 simultaneous requests are answered as fast as
one — and that omission flatters us rather than being neutral, because Rebound queues the most.

    node --test test/approver.test.js

**Expect 34 tests, 34 pass**, including the wait distribution hand-checked at u=0 and u=1−1/e, the
reviewer's business-hours deferral, and 500 sweep perturbations that must never trip the approver's own
SLA guard.

### 12b. The noise bar — an A/B you can run yourself from one code state

The threshold an action must clear used to be a flat ₹2. Its justification was that the probability
estimate has a standard error, and **a constant cannot track a standard error**: σ(EV) = σ(p) × amount ×
margin, so it grows with the stake and shrinks with the number of comparable rows the model saw. The bar
is now `max(₹2, k × σ(EV))` with `POLICY.evBarSigmaK = 1`.

Setting `k = 0` restores the old flat bar **exactly**, which is what makes this an A/B rather than a
before/after — the world, the model, the luck and the clock are all held, and only the bar moves:

    node src/eval/cli/run.js --seeds=1,2,3,4,5 --count=80 --split=TEST --ev-bar-sigma-k=0
    node src/eval/cli/run.js --seeds=1,2,3,4,5 --count=80 --split=TEST --ev-bar-sigma-k=1

**Expect the incremental money to be identical to the paise in all five worlds** (pooled ₹6,27,454 both
ways) while attempts fall 1,443 → 1,379, so paise per attempt rises 4.6%. `B3_FIXED_LADDER` should come
back **bit-identical** between the two runs; if it does not, the flag is leaking into something it should
not touch and the comparison is void.

"Zero rupees lost" is a suspicious result, so check the mechanism rather than the total: in every seed
the number of retries removed **equals** the number of *failed* retries removed exactly (13/13, 7/7, 3/3,
3/3, 10/10), plus 28 messages that recovered nothing. The bar removed 4.4% of the actions and none of the
money because what it removed was actions that were going to fail.

**The cost, which was not predicted and is not zero.** Net recovery falls ₹23 pooled, and one world loses
₹108. Stopped cases rise in every seed and unresolved cases fall in every seed: a noise bar converts
cheap wrong actions into human attention, and human attention is priced at ₹60. That trade is the honest
description of what this change does.

**Why an unseen cell deliberately does NOT get a σ bar.** With `rows = 0` the probability is the global
base rate and the error in it is **bias, not variance** — a standard error cannot express bias, so
inventing one would be arithmetic theatre. Those cases fall back to the flat floor and are handled by
`APR_UNSUPPORTED_BELIEF`, which routes money movement on an unsupported belief to a human. The first
implementation got this wrong in a way worth knowing about: applying the Jeffreys pseudo-count
unconditionally gave σ(p) ≈ 0.22 at rows = 0, a bar of roughly a fifth of the amount, which turned
`AWAIT_APPROVAL` into `ESCALATE_HUMAN`. Those are not interchangeable — approval gates an action the
agent has chosen and wants permission for; escalation is the agent declining to choose — and the swap
would have silently disabled the approval envelope while every headline number still looked reasonable.

    node --test test/expectedValue.test.js

**Expect 27 tests, 27 pass**, including σ(EV) hand-computed to the paise, the amount-invariance of
EV/σ(EV), and the assertion that `k = 0` reproduces the flat bar.

### 12c. The eleventh defect that flattered the headline

`RETRY_NOW` and `RETRY_SCHEDULED` on an `OVERDUE_INVOICE` were priced as if they could succeed. **There
is no failed charge to re-present** — the merchant sent an invoice, they never charged the card. The
recovery was real in the metrics and impossible in the world.

The cause is a shape worth recognising: the response model's `actionFit` table is indexed by **payer
type**, so it structurally cannot express "this *action* is meaningless for this *loss type*". A
reminder-responsive payer picked up a 0.50 fit for `RETRY_NOW` and the arithmetic did the rest. The
taxonomy knew; the physics did not.

    node --test test/retryTiming.test.js

The fix moved **1.39 percentage points of the entire labelled population** out of the recovered column:
`INVOICE_FORGOTTEN|RETRY_NOW` went from 18.06% empirical recovery to **0.00%** with n unchanged at 1,113.
That equality — labels moved, row counts did not — is the check that the fix changed the physics rather
than the dataset. The pinning test also asserts the fix is *narrow*: `SEND_LINK` to the same payer on the
same invoice must still work, and `RETRY_NOW` on a genuine `FAILED_PAYMENT` must still work, so "fixed"
cannot quietly mean "invoices are now unrecoverable".

This is the eleventh defect in this project that made the headline number look **better**, and not one
has made it look worse. That is not luck — a defect that made the number look bad would have been
investigated the day it appeared. **A bug that flatters the metric will not be found by reading the
metric**, which is why every one of these was caught by a probe that counted events in the world rather
than rupees in the report.

It also forced a retraction. The claim that the model **under-predicts recovery 6x** was wrong: on the
corrected physics, pooled empirical 9.93% against predicted 9.92% is **1.00x**. The "gap" was the
phantom recovery inflating the empirical side. What survives is within-cell mis-ranking, worst at
`INVOICE_DISPUTED|ESCALATE_HUMAN` (22.81% empirical against 10.17% predicted, n=114).

---


## 13. The assumption sensitivity sweep — does the ranking survive being wrong about the prices?

Every price in this project is stated, not measured: `describe-sim` prints `measured: false` beside all
of them. So the question that matters is not whether the numbers are right, but whether the **ranking**
survives them being wrong.

### Read it in one second, without re-running anything

    npm run sweep-report

Re-prints all 26 rows from the run committed under `docs/evidence/sweep-2026-08-26/rows/`. No
computation, no waiting. Every sweep figure quoted in `ENGINEERING_LOG.md` comes from these files.

### Or reproduce it from scratch — about 20 minutes

    npm run sweep

26 rows x (5 worlds x 80 held-out cases x 21 cycles). Two workers by default because the box has two
cores; `--workers=4` on a bigger machine. Individual rows:

    node src/eval/cli/sweep.js --list
    node src/eval/cli/sweep.js --only=baseline,cause-mix-do-not-honour-x3

### What to check, in this order

**One: the control row must reproduce the headline.** If it does not, the sweep harness is changing the
result by observing it and nothing below it can be read. Expect exactly:

    baseline    3/5 signs    1.87x pooled incremental vs B3    +Rs 58,483 mean paired
                1,379 actions (688 retries + 691 messages)     0.71x vs B2

Those are the same four figures `npm run eval` prints. The `vsB2` column stays in the table on purpose:
**the control LOSES that comparison**, and it is printed on all 26 rows so that a row which flips it
cannot be quoted without the other 25 beside it.

**Two: the row counts.** `Rows requested: 26. Completed: 26. Crashed: 0. With invariant defects: 0.` A
crashed row prints FAILED and is excluded from the verdict counts *and* from their denominator —
otherwise a broken sweep would report a better ratio than a working one.

**Three: the verdict column.** Of the 25 non-control rows, 24 hold the primary verdict and **1 flips**:

    cause-mix-do-not-honour-x3    2/5 signs, 1.75x    FLIP -> fails

The verdict is fixed in a `VERDICT` constant at the top of `sweep.js` — >= 3 of 5 paired worlds AND a
pooled ratio above 1, both required — written before any row ran and applied identically to every row
including the control. Rows print in catalogue order and are never sorted by favourability.

**Four: `NO-OP -- SUSPECT WIRING`.** This is the verdict that matters most and it should appear zero
times. A perturbation that fails to reach the world prints the control's numbers under a perturbed row's
name, and the honest-sounding reading of that row is "this assumption does not matter". Two rows,
`channels-x0.7` and `channels-x1.3`, pre-register their null in the catalogue and print
`no-op (PREDICTED)`; a test pins that list to exactly those two so no other row can be excused after the
fact.

**Five: the money-only nulls.** The findings section lists rows that changed what the agent *did* without
changing what it recovered. Those are results, not nulls — `retry-penalty-x0` fires 100 more retries for
the same rupees to the paise.

### The two claims worth attacking

The sweep's own headline finding is that **the failed-retry penalty does not drive the money.** Across
the 15 rows that hold the world fixed and change only a price, Rebound's retries span 447-788 (a 1.76x
range) while gross recovery spans ₹6,98,301-₹7,01,973 (0.53%). Retry success is 2.5-2.8% for every arm.
The money comes from contacting the right customer, not from re-charging the card.

And the assumption the conclusion actually rests on is **the cause mix**, not any price. Check that
yourself with the pair:

    node src/eval/cli/sweep.js --only=cause-mix-do-not-honour-x3,cause-mix-insufficient-funds-x3

DO_NOT_HONOUR is the cause the diagnosis taxonomy handles worst and the ranking fails there;
INSUFFICIENT_FUNDS is the cause where waiting is right and the ranking holds. Both refit the model on
the tilted world, so neither is measuring staleness.

### The row that answers a different question

`stale-model` prints `RFT: N`. The world moves and the model keeps beliefs fitted in the baseline world,
so it measures robustness to being **wrong** about the assumptions rather than sensitivity to their
values. It shares `joint-1`'s rng seed, so the two are the same world differing in exactly one variable:

    node src/eval/cli/sweep.js --only=joint-1,stale-model

Read them as a pair or not at all. A flip in `stale-model` cannot be attributed, because the
perturbation's effect and the size of the train/serve gap move together.

### The number in this sweep I am asking you not to quote

All three `joint-*` rows flip the vsB2 comparison from the control's 0.71x loss into a 1.08-1.11x win.
That is a win found by searching 25 worlds, and the sweep prints it under its own heading saying so. If
you want the honest version of the vsB2 comparison, it is in section 12: **on money alone, the
rule-breaking baseline beats us, and what it costs to be that baseline is 2,836 quiet-hours messages.**

---

## 14. What is proven versus what is measured

Two claims, never mixed, and the difference is the whole argument:

**The plumbing works** — proven against the real Razorpay test-mode API. Idempotency behaviour,
partial settlement, the 401, the duplicate-link refusal. One real ₹499 recovery traced end to end on
2026-08-22. Reproducing this needs your own test keys:

    npm run doctor

**The policy is better** — measured in simulation, against a documented response model, on a held-out
split with a deliberate parameter shift. Simulated rupees. `npm run model-report` prints this, and
prints the caveat next to the money column rather than in a footnote.

No command in this repo produces a number that mixes the two.

---

## 15. Git history

    git log --oneline
    git show --stat HEAD

Each day is one commit whose message states what was measured and what broke. The commit messages and
`ENGINEERING_LOG.md` are the same story at two levels of detail.
