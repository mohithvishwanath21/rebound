/**
 * THE RETRY-TIMING GAP, PINNED BEFORE IT IS FIXED
 * ===============================================
 *
 * Found on Day 6 by reading the decision engine's own audit trail, not by reading the simulator.
 * Case evt_000001 ranked seven RETRY_SCHEDULED candidates and every one of them scored ₹41 — an
 * exact tie in paise, resolved by the deterministic alphabetical tiebreak. A tie that wide is not a
 * coincidence, and chasing it produced the most consequential defect found so far.
 *
 * `recoveryProbability` never reads `action.scheduledFor`. The funds-timing branch computes the
 * salary-window boost from `now`, the moment of the DECISION, which is identical for every candidate
 * being compared. So the simulator cannot express a preference between retrying in six hours and
 * retrying in three days, even though its own docblock on `salaryWindowBoost` says the parameter is
 * "the largest single timing effect in the model", that it is "the mechanism that rewards
 * RETRY_SCHEDULED over RETRY_NOW", and — in the funds branch itself — that the decay is "what makes
 * *which* scheduled slot the agent picks matter, not merely that it scheduled at all."
 *
 * Three of these tests are marked `todo`. They assert the behaviour the simulator documents and does
 * not have. `todo` rather than a passing test of current behaviour, because a green test asserting
 * that timing does not matter would eventually be read as a specification; and `todo` rather than a
 * failing test, because a red suite trains you to ignore red. They are the definition of done for
 * the fix.
 *
 * The rest of the tests pass now and pin the parts that must NOT change when the fix lands: the
 * structural zero, and the tiebreak's meaning.
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

/** How the dataset labels rows today: one `now` — the decision instant — for every candidate. */
const asLabelled = (action, latent = SHORT) =>
  recoveryProbability({ action, latent, event: EVENT, now: NOW, touchesUsed: 0, assumptions: A });

// =============================================================================================
// THE GAP
// =============================================================================================

test('a scheduled retry is priced at the instant it lands, not the instant it was decided', { todo: true }, () => {
  /**
   * MEASURED VALUES AS OF THE COMMIT THAT ADDED THIS FILE:
   *
   *   offset   as labelled today   if the scheduled instant were honoured
   *   +6h          0.032094                 0.031146   (before the credit — still hopeless)
   *   +3d          0.032094                 0.800953   (just after — 25x better)
   *   +9d          0.032094                 0.244365   (window has decayed)
   *
   * The left column is what every number this project has produced was computed against. A 25x
   * difference in recovery probability, on the single decision the product is most distinctive
   * about, is invisible to the ground truth.
   */
  const before = asLabelled(BEFORE_FUNDS).p;
  const after = asLabelled(JUST_AFTER).p;
  const late = asLabelled(WINDOW_GONE).p;

  assert.ok(after > before * 5, `retrying after the credit should dominate: ${after} vs ${before}`);
  assert.ok(after > late * 2, `the window decays, so +3d should beat +9d: ${after} vs ${late}`);
});

test('the funds penalty is decided by when the retry lands, so a scheduled retry can escape it', { todo: true }, () => {
  /**
   * `preFundsPenalty` (0.06) is applied when `now` precedes the credit. Today it is applied to every
   * scheduled retry regardless of slot, including slots that land after the money arrives — the
   * penalty for charging an empty account is levied on a retry deliberately timed to avoid it.
   * That is the specific arithmetic that makes scheduling worthless in this simulator.
   */
  assert.equal(asLabelled(BEFORE_FUNDS).breakdown.preFunds, A.preFundsPenalty, 'a pre-credit slot is penalised');
  assert.equal(asLabelled(JUST_AFTER).breakdown.preFunds, undefined, 'a post-credit slot must not be');
  assert.ok(asLabelled(JUST_AFTER).breakdown.salaryWindow > 1, 'and should collect the salary-window boost');
});

test('the salary-window assumption is not inert, so sweeping it measures something', { todo: true }, () => {
  /**
   * WHY THIS ONE IS SEPARATE. Days 8-9 sweep `salaryWindowBoost` over [1.6, 3.2]. If no candidate's
   * probability varies with it, the sweep reports "robust to this assumption" for the sole reason
   * that the assumption cannot act — which is the same class of false robustness that
   * `recoveryProbability` already refuses to permit via a silent assumptions default. The file
   * guards one route to a meaningless sweep and contains another.
   *
   * The test is therefore about the sweep's validity, not about any one probability.
   */
  const low = materialiseAssumptions({ salaryWindowBoost: 1.6 });
  const high = materialiseAssumptions({ salaryWindowBoost: 3.2 });
  const p = (assumptions) =>
    recoveryProbability({ action: JUST_AFTER, latent: SHORT, event: EVENT, now: NOW, touchesUsed: 0, assumptions }).p;

  assert.notEqual(p(low), p(high), 'salaryWindowBoost does not move a scheduled retry at all');
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
    const { p, breakdown } = asLabelled(action, dead);
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

test('the shipped model key cannot distinguish two slots, which is a second defect behind the first', () => {
  /**
   * Fixing the simulator is necessary and not sufficient. The shipped recovery model groups on
   * (diagnosedCause, actionKind); `+6h` and `+3d` share a kind, so they land in one cell and receive
   * one rate no matter how different their true rates become. Recorded here rather than in the
   * simulator's tests because the two defects are easy to mistake for one, and fixing only the
   * loud half would leave the engine still choosing timing by tiebreak against a ground truth that
   * had started caring about it — which is worse than today, since the loss would then be real
   * money rather than a wash.
   */
  const key = (r) => `${r.diagnosedCause}|${r.actionKind}`;
  const rowFor = (action) => ({ diagnosedCause: 'INSUFFICIENT_FUNDS', actionKind: action.kind });
  assert.equal(key(rowFor(BEFORE_FUNDS)), key(rowFor(JUST_AFTER)), 'the key already separates slots');
});
