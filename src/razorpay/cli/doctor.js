/**
 * CREDENTIAL SHAPE DOCTOR
 * =======================
 *
 * Why this exists: `npm run live-check` correctly refuses to print your key or secret, and
 * `requireEnv` deliberately never echoes a bad value. Those are the right defaults — but they
 * leave you staring at a bare `401 Authentication failed` with no way to tell *which* of the
 * two values is wrong, and no way to ask for help without pasting a secret to someone.
 *
 * This command closes that gap without reopening the hole. It reports only *shape facts*:
 * lengths, character classes, whether there is stray whitespace or a smart quote, whether the
 * two values look like they were swapped. Every one of those is enough to identify the mistake
 * and none of them is enough to use the credential. The output is safe to paste anywhere.
 *
 * It makes NO network calls. A 401 has already told us the server's opinion; the useful
 * remaining question is what we sent, and that is answerable locally.
 *
 * The shapes below (23-char id, 24-char secret) are observed conventions, not documented
 * guarantees, so a mismatch is reported as SUSPICIOUS rather than as an error — a convention
 * that quietly changes should produce a hint, not a false accusation.
 */

import { loadEnv } from '../../core/env.js';
import { pathToFileURL } from 'node:url';

const EXPECTED_ID_PREFIX = 'rzp_test_';
const TYPICAL_ID_LENGTH = 23;
const TYPICAL_SECRET_LENGTH = 24;

let sink = console.log;
export function setSink(fn) {
  sink = fn ?? console.log;
}

const PASS = 'ok  ';
const WARN = 'HMM ';
const FAIL = 'BAD ';

/**
 * Describe a string without revealing it.
 *
 * The one concession: for the key ID we show the `rzp_test_` prefix, because it is a fixed
 * literal that every Razorpay test key shares and therefore carries no information. Nothing
 * after the prefix is shown, and nothing at all is shown for the secret.
 */
