/**
 * WHAT DID THE LOGISTIC LEARN ABOUT *TIMING*?
 * ===========================================
 *
 * A single, narrow question that the main model report cannot answer: what weight does the logistic
 * arm put on the three columns that exist only to express retry timing — `salaryWindow`, `delayDays`
 * and `isScheduled`? `model-report` prints the fifteen largest coefficients by magnitude, and these
 * three are nowhere near the top fifteen, so the number that matters here is invisible there.
 *
 * WHY IT IS WORTH A DEDICATED COMMAND. Until Day 6 the simulator priced every scheduled retry at the
 * decision instant, so the true recovery probability did not vary with the scheduled slot at all.
 * These three columns therefore described a real property of the action and predicted nothing, and a
 * correctly-fitted model should have driven their weights to approximately zero. That is a
 * falsifiable prediction about a defect, and this command is how it gets checked rather than asserted.
 *
 * It is also the cheap half of a pre-registered test. The expensive half is `npm run select-arm`
 * (~90 s, twenty worlds); this runs one fit and answers the mechanism question on its own. If these
 * coefficients do NOT move after the timing fix, then no amount of sweeping will show the ML layer
 * gaining an edge from timing, and the sweep should not be run in search of one.
 *
 * Run: node src/eval/cli/probe-coefficients.js
 */
import { generateBatch } from '../../sim/generator.js';
import { buildDataset } from '../dataset.js';
import { fitLogistic } from '../../ml/logistic.js';
import { featureNames, buildFeatures } from '../../ml/features.js';
import { EVAL_NOW } from '../evalClock.js';

const TIMING_COLUMNS = ['salaryWindow', 'delayDays', 'isScheduled'];

const batch = generateBatch({ seed: 'day5', split: 'TRAIN', now: EVAL_NOW });
const { rows } = await buildDataset({
  events: batch.events,
  latents: batch.latents,
  seed: 'day5',
  contextsPerEvent: 3,
});

const names = featureNames();
const model = fitLogistic(rows, { l2: 1e-3, iterations: 500, learningRate: 0.5 });

console.log(`fit on ${rows.length} rows, ${names.length} columns, converged in ${model.iterationsRun} iterations`);
console.log(`gradient norm ${model.finalGradNorm.toExponential(2)}\n`);

console.log('TIMING COLUMNS — log-odds weight, and how many fit rows the column is non-zero in:');
let maxTimingWeight = 0;
for (const col of TIMING_COLUMNS) {
  const i = names.indexOf(col);
  if (i < 0) {
    console.log(`  ${col.padEnd(14)} NOT PRESENT IN THE FEATURE VECTOR`);
    continue;
  }
  const w = model.weights[i];
  const support = rows.reduce((n, r) => n + (r.x[i] !== 0 ? 1 : 0), 0);
  maxTimingWeight = Math.max(maxTimingWeight, Math.abs(w));
  console.log(`  ${col.padEnd(14)} ${w >= 0 ? ' ' : ''}${w.toFixed(4)}   support ${support}`);
}

// A weight is only meaningful next to the scale of the other weights. Reporting 0.42 as "large"
// when the largest column in the model is 1.14 says something different from reporting it when the
// largest is 12.
const magnitudes = model.weights.map(Math.abs).sort((a, b) => b - a);
const median = magnitudes[Math.floor(magnitudes.length / 2)];
console.log(`\nfor scale: largest weight in the model ${magnitudes[0].toFixed(4)}, median ${median.toFixed(4)}`);
console.log(`largest timing weight is ${(maxTimingWeight / magnitudes[0] * 100).toFixed(1)}% of the largest weight`);

/**
 * THE TRAIN/SERVE SKEW, SIZED — added Day 7, and CLOSED by #51 on Day 8.
 * ======================================================================
 *
 * WHAT THE DEFECT WAS. `dataset.js` built every vector with `context.now` at the DECISION instant.
 * `decide.js` scored each candidate at `guard.effectiveAt`, the instant the action LANDS. Both were
 * handed one clock and needed two, so each sacrificed a different column: training got `delayDays`
 * right and `ageDays` wrong, serving got `ageDays` right and `delayDays` structurally pinned at zero
 * (`scheduledFor - now` where `now == scheduledFor`).
 *
 * WHY THE ARBITER WAS NEITHER OF THEM. Day 7 wrote this up as two coherent designs needing a choice.
 * That was wrong: `responseModel.js` draws the label against LANDING-time age, so the label had
 * already picked a side and the training-side `ageDays` was simply measuring a different quantity
 * than the thing it was being fitted against. #51 gives `buildFeatures` both instants and derives the
 * landing one from the same `effectiveAt` the guardrails use, so the two sides cannot drift again.
 *
 * WHAT THIS BLOCK NOW PRINTS, AND WHY IT IS NOT A LABEL. The notes below used to be hardcoded
 * strings, which meant they went on asserting a defect for as long as nobody edited them — a probe
 * that lies once it succeeds is worse than no probe. Each column's status is now COMPUTED: the same
 * scheduled action is featurised the way the serving path calls it, and the column value is compared
 * against what the old landing-instant convention produced. `salaryWindow` stays as the control; it
 * read `action.scheduledFor` directly and so was never skewed in either direction.
 *
 * The swing — weight times the range the column spans in training — is the log-odds the model learned
 * to spend. It is the number that says whether closing the seam could have mattered at all.
 */
