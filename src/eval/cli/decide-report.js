#!/usr/bin/env node
/**
 * npm run decide-report
 *
 * Runs the whole Day 6 pipeline over a batch and prints what it decided, in rupees.
 *
 *   generate -> observe -> diagnose -> fit the recovery model on TRAIN -> decide every case
 *
 * Runs with no Mongo, no network, no API key and no installed packages, so anyone who clones this
 * repo can regenerate every number below in one command.
 *
 * WHAT THIS COMMAND DOES AND DOES NOT CLAIM
 * -----------------------------------------
 * It shows the AGENT'S EXPECTED recovery, which is the sum of its own estimates for the actions it
 * chose. That is a statement about the policy's arithmetic, not about money. Nothing here has been
 * executed against a gateway and no outcome has been drawn, so a large number in the "expected
 * recovery" column is a claim the agent is making, not a result it has achieved.
 *
 * Measured recovery — the agent's decisions run against the simulated response model, drawn
 * outcomes, compared against baselines on a held-out split — is Day 8's `npm run eval`. Reporting
 * the two under the same heading is the single easiest way to make this project dishonest, so they
 * live in different commands with different words on them.
 *
 * WHAT TO READ FIRST
 * ------------------
 * The outcome mix, and specifically whether the rupees line up with the counts. A run that stops 60%
 * of cases looks aggressive until you notice the stopped cases carry 4% of the money, at which point
 * it is just triage. Counts and rupees disagreeing is the normal state of affairs and the reason
 * every bucket is printed both ways.
 *
 * Then the stop reasons. BUDGET_EXHAUSTED and TOO_OLD reading zero would have been a bug rather than
 * a finding until very recently — see the Day 6 engineering log entry.
 *
 * WHY THIS LIVES UNDER src/eval/ AND NOT NEXT TO THE ENGINE IT DRIVES
 * -------------------------------------------------------------------
 * It was written as `src/agent/cli/decide-report.js` and `test/boundary.test.js` immediately failed
 * it: `src/agent/**` must not import from `src/sim/**`, and this command necessarily does, because
 * generating a batch and fitting a model on drawn outcomes is how it gets something to decide.
 *
 * The right response was to move the file, not to widen the rule. A harness that manufactures cases
 * from a simulator is eval-side by definition; the agent is the part that must be unable to see
 * where its inputs came from. Had the exemption been granted instead — "it is only a CLI" — then
 * `src/agent/**` would import from `src/sim/**` for one honest reason, and the next import would
 * have a precedent to point at. The boundary is worth more than the convenience of the file's
 * location, and the test caught it in about four seconds.
 *
 * Flags (all in --name=value form; the spaced form is a hard error, see cli/flags.js):
 *   --seed=day6      seed for generation and the outcome draws behind the fitted model
 *   --count=200      events in the decided batch
 *   --split=TRAIN    which generator split to decide on (TRAIN or TEST)
 *   --now=...        ISO decision instant. Defaults to a fixed one, NOT the wall clock — see below.
 *   --explain=1      print the full audit trail and explanation for N cases
 *   --json           machine-readable, for the dashboard and for diffing runs
 *   --quiet          suppress progress lines
 */

import { generateBatch } from '../../sim/generator.js';
import { buildDataset } from '../dataset.js';
import { splitByEvent } from '../modelComparison.js';
import { observe } from '../../agent/observe.js';
import { diagnose } from '../../agent/diagnose.js';
import { fitLookupTable, fitPlatt } from '../../ml/calibration.js';
import { createRecoveryScorer } from '../../agent/recoveryModel.js';
import { decideBatch, explainDecision } from '../../agent/decide.js';
import { MONEY_MOVING, CUSTOMER_CONTACTING } from '../../core/actions.js';
import { GUARDRAILS, POLICY } from '../../core/config.js';
import { readFlags, asNumber } from './flags.js';

