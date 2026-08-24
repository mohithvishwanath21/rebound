/**
 * REPRODUCTION FOR THE RETRY-TIMING DEFECT
 * ========================================
 *
 * Referenced by VERIFY.md section 8 and by the last Day 6 entry in ENGINEERING_LOG.md. One command,
 * no arguments, no state: prints the same case priced two ways so the gap is visible rather than
 * argued.
 *
 * THE DEFECT. `recoveryProbability` never reads `action.scheduledFor`. Its funds-timing branch
 * computes the salary-window boost from `now` — the instant of the DECISION — which is identical for
 * every candidate being compared against each other. So the simulator cannot prefer one scheduled
 * slot to another, while three of its own comments say that preference is the largest timing effect
 * it models.
 *
 * The two blocks below differ in exactly one thing: which instant is passed as `now`. The first is
 * what `src/eval/dataset.js` does today when it labels rows, and therefore what every measured number
 * in this repo has been computed against. The second is what the comments describe.
 *
 * This lives under `src/eval/` and not `src/agent/`, because it imports the response model and
 * therefore latent truth; `test/boundary.test.js` forbids that anywhere else.
 *
 * Run: node src/eval/cli/probe-timing.js
 */
import { recoveryProbability, materialiseAssumptions } from '../../sim/responseModel.js';
import { ActionKind } from '../../core/actions.js';
import { PayerType } from '../../sim/payerTypes.js';

const A = materialiseAssumptions();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const now = new Date('2026-08-24T09:30:00Z');
const at = (ms) => new Date(now.getTime() + ms).toISOString();

// A cash-flow-constrained payer whose salary lands in two days — the exact case the
// salaryWindowBoost exists to model. A retry before the credit should be near-hopeless;
// a retry just after it should be the best moment available.
const latent = {
  payerType: PayerType.TEMPORARILY_SHORT,
  fundsAvailableFrom: new Date(now.getTime() + 2 * DAY).toISOString(),
};
const event = { amountPaise: 100_000, occurredAt: '2026-08-22T09:30:00Z', lossType: 'FAILED_PAYMENT' };

const candidates = [
  { label: 'RETRY_NOW', action: { kind: ActionKind.RETRY_NOW } },
  { label: 'SCHEDULED +6h  (before funds)', action: { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(6 * HOUR) } },
  { label: 'SCHEDULED +3d  (just after)', action: { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(3 * DAY) } },
  { label: 'SCHEDULED +9d  (window gone)', action: { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(9 * DAY) } },
];

console.log('Payer is TEMPORARILY_SHORT; salary credit lands', latent.fundsAvailableFrom);
console.log('Deciding at', now.toISOString());
console.log('\nAS THE DATASET LABELS IT — now = the DECISION instant for every candidate:');
for (const { label, action } of candidates) {
  const { p, breakdown } = recoveryProbability({ action, latent, event, now, touchesUsed: 0, assumptions: A });
  console.log(`  ${label.padEnd(30)} p=${p.toFixed(6)}  salaryWindow=${breakdown.salaryWindow ?? '-'} preFunds=${breakdown.preFunds ?? '-'}`);
}

console.log('\nIF now WERE THE INSTANT THE ACTION ACTUALLY LANDS (what the comment claims):');
for (const { label, action } of candidates) {
  const effective = action.scheduledFor ? new Date(action.scheduledFor) : now;
  const { p, breakdown } = recoveryProbability({ action, latent, event, now: effective, touchesUsed: 0, assumptions: A });
  console.log(`  ${label.padEnd(30)} p=${p.toFixed(6)}  salaryWindow=${breakdown.salaryWindow ?? '-'} preFunds=${breakdown.preFunds ?? '-'}`);
}

const asLabelled = candidates
  .filter((c) => c.action.scheduledFor)
  .map(({ action }) => recoveryProbability({ action, latent, event, now, touchesUsed: 0, assumptions: A }).p);
console.log(
  '\ndistinct trueP across the three scheduled offsets, as labelled:',
  new Set(asLabelled.map((p) => p.toFixed(12))).size
);
