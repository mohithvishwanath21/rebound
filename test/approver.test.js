/**
 * THE SIMULATED APPROVER — tests for the human on the other side of the gate.
 *
 * The claim this file has to protect is narrow and easy to break by accident: the reviewer is a
 * property of the WORLD, so two policy arms that queue the same case must meet the same reviewer with
 * the same answer after the same wait. If that ever stops being true, the arm that got lucky in the
 * approval queue wins on the money column, and — this is why the tests exist rather than a comment —
 * nothing else in the eval would notice, because the queue holds the largest cases by construction.
 *
 * So the tests below are mostly about determinism and about what the reviewer is NOT allowed to know.
 * The distribution tests are secondary; a reviewer who is slightly slower than advertised is a
 * calibration problem, while a reviewer who answers per-arm is a fabricated result.
 *
 * Run: node --test test/approver.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSimApprover, sampleApproverWaitHours } from '../src/sim/approver.js';
import { percentile, mean } from '../src/core/stats.js';
import { summariseApprovals } from '../src/eval/metrics.js';
import { createMemoryStore } from '../src/db/store.js';
import { CaseState, AuditType } from '../src/agent/orchestrator.js';
import { GUARDRAILS } from '../src/core/config.js';
import { materialiseAssumptions, ASSUMPTIONS, perturbAssumptions } from '../src/sim/responseModel.js';
import { makeRng } from '../src/core/rng.js';

const A = materialiseAssumptions();
const HOUR_MS = 3_600_000;

/** 09:30 UTC = 15:00 IST — comfortably inside the reviewer's working hours. */
const NOW = new Date('2026-08-24T09:30:00Z');

/**
 * A run containing one pending approval request.
 *
 * Built by hand rather than by running a cycle, deliberately. Driving the orchestrator to produce a
 * queued case would make every assertion here depend on the decision engine, the guardrails and the
 * response model, so a failure would not tell me which of the four broke. These tests are about the
 * approver alone.
 */
async function runWithPendingApproval({ eventId = 'e1', requestedAt = NOW, amountPaise = 5_000_000 } = {}) {
  const store = createMemoryStore();
  await store.putRun({ runId: 'r1', startedAt: requestedAt, arm: 'REBOUND_EV', seed: 1, split: 'TRAIN' });
  await store.putCases([
    {
      runId: 'r1',
      eventId,
      customerId: 'c1',
      amountPaise,
      state: CaseState.AWAITING_APPROVAL,
      retriesUsed: 0,
      touchesUsed: 0,
      openedAt: requestedAt,
      approval: {
        state: 'PENDING',
        requestedAt,
        checkIds: ['APR_LARGE_AMOUNT'],
        proposedInvasiveness: 2,
        proposedAction: { kind: 'RETRY_NOW' },
      },
    },
  ]);
  return store;
}

