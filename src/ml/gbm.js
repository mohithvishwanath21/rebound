/**
 * GRADIENT-BOOSTED TREES, BY HAND
 * ===============================
 *
 * Histogram-based gradient boosting on the logistic loss, with second-order (Newton) leaf values.
 * Roughly the algorithm XGBoost and LightGBM implement, minus the engineering.
 *
 * WHY THIS IS IN THE PROJECT AT ALL
 * --------------------------------
 * Not to win. To test one specific claim.
 *
 * `src/ml/features.js` hand-builds 76 cause x action interaction columns, because a linear model
 * structurally cannot express "retrying an expired card is hopeless while retrying an
 * insufficient-funds failure is fine" without them. That sentence is the entire domain argument of
 * this project — and I supplied it to the model rather than the model discovering it.
 *
 * Trees find interactions on their own. Every split below a split is an interaction, for free, with
 * no domain knowledge from me. So this file is a control for my own feature engineering:
 *
 *   - GBM clearly beats logistic  -> there is structure in the response model I did not think to
 *     encode, and my hand-built interaction list is incomplete. Worth knowing, and worth saying.
 *   - GBM roughly ties logistic   -> my interactions captured what mattered. The linear model wins
 *     on the strength of being auditable, and that is a defensible choice rather than laziness.
 *   - GBM loses                   -> almost certainly overfitting, since it has vastly more
 *     capacity. Check the TRAIN/TEST gap before believing anything else.
 *
 * All three outcomes are publishable. That is the test for whether a comparison was honest: I wrote
 * down what each result would mean before running it.
 *
 * WHY HISTOGRAMS RATHER THAN EXACT SPLITS
 * --------------------------------------
 * The textbook tree sorts every feature at every node and tries every threshold, which is
 * O(n log n) per feature per node. Instead each feature is binned ONCE up front, and split-finding
 * becomes "accumulate gradients into buckets, then scan the buckets" — O(n) per feature per node,
 * with a tiny constant.
 *
 * This is not only a speed trick, it happens to fit the data. Of the 140 features, the large
 * majority are one-hot indicators that take exactly two values, so binning them into 2 buckets
 * loses precisely nothing — the only split a binary column admits is "is it on or off." Only about
 * a dozen columns are continuous, and those get quantile bins. The approximation is therefore
 * confined to the handful of features where it is genuinely an approximation.
 *
 * WHY NEWTON LEAF VALUES RATHER THAN LEAF MEANS
 * --------------------------------------------
 * The naive version fits each tree to the residuals `y - p` and uses the mean residual as the leaf
 * value. That ignores curvature: a residual of 0.4 at p=0.5 needs a much smaller logit step than
 * the same residual at p=0.02, because the sigmoid is flat out there. Using `sum(g)/sum(h)` — the
 * ratio of first to second derivatives — accounts for it, and the practical difference is exactly
 * in the low-probability region where an 11% base rate puts most of this dataset.
 *
 * Since the output is consumed as a probability by an expected-value calculation, getting the
 * low-probability region right is the whole job, not a refinement.
 */

import { sigmoid } from './logistic.js';

const MAX_BINS = 32;

/**
 * Bin every feature column into at most `maxBins` buckets, using quantiles of the observed values.
 *
 * Quantiles rather than equal-width intervals: `logAmount` is roughly normal and `salaryWindow` is
 * mostly zero with a spike near 1, and equal-width bins would put almost every row of the latter in
 * a single bucket, making the feature unsplittable. Quantile bins put the boundaries where the data
 * actually is.
 *
 * Stored column-major (`binned[j * n + i]`) because split-finding iterates one feature across many
 * rows. Row-major would stride through memory by 140 elements per read and spend most of its time
 * waiting on cache misses.
 */
export function binFeatures(rows, { maxBins = MAX_BINS } = {}) {
  const n = rows.length;
  const d = rows[0].x.length;
  const binned = new Uint8Array(n * d);
  const edges = [];

  const column = new Float64Array(n);

  for (let j = 0; j < d; j += 1) {
    for (let i = 0; i < n; i += 1) column[i] = rows[i].x[j];

    // Distinct values, cheaply. A binary column produces 2 and skips all the quantile machinery.
    const distinct = Array.from(new Set(column)).sort((a, b) => a - b);

    let cuts;
    if (distinct.length <= maxBins) {
      // Exact: cut midway between consecutive distinct values. No approximation whatsoever, which
      // is the case for every one-hot column in the matrix.
      cuts = [];
      for (let k = 1; k < distinct.length; k += 1) cuts.push((distinct[k - 1] + distinct[k]) / 2);
    } else {
      const sorted = Float64Array.from(column).sort();
      cuts = [];
      for (let b = 1; b < maxBins; b += 1) {
        const v = sorted[Math.floor((b / maxBins) * n)];
        // Skip duplicate cut points, or a heavily tied column silently produces empty bins that
        // can never be split on and just cost time.
        if (cuts.length === 0 || v > cuts[cuts.length - 1]) cuts.push(v);
      }
    }

    edges.push(cuts);

    const base = j * n;
    for (let i = 0; i < n; i += 1) {
      const v = column[i];
      let b = 0;
      while (b < cuts.length && v > cuts[b]) b += 1;
      binned[base + i] = b;
    }
  }

  return { binned, edges, n, d, binCount: edges.map((c) => c.length + 1) };
}

