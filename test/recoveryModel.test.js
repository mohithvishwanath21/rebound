/**
 * THE SEAM BETWEEN THE MODEL AND THE ENGINE
 * =========================================
 *
 * Two things are tested here, and both exist because of the same Day 5 finding: a GROUP BY returns a
 * number for cells it has never seen, and 31% backed by 47 observations is byte-identical to 31%
 * meaning "no data, here is the average". The decision engine gates its stopping rules on that
 * distinction, so something has to carry it across the seam.
 *
 *   1. `fitLookupTable(...).supportFor(row)` — per-row support, which the table could not report
 *      before. `coverageOf(rows)` answers the batch question and a decision is not a batch.
 *   2. `createRecoveryScorer` — the adapter that produces `scoreAction` for `decideForCase`.
 *
 * Run: node --test test/recoveryModel.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { fitLookupTable } from '../src/ml/calibration.js';
import { featureNames } from '../src/ml/features.js';
import { createRecoveryScorer, createConstantScorer, rowForScoring } from '../src/agent/recoveryModel.js';
import { ActionKind } from '../src/core/actions.js';

const KEY = (r) => `${r.diagnosedCause}|${r.actionKind}`;

/**
 * A hand-built fit set with three cells of known composition, so every rate below is checkable
 * without running the fitter:
 *
 *   INSUFFICIENT_FUNDS|RETRY_NOW    20 rows, 5 positive   -> 0.25, SUPPORTED
 *   EXPIRED_CARD|RETRY_NOW           4 rows, 4 positive   -> collapses to the global rate, THIN
 *   EXPIRED_CARD|REQUEST_REAUTH     16 rows, 8 positive   -> 0.50, SUPPORTED
 *
 * Global rate: (5 + 4 + 8) / 40 = 17/40 = 0.425
 */
function rows(cause, kind, n, positives) {
  return Array.from({ length: n }, (_, i) => ({
    diagnosedCause: cause,
    actionKind: kind,
    y: i < positives ? 1 : 0,
  }));
}

const FIT = [
  ...rows('INSUFFICIENT_FUNDS', ActionKind.RETRY_NOW, 20, 5),
  ...rows('EXPIRED_CARD', ActionKind.RETRY_NOW, 4, 4),
  ...rows('EXPIRED_CARD', ActionKind.REQUEST_REAUTH, 16, 8),
];

const table = () => fitLookupTable(FIT, { key: KEY, minCount: 10 });

const call = (scoreAction, cause, kind, extra = {}) =>
  scoreAction({ diagnosis: { rootCause: cause }, observed: { eventId: 'e' }, action: { kind, ...extra } });

// =============================================================================================
// PER-ROW SUPPORT
// =============================================================================================

test('the fit set is composed as the comments claim', () => {
  // If this drifts, every number below becomes untraceable and the tests stop being hand-checkable.
  const t = table();
  assert.equal(FIT.length, 40);
  assert.equal(t.globalRate, 0.425);
  assert.equal(t.groups, 3);
  assert.equal(t.supportedGroups, 2);
});

test('a well-observed cell reports SUPPORTED with its row count', () => {
  const s = table().supportFor({ diagnosedCause: 'INSUFFICIENT_FUNDS', actionKind: ActionKind.RETRY_NOW });
  assert.equal(s.state, 'SUPPORTED');
  assert.equal(s.rows, 20);
});

test('a cell that exists but collapsed reports THIN, and still reports how thin', () => {
  /**
   * THE STATE THAT MATTERS MOST, because it is the one that is easiest to mistake for evidence. This
   * cell went 4 for 4 — an apparently perfect 100% recovery rate — and `minCount` correctly replaced
   * it with the 42.5% global average. A stopping rule reading only the probability would see a
   * number no more suspicious than any other.
   *
   * `rows: 4` is the point. It is not zero, so "we have never seen this" is false; it is not twenty,
   * so "we know this" is also false. Reporting the count rather than a bare flag is what lets a
   * reviewer disagree with the threshold instead of just with the verdict.
   */
  const s = table().supportFor({ diagnosedCause: 'EXPIRED_CARD', actionKind: ActionKind.RETRY_NOW });
  assert.equal(s.state, 'THIN');
  assert.equal(s.rows, 4);

  // And the prediction really is the fallback, not the cell's own flattering 1.0.
  assert.equal(table().predictRow({ diagnosedCause: 'EXPIRED_CARD', actionKind: ActionKind.RETRY_NOW }), 0.425);
});

