/**
 * THE LIVE-CHECK COMMAND, EXERCISED WITHOUT A NETWORK OR A KEY.
 *
 * `npm run live-check` is the one command in this project that is meant to be run by hand,
 * against real credentials, probably once, possibly while a judge is watching. That makes it
 * the single worst place for an undefined variable — and the hardest thing to iterate on,
 * because every run costs a round trip and creates records on a real account.
 *
 * So it runs here first, against `test/fakeRazorpay.js`, on every commit.
 *
 * The distinction this test is careful about: it verifies the *script* — the arguments, the
 * control flow, the ledger, the abort paths, the redaction, the evidence file. It says nothing
 * about whether my beliefs about Razorpay are correct, because it checks them against the fake
 * that encodes those same beliefs. A run here where every belief is CONFIRMED means "the
 * script works", never "Razorpay agrees with me". Only the real run can say the second thing,
 * which is exactly why the real run exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, setSink } from '../src/razorpay/cli/live-check.js';
import { createFakeRazorpay } from './fakeRazorpay.js';

// Deliberately key-shaped, so the redaction assertions below are testing the real regex
// rather than a string that happens not to look like a credential.
const KEY_ID = 'rzp_test_LiveCheckFake01';
const KEY_SECRET = 'aSecretThatMustNeverBePrinted';

/**
 * A path that does not exist, passed as `envPath` on every run.
 *
 * Without it, `loadEnv()` finds the operator's real `.env` and pulls genuine Razorpay
 * credentials into the test process. Nothing would leak — every path here is redacted — but a
 * test suite has no business reading a developer's secrets, and a test that behaves
 * differently depending on whether someone has configured their machine is not a test.
 */
const NO_ENV = join(tmpdir(), 'rebound-no-such-env-file');

const tmp = () => `${mkdtempSync(join(tmpdir(), 'rebound-evidence-'))}/`;

/**
 * Run the CLI against the fake. Returns everything printed plus the ledger, so a test can
 * assert on both the outcome and the operator-facing output.
 *
 * Note it injects `fetchImpl` rather than a finished client: the credential wiring between
 * `main` and `createRazorpayClient` is part of what needs testing, and it was in fact broken
 * the first time this file ran.
 */
