/**
 * THE WORLD GENERATOR — the invariants that keep the world coherent
 * ================================================================
 *
 * Every number this project reports comes from a batch this file's subject produced, and until Day 8
 * the generator had no test file of its own. That gap hid a real defect for six days: latents that
 * asserted a customer had paid weeks before the case was handed to us, which would have credited
 * ₹1,07,871 — 9.6% of portfolio exposure — to every policy arm equally at cycle 0, for free.
 *
 * The tests here are mostly about SELF-RECOVERY, because self-recovery is the single most dangerous
 * quantity in the project: it is money that arrives with no intervention, so any leak of it into an
 * arm's total is an overstatement of what the agent contributed, and it does not look like a bug. It
 * looks like a good result.
 *
 * Run: node --test test/generator.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateBatch,
  DEFAULT_PARAMS,
  GENERATOR_VERSION,
  batchIdFor,
} from '../src/sim/generator.js';
import { ASSUMPTIONS } from '../src/sim/responseModel.js';

const NOW = new Date('2026-08-24T09:30:00Z');
const DAY_MS = 86_400_000;
const SEED = 'day7';

/** Payer-type modulation, mirrored from the generator so the tests can reason about propensity. */
const SELF_MULTIPLIER = {
  WILL_PAY_IF_REMINDED: 1.5,
  TEMPORARILY_SHORT: 1.1,
  NEEDS_NEW_INSTRUMENT: 0.25,
  DISPUTING: 0.1,
  NEVER_PAYING: 0.0,
};

const ageDaysOf = (event, now = NOW) =>
  (now.getTime() - new Date(event.occurredAt).getTime()) / DAY_MS;

function batch(split = 'TRAIN', overrides = undefined) {
  const b = generateBatch({ seed: SEED, split, now: NOW, overrides });
  return { ...b, eventById: new Map(b.events.map((e) => [e.eventId, e])) };
}

// =================================================================================================
// SURVIVORSHIP — a case in our queue is by definition one that has NOT been paid
// =================================================================================================

test('no latent claims the customer already paid before we were handed the case', () => {
  /**
   * THE core invariant, and the one whose violation cost the most. A case reaches us because it is
   * still unpaid at `now`. A latent saying `selfRecoverAt` was three days ago asserts the opposite of
   * the reason the case exists.
   *
   * Stated as a property rather than by recomputing the generator's formula, deliberately: a test
   * that restates the arithmetic can only catch a typo, whereas this one catches any future change —
   * a different distribution, a different window, an added payer type — that reintroduces the
   * contradiction by another route.
   */
  for (const split of ['TRAIN', 'TEST']) {
    const b = batch(split);
    const selfRecoverers = b.latents.filter((l) => l.willSelfRecover);

    assert.ok(
      selfRecoverers.length > 0,
      `PRECONDITION FAILED on ${split}: no latent self-recovers at all, so the assertion below ` +
        'would pass over an empty set. Self-recovery must exist for B0 to measure anything.'
    );

    const past = selfRecoverers.filter((l) => new Date(l.selfRecoverAt).getTime() < NOW.getTime());
    assert.equal(
      past.length,
      0,
      `${split}: ${past.length} of ${selfRecoverers.length} self-recovering latents have ` +
        'selfRecoverAt BEFORE run start. Such a case was paid before we saw it, so it would not be ' +
        'in an open-recovery queue — and every arm would be credited its full amount at cycle 0.'
    );
  }
});

