/**
 * A DEFERRAL IS A COMMITMENT, NOT A PREFERENCE — the four tests for #67.
 *
 * THE DEFECT THESE PIN, measured before any of them existed:
 *
 *   seed w01, 16 cycles x 12h, 80 TRAIN cases, g120
 *     CASE_SCHEDULED 829 : ATTEMPT_STARTED 78  =  10.63 postponements per action
 *     59 of 80 cases still SCHEDULED at the horizon; 39 never attempted anything at all
 *     evt_000003 (Rs 16,721): 16 schedulings in 16 cycles, ZERO attempts, always +6.0h,
 *                             its own EV decaying Rs 6,385 -> Rs 2,997 while it waited
 *   pooled over 5 worlds: 4235 : 332 = 12.76x
 *
 * `POLICY.candidateRetryOffsetsHours` starts at 6, and the model says P(recover) rises with retry
 * delay. So EV(retry in 6h) > EV(retry now) at EVERY instant — the inequality has no clock in it. The
 * case wakes at the moment it chose, re-decides from scratch (#37, deliberately, so a three-day-old
 * belief never authorises a charge), reaches the same conclusion, and arms another +6h wakeup. A
 * time-invariant preference for waiting never resolves.
 *
 * WHY IT SURVIVED TWO DAYS OF REPORTS. Offsets start at 6h and the cycle step is 12h, so a case
 * deferred +6h genuinely IS due next cycle. Queue depth healthy, audit trail immaculate, zero guardrail
 * violations, sensible action mix, recovery figure merely small. It reads as a CAUTIOUS policy, which
 * is the adjective I wanted, so nothing prompted me to look. Money per cycle cannot distinguish "tried
 * and failed" from "never tried"; counting ATTEMPT_STARTED can, and did.
 *
 * THE RULE: when a case is woken at an instant it chose for itself, it may not spend that wakeup
 * re-arming the same class of action. It must act, escalate, or stop. Re-decision is fully preserved —
 * belief, guardrails and the approval envelope are all re-evaluated at the landing instant. What is
 * removed is only the option to postpone the same thing again. `POLICY.maxDeferralsPerCase` is the hard
 * backstop, so the invariant survives a path I have not thought of reaching the loop another way.
 *
 * EVERY TEST HERE ASSERTS BOTH HALVES. A test that only checks "cannot defer" would pass just as well
 * against a build where scheduled retries were broken outright, which would destroy the timing edge
 * Days 5-7 exist to exploit and look like a fix. So each one also checks that the same scorer on a
 * case that has NOT yet deferred still chooses the scheduled retry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideForCase, Outcome } from '../src/agent/decide.js';
import { runCycle, AuditType, CaseState } from '../src/agent/orchestrator.js';
import { createMemoryStore } from '../src/db/store.js';
import { ActionKind, MONEY_MOVING } from '../src/core/actions.js';
import { GUARDRAILS, POLICY } from '../src/core/config.js';
import { ReceiptState, validateActionRequest } from '../src/razorpay/gateway.js';

const CONFIG = { GUARDRAILS, POLICY };
const NOW = new Date('2026-08-24T09:30:00Z'); // 15:00 IST — clear of quiet hours
const HOUR = 3_600_000;

const observed = (over = {}) => ({
  eventId: 'evt_1',
  customerId: 'cust_1',
  amountPaise: 1_600_000, // ₹16,000 — the size of evt_000003, and under the approval threshold
  lossType: 'FAILED_PAYMENT',
  occurredAt: '2026-08-22T09:30:00Z',
  detectedAt: '2026-08-22T09:30:00Z',
  rail: 'CARD',
  errorCode: 'insufficient_funds',
  ...over,
});

const FIRM = Object.freeze({
  rootCause: 'INSUFFICIENT_FUNDS',
  source: 'RULE',
  matchTier: 'CODE',
  matchedOn: 'reason_code',
  abstained: false,
  requiresApprovalForMoneyMovement: false,
  physics: { retryCanSucceed: true, humanOnly: false },
  explanation: 'reason code mapped directly',
});

/**
 * THE PATHOLOGICAL SCORER, and getting its SHAPE right took three attempts. Both wrong versions are
 * recorded because each failed in a way that would have looked like a passing test.
 *
 * ATTEMPT 1 — P rising monotonically with delay (12% now, +4 points per day). Defensible as a reading
 * of the fitted model, and it produced a DIFFERENT defect: the agent deferred exactly once, to the
 * furthest offset (+168h), and the 5-day test horizon ended before that wakeup landed. One
 * postponement, zero attempts, case unresolved. A real defect, but not the measured one — and a test
 * that pins the wrong failure shape under the right name is worse than no test.
 *
 * ATTEMPT 2 — a bonus DECAYING with delay, meant to make the nearest slot best. It made RETRY_NOW best,
 * because a bonus that decays from zero delay is maximal at zero delay. The control assertion caught it
 * immediately: `CHOSEN: RETRY_NOW`, and the whole file went green on tests 4 and 5 while reproducing no
 * loop at all. **That is precisely why every test here asserts the control half.** Without it I would
 * have had four passing tests proving nothing, before the fix even existed.
 *
 * ATTEMPT 3, the one below. The measured defect chose **+6h every single time** — the NEAREST offset,
 * sixteen times over sixteen cycles. So P must PEAK at the first slot: rise from "now" to "six hours
 * from now", then fall away. That is what a real recovery curve does — a short wait lets a transient
 * decline clear, a long wait lets the customer forget and the invoice age. `u` is the delay in units of
 * the first offset, and `u/(1+u^2)` peaks at exactly u=1.
 *
 *   RETRY_NOW 12.00%  |  +6h 15.00%  +12h 14.40%  +24h 13.41%  +48h 12.74%  +72h 12.50%
 *                     |  +120h 12.30%  +168h 12.21%
 *
 * The +6h slot beats acting now, and beats every later slot. The inequality contains no clock, which is
 * the bug in one sentence. On a ₹16,000 case every one of those clears the ₹2 bar comfortably, so the
 * EV floor never terminates it either.
 *
 * The two wrong shapes are worth keeping straight from the right one because they need different fixes:
 * the peaked shape is a spin loop and needs the commitment rule; the monotone shape is a horizon
 * problem and belongs to #62.
 */
