/**
 * WEBHOOK AND PAYMENT SIGNATURE VERIFICATION
 * ==========================================
 *
 * This file is small, boring, and the most security-sensitive code in the project. It is
 * also — usefully — the part of the Razorpay integration I can verify completely offline,
 * because HMAC has no network in it. Everything here is exercised by `test/webhook.test.js`
 * with real digests, including the tamper and replay cases.
 *
 * Two different signatures, computed with two different secrets. Confusing them is the
 * classic Razorpay integration bug, so they get separate functions and separate names:
 *
 *   verifyWebhook()  — HMAC-SHA256 over the EXACT RAW REQUEST BODY, keyed by the
 *                      **webhook secret** you chose in the dashboard. Header:
 *                      `X-Razorpay-Signature`.
 *
 *   verifyPaymentSignature() — HMAC-SHA256 over `order_id|payment_id`, keyed by the
 *                      **key secret**. This is what Checkout hands back to the browser.
 *
 * Three rules I am not going to bend:
 *
 *   RAW BYTES. Verification runs on the unparsed body. If Express has already produced
 *   `req.body` as an object, the bytes are gone: re-serialising gives different key order
 *   and different whitespace, the digest won't match, and the tempting "fix" is to stop
 *   verifying. So the webhook route mounts `express.raw()` and this function takes a
 *   Buffer or string. There's a test asserting a re-serialised body FAILS, so nobody
 *   later "helpfully" switches it to JSON parsing.
 *
 *   CONSTANT TIME. `timingSafeEqual`, never `===`. A byte-at-a-time comparison leaks the
 *   expected digest to anyone who can time responses. This is cheap to do right.
 *
 *   FAIL CLOSED. Missing secret, missing header, wrong length, malformed hex — all
 *   return false. There is no configuration in which an unverified webhook is accepted,
 *   because a forged `payment.captured` would let anyone write fake recoveries straight
 *   into the number this whole project reports.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Razorpay events this project acts on. Anything else is acknowledged and ignored. */
export const HANDLED_EVENTS = new Set([
  'payment.captured',
  'payment.failed',
  'payment_link.paid',
  'payment_link.partially_paid',
  'payment_link.expired',
  'payment_link.cancelled',
  'order.paid',
]);

/**
 * Compare two hex digests without leaking where they differ.
 *
 * `timingSafeEqual` throws on a length mismatch — which would itself be a timing signal
 * and a crash — so length is checked first and a mismatch short-circuits to false.
 */
