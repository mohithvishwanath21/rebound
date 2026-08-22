import test from 'node:test';
import assert from 'node:assert/strict';
import { createRazorpayClient, redact, maskContact } from '../src/razorpay/httpClient.js';
import {
  RazorpayAuthError,
  RazorpayValidationError,
  RazorpayNotFoundError,
  RazorpayRateLimitError,
  RazorpayServerError,
  RazorpayUnknownOutcomeError,
  RazorpayProtocolError,
  RazorpayDuplicateError,
  isDuplicateReference,
} from '../src/razorpay/errors.js';

/**
 * The point of this file: the live Razorpay client is NOT untested code. Every branch
 * that decides "retry or not" runs here, offline, against a fake `fetch` that mimics
 * Razorpay's documented response envelopes. The only thing left unverified after this is
 * the network hop and whether my fakes match reality — which is precisely what
 * `npm run live-check` exists to settle.
 */

const KEY_ID = 'rzp_test_FAKE1234567890';
const KEY_SECRET = 'fakeSecretDoNotUse';

/** A minimal stand-in for the parts of a fetch Response this client touches. */
function makeRes(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => lower[k.toLowerCase()] ?? null,
      forEach: (fn) => Object.entries(lower).forEach(([k, v]) => fn(v, k)),
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** Records every call and replays a scripted sequence of responses (or throws). */
function scriptedFetch(steps) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    return step;
  };
  impl.calls = calls;
  return impl;
}

function client(fetchImpl, opts = {}) {
  const sleeps = [];
  const c = createRazorpayClient({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms), // no wall-clock time in tests
    rng: () => 0.5, // deterministic jitter
    ...opts,
  });
  c.__sleeps = sleeps;
  return c;
}

const ERR = (code, description, extra = {}) => ({ error: { code, description, ...extra } });

// -------------------------------------------------------------- construction

test('refuses to start without credentials, and says where they go', () => {
  assert.throws(() => createRazorpayClient({}), /RAZORPAY_KEY_ID/);
  assert.throws(() => createRazorpayClient({ keyId: KEY_ID }), /RAZORPAY_KEY_SECRET/);
});

test('refuses a LIVE key outright', () => {
  assert.throws(
    () => createRazorpayClient({ keyId: 'rzp_live_REAL123', keySecret: 'x' }),
    /LIVE key/,
    'a live key must be a hard stop, not a warning'
  );
});

test('exposes only a key prefix, never the full key or the secret', () => {
  const c = client(scriptedFetch([makeRes(200, {})]));
  assert.equal(c.keyIdPrefix, 'rzp_test_FAK');
  assert.equal(JSON.stringify(c).includes(KEY_SECRET), false);
});

// ------------------------------------------------------------ request shaping

test('GET builds the URL with query params and sends basic auth', async () => {
  const f = scriptedFetch([makeRes(200, { count: 0, items: [] })]);
  await client(f).get('/payment_links', { query: { reference_id: 'rbd_1', skipMe: undefined } });

  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.razorpay.com/v1/payment_links?reference_id=rbd_1');
  assert.equal(init.method, 'GET');
  const expected = 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  assert.equal(init.headers.Authorization, expected);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, undefined, 'a GET must not carry a body');
});

test('POST serialises the body as JSON', async () => {
  const f = scriptedFetch([makeRes(200, { id: 'plink_1' })]);
  await client(f).post('/payment_links', { body: { amount: 250000, currency: 'INR' } });
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { amount: 250000, currency: 'INR' });
});

test('a successful response returns the parsed body and the request id', async () => {
  const f = scriptedFetch([makeRes(200, { id: 'plink_1' }, { 'X-Razorpay-Request-Id': 'req_abc' })]);
  const res = await client(f).get('/payment_links/plink_1');
  assert.deepEqual(res.body, { id: 'plink_1' });
  assert.equal(res.requestId, 'req_abc');
});

// ------------------------------------------------------------- error mapping

test('maps each status onto the error type the caller branches on', async () => {
  const cases = [
    [401, ERR('BAD_REQUEST_ERROR', 'Authentication failed'), RazorpayAuthError],
    [403, ERR('BAD_REQUEST_ERROR', 'Forbidden'), RazorpayAuthError],
    [404, ERR('BAD_REQUEST_ERROR', 'The requested URL was not found'), RazorpayNotFoundError],
    [400, ERR('BAD_REQUEST_ERROR', 'amount must be at least 100'), RazorpayValidationError],
    [500, ERR('SERVER_ERROR', 'We are unable to process'), RazorpayServerError],
  ];
  for (const [status, body, Type] of cases) {
    const f = scriptedFetch([makeRes(status, body)]);
    await assert.rejects(client(f).get('/x'), (e) => {
      assert.ok(e instanceof Type, `${status} should map to ${Type.name}, got ${e.name}`);
      assert.equal(e.status, status);
      return true;
    });
  }
});

