/**
 * THE PERTURBATION CATALOGUE — the tests that stop a sweep from measuring nothing
 * =============================================================================
 *
 * A sensitivity sweep has a failure mode no other part of this project has: when it breaks, it does
 * not crash and it does not print a wrong number. It prints the RIGHT number — the control's number —
 * under a perturbed row's name, and the honest-looking reading of that row is "this assumption does
 * not matter". A silent no-op in this file manufactures confidence.
 *
 * That is not hypothetical. `self-recovery-x1.3` shipped as a no-op in the sweep's first smoke run,
 * on the row whose own `basis` field says it is the most load-bearing assumption in the project, and
 * I nearly read a byte-identical row as robustness. The tests below exist because a reader of
 * ENGINEERING_LOG.md has no way to tell a real null from a broken wire, so the code has to.
 *
 * Every test here is about WIRING, not about outcomes. None of them asserts that Rebound wins
 * anything, and none of them should ever be edited to make a sweep row look better — a failure here
 * means a row in the published table is uninterpretable.
 *
 * Run: node --test test/perturbations.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PERTURBATION_IDS,
  resolvePerturbation,
  describePerturbations,
} from '../src/eval/perturbations.js';
import { COSTS, CONTRIBUTION_MARGIN, POLICY } from '../src/core/config.js';
import { materialiseAssumptions } from '../src/sim/responseModel.js';
import { CAUSE_GIVEN_PAYER } from '../src/sim/generator.js';

const BASE = materialiseAssumptions();

// =============================================================================================
// THE CLOSED LIST — a typo must be an error, never a quiet baseline
// =============================================================================================

test('every catalogue id resolves, and the ids are unique', () => {
  assert.ok(PERTURBATION_IDS.length >= 26, `expected the full catalogue, got ${PERTURBATION_IDS.length}`);
  assert.equal(new Set(PERTURBATION_IDS).size, PERTURBATION_IDS.length, 'duplicate perturbation id');
  for (const id of PERTURBATION_IDS) {
    const p = resolvePerturbation(id);
    assert.equal(p.id, id);
  }
});

test('an unknown id throws, and the error names the known ids', () => {
  /**
   * The alternative — returning the baseline for an unrecognised id — is the exact failure this whole
   * file is about. `--only=retry-penalty-x3` (a row that does not exist) would run the control and
   * print it under a name suggesting a doubled penalty was tested.
   */
  assert.throws(() => resolvePerturbation('retry-penalty-x3'), (err) => {
    assert.match(err.message, /unknown perturbation "retry-penalty-x3"/);
    assert.match(err.message, /retry-penalty-x2/, 'the message must list what IS available');
    return true;
  });
});

test('describePerturbations agrees with the resolver on refit and expectNoMovement', () => {
  /**
   * The sweep table reads these two flags from `describePerturbations` (cheap, no rng) while the run
   * itself reads them from `resolvePerturbation`. If the two ever disagreed, the table's RFT column
   * and the run's actual behaviour would describe different experiments.
   */
  const described = describePerturbations();
  assert.equal(described.length, PERTURBATION_IDS.length);
  for (const d of described) {
    const r = resolvePerturbation(d.id);
    assert.equal(d.refit, r.refit, `${d.id}: refit disagrees`);
    assert.equal(d.expectNoMovement, r.expectNoMovement, `${d.id}: expectNoMovement disagrees`);
    assert.equal(d.family, r.family);
  }
});

test('every row states why it should matter, in enough words to interpret', () => {
  /**
   * Twenty uninterpretable rows all saying "no change" is the easiest way to manufacture false
   * confidence in this project, so the `why` field is load-bearing rather than decorative. The length
   * floor is crude on purpose: it catches a row added in a hurry with `why: 'TODO'`.
   */
  for (const d of describePerturbations()) {
    assert.equal(typeof d.why, 'string', `${d.id}: no why`);
    assert.ok(d.why.length > 60, `${d.id}: why is too short to interpret ("${d.why}")`);
    assert.equal(typeof d.label, 'string');
    assert.ok(d.label.length > 3, `${d.id}: no label`);
  }
});

// =============================================================================================
// THE CONTROL — reference-identical, so the control row cannot differ by construction
// =============================================================================================

