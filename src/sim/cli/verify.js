/**
 * `npm run verify-sim`
 *
 * Asserts the invariants the simulator must satisfy for any evaluation built on it to
 * mean anything, and prints a difficulty report on the generated world.
 *
 * This exists because the response model is the one component whose bugs would be
 * INVISIBLE in the final numbers. A broken diagnosis layer produces obviously wrong
 * decisions you notice immediately. A subtly broken response model produces a
 * plausible-looking metrics table that is quietly meaningless — and a plausible wrong
 * number is far more dangerous than a crash, because you will put it in a pitch.
 *
 * Runs with zero infrastructure: no Mongo, no network, no npm install.
 */

import { makeRng } from '../../core/rng.js';
import { formatINR, formatINRCompact } from '../../core/money.js';
import { ActionKind, Channel } from '../../core/actions.js';
import { Rail, LossType } from '../../core/enums.js';
import { PayerType } from '../payerTypes.js';
import { generateBatch } from '../generator.js';
import {
  materialiseAssumptions,
  recoveryProbability,
  perturbAssumptions,
} from '../responseModel.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
  console.log('-'.repeat(title.length));
}

const A = materialiseAssumptions();
const NOW = new Date('2026-08-22T10:00:00+05:30');

/** Minimal event/latent fixtures so invariants are tested in isolation. */
function fixture(overrides = {}) {
  return {
    event: {
      eventId: 'evt_test',
      lossType: LossType.FAILED_PAYMENT,
      amountPaise: 100000,
      occurredAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      rail: Rail.CARD,
      ...(overrides.event ?? {}),
    },
    latent: {
      payerType: PayerType.WILL_PAY_IF_REMINDED,
      responsiveness: 0.6,
      patienceBudget: 4,
      workingRails: [Rail.CARD, Rail.UPI],
      willSelfRecover: false,
      ...(overrides.latent ?? {}),
    },
  };
}

const p = (action, f, touchesUsed = 0, now = NOW) =>
  recoveryProbability({ action, latent: f.latent, event: f.event, now, touchesUsed, assumptions: A }).p;

/* =========================================================================
   1. STRUCTURAL ZEROS — the central claim of the whole project
   ========================================================================= */

section('1. Structural zeros: a dead instrument cannot be retried back to life');

{
  const f = fixture({ latent: { payerType: PayerType.NEEDS_NEW_INSTRUMENT, workingRails: [Rail.UPI] } });

  check(
    'RETRY_NOW against NEEDS_NEW_INSTRUMENT is exactly 0',
    p({ kind: ActionKind.RETRY_NOW }, f) === 0,
    `got ${p({ kind: ActionKind.RETRY_NOW }, f)}`
  );

  check(
    'RETRY_SCHEDULED against NEEDS_NEW_INSTRUMENT is exactly 0',
    p({ kind: ActionKind.RETRY_SCHEDULED, scheduledFor: NOW }, f) === 0
  );

  // Zero must be robust to every other favourable factor. If any multiplier could
  // lift it above zero, the "impossible" claim would be false and the argument that
  // diagnosis beats persistence would be merely rhetorical.
  const generous = fixture({
    latent: {
      payerType: PayerType.NEEDS_NEW_INSTRUMENT,
      responsiveness: 1.0,
      patienceBudget: 99,
      workingRails: [Rail.UPI, Rail.CARD, Rail.NETBANKING],
    },
    event: { occurredAt: NOW },
  });
  check(
    'zero survives maximally favourable conditions (fresh, responsive, patient)',
    p({ kind: ActionKind.RETRY_NOW }, generous) === 0
  );

  check(
    'but REQUEST_REAUTH against the same payer is meaningfully positive',
    p({ kind: ActionKind.REQUEST_REAUTH, channel: Channel.WHATSAPP }, f) > 0.15,
    `got ${p({ kind: ActionKind.REQUEST_REAUTH, channel: Channel.WHATSAPP }, f).toFixed(4)}`
  );
}

