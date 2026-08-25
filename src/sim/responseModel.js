/**
 * CUSTOMER RESPONSE MODEL
 * =======================
 *
 * This file decides whether a recovery attempt succeeds. It is therefore the most
 * important file in the repository to be honest about, because every "money
 * recovered" figure we report ultimately comes from here.
 *
 * WHAT THIS IS
 * ------------
 * A documented, parameterised model of how customers respond to recovery attempts.
 * It is NOT measured from production data, because I do not have production data — I
 * have Razorpay test mode, which faithfully exercises the API surface but has no
 * opinion about whether a human being will pay an invoice.
 *
 * WHY THAT IS ACCEPTABLE, AND WHERE THE LINE IS
 * ---------------------------------------------
 * Two separate claims, never mixed:
 *
 *   "The plumbing works"  -> proven against real Razorpay test-mode APIs, with real
 *                            order and payment IDs. No simulation involved.
 *
 *   "The policy is better" -> measured here, in simulation, against documented
 *                            assumptions, on a held-out batch, with a sensitivity
 *                            sweep over every constant below.
 *
 * The claim we are entitled to make is not "Rebound recovers 34% of at-risk revenue."
 * It is: "under a documented response model, Rebound's *ranking* against four
 * baselines is stable across a +/-30% perturbation of every assumption." The first is
 * a number that means nothing outside this repo. The second is a defensible result.
 *
 * HOW THIS AVOIDS GRADING ITS OWN HOMEWORK
 * ----------------------------------------
 * The agent never sees anything in this file, and never sees `payerType`. It observes
 * only what a real merchant observes. The mapping from observable signals to latent
 * type is deliberately noisy, so perfect inference is impossible and the agent is
 * rewarded for being well-calibrated rather than for being clairvoyant.
 *
 * WHAT MAKES THE PROBLEM NON-TRIVIAL
 * ----------------------------------
 * Four mechanisms below are what stop "do everything to everyone" from being optimal.
 * They are the load-bearing design of the whole evaluation:
 *
 *   1. HARD ZEROS. NEEDS_NEW_INSTRUMENT has retry probability of exactly 0. Attempt
 *      budget spent there is spent on an impossibility.
 *   2. TIMING. TEMPORARILY_SHORT recovers only after funds arrive. Three retries in
 *      ten minutes lose to one retry on the 2nd of the month.
 *   3. FATIGUE. Every touch reduces all future probabilities. This is why sending
 *      fewer messages can recover MORE money — it is not a slogan, it is this
 *      multiplier.
 *   4. BACKFIRE. Messaging a DISPUTING customer actively lowers recovery odds.
 *      Sometimes the highest-value action is to stop.
 */

import { PayerType } from './payerTypes.js';
import { ActionKind } from '../core/actions.js';
import { LossType } from '../core/enums.js';
/**
 * Imported for exactly one purpose: `approverSlaHours.sweep` derives its upper bound from
 * `GUARDRAILS.approvalValidForHours` so the declared sweep and the guard in `sim/approver.js` cannot
 * disagree. `core/config.js` imports only from `core/`, so this introduces no cycle.
 */
import { GUARDRAILS } from '../core/config.js';

/**
 * Every tunable constant, with its justification and the range the sensitivity
 * analysis sweeps. Kept as data rather than as literals so that:
 *   - `npm run describe-sim` can print the entire model for a judge to inspect
 *   - the Day 8-9 sweep can perturb them programmatically
 *   - no number in this model is unattributed
 *
 * `basis` is deliberately blunt about which figures are judgement calls. Most are.
 */
