/**
 * LOGISTIC REGRESSION, BY HAND
 * ============================
 *
 * Gradient descent on the logistic loss with L2 regularisation. About a hundred lines of
 * arithmetic, no dependencies, and every step of it explainable at a whiteboard — which is a
 * requirement here rather than an aesthetic preference.
 *
 * WHY NOT A LIBRARY
 * -----------------
 * Two reasons, in order of importance. First, `npm install` does not work in this environment at
 * all, so every number this project reports has to be reproducible on a clean clone with zero
 * installed packages — that constraint has shaped the whole repo and it applies here too. Second,
 * `model.fit(X, y)` is a sentence I cannot defend in an interview. `w -= lr * (Xᵀ(σ(Xw) - y)/n +
 * λw)` is one I can derive on request, and being able to derive it is the point of using a linear
 * model rather than something fancier.
 *
 * WHY LOGISTIC AT ALL, GIVEN GBM IS ALSO HERE
 * -------------------------------------------
 * Because the coefficients are the explanation. `topCoefficients()` prints things like
 * "x:EXPIRED_INSTRUMENT*RETRY_NOW  -2.4", which is a readable domain claim that a reviewer can
 * agree or disagree with. A tree ensemble's 200 splits are not. For a system that has to justify
 * moving money, a model whose reasoning can be read off in a table is worth a few points of
 * accuracy — and `npm run model-report` measures exactly how many points that is, rather than
 * assuming the trade-off is small.
 *
 * THE ONE DECISION THAT WOULD BE WRONG HERE: CLASS REBALANCING
 * -----------------------------------------------------------
 * Only 11.2% of rows are positive, and the reflex for imbalanced data is to reweight the classes
 * or resample until they are even. That would be actively harmful for this application.
 *
 * Reweighting deliberately distorts the predicted probabilities upward — that is what it is for.
 * It buys better ranking and better recall at the cost of calibration. But the consumer of this
 * model is an expected-value calculation, `P × amount × margin − cost`, which multiplies the
 * probability by real money. A model that says 0.30 when the truth is 0.11 does not merely
 * mis-rank; it manufactures positive expected value out of nothing and authorises spending on
 * cases that should have been stopped.
 *
 * So the class balance is left exactly as it is, and calibration is measured directly. Imbalance
 * is a problem for a classifier that has to pick a threshold. It is not a problem for a model
 * whose output is consumed as a probability.
 */

/** Numerically stable logistic function. */
export function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  // For very negative z, exp(-z) overflows to Infinity and 1/(1+Inf) silently gives 0 — which
  // then produces log(0) = -Infinity in the loss. Reformulating avoids the overflow entirely.
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Clamp away from 0 and 1 so log loss stays finite. */
const EPS = 1e-12;
const safe = (p) => Math.min(1 - EPS, Math.max(EPS, p));

export function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i += 1) s += w[i] * x[i];
  return s;
}

/** Mean negative log likelihood. The thing gradient descent is actually minimising. */
export function logLoss(yTrue, pPred) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    const p = safe(pPred[i]);
    s += yTrue[i] === 1 ? -Math.log(p) : -Math.log(1 - p);
  }
  return s / yTrue.length;
}

/**
 * Fit weights by gradient descent with momentum.
 *
 * Momentum is the only embellishment on textbook GD, and it earns its place: the feature matrix
 * mixes dense columns (log amount, age) with 76 very sparse interaction columns, so the loss
 * surface is far steeper in some directions than others and plain GD zig-zags down the valley
 * instead of along it. Momentum accumulates a running average of the gradient, which cancels the
 * oscillating components and keeps the consistent ones. One extra line, and it is the difference
 * between converging in 400 iterations and not converging at all.
 *
 * @param rows      [{ x: number[], y: 0|1 }]
 * @param opts.l2   L2 penalty. NOT applied to the bias term — penalising the intercept would pull
 *                  the model's baseline rate toward 0.5, which for an 11% base rate means
 *                  deliberately mis-calibrating every single prediction.
 * @param opts.onIteration  optional callback, so convergence can be inspected rather than assumed
 */
