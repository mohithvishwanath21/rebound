/**
 * DOES THE COMMITMENT RULE STOP THE SPIN LOOP? — the before/after instrument for #67.
 *
 * `probe-spin.mjs` proved the loop exists on one world by tracing single cases. This probe is the
 * measurement: same worlds, same horizon, run once BEFORE the fix and once AFTER, and it grades itself
 * against the thresholds pre-registered in ENGINEERING_LOG.md rather than against whatever it happens
 * to print. That ordering is the whole point. A probe that decides what "success" means after seeing
 * the numbers is a probe that always succeeds.
 *
 * THE FOUR PRE-REGISTERED THRESHOLDS, copied here so they cannot drift:
 *   1. (CASE_SCHEDULED + CASE_WAITING) : ATTEMPT_STARTED  <  3.0   in EVERY world  (was 10.2)
 *   2. cases still SCHEDULED at the horizon               <  25/80 in EVERY world  (was 59/80)
 *   3. no case defers the same action class more than POLICY.maxDeferralsPerCase times
 *   4. attempts 150-250 and recovered money up 5x-20x     — DIRECTIONAL, reported not asserted
 *
 * Thresholds 1-3 are mechanism and should be near-deterministic. 4 is money and is a band, and the
 * band is deliberately wide because I did not know the answer when I wrote it down.
 *
 * WHY BOTH CASE_SCHEDULED AND CASE_WAITING ARE COUNTED. The loop lives in the RETRY_SCHEDULED path
 * (`scheduleAction`), and `Outcome.WAIT` is a *different* re-arming path with a *different* audit type
 * (`CASE_WAITING`). Fixing one and displacing the loop into the other would satisfy a narrower metric
 * while changing nothing about the behaviour, and it is exactly the mistake I would make by accident.
 * So the ratio counts every way a case can postpone itself.
 *
 * WHY THE APPROVER GRANTS EVERYTHING. The approval gate freezes ~72% of exposure (5-world mean), and
 * a frozen case cannot attempt anything, so leaving the gate closed would mix two suppression
 * mechanisms into one ratio and neither would be measurable. Grant-everything is not a claim about
 * realistic approvers — that is #61 — it is how this probe isolates the deferral loop from the gate.
 *
 * RESUMABLE, because the host caps a single shell call at ~178s and background processes do not
 * survive between calls. Each seed appends a row keyed `label|cycles|seed`; the last write wins. Run
 * it repeatedly with different PROBE_SEEDS until the table is full.
 *
 * Run: PROBE_LABEL=pre node probe-commit.mjs
 *      PROBE_LABEL=post node probe-commit.mjs
 *      (env: PROBE_SEEDS, PROBE_CYCLES, PROBE_LABEL)
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { buildWorld, fitRecoveryScorer, runArm } from './src/eval/harness.js';
import { resolveApproval } from './src/agent/orchestrator.js';
import { POLICY } from './src/core/config.js';
import { formatINR } from './src/core/money.js';

const startAt = new Date('2026-03-02T09:00:00.000Z');
const CYCLES = Number(process.env.PROBE_CYCLES ?? 16);
const STEP_HOURS = 12;
const LABEL = process.env.PROBE_LABEL ?? 'pre';
const SEEDS = (process.env.PROBE_SEEDS ?? 'day7,w01,w02,w03,w04').split(',').filter(Boolean);
const LEDGER = new URL('./probe-commit-results.jsonl', import.meta.url);

/** Pre-registered, and not to be edited after seeing a result. */
const T_RATIO = 3.0;
const T_STUCK = 25;

/**
 * The action class a deferral is deferring. Threshold 3 is about deferring *the same kind of thing*
 * again, not about the exact signature — `RETRY_SCHEDULED:2026-03-02T15:00` and
 * `RETRY_SCHEDULED:2026-03-03T03:00` are the same intent re-armed at a new instant, and counting
 * signatures would treat those sixteen identical decisions as sixteen different ones.
 */
const classOf = (sig) => String(sig ?? '').split(':')[0];

