/**
 * ROOT CAUSE TAXONOMY
 * ===================
 *
 * The single most important idea in this project lives in this file.
 *
 * A merchant dashboard shows you a list of failed payments. They all look the same:
 * red, with an amount next to them. But they are not the same, and the differences
 * are not cosmetic — they change what you should do, and in two cases they change
 * whether you are allowed to do anything at all:
 *
 *   - Retrying an EXPIRED_INSTRUMENT has a success rate of exactly zero. Not "low."
 *     Zero. The card is dead. Every retry is pure cost, and it burns your decline
 *     ratio, which issuers and card networks watch. Enough of that and your *good*
 *     payments start getting declined too. You are actively making things worse.
 *
 *   - Retrying a RISK_BLOCKED payment is not a wasted API call, it is a compliance
 *     problem. Something flagged that transaction. An agent that retries it is an
 *     agent that overrides a risk control automatically. That must never happen.
 *
 *   - ISSUER_DOWNTIME is not the customer's fault, it is an outage. Messaging the
 *     customer to say "your payment failed, please try again" blames them for your
 *     infrastructure problem. The correct action is to wait and retry silently.
 *
 * This is why "money recovered" is a misleading metric on its own, and why the
 * naive baseline (retry everything three times, message everybody) can look busy
 * while destroying value. Diagnosis is not a nice-to-have preprocessing step. It is
 * the thing that makes the difference between a recovery agent and a spam cannon.
 *
 * Each class below therefore carries its *recovery physics*: can a retry ever work,
 * is timing the binding constraint, whose fault was it, and is automated contact
 * appropriate at all.
 *
 * ---------------------------------------------------------------------------
 * VERIFY BEFORE DEMO: the Razorpay error-field values in RULE_TABLE below are
 * written from prior knowledge of the API and MUST be checked against the current
 * docs (razorpay.com/docs — payment error codes / error reasons) and against real
 * test-mode failures. Field names and reason enums do change. This is exactly why
 * every unmapped value falls through to the LLM tier and then to UNKNOWN, rather
 * than crashing or guessing: a stale rule table degrades into caution, not into
 * wrong money movements. Log any corrections in ENGINEERING_LOG.md.
 * ---------------------------------------------------------------------------
 */

/** Who was responsible. Drives whether customer contact is even appropriate. */
export const Fault = {
  CUSTOMER: 'CUSTOMER',   // they abandoned, insufficient funds, wrong OTP
  INSTRUMENT: 'INSTRUMENT', // their card/mandate is dead or restricted
  BANK: 'BANK',           // issuer declined or was down
  MERCHANT: 'MERCHANT',   // our config, our outage, our risk rule
  UNKNOWN: 'UNKNOWN',
};

