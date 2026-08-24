/**
 * ML LAYER TESTS
 * ==============
 *
 * The model report prints numbers. This file exists to establish that the functions producing those
 * numbers are correct, because a metric function that is subtly wrong produces a report that is
 * confidently wrong, and nothing about the output would look suspicious.
 *
 * Three kinds of test here, and the distinction matters:
 *
 *   1. HAND-COMPUTED. Small vectors where the right answer was worked out on paper, independently of
 *      the implementation. These are the only tests that can catch a formula error — a test that
 *      compares the code against itself catches typos and nothing else.
 *
 *   2. MATHEMATICAL IDENTITIES. Facts that must hold for any correct implementation: a constant
 *      predictor's Brier score is exactly p̄(1−p̄); Platt scaling cannot change AUC because it is
 *      monotone; the Brier decomposition must recompose to the Brier score. These catch errors the
 *      hand-computed cases are too small to expose.
 *
 *   3. REGRESSION PINS. Bugs that actually happened during Day 5, each one now unable to return
 *      silently. Marked REGRESSION below with the story attached.
 *
 * Run: node --test test/ml.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sigmoid, dot, fitLogistic, fitConstant, predictAll, topCoefficients } from '../src/ml/logistic.js';
import {
  brier, logLoss, auc, reliabilityCurve, expectedCalibrationError,
  brierDecomposition, fitPlatt, scoreModel, fitLookupTable,
} from '../src/ml/calibration.js';
import { binFeatures, fitGBM, topFeatureGain, renderTree } from '../src/ml/gbm.js';
import { featureNames, salaryWindowProximity, FEATURE_COUNT } from '../src/ml/features.js';
import { splitByEvent, actionSelectionRegret, deadFeatures } from '../src/eval/modelComparison.js';
import { buildDataset, aleatoricFloor } from '../src/eval/dataset.js';
import { evalNow, EVAL_NOW } from '../src/eval/evalClock.js';
import { generateBatch } from '../src/sim/generator.js';
import { makeRng } from '../src/core/rng.js';

/** Tolerance for "the same real number", when floating point is the only source of difference. */
const FP = 1e-12;
const near = (actual, expected, tol, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label ?? 'value'}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)}, tol ${tol})`
  );
};

// ---------------------------------------------------------------------------------------------
// 1. HAND-COMPUTED METRICS
//
// One shared vector, worked out by hand, used by four metrics. Sharing it is deliberate: the same
// four numbers producing four different correct answers is a stronger check than four unrelated
// cases, because a mistake in how predictions are paired with labels would break some and not others.
//
//   y = [1, 0, 1, 0]
//   p = [0.8, 0.3, 0.6, 0.1]
// ---------------------------------------------------------------------------------------------

const Y = [1, 0, 1, 0];
const P = [0.8, 0.3, 0.6, 0.1];

test('brier matches the hand computation', () => {
  // (0.8−1)² + (0.3−0)² + (0.6−1)² + (0.1−0)²  =  0.04 + 0.09 + 0.16 + 0.01  =  0.30
  // 0.30 / 4 = 0.075
  near(brier(Y, P), 0.075, FP, 'brier');
});

test('logLoss matches the hand computation', () => {
  // −ln(0.8) − ln(0.7) − ln(0.6) − ln(0.9), all divided by 4.
  //  0.22314355131420976
  // +0.35667494393873245
  // +0.51082562376599070
  // +0.10536051565782628
  // =1.19600463467675920  /4 = 0.2990011586691898
  near(logLoss(Y, P), 0.2990011586691898, 1e-15, 'logLoss');
});

test('auc is 1.0 when every positive outranks every negative', () => {
  // positives {0.8, 0.6}, negatives {0.3, 0.1}. All four cross-pairs favour the positive.
  near(auc(Y, P), 1.0, FP, 'auc');
});

test('auc credits ties at exactly one half', () => {
  // y = [1,1,0,0], p = [0.9,0.1,0.9,0.1]. Four (positive, negative) pairs:
  //   0.9 vs 0.9  tie   → 0.5
  //   0.9 vs 0.1  win   → 1.0
  //   0.1 vs 0.9  loss  → 0.0
  //   0.1 vs 0.1  tie   → 0.5
  // total 2.0 / 4 pairs = 0.5, i.e. exactly uninformative — which it is, since the two labels are
  // symmetric across the two prediction values. An implementation that broke ties by index order
  // would return 0.75 or 0.25 here and look like a working model.
  near(auc([1, 1, 0, 0], [0.9, 0.1, 0.9, 0.1]), 0.5, FP, 'auc with ties');
});

test('auc is 0.0 for a perfectly inverted ranking', () => {
  near(auc([0, 0, 1, 1], [0.9, 0.8, 0.2, 0.1]), 0.0, FP, 'inverted auc');
});

test('expectedCalibrationError matches the hand computation', () => {
  // p = [0.1,0.1,0.9,0.9], y = [0,0,1,1], 2 equal-count bins.
  //   bin 1: mean p 0.1, observed rate 0.0 → gap 0.1, weight 0.5
  //   bin 2: mean p 0.9, observed rate 1.0 → gap 0.1, weight 0.5
  // ECE = 0.5(0.1) + 0.5(0.1) = 0.1
  near(expectedCalibrationError([0, 0, 1, 1], [0.1, 0.1, 0.9, 0.9], { bins: 2 }), 0.1, FP, 'ece');
});

test('a perfectly calibrated predictor has ECE zero', () => {
  // Two bins, each with its observed rate predicted exactly.
  const y = [0, 0, 0, 1, 1, 1, 1, 1];
  const p = [0.25, 0.25, 0.25, 0.25, 1, 1, 1, 1];
  // bin 1 (four rows at 0.25): rate 1/4 = 0.25 → gap 0
  // bin 2 (four rows at 1.00): rate 4/4 = 1.00 → gap 0
  near(expectedCalibrationError(y, p, { bins: 2 }), 0, FP, 'calibrated ece');
});

test('logLoss clamps rather than returning Infinity on a confident miss', () => {
  // A model that predicts 0 for an event that happened is infinitely surprised, mathematically.
  // Numerically that would poison every aggregate downstream — one row would make the whole
  // report NaN or Infinity, and the cause would be invisible in a table of dashes.
  const l = logLoss([1], [0]);
  assert.ok(Number.isFinite(l), `expected finite, got ${l}`);
  assert.ok(l > 20, `clamping should still record this as a very large loss, got ${l}`);
});

test('reliabilityCurve uses equal-COUNT bins, not equal-width', () => {
  // Nine rows clustered low, one high. Equal-WIDTH bins would put nine rows in the first bucket
  // and one in the last, and the curve would be a statement about one row. Equal-count bins give
  // every point on the curve the same weight, which is what makes the plot readable.
  const p = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.99];
  const y = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const curve = reliabilityCurve(y, p, { bins: 5 });
  const counts = curve.map((b) => b.count);
  assert.deepEqual(counts, [2, 2, 2, 2, 2], `equal-count bins expected, got ${counts}`);
});

// ---------------------------------------------------------------------------------------------
// 2. MATHEMATICAL IDENTITIES
// ---------------------------------------------------------------------------------------------

test('IDENTITY: a constant predictor scores exactly p̄(1−p̄)', () => {
  // This is the number the whole model report is read against, so it is worth pinning rather than
  // asserting in a comment. If the "baseline" column were even slightly wrong, every `captured`
  // fraction in the report would be wrong in the same direction and nothing would look odd.
  const rng = makeRng('constant-identity');
  const rows = Array.from({ length: 5000 }, () => ({ x: [1], y: rng.next() < 0.11 ? 1 : 0 }));
  const model = fitConstant(rows);
  const preds = predictAll(model, rows);
  const observed = brier(rows.map((r) => r.y), preds);
  near(observed, model.rate * (1 - model.rate), FP, 'constant Brier identity');
});

test('REGRESSION: the Brier decomposition recomposes to the Brier score', () => {
  // THE BUG. The original comment in calibration.js claimed
  //
  //     Brier = reliability − resolution + uncertainty
  //
  // was an exact identity. It is not, with equal-count bins over continuous predictions: Murphy's
  // decomposition is exact only when every prediction inside a bin is identical. The measured
  // residual was −1.05e-3 — about a thousand times too large to be floating point, which is what
  // gave it away. Two terms were missing: the variance of predictions within each bin, and the
  // covariance between prediction and outcome within each bin.
  //
  // The residual came out NEGATIVE, which is the interesting part: within a single bin the model's
  // higher predictions still tracked higher observed rates, so the 10-bin grouping was too coarse
  // to credit real discriminating power. The remainder was not hidden error, it was hidden
  // resolution.
  //
  // With both terms restored the identity is exact, so this test asserts floating-point equality.
  // A failure here means an algebra error, not a subtlety.
  const rng = makeRng('decomposition');
  const y = [];
  const p = [];
  for (let i = 0; i < 3000; i += 1) {
    const prob = rng.float(0.01, 0.6);
    p.push(prob);
    y.push(rng.next() < prob ? 1 : 0);
  }
  const d = brierDecomposition(y, p, { bins: 10 });
  near(d.recomposed, d.actual, 1e-12, 'recomposed vs actual');
  assert.ok(Math.abs(d.residual) < 1e-12, `residual should be floating-point noise, got ${d.residual}`);
  // And the terms should be individually sane.
  assert.ok(d.reliability >= 0, 'reliability is a squared quantity');
  assert.ok(d.resolution >= 0, 'resolution is a squared quantity');
  assert.ok(d.withinVariance >= 0, 'within-bin variance is a squared quantity');
  near(d.uncertainty, (() => {
    const base = y.reduce((s, v) => s + v, 0) / y.length;
    return base * (1 - base);
  })(), FP, 'uncertainty is base-rate variance');
});

test('IDENTITY: Platt scaling cannot change AUC', () => {
  // Platt has two parameters and applies a monotone increasing map, so it can stretch and shift the
  // probability scale but cannot reorder anything. AUC depends only on order. So any AUC change
  // after Platt scaling is a bug in one of the two functions, and this test is what distinguishes
  // "calibration improved" from "I accidentally reordered the predictions."
  const rng = makeRng('platt-auc');
  const y = [];
  const p = [];
  for (let i = 0; i < 2000; i += 1) {
    const prob = rng.float(0.02, 0.9);
    p.push(prob);
    y.push(rng.next() < prob ? 1 : 0);
  }
  const before = auc(y, p);
  const platt = fitPlatt(y, p);
  assert.ok(platt.a > 0, `monotone increasing requires a > 0, got a=${platt.a}`);
  const after = auc(y, p.map(platt.apply));
  near(after, before, 1e-12, 'auc after Platt');
});

test('fitPlatt survives a degenerate constant input instead of dividing by zero', () => {
  // The constant baseline emits one identical probability for every row. Its logit column has zero
  // variance, so the 2x2 Newton system is singular. The ridge on the diagonal makes this a no-op
  // rather than a NaN, and a NaN here would propagate into the report as a blank cell.
  const platt = fitPlatt([1, 0, 1, 0], [0.5, 0.5, 0.5, 0.5]);
  assert.ok(Number.isFinite(platt.a), `a should be finite, got ${platt.a}`);
  assert.ok(Number.isFinite(platt.b), `b should be finite, got ${platt.b}`);
  assert.ok(Number.isFinite(platt.apply(0.5)), 'apply should be finite');
});

test('scoreModel reports capturedFraction as the position between baseline and floor', () => {
  // capturedFraction is the column the report tells the reader to look at first, so its arithmetic
  // is worth pinning. Halfway between baseline and floor must read as exactly 0.5.
  const rows = [{ y: 1 }, { y: 0 }, { y: 1 }, { y: 0 }];
  const preds = [0.8, 0.3, 0.6, 0.1];  // Brier 0.075, from the hand computation above.
  const s = scoreModel(rows, preds, { floor: 0.055, baselineBrier: 0.095 });
  // (0.095 − 0.075) / (0.095 − 0.055) = 0.020 / 0.040 = 0.5
  near(s.capturedFraction, 0.5, FP, 'capturedFraction');
  near(s.excessOverFloor, 0.075 - 0.055, FP, 'excessOverFloor');
});

test('aleatoricFloor is mean(p(1−p)) over true probabilities', () => {
  // trueP = [0.5, 0.1] → (0.25 + 0.09) / 2 = 0.17
  near(aleatoricFloor([{ trueP: 0.5 }, { trueP: 0.1 }]), 0.17, FP, 'aleatoric floor');
  // A deterministic world has no irreducible error at all.
  near(aleatoricFloor([{ trueP: 1 }, { trueP: 0 }]), 0, FP, 'degenerate floor');
});

// ---------------------------------------------------------------------------------------------
// 3. THE MODELS
// ---------------------------------------------------------------------------------------------

test('sigmoid and dot behave', () => {
  near(sigmoid(0), 0.5, FP, 'sigmoid(0)');
  assert.ok(sigmoid(800) <= 1 && sigmoid(800) > 0.999, 'no overflow at large positive');
  assert.ok(sigmoid(-800) >= 0 && sigmoid(-800) < 0.001, 'no overflow at large negative');
  near(dot([1, 2, 3], [4, 5, 6]), 32, FP, 'dot');
});

test('fitLogistic RECOVERS known coefficients from noisy Bernoulli draws', () => {
  // The strongest single test of the optimiser. Data is generated from a logistic model with known
  // weights, labels are 0/1 DRAWS rather than probabilities, and the fit has to find the weights
  // back. If gradient, loss and update step do not agree with each other, this fails; a sign error
  // in the gradient produces coefficients of the wrong sign and is unmissable here.
  const TRUE_W = [-1.2, 2.0, -1.5, 0.8];
  const rng = makeRng('coefficient-recovery');
  const rows = [];
  for (let i = 0; i < 10000; i += 1) {
    const x = [1, rng.float(-2, 2), rng.float(-2, 2), rng.float(-2, 2)];
    const p = sigmoid(dot(TRUE_W, x));
    rows.push({ x, y: rng.next() < p ? 1 : 0 });
  }

  // l2 deliberately tiny and tolerance zero: this test is about whether the optimiser converges to
  // the right answer, and regularisation would bias the coefficients toward zero on purpose.
  const model = fitLogistic(rows, { l2: 1e-8, learningRate: 0.5, iterations: 2000, tolerance: 0 });

  for (let j = 0; j < TRUE_W.length; j += 1) {
    near(model.weights[j], TRUE_W[j], 0.15, `weight[${j}]`);
  }
  // Convergence VERIFIED, not assumed — this is why finalGradNorm is returned at all.
  assert.ok(model.finalGradNorm < 1e-3, `gradient norm should be tiny at optimum, got ${model.finalGradNorm}`);
});

test('fitLogistic initialises the intercept to base-rate log-odds', () => {
  // Zero iterations, so the returned weights are exactly the initialisation. On an 11% base rate the
  // intercept has a long way to travel from 0, and every other coefficient is being fit against a
  // badly wrong baseline until it arrives.
  const rng = makeRng('intercept-init');
  const rows = Array.from({ length: 4000 }, () => ({ x: [1, rng.float(-1, 1)], y: rng.next() < 0.11 ? 1 : 0 }));
  const model = fitLogistic(rows, { iterations: 0 });
  const base = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  near(model.weights[0], Math.log(base / (1 - base)), 1e-9, 'intercept init');
});

test('fitLogistic rejects ragged feature vectors instead of reading past the end', () => {
  assert.throws(
    () => fitLogistic([{ x: [1, 2], y: 1 }, { x: [1, 2, 3], y: 0 }]),
    /ragged/,
    'ragged input should throw'
  );
});

test('topCoefficients excludes bias and reports support', () => {
  const rows = [
    { x: [1, 1, 0], y: 1 },
    { x: [1, 0, 0], y: 0 },
    { x: [1, 1, 0], y: 1 },
  ];
  const model = fitLogistic(rows, { iterations: 50 });
  const top = topCoefficients(model, ['bias', 'common', 'never'], { rows });
  assert.ok(!top.some((c) => c.name === 'bias'), 'bias is not a domain claim and must not be listed');
  const common = top.find((c) => c.name === 'common');
  const never = top.find((c) => c.name === 'never');
  assert.equal(common.support, 2, 'support counts non-zero rows');
  assert.equal(never.support, 0, 'a column that is always zero has zero support');
});

test('binFeatures gives a binary column exactly two bins and loses nothing', () => {
  // Most of the 140 features are one-hot indicators. The only split a binary column admits is
  // "on or off", so 2 bins is exact rather than approximate — which is the argument for using
  // histograms on this particular matrix.
  const rows = [
    { x: [1, 0, 0.10], y: 0 },
    { x: [1, 1, 0.55], y: 1 },
    { x: [1, 0, 0.90], y: 0 },
    { x: [1, 1, 0.30], y: 1 },
  ];
  const { binCount } = binFeatures(rows, { maxBins: 32 });
  assert.equal(binCount[0], 1, 'the constant bias column is unsplittable');
  assert.equal(binCount[1], 2, 'a binary column gets exactly 2 bins');
  assert.equal(binCount[2], 4, 'four distinct values under the bin cap are kept exactly');
});

test('binFeatures does not emit empty bins on a heavily tied column', () => {
  // A column that is 95% zeros would, with naive quantile cuts, produce many identical cut points
  // and therefore bins that no row can ever fall into. Those cannot be split on and only cost time.
  const rows = [];
  for (let i = 0; i < 1000; i += 1) rows.push({ x: [i < 950 ? 0 : i / 1000], y: 0 });
  const { binned, binCount, n } = binFeatures(rows, { maxBins: 8 });
  const seen = new Set();
  for (let i = 0; i < n; i += 1) seen.add(binned[i]);
  assert.equal(seen.size, binCount[0], `every bin should be occupied: ${seen.size} used of ${binCount[0]}`);
});

test('fitGBM beats logistic on structure a linear model cannot express', () => {
  // XOR. y depends on (a XOR b) with no main effect on either a or b alone, so a linear model in
  // [1, a, b] is structurally incapable of doing better than the base rate no matter how long it
  // trains. Trees find the interaction for free, because every split below a split IS an
  // interaction.
  //
  // This is the control for src/ml/features.js. That file hand-builds 76 cause × action interaction
  // columns because I believed they were necessary — this test confirms the mechanism by which they
  // are necessary, on data where the answer is known in advance.
  //
  // Scored in-sample deliberately: the claim under test is about representational capacity, not
  // generalisation. Held-out comparison is the model report's job.
  const rng = makeRng('xor');
  const rows = [];
  for (let i = 0; i < 6000; i += 1) {
    const a = rng.next() < 0.5 ? 1 : 0;
    const b = rng.next() < 0.5 ? 1 : 0;
    const p = a !== b ? 0.75 : 0.15;
    rows.push({ x: [1, a, b], y: rng.next() < p ? 1 : 0 });
  }
  const y = rows.map((r) => r.y);

  const lin = fitLogistic(rows, { iterations: 800, l2: 1e-6 });
  const linBrier = brier(y, predictAll(lin, rows));

  const gbm = fitGBM(rows, {
    trees: 60, learningRate: 0.2, maxDepth: 2, minChildWeight: 20,
    subsample: 1, rng: makeRng('xor-gbm'),
  });
  const gbmBrier = brier(y, rows.map((r) => gbm.predict(r.x)));

  // The linear model is pinned at the base rate: mean p is 0.45, so its Brier is ≈0.2475.
  near(linBrier, 0.45 * (1 - 0.45), 0.01, 'linear model is stuck at the base rate on XOR');
  assert.ok(
    gbmBrier < linBrier - 0.05,
    `GBM should find the interaction: gbm ${gbmBrier.toFixed(5)} vs linear ${linBrier.toFixed(5)}`
  );
});

test('REGRESSION: fitGBM TRUNCATES the ensemble to the best validation round', () => {
  // THE BUG. The first honest run printed a validation curve that bottomed out near round 150 and
  // then climbed for 150 more rounds — textbook overfitting, visible only because the curve was
  // printed rather than summarised.
  //
  // Worth recording how close this came to being missed: an earlier smoke test passed the TEST rows
  // in as `validation`, which showed the GBM still improving at round 200 and capturing 48% of the
  // learnable gap. That reading was worthless. Watching TEST to decide when to stop makes TEST part
  // of training, and the resulting number is in-sample wearing a held-out label. With an honest
  // FIT/VALID split the same configuration captured 31.8%.
  //
  // The fix that matters is the TRUNCATION, not the stopping. Reporting "best round 122" while
  // shipping 153 trees would be reporting one model and shipping another.
  const rng = makeRng('early-stop');
  const make = (n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const x1 = rng.float(-1, 1);
      const p = sigmoid(0.8 * x1 - 0.5);
      out.push({ x: [1, x1, rng.float(-1, 1), rng.float(-1, 1)], y: rng.next() < p ? 1 : 0 });
    }
    return out;
  };
  // High capacity on little data, so validation loss turns upward quickly.
  const model = fitGBM(make(800), {
    trees: 300, learningRate: 0.3, maxDepth: 4, minChildWeight: 2,
    subsample: 1, rng: makeRng('es-sub'), validation: make(400), earlyStoppingRounds: 10,
  });

  assert.ok(model.stoppedEarly, 'should have stopped before the tree limit');
  assert.ok(model.treesGrown < 300, `should not have grown all 300, grew ${model.treesGrown}`);
  assert.equal(
    model.treesUsed,
    model.bestRound >= 0 ? model.bestRound + 1 : model.treesGrown,
    'the shipped ensemble must be exactly the best-validation prefix'
  );
  assert.equal(model.trees.length, model.treesUsed, 'trees array must match the reported count');
  assert.ok(model.treesUsed <= model.treesGrown, 'cannot ship more trees than were grown');
  assert.ok(model.bestValidationLoss !== null, 'best validation loss must be reported');
});

test('fitGBM without validation keeps every tree and says so', () => {
  const rng = makeRng('no-valid');
  const rows = Array.from({ length: 300 }, () => ({ x: [1, rng.float(-1, 1)], y: rng.next() < 0.3 ? 1 : 0 }));
  const model = fitGBM(rows, { trees: 12, subsample: 1, rng: makeRng('nv') });
  assert.equal(model.treesUsed, 12);
  assert.equal(model.stoppedEarly, false);
  assert.equal(model.hitTreeLimit, true, 'hitting the limit is a fact the caller needs');
  assert.equal(model.bestValidationLoss, null, 'no validation means no best loss to report');
});

test('fitGBM predictions stay inside (0,1) and leaf values are clipped', () => {
  // Without the clip on the Newton step, a pure leaf (all positives, tiny hessian) emits an
  // enormous logit and the model becomes numerically certain on the evidence of a handful of rows.
  // An EV engine reading 0.9999 would commit real money to it.
  const rng = makeRng('clip');
  const rows = Array.from({ length: 400 }, (_, i) => ({ x: [1, i < 200 ? 0 : 1], y: i < 200 ? 0 : 1 }));
  const model = fitGBM(rows, { trees: 40, learningRate: 0.5, maxDepth: 2, minChildWeight: 5, subsample: 1, rng });
  for (const r of rows) {
    const p = model.predict(r.x);
    assert.ok(p > 0 && p < 1, `prediction out of range: ${p}`);
  }
  for (const tree of model.trees) {
    const walk = (node) => {
      if (node.leaf) { assert.ok(Math.abs(node.value) <= 4 + 1e-9, `unclipped leaf ${node.value}`); return; }
      walk(node.left); walk(node.right);
    };
    walk(tree);
  }
});

test('topFeatureGain and renderTree produce an audit surface', () => {
  const rng = makeRng('audit');
  const rows = [];
  for (let i = 0; i < 600; i += 1) {
    const signal = rng.next() < 0.5 ? 1 : 0;
    rows.push({ x: [1, signal, rng.float(-1, 1)], y: rng.next() < (signal ? 0.7 : 0.2) ? 1 : 0 });
  }
  const names = ['bias', 'signal', 'noise'];
  const model = fitGBM(rows, { trees: 30, maxDepth: 2, minChildWeight: 10, subsample: 1, rng: makeRng('a2') });
  const top = topFeatureGain(model, names, { limit: 5 });
  assert.ok(top.length > 0, 'some feature must have positive gain');
  assert.equal(top[0].name, 'signal', `the real signal should dominate, got ${top[0].name}`);
  near(top.reduce((s, f) => s + f.share, 0), 1, 0.02, 'shares should sum to ~1');

  const text = renderTree(model.trees[0], names, model.edges);
  assert.match(text, /leaf/, 'rendered tree should contain leaves');
  assert.ok(text.includes('signal') || text.includes('noise'), 'rendered tree should name its features');
});

test('fitLookupTable falls back to the global rate for thin groups', () => {
  // THE REASON THIS MATTERS. A group of three rows that all failed predicts exactly 0.0, and an EV
  // engine reading 0.0 will stop a case permanently on the evidence of three observations. The
  // fallback is not statistical hygiene, it is a guard against a policy decision made on nothing.
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push({ actionKind: 'RETRY_NOW', y: i < 10 ? 1 : 0 });
  for (let i = 0; i < 3; i += 1) rows.push({ actionKind: 'ESCALATE_HUMAN', y: 0 });

  const lut = fitLookupTable(rows, { minCount: 10 });
  const globalRate = 10 / 23;
  near(lut.table.get('RETRY_NOW'), 0.5, FP, 'well-supported group uses its own rate');
  near(lut.table.get('ESCALATE_HUMAN'), globalRate, FP, 'thin group falls back');
  near(lut.globalRate, globalRate, FP, 'global rate');
  near(lut.predictRow({ actionKind: 'RETRY_NOW' }), 0.5, FP, 'predictRow');
  near(lut.predictRow({ actionKind: 'NEVER_SEEN' }), globalRate, FP, 'unseen key falls back too');
});

// ---------------------------------------------------------------------------------------------
// 4. THE HONESTY BOUNDARY
// ---------------------------------------------------------------------------------------------

test('featureNames() contains no latent field name', () => {
  // test/boundary.test.js enforces that src/ml/** has no import path to latent truth. That is a
  // denylist on INTENT, checked at build time. This is the complementary check on the DATA: even if
  // an import slipped through, a latent variable reaching the feature vector would have to be named,
  // and here is where that shows up.
  //
  // Two mechanisms that fail differently is the point. One catches a bad import; the other catches
  // a latent value arriving by some route nobody predicted.
  const LATENT = [
    'payerType', 'responsiveness', 'patienceBudget', 'willSelfRecover',
    'workingRails', 'trueP', 'truth', 'latent', 'oracle',
  ];
  const names = featureNames();
  for (const name of names) {
    for (const forbidden of LATENT) {
      assert.ok(
        !name.toLowerCase().includes(forbidden.toLowerCase()),
        `feature "${name}" looks like latent truth (matched "${forbidden}")`
      );
    }
  }
  assert.ok(names.length > 100, `expected the full feature set, got ${names.length}`);
  assert.equal(FEATURE_COUNT, names.length, 'FEATURE_COUNT must be derived, not hard-coded');
  assert.equal(new Set(names).size, names.length, 'duplicate feature names would make coefficients ambiguous');
});

test('salaryWindowProximity peaks on the 1st and decays across the first week', () => {
  // The observable proxy for "payday is near". If the model puts weight on this, that is it
  // rediscovering the salary-window effect from timing alone, which is the most satisfying thing it
  // can do — so the function itself had better be right.
  near(salaryWindowProximity('2026-08-01T10:00:00Z'), 1, FP, 'the 1st');
  near(salaryWindowProximity('2026-08-04T10:00:00Z'), 1 - 3 / 7, FP, 'the 4th');
  near(salaryWindowProximity('2026-08-08T10:00:00Z'), 0, FP, 'the 8th, decayed to zero');
  near(salaryWindowProximity('2026-08-15T10:00:00Z'), 0, FP, 'mid-month');
  near(salaryWindowProximity('2026-08-30T10:00:00Z'), 0.4, FP, 'credits land slightly early');
  near(salaryWindowProximity(null), 0, FP, 'missing timestamp is not payday');
});

// ---------------------------------------------------------------------------------------------
// 5. SPLITS, SELECTION AND REPRODUCIBILITY
// ---------------------------------------------------------------------------------------------

test('splitByEvent never splits an event across both sides', () => {
  // Thirty-three rows share each event's diagnosis, amount and latent payer. Splitting rows at
  // random would put near-duplicates of training rows into validation, and every held-out number in
  // the report would be optimistic — silently, and by an unknown amount.
  const rows = [];
  for (let e = 0; e < 100; e += 1) {
    for (let r = 0; r < 5; r += 1) rows.push({ eventId: `evt_${e}`, y: 0, x: [1] });
  }
  const { fit, valid, fitEvents, validEvents } = splitByEvent(rows, { fraction: 0.8, seed: 'split-test' });

  assert.equal(fitEvents, 80);
  assert.equal(validEvents, 20);
  assert.equal(fit.length + valid.length, rows.length, 'no row may be dropped or duplicated');

  const fitIds = new Set(fit.map((r) => r.eventId));
  const validIds = new Set(valid.map((r) => r.eventId));
  assert.equal(fitIds.size, 80);
  assert.equal(validIds.size, 20);
  for (const id of validIds) {
    assert.ok(!fitIds.has(id), `event ${id} leaked across the split`);
  }
});

test('splitByEvent is deterministic for a given seed and different across seeds', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ eventId: `evt_${i % 50}`, y: 0, x: [1] }));
  const a = splitByEvent(rows, { seed: 'same' });
  const b = splitByEvent(rows, { seed: 'same' });
  const c = splitByEvent(rows, { seed: 'different' });
  const ids = (s) => [...new Set(s.valid.map((r) => r.eventId))].sort().join(',');
  assert.equal(ids(a), ids(b), 'same seed must give the same split, or no comparison is attributable');
  assert.notEqual(ids(a), ids(c), 'different seeds should give different splits');
});

test('actionSelectionRegret matches the hand computation', () => {
  // Two groups, worked out on paper.
  //
  // Group 1, amount ₹1,000 (100000 paise):
  //   action A: predicted 0.9, true 0.20   ← model picks this (highest prediction)
  //   action B: predicted 0.1, true 0.30   ← actually best (highest true probability)
  //   chosen 0.20 × 100000 = 20000 paise,  best 0.30 × 100000 = 30000,  regret 10000
  //
  // Group 2, amount ₹700 (70000 paise):
  //   action C: predicted 0.8, true 0.10   ← model picks this, and it IS best
  //   action D: predicted 0.2, true 0.05
  //   chosen 7000, best 7000, regret 0
  //
  // Totals: regret 10000, best 37000, chosen 27000, capture 27000/37000, agreement 1 of 2.
  const rows = [
    { groupKey: 'g1', amountPaise: 100000, trueP: 0.20, actionKind: 'A' },
    { groupKey: 'g1', amountPaise: 100000, trueP: 0.30, actionKind: 'B' },
    { groupKey: 'g2', amountPaise: 70000, trueP: 0.10, actionKind: 'C' },
    { groupKey: 'g2', amountPaise: 70000, trueP: 0.05, actionKind: 'D' },
  ];
  const predictions = [0.9, 0.1, 0.8, 0.2];
  const r = actionSelectionRegret(rows, predictions);

  assert.equal(r.groups, 2);
  near(r.regretPaise, 10000, 1e-6, 'regretPaise');
  near(r.bestPaise, 37000, 1e-6, 'bestPaise');
  near(r.chosenPaise, 27000, 1e-6, 'chosenPaise');
  near(r.captureRate, 27000 / 37000, 1e-9, 'captureRate');
  near(r.topActionAgreement, 0.5, FP, 'topActionAgreement');
});

test('actionSelectionRegret is exactly zero for an oracle ranking', () => {
  // If predictions are the true probabilities, the argmax cannot differ, so regret must be 0 and
  // capture must be 1. A non-zero result here would mean the two argmax loops disagree.
  const rows = [
    { groupKey: 'g1', amountPaise: 100000, trueP: 0.20, actionKind: 'A' },
    { groupKey: 'g1', amountPaise: 100000, trueP: 0.30, actionKind: 'B' },
    { groupKey: 'g2', amountPaise: 50000, trueP: 0.10, actionKind: 'C' },
  ];
  const r = actionSelectionRegret(rows, rows.map((x) => x.trueP));
  near(r.regretPaise, 0, 1e-9, 'oracle regret');
  near(r.captureRate, 1, 1e-12, 'oracle capture');
  near(r.topActionAgreement, 1, FP, 'oracle agreement');
});

test('deadFeatures reports constant columns but never the bias', () => {
  // The first version reported `bias` as dead, which is true, useless, and would have trained me to
  // skim the list. A diagnostic that cries wolf once gets ignored forever.
  const rows = [
    { x: [1, 0, 5], y: 0 },
    { x: [1, 1, 5], y: 1 },
    { x: [1, 0, 5], y: 0 },
  ];
  const dead = deadFeatures(rows, ['bias', 'varies', 'constant']);
  assert.deepEqual(dead, ['constant'], `expected only the constant column, got ${dead}`);
});

test('REGRESSION: the evaluation clock is what makes the report reproducible', () => {
  // THE BUG. `npm run model-report` produced different numbers two minutes apart, with every seed in
  // the pipeline fixed and every model deterministic. The GBM's held-out regret moved from ₹1,70,078
  // to ₹1,77,087. I went looking for an unseeded Math.random and there wasn't one.
  //
  // The mechanism: `generateBatch({ now = new Date() })` defaults to wall-clock. The seeded RNG
  // decides the SHAPE of each event; `now` decides where that shape lands on a calendar. Shift the
  // anchor and every occurredAt shifts, which moves `ageDays` and `salaryWindowProximity` (which
  // reads the DAY OF THE MONTH), which changes probabilities, which changes the Bernoulli draws,
  // which changes the labels every model trains on.
  //
  // The drift was under a percentage point, which is exactly what made it dangerous — the same
  // magnitude as a real improvement from a modelling change. Any A/B across runs would have been
  // measuring the clock. And I had already written "anybody who clones this repo can reproduce every
  // figure" into three files.
  //
  // This test pins both halves: pinned clock ⇒ identical, and the clock genuinely does matter.
  const a = generateBatch({ seed: 'clock-test', split: 'TRAIN', now: evalNow() });
  const b = generateBatch({ seed: 'clock-test', split: 'TRAIN', now: evalNow() });
  assert.equal(
    JSON.stringify(a.events),
    JSON.stringify(b.events),
    'a pinned clock must give byte-identical events'
  );

  const shifted = generateBatch({
    seed: 'clock-test',
    split: 'TRAIN',
    now: new Date(EVAL_NOW.getTime() + 9 * 24 * 3600_000),
  });
  assert.notEqual(
    JSON.stringify(shifted.events),
    JSON.stringify(a.events),
    'the clock must actually affect the data, or this test proves nothing'
  );

  // And evalNow() must hand out a fresh object, so a caller mutating it cannot corrupt every later
  // evaluation in the same process.
  const d = evalNow();
  d.setUTCFullYear(1999);
  assert.equal(evalNow().getTime(), EVAL_NOW.getTime(), 'evalNow must be defensive');
});

// ---------------------------------------------------------------------------------------------
// 6. THE LABEL
// ---------------------------------------------------------------------------------------------

test('dataset labels are Bernoulli DRAWS, not probabilities', async () => {
  // The single most attractive mistake available in this project would be to train on `p`. It would
  // converge faster, produce beautiful calibration curves, and be worthless — no merchant has ever
  // observed a probability. They observe that one customer either paid or did not.
  //
  // Three things establish that the labels are draws:
  //   - every label is exactly 0 or 1
  //   - rows exist where the outcome contradicts the odds (y=1 while trueP < 0.5)
  //   - the mean label tracks the mean true probability, as unbiased draws must
  const batch = generateBatch({ seed: 'label-test', split: 'TRAIN', now: evalNow() });
  const events = batch.events.slice(0, 30);
  const keep = new Set(events.map((e) => e.eventId));
  const latents = batch.latents.filter((l) => keep.has(l.eventId));

  const { rows, featureNames: names } = await buildDataset({ events, latents, seed: 'label-test' });
  assert.ok(rows.length > 500, `expected a few hundred rows, got ${rows.length}`);

  for (const r of rows) {
    assert.ok(r.y === 0 || r.y === 1, `label must be 0 or 1, got ${r.y}`);
    assert.ok(r.trueP >= 0 && r.trueP <= 1, `trueP out of range: ${r.trueP}`);
    assert.equal(r.x.length, names.length, 'feature vector must match the name list');
  }

  const surprising = rows.filter((r) => r.y === 1 && r.trueP < 0.5);
  assert.ok(
    surprising.length > 0,
    'if no outcome ever contradicted the odds, the labels would be thresholds rather than draws'
  );

  const meanY = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const meanP = rows.reduce((s, r) => s + r.trueP, 0) / rows.length;
  near(meanY, meanP, 0.06, 'mean label vs mean true probability');

  // Group keys must bundle all candidate actions for one decision moment, or action-selection
  // scoring is not answerable at all.
  const groups = new Map();
  for (const r of rows) groups.set(r.groupKey, (groups.get(r.groupKey) ?? 0) + 1);
  const sizes = new Set(groups.values());
  assert.equal(sizes.size, 1, `every group should hold the same action set, saw sizes ${[...sizes]}`);
  assert.ok([...sizes][0] > 5, 'a group must contain several candidate actions to choose between');
});

test('dataset rows carry no latent field, only diagnosis outputs', async () => {
  // `trueP` is deliberately retained for the eval side. Everything ELSE about the latent payer must
  // be absent, and the feature vector must never see even trueP. This asserts the row shape rather
  // than trusting the import graph.
  const batch = generateBatch({ seed: 'shape-test', split: 'TRAIN', now: evalNow() });
  const events = batch.events.slice(0, 8);
  const keep = new Set(events.map((e) => e.eventId));
  const latents = batch.latents.filter((l) => keep.has(l.eventId));
  const { rows } = await buildDataset({ events, latents, seed: 'shape-test' });

  const FORBIDDEN = ['payerType', 'responsiveness', 'patienceBudget', 'willSelfRecover', 'workingRails'];
  for (const key of Object.keys(rows[0])) {
    assert.ok(!FORBIDDEN.includes(key), `row must not carry latent field "${key}"`);
  }
  // The feature vector is what the model actually receives, and trueP must not be findable in it.
  for (const r of rows.slice(0, 50)) {
    assert.ok(!r.x.includes(r.trueP) || r.trueP === 0 || r.trueP === 1, 'trueP must not appear as a feature value');
  }
  // Diagnosis outputs ARE allowed: they are our own inference from observables.
  assert.ok('diagnosedCause' in rows[0], 'diagnosis output should be carried for the lookup baseline');
  assert.ok('matchTier' in rows[0], 'matchTier is an ordinal fact, not a confidence score');
});
