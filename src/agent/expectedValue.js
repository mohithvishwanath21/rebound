/**
 * EXPECTED VALUE
 * ==============
 *
 * The arithmetic that turns a probability into a decision:
 *
 *     EV(a) = p(a) x amount x margin
 *             - channel cost(a)
 *             - human review cost(a)
 *             - (1 - p(a)) x failed-retry penalty          [money-moving actions only]
 *             - patience price x (touches already spent + 1)  [contacting actions only]
 *
 * Everything is integer paise. `p` is the only float in the file.
 *
 * WHY THIS IS THE WHOLE PROJECT IN FIVE LINES
 * -------------------------------------------
 * A retry loop asks "did it fail? try again." This asks "is this rupee worth chasing, by this
 * route, at this moment, given what it costs and what we have already spent." Every term on
 * the right is a thing a retry loop cannot see, and each one changes the answer:
 *
 *   `margin` is why a ₹10,000 failed card payment and a ₹10,000 overdue invoice are not the
 *   same opportunity. Recovering the invoice is worth ₹10,000 of contribution; recovering the
 *   payment is worth ₹3,500, because the goods already shipped at 65% cost. Chasing them
 *   equally hard is a mistake that no amount of retry tuning can fix.
 *
 *   `(1 - p) x failedRetryPenalty` is why "retry everything three times" is bad rather than
 *   merely crude. A retry that will probably fail carries most of that penalty. This term is
 *   what makes a hopeless retry *negative* instead of free, and it is the single assumption in
 *   this project I can least defend with a number — hence the widest range in the sensitivity
 *   sweep, and hence `describeAssumptions()` at the bottom of this file.
 *
 *   the patience price is why "message everyone until they pay" loses money. Priced at zero,
 *   the expected-value-maximising policy is harassment; the optimum only becomes humane once
 *   goodwill has a price.
 *
 * WHY THE PATIENCE TERM IS CONVEX
 * -------------------------------
 * `patienceUnitPaise x (touchesUsed + 1)`, not a flat charge. The first message to a customer
 * costs ₹4 of goodwill and the fifth costs ₹20. The response model's fatigue effect is real and
 * accelerating, so a flat price would under-charge exactly the late touches that do the damage.
 *
 * This makes escalating contact self-limiting *through the arithmetic* rather than only at the
 * cap. Both mechanisms are kept, and they are not redundant — they fail differently:
 *
 *   the shadow price handles ECONOMICS. It stops the agent spending ₹20 of goodwill to chase
 *   ₹9 of contribution, on a case that is nowhere near the cap.
 *   `maxTouchesPerCase` handles COMPLIANCE. It holds even if the model returns a wildly
 *   optimistic probability, because a bug in the probability must not be able to authorise a
 *   sixth message.
 *
 * A guardrail you can price your way through is not a guardrail. A price you can only express
 * as a cap cannot trade off. Keep both.
 *
 * WHAT THIS FUNCTION IS NOT ALLOWED TO DECIDE
 * -------------------------------------------
 * It returns a number and a decomposition. It does not choose, does not stop, and does not
 * consult guardrails. Selection lives in `decide.js` and stopping in `stopping.js`, and the
 * split is deliberate: see the header of `stopping.js` for why an argmax and a stop rule need
 * different things from the same probability.
 */

import { COSTS, CONTRIBUTION_MARGIN, POLICY } from '../core/config.js';
import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING, ACTION_META } from '../core/actions.js';

/**
 * Contribution margin for a loss type.
 *
 * An unrecognised loss type falls back to the LOWEST margin on the table rather than to 1.0.
 * The conservative direction matters: defaulting to full margin would make an unknown category
 * look like the most valuable thing in the batch and it would be chased first. Defaulting low
 * makes it look least valuable and it gets chased last, which is the correct way to be wrong
 * about something you do not recognise.
 */
export function marginFor(lossType) {
  const known = CONTRIBUTION_MARGIN[lossType];
  if (typeof known === 'number') return known;
  return Math.min(...Object.values(CONTRIBUTION_MARGIN));
}

