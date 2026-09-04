# If you just watched the video

The video is five minutes and makes about thirty factual claims. This file maps each one to the command
that reproduces it and the file that computes it, in the order you heard them. Nothing here is a new
claim — if a number below disagrees with the video, the number below is the one to trust, because it is
read off the code.

The one thing to carry into this repo from the video: **there are two separate claims here and they never
share a screen.** The ₹499 is real money moved through the real Razorpay API in test mode. The 1.87× is a
policy comparison run entirely against a simulator. Everything in the table below belongs to one or the
other, and the column says which.

| # | claim | which | reproduce it | computed in |
|---|---|---|---|---|
| 1 | A real payment failed and was recovered on a different rail — ₹499, declined on card, captured on netbanking | real | `npm run replay` (offline, stored receipts) or `npm run recover-live` (hits the API, needs your own test key) | [`docs/evidence/`](evidence/) |
| 2 | The failure reasons form a closed set of **12** root causes, in plain words | real | `npm run diagnose-report` | [`src/core/taxonomy.js`](../src/core/taxonomy.js) — `ROOT_CAUSE_IDS` |
| 3 | If no rule fits, it abstains rather than guessing | real | `npm run diagnose-report` — look for the `UNKNOWN` tier | `RULE_TABLE` (21 rows) in the same file |
| 4 | It enumerates **23** options and prices every one before choosing | real | `npm run decide-report` — prints *"Considered 23 actions: 15 priced, 8 not permitted at all"* | [`src/core/actions.js`](../src/core/actions.js) · asserted in `test/decide.test.js` |
| 5 | Retrying that card was worth **−₹2**, so it chose a different rail | real | `npm run replay` | [`src/agent/expectedValue.js`](../src/agent/expectedValue.js) |
| 6 | Two models, trained by hand, no ML libraries | sim | `npm run model-report` | [`src/ml/`](../src/ml/) · `dependencies: {}` in `package.json` |
| 7 | The GBM won the accuracy scores; the logistic won on money; neither clearly beat a lookup table | sim | `npm run model-report` — Brier, AUC **and** the regret column | [`src/ml/`](../src/ml/) |
| 8 | The shipped model was chosen by a tiebreak list written down before the run, not by picking the winner | sim | `npm run select-arm` | [`src/eval/`](../src/eval/) |
| 9 | Diagnosis is right **86.8%** of the time | sim | `npm run diagnose-report` | see §10 of [`VERIFY.md`](../VERIFY.md) |
| 10 | The agent is structurally unable to read the simulator's ground truth | sim | `npm run test` — a test fails if it ever does | [`docs/architecture.md`](architecture.md) §"The quarantine" |
| 11 | The horizon is **10 days**, walked as **21 cycles of 12 hours** | sim | `npm run console`, press *Run to horizon* | `HORIZON` in [`src/core/config.js`](../src/core/config.js) |
| 12 | A case stopped with budget left because every remaining option priced negative against an **₹8.51** bar | sim | `npm run console`, open the case, read *"The arithmetic behind it"* | [`src/agent/decide.js`](../src/agent/decide.js) |
| 13 | It had **3** retries and a message still available when it stopped | sim | same drawer, *"Attempts and receipts"* | `GUARDRAILS.maxRetriesPerCase = 3`, `maxTouchesPerCase = 5` |
| 14 | Above **₹25,000** nothing outbound executes without a named human signing | sim | `npm run console` — the queue at the top of the page | `GUARDRAILS.humanApprovalThresholdPaise = 2500000` |
| 15 | An approval is an envelope, not a password — it expires in **72 hours** and covers one action | sim | `npm run test` (`approver.test.js`) | `approvalValidForHours: 72` · [`docs/architecture.md`](architecture.md) §"Approval is an envelope" |
| 16 | Cases nobody signed for stayed frozen for the whole run: nothing spent, nothing recovered | sim | `npm run console`, *Run to horizon*, sign nothing — the page says so itself | [`web/app.js`](../web/app.js) |
| 17 | **1.87×** the fixed ladder's incremental money on **14% fewer** attempts (1,379 vs 1,610) | sim | `npm run eval` (~2 min) | [`src/eval/`](../src/eval/) · §12 of [`VERIFY.md`](../VERIFY.md) |
| 18 | It won **3 of the 5** worlds, not 5 — and it **loses** to the unconstrained arm | sim | `npm run eval` — read the sign count, not just the pooled ratio | §12 of [`VERIFY.md`](../VERIFY.md) |
| 19 | The arm that beat us sent **2,836** messages inside quiet hours and hit one customer **45** times against a cap of **2** | sim | `npm run eval` — the guardrail columns | `GUARDRAILS.quietHours` (21:00–09:00 IST), `maxMessagesPerCustomerPer7Days: 2` |
| 20 | The ranking survives being wrong about the input assumptions — 26 perturbed worlds, one flip | sim | `npm run sweep-report` (instant, reads stored results) | §13 of [`VERIFY.md`](../VERIFY.md) |
| 21 | A Razorpay flag that 694 green tests all agreed about had never once worked, because the tests never called Razorpay | real | `npm run replay` — the `caveat` line | Day 11 in [`ENGINEERING_LOG.md`](../ENGINEERING_LOG.md) |
| 22 | The fix was to remove the request, and to teach the fake to refuse it too | real | `npm run test` (`gatewayContract.js`) | Day 11 in [`ENGINEERING_LOG.md`](../ENGINEERING_LOG.md) |

## The three things the video does not have time to say

**The measured figures are incremental, not gross.** Money that would have come back on its own is
subtracted, for every arm, using the same counterfactual. Gross overstates the headline by roughly 67% in
one seed, which is why the gross number is not the one quoted. §12 of [`VERIFY.md`](../VERIFY.md).

**There is one number in the sensitivity sweep we ask you not to quote,** and the reason is written down
next to it rather than left for you to find. §13 of [`VERIFY.md`](../VERIFY.md).

**Eleven defects in this project flattered the result before they were found.** A bug that improves your
headline will never be found by reading your headline, so the log records how each one was actually
caught — usually by rendering the page and reading it, or by running the thing for real.
[`ENGINEERING_LOG.md`](../ENGINEERING_LOG.md).

## If you have sixty seconds

```
npm run test      # 735 tests, 20 suites, no network, no database, no dependencies
npm run replay    # the real recovery, from stored receipts
```

Then open [`VERIFY.md`](../VERIFY.md) §12 and read the sign count.
