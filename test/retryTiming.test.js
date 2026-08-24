/**
 * THE RETRY-TIMING GAP — PINNED, THEN FIXED
 * =========================================
 *
 * Found on Day 6 by reading the decision engine's own audit trail, not by reading the simulator.
 * Case evt_000001 ranked seven RETRY_SCHEDULED candidates and every one of them scored ₹41 — an
 * exact tie in paise, resolved by the deterministic alphabetical tiebreak. A tie that wide is not a
 * coincidence, and chasing it produced the most consequential defect found so far.
 *
 * `recoveryProbability` never read `action.scheduledFor`. The funds-timing branch computed the
 * salary-window boost from `now`, the moment of the DECISION, which is identical for every candidate
 * being compared. So the simulator could not express a preference between retrying in six hours and
 * retrying in three days, even though its own docblock on `salaryWindowBoost` says the parameter is
 * "the largest single timing effect in the model", that it is "the mechanism that rewards
 * RETRY_SCHEDULED over RETRY_NOW", and — in the funds branch itself — that the decay is "what makes
 * *which* scheduled slot the agent picks matter, not merely that it scheduled at all."
 *
 * HOW THIS FILE WAS WRITTEN, AND WHY THAT ORDER MATTERED. The first three tests were committed as
 * `todo` before any fix existed: they asserted the behaviour the simulator documented and did not
 * have. `todo` rather than a passing test of current behaviour, because a green test asserting that
 * timing does not matter would eventually be read as a specification; and `todo` rather than a
 * failing test, because a red suite trains you to ignore red. They were the definition of done, and
 * writing them first is what stopped the fix from being scoped by whatever happened to be easy.
 *
 * They are live assertions now. The remaining tests pinned the parts that had to survive the fix —
 * the structural zero, the clamp, the tiebreak's meaning — and all of them still pass unchanged,
 * which is the more informative half of this file.
 *
 * ONE PIN IS DELIBERATELY STILL RED IN SPIRIT: the last test asserts that the shipped lookup key
 * cannot tell two slots apart. It passes, and what it documents is a live limitation, not a solved
 * one. See its docblock.
 *
 * Run: node --test test/retryTiming.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { recoveryProbability, materialiseAssumptions } from '../src/sim/responseModel.js';
import { ActionKind, actionSignature } from '../src/core/actions.js';
import { PayerType } from '../src/sim/payerTypes.js';

const A = materialiseAssumptions();
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const NOW = new Date('2026-08-24T09:30:00Z');
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

/**
 * The exact case `salaryWindowBoost` exists to model: a payer who intends to pay and cannot yet,
 * with a credit landing in two days. Before the credit a retry is near-hopeless; just after it, it
 * is the best moment that will ever exist for this case; a week later the money has been spent.
 */
const SHORT = Object.freeze({
  payerType: PayerType.TEMPORARILY_SHORT,
  fundsAvailableFrom: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
});
const EVENT = Object.freeze({
  amountPaise: 100_000,
  occurredAt: '2026-08-22T09:30:00Z',
  lossType: 'FAILED_PAYMENT',
});

const BEFORE_FUNDS = { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(6 * HOUR_MS) };
const JUST_AFTER = { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(3 * DAY_MS) };
const WINDOW_GONE = { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(9 * DAY_MS) };

/**
 * Prices an action the way the dataset labels rows: one `now` — the decision instant — for every
 * candidate. That used to be the whole bug; the point of the fix is that this helper is now enough,
 * because the model derives the landing instant from the action itself rather than from its caller.
 * Deliberately kept in this shape so these tests exercise the real call site, not a corrected one.
 */
const price = (action, latent = SHORT) =>
  recoveryProbability({ action, latent, event: EVENT, now: NOW, touchesUsed: 0, assumptions: A });

// =============================================================================================
// THE GAP — these three were `todo` in the commit that added the file
// =============================================================================================

test('a scheduled retry is priced at the instant it lands, not the instant it was decided', () => {
  /**
   * MEASURED, BEFORE AND AFTER THE FIX:
   *
   *   offset   as labelled before   after honouring the scheduled instant
   *   +6h          0.032094                 0.031146   (before the credit — still hopeless)
   *   +3d          0.032094                 0.800953   (just after — 25x better)
   *   +9d          0.032094                 0.244365   (window has decayed)
   *
   * The left column is what every number this project produced up to Day 6 was computed against. A
   * 25x difference in recovery probability, on the single decision the product is most distinctive
   * about, was invisible to the ground truth.
   */
  const before = price(BEFORE_FUNDS).p;
  const after = price(JUST_AFTER).p;
  const late = price(WINDOW_GONE).p;

  assert.ok(after > before * 5, `retrying after the credit should dominate: ${after} vs ${before}`);
  assert.ok(after > late * 2, `the window decays, so +3d should beat +9d: ${after} vs ${late}`);
});

