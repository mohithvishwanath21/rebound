/**
 * THE SHARED GATEWAY CONTRACT
 * ===========================
 *
 * Both gateways run these identical assertions. Same reasoning as `storeContract.js`: two
 * implementations behind one interface are only safe if something forces them to agree,
 * and "I was careful" is not that something.
 *
 * The stakes here are higher than for the store. Every recovery number this project
 * reports is measured through the SIM gateway, and the argument for those numbers meaning
 * anything is that the LIVE gateway is interchangeable with it. If SIM were more permissive
 * — accepted a malformed request, allowed a sub-₹1 amount, produced a reference Razorpay
 * would reject — then the policy could learn to exploit a difference that does not exist in
 * production, and the measured result would be an artefact of my own test double.
 *
 * So the contract deliberately asserts the *structural* properties both must share, and
 * says nothing about outcomes: SIM decides whether money arrives by sampling latent truth,
 * LIVE decides by asking Razorpay. Anything outcome-shaped belongs in a mode-specific test,
 * and the two are kept apart on purpose.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GatewayMode,
  ReceiptState,
  assertReceiptShape,
  MAX_REFERENCE_LENGTH,
} from '../src/razorpay/gateway.js';
import { ActionKind } from '../src/core/actions.js';

/** A customer with full consent, so consent never confounds a contract assertion. */
export const CUSTOMER = {
  customerId: 'cust_000069',
  name: 'Karthik Khanna',
  email: 'karthik.khanna@example.com',
  contact: '+919894755125',
  phone: '+919894755125',
  segment: 'B2C',
  consent: { email: true, sms: true, whatsapp: false, voice: false },
  dnd: false,
  preferredRail: 'CARD',
};

export const EVENT = {
  eventId: 'evt_000001',
  lossType: 'FAILED_SUBSCRIPTION',
  customerId: 'cust_000069',
  amountPaise: 41000,
  currency: 'INR',
  occurredAt: '2026-08-09T01:55:26.700Z',
  detectedAt: '2026-08-09T04:28:13.628Z',
  rail: 'NETBANKING',
  priorAttempts: 0,
  references: { orderId: 'order_sim_000001', paymentId: 'pay_sim_000001' },
  downtime: { issuerDownAtFailure: false },
  failure: {
    errorCode: 'BAD_REQUEST_ERROR',
    errorReason: 'insufficient_funds',
    errorSource: 'bank',
    errorStep: 'payment_authorization',
    method: 'netbanking',
    bank: 'IDFC',
  },
  subscription: { subscriptionId: 'sub_sim_000001', cycleNumber: 1, totalCycles: 7, mandateStatus: 'active' },
};

/** Matches the shape the generator writes into `data/*.truth.json`. */
export const LATENT = {
  eventId: 'evt_000001',
  customerId: 'cust_000069',
  trueRootCause: 'INSUFFICIENT_FUNDS',
  payerType: 'WILL_PAY_IF_REMINDED',
  responsiveness: 0.78,
  patienceBudget: 4,
  workingRails: ['NETBANKING', 'CARD'],
  willSelfRecover: false,
};

export function requestFor(overrides = {}) {
  return {
    runId: 'run_contract_1',
    eventId: EVENT.eventId,
    event: EVENT,
    customer: CUSTOMER,
    amountPaise: EVENT.amountPaise,
    decisionSeq: 1,
    touchesUsed: 0,
    action: { kind: ActionKind.SEND_LINK, channel: 'EMAIL' },
    ...overrides,
  };
}

/**
 * @param {string} label
 * @param {() => object|Promise<object>} makeGateway - fresh gateway per test
 * @param {object} [opts]
 * @param {string} opts.expectedMode
 */
