/**
 * THE WORLD: immutable facts.
 *
 * Everything in this file is generated once per batch and never mutated again. The
 * five policy arms all read the *same* world, which is what makes comparing them
 * meaningful — if do-nothing and Rebound faced different customers, the comparison
 * would be worthless.
 *
 * So: mutable per-policy state lives in `runtime.js`, keyed by (runId, eventId).
 * Nothing here carries a `state` field, and nothing here knows about a run.
 *
 * NOTE ON WHAT IS ABSENT: there is no `trueRootCause` on AtRiskEvent, and no
 * `payerType` on Customer. Ground truth lives in `src/sim/latentTruth.js` and the
 * agent has no import path to it. See docs/honesty.md.
 */

import mongoose from 'mongoose';
import { LossType, Rail, Segment } from '../../core/enums.js';

const { Schema } = mongoose;

// Re-exported so existing import sites (`from '../db/models/world.js'`) keep working,
// while the canonical definitions live in the dependency-free core/enums.js.
export { LossType, Rail, Segment };

/* ------------------------------------------------------------------ Batch --- */

const BatchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },

    // The seed is the reproducibility contract. Given this number and the code at
    // a given commit, every figure in the pitch video can be regenerated exactly.
    seed: { type: Number, required: true },

    // TRAIN batches fit the probability model. TEST batches evaluate the policy and
    // are generated with a different seed AND mildly shifted parameters, so that we
    // measure generalisation rather than memorisation.
    split: { type: String, enum: ['TRAIN', 'TEST'], required: true },

    generatedAt: { type: Date, required: true },
    generatorVersion: { type: String, required: true },

    // Full snapshot of the parameters used. Written so that a result can always be
    // traced back to the assumptions that produced it, even months later.
    params: { type: Schema.Types.Mixed, required: true },

    counts: {
      customers: Number,
      events: Number,
      byLossType: Schema.Types.Mixed,
      byTrueRootCause: Schema.Types.Mixed,
      totalAtRiskPaise: Number,
    },

    notes: String,
  },
  { collection: 'batches', timestamps: true }
);

/* --------------------------------------------------------------- Customer --- */

const CustomerSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    customerId: { type: String, required: true },

    name: String,
    email: String,
    phone: String,

    segment: { type: String, enum: Object.values(Segment), required: true },

    // Signup date. Tenure is a real predictor: long-tenured customers recover at
    // higher rates because they have both a working relationship and a habit.
    signedUpAt: { type: Date, required: true },

    // Consent is per-channel and is an observable input to the policy, not an
    // afterthought. An action on a non-consented channel is never even a candidate.
    consent: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      voice: { type: Boolean, default: false },
    },

    // Do-not-disturb is absolute and separate from per-channel consent, because it
    // is a different kind of thing: consent is a preference, DND is a withdrawal.
    dnd: { type: Boolean, default: false },

    preferredRail: { type: String, enum: Object.values(Rail) },

    // Observable payment history. These are legitimate policy features.
    stats: {
      lifetimePayments: { type: Number, default: 0 },
      lifetimeSuccesses: { type: Number, default: 0 },
      priorRecoveries: { type: Number, default: 0 },
      priorFailedAttempts: { type: Number, default: 0 },
      typicalTicketPaise: { type: Number, default: 0 },
    },

    // Per-rail success history. Powers the rail-switch decision with evidence
    // instead of a hunch: if this customer has succeeded on UPI 9 times and failed
    // on card 3 times, suggesting UPI is grounded rather than generic advice.
    railStats: {
      type: Map,
      of: new Schema({ attempts: Number, successes: Number }, { _id: false }),
      default: () => new Map(),
    },
  },
  { collection: 'customers', timestamps: true }
);

CustomerSchema.index({ batchId: 1, customerId: 1 }, { unique: true });

/* ------------------------------------------------------------ AtRiskEvent --- */

/**
 * The raw failure metadata, shaped to mirror Razorpay's payment error fields.
 *
 * Kept as a nested object rather than flattened so that the diagnosis layer receives
 * something structurally identical to a real webhook payload. That way the rule table
 * is exercised against realistic input in SIM mode and needs no changes in LIVE_TEST
 * mode — the same code path handles both, which is the only way SIM results tell us
 * anything about real behaviour.
 */
const FailureSchema = new Schema(
  {
    errorCode: String,        // e.g. BAD_REQUEST_ERROR, GATEWAY_ERROR
    errorDescription: String, // human-readable, sometimes issuer free text
    errorSource: String,      // customer | business | bank | gateway | internal
    errorStep: String,        // payment_initiation | _authentication | _authorization
    errorReason: String,      // most specific machine-readable field
    method: String,           // upi | card | netbanking | wallet
    bank: String,
    network: String,          // Visa | Mastercard | RuPay
  },
  { _id: false }
);

const AtRiskEventSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },

    lossType: { type: String, enum: Object.values(LossType), required: true },
    customerId: { type: String, required: true, index: true },

    amountPaise: { type: Number, required: true },
    currency: { type: String, default: 'INR' },

    // When the money actually went at risk.
    occurredAt: { type: Date, required: true },
    // When we noticed. Non-zero lag is realistic and matters, because recovery
    // probability decays with age and a policy should be penalised for slow detection.
    detectedAt: { type: Date, required: true },

    failure: FailureSchema,

    // Receivable-specific context.
    invoice: {
      invoiceNumber: String,
      dueDate: Date,
      termsDays: Number,
      // Observable operational flags, e.g. dispute_raised. The diagnosis layer reads
      // these; it does not read whether the customer *intends* to pay.
      flags: [String],
    },

    // Recurring-specific context.
    subscription: {
      subscriptionId: String,
      cycleNumber: Number,
      totalCycles: Number,
      mandateStatus: String, // active | paused | revoked (observable)
    },

    rail: { type: String, enum: Object.values(Rail) },

    // Had the merchant's own gateway already auto-retried before we saw this? Real
    // pipelines have prior attempts, and a policy that ignores them will breach the
    // retry cap on its first move.
    priorAttempts: { type: Number, default: 0 },

    // Observable downtime signal at time of failure. Razorpay exposes downtime
    // information, so an agent is entitled to know this — and using it is one of the
    // clearest wins over a naive retry loop.
    downtime: {
      issuerDownAtFailure: { type: Boolean, default: false },
      observedWindowEndsAt: Date,
    },

    references: {
      orderId: String,
      paymentId: String,
      invoiceId: String,
      paymentLinkId: String,
    },
  },
  { collection: 'at_risk_events', timestamps: true }
);

AtRiskEventSchema.index({ batchId: 1, eventId: 1 }, { unique: true });
AtRiskEventSchema.index({ batchId: 1, lossType: 1 });

export const Batch = mongoose.model('Batch', BatchSchema);
export const Customer = mongoose.model('Customer', CustomerSchema);
export const AtRiskEvent = mongoose.model('AtRiskEvent', AtRiskEventSchema);