const nearFutureIsBest = () => ({ action }) => {
  const delayDays =
    action.kind === ActionKind.RETRY_SCHEDULED && action.scheduledFor
      ? Math.max(0, (new Date(action.scheduledFor).getTime() - NOW.getTime()) / 86_400_000)
      : 0;
  const u = delayDays / 0.25; // delay measured in units of the first candidate offset (6h)
  return {
    p: MONEY_MOVING.has(action.kind) ? 0.12 + 0.06 * (u / (1 + u * u)) : 0.1,
    support: { state: 'SUPPORTED', rows: 500 },
  };
};

const decide = (record, now = NOW) =>
  decideForCase({
    observed: observed(),
    diagnosis: FIRM,
    record,
    scoreAction: nearFutureIsBest(),
    now,
    config: CONFIG,
  });

/** A case that has never deferred. The control half of every test below. */
const FRESH = { retriesUsed: 0, touchesUsed: 0 };

// =============================================================================================
// 1. THE COMMITMENT RULE
// =============================================================================================

test('a case woken at its own scheduled instant cannot re-arm the same class of action', () => {
  /**
   * The control half first, because it is what makes the assertion below mean anything: with no
   * deferral on record this scorer must still pick the scheduled retry. If it did not, the test that
   * follows would pass against a build with scheduled retries simply removed.
   */
  const fresh = decide(FRESH);
  assert.equal(
    fresh.chosen?.action.kind,
    ActionKind.RETRY_SCHEDULED,
    'control: a fresh case with a nearest-slot-is-best scorer must still choose to schedule — if this ' +
      'fails, the scheduled-retry path is broken and the treated half below proves nothing'
  );

  /**
   * Now the same case, same instant, same scorer — but it is here BECAUSE it scheduled itself for
   * this moment. `deferral.wakeAt` is now, so this is its own wakeup landing.
   */
  const woken = decide({
    ...FRESH,
    deferral: {
      lastClass: ActionKind.RETRY_SCHEDULED,
      wakeAt: NOW.toISOString(),
      counts: { [ActionKind.RETRY_SCHEDULED]: 1 },
    },
  });

  assert.notEqual(
    woken.chosen?.action.kind,
    ActionKind.RETRY_SCHEDULED,
    'a case that woke from its own retry deferral chose to defer the retry AGAIN — this is the spin loop'
  );

  /**
   * And it must have done something rather than merely not deferred. Act, escalate or stop are all
   * acceptable; sliding into WAIT is not, because WAIT re-arms `nextActionAt` through a different
   * audit type and would relocate the loop rather than end it.
   */
  assert.notEqual(woken.outcome, Outcome.WAIT, 'the loop moved into the WAIT path instead of ending');
  assert.ok(
    [Outcome.ACT, Outcome.AWAIT_APPROVAL, Outcome.ESCALATE_HUMAN, Outcome.STOP_PERMANENT].includes(woken.outcome),
    `expected act-or-stop on wakeup, got ${woken.outcome}`
  );

  /**
   * The withheld candidates must appear in the trail with a reason. A decision that silently drops
   * the option it would otherwise have taken is less explainable than one that never had it, because
   * a reviewer comparing two cases cannot see why they diverged.
   */
  const withheld = woken.candidates.filter((c) => c.kind === ActionKind.RETRY_SCHEDULED);
  assert.ok(withheld.length > 0, 'the scheduled-retry candidates vanished from the audit trail entirely');
  assert.ok(
    withheld.every((c) => c.eligible === false && typeof c.rejectedBecause === 'string' && c.rejectedBecause.length > 0),
    'withheld candidates must be marked ineligible AND carry a reason a human can read'
  );
  assert.ok(
    withheld.every((c) => c.priced === false && c.evPaise === null),
    'a withheld candidate must not carry a price — a number beside it invites the comparison the rule forbids'
  );
});

