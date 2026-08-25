/**
 * THE MULTI-ARM HARNESS — one world, several policies, identical luck.
 *
 * Day 7's `orchestrate-report.js` grew a multi-cycle loop inline. Day 8 needs to run five policy
 * arms over the same world, so that loop had to become a function that takes the policy as an
 * argument. This file is that function plus the world it runs in.
 *
 * It lives under `src/eval/` and not `src/agent/` because it reads LATENT TRUTH. It hands latents to
 * the gateway (which is the world and is entitled to know) and to the metrics layer (which is
 * scoring, after the fact). It must never put a latent on a case record. `test/boundary.test.js`
 * enforces that `src/agent/**` cannot import `src/sim/**` at all; this file is the seam that is
 * allowed to touch both sides, and that permission is exactly why its boundaries are written down.
 *
 * =================================================================================================
 * THE THREE THINGS THAT MAKE AN ARM COMPARISON MEAN ANYTHING
 * =================================================================================================
 * Every one of these is an invariant that, if broken, yields a comparison that still runs, still
 * prints confident rupee figures, and measures something other than policy quality. That is the
 * failure mode worth engineering against: not a crash, a plausible wrong answer.
 *
 * 1. SAME WORLD. All arms see the same events, the same latents, the same customers, and the same
 *    fitted recovery model. The model is fitted ONCE, here, and shared — refitting per arm would
 *    let two arms disagree because their models differ, which is not the question being asked.
 *
 * 2. SAME LUCK, and this one is a trap. `simGateway` derives one RNG stream per action from
 *    `deriveSeed(seed, reference)`, and `buildReference` hashes the `runId` into that reference. So
 *    two arms running under different runIds face DIFFERENT outcome draws for the identical action
 *    on the identical case. Verified rather than assumed:
 *
 *      runId `run_day7_TRAIN`      -> ref rbd_RN1_vt000001_2d0a401ccb -> stream seed 1523402263
 *      runId `run_day7_TRAIN_B1`   -> ref rbd_RN1_vt000001_209c97a689 -> stream seed 1404675869
 *
 *    Therefore every arm runs under the SAME runId, in its OWN store. Identical runId keeps the
 *    luck paired; separate stores keep the idempotency keys from colliding (the reference IS the
 *    idempotency key, and two arms writing the same key into one store would have the second arm
 *    skip the action as a duplicate and report it as free). `runArm` constructs the store itself so
 *    a caller cannot get this wrong.
 *
 * 3. SAME CLOCK, shared by the orchestrator and the gateway through one mutable closure. If the
 *    gateway kept its own clock, a retry the policy priced to land at +72h would be resolved by the
 *    response model against whenever the process happened to be running, and the entire
 *    landing-instant correction from Day 6 would be undone at the seam without any test failing.
 *
 * =================================================================================================
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * =================================================================================================
 * It does not compute metrics and it does not decide anything. It produces a finished run — a store
 * full of cases, actions and audit entries — and hands it to `metrics.js` to be counted. Keeping
 * running and scoring apart is what lets the same metric code score all five arms, which is the
 * only way two arms' numbers are known to be commensurable.
 */

import { generateBatch } from '../sim/generator.js';
import { buildDataset } from './dataset.js';
import { splitByEvent } from './modelComparison.js';
import { observe } from '../agent/observe.js';
import { diagnose } from '../agent/diagnose.js';
import { fitLookupTable, fitPlatt } from '../ml/calibration.js';
import { fitLogistic } from '../ml/logistic.js';
import { createRecoveryScorer } from '../agent/recoveryModel.js';
import { runCycle, CaseState, AuditType } from '../agent/orchestrator.js';
import { createMemoryStore } from '../db/store.js';
import { createSimGateway } from '../sim/simGateway.js';
import { checkSelfRecovery, settlementAmountPaise, materialiseAssumptions } from '../sim/responseModel.js';
import { createSimApprover } from '../sim/approver.js';
import { percentile } from '../core/stats.js';
import { GUARDRAILS, POLICY, HORIZON } from '../core/config.js';

const HOUR_MS = 3_600_000;

/**
 * The runId every arm shares. A function of the world, NOT of the arm — see invariant 2. If you are
 * tempted to append the arm name here to make a debug log easier to read, that change silently
 * unpairs the comparison and nothing will fail.
 */
