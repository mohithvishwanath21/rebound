/**
 * THE TWO DAY 7 HAZARDS, PINNED BEFORE THE ORCHESTRATOR EXISTED
 * ============================================================
 *
 * Written first, deliberately, and for the reason `test/retryTiming.test.js` records: a test
 * written after the implementation tends to assert what the code happens to do, and the two
 * properties below are ones I could very easily have satisfied *nearly* and called done.
 *
 * HAZARD 1 — THE IDEMPOTENCY KEY MUST BE PERSISTED BEFORE THE SIDE EFFECT IT GUARDS.
 * `decide.js` mints the key deterministically from (eventId, action, attemptOrdinal), and its
 * own docblock flags the residual risk: a derived key depends on our counter being accurate,
 * a persisted key does not. But persisting it is only half. The other half is that `putAction`
 * returning false is ambiguous — the key exists, which proves we started, and says nothing
 * about whether the gateway call finished. A restart that treats "seen this key" as "already
 * done" abandons an attempt whose money may have moved; one that treats it as "not done"
 * charges twice. Both are real money and only one of them is visible in a report.
 *
 * HAZARD 2 — A BINDING RUN BUDGET MUST BE SPENT ON THE MOST VALUABLE CASES.
 * The engine already ranks *actions within a case*. Nothing ranked *cases against each other*.
 * With a finite per-run retry budget, processing in enumeration order spends the budget on
 * whichever case the generator happened to emit first, and — this is the part that makes it
 * hard to notice — the run still reports healthy guardrails and a sensible-looking action mix.
 * It is a pure and invisible loss of expected value.
 *
 * Run: node --test test/orchestrator.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../src/db/store.js';
import { runCycle, executeDecision, ExecState } from '../src/agent/orchestrator.js';
import { ActionKind, CUSTOMER_CONTACTING, MONEY_MOVING } from '../src/core/actions.js';
import { GUARDRAILS, POLICY } from '../src/core/config.js';
import { ReceiptState, validateActionRequest } from '../src/razorpay/gateway.js';

const NOW = new Date('2026-08-24T09:30:00Z');
const config = { GUARDRAILS, POLICY };

/**
 * A stub gateway that records every call and can be told to die mid-flight. Deliberately not
 * the sim gateway: these tests are about the orchestrator's control flow, and a gateway that
 * resolves outcomes against latent truth would make the assertions depend on the response
 * model as well as on the code under test.
 *
 * It DOES run `validateActionRequest`, though, and that is not decoration. It originally did
 * not, and the omission let these nine tests pass while `executeDecision` was building a
 * request the real seam would have rejected: it never passed `event`, so the SIM gateway
 * priced every outcome against `undefined` and crashed on the first contacting action the
 * moment the Day 7 CLI ran the loop for real. A double that accepts more than production
 * accepts is not a double, it is a second implementation with a weaker contract — and the
 * only thing it can prove is that the code agrees with itself.
 */
function stubGateway({ failWith = null, capture = false } = {}) {
  const calls = [];
  const receipt = (req) => ({
    mode: 'SIM',
    actionKind: req.action.kind,
    reference: `ref_${req.eventId}`,
    state: capture ? ReceiptState.CAPTURED : ReceiptState.FAILED,
    amountPaise: req.amountPaise,
    amountCollectedPaise: capture ? req.amountPaise : 0,
    providerRef: `order_${req.eventId}`,
    at: NOW.toISOString(),
    caveats: ['STUB'],
  });
  const run = async (req) => {
    validateActionRequest(req);
    calls.push(req);
    if (failWith) throw failWith;
    return receipt(req);
  };
  return {
    mode: 'SIM',
    calls,
    retryCharge: run,
    sendPaymentLink: run,
    requestReauth: run,
    fetchStatus: async ({ providerRef }) => ({
      kind: 'ORDER', providerRef, state: ReceiptState.ATTEMPTED,
      providerStatus: 'created', amountPaidPaise: 0,
    }),
    close: async () => {},
  };
}

/** An observed case in the shape `observe()` emits. */
const observedCase = ({ eventId, customerId = `cust_${eventId}`, amountPaise = 100_000 }) => ({
  eventId,
  customerId,
  amountPaise,
  lossType: 'FAILED_PAYMENT',
  occurredAt: '2026-08-22T09:30:00Z',
  detectedAt: '2026-08-22T09:30:00Z',
  rail: 'CARD',
  errorCode: 'insufficient_funds',
});

