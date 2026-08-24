/**
 * DECISION ENGINE TESTS
 * =====================
 *
 * Every expected value in this file is computed by hand and written as an integer literal, with
 * the arithmetic shown. Deriving an expectation from `expectedValue()` would prove only that
 * `decide.js` calls the function it calls.
 *
 * Reference numbers (from src/core/config.js):
 *   channel: EMAIL 2, SMS 25, WHATSAPP 35, VOICE 350 paise
 *   humanReviewPaise 6000, failedRetryPenaltyPaise 200, patienceUnitPaise 400
 *   margins: OVERDUE_INVOICE 1.0, FAILED_SUBSCRIPTION 0.75, FAILED_PAYMENT 0.35
 *   bar (minEvToActPaise) 200, maxRetriesPerCase 3, maxTouchesPerCase 5, maxCaseAgeDays 30
 *   humanApprovalThresholdPaise 2_500_000
 *
 * THREE OF THESE TESTS ARE REGRESSION PINS FOR BUGS THAT MADE CODE UNREACHABLE, all of the same
 * shape — a filter that quietly included the do-nothing actions:
 *
 *   1. `belief: best ? ... : null` meant STOP_PERMANENT on a confident NEGATIVE_EV could never
 *      happen, because `best` is non-null only when we are about to ACT.
 *   2. the replacement searched `permitted` (ALLOW only), so a case at 23:00 IST whose retry
 *      budget was spent had every recovering action DEFERRED and the search came back null again.
 *   3. `diagnoseStopReason` tested `permitted.length === 0`, and NO_ACTION_YET is permitted on
 *      every case, so NO_PERMITTED_ACTION, BUDGET_EXHAUSTED and TOO_OLD were all dead codes and
 *      every stop reported itself as NEGATIVE_EV.
 *
 * Run: node --test test/decide.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideForCase,
  decideBatch,
  candidatesFor,
  mintIdempotencyKey,
  explainDecision,
  Outcome,
  DECISION_SCHEMA_VERSION,
} from '../src/agent/decide.js';
import { CALIBRATION_NOTE, StopReason } from '../src/agent/stopping.js';
import { RULES } from '../src/agent/guardrails.js';
import { ActionKind, CUSTOMER_CONTACTING } from '../src/core/actions.js';
import { GUARDRAILS, POLICY } from '../src/core/config.js';

const CONFIG = { GUARDRAILS, POLICY };

const DAY = '2026-08-24T09:30:00Z';   // 15:00 IST — clear of quiet hours
const NIGHT = '2026-08-24T17:30:00Z'; // 23:00 IST — inside quiet hours
const MORNING = '2026-08-25T03:30:00.000Z';

function observedCase(over = {}) {
  return {
    eventId: 'evt_1',
    customerId: 'cust_1',
    amountPaise: 100_000, // ₹1,000
    lossType: 'OVERDUE_INVOICE', // margin 1.0, so gross == p x amount and the sums stay readable
    occurredAt: '2026-08-22T09:30:00Z', // 2 days old
    ...over,
  };
}

/** A firm diagnosis: nothing here gates approval or blocks closure. */
const FIRM = Object.freeze({
  rootCause: 'INSUFFICIENT_FUNDS',
  source: 'RULE',
  matchTier: 'CODE',
  matchedOn: 'reason_code',
  abstained: false,
  requiresApprovalForMoneyMovement: false,
  physics: { retryCanSucceed: true, humanOnly: false },
  explanation: 'reason code mapped directly',
});

/** A constant scorer. Constant on purpose: it makes every EV in this file hand-checkable. */
function scorer(p, state = 'SUPPORTED', rows = 400) {
  return () => ({ p, support: { state, rows } });
}

function decide(over = {}) {
  return decideForCase({
    observed: observedCase(over.observed),
    diagnosis: over.diagnosis ?? FIRM,
    record: over.record ?? {},
    scoreAction: over.scoreAction ?? scorer(0.3),
    now: over.now ?? DAY,
    config: over.config ?? CONFIG,
    ...(over.candidates ? { candidates: over.candidates } : {}),
  });
}

const chosenLine = (rec) => rec.explain.find((l) => l.startsWith('Chose '));

// =============================================================================================
// THE CANDIDATE SET
// =============================================================================================

test('the candidate set is 23 actions and every one is enumerated before filtering', () => {
  /**
   * 1 retry-now + 7 scheduled retries + 3 message types x 4 channels + no-op + escalate + stop.
   * Pinned because pruning before pricing is how an option quietly stops being considered, and
   * the audit trail is more useful for showing that VOICE was available and lost than for being
   * short.
   */
  const list = candidatesFor(DAY, POLICY);
  assert.equal(list.length, 23);
  assert.equal(list.filter((a) => a.kind === ActionKind.RETRY_SCHEDULED).length, 7);
  assert.equal(list.filter((a) => a.kind === ActionKind.SEND_LINK).length, 4);

  // The scheduled retries are the configured offsets from `now`, not arbitrary times.
  const offsets = list
    .filter((a) => a.kind === ActionKind.RETRY_SCHEDULED)
    .map((a) => (new Date(a.scheduledFor).getTime() - new Date(DAY).getTime()) / 3_600_000);
  assert.deepEqual(offsets, POLICY.candidateRetryOffsetsHours);
});

// =============================================================================================
// SELECTION AND THE TIEBREAK
// =============================================================================================

