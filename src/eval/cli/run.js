#!/usr/bin/env node
/**
 * npm run eval
 *
 * THE HEADLINE COMMAND. Five policies, the same batches, the same luck, one scorer.
 *
 * This is the command that answers Track 03's bar — "show measured money recovered across a batch,
 * with compliant escalation, stopping rules, and an audit trail" — and it is the only command in the
 * project whose output belongs in the pitch. Everything else either proves the plumbing works or
 * reports on a single arm, and a single arm's recovery total means almost nothing: the aggressive
 * baseline recovers a similar amount while breaking two rules a payments team would be fired for.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT MAKES THIS A COMPARISON AND NOT FIVE RUNS PRINTED TOGETHER
 * ---------------------------------------------------------------------------------------------
 * Four things are held identical across arms within a world, and each one is a way a comparison can
 * quietly become meaningless:
 *
 *   SAME WORLD    — one `buildWorld` per seed. Events, customers, latent truth, observations and
 *                   diagnoses are computed once and shared, so a difference between arms cannot be a
 *                   difference between batches.
 *   SAME MODEL    — fitted once on TRAIN, shared. Refitting per arm would make each arm's opponent a
 *                   slightly different model.
 *   SAME LUCK     — every arm runs under the same `runId` in its OWN store, because the gateway hashes
 *                   the runId into its RNG seed. Different runIds would give each arm different
 *                   outcome draws, and with n=80 that noise is larger than the effect.
 *   SAME CLOCK    — one mutable instant shared by orchestrator and gateway inside `runArm`.
 *
 * All four live in `harness.js` and are asserted there. This command adds the fifth: SAME SCORER —
 * `metrics.js` scores all five arms through one code path, so a difference between arms cannot be a
 * difference between summarisers.
 *
 * ---------------------------------------------------------------------------------------------
 * THE RUN-LEVEL CIRCUIT BREAKERS, AND WHY THIS COMMAND RAISES THEM
 * ---------------------------------------------------------------------------------------------
 * `GUARDRAILS.maxMessagesPerRun` is 250 in production and it BINDS here: 80 cases over 21 cycles gives
 * B2 far more contacting opportunities than that, and in every probe world B2 hit exactly 250.
 *
 * A truncated B2 recovers LESS. That flatters Rebound — the unsafe direction — and it does so
 * invisibly, because a capped run looks exactly like a run whose policy chose to stop. So this command
 * raises the two run-level breakers for the eval and prints the cap beside the actual count for every
 * arm, with a loud warning when any arm is within reach of one. If B2 is silenced by a circuit breaker
 * rather than by its own preferences, the compliance contrast is measured against a policy that was
 * prevented from misbehaving, and the headline is worth nothing.
 *
 * The PER-CASE guardrails are NOT raised. Those are the compliance rules under test.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT TO READ, IN ORDER
 * ---------------------------------------------------------------------------------------------
 * 1. THE ARM CARDS. What each policy is allowed to see and do, printed from `describeArm()` which
 *    reads the same constant the code enforces. B2's exemptions are listed there rather than in prose,
 *    so the arm cannot claim a compliance profile it does not have.
 *
 * 2. THE INVARIANTS BLOCK. If any invariant fails, the headline is SUPPRESSED and the command exits
 *    non-zero. A comparison whose money does not reconcile is not a weaker result, it is not a result.
 *
 * 3. INCREMENTAL, not gross. Gross recovery includes money that would have arrived with no agent at
 *    all — in one 40-case world that was two thirds of the total. `incremental` subtracts the
 *    do-nothing arm's take, which is the entire reason B0 is in the set. Arm-vs-arm differences are
 *    unaffected either way, because the counterfactual is common to both and cancels.
 *
 * 4. THE COMPLIANCE COLUMNS, beside the money. This is the actual argument: B2 recovers by breaking
 *    rules, B3 is compliant and competent, Rebound beats B3 while breaking nothing. Money without
 *    those columns is the number every submission prints.
 *
 * 5. THE SPREAD, not the mean. With a handful of worlds a mean paired difference is weak evidence, so
 *    the pooled block prints the mean WITH its range, its standard deviation, its sign count and n.
 *    "Up in 5 of 5 worlds, mean +X, range +A to +B, n=5" is a more honest sentence than any single
 *    number, and no p-value is printed at this n on purpose.
 *
 * Flags (all --name=value; the spaced form is a hard error — see cli/flags.js):
 *   --seeds=1,2,3,4,5  worlds to run. Each is an independent batch; results are paired within one.
 *   --count=80         cases per world
 *   --split=TEST       TRAIN or TEST. The model is fitted on TRAIN either way.
 *   --cycles=21        defaults to HORIZON.cycles — see config.js for why 21 and why it must be odd
 *   --step-hours=12    defaults to HORIZON.stepHours
 *   --arms=...         comma-separated subset, for debugging. Dropping B0 makes incremental unavailable.
 *   --now=...          ISO start instant. A fixed default, NOT the wall clock.
 *   --ev-bar-sigma-k=1 standard errors of headroom the EV bar demands. 0 = the old flat ₹2 bar.
 *   --json             machine-readable, for the dashboard and for diffing runs
 *   --quiet            suppress progress lines
 */

