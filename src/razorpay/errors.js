/**
 * NORMALISED GATEWAY ERRORS
 * =========================
 *
 * Razorpay reports failures in three structurally different ways, and the difference
 * matters enormously to a policy that decides whether to retry:
 *
 *   1. An HTTP error with a JSON `error` body   — the API understood us and said no.
 *   2. A non-JSON error page or empty body      — something in front of the API said no.
 *   3. No response at all (DNS, TLS, timeout)   — we never learned what happened.
 *
 * Case 3 is the dangerous one, and it is the reason this file exists. A timeout on a
 * money-moving call is NOT a failure — it is an *unknown*. The charge may well have
 * succeeded. An agent that treats unknown as failed and retries has just double-charged
 * a customer, and it did so while its own audit trail said "the first attempt failed."
 * So `RazorpayUnknownOutcomeError` is a distinct type, it is deliberately NOT retryable
 * without an idempotency guarantee, and the orchestrator is required to reconcile it by
 * asking the API what actually happened rather than by guessing.
 *
 * Everything here maps a provider-shaped failure into one of a handful of decisions the
 * caller can actually take. The rule I'm following: an error type earns its existence
 * only if some caller branches on it.
 */

/** Base class, so `catch (e) { if (e instanceof RazorpayError) ... }` works. */
export class RazorpayError extends Error {
  constructor(message, { code, description, status, requestId, reason, field, retryable, body } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code ?? null;
    this.description = description ?? null;
    this.status = status ?? null;
    this.requestId = requestId ?? null;
    this.reason = reason ?? null;
    this.field = field ?? null;
    this.retryable = Boolean(retryable);
    this.body = body ?? null;
  }

  /**
   * What goes in the audit trail. Never the raw error object — `body` can echo request
   * fields back, and I do not want a key or a customer's contact number reaching a log
   * because someone printed an exception.
   */
  toAudit() {
    return {
      type: this.name,
      code: this.code,
      description: this.description,
      status: this.status,
      requestId: this.requestId,
      reason: this.reason,
      field: this.field,
      retryable: this.retryable,
    };
  }
}

/** 401/403. Keys are wrong, revoked, or live keys pointed at a test flow. Never retry. */
export class RazorpayAuthError extends RazorpayError {}

/** 400/422 with a validation body. Our request was malformed. Never retry — it'll fail identically. */
export class RazorpayValidationError extends RazorpayError {}

/** 404. The resource genuinely isn't there. Never retry. */
export class RazorpayNotFoundError extends RazorpayError {}

/** 429. Retry, but only after honouring Retry-After. */
export class RazorpayRateLimitError extends RazorpayError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true });
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

/** 5xx. The API accepted the request and then broke. Retryable IF the call is idempotent. */
export class RazorpayServerError extends RazorpayError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true });
  }
}

/**
 * We never got a usable response: timeout, aborted socket, DNS failure, TLS failure.
 *
 * `outcomeKnown: false` is the whole point of this class. For a read, unknown is merely
 * annoying and retrying is free. For a write, unknown means the side effect may already
 * exist, so the only safe recoveries are (a) replay with the same idempotency key, or
 * (b) go and look. Anything else risks charging twice.
 */
export class RazorpayUnknownOutcomeError extends RazorpayError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false });
    this.outcomeKnown = false;
    this.cause = opts.cause ?? null;
  }
}

/** A 2xx whose body wasn't the JSON we require. Treated as unknown, not as success. */
export class RazorpayProtocolError extends RazorpayError {}

/**
 * Razorpay rejects a duplicate `reference_id`, which is exactly the behaviour this
 * project uses as its idempotency guarantee (see `liveGateway.js`). Surfacing it as its
 * own type lets the gateway convert "you already did this" into a successful replay
 * instead of an error — which is what the caller means by idempotent.
 */
export class RazorpayDuplicateError extends RazorpayError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false });
    this.duplicate = true;
  }
}

const AUTH_STATUSES = new Set([401, 403]);

/**
 * Turn an HTTP status plus a parsed body into one of the types above.
 *
 * Razorpay's documented error envelope is:
 *   { error: { code, description, source, step, reason, metadata, field } }
 *
 * I match on `reason` and `description` for the duplicate case rather than on a
 * dedicated code, because Razorpay returns a generic BAD_REQUEST_ERROR for it. That's a
 * string match against someone else's copy, which is fragile, so it is pinned by a test
 * and the fallback (a plain validation error) is safe: a failed replay-detect turns an
 * idempotent retry into a visible error, never into a second charge.
 */
export function errorFromResponse({ status, body, headers = {}, requestId = null }) {
  const err = body?.error ?? {};
  const code = err.code ?? null;
  const description = err.description ?? (typeof body === 'string' ? body.slice(0, 200) : null);
  const reason = err.reason ?? null;
  const field = err.field ?? null;
  const base = { code, description, status, requestId, reason, field, body };
  const label = `Razorpay ${status}${code ? ` ${code}` : ''}: ${description ?? 'no description'}`;

  if (AUTH_STATUSES.has(status)) return new RazorpayAuthError(label, base);
  if (status === 404) return new RazorpayNotFoundError(label, base);

  if (status === 429) {
    const raw = headers['retry-after'] ?? headers['Retry-After'];
    const secs = Number(raw);
    return new RazorpayRateLimitError(label, {
      ...base,
      retryAfterMs: Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null,
    });
  }

  if (status >= 500) return new RazorpayServerError(label, base);

  if (isDuplicateReference({ reason, description })) {
    return new RazorpayDuplicateError(label, base);
  }

  if (status >= 400) return new RazorpayValidationError(label, base);

  return new RazorpayProtocolError(label, base);
}

/** Split out so the string-matching heuristic is testable on its own. */
export function isDuplicateReference({ reason, description }) {
  if (reason === 'duplicate_reference_id') return true;
  if (typeof description !== 'string') return false;
  const d = description.toLowerCase();
  return d.includes('reference id') && (d.includes('already') || d.includes('exists') || d.includes('duplicate'));
}

/**
 * The single question the retry loop asks.
 *
 * Non-idempotent calls get one shot, with a single exception: a 429 is refused *before*
 * the request is processed, so no side effect can exist yet and retrying it is safe even
 * for a write. Every other failure mode on a non-idempotent call is left alone.
 *
 * That rule costs us some recoverable rupees on transient 500s, and I'm taking the trade
 * knowingly: a missed retry is a missed rupee, a duplicate charge is a refund, an angry
 * customer and a compliance problem. The costs are not symmetric, so the default should
 * not be either.
 */
export function isRetryable(error, { idempotent = false } = {}) {
  if (!(error instanceof RazorpayError)) return false;
  if (error instanceof RazorpayUnknownOutcomeError) return idempotent;
  if (!error.retryable) return false;
  return idempotent || error instanceof RazorpayRateLimitError;
}
