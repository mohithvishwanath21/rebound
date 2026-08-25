# Probes — one-off measurements, kept as evidence

Each file here answered one question that decided one task, and each is named in `ENGINEERING_LOG.md`
where its result is quoted. They are NOT part of `npm test` and they are NOT held to the boundary rule in
`test/boundary.test.js`: probes at the repo root may read the simulator's latents, because a probe's whole
job is to compare what the agent believed against what was true. The agent itself may never do that.

They are kept rather than deleted for one reason: **several of them falsified a pre-registered prediction
of mine, and the record of a failed prediction is worth more than the code.**

| probe | question it settled | outcome |
|---|---|---|
| `probe-mispricing.mjs` | does predicted probability match empirical recovery, per cell? | found **#68** — retries priced at 18% on invoices that were never charged, and **retracted** #63's "model under-predicts 6x" (it is 1.00x) |
| `probe-evbar.mjs` | how many chosen actions sit below one standard error of their own EV? | 12/12 unsupported vs 7/207 supported — became the σ bar in #52 |
| `probe-hopeless.mjs` | are retries on "hopeless" instruments actually hopeless? | **CIRCULAR — superseded.** Used the taxonomy's own `retryCanSucceed` as ground truth. See its header. |
| `probe-b3stall.mjs` | why does B3 act once and stop? | the ladder anchored "+24h" to `now`, so it never advanced |
| `probe-ladder.mjs` | does the fixed ladder progress over a full horizon? | confirmed the fix; became `test/baselines.test.js` trajectory tests |
| `probe-baseline.mjs` | what do the four baselines actually do per cycle? | shaped the arm implementations in #55 |
| `probe-metrics.mjs` | do the metric denominators mean the same thing across arms? | found `refused` is not cross-arm comparable |
| `probe-netincr.mjs` | is `net` on the same basis as `incremental`? | no — found the gross-net-beside-incremental defect |
| `probe-self.mjs` | when does self-recovery land relative to the horizon? | median 3-4 days, tail to 10.6 — drove the 21-cycle horizon in #62 |

**Reading order if you only read one:** `probe-mispricing.mjs`. It is the one that found the defect
eleven other measurements had missed, and its header explains why reading the headline metric could never
have found it.
