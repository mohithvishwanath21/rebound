/**
 * STOPPING RULES
 * ==============
 *
 * When to give up on a case, and — separately — whether we are entitled to give up at all.
 *
 * WHY THIS IS NOT PART OF `decide.js`
 * -----------------------------------
 * Selection and stopping consume the same probability and need completely different things
 * from it, and the difference is measured rather than asserted:
 *
 *   SELECTION needs ORDERING. It asks which action is best. Adding 0.1 to every candidate's
 *   probability changes no argmax. `model-report` observes exactly this — a shared shift moves
 *   all candidates for a case together and leaves the choice untouched.
 *
 *   STOPPING needs a LEVEL. It asks whether the best action clears its cost. An arm that
 *   ranks perfectly but reads 0.30 when the truth is 0.10 will chase cases it should abandon,
 *   and its regret on action choice will look excellent the whole time.
 *
 * A single "policy" module blurs this, and the blur has a direction: the ordering metric is
 * the one that looks good, so a combined module gets judged by it. Splitting the files forces
 * the calibration question to be asked out loud — which is why Platt scaling exists in this
 * project at all, and why `CALIBRATION_NOTE` below travels with every stop decision.
 *
 * THE ASYMMETRY THAT COST ME THE MOST TO FIND
 * -------------------------------------------
 * `lookupTable.predictRow` returns the global base rate for a cell it has never seen. That
 * value is numerically indistinguishable from an estimate backed by a thousand rows. Both
 * arrive as, say, 0.11.
 *
 * So on probability alone these two cases are the same case:
 *
 *   "I have seen four hundred expired-card retries and eleven percent recovered."
 *   "I have never seen this combination and eleven percent is the average of everything."
 *
 * The first is a finding. The second is an absence of evidence wearing a finding's clothes.
 * Stopping on the first is correct. Stopping on the second closes a case nobody ever looked
 * at, permanently, and the audit trail records a confident-looking number as the reason.
 *
 * The sweep measured 0.00% fallback on this generator, so the hazard is currently latent here
 * — every cell is populated. It would fire constantly on real data, where the cause-by-action
 * grid is sparse. A rule that is dormant on the simulator and load-bearing in production is
 * exactly the rule to write before the simulator is the only thing that has ever run.
 *
 * Hence: an unsupported belief cannot produce STOP_PERMANENT. It produces escalation, which
 * costs ₹60 of analyst time and is the correct price to pay for finding out.
 *
 * THREE OUTCOMES, NOT TWO
 * -----------------------
 *   CONTINUE          some action clears the bar; act on it.
 *   STOP_PERMANENT    the best action is below the bar AND we have grounds to believe it.
 *   ESCALATE_HUMAN    the best action is below the bar and we do NOT have grounds — no
 *                     support, an abstained diagnosis, or a large amount.
 *
 * Collapsing the third into the second is what makes an agent look decisive and lose money
 * quietly.
 */

import { GUARDRAILS, POLICY, COSTS } from '../core/config.js';
import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING } from '../core/actions.js';
import { actionThresholdPaise, marginFor } from './expectedValue.js';

/**
 * The actions that could actually recover money. NO_ACTION_YET, STOP_PERMANENT and
 * ESCALATE_HUMAN are excluded, and excluding them is load-bearing rather than tidy — see
 * `diagnoseStopReason`.
 */
const RECOVERING_KINDS = new Set([...MONEY_MOVING, ...CUSTOMER_CONTACTING]);

export const StopReason = Object.freeze({
  /** Best available action does not clear its own cost, on evidence we trust. */
  NEGATIVE_EV: 'NEGATIVE_EV',
  /** No action survived the guardrails, and none of the blocks was a timing block. */
  NO_PERMITTED_ACTION: 'NO_PERMITTED_ACTION',
  /** Retry and touch budgets are both spent. */
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  /** Past the age at which chasing is worth the operational noise. */
  TOO_OLD: 'TOO_OLD',
  /** The taxonomy says a human owns this class of case. */
  HUMAN_ONLY_CAUSE: 'HUMAN_ONLY_CAUSE',
  /**
   * CLOSED WITHOUT ESTABLISHING THAT IT WAS HOPELESS.
   *
   * We lacked the standing to close this case on the evidence, and the case is too small for a
   * ₹60 human review to make sense even if the human recovered every rupee. So it is closed
   * anyway — and it gets its own code, because that is a materially weaker claim than
   * NEGATIVE_EV and must not be reported as though it were the same thing.
   *
   * This is the honest form of a real limitation. Pretending these were confident closures
   * would inflate every "correctly abandoned" statistic in the eval, and a judge who asked
   * "how do you know?" would get a wrong answer. Reported separately, the line reads: N cases
   * worth ₹X were closed unreviewed because reviewing them costs more than they are worth.
   */
  UNREVIEWED_TOO_SMALL: 'UNREVIEWED_TOO_SMALL',
});