/** Per-message cost for the action's channel, in paise. Non-contacting actions cost nothing. */
export function channelCostPaise(action) {
  if (!CUSTOMER_CONTACTING.has(action?.kind)) return 0;
  const c = COSTS.channel[action?.channel];
  if (typeof c !== 'number') {
    // A contacting action with no channel is a construction bug, not a free message. Priced at
    // the most expensive channel so the mistake shows up as an action that never wins rather
    // than as an action that always wins.
    return Math.max(...Object.values(COSTS.channel));
  }
  return c;
}

/**
 * Expected value of one candidate action, in integer paise, with the decomposition.
 *
 * @param p           probability this action recovers the money. Must be in [0, 1].
 * @param amountPaise the at-risk amount
 * @param lossType    selects the contribution margin
 * @param touchesUsed how many times we have already contacted this customer about this case
 *
 * ROUNDING HAPPENS PER COMPONENT, ON PURPOSE. The audit drawer shows the terms and the total;
 * if the total were rounded independently of the parts it would not equal their sum, and a
 * reviewer checking the arithmetic by hand would find a one-paise discrepancy and reasonably
 * conclude the whole record was untrustworthy.
 */
export function expectedValue({ p, amountPaise, lossType, action, touchesUsed = 0, costs = COSTS } = {}) {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`expectedValue: p must be a probability in [0,1], got ${p}`);
  }
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new RangeError(`expectedValue: amountPaise must be a non-negative integer, got ${amountPaise}`);
  }
  if (!action?.kind) throw new TypeError('expectedValue({ action }): action.kind is required');

  const kind = action.kind;
  const meta = ACTION_META[kind] ?? {};
  const margin = marginFor(lossType);

  // Actions that cannot recover money have a structurally zero gross, not a small one. Writing
  // it as `p x amount x margin` for STOP_PERMANENT would depend on the caller having passed
  // p = 0, and a caller that passed the case's general recovery probability instead would make
  // stopping look profitable.
  //
  /**
   * ESCALATE_HUMAN IS DELIBERATELY OUTSIDE THE COMPETITION, AND THIS IS THE CONSEQUENCE.
   *
   * Escalation recovers nothing by itself — a human does the recovering afterwards. Its gross
   * is therefore zero, its cost is ₹60, and its expected value is always negative. It can
   * never win an argmax. That is not an oversight, and the alternative was worse.
   *
   * To price escalation properly I would need P(a human recovers this | they look at it), which
   * means a model of analyst behaviour that this project has no data for and would have to
   * invent. An invented number here would be uniquely corrosive: it sets how often the agent
   * hands work to people, so tuning it upward makes the automation look cautious and tuning it
   * downward makes it look decisive, and no measurement in the repo could catch either.
   *
   * So escalation is reached through the STANDING rules in `stopping.js` — do we have the
   * evidence to close this ourselves — and never through the arithmetic. Those are different
   * kinds of question and the split keeps the unpriceable one out of the priced comparison.
   * `reviewWorthwhile()` supplies the only cost discipline that needs no invented probability.
   */
  const canRecover = MONEY_MOVING.has(kind) || CUSTOMER_CONTACTING.has(kind);
  const grossPaise = canRecover ? Math.round(p * amountPaise * margin) : 0;

  const channel = channelCostPaise(action);
  const humanReview = kind === ActionKind.ESCALATE_HUMAN ? costs.humanReviewPaise : 0;

  // The externality of a decline: issuer and network scrutiny that raises the cost of every
  // FUTURE payment, including the ones that would have succeeded. Charged in expectation,
  // because it is incurred exactly when the retry fails.
  const expectedFailurePenalty = MONEY_MOVING.has(kind)
    ? Math.round((1 - p) * costs.failedRetryPenaltyPaise)
    : 0;

  // Convex in touches already spent. See the header.
  const patiencePenalty = meta.consumesTouch ? costs.patienceUnitPaise * (touchesUsed + 1) : 0;

  const totalCostPaise = channel + humanReview + expectedFailurePenalty + patiencePenalty;

  return {
    evPaise: grossPaise - totalCostPaise,
    grossPaise,
    totalCostPaise,
    components: {
      p,
      margin,
      amountPaise,
      channelPaise: channel,
      humanReviewPaise: humanReview,
      expectedFailurePenaltyPaise: expectedFailurePenalty,
      patiencePenaltyPaise: patiencePenalty,
      touchesUsed,
    },
  };
}

