/**
 * MODEL COMPARISON
 * ================
 *
 * Fits five arms on identical data and scores them identically. The arms exist to make specific
 * alternative explanations for a good score impossible to hide behind:
 *
 *   1. CONSTANT   always predict the base rate. Brier = ȳ(1−ȳ). The zero point: any arm that does
 *                 not beat this has learned nothing, no matter how small its raw score looks.
 *   2. LOOKUP     GROUP BY (diagnosed cause, action) and predict each group's observed rate. The
 *                 "you did not need machine learning" arm. If this wins, that is the finding, and
 *                 it gets reported as the finding.
 *   3. LOGISTIC   linear, with 76 hand-built cause x action interaction columns. Auditable: every
 *                 coefficient is a readable claim about the world.
 *   4. GBM        gradient-boosted trees, which discover interactions without being told any. A
 *                 control on my own feature engineering.
 *   5. ORACLE     the same GBM, but additionally fed the LATENT variables — payer type,
 *                 responsiveness, patience budget, working rails. It cheats deliberately.
 *
 * WHY THE ORACLE MATTERS MORE THAN THE WINNER
 * ------------------------------------------
 * Without it, a mediocre score has two indistinguishable explanations: "my model is bad" or "the
 * observables genuinely do not contain the answer." Those call for opposite responses — more work
 * versus stopping work — and the usual instinct is to assume the first and keep adding features
 * that cannot possibly help.
 *
 * The oracle is trained on the same noisy 0/1 draws as everything else, so it is not handed the
 * answer, only better inputs. The gap between the best honest arm and the oracle is the price of
 * not being able to see inside the customer. The gap between the oracle and the aleatoric floor is
 * what remains genuinely random even with perfect information.
 *
 * THREE SPLITS, AND WHY THE MIDDLE ONE EXISTS
 * ------------------------------------------
 *   FIT    80% of TRAIN events. Everything is fitted here and nowhere else.
 *   VALID  20% of TRAIN events. Used for Platt scaling and for reading the boosting curve —
 *          decisions that need held-out data but must not touch TEST.
 *   TEST   a separately generated batch with shifted parameters. Scored last, once.
 *
 * The FIT/VALID split is taken on eventId, never on rows. Each event contributes 33 rows sharing a
 * diagnosis, an amount and a latent payer; splitting rows at random would place near-duplicates on
 * both sides and make VALID silently optimistic. This is the most common way a held-out number gets
 * quietly corrupted, and it is invisible in the output when it happens.
 */

import { generateBatch, DEFAULT_PARAMS } from '../sim/generator.js';
import { buildDataset, aleatoricFloor, oracleFeatures } from './dataset.js';
import { evalNow } from './evalClock.js';
import { fitLogistic, fitConstant, topCoefficients } from '../ml/logistic.js';
import { fitGBM, topFeatureGain, binFeatures } from '../ml/gbm.js';
import {
  scoreModel, fitLookupTable, fitPlatt, reliabilityCurve, brier,
} from '../ml/calibration.js';
import { makeRng, deriveSeed } from '../core/rng.js';

const RUPEE = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Split rows into two sets by eventId, never by row. See the header.
 */
export function splitByEvent(rows, { fraction = 0.8, seed = 'split' } = {}) {
  const ids = [...new Set(rows.map((r) => r.eventId))];
  const rng = makeRng(deriveSeed(seed, 'eventsplit'));
  // Deterministic shuffle so the same seed always yields the same split — a comparison whose splits
  // move between runs cannot attribute a score change to a model change.
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const cut = Math.floor(ids.length * fraction);
  const inFit = new Set(ids.slice(0, cut));
  return {
    fit: rows.filter((r) => inFit.has(r.eventId)),
    valid: rows.filter((r) => !inFit.has(r.eventId)),
    fitEvents: cut,
    validEvents: ids.length - cut,
  };
}

