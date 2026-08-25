/**
 * Is B3 actually climbing its ladder?
 *
 * In the five-world eval B1 and B3 recovered IDENTICAL gross money in seeds 2 and 3, and B3 executed
 * only ~1.2 retries per case across a ten-day horizon despite a five-rung ladder. Either the ladder is
 * being cut short — in which case "Rebound beats the honest baseline 5/5" is a win over a crippled
 * opponent and cannot be quoted — or most cases leave the ladder early for a legitimate reason.
 *
 * This prints, for B1 / B3 / REBOUND_EV: the terminal case-state mix, the action-kind histogram, and
 * for B3 the distribution of how many actions each case received. A healthy B3 should show cases
 * spread across 1..5 actions. A broken B3 shows nearly every case at exactly 1.
 */
import { fitRecoveryScorer, buildWorld, runArm } from './src/eval/harness.js';
import { policyFor } from './src/eval/baselines.js';
import { GUARDRAILS, POLICY, HORIZON } from './src/core/config.js';

const startAt = new Date('2026-08-24T09:30:00Z');
const seed = '2';
const count = 80;

const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
const world = await buildWorld({ seed, split: 'TEST', count, startAt, train });
const config = {
  GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 4000, maxRetriesPerRun: 4000 },
  POLICY,
};

for (const arm of ['B1_NAIVE_RETRY', 'B3_FIXED_LADDER', 'REBOUND_EV']) {
  const r = await runArm({
    world, arm, decide: policyFor(arm), scoreAction,
    cycles: HORIZON.cycles, stepHours: HORIZON.stepHours, config,
  });
  const cases = await r.store.getCases(r.runId);
  const actions = await r.store.getActions(r.runId);

  const states = {};
  for (const c of cases) states[c.state] = (states[c.state] ?? 0) + 1;

  const kinds = {};
  const perCase = new Map();
  for (const a of actions) {
    kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;
    perCase.set(a.eventId, (perCase.get(a.eventId) ?? 0) + 1);
  }
  const hist = {};
  for (const c of cases) {
    const n = perCase.get(c.eventId) ?? 0;
    hist[n] = (hist[n] ?? 0) + 1;
  }

  console.log(`\n=== ${arm} · ${actions.length} actions over ${cases.length} cases · recovered ${r.recoveredPaise} paise`);
  console.log('  terminal states  :', JSON.stringify(states));
  console.log('  action kinds     :', JSON.stringify(kinds));
  console.log('  actions per case :', JSON.stringify(hist), '  (key = actions, value = cases)');

  /**
   * For B3 specifically: which ladder step did each case reach? The baseline stores its step on the
   * case, so a ladder that never advances is visible directly rather than inferred from counts.
   */
  if (arm === 'B3_FIXED_LADDER') {
    const steps = {};
    for (const c of cases) steps[c.ladderStep ?? 'none'] = (steps[c.ladderStep ?? 'none'] ?? 0) + 1;
    console.log('  ladderStep on case:', JSON.stringify(steps));
    const sample = cases.filter((c) => (perCase.get(c.eventId) ?? 0) <= 1).slice(0, 5);
    for (const c of sample) {
      const acts = actions.filter((a) => a.eventId === c.eventId).map((a) => `${a.kind}@${a.state}/${a.receipt?.state ?? '-'}`);
      console.log(`    ${c.eventId} state=${c.state} retriesUsed=${c.retriesUsed} touchesUsed=${c.touchesUsed} acts=[${acts.join(', ')}]`);
    }
  }
}
