import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifyWebhook,
  verifyPaymentSignature,
  verifyPaymentLinkCallback,
  safeCompareHex,
  createReplayGuard,
  normaliseWebhook,
  HANDLED_EVENTS,
} from '../src/razorpay/webhook.js';

const SECRET = 'wh_secret_forTestsOnly_1234';
const KEY_SECRET = 'ks_secret_forTestsOnly_5678';

const sign = (body, secret = SECRET) => createHmac('sha256', secret).update(body).digest('hex');

/** A realistic `payment_link.paid` envelope, shaped from Razorpay's documented payload. */
const LINK_PAID = {
  entity: 'event',
  account_id: 'acc_TEST',
  event: 'payment_link.paid',
  contains: ['payment_link', 'payment'],
  created_at: 1755840000,
  payload: {
    payment_link: {
      entity: {
        id: 'plink_TESTabc123',
        entity: 'payment_link',
        amount: 250000,
        amount_paid: 250000,
        currency: 'INR',
        reference_id: 'rbd_run7_evt42_SEND_LINK_1',
        status: 'paid',
        short_url: 'https://rzp.io/i/TESTxyz',
      },
    },
    payment: {
      entity: {
        id: 'pay_TESTdef456',
        entity: 'payment',
        amount: 250000,
        status: 'captured',
        method: 'upi',
        order_id: 'order_TESTghi789',
      },
    },
  },
};

// ------------------------------------------------------------------ raw HMAC

test('a correctly signed body verifies', () => {
  const raw = JSON.stringify(LINK_PAID);
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw), secret: SECRET }), true);
});

test('verification works on a Buffer body, byte-identically to the string form', () => {
  const raw = JSON.stringify(LINK_PAID);
  const buf = Buffer.from(raw, 'utf8');
  assert.equal(verifyWebhook({ rawBody: buf, signature: sign(raw), secret: SECRET }), true);
});

test('a single flipped byte in the body fails verification', () => {
  const raw = JSON.stringify(LINK_PAID);
  const tampered = raw.replace('250000', '250001');
  assert.notEqual(raw, tampered, 'the tamper must actually change the body');
  assert.equal(verifyWebhook({ rawBody: tampered, signature: sign(raw), secret: SECRET }), false);
});

test('the wrong secret fails verification', () => {
  const raw = JSON.stringify(LINK_PAID);
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw, 'other_secret'), secret: SECRET }), false);
});

/**
 * The regression test that protects the whole scheme. Re-serialising a parsed body
 * produces different bytes, so if anyone "simplifies" the route to use express.json(),
 * this fails rather than silently rejecting every real webhook.
 */
test('a re-serialised body does NOT verify — raw bytes are load-bearing', () => {
  const raw = JSON.stringify(LINK_PAID, null, 2); // as if Razorpay had sent pretty JSON
  const signature = sign(raw);
  const reserialised = JSON.stringify(JSON.parse(raw)); // what express.json() round-trip gives
  assert.notEqual(raw, reserialised);
  assert.equal(verifyWebhook({ rawBody: reserialised, signature, secret: SECRET }), false);
});

test('passing an already-parsed object throws a loud, actionable error', () => {
  assert.throws(
    () => verifyWebhook({ rawBody: LINK_PAID, signature: sign('x'), secret: SECRET }),
    /express\.raw/
  );
});

// -------------------------------------------------------------- fail closed

test('fails closed on missing secret, signature, or body', () => {
  const raw = JSON.stringify(LINK_PAID);
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw), secret: '' }), false);
  assert.equal(verifyWebhook({ rawBody: raw, signature: '', secret: SECRET }), false);
  assert.equal(verifyWebhook({ rawBody: null, signature: sign(raw), secret: SECRET }), false);
});

test('fails closed on malformed or wrong-length signatures instead of throwing', () => {
  const raw = JSON.stringify(LINK_PAID);
  const good = sign(raw);
  for (const bad of ['', 'zz', good.slice(0, -1), good + 'ab', 'not-hex-at-all!!', good.toUpperCase() + '00']) {
    assert.equal(
      verifyWebhook({ rawBody: raw, signature: bad, secret: SECRET }),
      false,
      `should reject signature ${JSON.stringify(bad.slice(0, 12))}`
    );
  }
});

test('safeCompareHex is case-insensitive on valid equal digests but rejects junk', () => {
  const d = sign('hello');
  assert.equal(safeCompareHex(d, d), true);
  assert.equal(safeCompareHex(d, d.toUpperCase()), true, 'hex case must not matter');
  assert.equal(safeCompareHex(d, d.replace(/.$/, (c) => (c === '0' ? '1' : '0'))), false);
  assert.equal(safeCompareHex(d, undefined), false);
  assert.equal(safeCompareHex(null, null), false);
});

// ------------------------------------------------- the two other signatures

test('checkout payment signature verifies over order_id|payment_id with the KEY secret', () => {
  const orderId = 'order_TESTghi789';
  const paymentId = 'pay_TESTdef456';
  const signature = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature, keySecret: KEY_SECRET }), true);
  // Swapping the two ids must fail — order matters in the payload.
  assert.equal(
    verifyPaymentSignature({ orderId: paymentId, paymentId: orderId, signature, keySecret: KEY_SECRET }),
    false
  );
});

test('the webhook secret and the key secret are not interchangeable', () => {
  const orderId = 'order_A';
  const paymentId = 'pay_B';
  const signature = createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  assert.equal(verifyPaymentSignature({ orderId, paymentId, signature, keySecret: SECRET }), false);
});

