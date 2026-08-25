/**
 * WHERE THE FITTED MODEL IS WRONG, CELL BY CELL — evidence for #52 and #63 together.
 *
 * These were logged as two tasks and they are one defect seen from two ends.
 *
 *   #52 says the agent retries instruments that cannot be retried. `probe-hopeless.mjs` confirmed the
 *       population is real and that the DIAGNOSIS is not at fault: 105 of 105 such retries were on
 *       causes that are truly retry-hopeless in the latent truth.
 *   #63 says the fitted model under-predicts and mis-ranks within a case.
 *
 * If the model prices a retry on a hopeless cause at 0.20 while the data says 0.02, then #63's
 * mis-ranking IS #52's mechanism, and there is one thing to fix rather than two.
 *
 * WHAT THIS PRINTS. For every (diagnosed cause x action kind) cell: how many training rows landed in
 * it, the EMPIRICAL recovery rate in those rows, and the mean prediction the logistic makes on the
 * same rows. Empirical rate is the thing to trust — it is a count of Bernoulli outcomes drawn by the
 * simulator, not anybody's model.
 *
 * The comparison is deliberately WITHIN cell rather than pooled. A model can be perfectly calibrated
 * in aggregate and still rank every case backwards, and it is the ranking that picks the action.
 *
 * PRE-REGISTERED PREDICTION: retry cells on retry-hopeless causes will show an empirical rate near
 * zero and a logistic prediction far above it, and that gap will be the largest over-prediction in the
 * table. If instead the empirical rate really is ~0.2, then the simulator lets hopeless retries recover
 * and the word "hopeless" is mine rather than the model's — in which case #52 dissolves and the note
 * to fix is in the taxonomy.
 *
 * Run: node probe-mispricing.mjs
 */
import { generateBatch } from './src/sim/generator.js';
import { buildDataset } from './src/eval/dataset.js';
import { fitLogistic } from './src/ml/logistic.js';
import { fitPlatt } from './src/ml/calibration.js';
import { splitByEvent } from './src/eval/modelComparison.js';
import { ROOT_CAUSES } from './src/core/taxonomy.js';
import { EVAL_NOW } from './src/eval/evalClock.js';

const startAt = new Date(EVAL_NOW);
const cells = new Map();

for (const seed of ['1', '2', '3']) {
  const batch = generateBatch({ seed, split: 'TRAIN', now: startAt });
  const { rows } = await buildDataset({ events: batch.events, latents: batch.latents, seed });
  const { fit, valid } = splitByEvent(rows, { fraction: 0.8, seed });
  const logistic = fitLogistic(fit, { l2: 1e-4, iterations: 500, learningRate: 0.5 });
  const platt = fitPlatt(valid.map((r) => r.y), valid.map((r) => logistic.predict(r.x)));

  for (const r of rows) {
    const key = `${r.diagnosedCause}|${r.actionKind}`;
    const c = cells.get(key) ?? { n: 0, y: 0, pRaw: 0, pCal: 0 };
    const raw = logistic.predict(r.x);
    c.n += 1;
    c.y += r.y;
    c.pRaw += raw;
    c.pCal += platt.predict ? platt.predict(raw) : raw;
    cells.set(key, c);
  }
}

const isRetryKind = (k) => k === 'RETRY_NOW' || k === 'RETRY_SCHEDULED';
// The flag lives directly on the cause record; `.physics` is the shape `diagnose()` emits, not the
// shape the taxonomy stores. Reading only `.physics` here silently classified every cause as
// not-hopeless and printed an empty table, which is why the accessor checks both.
const hopeless = (cause) => {
  const rec = ROOT_CAUSES[cause];
  const flag = rec?.physics?.retryCanSucceed ?? rec?.retryCanSucceed;
  if (flag === undefined) throw new Error(`no retryCanSucceed for cause ${cause}`);
  return flag === false;
};

const table = [...cells]
  .map(([key, c]) => {
    const [cause, kind] = key.split('|');
    return {
      cause, kind, n: c.n,
      emp: c.y / c.n,
      pred: c.pCal / c.n,
      gap: c.pCal / c.n - c.y / c.n,
      hopelessRetry: isRetryKind(kind) && hopeless(cause),
    };
  })
  .filter((r) => r.n >= 30);

console.log(`\n${table.length} cells with n >= 30, pooled over 3 TRAIN worlds.\n`);

const pooledEmp = table.reduce((a, r) => a + r.emp * r.n, 0) / table.reduce((a, r) => a + r.n, 0);
const pooledPred = table.reduce((a, r) => a + r.pred * r.n, 0) / table.reduce((a, r) => a + r.n, 0);
console.log(`POOLED: empirical ${(pooledEmp * 100).toFixed(2)}%  predicted ${(pooledPred * 100).toFixed(2)}%  ` +
  `ratio ${(pooledPred / pooledEmp).toFixed(2)}x`);
console.log('(a ratio near 1.00 pooled is exactly what makes the within-cell table below worth reading)\n');

console.log('THE RETRY CELLS ON RETRY-HOPELESS CAUSES — #52\'s population:');
console.log('  cause                       kind                  n   empirical   predicted     gap');
for (const r of table.filter((x) => x.hopelessRetry).sort((a, b) => b.gap - a.gap)) {
  console.log(
    `  ${r.cause.padEnd(26)} ${r.kind.padEnd(17)} ${String(r.n).padStart(4)}   ` +
      `${(r.emp * 100).toFixed(2).padStart(7)}%   ${(r.pred * 100).toFixed(2).padStart(7)}%  ${(r.gap * 100 >= 0 ? '+' : '') + (r.gap * 100).toFixed(2)}pp`
  );
}

console.log('\nWORST OVER-PREDICTIONS ANYWHERE IN THE TABLE (is #52\'s population the worst?):');
console.log('  cause                       kind                  n   empirical   predicted     gap');
for (const r of [...table].sort((a, b) => b.gap - a.gap).slice(0, 8)) {
  console.log(
    `  ${r.cause.padEnd(26)} ${r.kind.padEnd(17)} ${String(r.n).padStart(4)}   ` +
      `${(r.emp * 100).toFixed(2).padStart(7)}%   ${(r.pred * 100).toFixed(2).padStart(7)}%  ${(r.gap * 100 >= 0 ? '+' : '') + (r.gap * 100).toFixed(2)}pp` +
      `${r.hopelessRetry ? '   <-- hopeless retry' : ''}`
  );
}

console.log('\nWORST UNDER-PREDICTIONS (the other half of #63):');
console.log('  cause                       kind                  n   empirical   predicted     gap');
for (const r of [...table].sort((a, b) => a.gap - b.gap).slice(0, 6)) {
  console.log(
    `  ${r.cause.padEnd(26)} ${r.kind.padEnd(17)} ${String(r.n).padStart(4)}   ` +
      `${(r.emp * 100).toFixed(2).padStart(7)}%   ${(r.pred * 100).toFixed(2).padStart(7)}%  ${(r.gap * 100 >= 0 ? '+' : '') + (r.gap * 100).toFixed(2)}pp`
  );
}
