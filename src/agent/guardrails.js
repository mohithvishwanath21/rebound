/**
 * THE GUARDRAIL ENGINE
 * ====================
 *
 * Every action the agent might take is passed through here before its expected value is
 * computed. The output is not a boolean.
 *
 * WHY THREE VERDICTS AND NOT TWO
 * ------------------------------
 * The obvious signature is `isAllowed(action) -> bool`, and it collapses two situations that
 * demand opposite responses:
 *
 *   "you may never charge this revoked mandate"      -> FORBID
 *   "it is 02:40 in Kolkata, do not message yet"     -> DEFER until 09:00
 *
 * Under a boolean both come back false. The decision engine then sees no permissible action,
 * concludes nothing is worth doing, and stops the case permanently — at 2am, on a case that
 * only needed to wait seven hours. The money is not lost to a bad policy, it is lost to a
 * return type. So the verdict is `ALLOW | DEFER | FORBID`, and `DEFER` carries the instant the
 * action becomes available.
 *
 * WHY THE RULES ARE A TABLE AND WHY EVERY RULE IS RECORDED
 * -------------------------------------------------------
 * The Track 3 bar asks for an audit trail. An audit trail that lists only the rule that fired
 * cannot answer the question an auditor actually asks, which is "was this checked at all?" —
 * absence of a violation and absence of a check look identical in the log. So `evaluated`
 * returns one entry per rule, including the rules that did not apply to this action and the
 * ones that applied and passed. It is more verbose and it is the difference between a decision
 * and an assertion.
 *
 * THREE KINDS OF RULE, AND THE KIND DECIDES THE VERDICT
 * ----------------------------------------------------
 *   ABSOLUTE  a compliance boundary. No expected value can buy through it, and the EV scorer
 *             never sees the action. Sourced from `GUARDRAILS.absolute`, which the config
 *             already marks as non-tunable.
 *   BUDGET    a countable resource is spent. Waiting does not replenish it, so FORBID.
 *   TIMING    the action is fine, the moment is not. DEFER, with an instant.
 *
 * Misfiling a rule is the bug this taxonomy is designed to make visible: `minRetryGapHours` as
 * a BUDGET rule permanently forbids a retry that was six hours away from being legal.
 *
 * THE INSTANT A TIMING RULE IS EVALUATED AT IS NOT `now`
 * -----------------------------------------------------
 * `RETRY_SCHEDULED` and any scheduled message carry a `scheduledFor`. Checking quiet hours at
 * the moment of *deciding* rather than the moment of *executing* means a decision taken at
 * 15:00 IST happily schedules a WhatsApp message for 02:40, and every guardrail reports green.
 * `effectiveAt()` below resolves the execution instant, and the timing rules all use it.
 *
 * APPROVAL IS NOT A VETO
 * ----------------------
 * `requiresApproval` is returned alongside the verdict rather than folded into it. An action
 * can be ALLOW and still require a human, which routes it to a queue instead of the gateway.
 * Folding approval into FORBID would silently convert "a human should look at this ₹80,000
 * charge" into "this ₹80,000 is not worth chasing", which is the same class of error as
 * collapsing DEFER into FORBID.
 */

import { GUARDRAILS, POLICY } from '../core/config.js';
import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING, TERMINAL, ACTION_META } from '../core/actions.js';
import { isWithinHourWindow, nextInstantOutsideWindow } from '../core/timezone.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The rolling window the per-customer contact cap is measured over.
 *
 * Exported, and used by `TIM_CUSTOMER_MESSAGE_CAP` below, because the orchestrator has to query the
 * contact ledger over exactly this window and there is no safe way for it to guess. It first read a
 * `GUARDRAILS.customerMessageWindowDays` that does not exist in config, fell back to 7, and agreed
 * with this rule only by luck. The two numbers have to be the same number: counting over 14 days
 * while the rule's deferral instant assumes 7 would block a customer for a fortnight and report a
 * one-week cap while doing it.
 *
 * It is a constant rather than a config knob on purpose. The cap COUNT is tunable
 * (`maxMessagesPerCustomerPer7Days`) because that is a business judgement; the window is baked into
 * the field name every consumer reads, so making it configurable would let a config edit silently
 * falsify the name.
 */
