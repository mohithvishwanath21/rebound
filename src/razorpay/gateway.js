/**
 * THE GATEWAY SEAM
 * ================
 *
 * One interface, two implementations, and the agent cannot tell which one it is holding.
 *
 *   SIM       — `src/sim/simGateway.js`. Resolves outcomes against latent truth. This is
 *               the world, so it lives in `src/sim/` where reading ground truth is legal.
 *   LIVE_TEST — `src/razorpay/liveGateway.js`. Talks to api.razorpay.com in test mode.
 *
 * Note what this file does NOT contain: a factory that picks between them. If it did, this
 * module would have to import `src/sim/**`, and `test/boundary.test.js` forbids any import
 * of the simulator from `src/razorpay/**`, `src/agent/**` or `src/api/**`. So the gateway
 * is injected — the eval harness constructs the SIM one, the API constructs the LIVE one,
 * and the orchestrator receives whichever it is given. The property "the agent has no code
 * path to ground truth" is then enforced by a test rather than by my memory at 2am.
 *
 * That inversion is not decoration. It's the reason a number produced under SIM means
 * anything: the decision code that generated it is byte-for-byte the code that would run
 * against Razorpay.
 *
 * ---------------------------------------------------------------------------------------
 * IDEMPOTENCY: ONE KEY, ENFORCED ON BOTH SIDES OF THE TRUST BOUNDARY
 * ---------------------------------------------------------------------------------------
 *
 * `buildReference()` derives a deterministic key from (runId, eventId, actionKind, channel,
 * decisionSeq). That single string is used twice:
 *
 *   locally  — as the store's `idempotencyKey`. `putAction` returns false on a replay, so
 *              a crash-and-restart mid-batch cannot re-send a message or re-attempt a
 *              charge.
 *   remotely — as Razorpay's `reference_id`, which Razorpay itself requires to be unique.
 *              A duplicate create is rejected by *them*, and `RazorpayDuplicateError` is
 *              converted back into a successful replay receipt.
 *
 * The two checks are independent, which is the point. If our database is wiped, Razorpay
 * still refuses the duplicate. If Razorpay's uniqueness check ever changes, our store
 * still refuses it. Duplicate-charging a customer requires both to fail at once.
 *
 * ---------------------------------------------------------------------------------------
 * WHAT IS REAL IN LIVE_TEST, AND WHAT ISN'T
 * ---------------------------------------------------------------------------------------
 *
 * Stated here rather than buried, because overclaiming this is the easiest way to lose
 * credibility with anyone who knows the Razorpay API:
 *
 *   SEND_LINK / SWITCH_RAIL_NUDGE / REQUEST_REAUTH — fully real. A genuine payment link is
 *   created, Razorpay dispatches the email/SMS itself, a human can pay it with a test card,
 *   and the resulting webhook is what credits the recovery. End to end, no simulation.
 *
 *   RETRY_NOW / RETRY_SCHEDULED — partly real. A real Order is created, which is what a
 *   merchant's retry does first. The capture against a saved instrument is NOT attempted,
 *   because charging a card-on-file needs a tokenised mandate that test mode won't mint.
 *   Every such receipt carries an explicit `caveats` entry saying so, the dashboard shows
 *   it, and `npm run live-check` prints it. Receipts never claim more than happened.
 *
 * Channels: Razorpay's payment-link API notifies over EMAIL and SMS. WHATSAPP and VOICE are
 * in this project's action space because they matter to the policy's cost model, but
 * LIVE_TEST cannot dispatch them — the link is created and the receipt records
 * `notified: false` with a caveat, rather than quietly pretending a message went out.
 */

import { createHash } from 'node:crypto';
import { ActionKind, CUSTOMER_CONTACTING, MONEY_MOVING } from '../core/actions.js';
import { assertPaise } from '../core/money.js';

export const GatewayMode = { SIM: 'SIM', LIVE_TEST: 'LIVE_TEST' };

/**
 * What a receipt can say. Deliberately includes UNKNOWN.
 *
 * Most gateway wrappers offer success and failure and force the caller to invent a third
 * case badly. A timed-out charge is neither, and the honest thing is to have a word for
 * it so that the reconciler can be required to resolve it by asking the provider.
 */
