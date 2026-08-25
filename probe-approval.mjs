/**
 * DOES THE GRANT PATH ACTUALLY UNFREEZE THE MONEY? — a measurement, not a test.
 *
 * The unit tests prove the mechanism works on one case. This prints the magnitude, because the defect
 * being closed was a quantity: cases sitting in a state nothing could leave.
 *
 * ACROSS SEVERAL WORLDS, and that is a correction. The first version of this probe ran ONE world and
 * reported "81.41% of exposure frozen". Then task #64 re-rolled the generator's streams and the same
 * measurement on the same seed gave 40.0%. Both are true of their world and neither is a property of
 * the system: an 80-case slice has a handful of cases above the ₹25,000 approval threshold, and the
 * log-normal amount tail means WHICH ones land there swings the share enormously. So the honest
 * quantity is the spread across worlds, and a single-world figure must never be quoted as the finding.
 *
 * Two arms per world, identical world, identical luck (same runId, same seed, separate stores),
 * identical clock. The ONLY difference is whether a human works the approval queue. So the delta
 * between them is the money the approval gate was holding, and nothing else.
 *
 * The approver rides on `beforeCycle` here ON PURPOSE, and that is exactly why this is a probe and
 * not the shipped design. `runArm`'s own docblock explains why self-recovery is applied
 * unconditionally instead: a world property routed through an optional hook is a world property one
 * arm can be run without, and an approver is the same category of thing — it is the human
 * organisation around the agent, not a feature of one policy. Wiring it in properly is task #61,
 * and it must be pre-registered before it runs, because it unfreezes a large share of exposure and
 * therefore raises EVERY arm's figure including the one I want to win. Deliberately not naming that
 * share here: whatever this run prints is what the pre-registration should quote, and an inherited
 * number in a comment is precisely how the void 81.41% survived as long as it did.
 *
 * A grant-everything approver is also not a claim about reality. It is the CEILING of what the
 * approval path can release, which is the number that decides whether #61 is worth building.
 *
 * Run: node probe-approval.mjs
 */

import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { resolveApproval } from './src/agent/orchestrator.js';
import { formatINR } from './src/core/money.js';
import { GUARDRAILS } from './src/core/config.js';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const startAt = new Date('2026-03-02T09:00:00.000Z');
/**
 * CYCLES is an env knob because the first five-world run made the horizon the suspect. At 8 cycles
 * the grant path released ₹0 in 3 of 5 worlds while still issuing 9-26 grants and draining
 * AWAITING_APPROVAL to ₹0 in all 5 — money left the frozen state and then simply never landed inside
 * the window. Run this at 8 and at 20 and compare: if the delta grows, the 8-cycle figure was
 * measuring truncation, not the value of an approver.
 */
const CYCLES = Number(process.env.PROBE_CYCLES ?? 8);
const STEP_HOURS = 12;
const SEEDS = (process.env.PROBE_SEEDS ?? 'day7,w01,w02,w03,w04').split(',').filter(Boolean);
/**
 * Results are APPENDED to a jsonl checkpoint and the tables are printed from the file, not from this
 * process's own loop. Reason: at 20 cycles one world costs ~70s and the environment running this caps
 * a single command well below the five-world total, so the run has to be resumable across
 * invocations. Keying each row by `${cycles}|${seed}` means re-running a seed replaces its row rather
 * than duplicating it, so the file converges no matter how the work is sliced.
 */
const LEDGER = new URL('./probe-approval-results.jsonl', import.meta.url);

/** One approver pass. Returns how many grants it issued. */
async function workTheQueue({ store, runId, now }, tally) {
  const pending = await store.getPendingApprovals(runId);
  for (const c of pending) {
    const r = await resolveApproval({
      store, runId, eventId: c.eventId, grant: true, by: 'probe-approver', at: now,
    });
    if (r.applied) {
      tally.grants += 1;
      tally.unfrozenPaise += c.amountPaise ?? 0;
    }
  }
  return pending.length;
}

