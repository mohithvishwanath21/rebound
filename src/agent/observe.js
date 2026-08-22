/**
 * THE OBSERVATION BOUNDARY
 * ========================
 *
 * Everything the agent is allowed to know about an at-risk event passes through this file,
 * and it passes through as an ALLOWLIST.
 *
 * WHY AN ALLOWLIST, WHEN test/boundary.test.js ALREADY EXISTS
 * ----------------------------------------------------------
 * The boundary test is a denylist: it fails the build if agent code mentions
 * `trueRootCause`, `payerType`, `workingRails` and friends. That is genuinely useful and it
 * has a specific hole — it can only catch names I thought of when I wrote the list.
 *
 * I found the hole rather than reasoned my way to it. `buildFailurePayload()` in the
 * generator attaches `_generatedVague` to every failure, with the comment "stripped before
 * the agent sees it." Nothing stripped it. No test enforced it. And it is not in the
 * denylist, because when I wrote the denylist that field did not exist yet.
 *
 * `_generatedVague` is true exactly when the generator deliberately chose an error message
 * the rule table cannot match. An agent that could read it would know in advance which cases
 * are hard — it could abstain on precisely those and post a diagnosis accuracy that no real
 * integration could ever reproduce. That is not a subtle leak. It is the answer key for the
 * only metric Day 4 produces.
 *
 * So the projection below names the fields the agent MAY see, and drops everything else by
 * default. A new field added to the generator tomorrow is invisible to the agent until
 * somebody adds it here on purpose, which is the direction the default should point.
 *
 * The denylist stays. Two mechanisms that fail differently are the point: the allowlist stops
 * data at runtime, the denylist stops *intent* at build time. Neither subsumes the other.
 *
 * WHAT A REAL MERCHANT SEES
 * -------------------------
 * The fields below are exactly what Razorpay hands you on a failed payment, plus the invoice
 * metadata you already have in your own billing system. That correspondence is the point: if
 * the agent needs something that is not in this list, the honest response is that a real
 * deployment would not have it either.
 */

/**
 * Gateway failure fields the agent may read.
 *
 * `errorReason`, `errorSource` and `errorStep` carry most of the diagnostic signal and are
 * confirmed present on real Razorpay payment entities — the 2026-08-22 live run read
 * `error_reason: international_transaction_not_allowed` off a genuine decline.
 *
 * Deliberately absent: `_generatedVague`.
 */
export const OBSERVABLE_FAILURE_FIELDS = Object.freeze([
  'errorCode',
  'errorReason',
  'errorSource',
  'errorStep',
  'errorDescription',
  'method',
  'bank',
  'network',
]);

/** Invoice fields the agent may read. `flags` is only *sometimes* populated on real disputes. */
export const OBSERVABLE_INVOICE_FIELDS = Object.freeze([
  'invoiceNumber',
  'dueDate',
  'termsDays',
  'flags',
]);

/** Event-level fields the agent may read. */
export const OBSERVABLE_EVENT_FIELDS = Object.freeze([
  'eventId',
  'batchId',
  'lossType',
  'customerId',
  'amountPaise',
  'currency',
  'occurredAt',
  'detectedAt',
  'rail',
  'priorAttempts',
  'references',
]);

function project(source, allowed) {
  if (!source || typeof source !== 'object') return null;
  const out = {};
  for (const key of allowed) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * The observable view of one at-risk event.
 *
 * Returns a NEW object every time. It must never return the event itself or a shallow spread
 * of it, because either would carry whatever the generator attaches next.
 */
export function observe(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('observe(event): expected an event object');
  }

  const view = project(event, OBSERVABLE_EVENT_FIELDS) ?? {};

  // `subscription.mandateStatus` is observable and, importantly, only *usually* agrees with
  // the truth — a revoked mandate sometimes still reads 'active' because the status has not
  // propagated. Passing the disagreement through rather than smoothing it is the point.
  if (event.subscription) {
    view.subscription = {
      subscriptionId: event.subscription.subscriptionId,
      cycleNumber: event.subscription.cycleNumber,
      totalCycles: event.subscription.totalCycles,
      mandateStatus: event.subscription.mandateStatus,
    };
  }

  if (event.failure) view.failure = project(event.failure, OBSERVABLE_FAILURE_FIELDS);
  if (event.invoice) view.invoice = project(event.invoice, OBSERVABLE_INVOICE_FIELDS);

  // Observed downtime, which is an ESTIMATE. The true window may extend past it and lives in
  // latent truth. Two names for two different things, kept apart on purpose.
  if (event.downtime) {
    view.downtime = {
      issuerDownAtFailure: Boolean(event.downtime.issuerDownAtFailure),
      observedWindow: event.downtime.observedWindow ?? null,
    };
  }

  return view;
}

/**
 * ONE CANONICAL FAILURE SIGNAL, BECAUSE THE SAME CONCEPT CURRENTLY HAS TWO NAMES
 * -----------------------------------------------------------------------------
 * Razorpay sends `error_reason`. The simulator emits `errorReason`. Both mean the identical
 * thing, and a matcher written against either one silently returns nothing when handed the
 * other — no exception, no warning, just a quiet fall through to UNKNOWN on every case.
 *
 * This project has now been bitten five separate times by one name covering two properties.
 * This is the mirror image: two names covering one property, which fails just as quietly.
 * So the conversion happens exactly here, once, and `diagnose()` accepts nothing else.
 */
export function toFailureSignal(input) {
  if (!input || typeof input !== 'object') return { code: null, reason: null, source: null, step: null, text: '' };

  // Accept an event, an observable view, a bare failure block, or a raw Razorpay payment
  // entity. Anything that reaches here should end up in the same four fields.
  const f = input.failure ?? input;

  const pick = (...names) => {
    for (const n of names) {
      const v = f[n];
      if (typeof v === 'string' && v.length) return v;
    }
    return null;
  };

  return {
    code: pick('errorCode', 'error_code'),
    reason: pick('errorReason', 'error_reason'),
    source: pick('errorSource', 'error_source'),
    step: pick('errorStep', 'error_step'),
    // Free text is matched case-insensitively, so normalise once here rather than at every
    // comparison site.
    text: (pick('errorDescription', 'error_description') ?? '').toLowerCase(),
    method: pick('method'),
  };
}

/** Invoice signal, for receivables where there is no gateway error to read at all. */
export function toInvoiceSignal(input) {
  const inv = input?.invoice ?? input ?? {};
  return {
    flags: Array.isArray(inv.flags) ? inv.flags : [],
    text: String(inv.note ?? inv.notes ?? '').toLowerCase(),
    dueDate: inv.dueDate ?? null,
    termsDays: inv.termsDays ?? null,
  };
}