/**
 * A FIXED DEFAULT DECISION INSTANT, because `new Date()` would make this report irreproducible in a
 * way that is invisible in its own output. Quiet hours, the case-age budget and the retry gap are
 * all clock-dependent: the same command run at 22:00 IST and at 15:00 IST produces different
 * outcome mixes for correct reasons, and a reader diffing two runs would be diffing the time of day.
 *
 * 15:00 IST is chosen deliberately over anything nearer a boundary. Use `--now=` to move it; the
 * quiet-hours behaviour is worth seeing and `--now=2026-08-24T17:30:00Z` (23:00 IST) shows it.
 */
const DEFAULT_NOW = '2026-08-24T09:30:00Z';

const f = readFlags(
  process.argv.slice(2),
  { seed: 'day6', count: '200', split: 'TRAIN', now: DEFAULT_NOW, explain: '1' },
  ['json', 'quiet'],
  (raw) => {
    const split = String(raw.split).toUpperCase();
    if (split !== 'TRAIN' && split !== 'TEST') {
      throw new Error(`--split=${raw.split} must be TRAIN or TEST`);
    }
    if (Number.isNaN(new Date(raw.now).getTime())) {
      throw new Error(`--now=${raw.now} is not a parsable date. Use an ISO instant, e.g. ${DEFAULT_NOW}`);
    }
    return {
      ...raw,
      split,
      count: asNumber(raw.count, 'count', { min: 1 }),
      explain: asNumber(raw.explain, 'explain', { min: 0 }),
    };
  }
);

const asJson = f.json;
const quiet = f.quiet || asJson;
const say = (msg) => { if (!quiet) process.stderr.write(`  ... ${msg}\n`); };
const now = new Date(f.now);
const config = { GUARDRAILS, POLICY };

