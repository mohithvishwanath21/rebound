import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { scoreArm, compareWithinWorld, poolAcrossWorlds } from './src/eval/metrics.js';
import { policyFor } from './src/eval/baselines.js';
import { POLICY_ARMS, HORIZON } from './src/core/config.js';

const startAt = new Date('2026-03-05T09:00:00Z');
const perWorld = [];
for (const seed of [1, 2, 3]) {
  const scorer = await fitRecoveryScorer({ seed, startAt });
  const world = await buildWorld({ seed, split: 'TRAIN', count: 40, startAt, train: scorer.train });
  const scored = [];
  for (const key of Object.keys(POLICY_ARMS)) {
    const id = POLICY_ARMS[key].id;
    const result = await runArm({ world, arm: id, decide: policyFor(id), scoreAction: scorer.scoreAction,
      cycles: HORIZON.cycles, stepHours: HORIZON.stepHours });
    scored.push(await scoreArm({ result, world }));
  }
  const cmp = compareWithinWorld(scored);
  perWorld.push(cmp);
  console.log(`\n=== WORLD seed=${seed} | counterfactual(B0)=${cmp.counterfactualPaise} ===`);
  console.log('  invariants:', JSON.stringify(cmp.invariants));
  console.log('  arm              gross   incremental      net   msg quiet  cap  ABS  refus  defRef');
  for (const r of cmp.rows) {
    console.log('  ', r.arm.padEnd(16),
      String(r.recoveredPaise).padStart(8),
      String(r.incrementalPaise).padStart(9),
      String(r.netPaise).padStart(9),
      String(r.messages).padStart(4), String(r.quietHoursMessages).padStart(4),
      String(r.contactCapBreaches).padStart(4), String(r.absoluteBreaches).padStart(4),
      String(r.guardrailRefusals).padStart(6), String(r.deferralsRefused).padStart(6));
  }
}
console.log('\n\n########## POOLED ACROSS 3 WORLDS: REBOUND_EV vs B3_FIXED_LADDER ##########');
const p = poolAcrossWorlds({ perWorld, armId: 'REBOUND_EV', versusArmId: 'B3_FIXED_LADDER' });
console.log('gross diff  :', JSON.stringify(p.recovered));
console.log('incr  diff  :', JSON.stringify(p.incremental));
console.log('net   diff  :', JSON.stringify(p.net));
console.log('pooled      :', JSON.stringify(p.pooled, null, 1));