export const Disposition = Object.freeze({
  CONTINUE: 'CONTINUE',
  STOP_PERMANENT: 'STOP_PERMANENT',
  ESCALATE_HUMAN: 'ESCALATE_HUMAN',
  WAIT: 'WAIT',
});

/**
 * Support states for a probability estimate.
 *
 * SUPPORTED  enough rows behind this estimate to treat it as a finding.
 * THIN       the cell exists but is under the minimum count; the estimate is a fallback.
 * UNSEEN     the cell has never been observed. The number is the global base rate.
 * UNKNOWN    the arm does not report support at all.
 *
 * UNKNOWN is not folded into SUPPORTED. An arm that cannot say how much evidence it has is
 * not thereby well-evidenced, and defaulting the other way would let any future arm silently
 * disable this entire module by omitting one field.
 */
export const Support = Object.freeze({
  SUPPORTED: 'SUPPORTED',
  THIN: 'THIN',
  UNSEEN: 'UNSEEN',
  UNKNOWN: 'UNKNOWN',
});

export const TRUSTED_SUPPORT = Object.freeze([Support.SUPPORTED]);

/**
 * STOPS THAT REST ON POLICY RATHER THAN ON A PROBABILITY.
 *
 * `mayStopPermanently` exists because a stop justified by a *probability* can be resting on
 * absent evidence. Two of the stop reasons are not justified by a probability at all:
 *
 *   BUDGET_EXHAUSTED  we spent the three retries and five touches this case was allocated.
 *   TOO_OLD           the case is past the age at which the merchant wants it chased.
 *
 * Both are statements about a policy we set and can check exactly. Demanding a calibrated,
 * well-supported estimate before honouring one is a category error, and it has a concrete cost:
 * every case that exhausts its budget would land in the human queue instead of closing, which is
 * precisely the escalate-everything failure this module's header warns about. A queue built from
 * cases whose only feature is "we already tried three times" is not triage.
 *
 * The amount gate still applies to these, because a ₹50,000 case that ran out of retries
 * genuinely does deserve a person's attention before anyone writes it off.
 *
 * NO_PERMITTED_ACTION is deliberately NOT on this list. "Every route was refused" includes the
 * disputed-invoice and risk-blocked cases, and those must reach a human — closing them on the
 * grounds that we were not allowed to touch them would be the tidiest possible way to lose a
 * dispute.
 */
export const POLICY_GROUNDED_STOPS = Object.freeze([StopReason.BUDGET_EXHAUSTED, StopReason.TOO_OLD]);

/**
 * Travels with every stop decision into the audit trail.
 *
 * A stop is the one decision this agent makes that cannot be revisited, and it rests entirely
 * on the probability's LEVEL rather than its ordering. Recording which calibration the level
 * came from means a reviewer can tell a stop made on a Platt-scaled estimate from one made on
 * a raw score, without reading the code that produced it.
 */
export const CALIBRATION_NOTE =
  'Stop decisions depend on the calibrated level of p, not on the ranking of candidates. ' +
  'Probabilities reaching this module must have been calibrated on a split not used to fit them.';

/**
 * Classify how well-evidenced a probability estimate is.
 *
 * `belief.support` is expected to be `{ state, rows }` where an arm can supply it. The lookup
 * table's `coverageOf` provides exactly this; the logistic and GBM arms do not naturally have
 * a per-cell notion of support, so they report UNKNOWN and are treated cautiously.
 */
