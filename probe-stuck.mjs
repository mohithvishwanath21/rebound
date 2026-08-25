/**
 * WHY DID PREDICTION 2 FAIL? — decompose the cases still SCHEDULED at the horizon.
 *
 * I pre-registered "cases still SCHEDULED < 25/80 in every world" and measured 34-38 after the fix
 * (down from 59-65). The prediction failed. Before explaining it I need to know what the state
 * actually contains, because `CaseState.SCHEDULED` is written by TWO different paths:
 *
 *   - `scheduleAction`      — a chosen RETRY_SCHEDULED. This is the deferral the fix is about.
 *   - `applyNonActingOutcome` on Outcome.WAIT — a guardrail DEFER, e.g. quiet hours. Sets the same
 *     state and a `waitingBecause`, and resolves on its own when the clock moves.
 *
 * A case sitting in a legitimate quiet-hours wait at the instant the run ends is CORRECTLY
 * SCHEDULED, and counting it as stuck would be measuring the calendar rather than the policy. The
 * run's last cycle is startAt + 15*12h = 21:00 UTC = 02:30 IST, which is inside quiet hours, so
 * this is not a hypothetical.
 *
 * Either answer is publishable; what is not publishable is choosing between them by eye. If most of
 * the 34-38 carry a pending deferral, my threshold was right and the fix is only partial. If most
 * carry `waitingBecause`, the threshold was pointed at the wrong quantity and the honest correction
 * is to the instrument, stated as such — not a quiet re-band after seeing the number.
 */

import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { resolveApproval } from './src/agent/orchestrator.js';
import { formatINR } from './src/core/money.js';

const startAt = new Date('2026-03-02T09:00:00.000Z');
const CYCLES = 16;
const STEP_HOURS = 12;
const SEEDS = (process.env.PROBE_SEEDS ?? 'day7,w01').split(',').filter(Boolean);

const lastCycleAt = new Date(startAt.getTime() + (CYCLES - 1) * STEP_HOURS * 3_600_000);
console.log(`horizon: ${CYCLES} cycles x ${STEP_HOURS}h; final cycle at ${lastCycleAt.toISOString()} ` +
  `(${new Date(lastCycleAt.getTime() + 5.5 * 3_600_000).toISOString().slice(11, 16)} IST)\n`);

for (const seed of SEEDS) {
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
  const world = await buildWorld({ seed, split: 'TRAIN', count: 80, startAt, train });
  const { store, runId } = await runArm({
    world, arm: 'REBOUND_EV', scoreAction, cycles: CYCLES, stepHours: STEP_HOURS,
    beforeCycle: async ({ store: s, runId: r, now }) => {
      for (const c of await s.getPendingApprovals(r)) {
        await resolveApproval({ store: s, runId: r, eventId: c.eventId, grant: true, by: 'probe', at: now });
      }
    },
  });

  const cases = await store.getCases(runId);
  const stuck = cases.filter((c) => c.state === 'SCHEDULED');

  /**
   * A pending deferral is one whose wakeAt is still in the FUTURE relative to the last cycle. The
   * fix clears a spent wakeup, so a case holding one genuinely has a retry scheduled beyond the
   * horizon — which is a HORIZON fact (#62), not a spin loop.
   */
  const withPendingDeferral = stuck.filter(
    (c) => c.deferral?.wakeAt && new Date(c.deferral.wakeAt).getTime() > lastCycleAt.getTime()
  );
  const waitingOnGuardrail = stuck.filter((c) => c.waitingBecause && !c.deferral?.wakeAt);
  const other = stuck.filter(
    (c) => !withPendingDeferral.includes(c) && !waitingOnGuardrail.includes(c)
  );

  /** How far past the horizon are the pending ones due? If it is hours, #62 closes them. */
  const overhangHours = withPendingDeferral
    .map((c) => (new Date(c.deferral.wakeAt).getTime() - lastCycleAt.getTime()) / 3_600_000)
    .sort((a, b) => a - b);

  const attempted = new Set(
    (await store.getAudit(runId)).filter((a) => a.type === 'ATTEMPT_STARTED').map((a) => a.eventId)
  );
  const stuckThatNeverTried = stuck.filter((c) => !attempted.has(c.eventId));

  const reasons = {};
  for (const c of waitingOnGuardrail) reasons[c.waitingBecause] = (reasons[c.waitingBecause] ?? 0) + 1;

  console.log(`${seed}: ${stuck.length}/${cases.length} end SCHEDULED`);
  console.log(`  pending deferral beyond the horizon : ${withPendingDeferral.length}` +
    (overhangHours.length ? `  (due +${overhangHours[0].toFixed(1)}h to +${overhangHours[overhangHours.length - 1].toFixed(1)}h past the last cycle)` : ''));
  console.log(`  waiting on a guardrail (WAIT path)  : ${waitingOnGuardrail.length}  ${JSON.stringify(reasons)}`);
  console.log(`  neither                             : ${other.length}`);
  console.log(`  of the ${stuck.length} stuck, never attempted anything: ${stuckThatNeverTried.length}` +
    `  exposure ${formatINR(stuckThatNeverTried.reduce((s, c) => s + (c.amountPaise ?? 0), 0))}\n`);
}