test('the argmax picks money movement over messaging when the arithmetic says so', () => {
  /**
   * amount ₹1,000, OVERDUE_INVOICE (margin 1.0), p = 0.3, nothing spent.
   *
   *   RETRY_NOW    gross 30000, failure penalty round(0.7 x 200) = 140  -> EV 29860
   *   SEND_LINK:EMAIL  gross 30000, channel 2 + patience 400 = 402      -> EV 29598
   *
   * A retry is silent and a message is not; the ₹4 of goodwill is the entire difference, and it
   * is the reason a retry wins here rather than any claim that retries work better.
   */
  const rec = decide();

  assert.equal(rec.outcome, Outcome.ACT);
  assert.equal(rec.chosen.evPaise, 29_860);
  assert.equal(rec.chosen.grossPaise, 30_000);
  assert.equal(rec.chosen.components.expectedFailurePenaltyPaise, 140);
  assert.equal(rec.chosen.components.patiencePenaltyPaise, 0, 'a retry costs no patience');

  const email = rec.candidates.find((c) => c.signature === 'SEND_LINK:EMAIL');
  assert.equal(email.evPaise, 29_598);
});

test('all eight money-moving actions tie, and the tiebreak is deterministic', () => {
  /**
   * With a constant p, RETRY_NOW and all seven RETRY_SCHEDULED slots price identically at 29860 —
   * the timing has no effect because the scorer ignores it. That makes this the cleanest possible
   * test of the tiebreak, which exists because `Array.prototype.sort` stability plus an
   * unspecified tiebreak means two runs of one batch can pick different actions and the
   * reproducibility claim in VERIFY.md quietly stops holding.
   *
   * 'RETRY_NOW' < 'RETRY_SCHEDULED:...' on 'N' < 'S', so RETRY_NOW wins.
   */
  const rec = decide();
  const tied = rec.candidates.filter((c) => c.evPaise === 29_860);
  assert.equal(tied.length, 8);
  assert.equal(rec.chosen.signature, 'RETRY_NOW');

  const runnerUp = rec.candidates.find((c) => c.rank === 2);
  assert.equal(runnerUp.kind, ActionKind.RETRY_SCHEDULED);
  assert.match(runnerUp.rejectedBecause, /tied with RETRY_NOW at 29860 paise; lost the deterministic tiebreak/);
});

test('the choice does not depend on the order the candidates arrive in', () => {
  /**
   * The property the tiebreak buys. Reversing the enumeration is the cheapest available
   * adversary, and it is exactly the perturbation a refactor of `enumerateCandidateActions`
   * would introduce by accident.
   */
  const forward = decide();
  const reversed = decide({ candidates: candidatesFor(DAY, POLICY).reverse() });

  assert.equal(reversed.chosen.signature, forward.chosen.signature);
  assert.equal(reversed.chosen.evPaise, forward.chosen.evPaise);
  assert.deepEqual(
    reversed.candidates.map((c) => c.signature),
    forward.candidates.map((c) => c.signature),
    'the record itself must be byte-identical, not merely the winner'
  );
});

test('deciding the same case twice produces an identical record', () => {
  const a = decide();
  const b = decide();
  assert.deepEqual(b, a);
});

test('which message wins comes from the response model, not from the tiebreak', () => {
  /**
   * WORTH PINNING BECAUSE OF WHAT THE OTHER TESTS IN THIS FILE LOOK LIKE. A constant scorer prices
   * SEND_LINK, SWITCH_RAIL_NUDGE and REQUEST_REAUTH identically — same channel cost, same patience
   * cost, same p — so the winner falls through to the alphabetical tiebreak, and REQUEST_REAUTH
   * wins on 'R' < 'S'. Read carelessly, that looks like the engine's opinion is "ask for a new
   * card", which would be an odd default on an overdue invoice that never had a saved instrument.
   *
   * It is not an opinion. `enumerateCandidateActions` is deliberately generous — it offers
   * everything conceivable so the audit trail can show what was declined and why — and
   * suppressing the incoherent options is the scorer's job, because the rate for
   * (OVERDUE_INVOICE, REQUEST_REAUTH) is a thing we can measure rather than a thing we assert.
   * These two calls prove the ordering tracks the estimate: swap the rates, swap the winner.
   *
   * p = 0.3 wins at 30000 - 402 = 29598 against p = 0.1 at 10000 - 402 = 9598.
   */
  const byKind = (rates) => ({ action }) => ({
    p: rates[action.kind] ?? 0.01,
    support: { state: 'SUPPORTED', rows: 400 },
  });
  const spent = { record: { retriesUsed: 3 } };

  const linkIsBetter = decide({ ...spent, scoreAction: byKind({ SEND_LINK: 0.3, REQUEST_REAUTH: 0.1 }) });
  assert.equal(linkIsBetter.chosen.signature, 'SEND_LINK:EMAIL');
  assert.equal(linkIsBetter.chosen.evPaise, 29_598);

  const reauthIsBetter = decide({ ...spent, scoreAction: byKind({ SEND_LINK: 0.1, REQUEST_REAUTH: 0.3 }) });
  assert.equal(reauthIsBetter.chosen.signature, 'REQUEST_REAUTH:EMAIL');
  assert.equal(reauthIsBetter.chosen.evPaise, 29_598);

  // And the tiebreak only decides the case the data cannot: identical rates, identical costs.
  const flat = decide({ ...spent, scoreAction: scorer(0.3) });
  assert.equal(flat.chosen.signature, 'REQUEST_REAUTH:EMAIL');
  assert.match(flat.candidates.find((c) => c.signature === 'SEND_LINK:EMAIL').rejectedBecause, /tied with/);
});

// =============================================================================================
// THE WAIT PATH — code that had never executed before this test
// =============================================================================================

