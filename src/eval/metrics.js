/**
 * ARM-COMPARABLE METRICS
 * ======================
 *
 * One code path scores all five arms. That is not a tidiness preference — it is the only thing that
 * makes their numbers commensurable. If each arm computed its own summary, a difference between two
 * arms could come from a difference between two summarisers, and no amount of care in the experiment
 * design would rule that out.
 *
 * Five rules this module holds itself to, each one a specific way a metrics layer flatters its author.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 1 — MONEY IS COUNTED TWICE, FROM INDEPENDENT SOURCES, AND THE TWO MUST AGREE.
 * ---------------------------------------------------------------------------------------------
 * `runArm` accumulates `recoveredPaise` as the run proceeds, by summing gateway receipts. This module
 * recomputes the same figure from the FINAL case records in the store and asserts the two match. A
 * disagreement means money was credited with no receipt behind it, or a receipt arrived that no case
 * recorded — both of which are the kind of defect that makes a headline number worthless while
 * looking completely normal. `moneyReconciles` is reported, not assumed, and the CLI refuses to print
 * a comparison when it is false.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 2 — COMPLIANCE IS READ FROM THE PERSISTED TRAIL, NEVER SELF-REPORTED.
 * ---------------------------------------------------------------------------------------------
 * An arm does not get to tell this module how compliant it was. Violations are counted by reading the
 * decision records the orchestrator persisted, looking at the guardrail verdict recorded against the
 * action that was actually EXECUTED. B2 records the true DEFER verdict on the action it then took
 * anyway, so the same query that returns a positive count for B2 returns zero for the compliant arms.
 *
 * The alternative — asking each arm to declare its violations — would mean the most aggressive policy
 * in the set reported its own compliance, which is exactly the arrangement that makes a compliance
 * claim worthless.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 3 — SELF-RECOVERED MONEY IS NEVER SUMMED INTO RECOVERED MONEY.
 * ---------------------------------------------------------------------------------------------
 * They are kept apart at the case field, the case state, the `runArm` return, and here. An arm that
 * credited itself with money that would have arrived anyway would beat B0 by doing nothing at all.
 * `attributedPaise` exists as the explicitly-labelled sum for anyone who wants the gross figure, and
 * it is never the headline.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 4 — EVERY RATE CARRIES ITS DENOMINATOR, AND A NEAR-ZERO DENOMINATOR IS REFUSED.
 * ---------------------------------------------------------------------------------------------
 * This project has already been bitten by per-world money ratios of 3.15x to 329x where three of the
 * denominators were under Rs 6,000. A ratio computed against almost nothing is a division artifact,
 * not a finding. So `ratio()` returns null below a floor and records why, and every rate ships with
 * `n` beside it so no figure can be quoted without its sample size.
 *
 * ---------------------------------------------------------------------------------------------
 * RULE 5 — THE COSTS AN ARM IMPOSES ARE COUNTED, NOT JUST THE MONEY IT COLLECTS.
 * ---------------------------------------------------------------------------------------------
 * Recovering the most rupees is the wrong objective and this project's whole argument is that the
 * wrong objective is measurable. So the summary carries message volume, patience consumed, failed-
 * retry externalities and human-review load, priced with the same `COSTS` the EV policy uses, and a
 * `netPaise` that subtracts them. An arm can win on `recoveredPaise` and lose on `netPaise` — that is
 * a result, and it is invisible to a metrics layer that only counts receipts.
 */

import { COSTS, CONTRIBUTION_MARGIN, POLICY_ARMS, GUARDRAILS } from '../core/config.js';
import { MONEY_MOVING, CUSTOMER_CONTACTING, ActionKind } from '../core/actions.js';
import { RuleKind, RULES, CUSTOMER_MESSAGE_WINDOW_DAYS } from '../agent/guardrails.js';
import { CaseState, AuditType, ExecState } from '../agent/orchestrator.js';
import { ReceiptState } from '../razorpay/gateway.js';
import { Outcome } from '../agent/decide.js';
import { percentile } from '../core/stats.js';

/**
 * Below this, a ratio is a division artifact rather than a comparison.
 *
 * Rs 5,000 in paise. Chosen as the point at which a single mid-sized case no longer dominates the
 * denominator: the generator's amounts run to tens of thousands of rupees, so a denominator under
 * Rs 5,000 can be one case, and "arm A recovered 329x arm B" then means "B recovered one small case
 * and A recovered several". Both the value and its reasoning live here rather than at a call site so
 * that a future reader can disagree with the number without having to rediscover the hazard.
 */
export const RATIO_DENOMINATOR_FLOOR_PAISE = 500_000;

/**
 * A ratio, or null with a stated reason.
 *
 * Returning null rather than Infinity or a large number is deliberate: a number, once returned, gets
 * printed, and a printed 329x is quoted long after the caveat is forgotten. A null cannot be quoted.
 */
export function ratio(numerator, denominator, { floor = RATIO_DENOMINATOR_FLOOR_PAISE } = {}) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return { value: null, reason: 'non-finite input' };
  }
  if (denominator <= 0) {
    return { value: null, reason: 'denominator is zero or negative; a ratio would be meaningless' };
  }
  if (denominator < floor) {
    return {
      value: null,
      reason:
        `denominator ${denominator} paise is below the ${floor} paise floor — a ratio against ` +
        `almost nothing is a division artifact, not a finding. Quote the paired difference instead.`,
    };
  }
  return { value: numerator / denominator, reason: null };
}

