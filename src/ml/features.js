/**
 * FEATURES
 * ========
 *
 * Turns (observed event, diagnosis, candidate action, context) into a numeric vector.
 *
 * This is the most tempting file in the project to cheat in, which is why `src/ml/**` was added
 * to `test/boundary.test.js`'s RESTRICTED list *before* this file existed. One line reading
 * `latent.payerType` here would take the model from good to nearly perfect, and the diff would
 * look entirely innocent — a feature is just a number, and nobody reviewing a feature list asks
 * where each number came from. The test now fails the build if this directory so much as mentions
 * a latent field name.
 *
 * WHAT THE MODEL IS ALLOWED TO KNOW
 * ---------------------------------
 * Exactly three sources, and each corresponds to something a real merchant genuinely has:
 *
 *   1. the observable event      — what Razorpay told us, via `observe()`
 *   2. our own diagnosis         — what we inferred, including HOW we inferred it
 *   3. the action and context    — what we are considering doing, and our own contact history
 *
 * Note that (2) is our own output, not privileged information. Feeding the diagnosis in as a
 * feature is legitimate precisely because the diagnosis was itself produced from observables
 * only, and it is measurably imperfect — 92.0% on TRAIN, 87.2% on held-out TEST. The model
 * inherits those errors, which is correct: a production model would inherit them too.
 *
 * WHY `matchTier` IS A FEATURE, AND WHY THAT IS THE POINT OF DAY 4
 * ---------------------------------------------------------------
 * Day 4 measured per-tier diagnosis accuracy: REASON-tier diagnoses were 100% correct, TEXT-tier
 * were 0% correct. So "the cause is EXPIRED_INSTRUMENT" means something completely different
 * depending on how that conclusion was reached, and the tier is the observable that says which.
 *
 * Handing the model the tier lets it learn to discount the diagnosed cause exactly when the
 * diagnosis is unreliable, instead of trusting all diagnoses equally. This is what it looks like
 * to use a measured uncertainty rather than an invented confidence number: Day 4 refused to emit
 * a made-up 0.93, and Day 5 gets to feed in the thing that was actually measured instead.
 *
 * WHY INTERACTION TERMS ARE BUILT BY HAND
 * --------------------------------------
 * A linear model over [cause one-hot, action one-hot] can express "expired cards are hard" and
 * "retries succeed often", but it structurally CANNOT express "retrying an expired card is
 * hopeless while retrying an insufficient-funds failure is fine." That sentence is the entire
 * domain argument of this project, and it is a cause-by-action interaction.
 *
 * So the cause x action cross terms are constructed explicitly below. It is worth being clear
 * that this is me supplying the domain knowledge rather than the model discovering it — which is
 * precisely the comparison `npm run model-report` runs, since gradient-boosted trees find
 * interactions on their own. If the trees do not beat hand-specified interactions, that is a
 * finding about my feature engineering being adequate, not a failure of the comparison.
 */

import { LOSS_TYPES, RAILS } from '../core/enums.js';
import { ROOT_CAUSE_IDS } from '../core/taxonomy.js';
import { ActionKind, Channel, ALL_ACTION_KINDS } from '../core/actions.js';
import { MatchTier } from '../agent/diagnose.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CHANNELS = Object.values(Channel);
const TIERS = Object.values(MatchTier);

/**
 * Causes crossed with actions. Restricted to money-collecting actions because STOP_PERMANENT and
 * NO_ACTION_YET have a structurally zero recovery probability — a cross term for them would be a
 * column that is always multiplied by an outcome of 0, which contributes nothing but variance.
 */
const INTERACTION_ACTIONS = Object.freeze([
  ActionKind.RETRY_NOW,
  ActionKind.RETRY_SCHEDULED,
  ActionKind.SEND_LINK,
  ActionKind.SWITCH_RAIL_NUDGE,
  ActionKind.REQUEST_REAUTH,
  ActionKind.ESCALATE_HUMAN,
]);

/**
 * The salary-credit window, as a DATE ARITHMETIC feature rather than a latent read.
 *
 * The response model gives a large boost (2.4x at baseline) to charges that land after a
 * customer's salary credit, and `fundsAvailableFrom` is latent — the agent cannot see it. But
 * salary credits in India cluster at month start, and the day of the month of a *scheduled* retry
 * is something we choose and therefore know exactly.
 *
 * So this feature is the observable proxy for an unobservable cause. Whether it actually carries
 * signal is a question for the measurement, not for me: if the model learns a positive
 * coefficient on it, that is the model rediscovering the salary-window effect from timing alone,
 * which is the single most satisfying thing it could do. If it learns nothing, the proxy is too
 * weak and that gets reported.
 */