export const ROOT_CAUSES = {
  INSUFFICIENT_FUNDS: {
    id: 'INSUFFICIENT_FUNDS',
    label: 'Insufficient funds',
    fault: Fault.CUSTOMER,
    retryCanSucceed: true,
    // The binding constraint is *when*, not *whether*. Balance is a time series.
    timingSensitive: true,
    // Salary credits cluster at month start in India; retrying on the 3rd beats
    // retrying on the 27th. This is the single biggest timing lever we have.
    prefersSalaryWindow: true,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: false, // no rail creates money
    needsNewInstrument: false,
    explanation:
      'The account did not have the balance at the time of the charge. Retrying ' +
      'minutes later hits the same empty balance; retrying near a credit event ' +
      'materially changes the odds.',
  },

  ISSUER_DOWNTIME: {
    id: 'ISSUER_DOWNTIME',
    label: 'Issuer or gateway downtime',
    fault: Fault.BANK,
    retryCanSucceed: true,
    timingSensitive: true,
    prefersSalaryWindow: false,
    automationAllowed: true,
    // Deliberately false. This was an outage, not a customer failure. Telling the
    // customer "your payment failed" blames them for someone else's downtime and
    // spends goodwill we will need later.
    messagingAppropriate: false,
    railSwitchHelps: true, // a different rail may be up
    needsNewInstrument: false,
    explanation:
      'The bank or gateway was unavailable. Retrying while still down consumes an ' +
      'attempt for nothing; retrying after recovery usually succeeds. Do not ' +
      'contact the customer about our outage.',
  },

  AUTH_NOT_COMPLETED: {
    id: 'AUTH_NOT_COMPLETED',
    label: '3DS / OTP not completed',
    fault: Fault.CUSTOMER,
    // A retry cannot fix a human who closed the tab. Only a fresh prompt can.
    retryCanSucceed: false,
    timingSensitive: false,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    // UPI has materially fewer steps than a card 3DS flow, so nudging rail is a
    // real intervention here rather than a cosmetic one.
    railSwitchHelps: true,
    needsNewInstrument: false,
    explanation:
      'The customer started the payment but did not finish authentication. ' +
      'Re-charging the same instrument cannot help because nothing was wrong with ' +
      'it — the person walked away. Send a fresh link, ideally on a shorter rail.',
  },

  EXPIRED_INSTRUMENT: {
    id: 'EXPIRED_INSTRUMENT',
    label: 'Expired or invalid instrument',
    fault: Fault.INSTRUMENT,
    // The headline case. Zero, not small.
    retryCanSucceed: false,
    timingSensitive: false,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: true,
    needsNewInstrument: true,
    explanation:
      'The card is expired, blocked or invalid. Retry success probability is ' +
      'exactly zero — no amount of patience fixes a dead card. The only path to ' +
      'recovery is collecting a new instrument.',
  },

  MANDATE_REVOKED: {
    id: 'MANDATE_REVOKED',
    label: 'Mandate revoked or paused',
    fault: Fault.CUSTOMER,
    retryCanSucceed: false,
    timingSensitive: false,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: false,
    needsNewInstrument: true, // needs re-authorisation specifically
    requiresReauth: true,
    explanation:
      'The recurring mandate is no longer active. Charging against a revoked ' +
      'mandate is not just futile, it is a violation of the authorisation the ' +
      'customer gave. Recovery requires a fresh re-authorisation.',
  },

  RISK_BLOCKED: {
    id: 'RISK_BLOCKED',
    label: 'Blocked by risk or fraud controls',
    fault: Fault.MERCHANT,
    retryCanSucceed: false,
    timingSensitive: false,
    prefersSalaryWindow: false,
    // The hard one. No automated action of any kind.
    automationAllowed: false,
    messagingAppropriate: false,
    railSwitchHelps: false,
    needsNewInstrument: false,
    humanOnly: true,
    explanation:
      'A risk control rejected this payment. An agent that retries it is an agent ' +
      'that silently overrides a fraud control, which is a compliance incident ' +
      'regardless of outcome. Route to a human; take no automated action.',
  },

  LIMIT_EXCEEDED: {
    id: 'LIMIT_EXCEEDED',
    label: 'Per-transaction or velocity limit exceeded',
    fault: Fault.INSTRUMENT,
    // Same amount on the same rail will fail identically.
    retryCanSucceed: false,
    timingSensitive: true, // daily limits reset
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: true, // different rails have different caps
    needsNewInstrument: false,
    explanation:
      'The amount breached a limit on the instrument. Retrying the identical ' +
      'amount on the identical rail reproduces the identical failure. Either wait ' +
      'for a limit reset or move to a rail with a higher cap.',
  },

  DO_NOT_HONOUR: {
    id: 'DO_NOT_HONOUR',
    label: 'Do-not-honour / generic bank decline',
    fault: Fault.BANK,
    // Genuinely ambiguous: sometimes transient, sometimes a soft block. Weakly
    // retryable, which is precisely why it needs a *bounded* number of attempts
    // rather than either blind persistence or blanket surrender.
    retryCanSucceed: true,
    timingSensitive: true,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: true,
    needsNewInstrument: false,
    explanation:
      'The bank declined without telling us why. This is the genuinely uncertain ' +
      'bucket: sometimes transient, sometimes a soft block. Deserves a small ' +
      'bounded number of retries and then a rail switch, never open-ended retrying.',
  },

  INVOICE_FORGOTTEN: {
    id: 'INVOICE_FORGOTTEN',
    label: 'Invoice overdue, undisputed',
    fault: Fault.CUSTOMER,
    retryCanSucceed: false, // nothing to retry; there is no failed charge
    timingSensitive: false,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: true,
    railSwitchHelps: false,
    needsNewInstrument: false,
    isReceivable: true,
    explanation:
      'A receivable is past due with no dispute on record. This is an attention ' +
      'problem, not a capability problem, and responds to a graduated reminder ' +
      'ladder rather than to pressure.',
  },

  INVOICE_DISPUTED: {
    id: 'INVOICE_DISPUTED',
    label: 'Invoice disputed',
    fault: Fault.UNKNOWN,
    retryCanSucceed: false,
    timingSensitive: false,
    prefersSalaryWindow: false,
    // Automation freeze. Chasing a disputed invoice with reminder #4 is how you
    // turn a billing disagreement into a lost account.
    automationAllowed: false,
    messagingAppropriate: false,
    railSwitchHelps: false,
    needsNewInstrument: false,
    isReceivable: true,
    humanOnly: true,
    explanation:
      'The customer has raised a dispute. Automated chasing cannot resolve a ' +
      'disagreement about what is owed, and each additional reminder actively ' +
      'damages the relationship. Freeze automation and hand to a human.',
  },

  UNKNOWN: {
    id: 'UNKNOWN',
    label: 'Unclassified',
    fault: Fault.UNKNOWN,
    // The safe default. Note it is conservative on every axis.
    retryCanSucceed: true, // allow a single cautious attempt
    timingSensitive: false,
    prefersSalaryWindow: false,
    automationAllowed: true,
    messagingAppropriate: false, // do not message on a guess
    railSwitchHelps: false,
    needsNewInstrument: false,
    isFallback: true,
    explanation:
      'We could not confidently classify this failure. Deliberately conservative: ' +
      'at most one cautious retry, no customer contact. We would rather leave ' +
      'money on the table than take a money-moving action we cannot explain.',
  },
};

