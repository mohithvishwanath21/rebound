/**
 * THE DECISION ENGINE
 * ===================
 *
 * One case in, one decision record out. The record is the audit trail — not a log line written
 * alongside the decision, but the decision itself, in a form a reviewer can disagree with.
 *
 * WHAT IT DOES
 * ------------
 *   1. enumerate every action that could be taken
 *   2. put each through the guardrails
 *   3. price the ones that survived
 *   4. take the argmax over expected value
 *   5. ask `stopping.js` whether the outcome is act, wait, escalate, or close
 *
 * WHY THE REJECTED CANDIDATES ARE IN THE OUTPUT
 * --------------------------------------------
 * A record that says "we sent a WhatsApp link" is a log. A record that says "we sent a WhatsApp
 * link, worth ₹1,847; a retry in six hours was worth ₹1,203; retrying now was forbidden because
 * the mandate is revoked; SMS was worth ₹1,838 and lost by 9 paise" is an argument. Only the
 * second one can be checked, and only the second one survives the question a judge or an
 * auditor actually asks, which is "what else did you consider?"
 *
 * The cost is a fat record — around thirty candidates per case. That is the correct thing to
 * spend bytes on.
 *
 * WHY ABSOLUTE-BLOCKED ACTIONS ARE NEVER PRICED
 * --------------------------------------------
 * A forbidden action's EV is not computed and is recorded as `null`, not as a number the
 * argmax happened to lose to. If charging a revoked mandate had a number attached, then
 * someday somebody comparing numbers would notice it was the biggest one, and the only thing
 * standing between that observation and a compliance breach would be a filter in a sort. The
 * price is not "high risk, low reward" — it does not exist. `priced: false` in the record says
 * so explicitly.
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not execute anything, does not persist anything, and does not know a gateway exists.
 * It is a pure function of (observation, diagnosis, case record, probability model, clock). That
 * makes every decision in this project reproducible from its inputs and testable without a
 * network, and it is why the demo can replay a batch and get identical decisions.
 *
 * Execution, scheduling, and the contact ledger are Day 7.
 */

import { GUARDRAILS, POLICY, POLICY_ARMS } from '../core/config.js';
import { ActionKind, actionSignature, enumerateCandidateActions, MONEY_MOVING, CUSTOMER_CONTACTING, Channel } from '../core/actions.js';
import { formatINR } from '../core/money.js';
import { checkGuardrails, normaliseCaseState, Verdict } from './guardrails.js';
import { expectedValue, actionThresholdPaise, marginFor } from './expectedValue.js';
import { decideDisposition, Disposition, classifySupport, CALIBRATION_NOTE, POLICY_GROUNDED_STOPS } from './stopping.js';

const HOUR_MS = 3_600_000;

/** Bumped when the record's shape changes, so stored decisions stay readable. */
export const DECISION_SCHEMA_VERSION = 1;

export const Outcome = Object.freeze({
  ACT: 'ACT',
  AWAIT_APPROVAL: 'AWAIT_APPROVAL',
  WAIT: 'WAIT',
  ESCALATE_HUMAN: 'ESCALATE_HUMAN',
  STOP_PERMANENT: 'STOP_PERMANENT',
});

/**
 * The candidate set for one case, at one moment.
 *
 * Deliberately generous — every channel for every message type at every offset. The action
 * space is closed and small enough to enumerate exhaustively, so there is no reason to prune
 * before pricing, and pruning early is how an option quietly stops being considered. The
 * audit trail is more useful for showing that VOICE was available and lost than for staying
 * short.
 */
export function candidatesFor(now, policy = POLICY) {
  const base = new Date(now).getTime();
  return enumerateCandidateActions({
    retryTimes: policy.candidateRetryOffsetsHours.map((h) => new Date(base + h * HOUR_MS).toISOString()),
    channels: Object.values(Channel),
  });
}

