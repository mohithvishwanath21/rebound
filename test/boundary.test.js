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

const SRC = new URL('../src/', import.meta.url).pathname;

/** Directories whose code must never be able to see ground truth. */
const RESTRICTED = ['agent', 'api', 'razorpay'];

/** Tokens that indicate a read of simulator ground truth. */
const FORBIDDEN_TOKENS = [
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
