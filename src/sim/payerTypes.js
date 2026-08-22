/**
 * LATENT PAYER TYPES — the pure enum, no persistence dependency.
 *
 * Split out of `latentTruth.js` so the response model and generator can be imported
 * and unit-tested without pulling in mongoose.
 *
 * Kept under `src/sim/` rather than `src/core/` on purpose. The enum itself is not
 * secret — knowing five payer types exist leaks nothing. But `src/core/` is imported
 * freely by `src/agent/`, and putting anything payer-type-shaped there would make it
 * one autocomplete away from a tired developer joining latent truth onto a decision.
 * The boundary is cheap to keep and expensive to rebuild, so it stays here.
 *
 * WHY THESE FIVE
 * --------------
 * They are what make the policy problem non-trivial. Each responds to a *different*
 * action, and three of them actively punish the obvious action. Any one of them in
 * isolation would collapse the problem into a single fixed tactic.
 */

export const PayerType = {
  /**
   * Has the money and the intent; something mechanical got in the way.
   * Responds well to a fresh link or a rail switch.
   *
   * This is the type every naive agent implicitly assumes *everyone* is — which is
   * precisely why naive agents look reasonable in a demo and waste money in production.
   */
  WILL_PAY_IF_REMINDED: 'WILL_PAY_IF_REMINDED',

  /**
   * Intends to pay, currently cannot. Probability rises sharply once funds arrive,
   * which in India clusters around salary credit dates.
   *
   * The type that rewards patience and punishes immediacy: three retries in ten
   * minutes fail three times, while one well-timed retry on the 2nd of the month
   * succeeds. Same attempt budget, opposite outcome. This is the strongest argument
   * for treating *when* as a decision variable rather than a scheduling detail.
   */
  TEMPORARILY_SHORT: 'TEMPORARILY_SHORT',

  /**
   * Their instrument is dead — expired card, revoked mandate.
   *
   * Retry probability is hard-coded to EXACTLY zero for this type. Not small: zero.
   * The only action that can recover them is collecting a new instrument. An agent
   * that retries here spends its entire attempt budget on a mathematical
   * impossibility, which is the sharpest available illustration of why diagnosis
   * beats retry throughput.
   */
  NEEDS_NEW_INSTRUMENT: 'NEEDS_NEW_INSTRUMENT',

  /**
   * Withholding payment pending a disagreement.
   *
   * Messaging has NEGATIVE expected value here — each automated chase measurably
   * hardens their position and raises churn risk, because it signals that nobody read
   * their complaint. Only human contact helps. This is the type that makes STOP and
   * ESCALATE genuinely value-creating rather than merely harmless.
   */
  DISPUTING: 'DISPUTING',

  /**
   * Gone. Churned, fraudulent, or never intended to pay.
   *
   * Every rupee spent here is pure loss. Correctly identifying this type and stopping
   * is where a cost-aware policy generates most of its advantage — not by recovering
   * more from them, but by reallocating the budget they would have consumed to cases
   * that can still be won.
   */
  NEVER_PAYING: 'NEVER_PAYING',
};

export const PAYER_TYPES = Object.values(PayerType);