test('a cell absent from the fit reports UNSEEN with zero rows', () => {
  const s = table().supportFor({ diagnosedCause: 'INSTRUMENT_NOT_ACCEPTED', actionKind: ActionKind.SEND_LINK });
  assert.equal(s.state, 'UNSEEN');
  assert.equal(s.rows, 0);
});

test('per-row support agrees with the batch coverage it was factored out of', () => {
  /**
   * `coverageOf` and `supportFor` must not be able to disagree — one is the aggregate of the other,
   * and two independent implementations of the same count is how a dashboard ends up contradicting
   * its own detail view.
   */
  const t = table();
  const score = [
    { diagnosedCause: 'INSUFFICIENT_FUNDS', actionKind: ActionKind.RETRY_NOW },  // SUPPORTED
    { diagnosedCause: 'EXPIRED_CARD', actionKind: ActionKind.RETRY_NOW },        // THIN
    { diagnosedCause: 'NOBODY_HAS_SEEN_THIS', actionKind: ActionKind.RETRY_NOW }, // UNSEEN
  ];
  const cov = t.coverageOf(score);
  const states = score.map((r) => t.supportFor(r).state);

  assert.equal(cov.unseen, states.filter((s) => s === 'UNSEEN').length);
  assert.equal(cov.thin, states.filter((s) => s === 'THIN').length);
  assert.equal(cov.fallback, 2);
});

// =============================================================================================
// THE ADAPTER
// =============================================================================================

test('the scorer returns a probability and its support together', () => {
  const scoreAction = createRecoveryScorer({ model: table() });
  const b = call(scoreAction, 'INSUFFICIENT_FUNDS', ActionKind.RETRY_NOW);

  assert.equal(b.p, 0.25);
  assert.equal(b.support.state, 'SUPPORTED');
  assert.equal(b.support.rows, 20);
  assert.equal(b.cell, 'INSUFFICIENT_FUNDS|RETRY_NOW');
});

test('an action that cannot recover money gets no probability rather than a base rate', () => {
  /**
   * The base rate is 42.5% here. Handing that to ESCALATE_HUMAN would give the audit trail a
   * plausible-looking "42.5% chance of recovery" next to an action whose gross is structurally zero
   * — a number no measurement in this repo could ever check, which is precisely why
   * `expectedValue` refuses to price escalation in the first place. The refusal has to start here or
   * it is undone one layer down.
   */
  const scoreAction = createRecoveryScorer({ model: table() });
  for (const kind of [ActionKind.NO_ACTION_YET, ActionKind.ESCALATE_HUMAN, ActionKind.STOP_PERMANENT]) {
    const b = call(scoreAction, 'INSUFFICIENT_FUNDS', kind);
    assert.equal(b.p, 0, `${kind} was given a probability`);
    assert.equal(b.support.state, 'NOT_APPLICABLE');
  }
});

test('an unseen cell is scored at the base rate and flagged as unsupported, not refused', () => {
  /**
   * Both halves matter. Refusing to score would remove the action from the ranking entirely and the
   * agent would silently stop considering anything novel; scoring it without the flag is the Day 5
   * bug. So: a usable number, and a label saying not to close a case on it.
   */
  const scoreAction = createRecoveryScorer({ model: table() });
  const b = call(scoreAction, 'BRAND_NEW_CAUSE', ActionKind.RETRY_NOW);
  assert.equal(b.p, 0.425);
  assert.equal(b.support.state, 'UNSEEN');
  assert.equal(b.support.rows, 0);
});

