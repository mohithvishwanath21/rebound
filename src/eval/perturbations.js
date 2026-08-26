/**
 * THE PERTURBATION CATALOGUE — every "what if this number is wrong" the sweep can ask.
 * =================================================================================================
 *
 * `describeAssumptions()` in `expectedValue.js` returns `measured: false` for every price this project
 * charges, and `ASSUMPTIONS` in `responseModel.js` says JUDGEMENT in the `basis` of nearly every entry.
 * That is honest and it is also an unanswered question: if none of the numbers is measured, why should
 * anyone believe a result computed from them? The answer cannot be "trust the numbers". It has to be
 * "the RANKING does not depend on them" — and that is a claim you either measure or drop.
 *
 * So each entry below is one alternative world. A run of `sweep.js` executes the full five-arm paired
 * comparison inside each of them and reports whether Rebound still beats the compliant baseline.
 *
 * =================================================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE: THE SWEEP MUST NEVER SELECT ANYTHING
 * =================================================================================================
 * Reading down a column of twenty runs and keeping the setting where Rebound looks best is not a
 * sensitivity analysis, it is a hyperparameter search scored on the outcome the project is judged by.
 * It would produce a better-looking table and a worse system, and the resulting figure would not
 * generalise to a single real merchant.
 *
 * `POLICY.evBarSigmaK = 1` was fixed by the argument in `expectedValue.js` — that a noise bar should
 * scale with the noise — and by the A/B in VERIFY.md section 12b, BEFORE this sweep existed. The two
 * `ev-bar-k*` rows below therefore report what happens at other values; they do not choose one. If a
 * future session is tempted to move `k` because a row here looks good, the honest move is to state the
 * whole curve in the write-up and keep `k` where the reasoning put it.
 *
 * =================================================================================================
 * WHAT ONE-AT-A-TIME CANNOT SEE, AND THE ROWS THAT COVER FOR IT
 * =================================================================================================
 * Perturbing one number at a time is attributable — a flip is caused by the thing that moved — and it
 * is also the weakest possible test, because assumptions are not wrong one at a time. Real
 * mis-specification is joint and correlated. So the catalogue carries both kinds, and they are
 * labelled, because a table of only one-at-a-time rows saying "robust" invites a conclusion it has not
 * earned:
 *
 *   `family: 'cost'` / `'margin'` / `'world'` / `'policy'`  — one number, attributable.
 *   `family: 'joint'`                                        — every assumption drawn at once from its
 *                                                              own declared `sweep` range, via
 *                                                              `perturbAssumptions(A, 1.0, rng)`. Not
 *                                                              attributable, and much more honest
 *                                                              about what being wrong looks like.
 *   `family: 'skew'`                                         — the world moves and the model does NOT
 *                                                              retrain. Robustness to miscalibration,
 *                                                              which is a different question; see the
 *                                                              `fitRecoveryScorer` docblock.
 *
 * =================================================================================================
 * WHY THIS IS A CLOSED LIST OF NAMES AND NOT A `--set key=value` FLAG
 * =================================================================================================
 * A free-form flag can be typo'd, and a typo'd perturbation is a no-op, and a no-op prints "no
 * effect" — which reads as a finding and is a wiring bug. This project has now been bitten eleven
 * times by defects whose only symptom was a more flattering number, including one found while building
 * this very file (`expectedValue` accepted an injected cost table and then ignored half of it). An
 * unknown id here throws. Every row is reproducible on its own as
 * `node src/eval/cli/run.js --perturb=<id> --json`, which is the property that makes the table
 * checkable by someone who does not trust it.
 */

import { COSTS, CONTRIBUTION_MARGIN, POLICY } from '../core/config.js';
import { materialiseAssumptions, perturbAssumptions } from '../sim/responseModel.js';
import { tiltCauseMix, CAUSE_GIVEN_PAYER } from '../sim/generator.js';
import { makeRng } from '../core/rng.js';

/** Scale every channel price by `k`, rounding to whole paise. */
const scaleChannels = (k) => ({
  ...COSTS,
  channel: Object.fromEntries(Object.entries(COSTS.channel).map(([ch, v]) => [ch, Math.round(v * k)])),
});

