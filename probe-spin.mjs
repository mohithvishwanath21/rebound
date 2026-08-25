/**
 * IS THE AGENT A PERFECT PROCRASTINATOR? — tracing one case, cycle by cycle.
 *
 * `probe-cycle0.mjs` produced this on seed w01, 20 cycles x 12h:
 *
 *   cyc 10-15: DUE 51, DECIDED 51, ACT ~51, WAKEUPS ~51, ATTEMPTS 0, recovered ₹0
 *
 * Fifty-one cases wake up, fifty-one are decided, fifty-one wakeups are scheduled, and NOTHING is
 * attempted — every cycle, forever. `getDueCases` filters on `nextActionAt` correctly and
 * `scheduleAction` writes a future instant correctly, so neither of those is the fault. That leaves
 * one candidate: the DECISION. If the expected value of acting at T+6h always beats acting at T, then
 * at every wakeup the agent re-decides, again prefers six hours from now, and re-arms the same wakeup.
 * The scheduled instant is a moving target that recedes exactly as fast as the clock advances, so the
 * action is always imminent and never happens.
 *
 * The candidate retry offsets start at 6h and the step is 12h, which is why this hides so well: a case
 * scheduled +6h IS legitimately due at the next 12h cycle, so the queue looks healthy, the audit trail
 * shows diligent re-decisioning, the guardrails pass, and the recovery figure is simply small. It reads
 * as a cautious policy rather than as a policy that never acts.
 *
 * THE DISCRIMINATING OBSERVATION, per case:
 *   procrastination -> repeated CASE_SCHEDULED with the SAME intent and a wakeAt that keeps sliding
 *                      forward, and no ATTEMPT_STARTED between them.
 *   legitimate wait -> ONE CASE_SCHEDULED pointing at a distant instant (a salary date), then silence
 *                      until that instant, then an attempt.
 *
 * Those look identical in any money-per-cycle report, which is why this prints the wakeAt sequence.
 *
 * Run: node probe-spin.mjs   (env: PROBE_SEED, PROBE_CYCLES, PROBE_CASES)
 */

import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { resolveApproval } from './src/agent/orchestrator.js';
import { formatINR } from './src/core/money.js';

const startAt = new Date('2026-03-02T09:00:00.000Z');
const SEED = process.env.PROBE_SEED ?? 'w01';
const CYCLES = Number(process.env.PROBE_CYCLES ?? 16);
const SHOW = Number(process.env.PROBE_CASES ?? 3);
const STEP_HOURS = 12;

const { scoreAction, train } = await fitRecoveryScorer({ seed: SEED, startAt });
const world = await buildWorld({ seed: SEED, split: 'TRAIN', count: 80, startAt, train });

const result = await runArm({
  world,
  arm: 'REBOUND_EV',
  scoreAction,
  cycles: CYCLES,
  stepHours: STEP_HOURS,
  beforeCycle: async ({ store, runId, now }) => {
    for (const c of await store.getPendingApprovals(runId)) {
      await resolveApproval({ store, runId, eventId: c.eventId, grant: true, by: 'probe', at: now });
    }
  },
});

const { store, runId } = result;
const cases = await store.getCases(runId);
const audit = await store.getAudit(runId);

/** Cases still SCHEDULED at the end are the ones the loop would be holding. */
const stuck = cases.filter((c) => c.state === 'SCHEDULED');
console.log(`\nseed ${SEED}, ${CYCLES} cycles x ${STEP_HOURS}h = ${((CYCLES * STEP_HOURS) / 24).toFixed(1)} days`);
console.log(`${stuck.length} of ${cases.length} cases still SCHEDULED at the end; tracing ${Math.min(SHOW, stuck.length)}\n`);

const hrs = (a, b) => ((new Date(b) - new Date(a)) / 3_600_000).toFixed(1);

for (const c of stuck.slice(0, SHOW)) {
  const mine = audit.filter((a) => a.eventId === c.eventId);
  console.log(`=== ${c.eventId}  ${formatINR(c.amountPaise)}  attempts=${c.attemptsUsed ?? c.retriesUsed ?? '?'}`);
  let lastWake = null;
  for (const a of mine) {
    if (a.type === 'CASE_SCHEDULED') {
      const wake = a.detail?.wakeAt;
      const slide = lastWake ? `  wakeAt slid +${hrs(lastWake, wake)}h` : '';
      console.log(
        `  ${String(a.at).slice(5, 16)}  SCHEDULED -> wake ${String(wake).slice(5, 16)} ` +
        `(+${hrs(a.at, wake)}h)  ev=${formatINR(a.detail?.evPaise ?? 0)}  ${String(a.detail?.intent ?? '').slice(0, 34)}${slide}`
      );
      lastWake = wake;
    } else if (a.type === 'ATTEMPT_STARTED') {
      console.log(`  ${String(a.at).slice(5, 16)}  >>> ATTEMPT_STARTED  ${a.detail?.kind ?? ''} ${a.detail?.channel ?? ''}`);
    } else if (a.type === 'MONEY_RECOVERED') {
      console.log(`  ${String(a.at).slice(5, 16)}  $$$ RECOVERED ${formatINR(a.detail?.amountPaise ?? 0)}`);
    }
  }
  const scheds = mine.filter((a) => a.type === 'CASE_SCHEDULED');
  const tries = mine.filter((a) => a.type === 'ATTEMPT_STARTED');
  console.log(`  --> ${scheds.length} schedulings, ${tries.length} attempts`);
  const intents = new Set(scheds.map((a) => a.detail?.intent));
  console.log(`  --> distinct intents across those schedulings: ${intents.size} ${intents.size === 1 ? '(THE SAME ONE, re-armed)' : ''}`);
}

const scheds = audit.filter((a) => a.type === 'CASE_SCHEDULED');
const perCase = new Map();
for (const a of scheds) perCase.set(a.eventId, (perCase.get(a.eventId) ?? 0) + 1);
const counts = [...perCase.values()].sort((a, b) => b - a);
const tries = audit.filter((a) => a.type === 'ATTEMPT_STARTED').length;

console.log('\n--- ACROSS ALL CASES');
console.log(`  CASE_SCHEDULED events: ${scheds.length}   ATTEMPT_STARTED events: ${tries}`);
console.log(`  ratio: ${(scheds.length / Math.max(1, tries)).toFixed(1)} schedulings per attempt`);
console.log(`  most-rescheduled case: ${counts[0] ?? 0} times   median: ${counts[Math.floor(counts.length / 2)] ?? 0}`);
console.log(
  scheds.length > 4 * tries
    ? '\n  => PROCRASTINATION CONFIRMED: the agent schedules far more often than it acts.'
    : '\n  => not a scheduling loop by this measure; look elsewhere.'
);
