/**
 * DIAGNOSIS ACCURACY
 * ==================
 *
 * Scores what the agent believed against what was actually true.
 *
 * This file lives under `src/eval/` and not under `src/agent/`, and that placement is load
 * bearing. `test/boundary.test.js` forbids agent code from reading latent truth and explicitly
 * permits eval code to do it, because comparing beliefs to truth is the entire job here. If
 * this logic drifted into the agent, the agent could grade itself, and every number below
 * would become decoration.
 *
 * WHY THE HEADLINE ACCURACY NUMBER IS THE LEAST INTERESTING THING HERE
 * -------------------------------------------------------------------
 * Accuracy weights every mistake equally, and these mistakes are not equal.
 *
 * Reading a revoked mandate as a generic bank decline and reading a generic bank decline as a
 * revoked mandate are both "one error." The first charges against an authorisation the customer
 * withdrew. The second declines to charge someone who would have paid. One is a compliance
 * incident, the other is a missed rupee.
 *
 * So this reports three things accuracy cannot see:
 *
 *   unsafeRetryBeliefs   truth says a retry can NEVER succeed, we believed it could. Every one
 *                        of these is a guaranteed-failed attempt that burns decline ratio —
 *                        which issuers and card networks watch, and which eventually gets your
 *                        *good* payments declined too. This is the number to drive down.
 *
 *   missedHumanOnly      truth says no automated action was permitted, we thought it was. The
 *                        compliance-direction error.
 *
 *   falseHumanOnly       truth permitted automation, we froze it and queued a human. Cheap in
 *                        risk, expensive in operator time and recoverable money. Reported
 *                        because the fix for `missedHumanOnly` is to over-freeze, and a metric
 *                        that cannot see the overcorrection invites it.
 *
 * PER-TIER ACCURACY IS THE POINT OF THE WHOLE EXERCISE
 * ---------------------------------------------------
 * `diagnose()` deliberately emits no confidence number, because nothing had measured one. What
 * it emits instead is HOW the match was made. This file turns those tiers into measured hit
 * rates, which is what a calibrated probability can honestly be built from on Day 5.
 */

import { diagnose } from '../agent/diagnose.js';
import { observe } from '../agent/observe.js';
import { getRootCause, ROOT_CAUSE_IDS } from '../core/taxonomy.js';

function emptyTier() {
  return { n: 0, correct: 0 };
}

/**
 * @param events   generated events, as the simulator produced them
 * @param latents  parallel latent-truth rows
 * @param opts.llm optional tier-2 classifier, passed straight through to diagnose()
 */
