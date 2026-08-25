/**
 * SUPERSEDED, AND FOR A REASON WORTH READING: THIS PROBE'S GROUND TRUTH WAS CIRCULAR.
 * ===================================================================================
 * It set out to answer "can a retry on this population actually work" and it used the TAXONOMY's own
 * `ROOT_CAUSES[cause].retryCanSucceed` as the ground truth for the answer. But that flag is a property
 * of the label, not of the world. So the "105/105 truly retry-hopeless" result below does not establish
 * that retries were hopeless — it establishes only that the DIAGNOSIS MATCHED THE TRUE CAUSE, which is
 * a fact about the diagnosis layer and was never in question here.
 *
 * The lesson generalises past this file: **when a probe reaches for ground truth, check that the truth
 * it reaches for is independent of the thing being tested.** A latent is only ground truth for questions
 * the latent actually decides. `retryCanSucceed` decides nothing in the response model; the response
 * model decides.
 *
 * `probe-mispricing.mjs` supersedes this one. It compares predicted probability against the EMPIRICAL
 * recovery rate drawn from the response model, which is the quantity that was actually in dispute, and
 * it is the probe that found #68 — retries priced at 18% on invoices that were never charged.
 *
 * It also turned out that `retryCanSucceed` is coarse enough to be wrong in both directions:
 * LIMIT_EXCEEDED and AUTH_NOT_COMPLETED both recover 13-15% empirically despite carrying
 * `retryCanSucceed: false`, and LIMIT_EXCEEDED even sits beside the comment `timingSensitive: true,
 * // daily limits reset`, which contradicts it outright. That is why #52 was NOT resolved by hard-gating
 * money movement on this flag: doing so would have suppressed real recovery. It was resolved with a
 * support-scaled EV bar instead, and the certain structural zeros were put in the response model where
 * they belong.
 *
 * Kept rather than deleted because the pre-registered prediction below FAILED and the record of that is
 * worth more than the file's conclusion.
 *
 * ---------------------------------------------------------------------------------------------------
 *
 * IS A RETRY ON A "HOPELESS" INSTRUMENT ACTUALLY HOPELESS? — the measurement that decides #52.
 *
 * `probe-evbar.mjs` found that 105 of 219 chosen actions are retries on cases whose DIAGNOSED root
 * cause carries `physics.retryCanSucceed: false`, and that the model prices them at p = 0.10 to 0.26
 * with 900 supporting rows. Task #52 assumes that is waste. This checks the assumption instead of
 * acting on it, because there are two very different worlds consistent with those numbers:
 *
 *   WASTE — the diagnosis is right, the retries genuinely cannot work, and the model has been fooled.
 *   SKILL — the diagnosis is often WRONG on this population, retries really do recover about a fifth
 *           of the time, and the model has correctly learned to discount an unreliable diagnosis.
 *
 * Day 4 measured TEXT-tier diagnoses at 0% accuracy, so SKILL is not a stretch. The two are
 * distinguishable with ground truth, which is what the simulator's latents are for and why this file
 * lives at the repo root rather than under `src/agent/**`.
 *
 * PRE-REGISTERED PREDICTION: the diagnosis is wrong often enough on the hopeless-diagnosed population
 * that the true retry-hopeless share is well under 100% — I expect somewhere around 60-80% truly
 * hopeless. If it comes back at essentially 100% truly hopeless, #52 is a real defect and the model is
 * being fooled by something else. If it comes back near the model's own 20% recoverable, the physics
 * flag is being correctly discounted and #52 should be closed as measured.
 *
 * Run: node probe-hopeless.mjs
 */
import { fitRecoveryScorer, buildWorld } from './src/eval/harness.js';
import { decideForCase } from './src/agent/decide.js';
import { EVAL_NOW } from './src/eval/evalClock.js';
import { GUARDRAILS, POLICY } from './src/core/config.js';
import { ROOT_CAUSES } from './src/core/taxonomy.js';

const startAt = new Date(EVAL_NOW);
const RETRIES = new Set(['RETRY_NOW', 'RETRY_SCHEDULED']);
const isRetry = (sig) => RETRIES.has(String(sig).split(':')[0]);

let chosen = 0;
let diagHopeless = 0;
let diagHopelessRetry = 0;
let trulyHopeless = 0;
let trulyRecoverable = 0;
const byTier = new Map();
const causeConfusion = new Map();

for (const seed of ['1', '2', '3']) {
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
  const world = await buildWorld({ seed, split: 'TRAIN', count: 80, startAt, train });

  for (const event of world.events) {
    const observed = world.observedById.get(event.eventId);
    const diagnosis = world.diagnosisById.get(event.eventId);
    const latent = world.latentById.get(event.eventId);
    if (!observed || !diagnosis || !latent) continue;

    const rec = decideForCase({
      observed, diagnosis, record: {}, scoreAction, now: startAt,
      config: { GUARDRAILS, POLICY },
    });
    if (!rec.chosen || !Number.isFinite(rec.chosen.evPaise)) continue;
    chosen += 1;

    if (diagnosis.physics?.retryCanSucceed !== false) continue;
    diagHopeless += 1;
    if (!isRetry(rec.chosen.signature)) continue;
    diagHopelessRetry += 1;

    // GROUND TRUTH: the physics of the cause that ACTUALLY produced this failure.
    const trueCause = latent.rootCause ?? latent.cause ?? latent.trueRootCause;
    const truePhysics = ROOT_CAUSES[trueCause]?.physics ?? ROOT_CAUSES[trueCause];
    const trueCanRetry = truePhysics?.retryCanSucceed;
    if (trueCanRetry === true) trulyRecoverable += 1;
    else if (trueCanRetry === false) trulyHopeless += 1;

    const tier = diagnosis.matchTier ?? 'NONE';
    const t = byTier.get(tier) ?? { n: 0, wrong: 0 };
    t.n += 1;
    if (trueCanRetry === true) t.wrong += 1;
    byTier.set(tier, t);

    if (trueCause !== diagnosis.rootCause) {
      const k = `${diagnosis.rootCause}  <-  actually ${trueCause}`;
      causeConfusion.set(k, (causeConfusion.get(k) ?? 0) + 1);
    }
  }
}

console.log(`\nchosen actions: ${chosen}`);
console.log(`diagnosed retry-hopeless: ${diagHopeless}`);
console.log(`...and a retry was chosen anyway: ${diagHopelessRetry}\n`);
console.log('GROUND TRUTH on exactly those retries:');
const denom = trulyHopeless + trulyRecoverable;
console.log(`  truly retry-hopeless:  ${trulyHopeless}  (${(trulyHopeless / denom * 100).toFixed(1)}%)`);
console.log(`  truly RETRYABLE:       ${trulyRecoverable}  (${(trulyRecoverable / denom * 100).toFixed(1)}%)  <-- the diagnosis was wrong here`);

console.log('\nBY MATCH TIER — where does the diagnosis go wrong on this population?');
console.log('  tier        n    diagnosed hopeless but truly retryable');
for (const [tier, t] of [...byTier].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(tier).padEnd(10)} ${String(t.n).padStart(3)}    ${t.wrong} (${(t.wrong / t.n * 100).toFixed(1)}%)`);
}

console.log('\nTHE CONFUSIONS DRIVING IT (top 8):');
for (const [k, c] of [...causeConfusion].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(c).padStart(3)} x  ${k}`);
}
