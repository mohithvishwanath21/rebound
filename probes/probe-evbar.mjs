/**
 * IS A FLAT ₹2 BAR THE BAR ITS OWN DOCSTRING CLAIMS TO BE? — evidence for #52.
 *
 * `actionThresholdPaise` returns a constant 200 paise, and the reason given in
 * `src/agent/expectedValue.js` is that "the probability estimate has a standard error ... acting at
 * EV = +1 paise is not maximising expected value, it is fitting the noise in the estimate."
 *
 * That justification is about NOISE, and noise in an expected value is not constant. EV is
 * `p x amount x margin` minus costs, so its standard error is roughly
 *
 *     sigma(EV) = sigma(p) x amount x margin
 *
 * which scales with the amount at stake. A constant bar therefore demands a shrinking amount of
 * statistical headroom as the case gets larger — the exact opposite of what its stated purpose
 * requires. On a big enough case, a flat ₹2 is indistinguishable from a bar at zero.
 *
 * PRE-REGISTERED PREDICTION, written before running this:
 *   1. A large majority of CHOSEN actions will clear ₹2 while sitting BELOW one standard error of
 *      their own EV — i.e. the bar is not screening for noise on most of the batch.
 *   2. The failure will be concentrated in large amounts, because that is where sigma is biggest.
 *   3. `sigma(p)` from lookup support will be large wherever `rows` is small, so UNSUPPORTED cases
 *      should be the worst offenders — which would mean the support gate and the EV bar are trying
 *      to catch the same thing, and only one of them is sized correctly.
 *
 * Run: node probe-evbar.mjs
 */
import { fitRecoveryScorer, buildWorld, runIdFor } from './src/eval/harness.js';
import { decideForCase } from './src/agent/decide.js';
import { marginFor } from './src/agent/expectedValue.js';
import { EVAL_NOW } from './src/eval/evalClock.js';
import { GUARDRAILS, POLICY } from './src/core/config.js';
import { formatINR } from './src/core/money.js';

const startAt = new Date(EVAL_NOW);
const rows = [];

for (const seed of ['1', '2', '3']) {
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
  const world = await buildWorld({ seed, split: 'TRAIN', count: 80, startAt, train });

  for (const event of world.events) {
    const observed = world.observedById.get(event.eventId) ?? world.observedById[event.eventId];
    const diagnosis = world.diagnosisById.get(event.eventId) ?? world.diagnosisById[event.eventId];
    if (!observed || !diagnosis) continue;
    const rec = decideForCase({
      observed,
      diagnosis,
      record: {},
      scoreAction,
      now: startAt,
      config: { GUARDRAILS, POLICY },
    });
    if (!rec.chosen || !Number.isFinite(rec.chosen.evPaise)) continue;

    // Re-score the chosen action to recover p and the lookup support behind it.
    const belief = scoreAction({
      diagnosis,
      observed,
      action: rec.chosen.action ?? rec.chosen,
      context: { now: startAt, touchesUsed: 0 },
    });
    const p = belief?.p;
    const nRows = belief?.support?.rows ?? 0;
    if (!Number.isFinite(p)) continue;

    const margin = marginFor(observed.lossType);
    // Binomial standard error of the probability, from the number of comparable rows the model saw.
    // rows = 0 means the cell was never observed; sigma(p) is then undefined rather than zero, and
    // 0.5 (the maximum possible) is the honest stand-in for "we have no idea".
    const sigmaP = nRows > 0 ? Math.sqrt(Math.max(p * (1 - p), 1e-9) / nRows) : 0.5;
    const sigmaEv = sigmaP * observed.amountPaise * margin;

    rows.push({
      seed,
      amountPaise: observed.amountPaise,
      evPaise: rec.chosen.evPaise,
      p,
      nRows,
      sigmaEv,
      ratio: sigmaEv > 0 ? rec.chosen.evPaise / sigmaEv : Infinity,
      supported: nRows > 0,
      retryCanSucceed: diagnosis?.physics?.retryCanSucceed ?? null,
      signature: rec.chosen.signature,
    });
  }
}

const n = rows.length;
const below1 = rows.filter((r) => r.ratio < 1);
const below2 = rows.filter((r) => r.ratio < 2);
console.log(`\nCHOSEN actions examined: ${n} across 3 TRAIN worlds, all at cycle 0.\n`);
console.log(`every one of them cleared the flat bar of ${POLICY.minEvToActPaise} paise, by construction.`);
console.log(`of those, BELOW one standard error of their own EV: ${below1.length} (${(below1.length / n * 100).toFixed(1)}%)`);
console.log(`                        below two standard errors: ${below2.length} (${(below2.length / n * 100).toFixed(1)}%)`);

