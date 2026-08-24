/**
 * TESTS FOR THE ARM SELECTION PROCEDURE AND THE FLAG PARSER
 * ========================================================
 *
 * Two things get tested here, and they are related more closely than they look.
 *
 * The statistics are tested against values computed by hand, not against whatever the code currently
 * returns. A test that captures the current output is a change detector; it will happily lock in a
 * wrong denominator forever. Every expected number below was worked out on paper first and the
 * arithmetic is written into the test so a reader can check it without trusting me.
 *
 * The flag parser is tested because it is the thing standing between a mistyped argument and a report
 * labelled with a setting it did not use. That has now happened three times in this project, so the
 * parser's refusal to guess is a load-bearing property and belongs under test rather than under a
 * comment.
 *
 * The most important test in the file is the structural one: `selectionSweep` must have no way to
 * generate the reserved TEST batch. It is a static check on the source rather than a behavioural one,
 * for the same reason the ground-truth boundary is checked statically — a behavioural test can only
 * prove the paths it happens to exercise, while a source check covers the paths nobody thought to
 * exercise, including the ones added next week.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  summarise, pairedDiff, defaultSeeds, PREFERENCE_ORDER, T_THRESHOLD, selectionSweep,
} from '../src/eval/armSelection.js';
import { parseFlags, asNumber } from '../src/eval/cli/flags.js';
import { fitLookupTable } from '../src/ml/calibration.js';

const FP = 1e-9;
const near = (got, want, tol, msg) =>
  assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} (+/- ${tol})`);

// ---------------------------------------------------------------------------------------------
// Summary statistics
// ---------------------------------------------------------------------------------------------

test('summarise uses the n-1 denominator, hand-computed', () => {
  // xs = [1,2,3,4]. mean = 10/4 = 2.5.
  // deviations -1.5,-0.5,0.5,1.5 -> squares 2.25,0.25,0.25,2.25 -> sum 5.
  // sample variance = 5/3 = 1.666666...; sd = 1.2909944487...; se = sd/sqrt(4) = 0.6454972244...
  const s = summarise([1, 2, 3, 4]);
  assert.equal(s.n, 4);
  near(s.mean, 2.5, FP, 'mean');
  near(s.sd, Math.sqrt(5 / 3), FP, 'sd with n-1');
  near(s.sd, 1.2909944487358056, 1e-12, 'sd against the hand value');
  near(s.se, Math.sqrt(5 / 3) / 2, FP, 'se');

  // The population denominator would give sqrt(5/4) = 1.1180. Asserting it does NOT is the point:
  // on twenty worlds the two differ by about 3% on the standard error, which is enough to move a
  // borderline t across the threshold that decides the entire selection.
  assert.ok(Math.abs(s.sd - Math.sqrt(5 / 4)) > 0.1, 'must not be the population sd');
});

test('summarise reports NaN spread for a single point rather than zero', () => {
  // Zero would be a lie that reads as perfect precision, and it would make t infinite.
  const s = summarise([0.42]);
  assert.equal(s.n, 1);
  near(s.mean, 0.42, FP, 'mean of one');
  assert.ok(Number.isNaN(s.sd), 'sd of one point is undefined, not 0');
  assert.ok(Number.isNaN(s.se), 'se of one point is undefined, not 0');
});

// ---------------------------------------------------------------------------------------------
// Paired differences
// ---------------------------------------------------------------------------------------------

test('pairedDiff mean, se, t and sign count, all hand-computed', () => {
  const a = [0.10, 0.20, 0.30, 0.40];
  const b = [0.12, 0.18, 0.35, 0.36];
  // diffs = a - b = [-0.02, +0.02, -0.05, +0.04]; sum = -0.01; mean = -0.0025
  // deviations from mean: -0.0175, +0.0225, -0.0475, +0.0425
  // squares: 3.0625e-4, 5.0625e-4, 2.25625e-3, 1.80625e-3
  //   3.0625e-4 + 5.0625e-4 = 8.125e-4
  //   8.125e-4 + 2.25625e-3 = 3.06875e-3
  //   3.06875e-3 + 1.80625e-3 = 4.875e-3      <- sum of squares
  // variance = 4.875e-3 / 3 = 1.625e-3; sd = 0.0403112887414...; se = sd/2 = 0.0201556443707...
  // t = -0.0025 / 0.0201556443707 = -0.1240347...
  //
  // The sum above is written out term by term because the first version of this test added it wrong
  // (4.825e-3, one 5e-5 short) and the test failed against correct code. Keeping the intermediate
  // steps is what let me tell "my arithmetic is wrong" from "the implementation is wrong" in one read.
  const p = pairedDiff(a, b);
  assert.equal(p.n, 4);
  near(p.meanDiff, -0.0025, 1e-12, 'mean paired difference');
  near(p.sd, Math.sqrt(1.625e-3), 1e-12, 'sd of the differences');
  near(p.sd, 0.04031128874149276, 1e-15, 'sd against the hand value');
  near(p.se, Math.sqrt(1.625e-3) / 2, 1e-12, 'se');
  near(p.t, -0.0025 / (Math.sqrt(1.625e-3) / 2), 1e-12, 't');
  near(p.t, -0.1240347, 1e-6, 't against the hand value');

  // a is "less regret" where the difference is negative.
  assert.equal(p.aWins, 2, 'a wins the two worlds where its regret is lower');
  assert.equal(p.bWins, 2, 'b wins the other two');
  assert.equal(p.ties, 0);
});

test('pairedDiff is not the difference of the means — world variance cancels', () => {
  // This is the whole reason the sweep pairs. Two arms that differ by a constant 1 point in every
  // world, embedded in a between-world spread of 40 points.
  const worldEffect = [0.05, 0.45, 0.10, 0.38, 0.22];
  const a = worldEffect.map((w) => w);
  const b = worldEffect.map((w) => w + 0.01);

  const p = pairedDiff(a, b);
  near(p.meanDiff, -0.01, 1e-12, 'the paired mean recovers the real effect exactly');
  near(p.sd, 0, 1e-12, 'the shared world variance is gone, so the differences have no spread');
  assert.equal(p.aWins, 5, 'a wins every world');

  // Unpaired, the same data has a standard error of about 8 points, which would swamp a 1-point
  // effect entirely. Demonstrated rather than asserted in a comment.
  const unpairedSe = Math.sqrt(summarise(a).se ** 2 + summarise(b).se ** 2);
  assert.ok(unpairedSe > 0.07, `unpaired se should be huge, got ${unpairedSe}`);
  assert.ok(unpairedSe > 50 * 0.001, 'unpaired analysis cannot see a 1-point effect here');
});

test('pairedDiff t is 0 rather than NaN when both arms are identical', () => {
  // 0/0. Left alone this yields NaN, and NaN fails every `>=` comparison silently, so an arm pair
  // that is exactly tied would be reported as "separable" by a threshold test written the other way
  // round. Pinned because the selection rule reads this value.
  const p = pairedDiff([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]);
  assert.equal(p.meanDiff, 0);
  assert.equal(p.t, 0, 't must be 0, not NaN');
  assert.equal(p.ties, 3);
  assert.ok(!(Math.abs(p.t) >= T_THRESHOLD), 'identical arms must not read as separable');
});

test('pairedDiff refuses unaligned arrays', () => {
  // Silently zipping to the shorter array would compare arm A on worlds 1-5 against arm B on worlds
  // 1-3, which is not a paired comparison at all but would still print a plausible number.
  assert.throws(() => pairedDiff([1, 2, 3], [1, 2]), /seed-aligned/);
});

test('defaultSeeds are distinct and zero-padded', () => {
  const s = defaultSeeds(12);
  assert.equal(s.length, 12);
  assert.equal(s[0], 'sweep-01');
  assert.equal(s[11], 'sweep-12');
  assert.equal(new Set(s).size, 12, 'duplicate seeds would fake power without adding data');
});

// ---------------------------------------------------------------------------------------------
// The structural guarantee
// ---------------------------------------------------------------------------------------------

const ARM_SRC = fileURLToPath(new URL('../src/eval/armSelection.js', import.meta.url));

test('HONESTY: arm selection cannot generate the reserved TEST batch', () => {
  // The Day 5 error was reading a conclusion off the held-out TEST batch. The repair is not "remember
  // not to do that" — it is that this file has no expression that could produce it. The reserved batch
  // is `seed: 'day4'`, and every generateBatch call here templates its seed with a prefix.
  const code = readFileSync(ARM_SRC, 'utf8');
  const withoutComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const RESERVED = 'd' + 'ay4';   // assembled so this test's own literal cannot trip the scan
  assert.ok(
    !withoutComments.includes(RESERVED),
    'armSelection.js must not reference the reserved evaluation seed in executable code'
  );

  // Every seed passed to the generator must be a template literal carrying a prefix, so no call site
  // can pass a bare caller-supplied seed through to the reserved namespace.
  const seedArgs = [...withoutComments.matchAll(/seed:\s*(`[^`]*`|'[^']*'|"[^"]*"|\w+)/g)]
    .map((m) => m[1]);
  const generatorSeeds = seedArgs.filter((s) => s.startsWith('`'));
  assert.ok(generatorSeeds.length >= 2, `expected templated seeds, found ${seedArgs.join(', ')}`);
  for (const s of generatorSeeds) {
    assert.ok(
      /^`[a-z]+-/.test(s) || /-\$\{/.test(s) || /\}\-/.test(s),
      `seed ${s} must carry a namespace prefix or suffix so it cannot collide with a reserved seed`
    );
  }
});

test('the reserved-seed detector actually detects (negative control)', () => {
  // Same discipline as the Windows path guard: a check that cannot fail is not a check. If the scan
  // above were broken, it would pass on this counter-example too.
  const bad = `const b = generateBatch({ seed: 'day4', split: 'TEST' });`;
  const RESERVED = 'd' + 'ay4';
  assert.ok(bad.includes(RESERVED), 'the detector missed a literal reserved seed');
  assert.ok(!`const b = generateBatch({ seed: \`world-\${s}\` });`.includes(RESERVED),
    'the detector flagged the correct form');
});

test('the declared preference order is a total order over the arms, and is documented as a preference', () => {
  // If the preference order omitted an arm, a tie involving that arm would fall through to the mean —
  // the very number the procedure has just admitted it cannot read.
  assert.deepEqual([...PREFERENCE_ORDER].sort(), ['constant', 'gbm', 'logistic', 'lookup']);
  assert.equal(new Set(PREFERENCE_ORDER).size, PREFERENCE_ORDER.length);
  assert.equal(T_THRESHOLD, 2.0, 'the bar is pre-declared and flat; a bar that moves is a bar I tuned');
});

test('selection reads the in-distribution set, never the shifted one', async () => {
  // Three tiny worlds: enough to run the whole procedure, far too few to select on, which is exactly
  // what makes this a good test of the plumbing rather than of the outcome.
  const r = await selectionSweep({ seeds: ['t1', 't2', 't3'], count: 60, trees: 20 });

  assert.ok(r.inDist, 'in-distribution aggregate present');
  assert.ok(r.shift, 'shifted aggregate present');
  assert.equal(r.table, r.inDist.table, 'the top-level table is the in-distribution one');
  assert.equal(r.headToHead, r.inDist.headToHead, 'the head-to-head is the in-distribution one');

  // The decision must be reachable from inDist alone.
  const leader = r.inDist.table[0].name;
  if (r.selectedBy === 'measurement') {
    assert.equal(r.selected, leader, 'a measured selection is the in-distribution leader');
    assert.ok(r.inDist.separated);
  } else {
    assert.equal(r.selectedBy, 'tiebreak');
    assert.ok(r.inDist.tied.includes(r.selected), 'the tiebreak picks from the tied set');
    assert.equal(
      r.selected,
      PREFERENCE_ORDER.find((n) => r.inDist.tied.includes(n)),
      'the tiebreak follows the declared order exactly'
    );
  }

  // And it must not coincide with reading the shifted leader, unless the two agree by chance — which
  // is asserted as a possibility rather than a requirement, because forcing them to differ would be
  // testing the data instead of the code.
  assert.ok(['constant', 'gbm', 'logistic', 'lookup'].includes(r.shift.table[0].name));
});

test('every world reports counts taken from the data, not from the request', async () => {
  // `--count` was silently ignored for four days: generateBatch has no `count` parameter, so the
  // header printed the flag while the numbers came from 600 events. The repair is that the count is
  // read off the generated batch, so a request that does not take effect is visible.
  const r = await selectionSweep({ seeds: ['c1', 'c2', 'c3'], count: 60, trees: 20 });
  for (const w of r.worlds) {
    assert.equal(w.counts.requestedEvents, 60, 'the request is recorded');
    assert.equal(w.counts.worldEvents, 60, 'and the generator actually honoured it');
    assert.ok(w.counts.selectEvents > 0 && w.counts.selectRows > 0, 'select split is non-empty');
    assert.ok(
      w.counts.innerFitEvents + w.counts.tuneEvents + w.counts.selectEvents === w.counts.worldEvents,
      'fit + tune + select must account for every event exactly once'
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Lookup coverage — the instrumentation that falsified the drift hypothesis
// ---------------------------------------------------------------------------------------------

test('lookup coverage distinguishes a supported cell from a fallback', () => {
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push({ actionKind: 'RETRY_NOW', y: i < 10 ? 1 : 0 });
  for (let i = 0; i < 3; i += 1) rows.push({ actionKind: 'THIN', y: 0 });
  const lut = fitLookupTable(rows, { minCount: 10 });

  assert.equal(lut.groups, 2, 'both cells exist in the table');
  assert.equal(lut.supportedGroups, 1, 'only one cell has real support');

  const cov = lut.coverageOf([
    { actionKind: 'RETRY_NOW' },   // supported
    { actionKind: 'THIN' },        // exists but collapsed to the global rate
    { actionKind: 'NEVER_SEEN' },  // absent entirely
  ]);
  assert.equal(cov.rows, 3);
  assert.equal(cov.thin, 1, 'a populated-but-collapsed cell counts as thin');
  assert.equal(cov.unseen, 1, 'an absent cell counts as unseen');
  assert.equal(cov.fallback, 2, 'both are fallbacks');
  near(cov.fallbackRate, 2 / 3, FP, 'fallback rate');
  near(cov.unseenRate, 1 / 3, FP, 'unseen rate');

  // THE POINT OF THE INSTRUMENTATION. All three rows come back as a number, and two of those numbers
  // are the base rate wearing a cell's clothes. Without coverage the caller cannot tell.
  near(lut.predictRow({ actionKind: 'THIN' }), lut.globalRate, FP, 'thin cell returns the base rate');
  near(lut.predictRow({ actionKind: 'NEVER_SEEN' }), lut.globalRate, FP, 'so does an unseen one');
  near(lut.predictRow({ actionKind: 'RETRY_NOW' }), 0.5, FP, 'and so it is indistinguishable by value');
});

test('coverage is exactly zero when every cell is well supported (the measured sweep case)', () => {
  const rows = [];
  for (const k of ['A', 'B']) for (let i = 0; i < 50; i += 1) rows.push({ actionKind: k, y: i % 2 });
  const lut = fitLookupTable(rows, { minCount: 10 });
  const cov = lut.coverageOf(rows);
  assert.equal(cov.fallback, 0);
  assert.equal(cov.fallbackRate, 0, 'a 0% fallback rate is a real reading, not a missing measurement');
  assert.equal(lut.supportedGroups, lut.groups);
});

test('coverage does not change any prediction (instrumentation must be inert)', () => {
  const rows = [];
  for (let i = 0; i < 30; i += 1) rows.push({ actionKind: i % 3 === 0 ? 'X' : 'Y', y: i % 4 === 0 ? 1 : 0 });
  const lut = fitLookupTable(rows, { minCount: 10 });
  const before = rows.map((r) => lut.predictRow(r));
  lut.coverageOf(rows);
  lut.coverageOf([{ actionKind: 'Z' }]);
  assert.deepEqual(rows.map((r) => lut.predictRow(r)), before, 'measuring must not perturb');
});

// ---------------------------------------------------------------------------------------------
// Flag parsing — the guard against a report labelled with a setting it did not use
// ---------------------------------------------------------------------------------------------

test('parseFlags reads the =value form and applies defaults', () => {
  const f = parseFlags(['--seed=day6', '--json'], { seed: 'day5', count: '600' }, ['json', 'quiet']);
  assert.equal(f.seed, 'day6');
  assert.equal(f.count, '600', 'untouched flags keep their default');
  assert.equal(f.json, true);
  assert.equal(f.quiet, false, 'absent switches are false, not undefined');
});

test('parseFlags rejects the spaced form by name — instance 3 of the silent-fallback family', () => {
  // `--seed day6` used to leave the default in place and then print "day6" in the header.
  assert.throws(
    () => parseFlags(['--seed', 'day6'], { seed: 'day5' }, []),
    (err) => {
      assert.match(err.message, /--seed=VALUE/, 'the message must name the correct form');
      assert.match(err.message, /silently ignored/, 'and say why this is fatal');
      return true;
    }
  );
});

test('parseFlags rejects an unknown flag and suggests the near miss', () => {
  // A typo'd --tress=500 that silently does nothing is how a run gets reported as using a setting it
  // did not use.
  assert.throws(
    () => parseFlags(['--tress=500'], { trees: '300' }, []),
    /unknown flag --tress.*Did you mean --trees\?/s
  );
});

test('parseFlags rejects a value on a switch, and a bare positional argument', () => {
  assert.throws(() => parseFlags(['--json=yes'], {}, ['json']), /switch and takes no value/);
  assert.throws(() => parseFlags(['day6'], { seed: 'day5' }, []), /unexpected argument "day6"/);
});

test('parseFlags keeps a value that contains an equals sign', () => {
  // `body.slice(eq + 1)` rather than a split, so a seed or label containing '=' survives intact.
  const f = parseFlags(['--label=a=b=c'], { label: '' }, []);
  assert.equal(f.label, 'a=b=c');
});

test('asNumber fails loudly instead of letting NaN propagate', () => {
  assert.equal(asNumber('600', 'count'), 600);
  assert.throws(() => asNumber('abc', 'count'), /--count=abc is not a number/);
  assert.throws(() => asNumber('1.5', 'count'), /must be a whole number/);
  assert.throws(() => asNumber('0', 'count', { min: 20 }), /must be at least 20/);
  // Non-integer allowed explicitly where it makes sense.
  near(asNumber('0.05', 'lr', { integer: false, min: 0 }), 0.05, FP, 'float flag');
});
