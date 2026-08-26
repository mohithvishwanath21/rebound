/**
 * LIVE_TEST GATEWAY — the real Razorpay API, test mode only.
 *
 * Implements the interface documented in `gateway.js`. Everything here is a genuine call
 * to api.razorpay.com. What it can and cannot really do is written out in that file's
 * header rather than glossed over, and every partial capability appears on the receipt as
 * a `caveats` entry so a reviewer never has to take my word for which legs were real.
 *
 * Three integration details in here that I did not expect going in, and that I'd want to
 * be asked about:
 *
 *   1. `reminder_enable: false` — Razorpay will happily send its own reminder sequence on
 *      a payment link. That would be extra messages to a customer, dispatched outside my
 *      contact ledger, silently breaking the per-customer messaging cap that this project
 *      claims to enforce. A guardrail the payment provider can route around is not a
 *      guardrail. So Razorpay's reminders are off and Rebound owns the cadence.
 *
 *   2. Razorpay's rejection of a duplicate `reference_id` is load-bearing, not an
 *      annoyance. It is the remote half of the idempotency guarantee, so
 *      `RazorpayDuplicateError` is converted into a *successful replay* by fetching the
 *      link that already exists. Note that this holds for payment links only — an Order's
 *      `receipt` field is NOT enforced unique by Razorpay, so the retry safety on order
 *      creation rests on "an order moves no money" instead. Two different arguments for
 *      two different endpoints; assuming the first one covered both was a real mistake I
 *      made here, and it is written up in errors.js and the engineering log.
 *
 *   3. An unknown outcome on a create is reconciled by asking, never by assuming. If the
 *      network died mid-request we look the reference up; only if Razorpay has no record
 *      of it do we return `UNKNOWN`, and even then we never return FAILED, because
 *      "FAILED" would invite a retry that could double up.
 *
 *   4. `upi_link: true` CANNOT BE USED AT ALL, and this is the correction that hurt most.
 *      A UPI-only payment link is genuinely fewer taps than a card checkout, which is the
 *      whole mechanism SWITCH_RAIL_NUDGE bets on, so this gateway set the flag whenever the
 *      action was a rail nudge. Razorpay's reply, first seen on 2026-08-26:
 *
 *          400 BAD_REQUEST_ERROR
 *          "UPI Payment Links is not supported in Test Mode. Please experience the product
 *           in Live Mode."
 *
 *      It is a live-mode-only product. Since `createRazorpayClient` refuses any key that
 *      begins `rzp_live_`, this gateway is test mode by construction, which means the flag
 *      could NEVER have worked here — every SWITCH_RAIL_NUDGE through the live gateway was a
 *      guaranteed 400, and nothing caught it because `test/fakeRazorpay.js` accepted the flag
 *      happily. A fake encodes my beliefs, so it cannot falsify them; only the live run did.
 *      The fake now returns this exact error, so re-adding the flag fails in the suite.
 *
 *      What is lost is smaller than it looks. A standard link carries no method restriction at
 *      all, so it offers whatever this account has enabled, and the nudge's actual claim — "come
 *      and pay on a rail that is not the card that just failed" — is intact; what is gone is the
 *      tap saved by pre-selecting UPI. The receipt carries `UPI_LINK_TEST_MODE_CAVEAT` so a
 *      reviewer can see that the restriction was intended and why it is absent, rather than
 *      finding a silently unrestricted link. Note what this does NOT claim: nothing on the link
 *      entity reports which methods the account has enabled, so neither the caveat nor the CLI
 *      lists them.
 */

import { createRazorpayClient } from './httpClient.js';
import {
  GatewayMode,
  ReceiptState,
  buildReference,
  makeReceipt,
  validateActionRequest,
  RAZORPAY_NOTIFIABLE,
  UNSUPPORTED_CHANNEL_CAVEAT,
  RETRY_NOT_CAPTURED_CAVEAT,
} from './gateway.js';
import { ActionKind } from '../core/actions.js';
import { RazorpayDuplicateError, RazorpayUnknownOutcomeError, RazorpayNotFoundError } from './errors.js';

/** Razorpay requires a payment link to live at least 15 minutes. */
const MIN_EXPIRY_MS = 15 * 60 * 1000;
const DEFAULT_EXPIRY_MS = 72 * 60 * 60 * 1000;

/**
 * Recorded on every rail-nudge receipt. See note 4 in the file header: the UPI restriction is
 * intended, is impossible in test mode, and its absence must be visible on the receipt rather
 * than inferred from a link that quietly accepts cards too.
 */
export const UPI_LINK_TEST_MODE_CAVEAT =
  'UPI-only restriction (upi_link) requested but NOT applied: Razorpay supports UPI Payment Links ' +
  'in live mode only, confirmed by a 400 on 2026-08-26. The link carries no method restriction, so it ' +
  'offers whatever this account has enabled — the rail switch is still available to the payer, only ' +
  'the pre-selection is lost.';

