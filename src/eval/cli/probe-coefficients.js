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
import { featureNames } from '../../ml/features.js';
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
 * THE TRAIN/SERVE SKEW, SIZED — added Day 7.
 * =========================================
 *
 * `dataset.js` builds every feature vector with `context.now` set to the DECISION instant.
 * `decide.js` scores each candidate at `guard.effectiveAt`, the instant the action LANDS. For three
 * of the 140 columns those two clocks disagree, and `delayDays` is the worst case: it is computed as
 * `scheduledFor - now`, so at serving `now == scheduledFor` and the column is structurally pinned at
 * zero for every scheduled retry the shipped engine has ever scored.
 *
 * A weight alone does not say how much that costs. What matters is the weight times the range the
 * column actually spans in training — the log-odds swing the model learned to apply and then never
 * gets to apply in production. That product is what this block prints.
 *
 * `salaryWindow` is included as the control. It reads `action.scheduledFor` directly regardless of
 * `context.now`, so it is identical on both sides of the seam. Printing it here is what stops the
 * skew from being over-claimed: the column the model weighs most heavily is NOT one of the broken
 * ones, which is why the defect is worth measuring on Day 8 rather than panicking about tonight.
 */
const SKEWED = {
  delayDays: 'PINNED AT 0 at serving',
  ageDays: 'shifts forward at serving',
  ageDecayProxy: 'shifts forward at serving',
  salaryWindow: 'consistent — the control',
};
console.log('\nTRAIN/SERVE SKEW — the log-odds swing each column learned across its training range:');
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
  '\nThe `delayDays` swing is the number to read: it is log-odds the model learned to spend and the\n' +
    'shipped engine cannot spend, because the column it reads is always 0. Whether that costs any\n' +
    'recovered money is a Day 8 measurement (task #51), not something to infer from a coefficient —\n' +
    'the two age columns move in the same direction the delay would have, so it may be near-redundant.'
);