export const CUSTOMER_MESSAGE_WINDOW_DAYS = 7;

export const Verdict = Object.freeze({
  ALLOW: 'ALLOW',
  DEFER: 'DEFER',
  FORBID: 'FORBID',
});

export const RuleKind = Object.freeze({
  ABSOLUTE: 'ABSOLUTE',
  BUDGET: 'BUDGET',
  TIMING: 'TIMING',
});

/** Verdict a violated rule of each kind produces. The whole taxonomy is this mapping. */
const VERDICT_FOR_KIND = Object.freeze({
  [RuleKind.ABSOLUTE]: Verdict.FORBID,
  [RuleKind.BUDGET]: Verdict.FORBID,
  [RuleKind.TIMING]: Verdict.DEFER,
});

/**
 * The instant an action would actually take effect.
 *
 * A scheduled action executes at `scheduledFor`; everything else executes now. Timing rules
 * must be evaluated here and nowhere else — see the header.
 */
export function effectiveAt(action, now) {
  const scheduled = action?.scheduledFor ? new Date(action.scheduledFor) : null;
  if (scheduled && Number.isFinite(scheduled.getTime()) && scheduled.getTime() > new Date(now).getTime()) {
    return scheduled;
  }
  return new Date(now);
}

/** Does this action move money, contact a customer, or neither? */
function shape(action) {
  const kind = action?.kind;
  return {
    kind,
    movesMoney: MONEY_MOVING.has(kind),
    contactsCustomer: CUSTOMER_CONTACTING.has(kind),
    isTerminal: TERMINAL.has(kind),
    isEscalation: kind === ActionKind.ESCALATE_HUMAN,
    isNoop: kind === ActionKind.NO_ACTION_YET,
    meta: ACTION_META[kind] ?? {},
  };
}

/**
 * An action is "automated outbound" if executing it changes something in the outside world
 * without a human having looked. Escalation is deliberately excluded: the rules that forbid
 * automation on a risk-blocked or disputed case are the reason escalation exists, and a rule
 * table that blocked escalation too would leave those cases with no legal action at all.
 */
function isAutomatedOutbound(s) {
  return s.movesMoney || s.contactsCustomer;
}

/**
 * THE RULE TABLE.
 *
 * `applies` decides whether the rule is relevant to this action; `violated` returns null to
 * pass, or `{ message, until? }` to fail. `until` is only read for TIMING rules.
 *
 * Order is presentation order in the audit trail, not precedence — precedence is decided by
 * kind, so reordering this array cannot change a verdict. That property is worth having: a
 * rule table where moving a line changes behaviour is a rule table nobody can safely edit.
 */