test('a case older than the self-recovery window can never self-recover', () => {
  /**
   * The mechanism behind the invariant above, tested separately because the invariant could also be
   * satisfied the wrong way — by clamping `selfRecoverAt` forward to `now`, which would keep every
   * old case as a self-recoverer and merely hide the contradiction.
   *
   * If a customer only ever pays unprompted within 12 days and the failure was 20 days ago, their
   * continued non-payment is proof they are not that kind of customer. The posterior is exactly zero,
   * not small.
   */
  const [, windowHi] = DEFAULT_PARAMS.selfRecoveryWindowDays;
  const b = batch('TRAIN');

  const older = b.latents.filter((l) => ageDaysOf(b.eventById.get(l.eventId)) >= windowHi);
  assert.ok(
    older.length > 50,
    `PRECONDITION: only ${older.length} cases are older than the ${windowHi}-day window; with so ` +
      'few, this test would prove nothing. historyDays must exceed the window for it to bite.'
  );

  const offenders = older.filter((l) => l.willSelfRecover);
  assert.equal(
    offenders.length,
    0,
    `${offenders.length} of ${older.length} cases older than ${windowHi} days still self-recover. ` +
      'Their whole unprompted-payment window elapsed without payment.'
  );
});

test('self-recovery propensity falls as a case ages, rather than being uniform', () => {
  /**
   * Measuring the MECHANISM, not just the aggregate. The aggregate rate could be made to match by
   * scaling every case down equally, which would be a different (and wrong) world: it would say age
   * carries no information about whether a customer pays unprompted. Length bias says it carries a
   * lot.
   *
   * Buckets are wide and the assertion is on the ordering of the extremes only, because this is a
   * finite sample and asserting strict monotonicity across many narrow buckets would fail on noise —
   * which is the classic way a distributional test becomes a flaky test.
   */
  const b = batch('TRAIN');
  const buckets = [[0, 3], [3, 6], [6, 12], [12, 21]];
  const rates = buckets.map(([lo, hi]) => {
    const inBucket = b.latents.filter((l) => {
      const age = ageDaysOf(b.eventById.get(l.eventId));
      return age >= lo && age < hi;
    });
    const n = inBucket.length;
    const k = inBucket.filter((l) => l.willSelfRecover).length;
    return { lo, hi, n, k, rate: n ? k / n : 0 };
  });

  for (const r of rates) {
    assert.ok(r.n >= 20, `bucket ${r.lo}-${r.hi}d has only ${r.n} cases, too few to read`);
  }

  const youngest = rates[0];
  const oldest = rates[rates.length - 1];
  assert.ok(
    youngest.rate > oldest.rate,
    `freshest cases (${youngest.lo}-${youngest.hi}d, ${(youngest.rate * 100).toFixed(1)}%) must ` +
      `self-recover more often than the stalest (${oldest.lo}-${oldest.hi}d, ` +
      `${(oldest.rate * 100).toFixed(1)}%). Equal rates mean age was ignored.`
  );
  assert.equal(oldest.k, 0, `the ${oldest.lo}-${oldest.hi}d bucket must contain no self-recoverers`);
});

test('the self-recovery delay respects its truncated lower bound, not just the upper one', () => {
  /**
   * `selfRecoverAt > now` (the first test) and `delay <= windowHi` are both implied by drawing the
   * delay from `U(max(lo, ageDays), hi)`. But so is a lower bound that the first test cannot see: a
   * fresh case must still wait at least `lo` days. Without this, a "fix" that simply drew the instant
   * uniformly between `now` and `occurredAt + hi` would pass everything above while quietly letting
   * customers pay within minutes of the failure.
   */
  const [lo, hi] = DEFAULT_PARAMS.selfRecoveryWindowDays;
  const b = batch('TRAIN');

  for (const l of b.latents.filter((x) => x.willSelfRecover)) {
    const event = b.eventById.get(l.eventId);
    const age = ageDaysOf(event);
    const delay = (new Date(l.selfRecoverAt).getTime() - new Date(event.occurredAt).getTime()) / DAY_MS;
    const floor = Math.max(lo, age);

    assert.ok(
      delay >= floor - 1e-9,
      `${l.eventId}: delay ${delay.toFixed(3)}d is below its truncated floor ${floor.toFixed(3)}d`
    );
    assert.ok(delay <= hi + 1e-9, `${l.eventId}: delay ${delay.toFixed(3)}d exceeds the ${hi}d window`);
  }
});