// =================================================================================================
describe('the wait distribution', () => {
  test('is exponential with the SLA as its MEAN, hand-checked at two points', () => {
    // u = 0 -> -sla*ln(1) = 0.
    assert.equal(sampleApproverWaitHours(0, 18), 0);

    // u = 1 - 1/e = 0.632120558... -> -sla*ln(1/e) = sla exactly.
    const u = 1 - Math.exp(-1);
    assert.ok(
      Math.abs(sampleApproverWaitHours(u, 18) - 18) < 1e-9,
      'the point where the exponential CDF equals 1-1/e must return exactly the mean'
    );

    // u = 0.5 -> sla*ln(2) = 0.693*sla. The MEDIAN is well below the MEAN, which is the whole
    // reason the docblock insists on calling 18h a mean and not a promise.
    assert.ok(Math.abs(sampleApproverWaitHours(0.5, 18) - 18 * Math.LN2) < 1e-9);
    assert.ok(sampleApproverWaitHours(0.5, 18) < 18);
  });

  test('is monotonically increasing in u, so a bigger draw is never a shorter wait', () => {
    let prev = -1;
    for (let u = 0; u < 1; u += 0.01) {
      const w = sampleApproverWaitHours(u, 18);
      assert.ok(w > prev, `wait must increase with u; at u=${u} got ${w} after ${prev}`);
      prev = w;
    }
  });

  test('has a tail that reaches past the grant validity window — that path must be reachable', () => {
    /**
     * Not a curiosity. `GUARDRAILS.approvalValidForHours` is 72 and the mean SLA is 18, so a reader
     * could reasonably assume expiry never fires in simulation and the expiry branch is dead code
     * tested only by a unit test. It is not: at u = 0.99 the wait is 4.6x the mean.
     */
    const extreme = sampleApproverWaitHours(0.99, 18);
    assert.ok(extreme > GUARDRAILS.approvalValidForHours, `expected the tail to exceed 72h, got ${extreme}`);
  });

  test('the realised mean over many draws lands near the declared SLA', () => {
    const rng = makeRng('wait-mean');
    const draws = Array.from({ length: 20_000 }, () => sampleApproverWaitHours(rng.next(), 18));
    const m = mean(draws);
    assert.ok(Math.abs(m - 18) < 0.6, `expected a mean near 18h over 20k draws, got ${m.toFixed(3)}`);
    // And the median should sit near 18*ln2 = 12.48, NOT near 18.
    const p50 = percentile(draws, 50);
    assert.ok(Math.abs(p50 - 18 * Math.LN2) < 0.5, `expected a median near 12.5h, got ${p50.toFixed(3)}`);
  });
});

// =================================================================================================
describe('what the approver refuses to be constructed without', () => {
  test('throws without a materialised assumption set', () => {
    assert.throws(
      () => createSimApprover({ seed: 1 }),
      /requires a materialised assumption set/,
      'a default assumption set here would make the sensitivity sweep run every arm against the ' +
        'same approver while reporting that it varied one'
    );
  });

  test('throws when the SLA is not comfortably inside the grant validity window', () => {
    /**
     * The constraint this catches spans two files — the SLA is in ASSUMPTIONS, the validity window is
     * in GUARDRAILS — and the sweep moves one of them. Without this guard, pushing the SLA past 36h
     * would have most grants expire before the agent could use them, cases would cycle between the
     * queue and expiry, and the run would still print a tidy recovery figure.
     */
    assert.throws(
      () => createSimApprover({ seed: 1, assumptions: { ...A, approverSlaHours: 40 } }),
      /not comfortably inside/,
      'a mean SLA of 40h against a 72h validity window must be rejected'
    );

    // And the boundary is not off by one: exactly half the window is permitted.
    assert.doesNotThrow(() =>
      createSimApprover({ seed: 1, assumptions: { ...A, approverSlaHours: GUARDRAILS.approvalValidForHours / 2 } })
    );
  });

  test('the DECLARED sweep range for the SLA stays inside what the guard permits', () => {
    /**
     * A guard that throws in the middle of a sweep is a broken sweep, not a caught bug. So the
     * declared range and the guard have to be consistent, and this asserts it rather than trusting
     * that I checked once. `perturbAssumptions` at factor 1.0 explores each declared range fully.
     */
    const rng = makeRng('sla-sweep');
    for (let i = 0; i < 500; i += 1) {
      const perturbed = perturbAssumptions(A, 1.0, rng);
      assert.doesNotThrow(
        () => createSimApprover({ seed: 1, assumptions: perturbed }),
        `perturbed SLA of ${perturbed.approverSlaHours}h was rejected by the approver's own guard — ` +
          'ASSUMPTIONS.approverSlaHours.sweep and the guard disagree'
      );
    }
  });

  test('the SLA sweep bound is DERIVED from the guard, not a second hardcoded number', () => {
    /**
     * This is the regression pin for a bug this file caught on its first run. The declared sweep was
     * `[6, 48]`, chosen by eye, while `createSimApprover` rejects any mean SLA above half the grant
     * validity window — 36h. So the sweep asked for worlds the guard exists to refuse, and the
     * sensitivity run would have died partway through with a config error rather than a result.
     *
     * Asserting the RELATIONSHIP rather than the number 36 is the whole point: if somebody raises
     * `approvalValidForHours` to 120, the sweep should follow to 60 on its own, and if somebody
     * replaces the derived bound with a literal again, this fails.
     */
    const [lo, hi] = ASSUMPTIONS.approverSlaHours.sweep;
    assert.equal(hi, GUARDRAILS.approvalValidForHours / 2);
    assert.ok(lo < ASSUMPTIONS.approverSlaHours.value, 'the sweep must bracket the value from below');

    // And the top of the sweep must be exactly permitted — the guard's boundary, not one step past it.
    assert.doesNotThrow(() =>
      createSimApprover({ seed: 1, assumptions: { ...A, approverSlaHours: hi } })
    );
    assert.throws(
      () => createSimApprover({ seed: 1, assumptions: { ...A, approverSlaHours: hi * 1.01 } }),
      /not comfortably inside/
    );
  });
});