test('a case whose only viable action is deferred WAITS, and says until when', () => {
  /**
   * THE PATH THE MODULE CLAIMED TO HAVE AND HAD NEVER RUN. The smoke batch decided at 16:30 IST,
   * which never hits quiet hours, so DEFER -> WAIT was unexercised.
   *
   * Setup: retry budget spent (all 8 money-moving actions FORBID, unpriced), decision at 23:00
   * IST so every message is deferred to 09:00. p = 0.3 on ₹1,000 of invoice:
   *
   *   SEND_LINK:EMAIL  gross 30000 - (2 + 400) = 29598, comfortably over the 200 bar
   *
   * Without a WAIT outcome this case either reports CONTINUE while executing nothing, or stops a
   * live case permanently over a clock.
   */
  const rec = decide({ record: { retriesUsed: 3 }, now: NIGHT });

  assert.equal(rec.outcome, Outcome.WAIT);
  assert.equal(rec.waitUntil, MORNING);
  assert.equal(rec.chosen, null, 'nothing was executed');
  assert.equal(rec.stop, null, 'a wait is not a stop and must not be recorded as one');

  const email = rec.candidates.find((c) => c.signature === 'SEND_LINK:EMAIL');
  assert.equal(email.verdict, 'DEFER');
  assert.equal(email.evPaise, 29_598);
  assert.equal(email.deferUntil, MORNING);
  assert.match(email.rejectedBecause, /not yet — earliest legal moment 2026-08-25T03:30:00\.000Z/);

  assert.ok(rec.explain.some((l) => l.includes('No action yet')));
});

test('an unprofitable deferred action does not buy a WAIT — and the stop still knows its evidence', () => {
  /**
   * REGRESSION PIN FOR THE SECOND VERSION OF THE STANDING BUG.
   *
   * Same 23:00 setup, but p = 0.0001: gross round(0.0001 x 100000 x 1.0) = 10, so
   * SEND_LINK:EMAIL is 10 - 402 = -392. Waiting until 09:00 to send a message worth minus ₹4 is
   * not patience, it is a loop, so WAIT must not be entered.
   *
   * The pin is what happens next. Every recovering action here is either FORBID (retries) or
   * DEFER (messages) — none is ALLOW. When `bestRecovering` searched only the ALLOW candidates it
   * found nothing, the support gate saw UNKNOWN, and this case went to a human despite resting on
   * 400 rows of evidence. At 2am. Every night.
   */
  const rec = decide({ record: { retriesUsed: 3 }, now: NIGHT, scoreAction: scorer(0.0001) });

  assert.notEqual(rec.outcome, Outcome.WAIT);
  assert.equal(rec.outcome, Outcome.STOP_PERMANENT);
  assert.equal(rec.stop.code, StopReason.NEGATIVE_EV);
  assert.match(rec.stop.detail, /REQUEST_REAUTH.*-392 paise, below the 200 paise bar/);
  assert.deepEqual(rec.stop.standing.blockers, [], 'the evidence was there and must be credited');
});

// =============================================================================================
// THE SUPPORT ASYMMETRY — the same probability, two different outcomes
// =============================================================================================

test('an identical probability closes the case on SUPPORTED evidence and escalates on UNSEEN', () => {
  /**
   * THE CENTRAL REGRESSION PIN, and the reason `stopping.js` is a separate module.
   *
   * ₹200 invoice, retry budget spent, daytime so messages are permitted, p = 0.001:
   *   gross round(0.001 x 20000 x 1.0) = 20, SEND_LINK:EMAIL = 20 - 402 = -382
   * Nothing clears the 200 bar either way. The ONLY difference between the two calls below is
   * whether the estimate is backed by 400 rows or by a base-rate fallback on a cell we have never
   * observed — and `lookupTable.predictRow` returns numerically indistinguishable values for the
   * two, so probability alone cannot tell them apart.
   *
   * Before the fix, `belief` was null on every stop path, support read UNKNOWN, and BOTH branches
   * escalated. The agent could never say "I looked at this and it is not worth chasing", which is
   * the one claim the Track 3 bar explicitly asks a stopping rule to make.
   */
  const shared = { observed: { amountPaise: 20_000 }, record: { retriesUsed: 3 }, scoreAction: null };

  const confident = decide({ ...shared, scoreAction: scorer(0.001, 'SUPPORTED', 400) });
  const ignorant = decide({ ...shared, scoreAction: scorer(0.001, 'UNSEEN', 0) });

  assert.equal(confident.chosen, null);
  assert.equal(confident.outcome, Outcome.STOP_PERMANENT);
  assert.equal(confident.stop.code, StopReason.NEGATIVE_EV);
  assert.match(confident.stop.detail, /-382 paise/);

  assert.equal(ignorant.outcome, Outcome.ESCALATE_HUMAN);
  assert.equal(ignorant.stop.code, StopReason.NEGATIVE_EV, 'the reason is the same; the standing is not');
  assert.match(ignorant.stop.standing.blockers[0], /UNSEEN evidence \(0 rows\)/);

  // Same estimate on both sides. If this assertion ever fails the test is no longer about support.
  const pOf = (rec) => rec.candidates.find((c) => c.signature === 'SEND_LINK:EMAIL').p;
  assert.equal(pOf(confident), pOf(ignorant));
});

test('escalation is explained on standing, never on a probability it did not use', () => {
  /**
   * `expectedValue` prices escalation at a structurally zero gross precisely so that no invented
   * P(analyst recovers | they look) enters the decision. Printing "p=0.1%" next to it in the
   * explanation would re-create exactly the impression the pricing refuses to create.
   */
  const rec = decide({
    observed: { amountPaise: 20_000 },
    record: { retriesUsed: 3 },
    scoreAction: scorer(0.001, 'UNSEEN', 0),
  });

  assert.equal(rec.outcome, Outcome.ESCALATE_HUMAN);
  assert.equal(rec.chosen.signature, 'ESCALATE_HUMAN');
  assert.equal(rec.chosen.grossPaise, 0);
  assert.equal(rec.chosen.evPaise, -6000);

  const line = chosenLine(rec);
  assert.doesNotMatch(line, /p=/, 'escalation must not display a probability');
  assert.match(line, /recovers nothing by itself/);
  assert.match(line, /on standing: we were not entitled to close this case ourselves/);

  // And the runner-up line is suppressed, because for a standing-based choice the runner-up is
  // better on EV by construction and "₹60 behind" explains nothing.
  assert.ok(!rec.explain.some((l) => l.startsWith('Next best')));
});

// =============================================================================================
// UNREVIEWED_TOO_SMALL — the honest form of a real limitation
// =============================================================================================