for (const seed of SEEDS) {
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });
  const world = await buildWorld({ seed, split: 'TRAIN', count: 80, startAt, train });

  const { store, runId } = await runArm({
    world,
    arm: 'REBOUND_EV',
    scoreAction,
    cycles: CYCLES,
    stepHours: STEP_HOURS,
    beforeCycle: async ({ store: s, runId: r, now }) => {
      for (const c of await s.getPendingApprovals(r)) {
        await resolveApproval({ store: s, runId: r, eventId: c.eventId, grant: true, by: 'probe', at: now });
      }
    },
  });

  const cases = await store.getCases(runId);
  const audit = await store.getAudit(runId);

  const scheduled = audit.filter((a) => a.type === 'CASE_SCHEDULED');
  const waiting = audit.filter((a) => a.type === 'CASE_WAITING');
  const attempts = audit.filter((a) => a.type === 'ATTEMPT_STARTED');
  const postponements = scheduled.length + waiting.length;

  /** Per case: how many times did it re-arm the same action class? */
  const perCaseClass = new Map();
  for (const a of scheduled) {
    const key = `${a.eventId}|${classOf(a.detail?.intent)}`;
    perCaseClass.set(key, (perCaseClass.get(key) ?? 0) + 1);
  }
  const maxSameClass = Math.max(0, ...perCaseClass.values());

  const stateMix = {};
  for (const c of cases) stateMix[c.state] = (stateMix[c.state] ?? 0) + 1;

  /**
   * Cases that postponed at least once and never attempted and never terminated. Threshold 3's second
   * half. A case legitimately waiting for a distant salary date is NOT in this set if it eventually
   * attempts; this counts only the ones that spent the entire horizon postponing.
   */
  const attemptedIds = new Set(attempts.map((a) => a.eventId));
  const postponedIds = new Set(scheduled.map((a) => a.eventId));
  const TERMINAL = new Set(['RECOVERED', 'RECOVERED_SELF', 'STOPPED', 'ESCALATED', 'EXPIRED']);
  const byId = new Map(cases.map((c) => [c.eventId, c]));
  const neverResolved = [...postponedIds].filter(
    (id) => !attemptedIds.has(id) && !TERMINAL.has(byId.get(id)?.state)
  );

  const recovered = audit
    .filter((a) => a.type === 'MONEY_RECOVERED')
    .reduce((s, a) => s + (a.detail?.amountPaise ?? 0), 0);

  const row = {
    label: LABEL, seed, cycles: CYCLES,
    cases: cases.length,
    exposurePaise: cases.reduce((s, c) => s + (c.amountPaise ?? 0), 0),
    scheduled: scheduled.length,
    waiting: waiting.length,
    postponements,
    attempts: attempts.length,
    ratio: Number((postponements / Math.max(1, attempts.length)).toFixed(2)),
    recoveredPaise: recovered,
    stuckScheduled: stateMix.SCHEDULED ?? 0,
    maxSameClassDeferrals: maxSameClass,
    neverResolved: neverResolved.length,
    stateMix,
    maxDeferralsPolicy: POLICY.maxDeferralsPerCase ?? null,
    at: new Date().toISOString(),
  };
  appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
  console.log(
    `${LABEL} ${seed}: postpone ${postponements} / attempt ${row.attempts} = ${row.ratio}x  ` +
    `recovered ${formatINR(recovered)}  stuck ${row.stuckScheduled}/${row.cases}  ` +
    `maxSameClass ${maxSameClass}  neverResolved ${neverResolved.length}`
  );
}

// ---- report whatever is on the ledger, for this label and horizon ---------------------------------
const rows = existsSync(LEDGER)
  ? readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

/** Last write per label|cycles|seed wins, so a re-run supersedes rather than duplicates. */
const latest = new Map();
for (const r of rows) latest.set(`${r.label}|${r.cycles}|${r.seed}`, r);

const forLabel = (label) => [...latest.values()].filter((r) => r.label === label && r.cycles === CYCLES);