/**
 * IDEMPOTENCY KEY MINTING, AND THE HAZARD IT ONLY PARTLY SOLVES.
 *
 * Deterministic in (eventId, action, attempt ordinal), so re-deciding the same case at the same
 * moment produces the same key and a duplicate call is refused by the gateway. The ordinal is
 * `retriesUsed`, which is what makes the *second* legitimate retry get a different key from the
 * first — without it, a correct second attempt would be silently deduplicated against the first
 * and the case would look retried when nothing happened.
 *
 * THE PART THIS DOES NOT SOLVE. If the process dies between the gateway call and the write that
 * increments `retriesUsed`, the restart re-decides with the old ordinal, mints the same key, and
 * is correctly refused — safe. But if the increment landed and the gateway call did not, the
 * restart mints a *different* key for an attempt that never happened, which is also correct.
 * The unsafe interleaving is a gateway call that succeeded and a write that landed as a
 * *different* ordinal, which cannot happen here because the ordinal is read once per decision.
 *
 * What genuinely remains: this key is derived rather than persisted. Day 7's orchestrator must
 * write the key into an attempt record BEFORE calling the gateway and reuse it on replay,
 * because a derived key depends on our own counter being accurate and a persisted key does not.
 * Recorded here rather than in a ticket because the derivation looks safe and is only safe under
 * an assumption this file cannot enforce.
 */
export function mintIdempotencyKey({ eventId, action, attemptOrdinal }) {
  return `rebound:${eventId}:${actionSignature(action)}:${attemptOrdinal}`;
}

/**
 * Decide what to do about one case.
 *
 * @param observed    output of `observe()`
 * @param diagnosis   output of `diagnose()`
 * @param record      our own case record: retriesUsed, touchesUsed, lastRetryAt, flags, ledger
 * @param scoreAction `({ diagnosis, observed, action, context }) => { p, support }`
 *                    `support` is `{ state, rows }` where the arm can supply it. It is passed
 *                    in rather than derived from the model because support is a property of the
 *                    TRAINING DATA around a point, not of the model — which is what lets the
 *                    same coverage index serve the logistic arm and the lookup table alike.
 * @param runState    `{ retriesThisRun, messagesThisRun }`
 * @param now         decision time
 */
