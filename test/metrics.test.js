/**
 * TESTS FOR THE METRICS LAYER
 * ===========================
 *
 * A metrics module is the last place a bug gets caught and the first place one gets believed, so
 * these tests are built around a single question: would this test still pass if the thing it checks
 * were broken?
 *
 * Two consequences for how they are written.
 *
 * FIRST, the reconciliation and invariant tests are checked in BOTH directions. Asserting
 * `moneyReconciles === true` on a healthy run is nearly worthless on its own — it would also pass if
 * `moneyReconciles` were hard-coded to `true`, or if both sides of the comparison read the same
 * field. So every such test has a partner that deliberately corrupts one side and asserts the flag
 * goes false. The negative test is the one doing the work.
 *
 * SECOND, several of these use a REAL `createMemoryStore` with hand-built records rather than a test
 * double. A double that returns whatever the assertion needs would let a field-name error through —
 * and a field-name error is exactly the defect that hit this module during development, when
 * `c.lossType` (which does not exist on a case record) silently priced every case at full margin.
 * Hand-built records in the real store make field names load-bearing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreArm,
  compareWithinWorld,
  poolAcrossWorlds,
  ratio,
  rate,
  RATIO_DENOMINATOR_FLOOR_PAISE,
  auditContactWindows,
} from '../src/eval/metrics.js';
import { createMemoryStore } from '../src/db/store.js';
import { CaseState, AuditType, ExecState } from '../src/agent/orchestrator.js';
import { ReceiptState } from '../src/razorpay/gateway.js';
import { ActionKind, Channel } from '../src/core/actions.js';
import { Outcome } from '../src/agent/decide.js';
import { COSTS, CONTRIBUTION_MARGIN, POLICY_ARMS } from '../src/core/config.js';

const RUN = 'run_test_1';
const AT = new Date('2026-03-05T09:00:00Z');

/**
 * A case record shaped exactly as `caseRecordsFor` builds it — note `event` nested, carrying
 * `lossType`. If this fixture drifted to a flat `lossType` the margin tests would pass while
 * production code failed, so the shape here is deliberately the production shape.
 */
const caseRec = ({
  eventId,
  amountPaise = 100_000,
  lossType = 'FAILED_PAYMENT',
  state = CaseState.OPEN,
  recoveredPaise,
  selfRecoveredPaise,
  touchesUsed = 0,
  retriesUsed = 0,
}) => {
  const rec = {
    runId: RUN,
    eventId,
    customerId: `cust_${eventId}`,
    amountPaise,
    state,
    retriesUsed,
    touchesUsed,
    openedAt: AT,
    event: { eventId, lossType, amountPaise },
  };
  if (recoveredPaise !== undefined) rec.recoveredPaise = recoveredPaise;
  if (selfRecoveredPaise !== undefined) rec.selfRecoveredPaise = selfRecoveredPaise;
  return rec;
};

/** Build a store with the given cases, plus optional actions/decisions/audit. */
async function storeWith({ cases = [], actions = [], decisions = [], audit = [] } = {}) {
  const store = createMemoryStore();
  await store.putRun({ runId: RUN, startedAt: AT, arm: 'TEST', seed: 1, split: 'TRAIN' });
  if (cases.length) await store.putCases(cases);
  for (const a of actions) {
    await store.putAction({ runId: RUN, state: ExecState.SETTLED, decisionSeq: 0, startedAt: AT, ...a });
    if (a.receipt) {
      await store.patchAction(a.idempotencyKey, {
        state: a.state ?? ExecState.SETTLED,
        settledAt: AT,
        receipt: a.receipt,
      });
    }
  }
  for (const d of decisions) await store.putDecision({ runId: RUN, ...d });
  for (const e of audit) await store.appendAudit({ runId: RUN, at: AT, ...e });
  return store;
}

/** A `runArm`-shaped result. `recoveredPaise` here is the RUNNING sum, the independent second path. */
const resultFor = (store, over = {}) => ({
  arm: 'REBOUND_EV',
  store,
  runId: RUN,
  gateway: null,
  cycles: [],
  recoveredPaise: 0,
  selfRecoveredPaise: 0,
  selfRecoveredCount: 0,
  attempts: 0,
  stoppedEarlyAfter: null,
  endedAt: AT,
  ...over,
});

const world = (over = {}) => ({ seed: 1, split: 'TRAIN', ...over });

// =================================================================================================
describe('ratio() refuses to divide by almost nothing', () => {
  test('returns the value when the denominator clears the floor', () => {
    const r = ratio(2_000_000, 1_000_000);
    assert.equal(r.value, 2);
    assert.equal(r.reason, null);
  });

  test('returns null with a reason below the floor', () => {
    const below = RATIO_DENOMINATOR_FLOOR_PAISE - 1;
    const r = ratio(1_000_000, below);
    assert.equal(r.value, null, 'a ratio against a sub-floor denominator must not be returned');
    assert.match(r.reason, /below the .* floor/);
  });

  test('the floor is exactly inclusive at its own value', () => {
    assert.equal(ratio(1, RATIO_DENOMINATOR_FLOOR_PAISE).value, 1 / RATIO_DENOMINATOR_FLOOR_PAISE);
    assert.equal(ratio(1, RATIO_DENOMINATOR_FLOOR_PAISE - 1).value, null);
  });

  test('zero and negative denominators return null, never Infinity', () => {
    assert.equal(ratio(500, 0).value, null);
    assert.equal(ratio(500, -100).value, null);
    /** The whole point: a number, once returned, gets printed and then quoted. */
    assert.notEqual(ratio(500, 0).value, Infinity);
  });

  test('non-finite inputs return null', () => {
    assert.equal(ratio(NaN, 1_000_000).value, null);
    assert.equal(ratio(1, Infinity).value, null);
  });

  test('the floor is overridable, so a caller can justify a different one explicitly', () => {
    assert.equal(ratio(10, 100, { floor: 50 }).value, 0.1);
  });
});

describe('rate() cannot be quoted without its denominator', () => {
  test('carries hits and n alongside the value', () => {
    const r = rate(3, 12);
    assert.deepEqual(r, { hits: 3, n: 12, value: 0.25 });
  });

  test('an empty denominator gives a null value, not a divide-by-zero', () => {
    assert.deepEqual(rate(0, 0), { hits: 0, n: 0, value: null });
  });
});