const table = (label) => {
  const rs = forLabel(label).sort((a, b) => a.seed.localeCompare(b.seed));
  if (rs.length === 0) return;
  console.log(`\n=== ${label.toUpperCase()}  (${CYCLES} cycles x ${STEP_HOURS}h = ${((CYCLES * STEP_HOURS) / 24).toFixed(1)} days, 80 TRAIN cases)`);
  console.log('  seed   postpone  attempts   ratio   recovered      stuck  maxSame  unresolved');
  for (const r of rs) {
    console.log(
      `  ${r.seed.padEnd(6)} ${String(r.postponements).padStart(8)} ${String(r.attempts).padStart(9)} ` +
      `${String(r.ratio).padStart(7)} ${formatINR(r.recoveredPaise).padStart(11)} ` +
      `${String(`${r.stuckScheduled}/${r.cases}`).padStart(10)} ${String(r.maxSameClassDeferrals).padStart(8)} ${String(r.neverResolved).padStart(11)}`
    );
  }
  const sum = (f) => rs.reduce((s, r) => s + f(r), 0);
  console.log(
    `  ${'POOLED'.padEnd(6)} ${String(sum((r) => r.postponements)).padStart(8)} ${String(sum((r) => r.attempts)).padStart(9)} ` +
    `${String((sum((r) => r.postponements) / Math.max(1, sum((r) => r.attempts))).toFixed(2)).padStart(7)} ` +
    `${formatINR(sum((r) => r.recoveredPaise)).padStart(11)}`
  );
  return rs;
};

const pre = table('pre');
const post = table('post');

/**
 * THE VERDICT BLOCK REFUSES TO RENDER ON A SHORT SAMPLE, and that guard is here because its absence
 * has already cost me once. `probe-cycle0.mjs` threw before recording any row, its verdict block ran
 * against an empty array, and it confidently printed "GUILTY: later cycles start NO attempts at all" —
 * zero attempts because zero cycles were observed. A crash that prints a plausible conclusion on its
 * way out is worse than a crash, because the crash gets investigated.
 */
const MIN_WORLDS = 3;
if (!post || post.length < MIN_WORLDS) {
  console.log(
    `\n!! only ${post?.length ?? 0} post-fix world(s) on the ledger — NO verdict. ` +
    `Need ${MIN_WORLDS}+ at ${CYCLES} cycles. Re-run with PROBE_LABEL=post PROBE_SEEDS=...`
  );
} else {
  console.log('\n=== VERDICT against the pre-registered thresholds');
  const worstRatio = Math.max(...post.map((r) => r.ratio));
  const worstStuck = Math.max(...post.map((r) => r.stuckScheduled));
  const worstClass = Math.max(...post.map((r) => r.maxSameClassDeferrals));
  const cap = post[0].maxDeferralsPolicy;
  const unresolved = post.reduce((s, r) => s + r.neverResolved, 0);

  const line = (ok, label, detail) => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
  line(worstRatio < T_RATIO, `1. postpone:attempt ratio < ${T_RATIO} in every world`, `worst ${worstRatio}x`);
  line(worstStuck < T_STUCK, `2. cases stuck SCHEDULED < ${T_STUCK}/80 in every world`, `worst ${worstStuck}/80`);
  line(cap != null && worstClass <= cap, `3a. same-class deferrals <= maxDeferralsPerCase`, `worst ${worstClass}, cap ${cap ?? 'UNSET'}`);
  line(unresolved === 0, '3b. every postponing case attempts or terminates', `${unresolved} never resolved`);

  if (pre && pre.length) {
    const p = (rs, f) => rs.reduce((s, r) => s + f(r), 0);
    const preM = p(pre, (r) => r.recoveredPaise);
    const postM = p(post, (r) => r.recoveredPaise);
    const preA = p(pre, (r) => r.attempts);
    const postA = p(post, (r) => r.attempts);
    console.log(
      `\n  4. DIRECTIONAL (reported, not asserted — pre-registered band 5x-20x on money):\n` +
      `     attempts ${preA} -> ${postA}  (${(postA / Math.max(1, preA)).toFixed(2)}x)\n` +
      `     money    ${formatINR(preM)} -> ${formatINR(postM)}  (${(postM / Math.max(1, preM)).toFixed(2)}x)\n` +
      `     NOTE: pooled over ${pre.length} pre and ${post.length} post worlds. If those counts differ the\n` +
      `     ratio is not comparable — fill the shorter table before quoting it.`
    );
    if (postM < preM) {
      console.log(
        '\n  !! MONEY WENT DOWN. Per the pre-registration this means the deferrals were partly earning\n' +
        '     their keep and the commitment rule is too blunt. The registered response is to keep the\n' +
        '     BUDGET (maxDeferralsPerCase) alone and drop the hard act-or-stop rule — not to keep\n' +
        '     whichever version printed the bigger number.'
      );
    }
  }
}
