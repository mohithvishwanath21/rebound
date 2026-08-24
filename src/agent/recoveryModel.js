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
 * WHY THE ARM IS `lookup` AND NOT THE GRADIENT BOOSTER
 * ---------------------------------------------------
 * Because the measurement said so, twice. The five-arm table on a single split suggested the
 * structured models were ahead; a 20-world sweep corrected that and showed no arm measurably beats
 * a GROUP BY on (diagnosed cause, action) on this simulator. Shipping the booster anyway would mean
 * the headline architecture claim rested on a difference the eval could not detect. Swapping the arm
 * is a one-line change here (`createRecoveryScorer` takes any object with `predictRow`), and that is
 * the point of putting the seam in its own file: the choice is reversible and the evidence for it
 * lives in `npm run select-arm`.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not read latent truth, and it cannot: it is handed an `observation` and a `diagnosis`,
 * both produced downstream of `observe()`, which is boundary-tested. If this file ever imports from
 * `src/sim/`, `test/boundary.test.js` fails, and it should.
 */

import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING } from '../core/actions.js';

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
 * @param {object}   model         anything with `predictRow(row)`; `supportFor(row)` strongly preferred
 * @param {object?}  calibrator    Platt result from `fitPlatt`, i.e. `{ apply(p) }`
 * @param {string}   modelName     recorded in the audit trail so a decision can be traced to an arm
 * @returns {function} a `scoreAction` suitable for `decideForCase`
 */
export function createRecoveryScorer({ model, calibrator = null, modelName = 'lookup' } = {}) {
  if (typeof model?.predictRow !== 'function') {
    throw new TypeError('createRecoveryScorer needs a model exposing predictRow(row)');
  }
  if (calibrator !== null && typeof calibrator?.apply !== 'function') {
    throw new TypeError('calibrator must expose apply(p), as returned by fitPlatt');
  }

  /**
   * A model with no `supportFor` cannot distinguish evidence from a fallback, and the stopping
   * rules would then read UNKNOWN on every case and escalate everything. That is the safe
   * direction, but it silently disables the entire stopping mechanism — a demo that escalates 100%
   * of a batch while reporting healthy guardrails. Better to say so out loud.
   */
  const hasSupport = typeof model.supportFor === 'function';

  /**
   * CONSTRUCTION-TIME CHECK ON THE KEY AGREEMENT. If the row shape this file builds does not match
   * the one the table was fitted on, every lookup misses, every cell reads UNSEEN, and the failure
   * presents as excessive caution rather than as a bug. Probing one cell that must exist in any
   * non-empty fit turns that into an immediate error.
   */
  if (hasSupport) {
    const probe = model.supportFor(rowForScoring({ diagnosis: { rootCause: 'INSUFFICIENT_FUNDS' }, action: { kind: ActionKind.RETRY_NOW } }));
    if (!probe || typeof probe.state !== 'string') {
      throw new TypeError('model.supportFor(row) must return { state, rows }');
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
    const raw = model.predictRow(row);
    if (!Number.isFinite(raw)) {
      throw new TypeError(`model returned no probability for ${row.diagnosedCause}|${row.actionKind}`);
    }

    const calibrated = calibrator ? calibrator.apply(raw) : raw;
    const p = Math.min(P_CEILING, Math.max(P_FLOOR, calibrated));

    const support = hasSupport
      ? model.supportFor(row)
      : { state: 'UNKNOWN', rows: 0, note: 'model cannot report support; every stop will be blocked' };

    return { p, raw, calibrated, support, model: modelName, cell: `${row.diagnosedCause}|${row.actionKind}`, context: context.now ?? null };
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