test('a tiny case we cannot close is closed unreviewed, and labelled as the weaker claim', () => {
  /**
   * ₹100 FAILED_PAYMENT. Margin 0.35, so full recovery is worth 3500 paise and a ₹60 human review
   * cannot pay for itself even if the analyst recovers every rupee: 3500 - 6000 = -2500.
   *
   * p = 0.001 -> gross round(0.001 x 10000 x 0.35) = 4, SEND_LINK:EMAIL = 4 - 402 = -398.
   *
   * UNSEEN support means we are not entitled to close it on the evidence, and the amount means we
   * are not entitled to spend a human on finding out. It is closed anyway — and it gets its own
   * code, because "we did not establish this was hopeless" is a materially weaker claim than "we
   * established this was hopeless" and reporting them as one number would inflate every
   * correctly-abandoned statistic in the eval.
   */
  const small = { observed: { amountPaise: 10_000, lossType: 'FAILED_PAYMENT' }, record: { retriesUsed: 3 } };

  const weak = decide({ ...small, scoreAction: scorer(0.001, 'UNSEEN', 0) });
  assert.equal(weak.outcome, Outcome.STOP_PERMANENT);
  assert.equal(weak.stop.code, StopReason.UNREVIEWED_TOO_SMALL);
  assert.equal(weak.stop.underlying, StopReason.NEGATIVE_EV, 'the weaker code must carry what it is weaker than');
  assert.match(weak.stop.detail, /would not cover the 6000 paise cost of a human looking/);
  assert.ok(weak.explain.some((l) => l.includes('This is a weak closure')));

  const firm = decide({ ...small, scoreAction: scorer(0.001, 'SUPPORTED', 400) });
  assert.equal(firm.stop.code, StopReason.NEGATIVE_EV);
  assert.equal(firm.stop.underlying, undefined);
  assert.ok(firm.explain.some((l) => l.includes('Closing the case was permitted')));
});

// =============================================================================================
// THE THREE STOP CODES THAT WERE UNREACHABLE
// =============================================================================================

test('a case with every budget spent reports BUDGET_EXHAUSTED, not NEGATIVE_EV', () => {
  /**
   * REGRESSION PIN FOR THE THIRD BUG. `diagnoseStopReason` tested whether ANY action was
   * permitted, and NO_ACTION_YET is permitted on essentially every case — the kill switch does
   * not even apply to it. So the blocked branch was unreachable and this case reported
   * "best permitted action (NO_ACTION_YET) is worth 0 paise, below the 200 paise bar".
   *
   * That is not merely unhelpful, it is false about the mechanism: it claims we priced the options
   * and none was worth taking, when in fact every option capable of recovering money had been
   * refused outright. TOO_OLD and BUDGET_EXHAUSTED would have read zero in the eval — two rules
   * that fire constantly, reported as never firing.
   */
  const rec = decide({
    record: { retriesUsed: 3, touchesUsed: 5 },
    scoreAction: scorer(0.3, 'UNSEEN', 0),
  });

  assert.equal(rec.stop.code, StopReason.BUDGET_EXHAUSTED);
  assert.match(rec.stop.detail, /retries 3\/3, touches 5\/5/);

  /**
   * And it CLOSES rather than escalating, on UNSEEN support. A spent budget is a fact about a
   * policy we set, not an inference from a probability, so demanding calibrated evidence before
   * honouring it is a category error — and one that would route every budget-exhausted case to an
   * analyst whose only distinguishing feature is "we already tried three times".
   */
  assert.equal(rec.outcome, Outcome.STOP_PERMANENT);
  assert.deepEqual(rec.stop.standing.blockers, []);
  assert.ok(rec.explain.some((l) => l.includes('needed no probability estimate')));
});

test('but a large budget-exhausted case still gets a person', () => {
  // The amount gate is not waived for policy-grounded stops: ₹30,000 deserves a human before
  // anyone writes it off, whatever the reason for writing it off.
  const rec = decide({
    observed: { amountPaise: 3_000_000 },
    record: { retriesUsed: 3, touchesUsed: 5 },
    scoreAction: scorer(0.3, 'UNSEEN', 0),
  });

  assert.equal(rec.outcome, Outcome.ESCALATE_HUMAN);
  assert.equal(rec.stop.code, StopReason.BUDGET_EXHAUSTED);
  assert.equal(rec.stop.standing.blockers.length, 1);
  assert.match(rec.stop.standing.blockers[0], /2500000 paise approval threshold/);
});

test('an over-age case reports TOO_OLD and closes on policy grounds', () => {
  const rec = decide({
    observed: { occurredAt: '2026-07-15T09:30:00Z' }, // 40 days before DAY
    scoreAction: scorer(0.3, 'UNSEEN', 0),
  });

  assert.equal(rec.stop.code, StopReason.TOO_OLD);
  assert.match(rec.stop.detail, /40\.0 days old, past the 30-day limit/);
  assert.equal(rec.outcome, Outcome.STOP_PERMANENT);
});

test('a case where every route is refused reports NO_PERMITTED_ACTION and goes to a human', () => {
  /**
   * A revoked mandate blocks money movement; do-not-disturb blocks messaging. Nothing that could
   * recover money is legal.
   *
   * This code is deliberately NOT policy-grounded, so it escalates rather than closing. "Every
   * route was refused" includes the disputed-invoice and risk-blocked cases, and closing those on
   * the grounds that we were not allowed to touch them would be the tidiest possible way to lose
   * a dispute.
   */
  const rec = decide({
    observed: { subscription: { mandateStatus: 'revoked' } },
    record: { doNotDisturb: true },
  });

  assert.equal(rec.stop.code, StopReason.NO_PERMITTED_ACTION);
  assert.match(rec.stop.detail, /ABS_REVOKED_MANDATE/);
  assert.match(rec.stop.detail, /ABS_DO_NOT_DISTURB/);
  assert.equal(rec.outcome, Outcome.ESCALATE_HUMAN);
});