// Does the failure concentrate in large amounts, as predicted?
const sorted = [...rows].sort((a, b) => a.amountPaise - b.amountPaise);
const q = (i) => sorted[Math.min(sorted.length - 1, Math.floor(i * sorted.length))];
console.log('\nBY AMOUNT QUARTILE — is the bar weaker where the stake is bigger?');
console.log('  quartile   amount range               n   share below 1 sigma   median EV/sigma');
for (let k = 0; k < 4; k += 1) {
  const lo = Math.floor((k * sorted.length) / 4);
  const hi = Math.floor(((k + 1) * sorted.length) / 4);
  const bucket = sorted.slice(lo, hi);
  if (!bucket.length) continue;
  const share = bucket.filter((r) => r.ratio < 1).length / bucket.length;
  const ratios = bucket.map((r) => r.ratio).sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  console.log(
    `  Q${k + 1}         ${formatINR(bucket[0].amountPaise).padEnd(10)} - ${formatINR(bucket[bucket.length - 1].amountPaise).padEnd(11)} ` +
      `${String(bucket.length).padStart(3)}   ${(share * 100).toFixed(1).padStart(6)}%              ${Number.isFinite(med) ? med.toFixed(2) : 'inf'}`
  );
}

// Is the support gate already catching the same population?
const unsup = rows.filter((r) => !r.supported);
const sup = rows.filter((r) => r.supported);
console.log('\nBY SUPPORT — are the EV bar and the support gate aimed at the same thing?');
console.log(`  lookup cell never seen (rows=0): ${unsup.length} chosen actions, ${unsup.filter((r) => r.ratio < 1).length} below 1 sigma`);
console.log(`  lookup cell seen (rows>0):       ${sup.length} chosen actions, ${sup.filter((r) => r.ratio < 1).length} below 1 sigma`);
if (sup.length) {
  const meanRows = sup.reduce((a, r) => a + r.nRows, 0) / sup.length;
  console.log(`  mean supporting rows behind a supported choice: ${meanRows.toFixed(0)}`);
}

// What probability headroom does a flat ₹2 actually demand, as a function of amount?
console.log('\nWHAT A FLAT ₹2 DEMANDS, as the amount grows (margin 1.0, costs ignored):');
for (const rupees of [200, 2_000, 20_000, 200_000, 500_000]) {
  const paise = rupees * 100;
  console.log(`  ${formatINR(paise).padEnd(12)} needs p >= ${(POLICY.minEvToActPaise / paise * 100).toFixed(4)}% for gross EV to clear the bar`);
}
console.log(
  '\nThat spread is the defect in one line: the same bar asks for 1% confidence on a small case and\n' +
    'four ten-thousandths of a percent on a large one, while the noise it claims to be screening for\n' +
    'grows with the amount. It is strictest exactly where it matters least.'
);

/**
 * THE LITERAL CLAIM IN TASK #52, TESTED DIRECTLY.
 *
 * The task is titled "the agent retries hopeless instruments because the EV bar is only ₹2". That is
 * a checkable sentence, not a vibe: a hopeless instrument is one whose DIAGNOSED physics say a retry
 * cannot succeed (`physics.retryCanSucceed === false`), and a retry on it is a RETRY_NOW or
 * RETRY_SCHEDULED. If the count is zero, the task was written on a suspicion the code does not have,
 * and it should be closed as measured rather than "fixed" by moving a number until the suspicion
 * stops being visible.
 */
const RETRIES = new Set(['RETRY_NOW', 'RETRY_SCHEDULED']);
const isRetry = (sig) => RETRIES.has(String(sig).split(':')[0]);
const hopeless = rows.filter((r) => r.retryCanSucceed === false);
const hopelessRetries = hopeless.filter((r) => isRetry(r.signature));
console.log('\nTHE LITERAL CLAIM — retries chosen on instruments the diagnosis says cannot be retried:');
console.log(`  chosen actions on cases diagnosed retry-hopeless: ${hopeless.length}`);
console.log(`  of those, the chosen action IS a retry:            ${hopelessRetries.length}`);
if (hopelessRetries.length) {
  for (const r of hopelessRetries.slice(0, 8)) {
    console.log(`    ${r.signature.padEnd(34)} ${formatINR(r.amountPaise).padStart(12)}  EV ${formatINR(r.evPaise).padStart(11)}  p=${r.p.toFixed(4)}  rows=${r.nRows}  EV/sigma=${r.ratio.toFixed(2)}`);
  }
}

console.log('\nWHAT THE 19 SUB-1-SIGMA CHOICES ACTUALLY ARE — is something already catching them?');
const counts = new Map();
for (const r of below1) {
  const kind = String(r.signature).split(':')[0];
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
}
for (const [kind, c] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${kind.padEnd(20)} ${c}`);
}