function shapeOf(raw) {
  if (raw === undefined) return { present: false };
  return {
    present: true,
    length: raw.length,
    trimmedLength: raw.trim().length,
    hasLeadingSpace: /^\s/.test(raw),
    hasTrailingSpace: /\s$/.test(raw),
    hasInnerSpace: /\S\s+\S/.test(raw),
    hasQuote: /["'`]/.test(raw),
    hasSmartQuote: /[‘’“”]/.test(raw),
    hasNonAscii: /[^\x20-\x7e]/.test(raw),
    hasEllipsis: raw.includes('...') || raw.includes('…'),
    hasAsterisk: raw.includes('*'),
    allAlnumBody: /^[A-Za-z0-9_]+$/.test(raw),
  };
}

function findings(keyId, keySecret) {
  const out = [];
  const id = shapeOf(keyId);
  const sec = shapeOf(keySecret);

  const add = (level, label, detail = '') => out.push({ level, label, detail });

  // ---- presence ----
  if (!id.present) add(FAIL, 'RAZORPAY_KEY_ID is not set', 'add it to .env');
  if (!sec.present) add(FAIL, 'RAZORPAY_KEY_SECRET is not set', 'add it to .env');
  if (!id.present || !sec.present) return out;

  // ---- the mistake that produces a 401 most often ----
  // The dashboard shows the secret exactly once, at generation. If it was missed, people
  // reasonably assume it can be re-read later and end up pasting something else entirely.
  if (sec.hasAsterisk || sec.hasEllipsis) {
    add(
      FAIL,
      'the secret contains * or ...',
      'that is the dashboard\'s MASKED display, not the secret. Razorpay shows the real ' +
        'secret only once, at generation time. Generate a new test key pair and copy it then.'
    );
  }

  // ---- swapped or duplicated ----
  if (keySecret.startsWith('rzp_')) {
    add(FAIL, 'the secret starts with rzp_', 'that is a key ID. The two values are swapped.');
  }
  if (keyId === keySecret) {
    add(FAIL, 'key id and secret are identical', 'the same value was pasted into both lines');
  }

  // ---- key id shape ----
  if (keyId.startsWith('rzp_live_')) {
    add(FAIL, 'this is a LIVE key', 'live-check refuses these by design. Use a test-mode key.');
  } else if (!keyId.startsWith(EXPECTED_ID_PREFIX)) {
    add(WARN, `key id does not start with ${EXPECTED_ID_PREFIX}`, `starts with "${keyId.slice(0, 4)}"`);
  } else {
    add(PASS, `key id starts with ${EXPECTED_ID_PREFIX}`);
  }

  // ---- lengths, the highest-signal check that reveals nothing ----
  const idNote = id.length === TYPICAL_ID_LENGTH ? PASS : WARN;
  add(
    idNote,
    `key id length ${id.length}`,
    id.length === TYPICAL_ID_LENGTH ? '' : `test key ids are usually ${TYPICAL_ID_LENGTH} characters — a short one means a truncated paste`
  );

  const secNote = sec.length === TYPICAL_SECRET_LENGTH ? PASS : WARN;
  add(
    secNote,
    `secret length ${sec.length}`,
    sec.length === TYPICAL_SECRET_LENGTH ? '' : `secrets are usually ${TYPICAL_SECRET_LENGTH} characters — this is the most common cause of a 401`
  );

  // ---- paste damage ----
  for (const [name, s] of [['key id', id], ['secret', sec]]) {
    if (s.hasLeadingSpace || s.hasTrailingSpace) {
      // Not currently reachable, because parseEnv trims — reported anyway so that if the
      // value arrived from the real environment rather than the file, we still catch it.
      add(WARN, `${name} has surrounding whitespace`, 'trimmed length differs from raw length');
    }
    if (s.hasInnerSpace) add(FAIL, `${name} contains a space in the middle`, 'a line wrap was copied along with the value');
    if (s.hasQuote) add(WARN, `${name} contains a quote character`, 'remove quotes from the .env line, or use a matched pair');
    if (s.hasSmartQuote) {
      add(FAIL, `${name} contains a typographic "smart" quote`, 'the value passed through Word or Notes; retype it in a plain editor');
    }
    if (s.hasNonAscii) add(FAIL, `${name} contains a non-ASCII character`, 'usually an invisible character from a rich-text copy');
    if (!s.allAlnumBody) add(WARN, `${name} has characters outside [A-Za-z0-9_]`, 'unexpected for a Razorpay credential');
  }

  return out;
}

export function main({ argv = process.argv.slice(2), envPath } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    sink('Usage: npm run doctor');
    sink('');
    sink('Checks the SHAPE of your Razorpay credentials in .env and explains a 401.');
    sink('Makes no network calls. Prints no key, no secret — output is safe to share.');
    return { code: 0, results: [] };
  }

  sink('Razorpay credential doctor  — local only, no network, no secrets printed');
  const env = loadEnv(envPath ? { path: envPath } : {});
  sink(env.loaded ? `  .env found (${env.keys.length} vars applied)` : '  no .env found at the repo root');
  sink('');

  const results = findings(process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET);
  for (const r of results) sink(`  ${r.level} ${r.label}${r.detail ? `\n         ${r.detail}` : ''}`);

  const bad = results.filter((r) => r.level === FAIL);
  const hmm = results.filter((r) => r.level === WARN);

  sink('');
  if (bad.length) {
    sink(`  ${bad.length} definite problem(s) above. Fix those and run npm run live-check again.`);
  } else if (hmm.length) {
    sink(`  Nothing conclusive, ${hmm.length} thing(s) worth a look.`);
    sink('  If the lengths are both normal and you still get a 401, the likeliest');
    sink('  explanation is that the secret belongs to a DIFFERENT key pair than the id —');
    sink('  they are only valid together. Generate a fresh test pair in the Razorpay');
    sink('  dashboard (Settings -> API Keys -> Generate Test Key) and copy BOTH values');
    sink('  from that one dialog, because the secret is never shown again afterwards.');
  } else {
    sink('  Both credentials look structurally fine.');
    sink('  A 401 with well-formed values almost always means the id and secret are from');
    sink('  different key pairs, or the key was regenerated after this .env was written.');
  }

  // Exit 0 even on findings: this is a diagnostic, and a non-zero exit would make it look
  // like the doctor itself failed. `live-check` is the command that gates on success.
  return { code: 0, results };
}

// `pathToFileURL`, not string concatenation: on Windows `process.argv[1]` is `C:\...\doctor.js`
// and `new URL('file://' + that)` is malformed, so the comparison would silently never match
// and `npm run doctor` would print nothing at all. This is Mohit's machine, so Windows is the
// primary case, not the edge case.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
