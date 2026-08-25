/**
 * EXPECTED VALUE TESTS
 * ====================
 *
 * Every expectation in this file is arithmetic done by hand and written as an integer literal.
 * No test computes its expectation by calling the function under test with different arguments,
 * because that only proves internal consistency — it would pass just as happily if the margin
 * and the probability were swapped.
 *
 * The prices these are computed against (src/core/config.js):
 *
 *   channel        EMAIL 2, SMS 25, WHATSAPP 35, VOICE 350 paise
 *   humanReview    6000 paise (₹60)
 *   failedRetry    200 paise
 *   patienceUnit   400 paise, charged as unit x (touchesUsed + 1)
 *   margins        FAILED_PAYMENT 0.35, FAILED_SUBSCRIPTION 0.75, OVERDUE_INVOICE 1.0
 *   minEvToAct     200 paise (₹2)
 *
 * If a test here fails after a config change, that is the test working: these numbers are the
 * decision, and a change to them is a change of policy that should be noticed rather than
 * absorbed.
 *
 * Run: node --test test/expectedValue.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expectedValue,
  marginFor,
  channelCostPaise,
  actionThresholdPaise,
  evStandardErrorPaise,
  describeAssumptions,
} from '../src/agent/expectedValue.js';
import { ActionKind, Channel, ACTION_META } from '../src/core/actions.js';
import { COSTS, CONTRIBUTION_MARGIN, POLICY } from '../src/core/config.js';

// ---------------------------------------------------------------------------------------------
// Margin
// ---------------------------------------------------------------------------------------------

test('marginFor returns the configured margin per loss type', () => {
  assert.equal(marginFor('FAILED_PAYMENT'), 0.35);
  assert.equal(marginFor('FAILED_SUBSCRIPTION'), 0.75);
  assert.equal(marginFor('OVERDUE_INVOICE'), 1.0);
});

test('an unrecognised loss type falls back to the LOWEST margin, not to 1.0', () => {
  /**
   * The direction of this default is the whole point. Defaulting to full margin would make an
   * unknown category the most valuable thing in the batch and it would be chased first — an
   * unrecognised loss type would jump the queue ahead of a known invoice. Defaulting low makes it
   * chased last, which is the correct way to be wrong about something you do not recognise.
   */
  const lowest = Math.min(...Object.values(CONTRIBUTION_MARGIN));
  assert.equal(marginFor('SOMETHING_NEW'), lowest);
  assert.equal(marginFor(undefined), lowest);
  assert.equal(marginFor(null), lowest);
  assert.ok(lowest < 1.0, 'the fallback must be below full margin or this test proves nothing');
});

// ---------------------------------------------------------------------------------------------
// Channel cost
// ---------------------------------------------------------------------------------------------

test('channel cost is charged only to contacting actions', () => {
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK, channel: Channel.EMAIL }), 2);
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK, channel: Channel.SMS }), 25);
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK, channel: Channel.WHATSAPP }), 35);
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK, channel: Channel.VOICE }), 350);

  // A retry is silent to the customer, so it has no channel and no channel cost.
  assert.equal(channelCostPaise({ kind: ActionKind.RETRY_NOW, channel: Channel.SMS }), 0);
  assert.equal(channelCostPaise({ kind: ActionKind.ESCALATE_HUMAN }), 0);
});

test('a contacting action with no channel is priced at the MOST expensive channel', () => {
  /**
   * This is a construction bug, not a free message. Priced at the maximum so the mistake surfaces
   * as an action that never wins. Priced at zero — the tempting default — it would win every
   * argmax, and the audit trail would show the agent choosing a malformed action on merit.
   */
  const worst = Math.max(...Object.values(COSTS.channel));
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK }), worst);
  assert.equal(channelCostPaise({ kind: ActionKind.SEND_LINK, channel: 'CARRIER_PIGEON' }), worst);
});

// ---------------------------------------------------------------------------------------------
// The arithmetic, by hand
// ---------------------------------------------------------------------------------------------

