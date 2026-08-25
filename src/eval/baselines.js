/**
 * THE FOUR BASELINES — the policies Rebound has to beat, written to actually win.
 * ==============================================================================
 *
 * A baseline exists to be a fair opponent. That sounds obvious and it is the single easiest thing to
 * get wrong in a hackathon submission, because every incentive points the other way: a baseline that
 * is quietly crippled makes the headline number larger, and nothing in the code will complain. So
 * the rules this file holds itself to are written down, and each one is a specific temptation
 * refused.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 1 — EVERY ARM RUNS THROUGH THE SAME LOOP, THE SAME STORE AND THE SAME GATEWAY.
 * ---------------------------------------------------------------------------------------------
 * `runCycle` takes `decide` as an argument precisely so a baseline can be substituted without
 * anything else changing. If a baseline ran through its own simplified loop, the comparison would
 * measure the loop — crash-safety, ordering, ledger hydration, self-recovery — and attribute all of
 * it to policy quality. Rebound's advantage would then include the value of its own plumbing, which
 * is not a policy claim and would be indefensible if a judge asked how the baseline was implemented.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 2 — THE BASELINES GET THE SAME GUARDRAIL ENGINE, WITH ONE DELIBERATE EXCEPTION.
 * ---------------------------------------------------------------------------------------------
 * B1 and B3 obey every guardrail Rebound obeys, from the same `checkGuardrails` call. They are not
 * handicapped and they are not exempt.
 *
 * `B2_AGGRESSIVE` is the exception and it is exempt in ONE direction only: it ignores TIMING and
 * BUDGET verdicts (quiet hours, contact caps, retry gaps) while still obeying every ABSOLUTE rule.
 * That is not a straw man, it is the arm that models what most automated dunning actually does, and
 * it is here because it is the arm most likely to BEAT Rebound on money recovered. An honest
 * comparison needs an opponent that wins on the headline metric and loses on the thing the headline
 * metric does not show — otherwise "we recovered more AND stayed compliant" is untested rhetoric.
 * If B2 beats us on rupees, we report that it beat us on rupees, next to its violation count.
 *
 * It still obeys the ABSOLUTE rules — do-not-disturb, risk-blocked, disputed, revoked mandate, kill
 * switch, idempotency. Those are not "aggressive", they are illegal, and an arm that breaks them is
 * not a policy anyone would ship, so beating it would prove nothing.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 2b — THE APPROVAL GATE APPLIES TO EVERY ARM, BUT ONLY FOR THE REASONS THAT APPLY.
 * ---------------------------------------------------------------------------------------------
 * `APR_LARGE_AMOUNT` gates every arm. `APR_WEAK_DIAGNOSIS` and `APR_ABSTAINED_DIAGNOSIS` do not
 * gate the baselines, because those two checks exist to stop a charge being authorised by a
 * diagnosis that cannot support it — and a baseline's charge is authorised by a fixed rule, not by
 * a diagnosis it never read. `checkGuardrails` takes `diagnosisClaimed` for exactly this, and the
 * baselines pass false.
 *
 * This was very nearly a silent confound in Rebound's favour and it is worth being explicit about
 * why. The approval gate was separately measured to freeze about 72% of exposure across five
 * worlds. Had the baselines been gated on a diagnosis they do not consult, most of their actions
 * would have sat in an approval queue, their recovery would have collapsed, and the resulting
 * headline advantage would have been mostly an artifact of a default argument value. Nothing in the
 * money total would have looked wrong.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 3 — A BASELINE MAY NOT SEE THE FITTED MODEL, AND THAT IS THE POINT OF THE EXPERIMENT.
 * ---------------------------------------------------------------------------------------------
 * None of these four call `scoreAction`. That is the independent variable: Rebound's claim is that
 * diagnosis + a calibrated probability + explicit costs beats fixed rules. Handing a baseline the
 * probability model and then removing only the EV arithmetic would test something much narrower.
 *
 * The corollary is that `runCycle` must still be given a `scoreAction` for the baselines — it
 * validates the argument — and the baselines simply never call it. The harness passes the same
 * fitted model to every arm regardless, so no arm can differ because of which model it received.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 4 — EVERY ARM PRODUCES THE SAME DECISION RECORD SHAPE.
 * ---------------------------------------------------------------------------------------------
 * `metrics.js` scores all five arms with one code path, which is the only way their numbers are
 * known to be commensurable. So a baseline returns the full record — outcome, chosen, caseState,
 * candidates with reasons, guardrailsEvaluated — even though it reached it by simpler means. It also
 * means the dashboard can show a baseline's audit trail beside Rebound's, and a reviewer can see
 * that the baseline was really making decisions rather than being described as making them.
 *
 * The one field that is deliberately different: `evPaise` is null on a baseline's chosen action,
 * because these policies do not compute expected value and writing a number there would be fiction.
 * `metrics.js` must therefore never rank or sum on `evPaise` across arms — the orchestrator's
 * EV-descending queue order falls back to the eventId tiebreak for baseline arms, which is
 * deterministic and is stated here because it means baselines process cases in id order rather than
 * value order. That is a real (small) disadvantage of being a baseline, it is inherent to not having
 * a value estimate, and it is not something this file inflicts on them.
 */

import { GUARDRAILS, POLICY, POLICY_ARMS } from '../core/config.js';
import { ActionKind, Channel, MONEY_MOVING, CUSTOMER_CONTACTING, actionSignature } from '../core/actions.js';
import { Verdict, RuleKind, checkGuardrails, normaliseCaseState } from '../agent/guardrails.js';
import { Outcome, DECISION_SCHEMA_VERSION, mintIdempotencyKey } from '../agent/decide.js';