export const runIdFor = ({ seed, split }) => `run_${seed}_${split}`;

/**
 * Fit the recovery model. Once per world, shared by every arm.
 *
 * Identical to `decide-report` and `orchestrate-report` including hyperparameters, deliberately: the
 * arm this harness executes must be the arm `npm run select-arm` selected and the arm `decide-report`
 * prices, or the commands describe three different systems. Always on TRAIN, even when the run is on
 * TEST — fitting on the split being scored would make every lookup cell well-supported and the
 * support asymmetry the stopping rules depend on impossible to observe.
 */
export async function fitRecoveryScorer({ seed, startAt }) {
  const train = generateBatch({ seed, split: 'TRAIN', now: startAt });
  const trainData = await buildDataset({ events: train.events, latents: train.latents, seed });
  const { fit, valid: cal } = splitByEvent(trainData.rows, { fraction: 0.8, seed });

  const lookup = fitLookupTable(fit, { key: (r) => `${r.diagnosedCause}|${r.actionKind}`, minCount: 10 });
  const logistic = fitLogistic(fit, { l2: 1e-4, iterations: 500, learningRate: 0.5 });
  const logPlatt = fitPlatt(cal.map((r) => r.y), cal.map((r) => logistic.predict(r.x)));

  /**
   * Probability from the logistic arm, SUPPORT from the lookup table. Two questions, two
   * instruments: a logistic model will extrapolate a confident number for a cell it has never seen,
   * which is exactly what the stopping rules exist to catch.
   */
  const scoreAction = createRecoveryScorer({
    model: logistic,
    calibrator: logPlatt,
    supportFrom: lookup,
    modelName: 'logistic+platt',
  });

  return { scoreAction, logistic, logPlatt, lookup, train };
}

/**
 * Build the world: the events to be recovered, the latent truth behind them, and the observation
 * and diagnosis each case gets.
 *
 * Observation and diagnosis are computed ONCE and shared across arms rather than recomputed per
 * arm. Two reasons, and the second matters more. It is faster; and it guarantees that a difference
 * between arms cannot come from the diagnosis layer, because both arms are handed the identical
 * diagnosis object. Diagnosis is not part of the policy under test.
 */
export async function buildWorld({ seed, split = 'TRAIN', count = 80, startAt, train = null }) {
  const target =
    split === 'TRAIN'
      ? (train ?? generateBatch({ seed, split: 'TRAIN', now: startAt }))
      : generateBatch({ seed, split: 'TEST', now: startAt });

  const events = target.events.slice(0, count);
  const eventIds = new Set(events.map((e) => e.eventId));

  const latentById = new Map(
    target.latents.filter((l) => eventIds.has(l.eventId)).map((l) => [l.eventId, l])
  );
  const customerById = new Map(target.customers.map((c) => [c.customerId, c]));

  const observedById = new Map();
  const diagnosisById = new Map();
  for (const event of events) {
    const observed = observe(event);
    observedById.set(event.eventId, observed);
    diagnosisById.set(event.eventId, await diagnose(observed));
  }

  return {
    seed,
    split,
    startAt,
    events,
    latentById,
    customerById,
    observedById,
    diagnosisById,
    totalExposurePaise: events.reduce((s, e) => s + e.amountPaise, 0),
    runId: runIdFor({ seed, split }),
  };
}

/** The case records the agent is allowed to see. Latents are conspicuously absent. */
function caseRecordsFor(world, runId) {
  return world.events.map((event) => ({
    runId,
    eventId: event.eventId,
    customerId: event.customerId,
    amountPaise: event.amountPaise,
    state: 'OPEN',
    retriesUsed: 0,
    touchesUsed: 0,
    openedAt: world.startAt,
    /**
     * Contact details and the event itself, because the gateway seam needs both:
     * `validateActionRequest` refuses a CUSTOMER_CONTACTING action with no customer, in SIM exactly
     * as in LIVE, and the SIM gateway prices outcomes against the loss's own physics. Both are
     * OBSERVABLE records — the event is the failure as our own systems recorded it. The latent
     * truth about why it failed lives in `world.latentById` and goes only to the gateway.
     */
    customer: world.customerById.get(event.customerId) ?? null,
    event,
  }));
}