test('the funds penalty is decided by when the retry lands, so a scheduled retry can escape it', () => {
  /**
   * `preFundsPenalty` (0.06) applies when the retry lands before the credit. It used to apply to
   * every scheduled retry regardless of slot, including slots landing after the money arrived — the
   * penalty for charging an empty account was levied on a retry deliberately timed to avoid it.
   * That was the specific arithmetic that made scheduling worthless in this simulator.
   */
  assert.equal(price(BEFORE_FUNDS).breakdown.preFunds, A.preFundsPenalty, 'a pre-credit slot is penalised');
  assert.equal(price(JUST_AFTER).breakdown.preFunds, undefined, 'a post-credit slot must not be');
  assert.ok(price(JUST_AFTER).breakdown.salaryWindow > 1, 'and should collect the salary-window boost');
});

test('waiting longer is not free, so the optimum is interior rather than "wait forever"', () => {
  /**
   * ADDED WITH THE FIX, NOT BEFORE IT — this is the test the pre-fix pins did not think to demand,
   * and the one that decides whether the fix is honest.
   *
   * Moving the funds branch to the landing instant, on its own, makes later strictly better whenever
   * a credit is pending: the boost only appears once you wait, and nothing charges you for waiting.
   * A policy optimising against that ground truth would learn to schedule as late as the guardrails
   * allow, which is not a recovery strategy, it is a stalling strategy that happens to score well.
   *
   * Age decay is what prices the wait, so it had to move to the landing instant too. With both
   * moved, +3d beats both +6h and +9d — the optimum sits strictly between the extremes, which is
   * the shape a timing decision has to have for choosing a slot to be a real decision.
   */
  const ps = [BEFORE_FUNDS, JUST_AFTER, WINDOW_GONE].map((a) => price(a).p);
  assert.ok(ps[1] > ps[0] && ps[1] > ps[2], `optimum is not interior: ${ps.join(' / ')}`);

  // And the mechanism, checked directly rather than inferred: a later slot carries more decay.
  const soon = price(BEFORE_FUNDS).breakdown;
  const later = price(WINDOW_GONE).breakdown;
  assert.ok(later.ageDays > soon.ageDays, 'a later slot must be treated as an older case');
  assert.ok(later.ageDecay < soon.ageDecay, 'and must therefore pay more decay');
});

test('the salary-window assumption is not inert, so sweeping it measures something', () => {
  /**
   * WHY THIS ONE IS SEPARATE. Days 8-9 sweep `salaryWindowBoost` over [1.6, 3.2]. If no candidate's
   * probability varies with it, the sweep reports "robust to this assumption" for the sole reason
   * that the assumption cannot act — which is the same class of false robustness that
   * `recoveryProbability` already refuses to permit via a silent assumptions default. The file
   * guarded one route to a meaningless sweep and contained another.
   *
   * The test is therefore about the sweep's validity, not about any one probability.
   */
  const low = materialiseAssumptions({ salaryWindowBoost: 1.6 });
  const high = materialiseAssumptions({ salaryWindowBoost: 3.2 });
  const p = (assumptions) =>
    recoveryProbability({ action: JUST_AFTER, latent: SHORT, event: EVENT, now: NOW, touchesUsed: 0, assumptions }).p;

  assert.notEqual(p(low), p(high), 'salaryWindowBoost does not move a scheduled retry at all');
});

test('a slot in the past cannot land before it was decided, and a malformed one crashes', () => {
  /**
   * Two edge cases with deliberately different treatments, because they are different kinds of
   * event. A stale scheduled action arriving late is normal operations — clamp it to `now`, since
   * nothing can land in the past. An unparseable `scheduledFor` is a programming error, and it must
   * throw: NaN propagates silently through every multiplication below, `clamp01(NaN)` returns NaN,
   * and the case would then be priced at a probability for which every comparison is false. Silence
   * is the worst available outcome, so it is the one behaviour explicitly forbidden.
   */
  const past = { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(-5 * DAY_MS) };
  assert.equal(price(past).breakdown.effectiveAt, NOW.toISOString(), 'a past slot was not clamped to now');
  assert.equal(price(past).breakdown.scheduledDelayHours, 0);

  assert.throws(
    () => price({ kind: ActionKind.RETRY_SCHEDULED, scheduledFor: 'next tuesday' }),
    /not a valid date/
  );
});

// =============================================================================================
// WHAT MUST SURVIVE THE FIX
// =============================================================================================

