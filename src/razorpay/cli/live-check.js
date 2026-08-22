#!/usr/bin/env node
/**
 * LIVE CHECK — the one command that talks to the real Razorpay API.
 * =================================================================
 *
 * Everything else in this project is verified offline against `test/fakeRazorpay.js`. That
 * proves my code builds the right requests and handles the documented failures. It cannot
 * prove the fake is right, because a fake only ever encodes my current beliefs — and if a
 * belief is wrong, the fake is wrong in exactly the same direction. That is the one class
 * of bug you cannot test your way out of.
 *
 * So this script does not re-test my code. It tests my BELIEFS, one at a time, against
 * api.razorpay.com in test mode, and prints each one as CONFIRMED or CONTRADICTED. Three of
 * them are load-bearing:
 *
 *   B1  Razorpay enforces a unique `reference_id` on payment links.
 *       -> this is the remote half of the idempotency guarantee. If it is false, a lost
 *          response could produce two live payment links for one decision.
 *   B2  Razorpay does NOT enforce a unique `receipt` on orders.
 *       -> I originally assumed the opposite and wrote `idempotent: true` on order create
 *          because of it. Confirming the asymmetry is what makes the retry rules honest.
 *   B3  `reference_id` is capped at 40 characters and `expire_by` at 15 minutes.
 *       -> `buildReference()` and the expiry floor are built around these exact numbers.
 *
 * WHAT THIS SCRIPT WILL AND WILL NOT DO TO YOUR ACCOUNT
 * ----------------------------------------------------
 *   - It refuses to run against a key beginning `rzp_live_` (enforced in httpClient.js).
 *   - It creates test-mode payment links and orders. No money can move in test mode.
 *   - It sends NO email and NO SMS unless you pass --notify-email or --notify-phone. A
 *     script that quietly messages a real person the first time it runs is not a script I
 *     want in a repo.
 *   - It never prints a key, a secret, or an unmasked contact detail. Every line goes
 *     through `redact()` — including the JSON evidence file — so the output is safe to
 *     paste into a chat or an issue.
 *
 * USAGE
 *   npm run live-check                          # run the belief checks
 *   npm run live-check -- --notify-email you@example.com
 *   npm run live-check -- --reconcile plink_XXX # after paying a link with a test card
 *
 * The full recovery loop is two commands, because paying a link requires a human:
 *   1. `npm run live-check` prints a short_url.
 *   2. Open it, pay with Razorpay's test card 4111 1111 1111 1111 (any future expiry, any CVV).
 *   3. `npm run live-check -- --reconcile <plink_id>` reads the money back out.
 * Step 3 printing CAPTURED with a non-zero amount is the end-to-end proof for Day 3.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadEnv, requireEnv } from '../../core/env.js';
import { createRazorpayClient, redact } from '../httpClient.js';
import { createLiveGateway } from '../liveGateway.js';
import { ReceiptState, MAX_REFERENCE_LENGTH } from '../gateway.js';
import { ActionKind } from '../../core/actions.js';
import { RazorpayError, RazorpayValidationError } from '../errors.js';

// ----------------------------------------------------------------- terminal niceties

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColour ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const red = (s) => c('31', s);
const yellow = (s) => c('33', s);
const dim = (s) => c('2', s);

/**
 * Output goes through a swappable sink rather than straight to console.log, so
 * `test/liveCheck.test.js` can run this whole script against the fake Razorpay and assert on
 * what it printed. That test is the reason this file is shaped this way. The command whose
 * entire job is to be run by hand, against real credentials, possibly in front of a judge, is
 * the worst imaginable place to find a typo — so it executes on every commit, just not over a
 * network.
 */
let sink = console.log;
export function setSink(fn) {
  sink = fn ?? console.log;
}
const say = (s = '') => sink(s);
const safe = (s) => (typeof s === 'string' ? redact(s) : JSON.stringify(redact(s)));

// ----------------------------------------------------------------- results ledger

/**
 * Records one belief check.
 *
 * `belief` is always phrased as a claim about Razorpay, never about my code, so a
 * CONTRADICTED line always means "go change your code" and never "the API is broken".
 *
 * A ledger instance rather than a module-level array: module state would make a second run
 * inside one process append to the first run's results, and the test suite runs it twice.
 */
