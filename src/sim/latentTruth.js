/**
 * LATENT TRUTH — SIMULATOR ONLY. THE AGENT MUST NEVER READ THIS.
 * ==============================================================
 *
 * This file deliberately lives under `src/sim/` and NOT under `src/db/models/`.
 * That placement is the enforcement mechanism, not a filing preference.
 *
 * Why it matters:
 *
 * The whole evaluation rests on the agent having to *infer* why a payment failed and
 * whether a customer will ever pay. If the agent could read `payerType` directly, the
 * measured "lift" would be a measurement of nothing — it would be a model grading its
 * own answer key. That is the single easiest way to accidentally fake a hackathon
 * result, and it is easy precisely because nobody does it on purpose. It happens when
 * a convenient field is one join away and you are tired.
 *
 * So the boundary is structural:
 *   - Ground truth lives in its own collection, `latent_truth`.
 *   - The model is exported only from here, inside the simulator package.
 *   - `src/agent/**` never imports from `src/sim/**`.
 *   - `test/boundary.test.js` fails the build if that import ever appears.
 *
 * The agent observes exactly what a real agent would observe: Razorpay error fields,
 * payment history, consent flags, timestamps, downtime signals. Everything in this
 * file is the part of the world a real merchant cannot see either.
 *
 * A useful consequence: because we hold the truth separately, we can measure the
 * agent's DIAGNOSIS accuracy after the fact, by joining its beliefs against this
 * collection. So the honesty mechanism also gives us a metric we would not otherwise
 * have — how often the agent correctly identified an unrecoverable case.
 */

import mongoose from 'mongoose';
import { PayerType, PAYER_TYPES } from './payerTypes.js';

const { Schema } = mongoose;

// Re-exported so existing import sites keep working. The canonical definitions, and
// the explanation of why each type makes the policy problem non-trivial, live in
// payerTypes.js.
export { PayerType, PAYER_TYPES };


const LatentTruthSchema = new Schema(
  {
    batchId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    customerId: { type: String, required: true, index: true },

    /**
     * The actual reason the payment failed.
     *
     * The agent's diagnosis is a *guess* at this. Keeping them separate is what lets
     * us report diagnosis accuracy honestly, including a confusion matrix, rather
     * than assuming the rule table is correct because we wrote it.
     */
    trueRootCause: { type: String, required: true },

    payerType: { type: String, enum: PAYER_TYPES, required: true },

    /**
     * Would this have recovered with NO intervention at all?
     *
     * Essential, and routinely forgotten. Some customers simply retry by themselves
     * the next day. Any agent that takes credit for those recoveries is reporting a
     * fiction, and the B0 do-nothing baseline exists specifically to quantify how
     * large that fiction would have been.
     */
    willSelfRecover: { type: Boolean, default: false },
    selfRecoverAt: Date,

    /**
     * Base propensity to respond to any outbound message, 0..1. Independent of type,
     * so that "responsive but disputing" and "unresponsive but willing" both exist.
     */
    responsiveness: { type: Number, default: 0.5 },

    /** For TEMPORARILY_SHORT: when money actually arrives. */
    fundsAvailableFrom: Date,

    /** True issuer downtime window, which may extend past the observed estimate. */
    trueDowntimeWindow: { start: Date, end: Date },

    /**
     * How many total touches this customer tolerates before disengaging entirely.
     * The mechanism behind message fatigue, and the reason frugality can outperform
     * volume rather than merely tie with it.
     */
    patienceBudget: { type: Number, default: 4 },

    /** Ceiling on what they will ever pay (partial settlement on disputes). */
    maxWillingToPayPaise: Number,

    /** Which rails would actually work for them right now. */
    workingRails: [String],

    notes: String,
  },
  { collection: 'latent_truth', timestamps: false }
);

LatentTruthSchema.index({ batchId: 1, eventId: 1 }, { unique: true });

export const LatentTruth = mongoose.model('LatentTruth', LatentTruthSchema);