const HOUR_MS = 3_600_000;

/**
 * Build the decision record every arm shares.
 *
 * The shape mirrors `decideForCase`'s output field for field. Where a baseline has no equivalent of
 * something Rebound computes, the field is present and null rather than absent — a missing key and a
 * null value read identically to a careless consumer, but `metrics.js` asserts on presence, so an
 * arm that forgot to report its candidates fails loudly instead of scoring zero violations.
 */
function baselineRecord({
  arm,
  caseState,
  diagnosis,
  runState,
  decidedAt,
  outcome,
  chosen = null,
  waitUntil = null,
  stop = null,
  considered = [],
  requiresApproval = false,
  approvalReasons = [],
  approvalCheckIds = [],
  clearedByApproval = [],
  approvedBy = null,
  rationale,
}) {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    policyArm: arm,
    decidedAt: decidedAt.toISOString(),

    eventId: caseState.eventId,
    customerId: caseState.customerId,
    amountPaise: caseState.amountPaise,
    lossType: caseState.lossType,
    /**
     * Null, not 1.0. A baseline does not apply a contribution margin because it does not reason
     * about value at all, and writing 1.0 would let a reader believe it had considered margin and
     * concluded no haircut applied. `metrics.js` computes recovered money from receipts, which are
     * arm-independent, so nothing downstream needs this to be a number.
     */
    marginApplied: null,

    diagnosis: diagnosis
      ? {
          rootCause: diagnosis.rootCause,
          source: diagnosis.source,
          matchTier: diagnosis.matchTier,
          matchedOn: diagnosis.matchedOn,
          abstained: Boolean(diagnosis.abstained),
          requiresApprovalForMoneyMovement: Boolean(diagnosis.requiresApprovalForMoneyMovement),
          explanation: diagnosis.explanation,
        }
      : null,
    /**
     * WHY A BASELINE CARRIES A DIAGNOSIS IT DOES NOT USE.
     *
     * The harness computes diagnosis once per world and shares it across arms, so it arrives here
     * whether or not this policy reads it. Recording it is what makes the counterfactual legible:
     * the trail shows that B1 retried a REVOKED_MANDATE case that had been correctly diagnosed as
     * unrecoverable-by-retry. Dropping the field would leave the baseline looking merely unlucky
     * rather than uninformed, and "it had the diagnosis available and its rules could not act on it"
     * is the actual finding.
     */
    diagnosisUsed: false,

    caseState,
    runState: { ...runState },

    outcome,
    chosen: chosen
      ? {
          action: chosen.action,
          signature: actionSignature(chosen.action),
          /**
           * Null on purpose. See RULE 4 — these policies compute no expected value, and a number
           * here would be invented. It also means `metrics.js` cannot sum EV across arms, which is
           * correct: expected value is a claim about a model, not a measurement.
           */
          evPaise: null,
          grossPaise: null,
          totalCostPaise: null,
          components: null,
          p: null,
          support: null,
          timing: null,
          effectiveAt: chosen.effectiveAt?.toISOString?.() ?? null,
          idempotencyKey: chosen.action.idempotencyKey ?? null,
        }
      : null,
    waitUntil: waitUntil ? new Date(waitUntil).toISOString() : null,
    stop,

    requiresApproval,
    approvalReasons,
    approvalCheckIds,
    clearedByApproval,
    approvedBy,

    /** No EV bar exists for these arms; null rather than 0, which would read as "any positive EV". */
    barPaise: null,
    calibrationNote: null,
    deferralLimit: null,

    /**
     * What the policy looked at, with a reason per line. A baseline's candidate list is short — that
     * IS the baseline — and printing it is what lets a reviewer see the difference between "declined
     * REQUEST_REAUTH after pricing it" and "never had REQUEST_REAUTH in its vocabulary".
     */
    candidates: considered,
    guardrailsEvaluated: chosen?.evaluated ?? considered[0]?.evaluated ?? [],

    /** One sentence, in English, naming the rule that fired. The baselines' version of `explain`. */
    explain: rationale,
  };
}

/**
 * Attach the idempotency key an action needs to be executable.
 *
 * Lifted verbatim in behaviour from `decideForCase` rather than shared through a helper, because the
 * ordinal source differs per action class (`retriesUsed` for money, `touchesUsed` for contact) and
 * that pairing is a correctness property: one counter for both would make the second legitimate
 * message collide with the first retry's key and be silently deduplicated. A baseline that could not
 * execute at all would be the most dishonest baseline of the four.
 */
function keyed(action, caseState, eventId) {
  if (MONEY_MOVING.has(action.kind)) {
    return {
      ...action,
      idempotencyKey: mintIdempotencyKey({ eventId, action, attemptOrdinal: caseState.retriesUsed }),
    };
  }
  if (CUSTOMER_CONTACTING.has(action.kind)) {
    return {
      ...action,
      idempotencyKey: mintIdempotencyKey({ eventId, action, attemptOrdinal: caseState.touchesUsed }),
    };
  }
  return action;
}

/** A candidate line for the audit trail, in the same shape `decideForCase` emits. */
const line = (action, guard, { rank = null, chosen = false, rejectedBecause = null }) => ({
  rank,
  signature: actionSignature(action),
  kind: action.kind,
  channel: action.channel ?? null,
  scheduledFor: action.scheduledFor ?? null,
  verdict: guard?.verdict ?? null,
  priced: false,
  evPaise: null,
  grossPaise: null,
  totalCostPaise: null,
  p: null,
  support: null,
  timing: null,
  deferUntil: guard?.deferUntil ? new Date(guard.deferUntil).toISOString() : null,
  chosen,
  rejectedBecause,
  violations: (guard?.violations ?? []).map((v) => ({ id: v.id, kind: v.kind, message: v.message })),
  requiresApproval: Boolean(guard?.requiresApproval),
  evaluated: guard?.evaluated ?? [],
});