import { fitRecoveryScorer, buildWorld, runArm } from '../harness.js';
import { scoreArm, compareWithinWorld, poolAcrossWorlds } from '../metrics.js';
import { policyFor, describeArm } from '../baselines.js';
import { GUARDRAILS, POLICY, POLICY_ARMS, HORIZON, describeHorizon } from '../../core/config.js';
import { readFlags, asNumber } from './flags.js';

/**
 * A FIXED DEFAULT START INSTANT. Quiet hours, the retry gap and the case-age budget are all
 * clock-dependent, so `new Date()` would make this report irreproducible in a way invisible in its own
 * output. 15:00 IST, deliberately away from a quiet-hours boundary.
 */
const DEFAULT_NOW = '2026-08-24T09:30:00Z';

const ALL_ARM_IDS = Object.values(POLICY_ARMS).map((a) => a.id);

const f = readFlags(
  process.argv.slice(2),
  {
    seeds: '1,2,3,4,5',
    count: '80',
    split: 'TEST',
    cycles: String(HORIZON.cycles),
    'step-hours': String(HORIZON.stepHours),
    arms: ALL_ARM_IDS.join(','),
    now: DEFAULT_NOW,
    'ev-bar-sigma-k': String(POLICY.evBarSigmaK ?? 0),
  },
  ['json', 'quiet'],
  (raw) => {
    const split = String(raw.split).toUpperCase();
    if (split !== 'TRAIN' && split !== 'TEST') throw new Error(`--split=${raw.split} must be TRAIN or TEST`);
    if (Number.isNaN(new Date(raw.now).getTime())) {
      throw new Error(`--now=${raw.now} is not a parsable date. Use an ISO instant, e.g. ${DEFAULT_NOW}`);
    }
    const seeds = String(raw.seeds).split(',').map((s) => s.trim()).filter(Boolean);
    if (seeds.length === 0) throw new Error('--seeds needs at least one seed');

    const arms = String(raw.arms).split(',').map((s) => s.trim()).filter(Boolean);
    for (const a of arms) {
      if (!ALL_ARM_IDS.includes(a)) {
        throw new Error(`--arms contains unknown arm "${a}". Known: ${ALL_ARM_IDS.join(', ')}`);
      }
    }

    const cycles = asNumber(raw.cycles, 'cycles', { min: 1 });
    /**
     * The two horizon constraints — long enough for self-recovery, and not ending inside quiet hours —
     * are checked by `describeHorizon` below, not here, because they depend on `--now` as well as on
     * `--cycles` and because `orchestrate-report` needs the identical check. This used to be a local
     * `cycles % 2 === 0` test, which is only equivalent to the real constraint at a 09:00 UTC start
     * with a 12h step.
     */
    return {
      ...raw,
      split,
      seeds,
      arms,
      cycles,
      stepHours: asNumber(raw['step-hours'], 'step-hours', { integer: false, min: 0.25 }),
      count: asNumber(raw.count, 'count', { min: 1 }),
      evBarSigmaK: asNumber(raw['ev-bar-sigma-k'], 'ev-bar-sigma-k', { integer: false, min: 0 }),
    };
  }
);

const asJson = f.json;
const quiet = f.quiet || asJson;
const say = (msg) => { if (!quiet) process.stderr.write(`  ... ${msg}\n`); };
const startAt = new Date(f.now);