test('the baseline row hands back the module tables by reference, not by copy', () => {
  /**
   * `buildWorld`'s override guard tests reference equality, and `metrics.js` prices the scorer from a
   * table it is handed. A baseline that returned a deep COPY of COSTS would still be numerically the
   * control, so nothing would fail — but the control row would stop exercising the same object
   * identity as the perturbed rows, and the guard the perturbed rows rely on would be untested by the
   * one row guaranteed to run.
   */
  const p = resolvePerturbation('baseline');
  assert.equal(p.COSTS, COSTS, 'baseline COSTS must be the module object itself');
  assert.equal(p.CONTRIBUTION_MARGIN, CONTRIBUTION_MARGIN);
  assert.equal(p.POLICY, POLICY);
  assert.equal(p.isBaseline, true);
  assert.equal(p.refit, true);
  assert.deepEqual(p.generatorOverrides, {}, 'the control must perturb no generator parameter');
  assert.deepEqual(p.assumptions, BASE, 'the control must be the materialised assumption set');
});

test('resolving every row mutates none of the shared config objects', () => {
  /**
   * The perturbation builders spread (`{...COSTS}`) rather than assign, and this test is what keeps
   * that true. A single in-place write would leak into every row resolved afterwards AND into the
   * control if it happened to resolve last — turning the whole sweep into a comparison between the
   * catalogue and itself, in catalogue order.
   */
  const before = JSON.stringify({ COSTS, CONTRIBUTION_MARGIN, POLICY, BASE });
  for (const id of PERTURBATION_IDS) resolvePerturbation(id);
  assert.equal(JSON.stringify({ COSTS, CONTRIBUTION_MARGIN, POLICY, BASE }), before);
});

// =============================================================================================
// THE CLAMPS — the places where "+30%" is not a quantity
// =============================================================================================

test('margins clamp at 1.0, and only the two sub-unit margins move', () => {
  /**
   * OVERDUE_INVOICE is already 1.0: recovering an invoice yields the whole amount because no goods
   * moved. "+30% margin" there would mean collecting Rs.100 produced Rs.130 of contribution, which is
   * not an optimistic assumption, it is not a quantity. The row's label says `clamped` for this reason
   * and the test pins the asymmetry so nobody later "fixes" the clamp into a uniform shift.
   */
  const up = resolvePerturbation('margins-x1.3-clamped').CONTRIBUTION_MARGIN;
  assert.equal(up.OVERDUE_INVOICE, 1, 'OVERDUE_INVOICE must stay at 1.0');
  assert.ok(up.FAILED_PAYMENT > CONTRIBUTION_MARGIN.FAILED_PAYMENT, 'FAILED_PAYMENT must rise');
  assert.ok(up.FAILED_SUBSCRIPTION > CONTRIBUTION_MARGIN.FAILED_SUBSCRIPTION);
  for (const v of Object.values(up)) assert.ok(v > 0 && v <= 1, `margin out of range: ${v}`);

  // Downward has no clamp to hit, so all three must move and the ratio must be exact.
  const down = resolvePerturbation('margins-x0.7').CONTRIBUTION_MARGIN;
  for (const [lt, v] of Object.entries(CONTRIBUTION_MARGIN)) {
    assert.ok(Math.abs(down[lt] - v * 0.7) < 1e-9, `${lt}: expected ${v * 0.7}, got ${down[lt]}`);
  }
});

test('the grant rate clamps at 0.9, deliberately short of a rubber stamp', () => {
  /**
   * A reviewer who grants everything is not a perturbed human, it is the ABSENCE of the approval
   * gate — and a run without the gate has less exposure frozen at the horizon, so it reports MORE
   * recovered money. Letting the clamp reach 1.0 would be the sweep quietly deleting the project's
   * own compliance constraint and printing the result as robustness.
   */
  const up = resolvePerturbation('grant-rate-x1.3-clamped').assumptions.approvalGrantRate;
  assert.ok(up <= 0.9 + 1e-12, `grant rate reached ${up}, which is at or past a rubber stamp`);
  assert.ok(up > BASE.approvalGrantRate, 'the +30% row must still move the rate upward');

  const down = resolvePerturbation('grant-rate-x0.7').assumptions.approvalGrantRate;
  assert.ok(Math.abs(down - BASE.approvalGrantRate * 0.7) < 1e-9);
});