export const RULES = Object.freeze([
  // ---- ABSOLUTE -----------------------------------------------------------------------------
  {
    id: 'ABS_KILL_SWITCH',
    kind: RuleKind.ABSOLUTE,
    title: 'Run-level kill switch is off',
    applies: (s) => !s.isNoop,
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.killSwitch ? { message: 'KILL_SWITCH is set; no action executes' } : null,
  },
  {
    id: 'ABS_DO_NOT_DISTURB',
    kind: RuleKind.ABSOLUTE,
    title: 'Customer has not opted out of contact',
    applies: (s) => s.contactsCustomer,
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.absolute.honourDoNotDisturb && ctx.caseState.doNotDisturb
        ? { message: 'customer is on do-not-disturb' }
        : null,
  },
  {
    id: 'ABS_RISK_BLOCKED',
    kind: RuleKind.ABSOLUTE,
    title: 'Case is not flagged by risk',
    applies: (s) => isAutomatedOutbound(s),
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.absolute.neverAutomateRiskBlocked && ctx.caseState.riskBlocked
        ? { message: 'risk has blocked this case; automation is not permitted' }
        : null,
  },
  {
    id: 'ABS_DISPUTED',
    kind: RuleKind.ABSOLUTE,
    title: 'Invoice is not disputed',
    applies: (s) => isAutomatedOutbound(s),
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.absolute.neverAutomateDisputedInvoices && ctx.caseState.disputed
        ? { message: 'invoice is disputed; chasing it automatically is not permitted' }
        : null,
  },
  {
    /**
     * The one absolute rule most likely to be tempting to soften, because a revoked mandate
     * often still reads `active` in our own copy of the subscription and the charge would
     * probably go through. `observe()` passes that disagreement along rather than smoothing
     * it, and this rule fires on the observable it has. Charging on a revoked mandate is a
     * compliance failure, not an action with a poor expected value, so it is not priced — it
     * is refused.
     */
    id: 'ABS_REVOKED_MANDATE',
    kind: RuleKind.ABSOLUTE,
    title: 'Mandate has not been revoked',
    applies: (s) => s.movesMoney,
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.absolute.neverChargeRevokedMandate && ctx.caseState.mandateRevoked
        ? { message: 'mandate is revoked; charging it is not permitted' }
        : null,
  },
  {
    /**
     * Enforced here as well as at the gateway. The gateway check is the one that protects the
     * customer's card; this one protects the audit trail, because an action that reached the
     * scorer without a key would appear in the record as a legitimate candidate that merely
     * lost on expected value.
     */
    id: 'ABS_IDEMPOTENCY_KEY',
    kind: RuleKind.ABSOLUTE,
    title: 'Money movement carries an idempotency key',
    applies: (s) => s.movesMoney && s.meta.requiresIdempotencyKey !== false,
    violated: (_s, ctx) =>
      ctx.config.GUARDRAILS.absolute.requireIdempotencyKeyOnMoneyMovement && !ctx.action.idempotencyKey
        ? { message: 'money movement without an idempotency key' }
        : null,
  },
  {
    /**
     * `humanOnly` causes come from the taxonomy, not from a threshold: a chargeback or a
     * fraud block is not a case the agent is worse at than a human, it is a case the agent
     * has no business touching.
     */
    id: 'ABS_HUMAN_ONLY_CAUSE',
    kind: RuleKind.ABSOLUTE,
    title: 'Diagnosed cause permits automation',
    applies: (s) => isAutomatedOutbound(s),
    violated: (_s, ctx) =>
      ctx.diagnosis?.physics?.humanOnly ? { message: `${ctx.diagnosis.rootCause} is a human-only cause` } : null,
  },

  // ---- BUDGET -------------------------------------------------------------------------------
  {
    id: 'BUD_RETRIES_PER_CASE',
    kind: RuleKind.BUDGET,
    title: 'Retry budget for this case is not spent',
    applies: (s) => Boolean(s.meta.consumesRetry),
    violated: (_s, ctx) => {
      const cap = ctx.config.GUARDRAILS.maxRetriesPerCase;
      return ctx.caseState.retriesUsed >= cap
        ? { message: `${ctx.caseState.retriesUsed} of ${cap} retries already used on this case` }
        : null;
    },
  },
  {
    id: 'BUD_TOUCHES_PER_CASE',
    kind: RuleKind.BUDGET,
    title: 'Touch budget for this case is not spent',
    applies: (s) => Boolean(s.meta.consumesTouch),
    violated: (_s, ctx) => {
      const cap = ctx.config.GUARDRAILS.maxTouchesPerCase;
      return ctx.caseState.touchesUsed >= cap
        ? { message: `${ctx.caseState.touchesUsed} of ${cap} touches already used on this case` }
        : null;
    },
  },
  {
    /**
     * THE TAXONOMY'S COMMENT, MADE ENFORCEABLE.
     *
     * `ROOT_CAUSES.UNKNOWN` carries `retryCanSucceed: true` with the note "allow a single
     * cautious attempt". Nothing made it single and nothing made it cautious. An abstained
     * diagnosis therefore inherited the full three-retry budget, which means the cases we
     * understood least got exactly as many attempts at the customer's card as the cases we
     * understood best.
     *
     * A comment describing a policy is not the policy. One retry on an abstention is a
     * defensible position; three is the absence of a position. The budget is one here, and the
     * approval gate on abstained beliefs (APR_ABSTAINED_DIAGNOSIS) supplies the caution.
     */
    id: 'BUD_ABSTAINED_RETRY_LIMIT',
    kind: RuleKind.BUDGET,
    title: 'Single cautious attempt on an undiagnosed case is unspent',
    applies: (s) => Boolean(s.meta.consumesRetry),
    violated: (_s, ctx) =>
      ctx.diagnosis?.abstained && ctx.caseState.retriesUsed >= 1
        ? {
            message: `diagnosis abstained and ${ctx.caseState.retriesUsed} retry already spent; an undiagnosed case gets one attempt, not ${ctx.config.GUARDRAILS.maxRetriesPerCase}`,
          }
        : null,
  },
  {
    /**
     * Age is filed as a budget rather than a timing rule on purpose. Waiting does not make a
     * stale case legal again; it makes it staler. A timing verdict here would defer the case
     * forward forever, one poll at a time, and it would never appear in any report as
     * abandoned — the worst of both outcomes.
     */
    id: 'BUD_CASE_AGE',
    kind: RuleKind.BUDGET,
    title: 'Case is inside the maximum age',
    applies: (s) => isAutomatedOutbound(s),
    violated: (_s, ctx) => {
      const max = ctx.config.POLICY.maxCaseAgeDays;
      return ctx.caseState.ageDays > max
        ? { message: `case is ${ctx.caseState.ageDays.toFixed(1)} days old, past the ${max}-day limit` }
        : null;
    },
  },
  {
    id: 'BUD_RUN_RETRIES',
    kind: RuleKind.BUDGET,
    title: 'Run-level retry circuit breaker has not tripped',
    applies: (s) => Boolean(s.meta.consumesRetry),
    violated: (_s, ctx) => {
      const cap = ctx.config.GUARDRAILS.maxRetriesPerRun;
      return ctx.runState.retriesThisRun >= cap ? { message: `run cap of ${cap} retries reached` } : null;
    },
  },
  {
    id: 'BUD_RUN_MESSAGES',
    kind: RuleKind.BUDGET,
    title: 'Run-level message circuit breaker has not tripped',
    applies: (s) => s.contactsCustomer,
    violated: (_s, ctx) => {
      const cap = ctx.config.GUARDRAILS.maxMessagesPerRun;
      return ctx.runState.messagesThisRun >= cap ? { message: `run cap of ${cap} messages reached` } : null;
    },
  },

  // ---- TIMING -------------------------------------------------------------------------------
  {
    id: 'TIM_RETRY_GAP',
    kind: RuleKind.TIMING,
    title: 'Minimum gap since the last retry has elapsed',
    applies: (s) => Boolean(s.meta.consumesRetry),
    violated: (_s, ctx) => {
      const { lastRetryAt } = ctx.caseState;
      if (!lastRetryAt) return null;
      const gapMs = ctx.config.GUARDRAILS.minRetryGapHours * HOUR_MS;
      const legalFrom = new Date(new Date(lastRetryAt).getTime() + gapMs);
      // Compared against the EXECUTION instant, so a retry scheduled past the gap is legal
      // even though the gap has not elapsed at decision time. That is the whole point of
      // scheduling, and evaluating at `now` would forbid it.
      return ctx.at.getTime() < legalFrom.getTime()
        ? {
            message: `last retry was ${((ctx.at.getTime() - new Date(lastRetryAt).getTime()) / HOUR_MS).toFixed(1)}h ago, minimum gap is ${ctx.config.GUARDRAILS.minRetryGapHours}h`,
            until: legalFrom,
          }
        : null;
    },
  },
  {
    /**
     * Applies to contact only. A silent retry at 02:40 disturbs nobody — quiet hours protect
     * the customer's attention, not the merchant's ledger. Blanketing money movement with the
     * same window would forbid exactly the overnight retries that catch a salary credit at
     * the start of the month, for no benefit to anyone.
     */
    id: 'TIM_QUIET_HOURS',
    kind: RuleKind.TIMING,
    title: 'Execution instant is outside quiet hours',
    applies: (s) => s.contactsCustomer,
    violated: (_s, ctx) => {
      const window = ctx.config.GUARDRAILS.quietHours;
      if (!isWithinHourWindow(ctx.at, window)) return null;
      return {
        message: `${ctx.at.toISOString()} falls inside quiet hours ${window.startHour}:00-${window.endHour}:00 ${window.timezone}`,
        until: nextInstantOutsideWindow(ctx.at, window),
      };
    },
  },
  {
    /**
     * The cross-case rule. Per-case limits cannot catch the eight-invoices-one-morning
     * failure the config describes, so this reads a ledger keyed by customer.
     *
     * When the ledger cannot say WHEN the window clears, the verdict degrades to FORBID
     * rather than deferring to a guessed instant. Deferring to an optimistic time would send
     * the message early and break the cap; forbidding costs one cycle. An unknown clearing
     * time must not be assumed to be soon.
     */
    id: 'TIM_CUSTOMER_MESSAGE_CAP',
    kind: RuleKind.TIMING,
    title: 'Customer is under the rolling contact cap',
    applies: (s) => s.contactsCustomer,
    violated: (_s, ctx) => {
      const cap = ctx.config.GUARDRAILS.maxMessagesPerCustomerPer7Days;
      const sent = ctx.caseState.customerMessagesInLast7Days ?? 0;
      if (sent < cap) return null;
      const oldest = ctx.caseState.oldestCustomerMessageInWindowAt;
      const message = `customer has had ${sent} of ${cap} permitted messages in the last 7 days`;
      return oldest
        ? { message, until: new Date(new Date(oldest).getTime() + CUSTOMER_MESSAGE_WINDOW_DAYS * DAY_MS) }
        : { message };
    },
  },
  {
    /**
     * `observedWindow` is an ESTIMATE — `observe()` is explicit that the true window may run
     * past it — so the deferred instant is recorded as estimated and the audit trail says so.
     * The alternative, padding the window by an invented margin, would put a number in the
     * decision path that no measurement supports.
     */
    id: 'TIM_ISSUER_DOWNTIME',
    kind: RuleKind.TIMING,
    title: 'Execution instant is outside a known downtime window',
    applies: (s) => s.movesMoney,
    violated: (_s, ctx) => {
      if (!ctx.config.GUARDRAILS.respectDowntimeWindows) return null;
      const w = ctx.caseState.downtimeWindow;
      if (!w?.from || !w?.to) return null;
      const at = ctx.at.getTime();
      if (at < new Date(w.from).getTime() || at >= new Date(w.to).getTime()) return null;
      return {
        message: `${ctx.at.toISOString()} falls inside an observed issuer downtime window ending ${new Date(w.to).toISOString()} (an estimate, not a guarantee)`,
        until: new Date(w.to),
        estimated: true,
      };
    },
  },
]);