export function decideForCase({
  observed,
  diagnosis,
  record = {},
  scoreAction,
  runState = { retriesThisRun: 0, messagesThisRun: 0 },
  now = new Date(),
  config = { GUARDRAILS, POLICY },
  policyArm = POLICY_ARMS?.REBOUND_EV ?? 'REBOUND_EV',
  candidates,
} = {}) {
  if (typeof scoreAction !== 'function') {
    throw new TypeError('decideForCase({ scoreAction }): a probability function is required');
  }
  if (!observed?.eventId) throw new TypeError('decideForCase({ observed }): observed.eventId is required');

  const decidedAt = new Date(now);
  const caseState = normaliseCaseState({ observed, record, now: decidedAt });
  const bar = actionThresholdPaise(config.POLICY);
  const list = candidates ?? candidatesFor(decidedAt, config.POLICY);

  const scored = [];

  for (const raw of list) {
    // Money movement carries its key from the moment it becomes a candidate, so
    // ABS_IDEMPOTENCY_KEY is checking a real property rather than one this function forgot to
    // set. An action that reaches the guardrails without a key is a construction bug, and the
    // rule is there to catch it rather than to be satisfied by it.
    const action = MONEY_MOVING.has(raw.kind)
      ? { ...raw, idempotencyKey: mintIdempotencyKey({ eventId: observed.eventId, action: raw, attemptOrdinal: caseState.retriesUsed }) }
      : raw;

    const guard = checkGuardrails({ action, caseState, diagnosis, runState, now: decidedAt, config });

    /**
     * Only price what could actually happen. FORBID means the action is off the table, and a
     * number attached to it would be an invitation to compare it with the permitted ones.
     * DEFER is priced, because whether waiting is worthwhile is precisely an EV question.
     */
    if (guard.verdict === Verdict.FORBID) {
      scored.push({
        action,
        signature: actionSignature(action),
        verdict: guard.verdict,
        priced: false,
        evPaise: null,
        p: null,
        support: null,
        deferUntil: null,
        violations: guard.violations,
        evaluated: guard.evaluated,
        requiresApproval: guard.requiresApproval,
        approvalReasons: guard.approvalReasons,
      });
      continue;
    }

    /**
     * The instant the probability is evaluated at is the instant the action executes, not the
     * instant we decided. A scheduled retry's features include the delay and the salary-window
     * proximity of the FUTURE slot; scoring it at `now` would price every scheduled retry as
     * though it fired immediately and the timing effect — the highest-leverage distinction in
     * the model — would vanish from the decision while remaining visible in the training data.
     */
    const at = guard.effectiveAt;
    const belief = scoreAction({
      diagnosis,
      observed,
      action,
      context: { now: at, touchesUsed: caseState.touchesUsed },
    });

    const p = belief?.p;
    if (!Number.isFinite(p)) {
      throw new TypeError(`scoreAction returned no probability for ${actionSignature(action)}`);
    }

    const ev = expectedValue({
      p,
      amountPaise: caseState.amountPaise,
      lossType: caseState.lossType,
      action,
      touchesUsed: caseState.touchesUsed,
    });

    // Re-run the approval checks now that a belief exists: APR_UNSUPPORTED_BELIEF cannot be
    // evaluated before the probability is known, and skipping the second pass would let an
    // unsupported estimate authorise money movement unreviewed.
    const withBelief = checkGuardrails({ action, caseState, diagnosis, belief, runState, now: decidedAt, config });

    scored.push({
      action,
      signature: actionSignature(action),
      verdict: guard.verdict,
      priced: true,
      ...ev,
      p,
      support: classifySupport(belief),
      effectiveAt: at,
      deferUntil: guard.deferUntil,
      violations: guard.violations,
      evaluated: guard.evaluated,
      requiresApproval: withBelief.requiresApproval,
      approvalReasons: withBelief.approvalReasons,
    });
  }

  // ---- argmax, with a deterministic tiebreak ------------------------------------------------
  /**
   * Ties are broken by action signature, alphabetically. Any deterministic rule would do; the
   * requirement is only that it BE deterministic, because `Array.prototype.sort` stability plus
   * an unspecified tiebreak means two runs of the same batch can pick different actions and the
   * reproducibility claim in VERIFY.md quietly stops holding. The project has already been
   * bitten by a report that printed different numbers on two consecutive runs.
   */
  const ranked = scored
    .filter((c) => c.priced)
    .sort((a, b) => (b.evPaise - a.evPaise) || a.signature.localeCompare(b.signature));

  ranked.forEach((c, i) => { c.rank = i + 1; });

  const permitted = ranked.filter((c) => c.verdict === Verdict.ALLOW);
  const best = permitted.find((c) => c.evPaise >= bar) ?? null;

  /**
   * WHICH BELIEF THE STOPPING RULE IS ENTITLED TO JUDGE.
   *
   * This used to read `belief: best ? {...} : null`, and that line silently disabled the entire
   * standing mechanism. `best` is by definition the best action that CLEARS the bar, so it is
   * non-null exactly when we are about to act — and null on every path that leads to a stop.
   * `classifySupport(null)` returns UNKNOWN, UNKNOWN is not in TRUSTED_SUPPORT, so
   * `mayStopPermanently` blocked every single closure. STOP_PERMANENT on a confident
   * NEGATIVE_EV was unreachable code.
   *
   * The symptom was visible in the first batch run and I misread it as correct: 26 cases stopped
   * for NEGATIVE_EV, all 26 routed to a human, none closed. The consequences of leaving it:
   * every hopeless case either goes to an analyst or is filed under UNREVIEWED_TOO_SMALL, so the
   * agent can never say "I looked at this and it is not worth chasing" — which is the one claim
   * the Track 3 bar explicitly asks a stopping rule to make. It also inflates the escalation
   * queue with exactly the cases we had good evidence about, and it makes the weak stop code the
   * only stop code, so the honest distinction UNREVIEWED_TOO_SMALL was built to draw collapses.
   *
   * The estimate a stop actually rests on is the best PRICED action that could have recovered
   * money — the one whose probability is the reason we concluded nothing was worth doing. It does
   * not need to have cleared the bar; failing to clear the bar is the finding. NO_ACTION_YET and
   * STOP_PERMANENT are excluded because a probability attached to doing nothing is not evidence
   * about anything, and letting one satisfy the support gate would re-open the hole from the
   * other side.
   *
   * WHY THIS SEARCHES `ranked` AND NOT `permitted`, WHICH IS THE SAME BUG A SECOND TIME.
   * Restricting it to ALLOW candidates reintroduced the hole on a narrower path: a case at 23:00
   * IST whose retry budget is spent has every recovering action DEFERRED, none ALLOWED, so
   * `permitted` contains only escalate/stop/no-op and the search came back null again. Those
   * cases would go to a human forever, at 2am, on evidence we fully trusted. `ranked` is
   * priced-only and FORBID candidates are never priced, so the compliance boundary is still
   * respected — a refused action contributes no belief because it has none.
   *
   * The general shape of the mistake, worth naming because I have now made it twice: the
   * probability that justifies a STOP is not the probability of the action we are about to take
   * (there isn't one), it is the probability of the best action we are declining to take.
   */
  const bestRecovering =
    ranked.find((c) => MONEY_MOVING.has(c.action.kind) || CUSTOMER_CONTACTING.has(c.action.kind)) ?? null;
  const evidenceFor = best ?? bestRecovering;

  const disposition = decideDisposition({
    scored: ranked.concat(scored.filter((c) => !c.priced)),
    belief: evidenceFor ? { p: evidenceFor.p, support: evidenceFor.support } : null,
    diagnosis,
    caseState,
    config,
  });

  // ---- resolve the outcome ------------------------------------------------------------------
  let outcome;
  let chosen = null;
  let waitUntil = null;

  if (disposition.disposition === Disposition.CONTINUE && best) {
    chosen = best;
    outcome = best.requiresApproval ? Outcome.AWAIT_APPROVAL : Outcome.ACT;
  } else if (disposition.disposition === Disposition.WAIT) {
    outcome = Outcome.WAIT;
    waitUntil = disposition.until;
  } else if (disposition.disposition === Disposition.ESCALATE_HUMAN) {
    outcome = Outcome.ESCALATE_HUMAN;
    chosen = permitted.find((c) => c.action.kind === ActionKind.ESCALATE_HUMAN) ?? null;
  } else {
    outcome = Outcome.STOP_PERMANENT;
  }

  annotateRejections(scored, chosen, bar);

  const record_ = {
    schemaVersion: DECISION_SCHEMA_VERSION,
    policyArm,
    decidedAt: decidedAt.toISOString(),

    eventId: caseState.eventId,
    customerId: caseState.customerId,
    amountPaise: caseState.amountPaise,
    lossType: caseState.lossType,
    marginApplied: marginFor(caseState.lossType),

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

    caseState,
    runState: { ...runState },

    outcome,
    chosen: chosen
      ? {
          action: chosen.action,
          signature: chosen.signature,
          evPaise: chosen.evPaise,
          grossPaise: chosen.grossPaise,
          totalCostPaise: chosen.totalCostPaise,
          components: chosen.components,
          p: chosen.p,
          support: chosen.support,
          effectiveAt: chosen.effectiveAt?.toISOString?.() ?? null,
          idempotencyKey: chosen.action.idempotencyKey ?? null,
        }
      : null,
    waitUntil: waitUntil ? new Date(waitUntil).toISOString() : null,
    stop:
      outcome === Outcome.STOP_PERMANENT || outcome === Outcome.ESCALATE_HUMAN
        ? { ...disposition.reason, standing: disposition.standing ?? null, blockedEscalation: Boolean(disposition.blockedEscalation) }
        : null,

    requiresApproval: Boolean(chosen?.requiresApproval) || outcome === Outcome.AWAIT_APPROVAL,
    approvalReasons: chosen?.approvalReasons ?? [],

    barPaise: bar,
    calibrationNote: CALIBRATION_NOTE,

    // The audit surface. Ranked, priced where pricing was legitimate, with a reason per line.
    //
    // Sorted by rank rather than left in enumeration order, so the record reads top-down as the
    // argument it is: the winner, then what it beat, then what was never permitted. Unpriced
    // candidates sort last because they were not in the comparison at all.
    candidates: scored
      .slice()
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.signature.localeCompare(b.signature))
      .map((c) => ({
      rank: c.rank ?? null,
      signature: c.signature,
      kind: c.action.kind,
      channel: c.action.channel ?? null,
      scheduledFor: c.action.scheduledFor ?? null,
      verdict: c.verdict,
      priced: c.priced,
      evPaise: c.evPaise ?? null,
      grossPaise: c.grossPaise ?? null,
      totalCostPaise: c.totalCostPaise ?? null,
      p: c.p,
      support: c.support?.state ?? null,
      deferUntil: c.deferUntil ? new Date(c.deferUntil).toISOString() : null,
      chosen: c === chosen,
      rejectedBecause: c.rejectedBecause ?? null,
      violations: c.violations.map((v) => ({ id: v.id, kind: v.kind, message: v.message })),
      requiresApproval: c.requiresApproval,
    })),

    /**
     * Every rule that was evaluated for the chosen action, including the ones that did not
     * apply. Answers "was this checked?", which is a different question from "did this fire?"
     * and the one an auditor asks.
     */
    guardrailsEvaluated: (chosen ?? ranked[0])?.evaluated ?? [],
  };

  record_.explain = explainDecision(record_);
  return record_;
}