const diagnosisFor = () => ({
  rootCause: 'INSUFFICIENT_FUNDS',
  source: 'RULE',
  matchTier: 'REASON',
  confidence: 0.9,
  abstained: false,
  requiresApprovalForMoneyMovement: false,
  explanation: 'stub diagnosis',
});

/**
 * A scorer whose probability depends only on the amount, so EV ordering across cases is
 * predictable by construction and the test does not have to model the real one.
 */
const scorerByAmount = () => ({ action }) => ({
  p: action.kind === ActionKind.RETRY_NOW ? 0.5 : 0.4,
  support: { state: 'SUPPORTED', rows: 500 },
});

async function seedCases(store, runId, specs) {
  await store.putRun({ runId, startedAt: NOW, arm: 'REBOUND_EV' });
  await store.putCases(specs.map((s) => ({
    runId,
    eventId: s.eventId,
    customerId: s.customerId ?? `cust_${s.eventId}`,
    state: 'OPEN',
    retriesUsed: 0,
    touchesUsed: 0,
    amountPaise: s.amountPaise ?? 100_000,
    /**
     * Contact details and the event travel on the case record because `validateActionRequest`
     * requires them — a contacting action with no customer is refused, and the SIM gateway
     * prices outcomes off the event. Present here so these tests exercise the same request
     * shape production does rather than a laxer one.
     */
    customer: { customerId: s.customerId ?? `cust_${s.eventId}`, email: 'x@example.invalid', phone: '+919000000000' },
    event: {
      eventId: s.eventId,
      amountPaise: s.amountPaise ?? 100_000,
      lossType: 'FAILED_PAYMENT',
      occurredAt: '2026-08-22T09:30:00Z',
      rail: 'CARD',
    },
  })));
}

// =============================================================================================
// HAZARD 1 — CRASH SAFETY
// =============================================================================================