test('payment link callback signature verifies over the four-field payload', () => {
  const fields = {
    paymentLinkId: 'plink_TESTabc123',
    paymentLinkReferenceId: 'rbd_run7_evt42_SEND_LINK_1',
    paymentLinkStatus: 'paid',
    paymentId: 'pay_TESTdef456',
  };
  const payload = [fields.paymentLinkId, fields.paymentLinkReferenceId, fields.paymentLinkStatus, fields.paymentId].join('|');
  const signature = createHmac('sha256', KEY_SECRET).update(payload).digest('hex');
  assert.equal(verifyPaymentLinkCallback({ ...fields, signature, keySecret: KEY_SECRET }), true);
  assert.equal(
    verifyPaymentLinkCallback({ ...fields, paymentLinkStatus: 'expired', signature, keySecret: KEY_SECRET }),
    false
  );
});

// -------------------------------------------------------------- replay guard

test('replay guard accepts once and rejects the identical delivery', () => {
  const now = 1755840000_000;
  const guard = createReplayGuard();
  const delivery = { eventId: 'evt_TEST1', createdAt: 1755840000, now };
  assert.deepEqual(guard.check(delivery), { accepted: true });
  assert.deepEqual(guard.check(delivery), { accepted: false, reason: 'DUPLICATE' });
});

test('replay guard rejects a stale delivery even with a valid signature', () => {
  const guard = createReplayGuard({ windowMs: 60_000 });
  const res = guard.check({ eventId: 'evt_OLD', createdAt: 1755840000, now: 1755840000_000 + 120_000 });
  assert.deepEqual(res, { accepted: false, reason: 'STALE' });
});

test('replay guard rejects a far-future timestamp', () => {
  const guard = createReplayGuard({ windowMs: 60_000 });
  const res = guard.check({ eventId: 'evt_FUTURE', createdAt: 1755840000 + 600, now: 1755840000_000 });
  assert.deepEqual(res, { accepted: false, reason: 'FUTURE_DATED' });
});

test('replay guard accepts millisecond timestamps as well as seconds', () => {
  const guard = createReplayGuard({ windowMs: 60_000 });
  const nowMs = 1755840000_000;
  assert.deepEqual(guard.check({ eventId: 'a', createdAt: 1755840000, now: nowMs }), { accepted: true });
  assert.deepEqual(guard.check({ eventId: 'b', createdAt: nowMs, now: nowMs }), { accepted: true });
});

test('replay guard requires an event id', () => {
  const guard = createReplayGuard();
  assert.deepEqual(guard.check({ eventId: null, createdAt: 1755840000, now: 1755840000_000 }), {
    accepted: false,
    reason: 'MISSING_EVENT_ID',
  });
});

test('replay guard evicts oldest entries and stays bounded', () => {
  const guard = createReplayGuard({ capacity: 10, windowMs: 10 ** 12 });
  for (let i = 0; i < 50; i++) guard.check({ eventId: `evt_${i}`, now: 1 });
  assert.ok(guard.size() <= 11, `expected bounded size, got ${guard.size()}`);
  // And the eviction is genuinely FIFO: the very first id is gone, so it would be
  // accepted again. This is the known limitation the module documents, asserted rather
  // than left as a comment.
  assert.equal(guard.check({ eventId: 'evt_0', now: 1 }).accepted, true);
});

// -------------------------------------------------------------- normalisation

test('normalise digs identifiers out of a payment_link.paid envelope', () => {
  const n = normaliseWebhook(LINK_PAID);
  assert.equal(n.event, 'payment_link.paid');
  assert.equal(n.handled, true);
  assert.equal(n.paymentLinkId, 'plink_TESTabc123');
  assert.equal(n.paymentId, 'pay_TESTdef456');
  assert.equal(n.orderId, 'order_TESTghi789');
  assert.equal(n.referenceId, 'rbd_run7_evt42_SEND_LINK_1', 'reference_id is the join back to our case');
  assert.equal(n.amountPaise, 250000);
  assert.equal(n.amountPaidPaise, 250000);
  assert.equal(n.status, 'paid');
  assert.equal(n.method, 'upi');
});

test('normalise carries the failure reason out of a payment.failed envelope', () => {
  const n = normaliseWebhook({
    event: 'payment.failed',
    created_at: 1755840000,
    payload: {
      payment: {
        entity: {
          id: 'pay_FAIL1',
          amount: 99900,
          status: 'failed',
          method: 'card',
          order_id: 'order_X',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Your card has insufficient funds.',
          notes: { rebound_ref: 'rbd_run7_evt9_RETRY_NOW_1' },
        },
      },
    },
  });
  assert.equal(n.handled, true);
  assert.equal(n.errorDescription, 'Your card has insufficient funds.');
  assert.equal(n.referenceId, 'rbd_run7_evt9_RETRY_NOW_1', 'retries carry the ref in notes, not reference_id');
  assert.equal(n.amountPaidPaise, null, 'a failed payment paid nothing');
});

test('an unhandled event type is flagged rather than silently processed', () => {
  const n = normaliseWebhook({ event: 'subscription.charged', payload: {} });
  assert.equal(n.handled, false);
  assert.ok(!HANDLED_EVENTS.has('subscription.charged'));
});

test('normalise survives a malformed envelope without throwing', () => {
  for (const junk of [undefined, null, {}, { payload: null }, { event: 'x', payload: { payment: {} } }]) {
    const n = normaliseWebhook(junk);
    assert.equal(n.handled, false);
    assert.equal(n.paymentId, null);
  }
});