// =============================================================================================
// THE BUG THIS FILE WAS WRITTEN FOR — a generation-time latent needs a GENERATOR override
// =============================================================================================

test('a self-recovery perturbation reaches the WORLD, not just the assumption set', () => {
  /**
   * THE REGRESSION TEST. `willSelfRecover` and `selfRecoverAt` are drawn by `generateBatch` from
   * `params.selfRecoveryRate`; at run time `checkSelfRecovery` only reads the latent back:
   *
   *     if (!latent.willSelfRecover || !latent.selfRecoverAt) return false;
   *
   * So a row that moves only the run-time assumption changes what the response model BELIEVES about
   * unprompted payment and leaves the world's actual self-recoverers exactly where they were. The
   * first smoke run printed `self-recovery-x1.3` byte-identical to the control.
   *
   * The assertion is deliberately the strong one: the generator override must equal the assumption
   * table term by term. Merely asserting the key is present would pass if the two drifted apart, and
   * a world whose self-recovery rate disagrees with the response model's is a THIRD experiment that
   * nobody asked for.
   */
  for (const id of ['self-recovery-x0.7', 'self-recovery-x1.3', 'self-recovery-x2']) {
    const p = resolvePerturbation(id);
    assert.ok(
      p.generatorOverrides.selfRecoveryRate,
      `${id}: no generator override — this row would be a silent no-op`
    );
    assert.deepEqual(
      p.generatorOverrides.selfRecoveryRate,
      p.assumptions.selfRecoveryRate,
      `${id}: the world and the response model disagree about self-recovery`
    );
    for (const v of Object.values(p.generatorOverrides.selfRecoveryRate)) {
      assert.ok(v >= 0 && v <= 1, `${id}: self-recovery rate ${v} is not a probability`);
    }
  }
});

test('the self-recovery override is DERIVED, so the joint draws get it too', () => {
  /**
   * The override is derived by comparing the resolved assumption table against the baseline, rather
   * than declared per row. That choice is the test: `joint-1`, `joint-2`, `joint-3` and `stale-model`
   * all perturb `selfRecoveryRate` through `perturbAssumptions`, and a per-row flag would have left
   * every one of them with the same silent hole while looking complete.
   */
  for (const id of ['joint-1', 'joint-2', 'joint-3', 'stale-model']) {
    const p = resolvePerturbation(id);
    assert.ok(
      p.generatorOverrides.selfRecoveryRate,
      `${id}: joint draw moved self-recovery in the assumptions but not in the world`
    );
    assert.deepEqual(p.generatorOverrides.selfRecoveryRate, p.assumptions.selfRecoveryRate);
  }
});

test('a row that does NOT move self-recovery gets no generator override for it', () => {
  /**
   * The other half of the derivation. If the equality test were sloppy — comparing objects instead of
   * their terms, say — every cost row would carry a `selfRecoveryRate` override identical to the
   * baseline. Harmless numerically, and it would make `buildWorld`'s override guard fire on rows that
   * perturb nothing about the world, which is how a guard gets relaxed and stops guarding.
   */
  for (const id of ['baseline', 'retry-penalty-x2', 'margins-x0.7', 'ev-bar-k2', 'human-review-x1.3']) {
    const p = resolvePerturbation(id);
    assert.equal(
      p.generatorOverrides.selfRecoveryRate,
      undefined,
      `${id}: carries a self-recovery override without perturbing self-recovery`
    );
  }
});

// =============================================================================================
// ONE THING AT A TIME — a cost row must not move a margin, and vice versa
// =============================================================================================