test('a structural zero stays zero however cleverly it is scheduled', () => {
  /**
   * The fix makes timing matter, and the first temptation of a timing multiplier is to let it
   * rescue a case that no timing can rescue. A dead instrument is dead: no slot recovers a payer
   * who needs a new card, and the short-circuit must run before any timing factor is applied.
   */
  const dead = { payerType: PayerType.NEEDS_NEW_INSTRUMENT };
  for (const action of [BEFORE_FUNDS, JUST_AFTER, WINDOW_GONE, { kind: ActionKind.RETRY_NOW }]) {
    const { p, breakdown } = price(action, dead);
    assert.equal(p, 0, `${actionSignature(action)} rescued a structural zero`);
    assert.match(breakdown.reason, /structural zero/);
  }
});

test('scheduling cannot exceed a probability of 1 once the boost applies', () => {
  // 0.80 at the baseline 2.4x leaves little headroom, and the sweep goes to 3.2x. An unclamped
  // multiplier would produce a probability above 1, which would then be spent as expected gross
  // exceeding the amount at risk — recovering more than was lost.
  const generous = materialiseAssumptions({ salaryWindowBoost: 8 });
  const { p } = recoveryProbability({
    action: JUST_AFTER, latent: SHORT, event: EVENT,
    now: new Date(SHORT.fundsAvailableFrom), touchesUsed: 0, assumptions: generous,
  });
  assert.ok(p <= 1, `probability exceeded 1: ${p}`);
});

test('the tiebreak picks the soonest legal slot, and that is arithmetic rather than policy', () => {
  /**
   * WHY THIS IS PINNED EVEN THOUGH IT IS CURRENTLY HARMLESS.
   *
   * When candidates tie exactly, the engine breaks the tie on `actionSignature` alphabetically.
   * Signatures embed an ISO-8601 UTC instant, and ISO-8601 in UTC sorts lexicographically in the
   * same order as chronologically — so among tied scheduled retries the earliest slot always wins.
   *
   * "Act as soon as permitted" is a defensible default. But it is currently reached by accident of
   * string sorting, and it is the whole of the engine's answer to "when should we retry?" while the
   * probabilities are flat. Once timing is priced, this should almost never decide anything; if it
   * still does, the model is still blind and this test is the tripwire that says so.
   */
  const slots = [at(3 * DAY_MS), at(6 * HOUR_MS), at(9 * DAY_MS)]
    .map((scheduledFor) => actionSignature({ kind: ActionKind.RETRY_SCHEDULED, scheduledFor }));
  const alphabetical = [...slots].sort();
  const chronological = [...slots].sort(
    (a, b) => new Date(a.split(':').slice(1).join(':')) - new Date(b.split(':').slice(1).join(':'))
  );
  assert.deepEqual(alphabetical, chronological, 'lexicographic order stopped matching chronological order');
  assert.match(alphabetical[0], /2026-08-24T15:30/, 'the soonest slot sorts first');
});

test('the shipped lookup key still cannot distinguish two slots, and that is now a live cost', () => {
  /**
   * FIXING THE SIMULATOR WAS NECESSARY AND IS NOT SUFFICIENT — AND THIS TEST GOT MORE IMPORTANT,
   * NOT LESS, THE MOMENT THE FIX LANDED.
   *
   * The lookup arm groups on (diagnosedCause, actionKind); `+6h` and `+3d` share a kind, so they
   * land in one cell and receive one rate no matter how far apart their true rates are. Before the
   * fix that cost nothing, because the true rates were identical too. After it, the ground truth
   * separates those slots by 25x and the lookup table still averages them — so the blindness now
   * costs real simulated money rather than being a wash. This is precisely the "fixing only the
   * loud half is worse than today" warning from the Day 6 log, and the fix does not resolve it; it
   * activates it.
   *
   * What makes that a finding rather than a regression: `src/ml/features.js` already emits
   * `salaryWindow`, `delayDays` and `isScheduled`, all computed from `action.scheduledFor`. So the
   * logistic and gbm arms can represent the effect and the GROUP BY structurally cannot. Day 5
   * concluded "ML does not measurably beat a GROUP BY here" (−0.32% ± 0.29%, t = −1.09) — and that
   * was measured against a ground truth in which the one thing ML could express and a GROUP BY
   * could not had been switched off. Whether the conclusion survives is the pre-registered question,
   * not an assumption; the prediction and its kill condition were written down before the sweep was
   * re-run, and the answer is recorded in ENGINEERING_LOG.md either way.
   */
  const key = (r) => `${r.diagnosedCause}|${r.actionKind}`;
  const rowFor = (action) => ({ diagnosedCause: 'INSUFFICIENT_FUNDS', actionKind: action.kind });
  assert.equal(key(rowFor(BEFORE_FUNDS)), key(rowFor(JUST_AFTER)), 'the key already separates slots');

  // The gap the key has to swallow, stated as a number so this test fails loudly if the fix is
  // ever reverted and the limitation quietly becomes free again.
  assert.ok(price(JUST_AFTER).p > price(BEFORE_FUNDS).p * 5, 'the two slots the key merges are no longer far apart');
});