/**
 * The standard error of an expected value, in paise.
 *
 * `EV = p x amount x margin - costs`. The costs are constants — a channel price, a review price —
 * so all the uncertainty sits in `p`, and it passes through multiplied by the stake:
 *
 *     sigma(EV) = sigma(p) x amount x margin
 *
 * `sigma(p)` is the binomial standard error over the rows the model actually saw for this cell.
 * The `+2` is a pseudo-count, and it is doing real work rather than avoiding a divide-by-zero: with
 * a bare `1/n`, a cell that happened to contain three rows all of one class reports `sigma = 0` and
 * the resulting bar collapses to the flat floor exactly where the evidence is flimsiest. The +2 is
 * the same device as a Jeffreys prior — it says "treat every cell as if two coin flips of unknown
 * outcome were already in it" — and it means a thin cell is reported as uncertain instead of as
 * certain-and-extreme.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: rescue an UNSEEN cell. When `rows` is 0 the probability is the
 * global base rate, and the error in that number is BIAS — the cell may be nothing like the average —
 * not variance. A standard error cannot express bias, and inventing a sigma for those cases would be
 * arithmetic theatre. So `rows = 0` returns null and the caller falls back to the flat floor, leaving
 * unseen beliefs to `APR_UNSUPPORTED_BELIEF`, which routes money movement on them to a human.
 *
 * THE FIRST VERSION OF THIS FUNCTION DID NOT DO WHAT THE PARAGRAPH ABOVE SAYS, and a test caught it.
 * With the `+2` pseudo-count applied unconditionally, `rows = 0` gave sigma(p) = sqrt(p(1-p)/2) —
 * around 0.22 at a base rate of 0.11, so a bar of roughly a fifth of the whole amount. Unsupported
 * money movement then fell below its own bar and came out as ESCALATE_HUMAN instead of
 * AWAIT_APPROVAL. Those are not interchangeable: approval is a gate on an action the agent has
 * chosen and wants permission for, escalation is the agent declining to choose. Swapping one for the
 * other would have quietly disabled the approval envelope built in #60 and #61 while every headline
 * number still looked reasonable. `test/decide.test.js` line 549 held the line.
 *
 * A THIN cell (rows > 0, below the minimum count) gets BOTH a sigma bar and the approval rule, and
 * that is not double-counting. The sigma bar decides whether acting is worth it at all; approval
 * decides whether a person signs off on acting. A thin cell can fail either independently.
 */
export function evStandardErrorPaise({ p, rows, amountPaise, marginFraction = 1 } = {}) {
  if (!Number.isFinite(p) || !Number.isFinite(amountPaise) || !Number.isFinite(marginFraction)) return null;
  if (!Number.isFinite(rows) || rows <= 0) return null;
  const varianceP = Math.max(p * (1 - p), 1e-9) / (rows + 2);
  return Math.sqrt(varianceP) * amountPaise * marginFraction;
}

