/**
 * Tests for the hand-rolled .env loader.
 *
 * Small file, but it is the thing standing between a `.env` on disk and the Razorpay
 * credentials in `process.env`, so the two behaviours worth being sure about are the
 * precedence rule (a real environment variable must win, or a stale file could silently
 * override a CI secret) and the promise that no value is ever echoed in an error.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnv, requireEnv } from '../src/core/env.js';

const writeTmpEnv = (text) => {
  const path = join(mkdtempSync(join(tmpdir(), 'rebound-env-')), '.env');
  writeFileSync(path, text);
  return path;
};

test('parses the ordinary shapes', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'RAZORPAY_KEY_ID=rzp_test_abc123',
      'QUOTED="quoted value"',
      "SINGLE='single quoted'",
      'EXECUTION_MODE=SIM   ',
      'export EXPORTED=works',
    ].join('\n')
  );

  assert.equal(parsed.RAZORPAY_KEY_ID, 'rzp_test_abc123');
  assert.equal(parsed.QUOTED, 'quoted value');
  assert.equal(parsed.SINGLE, 'single quoted');
  assert.equal(parsed.EXECUTION_MODE, 'SIM', 'trailing whitespace should not become part of a value');
  assert.equal(parsed.EXPORTED, 'works');
  assert.equal(Object.keys(parsed).length, 5, 'comments and blank lines are not variables');
});

test('an inline comment is stripped from an unquoted value but kept inside quotes', () => {
  const parsed = parseEnv(['KILL_SWITCH=false # flip this to halt every run', 'NOTE="a # inside quotes stays"'].join('\n'));
  assert.equal(parsed.KILL_SWITCH, 'false', 'a trailing comment must not end up in the value');
  assert.equal(parsed.NOTE, 'a # inside quotes stays');
});

/**
 * A secret is the most likely thing in this file to contain '=' — base64 padding ends in it.
 * Splitting on every '=' rather than the first would corrupt exactly those values, and the
 * symptom would be a confusing 401 rather than an obvious parse error.
 */
test('a value containing = survives intact', () => {
  const parsed = parseEnv('RAZORPAY_WEBHOOK_SECRET=abc==def=');
  assert.equal(parsed.RAZORPAY_WEBHOOK_SECRET, 'abc==def=');
});

test('an existing environment variable is not overridden by the file', () => {
  const path = writeTmpEnv('REBOUND_TEST_PRECEDENCE=from_file\nREBOUND_TEST_FRESH=from_file\n');
  process.env.REBOUND_TEST_PRECEDENCE = 'from_environment';
  delete process.env.REBOUND_TEST_FRESH;
  try {
    const { loaded, keys } = loadEnv({ path });
    assert.equal(loaded, true);
    assert.equal(
      process.env.REBOUND_TEST_PRECEDENCE,
      'from_environment',
      'a variable already set must win — otherwise a stale .env can override a CI secret'
    );
    assert.equal(process.env.REBOUND_TEST_FRESH, 'from_file');
    assert.deepEqual(keys, ['REBOUND_TEST_FRESH'], 'only the keys actually applied are reported');
  } finally {
    delete process.env.REBOUND_TEST_PRECEDENCE;
    delete process.env.REBOUND_TEST_FRESH;
  }
});

test('the returned key list names variables but carries no values', () => {
  const path = writeTmpEnv('REBOUND_TEST_SECRETISH=super_secret_value\n');
  delete process.env.REBOUND_TEST_SECRETISH;
  try {
    const { keys } = loadEnv({ path });
    assert.ok(!JSON.stringify(keys).includes('super_secret_value'), 'this return value ends up in a log line');
  } finally {
    delete process.env.REBOUND_TEST_SECRETISH;
  }
});

test('a missing .env is not an error, because most of this project needs no credentials', () => {
  const { loaded, keys } = loadEnv({ path: join(tmpdir(), 'rebound-definitely-not-here') });
  assert.equal(loaded, false);
  assert.deepEqual(keys, []);
});

test('requireEnv explains what to do and never echoes the bad value', () => {
  process.env.REBOUND_TEST_WRONG = 'rzp_test_thisIsTheWrongValue';
  delete process.env.REBOUND_TEST_ABSENT;
  try {
    assert.throws(() => requireEnv('REBOUND_TEST_ABSENT'), /Copy \.env\.example to \.env/);
    assert.equal(requireEnv('REBOUND_TEST_WRONG'), 'rzp_test_thisIsTheWrongValue');

    // The reflex when a key is rejected is to print what was received. That is how a
    // credential reaches a terminal someone is screen-sharing, so the message must not.
    try {
      requireEnv('REBOUND_TEST_ABSENT', 'It must begin rzp_test_.');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(!e.message.includes('rzp_test_thisIsTheWrongValue'));
      assert.match(e.message, /It must begin rzp_test_\./);
    }
  } finally {
    delete process.env.REBOUND_TEST_WRONG;
  }
});
