#!/usr/bin/env node
/**
 * npm run orchestrate-report
 *
 * The Day 7 command. Runs the WHOLE loop over a batch, across several cycles, against the simulated
 * gateway, and prints what actually happened to the money.
 *
 *   generate -> observe -> diagnose -> fit on TRAIN -> [decide -> guardrail -> execute -> persist]
 *   -> settle receipts -> schedule wakeups -> advance the clock -> repeat
 *
 * No Mongo, no network, no API key, no installed packages. `--seed` fixes everything including the
 * outcome draws, so two runs of the same command are byte-identical.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW THIS DIFFERS FROM `npm run decide-report`, AND WHY BOTH EXIST
 * ---------------------------------------------------------------------------------------------
 * `decide-report` prints the agent's EXPECTED recovery: the sum of its own estimates for the actions
 * it chose. That is arithmetic about a policy. Nothing is executed and no outcome is drawn, so a big
 * number there is a claim, not a result.
 *
 * This command executes. Actions go through the gateway seam, the response model draws an outcome,
 * receipts come back, and `recovered` below sums only what a receipt said was CAPTURED. That is a
 * result — but a result IN SIMULATION, which is the second of this project's two claims and must
 * never be printed as if it were the first:
 *
 *   THE PLUMBING WORKS — proven against the real Razorpay test-mode API (`npm run live-check`).
 *   THE POLICY IS BETTER — measured in simulation. This command. Simulated rupees, labelled as such
 *   on every line that prints one.
 *
 * What this command is still NOT is a comparison. It runs one arm and reports what it did; it does
 * not show that REBOUND_EV beats retry-everything-three-times. Baselines on a held-out split are
 * Day 8's `npm run eval`. A single arm's recovery total means very little on its own — the naive
 * baseline may well recover a similar amount at four times the customer contact — so read the action
 * mix and the guardrail columns here, not the headline rupees.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT TO READ FIRST
 * ---------------------------------------------------------------------------------------------
 * The per-cycle table, left to right. Cycle 0 has every case due and does the most work; later
 * cycles should show `due` falling as cases terminate and `woke` rising as scheduled retries land.
 * A run where `due` never falls means cases are being re-decided forever without resolving, which is
 * the failure mode a cycle loop is most prone to and the reason `stopped` is worth as much attention
 * as `recovered`.
 *
 * Then `superseded`. That column counts cases whose committed action differed from the one that won
 * them their place in the queue — almost always a run budget binding partway through. Zero is normal
 * on a small batch; a large number means the caps are the thing driving the policy, not the EV.
 *
 * Then the lifecycle trail at the bottom. It is the audit artefact Track 03 asks for, printed for one
 * real case from the run: every decision, every guardrail refusal, every attempt, every receipt.
 *
 * Flags (all --name=value; the spaced form is a hard error — see cli/flags.js):
 *   --seed=day7        seeds generation, the model's outcome draws, AND the gateway's draws
 *   --count=80         cases in the run
 *   --cycles=8         how many times to run the loop
 *   --step-hours=12    how far the clock advances between cycles
 *   --split=TRAIN      which generator split to run on
 *   --now=...          ISO start instant. A fixed default, NOT the wall clock — see below.
 *   --trail=1          how many per-case lifecycle audit trails to print
 *   --json             machine-readable, for the dashboard and for diffing runs
 *   --quiet            suppress progress lines
 */

import { fitRecoveryScorer, buildWorld, runArm } from '../harness.js';
import { GUARDRAILS, POLICY } from '../../core/config.js';
import { readFlags, asNumber } from './flags.js';

/**
 * A FIXED DEFAULT START INSTANT, for the same reason `decide-report` has one: quiet hours, the retry
 * gap and the case-age budget are all clock-dependent, so `new Date()` would make this report
 * irreproducible in a way invisible in its own output. 15:00 IST, deliberately away from a boundary.
 */
const DEFAULT_NOW = '2026-08-24T09:30:00Z';