test('the sampled self-recovery count matches the propensity the generator computed', () => {
  /**
   * A sampler-vs-probability consistency check, and worth being explicit about what it can and cannot
   * do. It recomputes the intended propensity per case and asks whether the number of latents drawn
   * is consistent with the sum of those propensities. It therefore CANNOT validate that the formula
   * is the right formula — the properties above do that. What it catches is the sampler drifting away
   * from the probability it is supposed to implement: a draw against the unconditional `q` instead of
   * the conditioned one, an inverted comparison, a stale cached value.
   *
   * This is why the expectation is reconstructed from the batch's own composition rather than
   * hardcoded as "31". A hardcoded count would also pass, and would additionally break every time
   * anything upstream of the generator's RNG stream moved, teaching us to update the number instead
   * of reading it.
   *
   * The ratio assertion below checks the size of the survivorship correction. Its band is per-batch and
   * deliberately loose; see the note under this test for why the pre-registered 0.29-0.33 band belongs
   * to the across-world mean and not to any single batch. Measured on g120: 0.3305 (TRAIN), 0.3317
   * (TEST) — both were 0.303/0.319 on g110, which is a re-rolled age sample, not a changed world rule.
   */
  const [lo, hi] = DEFAULT_PARAMS.selfRecoveryWindowDays;

  for (const split of ['TRAIN', 'TEST']) {
    const b = batch(split);
    let sumUnconditional = 0;
    let sumConditioned = 0;
    let observed = 0;

    for (const l of b.latents) {
      const event = b.eventById.get(l.eventId);
      const age = ageDaysOf(event);
      const q = Math.min(
        0.95,
        DEFAULT_PARAMS.selfRecoveryRate[event.lossType] * SELF_MULTIPLIER[l.payerType]
      );
      const earliest = Math.max(lo, age);
      const pOutlasts = earliest >= hi ? 0 : (hi - earliest) / (hi - lo);

      sumUnconditional += q;
      sumConditioned += (q * pOutlasts) / (q * pOutlasts + (1 - q));
      if (l.willSelfRecover) observed += 1;
    }

    // Poisson-binomial mean; sd bounded above by sqrt(np(1-p)) using the pooled rate.
    const sd = Math.sqrt(sumConditioned * (1 - sumConditioned / b.latents.length));
    const z = (observed - sumConditioned) / sd;

    assert.ok(
      Math.abs(z) < 3,
      `${split}: drew ${observed} self-recoverers against an expected ${sumConditioned.toFixed(1)} ` +
        `(sd ${sd.toFixed(1)}), z=${z.toFixed(2)}. The sampler is not drawing against the ` +
        'conditioned propensity it computes.'
    );

    const ratio = sumConditioned / sumUnconditional;
    assert.ok(
      ratio > RATIO_PER_BATCH[0] && ratio < RATIO_PER_BATCH[1],
      `${split}: survivorship conditioning scales propensity by ${ratio.toFixed(3)}, outside the ` +
        `measured per-batch range ${RATIO_PER_BATCH[0]}-${RATIO_PER_BATCH[1]}. That is 4sd from the ` +
        'across-world mean, so this is a real change in the age distribution or the window, not a ' +
        'draw. Re-measure the spread before touching this bound.'
    );
  }
});