const RUPEE = (paise) => (paise === null || paise === undefined ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const started = Date.now();

// =================================================================================================
// THE EVAL CONFIG: PER-CASE RULES UNTOUCHED, RUN-LEVEL BREAKERS RAISED
// =================================================================================================
/**
 * See the header. The run-level breakers exist to stop a runaway loop in production; here they would
 * silently truncate the arm whose misbehaviour the comparison depends on observing, and truncation
 * flatters us. Raised to a value no arm can reach, and both the raised value and each arm's actual
 * count are printed so a reader can confirm nothing bound.
 *
 * Every PER-CASE guardrail keeps its production value. Those are the rules under test, and raising one
 * would be the difference between measuring a policy and measuring a policy with the brakes off.
 */
const EVAL_RUN_BREAKER_HEADROOM = 50; // × cases, per arm — far above any arm's reachable count
const evalGuardrails = {
  ...GUARDRAILS,
  maxMessagesPerRun: f.count * EVAL_RUN_BREAKER_HEADROOM,
  maxRetriesPerRun: f.count * EVAL_RUN_BREAKER_HEADROOM,
};
/**
 * `--ev-bar-sigma-k` is the ONLY policy knob this CLI exposes, and it is exposed for one reason: the
 * support-scaled EV bar (#52) had to be compared against the flat ₹2 bar it replaced, and the
 * comparison is only worth anything if the world, the model, the luck and the clock are all held
 * identical while it moves. Passing `--ev-bar-sigma-k=0` reproduces the previous policy exactly, so
 * the A/B is two invocations of one binary at one commit rather than a diff against a remembered
 * number. Every other policy value stays at its production setting; a CLI that let a reader tune the
 * policy until the table looked good would be a worse tool than one that could not be tuned at all.
 */
const config = { GUARDRAILS: evalGuardrails, POLICY: { ...POLICY, evBarSigmaK: f.evBarSigmaK } };

/** What the production caps would have been, printed beside the actuals. */
const PROD_CAPS = { messages: GUARDRAILS.maxMessagesPerRun, retries: GUARDRAILS.maxRetriesPerRun };

// =================================================================================================
// RUN
// =================================================================================================
const perWorld = [];
const perWorldScored = [];

for (const seed of f.seeds) {
  /**
   * Fitted ONCE per world and shared by every arm. Refitting per arm would let two arms disagree
   * because their models differ, which is not the question being asked. Always on TRAIN, even when the
   * run is on TEST — fitting on the split being scored would make every lookup cell well-supported and
   * the support asymmetry the stopping rules read impossible to observe.
   */
  say(`seed ${seed}: fitting the recovery model on TRAIN`);
  const { scoreAction, train } = await fitRecoveryScorer({ seed, startAt });

  say(`seed ${seed}: building the ${f.split} world (${f.count} cases)`);
  const world = await buildWorld({ seed, split: f.split, count: f.count, startAt, train });

  const scored = [];
  for (const armId of f.arms) {
    say(`seed ${seed}: running ${armId}`);
    const result = await runArm({
      world,
      arm: armId,
      /**
       * `policyFor` returns `undefined` for REBOUND_EV on purpose, so `runCycle` falls through to its
       * own `decideForCase`. The production decision path is the thing under test; a copy of it living
       * in the eval harness would be a different policy wearing its name.
       */
      decide: policyFor(armId),
      scoreAction,
      cycles: f.cycles,
      stepHours: f.stepHours,
      config,
    });
    scored.push(await scoreArm({ result, world }));
  }

  perWorldScored.push(scored);
  perWorld.push(compareWithinWorld(scored));
}

// =================================================================================================
// INVARIANTS — CHECKED BEFORE ANYTHING IS PRINTED
// =================================================================================================
/**
 * A failed invariant suppresses the headline and exits non-zero. This is deliberately harsher than a
 * warning: the failure modes these catch (money credited with no receipt, arms seeing different
 * worlds, an absolute rule breached) do not make the result weaker, they make it not a result. A
 * warning printed above a large number gets skipped; a missing number gets investigated.
 */
const invariantFailures = [];
for (const w of perWorld) {
  const iv = w.invariants;
  const where = `seed ${w.seed}/${w.split}`;
  if (iv.allMoneyReconciles === false) invariantFailures.push(`${where}: money does not reconcile between the running sum and the final case records`);
  if (iv.allExposureReconciles === false) invariantFailures.push(`${where}: exposure does not match the batch the generator built`);
  if (iv.b0RecoveredZero === false) invariantFailures.push(`${where}: B0_DO_NOTHING has agent-side recovery, which is impossible — it takes no actions`);
  if (iv.noAbsoluteBreaches === false) invariantFailures.push(`${where}: an ABSOLUTE guardrail was breached. No arm, not even B2, is permitted this`);
  if (iv.contactCapAgrees === false) {
    /**
     * Two independent measurements of the same rule disagreeing. Fatal rather than a warning,
     * because "zero cap breaches" is one of the two compliance numbers this project puts in front of
     * a judge, and a disagreement means one of the two things producing it is broken and we do not
     * yet know which.
     */
    /**
     * Flat fields on the row: `r.contactCapBreaches`, not `r.violations.contactCapBreaches`.
     * `compareWithinWorld` flattens the nested scorer output, and reading the nested path here
     * would print `undefined` for both sides of a comparison whose entire purpose is to show which
     * of two numbers is wrong.
     */
    const rows = w.rows.map((r) => `${r.arm} engine=${r.contactCapBreaches} ledger=${r.contactCapBreachedCustomers}`);
    invariantFailures.push(`${where}: the guardrail engine and the message ledger disagree about the contact cap — ${rows.join('; ')}`);
  }
  if (iv.selfRecoveryCounterfactualHolds === false) {
    invariantFailures.push(`${where}: a case self-recovered under B0 but carries no money under ${iv.counterfactualLeaks.map((l) => l.arm).join(', ')} — the arms are not seeing the same world`);
  }
  if (iv.approvalsReconcile === false) {
    const rows = w.rows
      .filter((r) => r.approverSaysGranted !== null)
      .map(
        (r) =>
          `${r.arm}: reviewer says ${r.approverSaysGranted}g/${r.approverSaysDenied}d, ` +
          `audit trail says ${r.approvalsGrantedAudits}g/${r.approvalsDeniedAudits}d`
      );
    invariantFailures.push(
      `${where}: the simulated approver's tally does not match the audit trail — ${rows.join('; ')}`
    );
  }
  if (iv.approvalsAccountedFor === false) {
    const rows = w.rows.map((r) => `${r.arm} requested=${r.approvalsRequested} granted=${r.approvalsGranted} denied=${r.approvalsDenied} pending=${r.approvalsPending}`);
    invariantFailures.push(`${where}: more approvals were resolved than requested, which means a case was resolved twice — ${rows.join('; ')}`);
  }
  if (iv.approverIsArmBlind === false) {
    /**
     * Fatal, and of everything in this list it is the one that would most cleanly fake a result. The
     * approval queue holds the largest cases by construction, so a reviewer who answered differently
     * per arm would move the headline money column directly, and no other invariant here would notice.
     */
    invariantFailures.push(`${where}: the same case got different verdicts from the approver under different arms — the approver is not arm-blind, so the comparison is measuring luck in the approval queue`);
  }
}

const armsInclude = (id) => f.arms.includes(id);
const canCompare = armsInclude(POLICY_ARMS.B3_FIXED_LADDER.id) && armsInclude(POLICY_ARMS.REBOUND_EV.id);
const pooled = canCompare
  ? poolAcrossWorlds({ perWorld, armId: POLICY_ARMS.REBOUND_EV.id, versusArmId: POLICY_ARMS.B3_FIXED_LADDER.id })
  : null;
const pooledVsB2 = canCompare && armsInclude(POLICY_ARMS.B2_AGGRESSIVE.id)
  ? poolAcrossWorlds({ perWorld, armId: POLICY_ARMS.REBOUND_EV.id, versusArmId: POLICY_ARMS.B2_AGGRESSIVE.id })
  : null;

// =================================================================================================
// BREAKER AUDIT — did a run-level cap bind for anyone?
// =================================================================================================
const breakerWarnings = [];
for (let i = 0; i < perWorld.length; i += 1) {
  for (const s of perWorldScored[i]) {
    if (s.actions.messages >= evalGuardrails.maxMessagesPerRun) {
      breakerWarnings.push(`seed ${s.seed}: ${s.arm} hit the RAISED message breaker (${s.actions.messages}/${evalGuardrails.maxMessagesPerRun}) — raise EVAL_RUN_BREAKER_HEADROOM and re-run; this arm was truncated`);
    }
    if (s.actions.retries >= evalGuardrails.maxRetriesPerRun) {
      breakerWarnings.push(`seed ${s.seed}: ${s.arm} hit the RAISED retry breaker (${s.actions.retries}/${evalGuardrails.maxRetriesPerRun}) — this arm was truncated`);
    }
  }
}

/**
 * Computed BEFORE the JSON branch so both output modes report the same horizon judgement. A warning
 * that only appears in the human-readable rendering is a warning that a script consuming `--json`
 * will never see, and `--json` is how a sweep consumes this command.
 */
const horizon = describeHorizon({ cycles: f.cycles, stepHours: f.stepHours, startAt });
const horizonDays = horizon.days;

if (asJson) {
  process.stdout.write(JSON.stringify({
    config: {
      seeds: f.seeds, count: f.count, split: f.split, cycles: f.cycles, stepHours: f.stepHours,
      horizonDays,
      horizonWarnings: horizon.warnings,
      horizonIsReference: horizon.isReference,
      startAt: startAt.toISOString(), arms: f.arms,
      productionRunCaps: PROD_CAPS,
      evalRunCaps: { messages: evalGuardrails.maxMessagesPerRun, retries: evalGuardrails.maxRetriesPerRun },
    },
    arms: f.arms.map((id) => describeArm(id)),
    perWorld,
    pooled: { vsB3: pooled, vsB2: pooledVsB2 },
    invariantFailures,
    breakerWarnings,
    elapsedMs: Date.now() - started,
  }, null, 2) + '\n');
  process.exit(invariantFailures.length ? 1 : 0);
}

// =================================================================================================
// RENDER
// =================================================================================================
const L = [];
L.push('');
L.push('  ============================================================================================');
L.push('  REBOUND — FIVE-ARM PAIRED COMPARISON');
L.push('  ============================================================================================');
L.push(`  ${f.seeds.length} world(s) × ${f.count} cases on ${f.split} · ${f.cycles} cycles × ${f.stepHours}h = ${horizonDays} days · start ${startAt.toISOString()}`);
L.push(`  seeds: ${f.seeds.join(', ')}`);
L.push('');
L.push('  SIMULATED RUPEES. This command measures THE POLICY IS BETTER, which is a claim about a');
L.push('  simulation. THE PLUMBING WORKS is a separate claim, proven against the real Razorpay');
L.push('  test-mode API by `npm run live-check`. The two are never added together.');

for (const w of horizon.warnings) {
  L.push('');
  L.push(`  ! ${w}`);
}

// ---- ARM CARDS ---------------------------------------------------------------------------------
L.push('');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  THE ARMS — what each policy may see and do');
L.push('  --------------------------------------------------------------------------------------------');
for (const id of f.arms) {
  const d = describeArm(id);
  L.push('');
  L.push(`  ${d.id}  —  ${d.label}`);
  L.push(`    ${d.purpose}`);
  L.push(`    actions      : ${d.actions}`);
  L.push(`    reads        : diagnosis=${d.usesDiagnosis ? 'YES' : 'no'}  model=${d.usesProbabilityModel ? 'YES' : 'no'}  expected-value=${d.usesExpectedValue ? 'YES' : 'no'}`);
  L.push(`    stopping rule: ${d.hasStoppingRule ? 'yes' : 'NO — runs until budgets bind'}`);
  L.push(`    approval gate: ${d.subjectToApprovalGate ? 'applies' : 'exempt'}`);
  if (d.ignoresRuleIds.length) {
    /**
     * Printed from the same frozen constant the guardrail loop filters on, so this line cannot drift
     * out of step with what the arm actually does. An arm that claimed compliance it did not have
     * would make the central contrast of this whole report a lie.
     */
    L.push(`    IGNORES      : ${d.ignoresRuleIds.join(', ')}`);
  } else {
    L.push('    IGNORES      : nothing — every guardrail binds');
  }
}

// ---- INVARIANTS -------------------------------------------------------------------------------
L.push('');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  INVARIANTS');
L.push('  --------------------------------------------------------------------------------------------');
/**
 * THIS LIST IS HAND-MAINTAINED AND HAD DRIFTED, WHICH IS WORTH A COMMENT BECAUSE OF THE DIRECTION.
 *
 * The checks above are enforced by pushing onto `invariantFailures`; this block is only the pass-side
 * report. So when #62 added `contactCapAgrees` and #61 added the three approval invariants, the run
 * kept enforcing nine checks while telling the reader it had made five. That understates the work
 * rather than overstating it, but it is still a report that does not match what ran, and the whole
 * point of printing an invariant list is that somebody can count them.
 */
if (invariantFailures.length === 0) {
  L.push('  ok  money reconciles from two independent sources in every arm and world');
  L.push('  ok  exposure matches the batch the generator built');
  L.push('  ok  B0_DO_NOTHING has zero agent-side recovery');
  L.push('  ok  no ABSOLUTE guardrail breached by any arm, including B2');
  L.push('  ok  every case that self-recovered under B0 carries money under every arm');
  L.push('  ok  the contact cap measured from the message ledger agrees with the engine\'s own count');
  L.push('  ok  the simulated reviewer\'s tally matches the audit trail, decision for decision');
  L.push('  ok  no arm resolved more approvals than it requested');
  L.push('  ok  the reviewer was ARM-BLIND: the same case got the same verdict under every arm');
} else {
  for (const msg of invariantFailures) L.push(`  FAIL  ${msg}`);
}

// ---- RUN BREAKERS -----------------------------------------------------------------------------
L.push('');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  RUN-LEVEL CIRCUIT BREAKERS — raised for this eval, and audited');
L.push('  --------------------------------------------------------------------------------------------');
L.push(`  production caps : ${PROD_CAPS.messages} messages/run, ${PROD_CAPS.retries} retries/run`);
L.push(`  eval caps       : ${evalGuardrails.maxMessagesPerRun} messages/run, ${evalGuardrails.maxRetriesPerRun} retries/run`);
L.push('  Raised because a truncated arm recovers LESS, which flatters Rebound. Per-case guardrails');
L.push('  are untouched — those are the rules under test. Highest actual counts, per arm:');
L.push('');
L.push(`    ${pad('arm', 18)}${lpad('max msgs', 10)}${lpad('max retries', 13)}   would prod cap have bound?`);
for (const id of f.arms) {
  const rows = perWorldScored.map((ws) => ws.find((s) => s.arm === id)).filter(Boolean);
  const maxMsg = Math.max(0, ...rows.map((s) => s.actions.messages));
  const maxRet = Math.max(0, ...rows.map((s) => s.actions.retries));
  const bound = maxMsg >= PROD_CAPS.messages || maxRet >= PROD_CAPS.retries;
  L.push(`    ${pad(id, 18)}${lpad(maxMsg, 10)}${lpad(maxRet, 13)}   ${bound ? 'YES — production would have truncated this arm' : 'no'}`);
}
for (const w of breakerWarnings) L.push(`  ! ${w}`);

// ---- HORIZON TRUNCATION -----------------------------------------------------------------------
/**
 * THE SAME CLASS OF BUG AS THE MESSAGE CAP, AND THE FIRST SMOKE RUN WALKED STRAIGHT INTO IT.
 *
 * At 7 cycles (3 days) every baseline recovered exactly ₹0 while Rebound recovered ₹1,222 — a
 * spectacular headline and a false one. B3's ladder schedules retries at +24h and +72h and B1's
 * spaced attempts land later still, so a short horizon cuts off the arms that WAIT and leaves the
 * arm that acts early looking uniquely effective. Truncation flatters Rebound, which is the unsafe
 * direction, and it does it invisibly because a run that ended has the same shape as a run that
 * finished.
 *
 * `pendingActions` is the direct measurement: an action executed but not yet resolved when the clock
 * stopped. It is reported per arm rather than summarised, because the number being LARGER FOR THE
 * BASELINES than for Rebound is the specific pattern that invalidates the comparison.
 */
const pendingByArm = f.arms.map((id) => {
  const rows = perWorldScored.map((ws) => ws.find((s) => s.arm === id)).filter(Boolean);
  return { id, pending: rows.reduce((n, s) => n + s.pendingActions, 0), unresolved: rows.reduce((n, s) => n + s.unresolvedCases, 0) };
});
const anyPending = pendingByArm.some((p) => p.pending > 0);
if (horizon.truncated || anyPending) {
  L.push('');
  L.push('  --------------------------------------------------------------------------------------------');
  L.push('  HORIZON TRUNCATION');
  L.push('  --------------------------------------------------------------------------------------------');
  if (horizon.truncated) {
    L.push(`  ! This run covers ${horizonDays} days. The measured horizon this project uses is ${HORIZON.days} days`);
    L.push(`    (HORIZON = ${HORIZON.cycles} cycles × ${HORIZON.stepHours}h), chosen because self-recovery needs about that`);
    L.push('    long to play out. A short horizon cuts off the arms that SPACE their attempts — B3 schedules');
    L.push('    rungs at +24h and +72h — and so flatters the arm that acts earliest. Do not quote a');
    L.push('    comparison from a truncated run.');
  }
  L.push('');
  L.push(`    ${pad('arm', 18)}${lpad('actions still pending', 23)}${lpad('cases unresolved', 18)}`);
  for (const p of pendingByArm) L.push(`    ${pad(p.id, 18)}${lpad(p.pending, 23)}${lpad(p.unresolved, 18)}`);
  L.push('');
  L.push('    An action pending at the end was executed and never resolved: money that may have been');
  L.push('    coming and was not counted. If a baseline has more of these than Rebound, the gap between');
  L.push('    them is partly the clock and not the policy.');
}

// ---- PER-WORLD TABLES -------------------------------------------------------------------------
L.push('');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  PER-WORLD RESULTS');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  incremental = what exists because the agent ran. Gross includes money that would have');
L.push('  arrived unprompted; B0 measures exactly that, and incremental subtracts it.');
L.push('  net = margin-weighted, after costs, ALSO on the incremental basis — see the note below.');

