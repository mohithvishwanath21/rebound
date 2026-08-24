/**
 * CALIBRATION AND DISCRIMINATION METRICS
 * ======================================
 *
 * The scoring layer. Everything here is a few lines of arithmetic; the reason it is its own file
 * with this much commentary is that choosing the WRONG metric is how a model like this passes review
 * while being unfit for its actual job.
 *
 * THE DISTINCTION THIS WHOLE FILE EXISTS TO MAKE
 * ---------------------------------------------
 * A probability model can be wrong in two independent ways.
 *
 *   DISCRIMINATION — can it tell cases apart? Measured by AUC. "Of a random recoverable case and a
 *   random unrecoverable one, how often does the model rank the recoverable one higher?"
 *
 *   CALIBRATION — are the numbers themselves true? "Among the cases it called 20%, did about 20%
 *   actually recover?" Measured by ECE and the reliability curve.
 *
 * These come apart completely. Take any model and halve every prediction: the ranking is untouched,
 * so AUC is IDENTICAL, while every probability is now wrong by a factor of two. A leaderboard
 * ranking on AUC cannot see the difference.
 *
 * For this project it is the difference that matters. The consumer is
 *
 *     EV(action) = P(recover) x amount x margin - cost(action)
 *
 * which MULTIPLIES the probability by real money. A model that says 0.40 where truth is 0.20 will
 * compute positive expected value for actions that in fact lose money, and will keep spending on
 * cases that should have been stopped — while posting a perfect AUC, because it ranked every case
 * correctly on the way to being wrong about all of them.
 *
 * So this file reports both, and when they disagree, calibration wins. That is not a general truth
 * about machine learning; it is a consequence of what the number is used for downstream. If the
 * output were a work queue for a collections team to walk top-down, the priority would flip and
 * ranking would be all that mattered.
 *
 * WHY THE BRIER SCORE IS THE HEADLINE
 * ----------------------------------
 * Because it is sensitive to both at once, and because it decomposes exactly into the two, plus a
 * term that is nobody's fault. See `brierDecomposition`.
 */

const EPS = 1e-12;
const clamp = (p) => Math.min(1 - EPS, Math.max(EPS, p));

/** Mean squared error between predicted probability and 0/1 outcome. Lower is better. */
export function brier(yTrue, pPred) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i += 1) s += (pPred[i] - yTrue[i]) ** 2;
  return s / yTrue.length;
}

/** Mean negative log likelihood. Punishes confident mistakes far harder than Brier does. */
export function logLoss(yTrue, pPred) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    const p = clamp(pPred[i]);
    s += yTrue[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / yTrue.length;
}

/**
 * Area under the ROC curve, computed from ranks rather than by tracing a curve.
 *
 *   AUC = (sum of ranks of positives - n1(n1+1)/2) / (n1 x n0)
 *
 * Equivalent to the Mann-Whitney U statistic, and exactly the probability that a randomly chosen
 * positive is scored above a randomly chosen negative. Ties get averaged ranks, which matters here
 * more than it usually does: a lookup-table model assigns literally identical predictions to whole
 * groups of rows, and counting those ties as wins would hand it a free and fictitious advantage.
 */