/**
 * The per-batch band, and why it is not the pre-registered one.
 *
 * The pre-registration in ENGINEERING_LOG.md predicted the survivorship correction would scale
 * propensity to 0.29-0.33x. This test used to apply that band to a SINGLE batch, and that conflates a
 * claim about a property with a bound on one sample. Measured across 12 seeds x 2 splits (probe output
 * recorded in the Day 8 log): mean **0.3110**, sd **0.0122**, range 0.2864-0.3317. So the 0.29-0.33
 * band excludes **5 of 24 worlds purely by chance** — it is roughly a +/-1.6sd interval being used as
 * an always-true bound.
 *
 * It went unnoticed because it happened to hold for the two batches it was written against, which is
 * the same failure this test's own docblock warns about for the count: a number that passes today and
 * breaks whenever anything upstream of the RNG moves, teaching us to edit the number. Task #64 moved
 * the generator to per-event streams, which re-rolled the age sample, and day7 landed at 0.3305.
 *
 * NOTE WHAT IS AND IS NOT BEING CHANGED. The pre-registered prediction is CONFIRMED: the across-world
 * mean is 0.311, inside 0.29-0.33. What is corrected is the test's inference from it. The band below is
 * mean +/- 4sd, wide enough that a failure means the world genuinely changed; the tighter claim — that
 * the POPULATION mean sits in the pre-registered band — is asserted separately in the test after this
 * one, which is the assertion that actually has the pre-registration behind it.
 */
const RATIO_PER_BATCH = [0.262, 0.360];
const RATIO_PREREGISTERED = [0.29, 0.33];

test('across worlds, the survivorship correction lands where it was pre-registered to land', () => {
  /**
   * The claim the pre-registration actually supports, asserted at the level it was made: not "this
   * batch" but "this correction". Averaging over seeds is what turns a draw into a property, and it is
   * the same reason the arm comparison pairs across 20 worlds instead of trusting one.
   *
   * Six seeds rather than the twelve the probe used, to keep `npm run check` quick; the sd is small
   * enough that six is ample for a mean this far from either bound.
   */
  const [lo, hi] = DEFAULT_PARAMS.selfRecoveryWindowDays;
  const ratios = [];

  for (const seed of ['day7', 'w01', 'w02', 'w03', 'w04', 'w05']) {
    for (const split of ['TRAIN', 'TEST']) {
      const b = generateBatch({ seed, split, now: NOW });
      const byId = new Map(b.events.map((e) => [e.eventId, e]));
      let su = 0;
      let sc = 0;

      for (const l of b.latents) {
        const event = byId.get(l.eventId);
        const q = Math.min(
          0.95,
          DEFAULT_PARAMS.selfRecoveryRate[event.lossType] * SELF_MULTIPLIER[l.payerType]
        );
        const earliest = Math.max(lo, ageDaysOf(event));
        const pOutlasts = earliest >= hi ? 0 : (hi - earliest) / (hi - lo);
        su += q;
        sc += (q * pOutlasts) / (q * pOutlasts + (1 - q));
      }

      ratios.push(sc / su);
    }
  }

  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  assert.ok(
    mean > RATIO_PREREGISTERED[0] && mean < RATIO_PREREGISTERED[1],
    `the across-world mean survivorship ratio is ${mean.toFixed(4)} over ${ratios.length} batches, ` +
      `outside the pre-registered ${RATIO_PREREGISTERED[0]}-${RATIO_PREREGISTERED[1]}. This one IS the ` +
      'pre-registered claim, so a failure here means the prediction was wrong and the log must say so ' +
      '— it must not be fixed by moving the band.'
  );
});

// =================================================================================================
// THE SELF-RECOVERY RATE IS A LIVE KNOB (task #59)
// =================================================================================================

test('the world reads its self-recovery rate from the assumption the sweep perturbs', () => {
  /**
   * These three numbers used to be hardcoded in the generator, identical to `ASSUMPTIONS
   * .selfRecoveryRate` character for character but connected to it by nothing. The assumption's own
   * `basis` says it is "load-bearing for the B0 baseline", and `perturbAssumptions` perturbs it — so
   * the sensitivity sweep would have swept the assumption most able to embarrass this project and
   * moved the world not at all, while printing a sensitivity result for it.
   *
   * Asserting equality here is what stops the copy coming back.
   */
  for (const lossType of ['FAILED_PAYMENT', 'FAILED_SUBSCRIPTION', 'OVERDUE_INVOICE']) {
    assert.equal(
      DEFAULT_PARAMS.selfRecoveryRate[lossType],
      ASSUMPTIONS.selfRecoveryRate[lossType].value,
      `the world's ${lossType} self-recovery rate has drifted from the declared assumption`
    );
  }
});

