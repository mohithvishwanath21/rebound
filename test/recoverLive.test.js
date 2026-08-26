/**
 * THE RECOVER-LIVE COMMAND, EXERCISED WITHOUT A NETWORK, A KEY, OR A HUMAN TO PAY A LINK.
 *
 * `npm run recover-live` is the opening shot of the pitch video. It runs by hand, against real
 * credentials, on an account with real records, with a camera pointed at the terminal — and it is
 * the one command in this project whose *output* is the deliverable. Everywhere else a wrong label
 * or a dropped minus sign is a cosmetic bug. Here it is the argument.
 *
 * That distinction is not hypothetical. The first smoke run of this command printed the retry's
 * expected value as `EV = ₹2` instead of `EV = −₹2`, because the local rupee formatter had been
 * copied from one whose inputs are all amounts and are therefore never negative. Every number on
 * that screen was correct; the only negative one on it was the whole point of the beat, and it
 * appeared to be a small profit rather than a small loss. Test 8 below exists for that alone.
 *
 * WHAT THIS TEST CAN AND CANNOT SAY. It drives the script against `test/fakeRazorpay.js`, so it
 * verifies the script: the search, the join, the diagnosis wiring, the pricing arithmetic, the
 * link body, the exit codes, the redaction, the evidence file, the offline replay. It says nothing
 * about whether Razorpay behaves as the fake claims — the fake encodes my beliefs, so it cannot
 * falsify them. Only `docs/evidence/live-check-*.json` can do that, and it already has.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, setSink } from '../src/razorpay/cli/recover-live.js';
import { createFakeRazorpay } from './fakeRazorpay.js';

// Key-shaped on purpose, so the redaction assertions test the real regex rather than a string
// that happens not to look like a credential.
const KEY_ID = 'rzp_test_RecoverLiveFake1';
const KEY_SECRET = 'aSecretThatMustNeverBePrinted';

/**
 * A path that does not exist, passed as `envPath` on every run, so `loadEnv()` cannot find the
 * operator's real `.env` and pull genuine Razorpay credentials into the test process. Nothing
 * would leak — every path here is redacted — but a suite that reads a developer's secrets is
 * wrong on principle, and one that behaves differently depending on whether a machine has been
 * configured is not a test.
 */
const NO_ENV = join(tmpdir(), 'rebound-no-such-env-file');

const tmp = () => `${mkdtempSync(join(tmpdir(), 'rebound-recover-'))}/`;

/** Seed the fake with a payment link, then a decline against it. Returns both. */
async function seedDecline(fake, { ref = 'rbd_seed_1', amount = 49900, errorReason, method = 'card' } = {}) {
  const res = await fake.fetchImpl('https://api.razorpay.com/v1/payment_links', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({
      amount,
      currency: 'INR',
      reference_id: ref,
      description: 'seed',
      notes: { rebound_ref: ref },
    }),
  });
  const link = JSON.parse(await res.text());
  const payment = fake.failAttempt(link.id, { errorReason, method });
  return { link, payment };
}

async function runCli({ argv = [], fake = createFakeRazorpay(), evidenceDir = tmp(), fetchImpl } = {}) {
  const lines = [];
  setSink((s) => lines.push(String(s)));
  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = KEY_ID;
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  try {
    const out = await main({
      argv,
      fetchImpl: fetchImpl ?? fake.fetchImpl,
      sleep: async () => {},
      evidenceDir,
      envPath: NO_ENV,
    });
    return { ...out, lines, output: lines.join('\n'), fake, evidenceDir };
  } finally {
    process.env = saved;
    setSink((s) => process.stdout.write(`${s}\n`));
  }
}

const evidenceFiles = (dir) => readdirSync(dir).filter((n) => n.startsWith('recover-live-'));
const readEvidence = (dir, i = 0) => JSON.parse(readFileSync(join(dir, evidenceFiles(dir).sort()[i]), 'utf8'));

