/**
 * THE SIMULATED APPROVER — the human on the other side of the approval gate.
 *
 * Day 7 built the queue and Day 8 built the lifecycle (`resolveApproval`), and between them they
 * left the gate write-only: cases went in and nothing ever came out. Measured across five worlds,
 * that stranded about 72% of Rebound's exposure in `AWAITING_APPROVAL` at the horizon. Every money
 * figure in the five-arm table was therefore measured in a world containing no reviewer, which is not
 * a conservative world — it is an incoherent one. A merchant who installs an approval gate also
 * employs somebody to answer it.
 *
 * =================================================================================================
 * WHY THIS LIVES IN src/sim/ AND NOT IN src/agent/
 * =================================================================================================
 * The reviewer is part of the WORLD. Their disposition toward a case, and how long they take, are
 * facts the agent does not get to know — exactly like `willSelfRecover` or `payerType`. Putting the
 * approver under `src/agent/` would make it importable by the policy, and a policy that can read the
 * approver can time its requests to catch a generous one. `test/boundary.test.js` already forbids
 * `src/agent/**` from importing `src/sim/**`, so this placement is enforced rather than intended.
 *
 * The agent's only channel to this file is the queue itself, and its only channel back is the case
 * state. That is the same seam a real dashboard would use.
 *
 * =================================================================================================
 * THE RNG STREAM IS KEYED ON THE CASE AND NOTHING ELSE, AND THAT IS THE WHOLE PAIRING ARGUMENT
 * =================================================================================================
 * `harness.js` invariant 2 (SAME LUCK) says two arms facing the identical situation must face the
 * identical draw. Applied here it has a specific and slightly surprising consequence: the seed must
 * be a function of the world and the case, and MUST NOT include the arm, the cycle, or the instant
 * the request was raised.
 *
 * If the request time went into the seed, then B3 queueing case X on cycle 2 and Rebound queueing the
 * same case X on cycle 5 would draw different reviewer decisions. One arm would be denied and the
 * other granted, for a reason that has nothing to do with either policy, and the difference would land
 * squarely in the money column. Keying on `eventId` alone makes the reviewer's disposition a property
 * of the CASE — of its amount and its story, which is what a reviewer actually looks at — so both arms
 * meet the same reviewer in the same mood. This is the difference between measuring policy and
 * measuring which arm got lucky with the approvals queue.
 *
 * It also means a case that returns to the queue a second time (its grant envelope expired, or the
 * policy now wants something more invasive) meets the same answer. That is deliberate and defensible:
 * a reviewer who authorised chasing this invoice yesterday is the same reviewer today. Denials are
 * terminal, so only grants can ever be re-drawn.
 *
 * =================================================================================================
 * WHAT THIS DELIBERATELY DOES NOT MODEL
 * =================================================================================================
 * The reviewer has no capacity limit. A world where 40 requests arrive at once is answered as fast as
 * a world where one does. Real queues do not behave that way, and a capacity model would make the
 * approval gate genuinely more expensive for the arm that queues the most — which is Rebound. So this
 * omission flatters us, it is not neutral, and it is written down here rather than discovered later.
 * The `approverSlaHours` sweep to 48h is the crude stand-in: a swamped reviewer looks like a slow one.
 */

import { makeRng, deriveSeed } from '../core/rng.js';
import { GUARDRAILS } from '../core/config.js';
import { nextInstantOutsideWindow, isWithinHourWindow } from '../core/timezone.js';
import { resolveApproval, CaseState } from '../agent/orchestrator.js';

const HOUR_MS = 3_600_000;

/**
 * Draw a wait from an exponential with mean `slaHours`.
 *
 * Exponential rather than a fixed delay or a uniform band, for one reason that matters to the
 * measurement: it has a long tail. A fixed 18-hour wait resolves every request in the same cycle and
 * so cannot produce the case that waits three days and finds its own approval about to expire — which
 * is the failure mode `GUARDRAILS.approvalValidForHours` exists for and which therefore has to be
 * reachable in simulation, or the expiry logic is untested by anything but a unit test.
 *
 * Consequence to state plainly: the MEAN wait is the SLA, the MEDIAN is about 0.69 of it, and the
 * worst case is unbounded. `summariseApprovals` reports the realised p50, p90 and max so that nobody
 * has to take the label "18-hour SLA" on trust.
 */
export function sampleApproverWaitHours(u, slaHours) {
  // u is uniform on [0,1); 1-u avoids log(0) at the top of the range.
  const hours = -slaHours * Math.log(1 - u);
  /**
   * `+ 0` is not decoration. At u = 0 the expression above is `-slaHours * 0`, which in IEEE-754 is
   * NEGATIVE zero, and negative zero survives arithmetic: it would print as `-0` in a wait-time
   * report and would make `Object.is(wait, 0)` false in any test that checks the boundary. Adding
   * zero collapses -0 to 0 and leaves every other value untouched.
   */
  return hours + 0;
}

/**
 * Create the approver for one world.
 *
 * @param seed        the world seed. Combined with the eventId, never with the arm — see above.
 * @param assumptions the materialised (possibly perturbed) assumption set. Required, with no default,
 *                    for the same reason `recoveryProbability` refuses one: a silent default would
 *                    make the sensitivity sweep secretly run every arm against the baseline approver
 *                    and report that the result is insensitive to it.
 * @param guardrails  so the reviewer's working hours and the grant validity window come from the same
 *                    config the guardrail engine enforces.
 */