/* =========================================================================
   2. TIMING — the salary-window effect
   ========================================================================= */

section('2. Timing: when you retry beats how often');

{
  const fundsAt = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
  const f = fixture({
    latent: { payerType: PayerType.TEMPORARILY_SHORT, fundsAvailableFrom: fundsAt },
  });

  const before = p({ kind: ActionKind.RETRY_NOW }, f, 0, NOW);
  const after = p(
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: fundsAt },
    f, 0, new Date(fundsAt.getTime() + 60 * 60 * 1000)
  );

  check(
    'retry before funds arrive is heavily suppressed',
    before < 0.1,
    `got ${before.toFixed(4)}`
  );
  check(
    'retry just after funds arrive is far more likely',
    after > before * 4,
    `before=${before.toFixed(4)} after=${after.toFixed(4)} ratio=${(after / before).toFixed(1)}x`
  );

  // Three immediate attempts vs one well-timed one. This comparison is the entire
  // argument for scheduling, expressed as a number.
  const naiveThree = 1 - Math.pow(1 - before, 3);
  check(
    'ONE well-timed retry beats THREE immediate retries',
    after > naiveThree,
    `3x immediate=${naiveThree.toFixed(4)} vs 1x timed=${after.toFixed(4)}`
  );
}

/* =========================================================================
   3. DOWNTIME
   ========================================================================= */

section('3. Downtime: retrying into a live outage wastes an attempt');

{
  const start = new Date(NOW.getTime() - 30 * 60 * 1000);
  const end = new Date(NOW.getTime() + 90 * 60 * 1000);
  const f = fixture({ latent: { trueDowntimeWindow: { start, end } } });

  const during = p({ kind: ActionKind.RETRY_NOW }, f, 0, NOW);
  const afterEnd = p({ kind: ActionKind.RETRY_NOW }, f, 0, new Date(end.getTime() + 60 * 60 * 1000));

  check(
    'retry during downtime is suppressed by ~the downtime factor',
    during < afterEnd * 0.1,
    `during=${during.toFixed(5)} after=${afterEnd.toFixed(5)}`
  );
  check('retry after the window recovers to a normal rate', afterEnd > 0.2, `got ${afterEnd.toFixed(4)}`);
}

/* =========================================================================
   4. FATIGUE — the mechanism behind "fewer messages, more money"
   ========================================================================= */

section('4. Fatigue: probability is monotonically non-increasing in touches spent');

{
  const f = fixture({ latent: { patienceBudget: 4 } });
  const series = [0, 1, 2, 3, 4, 5].map((t) =>
    p({ kind: ActionKind.SEND_LINK, channel: Channel.SMS }, f, t)
  );

  let monotone = true;
  for (let i = 1; i < series.length; i++) {
    if (series[i] > series[i - 1] + 1e-12) monotone = false;
  }

  check('strictly non-increasing as touches accumulate', monotone, series.map((x) => x.toFixed(4)).join(' -> '));
  check(
    'exhausting the patience budget drives probability to zero',
    series[4] === 0 && series[5] === 0,
    `at budget=${series[4]}, beyond=${series[5]}`
  );
  check(
    'the drop is convex (4th touch hurts more than the 2nd)',
    series[0] - series[1] < series[2] - series[3],
    `d1=${(series[0] - series[1]).toFixed(4)} d3=${(series[2] - series[3]).toFixed(4)}`
  );
}

/* =========================================================================
   5. BACKFIRE
   ========================================================================= */

section('5. Backfire: chasing a dispute makes it worse; only a human helps');

{
  const f = fixture({ latent: { payerType: PayerType.DISPUTING, maxWillingToPayPaise: 60000 } });

  const msg0 = p({ kind: ActionKind.SEND_LINK, channel: Channel.SMS }, f, 0);
  const msg2 = p({ kind: ActionKind.SEND_LINK, channel: Channel.SMS }, f, 2);
  const human = p({ kind: ActionKind.ESCALATE_HUMAN }, f, 2);

  check('repeat messaging a disputing payer degrades faster than fatigue alone', msg2 < msg0 * 0.4,
    `msg@0=${msg0.toFixed(4)} msg@2=${msg2.toFixed(4)}`);
  check('escalating to a human dominates messaging for disputes', human > msg0 * 5,
    `human=${human.toFixed(4)} vs msg=${msg0.toFixed(4)}`);
}