/**
 * How much damage an action can do if it turns out to be wrong. Used to bound what a human's
 * signature authorises.
 *
 * A ladder rather than a boolean because the whole point of an approval envelope is that consent
 * to a small thing is not consent to a large one. A reviewer shown "send this customer a payment
 * link" and clicking approve has not authorised a ₹2,99,915 charge against the same case, and an
 * implementation that treated the grant as a per-case boolean would let exactly that happen — with
 * a clean audit trail saying a human approved it.
 */
export const InvasivenessLevel = Object.freeze({ NONE: 0, CONTACT: 1, MONEY: 2 });

export function invasivenessOf(actionOrKind) {
  const kind = typeof actionOrKind === 'string' ? actionOrKind : actionOrKind?.kind;
  if (MONEY_MOVING.has(kind)) return InvasivenessLevel.MONEY;
  if (CUSTOMER_CONTACTING.has(kind)) return InvasivenessLevel.CONTACT;
  return InvasivenessLevel.NONE;
}

/**
 * The approval on this case, if it is a grant that is still worth anything.
 *
 * Fails CLOSED on every ambiguity. A grant with no `grantedAt` cannot be aged, so it is treated as
 * no grant at all rather than as a young one — the alternative is that a malformed or hand-edited
 * record becomes permanent authority, which is the more expensive way to be wrong.
 */
