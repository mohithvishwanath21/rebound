/**
 * Why does a B3 case stop after one retry and sit SCHEDULED for nine days?
 *
 * `probe-ladder.mjs` showed 65 of 80 cases with exactly one action and a terminal state of SCHEDULED.
 * The ladder code is indexed on work done and falls forward through blocked rungs, so on inspection it
 * should not be able to stall. This dumps every decision and audit entry for one stuck case, in order,
 * which is the only way to see whether the case is being decided and told to wait, or not being decided
 * at all.
 */
import { fitRecoveryScorer, buildWorld, runArm } from './src/eval/harness.js';
import { policyFor } from './src/eval/baselines.js';
import { GUARDRAILS, POLICY, HORIZON } from './src/core/config.js';

const startAt = new Date('2026-08-24T09:30:00Z');
const { scoreAction, train } = await fitRecoveryScorer({ seed: '2', startAt });
const world = await buildWorld({ seed: '2', split: 'TEST', count: 80, startAt, train });

const r = await runArm({
  world, arm: 'B3_FIXED_LADDER', decide: policyFor('B3_FIXED_LADDER'), scoreAction,
  cycles: HORIZON.cycles, stepHours: HORIZON.stepHours,
  config: { GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 4000, maxRetriesPerRun: 4000 }, POLICY },
});

const target = 'evt_000001';
const decisions = (await r.store.getDecisions(r.runId)).filter((d) => d.eventId === target);
const audit = (await r.store.getAudit(r.runId)).filter((a) => a.eventId === target);
const kase = (await r.store.getCases(r.runId)).find((c) => c.eventId === target);

console.log(`case ${target}: state=${kase.state} retriesUsed=${kase.retriesUsed} touchesUsed=${kase.touchesUsed}`);
console.log(`nextActionAt=${kase.nextActionAt}  openedAt=${kase.openedAt}`);
console.log(`\n${decisions.length} DECISIONS:`);
for (const d of decisions) {
  console.log(`  cycle=${d.cycle} at=${new Date(d.decidedAt).toISOString()} outcome=${d.outcome} waitUntil=${d.waitUntil ?? '-'}`);
  console.log(`    stop=${d.stop ? d.stop.code : '-'}  rationale=${(d.rationale ?? '').slice(0, 110)}`);
  for (const c of d.candidates ?? []) {
    const v = (c.violations ?? []).map((x) => x.id).join('|') || '-';
    console.log(`      cand ${c.signature} verdict=${c.verdict} chosen=${!!c.chosen} deferUntil=${c.deferUntil ?? '-'} viol=${v} why=${(c.rejectedBecause ?? '').slice(0, 70)}`);
  }
}
console.log(`\n${audit.length} AUDIT:`);
for (const a of audit) console.log(`  ${new Date(a.at).toISOString()} ${a.type} ${JSON.stringify(a.detail ?? {}).slice(0, 150)}`);