test('the commitment rule is scoped to the class deferred, not to every action', () => {
  /**
   * Waking from a retry deferral must not silence the contacting actions. The rule exists to stop one
   * intent being re-armed forever; broadening it into "a woken case may only retry-now or stop" would
   * quietly delete SEND_LINK from the action space on more than half the batch, and the recovery
   * figure would move for a reason that has nothing to do with the bug.
   */
  const woken = decide({
    ...FRESH,
    deferral: {
      lastClass: ActionKind.RETRY_SCHEDULED,
      wakeAt: NOW.toISOString(),
      counts: { [ActionKind.RETRY_SCHEDULED]: 1 },
    },
  });

  const stillOnTheTable = woken.candidates.filter(
    (c) => c.kind !== ActionKind.RETRY_SCHEDULED && c.eligible !== false
  );
  assert.ok(
    stillOnTheTable.some((c) => c.kind === ActionKind.SEND_LINK),
    'contacting actions were withheld too — the rule is over-broad'
  );
  assert.ok(
    stillOnTheTable.some((c) => c.kind === ActionKind.RETRY_NOW),
    'RETRY_NOW was withheld — then there is no act-now option and act-or-stop collapses to stop'
  );
});

// =============================================================================================
// 2. THE BUDGET BACKSTOP
// =============================================================================================

test('POLICY.maxDeferralsPerCase binds even when the case is not waking from its own deferral', () => {
  const cap = POLICY.maxDeferralsPerCase;
  assert.equal(typeof cap, 'number', 'POLICY.maxDeferralsPerCase must exist — it is the hard backstop');
  assert.ok(cap >= 1, 'a cap below 1 would forbid scheduling anything, ever');

  /**
   * `wakeAt` is deliberately in the FUTURE here, so the commitment rule does not apply and the only
   * thing that can withhold the candidate is the budget. Without this separation a single test would
   * pass on either mechanism and I could not tell which one was load-bearing.
   */
  const future = new Date(NOW.getTime() + 6 * HOUR).toISOString();

  const underCap = decide({
    ...FRESH,
    deferral: { lastClass: ActionKind.RETRY_SCHEDULED, wakeAt: future, counts: { [ActionKind.RETRY_SCHEDULED]: cap - 1 } },
  });
  assert.equal(
    underCap.chosen?.action.kind,
    ActionKind.RETRY_SCHEDULED,
    `control: at ${cap - 1} deferrals the case is still under the cap of ${cap} and must be free to schedule`
  );

  const atCap = decide({
    ...FRESH,
    deferral: { lastClass: ActionKind.RETRY_SCHEDULED, wakeAt: future, counts: { [ActionKind.RETRY_SCHEDULED]: cap } },
  });
  assert.notEqual(
    atCap.chosen?.action.kind,
    ActionKind.RETRY_SCHEDULED,
    `at the cap of ${cap} the case scheduled a retry anyway — the backstop does not bind`
  );

  /** The decision must say which mechanism bound, or the trail cannot distinguish the two. */
  assert.equal(atCap.deferralLimit?.boundBy, 'BUDGET');
  assert.equal(atCap.deferralLimit?.cap, cap);
  assert.equal(atCap.deferralLimit?.count, cap);
});

