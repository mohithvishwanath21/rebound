/**
 * THE DASHBOARD'S DATA SOURCE.
 *
 * This module runs a real batch through the same harness the eval uses and hands the API a read-only
 * handle on the result. It exists as a separate directory from `src/api` for a reason that is easy to
 * state and would be easy to lose: to build a world you need the simulator, and the simulator knows the
 * answer key. `src/api/**` is forbidden by `test/boundary.test.js` from importing `src/sim/**`, so the
 * construction cannot live there. Keeping the two apart means the HTTP layer is handed a store and a
 * comparison table and has no route back to latent truth — not by policy, by import graph.
 *
 * ===============================================================================================
 * TWO MODES, BECAUSE ONE SCREEN CANNOT MAKE BOTH CLAIMS HONESTLY
 * ===============================================================================================
 *
 * MEASURED (`--approver=SIM`, the default). All five arms run the full horizon, and the result is
 * scored with `compareWithinWorld` — the same function `npm run eval` calls. This is the mode that
 * answers Track 03's actual question, "show measured money recovered across a batch", and its money is
 * INCREMENTAL: B0_DO_NOTHING measures what arrives with no agent at all and that is subtracted. The
 * approval queue is empty here, because the seeded reviewer answered it on an SLA, identically for
 * every arm. Running four extra arms costs about ten seconds at boot and is what makes the headline a
 * comparison rather than a gross total.
 *
 * CONSOLE (`--approver=HUMAN`). One arm, PAUSED at the first instant the approval queue has something
 * in it, with no simulated reviewer. Here the operator is the reviewer: a grant lands between two
 * cycles, which is exactly where the simulated reviewer's grants land, and then `advance()` runs the
 * next cycle so the agent re-decides and executes the action it was holding. This is the mode that
 * demonstrates compliant escalation as a live loop instead of a screenshot.
 *
 * CONSOLE MODE REPORTS NO MONEY COMPARISON, AND THAT IS THE WHOLE REASON THE MODES ARE SEPARATE.
 * A paused run is a truncated run, and a truncated run's totals are biased twice over, both times in
 * our favour: cases still in flight have had less time to fail, and cases frozen in the queue are cases
 * the policy never spent money failing on. `scoreArm` throws on a paused run rather than trusting this
 * file to remember, and `meta()` returns `rows: null` with a caveat saying why. If a figure is quotable
 * it came from MEASURED mode.
 *
 * ===============================================================================================
 * WHAT EVEN THE MEASURED SCREEN IS NOT
 * ===============================================================================================
 *
 * It is ONE world. The reported result in this project is pooled over five worlds on the held-out
 * split, and its own summary says the sign count matters more than the ratio. A single world is a
 * demonstration of the mechanism, not evidence of the effect, and `meta()` says so in a field the UI
 * prints rather than in a comment nobody reads. Picking the seed that flatters us and showing it on
 * screen would be the easiest dishonesty available in the whole project, which is why the seed is a
 * flag with a documented default and the caveat travels with the payload.
 */

import { GUARDRAILS, POLICY, HORIZON } from '../core/config.js';
import { materialiseAssumptions } from '../sim/responseModel.js';
import { buildWorld, fitRecoveryScorer, runArm } from '../eval/harness.js';
import { compareWithinWorld, scoreArm } from '../eval/metrics.js';
import { policyFor } from '../eval/baselines.js';
import { resolveApproval } from '../agent/orchestrator.js';

/** The arm whose store the dashboard browses. The baselines exist to give its money a denominator. */
export const BROWSED_ARM = 'REBOUND_EV';

export const MEASURED_ARMS = Object.freeze([
  'B0_DO_NOTHING',
  'B1_NAIVE_RETRY',
  'B2_AGGRESSIVE',
  'B3_FIXED_LADDER',
  BROWSED_ARM,
]);