test('each single-price row perturbs exactly the price it names', () => {
  /**
   * The whole value of an attributable row is that a flip can be blamed on one number. A row that
   * moved two prices would still print a verdict, and the verdict would be uninterpretable.
   */
  const cases = [
    ['retry-penalty-x0', 'failedRetryPenaltyPaise', 0],
    ['retry-penalty-x0.7', 'failedRetryPenaltyPaise', 0.7],
    ['retry-penalty-x1.3', 'failedRetryPenaltyPaise', 1.3],
    ['retry-penalty-x2', 'failedRetryPenaltyPaise', 2],
    ['patience-x0.7', 'patienceUnitPaise', 0.7],
    ['patience-x1.3', 'patienceUnitPaise', 1.3],
    ['human-review-x0.7', 'humanReviewPaise', 0.7],
    ['human-review-x1.3', 'humanReviewPaise', 1.3],
  ];

  for (const [id, key, k] of cases) {
    const c = resolvePerturbation(id).COSTS;
    assert.ok(key in COSTS, `test is stale: COSTS has no key "${key}"`);
    assert.equal(c[key], Math.round(COSTS[key] * k), `${id}: ${key} was not scaled by ${k}`);

    const moved = Object.keys(COSTS).filter((k2) => JSON.stringify(c[k2]) !== JSON.stringify(COSTS[k2]));
    assert.deepEqual(moved, k === 1 ? [] : [key], `${id}: moved ${moved.join(', ')} instead of just ${key}`);

    // And the margins are untouched, by reference.
    assert.equal(resolvePerturbation(id).CONTRIBUTION_MARGIN, CONTRIBUTION_MARGIN);
  }
});

test('the channel rows move only the channel table, and pre-register their own null', () => {
  /**
   * Channel prices are 1-4 paise against amounts in the thousands of rupees, so they cannot move an
   * argmax and the catalogue says so up front via `expectNoMovement`. That flag is what stops the
   * sweep flagging a confirmed prediction as a suspected wiring bug — and it is only honest because
   * it was written before the run, so the test pins it to these two rows and no others.
   */
  for (const [id, k] of [['channels-x0.7', 0.7], ['channels-x1.3', 1.3]]) {
    const p = resolvePerturbation(id);
    assert.equal(p.expectNoMovement, true, `${id} must pre-register its null`);
    for (const [ch, v] of Object.entries(COSTS.channel)) {
      assert.equal(p.COSTS.channel[ch], Math.round(v * k), `${id}: channel ${ch} not scaled`);
    }
    const moved = Object.keys(COSTS).filter(
      (key) => JSON.stringify(p.COSTS[key]) !== JSON.stringify(COSTS[key])
    );
    assert.deepEqual(moved, ['channel'], `${id}: moved ${moved.join(', ')}`);
  }

  const preRegistered = describePerturbations().filter((d) => d.expectNoMovement).map((d) => d.id);
  assert.deepEqual(
    preRegistered.sort(),
    ['channels-x0.7', 'channels-x1.3'],
    'only the channel rows may pre-register a null; anything else must be read as a wiring bug first'
  );
});

test('the EV-bar rows move the policy knob and nothing priced', () => {
  for (const [id, k] of [['ev-bar-k0', 0], ['ev-bar-k2', 2]]) {
    const p = resolvePerturbation(id);
    assert.equal(p.POLICY.evBarSigmaK, k);
    assert.equal(p.COSTS, COSTS, `${id}: must not touch the cost table`);
    assert.equal(p.CONTRIBUTION_MARGIN, CONTRIBUTION_MARGIN);
    assert.deepEqual(p.generatorOverrides, {}, `${id}: a policy knob must not perturb the world`);
    for (const key of Object.keys(POLICY)) {
      if (key === 'evBarSigmaK') continue;
      assert.deepEqual(p.POLICY[key], POLICY[key], `${id}: POLICY.${key} moved`);
    }
  }
});

// =============================================================================================
// THE CAUSE MIX — the row the conclusion turned out to rest on
// =============================================================================================

test('a cause tilt raises its own cause, keeps every row a distribution, and reaches the generator', () => {
  /**
   * `cause-mix-do-not-honour-x3` is the one row in the published sweep where the primary verdict
   * flips, which makes it the assumption the whole conclusion rests on — so its wiring is the wiring
   * most worth being sure about. A tilt that silently failed to normalise would be a world where
   * causes do not sum to 1, and the diagnosis layer's accuracy figures would be measured against it.
   */
  for (const [id, cause] of [
    ['cause-mix-do-not-honour-x3', 'DO_NOT_HONOUR'],
    ['cause-mix-insufficient-funds-x3', 'INSUFFICIENT_FUNDS'],
  ]) {
    const table = resolvePerturbation(id).generatorOverrides.causeGivenPayer;
    assert.ok(table, `${id}: the tilt never reached the generator`);

    let sawRise = false;
    for (const [payerType, byLoss] of Object.entries(table)) {
      for (const [lossType, dist] of Object.entries(byLoss)) {
        const total = Object.values(dist).reduce((a, b) => a + b, 0);
        assert.ok(Math.abs(total - 1) < 1e-9, `${id}: ${payerType}/${lossType} sums to ${total}`);
        const base = CAUSE_GIVEN_PAYER[payerType][lossType];
        if (cause in base) {
          assert.ok(dist[cause] > base[cause], `${id}: ${payerType}/${lossType} did not rise`);
          sawRise = true;
        } else {
          assert.deepEqual(dist, base, `${id}: an untouched row was numerically disturbed`);
        }
      }
    }
    assert.ok(sawRise, `${id}: tilted a cause that appears nowhere`);
  }
});

