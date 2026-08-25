/**
 * SYNTHETIC WORLD GENERATOR
 * =========================
 *
 * Produces customers, at-risk events, and the hidden latent truth behind them.
 *
 * THE DESIGN GOAL IS DIFFICULTY, NOT REALISM THEATRE.
 * --------------------------------------------------
 * It would be easy to generate a world where diagnosis is trivial: give every expired
 * card an error reason of `card_expired` and every cash-flow problem an
 * `insufficient_funds`. The rule table would then score ~100%, the policy would look
 * brilliant, and the result would be worthless — because we would have generated the
 * answer key into the input.
 *
 * So the generator introduces ambiguity on purpose, in three specific ways:
 *
 *   1. MANY-TO-MANY causes. `DO_NOT_HONOUR` — the generic bank decline — is emitted
 *      for several different underlying payer types. A payment that reports "declined"
 *      might be a dead card, a cash-flow problem, or a customer who is never paying.
 *      This is true of real payment data and it is the reason the ambiguous bucket
 *      gets bounded retries rather than confident action.
 *
 *   2. VAGUE ERROR TEXT. A configurable fraction of failures carry unhelpful issuer
 *      text that the rule table cannot match. These exercise the LLM tier and, when
 *      confidence is low, the UNKNOWN fallback. If every failure were cleanly coded,
 *      the LLM tier would be decoration.
 *
 *   3. IMPERFECT DOWNTIME SIGNALS. The observed downtime window differs from the true
 *      one, so a downtime-aware policy is rewarded but not handed a free win.
 *
 * The direction of generation matters too. We pick the LATENT PAYER TYPE FIRST, then
 * choose a plausible error consistent with it. Generating the error first and deriving
 * the payer type from it would build a deterministic error->truth mapping, which is
 * exactly the leak we are trying to avoid.
 */

import { makeRng, deriveSeed } from '../core/rng.js';
import { rupeesToPaise } from '../core/money.js';
import { LossType, Rail, Segment } from '../core/enums.js';
import { PayerType } from './payerTypes.js';
import { ASSUMPTIONS } from './responseModel.js';

/**
 * Bumped to 1.1.0 when self-recovery gained its survivorship conditioning, to 1.2.0 when each
 * event got its own RNG stream, and to 1.3.0 when the rail draw stopped discarding the customer's
 * preferred rail. `batchIdFor` folds this into every batch id precisely so that a change
 * to the world cannot be mistaken for a change in results: any number computed against a `g100` batch
 * is not comparable to one computed against `g110`, `g120`, `g130` or `g140`, and the id says so out loud.
 *
 * 1.2.0 changes every event in every batch, because it changes the order numbers are drawn in. It
 * buys the property the Day 8 sensitivity sweep is built on — perturbing one world parameter perturbs
 * one thing — and it invalidates every figure measured against g110. Anything quoted from a g110 run
 * has to be re-measured rather than carried forward.
 *
 * 1.3.0 (#65) does NOT change the number of draws — a case still consumes exactly the same count, so
 * amounts and timings stay where they were — but it changes the OUTCOME of the rail draw for most
 * cases, and rail feeds `railSuccess`, `channelReach` and therefore every recovery probability. So
 * g120 figures are void for the same reason: re-measure, do not carry forward. The bug it fixes is
 * written up under `chosenRail` below, and `probe-rail.mjs` holds the before-and-after measurement.
 *
 * 1.4.0 (#68) is the first bump that this file does not itself cause, and it is deliberate. The
 * change lives in `src/sim/responseModel.js`: a retry against an OVERDUE_INVOICE now returns a
 * structural zero, because there is no failed charge to re-present. Nothing about the events this
 * file emits is different. But the version exists to answer one question — "is this number
 * comparable to that number?" — and the answer for anything measured before #68 is no, because the
 * simulator used to pay out on an action that cannot occur. Folding a response-model change into
 * the same counter is the only way the batch id can keep telling the truth. If the two ever need to
 * move independently, split the counter; do not leave a world change unversioned.
 */
export const GENERATOR_VERSION = '1.4.0';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * P(trueRootCause | payerType, lossType).
 *
 * The overlap is the point. Note DO_NOT_HONOUR appearing under four different payer
 * types — that single row is why the ambiguous bucket must be handled with bounded
 * caution rather than confidence, and why an agent cannot simply memorise a code.
 */
