/**
 * Tests for the credential doctor.
 *
 * The doctor's entire value proposition is "this output is safe to paste to someone who is
 * helping you debug." That is a security claim, and a security claim that rests on my having
 * been careful while writing string interpolation is not a claim — it is a hope. So the
 * central test here feeds in distinctive, key-shaped values and asserts that no fragment of
 * either one reaches the output, for every category of finding the doctor can produce.
 *
 * The second thing worth testing is the diagnosis itself: each failure mode has to name the
 * right cause, because a diagnostic that says "something is wrong" is only marginally better
 * than the 401 it is explaining.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, setSink } from '../src/razorpay/cli/doctor.js';

// A path that does not exist, so the doctor never reads the operator's real .env during tests.
const NO_ENV = join(tmpdir(), 'rebound-no-such-env-file');

const GOOD_ID = 'rzp_test_29QrsTuVwXyZ01';   // 23 chars, the usual shape
const GOOD_SECRET = 'zYxWvUtSrQpOnMlKjIhGfEdC'; // 24 chars

function runDoctor({ keyId, keySecret, argv = [] } = {}) {
  const lines = [];
  setSink((s) => lines.push(String(s)));
  const saved = { ...process.env };
  if (keyId === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = keyId;
  if (keySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = keySecret;

  try {
    const out = main({ argv, envPath: NO_ENV });
    return { ...out, output: lines.join('\n') };
  } finally {
    setSink(null);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const labels = (results) => results.map((r) => r.label).join(' | ');

// ------------------------------------------------------------ the security claim

/**
 * The important one. Every branch, checked for leakage — not just the happy path, because the
 * error branches are where a helpful `got: ${value}` is most tempting to write.
 */
test('no fragment of the key or secret appears in the output, on any branch', () => {
  const secretBody = 'zYxWvUtSrQpOnMlKjIhGfEdC';
  const cases = [
    { keyId: GOOD_ID, keySecret: secretBody },
    { keyId: GOOD_ID, keySecret: 'short' },
    { keyId: GOOD_ID, keySecret: `rzp_test_swapped${secretBody}` },
    { keyId: secretBody, keySecret: GOOD_ID },
    { keyId: GOOD_ID, keySecret: `${secretBody} with space` },
    { keyId: GOOD_ID, keySecret: `“${secretBody}”` },
    { keyId: 'rzp_live_29QrsTuVwXyZ01', keySecret: secretBody },
    { keyId: GOOD_ID, keySecret: 'zYxW****************EdC' },
    { keyId: undefined, keySecret: secretBody },
    { keyId: GOOD_ID, keySecret: undefined },
  ];

  for (const c of cases) {
    const { output } = runDoctor(c);
    assert.ok(!output.includes(secretBody), `the secret leaked for case ${JSON.stringify(c.keySecret)}`);
    // Any run of 8+ characters from the credential body is too much to reveal.
    for (const value of [c.keyId, c.keySecret].filter(Boolean)) {
      const body = value.replace(/^rzp_(test|live)_/, '');
      for (let i = 0; i + 8 <= body.length; i++) {
        const chunk = body.slice(i, i + 8);
        assert.ok(
          !output.includes(chunk),
          `an 8-char fragment "${chunk}" of a credential reached the output`
        );
      }
    }
    // The fixed prefix is allowed, since every test key shares it and it reveals nothing.
    assert.ok(!/rzp_test_[A-Za-z0-9]/.test(output), 'output showed characters after the rzp_test_ prefix');
  }
});