test('hand-computed EV: SEND_LINK by SMS on a failed payment, first touch', () => {
  /**
   *   amount      100000 paise (₹1,000)
   *   margin      0.35   (FAILED_PAYMENT)
   *   p           0.30
   *   gross       0.30 x 100000 x 0.35            = 10500
   *   channel     SMS                             =    25
   *   patience    400 x (0 + 1)                   =   400
   *   failure     none — SEND_LINK does not move money
   *   total cost                                  =   425
   *   EV          10500 - 425                     = 10075
   */
  const r = expectedValue({
    p: 0.3,
    amountPaise: 100_000,
    lossType: 'FAILED_PAYMENT',
    action: { kind: ActionKind.SEND_LINK, channel: Channel.SMS },
    touchesUsed: 0,
  });

  assert.equal(r.grossPaise, 10_500);
  assert.equal(r.components.channelPaise, 25);
  assert.equal(r.components.patiencePenaltyPaise, 400);
  assert.equal(r.components.expectedFailurePenaltyPaise, 0);
  assert.equal(r.totalCostPaise, 425);
  assert.equal(r.evPaise, 10_075);
});

test('hand-computed EV: RETRY_NOW carries the expected failure penalty and no patience cost', () => {
  /**
   *   amount      100000, margin 0.35, p 0.20
   *   gross       0.20 x 100000 x 0.35            =  7000
   *   channel     retries are silent               =     0
   *   patience    consumesTouch is false           =     0
   *   failure     (1 - 0.20) x 200 = 0.8 x 200     =   160
   *   EV          7000 - 160                       =  6840
   */
  const r = expectedValue({
    p: 0.2,
    amountPaise: 100_000,
    lossType: 'FAILED_PAYMENT',
    action: { kind: ActionKind.RETRY_NOW },
  });

  assert.equal(r.grossPaise, 7_000);
  assert.equal(r.components.channelPaise, 0);
  assert.equal(r.components.patiencePenaltyPaise, 0);
  assert.equal(r.components.expectedFailurePenaltyPaise, 160);
  assert.equal(r.evPaise, 6_840);
});

test('the failure penalty is what makes a hopeless retry negative rather than free', () => {
  /**
   * The mechanism that makes "retry everything three times" bad rather than merely crude. At
   * p = 0 the gross is zero and the penalty is the full 200 paise, so the action is worth -200.
   * Without this term it would be worth exactly 0 — free — and a policy that retried every dead
   * card three times would score identically to one that did not.
   */
  const hopeless = expectedValue({
    p: 0,
    amountPaise: 500_000,
    lossType: 'FAILED_PAYMENT',
    action: { kind: ActionKind.RETRY_NOW },
  });
  assert.equal(hopeless.grossPaise, 0);
  assert.equal(hopeless.components.expectedFailurePenaltyPaise, COSTS.failedRetryPenaltyPaise);
  assert.equal(hopeless.evPaise, -200);
  assert.ok(hopeless.evPaise < 0, 'a hopeless retry must cost something, not nothing');

  // And at p = 1 the penalty vanishes entirely: a retry that always works has no downside.
  const certain = expectedValue({
    p: 1,
    amountPaise: 500_000,
    lossType: 'FAILED_PAYMENT',
    action: { kind: ActionKind.RETRY_NOW },
  });
  assert.equal(certain.components.expectedFailurePenaltyPaise, 0);
  assert.equal(certain.evPaise, 175_000, '500000 x 0.35, no costs at all');
});