function liveGrant(approval, now, config) {
  if (approval?.state !== 'GRANTED') return null;
  const grantedAt = approval.grantedAt ? new Date(approval.grantedAt).getTime() : NaN;
  if (!Number.isFinite(grantedAt)) return null;
  const validMs = (config.GUARDRAILS.approvalValidForHours ?? 0) * 3_600_000;
  if (new Date(now).getTime() > grantedAt + validMs) return null;
  return approval;
}

/**
 * Does this grant clear this particular approval check for this particular action?
 *
 * Both halves matter. The grant must name the check — a human who was shown "the amount is above
 * the threshold" and approved has cleared that concern and nothing else, so a *different* concern
 * arising later (the diagnosis degraded, the belief lost its support) re-gates the case rather than
 * riding through on consent given for another reason. And the action must sit inside the
 * invasiveness envelope the grant was given for.
 *
 * `?? -1` on the envelope, not `?? 0`: a grant record missing the field authorises nothing at all,
 * rather than silently authorising the bottom rung. Being precise about this one, because I tried
 * to write a test for it and could not: today the difference is UNREACHABLE, because no approval
 * check applies to a NONE-invasiveness action (NO_ACTION_YET, ESCALATE_HUMAN, STOP_PERMANENT), so
 * `?? 0` would behave identically. It is defence in depth against a future rung rather than a
 * live defect being held shut, and `test/guardrails.test.js` pins the reachability argument
 * instead of pretending to pin the branch.
 */