/**
 * Gain from a candidate split, in the standard regularised-Newton form.
 *
 *   gain = ½ [ GL²/(HL+λ) + GR²/(HR+λ) − (GL+GR)²/(HL+HR+λ) ] − γ
 *
 * Reading it plainly: how much better can we predict the gradients if we are allowed to give the
 * two sides different values, versus one shared value. λ shrinks confidence in leaves with little
 * total curvature (few rows, or rows already predicted confidently), and γ is a flat toll per split
 * that stops the tree from carving off splits worth almost nothing.
 */
function splitGain(gl, hl, gr, hr, lambda, gamma) {
  const t = (g, h) => (g * g) / (h + lambda);
  return 0.5 * (t(gl, hl) + t(gr, hr) - t(gl + gr, hl + hr)) - gamma;
}

/**
 * Grow one regression tree against the current gradients and hessians.
 *
 * Depth-first, exact greedy over binned features. Returns a nested node structure rather than a
 * flat array — slower to traverse, far easier to print and inspect, and the printing is the point
 * for a project that has to justify its decisions.
 */
function growTree({
  binned, n, d, binCount, indices, grad, hess,
  maxDepth, minChildWeight, lambda, gamma, maxLeafDelta, featureGain,
}) {
  const build = (rowIdx, depth) => {
    let G = 0;
    let H = 0;
    for (const i of rowIdx) { G += grad[i]; H += hess[i]; }

    // The Newton step, clipped. Without the clip, a pure leaf (all positives, tiny hessian) emits
    // an enormous logit and the model becomes numerically confident on the strength of six rows.
    const raw = -G / (H + lambda);
    const value = Math.max(-maxLeafDelta, Math.min(maxLeafDelta, raw));
    const leaf = { leaf: true, value, count: rowIdx.length };

    if (depth >= maxDepth || rowIdx.length < 2 * minChildWeight || H < 2 * minChildWeight) return leaf;

    let best = null;

    for (let j = 0; j < d; j += 1) {
      const nb = binCount[j];
      if (nb < 2) continue;

      const hg = new Float64Array(nb);
      const hh = new Float64Array(nb);
      const hc = new Int32Array(nb);
      const base = j * n;

      for (const i of rowIdx) {
        const b = binned[base + i];
        hg[b] += grad[i];
        hh[b] += hess[i];
        hc[b] += 1;
      }

      // Scan cut points left to right, accumulating. One pass, nb steps.
      let gl = 0;
      let hl = 0;
      let cl = 0;
      for (let b = 0; b < nb - 1; b += 1) {
        gl += hg[b];
        hl += hh[b];
        cl += hc[b];
        const cr = rowIdx.length - cl;
        if (cl < minChildWeight || cr < minChildWeight) continue;
        const gr = G - gl;
        const hr = H - hl;
        if (hl < minChildWeight || hr < minChildWeight) continue;

        const gain = splitGain(gl, hl, gr, hr, lambda, gamma);
        if (gain > 0 && (best === null || gain > best.gain)) {
          best = { feature: j, bin: b, gain };
        }
      }
    }

    if (best === null) return leaf;

    featureGain[best.feature] += best.gain;

    const base = best.feature * n;
    const left = [];
    const right = [];
    for (const i of rowIdx) (binned[base + i] <= best.bin ? left : right).push(i);

    // Defensive: a split that sends everything one way would recurse forever at the same depth.
    if (left.length === 0 || right.length === 0) return leaf;

    return {
      leaf: false,
      feature: best.feature,
      bin: best.bin,
      gain: best.gain,
      count: rowIdx.length,
      left: build(left, depth + 1),
      right: build(right, depth + 1),
    };
  };

  return build(indices, 0);
}

/** Walk a tree for one already-binned row. */
function predictTreeBinned(node, binned, n, i) {
  let cur = node;
  while (!cur.leaf) {
    cur = binned[cur.feature * n + i] <= cur.bin ? cur.left : cur.right;
  }
  return cur.value;
}

