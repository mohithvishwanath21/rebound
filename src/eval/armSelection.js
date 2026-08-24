/**
 * ARM SELECTION — choosing which model Day 6 is built on, without touching TEST
 * ============================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Day 5 concluded "build the decision engine on logistic." That conclusion was read off the TEST
 * column, which is the one thing TEST is not allowed to do. It was not a typo — the report's own
 * VALID column ranked `lookup` first, and I preferred the TEST answer without noticing I was
 * choosing between them. Two findings in the same report then disagreed: one recommended logistic
 * (from TEST), the next fitted Platt scaling to lookup (from VALID).
 *
 * The obvious repair — "just use VALID" — is also wrong, and that is the more interesting half.
 * VALID is 120 events. On seed `day6` the four honest arms sat within ₹1,650 of each other there.
 * A ranking that noisy is not a measurement; taking it seriously would have been the same mistake
 * with the opposite answer, and it would have looked more rigorous.
 *
 * So selection needs more data without touching TEST. Since the seed bug is fixed and seeds finally
 * vary, that data can come from re-running the whole fit on many independently generated worlds and
 * averaging. That is what this file does.
 *
 * STRUCTURAL GUARANTEE, NOT A PROMISE
 * -----------------------------------
 * This module never generates a TEST batch. Not "avoids scoring it" — never brings it into scope.
 * The same reasoning as the latent-truth boundary: a rule that depends on me remembering it has
 * already failed once here. `generateBatch` is called with `split: 'TRAIN'` and nothing else, so
 * there is no TEST data in this file for a later edit to accidentally read.
 *
 * THE PROTOCOL
 * ------------
 * For each sweep seed, an independently generated world of `count` events, then:
 *
 *   INNER FIT  64% of events   every arm is fitted here, and only here
 *   TUNE       16% of events   GBM early stopping reads this, and nothing else does
 *   SELECT     20% of events   every arm is scored here; this is what selection averages over
 *
 * The three-way split exists because of a subtle reuse in the headline report: there, GBM early-stops
 * on VALID, and VALID was then also the selection set. Stopping is a hyperparameter choice, so an arm
 * that tunes itself on the selection set is being scored on data it has already consulted, while the
 * arms that cannot tune are not. The bias is probably small — early stopping optimises logloss and
 * selection reads regret — but "probably small and only affecting one arm" is not a defence when the
 * whole point of the exercise is a fair comparison. Every arm here fits on identical data and is
 * scored on data none of them has seen.
 *
 * Cost: the fit set drops from 480 events to 384. Selection is allowed to be run on slightly less
 * data than the final model, which is refitted on the full FIT set once the arm is chosen. That is
 * ordinary nested practice, and the alternative — a fair comparison that needs more events than
 * exist — is not available.
 *
 * WHY PAIRED DIFFERENCES, AND WHY THAT IS THE WHOLE TRICK
 * ------------------------------------------------------
 * Absolute regret swings wildly between seeds, because a world with a few large disputed invoices
 * has far more money at stake than one without. Comparing arm A on seed 3 to arm B on seed 7 is
 * mostly comparing seed 3 to seed 7.
 *
 * But within one seed every arm sees the identical world, identical labels and the identical split.
 * The per-seed DIFFERENCE between two arms therefore has the world variance cancelled out of it, and
 * that difference is exactly the quantity selection needs — not "how much regret does A have" but
 * "does A beat B." So the statistic reported below is the mean paired difference and its standard
 * error, never the difference of the means.
 *
 * Regret is also normalised per seed, as `regret / best available value`, which is `1 − captureRate`.
 * Raw rupees are not comparable across worlds of different total value; a fraction is.
 *
 * THE SELECTION RULE, WRITTEN DOWN BEFORE THE SWEEP WAS RUN
 * --------------------------------------------------------
 * Stating this afterwards would make any rule look principled, so it is stated here first, and the
 * output records which branch actually fired.
 *
 *   1. Rank the honest arms by MEAN NORMALISED SELECT REGRET across all sweep seeds.
 *   2. Compute the paired difference between the top arm and the runner-up. If |t| >= 2.0, the
 *      winner is selected BY MEASUREMENT.
 *   3. If |t| < 2.0, the sweep could not separate them. Declare a TIE and break it with a declared
 *      preference order, and label the result `selectedBy: 'tiebreak'` so that no reader mistakes a
 *      preference for a finding.
 *
 * The preference order is `logistic > gbm > lookup > constant`, on a functional requirement rather
 * than taste: Day 6 enumerates roughly 33 candidate actions per case and needs a probability for
 * every one, including (cause, action) combinations that are rare or absent in the fit set. The
 * lookup table falls back to a global rate below `minCount`, so it cannot rank candidates it has not
 * seen — and ranking candidates is the entire job. Logistic is placed above GBM on auditability:
 * fifteen signed coefficients are a falsifiable claim a reviewer can argue with, and split gain is
 * not.
 *
 * I want to flag the obvious hazard rather than hide it: that order happens to put my prior
 * preference first. That is exactly why step 3 labels the outcome. If the sweep separates the arms,
 * the preference never runs; if it does not, the report says so out loud, and the choice can be
 * discounted as the judgement call it is.
 *
 * The oracle is absent. It is not a shippable candidate, so including it would double the runtime to
 * rank something that cannot win.
 */