export function classifySupport(belief) {
  const s = belief?.support;
  if (!s) return { state: Support.UNKNOWN, rows: 0 };
  if (typeof s === 'string') return { state: s, rows: 0 };
  return { state: s.state ?? Support.UNKNOWN, rows: s.rows ?? 0 };
}

/** Do we have the standing to close this case permanently and never look at it again? */
export function mayStopPermanently({ belief, diagnosis, caseState, reasonCode = null, config = { GUARDRAILS } } = {}) {
  const reasons = [];
  const support = classifySupport(belief);
  const policyGrounded = POLICY_GROUNDED_STOPS.includes(reasonCode);

  /**
   * The evidence blockers apply only to stops that rest on an estimate. See
   * POLICY_GROUNDED_STOPS above for why a spent budget does not need a calibrated probability to
   * be a spent budget.
   */
  if (!policyGrounded) {
    if (!TRUSTED_SUPPORT.includes(support.state)) {
      reasons.push(
        `probability rests on ${support.state} evidence (${support.rows} rows); a base-rate fallback must not close a case`
      );
    }
    if (diagnosis?.abstained) {
      reasons.push('diagnosis abstained; closing a case we could not diagnose records a verdict we never reached');
    }
    if (diagnosis?.requiresApprovalForMoneyMovement) {
      reasons.push(`diagnosis reached at ${diagnosis.matchTier} tier is too weak to justify permanent closure`);
    }
  }

  /**
   * VALUE, NOT COUNT.
   *
   * Day 4 measured 19 unsafe beliefs on TEST carrying ₹73,428, against 16 on TRAIN carrying
   * ₹11,529. Nearly the same COUNT, six times the MONEY. A gate written on the count would
   * have read those two batches as equally risky and been wrong by ₹62,000 — the error is
   * invisible to any rule that counts cases.
   */
  const threshold = config.GUARDRAILS.humanApprovalThresholdPaise;
  if ((caseState?.amountPaise ?? 0) >= threshold) {
    reasons.push(`amount ${caseState.amountPaise} paise is at or above the ${threshold} paise approval threshold`);
  }

  return { allowed: reasons.length === 0, blockers: reasons };
}

/**
 * IS A HUMAN'S ATTENTION WORTH SPENDING ON THIS CASE?
 *
 * Asked only when we have already established that we lack the standing to close the case
 * ourselves. It is a value-of-information question, and it has an awkward property: the reason
 * we are asking is that we do not trust our probability, so we cannot use our probability to
 * answer it.
 *
 * So the test uses the only bound that needs no probability at all — assume the human recovers
 * EVERYTHING. If even that does not cover ₹60 of analyst time, looking is wasteful regardless
 * of what the true probability turns out to be, and no estimate could change the answer.
 *
 * THIS IS A NECESSARY CONDITION, NOT A SUFFICIENT ONE. Passing it does not mean review is
 * profitable; it means review is not *obviously* wasteful. That is a weaker claim than I would
 * like and it is the strongest one available once we have admitted the probability is not
 * trustworthy. Writing it as though it were a real expected-value test would be inventing the
 * number the whole branch exists because we do not have.
 *
 * WHY A GENEROUS BOUND IS THE RIGHT CHOICE HERE. It only filters out cases where review is
 * unarguably uneconomic — with a 35% margin the cut-off is about ₹177 (the amount whose full
 * contribution clears ₹60 of analyst time plus the ₹2 action bar). That sounds permissive
 * until you notice which cases reach this branch at all: an unsupported estimate, an abstained
 * diagnosis (6.2%-9.3% of cases, measured), a TEXT-tier match, or an amount already over the
 * ₹25,000 approval threshold. That population is small and mostly genuinely deserves a human.
 * A tighter bound here would be a hidden second policy, and it would be tuned against the
 * queue length rather than against anything measured.
 */
export function reviewWorthwhile({ caseState = {}, config = { POLICY, COSTS } } = {}) {
  const costs = config.COSTS ?? COSTS;
  const policy = config.POLICY ?? POLICY;
  const margin = marginFor(caseState.lossType);
  const ceilingPaise = Math.round((caseState.amountPaise ?? 0) * margin);
  const netPaise = ceilingPaise - costs.humanReviewPaise;
  return {
    worthwhile: netPaise >= policy.minEvToActPaise,
    ceilingPaise,
    netPaise,
    reviewCostPaise: costs.humanReviewPaise,
    basis: 'assumes the reviewer recovers the full amount; an upper bound, so failing it is decisive and passing it is not',
  };
}