/**
 * Give every rejected candidate a one-line reason.
 *
 * "lost to RETRY_SCHEDULED by 9 paise" is the line that makes the record explanatory rather
 * than a data dump — it is also the line that reveals when a decision was nearly a coin flip,
 * which is information a reviewer is entitled to.
 */
function annotateRejections(scored, chosen, bar) {
  for (const c of scored) {
    if (c === chosen) continue;

    if (c.verdict === Verdict.FORBID) {
      const absolute = c.violations.filter((v) => v.kind === 'ABSOLUTE');
      const src = absolute.length > 0 ? absolute : c.violations;
      c.rejectedBecause = `not permitted — ${src.map((v) => `${v.id}: ${v.message}`).join('; ')}`;
      continue;
    }
    if (c.verdict === Verdict.DEFER) {
      c.rejectedBecause = `not yet — earliest legal moment ${new Date(c.deferUntil).toISOString()} (${c.violations.map((v) => v.id).join(', ')})`;
      continue;
    }
    if (c.evPaise < bar) {
      c.rejectedBecause = `expected value ${c.evPaise} paise is below the ${bar} paise bar`;
      continue;
    }
    if (chosen) {
      const gap = chosen.evPaise - c.evPaise;
      c.rejectedBecause = gap === 0
        ? `tied with ${chosen.signature} at ${c.evPaise} paise; lost the deterministic tiebreak`
        : `lost to ${chosen.signature} by ${gap} paise`;
      continue;
    }
    c.rejectedBecause = 'no action was taken on this case';
  }
}

