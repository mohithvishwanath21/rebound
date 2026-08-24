/**
 * TRAINING DATA
 * =============
 *
 * Builds labelled rows for the recovery-probability model by actually simulating outcomes.
 *
 * Lives under `src/eval/` because it must touch latent truth to produce a label, and the boundary
 * test permits exactly this directory to do so. `src/ml/**` — where the model and the features
 * live — cannot reach any of it.
 *
 * THE SINGLE MOST IMPORTANT LINE IN THIS FILE IS THE LABEL
 * -------------------------------------------------------
 * The label is a Bernoulli DRAW, `rng.next() < p`, never `p` itself.
 *
 * Training on `p` would be the most attractive mistake available here. It would converge faster,
 * produce beautiful calibration curves, and be completely worthless — no real merchant has ever
 * observed a probability. They observe that this one customer either paid or did not. A model
 * trained on `p` would be learning to copy a function I wrote, and its reported calibration would
 * be a statement about curve-fitting rather than about prediction.
 *
 * Training on 0/1 draws means the model has to recover the probability from noisy binary outcomes,
 * which is the actual problem. It also means the model can never be perfect, and the exact size of
 * that imperfection is computable — see `aleatoricFloor` below.
 *
 * `trueP` IS RETAINED, AND ONLY THE EVAL SIDE MAY READ IT
 * ------------------------------------------------------
 * Each row keeps the true probability alongside the drawn label. That is not a leak: nothing in
 * `src/ml/**` receives it, the training call takes `{ x, y }` only, and the boundary test enforces
 * the directory rule. It is retained because it makes two otherwise impossible measurements
 * possible — the irreducible error floor, and how far each model sits above it.
 *
 * WHAT THIS IS AND IS NOT EVIDENCE OF
 * -----------------------------------
 * Every number downstream of this file is a statement about a documented simulator, not about
 * Razorpay. The honest claim is "the model recovers the response model's structure from
 * observables alone, and here is how much of the remaining error is irreducible." The dishonest
 * version, which I am not making, is "the model predicts payment recovery at X accuracy."
 */

import { observe } from '../agent/observe.js';
import { diagnose } from '../agent/diagnose.js';
import { buildFeatures } from '../ml/features.js';
import { simulateActionOutcome, materialiseAssumptions } from '../sim/responseModel.js';
import { ActionKind, Channel } from '../core/actions.js';
import { makeRng, deriveSeed } from '../core/rng.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 3_600_000;

/**
 * Candidate actions considered for each case when building training data.
 *
 * Deliberately NOT the full `enumerateCandidateActions()` cross product. That would produce every
 * channel for every message type at every scheduled slot, and the resulting dataset would be
 * dominated by near-duplicate rows that differ only in channel — the model would spend its
 * capacity on channel reach, which is the least interesting parameter in the response model.
 *
 * A representative subset keeps the class balance and the action mix informative. The scheduled
 * slots straddle a month boundary on purpose: without a slot inside the salary window and one
 * outside it, the timing effect is unlearnable, and RETRY_SCHEDULED versus RETRY_NOW is the
 * highest-leverage distinction the model has to make.
 */
function candidateActionsFor(now) {
  const at = (ms) => new Date(now.getTime() + ms).toISOString();
  return [
    { kind: ActionKind.RETRY_NOW },
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(6 * HOUR_MS) },
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(3 * DAY_MS) },
    { kind: ActionKind.RETRY_SCHEDULED, scheduledFor: at(9 * DAY_MS) },
    { kind: ActionKind.SEND_LINK, channel: Channel.WHATSAPP },
    { kind: ActionKind.SEND_LINK, channel: Channel.EMAIL },
    { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.WHATSAPP },
    { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: Channel.SMS },
    { kind: ActionKind.REQUEST_REAUTH, channel: Channel.WHATSAPP },
    { kind: ActionKind.REQUEST_REAUTH, channel: Channel.EMAIL },
    { kind: ActionKind.ESCALATE_HUMAN },
  ];
}

/**
 * Build a labelled dataset from a generated batch.
 *
 * @param events    generated events
 * @param latents   parallel latent truth (used ONLY for the outcome draw and for `trueP`)
 * @param seed      rng seed for the outcome draws and context sampling
 * @param contextsPerEvent  how many (decision time, touches already spent) contexts to sample
 * @param llm       optional tier-2 classifier, threaded into diagnosis
 *
 * @returns {{ rows: Array, featureNames: string[] }}
 *   each row: { x, y, trueP, eventId, amountPaise, actionKind, actionSignature, causeTruth }
 */
