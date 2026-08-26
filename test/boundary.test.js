/**
 * THE HONESTY BOUNDARY, ENFORCED BY CI.
 *
 * The central claim of this project's evaluation is that the agent must *infer* why a
 * payment failed. If agent code could read `latent_truth`, every reported number would
 * be a model grading its own answer key — and the lift would measure nothing.
 *
 * Comments do not enforce that. This file does.
 *
 * The rule is directional, not blanket:
 *   - `src/agent/**`, `src/api/**`, `src/razorpay/**`  MUST NOT reach latent truth.
 *   - `src/eval/**` MAY: scoring is exactly the job of comparing beliefs to truth.
 *   - `src/sim/**` obviously may.
 *
 * A blanket ban would be wrong and would get disabled the first time the eval needed to
 * score something, which is how these tests usually die.
 *
 * Run: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUND_TRUTH_TOKENS } from '../src/core/groundTruthTokens.js';

/**
 * `fileURLToPath`, NOT `new URL(...).pathname`.
 *
 * On POSIX the two agree, which is exactly why this was wrong for five days without failing here.
 * On Windows `.pathname` yields '/C:/MohithFiles/...' — with a leading slash — and `join` then
 * treats that as drive-relative, producing 'C:\C:\MohithFiles\...' and an ENOENT. So this file
 * passed on Linux and failed on the machine the project actually lives on.
 *
 * This is the same bug as the Day 3 entry "Worked on POSIX, wrote to C:\C:\ on Windows", recurring
 * in a new file because the lesson was written down and never enforced anywhere. `src/core/env.js`
 * and `src/razorpay/cli/live-check.js` already did it correctly, and live-check even carries a
 * comment warning about it — which made this a bug I had already documented the fix for.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * Directories whose code must never be able to see ground truth.
 *
 * `ml` joined this list on Day 5, before the feature extractor was written rather than after.
 * That ordering was deliberate: a feature extractor is the single most tempting place in the
 * project to reach for a latent variable, because `payerType` would make the model look
 * extraordinary and the code would read completely innocently. The extractor's whole job is to
 * decide what the model may know, so the constraint belongs in the test file first and the
 * implementation second.
 */
const RESTRICTED = ['agent', 'api', 'razorpay', 'ml'];

/** The annotated history of why each token is on the register. Pinned as a subset below. */
const LOCAL_TOKENS = [
  'latent_truth',     // the collection name
  'LatentTruth',      // the mongoose model
  'latentTruth',      // the module
  'trueRootCause',    // the answer key for diagnosis
  'payerType',        // the answer key for the policy problem
  'willSelfRecover',  // would let the agent skip cases that recover for free
  'patienceBudget',   // would let the agent read fatigue tolerance directly
  'workingRails',     // would let the agent read which rail actually works
  'fundsAvailableFrom',
  'maxWillingToPayPaise',
  'trueDowntimeWindow',
  // Added on Day 4, after finding it by accident rather than by reasoning.
  //
  // `buildFailurePayload()` in the generator attaches `_generatedVague: true` to exactly those
  // failures whose error text was deliberately chosen to be unmatchable. The comment beside it
  // said "stripped before the agent sees it." Nothing stripped it. No test enforced it. And it
  // was not on this list, because when this list was written the field did not exist.
  //
  // Reading it would let the agent know in advance which cases are hard — it could abstain on
  // precisely those and post a diagnosis accuracy no real integration could reproduce. It is
  // the answer key for the only metric Day 4 produces.
  //
  // Worth being honest about what this addition does and does not fix: a denylist can only
  // ever catch names somebody thought of. That is why `src/agent/observe.js` projects events
  // through an ALLOWLIST at runtime, so the next field nobody thought of is invisible by
  // default. This entry stops the intent at build time; the allowlist stops the data. Two
  // mechanisms that fail differently, on purpose.
  '_generatedVague',
  'trueCause',
];