/* =========================================================================
   6. BASIC SANITY
   ========================================================================= */

section('6. Sanity: probabilities are probabilities');

{
  const rng = makeRng(7);
  let allValid = true;
  let worst = null;

  for (let i = 0; i < 4000; i++) {
    const f = fixture({
      latent: {
        payerType: rng.pick(Object.values(PayerType)),
        responsiveness: rng.float(0, 1),
        patienceBudget: rng.int(1, 8),
        workingRails: rng.shuffle(Object.values(Rail)).slice(0, rng.int(0, 3)),
      },
      event: {
        occurredAt: new Date(NOW.getTime() - rng.float(0, 30) * 24 * 3600 * 1000),
        lossType: rng.pick(Object.values(LossType)),
      },
    });
    const action = {
      kind: rng.pick(Object.values(ActionKind)),
      channel: rng.pick(Object.values(Channel)),
      scheduledFor: NOW,
    };
    const val = p(action, f, rng.int(0, 9));
    if (!(val >= 0 && val <= 1) || Number.isNaN(val)) {
      allValid = false;
      worst = { action, val };
      break;
    }
  }

  check('4000 random draws all produce a value in [0,1]', allValid, worst ? JSON.stringify(worst) : '');

  check(
    'STOP_PERMANENT and NO_ACTION_YET collect nothing directly',
    p({ kind: ActionKind.STOP_PERMANENT }, fixture()) === 0 &&
      p({ kind: ActionKind.NO_ACTION_YET }, fixture()) === 0
  );
}

/* =========================================================================
   7. DETERMINISM — the reproducibility contract
   ========================================================================= */

section('7. Determinism: same seed, same world');

{
  const a = generateBatch({ seed: 42, split: 'TRAIN', now: NOW });
  const b = generateBatch({ seed: 42, split: 'TRAIN', now: NOW });
  const c = generateBatch({ seed: 43, split: 'TRAIN', now: NOW });

  check(
    'seed 42 twice produces byte-identical output',
    JSON.stringify(a.events) === JSON.stringify(b.events)
  );
  check(
    'seed 43 produces a different world',
    JSON.stringify(a.events) !== JSON.stringify(c.events)
  );
  check(
    'latent truth is equally reproducible',
    JSON.stringify(a.latents) === JSON.stringify(b.latents)
  );
}

/* =========================================================================
   8. THE WORLD IS ACTUALLY HARD
   ========================================================================= */

section('8. Difficulty: is the inference problem non-trivial?');

const batch = generateBatch({ seed: 42, split: 'TRAIN', now: NOW });