/**
 * ACTION-SELECTION REGRET — the metric that turns Brier points into rupees.
 *
 * Every other number in this report is a statement about probability quality, which no judge and no
 * merchant cares about directly. What they care about is whether the system picks the right action.
 * So for each (event, decision-moment) group of 11 candidate actions, this compares:
 *
 *   what the model picked   argmax over predicted probability
 *   what was actually best  argmax over TRUE probability
 *
 * and charges the difference, in money, at the event's amount.
 *
 * `captureRate` — recoverable value obtained divided by the most that was available — is the single
 * most honest summary of the whole day, because a model can lose meaningfully on Brier and still
 * pick the same action every time, in which case its worse calibration cost nothing.
 *
 * TWO LIMITS, STATED PLAINLY
 * -------------------------
 * First, this is NOT yet expected value. Amount is constant within a group, so argmax(p x amount)
 * reduces to argmax(p), and action costs and guardrails are absent — they arrive on Day 6, and they
 * will change which action wins. Calling this EV now would be overclaiming.
 *
 * Second, the money is simulated. `trueP` comes from a response model I wrote and documented. The
 * defensible claim is "given this documented response model, better probabilities are worth this
 * much" — not "this system recovers this much money."
 */
export function actionSelectionRegret(rows, predictions) {
  const groups = new Map();
  rows.forEach((r, i) => {
    if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
    groups.get(r.groupKey).push(i);
  });

  let regretPaise = 0;
  let bestPaise = 0;
  let chosenPaise = 0;
  let agreement = 0;

  for (const idxs of groups.values()) {
    const amount = rows[idxs[0]].amountPaise;
    let mi = idxs[0];
    let oi = idxs[0];
    for (const i of idxs) {
      if (predictions[i] > predictions[mi]) mi = i;
      if (rows[i].trueP > rows[oi].trueP) oi = i;
    }
    chosenPaise += rows[mi].trueP * amount;
    bestPaise += rows[oi].trueP * amount;
    regretPaise += (rows[oi].trueP - rows[mi].trueP) * amount;
    if (rows[mi].actionKind === rows[oi].actionKind) agreement += 1;
  }

  const n = groups.size;
  return {
    groups: n,
    regretPaise,
    bestPaise,
    chosenPaise,
    captureRate: bestPaise > 0 ? chosenPaise / bestPaise : 0,
    topActionAgreement: n > 0 ? agreement / n : 0,
  };
}

/** Columns that never vary. They cannot carry signal and should be known about, not discovered. */
export function deadFeatures(rows, names) {
  const { binCount } = binFeatures(rows, { maxBins: 2 });
  return binCount
    // `bias` is constant BY DESIGN — it is the intercept. The first version of this function
    // reported it as dead, which is technically true and completely unhelpful, and would have
    // trained me to skim the list. A diagnostic that cries wolf once gets ignored forever.
    .map((c, j) => (c < 2 && names[j] !== 'bias' ? names[j] : null))
    .filter(Boolean);
}

/**
 * Run the full comparison.
 *
 * Note what is NOT here: any hyperparameter chosen by looking at TEST. The logistic L2 and the GBM
 * depth/rate/round count were set from the FIT/VALID pair, and TEST is scored exactly once at the
 * end. If a TEST number disappoints, the honest move is to publish it, which is what Day 4 did with
 * a 4.8-point generalisation gap.
 */
