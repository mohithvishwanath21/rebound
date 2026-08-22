/**
 * `npm run seed`
 *
 * Materialises the two worlds the evaluation runs against and writes them to disk.
 *
 * Writing JSON rather than going straight to Mongo is deliberate. It means the exact
 * population behind every reported number is a file a reviewer can open, diff, and check
 * — including the latent truth, which is the part they should be most suspicious of. A
 * seeded generator is reproducible in principle; a committed artefact is reproducible in
 * practice, and it also removes the "works on my machine" gap where I regenerate a
 * slightly different world after touching the generator and never notice the headline
 * numbers moved.
 *
 * Latent truth is written to a SEPARATE file from the observable world, mirroring the
 * collection split. `world.json` is what an agent may read; `truth.json` is what only the
 * simulator and the scorer may read. Keeping them apart on disk too means a careless
 * `JSON.parse(readFileSync(...))` in agent code cannot pick up the answer key by
 * accident, and it makes the boundary visible in a directory listing.
 *
 * Usage:
 *   npm run seed                          both splits, default seeds, to ./data
 *   npm run seed -- --split TRAIN         one split only
 *   npm run seed -- --seed 7 --out /tmp   different seed and destination
 *   npm run seed -- --store MONGO         also load into MongoDB for the dashboard
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateBatch, GENERATOR_VERSION } from '../generator.js';
import { formatINR, formatINRCompact } from '../../core/money.js';
import { createStore } from '../../db/store.js';

/** Default seeds. Fixed constants, not clock-derived, so `npm run seed` is idempotent. */
const SEEDS = { TRAIN: 42, TEST: 4242 };

function parseArgs(argv) {
  const args = { out: 'data', store: null, split: null, seed: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--store') args.store = argv[++i];
    else if (a === '--split') args.split = argv[++i]?.toUpperCase();
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--now') args.now = new Date(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.split && !['TRAIN', 'TEST'].includes(args.split)) {
    console.error(`--split must be TRAIN or TEST, got ${args.split}`);
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

/**
 * A fixed reference time, not `new Date()`.
 *
 * Event ages drive the decay term, so seeding at 2am and seeding at 2pm would otherwise
 * produce measurably different recovery probabilities from the same seed. That would make
 * the "same seed, same world" guarantee false in a way that is very hard to spot, because
 * the difference is small and plausible rather than obviously wrong.
 */
const NOW = args.now ?? new Date('2026-08-22T09:00:00+05:30');

const outDir = resolve(process.cwd(), args.out);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const splits = args.split ? [args.split] : ['TRAIN', 'TEST'];
const written = [];

for (const split of splits) {
  const seed = args.seed ?? SEEDS[split];
  const batch = generateBatch({ seed, split, now: NOW });

  // The observable world. Everything an agent is allowed to see, and nothing else.
  const world = {
    generatorVersion: GENERATOR_VERSION,
    generatedAtReferenceTime: NOW.toISOString(),
    batch: batch.batch,
    customers: batch.customers,
    events: batch.events,
  };

  // The answer key. Read only by the simulator and by the scorer.
  const truth = {
    generatorVersion: GENERATOR_VERSION,
    batchId: batch.batch.batchId,
    warning:
      'SIMULATOR GROUND TRUTH. Read only by src/sim/** and src/eval/**. If agent code ' +
      'ever reads this file, every reported recovery number becomes meaningless — the ' +
      'agent would be grading itself against its own answer key. See docs/honesty.md.',
    latents: batch.latents,
  };

  const worldPath = join(outDir, `${split.toLowerCase()}.world.json`);
  const truthPath = join(outDir, `${split.toLowerCase()}.truth.json`);
  writeFileSync(worldPath, JSON.stringify(world, null, 2));
  writeFileSync(truthPath, JSON.stringify(truth, null, 2));

  written.push({ split, seed, batch, worldPath, truthPath });
}

// ---------------------------------------------------------------- optional load
if (args.store === 'MONGO') {
  const store = await createStore({ kind: 'MONGO', uri: process.env.MONGO_URI });
  for (const { batch } of written) {
    await store.putBatch(batch.batch);
    await store.putCustomers(batch.customers);
    await store.putEvents(batch.events);
    // Latent truth is loaded by the simulator's own loader, into its own collection.
    // Deliberately not done here: the seeder should not be the thing that knows how to
    // write the answer key into the same database the API reads from.
  }
  console.log(`\nLoaded ${written.length} batch(es) into MongoDB.`);
  await store.close?.();
}

// ------------------------------------------------------------------- reporting
console.log(`\nREBOUND — seeded ${written.length} batch(es)   generator ${GENERATOR_VERSION}`);
console.log(`Reference time: ${NOW.toISOString()}`);
console.log('='.repeat(72));

for (const { split, seed, batch, worldPath, truthPath } of written) {
  const c = batch.counts;
  console.log(`\n${split}  (seed ${seed})`);
  console.log(`  ${c.customers} customers, ${c.events} events, ${formatINR(c.totalAtRiskPaise)} at risk`);

  const top = Object.entries(c.byLossType).sort((a, b) => b[1] - a[1]);
  console.log(`  loss types: ${top.map(([k, v]) => `${k} ${v}`).join(', ')}`);

  console.log(`  world -> ${worldPath.replace(process.cwd() + '/', '')}`);
  console.log(`  truth -> ${truthPath.replace(process.cwd() + '/', '')}`);
}

if (written.length === 2) {
  const [train, test] = written;
  console.log(`\n${'-'.repeat(72)}`);
  console.log('The TEST split is not just a different random draw. Its payer mix, vague-error');
  console.log('rate and amount distribution are all shifted, so a policy tuned on TRAIN has to');
  console.log('generalise to a genuinely different population rather than to more of the same.');
  console.log(`Run \`npm run describe-sim\` to see exactly which parameters move.`);

  const share = (b, t) => {
    const n = b.latents.filter((l) => l.payerType === t).length;
    return ((n / b.latents.length) * 100).toFixed(1) + '%';
  };
  console.log('\n  payer type                TRAIN     TEST');
  for (const t of ['WILL_PAY_IF_REMINDED', 'TEMPORARILY_SHORT', 'NEEDS_NEW_INSTRUMENT', 'DISPUTING', 'NEVER_PAYING']) {
    console.log(`  ${t.padEnd(24)} ${share(train.batch, t).padStart(6)}   ${share(test.batch, t).padStart(6)}`);
  }
  console.log(`\n  at risk                  ${formatINRCompact(train.batch.counts.totalAtRiskPaise).padStart(7)}  ${formatINRCompact(test.batch.counts.totalAtRiskPaise).padStart(7)}`);
}

console.log('');
