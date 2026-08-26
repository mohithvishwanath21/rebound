/**
 * THE HARNESS — the invariants that make an arm comparison mean anything
 * =====================================================================
 *
 * Day 8 compares five policies on recovered money. Every test in this file guards a property whose
 * violation would NOT produce a crash or a failing assertion anywhere else — it would produce a
 * comparison that runs, prints confident rupee figures, and measures something other than policy.
 * That is the whole reason they are written down as tests rather than as comments.
 *
 * Run: node --test test/harness.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fitRecoveryScorer, buildWorld, runArm, runIdFor } from '../src/eval/harness.js';
import { buildReference } from '../src/razorpay/gateway.js';
import { deriveSeed } from '../src/core/rng.js';
import { HORIZON, GUARDRAILS, describeHorizon } from '../src/core/config.js';

const START = new Date('2026-08-24T09:30:00Z');
const SEED = 'harness-test';

/**
 * Fitting the model is the slow part (a logistic over ~140 columns and ~20k rows), so it is done
 * once and shared. That mirrors production usage: `fitRecoveryScorer` is called once per world and
 * handed to every arm, precisely so a difference between arms cannot come from their models.
 */
let shared;
async function world({ count = 12 } = {}) {
  shared ??= await fitRecoveryScorer({ seed: SEED, startAt: START });
  const w = await buildWorld({ seed: SEED, split: 'TRAIN', count, startAt: START, train: shared.train });
  return { w, scoreAction: shared.scoreAction };
}

// =============================================================================================
// THE PAIRING INVARIANT — identical luck across arms
// =============================================================================================

test('the runId is a function of the world, never of the arm', () => {
  /**
   * This looks like a triviality and is the single most consequential line in the harness.
   *
   * `simGateway` derives one RNG stream per action from `deriveSeed(seed, reference)`, and
   * `buildReference` hashes the runId into that reference. So appending the arm name to the runId —
   * an entirely reasonable-looking change, the kind made to disambiguate a debug log — gives every
   * arm a different set of outcome draws for the identical action on the identical case. The
   * comparison then silently measures luck, and nothing about its output looks wrong.
   *
   * Demonstrated below rather than asserted, so the failure message can show the reader the two
   * different stream seeds an arm-dependent runId would produce.
   */
  assert.equal(runIdFor({ seed: 'day7', split: 'TRAIN' }), 'run_day7_TRAIN');

  const refFor = (runId) =>
    buildReference({ runId, eventId: 'evt_000001', actionKind: 'RETRY_NOW', channel: null, decisionSeq: 1 });

  const paired = deriveSeed('day7', refFor('run_day7_TRAIN'));
  const unpaired = deriveSeed('day7', refFor('run_day7_TRAIN_B1_NAIVE_RETRY'));

  assert.notEqual(
    paired,
    unpaired,
    'PRECONDITION: if these were equal the runId would not affect the RNG stream and this whole ' +
      'invariant would be unnecessary. They must differ for the test below to be meaningful.'
  );
});

test('two arms over one world face identical luck — the arm label alone changes nothing', async () => {
  /**
   * The behavioural form of the invariant above. The same policy is run twice under two different
   * arm LABELS. Only the label differs, so every rupee must match. If the runId ever becomes
   * arm-dependent, the two runs get different outcome draws and this fails — which is the only way
   * that mistake would ever be caught, since both runs would still look entirely healthy alone.
   */
  const { w, scoreAction } = await world();

  const a = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 3, stepHours: 12 });
  const b = await runArm({ world: w, arm: 'B1_NAIVE_RETRY', scoreAction, cycles: 3, stepHours: 12 });

  assert.equal(a.runId, b.runId, 'both arms must run under the same runId to face the same luck');
  assert.equal(
    a.recoveredPaise,
    b.recoveredPaise,
    `same world, same policy, different label only: recovery must be identical. ` +
      `Got ${a.recoveredPaise} vs ${b.recoveredPaise} — the arm label is leaking into the RNG stream.`
  );
  assert.equal(a.attempts, b.attempts);
  assert.deepEqual(
    a.cycles.map((c) => c.outcomes),
    b.cycles.map((c) => c.outcomes),
    'the per-cycle outcome mix must match cycle for cycle, not merely in total'
  );
});