/** Payment link status -> our receipt state. */
const LINK_STATE = {
  created: ReceiptState.SENT,
  partially_paid: ReceiptState.SENT,
  paid: ReceiptState.CAPTURED,
  expired: ReceiptState.FAILED,
  cancelled: ReceiptState.FAILED,
};

const PAYMENT_STATE = {
  created: ReceiptState.ATTEMPTED,
  authorized: ReceiptState.ATTEMPTED,
  captured: ReceiptState.CAPTURED,
  refunded: ReceiptState.CAPTURED,
  failed: ReceiptState.FAILED,
};

export function createLiveGateway({
  keyId = process.env.RAZORPAY_KEY_ID,
  keySecret = process.env.RAZORPAY_KEY_SECRET,
  callbackUrl = process.env.REBOUND_CALLBACK_URL ?? null,
  client,
  now = () => new Date(),
  onLog = null,
  ...clientOpts
} = {}) {
  const http = client ?? createRazorpayClient({ keyId, keySecret, onLog, ...clientOpts });

  // ------------------------------------------------------------------ helpers

  const notesFor = (req, reference) => ({
    rebound_ref: reference,
    rebound_run: String(req.runId),
    rebound_event: String(req.eventId),
    rebound_action: req.action.kind,
    rebound_mode: 'TEST',
  });

  function expiryUnix(req, at) {
    const requested = req.expiresAt ? new Date(req.expiresAt).getTime() : at.getTime() + DEFAULT_EXPIRY_MS;
    const floor = at.getTime() + MIN_EXPIRY_MS;
    return Math.floor(Math.max(requested, floor) / 1000);
  }

  function receiptFromLink(link, { req, reference, at, replayed = false, extraCaveats = [] }) {
    const notifiable = RAZORPAY_NOTIFIABLE.has(req.action.channel);
    const state = LINK_STATE[link.status] ?? ReceiptState.ATTEMPTED;
    return makeReceipt({
      mode: GatewayMode.LIVE_TEST,
      actionKind: req.action.kind,
      reference,
      state,
      amountPaise: link.amount ?? req.amountPaise,
      // Razorpay's own `amount_paid`, and only when the link is fully paid. A
      // `partially_paid` link has collected something real, but this project sends links
      // with `accept_partial: false`, so a partial here means something unexpected
      // happened and the safe reading is zero until a human looks at it.
      amountCollectedPaise: state === ReceiptState.CAPTURED ? (link.amount_paid ?? link.amount ?? 0) : 0,
      providerRef: link.id ?? null,
      shortUrl: link.short_url ?? null,
      notified: notifiable,
      replayed,
      errorCode: state === ReceiptState.FAILED ? `LINK_${String(link.status).toUpperCase()}` : null,
      errorDescription: state === ReceiptState.FAILED ? `Payment link ${link.status}` : null,
      caveats: [...(notifiable ? [] : [UNSUPPORTED_CHANNEL_CAVEAT]), ...extraCaveats],
      at,
      raw: link,
    });
  }

  /**
   * The reconciliation path: ask Razorpay whether our reference already exists.
   *
   * Two things here are defensive as a direct result of the 2026-08-22 live run, where this
   * returned null for a reference that demonstrably existed — Razorpay had just refused to
   * duplicate it.
   *
   * 1. THE ENVELOPE KEY. Most Razorpay collections come back as `{count, entity, items}`, and
   *    I assumed payment links did too. The list endpoint returned 200 with no `items`, so an
   *    existing link read as absent. Their fetch-all-payment-links response uses
   *    `payment_links` as the array key instead, so both are accepted. Reading `body.items`
   *    and finding nothing is indistinguishable from "no such link" — a silent wrong answer
   *    rather than an error, which is why it survived a passing offline suite.
   *
   * 2. NO TRUSTING THE SERVER-SIDE FILTER. The original returned `items[0]` on the assumption
   *    that `?reference_id=` had filtered. If that parameter is ignored rather than honoured,
   *    an unfiltered list comes back and `items[0]` is SOMEONE ELSE'S PAYMENT LINK — which
   *    this function would then hand back as the replay of our decision, attaching a stranger's
   *    amount and status to our audit trail. That is far worse than returning null. So the
   *    match is re-verified locally on the exact reference, and the server filter is treated as
   *    an optimisation, never as a guarantee.
   */
  async function findByReference(reference) {
    try {
      const { body } = await http.get('/payment_links', { query: { reference_id: reference } });

      const collection = Array.isArray(body?.payment_links)
        ? body.payment_links
        : Array.isArray(body?.items)
          ? body.items
          : [];

      // Verify locally rather than trusting that the query filtered.
      const match = collection.find((l) => l?.reference_id === reference) ?? null;

      if (!match) {
        // A diagnostic, not a log for its own sake: if this ever fires again the next question
        // is always "what shape did the body actually have", and keys are safe to print where
        // the objects themselves are not — a payment link carries customer contact details.
        onLog?.({
          event: 'reference_lookup_empty',
          reference,
          bodyKeys: body && typeof body === 'object' ? Object.keys(body) : typeof body,
          collectionLength: collection.length,
          note: 'refused as duplicate but not findable — see findByReference',
        });
      }
      return match;
    } catch (e) {
      if (e instanceof RazorpayNotFoundError) return null;
      throw e;
    }
  }

  /**
   * Create a payment link, treating "already exists" and "we don't know" as the two
   * interesting cases rather than as errors.
   */
  async function createLink(req, reference, body, at, extraCaveats) {
    try {
      const { body: link } = await http.post('/payment_links', { body, safeToRetry: true });
      return receiptFromLink(link, { req, reference, at, extraCaveats });
    } catch (e) {
      if (e instanceof RazorpayDuplicateError) {
        // Razorpay refused a second link for this reference. That is the guarantee working,
        // so resolve it into the receipt for the link that already exists.
        const existing = await findByReference(reference);
        if (existing) return receiptFromLink(existing, { req, reference, at, replayed: true, extraCaveats });
        // Refused as duplicate but not findable. Do not guess, and above all do not retry.
        return unknownReceipt(req, reference, at, 'DUPLICATE_NOT_FOUND', e.description, extraCaveats);
      }

      if (e instanceof RazorpayUnknownOutcomeError) {
        const existing = await findByReference(reference).catch(() => null);
        if (existing) return receiptFromLink(existing, { req, reference, at, replayed: true, extraCaveats });
        return unknownReceipt(req, reference, at, e.code, e.message, extraCaveats);
      }

      throw e;
    }
  }

  function unknownReceipt(req, reference, at, code, description, extraCaveats = []) {
    return makeReceipt({
      mode: GatewayMode.LIVE_TEST,
      actionKind: req.action.kind,
      reference,
      state: ReceiptState.UNKNOWN,
      amountPaise: req.amountPaise,
      errorCode: code,
      errorDescription: description,
      caveats: [
        ...extraCaveats,
        'Outcome unknown: Razorpay may or may not have acted on this request. The ' +
          'reconciler must resolve it by fetching the reference before any further action ' +
          'is taken on this case.',
      ],
      at,
      raw: null,
    });
  }

  // ---------------------------------------------------------------- the interface

  return {
    mode: GatewayMode.LIVE_TEST,
    keyIdPrefix: http.keyIdPrefix,

    /**
     * A real Order, and an honest receipt about the leg that is missing.
     * See RETRY_NOT_CAPTURED_CAVEAT for why the capture is not attempted.
     */
    async retryCharge(req) {
      validateActionRequest(req);
      const at = now();
      const reference = buildReference({
        runId: req.runId,
        eventId: req.eventId,
        actionKind: req.action.kind,
        decisionSeq: req.decisionSeq,
      });

      try {
        const { body: order } = await http.post('/orders', {
          body: {
            amount: req.amountPaise,
            currency: 'INR',
            receipt: reference,
            notes: notesFor(req, reference),
          },
          safeToRetry: true, // an order moves no money, so a duplicate is harmless — see errors.js
        });

        return makeReceipt({
          mode: GatewayMode.LIVE_TEST,
          actionKind: req.action.kind,
          reference,
          state: ReceiptState.ATTEMPTED,
          amountPaise: order.amount ?? req.amountPaise,
          providerRef: order.id ?? null,
          notified: false,
          caveats: [RETRY_NOT_CAPTURED_CAVEAT],
          at,
          raw: order,
        });
      } catch (e) {
        if (e instanceof RazorpayUnknownOutcomeError) {
          return unknownReceipt(req, reference, at, e.code, e.message, [RETRY_NOT_CAPTURED_CAVEAT]);
        }
        return makeReceipt({
          mode: GatewayMode.LIVE_TEST,
          actionKind: req.action.kind,
          reference,
          state: ReceiptState.FAILED,
          amountPaise: req.amountPaise,
          errorCode: e.code ?? 'ORDER_CREATE_FAILED',
          errorDescription: e.description ?? e.message,
          caveats: [RETRY_NOT_CAPTURED_CAVEAT],
          at,
          raw: null,
        });
      }
    },

    async sendPaymentLink(req) {
      validateActionRequest(req);
      const at = now();
      const reference = buildReference({
        runId: req.runId,
        eventId: req.eventId,
        actionKind: req.action.kind,
        channel: req.action.channel,
        decisionSeq: req.decisionSeq ?? 1,
      });

      const notifiable = RAZORPAY_NOTIFIABLE.has(req.action.channel);
      const wantsUpi = req.preferredRail === 'UPI' || req.action.kind === ActionKind.SWITCH_RAIL_NUDGE;

      const body = {
        amount: req.amountPaise,
        currency: 'INR',
        accept_partial: false,
        expire_by: expiryUnix(req, at),
        reference_id: reference,
        description: req.description ?? 'Payment for your outstanding amount',
        customer: {
          name: req.customer?.name ?? undefined,
          contact: req.customer?.contact ?? undefined,
          email: req.customer?.email ?? undefined,
        },
        notify: {
          sms: req.action.channel === 'SMS',
          email: req.action.channel === 'EMAIL',
        },
        // See note 1 in the file header. Razorpay's own reminders would message the
        // customer outside our contact ledger and quietly break the messaging cap.
        reminder_enable: false,
        notes: notesFor(req, reference),
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
        /**
         * `upi_link: true` IS DELIBERATELY ABSENT, AND USED TO BE HERE. See note 4 in the
         * file header — Razorpay refuses it outright in test mode, so this gateway can never
         * send it.
         */
      };

      const extra = wantsUpi ? [UPI_LINK_TEST_MODE_CAVEAT] : [];
      const receipt = await createLink(req, reference, body, at, extra);

      if (!notifiable) {
        onLog?.({
          event: 'channel_not_dispatched',
          channel: req.action.channel,
          reference,
          note: 'link created and payable, notification not sent by Razorpay',
        });
      }
      return receipt;
    },

    /**
     * Re-authorisation. In test mode the honest primitive is still a payment link — paying
     * it with a fresh instrument is exactly the customer action we are asking for, and it
     * is the only action that can recover an expired card or a revoked mandate.
     */
    async requestReauth(req) {
      validateActionRequest(req);
      return this.sendPaymentLink({
        ...req,
        description: req.description ?? 'Please complete payment with an updated payment method',
      });
    },

    /**
     * Read the current truth from Razorpay. Dispatches on the id prefix, which is how
     * Razorpay's own ids are namespaced (`plink_`, `order_`, `pay_`).
     */
    async fetchStatus({ providerRef }) {
      if (!providerRef) throw new Error('fetchStatus needs a providerRef');

      if (providerRef.startsWith('plink_')) {
        const { body } = await http.get(`/payment_links/${providerRef}`);
        return {
          kind: 'PAYMENT_LINK',
          providerRef,
          state: LINK_STATE[body.status] ?? ReceiptState.ATTEMPTED,
          providerStatus: body.status,
          amountPaise: body.amount ?? null,
          amountPaidPaise: body.amount_paid ?? 0,
          referenceId: body.reference_id ?? null,
          /**
           * Razorpay puts an attempt history on the link as `payments`, which is `null` rather
           * than `[]` when there are none. Normalised to an array so callers can iterate
           * without a nullish dance.
           *
           * Explicitly NOT claimed: that a *failed* attempt shows up here. I have not observed
           * one, and the docs describe this as the payments made against the link, which may
           * well mean successful ones only. Anything that needs to distinguish "nobody opened
           * the page" from "somebody tried and was declined" must treat an empty array as
           * inconclusive rather than as proof of the former.
           */
          attempts: Array.isArray(body.payments) ? body.payments : [],
          raw: body,
        };
      }

      if (providerRef.startsWith('order_')) {
        const { body } = await http.get(`/orders/${providerRef}`);
        return {
          kind: 'ORDER',
          providerRef,
          state: body.status === 'paid' ? ReceiptState.CAPTURED : ReceiptState.ATTEMPTED,
          providerStatus: body.status,
          amountPaise: body.amount ?? null,
          amountPaidPaise: body.amount_paid ?? 0,
          referenceId: body.receipt ?? null,
          raw: body,
        };
      }

      if (providerRef.startsWith('pay_')) {
        const { body } = await http.get(`/payments/${providerRef}`);
        return {
          kind: 'PAYMENT',
          providerRef,
          state: PAYMENT_STATE[body.status] ?? ReceiptState.ATTEMPTED,
          providerStatus: body.status,
          amountPaise: body.amount ?? null,
          amountPaidPaise: body.status === 'captured' ? (body.amount ?? 0) : 0,
          referenceId: body.notes?.rebound_ref ?? null,
          errorCode: body.error_code ?? null,
          errorDescription: body.error_description ?? null,
          raw: body,
        };
      }

      throw new Error(`fetchStatus: unrecognised Razorpay id prefix in '${providerRef}'`);
    },

    async close() {
      /* fetch keeps no pool we own */
    },
  };
}