// =================================================================================================
describe('the reviewer is arm-blind and deterministic', () => {
  test('the same case gets the same verdict and the same wait, every time it is asked', () => {
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const first = approver.dispositionFor('e_abc');
    for (let i = 0; i < 5; i += 1) {
      assert.deepEqual(approver.dispositionFor('e_abc'), first, 'the reviewer must not drift between calls');
    }
  });

  test('two approvers built for the SAME world agree, which is what pairs the arms', () => {
    /**
     * This is the invariant in miniature. `runArm` builds a fresh approver per arm — it has to, each
     * arm gets its own store — so the pairing rests entirely on the seed being a function of the world
     * and not of the arm. Two independently constructed approvers for one world must be identical.
     */
    const a1 = createSimApprover({ seed: 7, assumptions: A });
    const a2 = createSimApprover({ seed: 7, assumptions: A });
    for (const id of ['e1', 'e2', 'e3', 'e_big', 'e_zzz']) {
      assert.deepEqual(a1.dispositionFor(id), a2.dispositionFor(id), `disagreement on ${id}`);
    }
  });

  test('different worlds get different reviewers, or the sweep would measure one draw', () => {
    const a1 = createSimApprover({ seed: 1, assumptions: A });
    const a2 = createSimApprover({ seed: 2, assumptions: A });
    const ids = Array.from({ length: 40 }, (_, i) => `e${i}`);
    const differ = ids.filter((id) => a1.dispositionFor(id).waitHours !== a2.dispositionFor(id).waitHours);
    assert.ok(differ.length > 30, `expected most cases to draw differently across seeds, got ${differ.length}/40`);
  });

  test('the empirical grant rate matches the declared one', () => {
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const ids = Array.from({ length: 4000 }, (_, i) => `e_${i}`);
    const granted = ids.filter((id) => approver.dispositionFor(id).grant).length;
    const observed = granted / ids.length;
    assert.ok(
      Math.abs(observed - A.approvalGrantRate) < 0.03,
      `expected roughly ${A.approvalGrantRate}, got ${observed.toFixed(3)} over 4000 cases`
    );
  });

  test('a grant rate of 0 denies everything and 1 grants everything', () => {
    // The endpoints matter because the sweep pushes toward them and a clamp bug would be silent.
    const none = createSimApprover({ seed: 1, assumptions: { ...A, approvalGrantRate: 0 } });
    const all = createSimApprover({ seed: 1, assumptions: { ...A, approvalGrantRate: 1 } });
    const ids = Array.from({ length: 50 }, (_, i) => `e_${i}`);
    assert.equal(ids.filter((id) => none.dispositionFor(id).grant).length, 0);
    assert.equal(ids.filter((id) => all.dispositionFor(id).grant).length, 50);
  });
});