test('it makes no network call — nothing to mock, and that is the point', () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('the doctor must not make network calls');
  };
  try {
    runDoctor({ keyId: GOOD_ID, keySecret: GOOD_SECRET });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ------------------------------------------------------------ the diagnoses

test('well-formed credentials produce no definite problem', () => {
  const { results, output } = runDoctor({ keyId: GOOD_ID, keySecret: GOOD_SECRET });
  assert.equal(results.filter((r) => r.level.trim() === 'BAD').length, 0, labels(results));
  // With both shapes correct, the remaining explanation is a mismatched pair, and the
  // operator needs to be told that explicitly or they will keep re-checking the same file.
  assert.match(output, /different key pairs/);
});

test('a masked secret copied from the dashboard is identified as exactly that', () => {
  const { results } = runDoctor({ keyId: GOOD_ID, keySecret: 'abcd****************wxyz' });
  const found = results.find((r) => r.label.includes('* or ...'));
  assert.ok(found, labels(results));
  assert.match(found.detail, /shown only once|MASKED/i);
});

test('a swapped pair is called out as swapped rather than as two vague warnings', () => {
  const { results } = runDoctor({ keyId: GOOD_SECRET, keySecret: GOOD_ID });
  assert.ok(results.some((r) => r.label.includes('secret starts with rzp_')), labels(results));
});

test('a truncated secret is flagged by length', () => {
  const { results } = runDoctor({ keyId: GOOD_ID, keySecret: 'zYxWvUtSrQ' });
  const found = results.find((r) => r.label.startsWith('secret length'));
  assert.equal(found.level.trim(), 'HMM');
  assert.match(found.detail, /most common cause of a 401/);
});

/**
 * The real one, from 2026-08-22: a key id two characters short of 23, which produced a 401 with
 * nothing else visibly wrong. Pinned as a test because it is the case this command exists for.
 */
test('a key id two characters short is flagged, and the advice is how to re-copy it', () => {
  // 'rzp_test_' (9) + 12 body chars = 21, i.e. two short of the usual 23.
  const { results } = runDoctor({ keyId: 'rzp_test_29QrsTuVwXyZ', keySecret: GOOD_SECRET });
  const found = results.find((r) => r.label.startsWith('key id length'));
  assert.equal(found.label, 'key id length 21');
  assert.equal(found.level.trim(), 'HMM');
  assert.match(found.detail, /COPY BUTTON/, 'the advice has to be the fix, not just the observation');
});

test('a live key is refused with the reason, not merely warned about', () => {
  const { results } = runDoctor({ keyId: 'rzp_live_29QrsTuVwXyZ01', keySecret: GOOD_SECRET });
  const found = results.find((r) => r.label.includes('LIVE key'));
  assert.equal(found.level.trim(), 'BAD');
});

/**
 * Smart quotes deserve their own test because they are invisible in most editors and produce a
 * 401 that looks identical to a wrong secret — the operator has no way to see the difference.
 */
test('a smart quote from a rich-text copy is detected', () => {
  const { results } = runDoctor({ keyId: GOOD_ID, keySecret: '“zYxWvUtSrQpOnMlKjIhGfEdC”' });
  assert.ok(results.some((r) => r.label.includes('smart')), labels(results));
});

test('a wrapped paste with an inner space is detected', () => {
  const { results } = runDoctor({ keyId: GOOD_ID, keySecret: 'zYxWvUtSrQpO nMlKjIhGfEdC' });
  assert.ok(results.some((r) => r.label.includes('space in the middle')), labels(results));
});

test('a missing variable is reported without inventing shape findings about it', () => {
  const { results } = runDoctor({ keyId: GOOD_ID, keySecret: undefined });
  assert.ok(results.some((r) => r.label.includes('KEY_SECRET is not set')));
  assert.ok(!results.some((r) => r.label.startsWith('secret length')), 'nothing to measure, so measure nothing');
});

test('--help explains itself and checks nothing', () => {
  const { results, output } = runDoctor({ keyId: GOOD_ID, keySecret: GOOD_SECRET, argv: ['--help'] });
  assert.deepEqual(results, []);
  assert.match(output, /no network/i);
});

/**
 * The exit code is deliberately 0 even when findings exist. A diagnostic that exits non-zero
 * reads, in a terminal, as "the diagnostic is broken" — and npm decorates it with its own error
 * block, which buries the actual advice under noise. live-check is the command that gates.
 */
test('the doctor exits 0 even when it finds a definite problem', () => {
  const { code, results } = runDoctor({ keyId: GOOD_SECRET, keySecret: GOOD_ID });
  assert.ok(results.some((r) => r.level.trim() === 'BAD'));
  assert.equal(code, 0);
});