/* ───────────────────────────── the failure, found not fabricated ───────────────────────────── */

test('1. with no declined payment on the account it refuses to invent one', async () => {
  const out = await runCli();
  assert.equal(out.code, 2, 'a run with nothing to narrate is not a success');
  assert.equal(out.found, false);
  assert.match(out.output, /No failed payment found/);
  assert.match(out.output, /4111 1111 1111 1111/, 'it must say how to create a real decline');
  assert.equal(out.fake.links.size, 0, 'and it must not create a recovery link for a case that does not exist');
});

test('2. it finds the real decline and prints the provider\'s own fields', async () => {
  const fake = createFakeRazorpay();
  const { payment } = await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  assert.equal(out.code, 0);
  assert.equal(out.declined, payment.id, 'the narrated payment must be the one Razorpay actually failed');
  assert.match(out.output, /error_reason\s+international_transaction_not_allowed/);
  assert.match(out.output, /BAD_REQUEST_ERROR/);
  assert.match(out.output, /our ref\s+rbd_seed_1/, 'the join back to our own reference must be shown');
});

test('3. with distinct timestamps it narrates the most recent decline', async () => {
  let clock = new Date('2026-08-26T10:00:00Z');
  const fake = createFakeRazorpay({ now: () => clock });
  await seedDecline(fake, { ref: 'rbd_old', errorReason: 'payment_failed' });
  clock = new Date('2026-08-26T10:05:00Z');
  const { payment: newest } = await seedDecline(fake, {
    ref: 'rbd_new',
    errorReason: 'international_transaction_not_allowed',
  });

  const out = await runCli({ fake });
  assert.equal(out.declined, newest.id);
  assert.match(out.output, /our ref\s+rbd_new/);
  assert.doesNotMatch(out.output, /share this timestamp/, 'nothing is ambiguous here, so nothing should be warned about');
});

test('4. when declines share a second it says so instead of quietly guessing', async () => {
  /**
   * `created_at` is unix SECONDS, so two attempts inside the same second do not order at all —
   * which is exactly what happens when someone hits the checkout twice in a row on camera. My
   * first version sorted descending with a stable sort, which on a tie preserves whatever order
   * the provider returned, and it silently narrated the OLDEST tied decline. On a filmed run that
   * means narrating a decline from a previous session, with a different reason code, and finding
   * out halfway through the take.
   *
   * No field resolves the tie, so this test does not assert which one is "right" — it asserts that
   * the pick is deterministic and that the ambiguity reaches the screen with the other candidates'
   * references, so `--ref` settles it in one re-run.
   */
  const clock = new Date('2026-08-26T10:00:00Z');
  const fake = createFakeRazorpay({ now: () => clock });
  await seedDecline(fake, { ref: 'rbd_first', errorReason: 'international_transaction_not_allowed' });
  await seedDecline(fake, { ref: 'rbd_second', errorReason: 'international_transaction_not_allowed' });

  const a = await runCli({ fake });
  const b = await runCli({ fake });
  assert.equal(a.declined, b.declined, 'the choice must not vary between runs');

  assert.match(a.output, /2 declines share this timestamp/);
  assert.match(a.output, /created_at is only accurate to the second/);
  assert.match(a.output, /--ref=/, 'and it must name the way out');
  const other = a.output.includes('our ref            rbd_first') ? 'rbd_second' : 'rbd_first';
  assert.ok(a.output.includes(other), 'the rejected candidate must be named so the operator can switch to it');
});

test('5. --ref scopes the search to one link, and says so when that link has no decline', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { ref: 'rbd_wanted', errorReason: 'international_transaction_not_allowed' });
  await seedDecline(fake, { ref: 'rbd_other', errorReason: 'payment_failed' });

  const hit = await runCli({ fake, argv: ['--ref=rbd_wanted'] });
  assert.equal(hit.diagnosis.rootCause, 'INSTRUMENT_NOT_ACCEPTED');
  assert.match(hit.output, /our ref\s+rbd_wanted/);

  const miss = await runCli({ fake, argv: ['--ref=rbd_nonexistent'] });
  assert.equal(miss.code, 2, 'a reference with no decline behind it is not a success either');
});

