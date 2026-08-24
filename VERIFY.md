# How to verify this repo

Nothing here asks you to take a number on trust. Every figure in the README, the pitch and the
engineering log comes out of a command in this file, and the commands need no credentials, no
database and no network. There is no `npm install` step because there are no dependencies to install.

Requires Node 22 or newer (`node --version`).

    cd C:\MohithFiles\OldLaptopFiles\Rebound\rebound

---

## 1. The whole thing, one command

    npm run check

Runs the test suite, the simulator self-check, the diagnosis report and the model report in sequence.
Takes about 40 seconds. If this passes, everything below passes.

Verify the four commands it runs, rather than trusting the label:

    npm pkg get scripts.check

---

## 2. The test suite

    npm test

Expect `# pass 246`, `# fail 0`. Roughly 3 seconds.

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

    node src/eval/cli/model-report.js > run1.txt
    node src/eval/cli/model-report.js > run2.txt
    fc run1.txt run2.txt

Expect no differences except the trailing timing line. This is not free: it required pinning an
evaluation clock, because the generator's `now` defaults to wall-clock time and two features read the
calendar. See the Day 5 entry "The same report, run twice, two minutes apart, printed different
numbers."

Then check that seeds actually do something, which is a different property and was broken for four
days:

    node src/eval/cli/model-report.js --seed=day6

Different numbers, in every column. If they were identical, the seed would be decorative — see the
Day 5 entry "Four days of 'different seeds' were all the same seed."

Note the `=`. `--seed day6` with a space is currently ignored and silently falls back to `day5`,
which is the same silent-fallback pattern as the bug above and is logged as a gap.

---

## 5. The model comparison

    npm run model-report

About 15 seconds. Five arms scored on three splits. What to look at, in order:

**The floor.** Each split prints `floor`, the exact expected Brier of a perfectly-informed predictor,
`mean(p(1-p))`. It is a closed form, not an estimate, and it is why "Brier 0.085" is reported as
"30.5% of the learnable gap captured" instead. Without it the raw number is unreadable.

**The lookup table.** A `(cause, action)` GROUP BY with no model in it. It is the baseline most ML
write-ups omit, and omitting it is how a project takes credit for a lookup table. It captures 94% of
recoverable value on TEST. Any claim the ML layer makes has to be measured against this, not against
zero.

**The oracle.** An arm that reads the latent truth. It cannot be shipped; it exists to bound the
problem. It captures 82.2% of the learnable Brier gap and still only picks the best action 67.0% of
the time, which says how much of the remaining error is irreducible rather than unmodelled.

**The two columns that disagree.** On TEST, `gbm` has the better Brier and AUC while `logistic` leaves
₹1,50,102 less money on the table. On VALID the same split is starker: `gbm` has the *best* Brier of
any honest arm and the *worst* regret. Brier and AUC are pooled over all rows; an action is chosen by
ranking candidates within a single case. A pooled metric cannot see within-case ordering, and only
within-case ordering spends money.

**The coefficient table.** Fifteen lines of log-odds with support counts. This is the audit surface —
each line is a falsifiable claim about the world that a reviewer can disagree with without reading
code. It is also the reason a linear model is in the running at all.

**The findings section.** Generated from the numbers, including the verdicts. To check that, change a
number and confirm the prose changes with it — see the Day 5 entry "The report generated its own
numbers and hard-coded its own conclusions" for the version where it did not.

---

## 6. Diagnosis accuracy

    npm run diagnose-report

Per-tier hit rates against latent truth, on TRAIN and held-out TEST. The row worth reading is
`TEXT`, at 0.0% on both splits — free-text matching is wrong every single time it fires. It was kept
rather than deleted, and now sets `requiresApprovalForMoneyMovement`. Also read the abstention rate:
a rule table that never says "I don't know" looks identical to one that is always right.

---

## 7. The simulator's assumptions, stated

    npm run describe-sim
    npm run verify-sim

`describe-sim` prints every hand-set parameter in the response model. These are assumptions, not
measurements, and the honest version of this project prints them rather than burying them.
`verify-sim` checks the generator's distributions against those declared parameters.

---

## 8. What is proven versus what is measured

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

## 9. Git history

    git log --oneline
    git show --stat HEAD

Each day is one commit whose message states what was measured and what broke. The commit messages and
`ENGINEERING_LOG.md` are the same story at two levels of detail.