test('calibration is applied to the level and cannot reorder the actions', () => {
  /**
   * The property that lets Platt scaling sit at this seam rather than inside the argmax: it is
   * monotone, so it can change whether the winner clears the rupee bar but never which action wins.
   * A calibrator that reversed an ordering would silently change the policy while looking like a
   * presentational fix.
   *
   * `apply` here is a deliberately aggressive monotone squash, not a fitted Platt — the test is
   * about the invariant, and a real fit on this toy table would be close to the identity and prove
   * nothing.
   */
  const squash = { apply: (p) => 0.1 + 0.2 * p };
  const plain = createRecoveryScorer({ model: table() });
  const cal = createRecoveryScorer({ model: table(), calibrator: squash });

  const cells = [
    ['INSUFFICIENT_FUNDS', ActionKind.RETRY_NOW],
    ['EXPIRED_CARD', ActionKind.REQUEST_REAUTH],
    ['BRAND_NEW_CAUSE', ActionKind.RETRY_NOW],
  ];
  const order = (s) => cells
    .map(([c, k]) => ({ cell: `${c}|${k}`, p: call(s, c, k).p }))
    .sort((a, b) => b.p - a.p || a.cell.localeCompare(b.cell))
    .map((x) => x.cell);

  assert.deepEqual(order(cal), order(plain), 'calibration reordered the actions');

  // The level did move, which is the whole point: 0.5 -> 0.1 + 0.1 = 0.2.
  assert.equal(call(cal, 'EXPIRED_CARD', ActionKind.REQUEST_REAUTH).p, 0.2);
  assert.equal(call(cal, 'EXPIRED_CARD', ActionKind.REQUEST_REAUTH).raw, 0.5);
});

test('probabilities are clamped off 0 and 1', () => {
  /**
   * A cell of eleven observations that all failed predicts exactly 0.0, and zero is not a small
   * number — it makes a retry's expected gross exactly zero regardless of the amount at risk, so a
   * ₹50,000 case and a ₹50 case become indistinguishable. Finite data does not license either
   * endpoint.
   */
  const allFail = fitLookupTable(rows('DEAD_CELL', ActionKind.RETRY_NOW, 12, 0), { key: KEY, minCount: 10 });
  const allWin = fitLookupTable(rows('SURE_THING', ActionKind.RETRY_NOW, 12, 12), { key: KEY, minCount: 10 });

  assert.equal(allFail.predictRow({ diagnosedCause: 'DEAD_CELL', actionKind: ActionKind.RETRY_NOW }), 0);
  assert.equal(call(createRecoveryScorer({ model: allFail }), 'DEAD_CELL', ActionKind.RETRY_NOW).p, 0.001);
  assert.equal(call(createRecoveryScorer({ model: allWin }), 'SURE_THING', ActionKind.RETRY_NOW).p, 0.98);
});

test('a model that cannot report support says so instead of silently disabling every stop', () => {
  /**
   * Support flows through `classifySupport`, which maps a missing value to UNKNOWN, and UNKNOWN is
   * not in TRUSTED_SUPPORT — so a scorer with no support signal blocks every permanent closure and
   * routes the whole batch to a human. That is the safe direction, and it is also a demo that
   * escalates 100% of its cases while reporting healthy guardrails. The state has to be legible in
   * the record, not inferred from behaviour.
   */
  const bare = { predictRow: () => 0.3 };
  const b = call(createRecoveryScorer({ model: bare }), 'ANY', ActionKind.RETRY_NOW);
  assert.equal(b.support.state, 'UNKNOWN');
  assert.match(b.support.note, /every stop will be blocked/);
});

test('the row shape the scorer builds is the shape the table was keyed on', () => {
  /**
   * The failure this guards is silent and total: a mismatched key makes every lookup miss, every
   * cell read UNSEEN, and the agent escalate the entire batch — which presents as excessive caution
   * rather than as a bug. Nothing in the output would say "the key is wrong".
   */
  const r = rowForScoring({ diagnosis: { rootCause: 'EXPIRED_CARD' }, action: { kind: ActionKind.RETRY_NOW } });
  assert.equal(KEY(r), 'EXPIRED_CARD|RETRY_NOW');
  assert.ok(table().table.has(KEY(r)), 'the scorer builds a row the fitted table cannot find');

  // A missing diagnosis becomes UNKNOWN rather than 'undefined|RETRY_NOW', which would be an
  // unseen cell whose name looks like a bug report.
  assert.equal(rowForScoring({ diagnosis: null, action: { kind: ActionKind.RETRY_NOW } }).diagnosedCause, 'UNKNOWN');
});