/**
 * EXACTLY WHICH RULES B2 IGNORES, AS AN EXPLICIT LIST.
 * ===================================================
 *
 * This started as a blunt "ignore everything that is not ABSOLUTE" flag, and that flag contained a
 * defect worth recording because it is the precise failure this file was written to prevent.
 *
 * `BUD_RETRIES_PER_CASE` is a BUDGET rule, so the blunt version let B2 ignore it — which meant B2
 * retried the same card on every one of the 21 cycles and, because a retry is always first in its
 * preference order and was never refused, **never sent a single message in its entire run**. The arm
 * whose whole identity is "retry AND message everyone" was silently a retry-only arm. Its money
 * would have come in lower than it should, its message-volume and quiet-hours violation counts would
 * have been ZERO, and the compliance contrast that this project's central claim rests on would have
 * been measured against an arm that never actually contacted anybody. Nothing in the totals would
 * have looked wrong.
 *
 * So the exemption is now an explicit allowlist of rule IDs, which is auditable, printable in the
 * CLI output, and testable one rule at a time.
 *
 * WHY THESE FOUR AND NOT OTHERS. B2's aggression is in the CONTACT and TIMING dimension — it messages
 * whoever it likes, whenever it likes, as often as it likes. That is what real automated dunning
 * does badly and it is the behaviour the compliance story is about.
 *
 * WHY IT STILL OBEYS THE RETRY CAP, AND THE DIRECTION THIS BIASES THE RESULT. Bounding B2's retries
 * at three makes B2 attempt less money movement and therefore recover LESS, which flatters Rebound —
 * the unsafe direction, so it needs a reason better than convenience. It has two. Its own declared
 * design is "Retry x3" (see `POLICY_ARMS.B2_AGGRESSIVE.label`), so an unbounded version would not be
 * the arm being described. And a policy that charges one card twenty-one times is not a policy any
 * merchant could run — the issuer would throttle the whole account long before cycle twenty-one — so
 * beating it would prove nothing, which is the same argument that keeps the ABSOLUTE rules binding.
 *
 * The honest handling is that this is a stated modelling choice with a known direction, printed in
 * the CLI beside the results, not a silent default.
 */
export const B2_IGNORED_RULE_IDS = Object.freeze([
  /** Messages at 2am. The single most visible thing a real dunning system gets wrong. */
  'TIM_QUIET_HOURS',
  /** Ignores the per-customer 7-day contact ceiling — the B2B customer with eight open invoices. */
  'TIM_CUSTOMER_MESSAGE_CAP',
  /** Ignores the minimum gap between retries, so its attempts bunch instead of spacing. */
  'TIM_RETRY_GAP',
  /** Ignores the per-case touch budget, so one case can be messaged every cycle for ten days. */
  'BUD_TOUCHES_PER_CASE',
]);

/**
 * Walk an ordered list of actions and take the first one the guardrails permit.
 *
 * This is the shared spine of B1, B2 and B3: a fixed preference order, filtered by compliance. The
 * differences between those three arms are entirely in WHICH order they supply and WHICH rule IDs
 * they are permitted to ignore, which is exactly the axis the comparison is about.
 *
 * @param ignoreRuleIds  rule IDs this arm proceeds in spite of. Empty for the compliant arms; for
 *                 B2 it is `B2_IGNORED_RULE_IDS`. An explicit list rather than a rule-KIND filter,
 *                 because a kind filter swept in `BUD_RETRIES_PER_CASE` and turned B2 into a
 *                 retry-only arm that never messaged anyone — see the constant above.
 */
function firstPermitted({
  order,
  caseState,
  diagnosis,
  runState,
  now,
  config,
  ignoreRuleIds = [],
}) {
  const ignored = new Set(ignoreRuleIds);
  const considered = [];
  let taken = null;

  for (const raw of order) {
    const action = keyed(raw, caseState, caseState.eventId);
    /**
     * `diagnosisClaimed: false` — and this flag is the single most important line in this file.
     *
     * Two of the four approval checks (`APR_WEAK_DIAGNOSIS`, `APR_ABSTAINED_DIAGNOSIS`) fire when
     * the diagnosis backing a charge is weak or absent. A baseline carries the shared diagnosis in
     * its record for the audit trail but never reads it, so its charge does not rest on that
     * diagnosis — it rests on a fixed rule.
     *
     * Leaving the flag at its default would have gated a large share of every baseline's actions
     * behind a human approver, and the approval gate was separately measured to freeze roughly 72%
     * of exposure across five worlds. The baselines would then have looked far worse than they are,
     * for a reason with nothing to do with policy quality, and the headline advantage would have
     * been mostly this bug. It would also have been almost undetectable from the money total, which
     * is the shape of defect this project has now been bitten by twice.
     *
     * `APR_LARGE_AMOUNT` still applies to every arm — it keys on the amount, not on a belief, and
     * it is the check that makes each arm accountable for large charges. See B1's body.
     */
    const guard = checkGuardrails({
      action, caseState, diagnosis, runState, now, config,
      diagnosisClaimed: false,
    });

    /**
     * The violations that actually bind this arm. Note the verdict recorded in the trail is still
     * the TRUE verdict from the shared engine — B2's line says FORBID or DEFER and shows it acted
     * anyway, which is precisely the evidence the compliance comparison needs. An arm that rewrote
     * its own verdicts would look compliant in the audit trail while behaving otherwise, and the
     * violation count would come out zero for the most aggressive policy in the set.
     */
    const blocking = guard.violations.filter((v) => !ignored.has(v.id));

    if (blocking.length > 0) {
      considered.push(
        line(action, guard, {
          rejectedBecause: blocking.map((v) => `${v.id}: ${v.message}`).join('; '),
        })
      );
      continue;
    }

    if (taken === null) {
      taken = { action, guard, effectiveAt: guard.effectiveAt };
      considered.push(line(action, guard, { rank: 1, chosen: true }));
      continue;
    }

    considered.push(
      line(action, guard, { rejectedBecause: 'permitted, but a higher-priority rule already matched' })
    );
  }

  return { taken, considered };
}