export function salaryWindowProximity(when) {
  if (!when) return 0;
  const day = new Date(when).getUTCDate();
  // Peaks on the 1st and decays across the first week; near zero for the rest of the month.
  // Also treats the last two days of the month as partial, since credits land slightly early.
  if (day >= 29) return 0.4;
  return Math.max(0, 1 - (day - 1) / 7);
}

/** One-hot block. Returns names and values together so the two can never drift apart. */
function oneHot(prefix, value, universe) {
  return universe.map((k) => [`${prefix}=${k}`, value === k ? 1 : 0]);
}

/**
 * Build the feature vector for one (case, action) pair.
 *
 * @param diagnosis  output of `diagnose()` — our own inference, not privileged data
 * @param observed   output of `observe()` — the observable projection of the event
 * @param action     the candidate action under consideration
 * @param context.now          decision time, as a Date
 * @param context.touchesUsed  how many times WE have contacted this customer already. Observable
 *                             because it is our own outgoing message log, not anything about them.
 *
 * Returns `{ names, values }`. Names exist so a logistic model's coefficients can be printed as
 * readable domain claims — "retry x expired instrument: -2.9" is an auditable statement, whereas
 * "w[87] = -2.9" is not, and this project has to be defensible out loud.
 */
export function buildFeatures({ diagnosis, observed, action, context = {} }) {
  const now = context.now ? new Date(context.now) : new Date();
  const touchesUsed = context.touchesUsed ?? 0;

  const pairs = [];
  const push = (name, value) => pairs.push([name, Number.isFinite(value) ? value : 0]);

  // ---- bias -------------------------------------------------------------------------------
  push('bias', 1);

  // ---- what kind of loss, and how much ----------------------------------------------------
  for (const [n, v] of oneHot('loss', observed?.lossType, LOSS_TYPES)) push(n, v);
  for (const [n, v] of oneHot('rail', observed?.rail, RAILS)) push(n, v);

  // Log-scaled and centred. Amounts span roughly ₹100 to ₹5,00,000, so the raw paise value would
  // dominate every gradient step and force a tiny learning rate for every other feature.
  const amount = Math.max(1, observed?.amountPaise ?? 0);
  push('logAmount', (Math.log(amount) - 11) / 3);

  // ---- how stale the case is --------------------------------------------------------------
  const ageDays = observed?.occurredAt
    ? Math.max(0, (now.getTime() - new Date(observed.occurredAt).getTime()) / DAY_MS)
    : 0;
  push('ageDays', ageDays / 7);
  // Recovery probability decays exponentially in age, so a linear model needs the nonlinearity
  // supplied. Without this the model can only fit a straight line through a curve.
  push('ageDecayProxy', Math.exp(-ageDays / 7));

  push('priorAttempts', observed?.priorAttempts ?? 0);

  // ---- what we think went wrong, and how confident that inference is ----------------------
  for (const [n, v] of oneHot('cause', diagnosis?.rootCause, ROOT_CAUSE_IDS)) push(n, v);
  for (const [n, v] of oneHot('tier', diagnosis?.matchTier, TIERS)) push(n, v);
  push('abstained', diagnosis?.abstained ? 1 : 0);

  // Recovery physics, as flags. Redundant with the cause one-hot in principle — the physics are a
  // deterministic function of the cause — but they group 13 sparse columns into a handful of dense
  // ones, which is what lets the model generalise to a cause it saw only a few times.
  const phys = diagnosis?.physics ?? {};
  push('phys.retryCanSucceed', phys.retryCanSucceed ? 1 : 0);
  push('phys.timingSensitive', phys.timingSensitive ? 1 : 0);
  push('phys.prefersSalaryWindow', phys.prefersSalaryWindow ? 1 : 0);
  push('phys.railSwitchHelps', phys.railSwitchHelps ? 1 : 0);
  push('phys.railSwitchIsPrimary', phys.railSwitchIsPrimary ? 1 : 0);
  push('phys.needsNewInstrument', phys.needsNewInstrument ? 1 : 0);
  push('phys.requiresReauth', phys.requiresReauth ? 1 : 0);
  push('phys.humanOnly', phys.humanOnly ? 1 : 0);

  // ---- observable context we happen to have -----------------------------------------------
  push('downtimeObservedAtFailure', observed?.downtime?.issuerDownAtFailure ? 1 : 0);
  push('mandateRevoked', observed?.subscription?.mandateStatus === 'revoked' ? 1 : 0);
  const cycle = observed?.subscription?.cycleNumber;
  push('subCycle', cycle ? Math.min(cycle, 24) / 24 : 0);
  push('isSubscription', observed?.subscription ? 1 : 0);
  push('invoiceFlagged', (observed?.invoice?.flags?.length ?? 0) > 0 ? 1 : 0);
  push('termsDays', (observed?.invoice?.termsDays ?? 0) / 60);

  // ---- our own contact history ------------------------------------------------------------
  // Fatigue is the mechanism behind "fewer messages recover more money", and it is driven by
  // touches spent against a LATENT patience budget. We can see the numerator and not the
  // denominator, so the model gets the count and has to learn the average denominator itself.
  push('touchesUsed', touchesUsed / 4);
  push('touchesUsedSq', (touchesUsed / 4) ** 2);
  push('anyTouchYet', touchesUsed > 0 ? 1 : 0);

  // ---- the action under consideration -----------------------------------------------------
  const kind = action?.kind;
  for (const [n, v] of oneHot('act', kind, ALL_ACTION_KINDS)) push(n, v);
  for (const [n, v] of oneHot('chan', action?.channel, CHANNELS)) push(n, v);

  const isScheduled = kind === ActionKind.RETRY_SCHEDULED && action?.scheduledFor;
  const delayHours = isScheduled
    ? Math.max(0, (new Date(action.scheduledFor).getTime() - now.getTime()) / 3_600_000)
    : 0;
  push('delayDays', delayHours / 24);
  push('isScheduled', isScheduled ? 1 : 0);

  // The observable proxy for an unobservable salary credit. Applied to the time the money would
  // actually be taken, which for a scheduled retry is the future slot and not now.
  push('salaryWindow', salaryWindowProximity(isScheduled ? action.scheduledFor : now));

  // Retrying the same rail that just failed, versus steering somewhere else. Observable, and the
  // response model penalises the former when the rail itself is the problem.
  push('sameRailRetry', kind === ActionKind.RETRY_NOW || kind === ActionKind.RETRY_SCHEDULED ? 1 : 0);

  // ---- interactions: the domain claim, made expressible ------------------------------------
  // "Retrying an expired card is hopeless; retrying an insufficient-funds failure is fine."
  // A linear model cannot say that without these columns.
  for (const cause of ROOT_CAUSE_IDS) {
    for (const act of INTERACTION_ACTIONS) {
      push(`x:${cause}*${act}`, diagnosis?.rootCause === cause && kind === act ? 1 : 0);
    }
  }

  // Timing-sensitive causes crossed with landing in the salary window — the specific mechanism
  // that should make RETRY_SCHEDULED beat RETRY_NOW. Called out separately because it is the
  // interaction I most expect to matter and want to be able to read off a coefficient.
  push(
    'x:timingSensitive*salaryWindow',
    (phys.timingSensitive ? 1 : 0) * salaryWindowProximity(isScheduled ? action.scheduledFor : now)
  );
  push('x:needsNewInstrument*reauth', (phys.needsNewInstrument ? 1 : 0) * (kind === ActionKind.REQUEST_REAUTH ? 1 : 0));
  push('x:railSwitchHelps*switch', (phys.railSwitchHelps ? 1 : 0) * (kind === ActionKind.SWITCH_RAIL_NUDGE ? 1 : 0));
  push('x:retryCanSucceed*retry', (phys.retryCanSucceed ? 1 : 0) * (kind === ActionKind.RETRY_NOW || isScheduled ? 1 : 0));

  return {
    names: pairs.map(([n]) => n),
    values: pairs.map(([, v]) => v),
  };
}

/**
 * The feature names, in order, derived by building one vector rather than maintained by hand.
 *
 * A hand-maintained list would drift from `buildFeatures` the first time a feature was added, and
 * the symptom would be coefficients printed against the wrong names — a silently misleading audit
 * trail rather than a crash.
 */
export function featureNames() {
  return buildFeatures({
    diagnosis: { rootCause: 'UNKNOWN', matchTier: MatchTier.NONE, physics: {} },
    observed: { lossType: LOSS_TYPES[0], rail: RAILS[0], amountPaise: 1000 },
    action: { kind: ActionKind.RETRY_NOW },
    context: { now: new Date(0), touchesUsed: 0 },
  }).names;
}

export const FEATURE_COUNT = featureNames().length;