// =================================================================================================
describe('money is counted twice from independent sources (RULE 1)', () => {
  test('reconciles when the case records agree with the running sum', async () => {
    const store = await storeWith({
      cases: [
        caseRec({ eventId: 'e1', state: CaseState.RECOVERED, recoveredPaise: 60_000 }),
        caseRec({ eventId: 'e2', state: CaseState.STOPPED }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store, { recoveredPaise: 60_000 }), world: world() });
    assert.equal(s.moneyReconciles, true);
    assert.equal(s.recoveredFromCases, 60_000);
  });

  /**
   * THE TEST THAT DOES THE WORK. If `moneyReconciles` were hard-coded true, or if both sides read the
   * same field, the positive test above would still pass and this one would fail.
   */
  test('FAILS to reconcile when the running sum disagrees with the case records', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', state: CaseState.RECOVERED, recoveredPaise: 60_000 })],
    });
    const s = await scoreArm({
      result: resultFor(store, { recoveredPaise: 99_999 }),
      world: world(),
    });
    assert.equal(s.moneyReconciles, false, 'money credited with no receipt behind it must be visible');
    assert.equal(s.recoveredFromCases, 60_000);
    assert.equal(s.recoveredPaise, 99_999, 'the reported figure stays the run figure; only the flag moves');
  });

  test('self-recovered money reconciles independently of agent-recovered money', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', state: CaseState.RECOVERED_SELF, selfRecoveredPaise: 40_000 })],
    });
    const ok = await scoreArm({ result: resultFor(store, { selfRecoveredPaise: 40_000 }), world: world() });
    assert.equal(ok.selfMoneyReconciles, true);

    const bad = await scoreArm({ result: resultFor(store, { selfRecoveredPaise: 1 }), world: world() });
    assert.equal(bad.selfMoneyReconciles, false);
  });

  test('exposure is cross-checked against the figure the generator computed', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', amountPaise: 30_000 }), caseRec({ eventId: 'e2', amountPaise: 70_000 })],
    });
    const ok = await scoreArm({ result: resultFor(store), world: world({ totalExposurePaise: 100_000 }) });
    assert.equal(ok.exposurePaise, 100_000);
    assert.equal(ok.exposureReconciles, true);

    const bad = await scoreArm({ result: resultFor(store), world: world({ totalExposurePaise: 12 }) });
    assert.equal(bad.exposureReconciles, false, 'the run must report on the batch it was given');
  });
});

// =================================================================================================
describe('recovered and self-recovered money are never merged (RULE 3)', () => {
  test('a self-recovered case contributes nothing to recoveredPaise', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', state: CaseState.RECOVERED_SELF, selfRecoveredPaise: 90_000 })],
    });
    const s = await scoreArm({
      result: resultFor(store, { recoveredPaise: 0, selfRecoveredPaise: 90_000 }),
      world: world(),
    });
    assert.equal(s.recoveredPaise, 0, 'money that arrived unprompted is not the agent’s');
    assert.equal(s.selfRecoveredPaise, 90_000);
  });

  test('attributedPaise is the explicitly-labelled gross sum, and only that', async () => {
    const store = await storeWith({ cases: [caseRec({ eventId: 'e1' })] });
    const s = await scoreArm({
      result: resultFor(store, { recoveredPaise: 0, selfRecoveredPaise: 0 }),
      world: world(),
    });
    /** The field exists so nobody has to add the two by hand and get it wrong in the other direction. */
    assert.equal(s.attributedPaise, s.recoveredPaise + s.selfRecoveredPaise);
  });
});

// =================================================================================================
describe('margin weighting reads the loss type off the nested event', () => {
  /**
   * The regression test for a real defect in this module. `c.lossType` does not exist on a case
   * record; the loss type lives on `c.event.lossType`. With a `?? 1.0` fallback, every case was
   * priced at full margin and `contributionPaise` came out exactly equal to `recoveredPaise` — a
   * plausible-looking number that made the whole margin argument circular.
   */
  test('applies the per-loss-type margin, hand-computed', async () => {
    const store = await storeWith({
      cases: [
        // FAILED_PAYMENT margin 0.35 on 100000 recovered = 35000
        caseRec({ eventId: 'e1', lossType: 'FAILED_PAYMENT', state: CaseState.RECOVERED, recoveredPaise: 100_000 }),
        // FAILED_SUBSCRIPTION margin 0.75 on 200000 recovered = 150000
        caseRec({ eventId: 'e2', lossType: 'FAILED_SUBSCRIPTION', state: CaseState.RECOVERED, recoveredPaise: 200_000 }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store, { recoveredPaise: 300_000 }), world: world() });

    assert.equal(CONTRIBUTION_MARGIN.FAILED_PAYMENT, 0.35, 'fixture assumes this margin');
    assert.equal(CONTRIBUTION_MARGIN.FAILED_SUBSCRIPTION, 0.75, 'fixture assumes this margin');
    assert.equal(s.contributionPaise, 35_000 + 150_000);
    assert.notEqual(
      s.contributionPaise,
      s.recoveredPaise,
      'if contribution equals gross, the margin lookup silently defaulted to 1.0'
    );
  });

  test('margin-weights SELF-recovered money too, at each case own margin', async () => {
    /**
     * `contributionSelfPaise` exists so `compareWithinWorld` can net out the no-agent counterfactual
     * on the contribution basis. If it were left as raw cash while the arm side was margin-weighted,
     * the subtraction would mix units and every `netIncrementalPaise` would be wrong — and wrong in a
     * direction that depends on the world's loss mix, so it would not look obviously broken.
     *
     * Hand-computed: FAILED_PAYMENT 0.35 x 100000 = 35000, OVERDUE_INVOICE 1.0 x 200000 = 200000.
     * The two margins differ, so an unweighted sum (3,00,000) cannot coincide with the right answer.
     */
    const store = await storeWith({
      cases: [
        caseRec({ eventId: 'e1', lossType: 'FAILED_PAYMENT', state: CaseState.RECOVERED_SELF, selfRecoveredPaise: 100_000 }),
        caseRec({ eventId: 'e2', lossType: 'OVERDUE_INVOICE', state: CaseState.RECOVERED_SELF, selfRecoveredPaise: 200_000 }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store, { selfRecoveredPaise: 300_000 }), world: world() });

    assert.equal(CONTRIBUTION_MARGIN.FAILED_PAYMENT, 0.35, 'fixture assumes this margin');
    assert.equal(CONTRIBUTION_MARGIN.OVERDUE_INVOICE, 1, 'fixture assumes this margin');
    assert.equal(s.contributionSelfPaise, 35_000 + 200_000);
    assert.notEqual(
      s.contributionSelfPaise,
      s.selfRecoveredPaise,
      'if self contribution equals self cash, the margin weighting was skipped'
    );
  });

  test('THROWS on an unknown loss type rather than defaulting to full margin', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', lossType: 'NOT_A_REAL_LOSS_TYPE', state: CaseState.RECOVERED, recoveredPaise: 100 })],
    });
    await assert.rejects(
      () => scoreArm({ result: resultFor(store, { recoveredPaise: 100 }), world: world() }),
      /no contribution margin/,
      'a metric that cannot be computed must fail loudly, not quietly produce a wrong number'
    );
  });

  test('a case with a flat lossType and no event still throws — the wrong shape is not tolerated', async () => {
    const store = createMemoryStore();
    await store.putRun({ runId: RUN, startedAt: AT, arm: 'T', seed: 1, split: 'TRAIN' });
    await store.putCases([
      { runId: RUN, eventId: 'e1', amountPaise: 100, state: CaseState.RECOVERED, recoveredPaise: 100, lossType: 'FAILED_PAYMENT' },
    ]);
    await assert.rejects(() => scoreArm({ result: resultFor(store, { recoveredPaise: 100 }), world: world() }));
  });
});