test('perturbing the self-recovery rate actually moves the world', () => {
  /**
   * The behavioural half. Equality of constants above does not prove the value is USED — it could be
   * read into a variable the draw ignores. Only moving the knob and watching the world move proves
   * the wiring, and this is the test that makes the Day 8 sensitivity sweep's self-recovery row
   * meaningful rather than decorative.
   */
  const base = DEFAULT_PARAMS.selfRecoveryRate;
  const scaled = (k) =>
    Object.fromEntries(Object.entries(base).map(([lt, v]) => [lt, v * k]));
  const countFor = (k) =>
    batch('TRAIN', { selfRecoveryRate: scaled(k) }).latents.filter((l) => l.willSelfRecover).length;

  const none = countFor(0);
  const half = countFor(0.5);
  const one = countFor(1);
  const double = countFor(2);

  assert.equal(none, 0, 'a zero self-recovery rate must produce no self-recoverers at all');
  assert.ok(
    half < one && one < double,
    `self-recoverer count must rise with the rate; got 0x=${none}, 0.5x=${half}, 1x=${one}, ` +
      `2x=${double}. A flat sequence means the parameter is read but not used.`
  );
});

// =================================================================================================
// STREAM ISOLATION — a sweep must perturb ONE thing (task #64)
// =================================================================================================

/**
 * The two tests below exist because the test above is not enough, and the gap between them is the
 * whole defect.
 *
 * "Perturbing the rate moves the world" was true. What nobody asked is whether it moved ONLY the
 * thing being perturbed. It did not. Measured on the day7 world before the fix, sweeping nothing but
 * `selfRecoveryRate` moved TOTAL PORTFOLIO EXPOSURE by 12.6%:
 *
 *     multiplier   self-recoverers   total exposure
 *       0.0x             0            ₹9,30,035
 *       0.5x            13            ₹8,47,896
 *       1.0x            31            ₹9,16,829
 *       2.0x            75            ₹8,12,762
 *
 * Self-recovery is a latent. It cannot create or destroy a rupee of exposure — exposure is just the
 * sum of the amounts our systems already recorded as failed. So those numbers were impossible, and
 * a sensitivity sweep built on them would have reported "recovery rate is sensitive to the
 * self-recovery assumption" when the real cause was that the entire portfolio had been replaced.
 *
 * CAUSE: all 600 events shared one RNG stream, and `rng.float(earliestDelay, selfHi)` was drawn only
 * when the case was a self-recoverer. So case i's coin flip shifted case i+1's amount. The generator
 * already had a docblock explaining that `rng.bool` is drawn unconditionally for exactly this reason
 * — the reasoning was right and applied one line too narrowly.
 *
 * FIX: one stream per event, which is what `deriveSeed`'s own docblock prescribes ("adding one extra
 * random call would shift every downstream number and silently invalidate a comparison"). Per-event
 * streams make this robust rather than carefully balanced: a future conditional draw anywhere in the
 * loop body cannot reach another case, so nobody has to remember this rule to keep it true.
 */

/** Scale one `{ key: number }` parameter block by `k`, leaving its shape alone. */
const scaleBlock = (block, k) =>
  Object.fromEntries(Object.entries(block).map(([key, v]) => [key, v * k]));

