/**
 * WHY DOES NOTHING RECOVER AFTER CYCLE 0? — an investigation, not a measurement.
 *
 * Three independent runs now show the same signature and I do not yet have an explanation:
 *
 *   - `orchestrate-report` per-cycle recovery: ₹12,300 at cycle 0, then ₹0 for cycles 1-7.
 *   - `probe-approval.mjs` at 8 vs 20 cycles: the approval delta is BIT-IDENTICAL in all 5 worlds
 *     (pooled ₹1,89,319 -> ₹1,89,319, 1.00x) even though grants went 9->23, 17->46, 20->48, 26->70,
 *     24->65 and 5-14 more cases per world reached a terminal state.
 *   - 50-61 of 80 cases are STILL `SCHEDULED` after 10 days, though the longest candidate offset is
 *     168h (7 days), so nearly all of them should have landed.
 *
 * Tripling the grants and doubling the clock bought exactly zero additional rupees. The innocent
 * explanation is that recovery is genuinely front-loaded: the easy money is collected immediately and
 * the rest is hopeless. The guilty explanation is that a SCHEDULED action never fires — the scheduler
 * wakes the case, the agent re-decides, and it schedules again forever, so the only attempts that ever
 * execute are the immediate ones in cycle 0. Those two stories predict very different things, and the
 * difference is observable, which is the point of this probe:
 *
 *   innocent -> attempts are SPREAD across cycles, and they fail.
 *   guilty   -> attempts are CONCENTRATED in cycle 0, and later cycles execute nothing at all.
 *
 * So: count attempts per cycle, not just money per cycle. Money per cycle cannot distinguish "we
 * tried and failed" from "we never tried", and every report I have built so far only prints money.
 *
 * Run: node probe-cycle0.mjs   (env: PROBE_SEED, PROBE_CYCLES)
 */

import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { resolveApproval } from './src/agent/orchestrator.js';
import { formatINR } from './src/core/money.js';

const startAt = new Date('2026-03-02T09:00:00.000Z');
const SEED = process.env.PROBE_SEED ?? 'w01';
const CYCLES = Number(process.env.PROBE_CYCLES ?? 20);
const STEP_HOURS = 12;

const { scoreAction, train } = await fitRecoveryScorer({ seed: SEED, startAt });
const world = await buildWorld({ seed: SEED, split: 'TRAIN', count: 80, startAt, train });

/**
 * `onCycle(summary, clock)` is the instrument, and reading its real signature first is what saved this
 * probe from lying. My first attempt assumed `onCycle` received a context object with `store` on it,
 * like `beforeCycle` does. It threw — and because the throw happened before any row was recorded, the
 * verdict block ran against an EMPTY rows array and confidently printed
 * "GUILTY: later cycles start NO attempts at all". Zero attempts because zero cycles were observed.
 *
 * That is the exact failure this project is supposed to be built against: not a crash, but a crash
 * that prints a plausible conclusion on its way out. So the verdict below refuses to run on an empty
 * or short row set, and `summariseCycle`'s own fields are used rather than re-derived.
 *
 * Note also that `runArm` calls `onCycle` WITHOUT awaiting it (harness.js:349). An async observer
 * would therefore interleave with the next cycle's writes. This probe's observer is synchronous for
 * that reason; the un-awaited call is logged as a hazard for #56 rather than relied upon.
 */
let prevRecovered = 0;
const rows = [];

const result = await runArm({
  world,
  arm: 'REBOUND_EV',
  scoreAction,
  cycles: CYCLES,
  stepHours: STEP_HOURS,
  beforeCycle: async ({ store, runId, now }) => {
    // Grant everything, so the approval gate is not what is being measured here.
    for (const c of await store.getPendingApprovals(runId)) {
      await resolveApproval({ store, runId, eventId: c.eventId, grant: true, by: 'probe', at: now });
    }
  },
  onCycle: (summary, clock) => {
    prevRecovered += summary.recoveredPaise;
    rows.push({
      cycle: summary.cycle,
      when: clock.toISOString().slice(5, 16),
      due: summary.dueCases,
      decided: summary.decided,
      attempts: summary.attempts,
      wakeups: summary.scheduledWakeups,
      recoveredPaise: summary.recoveredPaise,
      cumulative: prevRecovered,
      superseded: summary.proposalsSuperseded,
      dups: summary.duplicatesSkipped,
      outcomes: summary.outcomes,
    });
  },
});

console.log(`\nseed ${SEED}, 80 TRAIN cases, ${CYCLES} cycles x ${STEP_HOURS}h, approver grants everything`);
console.log(`exposure ${formatINR(world.totalExposurePaise)}\n`);
console.log('cyc  when          DUE  DECIDED  ATTEMPTS  WAKEUPS  SUPERSED  DUPS   recovered   cumulative');
for (const r of rows) {
  console.log(
    `${String(r.cycle).padStart(3)}  ${r.when}  ${String(r.due).padStart(4)} ${String(r.decided).padStart(8)} ` +
    `${String(r.attempts).padStart(9)} ${String(r.wakeups).padStart(8)} ${String(r.superseded).padStart(9)} ` +
    `${String(r.dups).padStart(5)}  ${formatINR(r.recoveredPaise).padStart(10)}  ${formatINR(r.cumulative).padStart(11)}`
  );
}

console.log('\n--- OUTCOME MIX PER CYCLE (what the policy decided, not what happened)');
const allOutcomes = [...new Set(rows.flatMap((r) => Object.keys(r.outcomes)))].sort();
console.log(`cyc  ${allOutcomes.map((o) => o.slice(0, 9).padStart(10)).join('')}`);
for (const r of rows) {
  console.log(`${String(r.cycle).padStart(3)}  ${allOutcomes.map((o) => String(r.outcomes[o] ?? 0).padStart(10)).join('')}`);
}

if (rows.length < 2) {
  console.log(`\n  !! only ${rows.length} cycle(s) observed — NO verdict. A conclusion drawn from this would be noise.`);
} else {
  const later = (k) => rows.slice(1).reduce((s, r) => s + r[k], 0);
  const c0 = rows[0];
  console.log('\n--- THE DISCRIMINATING QUESTION: did later cycles TRY, or not?');
  console.log(`  cycles observed: ${rows.length} of ${CYCLES} requested`);
  console.log(`  attempts   cycle 0: ${c0.attempts}   later cycles combined: ${later('attempts')}   total: ${c0.attempts + later('attempts')}`);
  console.log(`  decided    cycle 0: ${c0.decided}   later cycles combined: ${later('decided')}`);
  console.log(`  recovered  cycle 0: ${formatINR(c0.recoveredPaise)}   later cycles combined: ${formatINR(later('recoveredPaise'))}`);

  if (later('decided') === 0) {
    console.log('\n  => GUILTY: later cycles decide nothing. No case is ever due again — the scheduler never re-arms.');
  } else if (later('attempts') === 0) {
    console.log(`\n  => GUILTY: later cycles decide ${later('decided')} cases but start ZERO attempts.`);
    console.log('     Cases wake up, get re-decided, and the chosen action never executes. Scheduling loop.');
  } else if (later('recoveredPaise') === 0) {
    console.log(`\n  => later cycles DO make ${later('attempts')} attempts and recover nothing.`);
    console.log('     The scheduler fires and the attempts fail. Look at the response model, not the clock.');
  } else {
    console.log('\n  => recovery IS spread across cycles. Re-read the reports that suggested otherwise.');
  }
}