export const ROOT_CAUSE_IDS = Object.keys(ROOT_CAUSES);

/** Classes where NO automated action is permitted — human queue only. */
export const HUMAN_ONLY_CAUSES = ROOT_CAUSE_IDS.filter((id) => ROOT_CAUSES[id].humanOnly);

/** Classes where retrying the same instrument can never succeed. */
export const NEVER_RETRY_CAUSES = ROOT_CAUSE_IDS.filter((id) => !ROOT_CAUSES[id].retryCanSucceed);

export function getRootCause(id) {
  return ROOT_CAUSES[id] ?? ROOT_CAUSES.UNKNOWN;
}

/**
 * DETERMINISTIC RULE TABLE
 * ------------------------
 * Tier 1 of diagnosis. Matched against Razorpay's structured error fields, most
 * specific first: error_reason, then (error_source, error_step), then free-text.
 *
 * Rules are tried in order and the first match wins, so ordering is semantic:
 * the compliance-critical classes (risk, mandate) sit above the ambiguous ones
 * so they can never be swallowed by a looser pattern below.
 *
 * Anything unmatched here goes to Tier 2 (LLM, closed-label) and then to UNKNOWN.
 * We never guess in this file.
 */
export const RULE_TABLE = [
  // --- Compliance-critical: must match before anything more general ---
  { cause: 'RISK_BLOCKED', reason: ['risk_threshold_breached', 'payment_risk_check_failed', 'suspected_fraud'] },
  { cause: 'RISK_BLOCKED', textAny: ['risk', 'fraud', 'blocked by', 'security check'] },

  { cause: 'MANDATE_REVOKED', reason: ['mandate_revoked', 'mandate_cancelled', 'mandate_paused', 'subscription_mandate_not_active'] },
  { cause: 'MANDATE_REVOKED', textAny: ['mandate', 'e-mandate', 'emandate', 'autopay revoked', 'standing instruction'] },

  // --- Unambiguous technical classes ---
  { cause: 'EXPIRED_INSTRUMENT', reason: ['card_expired', 'invalid_card', 'card_blocked', 'card_disabled', 'invalid_card_number'] },
  { cause: 'EXPIRED_INSTRUMENT', textAny: ['expired', 'card is blocked', 'invalid card', 'card not supported'] },

  { cause: 'INSUFFICIENT_FUNDS', reason: ['insufficient_funds', 'insufficient_balance'] },
  { cause: 'INSUFFICIENT_FUNDS', textAny: ['insufficient fund', 'insufficient balance', 'not enough balance', 'low balance'] },

  { cause: 'LIMIT_EXCEEDED', reason: ['payment_limit_exceeded', 'card_limit_exceeded', 'velocity_limit_exceeded', 'amount_exceeds_limit'] },
  { cause: 'LIMIT_EXCEEDED', textAny: ['limit exceeded', 'exceeds the limit', 'transaction limit', 'daily limit'] },

  { cause: 'ISSUER_DOWNTIME', reason: ['gateway_technical_error', 'bank_technical_error', 'issuer_down', 'gateway_timeout', 'payment_timeout', 'server_error'] },
  { cause: 'ISSUER_DOWNTIME', source: ['bank', 'gateway'], step: ['payment_authorization', 'payment_initiation'], textAny: ['timeout', 'unavailable', 'technical', 'try again later', 'down'] },
  { cause: 'ISSUER_DOWNTIME', textAny: ['gateway timeout', 'bank is not responding', 'temporarily unavailable', 'technical error'] },

  { cause: 'AUTH_NOT_COMPLETED', reason: ['payment_cancelled', 'payment_abandoned', 'otp_not_entered', 'otp_incorrect', 'otp_expired', 'three_ds_authentication_failed', 'authentication_failed', 'user_cancelled'] },
  { cause: 'AUTH_NOT_COMPLETED', source: ['customer'], step: ['payment_authentication'] },
  { cause: 'AUTH_NOT_COMPLETED', textAny: ['otp', '3ds', 'authentication', 'cancelled by user', 'abandoned'] },

  // --- Deliberately last: the catch-all bank decline. Anything that reaches
  //     here is genuinely ambiguous, and is treated as such by the policy. ---
  { cause: 'DO_NOT_HONOUR', reason: ['payment_failed', 'do_not_honour', 'transaction_not_permitted', 'declined_by_bank'] },
  { cause: 'DO_NOT_HONOUR', textAny: ['do not honour', 'do not honor', 'declined', 'refused by bank'] },
];

/** Receivable-specific rules; invoices have no gateway error to inspect. */
export const INVOICE_RULE_TABLE = [
  { cause: 'INVOICE_DISPUTED', flagAny: ['dispute_raised', 'query_raised', 'short_payment_claim', 'goods_rejected'] },
  { cause: 'INVOICE_DISPUTED', textAny: ['dispute', 'discrepancy', 'wrong amount', 'not received', 'quality issue', 'raised a query'] },
  { cause: 'INVOICE_FORGOTTEN', default: true },
];