// =================================================================================================
describe('executed actions are read from the persisted records', () => {
  const act = (over) => ({
    eventId: over.eventId ?? 'e1',
    customerId: 'c1',
    idempotencyKey: over.idempotencyKey,
    kind: over.kind,
    channel: over.channel ?? null,
    amountPaise: 100_000,
    ...over,
  });

  test('kind and channel are read from the top level of the action record', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      actions: [
        act({ idempotencyKey: 'k1', kind: ActionKind.RETRY_NOW }),
        act({ idempotencyKey: 'k2', kind: ActionKind.SEND_LINK, channel: Channel.SMS }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    /** If these read `a.action.kind` every count would be zero and this test would catch it. */
    assert.equal(s.actions.byKind[ActionKind.RETRY_NOW], 1);
    assert.equal(s.actions.byKind[ActionKind.SEND_LINK], 1);
    assert.equal(s.actions.byChannel[Channel.SMS], 1);
    assert.equal(s.actions.retries, 1);
    assert.equal(s.actions.messages, 1);
    assert.equal(s.actions.total, 2);
  });

  /**
   * The other real defect caught during development. An UNKNOWN receipt also collected nothing, but
   * UNKNOWN means the gateway timed out — charging the failed-retry penalty there fines the arm for a
   * network fault, and the reconciler later resolves UNKNOWN into CAPTURED or FAILED, so the same
   * attempt would be penalised twice.
   */
  test('failedRetries counts FAILED receipts and NOT UNKNOWN ones', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      actions: [
        act({ idempotencyKey: 'k1', kind: ActionKind.RETRY_NOW, receipt: { state: ReceiptState.FAILED, amountCollectedPaise: 0 } }),
        act({ idempotencyKey: 'k2', kind: ActionKind.RETRY_NOW, receipt: { state: ReceiptState.UNKNOWN, amountCollectedPaise: 0 } }),
        act({ idempotencyKey: 'k3', kind: ActionKind.RETRY_NOW, receipt: { state: ReceiptState.CAPTURED, amountCollectedPaise: 100_000 } }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.actions.failedRetries, 1, 'only the FAILED receipt is a declined retry');
    assert.equal(s.actions.unknownRetries, 1, 'the UNKNOWN one is reported separately, not merged');
    assert.equal(s.actions.byReceiptState[ReceiptState.CAPTURED], 1);
    assert.equal(s.actions.capturedPaise, 100_000);
  });

  test('a message that was SENT is not a failed retry', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      actions: [
        act({ idempotencyKey: 'k1', kind: ActionKind.SEND_LINK, channel: Channel.EMAIL, receipt: { state: ReceiptState.SENT, amountCollectedPaise: 0 } }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.actions.failedRetries, 0);
    assert.equal(s.actions.messages, 1);
  });
});

// =================================================================================================
describe('costs are priced with the same numbers the EV policy decides with (RULE 5)', () => {
  test('message, failed-retry, patience and review costs, all hand-computed', async () => {
    const store = await storeWith({
      cases: [
        // touchesUsed 2 -> one case charged patience
        caseRec({ eventId: 'e1', state: CaseState.STOPPED, touchesUsed: 2 }),
        caseRec({ eventId: 'e2', state: CaseState.ESCALATED, touchesUsed: 1 }),
      ],
      actions: [
        { eventId: 'e1', idempotencyKey: 'k1', kind: ActionKind.SEND_LINK, channel: Channel.SMS, amountPaise: 0, receipt: { state: ReceiptState.SENT, amountCollectedPaise: 0 } },
        { eventId: 'e1', idempotencyKey: 'k2', kind: ActionKind.SEND_LINK, channel: Channel.EMAIL, amountPaise: 0, receipt: { state: ReceiptState.SENT, amountCollectedPaise: 0 } },
        { eventId: 'e1', idempotencyKey: 'k3', kind: ActionKind.RETRY_NOW, amountPaise: 100, receipt: { state: ReceiptState.FAILED, amountCollectedPaise: 0 } },
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });

    assert.equal(s.costs.messageCostPaise, COSTS.channel.SMS + COSTS.channel.EMAIL);
    assert.equal(s.costs.failedRetryCostPaise, 1 * COSTS.failedRetryPenaltyPaise);
    assert.equal(s.costs.patienceCostPaise, 1 * COSTS.patienceUnitPaise, 'one case has touchesUsed > 1');
    assert.equal(s.costs.humanReviewCostPaise, 1 * COSTS.humanReviewPaise, 'one ESCALATED case');
    assert.equal(
      s.costs.totalCostPaise,
      s.costs.messageCostPaise + s.costs.failedRetryCostPaise + s.costs.patienceCostPaise + s.costs.humanReviewCostPaise
    );
  });

  test('netPaise subtracts total cost from margin-weighted contribution, not from gross', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', lossType: 'FAILED_PAYMENT', state: CaseState.RECOVERED, recoveredPaise: 100_000 })],
      actions: [
        { eventId: 'e1', idempotencyKey: 'k1', kind: ActionKind.SEND_LINK, channel: Channel.SMS, amountPaise: 0, receipt: { state: ReceiptState.SENT, amountCollectedPaise: 0 } },
      ],
    });
    const s = await scoreArm({ result: resultFor(store, { recoveredPaise: 100_000 }), world: world() });
    assert.equal(s.contributionPaise, 35_000);
    assert.equal(s.netPaise, 35_000 - s.costs.totalCostPaise);
    assert.notEqual(s.netPaise, 100_000 - s.costs.totalCostPaise, 'net must not be built on gross');
  });

  /**
   * An arm can win on recovered rupees and lose on net. That is a result, and it is invisible to a
   * metrics layer that only counts receipts — which is why RULE 5 exists.
   */
  test('an arm that spends more than it collects reports a negative net', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', state: CaseState.STOPPED, touchesUsed: 3 })],
      actions: [
        { eventId: 'e1', idempotencyKey: 'k1', kind: ActionKind.RETRY_NOW, amountPaise: 100, receipt: { state: ReceiptState.FAILED, amountCollectedPaise: 0 } },
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.recoveredPaise, 0);
    assert.ok(s.netPaise < 0, 'effort with no recovery must show as value destroyed');
  });
});