export function runGatewayContract(label, makeGateway, { expectedMode }) {
  const g = async () => await makeGateway();

  // ------------------------------------------------------------- identity

  test(`[${label}] reports its mode, and it is the mode we asked for`, async () => {
    const gw = await g();
    assert.equal(gw.mode, expectedMode);
    assert.ok(Object.values(GatewayMode).includes(gw.mode));
  });

  test(`[${label}] implements every method the orchestrator calls`, async () => {
    const gw = await g();
    for (const m of ['retryCharge', 'sendPaymentLink', 'requestReauth', 'fetchStatus']) {
      assert.equal(typeof gw[m], 'function', `missing ${m}`);
    }
  });

  // ------------------------------------------------------- receipt shape

  test(`[${label}] every action returns a structurally valid receipt`, async () => {
    const gw = await g();
    const cases = [
      ['sendPaymentLink', { action: { kind: ActionKind.SEND_LINK, channel: 'EMAIL' } }],
      ['sendPaymentLink', { action: { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: 'SMS' }, preferredRail: 'UPI' }],
      ['requestReauth', { action: { kind: ActionKind.REQUEST_REAUTH, channel: 'EMAIL' } }],
      ['retryCharge', { action: { kind: ActionKind.RETRY_NOW } }],
    ];
    for (const [method, over] of cases) {
      const r = await gw[method](requestFor({ ...over, decisionSeq: 1 }));
      assertReceiptShape(r, `${label} ${method} ${over.action.kind}`);
      assert.equal(r.mode, expectedMode);
      assert.equal(r.actionKind, over.action.kind);
    }
  });

  test(`[${label}] receipts are immutable once issued`, async () => {
    const gw = await g();
    const r = await gw.sendPaymentLink(requestFor());
    // An audit trail you can edit after the fact is not an audit trail. Freezing the
    // receipt makes tampering a thrown error rather than a silent overwrite.
    assert.throws(() => {
      'use strict';
      r.amountCollectedPaise = 999999;
    });
    assert.throws(() => {
      'use strict';
      r.caveats.push('nothing to see here');
    });
  });

  test(`[${label}] carries at least one caveat describing what was and was not real`, async () => {
    const gw = await g();
    const r = await gw.retryCharge(requestFor({ action: { kind: ActionKind.RETRY_NOW } }));
    assert.ok(r.caveats.length > 0, 'a retry receipt must state what it did not do');
  });

  // ----------------------------------------------------- accounting rules

  test(`[${label}] a receipt that did not capture collected exactly zero`, async () => {
    const gw = await g();
    for (const seq of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = await gw.sendPaymentLink(requestFor({ decisionSeq: seq }));
      if (r.state !== ReceiptState.CAPTURED) {
        assert.equal(r.amountCollectedPaise, 0, `${r.state} receipt claimed ${r.amountCollectedPaise} paise`);
      }
    }
  });

  test(`[${label}] collected never exceeds requested, and both are integer paise`, async () => {
    const gw = await g();
    for (const seq of [1, 2, 3, 4, 5]) {
      for (const method of ['sendPaymentLink', 'retryCharge']) {
        const req = requestFor({
          decisionSeq: seq,
          action: method === 'retryCharge' ? { kind: ActionKind.RETRY_NOW } : { kind: ActionKind.SEND_LINK, channel: 'EMAIL' },
        });
        const r = await gw[method](req);
        assert.ok(Number.isInteger(r.amountPaise) && Number.isInteger(r.amountCollectedPaise));
        assert.ok(r.amountCollectedPaise <= r.amountPaise);
        assert.ok(r.amountCollectedPaise >= 0);
      }
    }
  });

  test(`[${label}] a FAILED receipt always carries a machine-readable error code`, async () => {
    const gw = await g();
    for (const seq of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = await gw.retryCharge(requestFor({ decisionSeq: seq, action: { kind: ActionKind.RETRY_NOW } }));
      if (r.state === ReceiptState.FAILED) {
        assert.ok(r.errorCode, 'a failure with no code cannot be diagnosed or aggregated');
      }
    }
  });

  // --------------------------------------------------------- idempotency

  test(`[${label}] the reference is deterministic in its inputs`, async () => {
    const gw = await g();
    const a = await gw.sendPaymentLink(requestFor({ decisionSeq: 3 }));
    const b = await gw.sendPaymentLink(requestFor({ decisionSeq: 3 }));
    assert.equal(a.reference, b.reference, 'a replayed decision must produce the same key');
  });

  test(`[${label}] the reference changes with decisionSeq, action and channel`, async () => {
    const gw = await g();
    const base = await gw.sendPaymentLink(requestFor({ decisionSeq: 1 }));
    const laterSeq = await gw.sendPaymentLink(requestFor({ decisionSeq: 2 }));
    const otherChannel = await gw.sendPaymentLink(requestFor({ decisionSeq: 1, action: { kind: ActionKind.SEND_LINK, channel: 'SMS' } }));
    const otherAction = await gw.sendPaymentLink(
      requestFor({ decisionSeq: 1, action: { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: 'EMAIL' } })
    );
    const refs = new Set([base.reference, laterSeq.reference, otherChannel.reference, otherAction.reference]);
    assert.equal(refs.size, 4, `expected 4 distinct references, got ${[...refs].join(', ')}`);
  });

  test(`[${label}] every reference fits Razorpay's 40-character reference_id limit`, async () => {
    const gw = await g();
    for (const seq of [1, 9, 99]) {
      for (const kind of [ActionKind.SEND_LINK, ActionKind.SWITCH_RAIL_NUDGE, ActionKind.REQUEST_REAUTH]) {
        const r = await gw.sendPaymentLink(requestFor({ decisionSeq: seq, action: { kind, channel: 'EMAIL' } }));
        assert.ok(
          r.reference.length <= MAX_REFERENCE_LENGTH,
          `${r.reference} is ${r.reference.length} chars — Razorpay would reject it`
        );
        assert.ok(r.reference.startsWith('rbd_'), 'our references must be greppable in the Razorpay dashboard');
      }
    }
  });

  // ---------------------------------------------------------- validation

  test(`[${label}] rejects requests that Razorpay itself would reject`, async () => {
    const gw = await g();
    const bad = [
      ['no runId', requestFor({ runId: null })],
      ['no eventId', requestFor({ eventId: null })],
      ['no action kind', requestFor({ action: {} })],
      ['amount below ₹1', requestFor({ amountPaise: 99 })],
      ['fractional paise', requestFor({ amountPaise: 41000.5 })],
      ['negative amount', requestFor({ amountPaise: -41000 })],
      ['contacting with no channel', requestFor({ action: { kind: ActionKind.SEND_LINK } })],
    ];
    for (const [why, req] of bad) {
      await assert.rejects(
        () => gw.sendPaymentLink(req),
        (e) => {
          assert.ok(e instanceof Error, `${why} should reject with an Error`);
          return true;
        },
        `should have rejected: ${why}`
      );
    }
  });

  /**
   * The asymmetry test. SIM being *more* permissive than LIVE is the dangerous direction,
   * because the policy would learn to do something that fails in production. Validation
   * lives in one shared function precisely so this cannot drift.
   */
  test(`[${label}] validation is shared, not reimplemented per mode`, async () => {
    const gw = await g();
    await assert.rejects(() => gw.retryCharge(requestFor({ action: { kind: ActionKind.RETRY_NOW }, decisionSeq: null })));
  });

  // --------------------------------------------------------- fetchStatus

  test(`[${label}] fetchStatus returns a coherent view for a receipt's providerRef`, async () => {
    const gw = await g();
    const r = await gw.sendPaymentLink(requestFor({ decisionSeq: 7 }));
    if (!r.providerRef) return; // an UNKNOWN receipt legitimately has none
    const view = await gw.fetchStatus({ providerRef: r.providerRef });
    assert.equal(view.providerRef, r.providerRef);
    assert.ok(Object.values(ReceiptState).includes(view.state), `bad state ${view.state}`);
    assert.ok(['PAYMENT_LINK', 'ORDER', 'PAYMENT'].includes(view.kind), `bad kind ${view.kind}`);
    assert.ok(Number.isInteger(view.amountPaidPaise) && view.amountPaidPaise >= 0);
  });

  test(`[${label}] fetchStatus refuses a missing providerRef`, async () => {
    const gw = await g();
    await assert.rejects(() => gw.fetchStatus({}), /providerRef/);
  });
}