const RUPEE = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const PCT = (x) => `${(100 * x).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const started = Date.now();

/**
 * STEP 1 — FIT THE RECOVERY MODEL ON TRAIN, ALWAYS.
 *
 * Even when deciding the TEST split. Fitting on the split being decided would make every cell
 * well-supported, every estimate optimistic, and the support asymmetry — the thing the stopping
 * rules exist to respect — structurally impossible to observe. The interesting number in a
 * `--split=TEST` run is precisely how many cells the model has never seen.
 */
say('generating TRAIN and fitting the recovery model');
const train = generateBatch({ seed: f.seed, split: 'TRAIN', now });
const trainData = await buildDataset({
  events: train.events,
  latents: train.latents,
  seed: f.seed,
});

/**
 * Split on eventId so the calibrator sees rows the group means were not computed from. `fit` builds
 * the table, `cal` fits the calibrator. See the note on Platt below for what happens without this.
 */
const { fit, valid: cal } = splitByEvent(trainData.rows, { fraction: 0.8, seed: f.seed });

const lookup = fitLookupTable(fit, {
  key: (r) => `${r.diagnosedCause}|${r.actionKind}`,
  minCount: 10,
});

/**
 * PLATT SCALING FITTED ON HELD-OUT ROWS, AND THE REASON THAT IS NOT A DETAIL.
 *
 * The first version of this command fitted the calibrator on the same rows the group means came
 * from, and printed `Platt a=1.0000 b=0.0000` — the identity transform. That is not a bug in
 * `fitPlatt`; it is arithmetic. A GROUP BY predicts each cell's empirical mean, so in-sample it is
 * already perfectly calibrated by construction, the gradient is zero at a=1, b=0, and the optimiser
 * correctly refuses to move. A calibration step that provably cannot do anything, printing
 * plausible-looking parameters, is exactly the kind of decoration this project is supposed not to
 * have — and it would have shipped in a report labelled "+ Platt".
 *
 * So the fit is split on eventId, never on rows: all 33 rows for one event share a diagnosis, an
 * amount and a latent payer, and splitting at random would put near-duplicates on both sides and
 * hand the calibrator the same in-sample problem in a less obvious form.
 *
 * Day 5 measured a=0.9196, b=-0.3294 for `lookup` this way. Held-out parameters near a=1, b=0 are
 * a real finding (the table is genuinely well calibrated out of sample); parameters exactly 1 and 0
 * mean the split did not happen.
 */
const rawCal = cal.map((r) => lookup.predictRow(r));
const platt = fitPlatt(cal.map((r) => r.y), rawCal);
const plattIsIdentity = platt.a === 1 && platt.b === 0;
const scoreAction = createRecoveryScorer({ model: lookup, calibrator: platt, modelName: 'lookup+platt' });

/**
 * A DIAGNOSTIC SECOND TABLE, FITTED ONLY TO MEASURE SOMETHING THE FIRST ONE CANNOT SHOW.
 *
 * The shipped key is (diagnosed cause, action kind): about 11 causes by 6 kinds, so 66 cells over
 * ~16,000 rows. Every cell is dense, on both splits, which means `supportFor` returns SUPPORTED for
 * essentially every case and the support asymmetry — the distinction the stopping rules exist to
 * respect — never fires on this simulator. Running `--split=TEST` does not change that, and an
 * earlier version of this report told the reader it would.
 *
 * That is worth stating plainly rather than leaving as an absence: on this generator the support
 * machinery has no observational evidence at all, and its only evidence is `test/decide.test.js`.
 *
 * It is also measurable rather than merely arguable. Refit on a key at the granularity a real
 * merchant's data would have — cause, action, channel and the diagnosis tier that produced the cause
 * — and the same rows give a real fallback rate. That number is the honest estimate of how often the
 * mechanism would engage in production, and it is computed on rows held out of the fit, so it is not
 * an in-sample artefact.
 */
const sparse = fitLookupTable(fit, {
  key: (r) => `${r.diagnosedCause}|${r.actionKind}|${r.matchTier}|${r.touchesUsed}`,
  minCount: 10,
});
const shippedCoverage = lookup.coverageOf(cal);
const sparseCoverage = sparse.coverageOf(cal);

/**
 * STEP 2 — BUILD THE CASES TO DECIDE.
 *
 * `observe()` then `diagnose()`, exactly as the orchestrator will. Note what is NOT carried across:
 * `batch.latents` is loaded above only to fit the model on drawn outcomes, and is never joined onto
 * the cases handed to the decision engine. `test/boundary.test.js` enforces that `src/agent/**`
 * cannot reach latent truth at all; this loop is where a well-meaning `latent` argument would most
 * plausibly get added, so it is worth saying here as well as there.
 */
say(`generating ${f.split} and diagnosing ${f.count} cases`);
const target = f.split === 'TRAIN' ? train : generateBatch({ seed: f.seed, split: 'TEST', now });
const events = target.events.slice(0, f.count);

const cases = [];
for (const event of events) {
  const observed = observe(event);
  cases.push({ observed, diagnosis: await diagnose(observed), record: {} });
}

say(`deciding ${cases.length} cases at ${now.toISOString()}`);
const { decisions, summary } = decideBatch({ cases, scoreAction, now, config });

// =============================================================================================
// REPORTING
// =============================================================================================

const stopsByCode = new Map();
for (const d of decisions) {
  if (!d.stop) continue;
  const code = d.stop.code;
  const e = stopsByCode.get(code) ?? { count: 0, exposurePaise: 0, escalated: 0 };
  e.count += 1;
  e.exposurePaise += d.amountPaise ?? 0;
  if (d.outcome === 'ESCALATE_HUMAN') e.escalated += 1;
  stopsByCode.set(code, e);
}