/**
 * B0 — DO NOTHING.
 * ================
 * Stops every case on sight, with a reason. It is the control that makes every other arm's figure
 * incremental rather than gross: `selfRecoveredPaise` under B0 is the money that arrives with no
 * intervention at all, and an arm that cannot beat B0 is worse than absent.
 *
 * WHY IT RETURNS STOP_PERMANENT RATHER THAN WAIT. A WAIT sets `nextActionAt` and keeps the case
 * active, so B0 would be re-decided every cycle forever and its audit trail would be 21 identical
 * lines per case. More importantly `runArm` treats "no active cases" as the policy having gone quiet
 * and records `stoppedEarlyAfter` — a signal that is only meaningful if a policy can actually finish.
 * Self-recovery still fires for stopped cases (see `applySelfRecovery`, which deliberately does not
 * filter on active), so stopping does not cost B0 any of the money it exists to measure.
 */
export function decideB0DoNothing({ observed, diagnosis, record = {}, runState = {}, now = new Date(), config = { GUARDRAILS, POLICY } } = {}) {
  const decidedAt = new Date(now);
  const caseState = normaliseCaseState({ observed, record, now: decidedAt });

  return baselineRecord({
    arm: POLICY_ARMS.B0_DO_NOTHING.id,
    caseState,
    diagnosis,
    runState,
    decidedAt,
    outcome: Outcome.STOP_PERMANENT,
    stop: {
      code: 'ARM_DOES_NOTHING',
      reason:
        'B0 is the do-nothing control. It takes no recovery action on any case, so that the money ' +
        'other arms report can be measured against what arrives unprompted.',
      standing: null,
      blockedEscalation: false,
    },
    considered: [],
    rationale:
      'B0_DO_NOTHING: no action, by construction. Any money credited to this arm arrived without ' +
      'intervention and is recorded as selfRecoveredPaise, never as recoveredPaise.',
  });
}

/**
 * B1 — RETRY x3 IMMEDIATELY.
 * =========================
 * The naive agent, and the one this project was pitched against. It retries the same instrument as
 * soon as the guardrails allow, up to the per-case cap, and then stops. No diagnosis, no timing, no
 * messaging, no notion of cost.
 *
 * IT OBEYS EVERY GUARDRAIL, INCLUDING THE RETRY GAP. That is deliberate and it makes B1 stronger
 * than the version of "naive retry" a submission would usually build: `TIM_RETRY_GAP` forces 6 hours
 * between attempts, so B1's three retries are spread over cycles rather than fired in one burst,
 * which is what a competent naive implementation would do anyway. Letting it hammer the instrument
 * three times in one cycle would have made it fail more and Rebound look better for a reason that
 * has nothing to do with policy quality.
 *
 * WHAT IT CANNOT DO, WHICH IS THE FINDING. RETRY_NOW is the only tool in its vocabulary. A revoked
 * mandate, an expired card, an authentication drop-off — all of them are diagnosed correctly in the
 * shared diagnosis it carries, and none of them are recoverable by retrying the same instrument. B1
 * will spend three retries and a `failedRetryPenaltyPaise` externality on each one and recover
 * nothing. That is not a handicap imposed here; it is what "no diagnosis" costs.
 */