/**
 * WHY THE SCAN NOW RUNS OVER THE SHARED REGISTER AND NOT THE LIST ABOVE.
 *
 * Day 10 gave this denylist a second consumer: the dashboard serves case records over HTTP, and the
 * store's records carry `event.failure._generatedVague`, which a build-time scan of agent source can
 * never catch — no agent file names the field, the generator writes it and the store copies the event
 * wholesale. So `test/api.test.js` grew a runtime check over real HTTP responses, reading
 * `GROUND_TRUTH_TOKENS` from `src/core/groundTruthTokens.js`. That file's own header warned what
 * happens next: "two checks reading two copies of a denylist is a bug waiting for one of them to be
 * updated alone."
 *
 * It happened. `selfRecoverAt` — the instant an untouched case would have paid on its own, and the
 * single most valuable field in the world model, because an agent reading it would skip precisely the
 * cases needing no help and post a recovery rate nothing could reproduce — was added to the shared
 * register on Day 10 for the runtime check and never reached the list above. For 16 days the
 * build-time scan would not have flagged agent code reading it. Nothing was reading it, so no number
 * in this project is affected; the guard was simply narrower than it advertised, which is the failure
 * mode a guard is least likely to report about itself.
 *
 * The scan therefore reads the shared register. `LOCAL_TOKENS` is retained only as the annotated
 * history of why each entry exists — the reasoning is worth keeping — and the assertion below pins it
 * as a subset, so the two can never disagree about a token again while the register stays free to grow.
 */
const FORBIDDEN_TOKENS = GROUND_TRUTH_TOKENS;

test('the denylist has one source of truth, and the annotated history has not drifted from it', () => {
  const drifted = LOCAL_TOKENS.filter((t) => !GROUND_TRUTH_TOKENS.includes(t));
  assert.deepEqual(
    drifted,
    [],
    `tokens documented here but absent from the shared register: ${drifted.join(', ')}`
  );
  assert.ok(
    GROUND_TRUTH_TOKENS.includes('selfRecoverAt'),
    'selfRecoverAt is the highest-value latent in the world model and must be on the register'
  );
});

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith('.js') || entry.endsWith('.jsx')) out.push(full);
  }
  return out;
}

