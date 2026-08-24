/**
 * THE SEAM BETWEEN THE PROBABILITY MODEL AND THE DECISION ENGINE
 * =============================================================
 *
 * `decideForCase` takes a `scoreAction` function and never learns anything about where the number
 * came from. This module is the only place that knows, and it exists because the decision engine
 * needs three things from an estimate that a scoring run does not:
 *
 *   1. A PROBABILITY PER CANDIDATE ACTION, not per row of a fitted dataset. The engine prices 23
 *      actions against one case; the model was fitted on rows that each already had an action
 *      attached. Something has to build the row.
 *
 *   2. SUPPORT ALONGSIDE THE PROBABILITY. Day 5 ended on the finding that
 *      `lookup.predictRow` returns a number for cells it has never seen, and that 31% backed by 47
 *      observations is indistinguishable from 31% meaning "no data, here is the average". The
 *      stopping rules gate on exactly that distinction, so the estimate and its support have to
 *      travel together — support is a property of the TRAINING DATA and nothing downstream could
 *      reconstruct it.
 *
 *   3. A CALIBRATED LEVEL, not just a usable ordering. Selection needs the ranking to be right;
 *      stopping needs 4% to mean four cases in a hundred, because the stop condition compares
 *      against a rupee bar. Those are different requirements from the same float, and Platt scaling
 *      is applied here rather than inside the argmax because it is monotone: it cannot change which
 *      action wins, only whether the winner clears the bar. Wiring it in at the seam makes that
 *      property obvious instead of load-bearing and invisible.
 *
 * WHICH ARM SHIPS, AND WHY THAT ANSWER CHANGED
 * --------------------------------------------
 * It was `lookup`, and the reason was good: a 20-world paired sweep found that no arm measurably beat
 * a GROUP BY on (diagnosed cause, action) on this simulator, so shipping a gradient booster would have
 * rested the headline architecture claim on a difference the eval could not detect.
 *
 * That reason expired on Day 6. The sweep it rested on was run against a simulator that priced every
 * scheduled retry at the decision instant, so the single thing a feature model can express and a
 * GROUP BY structurally cannot — WHEN to retry — had been switched off in the ground truth it was
 * measured against. With the simulator fixed, the paired difference under distribution shift is
 * −1.51% at t = −2.46, which clears the pre-declared bar of |t| ≥ 2.0. In distribution it still does
 * not (−0.42%, t = −1.36). So the honest claim is conditional, and it is stated that way everywhere.
 *
 * THOSE FOUR NUMBERS COME FROM `--seeds=20`, WHICH IS NOT THE DEFAULT. `npm run select-arm` runs ten
 * worlds and prints −0.85%/t = −1.98 in distribution and −2.51%/t = −2.22 under shift. Twenty was the
 * pre-registered design, so twenty is what is reported; the default was left at ten and the mismatch
 * is written up in the Day 6 log. Reproduce with `node src/eval/cli/select-arm.js --seeds=20`. Quoting
 * a t-statistic without the n behind it is how a reader ends up unable to reconcile two honest runs.
 *
 * Note also what the selection says about itself: `SELECTED: logistic — BY TIEBREAK, NOT BY
 * MEASUREMENT`. Three arms fail to separate in distribution and `gbm`, not `logistic`, leads mean
 * in-distribution regret. The arm ships on the preference order declared before the sweep ran, plus
 * the representational argument below — not because it was measured best on the selecting set.
 *
 * The decisive argument is not the t-statistic, though. It is that the GROUP BY *cannot represent the
 * decision the product is most distinctive about*. Two `RETRY_SCHEDULED` candidates a week apart share
 * a cause and a kind, so they share a cell and receive one rate — while the ground truth now separates
 * them by up to 25x. The audit trail showed seven scheduled candidates tied to the paise, resolved by
 * an alphabetical tiebreak on the action signature. No amount of data fixes that; it is the key.
 *
 * PROBABILITY AND SUPPORT NOW COME FROM DIFFERENT PLACES, DELIBERATELY
 * -------------------------------------------------------------------
 * A logistic model has no notion of support. It will happily extrapolate a confident number for a
 * (cause, action) pair it never saw, which is precisely the failure the stopping rules exist to catch,
 * and swapping the arm naively would have set `hasSupport` false and escalated every case in the batch
 * while the guardrail summary still looked healthy.
 *
 * So the two are separated: `model` estimates the probability, `supportFrom` reports how much data
 * backs it. That is not a workaround, it is the correct factoring — support answers "how many rows
 * were behind this?", which is a question about the TRAINING DATA and not about the estimator. The
 * coarse table remains the right instrument for it precisely because it is coarse: 66 dense cells give
 * a stable read on whether a region of the problem was observed at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not read latent truth, and it cannot: it is handed an `observation` and a `diagnosis`,
 * both produced downstream of `observe()`, which is boundary-tested. If this file ever imports from
 * `src/sim/`, `test/boundary.test.js` fails, and it should.
 */