test('a human-only cause escalates and says so', () => {
  const rec = decide({
    diagnosis: { ...FIRM, rootCause: 'CHARGEBACK_RECEIVED', physics: { humanOnly: true } },
  });

  assert.equal(rec.outcome, Outcome.ESCALATE_HUMAN);
  assert.equal(rec.stop.code, StopReason.HUMAN_ONLY_CAUSE);
  assert.equal(rec.chosen.signature, 'ESCALATE_HUMAN');
  assert.match(rec.stop.detail, /CHARGEBACK_RECEIVED is a human-only cause/);
});

// =============================================================================================
// PRICING DISCIPLINE
// =============================================================================================

test('an action blocked by an absolute rule is never given a number', () => {
  /**
   * If charging a revoked mandate had an expected value attached, then someday somebody comparing
   * numbers would notice it was the biggest one, and the only thing between that observation and
   * a compliance breach would be a filter in a sort. `priced: false` says the price does not
   * exist rather than that it lost.
   */
  const rec = decide({
    observed: { subscription: { mandateStatus: 'revoked' } },
    record: { doNotDisturb: true },
  });

  const forbidden = rec.candidates.filter((c) => c.verdict === 'FORBID');
  assert.equal(forbidden.length, 20, '8 money-moving + 12 messages');

  for (const c of forbidden) {
    assert.equal(c.priced, false, `${c.signature} was priced despite being forbidden`);
    assert.equal(c.evPaise, null);
    assert.equal(c.grossPaise, null);
    assert.equal(c.p, null);
    assert.equal(c.rank, null, 'an unpriced action was never in the ranking');
    assert.match(c.rejectedBecause, /^not permitted — ABS_/);
  }

  // The three that remain are the ones that cannot move money or contact anyone.
  const priced = rec.candidates.filter((c) => c.priced).map((c) => c.kind).sort();
  assert.deepEqual(priced, ['ESCALATE_HUMAN', 'NO_ACTION_YET', 'STOP_PERMANENT']);
});

test('a deferred action IS priced, because whether waiting is worthwhile is an EV question', () => {
  const rec = decide({ record: { retriesUsed: 3 }, now: NIGHT });
  const deferred = rec.candidates.filter((c) => c.verdict === 'DEFER');
  assert.equal(deferred.length, 12);
  for (const c of deferred) {
    assert.equal(c.priced, true);
    assert.ok(Number.isInteger(c.evPaise));
  }
});

test('margin is applied, and it is why equal amounts are unequal opportunities', () => {
  /**
   * The same ₹1,000 and the same p = 0.3, priced twice. The invoice is worth 30000 paise of
   * contribution; the card payment is worth 10500, because the goods shipped at 65% cost. Chasing
   * them equally hard is a mistake no amount of retry tuning can fix.
   */
  const invoice = decide({ observed: { lossType: 'OVERDUE_INVOICE' } });
  const payment = decide({ observed: { lossType: 'FAILED_PAYMENT' } });

  assert.equal(invoice.marginApplied, 1.0);
  assert.equal(payment.marginApplied, 0.35);
  assert.equal(invoice.chosen.grossPaise, 30_000);
  assert.equal(payment.chosen.grossPaise, 10_500);
  assert.equal(invoice.chosen.evPaise - payment.chosen.evPaise, 19_500, 'identical costs, so the gap is pure margin');
});

// =============================================================================================
// APPROVAL
// =============================================================================================

test('a large amount is held for approval rather than refused', () => {
  /**
   * ₹30,000 at p = 0.3: RETRY_NOW gross 900000, penalty 140 -> EV 899860. Enormously profitable
   * and still routed to a queue. Folding approval into the verdict would have converted "a human
   * should look at this ₹30,000" into "this ₹30,000 is not worth chasing".
   */
  const rec = decide({ observed: { amountPaise: 3_000_000 } });

  assert.equal(rec.outcome, Outcome.AWAIT_APPROVAL);
  assert.equal(rec.chosen.signature, 'RETRY_NOW');
  assert.equal(rec.chosen.evPaise, 899_860);
  assert.equal(rec.requiresApproval, true);
  assert.ok(rec.approvalReasons.some((r) => r.startsWith('APR_LARGE_AMOUNT')));
  assert.ok(rec.explain.some((l) => l.startsWith('Held for human approval')));
  assert.equal(rec.stop, null, 'awaiting approval is not a stop');
});

test('an unsupported belief holds money movement for approval even when it wins', () => {
  const rec = decide({ scoreAction: scorer(0.3, 'UNSEEN', 0) });

  assert.equal(rec.outcome, Outcome.AWAIT_APPROVAL);
  assert.equal(rec.chosen.signature, 'RETRY_NOW');
  assert.equal(rec.chosen.support.state, 'UNSEEN');
  assert.ok(rec.approvalReasons.some((r) => r.includes('APR_UNSUPPORTED_BELIEF')));
});

test('an abstained diagnosis gets one retry, then the messages take over', () => {
  const abstained = { ...FIRM, rootCause: 'UNKNOWN', abstained: true, requiresApprovalForMoneyMovement: true };

  const first = decide({ diagnosis: abstained, record: { retriesUsed: 0 } });
  assert.equal(first.chosen.action.kind, ActionKind.RETRY_NOW);
  assert.equal(first.outcome, Outcome.AWAIT_APPROVAL, 'the one cautious attempt still needs a human');

  /**
   * On the second, BUD_ABSTAINED_RETRY_LIMIT forbids all money movement, so the best remaining
   * action is a message on the cheapest channel. p = 0.3, ₹1,000 invoice, touchesUsed 0:
   *   <any message>:EMAIL = 30000 - (2 + 400) = 29598
   * Messages are not gated on diagnosis strength — a link on a misdiagnosed case costs 2 paise
   * and some goodwill, a charge on one touches the customer's card — so this one just ACTs.
   *
   * The assertion is on the CLASS of action, not on which message. With a constant scorer all
   * three message types price identically and the winner is decided by the alphabet; asserting
   * `SEND_LINK` here would be asserting the alphabet. The claim under test is that money movement
   * stopped and outreach continued.
   */
  const second = decide({ diagnosis: abstained, record: { retriesUsed: 1 } });
  assert.equal(second.chosen.evPaise, 29_598);
  assert.ok(CUSTOMER_CONTACTING.has(second.chosen.action.kind));
  assert.equal(second.chosen.action.channel, 'EMAIL');
  assert.equal(second.outcome, Outcome.ACT);
  assert.ok(
    second.candidates.filter((c) => c.kind === ActionKind.RETRY_SCHEDULED).every((c) => c.verdict === 'FORBID')
  );
});