test('margin is why two equal amounts are unequal opportunities', () => {
  /**
   * The business point that a retry loop cannot see. Same ₹10,000, same probability, same action.
   * The invoice is worth ₹10,000 of contribution because the goods were already delivered and the
   * cost is sunk; the failed payment is worth ₹3,500 because nothing has shipped and what was
   * lost is a sale. Chasing them equally hard is a mistake no amount of retry tuning can fix.
   */
  const args = {
    p: 0.5,
    amountPaise: 1_000_000,
    action: { kind: ActionKind.SEND_LINK, channel: Channel.EMAIL },
    touchesUsed: 0,
  };

  const invoice = expectedValue({ ...args, lossType: 'OVERDUE_INVOICE' });
  const payment = expectedValue({ ...args, lossType: 'FAILED_PAYMENT' });

  assert.equal(invoice.grossPaise, 500_000, '0.5 x 1000000 x 1.0');
  assert.equal(payment.grossPaise, 175_000, '0.5 x 1000000 x 0.35');
  assert.equal(invoice.grossPaise - payment.grossPaise, 325_000);

  // Identical costs, so the entire difference is the margin.
  assert.equal(invoice.totalCostPaise, payment.totalCostPaise);
});

// ---------------------------------------------------------------------------------------------
// The patience term
// ---------------------------------------------------------------------------------------------

test('the patience price is convex in touches already spent', () => {
  /**
   *   touch 1  400 x 1 =  400
   *   touch 2  400 x 2 =  800
   *   touch 5  400 x 5 = 2000
   *
   * A FLAT charge would under-price exactly the late touches that do the damage — the fifth
   * message is where the response model's fatigue effect is steepest, so a flat 400 would make
   * harassment look as cheap as a first contact.
   */
  const expected = [400, 800, 1200, 1600, 2000];
  for (let touchesUsed = 0; touchesUsed < 5; touchesUsed += 1) {
    const r = expectedValue({
      p: 0.1,
      amountPaise: 50_000,
      lossType: 'FAILED_PAYMENT',
      action: { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.WHATSAPP },
      touchesUsed,
    });
    assert.equal(
      r.components.patiencePenaltyPaise,
      expected[touchesUsed],
      `touch ${touchesUsed + 1} should cost ${expected[touchesUsed]} paise`
    );
    assert.equal(r.components.touchesUsed, touchesUsed);
  }
});

test('the patience price alone can turn a positive action negative before any cap binds', () => {
  /**
   * This is the ECONOMIC half of the two-mechanism argument, and it is measurable here without
   * involving the guardrails at all. A ₹250 failed payment at p = 0.10 has a gross of 875 paise.
   *
   *   touch 1: 875 - 35 - 400  = +440   worth doing
   *   touch 2: 875 - 35 - 800  = +40    above zero but below the 200-paise bar
   *   touch 3: 875 - 35 - 1200 = -360   destroys value
   *
   * `maxTouchesPerCase` is 5, so the cap is nowhere near binding. The shadow price stops the
   * agent spending ₹12 of goodwill to chase ₹8.75 of contribution — a trade-off a cap cannot
   * express, which is why both mechanisms are kept.
   */
  const at = (touchesUsed) =>
    expectedValue({
      p: 0.1,
      amountPaise: 25_000,
      lossType: 'FAILED_PAYMENT',
      action: { kind: ActionKind.SEND_LINK, channel: Channel.WHATSAPP },
      touchesUsed,
    }).evPaise;

  assert.equal(at(0), 440);
  assert.equal(at(1), 40);
  assert.equal(at(2), -360);

  const bar = actionThresholdPaise();
  assert.ok(at(0) >= bar, 'the first touch clears the bar');
  assert.ok(at(1) < bar, 'the second does not, despite being positive');
  assert.ok(at(2) < 0, 'the third actively destroys value');
});

// ---------------------------------------------------------------------------------------------
// Escalation, and the actions that structurally cannot recover
// ---------------------------------------------------------------------------------------------

test('ESCALATE_HUMAN has a structurally zero gross and can never win an argmax', () => {
  /**
   * Escalation recovers nothing by itself — a human does the recovering afterwards. Pricing it
   * properly would need P(analyst recovers | they look), which this project has no data for and
   * would have to invent. So its EV is always exactly -6000 and it is reached through the
   * standing rules in stopping.js instead of through the arithmetic.
   *
   * Note the gross stays zero even when p is high. If it were written as `p x amount x margin`
   * and a caller passed the case's general recovery probability, escalation would look like the
   * most profitable action available on every large case.
   */
  for (const p of [0, 0.5, 0.99]) {
    const r = expectedValue({
      p,
      amountPaise: 5_000_000,
      lossType: 'OVERDUE_INVOICE',
      action: { kind: ActionKind.ESCALATE_HUMAN },
    });
    assert.equal(r.grossPaise, 0, `gross must be zero at p=${p}`);
    assert.equal(r.components.humanReviewPaise, 6_000);
    assert.equal(r.evPaise, -6_000);
  }
});