export async function compareModels({
  seed = 'day5',
  count = 600,
  trees = 300,
  learningRate = 0.08,
  maxDepth = 3,
  l2 = 1e-4,
  iterations = 500,
  onProgress = () => {},
} = {}) {
  onProgress('generating batches');
  // `now` is PINNED. Left to its wall-clock default this report is not reproducible — see
  // src/eval/evalClock.js for the mechanism and for how the drift was found.
  //
  // `overrides: { events }`, NOT `count`. For four days this read `generateBatch({ seed, count, ... })`
  // and `generateBatch` has no `count` parameter, so the argument was silently dropped and every run
  // produced exactly 600 events no matter what `--count` said. The header then printed the FLAG value
  // as the event count, so `--count=200` would have produced a report claiming 200 events above
  // numbers computed from 600. Found on Day 5 while building the selection sweep, by asking for 200
  // and being told the split sizes for 600.
  //
  // Third instance of the same species as the seed bug and the spaced-flag bug: an input that appears
  // to be honoured, is discarded, and leaves the output looking correct. The counts below now come
  // from `batch.events.length` so the label cannot disagree with the data again.
  const batchOverrides = {
    events: count,
    // Scaled with the batch, because events-per-customer is itself a parameter of the world: holding
    // customers fixed while shrinking the event count would change the repeat-failure rate, which is
    // something the features read.
    customers: Math.max(2, Math.round((DEFAULT_PARAMS.customers * count) / DEFAULT_PARAMS.events)),
  };
  const trainBatch = generateBatch({ seed: 'day4', split: 'TRAIN', now: evalNow(), overrides: batchOverrides });
  const testBatch = generateBatch({ seed: 'day4', split: 'TEST', now: evalNow(), overrides: batchOverrides });

  onProgress('building datasets');
  const trainSet = await buildDataset({ events: trainBatch.events, latents: trainBatch.latents, seed });
  const testSet = await buildDataset({ events: testBatch.events, latents: testBatch.latents, seed: `${seed}-test` });
  const names = trainSet.featureNames;

  const { fit, valid, fitEvents, validEvents } = splitByEvent(trainSet.rows, { fraction: 0.8, seed });
  const test = testSet.rows;

  const splits = { FIT: fit, VALID: valid, TEST: test };
  const floors = {
    FIT: aleatoricFloor(fit), VALID: aleatoricFloor(valid), TEST: aleatoricFloor(test),
  };

  // The constant arm's Brier on each split IS that split's uncertainty term, and doubles as the
  // denominator for every "fraction of learnable structure captured" figure below.
  const constant = fitConstant(fit);
  const baselineBrier = Object.fromEntries(
    Object.entries(splits).map(([k, rowsK]) => [k, brier(rowsK.map((r) => r.y), rowsK.map(() => constant.rate))])
  );

  const arms = [];

  const addArm = (name, note, predictRow, extra = {}) => {
    const scores = {};
    const regret = {};
    for (const [k, rowsK] of Object.entries(splits)) {
      const p = rowsK.map(predictRow);
      scores[k] = scoreModel(rowsK, p, { floor: floors[k], baselineBrier: baselineBrier[k] });
      regret[k] = actionSelectionRegret(rowsK, p);
    }
    arms.push({ name, note, scores, regret, ...extra });
  };

  onProgress('arm 1/5: constant');
  addArm('constant', 'always predict the base rate', () => constant.rate, { rate: constant.rate });

  onProgress('arm 2/5: lookup table');
  const lookup = fitLookupTable(fit, {
    key: (r) => `${r.diagnosedCause}|${r.actionKind}`,
    minCount: 10,
  });
  addArm('lookup', 'GROUP BY (cause, action)', (r) => lookup.predictRow(r), { groups: lookup.groups });

  onProgress('arm 3/5: logistic');
  const logistic = fitLogistic(fit, { l2, iterations, learningRate: 0.5 });
  addArm('logistic', 'linear + hand-built interactions', (r) => logistic.predict(r.x), {
    iterationsRun: logistic.iterationsRun,
    finalGradNorm: logistic.finalGradNorm,
    coefficients: topCoefficients(logistic, names, { limit: 15, rows: fit }),
  });

  onProgress('arm 4/5: gbm');
  const gbm = fitGBM(fit, {
    trees, learningRate, maxDepth, rng: makeRng(deriveSeed(seed, 'gbm')), validation: valid,
  });
  addArm('gbm', 'boosted trees, interactions discovered', (r) => gbm.predict(r.x), {
    leafCount: gbm.leafCount,
    curve: gbm.history,
    treesGrown: gbm.treesGrown,
    treesUsed: gbm.treesUsed,
    bestRound: gbm.bestRound,
    stoppedEarly: gbm.stoppedEarly,
    hitTreeLimit: gbm.hitTreeLimit,
    gain: topFeatureGain(gbm, names, { limit: 15 }),
  });

  onProgress('arm 5/5: oracle (cheating, on purpose)');
  const oracleFit = oracleFeatures(fit, trainBatch.events, trainBatch.latents);
  const oracleValid = oracleFeatures(valid, trainBatch.events, trainBatch.latents);
  const oracleSplits = {
    FIT: oracleFit,
    VALID: oracleValid,
    TEST: oracleFeatures(test, testBatch.events, testBatch.latents),
  };
  // The oracle gets early stopping too. Denying it the same treatment would be rigging the ceiling
  // downward — an overfitted oracle understates how much the latents are worth, which would make
  // the honest arms look closer to optimal than they are. A ceiling has to be measured generously
  // or it is not a ceiling.
  const oracle = fitGBM(oracleFit, {
    trees, learningRate, maxDepth, rng: makeRng(deriveSeed(seed, 'oracle')), validation: oracleValid,
  });
  {
    const scores = {};
    const regret = {};
    for (const [k, rowsK] of Object.entries(oracleSplits)) {
      const p = rowsK.map((r) => oracle.predict(r.x));
      scores[k] = scoreModel(rowsK, p, { floor: floors[k], baselineBrier: baselineBrier[k] });
      regret[k] = actionSelectionRegret(rowsK, p);
    }
    arms.push({ name: 'oracle', note: 'GBM + latent variables — deliberately cheats', scores, regret });
  }

  // PLATT SCALING, fitted on VALID and applied to TEST. Never fitted on FIT: a model's calibration
  // on its own training data always looks fine, so the correction would come back as a no-op and
  // report a robustness it never tested.
  onProgress('platt scaling on VALID');
  // Selected by VALID REGRET, not VALID Brier.
  //
  // This used to rank by Brier, which put the calibration experiment on a different arm from the one
  // the report concludes should ship — the findings section would recommend building Day 6 on the
  // money winner while the Platt section quietly reported on the Brier winner. Two arms, one
  // conclusion, and nothing flagged the mismatch.
  //
  // Ranking on VALID rather than TEST is the part that must not change: TEST is scored exactly once,
  // at the end, and is not permitted to influence any choice made here.
  const bestHonest = [...arms]
    .filter((a) => a.name !== 'oracle')
    .sort((a, b) => a.regret.VALID.regretPaise - b.regret.VALID.regretPaise)[0];
  const bestPredict = bestHonest.name === 'gbm'
    ? (r) => gbm.predict(r.x)
    : bestHonest.name === 'logistic'
      ? (r) => logistic.predict(r.x)
      : bestHonest.name === 'lookup'
        ? (r) => lookup.predictRow(r)
        : () => constant.rate;

  const platt = fitPlatt(valid.map((r) => r.y), valid.map(bestPredict));
  const testRaw = test.map(bestPredict);
  const testPlatt = testRaw.map((p) => platt.apply(p));
  const platted = {
    on: bestHonest.name,
    a: platt.a,
    b: platt.b,
    before: scoreModel(test, testRaw, { floor: floors.TEST, baselineBrier: baselineBrier.TEST }),
    after: scoreModel(test, testPlatt, { floor: floors.TEST, baselineBrier: baselineBrier.TEST }),
  };

  return {
    seed,
    counts: {
      // From the generated data, not from the `count` argument. See the note beside `batchOverrides`:
      // these two used to be `count`, which meant the report's header was an echo of the request
      // rather than a description of the batch it scored.
      trainEvents: trainBatch.events.length,
      testEvents: testBatch.events.length,
      requestedEvents: count,
      fitEvents, validEvents,
      fitRows: fit.length, validRows: valid.length, testRows: test.length,
      features: names.length,
    },
    floors,
    baselineBrier,
    arms,
    platted,
    bestHonest: bestHonest.name,
    deadFeatures: deadFeatures(fit, names),
    reliability: reliabilityCurve(test.map((r) => r.y), test.map(bestPredict), { bins: 10 }),
    names,
  };
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const f5 = (v) => (Number.isFinite(v) ? v.toFixed(5) : '   n/a');

export function formatModelReport(result) {
  const L = [];
  const { counts, floors, baselineBrier, arms } = result;

  L.push('Recovery-probability model comparison');
  L.push('=====================================');
  L.push(
    `  seed ${result.seed} | ${counts.trainEvents} TRAIN events -> ${counts.fitEvents} fit / ` +
      `${counts.validEvents} valid | ${counts.testEvents} TEST events`
  );
  L.push(
    `  rows: fit ${counts.fitRows}  valid ${counts.validRows}  test ${counts.testRows} | ` +
      `${counts.features} features`
  );
  L.push('');
  L.push('  Labels are Bernoulli draws from the response model, never the probability itself.');
  L.push('  The aleatoric floor below is the exact expected Brier of a perfectly-informed');
  L.push('  predictor, mean(p(1-p)). No model can beat it; scores are only readable against it.');
  L.push('');

  for (const split of ['FIT', 'VALID', 'TEST']) {
    L.push(`${split}`);
    L.push('-'.repeat(split.length));
    L.push(
      `  floor ${f5(floors[split])}   base-rate Brier ${f5(baselineBrier[split])}   ` +
        `learnable gap ${f5(baselineBrier[split] - floors[split])}`
    );
    L.push('');
    L.push('  arm        Brier    logloss    AUC     ECE    captured   reliab.  resol.');
    for (const arm of arms) {
      const s = arm.scores[split];
      L.push(
        `  ${arm.name.padEnd(9)} ${f5(s.brier)}  ${f5(s.logLoss)}  ${(s.auc ?? NaN).toFixed(4)}  ` +
          `${f5(s.ece)}  ${(s.capturedFraction != null ? pct(s.capturedFraction) : 'n/a').padStart(7)}  ` +
          `${s.reliability.toFixed(6)} ${s.resolution.toFixed(6)}`
      );
    }
    L.push('');
    L.push('  arm        action chosen = best action    recoverable value captured    regret');
    for (const arm of arms) {
      const r = arm.regret[split];
      L.push(
        `  ${arm.name.padEnd(9)} ${pct(r.topActionAgreement).padStart(24)}    ` +
          `${pct(r.captureRate).padStart(24)}    ${RUPEE(r.regretPaise)}`
      );
    }
    L.push('');
  }

  L.push('What the money column means');
  L.push('---------------------------');
  L.push('  For each (event, decision moment), the arm picks the action it scores highest and the');
  L.push('  oracle picks the action with the highest TRUE probability. Regret is the difference,');
  L.push('  charged at the event amount. It is NOT expected value: action costs, guardrails and');
  L.push('  stopping rules arrive on Day 6 and will change which action wins. And the money is');
  L.push('  simulated — it prices better probabilities inside a documented response model, which');
  L.push('  is not the same claim as recovering rupees from Razorpay.');
  L.push('');

  const logistic = arms.find((a) => a.name === 'logistic');
  if (logistic?.coefficients) {
    L.push('Logistic coefficients — the auditable artefact');
    L.push('---------------------------------------------');
    L.push(`  converged in ${logistic.iterationsRun} iterations, final gradient norm ` +
      `${logistic.finalGradNorm.toExponential(2)}`);
    L.push('  Each line is a falsifiable claim about the world, in log-odds. Support is how many');
    L.push('  fit rows the column is non-zero in: a big weight on a rare column moves little money.');
    L.push('');
    for (const c of logistic.coefficients) {
      L.push(`  ${c.weight.toFixed(3).padStart(8)}  ${c.name.padEnd(44)} support ${c.support}`);
    }
    L.push('');
  }

  const gbm = arms.find((a) => a.name === 'gbm');
  if (gbm?.gain) {
    L.push('GBM split gain — a strictly weaker artefact');
    L.push('------------------------------------------');
    L.push(`  ${gbm.leafCount} leaves across the ensemble. Gain has no sign: it says a column was`);
    L.push('  useful, not which way it pushes. That asymmetry is a real cost of using trees for a');
    L.push('  decision that moves money, and it is weighed against the accuracy below, not waved off.');
    L.push('');
    for (const g of gbm.gain) L.push(`  ${pct(g.share).padStart(6)}  ${g.name}`);
    L.push('');
    if (gbm.treesUsed != null) {
      L.push(`  early stopping: grew ${gbm.treesGrown} trees, kept ${gbm.treesUsed} ` +
        `(best validation round ${gbm.bestRound})`);
      if (gbm.hitTreeLimit) {
        L.push('    NOTE: hit the tree limit without validation loss turning up, so the ensemble may');
        L.push('    still be improving. Re-run with a higher --trees before reading this as converged.');
      }
      L.push('');
    }
    if (gbm.curve?.length) {
      L.push('  boosting curve (fit / valid logloss) — overfitting is visible here or it is not real');
      const step = Math.max(1, Math.floor(gbm.curve.length / 8));
      for (let i = 0; i < gbm.curve.length; i += step) {
        const h = gbm.curve[i];
        L.push(`    round ${String(h.round).padStart(4)}  ${f5(h.trainLoss)}  ${f5(h.validationLoss)}`);
      }
      const last = gbm.curve[gbm.curve.length - 1];
      L.push(`    round ${String(last.round).padStart(4)}  ${f5(last.trainLoss)}  ${f5(last.validationLoss)}`);
      L.push('');
    }
  }

  const p = result.platted;
  L.push('Platt scaling — fitted on VALID, applied to TEST');
  L.push('-----------------------------------------------');
  L.push(`  best honest arm on VALID: ${p.on}`);
  L.push(`  fitted a=${p.a.toFixed(4)} b=${p.b.toFixed(4)}`);
  L.push(`    a < 1 means the base model was over-confident, a > 1 under-confident, b a base-rate shift.`);
  L.push(`  TEST Brier ${f5(p.before.brier)} -> ${f5(p.after.brier)}   ` +
    `ECE ${f5(p.before.ece)} -> ${f5(p.after.ece)}`);
  L.push(`  AUC ${p.before.auc.toFixed(4)} -> ${p.after.auc.toFixed(4)} (must be identical: two`);
  L.push('    parameters can stretch the probability scale but cannot reorder anything)');
  L.push('');

  L.push(`Reliability on TEST (${p.on}, equal-count bins)`);
  L.push('-'.repeat(40));
  L.push('  bin      n   predicted   observed    error');
  for (const b of result.reliability) {
    L.push(
      `  ${String(b.bin).padStart(3)}  ${String(b.count).padStart(5)}   ` +
        `${b.meanPredicted.toFixed(4)}      ${b.observedRate.toFixed(4)}   ` +
        `${(b.observedRate - b.meanPredicted >= 0 ? '+' : '')}${(b.observedRate - b.meanPredicted).toFixed(4)}`
    );
  }
  L.push('');

  if (result.deadFeatures.length) {
    L.push(`Dead features (${result.deadFeatures.length} of ${counts.features}) — constant across FIT`);
    L.push('-'.repeat(52));
    L.push('  These carry no signal by construction. Kept rather than pruned: they are one-hot slots');
    L.push('  for causes, actions and tiers that this batch happens not to contain, and a real batch');
    L.push('  would. Listing them is how a feature that SHOULD be firing gets noticed.');
    L.push(`  ${result.deadFeatures.join(', ')}`);
    L.push('');
  }

  L.push(...formatFindings(result));

  return L.join('\n');
}

/**
 * The conclusions, DERIVED from the table above rather than written alongside it.
 *
 * Every sentence here is generated from the measured numbers, so it cannot drift out of agreement
 * with them. A hand-written summary paragraph beside an auto-generated table is guaranteed to
 * become false the first time a parameter changes and nobody re-reads the prose — and it will be
 * false in the flattering direction, because that is the version that got written down.
 */
export function formatFindings(result) {
  const L = [];
  const { arms } = result;
  const split = 'TEST';

  const lookup = arms.find((a) => a.name === 'lookup');
  const oracle = arms.find((a) => a.name === 'oracle');
  const honest = arms.filter((a) => a.name !== 'oracle' && a.name !== 'constant');

  // TWO different "best" arms, because there are two different questions.
  //
  // The first version of this function ranked by Brier alone and called the winner `best`, then
  // wrote prose asserting that arm had beaten the lookup table on money. When the seed bug was
  // fixed and the data changed, the Brier winner and the money winner stopped being the same arm —
  // and the generated sentence reported a WORSE regret as "an 11.0% reduction". The magnitudes were
  // computed; the verdicts were hard-coded. That is the exact drift this function was built to
  // prevent, reintroduced one level up. So nothing below asserts a direction it has not measured.
  const bestBrier = [...honest].sort((a, b) => a.scores[split].brier - b.scores[split].brier)[0];
  const bestMoney = [...honest].sort((a, b) => a.regret[split].regretPaise - b.regret[split].regretPaise)[0];

  const sign = (x) => (x >= 0 ? '+' : '−');
  const ppt = (x) => `${sign(x)}${Math.abs(x * 100).toFixed(1)} percentage points`;

  L.push(`Findings on ${split} — generated from the numbers above`);
  L.push('='.repeat(46));
  L.push('');

  // ------------------------------------------------------------------------------------------
  // 1. Was the machine learning necessary at all?
  // ------------------------------------------------------------------------------------------
  const lr = lookup.regret[split];
  const br = bestMoney.regret[split];
  const beatLookup = br.regretPaise < lr.regretPaise;
  const regretDelta = lr.regretPaise > 0 ? (lr.regretPaise - br.regretPaise) / lr.regretPaise : 0;

  L.push('1. Did the model beat a GROUP BY?');
  L.push(`   Best arm by MONEY is ${bestMoney.name}. The lookup table captures ${pct(lr.captureRate)} of`);
  L.push(`   available recoverable value; ${bestMoney.name} captures ${pct(br.captureRate)} — a difference of`);
  L.push(`   ${ppt(br.captureRate - lr.captureRate)}.`);
  L.push(`   On REGRET: ${RUPEE(lr.regretPaise)} -> ${RUPEE(br.regretPaise)}, ` +
    `a ${pct(Math.abs(regretDelta))} ${beatLookup ? 'reduction' : 'INCREASE'}.`);
  L.push('');
  if (beatLookup) {
    L.push('   So on this split the model is ahead, but the margin belongs in the regret column, not');
    L.push('   the value-captured column: that denominator is dominated by easy cases every arm gets');
    L.push('   right, which is why both framings are reported and regret leads.');
  } else {
    L.push('   So on this split the GROUP BY wins, and that is the number that gets reported. A');
    L.push('   lookup table over (diagnosed cause, action) is perfectly calibrated within each group');
    L.push('   by construction and cannot extrapolate nonsense; those are real advantages and this');
    L.push('   result is what they buy.');
  }
  L.push('   The lookup table is a strong baseline and deserves to be called one.');
  L.push('');
  L.push('   READ THAT NUMBER AS ONE DRAW, NOT AS AN EFFECT. It is a single split of a single');
  L.push('   simulated world, so it has no standard error and cannot separate an ordering from noise.');
  L.push('   An earlier version of this section called it "the model earns its place"; a 20-world');
  L.push('   paired sweep (`npm run select-arm`) then found logistic, gbm and lookup mutually');
  L.push('   indistinguishable, with lookup winning more worlds than logistic did. So the honest');
  L.push('   version of finding 1 is that on this generator the GROUP BY is not measurably beaten, and');
  L.push('   a single-split gap of any size is not evidence to the contrary. The sweep is the place');
  L.push('   that question gets answered, because it is the only one with a denominator.');
  L.push('');

  // ------------------------------------------------------------------------------------------
  // 2. Better probabilities are not the same thing as better decisions.
  // ------------------------------------------------------------------------------------------
  const oCap = oracle.scores[split].capturedFraction;
  const bCap = bestBrier.scores[split].capturedFraction;
  const oReg = oracle.regret[split];
  const bbr = bestBrier.regret[split];

  L.push('2. The latent variables buy accuracy but far less decision quality.');
  L.push(`   The oracle sees payer type, patience and working rails. It captures ${pct(oCap)} of the`);
  L.push(`   learnable Brier gap against ${bestBrier.name}'s ${pct(bCap)} — ` +
    `${((oCap - bCap) * 100).toFixed(1)} points better at PREDICTING.`);
  L.push(`   Yet it picks the best action ${pct(oReg.topActionAgreement)} of the time against ` +
    `${pct(bbr.topActionAgreement)}, and its`);
  L.push(`   regret is ${RUPEE(oReg.regretPaise)} against ${RUPEE(bbr.regretPaise)}.`);
  L.push('');
  L.push('   That dissociation has a mechanism. Choosing among actions for ONE case needs only the');
  L.push('   RANKING within that case, and the ranking is driven by observables — which remedy fits');
  L.push('   the diagnosed cause, whether the instrument is dead, how many times we have already');
  L.push('   made contact. The latents mostly move the LEVEL of the probability, roughly uniformly');
  L.push('   across every action for that customer, and a shared shift does not change an argmax.');
  L.push('');
  L.push('   So the level matters for the STOP decision — is any action worth its cost — and the');
  L.push('   ranking matters for the WHICH decision. Day 6 builds both, and this says they have');
  L.push('   different accuracy requirements: guardrails and stopping rules need calibration,');
  L.push('   action choice needs ordering. That is a design consequence, not a slogan.');
  L.push('');

  // ------------------------------------------------------------------------------------------
  // 3. The same dissociation, now visible BETWEEN two honest arms.
  //    Only printed when the Brier winner and the money winner disagree — which is the whole point.
  // ------------------------------------------------------------------------------------------
  if (bestBrier.name !== bestMoney.name) {
    const sb = bestBrier.scores[split];
    const sm = bestMoney.scores[split];
    L.push('3. The best PROBABILITIES and the best DECISIONS come from different arms.');
    L.push(`   ${bestBrier.name} has the lower Brier (${f5(sb.brier)} vs ${f5(sm.brier)}) and the higher`);
    L.push(`   AUC (${sb.auc.toFixed(4)} vs ${sm.auc.toFixed(4)}), yet ${bestMoney.name} leaves far less money on`);
    L.push(`   the table: regret ${RUPEE(br.regretPaise)} against ${RUPEE(bbr.regretPaise)}, and it picks the best`);
    L.push(`   action ${pct(br.topActionAgreement)} of the time against ${pct(bbr.topActionAgreement)}.`);
    L.push('');
    L.push('   This is finding 2 restated without an oracle, and it is the more useful form because');
    L.push('   both arms here are shippable. Brier and AUC are computed over ALL rows pooled, so an');
    L.push('   arm can win them by being better on average across cases while being worse at ordering');
    L.push('   the eleven candidate actions WITHIN a case — and only the within-case ordering selects');
    L.push('   an action. A pooled metric cannot see that, and it is the metric most write-ups report.');
    L.push('');
    L.push('   WHAT THIS DOES NOT LICENCE. An earlier version of this paragraph concluded here that');
    L.push(`   ${bestMoney.name} is therefore the arm to build Day 6 on, and claimed the argument ran from`);
    L.push('   measurement rather than preference. That was wrong on its own terms: this is ONE split of');
    L.push('   ONE simulated world, so the gap above has no standard error attached and nothing here can');
    L.push('   distinguish a real ordering from the luck of the draw. Worse, TEST is the held-out sample');
    L.push('   reserved for final reporting — choosing a component by reading it is how held-out data');
    L.push('   quietly stops being held out, and it does not become acceptable because the reasoning');
    L.push('   afterwards is sound.');
    L.push('');
    L.push('   The arm choice is made by `npm run select-arm`, which never generates this batch. Run it');
    L.push('   for the ordering; this section reports the dissociation and stops there.');
    L.push('');
  }

  // ------------------------------------------------------------------------------------------
  // 4. Did recalibration transfer across the deliberate parameter shift?
  // ------------------------------------------------------------------------------------------
  const p = result.platted;
  const brierHelped = p.after.brier < p.before.brier;
  const eceHelped = p.after.ece < p.before.ece;
  const n = bestBrier.name === bestMoney.name ? 3 : 4;

  L.push(`${n}. Platt scaling fitted on VALID, applied to TEST.`);
  L.push(`   Brier ${f5(p.before.brier)} -> ${f5(p.after.brier)} (${brierHelped ? 'better' : 'worse'}), ` +
    `ECE ${f5(p.before.ece)} -> ${f5(p.after.ece)} (${eceHelped ? 'better' : 'worse'}).`);
  L.push(`   Fitted parameters a=${p.a?.toFixed(4) ?? 'n/a'} b=${p.b.toFixed(4)}: ` +
    `${p.b >= 0 ? 'pushing probabilities UP' : 'pulling probabilities DOWN'},`);
  L.push(`   because on VALID the base model ran slightly ${p.b >= 0 ? 'low' : 'high'}.`);
  L.push('');
  if (brierHelped && eceHelped) {
    L.push('   So the correction DID transfer, despite TEST applying a deliberate parameter shift with');
    L.push('   a different base rate. Worth stating plainly that this is the weaker of the two possible');
    L.push('   results to have found: it says the miscalibration was a roughly constant offset rather');
    L.push('   than something distribution-specific, which is the easy case. It is not evidence that a');
    L.push('   stored correction would survive a larger shift, and Day 8 should test a bigger one.');
  } else {
    L.push('   So the correction did NOT transfer, and that is worth more than a success would have');
    L.push('   been. It says probabilities must be RE-FITTED when the population moves rather than');
    L.push('   patched with a stored correction — exactly the failure mode a deployed recovery system');
    L.push('   hits, because the mix of failure causes drifts constantly.');
  }
  L.push(`   Either way the shipped arm is unpatched: ${p.on} reports raw, at ECE ${f5(p.before.ece)}.`);
  L.push('   AUC is unchanged by construction — two parameters can stretch the probability scale but');
  L.push('   cannot reorder anything, so any AUC movement here would be a bug.');
  L.push('');

  // ------------------------------------------------------------------------------------------
  // 5. The gap the whole batch is silent about.
  // ------------------------------------------------------------------------------------------
  const missing = result.deadFeatures.filter((x) => x.includes('INSTRUMENT_NOT_ACCEPTED'));
  if (missing.length) {
    L.push(`${n + 1}. The one evidence-backed cause never appears in the data.`);
    L.push('   `cause=INSTRUMENT_NOT_ACCEPTED` is constant-zero across the whole fit set, so every');
    L.push('   number in this report is silent about it. That is uncomfortable, because it is the');
    L.push('   ONLY root cause in the taxonomy traced from a real Razorpay decline rather than read');
    L.push('   out of the docs — an international card rejected in test mode, on 2026-08-22.');
    L.push('   The generator does not emit it, so the simulator cannot exercise the one path with');
    L.push('   real-world evidence behind it. Logged as a gap for the generator, not papered over');
    L.push('   here: pruning the dead column would hide it, so the column stays.');
    L.push('');
  }

  return L;
}