/**
 * The decision in plain English.
 *
 * This exists to be read out loud. If a line here cannot be defended in an interview, the
 * decision behind it probably cannot either, which makes this function a test of the policy
 * and not only a renderer of it.
 */
export function explainDecision(rec) {
  const L = [];
  const money = (p) => formatINR(p, { withDecimals: false });
  /**
   * Costs in this model run from 2 paise (an email) to ₹60 (an analyst). Rendering the whole
   * range without decimals prints "₹0 message" for the email, which reads as free and is the
   * one thing it must not read as — the entire reason email is priced at all is so that
   * "email everyone forever" stays bounded by something. Sub-rupee amounts keep their paise.
   */
  const cost = (p) => (p < 100 ? `${p} paise` : formatINR(p, { withDecimals: false }));

  L.push(`Case ${rec.eventId}: ${money(rec.amountPaise)} at risk (${rec.lossType}).`);
  L.push(
    `Contribution margin ${(rec.marginApplied * 100).toFixed(0)}%, so recovering it is worth ${money(Math.round(rec.amountPaise * rec.marginApplied))} — that is the number the decision is measured against, not the face value.`
  );

  if (rec.diagnosis) {
    const d = rec.diagnosis;
    L.push(
      `Diagnosis: ${d.rootCause}, reached at ${d.matchTier} tier via ${d.source}${d.matchedOn ? ` (${d.matchedOn})` : ''}.` +
        (d.abstained ? ' The diagnosis abstained — no cause was identified.' : '')
    );
    if (d.requiresApprovalForMoneyMovement) {
      L.push('That tier of match is not strong enough to authorise money movement on its own.');
    }
  }

  L.push(
    `State: ${rec.caseState.retriesUsed} retries and ${rec.caseState.touchesUsed} touches already spent; case is ${rec.caseState.ageDays.toFixed(1)} days old.`
  );

  const priced = rec.candidates.filter((c) => c.priced).length;
  const blocked = rec.candidates.filter((c) => c.verdict === 'FORBID').length;
  L.push(`Considered ${rec.candidates.length} actions: ${priced} priced, ${blocked} not permitted at all.`);

  if (rec.chosen) {
    const c = rec.chosen;
    const k = c.components;

    /**
     * An action with a structurally zero gross was not chosen by the arithmetic and its
     * probability played no part. Printing "p=2.0%" next to escalation implies the number was
     * weighed, which is precisely the impression `expectedValue` refuses to create by pricing
     * escalation at zero. Two different sentences for two different kinds of choice.
     */
    if (c.grossPaise === 0 && c.evPaise < 0) {
      L.push(
        `Chose ${c.signature}, which costs ${cost(c.totalCostPaise)} and recovers nothing by itself. It was not selected on expected value — it lost to every priced alternative — but on standing: we were not entitled to close this case ourselves.`
      );
    } else {
      L.push(
        `Chose ${c.signature}: expected value ${money(c.evPaise)} = ${money(c.grossPaise)} gross (p=${(k.p * 100).toFixed(1)}%) minus ${money(c.totalCostPaise)} of cost.`
      );
    }

    const parts = [];
    if (k.channelPaise) parts.push(`${cost(k.channelPaise)} message`);
    if (k.humanReviewPaise) parts.push(`${cost(k.humanReviewPaise)} analyst time`);
    if (k.expectedFailurePenaltyPaise) parts.push(`${cost(k.expectedFailurePenaltyPaise)} expected decline penalty`);
    if (k.patiencePenaltyPaise) parts.push(`${cost(k.patiencePenaltyPaise)} of customer patience (touch ${k.touchesUsed + 1})`);
    if (parts.length > 0) L.push(`Cost breakdown: ${parts.join(', ')}.`);

    // Only meaningful when the choice WAS an argmax. For a standing-based choice the runner-up
    // is better on EV by construction, and "lost by minus ₹60" is a sentence that explains
    // nothing.
    const runnerUp = rec.candidates.find((x) => x.rank === 2 && x.priced);
    if (runnerUp && c.evPaise >= runnerUp.evPaise) {
      L.push(
        `Next best was ${runnerUp.signature} at ${money(runnerUp.evPaise)}, ${money(c.evPaise - runnerUp.evPaise)} behind.`
      );
    }
  }

  if (rec.outcome === 'AWAIT_APPROVAL') {
    L.push(`Held for human approval: ${rec.approvalReasons.join('; ')}.`);
  }
  if (rec.outcome === 'WAIT') {
    L.push(`No action yet. The best action is legal from ${rec.waitUntil} and the case is re-decided then.`);
  }
  if (rec.outcome === 'ESCALATE_HUMAN') {
    L.push(`Escalated to a human. ${rec.stop?.detail ?? ''}`);
    for (const b of rec.stop?.standing?.blockers ?? []) L.push(`  Not entitled to close it instead: ${b}`);
    if (rec.stop?.blockedEscalation) {
      L.push('  Escalation is itself blocked by an absolute rule, so this case is unresolved rather than assigned.');
    }
  }
  if (rec.outcome === 'STOP_PERMANENT') {
    L.push(`Stopped permanently (${rec.stop?.code}): ${rec.stop?.detail}.`);
    /**
     * The three stop codes make three different claims and the explanation must not blur them.
     * Saying "the estimate is supported" on a case we closed only because reviewing it was
     * uneconomic would be the audit trail asserting evidence the decision never had — and saying
     * it on a budget-exhausted case would be worse, because that closure deliberately did not
     * consult the estimate at all.
     */
    if (rec.stop?.code === 'UNREVIEWED_TOO_SMALL') {
      L.push(
        '  This is a weak closure, and it is recorded as one: we did not establish that the case was hopeless, only that it was too small to be worth finding out.'
      );
    } else if (POLICY_GROUNDED_STOPS.includes(rec.stop?.code)) {
      L.push(
        '  Closing it needed no probability estimate: this is a limit we set ourselves and can check exactly, so the evidence behind the recovery model is not what the decision rests on. The amount is below the threshold at which a person reviews a write-off.'
      );
    } else {
      L.push(
        '  Closing the case was permitted: the estimate is supported, the diagnosis is firm, and the amount is below the approval threshold.'
      );
    }
  }

  return L;
}