export function createSimApprover({ seed, assumptions, guardrails = GUARDRAILS }) {
  if (!assumptions || typeof assumptions.approverSlaHours !== 'number') {
    throw new TypeError(
      'createSimApprover({ assumptions }) requires a materialised assumption set with ' +
        'approverSlaHours. Refusing to default: a default here would make the sensitivity sweep ' +
        'run every arm against the same approver while reporting that it varied one.'
    );
  }

  const slaHours = assumptions.approverSlaHours;
  const grantRate = assumptions.approvalGrantRate;

  /**
   * THE CONSTRAINT THAT IS EASY TO BREAK BY EDITING A NUMBER IN A DIFFERENT FILE.
   *
   * `GUARDRAILS.approvalValidForHours` was set to 72 specifically because it must comfortably exceed
   * the approver SLA — its own docblock says so. But the SLA lives in `ASSUMPTIONS` and the validity
   * window lives in `GUARDRAILS`, in different files, and the sweep moves one of them. Nothing
   * connected the two until this line. If the sweep pushes the SLA past the validity window, grants
   * expire before the agent can use them and every affected case cycles between queue and expiry
   * forever while the run still prints a tidy recovery figure.
   *
   * Asserting on the MEAN is not quite enough — the distribution has a tail, so individual requests
   * can still exceed the window even when the mean is comfortable, and they should: that path is real
   * and needs to be exercised. What must not happen is the mean itself crossing over. Hence 2x.
   */
  if (slaHours * 2 > guardrails.approvalValidForHours) {
    throw new Error(
      `simulated approver: mean SLA of ${slaHours}h is not comfortably inside the ` +
        `${guardrails.approvalValidForHours}h grant validity window. Most grants would expire before ` +
        'the agent could act on them, cases would cycle between the queue and expiry, and the run ' +
        'would still print a plausible recovery figure. Raise GUARDRAILS.approvalValidForHours or ' +
        'lower ASSUMPTIONS.approverSlaHours.sweep.'
    );
  }

  /**
   * The reviewer's decision and wait for a case. Pure, deterministic, and computed from a fresh
   * stream every time so that calling it twice for the same case cannot drift.
   */
  function dispositionFor(eventId) {
    const rng = makeRng(deriveSeed(seed, `approver|${eventId}`));
    const waitHours = sampleApproverWaitHours(rng.next(), slaHours);
    /**
     * Order matters and is fixed: wait first, then grant. Both come from one stream, so swapping the
     * two lines silently re-rolls every decision in the project. Anything reading these draws in a
     * different order is a different world.
     */
    const grant = rng.next() < grantRate;
    return { waitHours, grant };
  }

  /**
   * When the reviewer actually answers, given when the request was raised.
   *
   * Two steps, and the second is the one that makes the SLA mean something. The raw draw lands
   * wherever it lands, including 03:00. A finance-ops reviewer is not at their desk at 03:00, so the
   * answer is pushed to the start of the next working window. Working hours are taken as the
   * COMPLEMENT of the customer quiet-hours window rather than as a second copy of 09:00-21:00, so the
   * two cannot drift apart in config.
   */
  function decidedAtFor(requestedAt, waitHours) {
    const raw = new Date(new Date(requestedAt).getTime() + waitHours * HOUR_MS);
    if (!isWithinHourWindow(raw, guardrails.quietHours)) return raw;
    return nextInstantOutsideWindow(raw, guardrails.quietHours);
  }

  /**
   * Answer every request whose reviewer time has arrived, and leave the rest pending.
   *
   * Called unconditionally by `runArm` on every cycle for every arm, in the same place and for the
   * same reason `applySelfRecovery` is: it is a world property, and a world property routed through
   * an optional hook is a world property that one arm can be run without. An approver that only ran
   * for Rebound would be the single most flattering bug available in this project, and the money
   * total would look completely normal.
   *
   * `resolveApproval` is called with `at: decidedAt`, NOT with `at: now`. The cycle grid is 12 hours
   * wide, so a reviewer who answered after 3 hours is only NOTICED by the agent on the next cycle.
   * Recording the cycle instant instead would overstate every wait by up to a cycle and would start
   * the grant's expiry clock late. So the audit trail carries the true reviewer time and the
   * quantisation is confined to when the agent gets to act — which is honest, because that is exactly
   * what a batch job would do.
   */
  async function resolvePending({ store, runId, now }) {
    const cases = await store.getCases(runId);
    const resolved = [];

    for (const c of cases) {
      if (c.state !== CaseState.AWAITING_APPROVAL) continue;
      if (c.approval?.state !== 'PENDING') continue;
      const requestedAt = c.approval?.requestedAt;
      if (!requestedAt) continue;

      const { waitHours, grant } = dispositionFor(c.eventId);
      const decidedAt = decidedAtFor(requestedAt, waitHours);
      if (decidedAt.getTime() > new Date(now).getTime()) continue; // reviewer hasn't got to it yet

      const outcome = await resolveApproval({
        store,
        runId,
        eventId: c.eventId,
        grant,
        by: 'sim-approver',
        at: decidedAt,
        note: grant
          ? `simulated reviewer, mean SLA ${slaHours}h, grant rate ${grantRate}`
          : `simulated reviewer declined; grant rate ${grantRate}`,
      });

      if (outcome.applied) {
        resolved.push({
          eventId: c.eventId,
          amountPaise: c.amountPaise ?? 0,
          state: outcome.state,
          drawnWaitHours: Number(waitHours.toFixed(2)),
          /** What the trail will show: includes the push out of the reviewer's off-hours. */
          realisedWaitHours: Number(
            ((decidedAt.getTime() - new Date(requestedAt).getTime()) / HOUR_MS).toFixed(2)
          ),
        });
      }
    }

    return { resolved, granted: resolved.filter((r) => r.state === 'GRANTED').length,
      denied: resolved.filter((r) => r.state === 'DENIED').length };
  }

  return { resolvePending, dispositionFor, decidedAtFor, slaHours, grantRate };
}
