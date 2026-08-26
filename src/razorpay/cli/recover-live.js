#!/usr/bin/env node
/**
 * RECOVER-LIVE — one real payment, from a real decline to a real recovery.
 * ========================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Everything else that reports money in this project reports simulated money. The five-arm
 * comparison, the sensitivity sweep, the incremental-recovery figures — all of it runs against a
 * world model in `src/sim/`, which I wrote. That is the right tool for the question it answers
 * (you cannot run five competing policies against the same real customers, so you cannot measure
 * which policy is better without a counterfactual world), but it has an obvious and fair
 * objection attached to it:
 *
 *     "You wrote the world, you wrote how customers behave, and then you showed that your agent
 *      beats your baselines inside your own world. That is circular."
 *
 * It is circular, if the simulation is the only thing on offer. So this command exists to put the
 * agent's actual reasoning on top of a payment that really failed, at a provider I do not
 * control, for a reason I did not choose, and to carry it through to money that really arrives.
 *
 * Nothing here is scored, averaged, or compared. It is one case. One case cannot tell you a
 * policy is better — that is what the batch is for. What it can tell you is that the diagnosis
 * layer reads real provider payloads, that the pricing rule reaches the same conclusion on real
 * evidence as it does on generated evidence, and that the action it picks actually recovers the
 * money. Those are the three things a simulation genuinely cannot establish about itself.
 *
 * THE CASE THIS WAS BUILT AROUND
 * ------------------------------
 * On 2026-08-22 the first real payment this project ever attempted was declined, twice, with
 * `error_reason: international_transaction_not_allowed` — "this business accepts domestic
 * (Indian) card payments only". The test account is domestic-only, so card 4111 1111 1111 1111
 * can never be charged on it.
 *
 * That decline is the cleanest possible illustration of this project's whole thesis, and I did
 * not design it. Retrying the same card is worth exactly zero, forever, and not as an estimate —
 * it is what the decline *means*. Sending the same customer to UPI or netbanking recovers the
 * identical rupee. Same person, same amount, same minute, two actions whose expected values are
 * nowhere near each other. A retry loop cannot express the difference between them, and a fixed
 * ladder will spend three attempts finding that out.
 *
 * WHAT THIS DOES TO THE ACCOUNT
 * -----------------------------
 *   - Refuses to run against a key beginning `rzp_live_` (enforced in httpClient.js).
 *   - Reads the account's payments list, and creates test-mode payment links. Test mode only:
 *     no real money can move.
 *   - Sends NO email and NO SMS. The link is created and payable; Razorpay is told not to
 *     notify anybody and not to send its own reminders.
 *   - Never prints a key, a secret, or an unmasked contact. Every line, and the evidence file,
 *     goes through `redact()`, so the output is safe to paste anywhere.
 *
 * USAGE
 *   npm run recover-live                       beats 1-4: find the decline, diagnose it,
 *                                              price the options, issue a link on a live rail
 *   npm run recover-live -- --confirm plink_X   beat 5: read the recovery back
 *   npm run recover-live -- --replay            re-narrate the last real run, offline
 *
 * The `--replay` mode matters more than it looks. The live beats need network and a human to pay
 * a link; a recording session does not always have both. Replay reads a real run's evidence file
 * and prints exactly what that run printed, labelled as a replay with its original timestamp. It
 * invents nothing — if there is no evidence file, there is nothing to replay.
 */

import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { loadEnv, requireEnv } from '../../core/env.js';
import { createRazorpayClient, redact } from '../httpClient.js';
import { createLiveGateway } from '../liveGateway.js';
import { diagnose } from '../../agent/diagnose.js';
import { expectedValue } from '../../agent/expectedValue.js';
import { getRootCause } from '../../core/taxonomy.js';
import { ActionKind, Channel } from '../../core/actions.js';
import { LossType, Rail } from '../../core/enums.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * output
 * ───────────────────────────────────────────────────────────────────────────── */