import { generateBatch, DEFAULT_PARAMS } from '../sim/generator.js';
import { buildDataset } from './dataset.js';
import { evalNow } from './evalClock.js';
import { splitByEvent, actionSelectionRegret } from './modelComparison.js';
import { fitLogistic, fitConstant } from '../ml/logistic.js';
import { fitGBM } from '../ml/gbm.js';
import { fitLookupTable, brier } from '../ml/calibration.js';
import { makeRng, deriveSeed } from '../core/rng.js';

/** Declared before the sweep ran. See the header. */
export const PREFERENCE_ORDER = ['logistic', 'gbm', 'lookup', 'constant'];

/** Below this, the sweep is treated as unable to separate two arms. */
export const T_THRESHOLD = 2.0;

export function defaultSeeds(n = 10) {
  return Array.from({ length: n }, (_, i) => `sweep-${String(i + 1).padStart(2, '0')}`);
}

/**
 * Mean, sample standard deviation and standard error of the mean.
 *
 * `n - 1` in the denominator, deliberately: with ten seeds the difference between dividing by 10 and
 * by 9 is 5% on the standard error, which is enough to move a borderline t across the threshold that
 * decides the whole procedure.
 */
export function summarise(xs) {
  const n = xs.length;
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n < 2) return { n, mean, sd: NaN, se: NaN };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  return { n, mean, sd, se: sd / Math.sqrt(n) };
}

/**
 * Paired comparison of two arms across seeds. `a` and `b` are arrays of per-seed normalised regret,
 * index-aligned by seed.
 *
 * Returns the mean of the per-seed differences, its standard error, the resulting t, and a sign
 * count. The sign count is reported alongside t because it assumes almost nothing: t leans on the
 * differences being roughly normal, which ten points cannot establish, whereas "A beat B on 9 of 10
 * worlds" survives any distributional shape. When the two disagree, that disagreement is itself
 * information about the sample.
 */
export function pairedDiff(a, b) {
  if (a.length !== b.length) throw new Error('pairedDiff: arrays must be seed-aligned');
  const diffs = a.map((x, i) => x - b[i]);
  const { n, mean, sd, se } = summarise(diffs);
  const aWins = diffs.filter((d) => d < 0).length;
  return {
    n,
    meanDiff: mean,
    sd,
    se,
    t: se > 0 ? mean / se : (mean === 0 ? 0 : Infinity),
    aWins,
    bWins: diffs.filter((d) => d > 0).length,
    ties: diffs.filter((d) => d === 0).length,
    diffs,
  };
}

/**
 * Fit every honest arm on one world and score them on that world's SELECT split.
 *
 * Exported so a test can run a single seed cheaply rather than the whole sweep.
 */