test('a duplicate reference_id becomes its own error type, not a generic 400', async () => {
  const f = scriptedFetch([
    makeRes(400, ERR('BAD_REQUEST_ERROR', 'Payment link with the given reference id already exists')),
  ]);
  await assert.rejects(client(f).post('/payment_links', { body: {} }), RazorpayDuplicateError);
});

test('duplicate detection matches the documented reason as well as the prose', () => {
  assert.equal(isDuplicateReference({ reason: 'duplicate_reference_id' }), true);
  assert.equal(isDuplicateReference({ description: 'Reference id already exists' }), true);
  assert.equal(isDuplicateReference({ description: 'A duplicate reference id was supplied' }), true);
  // Must NOT swallow unrelated validation failures — a false positive here would report a
  // real rejection as a successful replay.
  assert.equal(isDuplicateReference({ description: 'amount must be at least 100' }), false);
  assert.equal(isDuplicateReference({ description: 'The id provided does not exist' }), false);
  assert.equal(isDuplicateReference({}), false);
});

test('a 2xx with a non-JSON body is an unknown outcome, never a success', async () => {
  const f = scriptedFetch([makeRes(200, '<html>maintenance</html>')]);
  await assert.rejects(client(f).get('/x'), RazorpayProtocolError);
});

test('a timeout is an unknown outcome and says so explicitly', async () => {
  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' });
  const f = scriptedFetch([timeout]);
  await assert.rejects(client(f).post('/payment_links', { body: {} }), (e) => {
    assert.ok(e instanceof RazorpayUnknownOutcomeError);
    assert.equal(e.outcomeKnown, false, 'the caller must be able to see that we do not know');
    assert.equal(e.code, 'TIMEOUT');
    return true;
  });
});

test('a DNS/TLS failure is also an unknown outcome', async () => {
  const f = scriptedFetch([new TypeError('fetch failed')]);
  await assert.rejects(client(f).get('/x'), (e) => {
    assert.ok(e instanceof RazorpayUnknownOutcomeError);
    assert.equal(e.code, 'NETWORK');
    return true;
  });
});

// -------------------------------------------------------------- retry policy

test('a 500 on a GET is retried up to maxAttempts', async () => {
  const f = scriptedFetch([makeRes(500, ERR('SERVER_ERROR', 'boom'))]);
  const c = client(f, { maxAttempts: 3 });
  await assert.rejects(c.get('/x'), RazorpayServerError);
  assert.equal(f.calls.length, 3);
  assert.equal(c.__sleeps.length, 2, 'sleeps happen between attempts, not after the last');
});

test('a 500 then a 200 succeeds without surfacing the error', async () => {
  const f = scriptedFetch([makeRes(500, ERR('SERVER_ERROR', 'boom')), makeRes(200, { id: 'plink_1' })]);
  const res = await client(f).get('/x');
  assert.equal(res.body.id, 'plink_1');
  assert.equal(f.calls.length, 2);
});

/** The single most important assertion in this file. */
test('a 500 on a NON-idempotent POST is not retried — one attempt only', async () => {
  const f = scriptedFetch([makeRes(500, ERR('SERVER_ERROR', 'boom'))]);
  await assert.rejects(client(f).post('/payments/pay_1/capture', { body: {}, safeToRetry: false }), RazorpayServerError);
  assert.equal(f.calls.length, 1, 'retrying a non-idempotent write risks a double charge');
});

test('a timeout on a NON-idempotent POST is not retried', async () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const f = scriptedFetch([timeout]);
  await assert.rejects(client(f).post('/x', { body: {}, safeToRetry: false }), RazorpayUnknownOutcomeError);
  assert.equal(f.calls.length, 1);
});

test('a timeout IS retried when the call carries an idempotency guarantee', async () => {
  const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
  const f = scriptedFetch([timeout, makeRes(200, { id: 'plink_1' })]);
  const res = await client(f).post('/payment_links', { body: {}, safeToRetry: true });
  assert.equal(res.body.id, 'plink_1');
  assert.equal(f.calls.length, 2);
});

test('a 429 IS retried even on a non-idempotent write, because nothing was processed', async () => {
  const f = scriptedFetch([makeRes(429, ERR('RATE_LIMIT', 'too many'), { 'Retry-After': '2' }), makeRes(200, { ok: 1 })]);
  const c = client(f);
  await c.post('/x', { body: {}, safeToRetry: false });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(c.__sleeps, [2000], 'Retry-After must override our own backoff');
});