/** Walk a tree for a raw feature vector, using the stored bin edges. */
function predictTreeRaw(node, x, edges) {
  let cur = node;
  while (!cur.leaf) {
    const cuts = edges[cur.feature];
    const v = x[cur.feature];
    let b = 0;
    while (b < cuts.length && v > cuts[b]) b += 1;
    cur = b <= cur.bin ? cur.left : cur.right;
  }
  return cur.value;
}

/**
 * Fit a gradient-boosted ensemble.
 *
 * @param opts.trees            how many boosting rounds
 * @param opts.learningRate     shrinkage. Small steps, many trees — the single most reliable
 *                              regularisation in boosting, and worth more than tuning depth.
 * @param opts.maxDepth         3 by default, not because deep trees fit worse but because depth d
 *                              permits d-way interactions, and I do not believe the response model
 *                              contains genuine 6-way interactions. Depth is a claim about the
 *                              world, so it should be set from what the world plausibly contains.
 * @param opts.subsample        fraction of rows per tree. Decorrelates trees and, incidentally,
 *                              makes each round cheaper.
 * @param opts.validation       held-out rows, used for EARLY STOPPING. Must come from the training
 *                              split, never from TEST — see the note on `earlyStoppingRounds`.
 * @param opts.earlyStoppingRounds
 *                              stop after this many rounds with no validation improvement, and
 *                              TRUNCATE the ensemble back to the best round.
 *
 *                              This is not a refinement, it is a correction. The first honest run of
 *                              `npm run model-report` printed a boosting curve whose validation loss
 *                              bottomed out around round 150 at 0.3219 and then climbed steadily to
 *                              0.3253 by round 299 — textbook overfitting, plainly visible because
 *                              the curve was printed rather than summarised.
 *
 *                              Worth recording how close I came to missing it. An earlier smoke test
 *                              passed the TEST rows in as `validation`, which showed the GBM looking
 *                              excellent and still improving at round 200. That reading was
 *                              worthless: watching TEST to decide when to stop makes TEST part of
 *                              training, and the resulting number is in-sample wearing a held-out
 *                              label. The fix is the split, not the metric.
 */