export async function scoreOneWorld({
  seed,
  count = 600,
  trees = 300,
  learningRate = 0.08,
  maxDepth = 3,
  l2 = 1e-4,
  iterations = 500,
  shifted = true,
} = {}) {
  const overridesFor = (n) => ({
    events: n,
    customers: Math.max(2, Math.round((DEFAULT_PARAMS.customers * n) / DEFAULT_PARAMS.events)),
  });

  // TRAIN only. There is deliberately no `seed: 'day4'` TEST batch anywhere in this module — see the
  // header. The shifted set below is a different world entirely, not the reserved held-out sample.
  //
  // `overrides`, not `count`. `generateBatch` has no `count` parameter — the batch size lives in
  // `DEFAULT_PARAMS.events` and is only reachable through `overrides`. Passing `count` directly, as
  // `compareModels` did for four days, is silently ignored: the generator produces 600 events
  // whatever you ask for. Found here, by asking for 200 and being told "384 fit / 96 tune" — which
  // are the 600-event numbers.
  //
  // `customers` is scaled alongside, because events-per-customer is a real parameter of the world:
  // holding 220 customers fixed while cutting events to 200 would quietly produce a population with
  // one third the repeat-failure rate, and repeat contact is something the model reads.
  const batch = generateBatch({
    seed: `world-${seed}`,
    split: 'TRAIN',
    now: evalNow(),
    overrides: overridesFor(count),
  });
  const built = await buildDataset({ events: batch.events, latents: batch.latents, seed });

  // Outer split: 80% fittable / 20% select. Then carve TUNE out of the fittable part so that the
  // select set is touched by exactly one thing — scoring.
  const outer = splitByEvent(built.rows, { fraction: 0.8, seed });
  const inner = splitByEvent(outer.fit, { fraction: 0.8, seed: `${seed}-inner` });
  const innerFit = inner.fit;
  const tune = inner.valid;
  const select = outer.valid;

  /**
   * A SECOND scoring set, drawn from a world with `TEST_PARAM_SHIFT` applied: a different mix of
   * payer types, a higher rate of unmatchable error text, different amount distributions.
   *
   * This exists because the first run of this sweep produced a result that contradicted the headline
   * report. On the pinned held-out TEST batch, logistic cut regret 37.9% against the lookup table. In
   * the sweep, over twenty in-distribution worlds, the two were indistinguishable and lookup won more
   * worlds than it lost. Both cannot be describing the same effect.
   *
   * The obvious candidate explanation is the shift itself, and it is a mechanism rather than a guess:
   * a GROUP BY stores the observed rate for each (cause, action) cell, so when the population moves
   * those stored rates are stale in a way no amount of data fixes. A model with structure can
   * interpolate.
   *
   * THAT EXPLANATION HAS SINCE BEEN TESTED AND IS WRONG, in the coverage form stated above. The
   * fallback rate measured by `lookup.coverageOf` is exactly 0.00% on both sets across twenty worlds:
   * all 66 cells are populated and all clear `minCount`. `TEST_PARAM_SHIFT` perturbs the payer mix,
   * the rate of unmatchable error text and the amount distribution, but it introduces no new cause and
   * no new action, so the set of cells is identical either side of the shift and there is no coverage
   * to lose. The paragraph above is kept rather than deleted because the reasoning was sound and the
   * conclusion was still false, which is the more useful thing to leave in a file.
   *
   * A narrower version is untested and plausible: every cell is populated, but under shift each cell
   * averages over a different internal mix, so a stored cell mean is stale rather than missing. That
   * needs a shift to the cause mix itself to separate from coverage loss — a Day 8-9 job, not this one.
   *
   * So the shifted set is retained for what it does establish (the ordering is stable under this
   * perturbation, and constant degrades much faster than anything fitted) and not as support for a
   * robustness claim I cannot make.
   *
   * TO BE PRECISE ABOUT WHAT THIS IS NOT: this is a freshly generated shifted world seeded from the
   * sweep seed. It is NOT the `seed: 'day4'` TEST batch that the headline report scores once at the
   * end. Selection may look at simulated data from the same generator; it may not look at the
   * specific held-out sample reserved for final reporting. Those are different things and conflating
   * them is how a held-out number quietly stops being held out.
   */
  let shiftedSelect = null;
  if (shifted) {
    const shiftedBatch = generateBatch({
      seed: `shift-${seed}`,
      split: 'TEST',
      now: evalNow(),
      overrides: overridesFor(Math.max(20, Math.round(count / 4))),
    });
    const shiftedBuilt = await buildDataset({
      events: shiftedBatch.events, latents: shiftedBatch.latents, seed: `${seed}-shift`,
    });
    shiftedSelect = shiftedBuilt.rows;
  }

  const constant = fitConstant(innerFit);
  const lookup = fitLookupTable(innerFit, {
    key: (r) => `${r.diagnosedCause}|${r.actionKind}`,
    minCount: 10,
  });
  const logistic = fitLogistic(innerFit, { l2, iterations, learningRate: 0.5 });
  const gbm = fitGBM(innerFit, {
    trees, learningRate, maxDepth, rng: makeRng(deriveSeed(seed, 'gbm')), validation: tune,
  });

  const predictors = {
    constant: () => constant.rate,
    lookup: (r) => lookup.predictRow(r),
    logistic: (r) => logistic.predict(r.x),
    gbm: (r) => gbm.predict(r.x),
  };

  const scoreOn = (rows) => {
    const y = rows.map((r) => r.y);
    const out = {};
    for (const [name, predict] of Object.entries(predictors)) {
      const p = rows.map(predict);
      const reg = actionSelectionRegret(rows, p);
      out[name] = {
        // `1 - captureRate`, computed from the ratio rather than the rupees so it is comparable across
        // worlds whose total recoverable value differs by a factor of several.
        normRegret: reg.bestPaise > 0 ? reg.regretPaise / reg.bestPaise : 0,
        regretPaise: reg.regretPaise,
        bestPaise: reg.bestPaise,
        topActionAgreement: reg.topActionAgreement,
        brier: brier(y, p),
      };
    }
    return out;
  };

  // The mechanism measurement, taken on both scoring sets. If a GROUP BY degrades under shift because
  // its stored cells go stale, this is where it shows up directly, with no standard error attached.
  const coverage = {
    inDist: lookup.coverageOf(select),
    shifted: shiftedSelect ? lookup.coverageOf(shiftedSelect) : null,
  };

  return {
    seed,
    counts: {
      // From `batch.events.length`, NOT from the `count` argument. The model report labelled its
      // header with the flag value, so a run that asked for 200 events and silently got 600 would
      // have printed "200 TRAIN events" above numbers computed from 600. A count that comes from the
      // request rather than the data is not a measurement, it is an echo.
      worldEvents: batch.events.length,
      requestedEvents: count,
      innerFitEvents: inner.fitEvents,
      tuneEvents: inner.validEvents,
      selectEvents: outer.validEvents,
      selectRows: select.length,
      shiftedEvents: shiftedSelect ? new Set(shiftedSelect.map((r) => r.eventId)).size : 0,
      shiftedRows: shiftedSelect?.length ?? 0,
    },
    gbmTreesUsed: gbm.treesUsed,
    lookupGroups: lookup.groups,
    lookupSupportedGroups: lookup.supportedGroups,
    coverage,
    arms: scoreOn(select),
    shiftedArms: shiftedSelect ? scoreOn(shiftedSelect) : null,
  };
}