/** Scale one scalar price by `k`, leaving the rest of the table alone. */
const scalePrice = (key, k) => ({ ...COSTS, [key]: Math.round(COSTS[key] * k) });

/**
 * Scale every contribution margin by `k`, CLAMPED AT 1.0, and the clamp is the interesting part.
 *
 * OVERDUE_INVOICE is already 1.0 — recovering an invoice yields the whole amount, because no goods
 * moved. A margin of 1.3 would mean collecting ₹100 produced ₹130 of contribution, which is not a
 * pessimistic or optimistic assumption, it is not a quantity. So "+30% margins" cannot move all three
 * numbers, and the honest thing is to say so in the row's label rather than to let a reader assume a
 * uniform shift. At k > 1 this perturbs FAILED_PAYMENT and FAILED_SUBSCRIPTION only.
 *
 * Left unstated, this would have been a small dishonesty with a real consequence: the row would
 * understate the sensitivity of the one loss type whose margin is already maximal, and OVERDUE_INVOICE
 * is the highest-margin inventory in the batch and therefore the most valuable to chase.
 */
const scaleMargins = (k) =>
  Object.fromEntries(
    Object.entries(CONTRIBUTION_MARGIN).map(([lt, v]) => [lt, Math.min(1, Number((v * k).toFixed(6)))])
  );

/**
 * Scale the world's self-recovery propensity, keeping every rate a probability.
 *
 * THIS RETURNS AN ASSUMPTION OVERRIDE, WHICH ON ITS OWN DOES NOTHING, AND THAT COST ME A SWEEP.
 *
 * `willSelfRecover` and `selfRecoverAt` are GENERATION-TIME LATENTS. `generateBatch` draws them from
 * `params.selfRecoveryRate`, and at run time `checkSelfRecovery` only reads the latent back:
 *
 *     if (!latent.willSelfRecover || !latent.selfRecoverAt) return false;
 *
 * So perturbing the run-time assumption set moves the response model's *declared* self-recovery rate
 * and leaves the world's actual self-recoverers exactly where they were. The first smoke run of the
 * sweep printed `self-recovery-x1.3` as byte-identical to the control — same attempts, same recovered
 * paise, same self-recovered paise — on the row the catalogue calls "the row most able to embarrass
 * this project". A null there would have been quoted as robustness against the one assumption whose
 * own `basis` field says it is load-bearing.
 *
 * `resolvePerturbation` therefore DERIVES a generator override from the materialised assumptions
 * whenever their self-recovery table differs from the baseline. Deriving it structurally rather than
 * listing it per row is the point: the joint draws perturb `selfRecoveryRate` too, and they would have
 * had the same silent hole.
 */
const scaleSelfRecovery = (k) => {
  const base = materialiseAssumptions();
  return {
    selfRecoveryRate: Object.fromEntries(
      Object.entries(base.selfRecoveryRate).map(([lt, v]) => [lt, Math.min(1, v * k)])
    ),
  };
};

/** The unperturbed self-recovery table, used to detect whether a row moved it at all. */
const BASE_SELF_RECOVERY = materialiseAssumptions().selfRecoveryRate;

/**
 * Scale the approver's grant rate, CLAMPED AT 0.9 AND NOT AT 1.0.
 *
 * `ASSUMPTIONS.approvalGrantRate` declares its sweep as [0.45, 0.9] with the note that the top is
 * deliberately short of 1.0, so that no run in the sweep is handed a rubber stamp. A reviewer who
 * grants everything is not a perturbed human, it is the absence of the approval gate — and a run
 * without the gate would have less exposure frozen at the horizon and would report MORE recovered
 * money. That would be the sweep quietly removing the project's own compliance constraint and
 * printing the result as robustness.
 */
const scaleGrantRate = (k) => ({
  approvalGrantRate: Math.min(0.9, materialiseAssumptions().approvalGrantRate * k),
});

/**
 * THE CATALOGUE. Order is the order the sweep runs and reports in.
 *
 * `why` is not decoration: a perturbation with no stated reason to matter is a row nobody can
 * interpret, and twenty uninterpretable rows all saying "no change" is the single easiest way to
 * manufacture false confidence in this whole project.
 */