test('the attempt is persisted before the gateway is called, not after', async () => {
  /**
   * The ordering IS the control. If the write happens after the call, then the window between
   * them is a window in which money has moved and nothing records that it did — and that window
   * is exactly when a process is most likely to die, because the gateway call is the slowest
   * thing in the loop.
   *
   * Checked by having the gateway throw: whatever is in the store afterwards was necessarily
   * written before the call.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [{ eventId: 'e1' }]);
  const gateway = stubGateway({ failWith: new Error('connection reset mid-flight') });

  const decision = {
    eventId: 'e1',
    outcome: 'ACT',
    decisionSeq: 0,
    chosen: {
      action: { kind: ActionKind.RETRY_NOW, idempotencyKey: 'rebound:e1:RETRY_NOW:0' },
      signature: 'RETRY_NOW',
      evPaise: 1200,
    },
    amountPaise: 100_000,
  };

  await assert.rejects(
    () => executeDecision({ store, gateway, runId: 'r1', decision, now: NOW, config }),
    /connection reset/
  );

  const attempt = await store.getAction('rebound:e1:RETRY_NOW:0');
  assert.ok(attempt, 'no attempt was recorded, so a crash here would be invisible');
  assert.equal(attempt.state, ExecState.PENDING, 'the attempt must be written PENDING before the call');
  assert.equal(attempt.eventId, 'e1');
  assert.deepEqual(
    (await store.getPendingActions('r1')).map((a) => a.idempotencyKey),
    ['rebound:e1:RETRY_NOW:0'],
    'a crashed attempt must remain on the pending work list'
  );
});

test('a restart reconciles a pending attempt instead of re-executing it', async () => {
  /**
   * THE EXPENSIVE CASE, AND THE ONE A NAIVE IDEMPOTENCY CHECK GETS WRONG.
   *
   * After the crash above, the key is present. `putAction` will therefore return false. A
   * restart that reads that as "already done" moves on and never learns whether the charge
   * landed; one that ignores it re-charges. The correct move is neither: ask the provider what
   * happened to the reference we already persisted.
   *
   * This is why `fetchStatus` exists in the SIM gateway at all — the sim has no asynchrony to
   * model, and implementing it anyway keeps this path exercised outside of production.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [{ eventId: 'e1' }]);
  const key = 'rebound:e1:RETRY_NOW:0';

  // The world as the crash left it.
  await store.putAction({
    runId: 'r1', eventId: 'e1', kind: ActionKind.RETRY_NOW,
    idempotencyKey: key, state: ExecState.PENDING, providerRef: 'order_e1',
  });

  const gateway = stubGateway();
  const decision = {
    eventId: 'e1',
    outcome: 'ACT',
    decisionSeq: 0,
    chosen: {
      action: { kind: ActionKind.RETRY_NOW, idempotencyKey: key },
      signature: 'RETRY_NOW',
      evPaise: 1200,
    },
    amountPaise: 100_000,
  };

  const result = await executeDecision({ store, gateway, runId: 'r1', decision, now: NOW, config });

  assert.equal(gateway.calls.length, 0, 'a pending attempt must never be re-executed against the gateway');
  assert.equal(result.reconciled, true, 'the restart must reconcile rather than skip silently');

  const settled = await store.getAction(key);
  assert.equal(settled.state, ExecState.SETTLED, 'reconciliation must settle the attempt');

  const audit = await store.getAudit('r1', { type: 'ATTEMPT_RECONCILED' });
  assert.equal(audit.length, 1, 'reconciliation must be visible in the audit trail, not silent');
});

test('an already-settled attempt is skipped without touching the gateway', async () => {
  const store = createMemoryStore();
  await seedCases(store, 'r1', [{ eventId: 'e1' }]);
  const key = 'rebound:e1:RETRY_NOW:0';

  await store.putAction({
    runId: 'r1', eventId: 'e1', kind: ActionKind.RETRY_NOW,
    idempotencyKey: key, state: ExecState.SETTLED,
    receipt: { state: ReceiptState.FAILED, amountCollectedPaise: 0 },
  });

  const gateway = stubGateway();
  const result = await executeDecision({
    store, gateway, runId: 'r1', now: NOW, config,
    decision: {
      eventId: 'e1', outcome: 'ACT', decisionSeq: 0, amountPaise: 100_000,
      chosen: { action: { kind: ActionKind.RETRY_NOW, idempotencyKey: key }, signature: 'RETRY_NOW', evPaise: 1200 },
    },
  });

  assert.equal(gateway.calls.length, 0);
  assert.equal(result.duplicate, true);
  assert.equal(result.reconciled, false, 'a settled attempt needs no reconciliation');
});

// =============================================================================================
// HAZARD 2 — A BINDING BUDGET MUST BE SPENT IN VALUE ORDER
// =============================================================================================

test('when the retry budget binds, it is spent on the highest-EV cases', async () => {
  /**
   * Three cases, enumerated smallest-first, with a run budget of two retries. Enumeration order
   * would spend the budget on ₹100 and ₹500 and leave ₹50,000 untouched, while every guardrail
   * reads healthy and the action mix looks reasonable. That is the failure this pins.
   *
   * The budget is set here rather than in config so the test states its own premise.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_small', amountPaise: 10_000 },
    { eventId: 'e_mid', amountPaise: 50_000 },
    { eventId: 'e_large', amountPaise: 5_000_000 },
  ]);

  const gateway = stubGateway();
  /**
   * The budget is set here rather than in config so the test states its own premise.
   *
   * The approval threshold is lifted for a subtler reason, and it is worth writing down because
   * it was found by this test failing rather than by reading. `APR_LARGE_AMOUNT` routes any
   * automated money movement at or above `humanApprovalThresholdPaise` (₹25,000 by default) to a
   * human — so the ₹50,000 case lands on AWAIT_APPROVAL, never calls the gateway, and therefore
   * consumes no retry budget at all. The run cap of two then gets spent by ₹100 and ₹500 without
   * ever binding, and the property under test here is silently never exercised.
   *
   * That approval gate is correct and is pinned in the Day 6 guardrail tests. It just makes a
   * second, independent claim about the same case, and a test that entangles two controls cannot
   * tell you which one failed. So it is lifted out of the way to leave the run budget as the only
   * binding constraint.
   */
  const budgetOfTwo = {
    GUARDRAILS: { ...GUARDRAILS, maxRetriesPerRun: 2, humanApprovalThresholdPaise: 10_000_000_000 },
    POLICY,
  };

  const { executed } = await runCycle({
    store,
    gateway,
    runId: 'r1',
    now: NOW,
    config: budgetOfTwo,
    scoreAction: scorerByAmount(),
    observeCase: (c) => observedCase({ eventId: c.eventId, amountPaise: c.amountPaise }),
    diagnoseCase: diagnosisFor,
  });

  const retried = executed
    .filter((x) => x.decision.chosen && x.decision.chosen.action.kind === ActionKind.RETRY_NOW)
    .map((x) => x.decision.eventId);

  assert.ok(retried.includes('e_large'), `the ₹50,000 case must get budget: got ${retried.join(', ')}`);
  assert.ok(!retried.includes('e_small'), `the ₹100 case must not outrank it: got ${retried.join(', ')}`);
});

