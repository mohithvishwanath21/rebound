/**
 * RUNTIME: mutable, run-scoped state and the audit trail.
 *
 * A "run" is one policy applied to one batch. Because all five policy arms are
 * evaluated against the same immutable world, every mutable thing here is keyed by
 * (runId, eventId) rather than living on the event itself. That separation is what
 * lets us run B0 through REBOUND_EV over identical inputs and attribute every
 * difference in outcome to the policy alone.
 *
 * The audit trail is append-only by convention and by API: nothing in this codebase
 * updates or deletes an AuditEntry. An audit log you can edit is not an audit log.
 */

import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CaseStateName = {
  OPEN: 'OPEN',                         // detected, not yet diagnosed
  DIAGNOSED: 'DIAGNOSED',               // cause assigned, awaiting decision
  ACTING: 'ACTING',                     // at least one action taken, still live
  SCHEDULED: 'SCHEDULED',               // waiting on a future retry or re-evaluation
  AWAITING_APPROVAL: 'AWAITING_APPROVAL', // high-value gate; a human must decide
  RECOVERED: 'RECOVERED',               // money in
  STOPPED: 'STOPPED',                   // closed by a stopping rule, with a reason
  ESCALATED: 'ESCALATED',               // handed to a human, automation frozen
  EXPIRED: 'EXPIRED',                   // aged out
};

/** Terminal states — the orchestrator makes no further decisions on these. */
export const TERMINAL_STATES = new Set([
  CaseStateName.RECOVERED,
  CaseStateName.STOPPED,
  CaseStateName.ESCALATED,
  CaseStateName.EXPIRED,
]);

/* ------------------------------------------------------------------- Run --- */

const RunSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },
    batchId: { type: String, required: true, index: true },
    policyArm: { type: String, required: true },

    // Full config snapshot: costs, guardrails, policy thresholds, execution mode.
    // Without this, a metrics table is an orphan — you cannot tell which assumptions
    // produced it, which makes the sensitivity analysis impossible to interpret.
    configSnapshot: { type: Schema.Types.Mixed, required: true },

    executionMode: { type: String, enum: ['SIM', 'LIVE_TEST'], required: true },

    // Simulated clock bounds. The orchestrator advances a virtual clock so a 30-day
    // recovery window evaluates in seconds. Real wall-clock time is meaningless here
    // and conflating the two would make scheduled retries untestable.
    simClock: {
      startAt: Date,
      endAt: Date,
      stepMinutes: Number,
    },

    startedAt: Date,
    finishedAt: Date,

    metrics: { type: Schema.Types.Mixed },

    // Circuit-breaker counters, checked before every action.
    counters: {
      messagesSent: { type: Number, default: 0 },
      retriesAttempted: { type: Number, default: 0 },
      humanEscalations: { type: Number, default: 0 },
      guardrailBlocks: { type: Number, default: 0 },
    },

    abortedReason: String,
  },
  { collection: 'runs', timestamps: true }
);

/* ------------------------------------------------------------- CaseState --- */

const CaseStateSchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    customerId: { type: String, required: true, index: true },

    state: { type: String, enum: Object.values(CaseStateName), required: true },

    // What the agent BELIEVES about the cause. Deliberately named to contrast with
    // the latent truth it cannot see. Diagnosis accuracy is itself a reported metric,
    // measured after the fact by joining this against LatentTruth.
    diagnosis: {
      rootCause: String,
      confidence: Number,
      source: { type: String, enum: ['RULE', 'LLM', 'FALLBACK'] },
      evidence: [String],
      diagnosedAt: Date,
      // Preserved when low confidence forces a downgrade to UNKNOWN, so the audit
      // trail shows both what we suspected and why we declined to rely on it.
      rawLlmLabel: String,
    },

    retriesUsed: { type: Number, default: 0 },
    touchesUsed: { type: Number, default: 0 },

    lastRetryAt: Date,
    lastContactAt: Date,
    nextEvaluateAt: Date,

    recoveredAmountPaise: { type: Number, default: 0 },
    recoveredAt: Date,
    recoveredVia: String,

    // Populated on STOPPED. This field is the stopping rule made legible: every
    // closed case can say in one line why nobody chased it further.
    stopReason: String,
    stopReasonDetail: Schema.Types.Mixed,

    escalationReason: String,

    approval: {
      required: { type: Boolean, default: false },
      requestedAt: Date,
      decidedAt: Date,
      decision: { type: String, enum: ['APPROVED', 'REJECTED', 'PENDING'] },
      decidedBy: String,
      proposedAction: Schema.Types.Mixed,
    },

    decisionCount: { type: Number, default: 0 },
  },
  { collection: 'case_states', timestamps: true }
);

CaseStateSchema.index({ runId: 1, eventId: 1 }, { unique: true });
CaseStateSchema.index({ runId: 1, state: 1 });
CaseStateSchema.index({ runId: 1, nextEvaluateAt: 1 });

/* -------------------------------------------------------------- Decision --- */

/**
 * One row per action considered — including the ones we rejected.
 *
 * This is the schema that makes the dashboard an explanation rather than a log. Any
 * system can tell you what it did. Showing the alternatives, their scores, and the
 * specific rule that disqualified each one is what lets a merchant's finance team
 * audit a decision they were not present for.
 */
const EvRowSchema = new Schema(
  {
    action: Schema.Types.Mixed,
    signature: String,

    pRecover: Number,
    grossValuePaise: Number,   // p * amount * contributionMargin
    actionCostPaise: Number,
    patiencePenaltyPaise: Number,
    evPaise: Number,

    allowed: Boolean,
    // Which guardrail forbade it, if any. Named specifically ('QUIET_HOURS',
    // 'CONTACT_CAP_7D') rather than a generic "blocked", because a reviewer's next
    // question is always "blocked by what?"
    blockedBy: [String],
    blockDetail: Schema.Types.Mixed,

    chosen: Boolean,
    rejectedBecause: String,
  },
  { _id: false }
);

const DecisionSchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    seq: { type: Number, required: true },

    decidedAt: { type: Date, required: true },   // simulated clock
    decidedAtReal: { type: Date, default: Date.now },

    policyArm: String,

    evTable: [EvRowSchema],

    chosenAction: Schema.Types.Mixed,
    chosenSignature: String,

    // Feature vector fed to the probability model, plus the signed per-feature
    // contribution to the log-odds. This is why the model is logistic regression:
    // "we predicted 31% because insufficient_funds contributed -0.8, salary window
    // +1.1, prior recoveries +0.4" is an explanation a human can check. A tree
    // ensemble would give a better number and no such sentence.
    features: Schema.Types.Mixed,
    featureContributions: Schema.Types.Mixed,
    modelVersion: String,

    guardrailEvaluations: [
      {
        rule: String,
        result: { type: String, enum: ['PASS', 'BLOCK', 'NOT_APPLICABLE'] },
        detail: Schema.Types.Mixed,
        _id: false,
      },
    ],

    // Plain-language summary, generated deterministically from the fields above.
    // Not LLM-written: the explanation must be a faithful rendering of the actual
    // computation, and a language model paraphrasing it could drift from the truth.
    rationale: String,
  },
  { collection: 'decisions', timestamps: false }
);

DecisionSchema.index({ runId: 1, eventId: 1, seq: 1 }, { unique: true });

/* ---------------------------------------------------------- ActionRecord --- */

const ActionRecordSchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    decisionSeq: Number,

    action: Schema.Types.Mixed,
    signature: String,

    executedAt: Date,        // simulated clock
    executedAtReal: { type: Date, default: Date.now },

    adapter: { type: String, enum: ['SIM', 'LIVE_TEST'] },

    /**
     * Idempotency key, deterministic from (runId, eventId, decisionSeq, action).
     *
     * Deterministic rather than random on purpose: if the process crashes after
     * sending the request but before recording the response, the retry on restart
     * recomputes the identical key and the downstream system deduplicates it. A
     * random key would generate a second charge in exactly the situation where a
     * double charge is least forgivable.
     */
    idempotencyKey: { type: String, index: true },

    request: Schema.Types.Mixed,
    response: Schema.Types.Mixed,

    razorpay: {
      orderId: String,
      paymentId: String,
      paymentLinkId: String,
      subscriptionId: String,
      invoiceId: String,
    },

    outcome: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'SENT', 'PENDING', 'ERROR', 'SKIPPED'],
    },
    outcomeDetail: Schema.Types.Mixed,
    errorMessage: String,

    costPaise: Number,
  },
  { collection: 'action_records', timestamps: false }
);

ActionRecordSchema.index({ runId: 1, eventId: 1, decisionSeq: 1 });

/* ------------------------------------------------------- ContactLedger --- */

/**
 * Every customer-directed message, per run.
 *
 * Exists as its own collection specifically to enforce the per-CUSTOMER contact cap.
 * Per-case counters cannot see across cases, which is how the classic failure happens:
 * a customer with eight overdue invoices gets eight reminders in one morning, each
 * from a workflow that individually respected its own limits.
 *
 * Enforcing that limit requires a store that sees all of a customer's cases at once.
 * This is that store.
 */
const ContactLedgerSchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    eventId: String,
    channel: String,
    sentAt: { type: Date, required: true },
    actionKind: String,
    costPaise: Number,
  },
  { collection: 'contact_ledger', timestamps: false }
);

ContactLedgerSchema.index({ runId: 1, customerId: 1, sentAt: -1 });

/* ------------------------------------------------------------ AuditEntry --- */

export const AuditType = {
  DETECTED: 'DETECTED',
  DIAGNOSED: 'DIAGNOSED',
  DECISION_MADE: 'DECISION_MADE',
  GUARDRAIL_BLOCKED: 'GUARDRAIL_BLOCKED',
  ACTION_EXECUTED: 'ACTION_EXECUTED',
  OUTCOME_OBSERVED: 'OUTCOME_OBSERVED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  APPROVAL_DECIDED: 'APPROVAL_DECIDED',
  STOPPED: 'STOPPED',
  ESCALATED: 'ESCALATED',
  RECOVERED: 'RECOVERED',
  CIRCUIT_BREAKER: 'CIRCUIT_BREAKER',
};

const AuditEntrySchema = new Schema(
  {
    runId: { type: String, required: true, index: true },
    eventId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },

    at: { type: Date, required: true },       // simulated clock
    atReal: { type: Date, default: Date.now },

    type: { type: String, enum: Object.values(AuditType), required: true },

    // One line a human can read without expanding anything. The case timeline in the
    // dashboard is built from these, so they are written for people, not for grep.
    summary: { type: String, required: true },

    payload: Schema.Types.Mixed,

    decisionSeq: Number,
  },
  { collection: 'audit_entries', timestamps: false }
);

AuditEntrySchema.index({ runId: 1, eventId: 1, seq: 1 }, { unique: true });

export const Run = mongoose.model('Run', RunSchema);
export const CaseState = mongoose.model('CaseState', CaseStateSchema);
export const Decision = mongoose.model('Decision', DecisionSchema);
export const ActionRecord = mongoose.model('ActionRecord', ActionRecordSchema);
export const ContactLedger = mongoose.model('ContactLedger', ContactLedgerSchema);
export const AuditEntry = mongoose.model('AuditEntry', AuditEntrySchema);