/**
 * WHAT EACH DECISION RESTED ON, which is not the same as the support of the action it chose.
 *
 * An escalated case's chosen action is ESCALATE_HUMAN, whose support is NOT_APPLICABLE — it has no
 * recovery probability by construction. Reporting that would say "12 decisions rested on nothing"
 * when the truth is that 12 decisions rested on the evidence behind the recovery options they
 * declined. So this reads the best-ranked action that could actually have recovered money, which is
 * the same quantity the stopping rules gate on.
 *
 * Note `candidates[].support` is the STATE STRING, not the `{state, rows}` object the engine works
 * with internally — the audit record flattens it. Reading it as an object gave every case 'NONE'
 * in the first version of this report.
 */
const RECOVERING_KINDS = new Set([...MONEY_MOVING, ...CUSTOMER_CONTACTING]);
const supportMix = new Map();
for (const d of decisions) {
  const evidence = d.candidates.find((c) => c.priced && RECOVERING_KINDS.has(c.kind));
  const state = evidence?.support ?? 'NO PRICED RECOVERY OPTION';
  supportMix.set(state, (supportMix.get(state) ?? 0) + 1);
}

if (asJson) {
  console.log(JSON.stringify({
    seed: f.seed,
    split: f.split,
    now: now.toISOString(),
    model: { arm: 'lookup', groups: lookup.groups, supportedGroups: lookup.supportedGroups, fitRows: fit.length, calRows: cal.length, platt: { a: platt.a, b: platt.b, isIdentity: plattIsIdentity } },
    summary,
    stopReasons: Object.fromEntries(stopsByCode),
    supportMix: Object.fromEntries(supportMix),
    coverage: { shipped: shippedCoverage, sparseDiagnostic: sparseCoverage, sparseCells: sparse.groups },
    elapsedMs: Date.now() - started,
  }, null, 2));
} else {
  const L = [];
  L.push('');
  L.push('  REBOUND — BATCH DECISION REPORT');
  L.push('  ' + '='.repeat(74));
  L.push(`  seed ${f.seed}   split ${f.split}   cases ${summary.cases}   deciding at ${now.toISOString()}`);
  L.push(`  model: GROUP BY (diagnosed cause, action) + Platt, fitted on TRAIN`);
  L.push(`         ${lookup.groups} cells, ${lookup.supportedGroups} with enough support to use their own rate`);
  L.push(`         table fitted on ${fit.length} rows, calibrator on ${cal.length} held-out rows`);
  L.push(`         Platt a=${platt.a.toFixed(4)} b=${platt.b.toFixed(4)}` +
    (plattIsIdentity
      ? '   !! exactly the identity — the calibrator saw in-sample rows and could not move'
      : ''));
  L.push('');
  L.push(`  Total at risk in this batch: ${RUPEE(summary.totalExposurePaise)}`);
  L.push('');

  L.push('  WHAT IT DECIDED');
  L.push('  ' + '-'.repeat(74));
  L.push(`  ${pad('outcome', 18)}${lpad('cases', 7)}${lpad('share', 8)}${lpad('at risk', 14)}${lpad('share', 8)}${lpad('exp. recovery', 16)}`);
  for (const [outcome, b] of Object.entries(summary.byOutcome)) {
    if (!b.count) continue;
    L.push(
      `  ${pad(outcome, 18)}${lpad(b.count, 7)}${lpad(PCT(b.count / summary.cases), 8)}` +
      `${lpad(RUPEE(b.exposurePaise), 14)}${lpad(PCT(summary.totalExposurePaise ? b.exposurePaise / summary.totalExposurePaise : 0), 8)}` +
      `${lpad(RUPEE(b.expectedRecoveryPaise), 16)}`
    );
  }
  L.push('  ' + '-'.repeat(74));
  L.push(`  ${pad('total', 18)}${lpad(summary.cases, 7)}${lpad('', 8)}${lpad(RUPEE(summary.totalExposurePaise), 14)}${lpad('', 8)}${lpad(RUPEE(summary.totalExpectedRecoveryPaise), 16)}`);
  L.push('');
  L.push('  Read the two share columns against each other. They are supposed to disagree: the');
  L.push('  policy is allocating a budget by value, so stopping many small cases to fund a few');
  L.push('  large ones is the intended behaviour, not a symptom.');
  L.push('');
  L.push('  "exp. recovery" is the agent\'s OWN estimate for the actions it chose. It is arithmetic,');
  L.push('  not money. Measured recovery against baselines on a held-out split is `npm run eval`.');
  L.push('');

  if (stopsByCode.size) {
    L.push('  WHY IT STOPPED OR ESCALATED');
    L.push('  ' + '-'.repeat(74));
    L.push(`  ${pad('reason', 26)}${lpad('cases', 7)}${lpad('at risk', 14)}${lpad('to a human', 13)}`);
    const ordered = [...stopsByCode.entries()].sort((a, b) => b[1].exposurePaise - a[1].exposurePaise);
    for (const [code, e] of ordered) {
      L.push(`  ${pad(code, 26)}${lpad(e.count, 7)}${lpad(RUPEE(e.exposurePaise), 14)}${lpad(e.escalated, 13)}`);
    }
    L.push('');
    L.push('  The "to a human" column is the honesty column. A stop reason that never escalates is');
    L.push('  one the agent always feels entitled to act on alone, and NEGATIVE_EV appearing in both');
    L.push('  states is the support asymmetry doing its job: the same low probability closes a case');
    L.push('  when it rests on observations and escalates when it rests on a fallback.');
    L.push('');
  }

  L.push('  WHAT THE ESTIMATES RESTED ON');
  L.push('  ' + '-'.repeat(74));
  for (const [state, n] of [...supportMix.entries()].sort((a, b) => b[1] - a[1])) {
    L.push(`  ${pad(state, 26)}${lpad(n, 7)}${lpad(PCT(n / summary.cases), 8)}`);
  }
  L.push('');
  L.push('  A LIMITATION, STATED RATHER THAN OMITTED. These are almost all SUPPORTED on BOTH');
  L.push('  splits, so the support asymmetry never fires here and this table is close to');
  L.push('  vacuous. The shipped key is (cause, action): 11 causes by 6 kinds is 66 cells over');
  L.push(`  ~${(fit.length / 1000).toFixed(0)}k rows, and on this generator every cell is dense.`);
  L.push('');
  L.push(`  ${pad('key granularity', 34)}${lpad('cells', 8)}${lpad('unseen', 9)}${lpad('fallback', 10)}`);
  L.push(`  ${pad('(cause, action) — shipped', 34)}${lpad(lookup.groups, 8)}${lpad(PCT(shippedCoverage.unseenRate), 9)}${lpad(PCT(shippedCoverage.fallbackRate), 10)}`);
  L.push(`  ${pad('+ tier, touches — diagnostic', 34)}${lpad(sparse.groups, 8)}${lpad(PCT(sparseCoverage.unseenRate), 9)}${lpad(PCT(sparseCoverage.fallbackRate), 10)}`);
  L.push('');
  L.push('  Both rows are scored on the same held-out slice. The second is not the shipped model —');
  L.push('  it is an estimate of how often the mechanism would engage against data at the');
  L.push('  granularity a real merchant has, where rare causes meet rare instruments. On this');
  L.push('  simulator the support rules are carried by their unit tests, not by this batch.');
  L.push('');

  if (summary.approvalQueue.length) {
    L.push('  APPROVAL QUEUE — an action is chosen and waiting on a yes/no');
    L.push('  ' + '-'.repeat(74));
    for (const q of summary.approvalQueue.slice(0, 8)) {
      L.push(`  ${pad(q.eventId, 14)}${lpad(RUPEE(q.amountPaise), 12)}  ${pad(q.proposed ?? '-', 22)}${lpad(RUPEE(q.expectedValuePaise ?? 0), 12)}`);
      for (const r of q.reasons) L.push(`                 ${r}`);
    }
    if (summary.approvalQueue.length > 8) L.push(`  ... and ${summary.approvalQueue.length - 8} more`);
    L.push('');
    L.push(`  Exposure awaiting sign-off: ${RUPEE(summary.approvalQueueExposurePaise)}`);
    L.push('  Ordered by value, not arrival. An analyst with one hour should spend it on the top of');
    L.push('  this list, and arrival order is uncorrelated with which cases those are. Every row');
    L.push('  carries the action and its idempotency key, so approving is one decision, not a');
    L.push('  re-run: the key was minted before the queue was built and does not change on approval.');
    L.push('');
  }

  if (summary.escalationQueue.length) {
    L.push('  ESCALATION QUEUE — the agent declined to act and a person owns the case');
    L.push('  ' + '-'.repeat(74));
    for (const q of summary.escalationQueue.slice(0, 8)) {
      L.push(`  ${pad(q.eventId, 14)}${lpad(RUPEE(q.amountPaise), 12)}  ${q.stopCode}`);
      for (const r of q.reasons) L.push(`                 ${r}`);
    }
    if (summary.escalationQueue.length > 8) L.push(`  ... and ${summary.escalationQueue.length - 8} more`);
    L.push('');
    L.push(`  Exposure handed over: ${RUPEE(summary.escalationQueueExposurePaise)}`);
    L.push('  Kept separate from the approval queue on purpose. There is no proposed action here to');
    L.push('  approve — these cases need someone to decide what to do, which is a different job with');
    L.push('  a different SLA. An earlier version merged the two and produced a queue whose total');
    L.push('  contradicted its own outcome table.');
    L.push('');
    L.push(`  Total waiting on a person, either way: ${RUPEE(summary.humanQueueExposurePaise)}` +
      ` (${PCT(summary.humanQueueExposurePaise / summary.totalExposurePaise)} of the batch)`);
    L.push('');
  }

  if (summary.budgetBound) {
    L.push('  !! RUN BUDGET BOUND');
    L.push('  A per-run cap was hit, so these results depend on the order the cases were processed.');
    L.push('  Cases are decided in arrival order here, which is the worst policy that respects the');
    L.push('  cap: it spends the budget on whichever cases happen to be early. Day 7 sorts by');
    L.push('  expected value first. Until then this run cannot be quoted as if ordering did not');
    L.push('  matter — raise the cap or read it as a lower bound.');
    L.push('');
  }

  for (let i = 0; i < Math.min(f.explain, decisions.length); i += 1) {
    const d = decisions[i];
    L.push('  ' + '='.repeat(74));
    L.push(`  AUDIT TRAIL ${i + 1}/${Math.min(f.explain, decisions.length)} — case ${d.eventId}, outcome ${d.outcome}`);
    L.push('  ' + '='.repeat(74));
    for (const line of explainDecision(d)) L.push(`  ${line}`);
    L.push('');
    L.push(`  ${pad('rank', 6)}${pad('action', 34)}${lpad('EV', 12)}   verdict`);
    for (const c of d.candidates.slice(0, 8)) {
      L.push(
        `  ${pad(c.rank ?? '-', 6)}${pad(c.signature.slice(0, 33), 34)}` +
        `${lpad(c.priced ? RUPEE(c.evPaise) : '—', 12)}   ${c.verdict}${c.chosen ? '  <- chosen' : ''}`
      );
    }
    if (d.candidates.length > 8) L.push(`  ... ${d.candidates.length - 8} further candidates in the record`);
    L.push('');
    L.push(`  ${d.guardrailsEvaluated.length} guardrails evaluated for the chosen action; ${d.guardrailsEvaluated.filter((e) => e.applied).length} applied.`);
    L.push(`  Calibration: ${d.calibrationNote}`);
    L.push('');
  }

  L.push(`  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  L.push('');
  console.log(L.join('\n'));
}