import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING } from '../core/actions.js';
import { buildFeatures } from '../ml/features.js';

/** Kinds whose probability of recovering money is a real quantity. The rest are structurally zero. */
const RECOVERING = new Set([...MONEY_MOVING, ...CUSTOMER_CONTACTING]);

/**
 * The row shape the fitted lookup table groups on. Must stay in step with the key used at fit time
 * in `modelComparison.js` — `${diagnosedCause}|${actionKind}` — or every cell reads as UNSEEN and
 * the agent escalates the entire batch while looking like it is being careful.
 *
 * That failure is silent in the worst way, so `createRecoveryScorer` asserts against it at
 * construction time rather than trusting this comment.
 */
export function rowForScoring({ diagnosis, action }) {
  return {
    diagnosedCause: diagnosis?.rootCause ?? 'UNKNOWN',
    actionKind: action?.kind ?? null,
  };
}

/**
 * Clamp bounds. A cell of eleven observations that all failed predicts exactly 0.0, and a zero is
 * qualitatively different from a small number: it makes a retry's expected gross exactly zero and
 * hands the decision entirely to the cost terms, no matter how much money is at risk.
 *
 * `fitLookupTable`'s `minCount` already collapses thin cells to the global rate, so a hard 0.0 can
 * only arrive from a well-observed cell — where it is close to true and the floor barely moves it.
 * The floor is here for the arms that have no such guard, and because 0 and 1 are the two values a
 * probability should never be allowed to assert from finite data.
 */
const P_FLOOR = 0.001;
const P_CEILING = 0.98;

/**
 * The three feature columns that exist only to express retry timing. Surfaced in the returned belief
 * so the audit trail can show WHY two scheduled slots were priced differently, rather than asserting
 * that they were. When the shipped arm was a GROUP BY these were unreachable from the decision path,
 * and their absence from the audit trail is what let the tie go unnoticed for a day.
 */
const TIMING_COLUMNS = ['salaryWindow', 'delayDays', 'isScheduled'];

/**
 * @param {object}   model         `predictRow(row)` (a GROUP BY) or `predict(x)` (a feature model)
 * @param {object?}  calibrator    Platt result from `fitPlatt`, i.e. `{ apply(p) }`
 * @param {string}   modelName     recorded in the audit trail so a decision can be traced to an arm
 * @param {object?}  supportFrom   anything with `supportFor(row)`. REQUIRED for a feature model,
 *                                 which has no notion of support. See the header.
 * @returns {function} a `scoreAction` suitable for `decideForCase`
 */