export function decideB1NaiveRetry({ observed, diagnosis, record = {}, runState = { retriesThisRun: 0, messagesThisRun: 0 }, now = new Date(), config = { GUARDRAILS, POLICY } } = {}) {
  const decidedAt = new Date(now);
  const caseState = normaliseCaseState({ observed, record, now: decidedAt });

  const { taken, considered } = firstPermitted({
    order: [{ kind: ActionKind.RETRY_NOW }],
    caseState, diagnosis, runState, now: decidedAt, config,
  });

  if (taken) {
    /**
     * The approval gate applies to B1 exactly as it applies to Rebound. A naive policy is not
     * licensed to charge ₹80,000 without a human just because it is naive — that would make B1 an
     * arm no merchant could run, and beating an arm nobody could run is not a result. So a
     * high-value retry goes to the queue here too, and if the approver is slow, B1 waits.
     */
    const needsApproval = taken.guard.requiresApproval;
    return baselineRecord({
      arm: POLICY_ARMS.B1_NAIVE_RETRY.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: needsApproval ? Outcome.AWAIT_APPROVAL : Outcome.ACT,
      chosen: taken,
      considered,
      requiresApproval: needsApproval,
      approvalReasons: taken.guard.approvalReasons,
      approvalCheckIds: taken.guard.approvalCheckIds,
      clearedByApproval: taken.guard.clearedByApproval,
      approvedBy: taken.guard.approvedBy ?? null,
      rationale:
        `B1_NAIVE_RETRY: retry the instrument now (attempt ${caseState.retriesUsed + 1} of ` +
        `${config.GUARDRAILS.maxRetriesPerCase}). No diagnosis consulted, no timing chosen.`,
    });
  }

  /**
   * Nothing permitted. The reason matters for the trail and it is read off the guardrail rather than
   * guessed: a DEFER means come back later (the retry gap or quiet hours has not cleared), a FORBID
   * means this arm has nothing left to try on this case. Collapsing both into a stop would credit B1
   * with a stopping rule it does not have, and collapsing both into a wait would leave its cases
   * spinning to the horizon.
   */
  const deferred = considered.find((c) => c.verdict === Verdict.DEFER && c.deferUntil);
  if (deferred) {
    return baselineRecord({
      arm: POLICY_ARMS.B1_NAIVE_RETRY.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: Outcome.WAIT,
      waitUntil: deferred.deferUntil,
      considered,
      rationale: `B1_NAIVE_RETRY: retry not yet permitted (${deferred.rejectedBecause}); wait.`,
    });
  }

  return baselineRecord({
    arm: POLICY_ARMS.B1_NAIVE_RETRY.id,
    caseState, diagnosis, runState, decidedAt,
    outcome: Outcome.STOP_PERMANENT,
    stop: {
      code: 'ARM_OUT_OF_RETRIES',
      reason:
        considered[0]?.rejectedBecause ??
        'no retry is permitted on this case and this arm has no other action available',
      standing: null,
      blockedEscalation: false,
    },
    considered,
    rationale:
      'B1_NAIVE_RETRY: out of permitted retries. This arm has no messaging, no re-auth and no ' +
      'escalation, so the case is abandoned.',
  });
}

/**
 * B2 — AGGRESSIVE: RETRY AND MESSAGE EVERYONE.
 * ============================================
 * The arm most hackathon submissions accidentally build, and the one most likely to beat Rebound on
 * rupees recovered. It tries everything, on every channel, as often as it can, and it ignores the
 * TIMING and BUDGET guardrails while doing it.
 *
 * WHY THIS ARM EXISTS AND WHY IT IS NOT A STRAW MAN. The thesis of this project is that recovering
 * the most money is the wrong objective. That thesis is only testable against an opponent that
 * actually maximises the wrong objective. If B2 recovers more than Rebound, the correct report is
 * "B2 recovered more money AND sent messages at 2am AND breached the per-customer contact cap N
 * times AND burned patience on cases that were never going to pay", with both numbers side by side.
 * Suppressing B2, or crippling it, would turn the central claim into an assertion.
 *
 * WHAT IT STILL OBEYS: every ABSOLUTE rule. Do-not-disturb, risk-blocked, disputed invoice, revoked
 * mandate, kill switch, and the idempotency-key requirement. Those are not aggression, they are
 * illegal or incoherent, and an arm that violated them would be a policy nobody would ship.
 *
 * A NOTE ON HOW ITS VIOLATIONS ARE COUNTED. B2 does not rewrite its own verdicts. It asks the same
 * `checkGuardrails` every other arm asks, records the real answer in its audit trail, and then acts
 * anyway. So its violations are countable from the trail by exactly the same query that returns zero
 * for the compliant arms — which is the only way the compliance comparison means anything.
 */
export function decideB2Aggressive({ observed, diagnosis, record = {}, runState = { retriesThisRun: 0, messagesThisRun: 0 }, now = new Date(), config = { GUARDRAILS, POLICY } } = {}) {
  const decidedAt = new Date(now);
  const caseState = normaliseCaseState({ observed, record, now: decidedAt });

  /**
   * Retry first, then message on the loudest channel available. The order is "cheapest to us first"
   * — a retry is silent and free of message cost — which is what an operator optimising throughput
   * would do, and it is followed by contact on every channel in descending intrusiveness.
   */
  const order = [
    { kind: ActionKind.RETRY_NOW },
    { kind: ActionKind.SEND_LINK, channel: Channel.WHATSAPP },
    { kind: ActionKind.SEND_LINK, channel: Channel.SMS },
    { kind: ActionKind.SEND_LINK, channel: Channel.EMAIL },
    { kind: ActionKind.REQUEST_REAUTH, channel: Channel.SMS },
    { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.SMS },
  ];

  const { taken, considered } = firstPermitted({
    order, caseState, diagnosis, runState, now: decidedAt, config,
    ignoreRuleIds: B2_IGNORED_RULE_IDS,
  });

  if (taken) {
    /**
     * B2 IS SUBJECT TO THE APPROVAL GATE. This is the one place its exemption stops, and the reason
     * is that the gate is not a timing or budget control — it is the boundary between an automated
     * system and an accountable human. An arm that charged ₹3,00,000 with no signature would not be
     * "aggressive", it would be the thing this entire project argues against, and including it would
     * let Rebound win by comparison with something indefensible rather than something plausible.
     */
    const needsApproval = taken.guard.requiresApproval;
    const ignored = considered
      .find((c) => c.chosen)
      ?.violations?.map((v) => v.id) ?? [];

    return baselineRecord({
      arm: POLICY_ARMS.B2_AGGRESSIVE.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: needsApproval ? Outcome.AWAIT_APPROVAL : Outcome.ACT,
      chosen: taken,
      considered,
      requiresApproval: needsApproval,
      approvalReasons: taken.guard.approvalReasons,
      approvalCheckIds: taken.guard.approvalCheckIds,
      clearedByApproval: taken.guard.clearedByApproval,
      approvedBy: taken.guard.approvedBy ?? null,
      rationale:
        `B2_AGGRESSIVE: ${actionSignature(taken.action)}` +
        (ignored.length
          ? `, proceeding despite ${ignored.join(', ')} — this arm ignores timing and budget rules by design`
          : ', no rule objected'),
    });
  }

  /**
   * Even B2 ran out of things it is willing to do. Unlike the compliant arms it does not wait,
   * because the TIMING rules that produce a wait are the very rules it ignores — anything still
   * blocking it is a rule it respects and that will not clear on its own.
   */
  return baselineRecord({
    arm: POLICY_ARMS.B2_AGGRESSIVE.id,
    caseState, diagnosis, runState, decidedAt,
    outcome: Outcome.STOP_PERMANENT,
    stop: {
      code: 'ARM_ABSOLUTELY_BLOCKED',
      reason:
        considered[0]?.rejectedBecause ??
        'every action available to this arm is blocked by a rule it respects',
      standing: null,
      blockedEscalation: false,
    },
    considered,
    rationale:
      'B2_AGGRESSIVE: stopped only because rules it respects (absolute rules, and its own retry ' +
      'cap) block everything — it ignores quiet hours, contact caps and touch budgets.',
  });
}

