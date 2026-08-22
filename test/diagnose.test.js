/**
 * DIAGNOSIS TESTS
 * ===============
 *
 * Every test in the first section pins a bug that was real. Not a hypothetical — each of these
 * was measured on a 600-event batch during Day 4, and each one was invisible until something
 * scored the output against truth. A rule table has no failing tests of its own: it always
 * returns *an* answer, and a wrong answer looks exactly like a right one from the inside.
 *
 * So these tests exist to stop specific regressions that already happened once:
 *
 *   - the table matched `payment_failed` and therefore never abstained at all
 *   - a compliance pattern read 28 dead cards as suspected fraud
 *   - a real decline observed on a live account fell through to UNKNOWN, which permits a retry
 *   - a revoked mandate was diagnosed from error text instead of from its own status field
 *
 * Run: node --test test/diagnose.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diagnose, MatchTier, abstainingLlm } from '../src/agent/diagnose.js';
import { observe, toFailureSignal } from '../src/agent/observe.js';
import { ROOT_CAUSES, ROOT_CAUSE_IDS, RULE_TABLE, getRootCause } from '../src/core/taxonomy.js';
import { generateBatch } from '../src/sim/generator.js';

/**
 * The exact decline observed against the real Razorpay test-mode API on 2026-08-22, twice, on
 * payment link `plink_TSpUdX79ucaa45`. Transcribed from
 * `docs/evidence/live-check-2026-08-22T14-19-24-146Z.json`:
 *
 *   failed/BAD_REQUEST_ERROR/international_transaction_not_allowed@account
 *
 * This is the only failure payload in the whole test suite that was not invented by me.
 */
const REAL_DECLINE = Object.freeze({
  lossType: 'FAILED_PAYMENT',
  amountPaise: 49900,
  failure: Object.freeze({
    errorCode: 'BAD_REQUEST_ERROR',
    errorReason: 'international_transaction_not_allowed',
    errorSource: 'account',
    errorStep: 'payment_authorization',
    errorDescription: 'Your payment failed. This account accepts domestic (Indian) cards only.',
    method: 'card',
  }),
});

// ---------------------------------------------------------------------------------------------
// The four regressions
// ---------------------------------------------------------------------------------------------

test('the real observed decline is diagnosed as never-retryable, from its reason enum', async () => {
  const d = await diagnose(observe(REAL_DECLINE));

  assert.equal(d.rootCause, 'INSTRUMENT_NOT_ACCEPTED');

  // The tier matters as much as the label. If this ever drops to TEXT, the classification has
  // started resting on a sentence Razorpay can reword in any release instead of on an enum.
  assert.equal(d.matchTier, MatchTier.REASON);
  assert.equal(d.matchedOn, 'reason=international_transaction_not_allowed');

  // THE POINT OF THE WHOLE DAY. Before INSTRUMENT_NOT_ACCEPTED existed, this payload fell
  // through every rule to UNKNOWN — and UNKNOWN carries retryCanSucceed: true, so the system
  // would have cheerfully retried a card that cannot ever work on this account.
  assert.equal(d.physics.retryCanSucceed, false);
  assert.equal(d.physics.railSwitchHelps, true);
  assert.equal(d.physics.railSwitchIsPrimary, true);

  // And it must NOT ask the customer for a new card: the card is fine, the rail is wrong.
  assert.equal(d.physics.needsNewInstrument, false);

  // This rule carries a confirmation date because a real decline was traced through it.
  assert.equal(d.evidenceDate, '2026-08-22');
});