export function createRecoveryScorer({ model, calibrator = null, modelName = 'lookup', supportFrom = null } = {}) {
  /**
   * TWO WAYS TO GET A PROBABILITY, AND THE DIFFERENCE IS THE WHOLE POINT OF THIS COMMIT.
   *
   * A GROUP BY consumes a `row` — a cause and an action kind — and by construction cannot see
   * anything else, including when a scheduled action lands. A feature model consumes the vector from
   * `buildFeatures`, which is built from the same `{diagnosis, observed, action, context}` the engine
   * already passes, with `context.now` set to the EXECUTION instant by `decide.js`. So the timing
   * information was flowing correctly through the engine the entire time; this seam was throwing it
   * away because the model on the other side had nowhere to put it.
   */
  const rowBased = typeof model?.predictRow === 'function';
  const featureBased = !rowBased && typeof model?.predict === 'function';
  if (!rowBased && !featureBased) {
    throw new TypeError('createRecoveryScorer needs a model exposing predictRow(row) or predict(featureVector)');
  }
  if (calibrator !== null && typeof calibrator?.apply !== 'function') {
    throw new TypeError('calibrator must expose apply(p), as returned by fitPlatt');
  }

  /**
   * A model with no support reporting cannot distinguish evidence from a fallback, and the stopping
   * rules would then read UNKNOWN on every case and escalate everything. That is the safe direction,
   * but it silently disables the entire stopping mechanism — a demo that escalates 100% of a batch
   * while reporting healthy guardrails. Better to say so out loud.
   */
  const supportModel = supportFrom ?? (typeof model?.supportFor === 'function' ? model : null);
  const hasSupport = typeof supportModel?.supportFor === 'function';

  const probeRow = rowForScoring({
    diagnosis: { rootCause: 'INSUFFICIENT_FUNDS' },
    action: { kind: ActionKind.RETRY_NOW },
  });

  /**
   * CONSTRUCTION-TIME CHECK ON THE KEY AGREEMENT. If the row shape this file builds does not match
   * the one the table was fitted on, every lookup misses, every cell reads UNSEEN, and the failure
   * presents as excessive caution rather than as a bug. Probing one cell that must exist in any
   * non-empty fit turns that into an immediate error.
   */
  if (hasSupport) {
    const probe = supportModel.supportFor(probeRow);
    if (!probe || typeof probe.state !== 'string') {
      throw new TypeError('supportFor(row) must return { state, rows }');
    }
  }

  /**
   * WIDTH CHECK, because the alternative is silent and wrong. `predict` dot-products the vector
   * against the fitted weights; a feature vector one column shorter than the weights it was fitted
   * against still produces a finite, plausible-looking probability, just computed against the wrong
   * columns. That is unfalsifiable from the output. Checked once here instead.
   */
  if (featureBased && Array.isArray(model.weights) && model.weights.length > 0) {
    const width = buildFeatures({
      diagnosis: { rootCause: 'INSUFFICIENT_FUNDS', physics: {} },
      observed: { lossType: 'FAILED_PAYMENT', rail: 'CARD', amountPaise: 1000 },
      action: { kind: ActionKind.RETRY_NOW },
      context: { now: new Date(0), touchesUsed: 0 },
    }).values.length;
    if (width !== model.weights.length) {
      throw new TypeError(
        `feature width mismatch: buildFeatures emits ${width} columns, model was fitted on ${model.weights.length}`
      );
    }
  }

  return function scoreAction({ diagnosis, observed, action, context = {} }) {
    if (!action?.kind) throw new TypeError('scoreAction needs an action with a kind');

    // Actions that cannot move money or reach a customer have no recovery probability to estimate.
    // Returning 0 rather than a base rate keeps `expectedValue` honest: their gross is structurally
    // zero, and inventing a probability for them would put a number next to "escalate to a human"
    // that no measurement in this repo could ever check.
    if (!RECOVERING.has(action.kind)) {
      return { p: 0, support: { state: 'NOT_APPLICABLE', rows: 0 }, model: modelName, raw: 0 };
    }

    const row = rowForScoring({ diagnosis, action });

    let raw;
    let timing = null;
    if (rowBased) {
      raw = model.predictRow(row);
    } else {
      const { names, values } = buildFeatures({ diagnosis, observed, action, context });
      raw = model.predict(values);
      timing = {};
      for (const col of TIMING_COLUMNS) {
        const i = names.indexOf(col);
        if (i >= 0) timing[col] = values[i];
      }
    }

    if (!Number.isFinite(raw)) {
      throw new TypeError(`model returned no probability for ${row.diagnosedCause}|${row.actionKind}`);
    }

    const calibrated = calibrator ? calibrator.apply(raw) : raw;
    const p = Math.min(P_CEILING, Math.max(P_FLOOR, calibrated));

    const support = hasSupport
      ? supportModel.supportFor(row)
      : { state: 'UNKNOWN', rows: 0, note: 'model cannot report support; every stop will be blocked' };

    return {
      p, raw, calibrated, support,
      model: modelName,
      cell: `${row.diagnosedCause}|${row.actionKind}`,
      ...(timing ? { timing } : {}),
      context: context.now ?? null,
    };
  };
}

/**
 * A fixed-probability scorer, for tests and for the "what if the model knew nothing" baseline in
 * the Day 8 eval. Named rather than inlined because a constant scorer with SUPPORTED support is a
 * meaningfully different baseline from one with UNSEEN support — the first exercises the EV
 * arithmetic, the second exercises the escalation path — and conflating them produced a
 * mysteriously escalation-heavy run earlier.
 */
export function createConstantScorer({ p = 0.11, state = 'SUPPORTED', rows = 1000 } = {}) {
  return function scoreAction({ action }) {
    if (!RECOVERING.has(action?.kind)) return { p: 0, support: { state: 'NOT_APPLICABLE', rows: 0 }, model: 'constant' };
    return { p, support: { state, rows }, model: 'constant', raw: p };
  };
}