// =================================================================================================
describe('compliance is read from the trail, never self-reported (RULE 2)', () => {
  const decision = ({ seq, outcome, candidates }) => ({
    eventId: 'e1',
    decisionSeq: seq,
    outcome,
    candidates,
  });

  const cand = ({ chosen = false, violations = [], kind = ActionKind.SEND_LINK }) => ({
    rank: 1,
    signature: `${kind}:x`,
    kind,
    channel: Channel.SMS,
    chosen,
    violations,
  });

  const QUIET = { id: 'TIM_QUIET_HOURS', kind: 'TIMING', message: 'quiet hours' };
  const CAP = { id: 'TIM_CUSTOMER_MESSAGE_CAP', kind: 'TIMING', message: 'cap' };
  const TOUCH = { id: 'BUD_TOUCHES_PER_CASE', kind: 'BUDGET', message: 'touches' };

  test('a violation on the CHOSEN candidate of an ACT decision is a breach', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [decision({ seq: 1, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [QUIET] })] })],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.breachingDecisions, 1);
    assert.equal(s.violations.quietHoursMessages, 1);
    assert.equal(s.violations.byRuleId.TIM_QUIET_HOURS, 1);
    assert.equal(s.violations.byKind.TIMING, 1);
  });

  test('a violation on a candidate that was NOT chosen is a refusal, not a breach', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [
        decision({
          seq: 1,
          outcome: Outcome.ACT,
          candidates: [cand({ chosen: false, violations: [QUIET] }), cand({ chosen: true, violations: [] })],
        }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.breachingDecisions, 0, 'considering a forbidden option is not a breach');
    assert.equal(s.refusals.refusedCandidates, 1, 'it is evidence the guardrail bound');
    assert.equal(s.refusals.byRuleId.TIM_QUIET_HOURS, 1);
  });

  /**
   * ADDED AFTER A SURVIVING MUTATION. Deleting the `if (c.chosen) continue` guard in `countRefusals`
   * broke no test, and it should have: without it, an action the arm took ANYWAY is counted both as a
   * breach and as a guardrail refusal.
   *
   * The direction of that error is what makes it worth a test of its own. `guardrailRefusals` is a
   * headline — it is the evidence that compliance is enforced rather than asserted — and B2 is the arm
   * with by far the most violations. Leaking breaches into the refusal count would inflate the
   * rule-BREAKING arm's apparent constraint the most, making the policy that ignores four rules look
   * like the one most often stopped by them.
   */
  test('a breach is counted once, as a breach, and never also as a refusal', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [decision({ seq: 1, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [QUIET, CAP] })] })],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.breachingDecisions, 1);
    assert.equal(
      s.refusals.refusedCandidates,
      0,
      'an action the arm went ahead with was not refused; counting it as one would credit B2 for restraint it did not show'
    );
    assert.equal(s.refusals.byRuleId.TIM_QUIET_HOURS, undefined);
  });

  test('a decision can contain both a breach and a genuine refusal, counted separately', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [
        decision({
          seq: 1,
          outcome: Outcome.ACT,
          candidates: [
            cand({ chosen: true, violations: [QUIET] }), // taken anyway -> breach
            cand({ chosen: false, violations: [CAP] }), // declined -> refusal
          ],
        }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.breachingDecisions, 1);
    assert.equal(s.violations.byRuleId.TIM_QUIET_HOURS, 1);
    assert.equal(s.violations.byRuleId.TIM_CUSTOMER_MESSAGE_CAP, undefined, 'the declined one is not a breach');
    assert.equal(s.refusals.refusedCandidates, 1);
    assert.equal(s.refusals.byRuleId.TIM_CUSTOMER_MESSAGE_CAP, 1);
    assert.equal(s.refusals.byRuleId.TIM_QUIET_HOURS, undefined, 'the taken one is not a refusal');
  });

  test('a forbidden candidate in a decision that did NOT act is not a breach', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [decision({ seq: 1, outcome: Outcome.STOP_PERMANENT, candidates: [cand({ chosen: true, violations: [QUIET] })] })],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.actingDecisions, 0);
    assert.equal(s.violations.breachingDecisions, 0, 'an arm that declined to act breached nothing');
  });

  test('breaches are attributed per rule and per kind, across several decisions', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [
        decision({ seq: 1, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [QUIET, CAP] })] }),
        decision({ seq: 2, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [TOUCH] })] }),
        decision({ seq: 3, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [] })] }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.actingDecisions, 3);
    assert.equal(s.violations.breachingDecisions, 2, 'the clean decision is not counted');
    assert.equal(s.violations.byKind.TIMING, 2);
    assert.equal(s.violations.byKind.BUDGET, 1);
    assert.equal(s.violations.absoluteBreaches, 0);
    assert.equal(s.violations.contactCapBreaches, 1);
  });

  test('an ABSOLUTE breach is surfaced on its own field', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [
        decision({
          seq: 1,
          outcome: Outcome.ACT,
          candidates: [cand({ chosen: true, violations: [{ id: 'ABS_DO_NOT_DISTURB', kind: 'ABSOLUTE', message: 'dnd' }] })],
        }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.absoluteBreaches, 1, 'no arm, not even B2, may breach an absolute rule');
  });

  test('a compliant run reports zero breaches — and the counter is not simply always zero', async () => {
    const clean = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [decision({ seq: 1, outcome: Outcome.ACT, candidates: [cand({ chosen: true, violations: [] })] })],
    });
    const s = await scoreArm({ result: resultFor(clean), world: world() });
    assert.equal(s.violations.breachingDecisions, 0);
    assert.equal(s.violations.quietHoursMessages, 0);
    /** Paired with the positive cases above, which is what makes this zero meaningful. */
  });

  test('deferral refusals are counted from their own audit type, not from violations', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      audit: [
        { eventId: 'e1', type: AuditType.DEFERRAL_REFUSED, detail: {} },
        { eventId: 'e1', type: AuditType.DEFERRAL_REFUSED, detail: {} },
        { eventId: 'e1', type: AuditType.CASE_DECIDED, detail: {} },
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.refusals.deferralsRefused, 2);
    assert.equal(s.violations.byKind.TIMING, 0, 'a policy limit is not a compliance breach');
  });

  /**
   * Withheld deferral candidates carry `eligible: false` and no verdict. They must not inflate the
   * compliance metric — that is the whole reason `applyDeferralLimits` does not use `Verdict.FORBID`.
   */
  test('a withheld candidate with no violations is neither a breach nor a refusal', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1' })],
      decisions: [
        decision({
          seq: 1,
          outcome: Outcome.ACT,
          candidates: [
            cand({ chosen: true, violations: [] }),
            { rank: null, signature: 'POSTPONE:x', kind: 'POSTPONE', eligible: false, violations: [] },
          ],
        }),
      ],
    });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    assert.equal(s.violations.breachingDecisions, 0);
    assert.equal(s.refusals.refusedCandidates, 0);
  });
});

// =================================================================================================
describe('the metrics layer never ranks or sums EV across arms', () => {
  test('no EV field appears anywhere in a scored arm', async () => {
    const store = await storeWith({ cases: [caseRec({ eventId: 'e1' })] });
    const s = await scoreArm({ result: resultFor(store), world: world() });
    const keys = Object.keys(s);
    for (const k of keys) {
      assert.ok(
        !/^ev|EvPaise$|evPaise/.test(k),
        `scored arm exposes ${k}; baselines emit null EV by design, so any cross-arm EV figure is meaningless`
      );
    }
  });

  test('a scored arm reports paisePerAttempt, which is money and not EV', async () => {
    const store = await storeWith({
      cases: [caseRec({ eventId: 'e1', state: CaseState.RECOVERED, recoveredPaise: 100_000 })],
    });
    const s = await scoreArm({ result: resultFor(store, { recoveredPaise: 100_000, attempts: 4 }), world: world() });
    assert.equal(s.paisePerAttempt, 25_000);
  });

  test('paisePerAttempt is null rather than a divide-by-zero when nothing was attempted', async () => {
    const store = await storeWith({ cases: [caseRec({ eventId: 'e1' })] });
    const s = await scoreArm({ result: resultFor(store, { attempts: 0 }), world: world() });
    assert.equal(s.paisePerAttempt, null);
  });
});