/** Strip comments so prose *about* the boundary doesn't trip the check on itself. */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every module specifier this source imports, static or dynamic. */
function importsOf(code) {
  const specs = [];
  const re = /(?:import|export)[\s\S]{0,200}?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * The two detectors, factored out so they can be pointed at both the real tree and a
 * known-bad snippet. That second use is the important one — see the self-check test.
 */
function findSimImports(source) {
  return importsOf(stripComments(source)).filter((spec) =>
    /(^|[\\/])sim([\\/]|$)/.test(spec.split('/').join(sep))
  );
}

function findGroundTruthTokens(source) {
  const code = stripComments(source);
  return FORBIDDEN_TOKENS.filter((token) => code.includes(token));
}

test('restricted directories do not import from the simulator', () => {
  const violations = [];
  for (const area of RESTRICTED) {
    for (const file of walk(join(SRC, area))) {
      for (const spec of findSimImports(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
  }
  assert.deepEqual(
    violations, [],
    `Agent-side code must not import simulator internals:\n  ${violations.join('\n  ')}`
  );
});

test('restricted directories never reference ground-truth fields', () => {
  const violations = [];
  for (const area of RESTRICTED) {
    for (const file of walk(join(SRC, area))) {
      for (const token of findGroundTruthTokens(readFileSync(file, 'utf8'))) {
        violations.push(`${relative(SRC, file)} references "${token}"`);
      }
    }
  }
  assert.deepEqual(
    violations, [],
    `Ground-truth fields leaked into agent-side code:\n  ${violations.join('\n  ')}`
  );
});

/**
 * SELF-CHECK — the test that stops the two above from being theatre.
 *
 * Both checks above pass by finding nothing. A check that passes by finding nothing is
 * indistinguishable from a check that *cannot* find anything: a typo'd regex, a wrong
 * root path, or an empty directory list all read green. Since this is the one test the
 * project's honesty claim depends on, it has to demonstrate on every run that it would
 * actually catch the thing it exists to catch.
 *
 * So we feed the detectors source text that violates the boundary, and assert they
 * complain. This replaced an earlier version that used a hand-maintained
 * `AGENT_CODE_EXISTS` flag — that only proved the scan touched files, not that the
 * detectors worked, and it required me to remember to flip it.
 */
test('the detectors actually detect (negative control)', () => {
  const violating = `
    import { LatentTruth } from '../sim/latentTruth.js';
    import { PayerType } from '../sim/payerTypes.js';
    export async function decide(event) {
      const truth = await LatentTruth.findOne({ eventId: event.eventId });
      if (truth.payerType === PayerType.NEVER_PAYING) return 'STOP';
      if (truth.willSelfRecover) return 'WAIT';
      return 'RETRY';
    }
  `;

  const imports = findSimImports(violating);
  assert.ok(imports.length >= 2, `expected sim imports to be flagged, got ${JSON.stringify(imports)}`);

  const tokens = findGroundTruthTokens(violating);
  for (const expected of ['LatentTruth', 'latentTruth', 'payerType', 'willSelfRecover']) {
    assert.ok(tokens.includes(expected), `detector missed ground-truth token "${expected}"`);
  }

  // And the inverse: legitimate agent code must not be flagged, or the check would be
  // useless in the other direction — a detector everyone learns to ignore.
  const clean = `
    import { getRootCause } from '../core/taxonomy.js';
    import { COSTS } from '../core/config.js';
    export function decide(event) {
      const cause = getRootCause(event.failure);
      return cause.retryCanSucceed ? 'RETRY' : 'REQUEST_REAUTH';
    }
  `;
  assert.deepEqual(findSimImports(clean), [], 'clean agent code was wrongly flagged');
  assert.deepEqual(findGroundTruthTokens(clean), [], 'clean agent code was wrongly flagged');
});

test('the simulator keeps ground truth in its own collection', () => {
  const latent = readFileSync(join(SRC, 'sim', 'latentTruth.js'), 'utf8');
  assert.match(
    latent, /collection:\s*'latent_truth'/,
    'latent truth must live in a dedicated collection, not embedded in world models'
  );

  // The observable world must not carry the answer key, however convenient that would be.
  const world = readFileSync(join(SRC, 'db', 'models', 'world.js'), 'utf8');
  for (const token of ['trueRootCause', 'payerType', 'willSelfRecover', 'patienceBudget']) {
    assert.ok(
      !stripComments(world).includes(token),
      `world.js must not contain "${token}" — the agent reads these models`
    );
  }
});

/**
 * REGRESSION: no filesystem path is built from `new URL(...).pathname`.
 *
 * This check exists because the underlying bug has now happened TWICE — once in Day 3's evidence
 * writer, and again on line 26 of this very file, which spent five days passing on Linux and
 * failing on Windows with 'C:\C:\MohithFiles\...'. Both times the lesson was written into the
 * engineering log, and writing it down did not stop it recurring, because nothing checked.
 *
 * On POSIX `.pathname` and `fileURLToPath` agree, so the bug is invisible in any environment where
 * the tests are normally run and fatal on the machine the project is developed on. That asymmetry is
 * what makes it worth a static check rather than trust.
 *
 * Deliberately narrow: it only fires on a URL built from `import.meta.url`, so ordinary use of
 * `.pathname` on a network URL — which the Razorpay test fakes do legitimately, to route a request —
 * is untouched. A check that flagged those would be turned off within a week.
 */
test('REGRESSION: filesystem paths use fileURLToPath, never URL.pathname', () => {
  const ROOT = fileURLToPath(new URL('../', import.meta.url));
  const offenders = [];

  for (const dir of ['src', 'test']) {
    for (const file of walk(join(ROOT, dir))) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // `new URL(<anything>import.meta.url<anything>).pathname`
      if (/new\s+URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/.test(code)) {
        offenders.push(relative(ROOT, file));
      }
    }
  }

  assert.deepEqual(
    offenders, [],
    `these build a filesystem path from URL.pathname, which yields '/C:/...' on Windows and then ` +
    `joins to 'C:\\C:\\...'. Use fileURLToPath(new URL(...)) instead: ${offenders.join(', ')}`
  );
});

/**
 * And the negative control, because a static check that cannot fail is decoration. The Day 4 lesson
 * was that a detector which has never fired is indistinguishable from a detector that does not work.
 */
test('the pathname detector actually detects (negative control)', () => {
  // Assembled from fragments on purpose. Spelling the bad form out as a literal would put it in this
  // file's own source, and the scan above reads every file in `test/` — including this one. A static
  // check that scans the tree cannot keep its own counter-example as a literal.
  const PATHNAME = '.path' + 'name';
  const bad = `const SRC = new URL('../src/', import.meta.url)${PATHNAME};`;
  const good = `const SRC = fileURLToPath(new URL('../src/', import.meta.url));`;
  const re = /new\s+URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/;
  assert.ok(re.test(bad), 'the detector missed the exact line that broke on Windows');
  assert.ok(!re.test(good), 'the detector flagged the correct form');
});
