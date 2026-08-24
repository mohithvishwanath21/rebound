/**
 * RNG TESTS
 * =========
 *
 * Every number in this project — every generated customer, every failure, every Bernoulli outcome
 * draw, every train/test split — comes out of `src/core/rng.js`. That makes this the highest-leverage
 * file in the repo to get wrong, and it was wrong for four days without a single test failing.
 *
 * THE BUG THESE TESTS EXIST TO PIN
 * -------------------------------
 * `makeRng` and `deriveSeed` both began with `seed >>> 0`. That is correct for numbers. But `>>>`
 * coerces via ToUint32, ToUint32 of a non-numeric string is NaN, and `NaN >>> 0` is `0`. So every
 * string seed in the project silently became zero:
 *
 *     'day4' >>> 0  ===  0        'day5' >>> 0  ===  0        'anything' >>> 0  ===  0
 *
 * `deriveSeed(parent, label)` therefore hashed only the label. `deriveSeed('day4', 'events')` and
 * `deriveSeed('day5', 'events')` returned the same number — 3110982872 — as did every other named
 * seed. Consequence: identical customers, identical events, identical outcome draws, identical
 * fit/validation split, identical GBM subsample, no matter what seed was requested.
 *
 * WHY IT SURVIVED SO LONG
 * ----------------------
 * Because it broke the property nobody was testing while preserving the one everybody was. Runs were
 * still perfectly DETERMINISTIC, so `npm test` passed, the report reproduced exactly, and the
 * reproducibility claim in the README was true. What was silently false was seed VARIATION — and
 * that is the property underwriting every statement of the form "this result is not an artefact of
 * one particular draw." A `--seed` flag that does nothing is worse than no flag, because its presence
 * invites precisely the claim it cannot support.
 *
 * It was caught by an almost embarrassingly obvious assertion: two different seeds should give two
 * different splits. That test nearly went unwritten for being too trivial to bother with.
 *
 * The lesson worth carrying forward is that determinism and variation are two different properties,
 * and testing one tells you nothing about the other.
 *
 * Run: node --test test/rng.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRng, deriveSeed } from '../src/core/rng.js';

// ---------------------------------------------------------------------------------------------
// THE REGRESSION
// ---------------------------------------------------------------------------------------------

test('REGRESSION: different STRING seeds derive different child seeds', () => {
  // The exact assertion that would have caught the original bug on day one.
  const labels = ['events', 'customers', 'dataset', 'eventsplit', 'gbm'];
  for (const label of labels) {
    const a = deriveSeed('day4', label);
    const b = deriveSeed('day5', label);
    assert.notEqual(a, b, `deriveSeed ignored the seed for label "${label}": both gave ${a}`);
  }
});

test('REGRESSION: a string seed is not silently coerced to zero', () => {
  // `'day5' >>> 0` is 0, so before the fix these two were the same stream.
  const named = makeRng('day5');
  const zero = makeRng(0);
  const a = Array.from({ length: 5 }, () => named.next());
  const b = Array.from({ length: 5 }, () => zero.next());
  assert.notDeepEqual(a, b, 'a named seed must not collapse onto the numeric seed 0');
});

test('REGRESSION: every character of a string seed contributes', () => {
  // A hash that only mixed the first or last character would pass the test above and still throw
  // away most of the seed space.
  const seeds = ['a', 'b', 'aa', 'ab', 'ba', 'day5', 'day6', '5day', 'DAY5'];
  const firstDraw = new Map();
  for (const s of seeds) {
    const v = makeRng(s).next();
    for (const [other, ov] of firstDraw) {
      assert.notEqual(v, ov, `seeds "${s}" and "${other}" produced the same stream`);
    }
    firstDraw.set(s, v);
  }
});

test('REGRESSION: deriveSeed cannot collide by concatenation', () => {
  // Without a separator, ('day', '5events') and ('day5', 'events') hash the same bytes. Same species
  // of bug as the one above — a seed silently sharing a stream with a different seed.
  assert.notEqual(
    deriveSeed('day', '5events'),
    deriveSeed('day5', 'events'),
    'seed and label must not be able to run together'
  );
});

test('deriveSeed separates subsystems, so adding a draw in one cannot shift another', () => {
  // The reason deriveSeed exists at all. If customers and events shared a stream, inserting one
  // extra random call into event generation would shift the whole customer population and silently
  // invalidate any comparison between two runs.
  const labels = ['customers', 'events', 'dataset', 'eventsplit', 'gbm', 'oracle'];
  const seen = new Map();
  for (const label of labels) {
    const v = deriveSeed('day5', label);
    assert.ok(!seen.has(v), `labels "${label}" and "${seen.get(v)}" share a stream`);
    seen.set(v, label);
  }
});

test('adjacent NUMERIC seeds give well-separated streams', () => {
  // mulberry32 started from adjacent state produces visibly correlated early output, and sequential
  // seeds are the common case in a sensitivity sweep (--seed 1, 2, 3...). So numeric seeds are mixed
  // rather than truncated. Compare the first few draws of neighbouring seeds.
  for (let s = 1; s <= 8; s += 1) {
    const a = Array.from({ length: 3 }, (() => { const r = makeRng(s); return () => r.next(); })());
    const b = Array.from({ length: 3 }, (() => { const r = makeRng(s + 1); return () => r.next(); })());
    for (let i = 0; i < 3; i += 1) {
      assert.ok(
        Math.abs(a[i] - b[i]) > 1e-6,
        `seeds ${s} and ${s + 1} produced near-identical draw ${i}: ${a[i]} vs ${b[i]}`
      );
    }
  }
});

// ---------------------------------------------------------------------------------------------
// DETERMINISM — the property that was never broken, now stated explicitly
// ---------------------------------------------------------------------------------------------

test('the same seed always gives the same stream', () => {
  for (const seed of ['day5', 42, 'a', 0]) {
    const a = Array.from({ length: 20 }, (() => { const r = makeRng(seed); return () => r.next(); })());
    const b = Array.from({ length: 20 }, (() => { const r = makeRng(seed); return () => r.next(); })());
    assert.deepEqual(a, b, `seed ${JSON.stringify(seed)} was not reproducible`);
  }
});

test('two RNGs from one seed do not share mutable state', () => {
  // If they did, drawing from one would advance the other, and evaluation order would change results.
  const a = makeRng('shared');
  const b = makeRng('shared');
  a.next(); a.next(); a.next();
  assert.equal(b.next(), makeRng('shared').next(), 'streams must be independent objects');
});

// ---------------------------------------------------------------------------------------------
// INPUT VALIDATION — fail loudly rather than quietly returning stream zero
// ---------------------------------------------------------------------------------------------

test('makeRng rejects seeds it cannot hash instead of defaulting to zero', () => {
  // This is the structural fix for the original bug. Silent coercion is what let a bad seed through;
  // now an unhashable seed is an error at the call site.
  for (const bad of [null, undefined, {}, [], true, NaN, Infinity]) {
    assert.throws(
      () => makeRng(bad),
      /seed must be/,
      `makeRng(${String(bad)}) should throw rather than silently seed from 0`
    );
  }
});

test('deriveSeed requires a string label', () => {
  assert.throws(() => deriveSeed('day5', 42), /label must be a string/);
  assert.throws(() => deriveSeed('day5', undefined), /label must be a string/);
});

// ---------------------------------------------------------------------------------------------
// DISTRIBUTIONAL SANITY
//
// Not a serious test of statistical quality — mulberry32's properties are established elsewhere and
// this is not a cryptographic context. These check that the wrappers around `next()` have their
// bounds and shapes right, which is where a hand-rolled RNG helper actually goes wrong.
// ---------------------------------------------------------------------------------------------

test('next() stays in [0,1) and has roughly the right mean', () => {
  const rng = makeRng('uniform');
  let sum = 0;
  const N = 50000;
  for (let i = 0; i < N; i += 1) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    sum += v;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.01, `mean should be ~0.5, got ${sum / N}`);
});

test('int() is inclusive at both ends and covers the whole range', () => {
  // Off-by-one at the top of the range is the classic bug here, and it silently biases every
  // categorical draw in the generator.
  const rng = makeRng('ints');
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) {
    const v = rng.int(0, 4);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 4, `out of range: ${v}`);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4], 'both endpoints must be reachable');
  // A degenerate range must return the single value rather than looping or throwing.
  assert.equal(rng.int(7, 7), 7);
});

test('float() respects its bounds', () => {
  const rng = makeRng('floats');
  for (let i = 0; i < 5000; i += 1) {
    const v = rng.float(-2, 5);
    assert.ok(v >= -2 && v < 5, `out of range: ${v}`);
  }
});

test('weighted() respects weights and ignores zero-weight keys', () => {
  const rng = makeRng('weighted');
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 20000; i += 1) counts[rng.weighted({ a: 7, b: 3, c: 0 })] += 1;
  assert.equal(counts.c, 0, 'a zero weight must never be selected');
  assert.ok(Math.abs(counts.a / 20000 - 0.7) < 0.02, `expected ~70% a, got ${counts.a / 20000}`);
  assert.ok(Math.abs(counts.b / 20000 - 0.3) < 0.02, `expected ~30% b, got ${counts.b / 20000}`);
});

test('weighted() refuses an all-zero distribution rather than silently picking', () => {
  const rng = makeRng('weighted-zero');
  assert.throws(() => rng.weighted({ a: 0, b: 0 }), /positive weight/);
});

test('shuffle() permutes without dropping or duplicating, and does not mutate the input', () => {
  const rng = makeRng('shuffle');
  const input = Array.from({ length: 50 }, (_, i) => i);
  const out = rng.shuffle(input);
  assert.deepEqual(input, Array.from({ length: 50 }, (_, i) => i), 'input must not be mutated');
  assert.deepEqual([...out].sort((a, b) => a - b), input, 'shuffle must be a permutation');
  assert.notDeepEqual(out, input, 'a 50-element shuffle returning the identity would be suspicious');
});

test('normal() has approximately the requested mean and spread', () => {
  const rng = makeRng('normal');
  const N = 40000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < N; i += 1) {
    const v = rng.normal(3, 2);
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / N;
  const sd = Math.sqrt(sumSq / N - mean * mean);
  assert.ok(Math.abs(mean - 3) < 0.05, `mean should be ~3, got ${mean}`);
  assert.ok(Math.abs(sd - 2) < 0.05, `sd should be ~2, got ${sd}`);
});

test('logNormal() is strictly positive and right-skewed', () => {
  // The shape matters for a real reason: transaction amounts must be mostly small with a long right
  // tail, or the high-value approval gate (>₹25,000) fires far too often and misrepresents the
  // problem the guardrails are solving.
  const rng = makeRng('lognormal');
  const vals = Array.from({ length: 20000 }, () => rng.logNormal(Math.log(2000), 1));
  assert.ok(vals.every((v) => v > 0), 'log-normal values must be positive');
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(vals.length / 2)];
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  assert.ok(mean > median * 1.2, `right-skew expected: mean ${mean.toFixed(0)} vs median ${median.toFixed(0)}`);
});

test('exponential() has approximately the requested mean and is non-negative', () => {
  const rng = makeRng('exponential');
  const N = 40000;
  let sum = 0;
  for (let i = 0; i < N; i += 1) {
    const v = rng.exponential(5);
    assert.ok(v >= 0, `negative gap: ${v}`);
    sum += v;
  }
  assert.ok(Math.abs(sum / N - 5) < 0.1, `mean should be ~5, got ${sum / N}`);
});

test('pick() only ever returns members of the array', () => {
  const rng = makeRng('pick');
  const arr = ['RETRY_NOW', 'SEND_LINK', 'ESCALATE_HUMAN'];
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) {
    const v = rng.pick(arr);
    assert.ok(arr.includes(v), `picked something not in the array: ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 3, 'every element should be reachable');
});

test('bool() honours its probability', () => {
  const rng = makeRng('bool');
  let trues = 0;
  for (let i = 0; i < 20000; i += 1) if (rng.bool(0.25)) trues += 1;
  assert.ok(Math.abs(trues / 20000 - 0.25) < 0.02, `expected ~25%, got ${trues / 20000}`);
  // The degenerate ends must be exact, since guardrail code will call bool(0) and bool(1).
  const r2 = makeRng('bool-edges');
  for (let i = 0; i < 200; i += 1) {
    assert.equal(r2.bool(0), false, 'bool(0) must never be true');
  }
});