export function fitLogistic(rows, {
  l2 = 1e-3,
  learningRate = 0.5,
  iterations = 600,
  momentum = 0.9,
  tolerance = 1e-7,
  onIteration,
} = {}) {
  if (!rows.length) throw new Error('fitLogistic: no rows');
  const d = rows[0].x.length;
  const n = rows.length;

  for (const r of rows) {
    if (r.x.length !== d) throw new Error(`fitLogistic: ragged feature vectors (${r.x.length} vs ${d})`);
  }

  const w = new Float64Array(d);
  const velocity = new Float64Array(d);
  const grad = new Float64Array(d);
  const history = [];

  // Initialise the bias to the base rate's log-odds rather than to zero. Costs one line and saves
  // roughly a hundred iterations that GD would otherwise spend just discovering that positives are
  // rare — the intercept has to travel a long way from 0 to log(0.11/0.89) and every other
  // coefficient is being fit against a badly wrong baseline until it gets there.
  const baseRate = rows.reduce((s, r) => s + r.y, 0) / n;
  w[0] = Math.log(safe(baseRate) / (1 - safe(baseRate)));

  let prevLoss = Infinity;
  let iterationsRun = 0;

  for (let it = 0; it < iterations; it += 1) {
    grad.fill(0);
    let loss = 0;

    for (let i = 0; i < n; i += 1) {
      const x = rows[i].x;
      const p = sigmoid(dot(w, x));
      const err = p - rows[i].y;
      for (let j = 0; j < d; j += 1) grad[j] += err * x[j];
      const ps = safe(p);
      loss += rows[i].y === 1 ? -Math.log(ps) : -Math.log(1 - ps);
    }

    loss /= n;
    for (let j = 0; j < d; j += 1) grad[j] /= n;

    // L2 on everything except the intercept.
    for (let j = 1; j < d; j += 1) {
      grad[j] += l2 * w[j];
      loss += 0.5 * l2 * w[j] * w[j] / n;
    }

    for (let j = 0; j < d; j += 1) {
      velocity[j] = momentum * velocity[j] - learningRate * grad[j];
      w[j] += velocity[j];
    }

    iterationsRun = it + 1;
    if (it % 25 === 0 || it === iterations - 1) history.push({ iteration: it, loss });
    onIteration?.({ iteration: it, loss });

    // Relative improvement, not absolute: an absolute threshold that works at loss 0.35 is
    // meaningless at loss 0.03.
    if (Math.abs(prevLoss - loss) / Math.max(loss, EPS) < tolerance) break;
    prevLoss = loss;
  }

  const weights = Array.from(w);

  return {
    kind: 'logistic',
    weights,
    iterationsRun,
    history,
    /** Final gradient norm, exposed so convergence can be VERIFIED rather than trusted. */
    finalGradNorm: Math.sqrt(Array.from(grad).reduce((s, g) => s + g * g, 0)),
    predict: (x) => sigmoid(dot(weights, x)),
  };
}

/**
 * The largest-magnitude coefficients, with names.
 *
 * This is the audit surface for the whole model, and the reason a linear model is here at all. A
 * reviewer who disagrees with "REQUEST_REAUTH on a dead instrument: +1.8" can say so, and be
 * right or wrong, without reading any code.
 *
 * Two honest caveats that must travel with any printed table of these. Coefficients are only
 * comparable across features on the same scale, and the one-hot columns are on a different scale
 * from `logAmount`. And a large coefficient on a column that is almost always zero moves very
 * little money, so `support` — how many rows the column is non-zero in — is printed alongside.
 * A big weight on a rare column is a curiosity; a big weight on a common one is a policy.
 */
export function topCoefficients(model, names, { limit = 20, rows = null } = {}) {
  const support = names.map(() => null);
  if (rows?.length) {
    for (let j = 0; j < names.length; j += 1) support[j] = 0;
    for (const r of rows) {
      for (let j = 0; j < r.x.length; j += 1) if (r.x[j] !== 0) support[j] += 1;
    }
  }

  return model.weights
    .map((w, j) => ({ name: names[j] ?? `w[${j}]`, weight: w, support: support[j] }))
    .filter((c) => c.name !== 'bias')
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
}

/**
 * Predict a whole dataset. Kept separate so metric functions never need a model object.
 */
export function predictAll(model, rows) {
  return rows.map((r) => model.predict(r.x));
}

/**
 * The no-model baseline: always predict the training base rate.
 *
 * Included because it is the number every other model has to beat to have justified existing, and
 * because it is a surprisingly strong baseline on imbalanced data. Its Brier score is p̄(1 − p̄),
 * which for an 11% base rate is about 0.0995 — so a model scoring 0.095 has learned almost
 * nothing, despite the number looking small in isolation.
 */
export function fitConstant(rows) {
  const p = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  return { kind: 'constant', rate: p, predict: () => p, weights: [], history: [] };
}