/**
 * Credit every case the customer has paid unprompted by `now`.
 *
 * =================================================================================================
 * WHY THIS IS NOT OPTIONAL, AND WHY IT DOES NOT FILTER ON ACTIVE CASES
 * =================================================================================================
 * Self-recovery is a property of the WORLD, not of a policy. It therefore has to fire identically for
 * every arm, before any policy is consulted, and `runArm` calls it unconditionally rather than through
 * a caller-supplied hook — an arm that could be run without it would report gross money as though it
 * were incremental, and would look better for it.
 *
 * The subtle half is the case selection. The intuitive filter is `getActiveCases`, and it is wrong in
 * a way that destroys the measurement: `B0_DO_NOTHING` stops every case in its first cycle, so by
 * cycle 1 it has no active cases at all. Filtering on active would hand B0 a self-recovery total of
 * exactly zero — inverting the single number B0 exists to produce, and making every active arm's
 * "incremental" figure identical to its gross figure. So the rule is: a case is eligible unless money
 * has ALREADY arrived. STOPPED and ESCALATED cases remain eligible, which is also just true — a
 * customer who was going to pay does not consult our case state first.
 *
 * Money lands in `selfRecoveredPaise`, never in `recoveredPaise`, and the case takes the distinct
 * terminal state `RECOVERED_SELF`. Both choices exist so that a metric which carelessly sums the
 * obvious field gets the agent's contribution alone.
 */
export async function applySelfRecovery({ store, runId, now, world, cycle = 0 }) {
  const all = await store.getCases(runId);
  let paise = 0;
  let count = 0;

  for (const c of all) {
    if (c.state === CaseState.RECOVERED || c.state === CaseState.RECOVERED_SELF) continue;

    const latent = world.latentById.get(c.eventId);
    if (!latent || !checkSelfRecovery({ latent, now })) continue;

    /**
     * The haircut applies here exactly as it does to an agent-driven settlement — a disputing
     * customer who pays unprompted still pays their reduced amount. Shared with the gateway through
     * `settlementAmountPaise` rather than recomputed, because two copies of a partial-settlement rule
     * is how "booked at full value" comes back.
     */
    const collected = settlementAmountPaise({ latent, event: c.event });

    await store.patchCase(runId, c.eventId, {
      state: CaseState.RECOVERED_SELF,
      selfRecoveredPaise: collected,
      selfRecoveredAt: now,
      nextActionAt: null,
    });

    await store.appendAudit({
      runId,
      eventId: c.eventId,
      type: AuditType.SELF_RECOVERED,
      at: now,
      detail: {
        amountPaise: collected,
        /**
         * Recorded so the trail can answer "did the agent waste effort on this case before the
         * customer paid anyway?" — which is a real cost the headline figure does not show.
         */
        stateWhenPaid: c.state,
        attemptsAlreadySpent: c.touchesUsed ?? 0,
        partialSettlement: collected < c.amountPaise,
        cycle,
      },
    });

    paise += collected;
    count += 1;
  }

  return { selfRecoveredPaise: paise, selfRecoveredCount: count };
}

/**
 * Run one policy arm over one world, for N cycles.
 *
 * @param world       from `buildWorld`
 * @param arm         the POLICY_ARMS id, recorded on the run and passed through as a label
 * @param scoreAction the shared fitted model
 * @param decide      the policy under test. Omitted means `decideForCase` (the orchestrator's
 *                    default), which is REBOUND_EV.
 * @param cycles      how many times to run the loop. Defaults to `HORIZON.cycles`, NOT to a
 *                    convenient small number. It used to default to 8 (4 days), which is short of
 *                    the 10 days self-recovery needs to play out, and a default that quietly
 *                    truncates is worse than no default: a caller who omits the flag gets a run that
 *                    LOOKS complete and systematically favours arms that act early. Anyone wanting a
 *                    fast run should cut worlds or cases and keep the cycles.
 * @param stepHours   how far the clock advances between cycles. Defaults to `HORIZON.stepHours`.
 * @param assumptions optional materialised (possibly perturbed) assumption set for the WORLD. The
 *                    agent's beliefs are in `scoreAction` and are NOT perturbed with it — see the
 *                    sensitivity sweep for why perturbing both together tests nothing.
 * @param onCycle     called with each cycle summary, for progress output
 * @param beforeCycle escape hatch for a caller that needs to observe or mutate state before a cycle
 *                    decides. NOT where self-recovery lives — that is applied unconditionally below,
 *                    because a world property routed through an optional hook is a world property one
 *                    arm can be run without.
 */