/* ─────────────────────────────────── the diagnosis ─────────────────────────────────── */

test('6. the raw provider payload is diagnosed at the REASON tier, on evidence, with the physics that drive the decision', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  const dx = out.diagnosis;
  assert.equal(dx.rootCause, 'INSTRUMENT_NOT_ACCEPTED');
  assert.equal(dx.source, 'RULE');
  assert.equal(dx.matchTier, 'REASON');
  assert.equal(dx.matchedOn, 'reason=international_transaction_not_allowed');
  assert.equal(dx.evidenceDate, '2026-08-22', 'the pattern was confirmed live; the screen must be able to say so');
  assert.equal(dx.abstained, false);
  assert.equal(dx.physics.retryCanSucceed, false, 'this is what makes the retry worth zero rather than a little');
  assert.equal(dx.physics.railSwitchIsPrimary, true, 'and this is what makes the nudge the primary remedy');
  assert.match(out.output, /pattern confirmed against the live API on 2026-08-22/);
});

test('7. a misleading error_description does not outrank the reason field', async () => {
  /**
   * The fake stamps every decline with "the card has insufficient funds" regardless of the reason
   * code — which started as a shortcut in the fixture and turns out to be the more valuable test.
   * The real API's description and reason agree; a fixture where they disagree proves which field
   * the rule table is actually reading.
   *
   * INSUFFICIENT_FUNDS and INSTRUMENT_NOT_ACCEPTED demand opposite actions: wait for the salary
   * window and retry, versus never retry and switch rail. Matching on free text where a reason
   * enum is present would pick the wrong one of those, and it would look entirely plausible in
   * the audit trail.
   */
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  assert.match(out.output, /insufficient funds/, 'the misleading description is on screen, unedited');
  assert.equal(out.diagnosis.rootCause, 'INSTRUMENT_NOT_ACCEPTED', 'and it did not win');
  assert.equal(out.diagnosis.matchTier, 'REASON');
});

/* ─────────────────────────────────── the pricing ─────────────────────────────────── */

test('8. the retry\'s expected value is printed as a loss, with a minus sign', async () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. The first run of this command printed `EV = ₹2` for an action
   * whose expected value is −200 paise, because the formatter took Math.abs and only prepended a
   * sign inside a branch that had been dropped. The beat's entire claim is that this action costs
   * money and recovers nothing, and the screen said it earned two rupees.
   *
   * Asserted on the rendered line rather than on the arithmetic on purpose: the arithmetic was
   * right the whole time. Only the output was wrong, so only the output can catch it.
   */
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  const line = out.lines.find((l) => l.includes('RETRY_NOW'));
  assert.ok(line, 'the retry must be priced on screen, not silently skipped');
  assert.match(line, /p = 0\.00/, 'p is fixed by the cause, not estimated');
  assert.match(line, /EV = −₹/, 'a negative expected value must read as negative');
  assert.doesNotMatch(line, /EV = ₹/, 'and must not read as a gain');
});

test('9. the rail switch is quoted as an exact break-even probability, not an invented point estimate', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  const line = out.lines.find((l) => l.includes('SWITCH_RAIL_NUDGE') && l.includes('beats'));
  assert.ok(line, 'the nudge must be priced on screen');
  const m = line.match(/p > (\d+\.\d+)%/);
  assert.ok(m, `expected a break-even percentage, got: ${line}`);
  const be = Number(m[1]);
  assert.ok(be > 0 && be < 100, `break-even must be a probability, got ${be}%`);
  /**
   * On a ₹499 stake the nudge's whole cost is a few rupees against a gross in the hundreds, so the
   * break-even has to be low single digits. A bound rather than an exact figure, because the cost
   * constants are policy and are allowed to move; a break-even that climbed past 20% would mean
   * the channel cost or the margin had changed by an order of magnitude, and the narration
   * ("switching wins at almost any chance of success") would no longer be true.
   */
  assert.ok(be < 20, `break-even of ${be}% would break the narration; costs must have moved`);
  assert.match(out.output, /DECISION/);
});