// =================================================================================================
describe('the reviewer works business hours', () => {
  test('an answer that lands at 00:30 IST is deferred to 09:00 IST', () => {
    const approver = createSimApprover({ seed: 1, assumptions: A });
    // 14:00 UTC = 19:30 IST. A 5-hour wait lands at 00:30 IST, inside quiet hours.
    const requestedAt = new Date('2026-08-24T14:00:00Z');
    const decided = approver.decidedAtFor(requestedAt, 5);
    // 09:00 IST on the 25th = 03:30 UTC on the 25th.
    assert.equal(decided.toISOString(), '2026-08-25T03:30:00.000Z');
  });

  test('an answer already inside working hours is not moved at all', () => {
    const approver = createSimApprover({ seed: 1, assumptions: A });
    // 05:00 UTC = 10:30 IST; +4h = 14:30 IST, a normal working afternoon.
    const requestedAt = new Date('2026-08-24T05:00:00Z');
    const decided = approver.decidedAtFor(requestedAt, 4);
    assert.equal(decided.toISOString(), '2026-08-24T09:00:00.000Z');
  });

  test('the working window is the COMPLEMENT of the configured quiet hours, not a second copy', () => {
    /**
     * Moving quiet hours must move the reviewer. If this test fails, someone has hard-coded 09:00-21:00
     * into the approver, and a future change to the customer-contact window would leave the reviewer
     * working hours that no longer exist in the config.
     */
    const approver = createSimApprover({
      seed: 1,
      assumptions: A,
      guardrails: { ...GUARDRAILS, quietHours: { startHour: 12, endHour: 18, timezone: 'Asia/Kolkata' } },
    });
    // 08:00 UTC = 13:30 IST, now inside the moved window; the answer must be pushed to 18:00 IST.
    const decided = approver.decidedAtFor(new Date('2026-08-24T08:00:00Z'), 0);
    assert.equal(decided.toISOString(), '2026-08-24T12:30:00.000Z'); // 18:00 IST
  });
});