// Exported so `npm run describe-sim` can print it. This table is the single most
// important disclosure in the project: it is the overlap between payer types that makes
// diagnosis a real inference problem rather than a lookup, so a reader has to be able to
// see it. Safe to export because the boundary test forbids `src/agent/**` from importing
// anything under `src/sim/**` at all.
export const CAUSE_GIVEN_PAYER = {
  [PayerType.WILL_PAY_IF_REMINDED]: {
    FAILED_PAYMENT: { AUTH_NOT_COMPLETED: 0.42, ISSUER_DOWNTIME: 0.24, DO_NOT_HONOUR: 0.19, LIMIT_EXCEEDED: 0.15 },
    FAILED_SUBSCRIPTION: { ISSUER_DOWNTIME: 0.34, DO_NOT_HONOUR: 0.33, LIMIT_EXCEEDED: 0.18, INSUFFICIENT_FUNDS: 0.15 },
    OVERDUE_INVOICE: { INVOICE_FORGOTTEN: 1.0 },
  },
  [PayerType.TEMPORARILY_SHORT]: {
    FAILED_PAYMENT: { INSUFFICIENT_FUNDS: 0.72, DO_NOT_HONOUR: 0.2, LIMIT_EXCEEDED: 0.08 },
    FAILED_SUBSCRIPTION: { INSUFFICIENT_FUNDS: 0.78, DO_NOT_HONOUR: 0.22 },
    OVERDUE_INVOICE: { INVOICE_FORGOTTEN: 1.0 },
  },
  [PayerType.NEEDS_NEW_INSTRUMENT]: {
    // The 0.14 on DO_NOT_HONOUR is the hard case: a dead card reported as a generic
    // decline. An agent that trusts the code will retry it three times for nothing.
    FAILED_PAYMENT: { EXPIRED_INSTRUMENT: 0.62, DO_NOT_HONOUR: 0.14, LIMIT_EXCEEDED: 0.08, MANDATE_REVOKED: 0.16 },
    FAILED_SUBSCRIPTION: { MANDATE_REVOKED: 0.48, EXPIRED_INSTRUMENT: 0.38, DO_NOT_HONOUR: 0.14 },
    OVERDUE_INVOICE: { INVOICE_FORGOTTEN: 1.0 },
  },
  [PayerType.DISPUTING]: {
    FAILED_PAYMENT: { RISK_BLOCKED: 0.3, DO_NOT_HONOUR: 0.4, AUTH_NOT_COMPLETED: 0.3 },
    FAILED_SUBSCRIPTION: { MANDATE_REVOKED: 0.55, DO_NOT_HONOUR: 0.45 },
    OVERDUE_INVOICE: { INVOICE_DISPUTED: 1.0 },
  },
  [PayerType.NEVER_PAYING]: {
    FAILED_PAYMENT: { RISK_BLOCKED: 0.26, DO_NOT_HONOUR: 0.34, EXPIRED_INSTRUMENT: 0.22, AUTH_NOT_COMPLETED: 0.18 },
    FAILED_SUBSCRIPTION: { MANDATE_REVOKED: 0.42, DO_NOT_HONOUR: 0.3, EXPIRED_INSTRUMENT: 0.28 },
    OVERDUE_INVOICE: { INVOICE_FORGOTTEN: 0.55, INVOICE_DISPUTED: 0.45 },
  },
};

/**
 * Weights for the rail a case is attempted on, given the rail its customer prefers.
 *
 * THIS IS A FUNCTION BECAUSE THE OBJECT LITERAL IT REPLACES WAS SILENTLY BROKEN, AND THAT IS WORTH
 * READING (#65). It used to be written inline as:
 *
 *   rng.weighted({
 *     [customer.preferredRail]: 0.7,
 *     [Rail.UPI]: 0.12, [Rail.CARD]: 0.12, [Rail.NETBANKING]: 0.06,
 *   })
 *
 * `Rail` has exactly three members, and all three are named LITERALLY after the computed key. In a
 * JavaScript object literal a later duplicate key overwrites an earlier one, so `[preferredRail]: 0.7`
 * was replaced by 0.12 or 0.06 on every single case, for every customer. The customer's preferred rail
 * had no effect whatsoever. `probe-rail.mjs` measured it across 8 worlds before the fix:
 * P(rail | preferredRail) was 40/40/20 for all three preferences, identical to three decimal places,
 * and a netbanking-preferring customer was attempted on netbanking 18.7% of the time — their LEAST
 * likely rail.
 *
 * It is a good example of a defect that reading the output could never catch. Nothing crashed, no
 * distribution looked odd in isolation, and every rail still appeared at a plausible-looking rate. The
 * only way to see it was to condition on the input that was supposed to matter.
 *
 * The weights are now built ADDITIVELY: a base spread of 0.12/0.12/0.06 across the three rails, with
 * the preference adding 0.7 on top. That reading is what the original numbers were reaching for —
 * 0.7 + 0.12 + 0.12 + 0.06 sums to exactly 1.0, which is not a coincidence — and it gives the
 * preferred rail 0.82 against 0.12 and 0.06. The alternative reading (preferred = 0.7 flat, others at
 * base) totals 0.88 and lands within a few points of the same place; the additive form is chosen
 * because it sums to one exactly and because it cannot degenerate no matter which rail is preferred.
 *
 * ONE DRAW, EXACTLY AS BEFORE. `rng.weighted` consumes a single number whatever the weights are, so
 * this fix does not shift the draw order inside a case — the property `generateEvents` is built on.
 */
export function railWeightsFor(preferredRail) {
  const weights = { [Rail.UPI]: 0.12, [Rail.CARD]: 0.12, [Rail.NETBANKING]: 0.06 };
  if (!(preferredRail in weights)) {
    throw new Error(
      `railWeightsFor: ${preferredRail} is not a known rail, so the preference would be dropped ` +
        'silently — which is the exact bug this function exists to prevent'
    );
  }
  weights[preferredRail] += 0.7;
  return weights;
}

/**
 * Return a copy of a cause table with one cause's weight multiplied and every row renormalised.
 *
 * The knob #58's cause-mix arm turns. Tilting toward `DO_NOT_HONOUR` is the interesting direction:
 * it is the generic bank decline that appears under four different payer types, so raising its share
 * makes the world MORE ambiguous without changing anything an agent can observe about how ambiguous it
 * is. A policy whose advantage comes from genuinely handling uncertainty should degrade gently; one
 * whose advantage came from the cause distribution happening to suit its rule table should fall over.
 *
 * Renormalising matters more than it looks. `rng.weighted` normalises internally, so an un-normalised
 * table still draws perfectly well — it just draws from a distribution that no longer matches the one
 * `npm run describe-sim` prints for a reader to check the experiment against. Silent divergence
 * between the disclosed world and the simulated one is the worst outcome available here.
 *
 * Refuses two no-ops rather than performing them:
 *   - a cause that appears in no row, because a sweep row labelled "cause mix shifted" that shifted
 *     nothing is the failure #59 was about, and a typo in a cause name is the obvious way to get one;
 *   - a factor of zero or less, because removing a cause entirely is a different experiment
 *     (it changes which causes EXIST, not their mix) and should be written as one.
 */