/** Decide a whole batch. Pure and order-independent, so a batch can be re-run and compared. */
export function decideBatch({ cases = [], scoreAction, now = new Date(), config = { GUARDRAILS, POLICY } } = {}) {
  /**
   * Run-level counters advance as the batch is processed, so the circuit breakers actually
   * bind. This does make the batch order-DEPENDENT once a breaker trips — the 251st message is
   * refused because 250 came first, and which case is 251st depends on the order.
   *
   * That is real and it is reported rather than hidden. Allocating a binding run budget across
   * cases is a knapsack problem, and processing in arrival order is the worst policy that
   * respects the cap: it spends the budget on whichever cases happen to be early rather than on
   * the ones carrying the most money. Day 7's orchestrator sorts by expected value before
   * spending, which is the fix. Until then, `budgetBound` in the summary says whether any
   * breaker tripped, so a run whose results depend on ordering cannot be quoted as if it did
   * not.
   */
  const runState = { retriesThisRun: 0, messagesThisRun: 0 };
  const decisions = [];

  for (const c of cases) {
    const decision = decideForCase({ ...c, scoreAction, runState, now, config });
    decisions.push(decision);

    if (decision.outcome === Outcome.ACT) {
      const kind = decision.chosen?.action?.kind;
      if (MONEY_MOVING.has(kind)) runState.retriesThisRun += 1;
      else if (kind && kind !== ActionKind.ESCALATE_HUMAN) runState.messagesThisRun += 1;
    }
  }

  return { decisions, runState, summary: summariseBatch(decisions, runState, config) };
}