test('a vague error message abstains instead of being forced into a class', async () => {
  /**
   * REGRESSION: `payment_failed` was in DO_NOT_HONOUR's reason list. Razorpay sends
   * `payment_failed` both when the issuer declined for a specific stated reason AND when there
   * is simply no information available. Matching it meant the table classified 100% of events
   * with total confidence, abstention measured 0.0% against a 12% deliberately-vague rate, and
   * both the LLM tier and UNKNOWN were unreachable dead code.
   *
   * A table that never abstains looks exactly like a table that is always right.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_PAYMENT',
      failure: {
        errorCode: 'BAD_REQUEST_ERROR',
        errorReason: 'payment_failed',
        errorDescription: 'Payment failed',
      },
    })
  );

  assert.equal(d.rootCause, 'UNKNOWN');
  assert.equal(d.abstained, true);
  assert.equal(d.matchTier, MatchTier.NONE);
});

test('a card blocked by the issuer is not read as suspected fraud', async () => {
  /**
   * REGRESSION: RISK_BLOCKED carried the text pattern `'blocked by'`, which matches "The card is
   * blocked by the issuing bank" — an ordinary dead card. 28 of 600 events were routed to a
   * human fraud queue on that basis.
   *
   * The lesson generalises past this one string: RISK_BLOCKED sits near the top of the table on
   * purpose, because a risk hold must never be overridden by a cheaper explanation below it. But
   * ordering by compliance also amplifies compliance false positives, so a pattern that sits at
   * the top must be the narrowest pattern in the table, not the broadest.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_PAYMENT',
      failure: {
        errorCode: 'BAD_REQUEST_ERROR',
        errorDescription: 'The card is blocked by the issuing bank.',
      },
    })
  );

  assert.notEqual(d.rootCause, 'RISK_BLOCKED');
  assert.equal(d.physics.humanOnly, false);
});

test('a revoked mandate is diagnosed from its own status, not from error text', async () => {
  /**
   * REGRESSION: five revoked mandates per 600-event batch produced error text no rule could
   * match, so they abstained to UNKNOWN — which permits one cautious retry. Retrying a revoked
   * mandate is not a wasted API call. It is a charge attempted against an authorisation the
   * customer explicitly withdrew.
   *
   * `subscription.mandateStatus` said `revoked` the entire time and nothing was reading it.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_SUBSCRIPTION',
      subscription: { subscriptionId: 'sub_x', mandateStatus: 'revoked', cycleNumber: 4, totalCycles: 12 },
      failure: { errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'Payment failed' },
    })
  );

  assert.equal(d.rootCause, 'MANDATE_REVOKED');
  assert.equal(d.matchTier, MatchTier.STATE);
  assert.equal(d.matchedOn, 'subscription.mandateStatus=revoked');
  assert.equal(d.physics.retryCanSucceed, false);
  assert.equal(d.physics.requiresReauth, true);
});

// ---------------------------------------------------------------------------------------------
// Precedence — the asymmetries that are easy to "clean up" into bugs
// ---------------------------------------------------------------------------------------------

test('mandateStatus active is ignored, because absence of the signal is not reassurance', async () => {
  /**
   * The generator models a real integration hazard: a revoked mandate can still read `active`
   * because the revocation has not propagated. So `revoked` is load-bearing and `active` carries
   * no information at all.
   *
   * Symmetry would be the bug here. If `active` were treated as evidence the mandate is fine,
   * every propagation-lag case would be actively misdiagnosed rather than merely unresolved —
   * and it would be misdiagnosed in the direction of charging the customer.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_SUBSCRIPTION',
      subscription: { subscriptionId: 'sub_y', mandateStatus: 'active' },
      failure: { errorReason: 'payment_failed', errorDescription: 'Payment failed' },
    })
  );

  assert.equal(d.rootCause, 'UNKNOWN', 'active must not resolve anything by itself');
  assert.equal(d.abstained, true);
});

test('a reason-tier match outranks the mandate status signal', async () => {
  // An enum describes the transaction that just failed; our stored status describes the world in
  // general. When they disagree about a specific attempt, the specific evidence wins.
  const d = await diagnose(
    observe({
      lossType: 'FAILED_SUBSCRIPTION',
      subscription: { subscriptionId: 'sub_z', mandateStatus: 'revoked' },
      failure: { errorReason: 'international_transaction_not_allowed', errorSource: 'account' },
    })
  );

  assert.equal(d.rootCause, 'INSTRUMENT_NOT_ACCEPTED');
  assert.equal(d.matchTier, MatchTier.REASON);
});

test('a human-only classification is never overridden by anything', async () => {
  /**
   * The top of the precedence list, and the one rule with no exceptions. If a risk control
   * fired, that is the answer. A corroborating signal from elsewhere must not be able to talk
   * the system into acting on a case a risk system flagged.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_SUBSCRIPTION',
      subscription: { subscriptionId: 'sub_r', mandateStatus: 'revoked' },
      failure: {
        errorCode: 'BAD_REQUEST_ERROR',
        errorDescription: 'Payment flagged for review by the risk engine.',
      },
    })
  );

  assert.equal(d.physics.humanOnly, true);
  assert.equal(d.physics.automationAllowed, false);
});

// ---------------------------------------------------------------------------------------------
// The observation boundary
// ---------------------------------------------------------------------------------------------

test('observe() drops the field that says which cases are hard', () => {
  /**
   * `_generatedVague` is true exactly when the generator deliberately chose an unmatchable error
   * message. An agent that could read it would know in advance which cases it will fail, could
   * abstain on precisely those, and would post a diagnosis accuracy no real integration could
   * reproduce.
   *
   * The comment in the generator claimed this was "stripped before the agent sees it." Nothing
   * stripped it. This is the test that makes the comment true.
   */
  const raw = {
    eventId: 'evt_1',
    lossType: 'FAILED_PAYMENT',
    amountPaise: 100000,
    failure: { errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'Payment failed', _generatedVague: true },
  };

  const view = observe(raw);

  assert.equal(view.failure._generatedVague, undefined);
  assert.ok(!Object.hasOwn(view.failure, '_generatedVague'));
  assert.ok(!JSON.stringify(view).includes('_generatedVague'));
});