// =============================================================================================
// REPRODUCIBILITY, AND THE ONE PAIR THAT ISOLATES REFIT
// =============================================================================================

test('the joint draws come from a fixed seed string, so two invocations agree', () => {
  /**
   * A sweep whose worlds differ between invocations is not reproducible, and irreproducible
   * sensitivity figures are worse than none: a reader who re-runs and gets different numbers cannot
   * tell whether the difference is the perturbation or the machine. `Math.random()` here would have
   * been invisible in every single run and fatal to every claim made from one.
   */
  for (const id of ['joint-1', 'joint-2', 'joint-3']) {
    assert.deepEqual(
      resolvePerturbation(id).assumptions,
      resolvePerturbation(id).assumptions,
      `${id}: not reproducible across two resolutions`
    );
  }

  // And the three draws must actually be three different worlds.
  const a = resolvePerturbation('joint-1').assumptions;
  const b = resolvePerturbation('joint-2').assumptions;
  const c = resolvePerturbation('joint-3').assumptions;
  assert.notDeepEqual(a, b, 'joint-1 and joint-2 drew the same world');
  assert.notDeepEqual(b, c, 'joint-2 and joint-3 drew the same world');
  for (const j of [a, b, c]) assert.notDeepEqual(j, BASE, 'a joint draw reproduced the baseline');
});

test('stale-model is joint-1 with exactly one variable changed', () => {
  /**
   * The pair is the only way `stale-model` can be read at all. It measures robustness to a
   * MISCALIBRATED model rather than sensitivity to an assumption's value, and those two questions are
   * only separable if the world is held identical while the refit flag moves. Sharing joint-1's rng
   * seed is what makes that true, and this test is what keeps the two seeds from drifting apart in a
   * later edit — after which the pair would silently become two unrelated rows.
   */
  const joint = resolvePerturbation('joint-1');
  const stale = resolvePerturbation('stale-model');

  assert.deepEqual(stale.assumptions, joint.assumptions, 'the pair is no longer the same world');
  assert.deepEqual(stale.generatorOverrides, joint.generatorOverrides);
  assert.equal(joint.refit, true);
  assert.equal(stale.refit, false, 'stale-model must be the only non-refitted row');

  const nonRefit = describePerturbations().filter((d) => !d.refit).map((d) => d.id);
  assert.deepEqual(nonRefit, ['stale-model'], 'a second non-refitted row needs its own labelled pair');
});

test('joint draws stay inside the ranges the assumptions declare', () => {
  /**
   * `perturbAssumptions` is supposed to draw each assumption from its own declared `sweep` range, so
   * a joint row is a plausible alternative world rather than an arbitrarily edited constant. If a draw
   * escaped its range, the row would still print a verdict and the verdict would be about a world the
   * project never claimed was possible — the sweep's most quotable rows resting on its least
   * defensible worlds.
   */
  for (const id of ['joint-1', 'joint-2', 'joint-3']) {
    const a = resolvePerturbation(id).assumptions;
    assert.ok(a.approvalGrantRate >= 0 && a.approvalGrantRate <= 1, `${id}: grant rate ${a.approvalGrantRate}`);
    for (const [lt, v] of Object.entries(a.selfRecoveryRate)) {
      assert.ok(v >= 0 && v <= 1, `${id}: selfRecoveryRate.${lt} = ${v} is not a probability`);
    }
    for (const [k, v] of Object.entries(a)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${id}: ${k} is ${v}`);
    }
  }
});