function grantClears({ grant, checkId, s }) {
  if (!grant) return false;
  if (!Array.isArray(grant.clearedCheckIds)) return false;
  if (!grant.clearedCheckIds.includes(checkId)) return false;
  return invasivenessOf(s.kind) <= (grant.approvedInvasiveness ?? -1);
}

/**
 * Reasons an otherwise-permitted action still needs a human before it executes.
 *
 * Each returns null or a string. Kept separate from RULES because these do not change whether
 * the action is legal — only who authorises it.
 */
export const APPROVAL_CHECKS = Object.freeze([
  {
    id: 'APR_LARGE_AMOUNT',
    applies: (s) => isAutomatedOutbound(s),
    reason: (_s, ctx) => {
      const t = ctx.config.GUARDRAILS.humanApprovalThresholdPaise;
      return ctx.caseState.amountPaise >= t
        ? `amount ${ctx.caseState.amountPaise} paise is at or above the ${t} paise approval threshold`
        : null;
    },
  },
  {
    /**
     * Set by `diagnose()` for LLM-tier and TEXT-tier results. TEXT tier was measured at 0.0%
     * accuracy — wrong on all 5 TRAIN and all 13 TEST cases it fired on — so a belief carrying
     * this flag has no business authorising a charge on its own.
     */
    id: 'APR_WEAK_DIAGNOSIS',
    applies: (s) => s.movesMoney,
    reason: (_s, ctx) =>
      ctx.diagnosis?.requiresApprovalForMoneyMovement
        ? `diagnosis reached at ${ctx.diagnosis.matchTier} tier via ${ctx.diagnosis.source} cannot authorise money movement alone`
        : null,
  },
  {
    /**
     * The support gate, added after the arm-selection sweep exposed that
     * `lookupTable.predictRow` returns the global base rate for a cell it has never seen —
     * numerically indistinguishable from an estimate backed by a thousand rows.
     *
     * "This is unlikely to work" and "I have no idea whether this works" are different
     * statements and must not authorise the same charge. Probability alone cannot tell them
     * apart, so support is read here explicitly.
     */
    id: 'APR_UNSUPPORTED_BELIEF',
    applies: (s) => s.movesMoney,
    reason: (_s, ctx) => {
      const support = ctx.belief?.support;
      if (!support || support.state === 'SUPPORTED') return null;
      return `probability for this action rests on ${support.state} evidence (${support.rows ?? 0} supporting rows)`;
    },
  },
  {
    id: 'APR_ABSTAINED_DIAGNOSIS',
    applies: (s) => s.movesMoney,
    reason: (_s, ctx) =>
      ctx.diagnosis?.abstained ? 'diagnosis abstained; no cause was identified for this failure' : null,
  },
]);