function makeLedger() {
  const results = [];
  return {
    results,
    record({ id, belief, held, detail, fatal = false }) {
      results.push({ id, belief, held, detail: detail ?? null, fatal });
      const tag = held ? green('CONFIRMED   ') : fatal ? red('CONTRADICTED') : yellow('UNVERIFIED  ');
      say(`  ${tag} ${bold(id)}  ${belief}`);
      if (detail) say(`               ${dim(safe(detail))}`);
    },
    get: (id) => results.find((r) => r.id === id) ?? null,
  };
}

function parseArgs(argv) {
  const args = { notifyEmail: null, notifyPhone: null, reconcile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--notify-email') args.notifyEmail = argv[++i];
    else if (a === '--notify-phone') args.notifyPhone = argv[++i];
    else if (a === '--reconcile') args.reconcile = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

/**
 * A fresh run id per invocation, so two live-checks never collide on a reference_id.
 * Generated per run and not at module load: at module load, two runs inside one process
 * would share it, and the second run's B1 check would see the first run's links and pass
 * for the wrong reason.
 */
const makeRunId = () => `live_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;

// ----------------------------------------------------------------- the checks

async function checkAuth(ctx) {
  const { ledger, http } = ctx;
  // The cheapest possible authenticated read. Confirms the key pair, the basic-auth
  // encoding, the base URL and TLS in one call, before anything is created.
  try {
    const { status } = await http.get('/payment_links', { query: { count: 1 } });
    ledger.record({
      id: 'AUTH',
      belief: 'the key pair authenticates against api.razorpay.com',
      held: status === 200,
      detail: `HTTP ${status}, key ${http.keyIdPrefix}...`,
      fatal: true,
    });
    return true;
  } catch (e) {
    ledger.record({
      id: 'AUTH',
      belief: 'the key pair authenticates against api.razorpay.com',
      held: false,
      detail: e instanceof RazorpayError ? e.toAudit() : String(e.message),
      fatal: true,
    });
    return false;
  }
}

/** B1 — the belief the whole idempotency story rests on. */
async function checkUniqueReference(ctx) {
  const { ledger, gw, args, runId } = ctx;
  const req = {
    runId,
    eventId: 'evt_livecheck1',
    decisionSeq: 1,
    amountPaise: 49900,
    action: { kind: ActionKind.SEND_LINK, channel: args.notifyEmail ? 'EMAIL' : 'WHATSAPP' },
    customer: {
      name: 'Rebound Live Check',
      email: args.notifyEmail ?? undefined,
      contact: args.notifyPhone ?? undefined,
    },
    description: 'Rebound live check — test mode only',
  };

  const first = await gw.sendPaymentLink(req);
  ledger.record({
    id: 'CREATE',
    belief: 'a payment link can be created and comes back with a payable short_url',
    held: first.state === ReceiptState.SENT && Boolean(first.shortUrl),
    detail: `${first.providerRef} state=${first.state} notified=${first.notified}`,
    fatal: true,
  });

  // The same decision, replayed. Razorpay must refuse it, and the gateway must turn that
  // refusal into a receipt for the link that already exists.
  const second = await gw.sendPaymentLink(req);
  const isReplay = second.replayed === true && second.providerRef === first.providerRef;
  ledger.record({
    id: 'B1',
    belief: 'Razorpay REJECTS a duplicate reference_id on payment links',
    held: isReplay,
    detail: isReplay
      ? `replay resolved to the same link ${second.providerRef}`
      : `created a SECOND link ${second.providerRef} for the same reference — idempotency is NOT provided remotely`,
    fatal: true,
  });

  return { first, second };
}

/** B2 — the asymmetry I originally got wrong. */
async function checkOrderReceiptNotUnique(ctx) {
  const { ledger, gw, runId } = ctx;
  const req = {
    runId,
    eventId: 'evt_livecheck2',
    decisionSeq: 1,
    amountPaise: 31500,
    action: { kind: ActionKind.RETRY_NOW, channel: null },
  };

  const a = await gw.retryCharge(req);
  const b = await gw.retryCharge(req);

  const distinct = a.providerRef !== b.providerRef;
  ledger.record({
    id: 'B2',
    belief: 'Razorpay does NOT dedupe orders on `receipt` — two creates give two orders',
    held: distinct,
    detail: distinct
      ? `two orders (${a.providerRef}, ${b.providerRef}) share receipt ${a.reference} — so retry safety rests on "an order moves no money", not on remote uniqueness`
      : `both creates returned ${a.providerRef} — Razorpay DOES dedupe receipt, which is stronger than I assumed`,
  });

  ledger.record({
    id: 'RETRY_HONEST',
    belief: 'creating an order does not by itself capture anything',
    held: a.state === ReceiptState.ATTEMPTED && a.amountCollectedPaise === 0,
    detail: `state=${a.state} collected=${a.amountCollectedPaise}`,
  });

  return a;
}

/** B3a — the 40-character cap that `buildReference()` is designed around. */
async function checkReferenceLengthCap(ctx) {
  const { ledger, http } = ctx;
  const tooLong = `rbd_${'x'.repeat(MAX_REFERENCE_LENGTH + 5)}`;
  try {
    await http.post('/payment_links', {
      body: {
        amount: 10000,
        currency: 'INR',
        reference_id: tooLong,
        description: 'Rebound live check — expected to be rejected',
      },
      safeToRetry: true,
    });
    ledger.record({
      id: 'B3a',
      belief: `reference_id longer than ${MAX_REFERENCE_LENGTH} chars is rejected`,
      held: false,
      detail: `a ${tooLong.length}-char reference was ACCEPTED — the cap in gateway.js is stricter than Razorpay's`,
    });
  } catch (e) {
    const rejected = e instanceof RazorpayValidationError;
    ledger.record({
      id: 'B3a',
      belief: `reference_id longer than ${MAX_REFERENCE_LENGTH} chars is rejected`,
      held: rejected,
      detail: rejected ? `${e.code}: ${e.description}` : e.message,
    });
  }
}