export function auc(yTrue, pPred) {
  const n = yTrue.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pPred[a] - pPred[b]);

  const ranks = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && pPred[idx[j + 1]] === pPred[idx[i]]) j += 1;
    const avg = (i + j) / 2 + 1;  // ranks are 1-based
    for (let k = i; k <= j; k += 1) ranks[idx[k]] = avg;
    i = j + 1;
  }

  let n1 = 0;
  let rankSum = 0;
  for (let k = 0; k < n; k += 1) {
    if (yTrue[k] === 1) { n1 += 1; rankSum += ranks[k]; }
  }
  const n0 = n - n1;
  if (n1 === 0 || n0 === 0) return NaN;  // undefined, and must not be silently reported as 0.5
  return (rankSum - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

/**
 * Reliability curve: predicted probability versus observed frequency, in equal-COUNT bins.
 *
 * Equal-count, not equal-width, and that choice is load-bearing. With an 11% base rate almost every
 * prediction falls below 0.3, so ten equal-width bins would put ~95% of the data in the first three
 * and leave seven bins holding a handful of rows each — producing a chart that looks like severe
 * miscalibration at the top end when it is really just noise over twelve observations.
 *
 * Equal-count bins put the same number of rows in each, so every point on the curve carries the same
 * statistical weight. `count` is returned per bin anyway, because a reliability curve without
 * counts is unreadable and invites exactly this mistake.
 */
export function reliabilityCurve(yTrue, pPred, { bins = 10 } = {}) {
  const n = yTrue.length;
  if (n === 0) return [];
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pPred[a] - pPred[b]);

  const out = [];
  for (let b = 0; b < bins; b += 1) {
    const start = Math.floor((b * n) / bins);
    const end = Math.floor(((b + 1) * n) / bins);
    if (end <= start) continue;
    let sp = 0;
    let sy = 0;
    for (let k = start; k < end; k += 1) { sp += pPred[idx[k]]; sy += yTrue[idx[k]]; }
    const count = end - start;
    out.push({
      bin: b,
      count,
      meanPredicted: sp / count,
      observedRate: sy / count,
      lowPredicted: pPred[idx[start]],
      highPredicted: pPred[idx[end - 1]],
    });
  }
  return out;
}

/**
 * Expected Calibration Error: mean |predicted − observed| across bins, weighted by bin size.
 *
 * The single number that answers "can I trust these probabilities as probabilities." An ECE of 0.01
 * means predictions are off by about one percentage point on average, which for an EV calculation
 * over an 11% base rate is the difference between a usable and a useless model.
 *
 * Honest limitation, because ECE is routinely over-read: it is bin-dependent. Fewer bins average
 * away real miscalibration and flatter the model; many bins add noise and penalise it. It is a
 * diagnostic to be reported next to the curve and the bin count, never a headline on its own.
 */
export function expectedCalibrationError(yTrue, pPred, { bins = 10 } = {}) {
  const curve = reliabilityCurve(yTrue, pPred, { bins });
  const n = yTrue.length;
  return curve.reduce((s, b) => s + (b.count / n) * Math.abs(b.meanPredicted - b.observedRate), 0);
}

/**
 * MURPHY'S DECOMPOSITION of the Brier score.
 *
 *     Brier = reliability − resolution + uncertainty   (+ two within-bin terms, see below)
 *
 *   reliability  how far observed frequencies stray from predicted ones, within bins. Lower better.
 *                This is calibration error, in the same units as the headline score.
 *   resolution   how far bin outcome rates stray from the overall base rate. HIGHER is better — it
 *                is the model successfully separating cases. A constant predictor scores zero here.
 *   uncertainty  ȳ(1 − ȳ), the variance of the outcome itself. Nothing any model does changes it.
 *                It is also exactly the Brier score of the constant base-rate predictor, which is
 *                why that baseline is the natural zero point for the whole table.
 *
 * This is the most useful diagnostic in the file, because it answers "why is this score what it is"
 * rather than just reporting it. A model that ties the constant baseline has either failed to
 * separate anything (resolution ~ 0) or separated cases well and then mis-stated the probabilities
 * (high resolution cancelled by high reliability). Those two failures need completely different
 * fixes, and the undecomposed Brier score cannot tell them apart.
 *
 * THE THREE-TERM IDENTITY IS NOT EXACT HERE, AND THE GAP IS INFORMATIVE
 * -------------------------------------------------------------------
 * I first wrote this function asserting the classic three-term identity and expecting a residual
 * around 1e-15. The measured residual was -1.05e-3 — a thousand times too large to be floating
 * point. The textbook identity is exact only when every prediction inside a bin is IDENTICAL, which
 * holds for a forecaster emitting a few discrete values (a weather service saying "30% chance") and
 * does not hold for a continuous model chopped into equal-count bins.
 *
 * Expanding (pᵢ − yᵢ)² around each bin's mean prediction p̄ₖ gives the two missing terms:
 *
 *     Brier = reliability − resolution + uncertainty + withinBinVariance − 2·withinBinCovariance
 *
 * where withinBinVariance is the spread of predictions inside bins, and withinBinCovariance is the
 * covariance between prediction and outcome inside bins.
 *
 * The sign of the residual is the interesting part. It came out NEGATIVE, meaning the covariance
 * term dominates: even within a single bin, the model's higher predictions still correspond to
 * higher observed recovery. That is real discriminating power which the 10-bin grouping is too
 * coarse to credit — the coarse `resolution` term understates the model. So the residual is not
 * error being swept under a rug; it is resolution the binning cannot see, and it is now reported as
 * its own two terms rather than left as an unexplained remainder.
 */
