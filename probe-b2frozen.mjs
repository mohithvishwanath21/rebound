/**
 * PROBE — why does B2 end the horizon with 13 of 24 cases OPEN, now that the approver exists?
 *
 * `test/baselines.test.js` "no arm leaves the majority of its cases frozen mid-flight" passed before
 * #61 and fails after it, at 13 of 24. The direction matters: a baseline that resolves LESS makes
 * Rebound's advantage look BIGGER, so this is the self-flattering direction and gets measured rather
 * than thresholded away.
 *
 * The hypothesis to kill: before the approver, a B2 case blocked by APR_LARGE_AMOUNT sat in
 * AWAITING_APPROVAL forever and so was never counted by a test that only looks at OPEN|SCHEDULED. The
 * approver now grants ~70% of those, and `resolveApproval` returns a granted case to OPEN with a null
 * nextActionAt. If that is all that happened, the case did not become MORE stuck — the freeze just
 * moved from one state label into another, and the honest fix is to the test's state list, not to B2.
 *
 * The rival hypothesis: granted cases return to OPEN and then genuinely loop without advancing.
 * Distinguishing them needs the per-case approval history, which is what this prints.
 */
import { buildWorld, runArm } from './src/eval/harness.js';
import { policyFor } from './src/eval/baselines.js';
import { GUARDRAILS, POLICY, HORIZON } from './src/core/config.js';

const forbiddenScorer = () => {
  throw new Error('baseline policies must not score');
};

const startAt = new Date('2026-03-05T09:00:00Z');

for (const armId of ['B1_NAIVE_RETRY', 'B2_AGGRESSIVE', 'B3_FIXED_LADDER']) {
  const world = await buildWorld({ seed: 'traj', split: 'TRAIN', count: 24, startAt });
  const result = await runArm({
    world,
    arm: armId,
    decide: policyFor(armId),
    scoreAction: forbiddenScorer,
    cycles: HORIZON.cycles,
    stepHours: HORIZON.stepHours,
    config: {
      GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 10_000, maxRetriesPerRun: 10_000 },
      POLICY,
    },
  });
  const cases = await result.store.getCases(result.runId);
  const actions = await result.store.getActions(result.runId);

  const census = {};
  for (const c of cases) census[c.state] = (census[c.state] ?? 0) + 1;

  const openish = cases.filter((c) => c.state === 'OPEN' || c.state === 'SCHEDULED');
  const touchedByApproval = openish.filter((c) => c.approval);
  const granted = openish.filter((c) => c.approval?.state === 'GRANTED');

  const actionsPerCase = new Map();
  for (const a of actions) actionsPerCase.set(a.eventId, (actionsPerCase.get(a.eventId) ?? 0) + 1);

  console.log(`\n=== ${armId} ===`);
  console.log('  states        :', census);
  console.log('  OPEN|SCHEDULED:', openish.length, 'of', cases.length);
  console.log('  ...of which have ANY approval record:', touchedByApproval.length);
  console.log('  ...of which were GRANTED and returned :', granted.length);
  console.log('  approver report:', {
    granted: result.approvals?.granted,
    denied: result.approvals?.denied,
    p50: result.approvals?.realisedWaitHoursP50,
  });
  console.log('  actions on the frozen cases:',
    openish.map((c) => actionsPerCase.get(c.eventId) ?? 0).join(','));
  console.log('  frozen cases that got ZERO actions all run:',
    openish.filter((c) => !actionsPerCase.has(c.eventId)).length);
}