test('observe() is an allowlist, so an unknown future field is invisible by default', () => {
  // The property that makes this different from a denylist: I do not have to have thought of
  // the field name for it to be excluded. This is the guarantee the boundary denylist cannot
  // give, and the reason both mechanisms exist.
  const view = observe({
    eventId: 'evt_2',
    lossType: 'FAILED_PAYMENT',
    someFieldNobodyHasInventedYet: 'the answer',
    failure: { errorCode: 'X', anotherUnknownLeak: 'also the answer' },
  });

  assert.equal(view.someFieldNobodyHasInventedYet, undefined);
  assert.equal(view.failure.anotherUnknownLeak, undefined);
  assert.ok(!JSON.stringify(view).includes('the answer'));
});

test('observe() returns a fresh object, not a view onto the event', () => {
  // A shallow spread would pass every test above today and leak the moment the generator grows
  // a field. Mutating the projection must not touch the source.
  const raw = { eventId: 'evt_3', lossType: 'FAILED_PAYMENT', failure: { errorCode: 'A' } };
  const view = observe(raw);

  view.failure.errorCode = 'MUTATED';
  assert.equal(raw.failure.errorCode, 'A');
  assert.notEqual(view, raw);
  assert.notEqual(view.failure, raw.failure);
});

test('toFailureSignal accepts both snake_case and camelCase for the same concept', () => {
  /**
   * Razorpay sends `error_reason`. The simulator emits `errorReason`. A matcher written against
   * one returns nothing when handed the other — no exception, no warning, just a quiet fall
   * through to UNKNOWN on every single case.
   *
   * Both spellings must land in the same field, because the conversion happens once, here.
   */
  const fromRazorpay = toFailureSignal({
    error_code: 'BAD_REQUEST_ERROR',
    error_reason: 'international_transaction_not_allowed',
    error_source: 'account',
    error_step: 'payment_authorization',
    error_description: 'MIXED Case Text',
  });

  assert.equal(fromRazorpay.reason, 'international_transaction_not_allowed');
  assert.equal(fromRazorpay.source, 'account');
  assert.equal(fromRazorpay.step, 'payment_authorization');
  // Lowercased once at the boundary so no comparison site has to remember to do it.
  assert.equal(fromRazorpay.text, 'mixed case text');

  const fromSimulator = toFailureSignal(REAL_DECLINE);
  assert.equal(fromSimulator.reason, fromRazorpay.reason);
  assert.equal(fromSimulator.source, fromRazorpay.source);
});

