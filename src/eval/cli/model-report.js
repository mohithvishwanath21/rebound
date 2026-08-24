#!/usr/bin/env node
/**
 * npm run model-report
 *
 * Fits five arms on identical data and prints every number Day 5 produces.
 *
 * Runs with no Mongo, no network, no API key and no installed packages, so anyone who clones this
 * repo can regenerate the whole table in one command. Same rule as `npm run diagnose-report`: a
 * number nobody else can reproduce is a screenshot, not a measurement.
 *
 * WHAT TO READ FIRST
 * ------------------
 * The `captured` column, not the Brier column. A raw Brier score on an 11% base rate looks small
 * whatever the model does — the constant baseline already scores about 0.0997 — so the absolute
 * number is close to meaningless. `captured` is the fraction of the gap between that baseline and
 * the irreducible floor that the arm actually closed, and it is the only column that answers "did
 * this model learn anything."
 *
 * Then read the money table, which prices the same question in rupees, and then the TEST rows,
 * which are the only ones that count.
 *
 * Flags:
 *   --seed=day5     seed for the outcome draws and the fit/valid split
 *   --count=600     events per split
 *   --trees=300     boosting rounds
 *   --json          machine-readable, for the dashboard and for diffing runs
 *   --quiet         suppress progress lines
 */

import { compareModels, formatModelReport } from '../modelComparison.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

const seed = flag('seed', 'day5');
const count = Number(flag('count', 600));
const trees = Number(flag('trees', 300));
const asJson = args.includes('--json');
const quiet = args.includes('--quiet') || asJson;

const started = Date.now();
const result = await compareModels({
  seed,
  count,
  trees,
  onProgress: (msg) => { if (!quiet) process.stderr.write(`  ... ${msg}\n`); },
});

if (asJson) {
  // `names` is dropped: 140 strings of noise in a diff, and `featureNames()` regenerates it.
  const { names, ...rest } = result;
  console.log(JSON.stringify({ ...rest, elapsedMs: Date.now() - started }, null, 2));
} else {
  console.log('');
  console.log(formatModelReport(result));
  console.log(`  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}