test('the adapter refuses inputs it cannot honour', () => {
  assert.throws(() => createRecoveryScorer({ model: {} }), TypeError);
  assert.throws(() => createRecoveryScorer({ model: table(), calibrator: { a: 1 } }), TypeError);
  assert.throws(() => call(createRecoveryScorer({ model: table() }), 'ANY', undefined), TypeError);

  // A model whose predictRow returns nothing must not be read as zero.
  const broken = { predictRow: () => undefined, supportFor: () => ({ state: 'SUPPORTED', rows: 9 }) };
  assert.throws(() => call(createRecoveryScorer({ model: broken }), 'ANY', ActionKind.RETRY_NOW), TypeError);
});

// =============================================================================================
// THE FEATURE-MODEL PATH — added when the engine stopped shipping a GROUP BY
// =============================================================================================

/**
 * WHY THESE EXIST, AND WHAT THEY WOULD HAVE CAUGHT.
 *
 * For six days the decision engine scored with a table keyed on (diagnosed cause, action kind). Two
 * `RETRY_SCHEDULED` candidates a week apart share both, so they shared a cell and received one rate:
 * the audit trail printed seven scheduled candidates tied to the paise, decided by an alphabetical
 * tiebreak on the signature. That was invisible while the simulator also priced every slot alike, and
 * became live error the moment it did not.
 *
 * Nothing failed when the engine was blind, which is the actual lesson. These tests are the tripwire
 * that was missing: they assert the SEAM can carry a timing distinction, so reverting the arm to a
 * GROUP BY breaks a test instead of quietly costing money.
 */

/** A feature model in the shape `fitLogistic` returns: `predict(x)` over a vector, and no support. */
const timingSensitive = (names) => ({
  kind: 'logistic',
  predict: (x) => {
    const i = names.indexOf('salaryWindow');
    return 0.05 + 0.9 * (i >= 0 ? x[i] : 0);
  },
});

test('a feature model prices two scheduled slots differently, which a GROUP BY cannot', () => {
  const names = featureNames();
  const scoreAction = createRecoveryScorer({
    model: timingSensitive(names),
    supportFrom: table(),
    modelName: 'logistic',
  });

  const now = new Date('2026-08-24T09:30:00Z');
  const priceSlot = (scheduledFor) =>
    scoreAction({
      diagnosis: { rootCause: 'INSUFFICIENT_FUNDS', physics: {} },
      observed: { lossType: 'FAILED_PAYMENT', rail: 'CARD', amountPaise: 100_000 },
      action: { kind: ActionKind.RETRY_SCHEDULED, scheduledFor },
      context: { now, touchesUsed: 0 },
    });

  // Two slots that a (cause, kind) key merges by construction.
  const a = priceSlot('2026-08-25T09:30:00Z');
  const b = priceSlot('2026-08-31T09:30:00Z');

  assert.equal(rowForScoring({ diagnosis: { rootCause: 'INSUFFICIENT_FUNDS' }, action: { kind: ActionKind.RETRY_SCHEDULED } }).actionKind,
    ActionKind.RETRY_SCHEDULED);
  assert.notEqual(a.p, b.p, 'the seam collapsed two slots to one probability again');

  // And the audit trail must be able to say WHY, not merely that they differ. A number that moves
  // for reasons the record cannot show is the same problem in a nicer costume.
  assert.ok(a.timing, 'no timing evidence in the belief');
  assert.notEqual(a.timing.salaryWindow, b.timing.salaryWindow);
  assert.equal(a.timing.isScheduled, 1);
});

test('support comes from the table even when the probability does not', () => {
  /**
   * A logistic will return a confident number for a (cause, action) region it never saw — exactly what
   * the stopping rules exist to catch, and the reason a naive arm swap is dangerous rather than
   * merely wrong. Probability and support are answered by different instruments on purpose.
   */
  const names = featureNames();
  const scoreAction = createRecoveryScorer({
    model: timingSensitive(names),
    supportFrom: table(),
    modelName: 'logistic',
  });
  const seen = call(scoreAction, 'INSUFFICIENT_FUNDS', ActionKind.RETRY_NOW);
  const never = call(scoreAction, 'NOBODY_HAS_SEEN_THIS', ActionKind.RETRY_NOW);

  assert.equal(seen.support.state, 'SUPPORTED');
  assert.equal(seen.support.rows, 20);
  assert.equal(never.support.state, 'UNSEEN');
  assert.ok(Number.isFinite(never.p), 'the model still has to produce a usable number');

  // Omitting supportFrom for a model with no supportFor is the escalate-everything trap.
  const unsupported = createRecoveryScorer({ model: timingSensitive(names), modelName: 'logistic' });
  assert.equal(call(unsupported, 'INSUFFICIENT_FUNDS', ActionKind.RETRY_NOW).support.state, 'UNKNOWN');
});

