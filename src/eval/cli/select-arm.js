#!/usr/bin/env node
/**
 * npm run select-arm
 *
 * Decides which model Day 6's decision engine is built on, using only TRAIN-derived data.
 *
 * This exists because the Day 5 report chose an arm by looking at TEST. Running this is how that
 * choice gets made legitimately: many independently generated worlds, a held-out SELECT split inside
 * each, paired comparisons across worlds, and a selection rule declared in `src/eval/armSelection.js`
 * before the sweep was first run.
 *
 * The output states whether the winner was chosen BY MEASUREMENT or BY TIEBREAK. That distinction is
 * the point of the command: a procedure that cannot separate two arms should say so rather than
 * emitting a confident-looking ranking of noise.
 *
 * Takes roughly a minute per ten worlds. Needs no Mongo, no network and no API key.
 *
 * Flags (all in --name=value form; the spaced form is a hard error, see cli/flags.js):
 *   --seeds=10      number of worlds (or --seeds=a,b,c for explicit seeds)
 *   --count=600     events per world
 *   --trees=300     boosting rounds
 *   --json          machine-readable
 *   --quiet         suppress progress lines
 */

import { selectionSweep, formatSelectionReport, defaultSeeds } from '../armSelection.js';
import { readFlags, asNumber } from './flags.js';

const f = readFlags(
  process.argv.slice(2),
  { seeds: '10', count: '600', trees: '300' },
  ['json', 'quiet'],
  (raw) => {
    const seeds = /^\d+$/.test(raw.seeds) ? defaultSeeds(Number(raw.seeds)) : raw.seeds.split(',');
    // Three is the smallest sample a standard error can be computed from at all. It is far too few to
    // select on, and the report's t column will say so rather than the CLI pretending otherwise.
    if (seeds.length < 3) {
      throw new Error(`the sweep needs at least 3 worlds to compute a standard error; got ${seeds.length}`);
    }
    if (new Set(seeds).size !== seeds.length) {
      // Duplicated seeds generate identical worlds, which would shrink every standard error while
      // adding no information — the most flattering possible way to fake statistical power.
      throw new Error('--seeds contains duplicates; identical worlds would fake power without adding data');
    }
    return {
      ...raw,
      seeds,
      count: asNumber(raw.count, 'count', { min: 20 }),
      trees: asNumber(raw.trees, 'trees', { min: 1 }),
    };
  }
);

const { seeds, count, trees } = f;
const asJson = f.json;
const quiet = f.quiet || asJson;

if (seeds.length < 3) {
  throw new Error(`the sweep needs at least 3 worlds to compute a standard error; got ${seeds.length}`);
}

const started = Date.now();
const result = await selectionSweep({
  seeds,
  count,
  trees,
  onProgress: (msg) => { if (!quiet) process.stderr.write(`  ... ${msg}\n`); },
});

if (asJson) {
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - started }, null, 2));
} else {
  console.log('');
  console.log(formatSelectionReport(result));
  console.log('');
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
