/**
 * WHAT IS THE POST-CORRECTION SELF-RECOVERY SHARE, ACROSS WORLDS?
 *
 * `verify-sim` asserts 5% < share < 45% under the name "B0 is a real but beatable baseline". The floor
 * was set before the survivorship correction, which by design multiplies propensity by ~0.311 — so the
 * floor may now exclude most worlds while passing on the one seeded batch. Measuring instead of
 * guessing a replacement, and using the real seeds (42/4242) that `seed.js` writes.
 */
import { generateBatch } from './src/sim/generator.js';

const NOW = new Date('2026-08-22T03:30:00.000Z');
const shares = [];

// The two the CLI actually seeds, plus ten more worlds to get a spread.
const cases = [['42', 'TRAIN'], ['4242', 'TEST']];
for (const s of ['day7', 'w01', 'w02', 'w03', 'w04', 'w05', 'w06', 'w07', 'w08', 'w09']) {
  cases.push([s, 'TRAIN'], [s, 'TEST']);
}

for (const [seed, split] of cases) {
  const n = Number.isNaN(Number(seed)) ? seed : Number(seed);
  const b = generateBatch({ seed: n, split, now: NOW });
  const share = b.latents.filter((l) => l.willSelfRecover).length / b.latents.length;
  shares.push({ seed, split, share, count: b.latents.filter((l) => l.willSelfRecover).length });
}

const xs = shares.map((s) => s.share);
const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = Math.sqrt(xs.map((x) => (x - mean) ** 2).reduce((a, b) => a + b, 0) / xs.length);
console.log(`n=${xs.length} worlds   mean ${(100 * mean).toFixed(2)}%  sd ${(100 * sd).toFixed(2)}pp  min ${(100 * Math.min(...xs)).toFixed(2)}%  max ${(100 * Math.max(...xs)).toFixed(2)}%`);
console.log(`worlds below the current 5% floor: ${xs.filter((x) => x <= 0.05).length} of ${xs.length}`);
console.log(`worlds above the current 45% ceiling: ${xs.filter((x) => x >= 0.45).length} of ${xs.length}`);
console.log(`mean - 4sd = ${(100 * (mean - 4 * sd)).toFixed(2)}%   mean + 4sd = ${(100 * (mean + 4 * sd)).toFixed(2)}%`);
console.log('\n  seed   split  share   count');
for (const s of shares) {
  console.log(`  ${String(s.seed).padEnd(6)} ${s.split.padEnd(6)} ${(100 * s.share).toFixed(2)}%  ${String(s.count).padStart(3)}${s.share <= 0.05 ? '   <-- fails the 5% floor' : ''}`);
}