for (const w of perWorld) {
  L.push('');
  L.push(`  seed ${w.seed} · ${w.split} · would-have-arrived-anyway (B0) = ${RUPEE(w.counterfactualPaise)}`);
  L.push(`    ${pad('arm', 18)}${lpad('gross', 11)}${lpad('increment', 11)}${lpad('net', 11)}${lpad('atmpt', 7)}${lpad('msg', 6)}${lpad('quiet!', 7)}${lpad('cap!', 6)}${lpad('worst7d', 8)}${lpad('ABS!', 6)}${lpad('refused', 9)}${lpad('stopped', 9)}`);
  for (const r of w.rows) {
    L.push(
      `    ${pad(r.arm, 18)}${lpad(RUPEE(r.recoveredPaise), 11)}${lpad(RUPEE(r.incrementalPaise), 11)}${lpad(RUPEE(r.netIncrementalPaise), 11)}` +
      `${lpad(r.attempts, 7)}${lpad(r.messages, 6)}${lpad(r.quietHoursMessages, 7)}${lpad(r.contactCapBreaches, 6)}` +
      /**
       * `worst7d` is the most messages any ONE customer received inside a single rolling 7-day
       * window, reconstructed from the message ledger rather than from the guardrail engine's own
       * verdicts. It is the most legible compliance number in this table and the only one that says
       * something when the count of breaches is zero: at the cap it means the control BOUND, whereas
       * a zero would mean it simply never engaged. `cap!` and this column are two independent
       * measurements of one rule, and an invariant above refuses to print anything if they disagree.
       */
      `${lpad(`${r.worstContactWindow}/${GUARDRAILS.maxMessagesPerCustomerPer7Days}`, 8)}${lpad(r.absoluteBreaches, 6)}${lpad(r.guardrailRefusals, 9)}${lpad(r.stoppedCases, 9)}`
    );
  }
}
L.push('');
L.push('  net is on the SAME basis as increment, and this matters. It is margin-weighted money minus');
L.push('  costs, minus the margin-weighted counterfactual — NOT gross-minus-costs. An arm that reaches');
L.push('  a case first stops that case self-recovering later, so gross net can exceed increment and');
L.push('  look like the better number. Measured here in seed 5: B1 gross net Rs 77,454 against');
L.push('  incremental Rs 49,550, because realised self-recovery collapsed from Rs 35,246 to Rs 1,585.');
L.push('  Two adjacent money columns on two different bases is a misread waiting to happen, so both');
L.push('  columns net out the same counterfactual and B0 sits at exactly 0 by construction.');
L.push('');
L.push('  quiet! = messages sent inside quiet hours · cap! = messages past the per-customer 7-day cap');
L.push('  ABS! = absolute-rule breaches (must be 0 everywhere). Those three ARE comparable across arms:');
L.push('  they count rules actually broken by actions actually taken.');
L.push('');
L.push('  refused = candidate actions a guardrail blocked. READ THIS COLUMN WITHIN AN ARM, NOT ACROSS');
L.push('  ARMS. It counts refused CANDIDATES, and the arms enumerate wildly different numbers of');
L.push('  candidates per cycle — Rebound prices the whole action space, B1 considers one thing. So a');
L.push('  bigger number here means "this arm proposed more and was told no more often", not "this arm');
L.push('  is more restrained". Its honest use is the zero test: a non-zero count is evidence the');
L.push('  guardrail engine actually binds on this arm rather than rubber-stamping it.');

