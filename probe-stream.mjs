/**
 * IS THE EVENT STREAM COUPLED TO SELF-RECOVERY OUTCOMES?
 *
 * generator.js:614 draws `rng.bool(qGivenOpen)` unconditionally, and its docblock says why: so the
 * number of draws does not depend on the case's age. But :617 `rng.float(earliestDelay, selfHi)`
 * sits INSIDE the `if (selfRecovers)`. If that leaks, then changing selfRecoveryRate reshuffles every
 * subsequent event's amount — and #58's sweep would confound "the rate moved" with "the whole
 * portfolio changed", which is exactly the confound the unconditional draw exists to prevent.
 *
 * Decisive test: perturb ONLY selfRecoveryRate and see whether total exposure moves. Exposure is a
 * pure sum of event amounts and has nothing to do with self-recovery.
 */
import { generateBatch } from './src/sim/generator.js';
import { ASSUMPTIONS } from './src/sim/responseModel.js';

const now = new Date('2026-03-02T09:00:00.000Z');
const base = {
  FAILED_PAYMENT: ASSUMPTIONS.selfRecoveryRate.FAILED_PAYMENT.value,
  FAILED_SUBSCRIPTION: ASSUMPTIONS.selfRecoveryRate.FAILED_SUBSCRIPTION.value,
  OVERDUE_INVOICE: ASSUMPTIONS.selfRecoveryRate.OVERDUE_INVOICE.value,
};
const scaled = (k) => Object.fromEntries(Object.entries(base).map(([lt, v]) => [lt, v * k]));

console.log('multiplier |  selfRec |  total exposure  | first 5 amounts (paise)');
for (const k of [0, 0.5, 1, 1.5, 2]) {
  const b = generateBatch({ seed: 'day7', split: 'TRAIN', now, overrides: { selfRecoveryRate: scaled(k) } });
  const exposure = b.events.reduce((s, e) => s + e.amountPaise, 0);
  const sr = b.latents.filter((l) => l.willSelfRecover).length;
  console.log(
    `${String(k).padStart(10)} | ${String(sr).padStart(8)} | ${String(exposure).padStart(16)} | ` +
    b.events.slice(0, 5).map((e) => e.amountPaise).join(', ')
  );
}
console.log('\nIf exposure or the amounts move with the multiplier, the stream is COUPLED.');
console.log('Exposure must be identical across all rows: self-recovery is a latent, not an amount.');