/**
 * Aggregate one scoring set across worlds: per-arm summaries, per-seed ranks, and every pairwise
 * paired comparison. Factored out so the in-distribution and shifted sets are summarised by identical
 * code — if they were summarised by two similar-looking blocks, a difference between them could be a
 * difference in the aggregation rather than in the data.
 */
function aggregate(worlds, pick) {
  const armNames = Object.keys(pick(worlds[0]));
  const byArm = Object.fromEntries(
    armNames.map((name) => [name, {
      normRegret: worlds.map((w) => pick(w)[name].normRegret),
      brier: worlds.map((w) => pick(w)[name].brier),
      agreement: worlds.map((w) => pick(w)[name].topActionAgreement),
    }])
  );

  // Per-seed ranks, so a single catastrophic world cannot decide the ordering on its own. Reported
  // beside the mean rather than instead of it: if the mean and the mean rank disagree, the mean is
  // being driven by outliers and that is worth seeing.
  const rankSum = Object.fromEntries(armNames.map((n) => [n, 0]));
  const winCount = Object.fromEntries(armNames.map((n) => [n, 0]));
  for (const w of worlds) {
    const a = pick(w);
    const order = [...armNames].sort((x, y) => a[x].normRegret - a[y].normRegret);
    order.forEach((n, idx) => { rankSum[n] += idx + 1; });
    winCount[order[0]] += 1;
  }

  const table = armNames.map((name) => ({
    name,
    regret: summarise(byArm[name].normRegret),
    brier: summarise(byArm[name].brier),
    agreement: summarise(byArm[name].agreement),
    meanRank: rankSum[name] / worlds.length,
    worldsWon: winCount[name],
  })).sort((a, b) => a.regret.mean - b.regret.mean);

  const pairwise = [];
  for (let i = 0; i < table.length; i += 1) {
    for (let j = i + 1; j < table.length; j += 1) {
      pairwise.push({
        a: table[i].name,
        b: table[j].name,
        ...pairedDiff(byArm[table[i].name].normRegret, byArm[table[j].name].normRegret),
      });
    }
  }

  const leader = table[0];
  const runnerUp = table[1];
  const headToHead = pairedDiff(byArm[leader.name].normRegret, byArm[runnerUp.name].normRegret);

  return {
    byArm,
    table,
    pairwise,
    regretOrder: table.map((r) => r.name),
    brierOrder: [...table].sort((a, b) => a.brier.mean - b.brier.mean).map((r) => r.name),
    headToHead: { leader: leader.name, runnerUp: runnerUp.name, ...headToHead },
    separated: Math.abs(headToHead.t) >= T_THRESHOLD,
  };
}

/**
 * Run the sweep and apply the declared selection rule.
 */