test('each arm gets its own store, so one arm cannot consume another arm idempotency keys', async () => {
  /**
   * The counterpart to the shared runId. Sharing the runId is required for paired luck; sharing the
   * STORE would be a disaster, because the reference IS the idempotency key. The second arm would
   * find every key already present, skip the action as a duplicate, and report the recovery as free.
   *
   * A near-miss worth pinning: this is the one place where the fix for one invariant creates the
   * conditions for the opposite bug.
   */
  const { w, scoreAction } = await world();

  const a = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 2, stepHours: 12 });
  const b = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 2, stepHours: 12 });

  assert.notEqual(a.store, b.store, 'each arm must get a fresh store');

  const actionsA = await a.store.getActions(a.runId);
  const actionsB = await b.store.getActions(b.runId);
  assert.ok(actionsA.length > 0, 'PRECONDITION: the run must have executed something');
  assert.equal(actionsA.length, actionsB.length, 'a second arm must not find its work already done');
  assert.equal(
    actionsB.filter((x) => x.state === 'SKIPPED').length,
    0,
    'nothing may be skipped as a duplicate: a shared store would make the second arm report ' +
      'another arm recoveries as its own at zero cost'
  );
});

// =============================================================================================
// REPRODUCIBILITY
// =============================================================================================

test('a run is reproducible from its seed, cycle by cycle', async () => {
  const { w, scoreAction } = await world();
  const a = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 3, stepHours: 12 });
  const b = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 3, stepHours: 12 });

  assert.deepEqual(a.cycles, b.cycles, 'the whole per-cycle summary must be identical, not just the total');
  assert.equal(a.recoveredPaise, b.recoveredPaise);
});

test('the harness never puts latent truth on a case record', async () => {
  /**
   * `test/boundary.test.js` enforces that `src/agent/**` cannot IMPORT `src/sim/**`. That is a
   * static check and it cannot catch this: the harness is allowed to import both, so nothing stops
   * it joining a latent onto a case record and handing the agent the answer key. The import
   * boundary and the data boundary are different guarantees and need different instruments.
   */
  const { w, scoreAction } = await world();
  const run = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction, cycles: 1, stepHours: 12 });
  const cases = await run.store.getCases(run.runId);

  assert.ok(cases.length > 0);
  const latentFields = ['willSelfRecover', 'selfRecoverAt', 'trueCause', 'trueRootCause', 'recoverable'];
  for (const c of cases) {
    for (const field of latentFields) {
      assert.ok(
        !(field in c),
        `case ${c.eventId} carries latent field "${field}" — the agent can see the answer key`
      );
    }
    assert.ok(!('latent' in c), `case ${c.eventId} carries a latent record`);
  }
});

// =============================================================================================
// THE POLICY SEAM
// =============================================================================================

test('a policy that stops everything recovers nothing and still terminates every case', async () => {
  /**
   * The shape B0_DO_NOTHING will take. Run here against the real world rather than a stub because
   * the property that matters is that the LOOP terminates: a policy that never acts must not leave
   * cases open forever being re-decided, which is the failure mode a cycle loop is most prone to.
   */
  const { w, scoreAction } = await world();
  const stopAll = ({ observed }) => ({
    eventId: observed.eventId,
    outcome: 'STOP_PERMANENT',
    decisionSeq: 0,
    chosen: null,
    candidates: [],
    barPaise: 200,
    amountPaise: observed.amountPaise,
  });

  const run = await runArm({ world: w, arm: 'B0_DO_NOTHING', scoreAction, decide: stopAll, cycles: 4, stepHours: 12 });

  assert.equal(run.recoveredPaise, 0, 'a policy that never acts cannot recover money — until self-recovery is wired');
  assert.equal(run.attempts, 0, 'no gateway call may be made');

  const cases = await run.store.getCases(run.runId);
  const open = cases.filter((c) => c.state === 'OPEN' || c.state === 'SCHEDULED');
  assert.equal(open.length, 0, `${open.length} case(s) left unresolved: a do-nothing policy must terminate them`);
  assert.equal(run.stoppedEarlyAfter, 1, 'with every case stopped in cycle 0, cycle 1 must find nothing active');
});

// =================================================================================================
// THE HORIZON — #62. One definition, checked against the clock rather than against a parity rule.
// =================================================================================================
/**
 * `HORIZON` declares 21 cycles x 12h = 10 days and two constraints: long enough for self-recovery to
 * play out, and not ending inside quiet hours. Both used to be enforced by hand, in one command, as
 * `cycles % 2 === 0`. These tests exist because that shortcut is only equivalent to the real
 * constraint at one particular start instant and step size — and because the OTHER command that runs
 * the loop defaulted to an even 8 and warned about nothing.
 */