test('a webhook-sourced failure diagnoses identically to a polled one', async () => {
  /**
   * REGRESSION: `normaliseWebhook` returned only `errorCode` and `errorDescription`, dropping
   * `errorReason`, `errorSource` and `errorStep` — the three fields the rule table matches most
   * specifically on. A diagnosis arriving by webhook could therefore only ever reach the
   * free-text tier, while the identical failure arriving through a polled read classified at the
   * top tier. No exception, no warning: just systematically worse diagnoses on one code path.
   *
   * Asserted here rather than in webhook.test.js because the property that matters is agreement
   * between two paths, and this is the file that knows what the other path produces.
   */
  const { normaliseWebhook } = await import('../src/razorpay/webhook.js');

  const fromWebhook = normaliseWebhook({
    event: 'payment.failed',
    payload: {
      payment: {
        entity: {
          id: 'pay_1',
          amount: 49900,
          status: 'failed',
          error_code: 'BAD_REQUEST_ERROR',
          error_reason: 'international_transaction_not_allowed',
          error_source: 'account',
          error_step: 'payment_authorization',
          error_description: 'This account accepts domestic (Indian) cards only.',
          method: 'card',
        },
      },
    },
  });

  const viaWebhook = await diagnose({ lossType: 'FAILED_PAYMENT', failure: fromWebhook });
  const viaPolling = await diagnose(observe(REAL_DECLINE));

  assert.equal(viaWebhook.rootCause, viaPolling.rootCause);
  assert.equal(viaWebhook.matchTier, viaPolling.matchTier, 'a webhook must not diagnose at a weaker tier');
  assert.equal(viaWebhook.physics.retryCanSucceed, false);
});

// ---------------------------------------------------------------------------------------------
// The LLM tier, which is the one place a wrong answer can arrive from outside the repo
// ---------------------------------------------------------------------------------------------

test('an invented label from a model is rejected rather than logged as a real class', async () => {
  // A prompt can ask a model to pick from a fixed list. A model can decline to. If an invented
  // label reached the audit trail it would name a category that exists in the logs and nowhere
  // in the code — so the label is validated against the taxonomy after the fact, not requested.
  const liar = { name: 'liar', async classify() { return { rootCause: 'CUSTOMER_IS_ON_HOLIDAY' }; } };

  const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }), { llm: liar });

  assert.equal(d.rootCause, 'UNKNOWN');
  assert.equal(d.source, 'FALLBACK');
});

test('a model that throws degrades to abstention instead of failing the run', async () => {
  // Tier 2 is an optional accuracy improvement on the residual. An outage in it must cost
  // diagnosis quality, never availability.
  const broken = { name: 'broken', async classify() { throw new Error('502 from the provider'); } };

  const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }), { llm: broken });

  assert.equal(d.rootCause, 'UNKNOWN');
  assert.equal(d.abstained, true);
});

test('the model is never consulted about a case a rule already matched', async () => {
  /**
   * The load-bearing property of the tier ordering. If an LLM could be asked about a case
   * RISK_BLOCKED already claimed, it could talk the system out of a compliance classification —
   * and it would do so invisibly, because the output shape is identical either way.
   */
  let calls = 0;
  const counting = { name: 'counting', async classify() { calls += 1; return { rootCause: 'DO_NOT_HONOUR' }; } };

  await diagnose(observe(REAL_DECLINE), { llm: counting });
  assert.equal(calls, 0, 'a rule matched, so tier 2 must not have been reached');

  await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }), { llm: counting });
  assert.equal(calls, 1, 'nothing matched, so tier 2 should have been consulted exactly once');
});