// =============================================================================================
// 3. THE AUDIT TRAIL, AND THE END-TO-END RATIO
// =============================================================================================

/**
 * The same stub gateway `orchestrator.test.js` uses, and reused rather than rewritten for the reason
 * stated there: it runs `validateActionRequest`, so it rejects exactly what the real seam rejects. My
 * first version of this file had a two-line double with a `perform()` method that production does not
 * call at all, and it failed with "gateway has no retryCharge()" — which was lucky. A double that
 * accepts MORE than production accepts is not a double, it is a second implementation with a weaker
 * contract, and it would have let these tests pass against an orchestrator that could not run.
 *
 * `capture: false` on purpose: every attempt FAILS. A recovering attempt would terminate the case on
 * its first try and there would be no multi-cycle behaviour left to measure. The bug under test is
 * about cases that stay alive, so the gateway has to keep them alive.
 */
function stubGateway({ capture = false } = {}) {
  const calls = [];
  const run = async (req) => {
    validateActionRequest(req);
    calls.push(req);
    return {
      mode: 'SIM',
      actionKind: req.action.kind,
      reference: `ref_${req.eventId}_${calls.length}`,
      state: capture ? ReceiptState.CAPTURED : ReceiptState.FAILED,
      amountPaise: req.amountPaise,
      amountCollectedPaise: capture ? req.amountPaise : 0,
      providerRef: `order_${req.eventId}_${calls.length}`,
      at: NOW.toISOString(),
      caveats: ['STUB'],
    };
  };
  return {
    mode: 'SIM',
    calls,
    retryCharge: run,
    sendPaymentLink: run,
    requestReauth: run,
    fetchStatus: async ({ providerRef }) => ({
      kind: 'ORDER', providerRef, state: ReceiptState.ATTEMPTED, providerStatus: 'created', amountPaidPaise: 0,
    }),
    close: async () => {},
  };
}

async function seedCase(store, runId, eventId, amountPaise = 1_600_000) {
  await store.putRun({ runId, startedAt: NOW, arm: 'REBOUND_EV' });
  await store.putCases([{
    runId,
    eventId,
    customerId: `cust_${eventId}`,
    state: CaseState.OPEN,
    retriesUsed: 0,
    touchesUsed: 0,
    amountPaise,
    customer: { customerId: `cust_${eventId}`, email: 'x@example.invalid', phone: '+919000000000' },
    event: { eventId, amountPaise, lossType: 'FAILED_PAYMENT', occurredAt: '2026-08-22T09:30:00Z', rail: 'CARD' },
  }]);
}

const cycleArgs = (store, gateway, now) => ({
  store,
  gateway,
  runId: 'r1',
  now,
  config: CONFIG,
  scoreAction: nearFutureIsBest(),
  observeCase: (c) => observed({ eventId: c.eventId, customerId: c.customerId, amountPaise: c.amountPaise }),
  diagnoseCase: () => FIRM,
});

test('the audit trail names the refusal, so a withheld deferral is visible rather than merely absent', async () => {
  const store = createMemoryStore();
  await seedCase(store, 'r1', 'evt_1');
  const gateway = stubGateway();

  /**
   * Two cycles, twelve hours apart — the real step. Cycle 0 schedules; cycle 1 lands on that wakeup
   * and must refuse to re-arm it. The refusal is an audit event because the alternative is a trail in
   * which cycle 0 and cycle 1 look like two unrelated decisions with no stated reason for differing.
   */
  await runCycle({ ...cycleArgs(store, gateway, NOW), cycle: 0 });
  const scheduledAt = (await store.getCases('r1'))[0]?.nextActionAt;
  assert.ok(scheduledAt, 'cycle 0 did not schedule anything, so there is no wakeup to test');

  await runCycle({ ...cycleArgs(store, gateway, new Date(scheduledAt)), cycle: 1 });

  const refusals = (await store.getAudit('r1')).filter((a) => a.type === 'DEFERRAL_REFUSED');
  assert.equal(refusals.length, 1, 'expected exactly one named DEFERRAL_REFUSED event on the wakeup cycle');
  assert.equal(AuditType.DEFERRAL_REFUSED, 'DEFERRAL_REFUSED', 'the enum must be the single source of this type');

  const d = refusals[0].detail ?? {};
  assert.equal(d.boundBy, 'COMMITMENT');
  assert.equal(d.actionClass, ActionKind.RETRY_SCHEDULED);
  assert.ok(Number.isFinite(d.withheldCandidates) && d.withheldCandidates > 0, 'the event must say how many options were withheld');
  assert.ok(typeof d.because === 'string' && d.because.length > 20, 'the event must explain itself in prose');
});