/**
 * A reviewer who never answers, so a human can.
 *
 * The simulated approver in `src/sim/approver.js` resolves pending requests on a seeded SLA. That is
 * right for the eval — every arm must meet the same reviewer or the comparison is unfair — and wrong
 * for a live console, where it would answer the queue out from under the operator, and a grant clicked
 * in the UI would race an automated one for the same case.
 *
 * So console mode installs this instead. It is deliberately not a flag on the simulated approver
 * (`grantRate: 0` would deny everything, `slaHours: Infinity` would leave a timer running): it is an
 * object that does nothing and says so, and `runArm` labels any run using it `EXTERNAL` so a score
 * computed over such a run cannot be mistaken for an eval result.
 */
export function createHumanApprover() {
  return {
    kind: 'HUMAN',
    slaHours: null,
    grantRate: null,
    async resolvePending() {
      return { resolved: [], granted: 0, denied: 0 };
    },
  };
}

/**
 * Build a session: run the batch, score it if it is scoreable, and return the handle the API consumes.
 *
 * `split` defaults to TRAIN rather than TEST, on purpose and against the instinct that the demo should
 * show the good split. TEST is the reserved held-out batch that produces the reported figure, and every
 * extra look at it is a look that erodes what "held out" means. A dashboard is a thing people click
 * repeatedly; pointing it at TEST by default would turn the reserved split into the most-viewed data in
 * the project. The eval reports TEST once, deliberately; the console browses TRAIN.
 */