/** B3b — the 15-minute expiry floor. */
async function checkExpiryFloor(ctx) {
  const { ledger, http, runId } = ctx;
  const inFiveMinutes = Math.floor(Date.now() / 1000) + 5 * 60;
  try {
    await http.post('/payment_links', {
      body: {
        amount: 10000,
        currency: 'INR',
        reference_id: `${runId}_expiry`,
        expire_by: inFiveMinutes,
        description: 'Rebound live check — expected to be rejected',
      },
      safeToRetry: true,
    });
    ledger.record({
      id: 'B3b',
      belief: 'expire_by less than 15 minutes away is rejected',
      held: false,
      detail: 'a 5-minute expiry was ACCEPTED — the MIN_EXPIRY_MS floor is defensive, not required',
    });
  } catch (e) {
    const rejected = e instanceof RazorpayValidationError;
    ledger.record({
      id: 'B3b',
      belief: 'expire_by less than 15 minutes away is rejected',
      held: rejected,
      detail: rejected ? `${e.code}: ${e.description}` : e.message,
    });
  }
}

/** The join column. If this doesn't come back, a webhook cannot find the case. */
async function checkReferenceRoundTrip(ctx, receipt) {
  const { ledger, gw } = ctx;
  const view = await gw.fetchStatus({ providerRef: receipt.providerRef });
  ledger.record({
    id: 'JOIN',
    belief: 'our reference_id comes back on a fetch, so a webhook can find the case',
    held: view.referenceId === receipt.reference,
    detail: `fetched referenceId=${view.referenceId} status=${view.providerStatus}`,
    fatal: true,
  });
  return view;
}

/**
 * Redaction, proven against the real secret rather than a fixture.
 *
 * Every other redaction test in this project feeds in a made-up key. This is the only
 * moment the process holds the actual one, so it is the only moment the assertion is worth
 * anything. If this line ever fails, stop and fix it before running anything else.
 */