// =================================================================================================
describe('the self-recovery counterfactual invariant', () => {
  /**
   * The corrected invariant. My first version asserted `selfRecoveredPaise` was IDENTICAL across
   * arms; the first real run falsified it, because an arm that recovers a case on day 2 legitimately
   * prevents it self-recovering on day 9. What must hold instead is that a customer who was going to
   * pay unprompted pays under every arm by SOME route.
   */
  const scoredArm = ({ arm, recovered = 0, self = 0, selfIds = [], moneyIds = [], cost = 0 }) => ({
    arm,
    n: 2,
    recoveredPaise: recovered,
    selfRecoveredPaise: self,
    netPaise: recovered - cost,
    contributionPaise: recovered,
    /**
     * Full margin on both, so `netIncrementalPaise` reduces to plain cash arithmetic and the
     * expected values below stay hand-checkable. `costs` must be present and shaped like the real
     * thing: `compareWithinWorld` reads `costs.totalCostPaise` to put net on the incremental basis,
     * and a stub missing it threw rather than silently scoring zero — which is the right failure.
     */
    contributionSelfPaise: self,
    costs: { totalCostPaise: cost },
    attempts: 1,
    actions: { messages: 0, retries: 0, failedRetries: 0 },
    violations: { quietHoursMessages: 0, contactCapBreaches: 0, absoluteBreaches: 0 },
    /**
     * The ledger-side cap audit, which `compareWithinWorld` flattens onto the row and the eval's
     * `contactCapAgrees` invariant compares against the engine-side count. Present and clean here so
     * these fixtures exercise the AGREEING case; the disagreement is pinned separately below.
     */
    contactWindows: { breachedCustomers: 0, worstInWindow: 0, worstOverWholeRun: 0, cap: 2, windowDays: 7, breaches: [] },
    /**
     * The approval census, for the same reason `costs` is here and shaped like the real thing:
     * `compareWithinWorld` flattens eight approval fields onto every row, so a stub missing this
     * threw. Following the precedent above, the fixture supplies the field rather than `metrics.js`
     * tolerating its absence — a metrics module that shrugs at a missing approval census is one that
     * would report `frozen: 0` for a run where the reviewer never ran at all.
     *
     * Empty and clean, because these fixtures exercise the MONEY arithmetic. `approverReport: null`
     * is the honest value for a hand-built score: no simulated reviewer produced it, and both
     * `approvalsReconcile` and `approverIsArmBlind` are written to skip a null report rather than
     * invent agreement with one. The approver's own behaviour is measured in `test/approver.test.js`.
     */
    approvals: {
      requested: 0, granted: 0, denied: 0, grantedAudits: 0, deniedAudits: 0, pendingAtEnd: 0,
      frozenPaise: 0, grantedPaise: 0, deniedPaise: 0,
      waitHoursP50: null, waitHoursP90: null, waitHoursMax: null, accountsFor: true,
    },
    approverReport: null,
    refusals: { refusedCandidates: 0, deferralsRefused: 0 },
    stoppedCases: 0,
    unresolvedCases: 0,
    moneyReconciles: true,
    selfMoneyReconciles: true,
    exposureReconciles: true,
    selfRecoveredEventIds: selfIds,
    moneyTerminalEventIds: moneyIds,
    seed: 1,
    split: 'TRAIN',
  });

  // -----------------------------------------------------------------------------------------------
  // `contactCapAgrees` — the guardrail engine's self-report against the ledger reconstruction
  // -----------------------------------------------------------------------------------------------
  const withCap = (row, { engine, ledger }) => ({
    ...row,
    violations: { ...row.violations, contactCapBreaches: engine },
    contactWindows: { ...row.contactWindows, breachedCustomers: ledger },
  });

  test('contactCapAgrees holds when both measurements are clean, and when both are dirty', () => {
    const clean = compareWithinWorld([
      withCap(scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }), { engine: 0, ledger: 0 }),
      withCap(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), { engine: 0, ledger: 0 }),
    ]);
    assert.equal(clean.invariants.contactCapAgrees, true);

    /**
     * Counts, not units: 40 flagged ACTIONS against 12 breached CUSTOMERS is agreement, because one
     * customer absorbs several over-cap actions. Asserting equality of the two numbers would fail on
     * every real B2 run and would have to be deleted, which is worse than not having the check.
     */
    const dirty = compareWithinWorld([
      withCap(scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }), { engine: 0, ledger: 0 }),
      withCap(scoredArm({ arm: POLICY_ARMS.B2_AGGRESSIVE.id }), { engine: 40, ledger: 12 }),
    ]);
    assert.equal(dirty.invariants.contactCapAgrees, true, 'both non-zero is agreement — they count different units');
  });

  // -----------------------------------------------------------------------------------------------
  // `approvalsReconcile` — the reviewer's tally against the audit trail, NOT against the case census
  // -----------------------------------------------------------------------------------------------
  /**
   * Attach a reviewer report and an approval census to a row. `caseGranted` and `auditGranted` are
   * separate parameters on purpose: the whole point of these tests is that they are allowed to differ.
   */
  const withApprovals = (row, { caseGranted, caseDenied, auditGranted, auditDenied, saysGranted, saysDenied, requested }) => ({
    ...row,
    approvals: {
      ...row.approvals,
      requested,
      granted: caseGranted,
      denied: caseDenied,
      grantedAudits: auditGranted,
      deniedAudits: auditDenied,
      accountsFor: caseGranted + caseDenied <= requested,
    },
    approverReport: { granted: saysGranted, denied: saysDenied, resolved: [] },
  });

  test('approvalsReconcile TOLERATES a case that collected several decisions over the run', () => {
    /**
     * THE REGRESSION PIN for a bug the eval caught and this file did not. `approvalsReconcile` first
     * compared the reviewer's tally against `approvals.granted`, the per-case census, and failed in all
     * five worlds. The real numbers: Rebound's reviewer logged 19 grants while only 9 cases ENDED in
     * GRANTED, because 7 cases had their authorisation envelope expire and returned for a fresh
     * signature — one of them four times.
     *
     * Those are different units. The census counts CASES in a final state; the reviewer's log counts
     * DECISIONS. `summariseApprovals` already says this about `accountsFor` being an inequality, and
     * the invariant was wired to the wrong field anyway. So this asserts the divergence is PERMITTED,
     * which is the assertion that would have stopped the bug being written.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }),
      withApprovals(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), {
        requested: 29, caseGranted: 9, caseDenied: 9, auditGranted: 19, auditDenied: 9,
        saysGranted: 19, saysDenied: 9,
      }),
    ]);
    assert.equal(cmp.invariants.approvalsReconcile, true, 'expiry-and-regrant is legitimate, not a mismatch');
    assert.equal(cmp.invariants.approvalsAccountedFor, true);
  });

  test('approvalsReconcile FAILS when the reviewer logged a decision the trail did not record', () => {
    /**
     * The failure that matters, in the direction that matters. A resolution the approver believes it
     * made but which never reached the audit trail means a case stayed frozen while the reviewer's
     * summary said it was answered — so `frozenPaise` understates, and the approval gate reads as
     * cheaper than it is. Nothing in the money columns would look odd.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }),
      withApprovals(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), {
        requested: 29, caseGranted: 9, caseDenied: 9, auditGranted: 18, auditDenied: 9,
        saysGranted: 19, saysDenied: 9,
      }),
    ]);
    assert.equal(cmp.invariants.approvalsReconcile, false);
  });

  test('approvalsReconcile checks denials too, which cannot repeat because they are terminal', () => {
    /**
     * Denials are the clean side of the pairing: `resolveApproval` makes them terminal, so a case can
     * collect at most one, and the census and the audit count must agree exactly. That is why the real
     * run matched 9 to 9 on denials while disagreeing 19 to 9 on grants — a signal that told me the
     * grants side was the wrong comparison rather than the approver being broken.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }),
      withApprovals(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), {
        requested: 29, caseGranted: 9, caseDenied: 9, auditGranted: 19, auditDenied: 8,
        saysGranted: 19, saysDenied: 9,
      }),
    ]);
    assert.equal(cmp.invariants.approvalsReconcile, false);
  });

  test('contactCapAgrees FAILS when the engine is silent and the ledger shows a breach', () => {
    /**
     * The dangerous direction. The engine reporting zero while messages actually went out over the cap
     * means its ledger query is broken, and every "zero cap breaches" figure in this project — one of
     * the two compliance numbers the pitch says out loud — would be worthless. Nothing else in the
     * suite would notice, because the engine is the thing being asked.
     */
    const cmp = compareWithinWorld([
      withCap(scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }), { engine: 0, ledger: 0 }),
      withCap(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), { engine: 0, ledger: 3 }),
    ]);
    assert.equal(cmp.invariants.contactCapAgrees, false);
  });

  test('contactCapAgrees FAILS when the engine is noisy and the ledger is clean', () => {
    /**
     * The other direction, checked too. It biases AGAINST Rebound — an engine refusing sends the rule
     * would permit throttles the compliant arms — so it is not a threat to the headline, and it is
     * still a bug. A one-sided invariant would find only the errors that flatter us.
     */
    const cmp = compareWithinWorld([
      withCap(scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }), { engine: 0, ledger: 0 }),
      withCap(scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id }), { engine: 5, ledger: 0 }),
    ]);
    assert.equal(cmp.invariants.contactCapAgrees, false);
  });

  test('holds when the agent got to the self-recoverer first', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 500_000, selfIds: ['e1'], moneyIds: ['e1'] }),
      // the active arm recovered e1 itself, so it never self-recovered: still money-terminal
      scoredArm({ arm: POLICY_ARMS.B3_FIXED_LADDER.id, recovered: 500_000, selfIds: [], moneyIds: ['e1'] }),
    ]);
    assert.equal(cmp.invariants.selfRecoveryCounterfactualHolds, true);
    assert.deepEqual(cmp.invariants.counterfactualLeaks, []);
  });

  test('FAILS when a case self-recovered under B0 but carries no money under an active arm', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 500_000, selfIds: ['e1'], moneyIds: ['e1'] }),
      scoredArm({ arm: POLICY_ARMS.B3_FIXED_LADDER.id, recovered: 0, selfIds: [], moneyIds: [] }),
    ]);
    assert.equal(
      cmp.invariants.selfRecoveryCounterfactualHolds,
      false,
      'the arms are not seeing the same world; every comparison would be void'
    );
    assert.deepEqual(cmp.invariants.counterfactualLeaks, [
      { arm: POLICY_ARMS.B3_FIXED_LADDER.id, eventId: 'e1' },
    ]);
  });

  test('self-recovery totals are ALLOWED to differ across arms', () => {
    /**
     * The explicit statement of what the old, wrong invariant forbade. Forcing these equal would
     * double-count the same rupees.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 500_000, selfIds: ['e1'], moneyIds: ['e1'] }),
      scoredArm({ arm: POLICY_ARMS.B3_FIXED_LADDER.id, recovered: 500_000, self: 0, selfIds: [], moneyIds: ['e1'] }),
    ]);
    assert.equal(cmp.invariants.selfRecoveryCounterfactualHolds, true);
    const b0 = cmp.rows.find((r) => r.arm === POLICY_ARMS.B0_DO_NOTHING.id);
    const b3 = cmp.rows.find((r) => r.arm === POLICY_ARMS.B3_FIXED_LADDER.id);
    assert.notEqual(b0.selfRecoveredPaise, b3.selfRecoveredPaise);
  });

  test('B0 having agent-side money is caught', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, recovered: 1, moneyIds: [] }),
    ]);
    assert.equal(cmp.invariants.b0RecoveredZero, false);
  });

  test('a broken reconciliation in any arm voids the whole world', () => {
    const bad = scoredArm({ arm: POLICY_ARMS.B3_FIXED_LADDER.id });
    bad.moneyReconciles = false;
    const cmp = compareWithinWorld([scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id }), bad]);
    assert.equal(cmp.invariants.allMoneyReconciles, false);
  });

  // -----------------------------------------------------------------------------------------------
  test('incremental money subtracts the no-agent counterfactual, hand-computed', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 1_437_000, selfIds: ['e1'], moneyIds: ['e1'] }),
      scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 2_134_728, self: 0, selfIds: [], moneyIds: ['e1'] }),
    ]);
    assert.equal(cmp.counterfactualPaise, 1_437_000);
    const rb = cmp.rows.find((r) => r.arm === POLICY_ARMS.REBOUND_EV.id);
    assert.equal(rb.attributedPaise, 2_134_728);
    assert.equal(rb.incrementalPaise, 2_134_728 - 1_437_000);
    assert.ok(
      rb.incrementalPaise < rb.recoveredPaise,
      'gross overstates the agent when it beat the customer to a self-recoverer'
    );
    const b0 = cmp.rows.find((r) => r.arm === POLICY_ARMS.B0_DO_NOTHING.id);
    assert.equal(b0.incrementalPaise, 0, 'doing nothing recovers nothing incrementally, by definition');
  });

  test('incremental equals gross when the agent did not pre-empt any self-recoverer', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 0, selfIds: [], moneyIds: [] }),
      scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 900_000, moneyIds: ['e2'] }),
    ]);
    const rb = cmp.rows.find((r) => r.arm === POLICY_ARMS.REBOUND_EV.id);
    assert.equal(rb.incrementalPaise, 900_000);
  });

  test('net is on the incremental basis, hand-computed, so it cannot exceed incremental money', () => {
    /**
     * THE BUG THIS PINS. `netPaise` is margin-weighted GROSS recovery minus cost; `incrementalPaise`
     * nets out B0. Printed side by side those are two different bases, and when an arm cannibalises
     * self-recovery they diverge in the flattering direction — measured in seed 5 of the real eval,
     * B1 showed gross net Rs 77,454 beside incremental Rs 49,550, because realised self-recovery
     * collapsed from Rs 35,246 to Rs 1,585. A reader scanning two money columns assumes one basis and
     * takes the bigger number as better.
     *
     * Hand-computed here at full margin so the arithmetic is checkable by eye:
     *   B0    self 10,00,000, no cost                  -> counterfactual contribution 10,00,000
     *   arm   agent 8,00,000 + self 2,00,000, cost 5,000
     *         netIncremental = 8,00,000 + 2,00,000 - 10,00,000 - 5,000 = -5,000
     *
     * The arm collected 8 lakh and created nothing, so its net is exactly its own cost, negative.
     * The gross net would have read 8,00,000 - 5,000 = +7,95,000 and looked like a triumph.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 1_000_000, selfIds: ['e1', 'e2'], moneyIds: ['e1', 'e2'] }),
      scoredArm({
        arm: POLICY_ARMS.REBOUND_EV.id,
        recovered: 800_000,
        self: 200_000,
        cost: 5_000,
        selfIds: ['e2'],
        moneyIds: ['e1', 'e2'],
      }),
    ]);
    const rb = cmp.rows.find((r) => r.arm === POLICY_ARMS.REBOUND_EV.id);
    assert.equal(rb.incrementalPaise, 0, 'every rupee it collected was coming anyway');
    assert.equal(rb.netIncrementalPaise, -5_000, 'so its net is exactly the cost it burned');
    assert.equal(rb.netPaise, 795_000, 'the gross-basis figure, kept for reference, reads as a triumph');
    assert.ok(
      rb.netIncrementalPaise <= rb.incrementalPaise,
      'net is incremental money minus costs, so it can never exceed incremental money'
    );
  });

  test('B0 nets to exactly zero on the incremental basis, by construction', () => {
    /**
     * B0 takes no action, so it has no costs and nets against its own counterfactual. Anything other
     * than zero means the counterfactual is not being subtracted on the same basis it was measured.
     */
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B0_DO_NOTHING.id, self: 3_206_140, selfIds: ['e1'], moneyIds: ['e1'] }),
      scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 500_000, self: 3_206_140, cost: 1_000, selfIds: ['e1'], moneyIds: ['e1'] }),
    ]);
    const b0 = cmp.rows.find((r) => r.arm === POLICY_ARMS.B0_DO_NOTHING.id);
    assert.equal(b0.netIncrementalPaise, 0);
  });

  test('net on the incremental basis is NULL without B0, like incremental itself', () => {
    const cmp = compareWithinWorld([scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 900_000, cost: 100 })]);
    assert.equal(
      cmp.rows[0].netIncrementalPaise,
      null,
      'a net that quietly falls back to the gross basis is the whole defect this field exists to close'
    );
  });

  test('incremental is NULL when B0 is absent, rather than silently equal to gross', () => {    const cmp = compareWithinWorld([scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 900_000 })]);
    assert.equal(cmp.counterfactualPaise, null);
    assert.equal(
      cmp.rows[0].incrementalPaise,
      null,
      'without the counterfactual arm there is nothing to subtract; a gross figure labelled incremental is the error this prevents'
    );
  });

  test('paired differences are computed against B3, the compliant baseline', () => {
    const cmp = compareWithinWorld([
      scoredArm({ arm: POLICY_ARMS.B3_FIXED_LADDER.id, recovered: 1_000_000 }),
      scoredArm({ arm: POLICY_ARMS.REBOUND_EV.id, recovered: 1_500_000 }),
    ]);
    const rb = cmp.rows.find((r) => r.arm === POLICY_ARMS.REBOUND_EV.id);
    assert.equal(rb.vsB3RecoveredPaise, 500_000);
    assert.equal(rb.vsB3Ratio.value, 1.5);
  });
});