// =================================================================================================
describe('resolvePending', () => {
  test('does nothing before the reviewer has got to it', async () => {
    const store = await runWithPendingApproval({ eventId: 'e_slow' });
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const { waitHours } = approver.dispositionFor('e_slow');
    assert.ok(waitHours > 0.5, 'fixture assumes a non-trivial draw; pick another eventId if this fails');

    const out = await approver.resolvePending({ store, runId: 'r1', now: NOW });
    assert.deepEqual(out.resolved, [], 'a request must not be answered before its wait has elapsed');
    const c = await store.getCase('r1', 'e_slow');
    assert.equal(c.state, CaseState.AWAITING_APPROVAL, 'and the case must stay in the queue');
  });

  test('resolves once the wait has elapsed, and records the reviewer time not the cycle time', async () => {
    const store = await runWithPendingApproval({ eventId: 'e_slow' });
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const { waitHours, grant } = approver.dispositionFor('e_slow');
    const decidedAt = approver.decidedAtFor(NOW, waitHours);

    // A cycle far past the reviewer's answer.
    const later = new Date(decidedAt.getTime() + 30 * HOUR_MS);
    const out = await approver.resolvePending({ store, runId: 'r1', now: later });

    assert.equal(out.resolved.length, 1);
    assert.equal(out.resolved[0].state, grant ? 'GRANTED' : 'DENIED');

    const audit = await store.getAudit('r1');
    const entry = audit.find(
      (a) => a.type === AuditType.APPROVAL_GRANTED || a.type === AuditType.APPROVAL_DENIED
    );
    /**
     * THE POINT OF THIS ASSERTION. The cycle grid is 12h wide, so recording `now` would overstate the
     * wait by up to a cycle AND start the grant's expiry clock late — a stale authorisation would then
     * read as fresh. The trail must carry the instant the human decided.
     */
    assert.equal(new Date(entry.at).toISOString(), decidedAt.toISOString());
    assert.notEqual(new Date(entry.at).toISOString(), later.toISOString());
  });

  test('is idempotent — a second call resolves nothing', async () => {
    const store = await runWithPendingApproval({ eventId: 'e_slow' });
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const later = new Date(NOW.getTime() + 500 * HOUR_MS);

    const first = await approver.resolvePending({ store, runId: 'r1', now: later });
    const second = await approver.resolvePending({ store, runId: 'r1', now: later });
    assert.equal(first.resolved.length, 1);
    assert.deepEqual(second.resolved, [], 'the second pass must find nothing PENDING left to answer');
  });

  test('a grant returns the case to OPEN so the agent RE-DECIDES; a denial is terminal', async () => {
    /**
     * Both branches, in one test, driven by picking eventIds whose draws differ — rather than by
     * stubbing the RNG. Stubbing would let the production seeding break without this test noticing.
     */
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const ids = Array.from({ length: 60 }, (_, i) => `e_${i}`);
    const granted = ids.find((id) => approver.dispositionFor(id).grant);
    const denied = ids.find((id) => !approver.dispositionFor(id).grant);
    assert.ok(granted && denied, 'need one of each to test both branches');

    for (const [id, expectGrant] of [[granted, true], [denied, false]]) {
      const store = await runWithPendingApproval({ eventId: id });
      const later = new Date(NOW.getTime() + 500 * HOUR_MS);
      await approver.resolvePending({ store, runId: 'r1', now: later });
      const c = await store.getCase('r1', id);
      if (expectGrant) {
        assert.equal(c.state, CaseState.OPEN, 'a grant must not execute the stale proposal — it re-decides');
        assert.equal(c.nextActionAt, null, 'and the case must be DUE on the next cycle');
        assert.equal(c.approval.state, 'GRANTED');
        assert.ok(c.approval.grantedAt, 'the expiry clock needs a start instant');
      } else {
        assert.equal(c.state, CaseState.STOPPED, 'a denial closes the case rather than re-proposing cheaper');
        assert.equal(c.stop.code, 'APPROVAL_DENIED');
      }
    }
  });

  test('names the approver in the audit trail, because that is the only thing the record is for', async () => {
    const store = await runWithPendingApproval({ eventId: 'e_slow' });
    const approver = createSimApprover({ seed: 1, assumptions: A });
    await approver.resolvePending({ store, runId: 'r1', now: new Date(NOW.getTime() + 500 * HOUR_MS) });
    const audit = await store.getAudit('r1');
    const entry = audit.find(
      (a) => a.type === AuditType.APPROVAL_GRANTED || a.type === AuditType.APPROVAL_DENIED
    );
    assert.equal(entry.detail.by, 'sim-approver');
    assert.match(entry.detail.note, /simulated reviewer/);
    assert.ok(Number.isFinite(entry.detail.waitedHours), 'the trail must show how long the human took');
  });

  test('leaves alone every case that is not a PENDING request', async () => {
    const store = await runWithPendingApproval({ eventId: 'e_pending' });
    await store.putCases([
      { runId: 'r1', eventId: 'e_open', customerId: 'c2', amountPaise: 100, state: CaseState.OPEN, openedAt: NOW },
      {
        runId: 'r1', eventId: 'e_paid', customerId: 'c3', amountPaise: 100, state: CaseState.RECOVERED_SELF,
        openedAt: NOW, approval: { state: 'PENDING', requestedAt: NOW },
      },
    ]);
    const approver = createSimApprover({ seed: 1, assumptions: A });
    const out = await approver.resolvePending({ store, runId: 'r1', now: new Date(NOW.getTime() + 500 * HOUR_MS) });

    assert.deepEqual(out.resolved.map((r) => r.eventId), ['e_pending']);
    /**
     * `e_paid` is the interesting one: it carries a stale PENDING approval but the customer has
     * already paid. Granting it would drag a terminal case back into play and hand the policy a case
     * the world has finished with. The state check, not the approval check, is what stops that.
     */
    assert.equal((await store.getCase('r1', 'e_paid')).state, CaseState.RECOVERED_SELF);
  });
});