test('a sweep on the self-recovery rate leaves the observable world byte-identical', () => {
  /**
   * The strongest form available, and it is available because self-recovery is a PURE latent: no
   * observable field anywhere depends on it. So the assertion is not "exposure is close" but "the
   * events array is deep-equal" — every amount, every customer assignment, every failure payload,
   * every timestamp. Anything weaker would pass while a handful of cases quietly swapped.
   */
  const base = DEFAULT_PARAMS.selfRecoveryRate;
  const worldAt = (k) => batch('TRAIN', { selfRecoveryRate: scaleBlock(base, k) });

  const reference = worldAt(1);

  for (const k of [0, 0.5, 1.5, 2]) {
    const other = worldAt(k);

    assert.deepEqual(
      other.events,
      reference.events,
      `sweeping selfRecoveryRate to ${k}x changed the observable events. Self-recovery is a latent; ` +
        'it cannot move a single recorded amount. A sweep that replaces the portfolio measures the ' +
        'portfolio, not the assumption.'
    );
    assert.deepEqual(other.customers, reference.customers, 'the customer population is a different stream');

    // Stated separately because exposure is the number the sweep actually reports on, and a reader
    // of a failure should see it named rather than inferred from a deep-equal diff.
    const exposure = (b) => b.events.reduce((s, e) => s + e.amountPaise, 0);
    assert.equal(exposure(other), exposure(reference), `total exposure moved at ${k}x`);
  }

  // Guard against the fix being achieved by breaking the knob: the latents must still move.
  assert.equal(
    worldAt(0).latents.filter((l) => l.willSelfRecover).length,
    0,
    'the knob must still work — this test must not be satisfiable by ignoring the parameter'
  );
  assert.ok(
    worldAt(2).latents.filter((l) => l.willSelfRecover).length >
      worldAt(0.5).latents.filter((l) => l.willSelfRecover).length,
    'the knob must still work'
  );
});

test('a sweep on the payer-type mix moves the latents without repricing the portfolio', () => {
  /**
   * The weaker but more general form. Unlike self-recovery, payer type DOES drive observables — the
   * failure payload, the invoice dispute flag, the mandate status, the downtime window. So the events
   * cannot be deep-equal, and asserting that would be wrong.
   *
   * What must hold is that the fields drawn BEFORE payer type's consequences diverge are untouched:
   * the customer, the loss type, and the amount. Those are the ones the eval's denominators are built
   * from, so if they move, no two rows of the sensitivity table share a denominator and the table is
   * not a table.
   *
   * `payerTypeMix` rather than the cause mix because the cause distribution is currently a module
   * constant (`CAUSE_GIVEN_PAYER`), not a parameter — see the note in ENGINEERING_LOG: #58's
   * cause-mix shift has no knob to turn yet.
   */
  const base = DEFAULT_PARAMS.payerTypeMix;

  // Shift weight toward NEVER_PAYING without renormalising — `rng.weighted` normalises internally,
  // which is why the mix is expressible as relative weights at all.
  const shifted = { ...base, NEVER_PAYING: base.NEVER_PAYING * 3 };

  const reference = batch('TRAIN');
  const other = batch('TRAIN', { payerTypeMix: shifted });

  const spine = (b) =>
    b.events.map((e) => `${e.eventId}|${e.customerId}|${e.lossType}|${e.amountPaise}`);

  assert.deepEqual(
    spine(other),
    spine(reference),
    'shifting the payer-type mix repriced the portfolio. Payer type changes how a case behaves, not ' +
      'how much money was lost, and the eval compares sweep rows against a shared denominator.'
  );

  const neverPaying = (b) => b.latents.filter((l) => l.payerType === 'NEVER_PAYING').length;
  assert.ok(
    neverPaying(other) > neverPaying(reference),
    `the mix must actually have shifted; got ${neverPaying(reference)} -> ${neverPaying(other)}`
  );
});