export async function selectionSweep({
  seeds = defaultSeeds(10),
  count = 600,
  trees = 300,
  shifted = true,
  onProgress = () => {},
} = {}) {
  const worlds = [];
  for (const [i, seed] of seeds.entries()) {
    onProgress(`world ${i + 1}/${seeds.length} (seed ${seed})`);
    worlds.push(await scoreOneWorld({ seed, count, trees, shifted }));
  }

  const inDist = aggregate(worlds, (w) => w.arms);
  const shift = shifted && worlds[0].shiftedArms ? aggregate(worlds, (w) => w.shiftedArms) : null;

  /**
   * How often the GROUP BY had nothing to say, in distribution and under shift, paired per world.
   *
   * This is deliberately not a regret comparison. It measures the mechanism rather than the symptom,
   * so it has no dependence on how the outcome draws happened to land, and it can settle a question
   * that a 20-world regret difference cannot resolve.
   */
  const coverage = shift
    ? {
        inDist: summarise(worlds.map((w) => w.coverage.inDist.fallbackRate)),
        shifted: summarise(worlds.map((w) => w.coverage.shifted.fallbackRate)),
        unseenInDist: summarise(worlds.map((w) => w.coverage.inDist.unseenRate)),
        unseenShifted: summarise(worlds.map((w) => w.coverage.shifted.unseenRate)),
        paired: pairedDiff(
          worlds.map((w) => w.coverage.shifted.fallbackRate),
          worlds.map((w) => w.coverage.inDist.fallbackRate)
        ),
        supportedGroups: summarise(worlds.map((w) => w.lookupSupportedGroups)),
        totalGroups: summarise(worlds.map((w) => w.lookupGroups)),
      }
    : null;

  /**
   * SELECTION USES THE IN-DISTRIBUTION SET, because that is what the rule declared in the header
   * says, and the rule was written before any of these numbers existed.
   *
   * The shifted set below is reported as evidence and is deliberately NOT used to select. Switching
   * the selection metric to the set that happens to separate the arms would be the original Day 5
   * error wearing better clothes: choose a procedure, look at several results, keep the one that gives
   * a clean answer. The shifted numbers can support or undermine the choice, and either way a reader
   * gets to see both.
   */
  const leader = inDist.table[0];
  let selected;
  let selectedBy;
  if (inDist.separated) {
    selected = leader.name;
    selectedBy = 'measurement';
  } else {
    // The tie is between every arm the leader cannot be distinguished from, not just the runner-up.
    // Comparing only the top two would let a third arm that is equally indistinguishable be dropped
    // purely for placing third on a mean the procedure has just admitted it cannot read.
    const tied = inDist.table
      .filter((r) => r.name === leader.name
        || Math.abs(pairedDiff(inDist.byArm[leader.name].normRegret, inDist.byArm[r.name].normRegret).t) < T_THRESHOLD)
      .map((r) => r.name);
    selected = PREFERENCE_ORDER.find((n) => tied.includes(n)) ?? leader.name;
    selectedBy = 'tiebreak';
    inDist.tied = tied;
  }

  return {
    seeds,
    count,
    worlds,
    inDist,
    shift,
    coverage,
    selected,
    selectedBy,
    // Kept at the top level because callers (and the Day 6 engine) read these directly.
    table: inDist.table,
    regretOrder: inDist.regretOrder,
    brierOrder: inDist.brierOrder,
    headToHead: inDist.headToHead,
    separated: inDist.separated,
    pairwise: inDist.pairwise,
  };
}

const pct = (v) => `${(v * 100).toFixed(2)}%`;

/**
 * Two-sided 95% critical values for small df, so the output can state the bar rather than expecting
 * the reader to look it up. Printed for context only; the rule uses the flat |t| >= 2.0 above,
 * because a threshold that moves with the seed count is a threshold I could tune.
 */
const T_CRIT_95 = {
  4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 14: 2.145, 19: 2.093, 29: 2.045,
};

function formatBlock(agg, seedCount, { label, note }) {
  const L = [];
  L.push(label);
  L.push('-'.repeat(label.length));
  if (note) L.push(note);
  L.push('');
  L.push('  arm        mean norm. regret     sd      mean rank   worlds won   mean Brier');
  for (const row of agg.table) {
    L.push(
      `  ${row.name.padEnd(9)} ${pct(row.regret.mean).padStart(16)}  ${pct(row.regret.sd).padStart(7)}  ` +
        `${row.meanRank.toFixed(2).padStart(10)}   ${String(`${row.worldsWon}/${seedCount}`).padStart(10)}   ` +
        `${row.brier.mean.toFixed(5)}`
    );
  }
  L.push('');
  L.push('  comparison               mean diff        se        t     wins');
  for (const p of agg.pairwise) {
    L.push(
      `  ${`${p.a} vs ${p.b}`.padEnd(24)} ${pct(p.meanDiff).padStart(9)} ${pct(p.se).padStart(9)} ` +
        `${p.t.toFixed(2).padStart(8)}   ${p.aWins}-${p.bWins}`
    );
  }
  L.push('');
  return L;
}