/* ─────────────────────────────────── the action ─────────────────────────────────── */

test('10. the link it issues is honest about the rail it could NOT restrict, and notifies nobody', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake });

  assert.ok(out.link?.startsWith('plink_'), `expected a payment link id, got ${out.link}`);
  const stored = out.fake.links.get(out.link);
  assert.ok(stored, 'the link must exist on the provider, not just in our output');
  /**
   * This assertion was `upi_link === true` until 2026-08-26, when the real API answered
   * "UPI Payment Links is not supported in Test Mode" and the whole path turned out to have never
   * worked. Both halves matter now: the flag must not be sent, AND the screen must say the
   * restriction was wanted and is missing. A silently unrestricted link that the narration calls a
   * rail switch is a worse outcome than the 400 was.
   */
  assert.equal(stored.upi_link, false, 'test mode refuses upi_link, so it must not be sent');
  assert.match(out.output, /upi_link requested, NOT applied/, 'the screen must own the missing restriction');
  assert.match(out.output, /live mode only/i, 'and say why it is missing');
  assert.equal(stored.reminder_enable, false, 'Razorpay reminders would contact outside our own ledger');
  assert.equal(stored.notify?.sms, false);
  assert.equal(stored.notify?.email, false);
  assert.match(out.output, /success@razorpay/, 'the operator needs the test UPI id to pay it on camera');
  assert.match(out.output, /--confirm plink_/, 'and the exact next command');
});

/* ─────────────────────────────────── the recovery ─────────────────────────────────── */

test('11. --confirm on an unpaid link does not claim a recovery', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const issued = await runCli({ fake });

  const out = await runCli({ fake, argv: ['--confirm', issued.link] });
  assert.equal(out.code, 2);
  assert.equal(out.paid, false);
  assert.doesNotMatch(out.output, /RECOVERED/);
  assert.match(out.output, /Not paid yet/);
});

test('12. --confirm on a paid link reports the money, the method, and the payment id', async () => {
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const issued = await runCli({ fake });
  fake.payLink(issued.link, { method: 'upi' });

  const out = await runCli({ fake, argv: ['--confirm', issued.link] });
  assert.equal(out.code, 0);
  assert.equal(out.paid, true);
  assert.match(out.output, /status\s+paid/);
  assert.match(out.output, /amount_paid\s+₹499 of ₹499/);
  assert.match(out.output, /method=upi/, 'the rail that worked is the point of the whole beat');
  assert.match(out.output, /payment\s+pay_/, 'and a real payment id, so a viewer can look it up');
  assert.match(out.output, /RECOVERED ₹499/);
});

/* ─────────────────────────────────── replay, offline ─────────────────────────────────── */

test('13. --replay with no evidence says so rather than inventing a run', async () => {
  const out = await runCli({ argv: ['--replay'], evidenceDir: tmp() });
  assert.equal(out.code, 1);
  assert.equal(out.replayed, false);
  assert.match(out.output, /will not invent one/);
});