// =================================================================================================
describe('summariseApprovals', () => {
  const caseRec = (eventId, state, approvalState, amountPaise) => ({
    eventId, state, amountPaise, approval: approvalState ? { state: approvalState } : undefined,
  });

  test('counts the queue from the records, hand-computed', () => {
    const cases = [
      caseRec('a', CaseState.AWAITING_APPROVAL, 'PENDING', 10_000),
      caseRec('b', CaseState.AWAITING_APPROVAL, 'PENDING', 30_000),
      caseRec('c', CaseState.OPEN, 'GRANTED', 50_000),
      caseRec('d', CaseState.STOPPED, 'DENIED', 70_000),
      caseRec('e', CaseState.OPEN, null, 90_000),
    ];
    const audit = [
      { type: AuditType.APPROVAL_REQUESTED }, { type: AuditType.APPROVAL_REQUESTED },
      { type: AuditType.APPROVAL_REQUESTED }, { type: AuditType.APPROVAL_REQUESTED },
      { type: AuditType.APPROVAL_GRANTED, detail: { waitedHours: 4 } },
      { type: AuditType.APPROVAL_DENIED, detail: { waitedHours: 20 } },
    ];
    const s = summariseApprovals({ cases, audit });

    assert.equal(s.requested, 4);
    assert.equal(s.granted, 1);
    assert.equal(s.denied, 1);
    assert.equal(s.pendingAtEnd, 2);
    assert.equal(s.frozenPaise, 40_000, '10,000 + 30,000 still waiting for a human');
    assert.equal(s.grantedPaise, 50_000);
    assert.equal(s.deniedPaise, 70_000, 'exposure the human permanently barred');
    assert.equal(s.accountsFor, true, '1 + 1 + 2 = 4 <= 4 requests');
  });

  test('an INEQUALITY, not an equality — a re-queued case is the approval design working', () => {
    /**
     * Two requests, one resolution, nothing pending: the first grant's envelope expired and the case
     * came back for a fresh signature, which is exactly what `resolveApproval`'s envelope design
     * intends. Asserting equality here would have failed the first time the expiry path fired and
     * would have looked like a bug in the approver.
     */
    const cases = [caseRec('a', CaseState.OPEN, 'GRANTED', 10_000)];
    const audit = [
      { type: AuditType.APPROVAL_REQUESTED }, { type: AuditType.APPROVAL_REQUESTED },
      { type: AuditType.APPROVAL_GRANTED, detail: { waitedHours: 3 } },
    ];
    assert.equal(summariseApprovals({ cases, audit }).accountsFor, true);
  });

  test('catches double-resolution, which is what the idempotency guard exists to prevent', () => {
    const cases = [
      caseRec('a', CaseState.OPEN, 'GRANTED', 10_000),
      caseRec('b', CaseState.STOPPED, 'DENIED', 10_000),
      caseRec('c', CaseState.AWAITING_APPROVAL, 'PENDING', 10_000),
    ];
    const audit = [{ type: AuditType.APPROVAL_REQUESTED }, { type: AuditType.APPROVAL_REQUESTED }];
    assert.equal(
      summariseApprovals({ cases, audit }).accountsFor,
      false,
      '3 resolutions against 2 requests cannot happen and must be flagged'
    );
  });

  test('reports null waits rather than zero when nothing was ever approved', () => {
    /**
     * Zero would read as instant approval, which is the opposite of the truth. Every consumer has to
     * distinguish "no approvals happened" from "approvals were fast", and null forces that.
     */
    const s = summariseApprovals({ cases: [caseRec('a', CaseState.OPEN, null, 100)], audit: [] });
    assert.equal(s.waitHoursP50, null);
    assert.equal(s.waitHoursMax, null);
    assert.equal(s.frozenPaise, 0);
  });

  test('reads the wait from the AUDIT DETAIL, so a wrong recorded instant is visible', () => {
    const s = summariseApprovals({
      cases: [],
      audit: [
        { type: AuditType.APPROVAL_GRANTED, detail: { waitedHours: 1 } },
        { type: AuditType.APPROVAL_GRANTED, detail: { waitedHours: 9 } },
        { type: AuditType.APPROVAL_DENIED, detail: { waitedHours: 5 } },
        { type: AuditType.APPROVAL_DENIED, detail: { waitedHours: null } }, // dropped, not counted as 0
      ],
    });
    assert.equal(s.waitHoursP50, 5, 'sorted 1,5,9 — nearest-rank p50 is 5');
    assert.equal(s.waitHoursMax, 9);
  });
});