export function tiltCauseMix(table, { cause, factor }) {
  if (!(factor > 0)) {
    throw new Error(`tiltCauseMix: factor must be positive, got ${factor}`);
  }

  let touched = 0;
  const out = {};
  for (const [payerType, byLoss] of Object.entries(table)) {
    out[payerType] = {};
    for (const [lossType, dist] of Object.entries(byLoss)) {
      if (!(cause in dist)) {
        // Copied by reference-free clone but numerically untouched. An OVERDUE_INVOICE row that is
        // {INVOICE_FORGOTTEN: 1.0} must come out exactly {INVOICE_FORGOTTEN: 1.0}, not 0.9999999.
        out[payerType][lossType] = { ...dist };
        continue;
      }
      touched += 1;
      const scaled = { ...dist, [cause]: dist[cause] * factor };
      const total = Object.values(scaled).reduce((a, b) => a + b, 0);
      out[payerType][lossType] = Object.fromEntries(
        Object.entries(scaled).map(([k, v]) => [k, v / total])
      );
    }
  }

  if (touched === 0) {
    throw new Error(
      `tiltCauseMix: "${cause}" appears in no row of the table, so this tilt would change nothing ` +
        'while being labelled a shift'
    );
  }
  return out;
}

export const DEFAULT_PARAMS = {
  customers: 220,
  events: 600,

  lossTypeMix: {
    FAILED_PAYMENT: 0.5,
    FAILED_SUBSCRIPTION: 0.28,
    OVERDUE_INVOICE: 0.22,
  },

  payerTypeMix: {
    WILL_PAY_IF_REMINDED: 0.34,
    TEMPORARILY_SHORT: 0.24,
    NEEDS_NEW_INSTRUMENT: 0.18,
    DISPUTING: 0.08,
    NEVER_PAYING: 0.16,
  },

  /**
   * Fraction of failures whose error text the rule table cannot match.
   * Set to 0 and the LLM tier never fires; set it to 1 and diagnosis is impossible.
   * ~12% is roughly the long tail you actually see across issuers.
   */
  vagueErrorRate: 0.12,

  /** Fraction of customers on DND. Absolute block, so it must be non-trivial. */
  dndRate: 0.05,

  /** Window over which failures occurred, relative to "now". */
  historyDays: 21,

  /**
   * Unconditional propensity to pay without any intervention, by loss type.
   *
   * READ FROM `ASSUMPTIONS.selfRecoveryRate` RATHER THAN RESTATED HERE, and that is the whole point.
   * These three numbers used to be a hardcoded copy sitting a few hundred lines below, identical to
   * the assumption character for character. The assumption's own `basis` field says it is
   * "load-bearing for the B0 baseline: set it high and every policy looks less impressive" — and
   * `perturbAssumptions` duly perturbs it, so the sensitivity sweep would have swept the one
   * assumption most able to embarrass this project and moved nothing whatsoever. A knob wired to
   * nothing that still prints a sensitivity result is worse than a missing knob.
   *
   * `overrides` on `generateBatch` is how the sweep supplies a perturbed set, which is why this is a
   * param and not a module constant.
   */
  selfRecoveryRate: {
    FAILED_PAYMENT: ASSUMPTIONS.selfRecoveryRate.FAILED_PAYMENT.value,
    FAILED_SUBSCRIPTION: ASSUMPTIONS.selfRecoveryRate.FAILED_SUBSCRIPTION.value,
    OVERDUE_INVOICE: ASSUMPTIONS.selfRecoveryRate.OVERDUE_INVOICE.value,
  },

  /**
   * How long after the failure an unprompted payment can arrive, in days.
   *
   * A generator-level modelling choice rather than a response-model assumption: it describes when
   * self-recovery happens, while `selfRecoveryRate` describes how often. Note it is much shorter than
   * `historyDays` (12 vs 21), and that gap is load-bearing — it is what makes a sufficiently old
   * unpaid case *provably* not a self-recoverer. See the survivorship conditioning below.
   */
  selfRecoveryWindowDays: [0.5, 12],

  /** Share of events the merchant's gateway had already auto-retried once. */
  priorAttemptRate: 0.22,

  b2bShare: 0.25,

  /**
   * P(trueRootCause | payerType, lossType), as a PARAMETER rather than the module constant it used
   * to be (#66).
   *
   * The table itself is unchanged and still lives in `CAUSE_GIVEN_PAYER` above — this is a reference
   * to it, so the default world is bit-identical. What changes is reachability: `generateBatch`'s
   * `overrides` can now replace it, which is the only reason #58's cause-mix arm can exist at all.
   * Before this, the sweep could perturb the payer mix, the amounts and the self-recovery rate, but
   * not the composition of root causes — and the cause composition is precisely the shift that
   * attacks the diagnosis layer the whole project rests on. Exactly the failure #59 fixed for
   * `selfRecoveryRate`: a sweep that cannot move the thing most able to embarrass you reports
   * reassurance rather than sensitivity.
   *
   * REPLACED WHOLESALE, NOT DEEP-MERGED, and that is deliberate. `generateBatch` spreads overrides
   * one level deep, so supplying `causeGivenPayer` substitutes the entire table. A deep merge would
   * let a caller override two entries of a five-entry row and leave a distribution summing to 0.8
   * without anything complaining — `rng.weighted` normalises internally, so the draw would still
   * work and would silently disagree with the table `npm run describe-sim` prints. Build perturbed
   * tables with `tiltCauseMix`, which renormalises and refuses a no-op.
   */
  causeGivenPayer: CAUSE_GIVEN_PAYER,

  amounts: {
    B2C: { muLogRupees: 6.6, sigma: 0.85 },   // median ~₹735, long right tail
    B2B: { muLogRupees: 10.3, sigma: 0.95 },  // median ~₹30k, some large
  },
};