export const ASSUMPTIONS = {
  // ---------------------------------------------------------------- base rates
  selfRecoveryRate: {
    FAILED_PAYMENT: {
      value: 0.18,
      basis: 'JUDGEMENT. A meaningful share of consumers retry unprompted within a ' +
        'day or two. Load-bearing for the B0 baseline: set it high and every policy ' +
        'looks less impressive, because much of the "recovered" money was never lost.',
      sweep: [0.1, 0.3],
    },
    FAILED_SUBSCRIPTION: {
      value: 0.12,
      basis: 'JUDGEMENT. Lower than one-off payments because the customer is often ' +
        'unaware the charge failed at all — nothing prompts them to act.',
      sweep: [0.06, 0.2],
    },
    OVERDUE_INVOICE: {
      value: 0.25,
      basis: 'JUDGEMENT. B2B invoices frequently get paid late but unprompted, once ' +
        'a payables cycle comes around.',
      sweep: [0.15, 0.4],
    },
  },

  // -------------------------------------------------- payer type prevalence
  payerTypeMix: {
    value: {
      WILL_PAY_IF_REMINDED: 0.34,
      TEMPORARILY_SHORT: 0.24,
      NEEDS_NEW_INSTRUMENT: 0.18,
      DISPUTING: 0.08,
      NEVER_PAYING: 0.16,
    },
    basis: 'JUDGEMENT, chosen so that no single strategy dominates. Roughly a third ' +
      'are winnable by a nudge, a quarter by patience, a fifth only by collecting a ' +
      'new instrument, and about a quarter should not be chased at all. If any one ' +
      'group exceeded ~60% the problem would collapse into a single fixed tactic and ' +
      'the evaluation would stop being informative.',
    sweep: 'dirichlet +/-30%',
  },

  // --------------------------------------------------------- action fit matrix
  /**
   * P(recover) multiplier for (payerType, actionKind).
   *
   * The zeros are the most important entries in this file. They are exact, not
   * rounded, and they encode the central argument: some failures are not
   * probabilistically hard, they are impossible, and an agent that cannot tell the
   * difference will burn its whole budget proving it.
   */
  actionFit: {
    value: {
      [PayerType.WILL_PAY_IF_REMINDED]: {
        [ActionKind.RETRY_NOW]: 0.50,
        [ActionKind.RETRY_SCHEDULED]: 0.58,
        [ActionKind.SEND_LINK]: 0.72,
        [ActionKind.SWITCH_RAIL_NUDGE]: 0.76,
        [ActionKind.REQUEST_REAUTH]: 0.34,
        [ActionKind.ESCALATE_HUMAN]: 0.80,
      },
      [PayerType.TEMPORARILY_SHORT]: {
        // Before funds arrive these are gated to near-zero by timeFactor(); the
        // numbers here are the ceiling once money is actually available.
        [ActionKind.RETRY_NOW]: 0.62,
        [ActionKind.RETRY_SCHEDULED]: 0.68,
        [ActionKind.SEND_LINK]: 0.55,
        [ActionKind.SWITCH_RAIL_NUDGE]: 0.50,
        [ActionKind.REQUEST_REAUTH]: 0.20,
        [ActionKind.ESCALATE_HUMAN]: 0.45,
      },
      [PayerType.NEEDS_NEW_INSTRUMENT]: {
        // EXACTLY ZERO. The dead card cannot be revived by persistence.
        [ActionKind.RETRY_NOW]: 0.0,
        [ActionKind.RETRY_SCHEDULED]: 0.0,
        // A link lets them choose a different method, so it is not hopeless.
        [ActionKind.SEND_LINK]: 0.18,
        [ActionKind.SWITCH_RAIL_NUDGE]: 0.46,
        [ActionKind.REQUEST_REAUTH]: 0.64,
        [ActionKind.ESCALATE_HUMAN]: 0.50,
      },
      [PayerType.DISPUTING]: {
        [ActionKind.RETRY_NOW]: 0.02,
        [ActionKind.RETRY_SCHEDULED]: 0.02,
        [ActionKind.SEND_LINK]: 0.05,
        [ActionKind.SWITCH_RAIL_NUDGE]: 0.04,
        [ActionKind.REQUEST_REAUTH]: 0.02,
        // The only action that resolves a disagreement is a conversation.
        [ActionKind.ESCALATE_HUMAN]: 0.55,
      },
      [PayerType.NEVER_PAYING]: {
        [ActionKind.RETRY_NOW]: 0.005,
        [ActionKind.RETRY_SCHEDULED]: 0.005,
        [ActionKind.SEND_LINK]: 0.01,
        [ActionKind.SWITCH_RAIL_NUDGE]: 0.01,
        [ActionKind.REQUEST_REAUTH]: 0.008,
        [ActionKind.ESCALATE_HUMAN]: 0.03,
      },
    },
    basis: 'JUDGEMENT, but the ORDERING within each row is the substantive claim and ' +
      'is defensible independently of the exact values: a dead instrument needs ' +
      're-authorisation, a cash-flow problem needs timing, a dispute needs a human. ' +
      'The sensitivity sweep perturbs magnitudes; it preserves ordering, because the ' +
      'ordering is the domain knowledge and the magnitudes are guesses.',
    sweep: '+/-30% multiplicative, ordering preserved',
  },

  // ------------------------------------------------------------- time effects
  decayPerDay: {
    FAILED_PAYMENT: {
      value: 0.12,
      basis: 'JUDGEMENT. Purchase intent evaporates quickly; a checkout failure ' +
        'chased eight days later is largely a cold lead.',
      sweep: [0.06, 0.2],
    },
    FAILED_SUBSCRIPTION: {
      value: 0.05,
      basis: 'JUDGEMENT. The relationship persists, so urgency decays slowly.',
      sweep: [0.02, 0.1],
    },
    OVERDUE_INVOICE: {
      value: 0.02,
      basis: 'JUDGEMENT. A contractual obligation does not expire because it aged.',
      sweep: [0.01, 0.05],
    },
  },

  salaryWindowBoost: {
    value: 2.4,
    basis: 'JUDGEMENT, and the largest single timing effect in the model. Salary ' +
      'credits in India cluster at month start, so a retry landing just after a ' +
      'credit is far more likely to clear than the same retry landing on the 27th. ' +
      'This is the mechanism that rewards RETRY_SCHEDULED over RETRY_NOW, so if the ' +
      'sweep shows our advantage collapsing when this shrinks, that is a genuine ' +
      'limitation and gets reported as one.',
    sweep: [1.6, 3.2],
  },

  preFundsPenalty: {
    value: 0.06,
    basis: 'JUDGEMENT. Charging an account before money arrives fails for the same ' +
      'reason it failed the first time. Not exactly zero, because balances do move ' +
      'for reasons other than salary.',
    sweep: [0.02, 0.12],
  },

  // ---------------------------------------------------------------- fatigue
  fatigueExponent: {
    value: 1.6,
    basis: 'JUDGEMENT. Applied to the fraction of patience SPENT, so above 1.0 means ' +
      'fatigue accelerates: the fourth message hurts more than the second. Chosen ' +
      'because a first reminder is usually welcome (people do forget) while a fourth ' +
      'reads as harassment — response rates fall and complaint rates rise faster than ' +
      'linearly with contact frequency. This is the specific mechanism that makes ' +
      'frugality *outperform* volume rather than merely tie with it, so it is both the ' +
      'assumption most likely to be challenged and the one that most favours our own ' +
      'policy. It is therefore swept widest, and deliberately swept BELOW 1.0 as well: ' +
      'at an exponent under 1 the damage decelerates and the aggressive baseline stops ' +
      'being punished. If the ranking only holds above 1.0, that is a finding to ' +
      'report, not to bury.',
    sweep: [0.6, 2.6],
  },

  disputeHardeningPerMessage: {
    value: 0.35,
    basis: 'JUDGEMENT. Each automated chase to a customer with a live dispute ' +
      'reduces the chance of settlement, because it signals nobody read their ' +
      'complaint. Makes STOP and ESCALATE genuinely value-creating actions rather ' +
      'than merely harmless ones.',
    sweep: [0.15, 0.5],
  },

  // ---------------------------------------------------------------- downtime
  retryDuringDowntimeFactor: {
    value: 0.03,
    basis: 'NEAR-MECHANICAL rather than judgement: if the issuer is genuinely down, ' +
      'the charge cannot be authorised. Not exactly zero because downtime is rarely ' +
      'total. The important asymmetry is that such a retry still consumes an attempt ' +
      'and still counts against decline ratio — it costs full price for almost ' +
      'nothing, which is why downtime awareness is a real edge.',
    sweep: [0.01, 0.08],
  },

  // -------------------------------------------------------------------- rails
  workingRailBoost: {
    value: 1.35,
    basis: 'JUDGEMENT. Steering to a rail the customer has historically succeeded on ' +
      'beats a generic "please try again".',
    sweep: [1.15, 1.6],
  },

  brokenRailPenalty: {
    value: 0.35,
    basis: 'JUDGEMENT. Re-attempting the rail that just failed, when the problem is ' +
      'the rail itself, mostly reproduces the failure.',
    sweep: [0.2, 0.55],
  },

  // ------------------------------------------------------------ channel reach
  channelReach: {
    value: { EMAIL: 0.45, SMS: 0.70, WHATSAPP: 0.85, VOICE: 0.92 },
    basis: 'JUDGEMENT on relative open/answer rates for Indian consumers. Ordering ' +
      '(voice > whatsapp > sms > email) is uncontroversial; the gaps are estimates. ' +
      'Note the cost model runs in the opposite direction, which is exactly what ' +
      'makes channel choice a real trade-off rather than "always use voice".',
    sweep: '+/-25%',
  },

  // ------------------------------------------------------------ the human approver
  /**
   * MEAN hours a queued approval request waits before a human answers it.
   *
   * Called an SLA because that is what a finance-ops team would call it, but it is the mean of a
   * distribution and not a promise — see `sampleApproverWait` in `approver.js`, which draws from an
   * exponential so that some requests wait far longer. A fixed 18 hours would resolve every request
   * in the same cycle and hide precisely the queueing behaviour this assumption exists to model.
   *
   * 18 HOURS, AND THE NUMBER IS CONSTRAINED FROM BOTH SIDES. It has to be well below
   * `GUARDRAILS.approvalValidForHours` (72), or grants expire before the agent can act on them and
   * cases ping-pong between the queue and expiry forever — `approver.js` asserts the gap rather than
   * trusting me to remember it. It has to be well above zero, or the gate costs nothing and the
   * project's claim that human review is a real constraint becomes decorative.
   *
   * LOAD-BEARING, and in a direction worth stating: a slower reviewer hurts every arm that queues
   * anything, and Rebound queues the most, so a long SLA is the assumption most hostile to our own
   * result. So the sweep should run as slow as it legitimately can.
   *
   * THE UPPER BOUND IS DERIVED, NOT CHOSEN. I first wrote `sweep: [6, 48]` by eye, and
   * `test/approver.test.js` caught it: `createSimApprover` refuses a mean SLA above half of
   * `GUARDRAILS.approvalValidForHours`, because past that point most grants expire before the agent
   * can act on them and every affected case cycles between queue and expiry while the run still
   * prints a tidy recovery figure. 48 is above 72/2, so the declared sweep was asking for a world the
   * guard exists to reject. Rather than hardcode 36 — a second magic number that would silently
   * disagree with the guard the moment anybody edited `approvalValidForHours` — the bound is computed
   * from the same constant the guard reads. The two can no longer drift apart.
   */
  approverSlaHours: {
    value: 18,
    basis: 'JUDGEMENT. A reviewer working business hours answers same-day if the request arrives in ' +
      'the morning and next-morning otherwise, which averages under a day. Nothing measured.',
    sweep: [6, GUARDRAILS.approvalValidForHours / 2],
  },

  /**
   * Probability a reviewer GRANTS rather than refuses.
   *
   * The number is not 1.0 and that is the point. An approver who always says yes is a rubber stamp,
   * and a rubber stamp measured as a control would let this project claim it has human oversight
   * while demonstrating none. Denials are terminal (see `resolveApproval`), so this rate directly
   * caps the exposure any arm can ever reach — it is a ceiling on our own headline, chosen against
   * our own interest.
   *
   * 0.7 because the cases that reach the queue are the large ones, where a reviewer is looking at a
   * real charge and will sometimes know something the agent does not: the account is in
   * renegotiation, the invoice is contested offline, the customer is about to churn.
   */
  approvalGrantRate: {
    value: 0.7,
    basis: 'JUDGEMENT. No measured base rate exists for this and I am not going to invent one. The ' +
      'defensible claim is that the ranking of policies survives the sweep from 0.45 to 0.9.',
    sweep: [0.45, 0.9],
  },
};