// =============================================================================================
// IDEMPOTENCY
// =============================================================================================

test('the idempotency key is deterministic in the case, the action, and the attempt ordinal', () => {
  const action = { kind: ActionKind.RETRY_NOW };
  const a = mintIdempotencyKey({ eventId: 'evt_1', action, attemptOrdinal: 0 });
  const b = mintIdempotencyKey({ eventId: 'evt_1', action, attemptOrdinal: 0 });
  assert.equal(a, b, 're-deciding the same case must mint the same key so a duplicate is refused');
  assert.equal(a, 'rebound:evt_1:RETRY_NOW:0');

  /**
   * The ordinal is what makes the SECOND legitimate retry get a different key. Without it a
   * correct second attempt would be deduplicated against the first and the case would look
   * retried when nothing happened.
   */
  assert.notEqual(a, mintIdempotencyKey({ eventId: 'evt_1', action, attemptOrdinal: 1 }));
  assert.notEqual(a, mintIdempotencyKey({ eventId: 'evt_2', action, attemptOrdinal: 0 }));
  assert.notEqual(
    a,
    mintIdempotencyKey({ eventId: 'evt_1', action: { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: DAY }, attemptOrdinal: 0 })
  );
});

test('the chosen money-moving action carries its key into the record', () => {
  assert.equal(decide().chosen.idempotencyKey, 'rebound:evt_1:RETRY_NOW:0');
  assert.equal(decide({ record: { retriesUsed: 1 } }).chosen.idempotencyKey, 'rebound:evt_1:RETRY_NOW:1');
});

// =============================================================================================
// THE AUDIT SURFACE
// =============================================================================================

test('the record reads top-down as the argument it is', () => {
  const rec = decide();

  assert.equal(rec.schemaVersion, DECISION_SCHEMA_VERSION);
  assert.equal(rec.calibrationNote, CALIBRATION_NOTE);
  assert.equal(rec.candidates.length, 23);

  // Ranked first, unranked last, and every rejected line carries a reason.
  const ranks = rec.candidates.map((c) => c.rank);
  const ranked = ranks.filter((r) => r !== null);
  assert.deepEqual(ranked, [...ranked].sort((a, b) => a - b));
  assert.equal(ranks.indexOf(null), -1, 'nothing is unranked on this case; all 23 were priced');
  assert.equal(rec.candidates[0].rank, 1);
  assert.equal(rec.candidates[0].chosen, true);
  assert.equal(rec.candidates.filter((c) => c.chosen).length, 1);

  for (const c of rec.candidates.slice(1)) {
    assert.ok(c.rejectedBecause, `${c.signature} was rejected without a reason`);
  }
});

test('every rule is recorded for the chosen action, not only the ones that fired', () => {
  const rec = decide();
  assert.equal(rec.guardrailsEvaluated.length, RULES.length);
  assert.ok(rec.guardrailsEvaluated.some((e) => e.applied === false), 'rules that did not apply are still listed');
  assert.ok(rec.guardrailsEvaluated.every((e) => e.passed === true), 'the chosen action violated nothing');
});

test('the decomposition sums exactly, so a reviewer checking by hand finds no discrepancy', () => {
  for (const over of [
    {},
    { observed: { lossType: 'FAILED_PAYMENT' } },
    { record: { retriesUsed: 3 } },
    { record: { retriesUsed: 3, touchesUsed: 2 } },
    { observed: { amountPaise: 7_777 } },
  ]) {
    const rec = decide(over);
    for (const c of rec.candidates.filter((x) => x.priced)) {
      assert.ok(Number.isInteger(c.evPaise), `${c.signature} EV is not an integer`);
      assert.equal(c.evPaise, c.grossPaise - c.totalCostPaise, `${c.signature} does not reconcile`);
    }
  }
});

test('the explanation names the margin, the alternatives, and the cost breakdown', () => {
  const rec = decide({ record: { retriesUsed: 3 } });
  const text = rec.explain.join('\n');

  assert.match(text, /₹1,000 at risk \(OVERDUE_INVOICE\)/);
  assert.match(text, /Contribution margin 100%/);
  assert.match(text, /Considered 23 actions: 15 priced, 8 not permitted at all/);
  assert.match(text, /Cost breakdown: 2 paise message/, 'a 2-paise email must not render as ₹0');
  assert.match(text, /₹4 of customer patience \(touch 1\)/);
  assert.match(text, /Next best was/);
});

test('explainDecision is a pure function of the record', () => {
  const rec = decide();
  assert.deepEqual(explainDecision(rec), rec.explain);
});

// =============================================================================================
// THE TIMING LINE IN THE AUDIT TRAIL
// =============================================================================================

/**
 * A scorer that surfaces `timing` the way `createRecoveryScorer` does for a FEATURE-BASED arm.
 * `salaryWindow` is echoed from the slot so the assertions below are about plumbing, not about
 * what the real model happens to believe this week.
 */