export async function buildDataset({
  events,
  latents,
  seed = 'day5',
  contextsPerEvent = 3,
  assumptions = materialiseAssumptions(),
  llm,
} = {}) {
  if (!Array.isArray(events) || !Array.isArray(latents)) {
    throw new TypeError('buildDataset({ events, latents }): both must be arrays');
  }

  const truthByEvent = new Map(latents.map((l) => [l.eventId, l]));
  const rng = makeRng(deriveSeed(seed, 'dataset'));
  const rows = [];
  let featureNames = null;

  for (const event of events) {
    const truth = truthByEvent.get(event.eventId);
    // Same reasoning as the diagnosis scorer: silently skipping a malformed row would shrink the
    // denominator and quietly flatter every metric computed from it.
    if (!truth) throw new Error(`no latent truth for event ${event.eventId}`);

    // The agent's own view. `observe()` is the projection; `diagnose()` is our inference. Both run
    // on observables only, and the model downstream sees nothing else.
    const observed = observe(event);
    const diagnosis = await diagnose(observed, { llm });

    for (let c = 0; c < contextsPerEvent; c += 1) {
      // Sample a decision moment and a contact history. Varying both is what lets the model learn
      // age decay and fatigue at all — a dataset captured at a single instant with zero touches
      // would leave both effects invisible, and the model would then be confidently wrong the
      // first time the orchestrator contacted somebody twice.
      const now = new Date(
        new Date(event.detectedAt ?? event.occurredAt).getTime() + rng.float(0, 10) * DAY_MS
      );
      const touchesUsed = c === 0 ? 0 : rng.int(0, 4);

      for (const action of candidateActionsFor(now)) {
        const outcome = simulateActionOutcome({
          action, latent: truth, event, now, touchesUsed, assumptions, rng,
        });

        const { names, values } = buildFeatures({ diagnosis, observed, action, context: { now, touchesUsed } });
        featureNames ??= names;

        rows.push({
          x: values,
          // THE LABEL. A draw, not a probability. See the header.
          y: outcome.recovered ? 1 : 0,
          // Eval-side only. Never passed to anything under src/ml/.
          trueP: outcome.p,
          eventId: event.eventId,
          amountPaise: event.amountPaise,
          actionKind: action.kind,
          touchesUsed,
          // Identifies the (event, decision-moment) group this row belongs to. All 11 candidate
          // actions for one moment share a groupKey, which is what makes action-SELECTION scoring
          // possible: the question "would the model have picked the right action here" is only
          // answerable across a group, never from a single row.
          //
          // It is also the correct unit for a train/validation split. Splitting rows at random
          // would scatter the 33 rows belonging to one event across both sides, and since those
          // rows share a diagnosis, an amount and a latent payer, the validation set would be
          // contaminated with near-duplicates of training rows and every held-out number would be
          // optimistic. Splits must be taken on eventId.
          contextIndex: c,
          groupKey: `${event.eventId}#${c}`,
          // Our own inference, carried alongside the feature vector so the lookup-table baseline
          // can GROUP BY (cause, action) without re-deriving it from one-hot columns. Safe for
          // `src/ml/**` to read: these are outputs of `diagnose()`, which itself only ever saw
          // observables. Not the same category of thing as `trueP` above.
          diagnosedCause: diagnosis.rootCause,
          matchTier: diagnosis.matchTier,
          abstained: Boolean(diagnosis.abstained),
        });
      }
    }
  }

  return { rows, featureNames };
}

/**
 * THE IRREDUCIBLE ERROR FLOOR.
 *
 * Outcomes are Bernoulli draws, so even a model that knew every true probability exactly would
 * still be wrong sometimes — it would predict 0.3 and the customer would either pay or not. The
 * expected Brier score of a perfectly-informed predictor is therefore mean(p * (1 - p)), which is
 * a closed form rather than an estimate.
 *
 * This number is why the model report is readable at all. "Brier 0.081" means nothing in
 * isolation; "Brier 0.081 against an irreducible floor of 0.074" says the model has captured
 * essentially all the learnable structure and the rest is coin-flipping. Reporting a raw score
 * with no floor invites a reader to imagine the remaining error is addressable, and usually it
 * is not.
 *
 * Only callable here, on the eval side, because it needs `trueP`.
 */
export function aleatoricFloor(rows) {
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + r.trueP * (1 - r.trueP), 0) / rows.length;
}

/**
 * Features an ORACLE is allowed to see: the latent variables that actually drive the outcome.
 *
 * This exists to establish a ceiling, and it is the one model in the project deliberately built to
 * cheat. Comparing an honest model against it separates two very different explanations for a
 * mediocre score — "my model is bad" and "the observables genuinely do not contain the answer."
 * Without the oracle those are indistinguishable, and the temptation is always to assume the first
 * and keep adding features that cannot help.
 *
 * Note it is trained on the same noisy 0/1 draws, not on `trueP`. An oracle handed the answer
 * directly would measure nothing at all.
 */
export function oracleFeatures(rows, events, latents) {
  const truthByEvent = new Map(latents.map((l) => [l.eventId, l]));
  const PAYER_TYPES = ['WILL_PAY_IF_REMINDED', 'TEMPORARILY_SHORT', 'NEEDS_NEW_INSTRUMENT', 'DISPUTING', 'NEVER_PAYING'];

  return rows.map((row) => {
    const t = truthByEvent.get(row.eventId);
    const extra = [
      ...PAYER_TYPES.map((p) => (t.payerType === p ? 1 : 0)),
      t.responsiveness ?? 0.5,
      (t.patienceBudget ?? 4) / 7,
      t.willSelfRecover ? 1 : 0,
      (t.workingRails?.length ?? 0) / 3,
    ];
    return { ...row, x: [...row.x, ...extra] };
  });
}