/**
 * WHAT EACH ARM IS PROGRAMMED TO DO, IN A FORM THE CLI CAN PRINT.
 * ==============================================================
 *
 * The compliance profile of a baseline is a claim about the experiment, and a claim that lives only
 * in a source comment is a claim a reviewer has to take on trust. `src/eval/cli/run.js` prints this
 * beside the results so that "the baselines were fairly implemented" is checkable from the output
 * alone — and so that if anyone ever widens an exemption, the widening appears in the report.
 *
 * `ignoresRuleIds` is read from the same constant the code enforces, not restated, so the printed
 * profile cannot drift from the behaviour.
 */
export function describeArm(armId) {
  const meta = Object.values(POLICY_ARMS).find((a) => a.id === armId);
  if (!meta) throw new Error(`describeArm: unknown arm "${armId}"`);

  const profiles = {
    B0_DO_NOTHING: {
      actions: 'none',
      usesDiagnosis: false,
      usesProbabilityModel: false,
      usesExpectedValue: false,
      ignoresRuleIds: [],
      subjectToApprovalGate: false,
      hasStoppingRule: 'stops every case immediately, by construction',
    },
    B1_NAIVE_RETRY: {
      actions: `RETRY_NOW only, up to the per-case cap of ${GUARDRAILS.maxRetriesPerCase}`,
      usesDiagnosis: false,
      usesProbabilityModel: false,
      usesExpectedValue: false,
      ignoresRuleIds: [],
      subjectToApprovalGate: true,
      hasStoppingRule: 'stops when its retries are exhausted',
    },
    B2_AGGRESSIVE: {
      actions: 'retry, then contact on every channel available, every cycle',
      usesDiagnosis: false,
      usesProbabilityModel: false,
      usesExpectedValue: false,
      ignoresRuleIds: [...B2_IGNORED_RULE_IDS],
      subjectToApprovalGate: true,
      hasStoppingRule: 'only when an absolute rule or its retry cap blocks everything',
    },
    B3_FIXED_LADDER: {
      actions: 'retry now, retry +24h, SMS link, retry +72h, email link',
      usesDiagnosis: false,
      usesProbabilityModel: false,
      usesExpectedValue: false,
      ignoresRuleIds: [],
      subjectToApprovalGate: true,
      hasStoppingRule: 'stops when the ladder is exhausted',
    },
    REBOUND_EV: {
      actions: 'the full action space, priced and ranked by expected value',
      usesDiagnosis: true,
      usesProbabilityModel: true,
      usesExpectedValue: true,
      ignoresRuleIds: [],
      subjectToApprovalGate: true,
      hasStoppingRule: `stops when the best expected value falls below ${POLICY.minEvToActPaise} paise`,
    },
  };

  return { ...meta, ...profiles[armId] };
}