test('a 429 without Retry-After falls back to jittered backoff', async () => {
  const f = scriptedFetch([makeRes(429, ERR('RATE_LIMIT', 'too many')), makeRes(200, { ok: 1 })]);
  const c = client(f);
  await c.get('/x');
  assert.equal(c.__sleeps.length, 1);
  assert.ok(c.__sleeps[0] > 0 && c.__sleeps[0] <= 250, `expected a first backoff <= base, got ${c.__sleeps[0]}`);
});

test('a 400 is never retried', async () => {
  const f = scriptedFetch([makeRes(400, ERR('BAD_REQUEST_ERROR', 'amount is invalid'))]);
  await assert.rejects(client(f).get('/x'), RazorpayValidationError);
  assert.equal(f.calls.length, 1, 'the same malformed request will fail identically');
});

test('a 401 is never retried', async () => {
  const f = scriptedFetch([makeRes(401, ERR('BAD_REQUEST_ERROR', 'Authentication failed'))]);
  await assert.rejects(client(f).get('/x'), RazorpayAuthError);
  assert.equal(f.calls.length, 1);
});

test('backoff grows between attempts and stays under the cap', async () => {
  const f = scriptedFetch([makeRes(500, ERR('SERVER_ERROR', 'boom'))]);
  const c = client(f, { maxAttempts: 5, backoffBaseMs: 100, backoffFactor: 2, backoffMaxMs: 400 });
  await assert.rejects(c.get('/x'), RazorpayServerError);
  const s = c.__sleeps;
  assert.equal(s.length, 4);
  assert.ok(s[1] > s[0], `expected growth, got ${JSON.stringify(s)}`);
  assert.ok(Math.max(...s) <= 400, `expected cap 400, got ${JSON.stringify(s)}`);
});

// ---------------------------------------------------------------- redaction

/**
 * Note on what this test had to be changed to prove. My first version retried once and
 * then succeeded, and asserted that a redacted key appeared in the logs — it failed,
 * because on the success path the client logs only status/attempt/ms/requestId and never
 * echoes a provider description at all. That's the desired behaviour, but it means the
 * happy path can't demonstrate redaction working. The only line that carries provider
 * prose is `http_giveup`, which logs the normalised error, so that is the path worth
 * pinning: exhaust the attempts, then assert the key came through masked.
 */
test('logs carry status and timing but never a key', async () => {
  const lines = [];
  const f = scriptedFetch([makeRes(500, ERR('SERVER_ERROR', `leaked ${KEY_ID}`))]);
  await assert.rejects(client(f, { onLog: (l) => lines.push(l), maxAttempts: 2 }).get('/payment_links'));

  const dump = JSON.stringify(lines);
  assert.ok(lines.length >= 3, 'expected http, http_retry and http_giveup lines');
  assert.equal(dump.includes(KEY_ID), false, 'the key id must never reach a log line');
  assert.equal(dump.includes(KEY_SECRET), false, 'the key secret must never reach a log line');
  assert.ok(dump.includes('rzp_test_***'), 'a key-shaped string should appear redacted, not removed');
  assert.ok(dump.includes('"status":500'), 'redaction must not cost us the debuggable fields');
  assert.ok(dump.includes('http_giveup'), 'exhausting attempts must be visible in the log');
});

test('redact scrubs keys, auth headers and contact details at any depth', () => {
  const out = redact({
    Authorization: 'Basic cnpwX3Rlc3Q6c2VjcmV0',
    key_secret: 'supersecret',
    note: `created with ${KEY_ID}`,
    customer: { name: 'A Payer', contact: '+919876543210', email: 'payer@example.com' },
    items: [{ email: 'other@example.com' }],
  });
  assert.equal(out.Authorization, '***');
  assert.equal(out.key_secret, '***');
  assert.equal(out.note, 'created with rzp_test_***');
  assert.equal(out.customer.name, 'A Payer', 'names are not secrets; contact details are');
  assert.equal(out.customer.contact, '+91***10');
  assert.equal(out.customer.email, 'pa***@example.com');
  assert.equal(out.items[0].email, 'ot***@example.com');
});

test('maskContact keeps enough to debug and not enough to identify', () => {
  assert.equal(maskContact('+919876543210'), '+91***10');
  assert.equal(maskContact('a@b.com'), 'a***@b.com');
  assert.equal(maskContact('123'), '***');
  assert.equal(maskContact(''), '');
});