async function runCli({ argv = [], fake = createFakeRazorpay(), env = {} } = {}) {
  const lines = [];
  setSink((s) => lines.push(String(s)));

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  Object.assign(process.env, env);

  const evidenceDir = tmp();
  try {
    const out = await main({
      argv,
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
      evidenceDir,
      envPath: NO_ENV,
    });
    return { ...out, lines, output: lines.join('\n'), fake, evidenceDir };
  } finally {
    setSink(null);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const byId = (results, id) => results.find((r) => r.id === id);

// ---------------------------------------------------------------- the happy path

test('the whole command runs end to end and exits 0', async () => {
  const { code, results } = await runCli();
  assert.equal(code, 0, 'a clean run against the fake must exit 0');
  assert.ok(results.length >= 7, `expected at least 7 belief checks, got ${results.length}`);
  const notHeld = results.filter((r) => !r.held);
  assert.deepEqual(
    notHeld.map((r) => r.id),
    [],
    'against the fake, every belief should hold — the fake encodes these beliefs by construction'
  );
});

test('every load-bearing belief is actually checked, not just the easy ones', async () => {
  const { results } = await runCli();
  for (const id of ['REDACT', 'AUTH', 'CREATE', 'B1', 'B1b', 'B2', 'B3a', 'B3b', 'JOIN', 'RETRY_HONEST']) {
    assert.ok(byId(results, id), `check ${id} did not run`);
  }
});

/**
 * B1 and B1b were one check until the first real run, and merging them produced a sentence
 * that was simply false: a refused duplicate whose lookup failed printed "idempotency is NOT
 * provided remotely", which is a claim about Razorpay contradicted by the very response being
 * reported. They stay split, and only the provider-behaviour half is fatal.
 */
test('a refused duplicate that cannot be located fails B1b but not B1', async () => {
  const fake = createFakeRazorpay();
  const noLookup = {
    ...fake,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      // Uniqueness still enforced; the reference_id filter simply returns nothing, which is
      // the world where GET /payment_links?reference_id= does not filter the way I assume.
      if ((init?.method ?? 'GET') === 'GET' && u.pathname.endsWith('/payment_links') && u.searchParams.get('reference_id')) {
        return { ok: true, status: 200, headers: new Map(), json: async () => ({ count: 0, entity: 'collection', items: [] }), text: async () => '{"count":0,"items":[]}' };
      }
      return fake.fetchImpl(url, init);
    },
  };

  const { results } = await runCli({ fake: noLookup });
  assert.equal(byId(results, 'B1').held, true, 'Razorpay DID refuse the duplicate — that belief holds');
  assert.equal(byId(results, 'B1b').held, false, 'but the lookup did not resolve it');
  assert.match(byId(results, 'B1').detail, /refused/);
  assert.ok(
    !byId(results, 'B1').detail.includes('NOT provided remotely'),
    'the old merged check said this, and it was false'
  );
});

/**
 * The ordering matters and is not cosmetic. Redaction is verified before any request is made,
 * so that a broken redactor cannot print a credential while "helpfully" logging the first
 * call. Auth is verified before anything is created, so a wrong key fails without leaving
 * half-finished records on the account.
 */
test('redaction is checked before the first request, and auth before the first create', async () => {
  const { results } = await runCli();
  const order = results.map((r) => r.id);
  assert.equal(order[0], 'REDACT', 'redaction must be proven before anything is sent');
  assert.equal(order[1], 'AUTH', 'auth must be proven before anything is created');
  assert.ok(order.indexOf('AUTH') < order.indexOf('CREATE'));
});

// ---------------------------------------------------------------- secrecy

test('neither the key nor the secret appears anywhere in the output', async () => {
  const { output } = await runCli();
  assert.ok(!output.includes(KEY_SECRET), 'the key SECRET leaked into the operator output');
  assert.ok(!output.includes(KEY_ID), 'the full key id leaked into the operator output');
  // The prefix is intentional: enough to confirm which key was used, never enough to use it.
  assert.ok(output.includes('rzp_test_Liv'), 'the key prefix should be shown so the operator can confirm the key');
});

test('nor in the evidence file, which is meant to be committable', async () => {
  const { evidenceDir } = await runCli();
  const files = readdirSync(evidenceDir);
  assert.equal(files.length, 1, 'exactly one evidence file per run');
  const raw = readFileSync(join(evidenceDir, files[0]), 'utf8');
  assert.ok(!raw.includes(KEY_SECRET), 'the secret reached a file intended for git');
  assert.ok(!raw.includes(KEY_ID));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.mode, 'LIVE_TEST');
  assert.ok(Array.isArray(parsed.results) && parsed.results.length > 0);
  assert.ok(Array.isArray(parsed.httpCalls) && parsed.httpCalls.length > 0, 'the HTTP log is the evidence');
});

// ---------------------------------------------------------------- default is silence

/**
 * A script that messages a real person the first time someone runs it is a script I would
 * regret committing. The default has to be that nothing is dispatched.
 */
test('by default no email or SMS is dispatched', async () => {
  const { fake } = await runCli();
  for (const link of fake.links.values()) {
    assert.deepEqual(link.notify, { sms: false, email: false }, 'the default run must not message anyone');
  }
});

test('--notify-email opts in, and only for email', async () => {
  const { fake } = await runCli({ argv: ['--notify-email', 'someone@example.com'] });
  const notifying = [...fake.links.values()].filter((l) => l.notify.email || l.notify.sms);
  assert.ok(notifying.length >= 1, 'the flag should have enabled a notification');
  for (const link of notifying) assert.equal(link.notify.sms, false, 'email opt-in must not also enable SMS');
});

// ---------------------------------------------------------------- failure paths