async function arm(label, { withApprover, seed, train, scoreAction }) {
  const world = await buildWorld({ seed, split: 'TRAIN', count: 80, startAt, train });
  const tally = { grants: 0, unfrozenPaise: 0 };
  const queueDepth = [];

  const result = await runArm({
    world,
    arm: 'REBOUND_EV',
    scoreAction,
    cycles: CYCLES,
    stepHours: STEP_HOURS,
    beforeCycle: async (ctx) => {
      if (withApprover) await workTheQueue(ctx, tally);
      queueDepth.push((await ctx.store.getPendingApprovals(ctx.runId)).length);
    },
  });

  const cases = await result.store.getCases(result.runId);
  const byState = new Map();
  let frozenPaise = 0;
  for (const c of cases) {
    byState.set(c.state, (byState.get(c.state) ?? 0) + 1);
    if (c.state === 'AWAITING_APPROVAL') frozenPaise += c.amountPaise ?? 0;
  }

  const decisions = await result.store.getDecisions(result.runId);
  const underGrant = decisions.filter((d) => (d.clearedByApproval ?? []).length > 0);

  return { label, world, result, tally, byState, frozenPaise, queueDepth, decisions, underGrant, cases };
}

for (const seed of SEEDS) {
  /**
   * The scorer is re-fit PER SEED, and that is not incidental. `fitRecoveryScorer({seed})` trains on
   * that seed's own history, so reusing one scorer across five worlds would leak a model fitted on
   * world A into the evaluation of world B. The control and treated arms inside a seed share the
   * fitted scorer, which is what makes the pair valid; across seeds they must not.
   */
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
  const control = await arm('no approver', { withApprover: false, seed, train, scoreAction });
  const treated = await arm('grants everything', { withApprover: true, seed, train, scoreAction });

  const exposure = control.world.totalExposurePaise;
  const row = {
    cycles: CYCLES,
    seed,
    exposure,
    frozenBefore: control.frozenPaise,
    frozenAfter: treated.frozenPaise,
    before: control.result.recoveredPaise,
    after: treated.result.recoveredPaise,
    grants: treated.tally.grants,
    underGrant: treated.underGrant.length,
    selfMatch: control.result.selfRecoveredPaise === treated.result.selfRecoveredPaise,
    /**
     * Terminal states of the TREATED arm, to make the truncation argument visible instead of
     * inferred. A world where the grant released ₹0 but ends with most cases SCHEDULED has not
     * shown that approvals are worthless; it has shown the run ended before the approved actions
     * landed. Those are opposite conclusions and only the state counts separate them.
     */
    sched: treated.byState.get('SCHEDULED') ?? 0,
    rec: treated.byState.get('RECOVERED') ?? 0,
    esc: treated.byState.get('ESCALATED') ?? 0,
    stopped: treated.byState.get('STOPPED') ?? 0,
    selfRec: treated.byState.get('RECOVERED_SELF') ?? 0,
  };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.error(`  done ${seed} @ ${CYCLES} cycles: delta ${formatINR(row.after - row.before)}`);
}

/** Last write per `cycles|seed` wins, so a re-run corrects a row instead of double-counting it. */
const byKey = new Map();
if (existsSync(LEDGER)) {
  for (const line of readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    byKey.set(`${r.cycles}|${r.seed}`, r);
  }
}
const all = [...byKey.values()];
const horizons = [...new Set(all.map((r) => r.cycles))].sort((a, b) => a - b);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(mean(a.map((x) => (x - mean(a)) ** 2))));
const pc = (x, d) => `${((100 * x) / d).toFixed(2)}%`;

console.log(`\napproval threshold ${formatINR(GUARDRAILS.humanApprovalThresholdPaise)}, grant valid ${GUARDRAILS.approvalValidForHours}h`);