/**
 * Decide the disposition of a case, given the scored candidates.
 *
 * @param scored    `[{ action, evPaise, verdict, deferUntil, requiresApproval, ... }]`, already
 *                  guardrail-checked and EV-scored. Must include DEFER and FORBID entries —
 *                  passing only the permitted ones would make "everything was blocked" and
 *                  "everything was unprofitable" arrive here as the same empty list, which is
 *                  the boolean-guardrail bug in a different costume.
 * @param belief    the best action's `{ p, support }`
 *
 * WHY `WAIT` IS SEPARATE FROM `CONTINUE`. A case whose only viable action is deferred to
 * 09:00 has not been decided yet. Reporting CONTINUE would have the orchestrator execute
 * nothing while the record claims it acted; reporting STOP would abandon a live case over a
 * clock. WAIT carries the instant and the orchestrator re-decides then.
 */
export function decideDisposition({
  scored = [],
  belief = null,
  diagnosis = null,
  caseState = {},
  config = { GUARDRAILS, POLICY },
} = {}) {
  const bar = actionThresholdPaise(config.POLICY);

  const permitted = scored.filter((c) => c.verdict === 'ALLOW');
  const deferred = scored.filter((c) => c.verdict === 'DEFER');

  const profitable = permitted.filter((c) => c.evPaise >= bar);
  if (profitable.length > 0) {
    return { disposition: Disposition.CONTINUE, reason: null, barPaise: bar, calibrationNote: CALIBRATION_NOTE };
  }

  // Escalation is itself an action, and it may be the only permitted one. If the arithmetic
  // already chose it there is nothing to decide here.
  const escalationAvailable = permitted.some((c) => c.action?.kind === ActionKind.ESCALATE_HUMAN);

  /**
   * A deferred action is a reason to WAIT only if it could plausibly be worth taking when the
   * clock permits. Waiting until 09:00 to send a message whose EV is minus ₹40 is not patience,
   * it is a loop. The comparison uses the EV computed at the deferred instant where the caller
   * supplied one.
   */
  const worthWaitingFor = deferred.filter((c) => c.evPaise >= bar);
  if (worthWaitingFor.length > 0) {
    const until = new Date(Math.min(...worthWaitingFor.map((c) => new Date(c.deferUntil).getTime())));
    return {
      disposition: Disposition.WAIT,
      until,
      reason: null,
      barPaise: bar,
      calibrationNote: CALIBRATION_NOTE,
      waitingOn: worthWaitingFor.map((c) => ({ action: c.action, evPaise: c.evPaise, until: c.deferUntil })),
    };
  }

  // ---- Nothing is worth doing now or later. Establish WHY, then whether we may close. ----
  const reason = diagnoseStopReason({ scored, permitted, caseState, diagnosis, config, bar });
  const standing = mayStopPermanently({ belief, diagnosis, caseState, reasonCode: reason.code, config });

  if (standing.allowed) {
    return {
      disposition: Disposition.STOP_PERMANENT,
      reason,
      barPaise: bar,
      standing,
      calibrationNote: CALIBRATION_NOTE,
    };
  }

  /**
   * We are not entitled to close this case. That leaves review — but review is not free, and
   * an agent that escalates everything it cannot decide has built a queue rather than
   * automated anything. So the exposure has to justify the analyst's time.
   */
  const review = reviewWorthwhile({ caseState, config });

  if (!review.worthwhile) {
    return {
      disposition: Disposition.STOP_PERMANENT,
      reason: {
        code: StopReason.UNREVIEWED_TOO_SMALL,
        detail:
          `${reason.detail}. We lacked the standing to close it on the evidence, but even full recovery ` +
          `(${review.ceilingPaise} paise) would not cover the ${review.reviewCostPaise} paise cost of a human looking, ` +
          `so it is closed unreviewed rather than escalated`,
        underlying: reason.code,
      },
      barPaise: bar,
      standing,
      review,
      calibrationNote: CALIBRATION_NOTE,
    };
  }

  /**
   * Escalation is warranted. `blockedEscalation` records the case where even escalation is
   * forbidden — a risk-blocked case with an unsupported belief, for instance. Closing it
   * anyway would be the tidy option and would record a decision nobody was entitled to make,
   * so it surfaces as an unresolved case in the run report instead.
   */
  return {
    disposition: Disposition.ESCALATE_HUMAN,
    reason,
    blockedEscalation: !escalationAvailable,
    barPaise: bar,
    standing,
    review,
    calibrationNote: CALIBRATION_NOTE,
  };
}