export function formatSelectionReport(r) {
  const L = [];
  const w0 = r.worlds[0];
  const n = r.seeds.length;

  L.push('Arm selection sweep — the reserved TEST batch is never generated');
  L.push('===============================================================');
  L.push(`  ${n} independently generated worlds x ${w0.counts.worldEvents} events`);
  L.push(`  per world: ${w0.counts.innerFitEvents} fit / ${w0.counts.tuneEvents} tune / ` +
    `${w0.counts.selectEvents} select (${w0.counts.selectRows} rows)`);
  if (r.shift) {
    L.push(`  plus a shifted scoring world: ${w0.counts.shiftedEvents} events ` +
      `(${w0.counts.shiftedRows} rows), TEST_PARAM_SHIFT applied`);
  }
  L.push('');
  L.push('  Regret is normalised per world as regret / best-available value, because absolute');
  L.push('  rupees are not comparable across worlds of different total value. Every comparison is');
  L.push('  PAIRED within a world: the between-world spread is large and shared by all arms, so the');
  L.push('  difference of the means would mostly be measuring which worlds got drawn.');
  L.push('');

  L.push(...formatBlock(r.inDist, n, {
    label: 'A. In distribution — fit and scored on the same world',
    note: '  This is the set the pre-declared selection rule reads.',
  }));

  L.push('Per-world normalised regret, in distribution');
  L.push('-------------------------------------------');
  L.push(`  seed        ${r.inDist.table.map((t) => t.name.padStart(9)).join('  ')}`);
  for (const world of r.worlds) {
    L.push(`  ${world.seed.padEnd(11)} ` +
      r.inDist.table.map((t) => pct(world.arms[t.name].normRegret).padStart(9)).join('  '));
  }
  L.push('');

  if (r.shift) {
    L.push(...formatBlock(r.shift, n, {
      label: 'B. Under distribution shift — fitted on one world, scored on a shifted one',
      note: '  Reported as evidence. NOT used to select: see the note in selectionSweep().',
    }));
  }

  const df = n - 1;
  const crit = T_CRIT_95[df];
  L.push(`  |t| >= ${T_THRESHOLD.toFixed(1)} is the pre-declared bar for "these arms are separable".` +
    (crit ? ` The two-sided 95% value at ${df} df is ${crit}.` : ''));
  L.push('');

  L.push('Decision');
  L.push('--------');
  const h = r.headToHead;
  L.push(`  Leader by mean in-distribution regret: ${h.leader}. Runner-up: ${h.runnerUp}.`);
  L.push(`  Paired difference ${pct(h.meanDiff)} +/- ${pct(h.se)} (se), t = ${h.t.toFixed(2)}, ` +
    `${h.leader} won ${h.aWins} of ${h.n} worlds.`);
  L.push('');

  if (r.selectedBy === 'measurement') {
    L.push(`  SELECTED: ${r.selected} — BY MEASUREMENT.`);
    L.push('  The paired difference clears the pre-declared bar, so the declared preference order');
    L.push('  never ran and had no influence on this result.');
  } else {
    L.push(`  SELECTED: ${r.selected} — BY TIEBREAK, NOT BY MEASUREMENT.`);
    L.push(`  ${r.inDist.tied?.length ?? 0} arms could not be separated at the pre-declared bar ` +
      `(${(r.inDist.tied ?? []).join(', ')}).`);
    L.push(`  The choice was made by the preference order declared before the sweep ran ` +
      `(${PREFERENCE_ORDER.join(' > ')}),`);
    L.push('  on the functional grounds that Day 6 must score candidate actions it has few or no fit');
    L.push('  rows for. This is a judgement call and is labelled as one. It is not a finding, and a');
    L.push('  reader who disagrees with the preference should discount it accordingly.');
  }
  L.push('');

  L.push('  In distribution — ranking by regret: ' + r.inDist.regretOrder.join(' > '));
  L.push('  In distribution — ranking by Brier:  ' + r.inDist.brierOrder.join(' > '));
  if (r.shift) {
    L.push('  Under shift    — ranking by regret: ' + r.shift.regretOrder.join(' > '));
    L.push('  Under shift    — ranking by Brier:  ' + r.shift.brierOrder.join(' > '));
  }
  L.push('');

  // ------------------------------------------------------------------------------------------
  // The two questions this command exists to answer, stated as measured findings rather than as
  // an invitation to read the tables and hope.
  // ------------------------------------------------------------------------------------------
  const idLogVsLookup = r.inDist.pairwise.find(
    (p) => (p.a === 'logistic' && p.b === 'lookup') || (p.a === 'lookup' && p.b === 'logistic')
  );
  const shLogVsLookup = r.shift?.pairwise.find(
    (p) => (p.a === 'logistic' && p.b === 'lookup') || (p.a === 'lookup' && p.b === 'logistic')
  );

  L.push('Did the ML layer beat the GROUP BY?');
  L.push('----------------------------------');
  const describe = (p, where) => {
    if (!p) return;
    // Orient the sign so it always reads "logistic minus lookup", whichever order the table put them
    // in. Left unoriented, the sign silently flips with the table ordering and the sentence reverses
    // its meaning — which is precisely the class of bug that put "a −11.0% reduction" beside a regret
    // that had gone up.
    const flip = p.a !== 'logistic';
    const meanDiff = flip ? -p.meanDiff : p.meanDiff;
    const t = flip ? -p.t : p.t;
    const logWins = flip ? p.bWins : p.aWins;
    const lookWins = flip ? p.aWins : p.bWins;
    const sep = Math.abs(t) >= T_THRESHOLD;
    L.push(`  ${where}: logistic − lookup = ${pct(meanDiff)} regret, t = ${t.toFixed(2)}, ` +
      `logistic won ${logWins}-${lookWins} of ${p.n} worlds.`);
    L.push(`    ${sep
      ? `Separable at the pre-declared bar, in favour of ${meanDiff < 0 ? 'logistic' : 'lookup'}.`
      : 'NOT separable at the pre-declared bar — on this evidence the two are equivalent.'}`);
  };
  describe(idLogVsLookup, 'In distribution');
  describe(shLogVsLookup, 'Under shift    ');
  L.push('');

  /**
   * WHY THESE TWO FLAGS EXIST INSTEAD OF A SENTENCE.
   *
   * Everything below used to open with the hard-coded words 'The regret answer above is "not
   * separable" on both sets'. That was true when it was written and stopped being true the moment
   * the retry-timing fix landed: the under-shift row crossed the bar (t = -2.46) while the prose two
   * screens down still announced that neither had, and still concluded that the ML layer "does not
   * earn its place on this generator by accuracy".
   *
   * This is the third instance in this project of one specific failure: a report that computes its
   * numbers honestly and then states a conclusion from memory. The Day 5 entry "The report generated
   * its own numbers and hard-coded its own conclusions" is the same bug, and the fix there was the
   * same as the fix here — the narrative has to be a function of the table, so that changing the
   * world changes the words. A report that cannot contradict its author is not evidence.
   *
   * The reason it is worth a comment rather than a quiet edit: a stale hard-coded conclusion is more
   * dangerous than a wrong number, because the number carries its own standard error and invites
   * scrutiny while the sentence sounds like a considered judgement.
   */
  const sepInDist = idLogVsLookup ? Math.abs(idLogVsLookup.t) >= T_THRESHOLD : false;
  const sepShift = shLogVsLookup ? Math.abs(shLogVsLookup.t) >= T_THRESHOLD : false;
  const sepCount = (sepInDist ? 1 : 0) + (sepShift ? 1 : 0);

  if (r.coverage) {
    const c = r.coverage;
    L.push(sepCount === 0
      ? '  The regret answer above is "not separable" on either set, so here is the mechanism measured'
      : sepCount === 2
        ? '  The regret answer above separates on both sets. The mechanism behind it, measured directly —'
        : `  The regret answer above separates ${sepShift ? 'under shift but NOT in distribution' :
            'in distribution but NOT under shift'}, which is itself a claim about the mechanism. Measured directly —`);
    L.push(sepCount === 0
      ? '  directly instead — how often the GROUP BY had no cell to read and served the base rate:'
      : '  how often the GROUP BY had no cell to read and served the base rate:');
    L.push('');
    L.push(`    in distribution   ${pct(c.inDist.mean)} of scored rows on a fallback ` +
      `(${pct(c.unseenInDist.mean)} on a cell never seen at all)`);
    L.push(`    under shift       ${pct(c.shifted.mean)} of scored rows on a fallback ` +
      `(${pct(c.unseenShifted.mean)} never seen at all)`);
    L.push(`    paired difference ${pct(c.paired.meanDiff)} +/- ${pct(c.paired.se)}, ` +
      `t = ${c.paired.t.toFixed(2)}, worse under shift in ${c.paired.aWins} of ${c.paired.n} worlds`);
    L.push(`    cells with real support: ${c.supportedGroups.mean.toFixed(1)} of ` +
      `${c.totalGroups.mean.toFixed(1)} populated`);
    L.push('');
    if (c.shifted.mean === 0 && c.inDist.mean === 0) {
      // Not a weak result — a clean negative one. Worth distinguishing in the output, because
      // "no effect detected" and "the proposed effect cannot occur here" are different findings and
      // only one of them justifies collecting more worlds.
      L.push('  FALSIFIED, and not merely unproven. The fallback rate is exactly zero on both sets, so');
      L.push('  the coverage story cannot be what is happening: the GROUP BY always has a cell to read.');
      L.push('  TEST_PARAM_SHIFT moves the payer mix, the rate of unmatchable error text and the amount');
      L.push('  distribution — it does not introduce new causes or new actions, so the SET of cells is');
      L.push('  identical on both sides and only the rates inside them move. With every cell populated');
      L.push('  there is no coverage to lose. More worlds would not have helped; the hypothesis was');
      L.push('  wrong, not underpowered.');
      L.push('');
      L.push('  A narrower version survives and this sweep cannot test it: the cells are all populated,');
      L.push('  but under shift each one averages over a different internal mix, so a stored cell mean is');
      L.push('  a stale average rather than a missing one. A model that reads amount and payer features');
      L.push('  can track that; a cell mean cannot. Separating rate-staleness from coverage-loss needs a');
      L.push('  shift that changes the cause mix itself, which is a Day 8-9 sensitivity job.');
      L.push('');
      if (sepShift && !sepInDist) {
        // The state the repo is actually in after the retry-timing fix, and the most interesting of
        // the three, so it says what the evidence supports and no more.
        L.push('  READ THE TWO SETS TOGETHER, BECAUSE THEY DISAGREE AND THE DISAGREEMENT IS THE RESULT.');
        L.push('  In distribution the GROUP BY is still not separably worse: with 66 cells and roughly');
        L.push(`  ${(w0.counts.innerFitEvents * 33).toLocaleString('en-IN')} fit rows it has enough data per cell to match anything fitted here, and`);
        L.push('  Day 5 claiming otherwise was reading one seed. Under shift it IS separably worse. Since');
        L.push('  the fallback rate is zero on both sets, the gap cannot be coverage — it is the stale-mean');
        L.push('  mechanism above: the cells still exist, but the population inside them has moved, and a');
        L.push('  stored mean cannot follow it while a model reading the features can.');
        L.push('');
        L.push('  WHAT THIS DOES NOT ESTABLISH. That a shift of this particular shape generalises. The');
        L.push('  shift moves the payer mix toward TEMPORARILY_SHORT (0.24 -> 0.27), and that is the only');
        L.push('  payer type whose recovery probability depends on WHEN a retry lands — so this is close to');
        L.push('  the best case for a model that reads timing features against a table that cannot. The');
        L.push('  honest claim is conditional: when the population moves in a way the features can see and');
        L.push('  the cell key cannot, the ML layer earns its place. That is a narrower claim than "ML');
        L.push('  wins", and it is the one the evidence supports.');
      } else if (sepCount === 0) {
        L.push('  The blunt reading of section A, stated plainly because it is the result: with 66 cells and');
        L.push(`  roughly ${(w0.counts.innerFitEvents * 33).toLocaleString('en-IN')} fit rows, a GROUP BY has enough data per cell to be as good as`);
        L.push('  anything I fitted. The ML layer does not earn its place on this generator by accuracy, and');
        L.push('  Day 5 claiming it did was reading one seed. What the ML layer does earn its place on is');
        L.push('  calibration under a value-weighted decision and the ability to score an action it has few');
        L.push('  rows for — both of which Day 6 exercises and neither of which this table measures.');
      } else {
        L.push('  The ML layer is separably better than the GROUP BY on ' +
          `${sepCount === 2 ? 'both sets' : 'the in-distribution set only'}, with a fallback rate of zero,`);
        L.push('  so the advantage is not coverage. It has to come from the features: the arms read columns');
        L.push('  the cell key cannot represent. Which columns, and whether the advantage survives a shift');
        L.push('  of a different shape, is a Day 8-9 question this sweep does not answer.');
      }
    } else if (Math.abs(c.paired.t) >= T_THRESHOLD) {
      L.push('  That difference IS separable, which makes the degradation a measured fact even though');
      L.push('  its effect on regret is not. The honest statement of the result is therefore narrow: the');
      L.push('  GROUP BY demonstrably loses coverage when the population moves, and on a world this size');
      L.push('  that loss of coverage is not yet large enough to show up in rupees. Two claims, one');
      L.push('  measured on the mechanism and one an admitted non-result, rather than one confident');
      L.push('  sentence spanning both.');
    } else {
      L.push('  That difference is not separable either, so the drift explanation is not established.');
      L.push('  It is recorded as an open question, not as a finding.');
    }
    L.push('');
    L.push('  Note what this makes visible regardless of the shift question: the lookup arm returns a');
    L.push('  probability for rows it has no cell for, and the caller cannot tell those apart from');
    L.push('  well-supported ones. Day 6 needs that distinction, because "low chance of recovery" and');
    L.push('  "no idea" should not produce the same decision.');
    L.push('');
  }

  L.push('Do Brier and regret rank the arms differently?');
  L.push('---------------------------------------------');
  if (r.inDist.regretOrder[0] !== r.inDist.brierOrder[0]) {
    L.push(`  In distribution, yes: Brier puts ${r.inDist.brierOrder[0]} first and regret puts ` +
      `${r.inDist.regretOrder[0]} first.`);
  } else {
    L.push(`  In distribution, no: both put ${r.inDist.regretOrder[0]} first across ${n} worlds.`);
    L.push('  Day 5 found them disagreeing on ONE seed, with a ₹1.5 lakh gap. Averaged over many');
    L.push('  worlds that disagreement does not survive, which makes the single-seed version a');
    L.push('  property of that seed rather than a general law. The MECHANISM stands — a pooled metric');
    L.push('  genuinely cannot see within-case ordering — but the magnitude was noise, and the Day 5');
    L.push('  write-up overstated it.');
  }
  L.push('');
  L.push('  The reserved TEST batch was not generated by this procedure and did not influence the');
  L.push('  choice above.');

  return L.join('\n');
}