const DAY_MS = 86_400_000;
const decisionAt = new Date(EVAL_NOW);
const scheduledFor = new Date(decisionAt.getTime() + 2 * DAY_MS).toISOString();
const probeArgs = {
  diagnosis: { rootCause: 'INSUFFICIENT_FUNDS', matchTier: 'CODE', physics: { timingSensitive: true } },
  observed: {
    lossType: 'FAILED_PAYMENT',
    rail: 'UPI',
    amountPaise: 100_000,
    occurredAt: new Date(decisionAt.getTime() - 3 * DAY_MS).toISOString(),
  },
  action: { kind: 'RETRY_SCHEDULED', scheduledFor },
};
// How the serving path calls it now (#51): the DECISION instant, with the landing instant derived.
const nowVec = buildFeatures({ ...probeArgs, context: { now: decisionAt } });
// How the serving path called it before (#51): the LANDING instant handed in as `now`.
const oldVec = buildFeatures({ ...probeArgs, context: { now: new Date(scheduledFor) } });
const columnStatus = (col) => {
  const i = names.indexOf(col);
  if (i < 0) return 'NOT PRESENT';
  const before = oldVec.values[i];
  const after = nowVec.values[i];
  if (before === after) return `consistent across both conventions (${after.toFixed(3)})`;
  return `was ${before.toFixed(3)} under the old convention, now ${after.toFixed(3)}`;
};
const SKEWED = {
  delayDays: columnStatus('delayDays'),
  ageDays: columnStatus('ageDays'),
  ageDecayProxy: columnStatus('ageDecayProxy'),
  salaryWindow: `${columnStatus('salaryWindow')} — the control`,
};
console.log('\nTRAIN/SERVE SKEW (closed by #51) — swing each column learned, and its value on both conventions:');
for (const [col, note] of Object.entries(SKEWED)) {
  const i = names.indexOf(col);
  if (i < 0) {
    console.log(`  ${col.padEnd(14)} NOT PRESENT IN THE FEATURE VECTOR`);
    continue;
  }
  const vals = rows.map((r) => r.x[i]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const w = model.weights[i];
  const swing = w * (hi - lo);
  console.log(
    `  ${col.padEnd(14)} w=${(w >= 0 ? ' ' : '') + w.toFixed(4)}  ` +
      `train range [${lo.toFixed(3)}, ${hi.toFixed(3)}]  ` +
      `swing ${(swing >= 0 ? ' ' : '') + swing.toFixed(4)}   ${note}`
  );
}
console.log(
  '\nWHAT #51 ACTUALLY BOUGHT, measured rather than inferred from these coefficients.\n' +
    '`delayDays` was the column the defect was named after, and it turns out to be worthless: a swing\n' +
    'of about -0.01 log-odds across its whole training range cannot move an argmax. The load-bearing\n' +
    'half of the fix was `ageDays`, which swings about -1.18 and whose TRAINING clock was the one that\n' +
    'disagreed with the label. So the fix was real and the headline framing of it was wrong.\n' +
    'A/B on a fixed g130 generator, TRAIN seeds 1-3 at count 80, incremental recovery: seed 1 and\n' +
    'seed 2 identical to the paise, seed 3 fell from Rs 1,74,521 to Rs 50,799. Closing the seam COST\n' +
    'Rs 1,23,722 across three worlds, because a correctly-aligned age decay scores stale cases lower,\n' +
    'they drop under the Rs 2 EV bar sooner, and the agent stops earlier. That is task #52, not an\n' +
    'argument for reopening the seam: a feature fitted against a different quantity than its own label\n' +
    'is a defect whether or not it happens to pay.'
);