test('a sweep on the loss-type mix does not reprice the cases whose type did not change', () => {
  /**
   * WHY THIS TEST EXISTS: I wrote a docblock in the generator claiming the hoisted rail draw protects a
   * `lossTypeMix` sweep, then mutated the hoist away and NOTHING FAILED — because no test swept that
   * parameter. The claim was true and unpinned, which is the same thing as unverified. An invoice is
   * always collected on netbanking, so the naive ternary skips the rail draw for invoices; that shifts
   * every later draw in the case, `amountPaise` included, as a function of the loss type.
   *
   * Loss type legitimately changes the observable payload (an invoice has no failure block), so the
   * assertion is narrowed to the two fields the eval's denominators are built from: who the customer is,
   * and how much money is at stake.
   */
  const base = DEFAULT_PARAMS.lossTypeMix;
  const shifted = { ...base, OVERDUE_INVOICE: base.OVERDUE_INVOICE * 4 };

  const reference = batch('TRAIN');
  const other = batch('TRAIN', { lossTypeMix: shifted });

  const money = (b) => b.events.map((e) => `${e.eventId}|${e.customerId}|${e.amountPaise}`);
  assert.deepEqual(
    money(other),
    money(reference),
    'shifting the loss-type mix repriced the portfolio. The amount is drawn from the customer segment, ' +
      'not the loss type, so it must not move — if it does, a conditional draw is shifting the stream ' +
      'inside each case.'
  );

  const invoices = (b) => b.events.filter((e) => e.lossType === 'OVERDUE_INVOICE').length;
  assert.ok(
    invoices(other) > invoices(reference),
    `the mix must actually have shifted; got ${invoices(reference)} -> ${invoices(other)} invoices`
  );
});

test('generating fewer events leaves the surviving events untouched', () => {
  /**
   * WHAT THIS TEST DOES AND DOES NOT ESTABLISH, because I first wrote it to prove the wrong thing.
   *
   * I keyed each event's stream on `eventId` and claimed in the generator that this is what keeps a
   * smaller batch a prefix of a larger one. Then I mutated the key to the loop index and nothing failed
   * — `eventId` is derived from `i`, so the two are the same function of position. Worse, I mutated the
   * generator back to ONE SHARED STREAM and this test still passed, because a sequential loop consumes
   * the same draws in the same order for the first 300 events either way. So this test does not
   * discriminate between any of the three designs, and the docblock claim it was written to support has
   * been corrected rather than propped up.
   *
   * It is kept because the PROPERTY is real and load-bearing even though nothing currently threatens it:
   * `buildWorld` slices the batch to 80 and a future run may want 200, and if batch size silently
   * re-rolled every case then no figure from a 600-event world could be compared to one from a
   * 300-event world. This is a regression guard for a property that holds today by construction.
   */
  const full = batch('TRAIN');
  const small = generateBatch({ seed: SEED, split: 'TRAIN', now: NOW, overrides: { events: 300 } });

  assert.equal(small.events.length, 300, 'the override must actually take effect');
  assert.deepEqual(
    small.events,
    full.events.slice(0, 300),
    'a smaller batch must be a prefix of the larger one. If it is not, the per-event stream is keyed ' +
      'on position rather than identity and batch size is silently a world parameter.'
  );

  const latentOf = (b) => new Map(b.latents.map((l) => [l.eventId, l]));
  const smallLatents = latentOf(small);
  const fullLatents = latentOf(full);
  for (const [eventId, l] of smallLatents) {
    assert.deepEqual(l, fullLatents.get(eventId), `latent for ${eventId} changed with the batch size`);
  }
});

// =================================================================================================
// PROVENANCE
// =================================================================================================

test('the batch id changes when the generator changes, so numbers cannot cross worlds', () => {
  /**
   * The survivorship fix altered the world. Any recovery figure measured before it is not comparable
   * to one measured after, and the batch id is the mechanism that makes that visible instead of
   * leaving two incompatible numbers looking like a before/after improvement.
   */
  assert.equal(batchIdFor({ seed: 42, split: 'TRAIN', generatorVersion: '1.0.0' }), 'batch_train_s42_g100');
  assert.equal(batchIdFor({ seed: 42, split: 'TRAIN', generatorVersion: '1.1.0' }), 'batch_train_s42_g110');
  assert.notEqual(GENERATOR_VERSION, '1.0.0', 'the survivorship fix must be reflected in the version');

  const b = batch('TRAIN');
  for (const l of b.latents) {
    assert.equal(l.batchId, batchIdFor({ seed: SEED, split: 'TRAIN' }));
  }
});