test('the execution order is by expected value, not by enumeration order', async () => {
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_small', amountPaise: 10_000 },
    { eventId: 'e_large', amountPaise: 5_000_000 },
    { eventId: 'e_mid', amountPaise: 50_000 },
  ]);

  const { executed } = await runCycle({
    store,
    gateway: stubGateway(),
    runId: 'r1',
    now: NOW,
    config,
    scoreAction: scorerByAmount(),
    observeCase: (c) => observedCase({ eventId: c.eventId, amountPaise: c.amountPaise }),
    diagnoseCase: diagnosisFor,
  });

  const evs = executed.map((x) => x.decision.chosen?.evPaise ?? -Infinity);
  const sorted = [...evs].sort((a, b) => b - a);
  assert.deepEqual(evs, sorted, `cases were not processed in descending EV order: ${evs.join(', ')}`);
});

test('a case re-decided under an exhausted budget records why it changed', async () => {
  /**
   * The propose/commit split, and the reason it is not merely an implementation detail.
   *
   * Cases are priced against the run state as it stood at the START of the cycle, because that
   * is the only way to get an ordering. But by the time a later case executes, earlier ones have
   * consumed budget — so it is re-decided against the LIVE state. That means the action actually
   * taken can differ from the one that earned the case its place in the queue.
   *
   * Silently swapping the action would make the audit trail a record of a decision that was
   * never made. The divergence has to be written down, because "we wanted to retry and the run
   * budget was gone" is a materially different fact from "we chose to send a link".
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_large', amountPaise: 5_000_000 },
    { eventId: 'e_mid', amountPaise: 400_000 },
  ]);

  const { executed } = await runCycle({
    store,
    gateway: stubGateway(),
    runId: 'r1',
    now: NOW,
    // maxRetriesPerRun: 1 makes the budget bind after the first (larger) case. The approval
    // threshold is lifted for the same reason as the budget test above: otherwise the ₹50,000
    // case routes to a human and consumes no retry, so the budget never binds and no divergence
    // is produced. See that test for the full reasoning.
    config: {
      GUARDRAILS: { ...GUARDRAILS, maxRetriesPerRun: 1, humanApprovalThresholdPaise: 10_000_000_000 },
      POLICY,
    },
    scoreAction: scorerByAmount(),
    observeCase: (c) => observedCase({ eventId: c.eventId, amountPaise: c.amountPaise }),
    diagnoseCase: diagnosisFor,
  });

  const diverged = executed.filter((x) => x.divergedFromProposal);
  assert.ok(diverged.length >= 1, 'a budget that binds must produce at least one recorded divergence');

  const entries = await store.getAudit('r1', { type: 'PROPOSAL_SUPERSEDED' });
  assert.ok(entries.length >= 1, 'the divergence must appear in the audit trail');
  assert.match(entries[0].detail.because, /budget|guardrail|retr/i);
});

// =============================================================================================
// HAZARD 3 — A CROSS-CASE CONTROL HAS TO BE TESTED ACROSS CASES
// =============================================================================================

/**
 * `TIM_CUSTOMER_MESSAGE_CAP` exists to stop the failure its own docblock names: messaging one
 * customer about eight invoices in one morning, while every per-case counter reads politely low.
 * A per-case test cannot exercise that rule at all — it would pass against a purely per-case
 * implementation — so the only test that means anything uses two cases of the SAME customer.
 *
 * Both of these are paired on purpose. The first shows the cap binds; the second shows it binds on
 * the CUSTOMER and not on the batch. Either alone is satisfied by a wrong implementation: a global
 * "one message per run" counter passes the first and fails the second.
 */

/** No retry budget at all, so the only actions left on the table are the ones that contact. */
const contactOnly = (over = {}) => ({
  GUARDRAILS: { ...GUARDRAILS, maxRetriesPerRun: 0, maxMessagesPerCustomerPer7Days: 1, ...over },
  POLICY,
});

const runArgs = (store, gateway, config) => ({
  store,
  gateway,
  runId: 'r1',
  now: NOW,
  config,
  scoreAction: scorerByAmount(),
  observeCase: (c) => observedCase({ eventId: c.eventId, customerId: c.customerId, amountPaise: c.amountPaise }),
  diagnoseCase: diagnosisFor,
});

test('the per-customer message cap binds across two cases of the SAME customer, within one cycle', async () => {
  /**
   * WHY "WITHIN ONE CYCLE" IS THE LOAD-BEARING PART OF THE NAME.
   *
   * The cycle hydrates every due case up front to price them, then executes them in EV order. If
   * the contact count is read only during that first pass, both of these cases are hydrated at zero
   * before either has sent anything, and both send — the cap binds across cycles and never within
   * one, which is precisely the morning it was written to prevent. This test failed exactly that
   * way before `runCycle` re-hydrated each case against the live ledger at commit time.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_hi', customerId: 'cust_shared', amountPaise: 300_000 },
    { eventId: 'e_lo', customerId: 'cust_shared', amountPaise: 200_000 },
  ]);

  const gateway = stubGateway();
  const { executed } = await runCycle(runArgs(store, gateway, contactOnly()));

  const contactCalls = gateway.calls.filter((c) => CUSTOMER_CONTACTING.has(c.action.kind));
  assert.equal(
    contactCalls.length,
    1,
    `one customer, cap of one, so exactly one message may go out; got ${contactCalls.length} ` +
      `(${contactCalls.map((c) => `${c.eventId}:${c.action.kind}`).join(', ')})`
  );
  assert.equal(contactCalls[0].eventId, 'e_hi', 'the one permitted message must go to the higher-EV case');

  const ledger = await store.countContactsSince('cust_shared', new Date(NOW.getTime() - 7 * 86_400_000));
  assert.equal(ledger, 1, 'the ledger must record exactly the message that was sent');

  // The blocked case must be blocked BY THIS RULE. Asserting only "it did not send" would also pass
  // if it had been stopped for an unrelated reason, which would leave the cap untested.
  const blocked = executed.find((x) => x.decision.eventId === 'e_lo');
  assert.ok(blocked, 'the second case must still be processed, not skipped');
  assert.notEqual(blocked.decision.outcome, 'ACT', 'the capped case must not act');
  const cappedCandidates = blocked.decision.candidates.filter((c) =>
    c.violations.some((v) => v.id === 'TIM_CUSTOMER_MESSAGE_CAP')
  );
  assert.ok(
    cappedCandidates.length > 0,
    'the block must be attributable to TIM_CUSTOMER_MESSAGE_CAP, not to some other rule'
  );

  /**
   * And it must be a DATED deferral, not a bare refusal. The rule degrades to FORBID when it cannot
   * say when the window clears, which is safe but drops the customer with no wakeup. Feeding it the
   * oldest in-window message turns that into "unreachable until exactly this instant" — a fact the
   * scheduler can act on.
   */
  const record = await store.getCase('r1', 'e_lo');
  assert.equal(record.state, 'SCHEDULED', 'a capped case should be waiting, not stopped');
  assert.ok(record.nextActionAt, 'the capped case must carry a wakeup instant');
  assert.equal(
    new Date(record.nextActionAt).toISOString(),
    new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
    'the window clears seven days after the oldest message in it'
  );
});

test('the same cap does NOT bind across two DIFFERENT customers', async () => {
  /**
   * The control. Without this, a global per-run message counter would pass the test above and look
   * like a working compliance rule while actually throttling the whole batch — a very expensive way
   * to be compliant, and one that would show up as unexplained lost recovery rather than as a bug.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_a', customerId: 'cust_a', amountPaise: 300_000 },
    { eventId: 'e_b', customerId: 'cust_b', amountPaise: 200_000 },
  ]);

  const gateway = stubGateway();
  await runCycle(runArgs(store, gateway, contactOnly()));

  const contactCalls = gateway.calls.filter((c) => CUSTOMER_CONTACTING.has(c.action.kind));
  assert.equal(
    contactCalls.length,
    2,
    'the cap is per customer, so two different customers may each be messaged once'
  );
  assert.equal(await store.countContactsSince('cust_a', new Date(NOW.getTime() - 7 * 86_400_000)), 1);
  assert.equal(await store.countContactsSince('cust_b', new Date(NOW.getTime() - 7 * 86_400_000)), 1);
});

// =============================================================================================
// HAZARD 4 — A SCHEDULED ACTION IS A WAKEUP, NOT A STORED INSTRUCTION
// =============================================================================================

test('a scheduled retry sets a wakeup, touches no gateway, and is re-decided rather than replayed', async () => {
  /**
   * Three claims in one test, because they are the same claim seen at three instants.
   *
   * The landing-instant principle already governs pricing: an action's probability belongs to the
   * moment it LANDS, not the moment it was chosen. This applies it to AUTHORISATION. Between now
   * and +72h the customer may pay unprompted, dispute, revoke a mandate, or spend their contact
   * budget on another invoice. A stored intent executed on wakeup acts on a three-day-old belief
   * AND a three-day-old guardrail check — and the guardrail half is the dangerous half, because it
   * is the half a reviewer assumes was checked at the moment money moved.
   *
   * The clock is injected rather than read, which is the only reason this is testable at all:
   * proving a +72h retry fires at +72h and not before would otherwise take three days.
   */
  const store = createMemoryStore();
  await seedCases(store, 'r1', [
    { eventId: 'e_sched', customerId: 'cust_sched', amountPaise: 400_000 },
  ]);

  const favour = (kind) => () => ({ action }) => ({
    p: action.kind === kind ? 0.75 : 0.05,
    support: { state: 'SUPPORTED', rows: 500 },
  });

  const base = {
    store,
    runId: 'r1',
    config,
    observeCase: (c) => observedCase({ eventId: c.eventId, customerId: c.customerId, amountPaise: c.amountPaise }),
    diagnoseCase: diagnosisFor,
  };

  // ---- cycle 0: waiting is the best available action -----------------------------------------
  const g0 = stubGateway();
  const c0 = await runCycle({ ...base, gateway: g0, now: NOW, cycle: 0, scoreAction: favour(ActionKind.RETRY_SCHEDULED)() });

  assert.equal(g0.calls.length, 0, 'a future retry must not be executed in the cycle that chose it');

  const scheduled = await store.getCase('r1', 'e_sched');
  assert.equal(scheduled.state, 'SCHEDULED');
  assert.ok(scheduled.nextActionAt, 'scheduling must set a wakeup instant');
  const wakeAt = new Date(scheduled.nextActionAt);
  assert.ok(wakeAt.getTime() > NOW.getTime(), 'the wakeup must be in the future');
  assert.equal(scheduled.scheduled.intent, c0.executed[0].decision.chosen.signature);

  const schedAudit = await store.getAudit('r1', { type: 'CASE_SCHEDULED' });
  assert.equal(schedAudit.length, 1, 'scheduling must be visible in the audit trail');

  // ---- one minute before the wakeup: still not due --------------------------------------------
  const g1 = stubGateway();
  const early = new Date(wakeAt.getTime() - 60_000);
  const c1 = await runCycle({ ...base, gateway: g1, now: early, cycle: 1, scoreAction: favour(ActionKind.RETRY_NOW)() });

  assert.equal(c1.due.length, 0, `a case scheduled for ${wakeAt.toISOString()} must not be due at ${early.toISOString()}`);
  assert.equal(g1.calls.length, 0, 'nothing may execute before the wakeup instant');

  // ---- at the wakeup, with a world that has moved ---------------------------------------------
  /**
   * The scorer now prefers retrying immediately. If the orchestrator replayed the stored
   * RETRY_SCHEDULED intent, the gateway would see RETRY_SCHEDULED. It re-decides, so it sees the
   * action that is correct NOW. That difference is the whole point of the design.
   */
  const g2 = stubGateway();
  const c2 = await runCycle({ ...base, gateway: g2, now: wakeAt, cycle: 2, scoreAction: favour(ActionKind.RETRY_NOW)() });

  assert.equal(c2.due.length, 1, 'the case must become due at exactly the wakeup instant');
  assert.equal(g2.calls.length, 1, 'the wakeup must actually do something');
  assert.equal(
    g2.calls[0].action.kind,
    ActionKind.RETRY_NOW,
    `the wakeup must execute the action that is right now, not the stored intent ` +
      `(${scheduled.scheduled.intent}); got ${g2.calls[0].action.kind}`
  );
  assert.ok(MONEY_MOVING.has(g2.calls[0].action.kind));
  assert.notEqual(
    g2.calls[0].action.kind,
    ActionKind.RETRY_SCHEDULED,
    'executing the stored intent would mean the guardrails were last checked three days ago'
  );
});