/**
 * Why did nothing survive?
 *
 * The reason is read off the violations rather than inferred from the empty result, because
 * "no action cleared the bar" and "every action was forbidden" produce identical-looking
 * outcomes and mean opposite things. The first is a judgement about value; the second is a
 * statement that the agent was never allowed to try.
 *
 * WHY THIS FILTERS TO THE RECOVERING ACTIONS, WHICH IS THE BUG THAT MADE THREE CODES DEAD.
 * ---------------------------------------------------------------------------------------
 * This used to test `permitted.length === 0`, where `permitted` was every ALLOW candidate.
 * NO_ACTION_YET, STOP_PERMANENT and ESCALATE_HUMAN are permitted on essentially every case — the
 * kill switch does not even touch NO_ACTION_YET — so that list was never empty and the entire
 * blocked branch was unreachable. NO_PERMITTED_ACTION, BUDGET_EXHAUSTED and TOO_OLD could not be
 * produced.
 *
 * Every stop therefore came back as NEGATIVE_EV, with the detail "best permitted action
 * (NO_ACTION_YET) is worth 0 paise". That sentence is not merely unhelpful, it is false about the
 * mechanism: it claims we priced the options and none was worth taking, when the truth was that
 * every option capable of recovering money had been refused outright. A case that hit its retry
 * cap and a case that was genuinely hopeless produced the same audit line, and the TOO_OLD and
 * BUDGET_EXHAUSTED buckets would have read zero in the eval — which looks like two rules that
 * never fire rather than two rules whose reporting was broken.
 *
 * DEFER counts as available here, not as blocked. A deferred action is one we could still take;
 * if it is unprofitable we are declining it on value, and NEGATIVE_EV is the honest code. Only a
 * FORBID means we were never permitted to try.
 */
function diagnoseStopReason({ scored, caseState, diagnosis, config, bar }) {
  if (diagnosis?.physics?.humanOnly) {
    return { code: StopReason.HUMAN_ONLY_CAUSE, detail: `${diagnosis.rootCause} is a human-only cause` };
  }

  const recovering = scored.filter((c) => RECOVERING_KINDS.has(c.action?.kind));
  const actionable = recovering.filter((c) => c.verdict !== 'FORBID');

  if (actionable.length === 0) {
    const ids = new Set(recovering.flatMap((c) => (c.violations ?? []).map((v) => v.id)));

    if (ids.has('BUD_CASE_AGE')) {
      return {
        code: StopReason.TOO_OLD,
        detail: `case is ${(caseState.ageDays ?? 0).toFixed(1)} days old, past the ${config.POLICY.maxCaseAgeDays}-day limit`,
      };
    }
    if (ids.has('BUD_RETRIES_PER_CASE') || ids.has('BUD_TOUCHES_PER_CASE')) {
      return {
        code: StopReason.BUDGET_EXHAUSTED,
        detail: `retries ${caseState.retriesUsed ?? 0}/${config.GUARDRAILS.maxRetriesPerCase}, touches ${caseState.touchesUsed ?? 0}/${config.GUARDRAILS.maxTouchesPerCase}`,
      };
    }
    return {
      code: StopReason.NO_PERMITTED_ACTION,
      detail: `every action that could have recovered money was refused: ${[...ids].join(', ') || 'no rule recorded'}`,
    };
  }

  const best = actionable.reduce((a, b) => (b.evPaise > a.evPaise ? b : a));
  return {
    code: StopReason.NEGATIVE_EV,
    detail: `best available recovery action (${best.action?.kind}) is worth ${best.evPaise} paise, below the ${bar} paise bar`,
  };
}