function timingScorer(p = 0.3) {
  return ({ action, context }) => {
    const scheduled = action.kind === ActionKind.RETRY_SCHEDULED && action.scheduledFor;
    return {
      p,
      support: { state: 'SUPPORTED', rows: 400 },
      timing: {
        // Deliberately computed the way features.js does — `scheduledFor - context.now` — so this
        // test would notice if the serving convention changed underneath it.
        delayDays: scheduled
          ? Math.max(0, (new Date(action.scheduledFor).getTime() - new Date(context.now).getTime()) / 86_400_000)
          : 0,
        isScheduled: scheduled ? 1 : 0,
        salaryWindow: scheduled ? 1 : 0,
      },
    };
  };
}

test('the trail states the scheduled delay from the timestamps, not from the inert delayDays feature', () => {
  /**
   * THE DEFECT THIS PINS.
   *
   * `decide` prices every action at the instant it LANDS, so for a scheduled retry `context.now`
   * IS `action.scheduledFor` and the `delayDays` feature is `scheduledFor - scheduledFor` = 0,
   * always. An explanation that read the feature printed "landing in 0.0 days" about a slot six
   * hours out, which is false — a plausible-looking number computed from nothing, which is the one
   * category of output this project treats as worse than no output.
   *
   * `effectiveAt - decidedAt` is the real delay and cannot degenerate, so that is what the line
   * reads. Asserting BOTH here — that the feature really is 0 and that the printed delay is not —
   * is the only way this stays pinned: assert only the printed text and a future refactor that
   * reintroduces the feature-based delay would still pass whenever the two happen to agree.
   */
  const rec = decide({ scoreAction: timingScorer(0.3), candidates: [
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: '2026-08-26T09:30:00Z' }, // 2 days out
  ] });

  assert.equal(rec.chosen.timing.delayDays, 0, 'the feature is pinned at 0 at serving; that is the skew');
  assert.equal(rec.chosen.timing.isScheduled, 1);

  const line = rec.explain.find((l) => l.startsWith('Timing:'));
  assert.ok(line, 'a scheduled retry must explain its timing');
  assert.match(line, /landing in 2\.0 days/, 'the delay must come from effectiveAt - decidedAt');
  assert.doesNotMatch(line, /landing in 0\.0 days/);
  assert.match(line, /priced at that future slot, not now/);
  assert.match(line, /Salary-window proximity of the slot is 1\.00/);
});

test('an action that fires now says so, and does not claim a future slot', () => {
  const rec = decide({ scoreAction: timingScorer(0.3), candidates: [{ kind: ActionKind.RETRY_NOW }] });
  const line = rec.explain.find((l) => l.startsWith('Timing:'));

  assert.match(line, /fires now, not on a schedule/);
  assert.doesNotMatch(line, /future slot/);
});

test('a GROUP BY arm declares that it cannot see the slot rather than staying silent', () => {
  /**
   * The distinction that matters: a trail with NO timing line and a trail whose timing line showed
   * the slot did not move `p` look identical to a reader, and they are opposite claims. A lookup by
   * (cause, action) structurally cannot see when a slot lands, so it has to say so — otherwise the
   * absence reads as "timing was considered and did not matter".
   */
  const rec = decide({
    scoreAction: scorer(0.3), // no `timing` key at all, like a lookup table
    candidates: [{ kind: ActionKind.RETRY_SCHEDULED, scheduledFor: '2026-08-26T09:30:00Z' }],
  });
  const line = rec.explain.find((l) => l.startsWith('Timing:'));

  assert.match(line, /cannot see when the slot lands/);
  assert.match(line, /no timing evidence backs this probability/);
});

// =============================================================================================
// BATCHES: value, not count
// =============================================================================================

test('the approval queue is ordered by money at stake, not by arrival', () => {
  /**
   * Measured on Day 4: 19 unsafe beliefs on TEST carried ₹73,428 against 16 on TRAIN carrying
   * ₹11,529 — nearly the same count, six times the money. A queue sorted by arrival time hands an
   * analyst with one hour the wrong hour's work.
   */
  const amounts = [3_000_000, 5_000_000, 4_000_000];
  const { summary } = decideBatch({
    cases: amounts.map((amountPaise, i) => ({
      observed: observedCase({ eventId: `evt_${i}`, amountPaise }),
      diagnosis: FIRM,
    })),
    scoreAction: scorer(0.3),
    now: DAY,
    config: CONFIG,
  });

  assert.deepEqual(summary.approvalQueue.map((q) => q.amountPaise), [5_000_000, 4_000_000, 3_000_000]);
  assert.equal(summary.approvalQueueExposurePaise, 12_000_000);
  assert.equal(summary.byOutcome.AWAIT_APPROVAL.count, 3);
  assert.equal(summary.byOutcome.AWAIT_APPROVAL.exposurePaise, 12_000_000);
  assert.equal(summary.totalExposurePaise, 12_000_000);
  for (const q of summary.approvalQueue) assert.ok(q.reasons.length > 0, 'a queued case must say why it is queued');
  assert.deepEqual(summary.escalationQueue, [], 'nothing was escalated, so that queue is empty not absent');
});

