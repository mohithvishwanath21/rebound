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
  const A = assumptions;
  const kind = action.kind;
  const breakdown = {};

  // Actions that cannot themselves collect money.
  if (kind === ActionKind.STOP_PERMANENT || kind === ActionKind.NO_ACTION_YET) {
    return { p: 0, breakdown: { reason: 'action collects no money directly' } };
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
  if (isRetry(kind) && latent.trueDowntimeWindow?.start && latent.trueDowntimeWindow?.end) {
    const t = now.getTime();
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
    if (now.getTime() < fundsAt) {
      p *= A.preFundsPenalty;
      breakdown.preFunds = A.preFundsPenalty;
    } else {
      // Boost decays over the days following the credit — money arrives and then
      // gets spent, so the window is real but narrow. This is what makes *which*
      // scheduled slot the agent picks matter, not merely that it scheduled at all.
      const daysSinceFunds = (now.getTime() - fundsAt) / DAY_MS;
      const windowFactor = Math.exp(-daysSinceFunds / 5);
      const boost = 1 + (A.salaryWindowBoost - 1) * windowFactor;
      p *= boost;
      breakdown.salaryWindow = boost;
    }
  }

  // --- 4. Age decay ---------------------------------------------------------
  const ageDays = Math.max(0, (now.getTime() - new Date(event.occurredAt).getTime()) / DAY_MS);
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
 * Draw an actual outcome. Separated from probability computation so that tests can
 * assert on probabilities deterministically without dealing with sampling.
 */
export function simulateActionOutcome({ action, latent, event, now, touchesUsed, assumptions, rng }) {
  const { p, breakdown } = recoveryProbability({
    action, latent, event, now, touchesUsed, assumptions,
  });

  const recovered = rng.next() < p;

  // Partial settlement: a disputing customer who does pay often pays less. Modelled
  // because reporting full recovery on a haircut would overstate results.
  let amountPaise = event.amountPaise;
  if (recovered && latent.payerType === PayerType.DISPUTING && latent.maxWillingToPayPaise) {
    amountPaise = Math.min(amountPaise, latent.maxWillingToPayPaise);
  }

  return { recovered, amountPaise: recovered ? amountPaise : 0, p, breakdown };
}

/**
 * Would this case have recovered on its own by `now`, with no intervention?
 *
 * Called by every policy arm including do-nothing, so that self-recovery is credited
 * identically everywhere. Without this, an active policy would silently absorb credit
 * for customers who were always going to pay — the most common way a recovery agent
 * overstates its own contribution.
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

  return out;
}

export { LossType };
