/**
 * RAZORPAY HTTP CLIENT
 * ====================
 *
 * A ~200 line client over `fetch` instead of the official `razorpay` npm package. That
 * looks like reinvention, so here is the actual reasoning, because I'd be asked:
 *
 *   1. I need six endpoints. The SDK is a thin wrapper over the same REST calls.
 *   2. **I cannot install or execute the SDK in the environment I'm building in.** Using
 *      it would mean shipping code I have never once run, in the one part of the system
 *      whose entire job is to prove "the plumbing works." Hand-rolling it lets me inject
 *      a fake `fetch` and unit-test request construction, auth, retry, backoff, error
 *      mapping and redaction — offline, on every commit. The untested surface shrinks
 *      from "the whole integration" to "the network hop itself," and `npm run live-check`
 *      is the single command that closes that last gap against the real API.
 *   3. Node 20+ ships `fetch`, and the project already requires Node 20 for the test
 *      runner. So this adds no dependency at all.
 *
 * If I were doing this at work with a registry and CI, I'd use the SDK. The tradeoff
 * being made here is specific to being unable to run it.
 *
 * Nothing in this file may log a key, and nothing may log a customer contact detail.
 * `redact()` is applied to everything on the way out, and there is a test that feeds a
 * realistic key through the logger and asserts it doesn't appear.
 */

import {
  RazorpayUnknownOutcomeError,
  RazorpayProtocolError,
  errorFromResponse,
  isRetryable,
} from './errors.js';

const DEFAULT_BASE_URL = 'https://api.razorpay.com/v1';

/** Conservative, and deliberately so — see the note on attempts below. */
export const HTTP_DEFAULTS = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  backoffBaseMs: 250,
  backoffFactor: 2,
  backoffMaxMs: 4_000,
};

/**
 * Strip anything that must never reach a log line, an audit entry or my terminal.
 *
 * Matches on shape (`rzp_test_...`, `rzp_live_...`, base64 basic-auth blobs) rather than
 * on the specific key in memory, so it still works for a key that arrives from somewhere
 * I didn't anticipate. Contact fields are keyed by name.
 */