test('a failed auth aborts before creating anything on the account', async () => {
  const fake = createFakeRazorpay();
  fake.faults.failNextWith = { status: 401, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } } };

  const { code, results, output } = await runCli({ fake });
  assert.equal(code, 1);
  assert.equal(byId(results, 'AUTH').held, false);
  assert.equal(byId(results, 'CREATE'), undefined, 'nothing should have been created after an auth failure');
  assert.equal(fake.links.size, 0, 'and above all, no records left behind on the account');
  assert.match(output, /Aborting: authentication failed/);
});

test('a contradicted load-bearing belief exits non-zero, so this can gate a commit', async () => {
  // A fake that does NOT enforce unique reference_id — i.e. the world in which my
  // idempotency story is false. The command must notice and fail loudly.
  const fake = createFakeRazorpay();
  const permissive = {
    ...fake,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if ((init?.method ?? 'GET') === 'POST' && u.pathname.endsWith('/payment_links')) {
        const body = JSON.parse(init.body);
        // Mutate the reference so the fake's uniqueness index never sees a collision.
        body.reference_id = `${body.reference_id}_${Math.random().toString(36).slice(2, 6)}`;
        return fake.fetchImpl(url, { ...init, body: JSON.stringify(body) });
      }
      return fake.fetchImpl(url, init);
    },
  };

  const { code, results } = await runCli({ fake: permissive });
  assert.equal(byId(results, 'B1').held, false, 'B1 must fail when duplicates are permitted');
  assert.equal(code, 1, 'a contradicted load-bearing belief has to be a non-zero exit');
});

test('--reconcile reports a paid link as recovered, with the amount that actually arrived', async () => {
  // First half: create a link, exactly as the operator's first command does.
  const fake = createFakeRazorpay();
  const first = await runCli({ fake });
  const linkId = [...fake.links.keys()][0];
  assert.ok(linkId, 'the first run should have created a link');

  // The human step, stood in for: pay it with a test card.
  fake.payLink(linkId);

  // Second half: the command the operator runs afterwards.
  const second = await runCli({ fake, argv: ['--reconcile', linkId] });
  const recovered = byId(second.results, 'RECOVERED');
  assert.equal(second.code, 0);
  assert.equal(recovered.held, true);
  assert.match(recovered.detail, /paid=49900/, 'the reconciled amount must be the amount that arrived');
  assert.ok(first.code === 0);
});

test('--reconcile on an unpaid link says so rather than reporting a recovery', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];

  const { code, results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });
  assert.equal(byId(results, 'RECOVERED').held, false);
  assert.equal(code, 1, 'an unpaid link is not a recovery and must not exit 0');
  assert.match(output, /Not paid yet/);
});

test('--help prints usage and touches nothing', async () => {
  const fake = createFakeRazorpay();
  const { code, results, output } = await runCli({ fake, argv: ['--help'] });
  assert.equal(code, 0);
  assert.equal(results.length, 0, 'help must not perform any checks');
  assert.equal(fake.links.size, 0);
  assert.match(output, /--reconcile/);
});

test('a missing key fails with an instruction rather than a stack trace', async () => {
  const lines = [];
  setSink((s) => lines.push(String(s)));
  const saved = process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_ID;
  try {
    await assert.rejects(
      () => main({ argv: [], evidenceDir: tmp(), envPath: NO_ENV }),
      /Copy \.env\.example to \.env/,
      'the operator should be told what to do, not handed a stack trace'
    );
  } finally {
    setSink(null);
    if (saved !== undefined) process.env.RAZORPAY_KEY_ID = saved;
  }
});

// ---------------------------------------------------------------- the honesty framing

/**
 * The one assertion here that is about wording rather than behaviour, and it is deliberate.
 * The two claims this project makes — "the plumbing works" and "the policy is better" — have
 * different kinds of evidence behind them, and the moment a reader conflates them the honesty
 * argument collapses. So the command restates the boundary every single run, and the test
 * makes that restatement load-bearing rather than a comment someone can quietly delete.
 */
test('the run states what it does not prove', async () => {
  const { output } = await runCli();
  assert.match(output, /says NOTHING about whether the/i);
  assert.match(output, /measured in simulation/i);
});
