/**
 * PROBE — approvalsReconcile fails in all five worlds. Print BOTH sides of the comparison.
 *
 * The CLI message only printed the case-record side, which is a defect in the message: a two-sided
 * invariant whose failure text shows one side tells you nothing. Fixed there too; this establishes the
 * actual numbers first.
 *
 * The suspicion, from `summariseApprovals`'s own docblock: the case record holds only the LATEST
 * approval, because a grant is an envelope that can expire and send the case back for a fresh
 * signature. So counting `cases.filter(c => c.approval.state === 'GRANTED')` is a census of final
 * states, while the approver's `resolved` list is a log of decision EVENTS. Those two are not the same
 * quantity and should not have been wired to an equality. If that is what this shows, the audit event
 * counts are the right thing to compare against.
 */
import { buildWorld, runArm, fitRecoveryScorer } from './src/eval/harness.js';
import { policyFor } from './src/eval/baselines.js';
import { scoreArm } from './src/eval/metrics.js';
import { GUARDRAILS, POLICY, HORIZON } from './src/core/config.js';


const startAt = new Date('2026-03-05T09:00:00Z');
const { scoreAction, train } = await fitRecoveryScorer({ seed: '1', startAt });
const world = await buildWorld({ seed: '1', split: 'TEST', count: 80, startAt, train });

for (const armId of ['B1_NAIVE_RETRY', 'REBOUND_EV']) {
  const isRebound = armId === 'REBOUND_EV';
  const result = await runArm({
    world,
    arm: armId,
    decide: policyFor(armId),
    scoreAction,
    cycles: HORIZON.cycles,
    stepHours: HORIZON.stepHours,
    config: { GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 4000, maxRetriesPerRun: 4000 }, POLICY },
  });

  const scored = await scoreArm({ result, world });
  const rep = result.approvals;

  console.log(`\n=== ${armId} ===`);
  console.log('  APPROVER REPORT (decision EVENTS the reviewer logged)');
  console.log('    granted:', rep.granted, ' denied:', rep.denied, ' resolved rows:', rep.resolved.length);
  console.log('  CASE RECORDS (final approval state per case)');
  console.log('    granted:', scored.approvals.granted, ' denied:', scored.approvals.denied,
    ' pending:', scored.approvals.pendingAtEnd, ' requested(audits):', scored.approvals.requested);
  console.log('  AUDIT EVENT COUNTS');
  console.log('    grantedAudits:', scored.approvals.grantedAudits,
    ' deniedAudits:', scored.approvals.deniedAudits);

  // Which cases were resolved more than once? That is the envelope-expiry path.
  const perCase = new Map();
  for (const r of rep.resolved) perCase.set(r.eventId, (perCase.get(r.eventId) ?? 0) + 1);
  const repeats = [...perCase.entries()].filter(([, n]) => n > 1);
  console.log('  cases resolved MORE THAN ONCE:', repeats.length, repeats.slice(0, 5));
  console.log('  distinct cases resolved:', perCase.size, 'vs resolution events:', rep.resolved.length);
}
