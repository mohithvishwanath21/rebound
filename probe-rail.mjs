/**
 * PROBE — #65. How much does `customer.preferredRail` actually move the rail a case is attempted on?
 *
 * The suspicion is stronger than the log entry recorded. The weights are built as an object literal
 * whose FIRST key is computed and whose next three are literal:
 *
 *   { [customer.preferredRail]: 0.7, [Rail.UPI]: 0.12, [Rail.CARD]: 0.12, [Rail.NETBANKING]: 0.06 }
 *
 * `Rail` has exactly three members, and all three are named literally after the computed key. In an
 * object literal a later duplicate key WINS, so whichever rail the customer prefers gets its 0.7
 * silently replaced by 0.12 or 0.06. Not "3 of 4 rails" — every rail, every case, always.
 *
 * If that is right, the empirical distribution of `event.rail` given `customer.preferredRail` is the
 * SAME for all three preferences, and equal to {0.12, 0.12, 0.06} renormalised = {0.4, 0.4, 0.2}.
 * That is the prediction. It is falsifiable in one run, so it gets run before anything is edited.
 *
 * Invoices are excluded from the tally: they are forced to NETBANKING after the draw, so including
 * them would mix the bug with a deliberate override and blur exactly the thing being measured.
 */
import { generateBatch } from './src/sim/generator.js';
import { LossType } from './src/core/enums.js';

const now = new Date('2026-08-24T09:30:00Z');
const tally = new Map();   // preferredRail -> { rail -> count }

for (const seed of ['1', '2', '3', '4', '5', '6', '7', '8']) {
  const { events, customers } = generateBatch({ seed, split: 'TRAIN', now });
  const byId = new Map(customers.map((c) => [c.customerId, c]));
  for (const e of events) {
    if (e.lossType === LossType.OVERDUE_INVOICE) continue;   // forced to NETBANKING, not a draw
    const pref = byId.get(e.customerId).preferredRail;
    if (!tally.has(pref)) tally.set(pref, new Map());
    const row = tally.get(pref);
    row.set(e.rail, (row.get(e.rail) ?? 0) + 1);
  }
}

console.log('\nP(event.rail | customer.preferredRail), 8 TRAIN worlds, invoices excluded\n');
console.log('  preferred        n     UPI    CARD    NETB    <- share on the PREFERRED rail');
for (const [pref, row] of [...tally.entries()].sort()) {
  const n = [...row.values()].reduce((a, b) => a + b, 0);
  const share = (r) => ((row.get(r) ?? 0) / n);
  const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(6);
  console.log(
    `  ${pref.padEnd(12)} ${String(n).padStart(5)}  ${pct(share('UPI'))} ${pct(share('CARD'))} ` +
      `${pct(share('NETBANKING'))}    ${pct(share(pref))}`
  );
}
console.log(
  '\n  PREDICTION IF THE BUG IS REAL: all three rows read 40.0% / 40.0% / 20.0%, and the last\n' +
    '  column therefore reads 40% / 40% / 20% instead of ~70% — i.e. a customer is LESS likely to be\n' +
    '  attempted on the rail they prefer than on one they do not, whenever they prefer netbanking.'
);