test('14. --replay assembles all five beats across the two commands that produced them', async () => {
  /**
   * The live run is deliberately two commands with a human payment between them, so it is two
   * evidence files, and the second holds only beat 5. The first version of replay read "the newest
   * file" and therefore replayed the recovery with no failure, diagnosis or pricing in front of
   * it — the money without the argument. This pins the assembly.
   */
  const dir = tmp();
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const issued = await runCli({ fake, evidenceDir: dir });
  fake.payLink(issued.link, { method: 'upi' });
  await runCli({ fake, argv: ['--confirm', issued.link], evidenceDir: dir });

  assert.equal(evidenceFiles(dir).length, 2, 'two commands, two evidence files');

  const out = await runCli({
    argv: ['--replay'],
    evidenceDir: dir,
    // A replay that reaches the network is not a replay. If anything calls fetch, this throws
    // and the test fails with the reason rather than with a timeout.
    fetchImpl: () => {
      throw new Error('replay must not touch the network');
    },
  });

  assert.equal(out.code, 0, 'all five beats present means a clean replay');
  assert.deepEqual(out.beats.map((b) => b.n), [1, 2, 3, 4, 5], 'in order, one of each');
  assert.deepEqual(out.missing, []);
  assert.match(out.output, /assembled from 2 real run\(s\)/);
  assert.match(out.output, /Nothing is recomputed/);
  // The substance of every beat has to survive the round trip, not just the headings.
  assert.match(out.output, /international_transaction_not_allowed/);
  assert.match(out.output, /INSTRUMENT_NOT_ACCEPTED/);
  assert.match(out.output, /EV = −₹/);
  assert.match(out.output, /RECOVERED ₹499/);
});

test('15. --replay reports which beats were never recorded instead of quietly skipping them', async () => {
  const dir = tmp();
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  await runCli({ fake, evidenceDir: dir }); // beats 1-4 only; nobody paid the link

  const out = await runCli({ argv: ['--replay'], evidenceDir: dir, fetchImpl: () => { throw new Error('no network'); } });
  assert.equal(out.code, 2, 'an incomplete recording is not a clean replay');
  assert.deepEqual(out.missing, [5]);
  assert.match(out.output, /Beat\(s\) 5 were never recorded/);
});

test('16. --replay survives a half-written evidence file', async () => {
  const dir = tmp();
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  await runCli({ fake, evidenceDir: dir });
  writeFileSync(join(dir, 'recover-live-9999-truncated.json'), '{"beats":[{"n":1,');

  const out = await runCli({ argv: ['--replay'], evidenceDir: dir, fetchImpl: () => { throw new Error('no network'); } });
  assert.equal(out.replayed, true, 'one corrupt file must not cost the whole recording');
  assert.deepEqual(out.beats.map((b) => b.n), [1, 2, 3, 4]);
});

/* ─────────────────────────────────── secrets ─────────────────────────────────── */

test('17. neither the screen nor the evidence file ever contains the key secret', async () => {
  /**
   * This command is run with a camera on the terminal and its evidence files are committed to a
   * public repo. Those are the two ways a test-mode secret becomes a public secret, and both are
   * checked here rather than trusted to the redactor's own unit tests.
   */
  const dir = tmp();
  const fake = createFakeRazorpay();
  await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const issued = await runCli({ fake, evidenceDir: dir });
  fake.payLink(issued.link, { method: 'upi' });
  const confirmed = await runCli({ fake, argv: ['--confirm', issued.link], evidenceDir: dir });

  for (const out of [issued, confirmed]) {
    assert.doesNotMatch(out.output, new RegExp(KEY_SECRET), 'the secret must never be printed');
    assert.doesNotMatch(out.output, new RegExp(KEY_ID), 'nor the full key id — only its prefix');
  }
  assert.match(issued.output, /key rzp_test_Rec\.\.\./, 'the prefix is enough to prove which account');

  for (const name of evidenceFiles(dir)) {
    const raw = readFileSync(join(dir, name), 'utf8');
    assert.ok(!raw.includes(KEY_SECRET), `${name} contains the key secret`);
    assert.ok(!raw.includes(KEY_ID), `${name} contains the full key id`);
    assert.ok(!/Basic [A-Za-z0-9+/=]{12,}/.test(raw), `${name} contains an authorization header`);
  }
});