test('over many cycles the agent acts instead of postponing: the ratio stays under a named bound', async () => {
  /**
   * THE BOUND IS PRE-REGISTERED at 3.0 postponements per attempt, against a measured 12.76 pooled
   * across five worlds. It is asserted here on a hand-built world rather than a generated one so the
   * test is fast and deterministic, and the five-world figure is measured separately by
   * `probe-commit.mjs` — a unit test cannot carry a claim about the portfolio.
   *
   * BOTH postponement types are counted. The loop lives in CASE_SCHEDULED, but `Outcome.WAIT` re-arms
   * `nextActionAt` through CASE_WAITING, and a fix that moved cases from one to the other would satisfy
   * a narrower assertion while changing nothing. Counting only the type I fixed is how I would fool
   * myself here.
   */
  const store = createMemoryStore();
  await seedCase(store, 'r1', 'evt_1');
  const gateway = stubGateway();

  const CYCLES = 10;
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await runCycle({ ...cycleArgs(store, gateway, new Date(NOW.getTime() + cycle * 12 * HOUR)), cycle });
  }

  const audit = await store.getAudit('r1');
  const postponements = audit.filter((a) => a.type === AuditType.CASE_SCHEDULED || a.type === 'CASE_WAITING').length;
  const attempts = audit.filter((a) => a.type === AuditType.ATTEMPT_STARTED).length;
  const terminal = new Set(['RECOVERED', 'RECOVERED_SELF', 'STOPPED', 'ESCALATED', 'EXPIRED']);
  const [theCase] = await store.getCases('r1');

  /**
   * Resolved-or-attempted first. A case that neither attempts nor terminates has a ratio of
   * postponements-to-zero, and asserting a ratio without asserting this would let 0 attempts and 0
   * postponements pass as a triumph.
   */
  assert.ok(
    attempts > 0 || terminal.has(theCase.state),
    `after ${CYCLES} cycles the case neither attempted anything nor reached a terminal state ` +
      `(state ${theCase.state}, ${postponements} postponements) — this is the defect verbatim`
  );

  if (attempts > 0) {
    const ratio = postponements / attempts;
    assert.ok(
      ratio < 3.0,
      `${postponements} postponements per ${attempts} attempts = ${ratio.toFixed(2)}x, over the ` +
        'pre-registered bound of 3.0'
    );
  }

  /** And the cap must have held throughout, not just at the end. */
  const perClass = new Map();
  for (const a of audit.filter((x) => x.type === AuditType.CASE_SCHEDULED)) {
    const cls = String(a.detail?.intent ?? '').split(':')[0];
    perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
  }
  for (const [cls, n] of perClass) {
    assert.ok(
      n <= POLICY.maxDeferralsPerCase,
      `class ${cls} was deferred ${n} times against a cap of ${POLICY.maxDeferralsPerCase}`
    );
  }
});

// =============================================================================================
// 4. THE TWO THINGS MUTATION TESTING FOUND NOTHING GUARDING
// =============================================================================================