let sink = (line) => process.stdout.write(`${line}\n`);
export function setSink(fn) {
  sink = fn;
}

const TTY = process.stdout.isTTY;
const paint = (code, s) => (TTY ? `[${code}m${s}[0m` : s);
const bold = (s) => paint('1', s);
const dim = (s) => paint('2', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const violet = (s) => paint('35', s);

/**
 * Beats are recorded as they are printed, so `--replay` can reproduce a real run exactly rather
 * than re-deriving it from stored fields and risking a prettier story than the one that happened.
 */
function makeReel() {
  const beats = [];
  let current = null;
  return {
    beats,
    open(n, of, title) {
      current = { n, of, title, lines: [] };
      beats.push(current);
      sink('');
      sink(`${violet(bold(`[${n}/${of}]`))} ${bold(title)}`);
    },
    say(line = '') {
      current?.lines.push(line);
      sink(line);
    },
    /** A key/value row, aligned so a viewer's eye can run down the left column. */
    kv(k, v, tone = null) {
      // 18, because `SWITCH_RAIL_NUDGE` is 17 characters and an action name that pushes the
      // value column out of line is the one row on this screen a viewer will be reading closely.
      const key = String(k).padEnd(18);
      current?.lines.push(`  ${key} ${v}`);
      sink(`  ${dim(key)} ${tone ? tone(v) : v}`);
    },
    note(text) {
      const wrapped = wrap(text, 92).map((l) => `     ${l}`);
      for (const l of wrapped) {
        current?.lines.push(l);
        sink(dim(l));
      }
    },
  };
}

function wrap(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const out = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out;
}

/**
 * THE SIGN IS NOT OPTIONAL, AND LEAVING IT OUT COST ME THE FIRST SMOKE RUN.
 *
 * I first wrote this as `₹${Math.round(Math.abs(paise) / 100)}` — copied from a formatter whose
 * inputs are all amounts, which are never negative. Every value on this screen except one is an
 * amount. The exception is the retry's expected value, which is negative *by definition* on a
 * decline that can never succeed, and it printed as `EV = ₹2`.
 *
 * That is the whole argument of beat 3 inverted on camera: the action the agent is refusing to
 * take appears to be worth two rupees rather than to cost them. A viewer reading `RETRY_NOW ₹2`
 * against `SWITCH_RAIL_NUDGE beats it above 1.35%` sees a formatter bug at best and a rigged
 * comparison at worst. The arithmetic underneath was right the entire time, which is exactly why
 * nothing would have caught it except looking at the output.
 */
const rupees = (paise) => {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '—';
  const sign = paise < 0 ? '−' : '';
  return `${sign}₹${Math.round(Math.abs(paise) / 100).toLocaleString('en-IN')}`;
};

/* ─────────────────────────────────────────────────────────────────────────────
 * args
 * ───────────────────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { confirm: null, ref: null, replay: false, amountPaise: 49900, help: false, contact: null, email: null };
  for (const a of argv) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--replay') args.replay = true;
    else if (a.startsWith('--confirm=')) args.confirm = a.slice(10);
    else if (a === '--confirm') args.confirm = '__NEXT__';
    else if (a.startsWith('--ref=')) args.ref = a.slice(6);
    else if (a.startsWith('--amount=')) args.amountPaise = Math.round(Number(a.slice(9)) * 100);
    else if (a.startsWith('--contact=')) args.contact = a.slice(10);
    else if (a.startsWith('--email=')) args.email = a.slice(8);
    else if (args.confirm === '__NEXT__') args.confirm = a;
  }
  if (args.confirm === '__NEXT__') args.confirm = null;
  return args;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * beat 1 — the failure, in the provider's own words
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Failed payments do NOT appear on a payment link entity's own `payments` array — observed
 * directly on 2026-08-22 as `link=0 account=2`. Successful ones do. That asymmetry is why this
 * reads the ACCOUNT payments list and joins back by our own `notes.rebound_ref`, and why anything
 * needing attempt history must never query the link.
 *
 * ON PICKING *WHICH* DECLINE, WHICH IS LESS OBVIOUS THAN IT LOOKS AND COST A FAILING TEST.
 *
 * `created_at` is unix SECONDS. Two declines a few seconds apart order fine; two declines inside
 * the same second do not order at all, and that is not a contrived case — it is what happens when
 * someone on camera hits the checkout twice in a row. My first version sorted descending by
 * `created_at` with a stable sort, which on a tie preserves the order the provider happened to
 * return, and it silently narrated the OLDEST of the tied declines. On a filmed run that means
 * narrating a decline from a previous session, with a different reason code, and finding out
 * halfway through the take.
 *
 * There is no field that resolves a tie. So this does not pretend to: it picks deterministically
 * (last of the tied group in provider order, which is the newer one in `test/fakeRazorpay.js` and
 * is UNVERIFIED against the real API's within-second ordering), and it *reports* the ambiguity
 * with the other candidates' references so the operator can settle it with `--ref` in one re-run.
 * A guess that announces itself is recoverable in eight seconds; a silent one is a wasted take.
 */
export function findRealDecline(list, { ref } = {}) {
  const items = Array.isArray(list) ? list : [];
  const failed = items.filter((p) => p?.status === 'failed');
  const scoped = ref ? failed.filter((p) => p?.notes?.rebound_ref === ref) : failed;
  if (scoped.length === 0) {
    return { chosen: null, tied: [], failedCount: failed.length, scannedCount: items.length };
  }

  const newest = Math.max(...scoped.map((p) => p.created_at ?? 0));
  const tied = scoped.filter((p) => (p.created_at ?? 0) === newest);
  return {
    chosen: tied[tied.length - 1],
    tied,
    failedCount: failed.length,
    scannedCount: items.length,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * beat 3 — pricing, without inventing a probability
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * EV is linear in p, so two evaluations describe the whole line and the break-even point is
 * exact rather than searched for.
 *
 * This matters for honesty. I could put a probability on the rail switch by running the recovery
 * model, but on a single live case that number would be an extrapolation from generated training
 * data dressed up as a measurement. The break-even framing needs no such number: it says what
 * has to be true for the decision to be right, and lets the viewer judge whether it is. The
 * retry side needs no estimate either — p is zero because that is what the decline means.
 */
function priceLine(action, { amountPaise, lossType }) {
  const at = (p) => expectedValue({ p, amountPaise, lossType, action, touchesUsed: 0 });
  const zero = at(0);
  const one = at(1);
  const evAt = (p) => Math.round(zero.evPaise + (one.evPaise - zero.evPaise) * p);
  return { zero, one, evAt, slope: one.evPaise - zero.evPaise };
}

function breakEvenP(better, worse) {
  // Solve evAt_better(p) = evAt_worse(0), i.e. the point where acting beats the alternative.
  if (better.slope <= 0) return null;
  const p = (worse.zero.evPaise - better.zero.evPaise) / better.slope;
  return Math.min(Math.max(p, 0), 1);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * evidence
 * ───────────────────────────────────────────────────────────────────────────── */

function evidenceDir(override) {
  return override ?? fileURLToPath(new URL('../../../docs/evidence/', import.meta.url));
}

/**
 * AN EVIDENCE FILE MUST NEVER SILENTLY REPLACE ANOTHER ONE.
 *
 * The name is an ISO timestamp to the millisecond, which I assumed was unique enough. It is not:
 * beats 1-4 and `--confirm` are minutes apart on a filmed run, but the test suite runs them back
 * to back inside the same millisecond, the second write landed on the first name, and the
 * directory ended up holding one file where two commands had run. The replay then had four beats
 * instead of five and blamed the missing one on the operator.
 *
 * `docs/evidence/` is the only place in this repo that holds records of things that really
 * happened, and it is committed. A write that overwrites a record there is worse than a crash, so
 * the name gets a counter rather than the file getting clobbered.
 */
function writeEvidence(summary, { dir } = {}) {
  const target = evidenceDir(dir);
  mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let path = join(target, `recover-live-${stamp}.json`);
  for (let n = 2; existsSync(path); n += 1) path = join(target, `recover-live-${stamp}-${n}.json`);
  writeFileSync(path, `${JSON.stringify(redact(summary), null, 2)}\n`);
  return path;
}

/**
 * REPLAY ASSEMBLES THE FIVE BEATS ACROSS FILES, AND THE FIRST VERSION DID NOT.
 *
 * The live run is deliberately split in two: beats 1-4 issue the link, then a human pays it, then
 * `--confirm` reads the recovery back as beat 5. That is two commands, so it is two evidence
 * files, and the newest one holds only beat 5. Reading "the newest file" therefore replayed a
 * single beat — the recovery, with no failure, no diagnosis and no pricing in front of it. Which
 * is to say: it replayed the money and threw away the argument.
 *
 * So this walks every file oldest-first and keeps the latest version of each beat number. Newest
 * wins per beat, which is what you want when you have re-run beats 1-4 a few times to get the
 * narration right. Each beat still comes from a real run, and the header names the runs it drew
 * from so a viewer can see it is a recording of two commands rather than one.
 */
function collectBeats(dir) {
  const target = evidenceDir(dir);
  let names = [];
  try {
    names = readdirSync(target).filter((n) => n.startsWith('recover-live-') && n.endsWith('.json'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  const loaded = [];
  for (const name of names) {
    let body;
    try {
      body = JSON.parse(readFileSync(join(target, name), 'utf8'));
    } catch {
      continue; // A half-written evidence file is not worth failing a replay over.
    }
    const beats = Array.isArray(body.beats) ? body.beats : [];
    if (beats.length === 0) continue;
    // The collision counter is `-2`, `-3`, ... appended after the timestamp. '-' sorts BEFORE '.'
    // in ASCII, so a plain lexical sort of filenames puts `...194Z-2.json` ahead of `...194Z.json`
    // and reverses the two writes it exists to distinguish. Order on the recorded timestamp, then
    // on that counter as a number.
    const seq = Number(name.match(/-(\d+)\.json$/)?.[1] ?? 1);
    loaded.push({ name, body, beats, seq });
  }
  loaded.sort((a, b) => String(a.body.at ?? '').localeCompare(String(b.body.at ?? '')) || a.seq - b.seq);

  const byNumber = new Map();
  const sources = [];
  for (const { name, body, beats } of loaded) {
    sources.push({ name, at: body.at, keyIdPrefix: body.keyIdPrefix, mode: body.mode, beatNumbers: beats.map((b) => b.n) });
    for (const beat of beats) byNumber.set(beat.n, { ...beat, at: body.at });
  }
  if (byNumber.size === 0) return null;

  const ordered = [...byNumber.values()].sort((a, b) => a.n - b.n);
  const missing = [1, 2, 3, 4, 5].filter((n) => !byNumber.has(n));
  return { ordered, missing, sources, last: sources[sources.length - 1] };
}

function replay({ dir } = {}) {
  const found = collectBeats(dir);
  if (!found) {
    sink(red('\nNo recover-live evidence to replay.'));
    sink(dim('  Replay prints a real run back. There has not been one yet, and it will not invent one.'));
    sink(dim('  Run `npm run recover-live` once while you have network and keys.\n'));
    return { code: 1, replayed: false, beats: [] };
  }
  const { ordered, missing, sources, last } = found;
  sink('');
  sink(bold('REBOUND — ONE REAL PAYMENT, DECLINE TO RECOVERY') + dim('   (replay)'));
  sink(dim(`  key ${last.keyIdPrefix} · mode ${last.mode} · assembled from ${sources.length} real run(s):`));
  for (const s of sources) sink(dim(`    ${s.at}  beats ${s.beatNumbers.join(',')}`));
  sink(dim('  Every line below was printed by one of those runs against api.razorpay.com. Nothing is recomputed.'));
  if (missing.length) {
    sink(yellow(`  Beat(s) ${missing.join(', ')} were never recorded, so they are not shown.`));
  }
  for (const beat of ordered) {
    sink('');
    sink(`${violet(bold(`[${beat.n}/${beat.of}]`))} ${bold(beat.title)}`);
    for (const l of beat.lines) sink(dim(l));
  }
  sink('');
  return { code: missing.length ? 2 : 0, replayed: true, beats: ordered, missing };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * main
 * ───────────────────────────────────────────────────────────────────────────── */

export async function main({ argv = process.argv.slice(2), fetchImpl, sleep, evidenceDir: dir, envPath } = {}) {
  const args = parseArgs(argv);

  if (args.help) {
    sink(
      [
        '',
        'Usage: npm run recover-live [-- options]',
        '',
        '  (no options)              find a real decline, diagnose it, price the options, issue a link',
        '  --confirm <plink_id>      read the recovery back after paying the link',
        '  --replay                  re-narrate the last real run, offline, from its evidence file',
        '  --ref <reference_id>      scope the search to one link\'s rebound_ref',
        '  --amount <rupees>         amount for the recovery link (default 499)',
        '',
      ].join('\n')
    );
    return { code: 0 };
  }

  if (args.replay) return replay({ dir });

  const env = loadEnv(envPath ? { path: envPath } : undefined);
  const keyId = requireEnv('RAZORPAY_KEY_ID', 'It must begin rzp_test_.');
  const keySecret = requireEnv('RAZORPAY_KEY_SECRET');

  const calls = [];
  const onLog = (line) => {
    calls.push(line);
    if (line.event === 'http') sink(dim(`    -> ${line.method} ${line.path} ${line.status} (${line.ms}ms)`));
  };

  const http = createRazorpayClient({
    keyId,
    keySecret,
    onLog,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(sleep ? { sleep } : {}),
  });
  const gw = createLiveGateway({ keyId, keySecret, client: http, onLog });
  const runId = `rec_${Date.now().toString(36)}`;
  const reel = makeReel();

  sink('');
  sink(bold('REBOUND — ONE REAL PAYMENT, DECLINE TO RECOVERY'));
  sink(dim(`  real Razorpay API · test mode · key ${http.keyIdPrefix}... · ${gw.mode}`));
  sink(dim(`  .env ${env.loaded ? `loaded (${env.keys.length} vars)` : 'not found — reading process env only'}`));

  /* ---------------------------------------------------------------- beat 5 only */
  if (args.confirm) {
    reel.open(5, 5, 'THE RECOVERY — money that actually arrived');
    const link = await http.get(`/payment_links/${args.confirm}`);
    const l = link.body ?? {};
    const paid = l.status === 'paid' || (l.amount_paid ?? 0) > 0;
    reel.kv('link', args.confirm);
    reel.kv('status', l.status ?? '—', paid ? green : yellow);
    reel.kv('amount_paid', `${rupees(l.amount_paid)} of ${rupees(l.amount)}`, paid ? green : dim);
    reel.kv('reference', l.reference_id ?? '—');

    // Successful payments DO appear on the link entity — the other half of the asymmetry.
    const on = Array.isArray(l.payments) ? l.payments : [];
    if (on.length) {
      for (const p of on) reel.kv('payment', `${p.payment_id ?? p.id ?? '—'}  method=${p.method ?? '—'}  ${p.status ?? ''}`, green);
      reel.note(
        'The payment that recovered the money is attached to the link entity. Declined attempts were not — ' +
          'they were only visible on the account payments list. That asymmetry is real provider behaviour, ' +
          'confirmed from both sides on 2026-08-22, and it is why the attempt history in this project never ' +
          'trusts the link alone.'
      );
    }
    if (paid) {
      reel.say('');
      reel.say(`  ${green(bold('RECOVERED'))} ${rupees(l.amount_paid)} — on a rail this account accepts.`);
      reel.note(
        'The same rupee the card refused. Nothing about the customer changed, nothing about the amount ' +
          'changed, and no retry of the original instrument could have produced this. Only the rail changed.'
      );
    } else {
      reel.note('Not paid yet. Open the link, pay with UPI id success@razorpay, then run this again.');
    }

    const path = writeEvidence(
      { runId, at: new Date().toISOString(), keyIdPrefix: http.keyIdPrefix, mode: gw.mode, beats: reel.beats, httpCalls: calls },
      { dir }
    );
    sink(dim(`\n  evidence written to ${path.replace(/^.*[/\\]docs[/\\]/, 'docs/').replace(/\\/g, '/')}\n`));
    return { code: paid ? 0 : 2, paid, beats: reel.beats };
  }

  /* ---------------------------------------------------------------- beat 1 */
  reel.open(1, 5, 'THE FAILURE — what Razorpay actually returned');
  const listed = await http.get('/payments', { query: { count: 100 } });
  const { chosen, tied, failedCount, scannedCount } = findRealDecline(listed.body?.items ?? [], { ref: args.ref });
  if (!chosen) {
    reel.say(`  ${yellow('No failed payment found')} in the last ${scannedCount} payments on this account.`);
    reel.note(
      'This command narrates a real decline; it will not fabricate one. To create one: run ' +
        '`npm run live-check` to issue a payment link, open it, and pay with card 4111 1111 1111 1111. ' +
        'On a domestic-only test account that card is refused with international_transaction_not_allowed, ' +
        'which is the decline this whole demo is built around. Then run this command again.'
    );
    sink('');
    return { code: 2, found: false };
  }

  reel.kv('payment', `${chosen.id}   ${rupees(chosen.amount)}   method=${chosen.method ?? '—'}`);
  reel.kv('status', chosen.status, red);
  reel.kv('error_code', chosen.error_code ?? '—');
  reel.kv('error_reason', chosen.error_reason ?? '—', bold);
  if (chosen.error_description) reel.kv('description', `"${chosen.error_description}"`);
  reel.kv('our ref', chosen.notes?.rebound_ref ?? '(not one of ours)');
  reel.note(
    `Those are Razorpay's fields, read from the account payments list — ${failedCount} declined payment(s) ` +
      'found among the last ' + scannedCount + '. Nothing below this line is written by hand; the next step ' +
      'feeds this exact payload into the diagnosis layer.'
  );
  if (tied.length > 1) {
    const others = tied
      .filter((p) => p.id !== chosen.id)
      .map((p) => p.notes?.rebound_ref ?? p.id)
      .join(', ');
    reel.say(
      `  ${yellow(`${tied.length} declines share this timestamp — created_at is only accurate to the second.`)}`
    );
    reel.note(
      `If the one narrated above is not the attempt you just made, re-run with --ref=<reference>. The other ` +
        `candidate(s): ${others}.`
    );
  }

  /* ---------------------------------------------------------------- beat 2 */
  reel.open(2, 5, 'THE DIAGNOSIS — what Rebound made of it');
  // The raw provider entity goes straight in. `toFailureSignal` accepts a Razorpay payment
  // object directly, so there is no hand-written translation step here to quietly help it.
  const dx = await diagnose(chosen);
  const cause = getRootCause(dx.rootCause);
  reel.kv('root cause', `${dx.rootCause}  (${cause.label})`, bold);
  reel.kv('matched at', `${dx.source} / ${dx.matchTier} tier, on ${dx.matchedOn ?? '—'}`);
  if (dx.evidenceDate) reel.kv('evidence', `pattern confirmed against the live API on ${dx.evidenceDate}`, green);
  reel.kv('fault', dx.physics.fault);
  reel.kv(
    'physics',
    `retryCanSucceed=${dx.physics.retryCanSucceed}  railSwitchIsPrimary=${dx.physics.railSwitchIsPrimary}  ` +
      `messagingAppropriate=${dx.physics.messagingAppropriate}`
  );
  reel.kv('abstained', String(dx.abstained));
  reel.note(cause.explanation);
  if (dx.rootCause === 'INSTRUMENT_NOT_ACCEPTED') {
    reel.note(
      'This is the only class in the taxonomy that was found rather than imagined. The twelve I wrote ' +
        'before touching the API did not cover this payload: it fell through every rule to UNKNOWN, which ' +
        'permits one cautious retry — so the considered answer to a decline that can never succeed was to ' +
        'try it again. The class, and the railSwitchIsPrimary flag that separates "press a different button" ' +
        'from "go and find another card", both exist because of this one real decline.'
    );
  }

  /* ---------------------------------------------------------------- beat 3 */
  reel.open(3, 5, 'THE PRICING — every action, in rupees');
  const amountPaise = chosen.amount ?? args.amountPaise;
  const lossType = LossType.FAILED_PAYMENT;
  const retry = { kind: ActionKind.RETRY_NOW, channel: null };
  const nudge = { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.WHATSAPP, preferredRail: Rail.UPI };

  const retryLine = priceLine(retry, { amountPaise, lossType });
  const nudgeLine = priceLine(nudge, { amountPaise, lossType });

  // p is zero on the retry because the taxonomy says the rail cannot accept this instrument.
  // That is a fact about the decline, not a model output, which is why it is quoted as 0.00.
  //
  // If the cause DOES permit a retry, there is no honest fixed p to quote, so the comparison
  // falls back to the only baseline that needs no probability at all: doing nothing, worth zero.
  const retryImpossible = !dx.physics.retryCanSucceed;
  const alternativePaise = retryImpossible ? retryLine.evAt(0) : 0;

  if (retryImpossible) {
    reel.kv('RETRY_NOW', `p = 0.00 (fixed by the cause)   EV = ${rupees(alternativePaise)}`, red);
    reel.note(
      'Not an estimate. international_transaction_not_allowed means this account cannot accept this ' +
        'instrument, so the retry is a cost with no upside — today, tomorrow, and on the third attempt a ' +
        'fixed ladder would also spend.'
    );
  } else {
    reel.kv('RETRY_NOW', 'this cause permits a retry, so no fixed p can be quoted here', yellow);
    reel.note(
      'The break-even below is therefore stated against doing nothing, which is worth exactly zero and ' +
        'needs no probability. A retry-versus-nudge comparison on this cause belongs in the batch, where ' +
        'both probabilities come from a model scored on held-out data.'
    );
  }

  const be = breakEvenP(nudgeLine, { zero: { evPaise: alternativePaise } });
  reel.kv(
    'SWITCH_RAIL_NUDGE',
    `beats ${retryImpossible ? 'the retry' : 'doing nothing'} at any p > ` +
      `${be === null ? '—' : `${(be * 100).toFixed(2)}%`}`,
    green
  );
  reel.note(
    'Deliberately quoted as a break-even rather than a point estimate. Putting a probability on a single ' +
      'live case would mean extrapolating from generated training data and presenting it as a measurement. ' +
      'The break-even says what would have to be true for this decision to be wrong, which is a claim the ' +
      'viewer can check. The calibrated probabilities live in the batch evaluation, where they were scored ' +
      'against held-out data.'
  );
  reel.say('');
  reel.say(`  ${bold('DECISION')} ${green('SWITCH_RAIL_NUDGE')} — move the customer to a rail this account accepts.`);

  /* ---------------------------------------------------------------- beat 4 */
  reel.open(4, 5, 'THE ACTION — a real link, on a rail that works');
  const receipt = await gw.sendPaymentLink({
    runId,
    eventId: chosen.notes?.rebound_ref ?? chosen.id,
    decisionSeq: 1,
    action: nudge,
    amountPaise,
    preferredRail: Rail.UPI,
    description: 'Rebound recovery — alternate rail',
    customer: { name: 'Rebound demo', contact: args.contact ?? undefined, email: args.email ?? undefined },
  });

  const plink = receipt?.providerRef ?? receipt?.id ?? null;
  const url = receipt?.shortUrl ?? receipt?.short_url ?? receipt?.raw?.short_url ?? null;
  reel.kv('link', plink ?? '—', bold);
  if (url) reel.kv('url', url, bold);
  reel.kv('amount', rupees(amountPaise));
  /**
   * DELIBERATELY NOT "UPI, netbanking, wallet, card". Nothing on the payment-link entity says which
   * methods this account has enabled, so listing them would be me narrating a configuration I never
   * read. What I can say is verified from both ends: the link carries no restriction, and a real
   * recovery on this account arrived on netbanking on 2026-08-22.
   */
  reel.kv('methods', 'unrestricted — the payer chooses; the 22 Aug recovery arrived on netbanking');

  /**
   * THIS BEAT USED TO CLAIM `upi_link=true — this link can only be paid on UPI`, AND THE CLAIM WAS
   * FALSE FOR AS LONG AS IT EXISTED. Razorpay refuses the flag in test mode. The caveat below is
   * read off the receipt rather than typed here, so if the gateway ever stops recording it this
   * line disappears from the video instead of turning back into a lie.
   */
  const railCaveat = (receipt?.caveats ?? []).find((c) => /upi_link/i.test(c)) ?? null;
  if (railCaveat) {
    reel.kv('caveat', 'upi_link requested, NOT applied', yellow);
    reel.note(railCaveat);
    reel.note(
      'Worth pausing on, because it is the most useful thing that has gone wrong on this project. A ' +
        'UPI-only link saves the customer a tap, so the gateway set that flag on every rail nudge and ' +
        'the whole test suite agreed it worked — the fake I test against accepted the flag because I am ' +
        'the one who wrote the fake. The real API returns "UPI Payment Links is not supported in Test ' +
        'Mode", and this account is test mode by construction, so that code path had never once worked. ' +
        'A fake encodes my own beliefs, which is precisely why it cannot falsify them; only a live call ' +
        'could. The decision itself is untouched: the declined card cannot be authorised at all, and ' +
        'this link puts no method restriction in the payer\'s way. What is lost is one tap, and what ' +
        'is gained is a receipt that says so.'
    );
  }
  reel.kv('notify', 'sms=false email=false reminder_enable=false');
  reel.note(
    'No message was sent to anybody. Razorpay would happily notify and re-remind on its own schedule, ' +
      'which would put contacts outside this project\'s own contact ledger and silently break the messaging ' +
      'cap the guardrails enforce — so reminders are disabled at creation.'
  );
  reel.say('');
  reel.say(`  ${yellow(bold('YOUR TURN'))} open that url and pay it with UPI id  ${bold('success@razorpay')}`);
  reel.say(`  ${dim('then run')}  npm run recover-live -- --confirm ${plink ?? 'plink_XXXX'}`);

  const path = writeEvidence(
    {
      runId,
      at: new Date().toISOString(),
      keyIdPrefix: http.keyIdPrefix,
      mode: gw.mode,
      declinedPayment: chosen.id,
      diagnosis: dx,
      issuedLink: plink,
      beats: reel.beats,
      httpCalls: calls,
    },
    { dir }
  );
  sink(dim(`\n  evidence written to ${path.replace(/^.*[/\\]docs[/\\]/, 'docs/').replace(/\\/g, '/')}\n`));
  return { code: 0, declined: chosen.id, diagnosis: dx, link: plink, beats: reel.beats };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main()
    .then((r) => process.exit(r?.code ?? 0))
    .catch((err) => {
      sink(red(`\n  ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`));
      sink(dim('  Nothing was retried automatically. Fix the cause and run the command again.\n'));
      process.exit(1);
    });
}