export async function runArm({
  world,
  arm = 'REBOUND_EV',
  scoreAction,
  decide,
  cycles = HORIZON.cycles,
  stepHours = HORIZON.stepHours,
  config = { GUARDRAILS, POLICY },
  assumptions,
  onCycle,
  beforeCycle,
}) {
  const { startAt, runId } = world;
  const store = createMemoryStore();
  await store.putRun({ runId, startedAt: startAt, arm, seed: world.seed, split: world.split });
  await store.putCases(caseRecordsFor(world, runId));

  /**
   * ONE materialised assumption set, shared by the gateway and the approver.
   *
   * `createSimGateway` will happily default to `materialiseAssumptions()` on its own, and so would a
   * separate call here. Two independent defaults agree today by coincidence and would diverge the
   * moment either grew a parameter — the run would then be scored in a world where the payments
   * physics came from one assumption set and the human reviewer from another, and nothing would fail.
   * Resolving it once here makes that impossible.
   */
  const A = assumptions ?? materialiseAssumptions();

  /**
   * One mutable clock, closed over by both the orchestrator and the gateway. See invariant 3.
   */
  let clock = new Date(startAt);
  const gateway = createSimGateway({
    getLatent: (eventId) => world.latentById.get(eventId),
    seed: world.seed,
    assumptions: A,
    now: () => clock,
  });

  /**
   * The human on the other side of the approval gate. Seeded from the WORLD, never from the arm, so
   * two arms that queue the same case meet the same reviewer in the same mood — see `approver.js`.
   */
  const approver = createSimApprover({ seed: world.seed, assumptions: A, guardrails: config.GUARDRAILS });

  const cycleSummaries = [];
  let recoveredPaise = 0;
  let selfRecoveredPaise = 0;
  let selfRecoveredCount = 0;
  let attempts = 0;
  let stoppedEarlyAfter = null;
  /**
   * Every approval the simulated reviewer answered, in order. Accumulated here rather than
   * reconstructed from the audit trail by `metrics.js` because the DRAWN wait (what the reviewer
   * took) and the REALISED wait (what the trail records, after pushing out of the reviewer's
   * off-hours) are different numbers, and only one of them survives into the audit entry. Reporting
   * both is what lets a reader check that "18-hour SLA" describes the run rather than the label.
   */
  const approvals = [];

  /**
   * THE LOOP RUNS ITS FULL HORIZON EVEN AFTER THE POLICY GOES QUIET.
   *
   * It used to `break` as soon as no case was active, which is right for deciding and wrong for the
   * world: self-recovery keeps happening to cases a policy has abandoned. Breaking early truncated
   * the observation window for exactly the arms that stop soonest — B0 hardest of all — so the arms
   * would have been compared over different lengths of time while appearing to share a horizon.
   *
   * So `stoppedEarlyAfter` now records when the POLICY fell silent, and the world runs on to the end.
   * The horizon is the instants `startAt + i*stepHours` for i in [0, cycles); a self-recovery falling
   * after the last of those is outside the run and counted for nobody, identically across arms.
   */
  for (let i = 0; i < cycles; i += 1) {
    clock = new Date(startAt.getTime() + i * stepHours * HOUR_MS);

    const self = await applySelfRecovery({ store, runId, now: clock, world, cycle: i });
    selfRecoveredPaise += self.selfRecoveredPaise;
    selfRecoveredCount += self.selfRecoveredCount;

    /**
     * THE REVIEWER ANSWERS, UNCONDITIONALLY, FOR EVERY ARM.
     *
     * Same placement and same reasoning as `applySelfRecovery` above: this is a property of the world,
     * so it is called directly rather than through the `beforeCycle` hook. `APR_LARGE_AMOUNT` gates
     * all five arms, so all five have a queue; an approver wired to run for Rebound alone would be
     * the most flattering bug available in this project and the money column would look normal.
     *
     * AFTER self-recovery and BEFORE the policy decides. After, because a customer who has already
     * paid should not have their case handed back to the policy by a grant — `resolveApproval` guards
     * on state, so this is belt and braces, but the ordering is the part that makes the guard
     * unnecessary rather than load-bearing. Before, because a grant returns the case to OPEN with a
     * null `nextActionAt`, and the whole design of the envelope is that the agent RE-DECIDES at the
     * current instant; deciding first and granting after would delay every granted case by a full
     * cycle for no reason other than statement order.
     */
    const answered = await approver.resolvePending({ store, runId, now: clock });
    for (const a of answered.resolved) approvals.push({ ...a, cycle: i });

    if (beforeCycle) await beforeCycle({ store, runId, now: clock, cycle: i, world });

    const active = await store.getActiveCases(runId);
    if (active.length === 0) {
      if (stoppedEarlyAfter === null) stoppedEarlyAfter = i;
      continue;
    }

    const { summary } = await runCycle({
      store,
      gateway,
      runId,
      now: clock,
      config,
      scoreAction,
      observeCase: (c) => world.observedById.get(c.eventId),
      diagnoseCase: (obs) => world.diagnosisById.get(obs.eventId),
      decide,
      cycle: i,
      policyArm: arm,
    });

    recoveredPaise += summary.recoveredPaise;
    attempts += summary.attempts;
    cycleSummaries.push({ ...summary, activeAtStart: active.length });
    if (onCycle) await onCycle({ ...summary, activeAtStart: active.length }, clock);
  }

  return {
    arm,
    store,
    runId,
    gateway,
    cycles: cycleSummaries,
    /**
     * Money the GATEWAY confirmed, summed as the run went. `metrics.js` recomputes it from the
     * final case records and asserts the two agree; a disagreement means money was credited with no
     * receipt behind it. Two independent paths is why this figure is worth anything.
     */
    recoveredPaise,
    /**
     * Money that arrived with no action from us. Kept apart from `recoveredPaise` at every level —
     * case field, case state, and here — so that no single careless sum can merge them. The headline
     * Day 8 metric is an arm's `recoveredPaise` measured against B0's on the same world with the same
     * luck; this figure is what makes that subtraction meaningful rather than decorative.
     */
    selfRecoveredPaise,
    selfRecoveredCount,
    attempts,
    stoppedEarlyAfter,
    /**
     * What the human reviewer did, and how long they took.
     *
     * `pendingAtEnd` is deliberately NOT computed here — it is a property of the final case records
     * and `metrics.js` reads it from there, so the two paths can be cross-checked the way the money
     * figures are. What this holds is the event log the case records cannot reconstruct.
     *
     * The two wait figures answer different questions and both are reported. `drawnWaitHours` is how
     * long the reviewer took; `realisedWaitHours` adds the wait for them to be back at their desk, so
     * a request raised at 20:00 with a 4-hour draw shows 4.0 and 13.0. Reporting only the first would
     * understate the gate's real cost; only the second would make the SLA unverifiable.
     */
    approvals: {
      slaHours: approver.slaHours,
      grantRate: approver.grantRate,
      resolved: approvals,
      granted: approvals.filter((a) => a.state === 'GRANTED').length,
      denied: approvals.filter((a) => a.state === 'DENIED').length,
      grantedPaise: approvals.filter((a) => a.state === 'GRANTED').reduce((s, a) => s + a.amountPaise, 0),
      deniedPaise: approvals.filter((a) => a.state === 'DENIED').reduce((s, a) => s + a.amountPaise, 0),
      drawnWaitHoursP50: percentile(approvals.map((a) => a.drawnWaitHours), 50),
      realisedWaitHoursP50: percentile(approvals.map((a) => a.realisedWaitHours), 50),
      realisedWaitHoursP90: percentile(approvals.map((a) => a.realisedWaitHours), 90),
      realisedWaitHoursMax: percentile(approvals.map((a) => a.realisedWaitHours), 100),
    },
    /**
     * The horizon the loop ACTUALLY ran, not the one the caller meant to ask for. Reported because
     * `cycles` above holds one summary per cycle that had work to do — an arm that goes quiet on
     * cycle 2 reports two summaries out of twenty-one — so `cycles.length` is a measure of policy
     * behaviour and cannot double as a record of the horizon. Conflating the two is how a truncated
     * run reads as a complete one.
     */
    horizon: { cycles, stepHours, days: ((cycles - 1) * stepHours) / 24 },
    endedAt: clock,
  };
}