test('a spent wakeup is released, so the cap is the cap and not one', async () => {
  /**
   * THIS TEST EXISTS BECAUSE A MUTATION DID NOT BITE. With the four tests above written and the fix
   * in, I deleted the orchestrator's clear-the-consumed-wakeup patch and the whole suite — 461
   * tests — stayed green. The fix was correct and completely unguarded, which is the same thing as
   * being one careless edit from wrong.
   *
   * WHAT GOES WRONG WITHOUT IT. The commitment rule fires when `deferral.wakeAt` is in the past. A
   * wakeAt left on the record stays in the past forever and `lastClass` stays set, so a case that
   * deferred once, woke, and retried could never schedule again for the rest of its life. The
   * observable damage is subtle in exactly the wrong way: nothing errors, no rule is breached, the
   * postpone:attempt ratio actually looks BETTER, and `maxDeferralsPerCase: 3` becomes a number no
   * case can reach. I would have shipped a policy of "one deferral per case, ever", reported it as a
   * cap of three, and swept the wrong knob in #58.
   *
   * The general shape, and it is the second time this project has met it: a bug that makes the
   * headline metric look better is a bug that will not be found by reading the headline metric.
   */
  const store = createMemoryStore();
  await seedCase(store, 'r1', 'evt_1');
  const gateway = stubGateway();

  const CYCLES = 10;
  const wakeAtByCycle = [];
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await runCycle({ ...cycleArgs(store, gateway, new Date(NOW.getTime() + cycle * 12 * HOUR)), cycle });
    const [c] = await store.getCases('r1');
    wakeAtByCycle.push({ cycle, state: c.state, wakeAt: c.deferral?.wakeAt ?? null });
  }

  /**
   * Directly: no cycle may end with a wakeup in its own past. That is the invariant the clear
   * maintains, and it is stronger than checking one cycle because it forbids the state from ever
   * existing rather than from existing at the moment I happened to look.
   */
  for (const { cycle, wakeAt } of wakeAtByCycle) {
    if (!wakeAt) continue;
    const cycleEndsAt = NOW.getTime() + cycle * 12 * HOUR;
    assert.ok(
      new Date(wakeAt).getTime() > cycleEndsAt,
      `cycle ${cycle} ended holding a wakeup at ${wakeAt}, which is already in its past — a spent ` +
        'wakeup that is never released bars its action class permanently'
    );
  }

  /** And behaviourally: the case scheduled more than once, so the effective cap is not 1. */
  const scheduled = (await store.getAudit('r1')).filter((a) => a.type === AuditType.CASE_SCHEDULED);
  const perClass = new Map();
  for (const a of scheduled) {
    const cls = String(a.detail?.intent ?? '').split(':')[0];
    perClass.set(cls, (perClass.get(cls) ?? 0) + 1);
  }
  const retryDeferrals = perClass.get(ActionKind.RETRY_SCHEDULED) ?? 0;
  assert.ok(
    retryDeferrals > 1,
    `the case deferred a retry ${retryDeferrals} time(s) in ${CYCLES} cycles. With a scorer that ` +
      `always prefers the near-future slot and a cap of ${POLICY.maxDeferralsPerCase}, it should ` +
      'reach the cap — exactly 1 means a spent wakeup barred the class permanently'
  );
});

test('the cap is a number that actually binds inside a run, not a number in a config file', async () => {
  /**
   * The second mutation that did not bite: raising `maxDeferralsPerCase` from 3 to 999 left all 461
   * tests green. That is CORRECT of the budget test above — it reads the cap from POLICY and asserts
   * the mechanism at whatever value it holds, which is what makes it survive #58's sweep instead of
   * having to be edited every time the knob moves.
   *
   * But it leaves nothing saying the cap is *reachable*. A backstop set beyond any realistic horizon
   * is decorative: it would appear in the config, appear in the write-up, and never once be the
   * binding constraint. So this asserts the property rather than the value — on a case that always
   * prefers to postpone, the BUDGET must bind within a 10-cycle run — which stays true if #58 sweeps
   * the cap to 2 or 5 and fails honestly if someone sets it to 999.
   */
  const store = createMemoryStore();
  await seedCase(store, 'r1', 'evt_1');
  const gateway = stubGateway();

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await runCycle({ ...cycleArgs(store, gateway, new Date(NOW.getTime() + cycle * 12 * HOUR)), cycle });
  }

  const refusals = (await store.getAudit('r1')).filter((a) => a.type === AuditType.DEFERRAL_REFUSED);
  const boundBy = refusals.map((a) => a.detail?.boundBy);

  assert.ok(
    boundBy.includes('COMMITMENT'),
    'no refusal was bound by COMMITMENT — the rule that actually fixes the loop never fired'
  );
  assert.ok(
    boundBy.includes('BUDGET'),
    `no refusal was bound by BUDGET in 10 cycles against a cap of ${POLICY.maxDeferralsPerCase}. ` +
      'The backstop is set too high to ever be the binding constraint, so it is decoration'
  );

  /**
   * Order matters and is worth pinning: COMMITMENT must fire before BUDGET. The reverse would mean
   * the case reached its lifetime cap without ever standing on its own wakeup, which is not the
   * mechanism this fix describes and would make the write-up wrong about its own agent.
   */
  assert.ok(
    boundBy.indexOf('COMMITMENT') < boundBy.indexOf('BUDGET'),
    `refusals fired in the order ${boundBy.join(', ')} — COMMITMENT is the per-wakeup rule and must ` +
      'precede the lifetime budget'
  );
});