test('an LLM-tier diagnosis is flagged as needing approval before money moves', async () => {
  const guesser = {
    name: 'guesser',
    async classify() { return { rootCause: 'INSUFFICIENT_FUNDS', rationale: 'text mentions balance' }; },
  };

  const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }), { llm: guesser });

  assert.equal(d.rootCause, 'INSUFFICIENT_FUNDS');
  assert.equal(d.source, 'LLM');
  assert.equal(d.requiresApprovalForMoneyMovement, true);
  assert.match(d.matchedOn, /^llm:guesser/);
});

test('UNKNOWN from a model is not dressed up as an LLM-tier result', async () => {
  // A model saying "I do not know" carries no more information than not asking it, and tagging
  // the case as LLM-resolved would overstate what happened in the audit trail.
  const humble = { name: 'humble', async classify() { return { rootCause: 'UNKNOWN' }; } };

  const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }), { llm: humble });

  assert.equal(d.source, 'FALLBACK');
  assert.equal(d.requiresApprovalForMoneyMovement, false);
});

test('the default classifier abstains, so the system needs no API key to run', async () => {
  assert.equal(await abstainingLlm.classify({}), null);

  const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure: { errorReason: 'payment_failed' } }));
  assert.equal(d.source, 'FALLBACK');
});

test('a text-tier match cannot authorise money movement on its own', async () => {
  /**
   * Measured, not assumed. On the first corpus this was ever scored against, the TEXT tier was
   * 0.0% accurate — 5 of 5 wrong on TRAIN, 13 of 13 wrong on TEST. Structurally rather than by
   * bad luck: text matching only runs on payloads whose reason enum already failed to match,
   * which is exactly the population where the sentence is uninformative too.
   *
   * The rules stay, because that 0% is measured against error text I wrote myself and real
   * providers may phrase things more usefully. But a belief this weak does not get to charge a
   * customer without a human agreeing.
   */
  const d = await diagnose(
    observe({
      lossType: 'FAILED_PAYMENT',
      failure: { errorCode: 'BAD_REQUEST_ERROR', errorDescription: 'The card has expired.' },
    })
  );

  assert.equal(d.matchTier, MatchTier.TEXT);
  assert.equal(d.requiresApprovalForMoneyMovement, true);
});

// ---------------------------------------------------------------------------------------------
// Invariants over the whole taxonomy and a real batch
// ---------------------------------------------------------------------------------------------

test('every diagnosis carries the evidence it rested on', async () => {
  // Without this, an audit trail records a verdict and not its basis, which is the difference
  // between a decision and an assertion.
  const d = await diagnose(observe(REAL_DECLINE));

  assert.equal(d.observed.reason, 'international_transaction_not_allowed');
  assert.equal(d.observed.code, 'BAD_REQUEST_ERROR');
  assert.equal(d.observed.errorSource, 'account');
  assert.ok(d.explanation.length > 20, 'a diagnosis must be explainable in words');
  assert.ok(Object.hasOwn(d, 'ruleIndex'), 'the matching rule must be identifiable');
});

test('physics is copied out, so a stored decision cannot re-interpret itself later', async () => {
  const d = await diagnose(observe(REAL_DECLINE));
  const cause = getRootCause('INSTRUMENT_NOT_ACCEPTED');

  assert.notEqual(d.physics, cause, 'physics must be a copy, not a live reference to the taxonomy');
  assert.equal(d.physics.retryCanSucceed, cause.retryCanSucceed);

  // Survives serialisation unchanged: an audit record is only useful if it means the same thing
  // after a round trip through the database.
  assert.deepEqual(JSON.parse(JSON.stringify(d)).physics, d.physics);
});