/**
 * Batch summary, reported in RUPEES rather than counts.
 *
 * Counts were the wrong unit and it was measured: 19 unsafe beliefs on TEST carried ₹73,428
 * against 16 on TRAIN carrying ₹11,529. A summary reporting "19 vs 16" describes those two
 * batches as equivalent and is wrong by ₹62,000. So every bucket below carries its exposure,
 * and both human queues are ordered by it — a human with an hour should spend it on the
 * ₹73,428, and a queue sorted by arrival time will not let them.
 *
 * WHY THERE ARE TWO HUMAN QUEUES AND NOT ONE
 * -----------------------------------------
 * An earlier version of this function returned a single `approvalQueue` holding both
 * AWAIT_APPROVAL and ESCALATE_HUMAN. The first batch report built on it printed a queue whose
 * exposure (₹17,38,594) exceeded the AWAIT_APPROVAL bucket it was supposed to describe
 * (₹15,50,661), and listed "INVOICE_DISPUTED is a human-only cause" as an approval reason, which
 * is not a reason to approve anything.
 *
 * They are different work. AWAIT_APPROVAL means the agent has chosen an action, minted its
 * idempotency key and is asking one question with a yes/no answer — the reviewer's job is thirty
 * seconds long and the case is otherwise ready to execute. ESCALATE_HUMAN means the agent is not
 * going to act at all and a person now owns the case; there is no proposed action to approve, and
 * the reviewer's job is unbounded. Merging them gives a reviewer a list where two thirds of the
 * items cannot be actioned the way the list implies, and gives a dashboard a total that
 * contradicts its own outcome table.
 *
 * `humanQueueExposurePaise` is kept for the one legitimate use of the merged figure: how much
 * money is currently waiting on a person for any reason.
 */