const CATALOGUE = [
  {
    id: 'baseline',
    family: 'none',
    label: 'no perturbation',
    why: 'The control. Must reproduce the headline table exactly, or the sweep harness is changing the result by observing it.',
  },

  // ------------------------------------------------------------------ costs the POLICY charges itself
  {
    id: 'retry-penalty-x0',
    family: 'cost',
    label: 'failed-retry penalty = 0',
    why:
      'THE MOST IMPORTANT ROW IN THE TABLE. This penalty is the term that makes a hopeless retry ' +
      'negative rather than free, and it is the number `describeAssumptions` calls the least ' +
      'defensible in the project. At zero, Rebound loses its central argument for declining to retry ' +
      'and should converge toward the naive baselines. If the ranking is UNCHANGED here, the honest ' +
      'reading is not "robust" — it is that the penalty was never doing the work I claim it does.',
    costs: scalePrice('failedRetryPenaltyPaise', 0),
  },
  {
    id: 'retry-penalty-x0.7',
    family: 'cost',
    label: 'failed-retry penalty -30%',
    why:
      'The declared ±30% band on the least defensible price in the project. Nothing about this ' +
      'penalty was measured; it stands for the customer goodwill a failed re-charge burns, and a ' +
      'reader who thinks I priced that badly should be able to see immediately whether it matters.',
    costs: scalePrice('failedRetryPenaltyPaise', 0.7),
  },
  {
    id: 'retry-penalty-x1.3',
    family: 'cost',
    label: 'failed-retry penalty +30%',
    why:
      'The other side of the same band. A dearer failed retry should push Rebound further away from ' +
      'the retry-heavy baselines, so if the money is unchanged the penalty is not doing the work I ' +
      'claim for it — read the ACTIONS column here before reading the money column.',
    costs: scalePrice('failedRetryPenaltyPaise', 1.3),
  },
  {
    id: 'retry-penalty-x2',
    family: 'cost',
    label: 'failed-retry penalty x2',
    why:
      'Wider than ±30% on purpose, because the ±30% band presumes the central value is roughly right ' +
      'and there is no measurement behind it. If a doubling flips nothing, the band is beside the point.',
    costs: scalePrice('failedRetryPenaltyPaise', 2),
  },
  {
    id: 'patience-x0.7',
    family: 'cost',
    label: 'patience price -30%',
    why:
      'The shadow price of goodwill is what makes the EV-maximising policy humane rather than ' +
      'harassing. Cheaper goodwill should move Rebound toward B2_AGGRESSIVE, i.e. it should CLOSE the ' +
      'gap it currently loses by — an unflattering direction worth reporting.',
    costs: scalePrice('patienceUnitPaise', 0.7),
  },
  {
    id: 'patience-x1.3',
    family: 'cost',
    label: 'patience price +30%',
    why:
      'Dearer goodwill should make Rebound quieter still, because the patience penalty is what stops ' +
      'the agent spending a customer\'s tolerance to collect a small amount. Watch the ACTIONS ' +
      'column: a row that suppresses contact without losing money is the mechanism working, not a null.',
    costs: scalePrice('patienceUnitPaise', 1.3),
  },
  {
    id: 'human-review-x0.7',
    family: 'cost',
    label: 'human review -30%',
    why:
      'Sets how readily the agent hands work to a person. Cheaper review should raise escalations, ' +
      'and escalated exposure is neither recovered nor ruled out at the horizon.',
    costs: scalePrice('humanReviewPaise', 0.7),
  },
  {
    id: 'human-review-x1.3',
    family: 'cost',
    label: 'human review +30%',
    why:
      'Dearer human review should suppress escalation and push more decisions onto the automation. If ' +
      'nothing moves except netPaise, escalation is being chosen for reasons the price does not enter ' +
      '— which is a finding about the guardrail, not about the cost.',
    costs: scalePrice('humanReviewPaise', 1.3),
  },
  {
    id: 'channels-x0.7',
    family: 'cost',
    label: 'all channel prices -30%',
    why:
      'Message prices are small relative to the amounts at stake, so the pre-registered expectation ' +
      'is that this row barely moves. Stated in advance so that a null result here is a prediction ' +
      'confirmed rather than a wiring bug hiding — which is exactly what it was until this week.',
    costs: scaleChannels(0.7),
    expectNoMovement: true,
  },
  {
    id: 'channels-x1.3',
    family: 'cost',
    label: 'all channel prices +30%',
    why:
      'The same argument upward. Channel prices are 1-4 paise against amounts in the thousands of ' +
      'rupees, so neither direction can move an argmax; both rows pre-register their null so that a ' +
      'confirmed prediction is not reported as a suspected wiring bug.',
    costs: scaleChannels(1.3),
    expectNoMovement: true,
  },

  // ------------------------------------------------------------------ what a recovered rupee is worth
  {
    id: 'margins-x0.7',
    family: 'margin',
    label: 'contribution margins -30%',
    why:
      'Margin is why a ₹10,000 invoice and a ₹10,000 failed card payment are different opportunities. ' +
      'Thinner margins shrink every gross term while leaving costs alone, so every arm should act ' +
      'less; the question is whether the ORDER survives.',
    margins: scaleMargins(0.7),
  },
  {
    id: 'margins-x1.3-clamped',
    family: 'margin',
    label: 'contribution margins +30%, clamped at 1.0',
    why:
      'Clamped, so this moves FAILED_PAYMENT and FAILED_SUBSCRIPTION only — OVERDUE_INVOICE is already ' +
      '1.0 and a margin above 1.0 is not a quantity. The label says clamped because an unlabelled ' +
      '"+30% margins" row would be a claim about three numbers backed by two.',
    margins: scaleMargins(1.3),
  },

  // ------------------------------------------------------------------ the world itself
  {
    id: 'self-recovery-x0.7',
    family: 'world',
    label: 'self-recovery propensity -30%',
    why:
      'Its own `basis` field says it is load-bearing for B0: set it high and every policy looks less ' +
      'impressive because much of the recovered money was never lost. Lowering it FLATTERS every ' +
      'active arm, which is why the +30% row matters more than this one.',
    assumptionOverrides: scaleSelfRecovery(0.7),
  },
  {
    id: 'self-recovery-x1.3',
    family: 'world',
    label: 'self-recovery propensity +30%',
    why:
      'Intended as the row most able to embarrass this project — more customers pay unprompted, so more ' +
      "of every arm's gross was never the agent's to claim, and Rebound gives up the largest " +
      'counterfactual deduction of any arm (10.6% of gross). IT DOES NOT DELIVER THAT, and the label of ' +
      'the row below explains why with counted latents: +30% adds two self-recoverers in 400 cases. ' +
      'Kept because it is the honest ±30% band on a declared assumption, but read `self-recovery-x2` ' +
      'before drawing any comfort from a null here.',
    assumptionOverrides: scaleSelfRecovery(1.3),
  },
  {
    id: 'self-recovery-x2',
    family: 'world',
    label: 'self-recovery propensity x2 — OUTSIDE the declared band, a stress test not a sensitivity row',
    why:
      'MEASURED, BECAUSE THE +30% ROW ABOVE TURNED OUT TO BE ALMOST POWERLESS. Counting the latents ' +
      'directly across the five TEST worlds: the baseline has 22 self-recoverers in 400 cases carrying ' +
      '₹4,33,634 of exposure, and +30% takes that to 24 carrying ₹4,34,424 — two more cases and ₹790 ' +
      'more exposure. The truncated posterior is why: a case whose self-recovery window has already ' +
      'elapsed is provably not a self-recoverer at any base rate, and that is 43% of the batch. So ' +
      '"the ranking survives +30% self-recovery" would be a null about the size of the perturbation ' +
      'dressed up as a null about the policy, on the one assumption whose own basis field calls itself ' +
      'load-bearing. x2 moves 22 to 38 and the exposure by 48%, which is enough to actually hurt. It ' +
      'sits outside the declared ±30% band and says so in its own label, so it can never be quoted as ' +
      'a sensitivity result — it answers "how wrong would this have to be to break us".',
    assumptionOverrides: scaleSelfRecovery(2),
  },
  {
    id: 'grant-rate-x0.7',
    family: 'world',
    label: 'approver grant rate -30%',
    why:
      'Denials are terminal, so the grant rate is a ceiling on the exposure any arm can ever reach. ' +
      'A stricter reviewer caps Rebound specifically, because Rebound is the only arm that asks.',
    assumptionOverrides: scaleGrantRate(0.7),
  },
  {
    id: 'grant-rate-x1.3-clamped',
    family: 'world',
    label: 'approver grant rate +30%, clamped at 0.9',
    why:
      'Clamped short of 1.0 by the declared sweep range. A reviewer who grants everything is not a ' +
      'perturbed human, it is the removal of the approval gate — and removing our own compliance ' +
      'constraint would raise the headline while being reported as robustness.',
    assumptionOverrides: scaleGrantRate(1.3),
  },
  {
    id: 'cause-mix-do-not-honour-x3',
    family: 'world',
    label: 'DO_NOT_HONOUR 3x more likely, model refitted',
    why:
      'The cause composition is the shift that attacks the diagnosis layer the whole project rests ' +
      'on, and DO_NOT_HONOUR is the vague-but-retryable cause the taxonomy handles worst. Applied to ' +
      'TRAIN and TEST together, so the agent learns the tilted world and the row isolates composition ' +
      'from staleness.',
    generatorOverrides: { causeGivenPayer: tiltCauseMix(CAUSE_GIVEN_PAYER, { cause: 'DO_NOT_HONOUR', factor: 3 }) },
  },
  {
    id: 'cause-mix-insufficient-funds-x3',
    family: 'world',
    label: 'INSUFFICIENT_FUNDS 3x more likely, model refitted',
    why:
      'The opposite kind of tilt: a cause where WAITING is the right answer and the salary-window ' +
      'timing edge should pay off. If Rebound gains here and loses on the DO_NOT_HONOUR row, the ' +
      'advantage is timing rather than diagnosis, which is a sharper claim than "the agent is smarter".',
    generatorOverrides: { causeGivenPayer: tiltCauseMix(CAUSE_GIVEN_PAYER, { cause: 'INSUFFICIENT_FUNDS', factor: 3 }) },
  },

  // ------------------------------------------------------------------ the policy knob, reported not chosen
  {
    id: 'ev-bar-k0',
    family: 'policy',
    label: 'EV bar k = 0 (the flat ₹2 floor)',
    why:
      'The policy that #52 replaced, reachable from this one code state. Reported for the curve, NOT ' +
      'offered as a choice: k = 1 was fixed by the argument that a noise bar must scale with the noise, ' +
      'before this sweep existed. See the header.',
    policy: { evBarSigmaK: 0 },
  },
  {
    id: 'ev-bar-k2',
    family: 'policy',
    label: 'EV bar k = 2',
    why: 'Two standard errors. Should trade recovered rupees for fewer actions — a trade a merchant may legitimately want to set.',
    policy: { evBarSigmaK: 2 },
  },

  // ------------------------------------------------------------------ joint, and therefore honest
  {
    id: 'joint-1',
    family: 'joint',
    label: 'every assumption drawn from its declared range (draw 1)',
    why:
      'Assumptions are not wrong one at a time. `perturbAssumptions(A, 1.0, rng)` moves all of them ' +
      'at once, each within the `sweep` range printed by `describe-sim`, so a row here is a plausible ' +
      'alternative world rather than a single edited constant. Not attributable — that is the price.',
    assumptions: (rng) => perturbAssumptions(materialiseAssumptions(), 1.0, rng),
    rngSeed: 'sweep|joint|1',
  },
  {
    id: 'joint-2',
    family: 'joint',
    label: 'every assumption drawn from its declared range (draw 2)',
    why: 'A second draw. Three draws is not a distribution and is not offered as one; it is three worlds.',
    assumptions: (rng) => perturbAssumptions(materialiseAssumptions(), 1.0, rng),
    rngSeed: 'sweep|joint|2',
  },
  {
    id: 'joint-3',
    family: 'joint',
    label: 'every assumption drawn from its declared range (draw 3)',
    why:
      'A third draw, and the last. Three draws is not a distribution and is not offered as one — it ' +
      'is three named worlds a reader can inspect individually, which is why they print as three rows ' +
      'rather than as a mean with an interval around it.',
    assumptions: (rng) => perturbAssumptions(materialiseAssumptions(), 1.0, rng),
    rngSeed: 'sweep|joint|3',
  },

  // ------------------------------------------------------------------ the different question, labelled
  {
    id: 'stale-model',
    family: 'skew',
    label: 'world perturbed jointly, model NOT refitted',
    why:
      'THIS ROW ANSWERS A DIFFERENT QUESTION AND IS SEPARATED SO IT CANNOT BE READ AS THE OTHERS ARE. ' +
      'The world moves and the agent keeps beliefs fitted in the baseline world, so this measures ' +
      'robustness to being WRONG about the assumptions rather than sensitivity to their values. It is ' +
      'the harder test and the one closest to deployment; it also cannot attribute a flip, because the ' +
      "perturbation's effect and the size of the train/serve gap move together. It shares `joint-1`'s " +
      'rng seed, so the two rows are the same world and differ in exactly one variable: whether the ' +
      'model was allowed to see it. Read them as a pair or not at all.',
    assumptions: (rng) => perturbAssumptions(materialiseAssumptions(), 1.0, rng),
    rngSeed: 'sweep|joint|1',
    refit: false,
  },
];