test('no never-retryable rule is shadowed by a retryable rule above it', async () => {
  /**
   * A PROPERTY TEST OVER THE TABLE, replacing one that could not fail.
   *
   * The first version of this test read, for causes already known never-retryable:
   *
   *     assert.equal(cause.automationAllowed && cause.retryCanSucceed, false)
   *
   * `retryCanSucceed` is false on that line by construction, so `X && false` is false whatever
   * the taxonomy says. It passed because it was incapable of failing — the exact shape of test
   * this project keeps finding and deleting.
   *
   * The real risk in an ordered table is SHADOWING. Rule ordering is hand-maintained and
   * compliance-first, so a broad rule near the top can make a narrow rule below it unreachable.
   * If the broad one happens to be retryable, an unreachable never-retryable rule means the
   * system retries a payment that structurally cannot succeed — which burns decline ratio, which
   * issuers and card networks watch, and which eventually gets the *good* payments declined too.
   *
   * So: for every never-retryable rule, synthesise the minimal signal that satisfies exactly its
   * predicates, run the real engine, and require the verdict to still be never-retryable. Landing
   * on a *different* never-retryable cause is acceptable — the safety property holds. Landing on
   * a retryable one is not.
   */
  const neverRetryable = RULE_TABLE.map((rule, index) => ({ rule, index })).filter(
    ({ rule }) => rule.cause && !getRootCause(rule.cause).retryCanSucceed
  );

  assert.ok(neverRetryable.length >= 4, 'expected several never-retryable rules to check');

  for (const { rule, index } of neverRetryable) {
    // Only the predicates this rule declares. Anything extra could satisfy a different rule and
    // turn a genuine shadowing finding into noise.
    const failure = {};
    if (rule.reason) failure.errorReason = rule.reason[0];
    if (rule.source) failure.errorSource = rule.source[0];
    if (rule.step) failure.errorStep = rule.step[0];
    if (rule.textAny) failure.errorDescription = rule.textAny[0];
    if (Object.keys(failure).length === 0) continue; // default rules carry no signal to build

    const d = await diagnose(observe({ lossType: 'FAILED_PAYMENT', failure }));

    assert.equal(
      d.physics.retryCanSucceed, false,
      `RULE_TABLE[${index}] (${rule.cause}) is shadowed: the minimal signal that should match it ` +
        `diagnosed as ${d.rootCause} via ${d.matchTier}, which permits a retry`
    );
  }
});

test('a full generated batch produces a well-formed diagnosis for every event', async () => {
  // The integration check. Runs the real generator through the real projection into the real
  // engine, and asserts shape rather than accuracy — accuracy is `npm run diagnose-report`.
  const { events } = generateBatch({ seed: 'diagnose-test', split: 'TRAIN' });
  assert.ok(events.length > 100, 'expected a substantial batch');

  for (const event of events) {
    const d = await diagnose(observe(event));

    assert.ok(Object.hasOwn(ROOT_CAUSES, d.rootCause), `unknown class ${d.rootCause}`);
    assert.ok(Object.values(MatchTier).includes(d.matchTier), `unknown tier ${d.matchTier}`);
    assert.equal(typeof d.physics.retryCanSucceed, 'boolean');
    assert.equal(typeof d.abstained, 'boolean');

    // Abstention and a confident class must never both be claimed.
    assert.equal(d.abstained, d.rootCause === 'UNKNOWN');

    // A human-only cause must never also be marked automatable, in any code path.
    if (d.physics.humanOnly) assert.equal(d.physics.automationAllowed, false);
  }
});

test('the engine emits no confidence number, on purpose', async () => {
  /**
   * The design decision most likely to be "fixed" by a well-meaning later edit.
   *
   * A confidence of 0.93 claims that in roughly 93 of 100 similar cases this answer is right.
   * Nothing here has measured that. Inventing it would mean the expected-value engine multiplies
   * real money by a number I made up, and it would be indistinguishable from a measured
   * probability in every log line and dashboard. That is the most expensive kind of dishonesty
   * available in this codebase, because no reviewer can falsify it by reading the code.
   *
   * `matchTier` is emitted instead: an observable fact about HOW the match was made. Day 5 may
   * attach a probability once `npm run diagnose-report` has measured the per-tier hit rates.
   * Measure first, then quantify.
   */
  const d = await diagnose(observe(REAL_DECLINE));

  for (const banned of ['confidence', 'probability', 'score', 'likelihood', 'certainty']) {
    assert.ok(!Object.hasOwn(d, banned), `diagnose() must not invent a "${banned}" field`);
  }
  assert.ok(Object.hasOwn(d, 'matchTier'));
});