export function brierDecomposition(yTrue, pPred, { bins = 10 } = {}) {
  const n = yTrue.length;
  const curve = reliabilityCurve(yTrue, pPred, { bins });
  const baseRate = yTrue.reduce((s, v) => s + v, 0) / n;

  // Re-derive the bin membership the curve used, so the two sets of terms cannot disagree.
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => pPred[a] - pPred[b]);

  let reliability = 0;
  let resolution = 0;
  let withinVariance = 0;
  let withinCovariance = 0;

  for (let b = 0; b < bins; b += 1) {
    const start = Math.floor((b * n) / bins);
    const end = Math.floor(((b + 1) * n) / bins);
    if (end <= start) continue;
    const count = end - start;
    const w = count / n;

    let sp = 0;
    let sy = 0;
    for (let k = start; k < end; k += 1) { sp += pPred[idx[k]]; sy += yTrue[idx[k]]; }
    const meanP = sp / count;
    const rate = sy / count;

    let vp = 0;
    let cov = 0;
    for (let k = start; k < end; k += 1) {
      const dp = pPred[idx[k]] - meanP;
      vp += dp * dp;
      cov += dp * (yTrue[idx[k]] - rate);
    }

    reliability += w * (meanP - rate) ** 2;
    resolution += w * (rate - baseRate) ** 2;
    withinVariance += w * (vp / count);
    withinCovariance += w * (cov / count);
  }

  const uncertainty = baseRate * (1 - baseRate);
  const recomposed = reliability - resolution + uncertainty + withinVariance - 2 * withinCovariance;
  const actual = brier(yTrue, pPred);

  return {
    reliability, resolution, uncertainty,
    withinVariance, withinCovariance,
    recomposed,
    actual,
    /** Now genuinely a floating-point residual. A large value here means a bug, not a subtlety. */
    residual: actual - recomposed,
  };
}

/**
 * PLATT SCALING: fit `sigmoid(a * logit(p) + b)` on held-out data to repair calibration.
 *
 * A deliberately tiny model — two parameters — fit by Newton's method on the logistic loss. Two
 * parameters is the whole point: it can stretch and shift the probability scale but cannot reorder
 * anything, so AUC is mathematically unchanged and any improvement is purely calibration.
 *
 * MUST be fit on data the base model did not train on. Fitting it on the training set would find
 * a ~ 1, b ~ 0 and report that no correction was needed, because a model's calibration on its own
 * training data is always flattering. This function therefore takes its fitting data as an explicit
 * argument, so the caller cannot pass the training set by accident of default.
 *
 * The two fitted parameters are themselves the diagnostic, and often more interesting than the
 * correction: a < 1 means the base model was over-confident (predictions too spread out), a > 1
 * under-confident, b ≠ 0 a systematic bias in the base rate.
 */
export function fitPlatt(yTrue, pPred, { iterations = 100, tolerance = 1e-10 } = {}) {
  const logit = (p) => {
    const c = clamp(p);
    return Math.log(c / (1 - c));
  };
  const z = pPred.map(logit);
  const n = yTrue.length;

  let a = 1;
  let b = 0;

  for (let it = 0; it < iterations; it += 1) {
    let g0 = 0; let g1 = 0;
    let h00 = 0; let h01 = 0; let h11 = 0;

    for (let i = 0; i < n; i += 1) {
      const f = a * z[i] + b;
      const p = f >= 0 ? 1 / (1 + Math.exp(-f)) : Math.exp(f) / (1 + Math.exp(f));
      const err = p - yTrue[i];
      const w = Math.max(p * (1 - p), 1e-10);
      g0 += err * z[i];
      g1 += err;
      h00 += w * z[i] * z[i];
      h01 += w * z[i];
      h11 += w;
    }

    // 2x2 solve. Ridge on the diagonal so a degenerate input (all predictions identical, which the
    // constant baseline produces) yields a no-op instead of dividing by zero.
    h00 += 1e-9; h11 += 1e-9;
    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-14) break;
    const da = (g0 * h11 - g1 * h01) / det;
    const db = (g1 * h00 - g0 * h01) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) < tolerance && Math.abs(db) < tolerance) break;
  }

  return {
    a, b,
    apply: (p) => {
      const f = a * logit(p) + b;
      return f >= 0 ? 1 / (1 + Math.exp(-f)) : Math.exp(f) / (1 + Math.exp(f));
    },
  };
}