/**
 * Evaluate every guardrail against one candidate action.
 *
 * @param action     the candidate, from `enumerateCandidateActions()`
 * @param caseState  our own records for this case — see `normaliseCaseState`
 * @param diagnosis  output of `diagnose()`
 * @param belief     `{ p, support }` for this (case, action) pair; support may be absent
 * @param runState   `{ retriesThisRun, messagesThisRun }`
 * @param now        decision time
 *
 * @returns {{
 *   verdict: string, action: object, effectiveAt: Date, deferUntil: Date|null,
 *   violations: Array, evaluated: Array, requiresApproval: boolean, approvalReasons: string[]
 * }}
 */
export function checkGuardrails({
  action,
  caseState,
  diagnosis = null,
  belief = null,
  runState = { retriesThisRun: 0, messagesThisRun: 0 },
  now = new Date(),
  config = { GUARDRAILS, POLICY },
} = {}) {
  if (!action?.kind) throw new TypeError('checkGuardrails({ action }): action.kind is required');
  if (!caseState) throw new TypeError('checkGuardrails({ caseState }): caseState is required');

  const s = shape(action);
  const at = effectiveAt(action, now);
  const ctx = { action, caseState, diagnosis, belief, runState, now: new Date(now), at, config };

  const evaluated = [];
  const violations = [];

  for (const rule of RULES) {
    const applies = rule.applies(s, ctx);
    if (!applies) {
      evaluated.push({ id: rule.id, kind: rule.kind, title: rule.title, applied: false, passed: true });
      continue;
    }
    const failure = rule.violated(s, ctx);
    if (!failure) {
      evaluated.push({ id: rule.id, kind: rule.kind, title: rule.title, applied: true, passed: true });
      continue;
    }
    const violation = {
      id: rule.id,
      kind: rule.kind,
      title: rule.title,
      message: failure.message,
      until: failure.until ?? null,
      estimated: Boolean(failure.estimated),
    };
    evaluated.push({ ...violation, applied: true, passed: false });
    violations.push(violation);
  }

  /**
   * Verdict resolution. FORBID dominates DEFER, because a forbidden action does not become
   * permitted by waiting and reporting DEFER on one would send the case round the loop
   * forever. Among DEFERs the LATEST instant wins: satisfying the quiet-hours rule at 09:00
   * is useless if the retry gap does not clear until 14:00.
   */
  const forbidding = violations.filter((v) => VERDICT_FOR_KIND[v.kind] === Verdict.FORBID);
  const deferring = violations.filter((v) => VERDICT_FOR_KIND[v.kind] === Verdict.DEFER);

  // A TIMING rule that could not compute an instant degrades to FORBID rather than deferring
  // to an unknown time. See TIM_CUSTOMER_MESSAGE_CAP.
  const undatedDefers = deferring.filter((v) => !v.until);
  const datedDefers = deferring.filter((v) => v.until);

  let verdict = Verdict.ALLOW;
  let deferUntil = null;
  if (forbidding.length > 0 || undatedDefers.length > 0) {
    verdict = Verdict.FORBID;
  } else if (datedDefers.length > 0) {
    verdict = Verdict.DEFER;
    deferUntil = new Date(Math.max(...datedDefers.map((v) => new Date(v.until).getTime())));
  }

  /**
   * A live grant SUPPRESSES the checks it was given for, rather than bypassing this block. The
   * distinction shows up in the audit trail: `clearedByApproval` records which concerns a human
   * signed off and who signed, so "this charge went out above the threshold" is answerable with a
   * name and an instant instead of being invisible because the check never ran.
   */
  const grant = liveGrant(caseState.approval, ctx.now, config);
  const approvalReasons = [];
  const approvalCheckIds = [];
  const clearedByApproval = [];

  for (const check of APPROVAL_CHECKS) {
    if (!check.applies(s, ctx)) continue;
    const reason = check.reason(s, ctx);
    if (!reason) continue;
    if (grantClears({ grant, checkId: check.id, s })) {
      clearedByApproval.push(check.id);
      continue;
    }
    approvalReasons.push(`${check.id}: ${reason}`);
    approvalCheckIds.push(check.id);
  }

  return {
    action,
    verdict,
    effectiveAt: at,
    deferUntil,
    violations,
    evaluated,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
    /**
     * The same reasons as ids, unjoined. Exists so that a grant can be recorded against the exact
     * checks it answers without anyone parsing `"APR_LARGE_AMOUNT: amount 29991500 paise is..."`
     * back apart. A string split on ':' would work today and break the first time a reason text
     * contains a colon.
     */
    approvalCheckIds,
    clearedByApproval,
    approvedBy: grant?.by ?? null,
  };
}

