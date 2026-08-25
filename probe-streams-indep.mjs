/**
 * ARE PER-EVENT STREAMS ACTUALLY INDEPENDENT? — and is 0.330 noise or bias?
 *
 * Per-event streams are now load-bearing, so "seeds that differ by one character give uncorrelated
 * streams" has stopped being a detail and become an assumption every figure rests on. If adjacent
 * eventIds produced correlated streams, every distribution in the world would be subtly wrong while
 * every test kept passing.
 *
 * Two questions, and the second only means something if the first is clean:
 *   1. Do the marginal distributions match theory? (ages ~ U(0.2, 21), payer mix ~ declared mix)
 *   2. Across seeds, what is the natural spread of the survivorship ratio? The band 0.29-0.33 was
 *      fitted to TWO observations from one generator version. If the spread is wider than that band,
 *      the band pinned a draw rather than a property.
 */
import { generateBatch, DEFAULT_PARAMS } from './src/sim/generator.js';

const NOW = new Date('2026-08-24T09:30:00Z');
const DAY_MS = 86_400_000;
const [lo, hi] = DEFAULT_PARAMS.selfRecoveryWindowDays;
const MULT = { WILL_PAY_IF_REMINDED: 1.5, TEMPORARILY_SHORT: 1.1, NEEDS_NEW_INSTRUMENT: 0.25, DISPUTING: 0.1, NEVER_PAYING: 0.0 };

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2)));

const seeds = ['day7', 'w01', 'w02', 'w03', 'w04', 'w05', 'w06', 'w07', 'w08', 'w09', 'w10', 'w11'];
const ratios = [];
const ages = [];
const firstDraws = [];
const payerCounts = {};

for (const seed of seeds) {
  for (const split of ['TRAIN', 'TEST']) {
    const b = generateBatch({ seed, split, now: NOW });
    const byId = new Map(b.events.map((e) => [e.eventId, e]));
    let su = 0, sc = 0;
    for (const l of b.latents) {
      const e = byId.get(l.eventId);
      const age = (NOW.getTime() - new Date(e.occurredAt).getTime()) / DAY_MS;
      if (seed === 'day7') { ages.push(age); }
      const q = Math.min(0.95, DEFAULT_PARAMS.selfRecoveryRate[e.lossType] * MULT[l.payerType]);
      const earliest = Math.max(lo, age);
      const pOut = earliest >= hi ? 0 : (hi - earliest) / (hi - lo);
      su += q;
      sc += (q * pOut) / (q * pOut + (1 - q));
      payerCounts[l.payerType] = (payerCounts[l.payerType] ?? 0) + 1;
    }
    ratios.push({ seed, split, ratio: sc / su });
  }
}

console.log('--- 1. MARGINALS on the day7 TRAIN world (n=600). Bias would show here first.');
console.log(`  ageDays mean  ${mean(ages).toFixed(3)}   theory U(0.2, 21) -> 10.600`);
console.log(`  ageDays sd    ${sd(ages).toFixed(3)}   theory (21-0.2)/sqrt(12) -> ${(20.8 / Math.sqrt(12)).toFixed(3)}`);
console.log(`  ageDays min/max ${Math.min(...ages).toFixed(3)} / ${Math.max(...ages).toFixed(3)}   theory 0.2 / 21`);

const totalP = Object.values(payerCounts).reduce((s, x) => s + x, 0);
console.log(`\n  payer mix over all ${seeds.length * 2} batches (n=${totalP}) vs declared:`);
for (const [k, v] of Object.entries(DEFAULT_PARAMS.payerTypeMix)) {
  // Declared mix is B2C; B2B overrides it, so exact agreement is not expected — only rough.
  console.log(`    ${k.padEnd(22)} observed ${((100 * (payerCounts[k] ?? 0)) / totalP).toFixed(1)}%   declared(B2C) ${(100 * v).toFixed(1)}%`);
}

console.log(`\n--- 2. SURVIVORSHIP RATIO across ${ratios.length} batches`);
const rs = ratios.map((r) => r.ratio);
console.log(`  mean ${mean(rs).toFixed(4)}  sd ${sd(rs).toFixed(4)}  min ${Math.min(...rs).toFixed(4)}  max ${Math.max(...rs).toFixed(4)}`);
console.log(`  the old band was 0.29 - 0.33; observed range is ${Math.min(...rs).toFixed(3)} - ${Math.max(...rs).toFixed(3)}`);
const outside = rs.filter((r) => r <= 0.29 || r >= 0.33).length;
console.log(`  batches falling OUTSIDE the old band: ${outside} of ${rs.length}`);
console.log('\n  per-batch:');
for (const r of ratios) console.log(`    ${r.seed} ${r.split.padEnd(5)} ${r.ratio.toFixed(4)}${r.ratio <= 0.29 || r.ratio >= 0.33 ? '  <-- outside old band' : ''}`);