function checkRedactionOnTheRealKey(ctx) {
  const { ledger, keyId = '', keySecret = '' } = ctx;
  const probe = redact({
    authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    note: `a log line that accidentally interpolated ${keyId}`,
    key_secret: keySecret,
  });
  const serialised = JSON.stringify(probe);
  const leaked =
    (keyId && serialised.includes(keyId)) ||
    (keySecret && keySecret.length > 6 && serialised.includes(keySecret));
  ledger.record({
    id: 'REDACT',
    belief: 'redact() removes the REAL key and secret, not just test-shaped fixtures',
    held: !leaked,
    detail: leaked ? 'A CREDENTIAL SURVIVED REDACTION. Do not paste this run anywhere.' : serialised,
    fatal: true,
  });
}

/** The second half of the end-to-end proof, run after a human pays the link. */
async function reconcile(ctx, providerRef) {
  const { ledger, gw } = ctx;
  say(bold(`\nReconciling ${providerRef}\n`));
  const view = await gw.fetchStatus({ providerRef });
  const captured = view.state === ReceiptState.CAPTURED;

  ledger.record({
    id: 'RECOVERED',
    belief: 'a paid test-mode link reads back as CAPTURED with the amount that arrived',
    held: captured && view.amountPaidPaise > 0,
    detail: `status=${view.providerStatus} paid=${view.amountPaidPaise} of ${view.amountPaise} reference=${view.referenceId}`,
    fatal: true,
  });

  if (!captured) {
    say(
      yellow(
        `\n  Not paid yet. Open the short_url, pay with test card 4111 1111 1111 1111 ` +
          `(any future expiry, any CVV), then run this again.`
      )
    );
  }
  return view;
}

// ----------------------------------------------------------------- evidence file

/**
 * Write the run to `docs/evidence/`. Two reasons this is worth a file rather than just
 * terminal output: it is the artefact that backs the "the plumbing works" claim in the
 * README, and a diff between two runs is how I'd notice Razorpay changing a behaviour I
 * depend on. Redacted before writing, not after — the file is meant to be committable.
 */
