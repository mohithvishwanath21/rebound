#!/usr/bin/env node
/**
 * npm run diagnose-report
 *
 * Scores the diagnosis layer against latent truth on both splits and prints the numbers.
 *
 * Runs entirely in memory, with no Mongo, no network, no API key and no installed packages, so
 * anybody who clones this repo can reproduce every figure it prints in one command. That is a
 * deliberate property rather than a convenience: a number nobody else can regenerate is a
 * screenshot, not a measurement.
 *
 * WHY TEST IS PRINTED AND WHY IT IS ALLOWED TO LOOK WORSE
 * ------------------------------------------------------
 * TEST applies `TEST_PARAM_SHIFT` — a different mix of causes and a higher rate of unmatchable
 * error text. A rule table tuned by staring at TRAIN will score worse on it, and that gap is
 * the honest thing to publish. If the two ever match exactly, the most likely explanation is
 * that the shift is not shifting anything, not that the diagnosis generalises perfectly.
 *
 * Held out means held out: nothing in `src/core/taxonomy.js` was written or edited while looking
 * at TEST output.
 */

import { generateBatch } from '../../sim/generator.js';
import { scoreDiagnosis, formatDiagnosisReport } from '../diagnosisAccuracy.js';
import { evalNow } from '../evalClock.js';

const args = process.argv.slice(2);
const seed = args.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? 'day4';
const asJson = args.includes('--json');

async function run(split) {
  // Pinned clock. Diagnosis never reads a timestamp, so this report was already reproducible —
  // but by luck of what it happens to depend on rather than by design. Pinned anyway.
  const { events, latents } = generateBatch({ seed, split, now: evalNow() });
  const report = await scoreDiagnosis({ events, latents });
  return { split, report };
}

const results = [await run('TRAIN'), await run('TEST')];

if (asJson) {
  console.log(JSON.stringify({ seed, results }, null, 2));
} else {
  for (const { split, report } of results) {
    console.log(formatDiagnosisReport(report, { label: `${split} (seed ${seed})` }));
    console.log('');
  }

  const [train, test] = results;
  console.log('Generalisation gap');
  console.log('==================');
  console.log(
    `  accuracy  TRAIN ${(train.report.accuracy * 100).toFixed(1)}%  ` +
      `TEST ${(test.report.accuracy * 100).toFixed(1)}%  ` +
      `(${((test.report.accuracy - train.report.accuracy) * 100).toFixed(1)} pts)`
  );
  console.log(
    `  unsafe    TRAIN ${(train.report.unsafeRetryRate * 100).toFixed(1)}%  ` +
      `TEST ${(test.report.unsafeRetryRate * 100).toFixed(1)}%`
  );
  console.log('');
  console.log('What these numbers are, precisely');
  console.log('---------------------------------');
  console.log('  Diagnosis accuracy against a SIMULATED world whose truth I generated. It says');
  console.log('  the rule table is consistent with the failure payloads my generator produces.');
  console.log('  It does NOT say real Razorpay failures distribute the same way, and no honest');
  console.log('  reading of it can. One rule in the table carries a confirmation date because a');
  console.log('  real decline was traced through it; the rest are still my best reading of the');
  console.log('  docs, and would need a corpus of real failures to verify.');
}