/** A rate that carries its own denominator, so it cannot be quoted without n. */
export function rate(hits, n) {
  return { hits, n, value: n > 0 ? hits / n : null };
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

/** Which rule IDs are TIMING, BUDGET, ABSOLUTE — read from the rule table, never restated. */
const KIND_OF_RULE = new Map(RULES.map((r) => [r.id, r.kind]));

/**
 * COUNT WHAT AN ARM ACTUALLY DID TO CUSTOMERS, FROM THE PERSISTED ACTIONS.
 *
 * Reads `store.getActions(runId)` — the attempts that were really written and executed, not the
 * decisions that proposed them. The distinction matters: a decision that was superseded before
 * commit proposed a message that was never sent, and charging an arm for it would penalise the arm
 * whose queue ordering is best at reacting to a spent budget.
 */
async function countExecutedActions(store, runId) {
  const actions = await store.getActions(runId);

  const byKind = {};
  const byChannel = {};
  const byReceiptState = {};
  let retries = 0;
  let messages = 0;
  let escalations = 0;
  let settled = 0;
  let pending = 0;
  let failedRetries = 0;
  let unknownRetries = 0;
  let capturedPaise = 0;

  for (const a of actions) {
    /**
     * `kind` and `channel` are TOP-LEVEL fields on the persisted action record — `putAction` flattens
     * them out of the action object. Reading `a.action.kind` here would return undefined for every
     * record and every count below would be silently zero, which is the failure mode this whole
     * module is built to catch, so it would be embarrassing to introduce it here.
     */
    const kind = a.kind ?? null;
    if (!kind) continue;
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    const channel = a.channel ?? null;
    if (channel) byChannel[channel] = (byChannel[channel] ?? 0) + 1;

    if (MONEY_MOVING.has(kind)) retries += 1;
    if (CUSTOMER_CONTACTING.has(kind)) messages += 1;
    if (kind === ActionKind.ESCALATE_HUMAN) escalations += 1;

    if (a.state === ExecState.SETTLED) settled += 1;
    if (a.state === ExecState.PENDING) pending += 1;

    const receiptState = a.receipt?.state ?? null;
    if (receiptState) byReceiptState[receiptState] = (byReceiptState[receiptState] ?? 0) + 1;

    capturedPaise += a.receipt?.amountCollectedPaise ?? 0;

    /**
     * A retry the issuer actually DECLINED. This is the quantity that carries the
     * `failedRetryPenaltyPaise` externality — the issuer-ratio damage a futile attempt does to every
     * future payment. It is the cost an arm that hammers hopeless instruments accumulates fastest.
     *
     * Keyed on `ReceiptState.FAILED` and NOT on "collected nothing", which is the trap. An UNKNOWN
     * receipt also collected nothing, but UNKNOWN means the gateway timed out and we do not know
     * whether the charge happened. Charging the penalty there would fine an arm for a network fault,
     * and worse, the reconciler later resolves UNKNOWN into CAPTURED or FAILED — so the same attempt
     * would be penalised twice, once while unresolved and once after. Counted separately instead, and
     * reported, because a large `unknownRetries` is itself a finding about the run.
     */
    if (MONEY_MOVING.has(kind) && receiptState === ReceiptState.FAILED) failedRetries += 1;
    if (MONEY_MOVING.has(kind) && receiptState === ReceiptState.UNKNOWN) unknownRetries += 1;
  }

  return {
    total: actions.length,
    byKind,
    byChannel,
    byReceiptState,
    retries,
    messages,
    escalations,
    settled,
    pending,
    failedRetries,
    unknownRetries,
    capturedPaise,
  };
}

/**
 * THE CONTACT CAP, RECONSTRUCTED FROM THE LEDGER INSTEAD OF TAKEN ON TRUST.
 * ------------------------------------------------------------------------
 * `countViolations` reports a cap breach when the GUARDRAIL ENGINE flagged the chosen action as
 * violating `TIM_CUSTOMER_MESSAGE_CAP` and the arm executed it anyway. That is the right definition,
 * and it has one weakness: it is the guardrail engine grading its own homework. If the engine's
 * ledger query were broken — and it has been, it once read a `GUARDRAILS.customerMessageWindowDays`
 * that does not exist and fell back to 7 by luck — it would emit no violation and the metrics would
 * dutifully report perfect compliance.
 *
 * So this walks the actual sent messages and asks the rule's question independently: at each send,
 * how many messages to that customer were already inside the trailing window? Two paths to the same
 * property, and `run.js` asserts they agree. A reconstruction that disagrees with the engine is
 * interesting in either direction: the engine missed a breach, or the engine is refusing sends the
 * rule would allow.
 *
 * THE WINDOW IS THE WHOLE POINT. Counting a customer's messages over the whole RUN and comparing that
 * total against a 7-day cap is wrong for any run longer than 7 days, and `orchestrate-report` shipped
 * exactly that check — correct only while the horizon was 4 days, then reporting "4 of 2, seven
 * customers over the cap" the moment #62 extended it to 10 days, for a policy the eval scores at zero
 * breaches. Four sends across ten days is compliant; the window slides.
 *
 * @param cap the permitted count. Passed rather than read from config so a test can pin the
 *            arithmetic at a cap it chose, instead of asserting against whatever config says today.
 */
export function auditContactWindows(actions, { cap, windowDays = CUSTOMER_MESSAGE_WINDOW_DAYS } = {}) {
  const windowMs = windowDays * 24 * 3_600_000;

  const sends = new Map();
  for (const a of actions) {
    // A message that was PROPOSED but never sent has not contacted anybody. Only settled sends with a
    // channel count — the same rule `countExecutedActions` uses, for the same reason.
    if (!a.channel || a.state !== ExecState.SETTLED) continue;
    const at = new Date(a.startedAt ?? a.settledAt ?? 0).getTime();
    if (!Number.isFinite(at) || at === 0) continue;
    if (!sends.has(a.customerId)) sends.set(a.customerId, []);
    sends.get(a.customerId).push(at);
  }

  let worstInWindow = 0;
  let worstOverWholeRun = 0;
  const breaches = [];

  for (const [customerId, times] of sends) {
    times.sort((x, y) => x - y);
    worstOverWholeRun = Math.max(worstOverWholeRun, times.length);

    let worstHere = 0;
    let breachedAt = null;
    for (const t of times) {
      // Inclusive at both ends: the rule counts what has already been sent, and a message sent at
      // the same instant has been sent. An exclusive upper bound would count the send under audit
      // as not-yet-sent and under-report every window by exactly one.
      const inWindow = times.filter((u) => u >= t - windowMs && u <= t).length;
      if (inWindow > worstHere) worstHere = inWindow;
      if (inWindow > cap && breachedAt === null) breachedAt = new Date(t).toISOString();
    }
    worstInWindow = Math.max(worstInWindow, worstHere);
    if (breachedAt !== null) {
      breaches.push({ customerId, messagesInWindow: worstHere, totalInRun: times.length, breachedAt });
    }
  }

  return {
    cap,
    windowDays,
    /** The largest number of messages any one customer received inside a single rolling window. */
    worstInWindow,
    /**
     * The largest number any one customer received across the ENTIRE run. Reported beside the window
     * figure, never instead of it: on a 10-day run this legitimately exceeds a 7-day cap, and the gap
     * between these two numbers is precisely the bug that used to live here.
     */
    worstOverWholeRun,
    breaches,
    breachedCustomers: breaches.length,
  };
}

/**
 * COUNT COMPLIANCE BREACHES FROM THE DECISION TRAIL.
 *
 * For every decision that resulted in an action being taken, look at the guardrail verdict recorded
 * against the CHOSEN candidate. A violation present on a chosen line means the arm executed an action
 * the shared guardrail engine objected to.
 *
 * Read from the store rather than from an arm's return value — see RULE 2. Note also that this counts
 * only decisions whose outcome was ACT: an arm that proposed something forbidden and then correctly
 * declined to do it has not breached anything, and counting the proposal would punish an arm for
 * considering options, which is the opposite of what an audit trail is for.
 */
async function countViolations(store, runId) {
  const decisions = await store.getDecisions(runId);

  const byRuleId = {};
  const byKind = { [RuleKind.ABSOLUTE]: 0, [RuleKind.BUDGET]: 0, [RuleKind.TIMING]: 0 };
  let actingDecisions = 0;
  let breachingDecisions = 0;
  let quietHoursMessages = 0;
  let contactCapBreaches = 0;

  for (const d of decisions) {
    if (d.outcome !== Outcome.ACT) continue;
    actingDecisions += 1;

    const chosen = (d.candidates ?? []).find((c) => c.chosen);
    const violations = chosen?.violations ?? [];
    if (violations.length === 0) continue;

    breachingDecisions += 1;
    for (const v of violations) {
      byRuleId[v.id] = (byRuleId[v.id] ?? 0) + 1;
      const kind = v.kind ?? KIND_OF_RULE.get(v.id);
      if (kind && byKind[kind] !== undefined) byKind[kind] += 1;
      if (v.id === 'TIM_QUIET_HOURS') quietHoursMessages += 1;
      if (v.id === 'TIM_CUSTOMER_MESSAGE_CAP') contactCapBreaches += 1;
    }
  }

  return {
    actingDecisions,
    breachingDecisions,
    byRuleId,
    byKind,
    /**
     * The two headline compliance figures, named individually because they are the two a merchant
     * would actually be angry about and the two the pitch names out loud.
     */
    quietHoursMessages,
    contactCapBreaches,
    /**
     * Zero for a compliant arm, and asserted as such by the CLI. An ABSOLUTE breach by ANY arm is a
     * bug in this project rather than a property of a policy — no arm, including B2, is permitted to
     * ignore an absolute rule.
     */
    absoluteBreaches: byKind[RuleKind.ABSOLUTE],
  };
}

/**
 * COUNT WHAT THE POLICY REFUSED TO DO, WHICH IS A FEATURE AND NOT AN ABSENCE.
 *
 * `guardrailRefusals` is a headline metric for this project: it is the evidence that compliance is
 * enforced rather than asserted. It counts decisions where the policy wanted something and the
 * guardrail said no — distinct from `violations`, which counts times an arm went ahead regardless.
 *
 * NOTE the deliberate exclusion. Deferral-limit withholding (#67) is NOT counted here, because a
 * withheld candidate is refused by a POLICY limit and not by a compliance rule. Mixing the two would
 * inflate the compliance metric with policy bookkeeping — which is precisely why `applyDeferralLimits`
 * marks candidates `eligible: false` instead of giving them `Verdict.FORBID`.
 */
async function countRefusals(store, runId) {
  const decisions = await store.getDecisions(runId);
  const audit = await store.getAudit(runId);

  let refusedCandidates = 0;
  let decisionsWithAnyRefusal = 0;
  const byRuleId = {};

  for (const d of decisions) {
    let any = false;
    for (const c of d.candidates ?? []) {
      const violations = c.violations ?? [];
      if (violations.length === 0) continue;
      if (c.chosen) continue; // that is a breach, counted elsewhere
      refusedCandidates += 1;
      any = true;
      for (const v of violations) byRuleId[v.id] = (byRuleId[v.id] ?? 0) + 1;
    }
    if (any) decisionsWithAnyRefusal += 1;
  }

  return {
    refusedCandidates,
    decisionsWithAnyRefusal,
    byRuleId,
    /** How often the commitment rule bound. Counted from its own audit type — see #67. */
    deferralsRefused: audit.filter((a) => a.type === AuditType.DEFERRAL_REFUSED).length,
  };
}

/**
 * THE COSTS AN ARM IMPOSED, PRICED WITH THE SAME NUMBERS THE EV POLICY USES.
 *
 * Using `COSTS` here rather than a separate table is what makes `netPaise` an honest scoring of the
 * objective the EV arm optimises. It also means the sensitivity sweep (#58) perturbs the scorer and
 * the score together, so a result cannot survive by being measured with different prices than it was
 * decided with.
 *
 * THE ONE THING THIS DOES NOT PRICE, stated because omitting it silently would be the dishonest
 * version: patience is charged per message beyond the first on a case, which is a crude proxy for a
 * real churn effect. The `patienceUnitPaise` figure is a judgement call (see `config.js`) and it is
 * swept in #58 precisely because the ranking should not depend on it.
 *
 * `table` is injectable for #58 AND IT IS THE MORE IMPORTANT HALF OF THAT PLUMBING. If only the
 * decider were perturbed, the sweep would measure "a policy that believes a wrong price" — a
 * robustness-to-miscalibration question — while claiming to measure "a world where the price is
 * different". Those have opposite interpretations when the ranking moves: the first says the policy is
 * fragile, the second says the world matters. Perturbing both keeps it the second one.
 */
function priceCosts({ actions, escalations, casesTouchedMoreThanOnce, table = COSTS }) {
  const messageCostPaise = sum(
    Object.entries(actions.byChannel).map(([ch, n]) => (table.channel[ch] ?? 0) * n)
  );
  const failedRetryCostPaise = actions.failedRetries * table.failedRetryPenaltyPaise;
  const patienceCostPaise = casesTouchedMoreThanOnce * table.patienceUnitPaise;
  const humanReviewCostPaise = escalations * table.humanReviewPaise;

  return {
    messageCostPaise,
    failedRetryCostPaise,
    patienceCostPaise,
    humanReviewCostPaise,
    totalCostPaise:
      messageCostPaise + failedRetryCostPaise + patienceCostPaise + humanReviewCostPaise,
  };
}

/**
 * Score one arm's completed run.
 *
 * @param result  the object `runArm` returned
 * @param world   the world it ran in, for the exposure denominator
 */
/**
 * THE APPROVAL QUEUE, MEASURED FROM THE RECORDS RATHER THAN FROM THE APPROVER'S OWN TALLY.
 *
 * `runArm` returns what the simulated reviewer says it did. This counts what the case records and the
 * audit trail say happened to them, and the CLI asserts the two agree. Same pattern as the money
 * reconciliation and the contact-cap ledger, for the same reason: the approval gate is a compliance
 * claim, and a compliance claim measured only by the component that implements it is a component
 * grading its own homework.
 *
 * `frozenPaise` is the figure that motivated the whole task. Exposure sitting in `AWAITING_APPROVAL`
 * when the horizon ends is money the arm could neither recover nor rule out — it is not a loss and it
 * is not a win, and reporting recovery rate without it makes the denominator quietly wrong. Before the
 * reviewer existed this was about 72% of Rebound's exposure.
 *
 * THE INEQUALITY, NOT AN EQUALITY. `granted + denied + pendingAtEnd <= requested`, because one case
 * can be queued more than once: a grant is an envelope that expires, and a case whose envelope lapses
 * or whose policy now wants something more invasive comes back for a fresh signature. Asserting
 * equality here would fail the first time the expiry path fired, which would look like a bug in the
 * approver and would in fact be the approval design working.
 */
export function summariseApprovals({ cases, audit }) {
  const pending = cases.filter((c) => c.state === CaseState.AWAITING_APPROVAL);
  const granted = cases.filter((c) => c.approval?.state === 'GRANTED');
  const denied = cases.filter((c) => c.approval?.state === 'DENIED');

  const requestedAudits = audit.filter((a) => a.type === AuditType.APPROVAL_REQUESTED).length;
  const grantedAudits = audit.filter((a) => a.type === AuditType.APPROVAL_GRANTED).length;
  const deniedAudits = audit.filter((a) => a.type === AuditType.APPROVAL_DENIED).length;

  /**
   * Waits as the TRAIL records them, which is the number a compliance reviewer would read. Taken from
   * the audit detail rather than recomputed, so that if `resolveApproval` ever recorded the wrong
   * instant this figure would move and the harness's own tally would not — making the disagreement
   * visible instead of averaging it away.
   */
  const waits = audit
    .filter((a) => a.type === AuditType.APPROVAL_GRANTED || a.type === AuditType.APPROVAL_DENIED)
    .map((a) => a.detail?.waitedHours)
    .filter((h) => Number.isFinite(h));

  return {
    requested: requestedAudits,
    granted: granted.length,
    denied: denied.length,
    grantedAudits,
    deniedAudits,
    pendingAtEnd: pending.length,
    frozenPaise: sum(pending.map((c) => c.amountPaise ?? 0)),
    grantedPaise: sum(granted.map((c) => c.amountPaise ?? 0)),
    deniedPaise: sum(denied.map((c) => c.amountPaise ?? 0)),
    /**
     * Money the reviewer refused. Reported because a denial is terminal, so this is exposure the arm
     * is permanently barred from — a ceiling the policy did not choose and cannot beat. Leaving it out
     * would let a reader read `frozenPaise: 0` as "nothing was blocked".
     */
    waitHoursP50: percentile(waits, 50),
    waitHoursP90: percentile(waits, 90),
    waitHoursMax: percentile(waits, 100),
    /** `false` means more resolutions than requests, which cannot happen and means double-resolution. */
    accountsFor: granted.length + denied.length + pending.length <= requestedAudits,
  };
}

export async function scoreArm({ result, world, config = {} }) {
  const { store, runId, arm } = result;

  /**
   * REFUSE TO SCORE A RUN THAT HAS NOT FINISHED ITS HORIZON.
   *
   * `runArm` can now be paused and resumed, because the live console steps the loop between operator
   * decisions (see `pauseAfterCycles`). A paused run is a truncated run, and truncation biases every
   * figure below in the same direction: cases still in flight have had less time to recover, and cases
   * frozen in the approval queue are cases the policy never spent money failing on. Restraint and
   * interruption look identical in the output.
   *
   * So this throws instead of trusting the caller to remember. `cyclesRun` is checked with `!= null`
   * rather than for truthiness because cycle 0 is a real value.
   */
  if (result.cyclesRun != null && result.cyclesRun < result.horizon.cycles) {
    throw new Error(
      `scoreArm: ${arm} ran ${result.cyclesRun} of ${result.horizon.cycles} cycles and is still paused. ` +
        'A truncated run cannot be scored: unfinished cases have had less time to recover and frozen ' +
        'approvals are money the policy never spent, so every figure would be biased in the flattering ' +
        'direction. Finish the horizon with result.advance() first, or do not score this run.'
    );
  }

  const cases = await store.getCases(runId);

  /**
   * The price and margin tables this score is computed with. Default to the production constants so
   * every existing caller is byte-identical; #58 passes perturbed ones. See `priceCosts` for why the
   * scorer must be perturbed alongside the decider rather than instead of it.
   */
  const costTable = config.COSTS ?? COSTS;
  const marginTable = config.CONTRIBUTION_MARGIN ?? CONTRIBUTION_MARGIN;

  /**
   * MONEY, RECOMPUTED INDEPENDENTLY. See RULE 1. `runArm` summed receipts as it went; this sums the
   * `recoveredPaise` field on the final case records. Two paths to the same number is the only reason
   * either is worth printing.
   */
  const recoveredFromCases = sum(cases.map((c) => c.recoveredPaise ?? 0));
  const selfRecoveredFromCases = sum(cases.map((c) => c.selfRecoveredPaise ?? 0));

  const moneyReconciles = recoveredFromCases === result.recoveredPaise;
  const selfMoneyReconciles = selfRecoveredFromCases === result.selfRecoveredPaise;

  const actions = await countExecutedActions(store, runId);
  const violations = await countViolations(store, runId);
  const refusals = await countRefusals(store, runId);

  /**
   * The contact cap, measured a SECOND way — from the message ledger rather than from the guardrail
   * engine's own verdicts. `run.js` asserts the two agree; see `auditContactWindows`.
   */
  const contactWindows = auditContactWindows(await store.getActions(runId), {
    cap: GUARDRAILS.maxMessagesPerCustomerPer7Days,
  });

  /**
   * The approval queue, counted from the records. Cross-checked against `result.approvals` — what the
   * simulated reviewer believes it did — by the CLI's `approvalsReconcile` invariant.
   */
  const approvals = summariseApprovals({ cases, audit: await store.getAudit(runId) });

  /** Terminal-state census. A diagnostic, not a result — see the HORIZON docblock on state counts. */
  const byState = {};
  for (const c of cases) byState[c.state] = (byState[c.state] ?? 0) + 1;

  /**
   * The two case sets `compareWithinWorld` needs to check the pairing and compute incremental lift.
   *
   * `moneyTerminalEventIds` is every case where money arrived by ANY route. It exists because of the
   * invariant described in `compareWithinWorld`: a customer who was going to pay unprompted by day X
   * pays regardless of what the agent did, so a case that self-recovered under B0 must have money on
   * it under every arm — either the agent got there first, or it self-recovered anyway.
   */
  const selfRecoveredEventIds = cases
    .filter((c) => c.state === CaseState.RECOVERED_SELF)
    .map((c) => c.eventId);
  const moneyTerminalEventIds = cases
    .filter((c) => c.state === CaseState.RECOVERED || c.state === CaseState.RECOVERED_SELF)
    .map((c) => c.eventId);

  const casesTouchedMoreThanOnce = cases.filter((c) => (c.touchesUsed ?? 0) > 1).length;
  const costs = priceCosts({
    actions,
    escalations: byState[CaseState.ESCALATED] ?? 0,
    casesTouchedMoreThanOnce,
    table: costTable,
  });

  /**
   * MARGIN-WEIGHTED RECOVERY, which is the figure the EV policy actually optimises.
   *
   * Recovering Rs 200 of a low-margin sale is worth Rs 70 of contribution, and a policy that spent
   * Rs 7.50 of message and patience cost to get it destroyed value while succeeding. Gross recovery
   * cannot show that; this can. Both are reported, because the gross figure is the one Track 03 asks
   * for and the margin figure is the one that makes the argument.
   *
   * NOTE `c.event.lossType`, not `c.lossType`. The case record has no `lossType` of its own — it
   * carries the whole observable event nested under `event`, and the loss type lives there. Reading
   * `c.lossType` returns undefined, and with a `?? 1.0` fallback EVERY case would silently be priced
   * at full margin, making `contributionPaise` exactly equal to `recoveredPaise` and the whole
   * margin-weighted argument a tautology that still printed a plausible number. So the lookup throws
   * on a miss instead of defaulting: a metric that cannot be computed must fail loudly, because the
   * one thing worse than a missing number is a wrong number nobody can see is wrong.
   */
  const marginFor = (c) => {
    const lossType = c.event?.lossType ?? null;
    const margin = marginTable[lossType];
    if (margin === undefined) {
      throw new Error(
        `metrics: no contribution margin for lossType ${JSON.stringify(lossType)} on case ` +
          `${c.eventId}. Refusing to default to 1.0 — that would silently price every case at full ` +
          `margin and make contributionPaise a copy of recoveredPaise.`
      );
    }
    return margin;
  };
  const contributionPaise = sum(cases.map((c) => (c.recoveredPaise ?? 0) * marginFor(c)));

  /**
   * The same margin weighting applied to money that arrived UNPROMPTED. Not a result on its own —
   * it exists so `compareWithinWorld` can net out the no-agent counterfactual on the contribution
   * basis exactly, weighting each self-recovered rupee by ITS OWN case's margin rather than by some
   * arm-level average. See `netIncrementalPaise`.
   */
  const contributionSelfPaise = sum(cases.map((c) => (c.selfRecoveredPaise ?? 0) * marginFor(c)));

  /**
   * Exposure, recomputed from the case records and cross-checked against the figure the generator
   * computed when it built the world. Same reasoning as the money reconciliation: two independent
   * paths to one number, and a mismatch means the run did not receive the batch it reports on.
   */
  const exposurePaise = sum(cases.map((c) => c.amountPaise ?? 0));
  const exposureReconciles =
    world?.totalExposurePaise === undefined ? null : exposurePaise === world.totalExposurePaise;

  return {
    arm,
    runId,
    seed: world?.seed ?? null,
    split: world?.split ?? null,

    n: cases.length,
    exposurePaise,
    exposureReconciles,

    // ---- money -----------------------------------------------------------------------------
    /** The headline. Gateway-confirmed money the AGENT recovered. Never includes self-recovery. */
    recoveredPaise: result.recoveredPaise,
    /** Money that arrived unprompted. Identical across arms within a world, and asserted so. */
    selfRecoveredPaise: result.selfRecoveredPaise,
    selfRecoveredCount: result.selfRecoveredCount,
    /** The gross figure, explicitly labelled so it can never be mistaken for the headline. */
    attributedPaise: result.recoveredPaise + result.selfRecoveredPaise,
    contributionPaise: Math.round(contributionPaise),
    contributionSelfPaise: Math.round(contributionSelfPaise),
    netPaise: Math.round(contributionPaise) - costs.totalCostPaise,
    recoveryRate: rate(result.recoveredPaise, exposurePaise),

    /** RULE 1. The CLI refuses to print a comparison when either of these is false. */
    moneyReconciles,
    selfMoneyReconciles,
    recoveredFromCases,
    selfRecoveredFromCases,

    // ---- effort and cost -------------------------------------------------------------------
    attempts: result.attempts,
    actions,
    costs,
    /** Money recovered per attempt. The figure that separates "effective" from merely "busy". */
    paisePerAttempt: result.attempts > 0 ? Math.round(result.recoveredPaise / result.attempts) : null,

    // ---- compliance ------------------------------------------------------------------------
    violations,
    contactWindows,
    refusals,
    /**
     * The human-in-the-loop column. Belongs under compliance rather than under money because the
     * headline it supports is not "we recovered more" — it is "we recovered it with a named human
     * authorising everything above Rs 25,000, and here is how long that took and what they refused".
     */
    approvals,
    /** What the simulated reviewer believes it did. The CLI asserts this matches `approvals`. */
    approverReport: result.approvals ?? null,

    // ---- shape of the run ------------------------------------------------------------------
    byState,
    selfRecoveredEventIds,
    moneyTerminalEventIds,
    cyclesRun: result.cycles.length,
    stoppedEarlyAfter: result.stoppedEarlyAfter,
    /**
     * Cases the policy explicitly closed. A stopping rule is part of the Track 03 bar, and an arm
     * with no stopping rule leaves cases open forever — which looks like patience and is negligence.
     */
    stoppedCases: byState[CaseState.STOPPED] ?? 0,
    unresolvedCases:
      (byState[CaseState.OPEN] ?? 0) +
      (byState[CaseState.SCHEDULED] ?? 0) +
      (byState[CaseState.AWAITING_APPROVAL] ?? 0),
    pendingActions: actions.pending,
  };
}

/**
 * COMPARE ARMS WITHIN ONE WORLD.
 *
 * Everything here is a PAIRED comparison: same world, same luck, same clock, same fitted model. The
 * pairing is established by `harness.js` and this module's job is not to undo it by comparing across
 * worlds. So there is no averaging over worlds in this function — that happens in `poolAcrossWorlds`
 * below, and it happens on paired DIFFERENCES rather than on ratios.
 */
export function compareWithinWorld(scored) {
  const byArm = new Map(scored.map((s) => [s.arm, s]));
  const b0 = byArm.get(POLICY_ARMS.B0_DO_NOTHING.id) ?? null;

  /**
   * =============================================================================================
   * THE COUNTERFACTUAL, AND THE INVARIANT I ORIGINALLY GOT WRONG.
   * =============================================================================================
   * My first version of this function asserted that `selfRecoveredPaise` must be IDENTICAL across
   * arms, on the reasoning that self-recovery is a property of the world. The first run failed it:
   * B0 self-recovered Rs 14,370 and all four active arms self-recovered exactly Rs 0.
   *
   * The harness was right and the assertion was wrong. `applySelfRecovery` skips a case only when
   * money has ALREADY arrived, so when an active arm recovers a case on day 2 that would have paid
   * unprompted on day 9, that case is legitimately no longer available to self-recover. The world's
   * self-recovery PROPENSITY is shared; the REALISED total cannot be, and an arm that forced it to be
   * would be double-counting the same rupees.
   *
   * Two things follow, and the second is the important one.
   *
   * (1) The invariant that does hold, checked below. A customer who was going to pay unprompted by
   *     day X does not consult our case state first — so every case B0 self-recovered must carry
   *     money under every other arm too, by one route or the other. If a case self-recovers under B0
   *     and ends OPEN or STOPPED with nothing on it under some active arm, the arms are not seeing
   *     the same world and every comparison here is void. That is a real leak detector; the identity
   *     assertion was not.
   *
   * (2) GROSS RECOVERY OVERSTATES WHAT THE AGENT ACHIEVED, and by a lot. In the first 40-case world,
   *     ONE case worth Rs 14,370 self-recovered under B0 and was agent-recovered under every active
   *     arm. Rebound's gross figure was Rs 21,347 — so roughly two thirds of its headline was money
   *     that would have arrived with no agent at all. Quoting the gross number as "money recovered"
   *     would have been the single most misleading thing in this project.
   *
   *     Hence `incrementalPaise`: what the arm collected, less what would have arrived anyway. B0's
   *     attributed total IS the no-agent counterfactual, which is the entire reason B0 is in the set.
   *     Note this leaves the arm-vs-arm paired differences unchanged — the B0 term is common to all
   *     of them and cancels — so it does not flatter or penalise any comparison between policies. It
   *     only corrects the "versus doing nothing" claim, which is the one a judge will ask about.
   */
  const counterfactualPaise = b0 ? b0.recoveredPaise + b0.selfRecoveredPaise : null;

  /**
   * The same counterfactual, margin-weighted. B0 takes no action, so all of its money is self-
   * recovery and its contribution basis is just `contributionSelfPaise`. Kept separate from the
   * cash figure above because netting a contribution against a cash counterfactual would subtract
   * rupees from a quantity that is not measured in rupees of revenue.
   */
  const counterfactualContributionPaise = b0 ? b0.contributionPaise + b0.contributionSelfPaise : null;

  let selfRecoveryCounterfactualHolds = null;
  const counterfactualLeaks = [];
  if (b0) {
    selfRecoveryCounterfactualHolds = true;
    for (const s of scored) {
      if (s.arm === b0.arm) continue;
      const hasMoney = new Set(s.moneyTerminalEventIds);
      for (const id of b0.selfRecoveredEventIds) {
        if (!hasMoney.has(id)) {
          selfRecoveryCounterfactualHolds = false;
          counterfactualLeaks.push({ arm: s.arm, eventId: id });
        }
      }
    }
  }

  /**
   * B0's own agent-side recovery must be exactly zero. B0 takes no action, so a non-zero figure means
   * money reached an arm through a path that is not an action — and every arm shares that path, so
   * every number in the table would be inflated together and the comparison would still look sane.
   */
  const b0RecoveredZero = b0 ? b0.recoveredPaise === 0 : null;

  const b3 = byArm.get(POLICY_ARMS.B3_FIXED_LADDER.id) ?? null;

  const rows = scored.map((s) => {
    const attributed = s.recoveredPaise + s.selfRecoveredPaise;
    return {
      arm: s.arm,
      n: s.n,
      recoveredPaise: s.recoveredPaise,
      selfRecoveredPaise: s.selfRecoveredPaise,
      attributedPaise: attributed,
      /**
       * THE HEADLINE. Money that exists because the agent ran. Null when B0 is absent from the set,
       * because without the counterfactual arm there is nothing to subtract and a gross figure
       * presented as incremental is precisely the error this field exists to prevent.
       */
      incrementalPaise: counterfactualPaise === null ? null : attributed - counterfactualPaise,
      netPaise: s.netPaise,
      contributionPaise: s.contributionPaise,
      /**
       * NET ON THE INCREMENTAL BASIS — added because printing `netPaise` beside `incrementalPaise`
       * invites a misread that survives inspection.
       *
       * `netPaise` is margin-weighted GROSS agent recovery minus cost. `incrementalPaise` nets out
       * B0. Those are different bases, and when an arm cannibalises self-recovery they diverge hard
       * in the FLATTERING direction: in seed 5, B1 showed net Rs 77,454 beside incremental Rs 49,550,
       * because B1 got to cases first and the world's realised self-recovery collapsed from
       * Rs 35,246 to Rs 1,585. A reader scanning two adjacent money columns reasonably assumes one
       * basis, and would take the larger number as the better one.
       *
       * So: the arm's TOTAL margin-weighted money (agent + self) less the no-agent counterfactual's
       * margin-weighted money, less the arm's costs. Every rupee is weighted by ITS OWN case's
       * margin on both sides of the subtraction — no arm-level average — so a policy cannot gain by
       * cannibalising high-margin self-recovery. The result answers "contribution the agent created,
       * after costs, that would not have existed without it", which is the only net figure worth
       * putting next to an incremental one. Null when B0 is absent, as `incrementalPaise` is.
       */
      netIncrementalPaise:
        counterfactualContributionPaise === null
          ? null
          : s.contributionPaise +
            s.contributionSelfPaise -
            counterfactualContributionPaise -
            s.costs.totalCostPaise,
      attempts: s.attempts,
      messages: s.actions.messages,
      retries: s.actions.retries,
      failedRetries: s.actions.failedRetries,
      quietHoursMessages: s.violations.quietHoursMessages,
      contactCapBreaches: s.violations.contactCapBreaches,
      /**
       * The ledger-side reconstruction of the same rule, flattened onto the row beside the
       * engine-side count so a reader comparing them does not have to know they come from two
       * different subsystems. `worstContactWindow` is the useful diagnostic even when there is no
       * breach: at the cap it means the control is BINDING, and at zero it means it never engaged.
       */
      contactCapBreachedCustomers: s.contactWindows.breachedCustomers,
      worstContactWindow: s.contactWindows.worstInWindow,
      worstContactsOverWholeRun: s.contactWindows.worstOverWholeRun,
      absoluteBreaches: s.violations.absoluteBreaches,
      guardrailRefusals: s.refusals.refusedCandidates,
      deferralsRefused: s.refusals.deferralsRefused,
      stoppedCases: s.stoppedCases,
      unresolvedCases: s.unresolvedCases,
      /**
       * THE HUMAN-IN-THE-LOOP COLUMNS.
       *
       * `frozenPaise` is the one to read first and it is the reason #61 exists: exposure still sitting
       * in the approval queue when the horizon ends. That money is neither recovered nor ruled out, so
       * an arm with a large frozen figure has not been measured so much as interrupted. Before the
       * simulated reviewer existed it was about 72% of Rebound's exposure and the queue never emptied
       * because nothing ever answered it.
       *
       * `approvalsDeniedPaise` is the honest counterweight. A denial is terminal, so this is exposure
       * the arm is permanently barred from by a human decision it does not control. Reporting the
       * frozen figure without it would let a reader take `frozen: 0` for "nothing was blocked".
       */
      approvalsRequested: s.approvals.requested,
      approvalsGranted: s.approvals.granted,
      approvalsDenied: s.approvals.denied,
      approvalsPending: s.approvals.pendingAtEnd,
      frozenPaise: s.approvals.frozenPaise,
      approvalsDeniedPaise: s.approvals.deniedPaise,
      approvalWaitP50: s.approvals.waitHoursP50,
      approvalWaitP90: s.approvals.waitHoursP90,
      /**
       * Both sides of `approvalsReconcile`, on the row, so its failure message can print the
       * comparison instead of half of it. When this invariant first fired it printed only the
       * case-record side, which told the reader nothing about what disagreed with what and sent me to
       * a probe to find out. A two-sided invariant owes its reader both numbers.
       *
       * `...Audits` counts DECISIONS from the audit trail and is what the reviewer's tally is compared
       * against; `approvalsGranted` above counts CASES ending in that state, and the two differ
       * legitimately whenever a grant envelope expires and the case returns for a fresh signature.
       */
      approvalsGrantedAudits: s.approvals.grantedAudits,
      approvalsDeniedAudits: s.approvals.deniedAudits,
      approverSaysGranted: s.approverReport?.granted ?? null,
      approverSaysDenied: s.approverReport?.denied ?? null,
      /**
       * PAIRED DIFFERENCES against B3, the honest baseline — fully compliant and competently
       * designed. Rebound beating B2 proves little, because B2 breaks rules to get there; beating B0
       * proves only that acting beats not acting.
       *
       * Differences, not ratios: this project has already been burned by per-world ratios computed
       * against near-zero denominators. `ratio()` is floored and available, but the difference is
       * what gets pooled and quoted.
       */
      vsB3RecoveredPaise: b3 ? s.recoveredPaise - b3.recoveredPaise : null,
      vsB3NetPaise: b3 ? s.netPaise - b3.netPaise : null,
      vsB3Ratio: b3 ? ratio(s.recoveredPaise, b3.recoveredPaise) : null,
    };
  });

  return {
    seed: scored[0]?.seed ?? null,
    split: scored[0]?.split ?? null,
    counterfactualPaise,
    rows,
    invariants: {
      /**
       * The corrected pairing check. See the long note above for why the obvious "self-recovery is
       * identical across arms" assertion is false and this one is not.
       */
      selfRecoveryCounterfactualHolds,
      counterfactualLeaks,
      b0RecoveredZero,
      /** Every arm must reconcile, or nothing in this world may be quoted. */
      allMoneyReconciles: scored.every((s) => s.moneyReconciles && s.selfMoneyReconciles),
      allExposureReconciles: scored.every((s) => s.exposureReconciles !== false),
      /** No arm, not even B2, may breach an absolute rule. */
      noAbsoluteBreaches: scored.every((s) => s.violations.absoluteBreaches === 0),
      /**
       * THE GUARDRAIL ENGINE AND THE MESSAGE LEDGER MUST TELL THE SAME STORY.
       *
       * `violations.contactCapBreaches` is the engine reporting on itself: it counts actions the
       * engine flagged as over the cap and the arm sent anyway. `contactWindows.breachedCustomers`
       * is an independent reconstruction from the sent messages. A compliant arm must be at zero on
       * both, and a rule-breaking arm must be non-zero on both.
       *
       * A DISAGREEMENT IS INTERESTING IN EITHER DIRECTION, which is why this is an equality of
       * signs rather than of counts (they count different units — actions versus customers). Engine
       * silent while the ledger shows a breach means the engine's ledger query is broken and every
       * "zero breaches" claim in this project is worthless. Engine noisy while the ledger is clean
       * means the engine is refusing sends the rule permits, and the compliant arms are being
       * needlessly throttled — which would understate Rebound rather than flatter it, but is still
       * a bug and still worth knowing.
       */
      contactCapAgrees: scored.every(
        (s) => (s.violations.contactCapBreaches > 0) === (s.contactWindows.breachedCustomers > 0)
      ),
      /**
       * THE APPROVER'S OWN TALLY MUST MATCH THE AUDIT TRAIL, EVENT FOR EVENT.
       *
       * `approverReport` is what `createSimApprover` believes it did; the audit counts are what
       * `resolveApproval` actually persisted. They are produced by different code reading different
       * state. A mismatch means a resolution was reported but not written, or written twice — either
       * way the frozen-exposure figure is wrong, and wrong in the direction that makes the approval
       * gate look cheaper than it is.
       *
       * IT MUST BE THE AUDIT COUNTS AND NOT `granted`/`denied`, AND THAT COST A RUN TO LEARN. This
       * invariant first compared against `s.approvals.granted`, the per-case census, and failed in all
       * five worlds. The numbers said why: Rebound's reviewer logged 19 grants while only 9 cases ENDED
       * in GRANTED, because 7 cases had their authorisation envelope expire and came back for a fresh
       * signature — one of them four times. Those are not two measurements of one quantity. A census of
       * final states counts CASES; the reviewer's log counts DECISIONS; and a case can legitimately
       * collect several decisions over ten days. `summariseApprovals`'s own docblock says exactly this
       * about `accountsFor` being an inequality, and I wired an equality to the wrong field anyway.
       *
       * Denials are the useful sanity check on the pairing: they are terminal, so they cannot repeat,
       * and they matched 9 to 9 on both sides even while the grants disagreed 19 to 9.
       */
      approvalsReconcile: scored.every(
        (s) =>
          s.approverReport === null ||
          (s.approverReport.granted === s.approvals.grantedAudits &&
            s.approverReport.denied === s.approvals.deniedAudits)
      ),
      /**
       * NO ARM MAY RESOLVE MORE APPROVALS THAN IT REQUESTED.
       *
       * Separate from the check above because it catches a different failure: double-resolution. The
       * idempotency guard in `resolveApproval` exists precisely because a case can be handed to the
       * reviewer twice by a retried call, and if that guard ever regressed, a case could be granted
       * and then granted again — inflating the granted count, and, more seriously, restarting the
       * grant's expiry clock so a stale authorisation reads as fresh.
       */
      approvalsAccountedFor: scored.every((s) => s.approvals.accountsFor),
      /**
       * THE REVIEWER MUST HAVE BEEN THE SAME PERSON FOR EVERY ARM.
       *
       * This is the SAME LUCK invariant (harness.js #2) applied to the approver, and it is the check I
       * would want a sceptical judge to look at, because the alternative failure is invisible. The
       * approver's RNG stream is keyed on the world seed and the eventId and deliberately NOT on the
       * arm — so any case that reached the queue under two different arms must have received the SAME
       * verdict from the reviewer under both.
       *
       * If a stray `arm` or `cycle` ever entered that seed, arms would face different reviewers, the
       * high-value cases would be granted to one and refused to another, and the difference would land
       * directly in the headline money column while every other invariant in this file still passed.
       *
       * Only cases the reviewer actually ANSWERED are compared. A case queued under one arm and never
       * queued under another is not a disagreement — it is the policies differing, which is the thing
       * being measured.
       */
      approverIsArmBlind: (() => {
        const verdicts = new Map();
        for (const s of scored) {
          for (const a of s.approverReport?.resolved ?? []) {
            if (!verdicts.has(a.eventId)) verdicts.set(a.eventId, new Set());
            verdicts.get(a.eventId).add(a.state);
          }
        }
        return [...verdicts.values()].every((states) => states.size === 1);
      })(),
    },
  };
}

/**
 * POOL PAIRED DIFFERENCES ACROSS WORLDS.
 *
 * The unit of analysis is the WORLD, and the quantity is the paired difference between two arms
 * within it. Pooling differences rather than ratios is what keeps a world whose baseline recovered
 * almost nothing from dominating the summary — the 329x problem.
 *
 * WHAT IS DELIBERATELY NOT HERE: a p-value. With five worlds, a t-statistic on paired differences is
 * reportable but weak, and this project's standing rule is to measure the mechanism rather than buy
 * power. So this returns the mean, the spread, the sign count and n, and the CLI prints all four
 * together. "Up in 5 of 5 worlds, mean +Rs 3.1L, range +Rs 2.2L to +Rs 5.4L, n=5" is a more honest
 * sentence than any single number with a star next to it.
 */
export function poolAcrossWorlds({ perWorld, armId, versusArmId }) {
  const diffs = [];
  const nets = [];
  const incrementals = [];
  const netIncrementals = [];

  for (const world of perWorld) {
    const a = world.rows.find((r) => r.arm === armId);
    const b = world.rows.find((r) => r.arm === versusArmId);
    if (!a || !b) continue;
    diffs.push(a.recoveredPaise - b.recoveredPaise);
    nets.push(a.netPaise - b.netPaise);
    /**
     * The paired difference in INCREMENTAL money, which is NOT the same as the gross difference.
     *
     * An earlier version of this comment asserted they were identical "by construction, because both
     * arms subtract the same B0 counterfactual and it cancels". The B0 term does cancel. The SELF
     * term does not, and that is the entire content of the corrected counterfactual invariant above:
     * realised self-recovery differs BETWEEN arms, because an arm that reaches a case first stops it
     * from self-recovering later. So
     *
     *     incremental(A) - incremental(B) = (rec_A - rec_B) + (self_A - self_B)
     *
     * and the second bracket is only zero when both arms cannibalised identically. Measured on the
     * five-world default: gross mean +Rs 11,398 against incremental mean +Rs 11,168 — a real Rs 230
     * gap that the old comment told the reader to expect to be zero. An arm that wins gross partly by
     * getting to money that was coming anyway wins less on this line, which is the correct penalty
     * and the reason this is pooled separately rather than assumed redundant.
     */
    /**
     * `Number.isFinite`, not `!== null`. A missing field is `undefined`, which passes a null check
     * and then pushes `undefined - undefined === NaN` into the pool, where it silently poisons the
     * mean and the sd while `n` still reads 5. Checking for a finite number rejects null, undefined
     * and NaN alike, so an arm that failed to produce the figure is EXCLUDED and visible in `n`
     * rather than averaged in as garbage.
     */
    if (Number.isFinite(a.incrementalPaise) && Number.isFinite(b.incrementalPaise)) {
      incrementals.push(a.incrementalPaise - b.incrementalPaise);
    }
    /** Net on the incremental basis. See `netIncrementalPaise` for why gross net is not enough. */
    if (Number.isFinite(a.netIncrementalPaise) && Number.isFinite(b.netIncrementalPaise)) {
      netIncrementals.push(a.netIncrementalPaise - b.netIncrementalPaise);
    }
  }

  const stats = (xs) => {
    if (xs.length === 0) return { n: 0, mean: null, min: null, max: null, positive: 0, negative: 0 };
    const mean = sum(xs) / xs.length;
    return {
      n: xs.length,
      mean: Math.round(mean),
      min: Math.min(...xs),
      max: Math.max(...xs),
      positive: xs.filter((x) => x > 0).length,
      negative: xs.filter((x) => x < 0).length,
      /**
       * Sample standard deviation, n-1. Reported so the spread is visible, NOT to be turned into a
       * confidence interval at n=5 — see the docblock above.
       */
      sd:
        xs.length > 1
          ? Math.round(Math.sqrt(sum(xs.map((x) => (x - mean) ** 2)) / (xs.length - 1)))
          : null,
    };
  };

  /**
   * POOLED TOTALS, which is how a money ratio may legitimately be quoted. Summing both arms across
   * all worlds first and dividing once avoids the near-zero denominators that make per-world ratios
   * meaningless — the same reasoning that produced the "quote 9.55x pooled, never the per-world
   * 329x" rule from #67.
   *
   * `incrementalRatio` is the one to quote when the comparison is against doing nothing, because a
   * gross ratio against B0 divides by B0's agent-side zero and a gross ratio against an active arm
   * still has the counterfactual sitting inside both halves, inflating both toward 1.0 and making a
   * real difference look small.
   */
  const pooledOf = (id, field) =>
    sum(perWorld.map((w) => w.rows.find((r) => r.arm === id)?.[field] ?? 0));

  const pooledA = pooledOf(armId, 'recoveredPaise');
  const pooledB = pooledOf(versusArmId, 'recoveredPaise');
  const pooledIncA = pooledOf(armId, 'incrementalPaise');
  const pooledIncB = pooledOf(versusArmId, 'incrementalPaise');

  return {
    armId,
    versusArmId,
    recovered: stats(diffs),
    net: stats(nets),
    incremental: stats(incrementals),
    netIncremental: stats(netIncrementals),
    pooled: {
      armPaise: pooledA,
      versusPaise: pooledB,
      differencePaise: pooledA - pooledB,
      ratio: ratio(pooledA, pooledB),
      armIncrementalPaise: pooledIncA,
      versusIncrementalPaise: pooledIncB,
      incrementalDifferencePaise: pooledIncA - pooledIncB,
      incrementalRatio: ratio(pooledIncA, pooledIncB),
    },
    /**
     * The sentence a reader should quote, assembled here so that the caveats travel with the number
     * instead of being left behind in a docblock.
     */
    howToQuote:
      `Paired within ${diffs.length} worlds. Quote the mean paired difference with its range and ` +
      `sign count, or the pooled ratio. Never a per-world ratio — see RULE 4. When the claim is ` +
      `"versus doing nothing", quote the INCREMENTAL figure: gross recovery includes money that ` +
      `would have arrived unprompted, which in the first 40-case world was two thirds of the total.`,
  };
}