export function safeCompareHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  if (!/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a Razorpay webhook.
 *
 * @param {object} o
 * @param {Buffer|string} o.rawBody   - the body exactly as received. NOT a parsed object.
 * @param {string} o.signature        - the `X-Razorpay-Signature` header
 * @param {string} o.secret           - the dashboard webhook secret
 * @returns {boolean}
 */
export function verifyWebhook({ rawBody, signature, secret }) {
  if (!secret || !signature) return false;
  if (rawBody == null) return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    // Guard against the exact mistake described in the header comment: someone passing
    // `req.body` after JSON middleware. Failing loudly here is far better than failing
    // mysteriously later.
    throw new TypeError(
      'verifyWebhook needs the raw body as a Buffer or string. It looks like the body was ' +
        'already parsed — mount express.raw({type:"application/json"}) on the webhook route.'
    );
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeCompareHex(expected, signature);
}

/**
 * Verify the signature Checkout returns to the browser after a successful payment.
 * Keyed by the KEY secret, over `order_id|payment_id`.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature, keySecret }) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeCompareHex(expected, signature);
}

/** Verify the signature returned for a Payment Link callback (`payment_link_id|...`). */
export function verifyPaymentLinkCallback({ paymentLinkId, paymentLinkReferenceId, paymentLinkStatus, paymentId, signature, keySecret }) {
  if (!signature || !keySecret) return false;
  const payload = [paymentLinkId, paymentLinkReferenceId, paymentLinkStatus, paymentId].join('|');
  const expected = createHmac('sha256', keySecret).update(payload).digest('hex');
  return safeCompareHex(expected, signature);
}

/**
 * Replay guard.
 *
 * A valid signature proves authenticity, not freshness. Anyone who captures one delivery
 * can send the same bytes again forever, and since our handler credits a recovery, a
 * replayed `payment.captured` inflates the headline number — the single most attractive
 * thing to forge in this system. So: dedupe on `X-Razorpay-Event-Id`, and reject payloads
 * older than a freshness window.
 *
 * Kept in memory with a bounded FIFO. That is honestly insufficient for production — a
 * restart or a second instance forgets everything — and the right answer is a unique
 * index on `eventId` in Mongo. `putAction`'s idempotency key in the store already gives
 * the same protection one layer down, so a replay that slips past this cannot double-count
 * a recovery; this is defence in depth rather than the only defence.
 */
export function createReplayGuard({ windowMs = 5 * 60 * 1000, capacity = 5000 } = {}) {
  const seen = new Map(); // eventId -> receivedAt

  return {
    /** @returns {{accepted: boolean, reason?: string}} */
    check({ eventId, createdAt, now = Date.now() }) {
      if (!eventId) return { accepted: false, reason: 'MISSING_EVENT_ID' };

      if (createdAt != null) {
        // Razorpay sends `created_at` in seconds. Anything above ~1e11 is already ms.
        const ms = Number(createdAt) < 1e11 ? Number(createdAt) * 1000 : Number(createdAt);
        if (!Number.isFinite(ms)) return { accepted: false, reason: 'BAD_CREATED_AT' };
        const age = now - ms;
        if (age > windowMs) return { accepted: false, reason: 'STALE' };
        // A little tolerance for clock skew between Razorpay's clock and ours; a
        // far-future timestamp is a forgery attempt or a badly broken clock, and either
        // way we should not act on it.
        if (age < -windowMs) return { accepted: false, reason: 'FUTURE_DATED' };
      }

      if (seen.has(eventId)) return { accepted: false, reason: 'DUPLICATE' };

      seen.set(eventId, now);
      if (seen.size > capacity) {
        const oldest = seen.keys().next().value;
        seen.delete(oldest);
      }
      return { accepted: true };
    },

    size: () => seen.size,
  };
}

/**
 * Flatten a webhook envelope into the few fields the reconciler needs.
 *
 * Razorpay nests entities as `payload.<entity>.entity`, and the useful identifiers sit at
 * different depths per event type. Doing that dig once, here, keeps the reconciler free of
 * provider shape — and keeps the `reference_id` lookup in one place, since that field is
 * how a webhook finds its way back to the case that created it.
 */
export function normaliseWebhook(envelope) {
  const event = envelope?.event ?? null;
  const payload = envelope?.payload ?? {};
  const payment = payload.payment?.entity ?? null;
  const link = payload.payment_link?.entity ?? null;
  const order = payload.order?.entity ?? null;

  return {
    event,
    handled: HANDLED_EVENTS.has(event),
    createdAt: envelope?.created_at ?? null,
    paymentId: payment?.id ?? null,
    paymentLinkId: link?.id ?? null,
    orderId: order?.id ?? payment?.order_id ?? null,
    // Our idempotency key travels out as `reference_id` and comes back here. This is the
    // join column between Razorpay's world and ours.
    referenceId: link?.reference_id ?? order?.receipt ?? payment?.notes?.rebound_ref ?? null,
    amountPaise: link?.amount ?? payment?.amount ?? order?.amount ?? null,
    amountPaidPaise: link?.amount_paid ?? (payment?.status === 'captured' ? payment.amount : null),
    status: link?.status ?? payment?.status ?? order?.status ?? null,
    errorCode: payment?.error_code ?? null,
    errorDescription: payment?.error_description ?? null,
    method: payment?.method ?? null,
  };
}