test('18. the evidence file records the decline, the diagnosis and the beats as printed', async () => {
  const dir = tmp();
  const fake = createFakeRazorpay();
  const { payment } = await seedDecline(fake, { errorReason: 'international_transaction_not_allowed' });
  const out = await runCli({ fake, evidenceDir: dir });

  const ev = readEvidence(dir);
  assert.equal(ev.declinedPayment, payment.id);
  assert.equal(ev.diagnosis.rootCause, 'INSTRUMENT_NOT_ACCEPTED');
  assert.equal(ev.issuedLink, out.link);
  assert.equal(ev.mode, 'LIVE_TEST');
  assert.deepEqual(ev.beats.map((b) => b.n), [1, 2, 3, 4]);
  assert.ok(ev.httpCalls.length > 0, 'the http trace is what makes this evidence rather than a claim');
  assert.ok(
    ev.beats.every((b) => b.lines.every((l) => !/\[/.test(l))),
    'recorded lines must be free of terminal colour codes, or a replay prints escape soup'
  );
});

test('19. re-running a beat replaces it in the replay rather than colliding with it', async () => {
  /**
   * TWO REAL DEFECTS MEET HERE, AND BOTH WERE FOUND BY THIS FILE RATHER THAN BY READING THE CODE.
   *
   * First: the evidence filename is an ISO timestamp to the millisecond, and two runs back to back
   * landed on the same name — so the second write replaced the first and `docs/evidence/`, the one
   * directory in this repo that holds records of things that really happened, quietly lost one.
   * Hence the `-2` collision counter.
   *
   * Second, immediately caused by the fix: '-' sorts before '.' in ASCII, so a lexical sort of
   * filenames puts `...194Z-2.json` AHEAD of `...194Z.json` and reverses the two writes the counter
   * exists to tell apart. Replay keeps the newest version of each beat, so a reversed order silently
   * replays the older take. Ordering now runs on the timestamp recorded inside the file, with the
   * counter as a numeric tiebreak.
   *
   * Both are invisible unless a beat is recorded twice, which is exactly what happens when you
   * re-run beats 1-4 a few times to get the narration right — the normal way this command is used.
   */
  const dir = tmp();
  const fake = createFakeRazorpay();
  await seedDecline(fake, { ref: 'rbd_take_one', errorReason: 'international_transaction_not_allowed' });
  const first = await runCli({ fake, evidenceDir: dir });

  // A second take, against a different decline, so the two recordings of beat 1 are distinguishable.
  fake.reset();
  await seedDecline(fake, { ref: 'rbd_take_two', errorReason: 'international_transaction_not_allowed' });
  const second = await runCli({ fake, evidenceDir: dir });

  assert.equal(evidenceFiles(dir).length, 2, 'the second take must not overwrite the first');
  assert.notEqual(first.declined, second.declined, 'the two takes must be distinguishable');

  const out = await runCli({ argv: ['--replay'], evidenceDir: dir, fetchImpl: () => { throw new Error('no network'); } });
  assert.match(out.output, /rbd_take_two/, 'the replay must show the later take');
  assert.doesNotMatch(out.output, /rbd_take_one/, 'and not the one it superseded');
  assert.deepEqual(out.beats.map((b) => b.n), [1, 2, 3, 4], 'still one of each beat, not eight');
});

test('20. --help explains the three modes without needing a key', async () => {
  const lines = [];
  setSink((s) => lines.push(String(s)));
  const saved = { ...process.env };
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  try {
    const out = await main({ argv: ['--help'], envPath: NO_ENV });
    assert.equal(out.code, 0, 'help must work on a machine with no credentials at all');
    const text = lines.join('\n');
    assert.match(text, /--confirm/);
    assert.match(text, /--replay/);
  } finally {
    process.env = saved;
    setSink((s) => process.stdout.write(`${s}\n`));
  }
});