// =================================================================================================
describe('percentile', () => {
  test('is nearest-rank, hand-computed, and never invents a value', () => {
    const v = [10, 20, 30, 40];
    assert.equal(percentile(v, 50), 20, 'ceil(0.5*4)=2 -> index 1 -> 20, NOT the interpolated 25');
    assert.equal(percentile(v, 90), 40);
    assert.equal(percentile(v, 100), 40, 'p100 is the max, so callers need no second code path');
    assert.equal(percentile(v, 0), 10, 'p0 clamps to the first element rather than index -1');
  });

  test('does not mutate its input', () => {
    const v = [3, 1, 2];
    percentile(v, 50);
    assert.deepEqual(v, [3, 1, 2], 'sorting in place would silently reorder a caller\'s array');
  });

  test('returns null on empty, and mean does too', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(mean([]), null);
  });
});

// =================================================================================================
describe('the assumptions are declared, not hidden', () => {
  test('both approver assumptions carry a basis and a numeric sweep range', () => {
    for (const key of ['approverSlaHours', 'approvalGrantRate']) {
      const spec = ASSUMPTIONS[key];
      assert.ok(spec, `${key} must be a declared assumption so npm run describe-sim prints it`);
      assert.match(spec.basis, /JUDGEMENT/, `${key} is a judgement call and must say so`);
      assert.ok(Array.isArray(spec.sweep) && spec.sweep.length === 2, `${key} needs a numeric sweep range`);
      const [lo, hi] = spec.sweep;
      assert.ok(lo < spec.value && spec.value < hi, `${key}'s declared value must sit inside its sweep`);
    }
  });

  test('the grant rate sweep never reaches 1.0 — no run in the sweep gets a rubber stamp', () => {
    /**
     * A reviewer who always says yes would let this project claim human oversight while demonstrating
     * none, and it would raise every arm's money at once so the table would still look sane.
     */
    assert.ok(ASSUMPTIONS.approvalGrantRate.sweep[1] < 1.0);
  });

  test('materialiseAssumptions surfaces both, or the approver would be unreachable by the sweep', () => {
    assert.equal(typeof A.approverSlaHours, 'number');
    assert.equal(typeof A.approvalGrantRate, 'number');
  });

  test('perturbAssumptions moves both, and keeps the grant rate a probability', () => {
    const rng = makeRng('perturb-approver');
    let movedSla = 0;
    let movedRate = 0;
    for (let i = 0; i < 200; i += 1) {
      const p = perturbAssumptions(A, 1.0, rng);
      if (p.approverSlaHours !== A.approverSlaHours) movedSla += 1;
      if (p.approvalGrantRate !== A.approvalGrantRate) movedRate += 1;
      assert.ok(p.approvalGrantRate >= 0 && p.approvalGrantRate <= 1);
      assert.ok(p.approverSlaHours >= 0.5, 'an instantaneous reviewer is the absence of the gate, not a perturbation');
    }
    assert.ok(movedSla > 190, `the sweep must actually move the SLA; moved ${movedSla}/200`);
    assert.ok(movedRate > 190, `the sweep must actually move the grant rate; moved ${movedRate}/200`);
  });
});