export async function scoreDiagnosis({ events, latents, llm } = {}) {
  if (!Array.isArray(events) || !Array.isArray(latents)) {
    throw new TypeError('scoreDiagnosis({ events, latents }): both must be arrays');
  }

  const truthByEvent = new Map(latents.map((l) => [l.eventId, l]));

  const byTier = {};
  const confusion = new Map();
  const byCause = {};
  for (const id of ROOT_CAUSE_IDS) byCause[id] = { truthN: 0, predictedN: 0, correct: 0 };

  let n = 0;
  let correct = 0;
  let abstained = 0;
  let unsafeRetryBeliefs = 0;
  let missedHumanOnly = 0;
  let falseHumanOnly = 0;
  let llmTierUsed = 0;
  let atRiskPaise = 0;
  let unsafeRetryPaise = 0;

  for (const event of events) {
    const truth = truthByEvent.get(event.eventId);
    // A missing truth row means the batch is malformed. Silently skipping would understate the
    // denominator and quietly flatter every rate below it.
    if (!truth) throw new Error(`no latent truth for event ${event.eventId}`);

    // `observe()` rather than the raw event. This is not defensive style, it is the mechanism:
    // the raw event still carries `_generatedVague`, and the projection is what removes it.
    const belief = await diagnose(observe(event), { llm });

    const truthCause = getRootCause(truth.trueRootCause);
    const isCorrect = belief.rootCause === truth.trueRootCause;

    n += 1;
    atRiskPaise += event.amountPaise ?? 0;
    if (isCorrect) correct += 1;
    if (belief.abstained) abstained += 1;
    if (belief.source === 'LLM') llmTierUsed += 1;

    byTier[belief.matchTier] ??= emptyTier();
    byTier[belief.matchTier].n += 1;
    if (isCorrect) byTier[belief.matchTier].correct += 1;

    byCause[truth.trueRootCause] ??= { truthN: 0, predictedN: 0, correct: 0 };
    byCause[belief.rootCause] ??= { truthN: 0, predictedN: 0, correct: 0 };
    byCause[truth.trueRootCause].truthN += 1;
    byCause[belief.rootCause].predictedN += 1;
    if (isCorrect) byCause[truth.trueRootCause].correct += 1;

    if (!isCorrect) {
      const key = `${truth.trueRootCause} -> ${belief.rootCause}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }

    // The money-weighted version matters as much as the count: ten unsafe retries on ₹99
    // subscriptions and ten on ₹50,000 invoices are not the same mistake.
    if (!truthCause.retryCanSucceed && belief.physics.retryCanSucceed) {
      unsafeRetryBeliefs += 1;
      unsafeRetryPaise += event.amountPaise ?? 0;
    }
    if (truthCause.humanOnly && !belief.physics.humanOnly) missedHumanOnly += 1;
    if (!truthCause.humanOnly && belief.physics.humanOnly) falseHumanOnly += 1;
  }

  const rate = (x) => (n ? x / n : 0);

  return {
    n,
    accuracy: rate(correct),
    abstentionRate: rate(abstained),
    llmTierRate: rate(llmTierUsed),

    unsafeRetryBeliefs,
    unsafeRetryRate: rate(unsafeRetryBeliefs),
    unsafeRetryPaise,
    atRiskPaise,

    missedHumanOnly,
    falseHumanOnly,

    /** Hit rate per match tier. The input Day 5 calibrates against. */
    byTier: Object.fromEntries(
      Object.entries(byTier).map(([tier, v]) => [tier, { n: v.n, accuracy: v.n ? v.correct / v.n : 0 }])
    ),

    byCause,

    /** Sorted worst-first, because that is the order anybody actually reads it in. */
    confusion: [...confusion.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Fixed-width text report. Kept separate from scoring so the numbers stay testable. */
export function formatDiagnosisReport(r, { label = '' } = {}) {
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN')}`;
  const L = [];

  L.push(`Diagnosis accuracy${label ? ` — ${label}` : ''}`);
  L.push('='.repeat(40));
  L.push(`  events                  ${r.n}`);
  L.push(`  accuracy                ${pct(r.accuracy)}`);
  L.push(`  abstained (UNKNOWN)     ${pct(r.abstentionRate)}`);
  L.push(`  resolved by tier 2      ${pct(r.llmTierRate)}`);
  L.push('');
  L.push('  What accuracy cannot see');
  L.push('  ------------------------');
  L.push(
    `  unsafe retry beliefs    ${r.unsafeRetryBeliefs} (${pct(r.unsafeRetryRate)})  ` +
      `${rupees(r.unsafeRetryPaise)} of ${rupees(r.atRiskPaise)} at risk`
  );
  L.push(`  missed human-only       ${r.missedHumanOnly}  (compliance direction)`);
  L.push(`  froze unnecessarily     ${r.falseHumanOnly}  (overcorrection direction)`);
  L.push('');
  L.push('  Accuracy by how the match was made');
  L.push('  ----------------------------------');
  for (const [tier, v] of Object.entries(r.byTier).sort((a, b) => b[1].n - a[1].n)) {
    L.push(`  ${tier.padEnd(14)} n=${String(v.n).padStart(4)}   ${pct(v.accuracy)}`);
  }
  if (r.confusion.length) {
    L.push('');
    L.push('  Top confusions (truth -> believed)');
    L.push('  ----------------------------------');
    for (const { pair, count } of r.confusion.slice(0, 10)) {
      L.push(`  ${String(count).padStart(4)}  ${pair}`);
    }
  }
  return L.join('\n');
}