export const ReceiptState = {
  ATTEMPTED: 'ATTEMPTED', // the request was accepted; the outcome is not yet decided
  SENT: 'SENT', // a link/message went out
  CAPTURED: 'CAPTURED', // money actually arrived
  FAILED: 'FAILED', // the provider said no, and we know why
  UNKNOWN: 'UNKNOWN', // we do not know whether the side effect happened
};

/** Razorpay caps `reference_id` at 40 characters, so every key we mint must fit. */
export const MAX_REFERENCE_LENGTH = 40;

/** Two-letter codes keep the reference readable in the Razorpay dashboard. */
const ACTION_CODE = {
  [ActionKind.RETRY_NOW]: 'RN',
  [ActionKind.RETRY_SCHEDULED]: 'RS',
  [ActionKind.SEND_LINK]: 'SL',
  [ActionKind.SWITCH_RAIL_NUDGE]: 'SR',
  [ActionKind.REQUEST_REAUTH]: 'RA',
};

/** Last n url-safe characters of an id — enough to eyeball, never enough to collide alone. */
function tail(id, n) {
  return String(id ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(-n)
    .padStart(n, '0');
}

/**
 * The idempotency key, and Razorpay's `reference_id`.
 *
 * Shape: `rbd_SL1_a1b2c3d4_9f8e7d6c5b`
 *          |   |   |         |
 *          |   |   |         `- 10 hex of sha256 over the full tuple (collision safety)
 *          |   |   `----------- 8 chars of eventId (so a dashboard row is identifiable)
 *          |   `--------------- action code + decision sequence
 *          `------------------- fixed prefix, so our links are greppable in Razorpay
 *
 * The hash carries the uniqueness; the readable parts carry the debuggability. Truncating
 * ids alone would risk collisions between two events whose ids share a suffix, and a
 * reference collision means a *silently skipped action* — the worst failure mode available
 * here, because the audit trail would record it as already done.
 */
export function buildReference({ runId, eventId, actionKind, channel = null, decisionSeq = 1 }) {
  if (!runId || !eventId) throw new Error('buildReference needs runId and eventId');
  const code = ACTION_CODE[actionKind];
  if (!code) throw new Error(`buildReference: no reference code for action ${actionKind}`);

  const tuple = `${runId}|${eventId}|${actionKind}|${channel ?? ''}|${decisionSeq}`;
  const h = createHash('sha256').update(tuple).digest('hex').slice(0, 10);
  const ref = `rbd_${code}${decisionSeq}_${tail(eventId, 8)}_${h}`;

  if (ref.length > MAX_REFERENCE_LENGTH) {
    throw new Error(`buildReference produced ${ref.length} chars, over Razorpay's ${MAX_REFERENCE_LENGTH} limit: ${ref}`);
  }
  return ref;
}

/**
 * Build a receipt, validating as we go.
 *
 * Both implementations go through here, which is what makes the SIM and LIVE receipts
 * structurally identical. If they weren't, the orchestrator would grow a branch on mode —
 * and a branch on mode is exactly the thing that lets simulated results and real results
 * diverge without anyone noticing.
 */
export function makeReceipt({
  mode,
  actionKind,
  reference,
  state,
  amountPaise,
  amountCollectedPaise = 0,
  providerRef = null,
  shortUrl = null,
  notified = null,
  replayed = false,
  errorCode = null,
  errorDescription = null,
  caveats = [],
  at,
  raw = null,
}) {
  if (!Object.values(GatewayMode).includes(mode)) throw new Error(`bad gateway mode: ${mode}`);
  if (!Object.values(ReceiptState).includes(state)) throw new Error(`bad receipt state: ${state}`);
  if (!reference) throw new Error('receipt needs a reference (the idempotency key)');
  assertPaise(amountPaise, 'receipt amountPaise');
  assertPaise(amountCollectedPaise, 'receipt amountCollectedPaise');
  if (!at) throw new Error('receipt needs a timestamp');

  return Object.freeze({
    mode,
    actionKind,
    reference,
    /** What we ASKED for. */
    amountPaise,
    /**
     * What actually ARRIVED. Two separate numbers on purpose.
     *
     * I originally had one `amountPaise` and credited the full attempted amount whenever a
     * receipt came back CAPTURED. That is wrong in a specific, self-serving direction: a
     * disputing customer who settles often pays *less* than the invoice, and the simulator
     * models that haircut. Reading recovery off the requested amount would have quietly
     * booked the full figure every time a partial settlement landed, inflating the single
     * number this whole project is judged on — and it would have done so invisibly,
     * because every individual receipt would still have looked correct.
     *
     * So the scorer is only ever allowed to sum this field, and `assertReceiptShape`
     * enforces that a non-captured receipt collected exactly zero.
     */
    amountCollectedPaise,
    state,
    providerRef,
    shortUrl,
    notified,
    replayed,
    errorCode,
    errorDescription,
    caveats: Object.freeze([...caveats]),
    at: new Date(at).toISOString(),
    // Only LIVE_TEST populates this, and only with the provider's own response. It exists
    // so a reviewer can check a claimed recovery against Razorpay's own record of it.
    raw,
  });
}

/**
 * Validate that an object is a usable receipt. Used by the shared contract test, so a
 * new gateway implementation cannot pass by returning something receipt-shaped.
 */
export function assertReceiptShape(r, label = 'receipt') {
  const required = [
    'mode',
    'actionKind',
    'reference',
    'state',
    'amountPaise',
    'amountCollectedPaise',
    'caveats',
    'at',
    'replayed',
  ];
  for (const k of required) {
    if (!(k in r)) throw new Error(`${label} is missing '${k}'`);
  }
  if (!Object.values(ReceiptState).includes(r.state)) throw new Error(`${label} has bad state ${r.state}`);
  if (!Array.isArray(r.caveats)) throw new Error(`${label}.caveats must be an array`);
  if (!Number.isInteger(r.amountPaise)) throw new Error(`${label}.amountPaise must be integer paise, got ${r.amountPaise}`);
  if (!Number.isInteger(r.amountCollectedPaise)) throw new Error(`${label}.amountCollectedPaise must be integer paise`);
  if (Number.isNaN(Date.parse(r.at))) throw new Error(`${label}.at must be an ISO timestamp`);
  if (r.state === ReceiptState.FAILED && !r.errorCode) throw new Error(`${label} is FAILED but carries no errorCode`);

  // The two invariants that protect the headline number.
  if (r.state !== ReceiptState.CAPTURED && r.amountCollectedPaise !== 0) {
    throw new Error(`${label} is ${r.state} but claims to have collected ${r.amountCollectedPaise} paise`);
  }
  if (r.amountCollectedPaise > r.amountPaise) {
    throw new Error(`${label} collected ${r.amountCollectedPaise} against a request of ${r.amountPaise}`);
  }
  return true;
}

/**
 * The request every gateway call takes. Validated in one place so that SIM cannot be
 * accidentally more permissive than LIVE — a policy that works in simulation only because
 * the simulator accepted a malformed request is a policy that fails in production.
 */
export function validateActionRequest(req) {
  const { runId, eventId, action, amountPaise, customer } = req ?? {};
  if (!runId) throw new Error('gateway request needs runId');
  if (!eventId) throw new Error('gateway request needs eventId');
  if (!action?.kind) throw new Error('gateway request needs action.kind');
  assertPaise(amountPaise, 'gateway request amountPaise');
  if (amountPaise < 100) {
    // Razorpay's own floor is ₹1. Catching it here means SIM rejects it too, so the
    // policy can never learn to chase amounts it could not actually collect.
    throw new Error(`gateway request amountPaise must be at least 100 (₹1), got ${amountPaise}`);
  }
  if (CUSTOMER_CONTACTING.has(action.kind)) {
    if (!action.channel) throw new Error(`${action.kind} needs action.channel`);
    if (!customer) throw new Error(`${action.kind} needs customer contact details`);
  }
  if (MONEY_MOVING.has(action.kind) && req.decisionSeq == null) {
    throw new Error(`${action.kind} needs decisionSeq so its idempotency key is derivable`);
  }
  return true;
}

/** Channels Razorpay's payment-link API can actually notify over. */
export const RAZORPAY_NOTIFIABLE = new Set(['EMAIL', 'SMS']);

export const UNSUPPORTED_CHANNEL_CAVEAT =
  'Razorpay payment links notify over email and SMS only. The link is real and payable, ' +
  'but this channel was not dispatched by Razorpay.';

export const RETRY_NOT_CAPTURED_CAVEAT =
  'A real Razorpay order was created. The capture against the saved instrument was not ' +
  'attempted: charging a card-on-file requires a tokenised mandate that test mode does ' +
  'not mint. This receipt does not claim a completed retry.';