{
  // Ambiguity check: does the generic decline genuinely span multiple payer types?
  const dnhPayerTypes = new Set(
    batch.latents.filter((l) => l.trueRootCause === 'DO_NOT_HONOUR').map((l) => l.payerType)
  );
  check(
    'DO_NOT_HONOUR spans >=3 distinct payer types (no code-to-truth shortcut)',
    dnhPayerTypes.size >= 3,
    `spans: ${[...dnhPayerTypes].join(', ')}`
  );

  // Some failures must be unmatchable by the rule table, or the LLM tier is theatre.
  const vague = batch.events.filter((e) => e.failure?._generatedVague).length;
  const withFailure = batch.events.filter((e) => e.failure).length;
  check(
    'a non-trivial share of errors carry unmatched vague text',
    vague / withFailure > 0.05,
    `${vague}/${withFailure} = ${((vague / withFailure) * 100).toFixed(1)}%`
  );

  // Mandate status must be an imperfect signal, not an oracle.
  const revoked = batch.events.filter((e, i) => batch.latents[i].trueRootCause === 'MANDATE_REVOKED' && e.subscription);
  const mislabelled = revoked.filter((e) => e.subscription.mandateStatus === 'active').length;
  check(
    'some revoked mandates still report status=active (stale propagation)',
    revoked.length === 0 || mislabelled > 0,
    `${mislabelled}/${revoked.length} revoked mandates look active`
  );

  // Retry-proof share: how much of the book cannot be recovered by retrying at all.
  const retryProof = batch.latents.filter((l) => l.payerType === PayerType.NEEDS_NEW_INSTRUMENT).length;
  const hopeless = batch.latents.filter((l) => l.payerType === PayerType.NEVER_PAYING).length;
  check(
    'a substantial share is retry-proof, so retry-only policies must lose ground',
    retryProof / batch.latents.length > 0.1,
    `${retryProof}/${batch.latents.length} retry-proof, ${hopeless} never-paying`
  );

  check(
    'self-recovery is present but not dominant (B0 is a real but beatable baseline)',
    (() => {
      const s = batch.latents.filter((l) => l.willSelfRecover).length / batch.latents.length;
      return s > 0.05 && s < 0.45;
    })(),
    `${((batch.latents.filter((l) => l.willSelfRecover).length / batch.latents.length) * 100).toFixed(1)}% self-recover`
  );
}

/* =========================================================================
   9. PERTURBATION preserves structure
   ========================================================================= */

section('9. Sensitivity sweep preserves structural claims');

{
  const rng = makeRng(99);
  let zerosHeld = true;
  let orderingHeld = true;

  for (let i = 0; i < 200; i++) {
    const perturbed = perturbAssumptions(A, 0.3, rng);
    const fit = perturbed.actionFit[PayerType.NEEDS_NEW_INSTRUMENT];
    if (fit[ActionKind.RETRY_NOW] !== 0 || fit[ActionKind.RETRY_SCHEDULED] !== 0) zerosHeld = false;
    if (fit[ActionKind.REQUEST_REAUTH] <= fit[ActionKind.SEND_LINK]) orderingHeld = false;
  }

  check('structural zeros survive 200 perturbations', zerosHeld);
  check('within-row ordering (reauth > link for dead instruments) survives', orderingHeld);

  // Regression guard. A flat +/-30% jitter around 1.6 explores only 1.12-2.08 and so
  // never enters the regime where fatigue DECELERATES — the one regime in which the
  // aggressive baseline stops being punished. A sweep that cannot reach the case that
  // would embarrass us is not a sensitivity analysis, it is decoration.
  const sweepRng = makeRng(1234);
  const exps = [];
  for (let i = 0; i < 400; i++) exps.push(perturbAssumptions(A, 1.0, sweepRng).fatigueExponent);
  const below = exps.filter((e) => e < 1.0).length;
  const above = exps.filter((e) => e > 2.0).length;

  check(
    'full sweep reaches decelerating fatigue (exponent < 1.0)',
    below > 0,
    `${below}/400 draws below 1.0, range ${Math.min(...exps).toFixed(2)}-${Math.max(...exps).toFixed(2)}`
  );
  check('full sweep also reaches strongly accelerating fatigue (> 2.0)', above > 0, `${above}/400 draws`);
  check(
    'sampled exponents stay inside the declared range [0.6, 2.6]',
    Math.min(...exps) >= 0.6 - 1e-9 && Math.max(...exps) <= 2.6 + 1e-9,
    `observed ${Math.min(...exps).toFixed(3)}-${Math.max(...exps).toFixed(3)}`
  );

  // And the direction of the mechanism must actually flip when the exponent does,
  // otherwise the parameter is not doing what its name says.
  const decel = materialiseAssumptions({ fatigueExponent: 0.6 });
  const f = fixture({ latent: { patienceBudget: 4 } });
  const dp = (t, asm) =>
    recoveryProbability({
      action: { kind: ActionKind.SEND_LINK, channel: Channel.SMS },
      latent: f.latent, event: f.event, now: NOW, touchesUsed: t, assumptions: asm,
    }).p;

  const accelDrops = [dp(0, A) - dp(1, A), dp(2, A) - dp(3, A)];
  const decelDrops = [dp(0, decel) - dp(1, decel), dp(2, decel) - dp(3, decel)];

  check(
    'exponent > 1 accelerates damage, exponent < 1 decelerates it',
    accelDrops[1] > accelDrops[0] && decelDrops[1] < decelDrops[0],
    `accel: ${accelDrops.map((x) => x.toFixed(4)).join(' -> ')} | decel: ${decelDrops.map((x) => x.toFixed(4)).join(' -> ')}`
  );
}