/**
 * Everything at once, for one model on one split.
 *
 * `floor` is the aleatoric Brier floor from `src/eval/dataset.js` when available. Passing it in is
 * what turns an uninterpretable number into a readable one: "Brier 0.0888" says nothing, whereas
 * "Brier 0.0888, floor 0.0703, baseline 0.0997 — so 37% of the learnable gap captured" is a
 * finding. `capturedFraction` computes exactly that, and is the number I would put on a slide.
 */
export function scoreModel(rows, predictions, { bins = 10, floor = null, baselineBrier = null } = {}) {
  const y = rows.map((r) => r.y);
  const b = brier(y, predictions);
  const decomp = brierDecomposition(y, predictions, { bins });

  const out = {
    n: rows.length,
    baseRate: y.reduce((s, v) => s + v, 0) / rows.length,
    meanPredicted: predictions.reduce((s, v) => s + v, 0) / predictions.length,
    brier: b,
    logLoss: logLoss(y, predictions),
    auc: auc(y, predictions),
    ece: expectedCalibrationError(y, predictions, { bins }),
    reliability: decomp.reliability,
    resolution: decomp.resolution,
    uncertainty: decomp.uncertainty,
    decompositionResidual: decomp.residual,
  };

  if (floor != null) {
    out.floor = floor;
    out.excessOverFloor = b - floor;
  }
  if (floor != null && baselineBrier != null && baselineBrier > floor) {
    out.capturedFraction = (baselineBrier - b) / (baselineBrier - floor);
  }

  return out;
}

/**
 * THE "YOU DID NOT NEED MACHINE LEARNING" BASELINE.
 *
 * Group the training rows by (diagnosed cause, action kind) and predict each group's observed
 * recovery rate. No gradients, no features, no model — a GROUP BY, which any competent engineer
 * would write in an afternoon.
 *
 * It is here because it is the baseline most ML write-ups omit, and omitting it is how a project
 * claims credit for a lookup table. It has real advantages too: perfectly calibrated by
 * construction within each group, trivially auditable, and it cannot extrapolate nonsense.
 *
 * Its weaknesses are equally structural, and predictable in advance: it ignores amount, age,
 * fatigue, timing and channel entirely, and it has nothing to say about a (cause, action) pair it
 * never saw. So the fair comparison is not "did the fancy model win" but "did the fancy model win
 * by enough to justify being harder to audit." Both halves of that get reported.
 *
 * `key` is passed in rather than hard-coded so the same machinery can test a richer grouping — a
 * fair fight requires letting the simple model be as good as it can easily be.
 */
export function fitLookupTable(rows, { key = (r) => `${r.actionKind}` , minCount = 10 } = {}) {
  const groups = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!groups.has(k)) groups.set(k, { n: 0, positives: 0 });
    const g = groups.get(k);
    g.n += 1;
    g.positives += r.y;
  }

  const globalRate = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  const table = new Map();
  for (const [k, g] of groups) {
    // Thin groups fall back to the global rate. Without this a group of three rows that all failed
    // predicts exactly 0.0, and an EV engine reading 0.0 will permanently stop a case on the
    // evidence of three observations.
    table.set(k, g.n >= minCount ? g.positives / g.n : globalRate);
  }

  return {
    kind: 'lookup',
    table,
    globalRate,
    groups: table.size,
    /** Takes a ROW, not a feature vector — the grouping is over semantic fields, not features. */
    predictRow: (r) => table.get(key(r)) ?? globalRate,
  };
}