/**
 * The bar an action must clear to be worth taking, in paise.
 *
 * `POLICY.minEvToActPaise` is ₹2 rather than zero, and the gap is not squeamishness. The
 * probability estimate has its own error, and on the held-out split that error is worth far
 * more than one paise of expected value. Acting at EV = +1 paise is not maximising expected
 * value, it is fitting the noise in the estimate. The threshold is the honest admission that
 * the number has a standard error attached even though the arithmetic prints to the paise.
 *
 * IT USED TO BE A FLAT ₹2, AND THE FLAT VERSION DID NOT DO WHAT THE PARAGRAPH ABOVE CLAIMS (#52).
 * The justification is about noise, and the noise in an expected value is not constant — it scales
 * with the stake. So a flat bar demands 1% of confidence on a ₹200 case and four ten-thousandths of
 * a percent on a ₹5,00,000 one: strictest exactly where it matters least. `probe-evbar.mjs`
 * measured the consequence — a large share of chosen actions cleared ₹2 while sitting below one
 * standard error of their own EV.
 *
 * THE MEASUREMENT ALSO CORRECTED MY REASONING, WHICH IS THE MORE USEFUL HALF. I expected the
 * failure to concentrate in large amounts. It does not, and it cannot: EV and sigma(EV) both scale
 * linearly in the amount, so `EV / sigma(EV) = p / sigma(p)` is amount-INVARIANT. The largest
 * quartile turned out to be the safest. Every bit of the problem lives in `sigma(p)`, i.e. in how
 * many comparable rows the model saw. That makes the noise bar and the support gate algebraically
 * the same instrument, discovered from two directions — which is why the sigma form below is
 * scaled by support and why unseen cells are left to the approval rule instead.
 *
 * `POLICY.evBarSigmaK` is the number of standard errors demanded. Setting it to 0 restores the flat
 * bar EXACTLY, which is not a legacy escape hatch — it is what lets the two policies be run as an
 * A/B from one code state, and what lets the Day 8 sweep perturb `k` like any other assumption.
 *
 * It remains a reportable knob either way: raising it trades recovered rupees for fewer actions
 * taken, which is the trade a merchant may legitimately want to set for themselves.
 */
export function actionThresholdPaise(policy = POLICY, evidence = null) {
  const floor = policy.minEvToActPaise;
  const k = policy.evBarSigmaK ?? 0;
  if (!k || !evidence) return floor;
  const sigma = evStandardErrorPaise(evidence);
  if (!Number.isFinite(sigma) || sigma <= 0) return floor;
  return Math.max(floor, Math.round(k * sigma));
}

/**
 * Every price this file depends on, with its status.
 *
 * `describe-sim` prints the simulator's assumptions for the same reason: a number that decides
 * money should be visible rather than buried in a constant. `measured: false` on all of them is
 * the point — these are stated assumptions, and the sensitivity sweep on Days 8-9 exists
 * because none of them is a measurement.
 */
export function describeAssumptions(costs = COSTS, policy = POLICY) {
  return [
    { name: 'channel.EMAIL', paise: costs.channel.EMAIL, measured: false, basis: 'token price so that "email forever" is still bounded by something' },
    { name: 'channel.SMS', paise: costs.channel.SMS, measured: false, basis: 'rough Indian transactional messaging rate' },
    { name: 'channel.WHATSAPP', paise: costs.channel.WHATSAPP, measured: false, basis: 'rough Indian transactional messaging rate' },
    { name: 'channel.VOICE', paise: costs.channel.VOICE, measured: false, basis: 'rough Indian outbound call rate' },
    { name: 'humanReviewPaise', paise: costs.humanReviewPaise, measured: false, basis: '~6 minutes of a finance-ops analyst' },
    { name: 'failedRetryPenaltyPaise', paise: costs.failedRetryPenaltyPaise, measured: false, basis: 'issuer/network scrutiny externality. THE LEAST DEFENSIBLE NUMBER HERE; widest sensitivity range' },
    { name: 'patienceUnitPaise', paise: costs.patienceUnitPaise, measured: false, basis: 'shadow price of one unit of customer goodwill; charged convexly' },
    { name: 'minEvToActPaise', paise: policy.minEvToActPaise, measured: false, basis: 'above zero because the probability estimate has a standard error' },
    ...Object.entries(CONTRIBUTION_MARGIN).map(([k, v]) => ({
      name: `margin.${k}`,
      paise: null,
      fraction: v,
      measured: false,
      basis: 'contribution margin; sets what a recovered rupee is actually worth',
    })),
  ];
}