test('the reference horizon satisfies both constraints and warns about nothing', () => {
  const h = describeHorizon({ cycles: HORIZON.cycles, stepHours: HORIZON.stepHours, startAt: START });
  assert.equal(h.days, 10, '21 cycles 12h apart spans 20 steps = 240h = 10 days');
  assert.equal(h.truncated, false);
  assert.equal(h.endsInQuietHours, false, 'the final cycle must land where an arm can actually contact someone');
  assert.equal(h.isReference, true);
  assert.deepEqual(h.warnings, [], `the default horizon must be silent, otherwise the warning is noise: ${h.warnings.join(' | ')}`);
});

test('an ODD cycle count can still end inside quiet hours — the case the parity rule missed', () => {
  /**
   * The point of the whole change. 21 is odd, so the old `cycles % 2 === 0` test stayed silent, but
   * from a 21:30Z start the final cycle lands at 03:00 IST and no arm can contact anyone in it. The
   * old rule was a consequence of the 09:00Z start, not a property of horizons, and a check that is
   * only correct for the default arguments protects nothing the moment someone passes `--now`.
   */
  const h = describeHorizon({ cycles: 21, stepHours: 12, startAt: new Date('2026-08-24T21:30:00Z') });
  assert.equal(h.endsInQuietHours, true, 'final cycle at 03:00 IST is inside the 21:00-09:00 quiet window');
  assert.equal(h.truncated, false, 'this run is a full 10 days — the quiet-hours fault is independent of length');
  assert.equal(h.isReference, false);
  assert.match(h.warnings.join(' '), /quiet hours/, 'the warning must name the reason, not just fire');
  assert.match(h.warnings.join(' '), /03:00/, 'and must print the instant, so a reader can check it against their own clock');
});

test('an EVEN cycle count can be perfectly fine — the false positive the parity rule produced', () => {
  const h = describeHorizon({ cycles: 12, stepHours: 24, startAt: START });
  assert.equal(h.days, 11);
  assert.equal(h.endsInQuietHours, false, '11 days later at a 24h step is the same wall-clock time: 15:00 IST');
  assert.equal(h.truncated, false);
  assert.deepEqual(h.warnings, [], 'warning about a sound horizon teaches people to ignore the warnings');
});

test('a truncated horizon says so, and says which direction the bias runs', () => {
  const h = describeHorizon({ cycles: 7, stepHours: 12, startAt: START });
  assert.equal(h.days, 3, '7 cycles is 6 steps = 72h');
  assert.equal(h.truncated, true);
  assert.equal(h.isReference, false);
  const text = h.warnings.join(' ');
  assert.match(text, /3 days/);
  assert.match(text, /10 days/, 'must state what the horizon should be, not merely that this one is short');
  assert.match(text, /SPACE their attempts/, 'and must state WHO it biases against, because the bias favours Rebound');
});

test('the quiet window comes from the guardrail config, not a second copy of 21:00-09:00', () => {
  /**
   * A horizon check with its own hardcoded window would keep passing after someone widened
   * `GUARDRAILS.quietHours`, and the run would then end in a window the guardrail enforces and the
   * horizon check does not know about. Verified by moving the window rather than by reading the code.
   */
  const nightOwl = { ...GUARDRAILS, quietHours: { startHour: 12, endHour: 18, timezone: 'Asia/Kolkata' } };
  const h = describeHorizon({ cycles: HORIZON.cycles, stepHours: HORIZON.stepHours, startAt: START, guardrails: nightOwl });
  assert.equal(h.endsInQuietHours, true, 'the reference horizon ends at 15:00 IST, which this window forbids');
});