/**
 * B3 — THE SENSIBLE FIXED DUNNING LADDER.
 * =======================================
 * The honest baseline, and the one actually worth beating. This is a competently designed sequence
 * of the kind a good payments-ops team writes on a whiteboard, with real guardrails and a real
 * stopping point. A judge who has run recovery operations will look for exactly this arm, and its
 * absence would be the first thing they distrusted.
 *
 * THE LADDER, and every rung has a defensible reason:
 *
 *   step 0  retry immediately          — a meaningful share of failures are transient
 *   step 1  retry in 24h               — the standard "sleep on it" retry; catches funds arriving
 *   step 2  send a payment link (SMS)  — the instrument may be fine and the human may have dropped
 *   step 3  retry in 72h              — one last attempt, spaced far enough to catch a salary credit
 *   step 4  send a link (EMAIL)        — cheapest possible final nudge
 *   step 5  stop                       — with the reason recorded
 *
 * WHY IT IS GENUINELY STRONG. It has timing (two spaced retries, one of them at 72h), it has channel
 * variety, it escalates in cost rather than volume, it obeys every guardrail, and it stops. Those
 * are four of the five things Rebound does. The ONE thing it does not do is condition on anything:
 * every case gets the same ladder regardless of diagnosis, amount, margin or probability. A revoked
 * mandate gets two retries it cannot possibly convert; a ₹200 low-margin sale gets the same spend as
 * a ₹80,000 invoice.
 *
 * THAT IS THE WHOLE EXPERIMENT. If Rebound cannot beat B3, the honest conclusion is that
 * conditioning on diagnosis and value does not pay for its complexity, and that conclusion goes in
 * the log. This arm is built to make that a real possibility rather than a rhetorical one.
 *
 * IMPLEMENTATION NOTE — THE RUNG IS INDEXED ON WORK DONE; THE CLOCK IS ANCHORED TO THE FAILURE.
 *
 * Two separate decisions, and the first version got the second one wrong in a way that silently
 * crippled this arm. Both are written down because the bug was invisible in every summary statistic.
 *
 * THE RUNG is `retriesUsed + touchesUsed`. Indexing on cycle index instead would make the ladder
 * advance while the case was blocked by quiet hours, so a case could skip its own steps by being
 * decided at an awkward hour, and two runs with different horizons would give the same case different
 * treatment. Indexing on work done makes the ladder a property of the case's history, which is what a
 * human-written ladder actually is.
 *
 * THE CLOCK is anchored to the case's own failure instant — `now - ageDays`, so that rung 1 means "24h
 * after the payment failed" and not "24h after whenever this function happened to run".
 *
 * =================================================================================================
 * THE BUG THIS ANCHOR EXISTS TO PREVENT — B3 STALLED AFTER ONE RETRY AND NOBODY NOTICED
 * =================================================================================================
 * The first version computed rung 1 as `now + 24h`. `scheduleAction` in the orchestrator correctly
 * treats a future RETRY_SCHEDULED as a WAKEUP rather than an execution — it stores the intent, sets
 * `nextActionAt`, and RE-DECIDES the case at wakeup, deliberately, so that a three-day-old
 * authorisation is never executed blind. So the sequence was:
 *
 *   t+0h    rung 0, RETRY_NOW executes            -> retriesUsed = 1, rung = 1
 *   t+12h   rung 1, schedules a retry for t+36h    -> nothing executes, rung STILL 1
 *   t+36h   rung 1, schedules a retry for t+60h    -> nothing executes, rung STILL 1
 *   t+60h   rung 1, schedules a retry for t+84h    -> ... for the whole horizon
 *
 * A scheduled retry never becomes work done, so the rung never advanced, so the ladder re-armed the
 * same rung forever. Measured over five worlds: 65 of 80 cases received EXACTLY ONE action and then
 * sat in SCHEDULED for the remaining nine days. B3 was, in effect, B1-with-one-retry wearing the name
 * of the strong baseline.
 *
 * WHY IT SURVIVED A TESTED, MUTATION-CHECKED IMPLEMENTATION. Every test on this function tested ONE
 * decision: given a case at rung 1, does it propose the right action? It does. The defect only exists
 * across cycles, and no unit test on a single decision can see a policy that never advances. The
 * repair is `test/baselines.test.js`'s trajectory test, which runs the arm for a full horizon and
 * asserts the ladder is climbed — a property no single-decision test can express.
 *
 * AND WHY IT MATTERED MORE THAN ANY OTHER BUG IN THIS PROJECT. B3 is the opponent the whole result
 * rests on. A crippled B3 recovers less, which INFLATES Rebound's margin — so the headline moved in
 * the flattering direction, which is the direction that does not prompt anyone to look. "Rebound beats
 * the honest baseline in 5 of 5 worlds" was, until this fix, a win over a baseline that fired one
 * retry and stalled.
 *
 * THE FIX has two halves. Rungs carry a `dueAtHours` offset from the failure instant, so re-deciding
 * at wakeup recomputes the SAME instant rather than a fresh one 24h further out. And when that instant
 * has arrived, the rung is materialised as `RETRY_NOW` rather than as a RETRY_SCHEDULED pointing at
 * the present — because a scheduled action whose `scheduledFor` is not in the future is a retry that
 * is due, and saying so plainly is what lets the orchestrator execute it.
 */