// ---- HUMAN APPROVAL ---------------------------------------------------------------------------
/**
 * Its own section rather than four more columns on a table that is already twelve wide. That is
 * partly legibility and partly emphasis: "every rupee above Rs 25,000 was authorised by a named
 * human, the median wait was N hours, and the reviewer refused Rs X" is a Track 03 answer in its own
 * right, and burying it in a wide table would waste it.
 */
L.push('');
L.push('  --------------------------------------------------------------------------------------------');
L.push('  HUMAN APPROVAL — the gate, the queue, and what the reviewer refused');
L.push('  --------------------------------------------------------------------------------------------');
L.push(`  Actions on cases above ${RUPEE(GUARDRAILS.humanApprovalThresholdPaise)} do not execute without a named human.`);
L.push('  The reviewer is SIMULATED: mean SLA and grant rate are declared assumptions, swept in the');
L.push('  sensitivity analysis. They are seeded from the world and the case and NOT from the arm, so');
L.push('  two arms that queue the same case meet the same reviewer with the same answer — an invariant');
L.push('  above refuses to print anything at all if that ever stops being true.');
L.push('');
for (const w of perWorld) {
  L.push(`  seed ${w.seed} · ${w.split}`);
  L.push(`    ${pad('arm', 18)}${lpad('asked', 7)}${lpad('granted', 9)}${lpad('denied', 8)}${lpad('pending', 9)}${lpad('frozen', 12)}${lpad('refused', 12)}${lpad('p50 wait', 10)}${lpad('p90 wait', 10)}`);
  for (const r of w.rows) {
    L.push(
      `    ${pad(r.arm, 18)}${lpad(r.approvalsRequested, 7)}${lpad(r.approvalsGranted, 9)}${lpad(r.approvalsDenied, 8)}${lpad(r.approvalsPending, 9)}` +
      `${lpad(RUPEE(r.frozenPaise), 12)}${lpad(RUPEE(r.approvalsDeniedPaise), 12)}` +
      `${lpad(r.approvalWaitP50 === null ? '-' : `${r.approvalWaitP50}h`, 10)}${lpad(r.approvalWaitP90 === null ? '-' : `${r.approvalWaitP90}h`, 10)}`
    );
  }
  L.push('');
}
L.push('  frozen = exposure still waiting for a human when the horizon ended. Read it as a WARNING on');
L.push('  the money columns above, not as a result: that money was neither recovered nor ruled out, so');
L.push('  an arm with a large frozen figure was interrupted rather than measured. Before this reviewer');
L.push('  existed nothing ever answered the queue, and roughly 72% of Rebound exposure sat here.');
L.push('');
L.push('  refused = exposure a human declined. Denials are TERMINAL, so this is money the policy is');
L.push('  permanently barred from by a decision it does not control — a ceiling on our own headline.');
L.push('  Printed beside frozen so that "frozen: 0" cannot be misread as "nothing was blocked".');
L.push('');
L.push('  asked can EXCEED granted+denied+pending. A grant is an envelope that expires, so a case whose');
L.push('  authorisation lapsed returns for a fresh signature instead of acting on a stale one.');

