import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { policyFor } from './src/eval/baselines.js';
import { POLICY_ARMS, HORIZON } from './src/core/config.js';

const startAt = new Date('2026-03-05T09:00:00Z');
const scorer = await fitRecoveryScorer({ seed: 1, startAt });
const world = await buildWorld({ seed: 1, split: 'TRAIN', count: 40, startAt, train: scorer.train });

const finals = {};
for (const key of ['B0_DO_NOTHING', 'B1_NAIVE_RETRY', 'B3_FIXED_LADDER']) {
  const id = POLICY_ARMS[key].id;
  const r = await runArm({ world, arm: id, decide: policyFor(id), scoreAction: scorer.scoreAction,
    cycles: HORIZON.cycles, stepHours: HORIZON.stepHours });
  const cases = await r.store.getCases(r.runId);
  finals[id] = new Map(cases.map(c => [c.eventId, c]));
  console.log(id, 'self=', r.selfRecoveredPaise, 'count=', r.selfRecoveredCount, 'recovered=', r.recoveredPaise);
}

const b0 = finals['B0_DO_NOTHING'];
const selfIds = [...b0.values()].filter(c => c.state === 'RECOVERED_SELF').map(c => c.eventId);
console.log('\nB0 self-recoverers:', selfIds.length);
console.log('\nWhere those same cases ended under the active arms:');
for (const id of selfIds) {
  const b1 = finals['B1_NAIVE_RETRY'].get(id);
  const b3 = finals['B3_FIXED_LADDER'].get(id);
  console.log(' ', id.padEnd(14),
    'B0=RECOVERED_SELF', String(b0.get(id).selfRecoveredPaise).padStart(7),
    '| B1=', String(b1.state).padEnd(17), String(b1.recoveredPaise ?? 0).padStart(7),
    '| B3=', String(b3.state).padEnd(17), String(b3.recoveredPaise ?? 0).padStart(7));
}