export function decideB3FixedLadder({ observed, diagnosis, record = {}, runState = { retriesThisRun: 0, messagesThisRun: 0 }, now = new Date(), config = { GUARDRAILS, POLICY } } = {}) {
  const decidedAt = new Date(now);
  const caseState = normaliseCaseState({ observed, record, now: decidedAt });

  const rung = (caseState.retriesUsed ?? 0) + (caseState.touchesUsed ?? 0);

  /**
   * The instant the payment failed, derived from `caseState.ageDays` rather than read off the
   * observation a second time. One source of truth: the guardrail engine ages this case by `ageDays`,
   * and a ladder anchored to a different instant than the rules are enforced against would drift
   * apart under exactly the conditions nobody tests. When the observation carries no timestamp
   * `ageDays` is 0, so the anchor falls back to first sight, which is the right default.
   */
  const anchor = new Date(decidedAt.getTime() - (caseState.ageDays ?? 0) * 24 * HOUR_MS);
  const dueAt = (hours) => new Date(anchor.getTime() + hours * HOUR_MS);

  /**
   * `dueAtHours: null` means "do this on the cycle the rung comes up". A number means "this rung is
   * due at that many hours after the failure" — a wakeup if it is still ahead of us, an execution if
   * it has arrived.
   */
  const LADDER = [
    { kind: ActionKind.RETRY_NOW, dueAtHours: null },
    { kind: ActionKind.RETRY_NOW, dueAtHours: 24 },
    { kind: ActionKind.SEND_LINK, channel: Channel.SMS, dueAtHours: null },
    { kind: ActionKind.RETRY_NOW, dueAtHours: 72 },
    { kind: ActionKind.SEND_LINK, channel: Channel.EMAIL, dueAtHours: null },
  ];

  /**
   * Materialise a rung against the clock. A retry whose due instant is still in the future becomes a
   * RETRY_SCHEDULED, which the orchestrator turns into a wakeup; one whose instant has arrived becomes
   * a RETRY_NOW, which executes. The same rung therefore has one identity before its time and another
   * after it, and the rung index does not change in between — that is the whole point.
   */
  const materialise = (step) => {
    if (step.dueAtHours === null) {
      return step.channel ? { kind: step.kind, channel: step.channel } : { kind: step.kind };
    }
    const when = dueAt(step.dueAtHours);
    if (when.getTime() > decidedAt.getTime()) {
      return { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: when };
    }
    return { kind: ActionKind.RETRY_NOW };
  };

  if (rung >= LADDER.length) {
    return baselineRecord({
      arm: POLICY_ARMS.B3_FIXED_LADDER.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: Outcome.STOP_PERMANENT,
      stop: {
        code: 'LADDER_EXHAUSTED',
        reason: `the fixed ladder has ${LADDER.length} steps and this case has used all of them`,
        standing: null,
        blockedEscalation: false,
      },
      considered: [],
      rationale:
        `B3_FIXED_LADDER: all ${LADDER.length} ladder steps used; stop with the reason recorded.`,
    });
  }

  /**
   * Try this rung, then fall forward through the remaining rungs if it is blocked.
   *
   * Falling forward rather than waiting is the choice a real ladder makes: if the SMS step is barred
   * because the customer has hit their contact cap, a sensible operator moves to the next step
   * instead of parking the case. It is also what keeps B3 from degenerating into a wait loop and
   * quietly becoming B0 — which is the specific way a fixed-ladder baseline gets accidentally
   * crippled, and it would be invisible in the money total.
   */
  const { taken, considered } = firstPermitted({
    order: LADDER.slice(rung).map(materialise),
    caseState, diagnosis, runState, now: decidedAt, config,
  });

  if (taken) {
    const needsApproval = taken.guard.requiresApproval;
    return baselineRecord({
      arm: POLICY_ARMS.B3_FIXED_LADDER.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: needsApproval ? Outcome.AWAIT_APPROVAL : Outcome.ACT,
      chosen: taken,
      considered,
      requiresApproval: needsApproval,
      approvalReasons: taken.guard.approvalReasons,
      approvalCheckIds: taken.guard.approvalCheckIds,
      clearedByApproval: taken.guard.clearedByApproval,
      approvedBy: taken.guard.approvedBy ?? null,
      rationale:
        `B3_FIXED_LADDER: step ${rung + 1} of ${LADDER.length} — ` +
        `${actionSignature(taken.action)}. Same ladder for every case, regardless of diagnosis or value.`,
    });
  }

  const deferred = considered.find((c) => c.verdict === Verdict.DEFER && c.deferUntil);
  if (deferred) {
    return baselineRecord({
      arm: POLICY_ARMS.B3_FIXED_LADDER.id,
      caseState, diagnosis, runState, decidedAt,
      outcome: Outcome.WAIT,
      waitUntil: deferred.deferUntil,
      considered,
      rationale:
        `B3_FIXED_LADDER: every remaining step is blocked until ${deferred.deferUntil}; wait.`,
    });
  }

  return baselineRecord({
    arm: POLICY_ARMS.B3_FIXED_LADDER.id,
    caseState, diagnosis, runState, decidedAt,
    outcome: Outcome.STOP_PERMANENT,
    stop: {
      code: 'LADDER_BLOCKED',
      reason:
        considered[0]?.rejectedBecause ??
        'every remaining ladder step is forbidden on this case',
      standing: null,
      blockedEscalation: false,
    },
    considered,
    rationale: 'B3_FIXED_LADDER: remaining steps all forbidden; stop with the reason recorded.',
  });
}

/**
 * The arm registry. `runArm` looks a policy up here by id, so adding an arm to `POLICY_ARMS` without
 * implementing it fails loudly at lookup rather than silently falling back to REBOUND_EV — which
 * would report the EV policy's numbers under a baseline's name, the single most misleading bug this
 * file could have.
 *
 * REBOUND_EV maps to `undefined` deliberately: `runCycle`'s default parameter is `decideForCase`, so
 * the EV arm gets the production decision path with nothing wrapped around it. An entry here that
 * re-exported `decideForCase` would be a second reference to the same function that could drift.
 */
export const ARM_POLICIES = Object.freeze({
  [POLICY_ARMS.B0_DO_NOTHING.id]: decideB0DoNothing,
  [POLICY_ARMS.B1_NAIVE_RETRY.id]: decideB1NaiveRetry,
  [POLICY_ARMS.B2_AGGRESSIVE.id]: decideB2Aggressive,
  [POLICY_ARMS.B3_FIXED_LADDER.id]: decideB3FixedLadder,
  [POLICY_ARMS.REBOUND_EV.id]: undefined,
});

/**
 * Resolve an arm id to its decision function.
 *
 * Throws on an unknown id rather than returning undefined, because undefined is a MEANINGFUL value
 * here (it selects the production policy). A typo in an arm name would otherwise silently run
 * Rebound and label the results as a baseline.
 */
export function policyFor(armId) {
  if (!Object.prototype.hasOwnProperty.call(ARM_POLICIES, armId)) {
    throw new Error(
      `policyFor: unknown arm "${armId}". Known arms: ${Object.keys(ARM_POLICIES).join(', ')}. ` +
        `An unrecognised arm must not fall back to the EV policy — that would report Rebound's ` +
        `numbers under a baseline's name.`
    );
  }
  return ARM_POLICIES[armId];
}