/**
 * Fill in the fields the rule table reads, from an observation plus our own case records.
 *
 * Defaults are deliberately PERMISSIVE for flags and STRICT for counters: a missing
 * `doNotDisturb` means we have no opt-out on file, whereas a missing `retriesUsed` defaulting
 * to anything other than 0 would silently block every fresh case. Both directions are chosen
 * rather than inherited from `??` convenience.
 *
 * `mandateRevoked` is read from the observation, which is the copy that may disagree with the
 * provider. That disagreement is the hazard the generator models on purpose, and reading the
 * observable is what a real deployment would do.
 */
export function normaliseCaseState({ observed, record = {}, now = new Date() } = {}) {
  const occurred = observed?.occurredAt ?? observed?.detectedAt ?? null;
  const ageDays = occurred
    ? Math.max(0, (new Date(now).getTime() - new Date(occurred).getTime()) / DAY_MS)
    : 0;

  return {
    eventId: observed?.eventId ?? record.eventId ?? null,
    customerId: observed?.customerId ?? record.customerId ?? null,
    amountPaise: observed?.amountPaise ?? record.amountPaise ?? 0,
    lossType: observed?.lossType ?? record.lossType ?? null,
    ageDays,

    retriesUsed: record.retriesUsed ?? 0,
    touchesUsed: record.touchesUsed ?? 0,
    lastRetryAt: record.lastRetryAt ?? null,
    lastContactAt: record.lastContactAt ?? null,

    customerMessagesInLast7Days: record.customerMessagesInLast7Days ?? 0,
    oldestCustomerMessageInWindowAt: record.oldestCustomerMessageInWindowAt ?? null,

    doNotDisturb: Boolean(record.doNotDisturb),
    riskBlocked: Boolean(record.riskBlocked),
    disputed: Boolean(record.disputed ?? (observed?.invoice?.flags ?? []).includes('disputed')),
    mandateRevoked: observed?.subscription?.mandateStatus === 'revoked',

    downtimeWindow: record.downtimeWindow ?? observed?.downtime?.observedWindow ?? null,

    /**
     * THE DEFERRAL LEDGER (#67) — how many times this case has already postponed each class of
     * action, which class it postponed last, and the instant it chose to wake at.
     *
     * Surfaced here, in the same shape as every other budget counter, because a deferral limit is
     * exactly a budget: `retriesUsed` bounds how often we may charge, `touchesUsed` bounds how
     * often we may write, and `deferralCounts` bounds how often we may promise to decide later.
     * That the third budget did not exist is why the agent could postpone 4,235 times against 332
     * attempts and never breach a single rule.
     *
     * `deferralWakeAt` is what distinguishes "waiting, legitimately, for an instant still in the
     * future" from "standing on the instant it chose and choosing to wait again". Only the second
     * is the loop, and a rule that could not tell them apart would delete scheduled retries
     * outright — which would look like a fix and would destroy the timing edge Days 5-7 exist to
     * exploit. Defaults follow the STRICT-for-counters convention above: a missing ledger is an
     * empty ledger, never an exhausted one.
     */
    deferralCounts: record.deferral?.counts ?? {},
    deferredClass: record.deferral?.lastClass ?? null,
    deferralWakeAt: record.deferral?.wakeAt ?? null,

    /**
     * The approval record, read from OUR case file rather than from the observation — a human's
     * signature is our own fact about our own process, and nothing the payment provider tells us
     * can grant or revoke it. Passed through unvalidated on purpose: `liveGrant` is the single
     * place that decides whether an approval record means anything, so there is one gate to audit
     * instead of a permissiveness decision duplicated here.
     */
    approval: record.approval ?? null,
  };
}