/**
 * Shifted parameters for the held-out TEST batch.
 *
 * Deliberately not just a different seed. A different seed alone measures variance;
 * shifting the parameters measures whether the policy generalises to a world whose
 * composition differs from the one its probability model was fitted on. A policy that
 * only works on its training distribution is not a policy, it is a lookup table.
 */
export const TEST_PARAM_SHIFT = {
  payerTypeMix: {
    WILL_PAY_IF_REMINDED: 0.29,
    TEMPORARILY_SHORT: 0.27,
    NEEDS_NEW_INSTRUMENT: 0.21,
    DISPUTING: 0.09,
    NEVER_PAYING: 0.14,
  },
  vagueErrorRate: 0.16,
  amounts: {
    B2C: { muLogRupees: 6.75, sigma: 0.9 },
    B2B: { muLogRupees: 10.15, sigma: 1.0 },
  },
};


/**
 * Realistic-looking Razorpay-shaped error payloads per true cause.
 *
 * `clear` variants are matchable by the rule table. `vague` variants are the issuer
 * free-text that real integrations actually receive and that no rule table can catch —
 * these route to the LLM tier and then to UNKNOWN.
 *
 * VERIFY BEFORE DEMO: these field values are written from prior knowledge of the
 * Razorpay API and must be checked against current docs and real test-mode failures.
 * Mismatches degrade gracefully (unmatched -> LLM -> UNKNOWN) rather than crashing,
 * which is the whole reason for the tiered design.
 */
const ERROR_TEMPLATES = {
  INSUFFICIENT_FUNDS: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'insufficient_funds', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Your payment could not be completed due to insufficient funds in the account.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'insufficient_balance', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Insufficient balance in the customer account.' },
    ],
    vague: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Transaction could not be processed at this time. Please contact your bank.' },
    ],
  },
  ISSUER_DOWNTIME: {
    clear: [
      { errorCode: 'GATEWAY_ERROR', errorReason: 'gateway_technical_error', errorSource: 'gateway', errorStep: 'payment_authorization', errorDescription: 'Payment processing failed due to a technical error at the gateway.' },
      { errorCode: 'GATEWAY_ERROR', errorReason: 'payment_timeout', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'The bank did not respond in time. Please try again later.' },
      { errorCode: 'SERVER_ERROR', errorReason: 'bank_technical_error', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Issuing bank is temporarily unavailable.' },
    ],
    vague: [
      { errorCode: 'GATEWAY_ERROR', errorReason: 'payment_failed', errorSource: 'gateway', errorStep: 'payment_authorization', errorDescription: 'Unable to process. Error 0x5A21 from upstream.' },
    ],
  },
  AUTH_NOT_COMPLETED: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_cancelled', errorSource: 'customer', errorStep: 'payment_authentication', errorDescription: 'Payment was cancelled by the user.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'otp_not_entered', errorSource: 'customer', errorStep: 'payment_authentication', errorDescription: 'OTP was not entered within the time limit.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'three_ds_authentication_failed', errorSource: 'customer', errorStep: 'payment_authentication', errorDescription: '3DS authentication was not completed.' },
    ],
    vague: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'customer', errorStep: 'payment_authentication', errorDescription: 'Session ended before completion.' },
    ],
  },
  EXPIRED_INSTRUMENT: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'card_expired', errorSource: 'customer', errorStep: 'payment_initiation', errorDescription: 'The card used for the payment has expired.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'card_blocked', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'The card is blocked by the issuing bank.' },
    ],
    vague: [
      // The single nastiest row in the generator: a dead card that merely says
      // "declined". Retrying is guaranteed to fail, and nothing in the payload says so.
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Payment declined by the issuer.' },
    ],
  },
  MANDATE_REVOKED: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'mandate_revoked', errorSource: 'customer', errorStep: 'payment_initiation', errorDescription: 'The e-mandate for this subscription has been revoked by the customer.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'subscription_mandate_not_active', errorSource: 'business', errorStep: 'payment_initiation', errorDescription: 'Standing instruction is no longer active.' },
    ],
    vague: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'bank', errorStep: 'payment_initiation', errorDescription: 'Debit could not be processed for this registration.' },
    ],
  },
  RISK_BLOCKED: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'risk_threshold_breached', errorSource: 'business', errorStep: 'payment_initiation', errorDescription: 'Payment blocked as it breached the configured risk threshold.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_risk_check_failed', errorSource: 'internal', errorStep: 'payment_initiation', errorDescription: 'Payment failed the security check.' },
    ],
    // No vague variant on purpose. Risk decisions must be unambiguous, and if a real
    // integration ever produced an ambiguous one, treating it as UNKNOWN (no automated
    // action) is the correct and conservative outcome anyway.
    vague: [],
  },
  LIMIT_EXCEEDED: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_limit_exceeded', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'The transaction amount exceeds the limit set on the card.' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'card_limit_exceeded', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Daily transaction limit exceeded.' },
    ],
    vague: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Transaction not permitted for this amount.' },
    ],
  },
  DO_NOT_HONOUR: {
    clear: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'do_not_honour', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'The bank declined the transaction (do not honour).' },
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'transaction_not_permitted', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Transaction not permitted by the issuing bank.' },
    ],
    vague: [
      { errorCode: 'BAD_REQUEST_ERROR', errorReason: 'payment_failed', errorSource: 'bank', errorStep: 'payment_authorization', errorDescription: 'Refer to card issuer.' },
    ],
  },
};