test('the approval queue and the escalation queue are separate, and their totals reconcile', () => {
  /**
   * REGRESSION PIN. `summariseBatch` used to return one `approvalQueue` holding both AWAIT_APPROVAL
   * and ESCALATE_HUMAN. The first batch report built on it printed a queue whose exposure exceeded
   * the AWAIT_APPROVAL bucket it claimed to describe, and listed "INVOICE_DISPUTED is a human-only
   * cause" as a reason to approve something.
   *
   * They are different work: an approval is a yes/no on an action that is already chosen and keyed,
   * an escalation is a case with no proposed action that a person now owns. The pin is the
   * reconciliation — each queue's exposure must equal its own outcome bucket, which is the property
   * the merged version violated.
   *
   * Two approvals (₹30,000 and ₹50,000 clear the ₹25,000 threshold) and one escalation (a
   * human-only cause, any size).
   */
  const { summary } = decideBatch({
    cases: [
      { observed: observedCase({ eventId: 'big', amountPaise: 5_000_000 }), diagnosis: FIRM },
      { observed: observedCase({ eventId: 'mid', amountPaise: 3_000_000 }), diagnosis: FIRM },
      {
        observed: observedCase({ eventId: 'esc', amountPaise: 900_000 }),
        diagnosis: { ...FIRM, rootCause: 'CHARGEBACK_RECEIVED', physics: { humanOnly: true } },
      },
    ],
    scoreAction: scorer(0.3),
    now: DAY,
    config: CONFIG,
  });

  assert.deepEqual(summary.approvalQueue.map((q) => q.eventId), ['big', 'mid']);
  assert.equal(summary.approvalQueueExposurePaise, 8_000_000);
  assert.equal(summary.approvalQueueExposurePaise, summary.byOutcome.AWAIT_APPROVAL.exposurePaise);

  assert.deepEqual(summary.escalationQueue.map((q) => q.eventId), ['esc']);
  assert.equal(summary.escalationQueueExposurePaise, 900_000);
  assert.equal(summary.escalationQueueExposurePaise, summary.byOutcome.ESCALATE_HUMAN.exposurePaise);

  assert.equal(summary.humanQueueExposurePaise, 8_900_000);

  /**
   * And each queue carries what its own reviewer needs. An approval is actionable without
   * re-deciding — the action and its idempotency key were minted before the queue was built, so
   * approving cannot silently execute something different from what was reviewed.
   */
  const [top] = summary.approvalQueue;
  assert.equal(top.proposed, 'RETRY_NOW');
  assert.equal(top.idempotencyKey, 'rebound:big:RETRY_NOW:0');
  assert.ok(top.expectedValuePaise > 0);
  assert.ok(top.reasons.every((r) => r.startsWith('APR_')), 'approval reasons only');

  // An escalation has no proposed action, by definition, and carries the stop code instead.
  const [esc] = summary.escalationQueue;
  assert.equal(esc.proposed, undefined);
  assert.equal(esc.stopCode, StopReason.HUMAN_ONLY_CAUSE);
  assert.ok(esc.reasons.some((r) => /human-only cause/.test(r)));
});

test('a run whose results depend on ordering says so', () => {
  /**
   * `budgetBound` exists because processing in arrival order is the worst policy that respects a
   * binding cap — it spends the budget on whichever cases happen to be early rather than on the
   * ones carrying the most money. Day 7 sorts by expected value before spending. Until then the
   * flag means such a run cannot be quoted as though the ordering did not matter.
   */
  const capped = { GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 1 }, POLICY };
  const { decisions, summary } = decideBatch({
    cases: [0, 1].map((i) => ({
      observed: observedCase({ eventId: `evt_${i}` }),
      diagnosis: FIRM,
      record: { retriesUsed: 3 }, // force the choice onto a message
    })),
    scoreAction: scorer(0.3),
    now: DAY,
    config: capped,
  });

  assert.equal(decisions[0].outcome, Outcome.ACT);
  assert.ok(CUSTOMER_CONTACTING.has(decisions[0].chosen.action.kind));
  assert.equal(summary.runState.messagesThisRun, 1);

  assert.notEqual(decisions[1].outcome, Outcome.ACT, 'the second case is refused by the run breaker');
  assert.ok(
    decisions[1].candidates
      .filter((c) => CUSTOMER_CONTACTING.has(c.kind))
      .every((c) => c.verdict === 'FORBID'),
    'the run breaker must stop every outbound kind, not only the one that won the first case'
  );
  assert.equal(summary.budgetBound, true);
});

test('the summary reports rupees per bucket, not only counts', () => {
  const { summary } = decideBatch({
    cases: [
      { observed: observedCase({ eventId: 'a', amountPaise: 100_000 }), diagnosis: FIRM },
      { observed: observedCase({ eventId: 'b', amountPaise: 200_000 }), diagnosis: FIRM, record: { retriesUsed: 3, touchesUsed: 5 } },
    ],
    scoreAction: scorer(0.3),
    now: DAY,
    config: CONFIG,
  });

  assert.equal(summary.cases, 2);
  assert.equal(summary.totalExposurePaise, 300_000);
  assert.equal(summary.byOutcome.ACT.count, 1);
  assert.equal(summary.byOutcome.ACT.exposurePaise, 100_000);
  assert.equal(summary.byOutcome.ACT.expectedRecoveryPaise, 30_000);
  assert.equal(summary.byOutcome.STOP_PERMANENT.count, 1);
  assert.equal(summary.byOutcome.STOP_PERMANENT.exposurePaise, 200_000);
  assert.equal(summary.byOutcome.STOP_PERMANENT.expectedRecoveryPaise, 0, 'a stop recovers nothing');
  assert.equal(summary.totalExpectedRecoveryPaise, 30_000);
  assert.equal(summary.budgetBound, false);
});

// =============================================================================================
// VALIDATION
// =============================================================================================

test('decideForCase refuses to guess at missing inputs', () => {
  assert.throws(() => decideForCase({ observed: observedCase(), diagnosis: FIRM }), TypeError);
  assert.throws(() => decideForCase({ diagnosis: FIRM, scoreAction: scorer(0.3) }), TypeError);
  assert.throws(() => decideForCase({ observed: { amountPaise: 1 }, scoreAction: scorer(0.3) }), TypeError);
});

test('a scorer that returns no probability is an error, not a zero', () => {
  /**
   * Defaulting a missing probability to 0 would make every action look worthless and every case
   * look correctly abandoned — a silent failure that reports itself as excellent stopping
   * discipline. This is the fourth member of the project's silent-fallback bug family and the
   * only one caught before it shipped.
   */
  for (const bad of [undefined, null, {}, { p: null }, { p: '0.3' }, { p: NaN }]) {
    assert.throws(
      () => decideForCase({ observed: observedCase(), diagnosis: FIRM, scoreAction: () => bad, now: DAY, config: CONFIG }),
      TypeError,
      `scoreAction returning ${JSON.stringify(bad)} must throw`
    );
  }
});