const BY_ID = new Map(CATALOGUE.map((p) => [p.id, p]));

export const PERTURBATION_IDS = CATALOGUE.map((p) => p.id);

/**
 * Resolve one perturbation id into everything a run needs, with the tables already built.
 *
 * Throws on an unknown id. That is the whole reason the ids are a closed list: a typo must be an
 * error, because a typo that silently produced the baseline would print a row saying "no effect".
 */
export function resolvePerturbation(id) {
  const spec = BY_ID.get(id);
  if (!spec) {
    throw new Error(
      `unknown perturbation "${id}". Known ids:\n  ${PERTURBATION_IDS.join('\n  ')}`
    );
  }

  /**
   * The joint rows need randomness, and it comes from a FIXED seed string rather than from the
   * process. A sweep whose worlds differ between two invocations is not reproducible, and
   * irreproducible sensitivity numbers are worse than none: a reader who re-runs and gets different
   * figures cannot tell whether the difference is the perturbation or the machine.
   */
  const rng = spec.rngSeed ? makeRng(spec.rngSeed) : null;

  const assumptions = spec.assumptions
    ? spec.assumptions(rng)
    : materialiseAssumptions(spec.assumptionOverrides ?? {});

  /**
   * DERIVED, NOT DECLARED. See `scaleSelfRecovery` for the bug this closes: a self-recovery
   * perturbation that lives only in the assumption set never reaches the world, because whether a
   * customer pays unprompted is a latent drawn at generation time.
   *
   * The equality test is against the baseline table rather than a per-row flag so that any row moving
   * self-recovery — the two explicit rows, all three joint draws, `stale-model` — gets the world moved
   * with it, including rows nobody has written yet.
   */
  const selfRecoveryMoved = Object.keys(BASE_SELF_RECOVERY).some(
    (lt) => assumptions.selfRecoveryRate?.[lt] !== BASE_SELF_RECOVERY[lt]
  );
  const generatorOverrides = selfRecoveryMoved
    ? { ...(spec.generatorOverrides ?? {}), selfRecoveryRate: { ...assumptions.selfRecoveryRate } }
    : (spec.generatorOverrides ?? {});

  return {
    id: spec.id,
    family: spec.family,
    label: spec.label,
    why: spec.why,
    /** True when nothing at all was changed — the control row. */
    isBaseline: spec.family === 'none',
    /** Whether the agent's model is refitted in the perturbed world. See the header. */
    refit: spec.refit !== false,
    /**
     * True where the catalogue pre-registers that this row should barely move. The sweep flags an
     * unmoved row as a suspected wiring bug, and this is what stops it flagging a confirmed prediction.
     */
    expectNoMovement: spec.expectNoMovement === true,
    COSTS: spec.costs ?? COSTS,
    CONTRIBUTION_MARGIN: spec.margins ?? CONTRIBUTION_MARGIN,
    POLICY: spec.policy ? { ...POLICY, ...spec.policy } : POLICY,
    assumptions,
    generatorOverrides,
  };
}

/** The catalogue as data, for `--list` and for the sweep's own header. */
export function describePerturbations() {
  return CATALOGUE.map(({ id, family, label, why, refit, expectNoMovement }) => ({
    id,
    family,
    label,
    why,
    refit: refit !== false,
    expectNoMovement: expectNoMovement === true,
  }));
}
