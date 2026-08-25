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