export async function createSession({
  seed = 1,
  split = 'TRAIN',
  count = 80,
  cycles = HORIZON.cycles,
  stepHours = HORIZON.stepHours,
  approver = 'SIM',
  startAt = new Date('2026-06-01T09:00:00.000Z'),
  pauseAfterCycles = 2,
  onProgress = () => {},
} = {}) {
  if (approver !== 'SIM' && approver !== 'HUMAN') {
    throw new Error(`createSession: approver must be 'SIM' or 'HUMAN', got ${JSON.stringify(approver)}`);
  }
  const mode = approver === 'SIM' ? 'MEASURED' : 'CONSOLE';

  const config = { GUARDRAILS, POLICY };
  const assumptions = materialiseAssumptions();

  onProgress(`fitting the recovery model on TRAIN (seed ${seed})`);
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });

  onProgress(`building the ${split} world (${count} cases)`);
  const world = await buildWorld({ seed, split, count, startAt, train });

  const armsToRun = mode === 'MEASURED' ? MEASURED_ARMS : [BROWSED_ARM];
  const runs = new Map();
  for (const armId of armsToRun) {
    onProgress(`running ${armId}`);
    runs.set(
      armId,
      await runArm({
        world,
        arm: armId,
        decide: policyFor(armId),
        scoreAction,
        cycles,
        stepHours,
        config,
        assumptions,
        approver: armId === BROWSED_ARM && mode === 'CONSOLE' ? createHumanApprover() : undefined,
        /**
         * CONSOLE MODE STOPS EARLY AND IS THEN WALKED FORWARD BELOW.
         *
         * TWO is the default, and the reason is quiet hours rather than taste. `GUARDRAILS.quietHours`
         * is 21:00–09:00 Asia/Kolkata — a TWELVE-hour window — and `HORIZON.stepHours` is also twelve.
         * A twelve-hour step against a twelve-hour window can only alternate: if cycle i falls at an
         * hour where customer contact is legal, cycle i+1 necessarily does not. With the default
         * `startAt` the run alternates 14:30 IST (open) and 02:30 IST (quiet) for all 21 cycles, and
         * ten of them can do no contacting work at all.
         *
         * Pausing after ONE cycle therefore hands the operator a queue whose next cycle is 02:30 IST,
         * where every contacting action defers. Granting a WhatsApp nudge there does not send a WhatsApp
         * nudge; the agent's best remaining action becomes a card retry, which is outside the
         * invasiveness the signature covered, so the case correctly returns to the queue. Correct, and
         * a terrible first impression: the single most important interaction in this console would
         * appear to do nothing.
         *
         * Pausing after TWO means the next `advance()` lands at 14:30 IST, where a granted contact
         * action executes immediately. Nothing is hidden by this — the choice is only WHEN control is
         * handed over, the queue is larger rather than smaller, and the envelope refusal is still
         * reachable by passing `pauseAfterCycles: 1`, which `test/api.test.js` does precisely so that
         * both behaviours stay pinned.
         */
        pauseAfterCycles: armId === BROWSED_ARM && mode === 'CONSOLE' ? pauseAfterCycles : null,
      })
    );
  }

  const browsed = runs.get(BROWSED_ARM);

  /**
   * Walk forward until the operator has something to decide, or until the horizon runs out.
   *
   * Booting a console whose only interactive surface is empty is a worse demo than booting three
   * seconds slower, and a queue that fills on cycle 4 with nothing on screen at cycle 0 looks like a
   * broken dashboard rather than a policy that had not needed a human yet. The cap is the horizon
   * itself: if this arm never needs an approval in this world, the loop finishes and the console says
   * so instead of pretending to be paused.
   */
  if (mode === 'CONSOLE') {
    while (browsed.paused && (await browsed.store.getPendingApprovals(browsed.runId)).length === 0) {
      onProgress(`no approval pending yet — advancing to cycle ${browsed.cyclesRun}`);
      await browsed.advance();
    }
  }

  /**
   * Scored only when the run is complete. `scoreArm` would throw on a paused run anyway — that guard is
   * the load-bearing one — and this branch is here so console mode does not depend on catching it.
   */
  let comparison = null;
  if (mode === 'MEASURED') {
    onProgress('scoring');
    const scored = [];
    for (const armId of armsToRun) {
      scored.push(await scoreArm({ result: runs.get(armId), world, config }));
    }
    comparison = compareWithinWorld(scored);
  }

  /**
   * Diagnoses are looked up from the world rather than recomputed. `world.diagnosisById` is what the
   * agent was actually shown when it decided — recomputing here could disagree with it after any change
   * to the diagnosis engine, and the drawer would then explain a decision using a diagnosis that did
   * not produce it.
   */
  const diagnosisById = world.diagnosisById;

  /**
   * Whether a human has intervened in this run. Once true, even a MEASURED run's arm table is a table
   * about a world that no longer exists, so it is reported rather than quietly left stale. Console mode
   * has no table to invalidate; this flag is here for the case where someone points a browser at a
   * measured run and starts clicking.
   */
  let operatorActions = 0;

  const meta = () => ({
    mode,
    runId: browsed.runId,
    arm: BROWSED_ARM,
    seed,
    split,
    n: count,
    arms: [...armsToRun],
    startAt: startAt.toISOString(),
    clockAt: browsed.endedAt.toISOString(),
    horizon: {
      cycles: browsed.horizon.cycles,
      stepHours: browsed.horizon.stepHours,
      days: browsed.horizon.days,
    },
    cyclesRun: browsed.cyclesRun,
    paused: browsed.paused,
    approverKind: browsed.approvals.approverKind,
    approverSlaHours: browsed.approvals.slaHours,
    approverGrantRate: browsed.approvals.grantRate,
    stoppedEarlyAfter: browsed.stoppedEarlyAfter,
    totalExposurePaise: world.totalExposurePaise,
    operatorActions,
    /**
     * The arm-comparable table, straight from `compareWithinWorld`, or null. Passed through untouched
     * when it exists: the dashboard's job is to render the eval's numbers, not to have its own. Null in
     * console mode is not a missing feature — it is the correct answer to "what did this recover
     * relative to doing nothing", asked of a run that has not finished.
     */
    counterfactualPaise: comparison?.counterfactualPaise ?? null,
    rows: comparison?.rows ?? null,
    invariants: comparison?.invariants ?? null,
    /**
     * THE HONESTY BLOCK. Rendered by the UI, not buried here.
     *
     * Every one of these sentences exists because the alternative is a screen that overstates the
     * result by omission. A judge who reads only the dashboard should end up with the same understanding
     * as a judge who reads the engineering log.
     */
    caveats: [
      `This is ONE world (seed ${seed}, ${split} split, n=${count}). The reported result is pooled over five worlds on the held-out TEST split. A single world shows the mechanism; it is not evidence of the effect.`,
      'This screen is a SIMULATION of policy. The separate claim that the Razorpay integration works is made only by `npm run doctor` against the real test-mode API, and the two are never mixed in one command or one screen.',
      ...(mode === 'MEASURED'
        ? [
            'Money is INCREMENTAL: B0_DO_NOTHING measures what arrives with no agent at all, and that is subtracted from every arm. Gross recovery overstates this project by roughly two thirds on the most favourable seed.',
            `APPROVER: SIM. A seeded reviewer answers on a ${browsed.approvals.slaHours}-hour SLA with a ${browsed.approvals.grantRate} grant rate, identically for every arm — so the approval queue is empty by design here, not because nothing was gated.`,
          ]
        : [
            `CONSOLE MODE: NO MONEY FIGURES. This run is PAUSED at cycle ${browsed.cyclesRun} of ${browsed.horizon.cycles} so that you are the reviewer. A truncated run is biased twice in our favour — cases still in flight have had less time to fail, and frozen approvals are money the policy never spent — so no recovery total is computed and none may be quoted. Run \`npm run api\` without --approver=HUMAN for the measured comparison.`,
            'APPROVER: HUMAN (you). Grant or deny in the queue, then advance the clock: the agent re-decides at the new instant and executes what it was holding, through the same loop the eval runs.',
          ]),
      ...(operatorActions > 0 && mode === 'MEASURED'
        ? [
            `An operator has taken ${operatorActions} action(s) in this run since it was scored. The arm table above describes the run as it stood at boot and is now stale. Restart to re-measure.`,
          ]
        : []),
    ],
  });

  return {
    runId: browsed.runId,
    store: browsed.store,
    world,
    comparison,
    meta,
    diagnosisFor: (eventId) => diagnosisById.get(eventId) ?? null,
    resolveApproval: async ({ eventId, grant, by, note }) => {
      /**
       * Delegated to the orchestrator's own lifecycle rather than reimplemented. That function owns the
       * state guard that makes a grant idempotent and a denial terminal, writes the audit entries, and
       * returns the case to OPEN with a null `nextActionAt` so the agent re-decides at the current
       * instant. An API that patched the case directly would have to reproduce all of it, and would
       * drift.
       *
       * `at` is the RUN's clock, not the wall clock. The whole world — every deadline, every retry gap,
       * every quiet-hours check — is on simulated time, and stamping a grant with `new Date()` would
       * put the approval three months after the failure it approves and hand the next cycle a case whose
       * approval is dated in its future. The operator's decision happens at the instant the run is
       * paused at, which is what the paused run's clock holds.
       */
      const result = await resolveApproval({
        store: browsed.store,
        runId: browsed.runId,
        eventId,
        grant,
        by,
        note,
        at: browsed.endedAt,
      });
      if (result.applied) operatorActions += 1;
      return result;
    },
    /**
     * Step the world forward one cycle. Console mode only, and refused elsewhere.
     *
     * A MEASURED run has already finished its horizon, so `advance()` there would report `ran: false`
     * and be harmless — but the reason to refuse it explicitly is the arm table. Anything that could
     * change the store after `compareWithinWorld` has run turns the numbers on screen into a description
     * of a world that no longer exists, and "harmless because it happens to be a no-op" is a property
     * that survives exactly until someone raises the horizon.
     */
    advance: async () => {
      if (mode !== 'CONSOLE') {
        return {
          ran: false,
          because:
            'This is a MEASURED run: its horizon is complete and its arm comparison has been computed. ' +
            'Advancing the clock would invalidate every figure on screen. Start with --approver=HUMAN ' +
            'for a run you can step.',
        };
      }
      const stepped = await browsed.advance();
      return {
        ran: stepped.ran,
        cycle: stepped.cycle,
        cyclesRun: browsed.cyclesRun,
        cyclesTotal: browsed.horizon.cycles,
        paused: browsed.paused,
        clockAt: browsed.endedAt.toISOString(),
        summary: stepped.summary ?? null,
        because: stepped.ran ? null : 'the horizon is finished; there are no cycles left to run',
      };
    },
  };
}
