/** Verify netIncrementalPaise is exact and B0-relative, on one real world. */
import { fitRecoveryScorer, buildWorld, runArm } from './src/eval/harness.js';
import { scoreArm, compareWithinWorld } from './src/eval/metrics.js';
import { policyFor } from './src/eval/baselines.js';
import { GUARDRAILS, POLICY, HORIZON } from './src/core/config.js';
import { CONTRIBUTION_MARGIN } from './src/core/config.js';

const startAt = new Date('2026-08-24T09:30:00Z');
const { scoreAction, train } = await fitRecoveryScorer({ seed: '5', startAt });
const world = await buildWorld({ seed: '5', split: 'TEST', count: 80, startAt, train });
const cfg = { GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 4000, maxRetriesPerRun: 4000 }, POLICY };
const scored = [];
for (const arm of ['B0_DO_NOTHING', 'B1_NAIVE_RETRY', 'B3_FIXED_LADDER', 'REBOUND_EV']) {
  const r = await runArm({ world, arm, decide: policyFor(arm), scoreAction, cycles: HORIZON.cycles, stepHours: HORIZON.stepHours, config: cfg });
  scored.push(await scoreArm({ result: r, world }));
}
const cmp = compareWithinWorld(scored);
console.log('CONTRIBUTION_MARGIN =', JSON.stringify(CONTRIBUTION_MARGIN));
const b0 = scored.find((s) => s.arm === 'B0_DO_NOTHING');
const cfContrib = b0.contributionPaise + b0.contributionSelfPaise;
console.log(`B0 contribution basis = ${cfContrib} (agent ${b0.contributionPaise} + self ${b0.contributionSelfPaise})`);
for (const row of cmp.rows) {
  const s = scored.find((x) => x.arm === row.arm);
  const hand = s.contributionPaise + s.contributionSelfPaise - cfContrib - s.costs.totalCostPaise;
  const ok = hand === row.netIncrementalPaise;
  console.log(`${row.arm.padEnd(16)} netGross=${String(row.netPaise).padStart(9)} netIncr=${String(row.netIncrementalPaise).padStart(9)} handComputed=${String(hand).padStart(9)} ${ok ? 'MATCH' : 'MISMATCH'}`);
}
const b0row = cmp.rows.find((r) => r.arm === 'B0_DO_NOTHING');
console.log(`\nB0 netIncremental must be 0 (no actions, no cost, nets against itself): ${b0row.netIncrementalPaise}`);