test('STOP_PERMANENT and NO_ACTION_YET are free and worth nothing', () => {
  for (const kind of [ActionKind.STOP_PERMANENT, ActionKind.NO_ACTION_YET]) {
    const r = expectedValue({
      p: 0.9,
      amountPaise: 1_000_000,
      lossType: 'OVERDUE_INVOICE',
      action: { kind },
    });
    assert.equal(r.grossPaise, 0, `${kind} cannot recover money`);
    assert.equal(r.totalCostPaise, 0, `${kind} costs nothing`);
    assert.equal(r.evPaise, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// Structural properties of the decomposition
// ---------------------------------------------------------------------------------------------

test('the decomposition sums exactly to the total, with no rounding drift', () => {
  /**
   * Rounding happens per component so the audit drawer's terms add up to its total. If the total
   * were rounded independently of the parts, a reviewer checking the arithmetic by hand would
   * find a one-paise discrepancy and reasonably conclude the whole record was untrustworthy.
   *
   * Swept across awkward probabilities and amounts because that is where a stray Math.round on
   * the total would show up.
   */
  const actions = [
    { kind: ActionKind.RETRY_NOW },
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: '2026-08-25T03:30:00.000Z' },
    { kind: ActionKind.SEND_LINK, channel: Channel.EMAIL },
    { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.VOICE },
    { kind: ActionKind.REQUEST_REAUTH, channel: Channel.SMS },
    { kind: ActionKind.ESCALATE_HUMAN },
  ];

  for (const action of actions) {
    for (const p of [0, 0.007, 0.333333, 0.5, 0.987654, 1]) {
      for (const amountPaise of [1, 999, 12_345, 7_777_777]) {
        for (const lossType of Object.keys(CONTRIBUTION_MARGIN)) {
          const r = expectedValue({ p, amountPaise, lossType, action, touchesUsed: 2 });
          const k = r.components;
          const summed =
            k.channelPaise + k.humanReviewPaise + k.expectedFailurePenaltyPaise + k.patiencePenaltyPaise;

          assert.equal(r.totalCostPaise, summed, 'cost components must sum to totalCostPaise');
          assert.equal(r.evPaise, r.grossPaise - r.totalCostPaise, 'EV must equal gross minus cost');
          assert.ok(Number.isInteger(r.evPaise), `EV must be integer paise, got ${r.evPaise}`);
          assert.ok(Number.isInteger(r.grossPaise), 'gross must be integer paise');
        }
      }
    }
  }
});

test('EV is monotonically non-decreasing in p for every recovering action', () => {
  /**
   * Not merely a sanity check. The failure penalty term also depends on p — it shrinks as p
   * rises — so if it were ever added with the wrong sign, EV would fall as the probability
   * improved and the argmax would systematically prefer the actions least likely to work.
   */
  const actions = [
    { kind: ActionKind.RETRY_NOW },
    { kind: ActionKind.SEND_LINK, channel: Channel.SMS },
    { kind: ActionKind.REQUEST_REAUTH, channel: Channel.WHATSAPP },
  ];

  for (const action of actions) {
    let previous = -Infinity;
    for (let i = 0; i <= 20; i += 1) {
      const ev = expectedValue({
        p: i / 20,
        amountPaise: 200_000,
        lossType: 'FAILED_SUBSCRIPTION',
        action,
        touchesUsed: 1,
      }).evPaise;
      assert.ok(ev >= previous, `${action.kind} EV fell as p rose to ${i / 20}`);
      previous = ev;
    }
  }
});

test('touchesUsed only affects actions that consume a touch', () => {
  for (const kind of [ActionKind.RETRY_NOW, ActionKind.RETRY_SCHEDULED, ActionKind.ESCALATE_HUMAN]) {
    assert.equal(ACTION_META[kind].consumesTouch, false, `${kind} should not consume a touch`);
    const a = expectedValue({ p: 0.4, amountPaise: 90_000, lossType: 'FAILED_PAYMENT', action: { kind }, touchesUsed: 0 });
    const b = expectedValue({ p: 0.4, amountPaise: 90_000, lossType: 'FAILED_PAYMENT', action: { kind }, touchesUsed: 4 });
    assert.equal(a.evPaise, b.evPaise, `${kind} must not be charged for touches it does not use`);
  }
});

// ---------------------------------------------------------------------------------------------
// Input validation. These throw rather than coerce, on purpose.
// ---------------------------------------------------------------------------------------------

test('an out-of-range or non-finite probability throws', () => {
  const base = { amountPaise: 1000, lossType: 'FAILED_PAYMENT', action: { kind: ActionKind.RETRY_NOW } };
  for (const p of [-0.01, 1.01, NaN, Infinity, undefined, null, '0.5']) {
    assert.throws(() => expectedValue({ ...base, p }), RangeError, `p=${p} must be rejected`);
  }
});

test('a non-integer or negative amount throws rather than silently rounding', () => {
  /**
   * Money is integer paise everywhere in this project. Accepting 1234.56 here would let a float
   * amount in through one door and it would reappear as a fractional rupee in a report much
   * later, at which point its origin would be untraceable.
   */
  const base = { p: 0.5, lossType: 'FAILED_PAYMENT', action: { kind: ActionKind.RETRY_NOW } };
  for (const amountPaise of [-1, 1234.56, NaN, undefined, null, '1000']) {
    assert.throws(() => expectedValue({ ...base, amountPaise }), RangeError, `amount=${amountPaise} must be rejected`);
  }
  assert.equal(expectedValue({ ...base, amountPaise: 0 }).grossPaise, 0, 'zero is legal');
});

test('a missing action throws', () => {
  assert.throws(
    () => expectedValue({ p: 0.5, amountPaise: 1000, lossType: 'FAILED_PAYMENT' }),
    TypeError
  );
  assert.throws(
    () => expectedValue({ p: 0.5, amountPaise: 1000, lossType: 'FAILED_PAYMENT', action: {} }),
    TypeError
  );
});

// ---------------------------------------------------------------------------------------------
// The threshold and the assumption register
// ---------------------------------------------------------------------------------------------

test('the action bar is above zero, not at it', () => {
  /**
   * Acting at EV = +1 paise is not maximising expected value, it is fitting the noise in the
   * probability estimate. The bar is the honest admission that the number has a standard error
   * attached even though the arithmetic prints to the paise.
   */
  assert.equal(actionThresholdPaise(), 200);
  assert.ok(actionThresholdPaise() > 0, 'a bar at zero would be acting on our own noise');
  assert.equal(actionThresholdPaise({ minEvToActPaise: 500 }), 500, 'it is a reportable knob');
});

test('every assumption is registered and every one is marked unmeasured', () => {
  /**
   * `measured: false` on all of them is the point. These are stated assumptions, and the
   * sensitivity sweep on Days 8-9 exists because none of them is a measurement. A future entry
   * that quietly appeared with measured: true would need evidence behind it, and this test is
   * where that claim has to be made deliberately.
   */
  const assumptions = describeAssumptions();
  const names = assumptions.map((a) => a.name);

  for (const required of [
    'channel.EMAIL', 'channel.SMS', 'channel.WHATSAPP', 'channel.VOICE',
    'humanReviewPaise', 'failedRetryPenaltyPaise', 'patienceUnitPaise', 'minEvToActPaise',
  ]) {
    assert.ok(names.includes(required), `${required} must appear in the assumption register`);
  }

  for (const lossType of Object.keys(CONTRIBUTION_MARGIN)) {
    assert.ok(names.includes(`margin.${lossType}`), `margin.${lossType} must be registered`);
  }

  assert.ok(assumptions.every((a) => a.measured === false), 'no assumption here is a measurement');

  // The prices in the register must be the prices the arithmetic actually used.
  const byName = Object.fromEntries(assumptions.map((a) => [a.name, a]));
  assert.equal(byName['channel.SMS'].paise, COSTS.channel.SMS);
  assert.equal(byName.failedRetryPenaltyPaise.paise, COSTS.failedRetryPenaltyPaise);
  assert.equal(byName.patienceUnitPaise.paise, COSTS.patienceUnitPaise);
  assert.equal(byName.minEvToActPaise.paise, POLICY.minEvToActPaise);

  // The least defensible number is labelled as such, because the sweep depends on knowing it.
  assert.match(byName.failedRetryPenaltyPaise.basis, /LEAST DEFENSIBLE/);
});

test('costs are injectable, so the sensitivity sweep can perturb them without mutating config', () => {
  /**
   * Days 8-9 perturb every price by +/-30%. That is only tractable if the arithmetic reads its
   * prices from an argument rather than closing over the module-level constant.
   */
  const doubled = { ...COSTS, failedRetryPenaltyPaise: 400 };
  const r = expectedValue({
    p: 0.5,
    amountPaise: 100_000,
    lossType: 'FAILED_PAYMENT',
    action: { kind: ActionKind.RETRY_NOW },
    costs: doubled,
  });
  assert.equal(r.components.expectedFailurePenaltyPaise, 200, '(1 - 0.5) x 400');
  assert.equal(COSTS.failedRetryPenaltyPaise, 200, 'the real config must be untouched');
});

// =============================================================================================
// THE SUPPORT-SCALED BAR (#52) — every number below is hand-computed
// =============================================================================================

test('sigma(EV) is the binomial standard error times the stake, to the paise', () => {
  /**
   * BY HAND, with p = 0.12 over 30 rows on a ₹1,000 case at margin 1.0:
   *
   *   p(1-p)          = 0.12 x 0.88            = 0.1056
   *   /(rows + 2)     = 0.1056 / 32            = 0.0033
   *   sigma(p)        = sqrt(0.0033)           = 0.05744562646...
   *   sigma(EV)       = 0.05744562646 x 100000 = 5744.5626... paise
   *
   * The `+2` is the pseudo-count, and using `rows` alone would give 5936.6 — a 3.3% difference here
   * and an unbounded one on a cell of three identical rows, where the bare form reports sigma = 0.
   */
  const sigma = evStandardErrorPaise({ p: 0.12, rows: 30, amountPaise: 100_000, marginFraction: 1 });
  assert.ok(Math.abs(sigma - 5744.5626466) < 1e-6, `expected 5744.5626 paise, got ${sigma}`);
  assert.equal(actionThresholdPaise({ minEvToActPaise: 200, evBarSigmaK: 1 }, { p: 0.12, rows: 30, amountPaise: 100_000, marginFraction: 1 }), 5745);
});

test('the bar scales exactly with the stake, so EV/sigma is amount-invariant', () => {
  /**
   * THIS TEST PINS THE FINDING THAT CORRECTED MY OWN REASONING. I predicted the flat bar would fail
   * worst on large amounts. It cannot: EV and sigma(EV) are both linear in the amount, so their
   * ratio — the quantity that actually decides whether an action clears a sigma bar — does not
   * depend on the amount at all. `probe-evbar.mjs` measured the largest quartile as the SAFEST.
   *
   * If a future change makes the bar sublinear in the amount, that finding silently stops holding
   * and every conclusion drawn from it becomes wrong. Hence an equality, not an inequality.
   */
  const evidence = (amountPaise) => ({ p: 0.12, rows: 30, amountPaise, marginFraction: 1 });
  const small = evStandardErrorPaise(evidence(100_000));
  const large = evStandardErrorPaise(evidence(1_000_000));
  assert.ok(Math.abs(large - small * 10) < 1e-9, `sigma must be linear in the stake: ${large} vs ${small * 10}`);

  // And the ratio is p / sigma(p) = 0.12 / 0.05744562646 = 2.0889..., identical at both stakes.
  const ratio = (amountPaise) => (0.12 * amountPaise) / evStandardErrorPaise(evidence(amountPaise));
  assert.ok(Math.abs(ratio(100_000) - ratio(1_000_000)) < 1e-9, 'EV/sigma must be amount-invariant');
  assert.ok(Math.abs(ratio(100_000) - 2.0889318714) < 1e-8, `expected 2.08893, got ${ratio(100_000)}`);
});

test('support, not amount, is what moves the bar', () => {
  // Same p, same stake, 30 rows vs 900. Hand-computed: sqrt(0.1056/902) x 100000 = 1082.0035 paise.
  const thin = evStandardErrorPaise({ p: 0.12, rows: 30, amountPaise: 100_000, marginFraction: 1 });
  const solid = evStandardErrorPaise({ p: 0.12, rows: 900, amountPaise: 100_000, marginFraction: 1 });
  assert.ok(Math.abs(solid - 1082.0035616) < 1e-6, `expected 1082.0036 paise, got ${solid}`);
  assert.ok(thin > solid * 5, `a thin cell must face a much higher bar: ${thin} vs ${solid}`);
});

test('an unseen cell falls back to the flat floor rather than inventing a standard error', () => {
  /**
   * The architectural boundary, pinned. `rows = 0` means the probability is the global base rate and
   * its error is BIAS, which a standard error cannot express. Returning a sigma here produced a bar
   * of roughly a fifth of the amount, which turned AWAIT_APPROVAL into ESCALATE_HUMAN and disabled
   * the approval envelope — see the docblock on `evStandardErrorPaise`. Unseen beliefs belong to
   * `APR_UNSUPPORTED_BELIEF`, and this assertion is what keeps them there.
   */
  const policy = { minEvToActPaise: 200, evBarSigmaK: 1 };
  assert.equal(evStandardErrorPaise({ p: 0.12, rows: 0, amountPaise: 5_000_000, marginFraction: 1 }), null);
  assert.equal(actionThresholdPaise(policy, { p: 0.12, rows: 0, amountPaise: 5_000_000, marginFraction: 1 }), 200);
  // An arm that cannot report support at all is treated the same way, for the same reason.
  assert.equal(actionThresholdPaise(policy, { p: 0.12, amountPaise: 5_000_000, marginFraction: 1 }), 200);
});

test('k = 0 restores the old flat bar exactly, which is what makes the A/B possible', () => {
  /**
   * Not a legacy escape hatch. The comparison in ENGINEERING_LOG holds the world, the model, the
   * luck and the clock fixed and moves only `evBarSigmaK`, and that is only a clean experiment if
   * k = 0 reproduces the previous policy to the paise rather than approximately.
   */
  const evidence = { p: 0.12, rows: 30, amountPaise: 100_000, marginFraction: 1 };
  assert.equal(actionThresholdPaise({ minEvToActPaise: 200, evBarSigmaK: 0 }, evidence), 200);
  assert.equal(actionThresholdPaise({ minEvToActPaise: 200 }, evidence), 200, 'a policy with no k set must not opt in silently');
  assert.equal(actionThresholdPaise(POLICY), POLICY.minEvToActPaise, 'called without evidence, the shipped policy still reports its floor');
});

test('the floor still binds when sigma is tiny', () => {
  // A well-observed cell on a ₹20 case: sqrt(0.1056/10002) x 2000 = 6.5 paise, under the ₹2 floor.
  const bar = actionThresholdPaise({ minEvToActPaise: 200, evBarSigmaK: 1 }, { p: 0.12, rows: 10_000, amountPaise: 2_000, marginFraction: 1 });
  assert.equal(bar, 200, 'max(floor, k x sigma) must not let a small case act on 7 paise of headroom');
});