function writeEvidence(summary, { dir } = {}) {
  const target = dir ?? new URL('../../../docs/evidence/', import.meta.url).pathname;
  mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${target}live-check-${stamp}.json`;
  writeFileSync(path, `${JSON.stringify(redact(summary), null, 2)}\n`);
  return path;
}

// ----------------------------------------------------------------- main

/**
 * @param {object} [o]
 * @param {string[]} [o.argv]        - defaults to the real command line
 * @param {function} [o.fetchImpl]   - injected transport. The offline test passes the fake
 *                                     Razorpay here, which is how this command gets exercised
 *                                     without keys or a network. Note it injects the transport
 *                                     rather than a finished client, so the credential wiring
 *                                     and the HTTP logging are under test too — a bug in
 *                                     exactly that wiring is what this parameter caught.
 * @param {function} [o.sleep]       - injected so retry backoff costs no wall-clock time
 * @param {string}   [o.evidenceDir] - so the test does not litter docs/evidence/
 * @param {string}   [o.envPath]     - so the test never reads the operator's real .env
 * @returns {Promise<{ code: number, results: object[] }>}
 */
export async function main({ argv = process.argv.slice(2), fetchImpl, sleep, evidenceDir, envPath } = {}) {
  const ledger = makeLedger();
  const args = parseArgs(argv);

  if (args.help) {
    say(
      [
        'Usage: npm run live-check [-- options]',
        '',
        '  --notify-email <addr>   let Razorpay email the link (default: no message is sent)',
        '  --notify-phone <num>    let Razorpay SMS the link  (default: no message is sent)',
        '  --reconcile <plink_id>  read a link back after paying it with a test card',
      ].join('\n')
    );
    return { code: 0, results: ledger.results };
  }

  const env = loadEnv(envPath ? { path: envPath } : undefined);
  say(bold('\nRebound live check') + dim('  — real Razorpay API, test mode only'));
  say(dim(`  .env ${env.loaded ? `loaded (${env.keys.length} vars)` : 'not found — reading process env only'}`));

  // Read once and pass explicitly, rather than letting each constructor reach into
  // process.env on its own. `createRazorpayClient` takes no env default at all — it is
  // library code and should not be reading global state — and the first version of this file
  // called it with neither key, which would have failed on the very first real run with a
  // message about missing keys while the .env was perfectly fine.
  const keyId = requireEnv('RAZORPAY_KEY_ID', 'It must begin rzp_test_.');
  const keySecret = requireEnv('RAZORPAY_KEY_SECRET');

  // A visible log of every HTTP call, already redacted by the client itself.
  const calls = [];
  const onLog = (line) => {
    calls.push(line);
    if (line.event === 'http') say(dim(`    -> ${line.method} ${line.path} ${line.status} (${line.ms}ms)`));
    else say(yellow(`    !! ${line.event} ${safe(line)}`));
  };

  const http = createRazorpayClient({
    keyId,
    keySecret,
    onLog,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const gw = createLiveGateway({ keyId, keySecret, client: http, onLog });
  const ctx = { ledger, http, gw, args, runId: makeRunId(), keyId, keySecret };

  say(dim(`  key ${http.keyIdPrefix}...  mode ${gw.mode}\n`));

  checkRedactionOnTheRealKey(ctx);
  if (ledger.get('REDACT')?.held === false) {
    say(red('\nAborting: redaction failed on the real credential. Nothing was sent.'));
    return { code: 1, results: ledger.results };
  }

  if (!(await checkAuth(ctx))) {
    say(red('\nAborting: authentication failed. Check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET in .env.'));
    return { code: 1, results: ledger.results };
  }

  let created = null;
  if (args.reconcile) {
    await reconcile(ctx, args.reconcile);
  } else {
    say('');
    const { first } = await checkUniqueReference(ctx);
    created = first;
    await checkReferenceRoundTrip(ctx, first);
    await checkOrderReceiptNotUnique(ctx);
    await checkReferenceLengthCap(ctx);
    await checkExpiryFloor(ctx);
  }

  // ------------------------------------------------------------- summary

  const { results } = ledger;
  const failed = results.filter((r) => !r.held);
  const fatal = failed.filter((r) => r.fatal);

  say(bold('\nResult'));
  say('------');
  say(`  ${results.length - failed.length} confirmed, ${failed.length} not confirmed`);

  if (created?.shortUrl) {
    say('');
    say(bold('  Pay this link to complete the end-to-end proof:'));
    say(`    ${created.shortUrl}`);
    say(dim('    test card 4111 1111 1111 1111, any future expiry, any CVV'));
    say(dim(`    then: npm run live-check -- --reconcile ${created.providerRef}`));
  }

  const evidence = writeEvidence(
    {
      runId: ctx.runId,
      at: new Date().toISOString(),
      keyIdPrefix: http.keyIdPrefix,
      mode: gw.mode,
      results,
      httpCalls: calls,
    },
    { dir: evidenceDir }
  );
  say(dim(`\n  evidence written to ${evidence.replace(/^.*\/docs\//, 'docs/')}`));

  // The claim boundary, restated every run so it cannot drift from what the code did.
  say(dim('\n  What this proves: the integration works against the real API — auth, creation,'));
  say(dim('  idempotency, reconciliation and redaction. It says NOTHING about whether the'));
  say(dim('  recovery policy is any good; that number is measured in simulation and is'));
  say(dim('  reported separately, on purpose.\n'));

  if (fatal.length) {
    say(red(`  ${fatal.length} load-bearing belief(s) contradicted. Fix the code, not the fake.`));
    return { code: 1, results };
  }
  if (failed.length) {
    say(yellow('  Some non-fatal beliefs were not confirmed — see above and update fakeRazorpay.js.'));
  }
  return { code: 0, results };
}

/**
 * Only run when invoked directly. Without this guard, importing the module to test it would
 * fire a real API call and then call process.exit() in the middle of the test runner.
 */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then(({ code }) => process.exit(code))
    .catch((e) => {
      // Even the crash path is redacted. An exception from the HTTP layer can carry a request
      // body, and a stack trace printed raw is a perfectly ordinary way to leak a key.
      say(red(`\nlive-check failed: ${safe(e instanceof RazorpayError ? e.toAudit() : e.message)}`));
      if (process.env.REBOUND_DEBUG) say(dim(safe(e.stack ?? '')));
      process.exit(1);
    });
}
