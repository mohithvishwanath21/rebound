/**
 * REPRODUCTION FOR THE RETRY-TIMING DEFECT — NOW A REGRESSION CHECK
 * ================================================================
 *
 * Referenced by VERIFY.md section 8 and by the Day 6 entries in ENGINEERING_LOG.md. One command, no
 * arguments, no state: prints the same case priced two ways.
 *
 * THE DEFECT, PAST TENSE. `recoveryProbability` did not read `action.scheduledFor`. Its funds-timing
 * branch computed the salary-window boost from `now` — the instant of the DECISION — which is identical
 * for every candidate being compared against each other. So the simulator could not prefer one
 * scheduled slot to another, while three of its own comments said that preference was the largest
 * timing effect it modelled. Every measured number in this repo before that commit was computed against
 * a ground truth with the timing decision switched off.
 *
 * WHAT THE TWO BLOCKS MEAN NOW, AND WHY THE FILE IS KEPT RATHER THAN DELETED. They differ in exactly
 * one thing: which instant is passed as `now`. The first passes the decision instant, which is what
 * `src/eval/dataset.js` does when it labels rows. The second passes the landing instant explicitly.
 *
 * Before the fix those printed different numbers, and the difference WAS the bug. They now print the
 * same numbers, because the model derives the landing instant from `action.scheduledFor` itself instead
 * of trusting its caller to pass the right `now`. **Agreement between the two blocks is the passing
 * signal.** If they ever diverge again, the model has gone back to depending on the caller's clock —
 * which is the one thing every call site had been getting subtly wrong.
 *
 * The behaviour is pinned properly in `test/retryTiming.test.js`; this command exists so the claim can
 * be seen in rupees and probabilities without reading a test file.
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
console.log('\nBLOCK A — now = the DECISION instant, exactly as src/eval/dataset.js labels rows:');
const blockA = [];
for (const { label, action } of candidates) {
  const { p, breakdown } = recoveryProbability({ action, latent, event, now, touchesUsed: 0, assumptions: A });
  blockA.push(p);
  console.log(`  ${label.padEnd(30)} p=${p.toFixed(6)}  salaryWindow=${breakdown.salaryWindow ?? '-'} preFunds=${breakdown.preFunds ?? '-'}`);
}

console.log('\nBLOCK B — now = the instant the action actually lands, passed explicitly:');
const blockB = [];
for (const { label, action } of candidates) {
  const effective = action.scheduledFor ? new Date(action.scheduledFor) : now;
  const { p, breakdown } = recoveryProbability({ action, latent, event, now: effective, touchesUsed: 0, assumptions: A });
  blockB.push(p);
  console.log(`  ${label.padEnd(30)} p=${p.toFixed(6)}  salaryWindow=${breakdown.salaryWindow ?? '-'} preFunds=${breakdown.preFunds ?? '-'}`);
}

/**
 * The verdict, stated by the command rather than left for the reader to eyeball. Before the fix the
 * two blocks disagreed and the scheduled offsets in block A collapsed to a single distinct value.
 */
const distinctA = new Set(blockA.slice(1).map((p) => p.toFixed(12))).size;
const blocksAgree = blockA.every((p, i) => Math.abs(p - blockB[i]) < 1e-12);

console.log(`\ndistinct probabilities across the three scheduled offsets, block A: ${distinctA} of 3`);
console.log(`blocks A and B agree: ${blocksAgree ? 'YES' : 'NO'}`);
console.log(
  distinctA === 3 && blocksAgree
    ? 'PASS — the model derives the landing instant itself, so the caller\'s clock no longer decides.'
    : 'FAIL — the timing defect is back: pricing depends on which instant the caller happens to pass.'
);
process.exit(distinctA === 3 && blocksAgree ? 0 : 1);