test('a feature vector narrower than the fitted weights is refused, not silently dot-producted', () => {
  /**
   * The failure mode this forbids is unfalsifiable from the output: a vector one column short still
   * produces a finite, plausible probability, just computed against the wrong columns. It would show
   * up as a policy that is mysteriously slightly bad forever.
   */
  const wrongWidth = { kind: 'logistic', predict: () => 0.3, weights: new Array(featureNames().length + 1).fill(0.1) };
  assert.throws(() => createRecoveryScorer({ model: wrongWidth, supportFrom: table() }), /width mismatch/);

  const rightWidth = { kind: 'logistic', predict: () => 0.3, weights: new Array(featureNames().length).fill(0.1) };
  assert.doesNotThrow(() => createRecoveryScorer({ model: rightWidth, supportFrom: table() }));
});


test('the shipped CLI wires a timing-aware arm, with support supplied separately', () => {
  /**
   * A SOURCE-LEVEL CHECK, AND IT IS THE ONLY TEST HERE THAT WOULD HAVE CAUGHT THE REAL BUG.
   *
   * Everything above proves the seam *can* carry a timing distinction. None of it proves the shipped
   * entry point *does* — and for six days it did not: `decide-report.js` built its scorer from the
   * lookup table while `npm run select-arm` printed `SELECTED: logistic`. Two defensible files, one
   * undocumented divergence, no failing test. The engine was blind and the suite was green, which is
   * the whole reason this assertion is worth its brittleness.
   *
   * Checking source text is a weaker instrument than checking behaviour, and it is used here for the
   * same reason `boundary.test.js` and `armSelection.test.js` use it: the property is architectural.
   * The alternative — fitting a real logistic and deciding a batch — costs seconds per run and would
   * be measuring the fitter, not the wiring. If this test ever has to be relaxed, the thing to add is
   * an end-to-end assertion that no two scheduled candidates tie, not a looser regex.
   */
  const src = readFileSync(new URL('../src/eval/cli/decide-report.js', import.meta.url), 'utf8');
  const ctor = src.match(/createRecoveryScorer\(\{[\s\S]*?\}\)/);
  assert.ok(ctor, 'decide-report.js no longer constructs a recovery scorer');

  assert.match(ctor[0], /model:\s*logistic/, 'the CLI is not scoring with the arm select-arm selects');
  assert.match(ctor[0], /supportFrom:\s*lookup/, 'support is not being supplied from the table');
  assert.doesNotMatch(ctor[0], /model:\s*lookup\b/, 'the CLI reverted to a GROUP BY and cannot see the slot');
});

test('the constant scorer distinguishes its two baselines', () => {
  /**
   * A constant scorer with SUPPORTED support and one with UNSEEN support are different baselines —
   * the first exercises the EV arithmetic, the second exercises escalation — and conflating them
   * produced a mysteriously escalation-heavy run earlier. Naming them separately is the fix.
   */
  const confident = createConstantScorer({ p: 0.2, state: 'SUPPORTED', rows: 500 });
  const ignorant = createConstantScorer({ p: 0.2, state: 'UNSEEN', rows: 0 });

  assert.equal(call(confident, 'X', ActionKind.RETRY_NOW).p, 0.2);
  assert.equal(call(ignorant, 'X', ActionKind.RETRY_NOW).p, 0.2);
  assert.equal(call(confident, 'X', ActionKind.RETRY_NOW).support.state, 'SUPPORTED');
  assert.equal(call(ignorant, 'X', ActionKind.RETRY_NOW).support.state, 'UNSEEN');
  assert.equal(call(confident, 'X', ActionKind.ESCALATE_HUMAN).p, 0);
});