const f = readFlags(
  process.argv.slice(2),
  { seed: 'day7', count: '80', cycles: '8', 'step-hours': '12', split: 'TRAIN', now: DEFAULT_NOW, trail: '1' },
  ['json', 'quiet'],
  (raw) => {
    const split = String(raw.split).toUpperCase();
    if (split !== 'TRAIN' && split !== 'TEST') throw new Error(`--split=${raw.split} must be TRAIN or TEST`);
    if (Number.isNaN(new Date(raw.now).getTime())) {
      throw new Error(`--now=${raw.now} is not a parsable date. Use an ISO instant, e.g. ${DEFAULT_NOW}`);
    }
    const stepHours = asNumber(raw['step-hours'], 'step-hours', { integer: false, min: 0.25 });
    /**
     * A step shorter than the minimum retry gap is not an error, but it is worth naming: every case
     * that retried last cycle will be DEFERRED this cycle by TIM_RETRY_GAP, so the run will look
     * mysteriously idle. Saying so beats letting the reader conclude the policy is broken.
     */
    return {
      ...raw,
      split,
      stepHours,
      count: asNumber(raw.count, 'count', { min: 1 }),
      cycles: asNumber(raw.cycles, 'cycles', { min: 1 }),
      trail: asNumber(raw.trail, 'trail', { min: 0 }),
    };
  }
);

const asJson = f.json;
const quiet = f.quiet || asJson;
const say = (msg) => { if (!quiet) process.stderr.write(`  ... ${msg}\n`); };
const config = { GUARDRAILS, POLICY };
const startAt = new Date(f.now);