export function fitGBM(rows, {
  trees = 200,
  learningRate = 0.08,
  maxDepth = 3,
  minChildWeight = 20,
  lambda = 1.0,
  gamma = 0.0,
  maxLeafDelta = 4,
  subsample = 0.8,
  maxBins = MAX_BINS,
  rng = null,
  validation = null,
  earlyStoppingRounds = 30,
} = {}) {
  if (!rows.length) throw new Error('fitGBM: no rows');

  const { binned, edges, n, d, binCount } = binFeatures(rows, { maxBins });

  const y = Float64Array.from(rows, (r) => r.y);
  const baseRate = y.reduce((s, v) => s + v, 0) / n;
  const base = Math.log(baseRate / (1 - baseRate));

  const F = new Float64Array(n).fill(base);
  const grad = new Float64Array(n);
  const hess = new Float64Array(n);
  const featureGain = new Float64Array(d);
  const ensemble = [];
  const history = [];

  // Validation rows are scored through the raw path, using the TRAINING bin edges. Deliberate:
  // re-binning held-out rows with their own quantiles would leak the held-out distribution into
  // the model's view of where the cut points should be.
  const vF = validation ? new Float64Array(validation.length).fill(base) : null;
  const vy = validation ? Float64Array.from(validation, (r) => r.y) : null;

  let bestValidationLoss = Infinity;
  let bestRound = -1;
  let roundsSinceBest = 0;
  let stoppedEarly = false;

  const draw = rng ? () => rng.next() : Math.random;

  const meanLogLoss = (scores, labels) => {
    let s = 0;
    for (let i = 0; i < labels.length; i += 1) {
      const p = Math.min(1 - 1e-12, Math.max(1e-12, sigmoid(scores[i])));
      s += labels[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
    }
    return s / labels.length;
  };

  for (let t = 0; t < trees; t += 1) {
    for (let i = 0; i < n; i += 1) {
      const p = sigmoid(F[i]);
      grad[i] = p - y[i];        // dL/dF for logistic loss
      hess[i] = Math.max(p * (1 - p), 1e-6);  // d²L/dF². Floored: a saturated row has hessian ~0
    }                                          // and would otherwise divide by nothing.

    let indices;
    if (subsample >= 1) {
      indices = Array.from({ length: n }, (_, i) => i);
    } else {
      indices = [];
      for (let i = 0; i < n; i += 1) if (draw() < subsample) indices.push(i);
      if (indices.length < 4 * minChildWeight) indices = Array.from({ length: n }, (_, i) => i);
    }

    const tree = growTree({
      binned, n, d, binCount, indices, grad, hess,
      maxDepth, minChildWeight, lambda, gamma, maxLeafDelta, featureGain,
    });

    // Rows outside the subsample still get updated — the tree is a function of the features, not
    // of which rows trained it, and leaving them stale would corrupt the next round's gradients.
    for (let i = 0; i < n; i += 1) {
      F[i] += learningRate * predictTreeBinned(tree, binned, n, i);
    }

    ensemble.push(tree);

    // Validation is scored EVERY round, not sampled. Early stopping needs to know which round was
    // best, and a curve sampled every tenth round can only ever locate that to within ten rounds.
    let validationLoss = null;
    if (validation) {
      for (let i = 0; i < validation.length; i += 1) {
        vF[i] += learningRate * predictTreeRaw(tree, validation[i].x, edges);
      }
      validationLoss = meanLogLoss(vF, vy);

      if (validationLoss < bestValidationLoss - 1e-9) {
        bestValidationLoss = validationLoss;
        bestRound = t;
        roundsSinceBest = 0;
      } else {
        roundsSinceBest += 1;
      }
    }

    if (t % 10 === 0 || t === trees - 1) {
      history.push({ round: t, trainLoss: meanLogLoss(F, y), validationLoss });
    }

    if (validation && earlyStoppingRounds > 0 && roundsSinceBest >= earlyStoppingRounds) {
      history.push({ round: t, trainLoss: meanLogLoss(F, y), validationLoss });
      stoppedEarly = true;
      break;
    }
  }

  // TRUNCATE to the best validation round. Keeping the extra trees and merely reporting the best
  // round would be reporting one model and shipping another.
  const used = validation && bestRound >= 0 ? ensemble.slice(0, bestRound + 1) : ensemble;

  const predict = (x) => {
    let f = base;
    for (const tree of used) f += learningRate * predictTreeRaw(tree, x, edges);
    return sigmoid(f);
  };

  return {
    kind: 'gbm',
    predict,
    trees: used,
    treesGrown: ensemble.length,
    treesUsed: used.length,
    bestRound,
    bestValidationLoss: bestValidationLoss === Infinity ? null : bestValidationLoss,
    stoppedEarly,
    hitTreeLimit: !stoppedEarly && ensemble.length === trees,
    edges,
    base,
    learningRate,
    history,
    featureGain: Array.from(featureGain),
    leafCount: used.reduce((s, t) => s + countLeaves(t), 0),
  };
}

function countLeaves(node) {
  return node.leaf ? 1 : countLeaves(node.left) + countLeaves(node.right);
}

/**
 * Total split gain per feature — the ensemble's audit surface.
 *
 * This is the counterpart to `topCoefficients()` for the linear model, and it is worth being clear
 * that it is a strictly weaker artefact. A coefficient has a sign and a magnitude in log-odds:
 * "expired card x retry: −1.35" is a falsifiable claim about the world. Gain has neither. It says
 * "the trees found this column useful" and nothing about which direction it pushes, because in a
 * tree ensemble a single feature can push both ways depending on what it is combined with.
 *
 * That asymmetry is a real cost of using trees for a decision that moves money, and it should be
 * weighed against whatever accuracy they buy rather than waved away with a feature-importance plot.
 */
export function topFeatureGain(model, names, { limit = 20 } = {}) {
  const total = model.featureGain.reduce((s, g) => s + g, 0) || 1;
  return model.featureGain
    .map((gain, j) => ({ name: names[j] ?? `f[${j}]`, gain, share: gain / total }))
    .filter((f) => f.gain > 0)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit);
}

/**
 * Render one tree as indented text.
 *
 * Included because "the GBM is a black box" is a claim I would rather not have to accept on
 * someone else's authority. A depth-3 tree printed with feature names and thresholds is perfectly
 * readable; what is unreadable is two hundred of them summed. The honest statement is that
 * individual trees are interpretable and the ensemble is not, and printing one makes that concrete
 * instead of rhetorical.
 */
export function renderTree(tree, names, edges, indent = '') {
  if (tree.leaf) return `${indent}leaf ${tree.value.toFixed(4)} (n=${tree.count})\n`;
  const cuts = edges[tree.feature];
  const threshold = cuts[tree.bin];
  const name = names[tree.feature] ?? `f[${tree.feature}]`;
  return (
    `${indent}if ${name} <= ${threshold?.toFixed(4) ?? '?'}  (gain ${tree.gain.toFixed(2)}, n=${tree.count})\n` +
    renderTree(tree.left, names, edges, `${indent}  `) +
    `${indent}else\n` +
    renderTree(tree.right, names, edges, `${indent}  `)
  );
}