export function redact(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/rzp_(test|live)_[A-Za-z0-9]+/g, 'rzp_$1_***')
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic ***');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'key_secret' || lower === 'keysecret') {
        out[k] = '***';
      } else if (lower === 'contact' || lower === 'email' || lower === 'phone') {
        out[k] = maskContact(String(v));
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/** Keep enough to debug ("is this the right customer?") and not enough to identify. */
export function maskContact(s) {
  if (!s) return s;
  if (s.includes('@')) {
    const [local, domain] = s.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return s.length <= 4 ? '***' : `${s.slice(0, 3)}***${s.slice(-2)}`;
}

function basicAuth(keyId, keySecret) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

function backoffMs(attempt, cfg, rng) {
  const raw = cfg.backoffBaseMs * Math.pow(cfg.backoffFactor, attempt - 1);
  const capped = Math.min(raw, cfg.backoffMaxMs);
  // Full jitter. Not decoration: retries from a batch run are correlated by construction,
  // because they were all fired by the same sweep over the same due-case list. Without
  // jitter a single Razorpay blip turns into a synchronised thundering herd from us.
  return Math.floor(capped * (0.5 + 0.5 * rng()));
}

/**
 * @param {object} o
 * @param {string} o.keyId        - read from env by the caller, never hardcoded
 * @param {string} o.keySecret
 * @param {function} [o.fetchImpl] - injected in tests; defaults to global fetch
 * @param {function} [o.sleep]     - injected in tests so backoff costs no wall-clock time
 * @param {function} [o.rng]       - injected so jitter is deterministic under test
 * @param {function} [o.onLog]     - receives already-redacted structured log lines
 */
export function createRazorpayClient({
  keyId,
  keySecret,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  rng = Math.random,
  onLog = null,
  ...overrides
} = {}) {
  if (!keyId || !keySecret) {
    throw new Error(
      'Razorpay client needs keyId and keySecret. Put RAZORPAY_KEY_ID and ' +
        'RAZORPAY_KEY_SECRET in .env (see .env.example) — they are never committed.'
    );
  }
  if (keyId.startsWith('rzp_live_')) {
    // A hard stop, not a warning. This project's entire value claim is measured in a
    // simulator; there is no scenario in which it should hold a live key, and the cost of
    // being wrong is real money moving off a real merchant account.
    throw new Error(
      'Refusing to start: RAZORPAY_KEY_ID is a LIVE key. Rebound is test-mode only. ' +
        'Use a key beginning rzp_test_.'
    );
  }

  const cfg = { ...HTTP_DEFAULTS, ...overrides };
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('No fetch available. Node 20+ provides it; otherwise inject fetchImpl.');
  }

  const log = (event, fields) => onLog?.({ event, ...redact(fields) });

  /**
   * @param {'GET'|'POST'|'PATCH'} method
   * @param {string} path      - e.g. '/payment_links'
   * @param {object} [o]
   * @param {object} [o.body]
   * @param {object} [o.query]
   * @param {boolean} [o.safeToRetry] - may this call be retried after an unknown outcome?
   */
  async function request(method, path, { body, query, safeToRetry = method === 'GET' } = {}) {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    let lastError = null;

    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      const startedAt = Date.now();
      try {
        const res = await doFetch(url.toString(), {
          method,
          headers: {
            Authorization: basicAuth(keyId, keySecret),
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'rebound/0.1 (buildathon; test-mode-only)',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });

        const requestId = res.headers?.get?.('x-razorpay-request-id') ?? null;
        const text = await res.text();
        let parsed = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = text;
        }

        log('http', {
          method,
          path,
          status: res.status,
          attempt,
          ms: Date.now() - startedAt,
          requestId,
        });

        if (res.ok) {
          if (parsed === null || typeof parsed !== 'object') {
            // A 2xx we can't parse is NOT a success. The side effect probably happened,
            // so this has to surface as unknown rather than as either outcome.
            throw new RazorpayProtocolError('Razorpay returned 2xx with a non-JSON body', {
              status: res.status,
              requestId,
              body: typeof parsed === 'string' ? parsed.slice(0, 200) : null,
            });
          }
          return { status: res.status, body: parsed, requestId };
        }

        const headers = {};
        res.headers?.forEach?.((v, k) => {
          headers[k.toLowerCase()] = v;
        });
        throw errorFromResponse({ status: res.status, body: parsed, headers, requestId });
      } catch (raw) {
        const err = normaliseThrown(raw);
        lastError = err;

        if (attempt >= cfg.maxAttempts || !isRetryable(err, { safeToRetry })) {
          log('http_giveup', {
            method,
            path,
            attempt,
            error: err.toAudit?.() ?? String(err),
          });
          throw err;
        }

        const wait = err.retryAfterMs ?? backoffMs(attempt, cfg, rng);
        log('http_retry', { method, path, attempt, waitMs: wait, code: err.code });
        await sleep(wait);
      }
    }

    throw lastError; // unreachable; kept so the function has no implicit-undefined path
  }

  return {
    mode: 'LIVE_TEST',
    keyIdPrefix: keyId.slice(0, 12), // enough to confirm which key, never enough to use it
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    patch: (path, opts) => request('PATCH', path, opts),
  };
}

/**
 * Anything thrown that isn't already one of ours becomes an explicit unknown outcome.
 *
 * `fetch` rejects with a bare `TypeError` for DNS and TLS problems and with an
 * `AbortError`/`TimeoutError` for timeouts. All of them share the property that matters:
 * we do not know whether the server acted on our request.
 */
function normaliseThrown(raw) {
  if (raw?.toAudit) return raw; // already a RazorpayError
  const name = raw?.name ?? 'Error';
  const isTimeout = name === 'TimeoutError' || name === 'AbortError';
  return new RazorpayUnknownOutcomeError(
    isTimeout ? `Razorpay request timed out (${name})` : `Razorpay request failed before a response: ${raw?.message ?? name}`,
    { code: isTimeout ? 'TIMEOUT' : 'NETWORK', cause: raw }
  );
}
