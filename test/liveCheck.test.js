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
  // No check in the default run depends on a human doing anything, so nothing may be PENDING.
  // If one ever is, the run is claiming less than it looks like it is claiming.
  assert.deepEqual(
    results.filter((r) => r.pending).map((r) => r.id),
    []
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
      // the world where GET /payment_links?reference_id= does not resolve our link.
      // Response shape mirrors the fake's own — text(), no json() — since the client parses text.
      if ((init?.method ?? 'GET') === 'GET' && u.pathname.endsWith('/payment_links') && u.searchParams.get('reference_id')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null, forEach: () => {} },
          text: async () => JSON.stringify({ count: 0, entity: 'collection', payment_links: [] }),
        };
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

/**
 * "Not paid yet" and "my belief about Razorpay is false" are different facts, and the first
 * version of this reported the first as the second — it printed "1 load-bearing belief
 * contradicted. Fix the code, not the fake." at an operator whose actual next step was to open
 * a URL and type a card number. That is the worst kind of wrong output: confident, specific,
 * and pointing away from the fix.
 *
 * So this asserts three separate things, because the bug could come back through any of them:
 * the ledger state is PENDING rather than false, the exit code is neither 0 nor 1, and the
 * fix-the-code sentence does not appear.
 */
test('--reconcile on an unpaid link reports PENDING, not a contradicted belief', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];

  const { code, results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });
  const recovered = byId(results, 'RECOVERED');

  assert.equal(recovered.pending, true, 'an unpaid link means the check could not run, not that it failed');
  assert.equal(recovered.held, null, 'held must be null — neither confirmed nor contradicted');
  assert.equal(code, 2, 'not 0 (nothing was proven) and not 1 (nothing was contradicted)');
  assert.match(output, /Not paid yet/);
  assert.match(output, /PENDING/, 'the operator-facing tag must be its own state, not CONTRADICTED');
  assert.ok(
    !/Fix the code, not the fake/.test(output),
    'this advice is actively wrong here — the fix is to pay the link'
  );
  assert.ok(!/CONTRADICTED/.test(output), 'nothing about Razorpay was contradicted by an unpaid link');
});

/**
 * The other half of the same distinction: once money HAS arrived, the check is live again and a
 * mismatch must be fatal. Without this, making PENDING non-fatal could have quietly made the
 * whole RECOVERED check unable to fail.
 */
test('--reconcile on a link where money arrived but the status disagrees IS contradicted', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];
  fake.payLink(linkId);
  // Money arrived, but Razorpay reports a state my gateway does not map to CAPTURED. This is a
  // genuine claim about the provider being wrong, and it must still exit 1.
  fake.links.get(linkId).status = 'partially_paid';

  const { code, results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });
  const recovered = byId(results, 'RECOVERED');
  assert.equal(recovered.pending, false, 'money arrived, so the precondition WAS met');
  assert.equal(recovered.held, false);
  assert.equal(code, 1, 'a real contradiction must still gate');
  assert.match(output, /Fix the code, not the fake/);
});

/**
 * The distinction this project is actually about. `status=created paid=0` is what BOTH of these
 * look like on the link itself:
 *
 *   - nobody opened the checkout page
 *   - somebody opened it and the card was declined
 *
 * The second one is the event Rebound exists to recover from, so a reconciler that reports them
 * identically is blind in its own domain. These two tests pin both readings.
 */
test('--reconcile surfaces a declined attempt and the reason Razorpay gave', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];
  fake.failAttempt(linkId, { errorReason: 'payment_failed_due_to_insufficient_funds' });

  const { code, results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });

  // The link still says nothing happened, which is exactly why the account has to be asked.
  assert.equal(fake.links.get(linkId).status, 'created');
  assert.equal(fake.links.get(linkId).amount_paid, 0);

  assert.match(output, /Somebody DID try to pay/);
  assert.match(output, /payment_failed_due_to_insufficient_funds/, 'the decline reason is the point');
  const attempt = byId(results, 'ATTEMPT_VISIBLE');
  assert.equal(attempt.held, true, 'a discoverable decline confirms the belief');
  assert.equal(attempt.pending, false);
  // Still no money, so RECOVERED remains pending and the run still exits 2 rather than 0.
  assert.equal(byId(results, 'RECOVERED').pending, true);
  assert.equal(code, 2);
});

test('--reconcile with no attempt at all says so WITHOUT claiming the page was never opened', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];

  const { results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });
  const attempt = byId(results, 'ATTEMPT_VISIBLE');

  assert.equal(attempt.pending, true, 'zero attempts is inconclusive, not a contradicted belief');
  assert.equal(attempt.held, null);
  assert.match(output, /no payment records against this link/);
  assert.match(output, /NOT proof of that/, 'the limit of what this observes must be stated');
  assert.ok(!/Somebody DID try to pay/.test(output));
});

test('--reconcile still works when the payments list endpoint is unavailable', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];

  // A diagnostic that can crash the command it is diagnosing is worse than no diagnostic.
  const listBroken = {
    ...fake,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      if ((init?.method ?? 'GET') === 'GET' && u.pathname.endsWith('/payments')) {
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }
      return fake.fetchImpl(url, init);
    },
  };

  const { code, results } = await runCli({ fake: listBroken, argv: ['--reconcile', linkId] });
  assert.equal(byId(results, 'RECOVERED').pending, true, 'the main verdict must survive');
  assert.match(byId(results, 'ATTEMPT_VISIBLE').detail, /list_endpoint=unavailable/);
  assert.equal(code, 2, 'a broken diagnostic must not turn into a contradicted belief');
});

/**
 * The overlap case, taken from a real run that reported two identical declines when there may
 * only have been one. If the same payment is visible on the link AND in the account list, it is
 * one attempt seen twice, not two attempts — and "how many times have we already asked this
 * customer" is a model feature, so a counter that can double would bias every decision built on
 * it. The provenance string is asserted because it is what turns this from a guess into an
 * observation on the next real run.
 */
test('one decline visible in two places is counted once, with its sources named', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];
  const failed = fake.failAttempt(linkId);
  // The world in which Razorpay DOES append the failure to the link entity, so both sources
  // return the very same payment id.
  fake.links.get(linkId).payments = [
    { payment_id: failed.id, status: 'failed', method: 'card', amount: failed.amount, error_reason: failed.error_reason },
  ];

  const { results, output } = await runCli({ fake, argv: ['--reconcile', linkId] });
  const attempt = byId(results, 'ATTEMPT_VISIBLE');

  assert.match(attempt.detail, /^1 distinct decline\(s\)/, 'one payment, seen twice, is one decline');
  assert.match(attempt.detail, /link=1 account=1 distinct=1/, 'provenance makes the overlap visible');
  assert.match(output, /seen_in=link\+account/);
});

test('two genuinely different declines are counted as two', async () => {
  const fake = createFakeRazorpay();
  await runCli({ fake });
  const linkId = [...fake.links.keys()][0];
  fake.failAttempt(linkId, { errorReason: 'international_transaction_not_allowed' });
  fake.failAttempt(linkId, { errorReason: 'payment_failed_due_to_insufficient_funds' });

  const { results } = await runCli({ fake, argv: ['--reconcile', linkId] });
  const attempt = byId(results, 'ATTEMPT_VISIBLE');
  assert.match(attempt.detail, /^2 distinct decline\(s\)/);
  assert.match(attempt.detail, /international_transaction_not_allowed/);
  assert.match(attempt.detail, /insufficient_funds/);
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