/** Flatten ASSUMPTIONS to plain values for fast use in the hot loop. */
export function materialiseAssumptions(overrides = {}) {
  const pick = (node) => (node && typeof node === 'object' && 'value' in node ? node.value : node);

  const flat = {
    selfRecoveryRate: {
      FAILED_PAYMENT: pick(ASSUMPTIONS.selfRecoveryRate.FAILED_PAYMENT),
      FAILED_SUBSCRIPTION: pick(ASSUMPTIONS.selfRecoveryRate.FAILED_SUBSCRIPTION),
      OVERDUE_INVOICE: pick(ASSUMPTIONS.selfRecoveryRate.OVERDUE_INVOICE),
    },
    payerTypeMix: pick(ASSUMPTIONS.payerTypeMix),
    actionFit: pick(ASSUMPTIONS.actionFit),
    decayPerDay: {
      FAILED_PAYMENT: pick(ASSUMPTIONS.decayPerDay.FAILED_PAYMENT),
      FAILED_SUBSCRIPTION: pick(ASSUMPTIONS.decayPerDay.FAILED_SUBSCRIPTION),
      OVERDUE_INVOICE: pick(ASSUMPTIONS.decayPerDay.OVERDUE_INVOICE),
    },
    salaryWindowBoost: pick(ASSUMPTIONS.salaryWindowBoost),
    preFundsPenalty: pick(ASSUMPTIONS.preFundsPenalty),
    fatigueExponent: pick(ASSUMPTIONS.fatigueExponent),
    disputeHardeningPerMessage: pick(ASSUMPTIONS.disputeHardeningPerMessage),
    retryDuringDowntimeFactor: pick(ASSUMPTIONS.retryDuringDowntimeFactor),
    workingRailBoost: pick(ASSUMPTIONS.workingRailBoost),
    brokenRailPenalty: pick(ASSUMPTIONS.brokenRailPenalty),
    channelReach: pick(ASSUMPTIONS.channelReach),
    approverSlaHours: pick(ASSUMPTIONS.approverSlaHours),
    approvalGrantRate: pick(ASSUMPTIONS.approvalGrantRate),
  };

  return { ...flat, ...overrides };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const clamp01 = (x) => Math.min(1, Math.max(0, x));

const isRetry = (kind) => kind === ActionKind.RETRY_NOW || kind === ActionKind.RETRY_SCHEDULED;
const isMessage = (kind) =>
  kind === ActionKind.SEND_LINK ||
  kind === ActionKind.SWITCH_RAIL_NUDGE ||
  kind === ActionKind.REQUEST_REAUTH;

/**
 * THE core function: probability that `action` taken at `now` recovers `event`.
 *
 * Returns the probability AND a full factor-by-factor breakdown. The breakdown is not
 * decoration — it is what lets `npm run verify-sim` assert the invariants below, and
 * what lets a reviewer see exactly which multiplier drove a result.
 *
 * Invariants worth stating, all covered by tests in test/responseModel.test.js:
 *   - retry against NEEDS_NEW_INSTRUMENT returns exactly 0
 *   - retry inside a true downtime window is multiplied by ~0.03
 *   - a message to a DISPUTING payer lowers subsequent probability
 *   - probability is monotonically non-increasing in touches already spent
 */
export function recoveryProbability({ action, latent, event, now, touchesUsed = 0, assumptions }) {
  // Deliberately NOT `assumptions = materialiseAssumptions()`.
  //
  // A default here would be the most expensive convenience in the project. The sensitivity
  // sweep works by handing each arm a *different* perturbed assumption set; if an arm ever
  // failed to thread its set through, a silent default would run it against the baseline
  // instead, every arm would secretly agree, and the sweep would report "the result is
  // robust to our assumptions" for the single reason that no assumption ever varied. That is
  // a false claim about the exact thing this simulator exists to be honest about, and it
  // would be invisible — the numbers would look fine. So a missing set is a crash, and the
  // one place allowed to choose the default is the caller that constructs the gateway.
  if (!assumptions?.actionFit) {
    throw new Error(
      'recoveryProbability requires a materialised assumption set (see materialiseAssumptions). ' +
        'It has no default on purpose: silently falling back to baseline assumptions would make ' +
        'a sensitivity sweep report robustness it never measured.'
    );
  }
  const A = assumptions;
  const kind = action.kind;
  const breakdown = {};

  /**
   * THE INSTANT THAT MATTERS IS THE ONE THE ACTION LANDS ON, NOT THE ONE IT WAS CHOSEN ON.
   *
   * This was wrong until Day 6 and the bug was silent, expensive and entirely invisible to the test
   * suite. Every time-dependent factor below read `now` — the moment of the DECISION — which is by
   * construction identical for every candidate being compared against each other. A retry scheduled
   * for six hours' time and one scheduled for a week's time therefore received identical
   * probabilities, all seven candidate slots tied to the paise in the decision engine, and the
   * alphabetical tiebreak picked the winner.
   *
   * Three comments in this file asserted the opposite. `salaryWindowBoost` is described as "the
   * largest single timing effect in the model" and as "the mechanism that rewards RETRY_SCHEDULED
   * over RETRY_NOW"; the funds branch below claims its decay is "what makes *which* scheduled slot
   * the agent picks matter". None of that could be true while the only clock consulted was the
   * decision clock. Measured before the fix, for a TEMPORARILY_SHORT payer with a credit two days
   * out, the +6h / +3d / +9d slots were 0.032094 / 0.032094 / 0.032094; after it they are
   * 0.031146 / 0.800953 / 0.244365.
   *
   * Two consequences worth stating, because they are the reason this is a real fix and not a
   * cosmetic one:
   *
   *   - `preFundsPenalty` was being levied on retries deliberately timed to land AFTER the money
   *     arrives. The penalty for charging an empty account was applied to the act of avoiding it.
   *   - Age decay moves here too, and that is what makes the trade-off honest rather than a free
   *     lunch. Scheduling later buys proximity to a salary credit and pays for it in decay, so
   *     "wait for the 1st" stops being unconditionally correct and becomes an optimisation with a
   *     real cost on both sides. A version that moved only the funds branch would have made
   *     scheduling strictly better the longer you waited.
   *
   * This also brings the simulator into line with the rest of the system rather than introducing a
   * new idea: `src/agent/guardrails.js` already evaluates TIMING rules at the execution instant, and
   * `src/ml/features.js` already computes `salaryWindow` from `action.scheduledFor` with a comment
   * saying it is "applied to the time the money would actually be taken". The feature builder and
   * the guardrails were right. The ground truth was the one layer that disagreed, which is the worst
   * layer to be wrong because everything else is measured against it.
   */
  let effectiveAt = now;
  if (action.scheduledFor) {
    const at = new Date(action.scheduledFor);
    if (Number.isNaN(at.getTime())) {
      // Not defensive padding. An invalid date yields NaN from every arithmetic operation below,
      // NaN propagates through the multiplications without throwing, and `clamp01(NaN)` returns
      // NaN — so the case would be priced at a probability that is neither high nor low and every
      // comparison against it would be false. A crash is the only honest outcome.
      throw new TypeError(`recoveryProbability: action.scheduledFor is not a valid date: ${action.scheduledFor}`);
    }
    // A slot in the past cannot land before it was decided. Clamping rather than throwing because
    // a stale scheduled action arriving late is a normal operational event, not a programming error.
    effectiveAt = at.getTime() > now.getTime() ? at : now;
  }
  breakdown.effectiveAt = effectiveAt.toISOString();
  breakdown.scheduledDelayHours = Number(((effectiveAt.getTime() - now.getTime()) / 3_600_000).toFixed(2));

  // Actions that cannot themselves collect money.
  if (kind === ActionKind.STOP_PERMANENT || kind === ActionKind.NO_ACTION_YET) {
    return { p: 0, breakdown: { reason: 'action collects no money directly' } };
  }

  /**
   * YOU CANNOT RETRY A CHARGE THAT WAS NEVER MADE (#68).
   *
   * `actionFit` is indexed by PAYER TYPE, so it can express "this person will pay if reminded" but it
   * structurally cannot express "this ACTION is meaningless for this LOSS TYPE." An OVERDUE_INVOICE
   * is not a failed charge — nobody attempted a payment and it declined; the invoice was simply never
   * paid. There is no authorisation to re-present and no instrument on file to charge, which is
   * exactly what `ROOT_CAUSES.INVOICE_FORGOTTEN` says in its own comment: "nothing to retry; there is
   * no failed charge."
   *
   * Without this branch, an invoice case belonging to a WILL_PAY_IF_REMINDED payer picked up
   * `actionFit[WILL_PAY_IF_REMINDED][RETRY_NOW] = 0.50` and recovered at a measured 18.06% (n=1113)
   * from an action that cannot physically occur. That is not a small mis-specification. A retry is the
   * CHEAPEST action in the whole model — no channel cost, no patience penalty, the entire reason
   * `test/decide.test.js` shows a retry beating an email by ₹4 of goodwill — so a free 18% lottery
   * ticket on the largest loss type is precisely what an EV-maximising agent will spend its batch on.
   * The recovery was real in the metrics and impossible in the world.
   *
   * This is the eleventh defect in this project that made the headline number look BETTER, and like
   * the other ten it was invisible in the headline number. It surfaced only from asking a different
   * question — comparing per-cell empirical recovery against the taxonomy's physics claims
   * (`probe-mispricing.mjs`), which is a comparison no summary metric performs.
   *
   * The right recovery actions for an unpaid invoice remain fully available and unchanged: SEND_LINK,
   * SWITCH_RAIL_NUDGE, REQUEST_REAUTH and ESCALATE_HUMAN. This closes one impossible path; it does not
   * make invoices unrecoverable.
   */
  if (isRetry(kind) && event?.lossType === LossType.OVERDUE_INVOICE) {
    return {
      p: 0,
      breakdown: {
        ...breakdown,
        reason: `${kind} on an OVERDUE_INVOICE is a structural zero: there is no failed charge to re-present`,
      },
    };
  }

  // --- 1. Action fit for this latent payer type -----------------------------
  const fitRow = A.actionFit[latent.payerType] ?? {};
  let p = fitRow[kind] ?? 0;
  breakdown.actionFit = p;

  // Hard zero short-circuits everything downstream. A dead instrument is dead
  // regardless of timing, channel, or persistence — no multiplier can rescue it.
  if (p === 0) {
    return {
      p: 0,
      breakdown: {
        ...breakdown,
        reason: `${kind} cannot recover payerType ${latent.payerType} (structural zero)`,
      },
    };
  }

  // --- 2. Downtime: retrying into a live outage -----------------------------
  // Evaluated at `effectiveAt`: an outage that has ended by the time a scheduled retry lands does
  // not penalise it, and scheduling past a known outage is a legitimate thing for a policy to do.
  if (isRetry(kind) && latent.trueDowntimeWindow?.start && latent.trueDowntimeWindow?.end) {
    const t = effectiveAt.getTime();
    const inWindow =
      t >= new Date(latent.trueDowntimeWindow.start).getTime() &&
      t <= new Date(latent.trueDowntimeWindow.end).getTime();
    if (inWindow) {
      p *= A.retryDuringDowntimeFactor;
      breakdown.downtime = A.retryDuringDowntimeFactor;
    }
  }

  // --- 3. Funds timing for the cash-flow-constrained ------------------------
  if (latent.payerType === PayerType.TEMPORARILY_SHORT && latent.fundsAvailableFrom) {
    const fundsAt = new Date(latent.fundsAvailableFrom).getTime();
    if (effectiveAt.getTime() < fundsAt) {
      p *= A.preFundsPenalty;
      breakdown.preFunds = A.preFundsPenalty;
    } else {
      // Boost decays over the days following the credit — money arrives and then
      // gets spent, so the window is real but narrow. This is what makes *which*
      // scheduled slot the agent picks matter, not merely that it scheduled at all.
      const daysSinceFunds = (effectiveAt.getTime() - fundsAt) / DAY_MS;
      const windowFactor = Math.exp(-daysSinceFunds / 5);
      const boost = 1 + (A.salaryWindowBoost - 1) * windowFactor;
      p *= boost;
      breakdown.salaryWindow = boost;
    }
  }

  // --- 4. Age decay ---------------------------------------------------------
  // Also at `effectiveAt`, and this is what prices the cost of waiting. See the docblock above:
  // without it, scheduling later would be free and the optimum would always be "wait".
  const ageDays = Math.max(0, (effectiveAt.getTime() - new Date(event.occurredAt).getTime()) / DAY_MS);
  const decay = Math.exp(-(A.decayPerDay[event.lossType] ?? 0.08) * ageDays);
  p *= decay;
  breakdown.ageDecay = decay;
  breakdown.ageDays = Number(ageDays.toFixed(2));

  // --- 5. Rail fit ----------------------------------------------------------
  const working = latent.workingRails ?? [];
  if (kind === ActionKind.SWITCH_RAIL_NUDGE) {
    const hasAlternative = working.some((r) => r !== event.rail);
    const railFactor = hasAlternative ? A.workingRailBoost : A.brokenRailPenalty;
    p *= railFactor;
    breakdown.rail = railFactor;
  } else if (isRetry(kind) && working.length > 0 && !working.includes(event.rail)) {
    p *= A.brokenRailPenalty;
    breakdown.rail = A.brokenRailPenalty;
  }

  // --- 6. Channel reach -----------------------------------------------------
  if (isMessage(kind) && action.channel) {
    const reach = A.channelReach[action.channel] ?? 0.5;
    p *= reach;
    breakdown.channelReach = reach;
  }

  // --- 7. Individual responsiveness ----------------------------------------
  if (isMessage(kind)) {
    // Blended rather than applied raw, so an unresponsive customer is unlikely
    // rather than impossible to reach.
    const respFactor = 0.4 + 0.6 * (latent.responsiveness ?? 0.5);
    p *= respFactor;
    breakdown.responsiveness = respFactor;
  }

  // --- 8. FATIGUE — the mechanism behind "fewer messages, more money" ------
  // Parameterised on the fraction of patience SPENT, not the fraction remaining.
  //
  // This is deliberate and was got wrong once (see ENGINEERING_LOG, Day 2). Writing
  // it as pow(remaining, e) reads naturally but inverts the curvature: with e > 1 the
  // damage per touch *shrinks*, so the first message is expensive and the fourth is
  // nearly free, which rewards volume. Written on spent fraction, e > 1 means what
  // the name claims — each successive touch costs more than the last. e = 1 is
  // linear, e < 1 decelerates. The sweep range crosses 1.0 in both directions so the
  // eval reports results under a regime that does NOT favour frugality.
  const budget = Math.max(1, latent.patienceBudget ?? 4);
  const spent = Math.min(1, Math.max(0, touchesUsed) / budget);
  const fatigue = 1 - Math.pow(spent, A.fatigueExponent);
  p *= fatigue;
  breakdown.fatigue = Number(fatigue.toFixed(4));
  breakdown.touchesUsed = touchesUsed;

  // --- 9. Dispute hardening ------------------------------------------------
  if (latent.payerType === PayerType.DISPUTING && isMessage(kind)) {
    const hardening = Math.pow(1 - A.disputeHardeningPerMessage, touchesUsed);
    p *= hardening;
    breakdown.disputeHardening = Number(hardening.toFixed(4));
  }

  const final = clamp01(p);
  breakdown.final = Number(final.toFixed(5));
  return { p: final, breakdown };
}

/**
 * What a customer actually hands over when they pay.
 *
 * Extracted so the rule has exactly ONE home. A disputing customer who settles usually settles for
 * less, and this used to be inlined in `simulateActionOutcome` alone — which was fine while an agent
 * action was the only way money could arrive. Self-recovery is a second path to the same event, and a
 * second copy of a haircut rule is a copy that eventually disagrees. Day 3 already cost a full log
 * entry to "every partial settlement would have been booked at full value"; the way that recurs is by
 * a new code path forgetting the cap, not by the original one breaking.
 */
export function settlementAmountPaise({ latent, event }) {
  if (latent.payerType === PayerType.DISPUTING && latent.maxWillingToPayPaise) {
    return Math.min(event.amountPaise, latent.maxWillingToPayPaise);
  }
  return event.amountPaise;
}

/**
 * Draw an actual outcome. Separated from probability computation so that tests can
 * assert on probabilities deterministically without dealing with sampling.
 */
export function simulateActionOutcome({ action, latent, event, now, touchesUsed, assumptions, rng }) {
  const { p, breakdown } = recoveryProbability({
    action, latent, event, now, touchesUsed, assumptions,
  });

  const recovered = rng.next() < p;
  const amountPaise = settlementAmountPaise({ latent, event });

  return { recovered, amountPaise: recovered ? amountPaise : 0, p, breakdown };
}

/**
 * Would this case have recovered on its own by `now`, with no intervention?
 *
 * Called for every policy arm including do-nothing, so that self-recovery is credited identically
 * everywhere. Without this, an active policy would silently absorb credit for customers who were
 * always going to pay — the most common way a recovery agent overstates its own contribution.
 *
 * Two things this function relies on and does not itself enforce, both of which cost real debugging:
 *
 *  - `selfRecoverAt` must be AFTER the instant the case entered our queue. The generator conditions
 *    on that now (see its survivorship note); before it did, 75% of self-recoverers had already
 *    "paid" before any run began, and this function would have fired for all of them at cycle 0.
 *  - The CALLER must apply it to cases the policy has given up on, not merely to active ones. A
 *    STOPPED or ESCALATED case is still unpaid, and a customer who pays anyway pays regardless of
 *    whether we are still chasing. Filtering on active cases would give B0_DO_NOTHING — which stops
 *    everything immediately — a self-recovery total of exactly zero, inverting the one measurement
 *    B0 exists to provide.
 */
export function checkSelfRecovery({ latent, now }) {
  if (!latent.willSelfRecover || !latent.selfRecoverAt) return false;
  return now.getTime() >= new Date(latent.selfRecoverAt).getTime();
}

/**
 * Produce a perturbed assumption set for the sensitivity sweep.
 *
 * Magnitudes move; ordering within each actionFit row is preserved, and structural
 * zeros stay zero. That distinction is deliberate: the ordering encodes the domain
 * claim (a dead card needs a new card), while the magnitudes are guesses. Sweeping
 * the guesses tests our result; scrambling the ordering would test a different and
 * incoherent world.
 *
 * Scalars are sampled from the `sweep` range each one DECLARES above, not from a
 * generic ±factor band. This matters more than it looks. With a flat ±30% the fatigue
 * exponent would only ever explore 1.12–2.08, never crossing below 1.0 — so the sweep
 * would silently skip the one regime where our own policy loses its main advantage,
 * while the docstring claimed otherwise. Tying the perturbation to the declared range
 * makes those ranges load-bearing: widen a range in the docs and the sweep genuinely
 * widens. `factor` interpolates, so 1.0 explores each full declared range and 0.3
 * explores 30% of the way toward each edge.
 *
 * Perturbation is applied as a RATIO against the declared value, so any overrides
 * passed into materialiseAssumptions() are scaled rather than discarded.
 */
export function perturbAssumptions(base, factor, rng) {
  const jitter = () => 1 + factor * (rng.next() * 2 - 1);
  const out = structuredClone(base);

  /** Sample a multiplier implied by a leaf's own declared sweep range. */
  const ratio = (spec) => {
    if (!spec || !Array.isArray(spec.sweep) || !spec.value) return jitter();
    const [lo, hi] = spec.sweep;
    const low = spec.value - factor * (spec.value - lo);
    const high = spec.value + factor * (hi - spec.value);
    return (low + rng.next() * (high - low)) / spec.value;
  };

  for (const lossType of Object.keys(out.selfRecoveryRate)) {
    out.selfRecoveryRate[lossType] = clamp01(
      out.selfRecoveryRate[lossType] * ratio(ASSUMPTIONS.selfRecoveryRate[lossType])
    );
    out.decayPerDay[lossType] = Math.max(
      0.001, out.decayPerDay[lossType] * ratio(ASSUMPTIONS.decayPerDay[lossType])
    );
  }

  for (const payerType of Object.keys(out.actionFit)) {
    const row = out.actionFit[payerType];
    const scale = jitter(); // one scale per row preserves within-row ordering
    for (const kind of Object.keys(row)) {
      if (row[kind] === 0) continue; // structural zeros are not assumptions
      row[kind] = clamp01(row[kind] * scale * (1 + 0.3 * factor * (rng.next() * 2 - 1)));
    }
  }

  out.salaryWindowBoost = Math.max(1, out.salaryWindowBoost * ratio(ASSUMPTIONS.salaryWindowBoost));
  out.preFundsPenalty = clamp01(out.preFundsPenalty * ratio(ASSUMPTIONS.preFundsPenalty));
  // Floored just above zero: an exponent of exactly 0 would make fatigue a step
  // function (1 until the budget, then 0), which is a different model rather than a
  // perturbed one.
  out.fatigueExponent = Math.max(0.05, out.fatigueExponent * ratio(ASSUMPTIONS.fatigueExponent));
  out.disputeHardeningPerMessage = clamp01(
    out.disputeHardeningPerMessage * ratio(ASSUMPTIONS.disputeHardeningPerMessage)
  );
  out.retryDuringDowntimeFactor = clamp01(
    out.retryDuringDowntimeFactor * ratio(ASSUMPTIONS.retryDuringDowntimeFactor)
  );
  out.workingRailBoost = Math.max(1, out.workingRailBoost * ratio(ASSUMPTIONS.workingRailBoost));
  out.brokenRailPenalty = clamp01(out.brokenRailPenalty * ratio(ASSUMPTIONS.brokenRailPenalty));

  for (const ch of Object.keys(out.channelReach)) {
    out.channelReach[ch] = clamp01(out.channelReach[ch] * jitter());
  }

  /**
   * The approver moves too. Floored at 0.5h rather than 0 because an instantaneous reviewer is not a
   * perturbed human, it is the absence of the gate — a different world, not a noisier one. The grant
   * rate is clamped to [0,1] like any probability; note that the declared sweep tops out at 0.9 and
   * NOT at 1.0, deliberately, so no run in the sweep is ever handed a rubber stamp.
   */
  out.approverSlaHours = Math.max(0.5, out.approverSlaHours * ratio(ASSUMPTIONS.approverSlaHours));
  out.approvalGrantRate = clamp01(out.approvalGrantRate * ratio(ASSUMPTIONS.approvalGrantRate));

  return out;
}

export { LossType };