// ---- POOLED -----------------------------------------------------------------------------------
if (pooled && invariantFailures.length === 0) {
  L.push('');
  L.push('  --------------------------------------------------------------------------------------------');
  L.push('  POOLED ACROSS WORLDS — paired differences, Rebound vs the honest baseline');
  L.push('  --------------------------------------------------------------------------------------------');
  L.push('  B3 is the comparison that matters. It is fully compliant and competently designed, so');
  L.push('  beating it is a claim about the policy. Beating B2 proves less, because B2 buys its');
  L.push('  recovery by breaking rules; beating B0 proves only that acting beats not acting.');

  const block = (title, p) => {
    if (!p) return;
    const s = p.incremental.n > 0 ? p.incremental : p.recovered;
    L.push('');
    L.push(`  ${title}`);
    L.push(`    incremental money : mean ${RUPEE(s.mean)}  range ${RUPEE(s.min)} to ${RUPEE(s.max)}  sd ${RUPEE(s.sd)}  n=${s.n}`);
    L.push(`    net of costs      : mean ${RUPEE(p.netIncremental.mean)}  range ${RUPEE(p.netIncremental.min)} to ${RUPEE(p.netIncremental.max)}  n=${p.netIncremental.n}`);
    L.push(`    direction         : Rebound ahead in ${s.positive} of ${s.n} worlds, behind in ${s.negative}`);
    L.push(`    pooled totals     : ${RUPEE(p.pooled.armIncrementalPaise)} vs ${RUPEE(p.pooled.versusIncrementalPaise)} incremental` +
      (p.pooled.incrementalRatio.value === null ? `  (ratio withheld: ${p.pooled.incrementalRatio.reason})` : `  = ${p.pooled.incrementalRatio.value.toFixed(2)}×`));
  };
  block(`vs ${POLICY_ARMS.B3_FIXED_LADDER.id} — the honest baseline`, pooled);
  block(`vs ${POLICY_ARMS.B2_AGGRESSIVE.id} — the rule-breaking baseline`, pooledVsB2);

  L.push('');
  L.push('  HOW TO QUOTE THIS. Give the sign count and the range, not the mean alone. Between-world');
  L.push('  variance here is large relative to the effect, so a single averaged rupee figure overstates');
  L.push('  how much is known. No p-value is printed: at this many worlds it would be theatre, and the');
  L.push('  mechanism — which rules bound, which actions were chosen, what was refused — is the');
  L.push('  evidence worth showing.');
} else if (invariantFailures.length) {
  L.push('');
  L.push('  --------------------------------------------------------------------------------------------');
  L.push('  HEADLINE SUPPRESSED');
  L.push('  --------------------------------------------------------------------------------------------');
  L.push('  An invariant failed above. A comparison whose money does not reconcile, or whose arms did');
  L.push('  not see the same world, is not a weaker result — it is not a result. Fix the failure and');
  L.push('  re-run before quoting anything from this output.');
} else if (!canCompare) {
  L.push('');
  L.push(`  (pooled comparison needs both ${POLICY_ARMS.REBOUND_EV.id} and ${POLICY_ARMS.B3_FIXED_LADDER.id} in --arms)`);
}

L.push('');
L.push(`  ${((Date.now() - started) / 1000).toFixed(1)}s`);
L.push('');

process.stdout.write(L.join('\n'));
process.exit(invariantFailures.length ? 1 : 0);
