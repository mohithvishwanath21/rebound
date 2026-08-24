# How to verify this repo

Nothing here asks you to take a number on trust. Every figure in the README, the pitch and the
engineering log comes out of a command in this file, and the commands need no credentials, no
database and no network. There is no `npm install` step because there are no dependencies to install.

Requires Node 22 or newer (`node --version`).

    cd C:\MohithFiles\OldLaptopFiles\Rebound\rebound

---

## 1. The whole thing, one command

    npm run check

Runs the test suite, the simulator self-check, the diagnosis report, the model report and the batch
decision report in sequence. Under a minute — 23 s on the machine it was last measured on, and it was
~40 s on the reference Windows box before the decision report was added, so expect that range. If this
passes, everything below passes.

Verify the five commands it runs, rather than trusting the label:

    npm pkg get scripts.check

---

## 2. The test suite

    npm test

Expect `# pass 406`, `# fail 0`, `# todo 0`. Roughly 7 seconds. Section 8 explains why the count moved
and why there are no longer any `todo` entries.

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

The Day 6 files are worth reading for the names alone. Several are regression pins whose titles state
the bug: "the approval queue and the escalation queue are separate, and their totals reconcile", "a
revoked mandate is refused, not priced", "an unprofitable deferred action does not buy a WAIT — and the
stop still knows its evidence".

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
**Expect 406 tests, 406 pass, 0 fail, 0 todo.**

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

## 9. Diagnosis accuracy

    npm run diagnose-report

Per-tier hit rates against latent truth, on TRAIN and held-out TEST. The row worth reading is
`TEXT`, at 0.0% on both splits — free-text matching is wrong every single time it fires. It was kept
rather than deleted, and now sets `requiresApprovalForMoneyMovement`. Also read the abstention rate:
a rule table that never says "I don't know" looks identical to one that is always right.

---

## 10. The simulator's assumptions, stated

    npm run describe-sim
    npm run verify-sim

`describe-sim` prints every hand-set parameter in the response model. These are assumptions, not
measurements, and the honest version of this project prints them rather than burying them.
`verify-sim` checks the generator's distributions against those declared parameters.

---

## 11. What is proven versus what is measured

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

## 12. Git history

    git log --oneline
    git show --stat HEAD

Each day is one commit whose message states what was measured and what broke. The commit messages and
`ENGINEERING_LOG.md` are the same story at two levels of detail.