const FIRST_NAMES = ['Aarav', 'Vivaan', 'Diya', 'Ananya', 'Ishaan', 'Kavya', 'Rohan', 'Meera', 'Arjun', 'Saanvi', 'Kabir', 'Nithya', 'Rahul', 'Priya', 'Aditya', 'Sneha', 'Karthik', 'Divya', 'Manish', 'Pooja'];
const LAST_NAMES = ['Sharma', 'Verma', 'Iyer', 'Reddy', 'Nair', 'Patel', 'Gupta', 'Menon', 'Bose', 'Khanna', 'Rao', 'Joshi', 'Desai', 'Malhotra', 'Pillai'];
const COMPANIES = ['Northwind Traders', 'Sunrise Logistics', 'Bluepeak Retail', 'Kavery Foods', 'Meridian Textiles', 'Orbit Supplies', 'Anand Motors', 'Silverline Pharma', 'Trident Packaging', 'Vertex Components'];
const BANKS = ['HDFC', 'ICICI', 'SBIN', 'AXIS', 'KOTAK', 'PNB', 'YESB', 'IDFC'];
const NETWORKS = ['Visa', 'Mastercard', 'RuPay'];

function pad(n, width = 6) {
  return String(n).padStart(width, '0');
}

/**
 * Generate the customer population.
 *
 * Note what is and is not here: consent flags, tenure, payment history and per-rail
 * success counts are all OBSERVABLE and are legitimate policy features. Nothing about
 * intent or ability to pay is stored on the customer — that lives in latent truth,
 * generated per event.
 */