/* =========================================================================
   REPORT
   ========================================================================= */

section('Generated world summary (seed 42, TRAIN)');

console.log(`  customers        ${batch.counts.customers}`);
console.log(`  events           ${batch.counts.events}`);
console.log(`  total at risk    ${formatINR(batch.counts.totalAtRiskPaise)} (${formatINRCompact(batch.counts.totalAtRiskPaise)})`);
console.log('\n  by loss type');
for (const [k, v] of Object.entries(batch.counts.byLossType).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${String(v).padStart(4)}  ${((v / batch.counts.events) * 100).toFixed(1)}%`);
}
console.log('\n  by TRUE root cause (hidden from the agent)');
for (const [k, v] of Object.entries(batch.counts.byTrueRootCause).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${String(v).padStart(4)}  ${((v / batch.counts.events) * 100).toFixed(1)}%`);
}
console.log('\n  by latent payer type (hidden from the agent)');
const byPayer = {};
for (const l of batch.latents) byPayer[l.payerType] = (byPayer[l.payerType] ?? 0) + 1;
for (const [k, v] of Object.entries(byPayer).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${k.padEnd(22)} ${String(v).padStart(4)}  ${((v / batch.counts.events) * 100).toFixed(1)}%`);
}

// Money-weighted difficulty. Counts alone understate the problem, because the
// unrecoverable cases are not uniformly distributed across amounts — and a policy is
// judged on rupees, not on rows.
const paiseBy = {};
batch.latents.forEach((l, i) => {
  paiseBy[l.payerType] = (paiseBy[l.payerType] ?? 0) + batch.events[i].amountPaise;
});
console.log('\n  at-risk value by payer type');
for (const [k, v] of Object.entries(paiseBy).sort((a, b) => b[1] - a[1])) {
  const pct = ((v / batch.counts.totalAtRiskPaise) * 100).toFixed(1);
  console.log(`    ${k.padEnd(22)} ${formatINRCompact(v).padStart(10)}  ${pct}%`);
}

const unrecoverableValue = (paiseBy[PayerType.NEVER_PAYING] ?? 0);
const retryProofValue = (paiseBy[PayerType.NEEDS_NEW_INSTRUMENT] ?? 0);
console.log(`\n  \x1b[1mCeiling analysis\x1b[0m`);
console.log(`    Value that NO policy can recover:        ${formatINRCompact(unrecoverableValue)} (${((unrecoverableValue / batch.counts.totalAtRiskPaise) * 100).toFixed(1)}%)`);
console.log(`    Value no RETRY-ONLY policy can recover:  ${formatINRCompact(retryProofValue + unrecoverableValue)} (${(((retryProofValue + unrecoverableValue) / batch.counts.totalAtRiskPaise) * 100).toFixed(1)}%)`);
console.log(`    -> retry-only policies are capped well below the achievable maximum,`);
console.log(`       which is the gap a diagnosis-driven policy exists to close.`);

section('Result');
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`\n  \x1b[31mFailing invariants:\x1b[0m`);
  failures.forEach((f) => console.log(`    - ${f}`));
  process.exit(1);
}
console.log('  \x1b[32mAll simulator invariants hold.\x1b[0m\n');
