/**
 * THE ACTION SPACE
 * ================
 *
 * Closed, small, and every member has a cost. Those three properties are the whole
 * safety argument of this project, so they are worth stating plainly:
 *
 *   CLOSED — the agent chooses from this list and cannot invent anything else. The
 *   LLM in the diagnosis tier returns a *label*, never an action. There is no code
 *   path from model output to an arbitrary API call. When someone asks "what's the
 *   worst thing your agent can do?", the answer is a finite list you can read in
 *   under a minute, and every item on it is reversible or harmless.
 *
 *   SMALL — eight actions. A policy over eight actions can be audited by a human
 *   who has never seen the code. A policy over an open action space cannot.
 *
 *   COSTED — this is what makes "should we act at all?" a real question with a real
 *   answer rather than a rhetorical one. Without costs, the optimal policy is always
 *   "do everything to everyone," which is exactly the failure mode we are arguing
 *   against.
 */

export const ActionKind = {
  NO_ACTION_YET: 'NO_ACTION_YET',
  RETRY_NOW: 'RETRY_NOW',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  SEND_LINK: 'SEND_LINK',
  SWITCH_RAIL_NUDGE: 'SWITCH_RAIL_NUDGE',
  REQUEST_REAUTH: 'REQUEST_REAUTH',
  ESCALATE_HUMAN: 'ESCALATE_HUMAN',
  STOP_PERMANENT: 'STOP_PERMANENT',
};

export const Channel = {
  EMAIL: 'EMAIL',
  SMS: 'SMS',
  WHATSAPP: 'WHATSAPP',
  VOICE: 'VOICE',
};

/**
 * Does this action move money / touch a payment instrument?
 * Used to decide which actions need an idempotency key and which need the
 * high-value approval gate.
 */
export const MONEY_MOVING = new Set([ActionKind.RETRY_NOW, ActionKind.RETRY_SCHEDULED]);

/** Does this action consume the customer's finite patience budget? */
export const CUSTOMER_CONTACTING = new Set([
  ActionKind.SEND_LINK,
  ActionKind.SWITCH_RAIL_NUDGE,
  ActionKind.REQUEST_REAUTH,
]);

/** Terminal actions — the case is closed and no further decisions are made. */
export const TERMINAL = new Set([ActionKind.STOP_PERMANENT, ActionKind.ESCALATE_HUMAN]);

export const ACTION_META = {
  [ActionKind.NO_ACTION_YET]: {
    label: 'Wait and re-evaluate',
    // Genuinely free, and genuinely often correct. Worth having as an explicit
    // choice rather than an implicit gap, so that "we deliberately waited" appears
    // in the audit trail as a decision rather than as silence.
    consumesRetry: false,
    consumesTouch: false,
    description:
      'Take no action now and reconsider later. Chosen when the expected value of ' +
      'every available action is currently negative but conditions are expected to ' +
      'change — most often waiting out an issuer outage or waiting for a salary credit.',
  },

  [ActionKind.RETRY_NOW]: {
    label: 'Retry the charge immediately',
    consumesRetry: true,
    consumesTouch: false, // silent to the customer
    requiresIdempotencyKey: true,
    description:
      'Re-attempt the same instrument right now. Correct only when the failure was ' +
      'transient and has already cleared.',
  },

  [ActionKind.RETRY_SCHEDULED]: {
    label: 'Retry the charge at a chosen time',
    consumesRetry: true,
    consumesTouch: false,
    requiresIdempotencyKey: true,
    description:
      'Re-attempt at a specific future time. This is the highest-leverage action in ' +
      'the whole space and the one naive agents lack: for insufficient-funds and ' +
      'downtime failures, *when* you retry matters far more than *how often*.',
  },

  [ActionKind.SEND_LINK]: {
    label: 'Send a payment link',
    consumesRetry: false,
    consumesTouch: true,
    description:
      'Send a fresh payment link on a consented channel. The right move when the ' +
      'instrument is fine but the human did not finish.',
  },

  [ActionKind.SWITCH_RAIL_NUDGE]: {
    label: 'Suggest a different payment method',
    consumesRetry: false,
    consumesTouch: true,
    description:
      'Send a link that steers to a different rail — typically UPI instead of a card, ' +
      'because it has materially fewer steps to complete. Useful for authentication ' +
      'drop-off and for per-instrument limit breaches.',
  },

  [ActionKind.REQUEST_REAUTH]: {
    label: 'Request a new instrument or re-authorisation',
    consumesRetry: false,
    consumesTouch: true,
    description:
      'Ask the customer to add a new instrument or re-authorise a mandate. The ONLY ' +
      'action that can recover an expired instrument or a revoked mandate — which is ' +
      'why correct diagnosis is worth more than retry throughput.',
  },

  [ActionKind.ESCALATE_HUMAN]: {
    label: 'Escalate to a human',
    consumesRetry: false,
    consumesTouch: false,
    description:
      'Place the case in the human queue and stop automating it. Mandatory for ' +
      'risk-blocked payments and disputed invoices, and chosen on value grounds when ' +
      'the amount justifies the time of a person.',
  },

  [ActionKind.STOP_PERMANENT]: {
    label: 'Stop pursuing',
    consumesRetry: false,
    consumesTouch: false,
    description:
      'Close the case and never touch it again, with the reason recorded. The bar for ' +
      'this track explicitly asks for stopping rules, and this is where they land. ' +
      'Choosing this correctly on unrecoverable cases is what frees budget for the ' +
      'recoverable ones — it is a source of value, not an admission of defeat.',
  },
};

export const ALL_ACTION_KINDS = Object.keys(ACTION_META);

/**
 * Build the full set of candidate actions for a case, before any filtering.
 *
 * Deliberately generous: this enumerates everything conceivable, including things
 * that are obviously wrong for the case. The guardrail engine then removes what is
 * forbidden, and the expected-value scorer ranks what remains.
 *
 * Keeping generation broad and filtering explicit is what lets the audit trail show
 * *rejected* alternatives with reasons. A dashboard that shows only what the agent
 * did is a log; one that shows what it considered and declined is an explanation.
 * That distinction is most of what "explainable" should mean for money movement.
 */
export function enumerateCandidateActions({ retryTimes = [], channels = [] } = {}) {
  const candidates = [
    { kind: ActionKind.NO_ACTION_YET },
    { kind: ActionKind.RETRY_NOW },
    { kind: ActionKind.ESCALATE_HUMAN },
    { kind: ActionKind.STOP_PERMANENT },
  ];

  for (const at of retryTimes) {
    candidates.push({ kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at });
  }

  for (const channel of channels) {
    candidates.push({ kind: ActionKind.SEND_LINK, channel });
    candidates.push({ kind: ActionKind.SWITCH_RAIL_NUDGE, channel });
    candidates.push({ kind: ActionKind.REQUEST_REAUTH, channel });
  }

  return candidates;
}

/** Stable, human-readable id for an action instance. Used in audit entries. */
export function actionSignature(action) {
  const parts = [action.kind];
  if (action.channel) parts.push(action.channel);
  if (action.scheduledFor) parts.push(new Date(action.scheduledFor).toISOString());
  return parts.join(':');
}