for (const h of horizons) {
  const rows = all.filter((r) => r.cycles === h).sort((a, b) => a.seed.localeCompare(b.seed));
  console.log(`\n######## ${h} cycles x ${STEP_HOURS}h = ${((h * STEP_HOURS) / 24).toFixed(1)} days — ${rows.length} worlds x 80 TRAIN cases`);
  console.log('seed   exposure       frozen(before)        recovered before -> after        delta        grants  SCHED');
  for (const r of rows) {
    console.log(
      `${r.seed.padEnd(6)} ${formatINR(r.exposure).padStart(12)}  ` +
      `${formatINR(r.frozenBefore).padStart(12)} ${pc(r.frozenBefore, r.exposure).padStart(7)}  ` +
      `${formatINR(r.before).padStart(10)} -> ${formatINR(r.after).padStart(11)}  ` +
      `${('+' + formatINR(r.after - r.before)).padStart(12)} ${pc(r.after - r.before, r.exposure).padStart(7)}  ` +
      `${String(r.grants).padStart(4)}  ${String(r.sched).padStart(4)}`
    );
  }
  const frozenShares = rows.map((r) => (100 * r.frozenBefore) / r.exposure);
  const deltaShares = rows.map((r) => (100 * (r.after - r.before)) / r.exposure);
  const untermShares = rows.map((r) => (100 * r.sched) / 80);
  console.log(`  frozen share:  mean ${mean(frozenShares).toFixed(2)}%  sd ${sd(frozenShares).toFixed(2)}pp  range ${Math.min(...frozenShares).toFixed(2)}-${Math.max(...frozenShares).toFixed(2)}%`);
  console.log(`  delta share:   mean ${mean(deltaShares).toFixed(2)}%  sd ${sd(deltaShares).toFixed(2)}pp  range ${Math.min(...deltaShares).toFixed(2)}-${Math.max(...deltaShares).toFixed(2)}%`);
  console.log(`  unterminated:  mean ${mean(untermShares).toFixed(1)}% of cases still SCHEDULED when the run ended`);
  console.log(`  worlds where a grant released money: ${rows.filter((r) => r.after > r.before).length} of ${rows.length}`);
  console.log(`  worlds still holding frozen money:   ${rows.filter((r) => r.frozenAfter > 0).length} of ${rows.length}`);
  console.log(`  self-recovery identical across arms:  ${rows.every((r) => r.selfMatch) ? 'YES' : 'NO — ARMS NOT COMPARABLE'}`);
}

/**
 * The paired horizon comparison is the whole point once both horizons are populated: the SAME seed at
 * two horizons differs in nothing but how long the clock ran, so a delta that GROWS with the horizon
 * is truncation, and a delta that does not is a real ceiling on what an approver can release. Without
 * this pairing the 8-cycle result reads as "approvals are worth nothing in 3 of 5 worlds", which is
 * the wrong conclusion drawn from a run that stopped rather than finished.
 */
if (horizons.length > 1) {
  const [lo, hi] = [horizons[0], horizons[horizons.length - 1]];
  const paired = all
    .filter((r) => r.cycles === lo)
    .map((r) => ({ lo: r, hi: byKey.get(`${hi}|${r.seed}`) }))
    .filter((p) => p.hi);
  if (paired.length) {
    console.log(`\n######## PAIRED: same seed, ${lo} vs ${hi} cycles — was the ${lo}-cycle delta a truncation artifact?`);
    console.log('seed    delta@lo        delta@hi        growth   SCHED lo->hi');
    for (const p of paired) {
      const dLo = p.lo.after - p.lo.before;
      const dHi = p.hi.after - p.hi.before;
      const growth = dLo === 0 ? (dHi === 0 ? 'none' : '0 -> +') : `${(dHi / dLo).toFixed(2)}x`;
      console.log(
        `${p.lo.seed.padEnd(6)} ${formatINR(dLo).padStart(13)}  ${formatINR(dHi).padStart(13)}  ` +
        `${growth.padStart(7)}   ${p.lo.sched} -> ${p.hi.sched}`
      );
    }
    const dLoT = paired.reduce((s, p) => s + (p.lo.after - p.lo.before), 0);
    const dHiT = paired.reduce((s, p) => s + (p.hi.after - p.hi.before), 0);
    console.log(`  pooled delta ${formatINR(dLoT)} -> ${formatINR(dHiT)}  (${dLoT > 0 ? `${(dHiT / dLoT).toFixed(2)}x` : 'n/a'})`);
    console.log(`  worlds releasing money: ${paired.filter((p) => p.lo.after > p.lo.before).length}/${paired.length} at ${lo} cycles, ${paired.filter((p) => p.hi.after > p.hi.before).length}/${paired.length} at ${hi}`);
  }
}

console.log('\n  A single-world figure is a draw. Quote the mean and the range, or quote neither.');