test('runArm defaults to the full HORIZON, not to a convenient small number', async () => {
  /**
   * `cycles = 8` used to be the default here — 4 days, short of the 10 self-recovery needs, and even,
   * so it also ended inside quiet hours. A caller who omits the flag must get the horizon the project
   * measures on. Asserted by running, because the default is only real if the loop honours it.
   */
  const { w, scoreAction } = await world({ count: 2 });
  const run = await runArm({ world: w, arm: 'REBOUND_EV', scoreAction });

  /**
   * Read `run.horizon`, NOT `run.cycles.length`. The first assertion I wrote here used the latter and
   * failed at 1 !== 21 — correctly, because `cycles` holds one summary per cycle that had work to do,
   * and two cases both terminating in cycle 0 leaves exactly one summary. `cycles.length` measures
   * how long the POLICY stayed busy; the horizon is how long the WORLD ran. The run now reports both,
   * because the whole point of #62 was that a truncated run must not be able to read as a complete one.
   */
  assert.equal(run.horizon.cycles, HORIZON.cycles, 'omitting --cycles must run the reference horizon');
  assert.equal(run.horizon.stepHours, HORIZON.stepHours);
  assert.equal(run.horizon.days, 10);

  const expected = new Date(START.getTime() + (HORIZON.cycles - 1) * HORIZON.stepHours * 3_600_000);
  assert.equal(
    run.endedAt.toISOString(),
    expected.toISOString(),
    'and the clock must actually have advanced that far — the world runs on after the policy goes quiet'
  );
  assert.ok(run.cycles.length <= HORIZON.cycles, 'a cycle summary per busy cycle, never more than the horizon');
});

// =============================================================================================
// THE OVERRIDE GUARD — the difference between a perturbed world and a mislabelled one
// =============================================================================================

test('buildWorld refuses a TRAIN batch that was not built with the overrides it is handed', async () => {
  /**
   * `run.js` fits the model and builds the world from the same batch, so `train` arrives already
   * built — with whatever overrides the caller gave `fitRecoveryScorer`. If a sweep row passed its
   * generator overrides to one call and forgot them in the other, `buildWorld` would reuse the
   * BASELINE batch and return an unperturbed world while the run's header printed the perturbation's
   * name and its `why`.
   *
   * Nothing would crash. The row would report "no effect", and the honest-sounding reading of that row
   * is "this assumption does not matter" — a claim about the world, arrived at from a missing argument.
   * This is the guard that turns that into a stack trace, and the assertion on the message text is
   * part of the test because the error has to tell whoever hits it which of the two calls to fix.
   */
  const overrides = { selfRecoveryRate: { FAILED_PAYMENT: 0.9, FAILED_SUBSCRIPTION: 0.9, OVERDUE_INVOICE: 0.9 } };
  shared ??= await fitRecoveryScorer({ seed: SEED, startAt: START });

  await assert.rejects(
    () => buildWorld({ seed: SEED, split: 'TRAIN', count: 2, startAt: START, train: shared.train, overrides }),
    (err) => {
      assert.match(err.message, /overrides\.selfRecoveryRate was supplied/);
      assert.match(err.message, /fitted on the baseline world while the run claims to be/);
      assert.match(err.message, /allowStaleTrain/, 'the message must name the one legitimate way out');
      return true;
    }
  );
});

test('allowStaleTrain lets the skew through, because for one row the skew IS the experiment', async () => {
  /**
   * `stale-model` deliberately moves the world and keeps a model fitted in the baseline world. That is
   * robustness to a MISCALIBRATED model rather than sensitivity to an assumption's value, and it
   * requires exactly the state the guard above rejects.
   *
   * It is a named argument rather than a relaxation of the guard because the two situations are
   * indistinguishable from inside `buildWorld` — a stale model is either the experiment or the bug, and
   * only the caller knows which. Making the caller say so puts the claim in the run's JSON, where a
   * reader can see `refit: false` beside the row's numbers, instead of leaving it a silent property of
   * a code path.
   */
  const overrides = { selfRecoveryRate: { FAILED_PAYMENT: 0.9, FAILED_SUBSCRIPTION: 0.9, OVERDUE_INVOICE: 0.9 } };
  shared ??= await fitRecoveryScorer({ seed: SEED, startAt: START });

  const w = await buildWorld({
    seed: SEED, split: 'TRAIN', count: 2, startAt: START, train: shared.train, overrides, allowStaleTrain: true,
  });
  assert.equal(w.events.length, 2, 'the world must still build');
  assert.equal(w.runId, runIdFor({ seed: SEED, split: 'TRAIN' }), 'and must still pair with the other arms');
});

test('the guard is silent when there are no overrides to disagree about', async () => {
  /**
   * The control row and every cost/margin/policy row pass no generator overrides at all, so the guard
   * must not fire for them — a guard that fired on the baseline would be turned off within a day, and
   * then the sweep's 24 world-perturbing rows would be unprotected.
   */
  shared ??= await fitRecoveryScorer({ seed: SEED, startAt: START });
  const w = await buildWorld({ seed: SEED, split: 'TRAIN', count: 2, startAt: START, train: shared.train });
  assert.equal(w.events.length, 2);
});