// =================================================================================================
describe('pooling across worlds', () => {
  const worldRow = (arm, recovered, incremental, net) => ({
    arm,
    recoveredPaise: recovered,
    incrementalPaise: incremental,
    netPaise: net,
    netIncrementalPaise: net,
  });
  const w = (rows) => ({ rows });

  test('reports mean, range, sign counts and n — never a bare mean', () => {
    const p = poolAcrossWorlds({
      perWorld: [
        w([worldRow('REBOUND_EV', 300, 300, 300), worldRow('B3_FIXED_LADDER', 100, 100, 100)]),
        w([worldRow('REBOUND_EV', 500, 500, 500), worldRow('B3_FIXED_LADDER', 100, 100, 100)]),
        w([worldRow('REBOUND_EV', 100, 100, 100), worldRow('B3_FIXED_LADDER', 400, 400, 400)]),
      ],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    // diffs: +200, +400, -300 -> mean 100
    assert.equal(p.recovered.n, 3);
    assert.equal(p.recovered.mean, 100);
    assert.equal(p.recovered.min, -300);
    assert.equal(p.recovered.max, 400);
    assert.equal(p.recovered.positive, 2);
    assert.equal(p.recovered.negative, 1);
    assert.ok(p.recovered.sd > 0, 'spread must be visible next to the mean');
  });

  test('the incremental paired difference equals the gross one ONLY when both arms cannibalised equally', () => {
    /**
     * This test used to be titled "...because the counterfactual cancels", and asserted the equality
     * as a general property. It is not one. The B0 term does cancel, but
     *
     *     incremental(A) - incremental(B) = (rec_A - rec_B) + (self_A - self_B)
     *
     * and the self term only vanishes when both arms took the same amount of money out of the
     * would-have-paid-anyway pool. Here both self totals are equal, so the equality holds and that is
     * worth pinning — but the next test shows it breaking, which is why the title now names the
     * precondition instead of asserting a law. On the real five-world default the two differ:
     * gross mean +Rs 11,398 against incremental mean +Rs 11,168.
     */
    const p = poolAcrossWorlds({
      perWorld: [
        w([worldRow('REBOUND_EV', 2_134_728, 697_728, 0), worldRow('B3_FIXED_LADDER', 1_967_800, 530_800, 0)]),
      ],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.recovered.mean, 166_928);
    assert.equal(p.incremental.mean, 166_928, 'equal cannibalisation, so the self term cancels too');
  });

  test('the incremental difference DIVERGES from gross when one arm eats more self-recovery', () => {
    /**
     * The counterexample to the old general claim, hand-computed.
     *
     * One world, B0 counterfactual = 10,00,000 paise. Rebound recovers 8,00,000 of agent money and
     * leaves 2,00,000 to self-recover, so attributed = 10,00,000 and incremental = 0 — it collected
     * a lot but created nothing, because every rupee was coming anyway. B3 recovers 5,00,000 and
     * leaves 7,00,000, so attributed = 12,00,000 and incremental = +2,00,000.
     *
     *   gross difference       = 8,00,000 - 5,00,000 = +3,00,000  (Rebound looks 3L ahead)
     *   incremental difference =        0 - 2,00,000 = -2,00,000  (Rebound is actually 2L behind)
     *
     * Same two arms, opposite sign. Quoting the gross difference here would invert the conclusion,
     * which is exactly what the old test title licensed a reader to do.
     */
    const p = poolAcrossWorlds({
      perWorld: [
        w([worldRow('REBOUND_EV', 800_000, 0, 0), worldRow('B3_FIXED_LADDER', 500_000, 200_000, 0)]),
      ],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.recovered.mean, 300_000, 'gross says Rebound is ahead');
    assert.equal(p.incremental.mean, -200_000, 'incremental says it is behind — and incremental is the honest one');
    assert.equal(p.recovered.positive, 1);
    assert.equal(p.incremental.negative, 1, 'the sign count must flip too, not just the magnitude');
  });

  test('a row missing netIncremental is excluded from the pool, not averaged in as NaN', () => {
    /**
     * `undefined !== null` is true, so a `!== null` guard would push `undefined - undefined = NaN`
     * into the pool and every statistic would read NaN while `n` still said 1. The guard tests for a
     * finite number instead, so the figure is absent and `n` says so.
     */
    const bare = (arm, recovered) => ({ arm, recoveredPaise: recovered, incrementalPaise: recovered });
    const p = poolAcrossWorlds({
      perWorld: [w([bare('REBOUND_EV', 500), bare('B3_FIXED_LADDER', 200)])],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.netIncremental.n, 0, 'no netIncremental was available, and n must admit it');
    assert.equal(p.netIncremental.mean, null);
    assert.equal(p.recovered.mean, 300, 'the figures that WERE present still pool normally');
  });

  test('pooled totals divide once, and the ratio is floored like any other', () => {
    const p = poolAcrossWorlds({
      perWorld: [
        w([worldRow('REBOUND_EV', 4_000_000, 4_000_000, 0), worldRow('B3_FIXED_LADDER', 2_000_000, 1_000_000, 0)]),
      ],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.pooled.armPaise, 4_000_000);
    assert.equal(p.pooled.versusPaise, 2_000_000);
    assert.equal(p.pooled.ratio.value, 2);
    assert.equal(p.pooled.incrementalRatio.value, 4, 'incremental is the ratio to quote vs doing nothing');
  });

  test('a pooled ratio against a sub-floor denominator is refused, not printed', () => {
    const p = poolAcrossWorlds({
      perWorld: [w([worldRow('REBOUND_EV', 4_000_000, 4_000_000, 0), worldRow('B3_FIXED_LADDER', 1_000, 1_000, 0)])],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.pooled.ratio.value, null, 'this is the 329x trap');
    assert.match(p.pooled.ratio.reason, /floor/);
  });

  test('an empty set yields nulls and n=0, not NaN', () => {
    const p = poolAcrossWorlds({ perWorld: [], armId: 'REBOUND_EV', versusArmId: 'B3_FIXED_LADDER' });
    assert.equal(p.recovered.n, 0);
    assert.equal(p.recovered.mean, null);
  });

  test('sd is null at n=1, because one world has no spread to report', () => {
    const p = poolAcrossWorlds({
      perWorld: [w([worldRow('REBOUND_EV', 300, 300, 300), worldRow('B3_FIXED_LADDER', 100, 100, 100)])],
      armId: 'REBOUND_EV',
      versusArmId: 'B3_FIXED_LADDER',
    });
    assert.equal(p.recovered.sd, null);
  });

  test('howToQuote names the incremental caveat, so it travels with the number', () => {
    const p = poolAcrossWorlds({ perWorld: [], armId: 'REBOUND_EV', versusArmId: 'B3_FIXED_LADDER' });
    assert.match(p.howToQuote, /INCREMENTAL/);
    assert.match(p.howToQuote, /Never a per-world ratio/);
  });
});

// =================================================================================================
// THE CONTACT-CAP WINDOW AUDIT — #62. Hand-computed, on the case the old check got wrong.
// =================================================================================================
describe('auditContactWindows', () => {
  const DAY = 24 * 3_600_000;
  const T0 = new Date('2026-08-24T09:30:00Z').getTime();

  /** A settled WhatsApp send, `d` days after the run start. The audit reads `startedAt`. */
  const send = (customerId, d) => ({
    customerId,
    channel: Channel.WHATSAPP,
    kind: ActionKind.SEND_LINK,
    state: ExecState.SETTLED,
    startedAt: new Date(T0 + d * DAY).toISOString(),
  });

  test('four sends across ten days at a cap of 2 is COMPLIANT — the window slides', () => {
    /**
     * THE EXACT CASE THE OLD CHECK CALLED A BREACH. `orchestrate-report` counted a customer's sends
     * over the whole run and compared that total to a SEVEN-DAY cap, which is only the same question
     * when the run is under seven days. At a 4-day horizon it was accidentally right; at 10 days it
     * reported seven customers over the cap for a policy the eval scores at zero breaches.
     *
     * Hand-computed. Sends at days 0, 1, 8, 9. Window at day 0: {0} = 1. At day 1: {0,1} = 2 — AT the
     * cap, not over. At day 8: look back to day 1, so {1,8} = 2. At day 9: back to day 2, so {8,9} = 2.
     * Worst window 2, cap 2, zero breaches. Total over the run 4, which is meaningless against a
     * 7-day cap and is reported separately for exactly that reason.
     */
    const a = auditContactWindows(
      [send('c1', 0), send('c1', 1), send('c1', 8), send('c1', 9)],
      { cap: 2 }
    );
    assert.equal(a.worstInWindow, 2, 'the largest count inside any 7-day window');
    assert.equal(a.worstOverWholeRun, 4, 'and the run total, reported beside it and never instead of it');
    assert.deepEqual(a.breaches, [], 'four sends over ten days does not breach a 7-day cap of 2');
    assert.equal(a.breachedCustomers, 0);
  });

  test('three sends inside one window IS a breach, and it names when', () => {
    // Days 0, 1, 2 — all inside a 7-day window from day 2, so the third send is the breach.
    const a = auditContactWindows([send('c1', 0), send('c1', 1), send('c1', 2)], { cap: 2 });
    assert.equal(a.worstInWindow, 3);
    assert.equal(a.breachedCustomers, 1);
    assert.equal(a.breaches[0].customerId, 'c1');
    assert.equal(a.breaches[0].messagesInWindow, 3);
    assert.equal(
      a.breaches[0].breachedAt,
      new Date(T0 + 2 * DAY).toISOString(),
      'the instant the cap was first exceeded, so an auditor can find the action'
    );
  });

  test('the window boundary is inclusive at both ends', () => {
    /**
     * Sends at day 0 and day 7 with a 7-day window. The lower bound is `t - 7d`, and day 0 is
     * exactly that instant, so both sends fall inside the window measured at day 7: the count is 2.
     * An exclusive bound would report 1 and would under-count every window by one at the edge —
     * which is the direction that hides breaches.
     */
    const a = auditContactWindows([send('c1', 0), send('c1', 7)], { cap: 2 });
    assert.equal(a.worstInWindow, 2, 'day 0 sits exactly on the day-7 window boundary and counts');
    assert.equal(a.breachedCustomers, 0, 'two in a window at a cap of two is at the cap, not over it');
  });

  test('windows are per customer, never pooled', () => {
    // Three sends, three different customers, one each. Pooling them would read as a breach of 3.
    const a = auditContactWindows([send('c1', 0), send('c2', 0), send('c3', 0)], { cap: 2 });
    assert.equal(a.worstInWindow, 1, 'the cap is per customer — pooling three customers invents a breach');
    assert.equal(a.breachedCustomers, 0);
  });

  test('a proposed-but-never-sent action has contacted nobody', () => {
    /**
     * Charging an arm for a message it never sent would penalise whichever arm is best at abandoning
     * a queued action once the budget is spent — the same reasoning `countExecutedActions` uses, and
     * the reason both count only SETTLED sends with a channel.
     */
    const proposed = { ...send('c1', 0), state: ExecState.PENDING };
    const retryNoChannel = { customerId: 'c1', kind: ActionKind.RETRY_NOW, state: ExecState.SETTLED, startedAt: new Date(T0).toISOString(), channel: null };
    const a = auditContactWindows([send('c1', 0), proposed, proposed, retryNoChannel], { cap: 2 });
    assert.equal(a.worstInWindow, 1, 'one settled message; the pending ones and the retry are not contact');
    assert.equal(a.breachedCustomers, 0);
  });

  test('out-of-order ledger rows do not change the answer', () => {
    /**
     * The store returns actions in insertion order, which is cycle order, which is NOT guaranteed to
     * be send order once scheduled retries land out of sequence. A window audit that assumed sorted
     * input would read a scheduled send as the start of a fresh window and miss real breaches.
     */
    const shuffled = [send('c1', 2), send('c1', 0), send('c1', 1)];
    const a = auditContactWindows(shuffled, { cap: 2 });
    assert.equal(a.worstInWindow, 3, 'same three sends, same breach, regardless of row order');
    assert.equal(a.breaches[0].breachedAt, new Date(T0 + 2 * DAY).toISOString());
  });
});