export function generateCustomers({ seed, params, now }) {
  const rng = makeRng(deriveSeed(seed, 'customers'));
  const customers = [];

  for (let i = 0; i < params.customers; i++) {
    const isB2B = rng.bool(params.b2bShare);
    const segment = isB2B ? Segment.B2B : Segment.B2C;

    const name = isB2B
      ? rng.pick(COMPANIES)
      : `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;

    const tenureDays = Math.floor(rng.exponential(280)) + 10;
    const signedUpAt = new Date(now.getTime() - tenureDays * DAY_MS);

    const lifetimePayments = Math.max(1, Math.floor(rng.exponential(tenureDays / 30)) + 1);
    const successRate = rng.float(0.62, 0.99);
    const lifetimeSuccesses = Math.round(lifetimePayments * successRate);

    const preferredRail = rng.weighted({ [Rail.UPI]: 0.55, [Rail.CARD]: 0.32, [Rail.NETBANKING]: 0.13 });

    // Rail history concentrated on the preferred rail, with some spread. Gives the
    // rail-switch decision real evidence to reason from rather than a coin flip.
    const railStats = {};
    for (const rail of Object.values(Rail)) {
      const share = rail === preferredRail ? rng.float(0.5, 0.8) : rng.float(0.02, 0.25);
      const attempts = Math.max(0, Math.round(lifetimePayments * share));
      if (attempts === 0) continue;
      const railSuccess = rail === preferredRail ? rng.float(0.75, 0.99) : rng.float(0.4, 0.9);
      railStats[rail] = { attempts, successes: Math.round(attempts * railSuccess) };
    }

    const dnd = rng.bool(params.dndRate);

    const amountCfg = params.amounts[segment];
    const typicalTicketPaise = rupeesToPaise(
      Math.round(Math.exp(amountCfg.muLogRupees))
    );

    customers.push({
      customerId: `cust_${pad(i + 1)}`,
      name,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      phone: `+9198${pad(rng.int(10000000, 99999999), 8)}`,
      segment,
      signedUpAt,
      consent: {
        email: true,
        sms: !dnd && rng.bool(0.92),
        whatsapp: !dnd && rng.bool(0.55),
        voice: !dnd && rng.bool(0.16),
      },
      dnd,
      preferredRail,
      stats: {
        lifetimePayments,
        lifetimeSuccesses,
        priorRecoveries: Math.floor(rng.exponential(0.7)),
        priorFailedAttempts: lifetimePayments - lifetimeSuccesses,
        typicalTicketPaise,
      },
      railStats,
    });
  }

  return customers;
}

/** Next plausible salary/credit date after `from` — clusters at month start. */
function nextFundsDate(from, rng) {
  const d = new Date(from.getTime());
  const dayOfMonth = d.getDate();
  // Most Indian salary credits land in the last two or first few days of a month.
  if (dayOfMonth <= 3) {
    return new Date(d.getTime() + rng.int(0, 2) * DAY_MS);
  }
  const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1, 10, 0, 0);
  return new Date(nextMonth.getTime() + rng.int(0, 3) * DAY_MS);
}

function buildFailurePayload({ trueCause, rail, rng, vagueRate }) {
  const templates = ERROR_TEMPLATES[trueCause];
  if (!templates) return null;

  const useVague = templates.vague.length > 0 && rng.bool(vagueRate);
  const pool = useVague ? templates.vague : templates.clear;
  const chosen = rng.pick(pool);

  return {
    ...chosen,
    method: rail.toLowerCase(),
    bank: rng.pick(BANKS),
    network: rail === Rail.CARD ? rng.pick(NETWORKS) : undefined,
    _generatedVague: useVague, // stripped before the agent sees it; used for reporting
  };
}

/**
 * Generate at-risk events plus their latent truth.
 *
 * Returns `{ events, latents }` as parallel arrays. The caller persists them to
 * separate collections, which is what keeps the truth out of the agent's reach.
 */
export function generateEvents({ seed, params, now, customers }) {
  const events = [];
  const latents = [];

  for (let i = 0; i < params.events; i++) {
    const eventId = `evt_${pad(i + 1)}`;

    /**
     * ONE RNG STREAM PER EVENT, and this is load-bearing for the entire sensitivity analysis.
     *
     * This used to be a single stream created once outside the loop, and all 600 events drew from it
     * in sequence. That is the natural way to write a generator and it silently coupled every case to
     * every case before it: the loop body is full of conditional draws (`if (trueRootCause ===
     * 'ISSUER_DOWNTIME')`, `if (payerType === DISPUTING)`, and the self-recovery delay below), so how
     * many numbers case i consumed depended on how case i turned out — and therefore on the
     * parameters. Change one probability and every subsequent case gets different numbers for
     * everything.
     *
     * Measured cost before the fix, on the day7 world: sweeping nothing but `selfRecoveryRate` moved
     * total portfolio exposure by 12.6% (₹9,30,035 at 0x to ₹8,12,762 at 2x). Self-recovery is a
     * latent and cannot move a rupee of recorded exposure, so those figures were impossible; a
     * sensitivity sweep built on them would have attributed a repriced portfolio to the assumption
     * under test. `test/generator.test.js` now pins the invariance.
     *
     * `deriveSeed`'s own docblock prescribes exactly this ("adding one extra random call would shift
     * every downstream number and silently invalidate a comparison") and the generator already
     * applied the reasoning one line wide, drawing `rng.bool(qGivenOpen)` unconditionally to protect
     * the stream. Per-event streams make it structural instead of a rule someone has to remember: a
     * conditional draw added anywhere in this loop tomorrow cannot reach another case.
     *
     * Keyed on `eventId` rather than on `i`, and being precise about this because I tried to write a
     * test that distinguishes them and could not: `eventId` is derived from `i`, so today the two are
     * the same function of position and NO test can tell them apart. It is a naming choice, not a
     * behavioural one. It is kept because the identity is the meaningful key the moment event
     * generation stops being a simple indexed loop — a filter, a shuffle, or per-customer generation
     * would all break the index and leave the id correct. Stated as defence in depth rather than
     * dressed up as a tested property.
     */
    const rng = makeRng(deriveSeed(seed, `event:${eventId}`));

    const customer = rng.pick(customers);

    // B2B customers skew toward invoices; consumers toward payments and subscriptions.
    const lossType = customer.segment === Segment.B2B
      ? rng.weighted({ OVERDUE_INVOICE: 0.62, FAILED_PAYMENT: 0.24, FAILED_SUBSCRIPTION: 0.14 })
      : rng.weighted({
          FAILED_PAYMENT: params.lossTypeMix.FAILED_PAYMENT,
          FAILED_SUBSCRIPTION: params.lossTypeMix.FAILED_SUBSCRIPTION,
          OVERDUE_INVOICE: params.lossTypeMix.OVERDUE_INVOICE * 0.3,
        });

    // LATENT FIRST, then a consistent observable error. Never the other way round.
    const payerType = rng.weighted(params.payerTypeMix);
    const causeDist = params.causeGivenPayer[payerType][lossType];
    const trueRootCause = rng.weighted(causeDist);

    /**
     * Drawn unconditionally and then possibly discarded, for the same reason the self-recovery coin
     * below is: an invoice is always collected on netbanking, so a naive ternary skips the draw for
     * invoices and shifts everything after it — including `amountPaise` — as a function of the loss
     * type. With per-event streams that can no longer leak into another case, but it would still
     * couple a `lossTypeMix` sweep to the amounts WITHIN each case, which is the same confound at
     * smaller scale. The rule this file follows: a case consumes a fixed number of draws.
     */
    const chosenRail = rng.weighted(railWeightsFor(customer.preferredRail));
    const rail = lossType === LossType.OVERDUE_INVOICE ? Rail.NETBANKING : chosenRail;

    const ageDays = rng.float(0.2, params.historyDays);
    const occurredAt = new Date(now.getTime() - ageDays * DAY_MS);
    // Detection lag: real pipelines are not instantaneous, and a policy should be
    // measured against the world as it is actually observed.
    const detectedAt = new Date(occurredAt.getTime() + rng.float(0.1, 6) * HOUR_MS);

    const amountCfg = params.amounts[customer.segment];
    const amountRupees = Math.max(50, Math.round(rng.logNormal(amountCfg.muLogRupees, amountCfg.sigma)));
    const amountPaise = rupeesToPaise(amountRupees);

    const event = {
      eventId,
      lossType,
      customerId: customer.customerId,
      amountPaise,
      currency: 'INR',
      occurredAt,
      detectedAt,
      rail,
      priorAttempts: rng.bool(params.priorAttemptRate) ? 1 : 0,
      references: {},
      downtime: { issuerDownAtFailure: false },
    };

    const latent = {
      eventId,
      customerId: customer.customerId,
      trueRootCause,
      payerType,
      responsiveness: rng.float(0.15, 0.95),
      patienceBudget:
        payerType === PayerType.NEVER_PAYING ? rng.int(1, 3) : rng.int(3, 7),
      workingRails: [],
      willSelfRecover: false,
    };

    // ---- loss-type specific shaping ----
    if (lossType === LossType.OVERDUE_INVOICE) {
      const termsDays = rng.pick([15, 30, 45, 60]);
      const dueDate = new Date(occurredAt.getTime() - rng.float(1, 40) * DAY_MS);
      const flags = [];
      // Only SOME disputes are flagged in the system. The unflagged ones are the
      // interesting case: the agent must infer a dispute from weaker signals, or fail
      // to, and get punished by the hardening penalty for chasing.
      if (trueRootCause === 'INVOICE_DISPUTED' && rng.bool(0.6)) {
        flags.push(rng.pick(['dispute_raised', 'query_raised', 'short_payment_claim']));
      }
      event.invoice = {
        invoiceNumber: `INV-${pad(i + 1, 5)}`,
        dueDate,
        termsDays,
        flags,
      };
      event.references.invoiceId = `inv_sim_${pad(i + 1)}`;
    } else {
      event.failure = buildFailurePayload({
        trueCause: trueRootCause,
        rail,
        rng,
        vagueRate: params.vagueErrorRate,
      });
      event.references.orderId = `order_sim_${pad(i + 1)}`;
      event.references.paymentId = `pay_sim_${pad(i + 1)}`;
    }

    if (lossType === LossType.FAILED_SUBSCRIPTION) {
      const totalCycles = rng.int(6, 36);
      event.subscription = {
        subscriptionId: `sub_sim_${pad(i + 1)}`,
        cycleNumber: rng.int(1, totalCycles),
        totalCycles,
        // Observable mandate status. Note it is only *usually* consistent with the
        // truth: sometimes a revoked mandate still reads 'active' because the status
        // has not propagated, which is a real integration hazard.
        mandateStatus:
          trueRootCause === 'MANDATE_REVOKED'
            ? (rng.bool(0.75) ? 'revoked' : 'active')
            : 'active',
      };
    }

    // ---- downtime windows ----
    if (trueRootCause === 'ISSUER_DOWNTIME') {
      const trueStart = new Date(occurredAt.getTime() - rng.float(0.2, 2) * HOUR_MS);
      const trueEnd = new Date(trueStart.getTime() + rng.float(0.5, 5) * HOUR_MS);
      latent.trueDowntimeWindow = { start: trueStart, end: trueEnd };

      // The agent's view is imperfect: sometimes downtime is not flagged at all, and
      // the estimated end time is off by up to an hour either way. A downtime-aware
      // policy is rewarded, but it is not handed the answer.
      event.downtime = {
        issuerDownAtFailure: rng.bool(0.8),
        observedWindowEndsAt: new Date(trueEnd.getTime() + rng.float(-1, 1) * HOUR_MS),
      };
    }

    // ---- payer-type specific latent state ----
    if (payerType === PayerType.TEMPORARILY_SHORT) {
      latent.fundsAvailableFrom = nextFundsDate(occurredAt, rng);
    }

    if (payerType === PayerType.NEEDS_NEW_INSTRUMENT) {
      // Their current rail is dead. Other rails may work — which is exactly why
      // REQUEST_REAUTH and SWITCH_RAIL_NUDGE are the only viable moves.
      latent.workingRails = Object.values(Rail).filter((r) => r !== rail);
      if (rng.bool(0.25)) latent.workingRails = []; // some have nothing that works
    } else if (payerType === PayerType.NEVER_PAYING) {
      latent.workingRails = [];
    } else {
      latent.workingRails = [rail, ...Object.values(Rail).filter((r) => r !== rail && rng.bool(0.4))];
    }

    if (payerType === PayerType.DISPUTING) {
      // Partial settlement ceiling: disputes often end in a haircut, and reporting
      // full recovery on a partial payment would overstate results.
      latent.maxWillingToPayPaise = Math.round(amountPaise * rng.float(0.4, 0.85));
    }

    // ---- self-recovery, conditioned on the case still being open ----
    /**
     * "Would have paid anyway", modulated by payer type. This is what the B0 baseline exists to
     * measure, and crediting it to an active policy is the most common way a recovery agent flatters
     * itself.
     *
     * THE SURVIVORSHIP CORRECTION, which is the subtle part and was a real bug for six days.
     *
     * The naive draw is `selfRecoverAt = occurredAt + U(0.5, 12) days`. But `occurredAt` is up to
     * `historyDays` = 21 days in the past, while the window closes at 12 — so a case that failed 20
     * days ago got a self-recovery instant up to 19.5 days BEFORE `now`. In English the world was
     * asserting: this customer paid you seventeen days ago, and the invoice is still sitting in your
     * open-recovery queue. Both cannot be true. Measured consequence: 66 of 88 self-recoverers (75%)
     * had already "paid" before the run began, and ₹1,07,871 — 9.6% of portfolio exposure, 25x what
     * the agent recovers — evaporated at cycle 0 into every arm's total equally.
     *
     * The input to this system is the set of losses STILL UNPAID at `now`. That is a
     * survivorship-conditioned sample, and conditioning on it removes precisely the fast
     * self-recoverers — the same length bias that makes the average wait for a bus exceed half the
     * average headway. So the latent must be drawn from the conditional distribution:
     *
     *   pOutlasts  = P(delay > ageDays)                     -- 0 once the whole window has elapsed
     *   qGivenOpen = q*pOutlasts / (q*pOutlasts + (1 - q))   -- Bayes: P(self-recoverer | still open)
     *   delay      ~ U(max(lo, ageDays), hi)                -- truncated, so selfRecoverAt > now always
     *
     * Note this is NOT merely rescheduling the same cases into the future. It correctly makes an old
     * unpaid case LESS LIKELY to be a self-recoverer at all, because its continued presence in the
     * queue is evidence against it. Past `hi` days the posterior is exactly zero: the entire window
     * elapsed and they did not pay, so they are provably not someone who pays unprompted. That is
     * 43.3% of the batch, and it is why `selfRecoveryWindowDays` being shorter than `historyDays`
     * carries real information rather than being an arbitrary pair of constants.
     *
     * This change makes B0 weaker and therefore makes our own policy's incremental figure look
     * better, which is exactly the kind of self-serving correction that deserves suspicion. It was
     * pre-registered in ENGINEERING_LOG.md before the arm comparison was run, the predicted magnitude
     * (0.29-0.33x) was committed to in advance, and Day 8 reports B0 under both conventions.
     */
    const baseSelf = params.selfRecoveryRate[lossType];

    const selfMultiplier = {
      [PayerType.WILL_PAY_IF_REMINDED]: 1.5,
      [PayerType.TEMPORARILY_SHORT]: 1.1,
      [PayerType.NEEDS_NEW_INSTRUMENT]: 0.25,
      [PayerType.DISPUTING]: 0.1,
      [PayerType.NEVER_PAYING]: 0.0,
    }[payerType];

    const [selfLo, selfHi] = params.selfRecoveryWindowDays;
    const q = Math.min(0.95, baseSelf * selfMultiplier);

    const earliestDelay = Math.max(selfLo, ageDays);
    const pOutlasts = earliestDelay >= selfHi ? 0 : (selfHi - earliestDelay) / (selfHi - selfLo);
    const qGivenOpen = q >= 1 ? 1 : (q * pOutlasts) / (q * pOutlasts + (1 - q));

    /**
     * BOTH draws are unconditional, so a case consumes the same count whatever it turns out to be.
     *
     * The coin was already drawn unconditionally, with a docblock explaining why. The delay was not —
     * it sat inside the `if`, which is the defect described at the top of this loop. Nothing currently
     * follows it in the loop body, so hoisting it changes no number on its own; it is here so that the
     * next person to add a draw below this line does not reintroduce a portfolio-repricing bug by
     * writing perfectly reasonable code.
     */
    const selfRecovers = rng.bool(qGivenOpen);
    const selfDelayDays = rng.float(earliestDelay, selfHi);
    if (selfRecovers) {
      latent.willSelfRecover = true;
      latent.selfRecoverAt = new Date(occurredAt.getTime() + selfDelayDays * DAY_MS);
    }

    events.push(event);
    latents.push(latent);
  }

  return { events, latents };
}

/**
 * Deterministic batch identifier.
 *
 * Derived from seed, split and generator version rather than from a UUID or a timestamp,
 * so re-seeding produces the SAME id and overwrites the previous batch instead of
 * silently accumulating near-duplicate worlds. Including the generator version means that
 * changing the generator yields a visibly different batch id — which is the point: a
 * reported number should never be traceable to an ambiguous world.
 */
export function batchIdFor({ seed, split, generatorVersion = GENERATOR_VERSION }) {
  return `batch_${split.toLowerCase()}_s${seed}_g${generatorVersion.replace(/\./g, '')}`;
}

/** Generate a complete batch: customers, events, and latent truth. */
export function generateBatch({ seed, split = 'TRAIN', now = new Date(), overrides = {} }) {
  const params = {
    ...DEFAULT_PARAMS,
    ...(split === 'TEST' ? TEST_PARAM_SHIFT : {}),
    ...overrides,
  };

  const customers = generateCustomers({ seed, params, now });
  const { events, latents } = generateEvents({ seed, params, now, customers });

  // Stamp batch provenance onto every row. Done here rather than inside the generators so
  // that they stay concerned only with modelling, and so there is exactly one place where
  // the link between a row and the world that produced it is established.
  const batchId = batchIdFor({ seed, split });
  for (const c of customers) c.batchId = batchId;
  for (const e of events) e.batchId = batchId;
  for (const l of latents) l.batchId = batchId;

  const byLossType = {};
  const byTrueRootCause = {};
  let totalAtRiskPaise = 0;

  for (const e of events) {
    byLossType[e.lossType] = (byLossType[e.lossType] ?? 0) + 1;
    totalAtRiskPaise += e.amountPaise;
  }
  for (const l of latents) {
    byTrueRootCause[l.trueRootCause] = (byTrueRootCause[l.trueRootCause] ?? 0) + 1;
  }

  return {
    seed,
    split,
    params,
    generatorVersion: GENERATOR_VERSION,
    generatedAt: now,

    /**
     * The batch descriptor, shaped to match BatchSchema in src/db/models/world.js.
     *
     * Carried as its own object rather than being reassembled by each caller, because the
     * full parameter snapshot is what lets a result be traced back to the assumptions that
     * produced it months later. Every caller reconstructing this by hand is a chance for
     * one of them to omit `params` — and a result whose parameters are unknown is not a
     * result.
     */
    batch: {
      batchId,
      seed,
      split,
      generatedAt: now,
      generatorVersion: GENERATOR_VERSION,
      params,
      counts: {
        customers: customers.length,
        events: events.length,
        byLossType,
        byTrueRootCause,
        totalAtRiskPaise,
      },
    },

    customers,
    events,
    latents,
    counts: {
      customers: customers.length,
      events: events.length,
      byLossType,
      byTrueRootCause,
      totalAtRiskPaise,
    },
  };
}