export function summariseBatch(decisions, runState, config = { GUARDRAILS, POLICY }) {
  const bucket = () => ({ count: 0, exposurePaise: 0, expectedRecoveryPaise: 0 });
  const byOutcome = {};
  for (const o of Object.values(Outcome)) byOutcome[o] = bucket();

  for (const d of decisions) {
    const b = byOutcome[d.outcome];
    b.count += 1;
    b.exposurePaise += d.amountPaise;
    b.expectedRecoveryPaise += d.chosen?.grossPaise ?? 0;
  }

  /**
   * Two queues, deliberately. See the header. The reason each carries is taken from the matching
   * field rather than from whichever field happens to be populated: approvals get
   * `approvalReasons`, escalations get the stop detail, and neither borrows the other's.
   */
  const byValue = (a, b) => b.amountPaise - a.amountPaise;

  const approvalQueue = decisions
    .filter((d) => d.outcome === Outcome.AWAIT_APPROVAL)
    .sort(byValue)
    .map((d) => ({
      eventId: d.eventId,
      amountPaise: d.amountPaise,
      outcome: d.outcome,
      // The action is already chosen and keyed, so a reviewer can approve it without re-deciding.
      proposed: d.chosen?.signature ?? null,
      idempotencyKey: d.chosen?.idempotencyKey ?? null,
      expectedValuePaise: d.chosen?.evPaise ?? null,
      reasons: d.approvalReasons,
    }));

  const escalationQueue = decisions
    .filter((d) => d.outcome === Outcome.ESCALATE_HUMAN)
    .sort(byValue)
    .map((d) => ({
      eventId: d.eventId,
      amountPaise: d.amountPaise,
      outcome: d.outcome,
      // No proposed action, by definition: the agent has declined to choose one.
      stopCode: d.stop?.code ?? null,
      reasons: [d.stop?.detail, ...(d.stop?.standing?.blockers ?? [])].filter(Boolean),
    }));

  const sum = (q) => q.reduce((s, x) => s + x.amountPaise, 0);
  const approvalQueueExposurePaise = sum(approvalQueue);
  const escalationQueueExposurePaise = sum(escalationQueue);

  return {
    cases: decisions.length,
    totalExposurePaise: decisions.reduce((s, d) => s + d.amountPaise, 0),
    byOutcome,
    approvalQueue,
    approvalQueueExposurePaise,
    escalationQueue,
    escalationQueueExposurePaise,
    /** Everything waiting on a person, for any reason. The one figure the merge was right about. */
    humanQueueExposurePaise: approvalQueueExposurePaise + escalationQueueExposurePaise,
    totalExpectedRecoveryPaise: decisions.reduce((s, d) => s + (d.chosen?.grossPaise ?? 0), 0),
    totalExpectedValuePaise: decisions.reduce((s, d) => s + (d.chosen?.evPaise ?? 0), 0),
    runState: { ...runState },
    budgetBound:
      runState.messagesThisRun >= config.GUARDRAILS.maxMessagesPerRun ||
      runState.retriesThisRun >= config.GUARDRAILS.maxRetriesPerRun,
  };
}