const RUPEE = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const PCT = (x) => `${(100 * x).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

const started = Date.now();

// =============================================================================================
// STEP 1 — FIT THE RECOVERY MODEL ON TRAIN, ALWAYS
// =============================================================================================
/**
 * Both of these now come from `src/eval/harness.js`, which Day 8 extracted so that the five-arm
 * comparison in `npm run eval` runs the SAME loop this command runs. That is not tidying: a
 * baseline measured by a different runner measures the runner. The extraction was verified by
 * diffing this command's `--json` output before and after — identical apart from `elapsedMs`.
 *
 * The model is fitted on TRAIN even when `--split=TEST`, deliberately. Fitting on the split being
 * run would make every lookup cell well-supported and the support asymmetry impossible to observe.
 */
say('generating TRAIN and fitting the recovery model');
const { scoreAction, logistic, logPlatt, lookup, train } = await fitRecoveryScorer({
  seed: f.seed,
  startAt,
});

// =============================================================================================
// STEP 2 — BUILD THE WORLD AND RUN THE LOOP
// =============================================================================================
/**
 * `buildWorld` observes and diagnoses every case; `runArm` owns the store, the gateway, the shared
 * mutable clock, and the cycle loop. The clock in particular is why this is one function and not
 * three: the orchestrator and the gateway must read the same instant, or a retry priced to land at
 * +72h gets resolved against whenever the process happened to be running, and Day 6's whole
 * landing-instant correction is undone at the seam with no test failing.
 */
say(`observing and diagnosing ${f.count} cases`);
const world = await buildWorld({
  seed: f.seed,
  split: f.split,
  count: f.count,
  startAt,
  train,
});

const totalExposurePaise = world.totalExposurePaise;

const run = await runArm({
  world,
  arm: 'REBOUND_EV',
  scoreAction,
  cycles: f.cycles,
  stepHours: f.stepHours,
  config,
  onCycle: (summary, at) =>
    say(`cycle ${summary.cycle} at ${at.toISOString()}: ${summary.decided} decided, ` +
      `${summary.attempts} executed, ${RUPEE(summary.recoveredPaise)} recovered`),
});

const { store, runId, cycles, recoveredPaise, attempts } = run;
if (run.stoppedEarlyAfter !== null) say(`all cases terminal after ${run.stoppedEarlyAfter} cycles; stopping early`);


// =============================================================================================
// STEP 3 — WHERE EVERY CASE ENDED UP
// =============================================================================================
const finalCases = await store.getCases(runId);
const stateMix = new Map();
for (const c of finalCases) {
  const e = stateMix.get(c.state) ?? { count: 0, exposurePaise: 0, recoveredPaise: 0 };
  e.count += 1;
  e.exposurePaise += c.amountPaise ?? 0;
  e.recoveredPaise += c.recoveredPaise ?? 0;
  stateMix.set(c.state, e);
}

const allActions = await store.getActions(runId);
const actionMix = new Map();
for (const a of allActions) {
  const k = a.channel ? `${a.kind}:${a.channel}` : a.kind;
  const e = actionMix.get(k) ?? { count: 0, settled: 0, capturedPaise: 0 };
  e.count += 1;
  if (a.state === 'SETTLED') e.settled += 1;
  e.capturedPaise += a.receipt?.amountCollectedPaise ?? 0;
  actionMix.set(k, e);
}

/**
 * `recoveredPaise` is computed twice on purpose and the two must agree.
 *
 * One number comes from summing per-cycle receipts as the run went; the other from re-reading the
 * final case records. They are produced by different code paths — one through `summariseCycle`, one
 * through `settleAttempt`'s patch — and a disagreement means money was credited to a case without a
 * receipt behind it, or a receipt landed that no case recorded. That is the single most important
 * invariant in the project, so it is checked rather than assumed, and loudly.
 */
const recoveredFromCases = finalCases.reduce((s, c) => s + (c.recoveredPaise ?? 0), 0);
const ledgerAgrees = recoveredFromCases === recoveredPaise;

const contactsByCustomer = new Map();
for (const a of allActions) {
  if (!a.channel || a.state !== 'SETTLED') continue;
  contactsByCustomer.set(a.customerId, (contactsByCustomer.get(a.customerId) ?? 0) + 1);
}
const maxContacts = contactsByCustomer.size ? Math.max(...contactsByCustomer.values()) : 0;
const capBreaches = [...contactsByCustomer.entries()]
  .filter(([, n]) => n > GUARDRAILS.maxMessagesPerCustomerPer7Days)
  .map(([customerId, n]) => ({ customerId, messages: n }));

// The trail is worth more on a case that actually did something, so prefer the busiest lifecycle.
const auditCounts = [];
for (const c of finalCases) {
  const entries = await store.getAudit(runId, { eventId: c.eventId });
  auditCounts.push({ eventId: c.eventId, n: entries.length, state: c.state, amountPaise: c.amountPaise });
}
auditCounts.sort((a, b) => (b.n - a.n) || (b.amountPaise - a.amountPaise));

/**
 * WHOSE MONEY WAS IT TO CHASE?
 *
 * The first version of this report printed one recovery rate: recovered over everything at risk.
 * On the first real run that read 0.2%, and it was a misleading number in the direction that
 * flatters nobody — 70% of the money at risk sat in AWAITING_APPROVAL, above the ₹25,000 human
 * threshold, where the agent is *forbidden* to act without a person. Dividing by money the policy
 * was never allowed to touch measures the approval threshold, not the policy.
 *
 * So the exposure is split three ways and all three are printed. `awaitingHuman` and `escalated`
 * are not failures; they are the compliant-escalation half of the Track 03 bar working. But they
 * must be visible, because the honest claim is "of the money it was allowed to chase, it recovered
 * X" and the dishonest one in the other direction would be to quietly drop them from the
 * denominator without saying so.
 */
const TERMINAL_NOT_OURS = new Set(['AWAITING_APPROVAL', 'ESCALATED']);
let awaitingHumanPaise = 0;
let escalatedPaise = 0;
for (const c of finalCases) {
  if (c.state === 'AWAITING_APPROVAL') awaitingHumanPaise += c.amountPaise ?? 0;
  if (c.state === 'ESCALATED') escalatedPaise += c.amountPaise ?? 0;
}
const autonomousExposurePaise = totalExposurePaise - awaitingHumanPaise - escalatedPaise;

if (asJson) {
  console.log(JSON.stringify({
    seed: f.seed,
    split: f.split,
    startAt: startAt.toISOString(),
    stepHours: f.stepHours,
    cyclesRequested: f.cycles,
    cyclesRun: cycles.length,
    cases: finalCases.length,
    totalExposurePaise,
    /**
     * Named rather than left to the consumer to derive, so a dashboard cannot accidentally divide
     * recovery by the wrong denominator and publish a figure this command would not stand behind.
     */
    exposure: {
      totalPaise: totalExposurePaise,
      awaitingHumanPaise,
      escalatedPaise,
      autonomousPaise: autonomousExposurePaise,
    },
    simulatedRecoveredPaise: recoveredPaise,
    recoveryRateOfAutonomous: autonomousExposurePaise ? recoveredPaise / autonomousExposurePaise : 0,
    recoveryRateOfTotal: totalExposurePaise ? recoveredPaise / totalExposurePaise : 0,
    recoveryIsSimulated: true,
    hasBaseline: false,
    selfRecoveryCounterfactualIncluded: false,
    ledgerAgrees,
    recoveredFromCases,
    attempts,
    cycles,
    finalStates: Object.fromEntries(stateMix),
    actionMix: Object.fromEntries(actionMix),
    compliance: {
      maxMessagesToOneCustomer: maxContacts,
      capPerCustomerPer7Days: GUARDRAILS.maxMessagesPerCustomerPer7Days,
      breaches: capBreaches,
    },
    elapsedMs: Date.now() - started,
  }, null, 2));
} else {
  const L = [];
  L.push('');
  L.push('  REBOUND — ORCHESTRATED RUN REPORT  (Day 7)');
  L.push('  ' + '='.repeat(90));
  L.push(`  seed ${f.seed}   split ${f.split}   cases ${finalCases.length}   ${cycles.length} cycles` +
    `   ${f.stepHours}h apart from ${startAt.toISOString()}`);
  L.push(`  model: LOGISTIC over ${logistic.weights.length} observable features + Platt (a=${logPlatt.a.toFixed(4)}` +
    ` b=${logPlatt.b.toFixed(4)}), support from GROUP BY over ${lookup.groups} cells`);
  L.push(`  gateway: SIM — every rupee below is SIMULATED. No Razorpay call was made and no money moved.`);
  L.push('');
  L.push(`  Total at risk in this run: ${RUPEE(totalExposurePaise)}`);
  L.push('');

  L.push('  WHAT EACH CYCLE DID');
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('cycle', 7)}${pad('at', 22)}${lpad('due', 6)}${lpad('acted', 7)}${lpad('woke', 6)}` +
    `${lpad('sup.', 6)}${lpad('recovered (sim)', 18)}`);
  for (const c of cycles) {
    L.push(
      `  ${pad(c.cycle, 7)}${pad(String(c.at).slice(0, 19), 22)}${lpad(c.dueCases, 6)}${lpad(c.attempts, 7)}` +
      `${lpad(c.scheduledWakeups, 6)}${lpad(c.proposalsSuperseded, 6)}${lpad(RUPEE(c.recoveredPaise), 18)}`
    );
  }
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('total', 29)}${lpad('', 6)}${lpad(attempts, 7)}${lpad('', 6)}${lpad('', 6)}${lpad(RUPEE(recoveredPaise), 18)}`);
  L.push('');
  L.push('  "due" is cases the scheduler woke; "acted" is gateway calls that returned a receipt;');
  L.push('  "woke" is retries deferred to a later cycle; "sup." is proposals superseded when the');
  L.push('  live run budget differed from the state the case was priced against.');
  L.push('');

  L.push('  WHERE EVERY CASE ENDED UP');
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('final state', 22)}${lpad('cases', 7)}${lpad('share', 8)}${lpad('at risk', 14)}${lpad('recovered (sim)', 18)}`);
  const orderedStates = [...stateMix.entries()].sort((a, b) => b[1].exposurePaise - a[1].exposurePaise);
  for (const [state, e] of orderedStates) {
    L.push(`  ${pad(state, 22)}${lpad(e.count, 7)}${lpad(PCT(e.count / finalCases.length), 8)}` +
      `${lpad(RUPEE(e.exposurePaise), 14)}${lpad(RUPEE(e.recoveredPaise), 18)}`);
  }
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('total', 22)}${lpad(finalCases.length, 7)}${lpad('', 8)}${lpad(RUPEE(totalExposurePaise), 14)}${lpad(RUPEE(recoveredFromCases), 18)}`);
  L.push('');
  L.push('');
  L.push('  WHOSE MONEY WAS IT TO CHASE?');
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('at risk in this run', 42)}${lpad(RUPEE(totalExposurePaise), 14)}`);
  L.push(`  ${pad('  parked awaiting human approval', 42)}${lpad(RUPEE(awaitingHumanPaise), 14)}` +
    `${lpad(PCT(totalExposurePaise ? awaitingHumanPaise / totalExposurePaise : 0), 9)}`);
  L.push(`  ${pad('  escalated to a human', 42)}${lpad(RUPEE(escalatedPaise), 14)}` +
    `${lpad(PCT(totalExposurePaise ? escalatedPaise / totalExposurePaise : 0), 9)}`);
  L.push(`  ${pad('  the agent\'s to act on autonomously', 42)}${lpad(RUPEE(autonomousExposurePaise), 14)}` +
    `${lpad(PCT(totalExposurePaise ? autonomousExposurePaise / totalExposurePaise : 0), 9)}`);
  L.push('');
  L.push(`  Recovered ${RUPEE(recoveredPaise)} (SIMULATED) =` +
    ` ${PCT(autonomousExposurePaise ? recoveredPaise / autonomousExposurePaise : 0)} of what it was allowed to chase,` +
    ` ${PCT(totalExposurePaise ? recoveredPaise / totalExposurePaise : 0)} of everything at risk.`);
  L.push('');
  L.push(`  BOTH rates are printed because either alone misleads. Dividing by everything at risk`);
  L.push(`  measures the ₹${(GUARDRAILS.humanApprovalThresholdPaise / 100).toLocaleString('en-IN')} approval threshold rather than the policy — a handful of large`);
  L.push('  invoices can park most of the exposure with a human and make a working agent look');
  L.push('  inert. Dividing only by the autonomous slice, without showing the rest, quietly hides');
  L.push('  how much of the book needed a person. The approval and escalation rows are not');
  L.push('  failures; they are the compliant-escalation half of what Track 03 asks for. They just');
  L.push('  have to be visible.');
  L.push('');
  L.push('  Neither rate is a claim that the policy BEATS anything. There is no baseline here and');
  L.push('  no counterfactual: `checkSelfRecovery` exists in the response model and this command');
  L.push('  does not call it, so the money that would have come back with no agent at all is not');
  L.push('  yet subtracted from anything. That comparison is Day 8 (`npm run eval`), and until it');
  L.push('  exists the only honest reading of these numbers is "the loop runs and this is what it');
  L.push('  did", not "this is what it was worth".');
  L.push('');
  L.push(ledgerAgrees
    ? `  Ledger check: receipts and case records agree at ${RUPEE(recoveredPaise)}.`
    : `  !! LEDGER MISMATCH: receipts say ${RUPEE(recoveredPaise)}, case records say ${RUPEE(recoveredFromCases)}.`);
  L.push('  Two independent code paths produce that figure — per-cycle receipts, and the patch');
  L.push('  `settleAttempt` writes onto the case. A disagreement would mean money credited without a');
  L.push('  receipt behind it, so it is checked here rather than assumed.');
  L.push('');

  L.push('  WHAT IT ACTUALLY DID, BY ACTION');
  L.push('  ' + '-'.repeat(90));
  L.push(`  ${pad('action', 30)}${lpad('attempts', 10)}${lpad('settled', 9)}${lpad('recovered (sim)', 18)}`);
  for (const [k, e] of [...actionMix.entries()].sort((a, b) => b[1].count - a[1].count)) {
    L.push(`  ${pad(k, 30)}${lpad(e.count, 10)}${lpad(e.settled, 9)}${lpad(RUPEE(e.capturedPaise), 18)}`);
  }
  if (actionMix.size === 0) L.push('  (nothing was executed — every case stopped, waited or escalated)');
  L.push('');

  L.push('  COMPLIANCE, MEASURED RATHER THAN ASSERTED');
  L.push('  ' + '-'.repeat(90));
  L.push(`  Per-customer message cap: ${GUARDRAILS.maxMessagesPerCustomerPer7Days} per 7 days.` +
    `  Worst case observed in this run: ${maxContacts}.`);
  if (capBreaches.length) {
    L.push(`  !! ${capBreaches.length} CUSTOMER(S) OVER THE CAP — the cross-case control did not hold:`);
    for (const b of capBreaches.slice(0, 5)) L.push(`     ${b.customerId}: ${b.messages} messages`);
  } else {
    L.push('  No customer was messaged more than the cap allows.');
  }
  L.push('  Counted from the action ledger by customer, NOT from the guardrail\'s own verdicts. Asking');
  L.push('  the rule whether it was obeyed is circular; counting what was actually sent is not.');
  L.push('');

  // =========================================================================================
  // THE AUDIT TRAIL — the artefact Track 03 asks for
  // =========================================================================================
  for (const pick of auditCounts.slice(0, f.trail)) {
    const entries = await store.getAudit(runId, { eventId: pick.eventId });
    const record = finalCases.find((c) => c.eventId === pick.eventId);
    const diag = world.diagnosisById.get(pick.eventId);

    L.push('  ' + '='.repeat(90));
    L.push(`  LIFECYCLE AUDIT TRAIL — case ${pick.eventId}`);
    L.push('  ' + '='.repeat(90));
    L.push(`  ${RUPEE(record.amountPaise)} at risk   |   diagnosed ${diag.rootCause} at the ${diag.matchTier} tier` +
      `${diag.matchedOn ? ` (${diag.matchedOn})` : ''}${diag.abstained ? ' [ABSTAINED]' : ''}   |   ended ${record.state}`);
    if (record.recoveredPaise) L.push(`  Recovered ${RUPEE(record.recoveredPaise)} (SIMULATED) at ${record.recoveredAt}`);
    /**
     * No confidence number on the diagnosis line, deliberately. `diagnose` does not emit one — a
     * "0.93" would be a claim that 93 of 100 cases that look like this have this cause, which
     * nothing in the rule tables measures. What it emits instead is the TIER the match came from
     * and whether that tier is trusted to authorise money on its own, which is a claim the code
     * can actually back. TEXT-tier matches scored 0% on the first corpus they were measured
     * against, so they route to a human rather than to a charge.
     */
    if (diag.requiresApprovalForMoneyMovement) {
      L.push(`  This tier may NOT authorise money movement on its own — money-moving actions on this`);
      L.push(`  case require a human. (source=${diag.source}, tier=${diag.matchTier})`);
    }
    L.push(`  ${entries.length} audit entries, ${record.retriesUsed ?? 0} retries and ${record.touchesUsed ?? 0} contacts used`);
    L.push('');
    for (const e of entries) {
      const when = String(e.at).slice(0, 19);
      L.push(`  ${pad(when, 21)}${pad(e.type, 22)}${summariseEntry(e)}`);
    }
    L.push('');

    /**
     * WHY THE MONEY-MOVING DECISION WAS PRICED THE WAY IT WAS.
     *
     * The audit entries above record WHAT happened — decided, attempted, settled. They do not
     * record why one scheduled slot was chosen over another, because that reasoning lives on the
     * decision record, not the event log. Track 03 asks for a trail that explains its escalation
     * and stopping; the timing line is the same idea one level down — the single sentence that
     * says why a retry three days out scored higher than one now. Pulled from the persisted
     * decision's own `explain`, not re-derived here, so the trail cannot drift from the decision.
     */
    const decisions = await store.getDecisions(runId, pick.eventId);
    const timingLines = decisions
      .flatMap((d) => (d.explain ?? []).filter((l) => l.startsWith('Timing:')))
      .filter((l, i, a) => a.indexOf(l) === i); // dedupe: a case re-decided each cycle repeats the line
    if (timingLines.length) {
      L.push('  WHY THE TIMING WAS PRICED AS IT WAS (from the decision record, deduplicated):');
      for (const line of timingLines.slice(0, 4)) L.push(`  ${line}`);
      L.push('');
    }
    L.push('  Every line is written before or at the moment of the thing it describes — the attempt');
    L.push('  rows in particular are persisted BEFORE the gateway call they guard, which is what makes');
    L.push('  a crash mid-flight recoverable instead of invisible.');
    L.push('');
  }

  L.push(`  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  L.push('');
  console.log(L.join('\n'));
}

/**
 * One line of detail per audit type. Written as an explicit switch rather than dumping the detail
 * object, because a reviewer reading a trail needs the ONE fact that entry establishes, and a JSON
 * blob per line makes a twenty-entry lifecycle unreadable.
 */
function summariseEntry(e) {
  const d = e.detail ?? {};
  switch (e.type) {
    case 'CASE_DECIDED':
      return `${d.outcome}${d.chosen ? ` -> ${d.chosen}` : ''}` +
        `${d.evPaise != null ? ` (EV ${RUPEE(d.evPaise)}` : ''}${d.p != null ? `, p=${d.p.toFixed(3)}` : ''}` +
        `${d.evPaise != null ? `, bar ${RUPEE(d.barPaise ?? 0)}, ${d.candidatesConsidered} candidates)` : ''}`;
    case 'PROPOSAL_SUPERSEDED':
      return `${d.proposedAction} -> ${d.committedAction}: ${d.because}`;
    case 'ATTEMPT_STARTED':
      return `${d.kind}${d.channel ? `:${d.channel}` : ''} key ${d.idempotencyKey}`;
    case 'ATTEMPT_SETTLED':
      return `${d.receiptState}${d.amountCollectedPaise ? ` collected ${RUPEE(d.amountCollectedPaise)}` : ''}` +
        `${d.reconciled ? ' (reconciled)' : ''}`;
    case 'ATTEMPT_FAILED':
      return `gateway threw: ${d.error} — left PENDING for reconciliation`;
    case 'ATTEMPT_RECONCILED':
      return `asked the provider, it said ${d.resolvedState} (ref ${d.providerRef ?? 'none'})`;
    case 'ATTEMPT_DUPLICATE':
      return d.because ?? 'already done';
    case 'MONEY_RECOVERED':
      return `${RUPEE(d.amountPaise)} via ${d.viaKind}${d.channel ? `:${d.channel}` : ''} (SIMULATED)`;
    case 'CONTACT_RECORDED':
      return `${d.channel} to ${d.customerId} — written to the cross-case ledger`;
    case 'CASE_SCHEDULED':
      return `${d.intent} at ${String(d.wakeAt).slice(0, 19)} — re-decided on wakeup, not replayed`;
    case 'CASE_WAITING':
      return `until ${String(d.until).slice(0, 19)}: ${d.because}`;
    case 'APPROVAL_REQUESTED':
      return `${d.proposed} (${RUPEE(d.evPaise ?? 0)}) — ${(d.reasons ?? []).join('; ')}`;
    case 'CASE_ESCALATED':
      return `${d.code}: ${d.because}`;
    case 'CASE_STOPPED':
      return `${d.code}: ${d.because}`;
    case 'CASE_EXPIRED':
      return d.because ?? 'past the case-age budget';
    case 'CYCLE_STARTED':
      return `cycle ${d.cycle}, ${d.dueCases} due`;
    case 'CYCLE_FINISHED':
      return `cycle ${d.cycle}: ${d.decided} decided, ${d.attempts} executed`;
    default:
      return JSON.stringify(d);
  }
}
