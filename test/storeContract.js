/**
 * THE STORE CONTRACT.
 *
 * Exported as a function so both store implementations run the *same* assertions. This
 * is the whole point: the in-memory store is what produces the numbers in the README,
 * and the Mongo store is what runs behind the dashboard. If they disagree, one of those
 * two things is a lie and I will not be able to tell which.
 *
 * The contact-ledger and idempotency cases matter most. Both are controls rather than
 * features — one caps how often a customer can be messaged, the other stops a restart
 * from charging someone twice — so a portability gap in either is a compliance defect
 * that would show up in production and not in evaluation.
 *
 * Usage:
 *   import { runStoreContract } from './storeContract.js';
 *   runStoreContract('memory', async () => createMemoryStore());
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

export function runStoreContract(label, makeStore) {
  const T = (name, fn) => test(`[${label}] ${name}`, fn);

  T('world objects round-trip', async () => {
    const s = await makeStore();
    await s.putBatch({ batchId: 'b1', seed: 42, split: 'TRAIN' });
    await s.putCustomers([{ customerId: 'c1', segment: 'B2C' }, { customerId: 'c2', segment: 'B2B' }]);
    await s.putEvents([
      { eventId: 'e1', batchId: 'b1', customerId: 'c1', amountPaise: 100000 },
      { eventId: 'e2', batchId: 'b1', customerId: 'c2', amountPaise: 250000 },
    ]);

    assert.equal((await s.getBatch('b1')).seed, 42);
    assert.equal(await s.getBatch('nope'), null);
    assert.equal((await s.getCustomer('c2')).segment, 'B2B');
    assert.equal((await s.getEvents('b1')).length, 2);
    assert.equal((await s.getEvent('e1')).amountPaise, 100000);
    assert.deepEqual(await s.getEvents('other-batch'), []);
  });

  T('rejects non-integer money at the boundary', async () => {
    const s = await makeStore();
    await assert.rejects(
      () => s.putEvents([{ eventId: 'bad', batchId: 'b1', amountPaise: 1234.56 }]),
      /paise|integer/i,
      'a fractional paise amount must not be storable'
    );
  });

  T('reads are isolated from later caller mutation', async () => {
    const s = await makeStore();
    await s.putBatch({ batchId: 'b1', params: { customers: 220 } });

    const first = await s.getBatch('b1');
    first.params.customers = 999;

    const second = await s.getBatch('b1');
    assert.equal(second.params.customers, 220, 'mutating a read result must not affect the store');
  });

  T('patch supports dotted paths and leaves siblings alone', async () => {
    const s = await makeStore();
    await s.putCases([{
      runId: 'r1', eventId: 'e1', state: 'OPEN',
      retriesUsed: 0, touchesUsed: 0,
      diagnosis: { rootCause: 'UNKNOWN', confidence: 0.2, source: 'FALLBACK' },
    }]);

    await s.patchCase('r1', 'e1', {
      state: 'DIAGNOSED',
      'diagnosis.rootCause': 'EXPIRED_INSTRUMENT',
      'diagnosis.confidence': 0.91,
    });

    const c = await s.getCase('r1', 'e1');
    assert.equal(c.state, 'DIAGNOSED');
    assert.equal(c.diagnosis.rootCause, 'EXPIRED_INSTRUMENT');
    assert.equal(c.diagnosis.confidence, 0.91);
    assert.equal(c.diagnosis.source, 'FALLBACK', 'unmentioned sibling fields must survive');
    assert.equal(c.retriesUsed, 0);
  });

  T('patch creates missing intermediate objects', async () => {
    const s = await makeStore();
    await s.putCases([{ runId: 'r1', eventId: 'e1', state: 'OPEN' }]);
    await s.patchCase('r1', 'e1', { 'approval.state': 'PENDING', 'approval.requestedAt': new Date(0) });
    const c = await s.getCase('r1', 'e1');
    assert.equal(c.approval.state, 'PENDING');
  });

  T('patching an unknown case is an error, not a silent no-op', async () => {
    const s = await makeStore();
    await assert.rejects(() => s.patchCase('r1', 'ghost', { state: 'RECOVERED' }));
    await assert.rejects(() => s.patchRun('ghost', { state: 'DONE' }));
  });

  T('active and due case filtering excludes terminal states', async () => {
    const s = await makeStore();
    const now = new Date('2026-08-22T10:00:00Z');
    const later = new Date('2026-08-23T10:00:00Z');

    await s.putCases([
      { runId: 'r1', eventId: 'e1', state: 'OPEN' },
      { runId: 'r1', eventId: 'e2', state: 'SCHEDULED', nextActionAt: later },
      { runId: 'r1', eventId: 'e3', state: 'RECOVERED' },
      { runId: 'r1', eventId: 'e4', state: 'STOPPED' },
      { runId: 'r1', eventId: 'e5', state: 'ESCALATED' },
      { runId: 'r1', eventId: 'e6', state: 'EXPIRED' },
      { runId: 'r2', eventId: 'e7', state: 'OPEN' },
    ]);

    const active = await s.getActiveCases('r1');
    assert.deepEqual(active.map((c) => c.eventId).sort(), ['e1', 'e2'], 'terminal states are not active');

    const dueNow = await s.getDueCases('r1', now);
    assert.deepEqual(dueNow.map((c) => c.eventId), ['e1'], 'a case scheduled for tomorrow is not due now');

    const dueLater = await s.getDueCases('r1', later);
    assert.deepEqual(dueLater.map((c) => c.eventId).sort(), ['e1', 'e2']);

    assert.equal((await s.getCases('r2')).length, 1, 'runs are isolated from each other');
  });

  T('idempotency key rejects a replayed action', async () => {
    const s = await makeStore();
    const action = {
      runId: 'r1', eventId: 'e1', kind: 'SEND_LINK',
      idempotencyKey: 'r1:e1:0:SEND_LINK:SMS',
      costPaise: 25,
    };

    assert.equal(await s.putAction(action), true, 'first write succeeds');
    assert.equal(await s.putAction(action), false, 'replay is rejected');
    assert.equal(await s.putAction({ ...action, costPaise: 999 }), false,
      'rejection is keyed on the idempotency key, not the payload');
    assert.equal((await s.getActions('r1')).length, 1, 'only one action was actually recorded');

    assert.equal(await s.putAction({ ...action, idempotencyKey: 'r1:e1:1:SEND_LINK:SMS' }), true,
      'a genuinely new decision sequence is allowed');
    assert.equal((await s.getActions('r1')).length, 2);
  });

  T('an action without an idempotency key is refused', async () => {
    const s = await makeStore();
    await assert.rejects(() => s.putAction({ runId: 'r1', eventId: 'e1', kind: 'RETRY_NOW' }),
      /idempotencyKey/);
  });

  T('contact ledger counts within the window and excludes what falls outside', async () => {
    const s = await makeStore();
    const day = 24 * 60 * 60 * 1000;
    const now = new Date('2026-08-22T10:00:00Z');

    await s.recordContact({ customerId: 'c1', channel: 'SMS', sentAt: new Date(now - 1 * day) });
    await s.recordContact({ customerId: 'c1', channel: 'EMAIL', sentAt: new Date(now - 5 * day) });
    await s.recordContact({ customerId: 'c1', channel: 'SMS', sentAt: new Date(now - 9 * day) });
    await s.recordContact({ customerId: 'c2', channel: 'SMS', sentAt: new Date(now - 1 * day) });

    const since7 = new Date(now - 7 * day);
    assert.equal(await s.countContactsSince('c1', since7), 2, 'the 9-day-old contact is outside the window');
    assert.equal(await s.countContactsSince('c2', since7), 1, 'counts are per customer');
    assert.equal(await s.countContactsSince('c3', since7), 0);

    // Boundary: a contact exactly at the window edge counts as inside. Chosen so the cap
    // errs toward being MORE restrictive — under-messaging is a missed rupee, while
    // over-messaging is a consent violation, and those are not symmetric costs.
    const exact = new Date(now - 5 * day);
    assert.equal(await s.countContactsSince('c1', exact), 2,
      'a contact exactly on the boundary is counted, so the cap never rounds in favour of sending');
  });

  T('audit is append-only and ordered', async () => {
    const s = await makeStore();
    for (const type of ['RUN_STARTED', 'CASE_DIAGNOSED', 'ACTION_BLOCKED', 'CASE_STOPPED']) {
      await s.appendAudit({ runId: 'r1', eventId: 'e1', type, at: new Date() });
    }
    await s.appendAudit({ runId: 'r1', eventId: 'e2', type: 'CASE_DIAGNOSED', at: new Date() });
    await s.appendAudit({ runId: 'r2', eventId: 'e9', type: 'RUN_STARTED', at: new Date() });

    const all = await s.getAudit('r1');
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((a) => a.seq), [0, 1, 2, 3, 4], 'entries carry a monotonic sequence');

    assert.equal((await s.getAudit('r1', { eventId: 'e1' })).length, 4);
    assert.equal((await s.getAudit('r1', { type: 'CASE_DIAGNOSED' })).length, 2);
    assert.equal((await s.getAudit('r1', { eventId: 'e1', type: 'CASE_DIAGNOSED' })).length, 1);
    assert.equal((await s.getAudit('r2')).length, 1, 'audit is scoped per run');

    // There must be no way to rewrite history. If a future refactor adds one, this fails.
    for (const forbidden of ['updateAudit', 'deleteAudit', 'removeAudit', 'clearAudit']) {
      assert.equal(typeof s[forbidden], 'undefined', `store must not expose ${forbidden}`);
    }
  });

  T('decisions are returned in decision order', async () => {
    const s = await makeStore();
    for (const seq of [2, 0, 1]) {
      await s.putDecision({ runId: 'r1', eventId: 'e1', decisionSeq: seq, chosen: { kind: 'RETRY_NOW' } });
    }
    await s.putDecision({ runId: 'r1', eventId: 'e2', decisionSeq: 0, chosen: { kind: 'STOP_PERMANENT' } });

    const d = await s.getDecisions('r1', 'e1');
    assert.deepEqual(d.map((x) => x.decisionSeq), [0, 1, 2]);
    assert.equal((await s.getDecisions('r1')).length, 4, 'omitting eventId returns the whole run');
  });

  T('runs list newest first', async () => {
    const s = await makeStore();
    await s.putRun({ runId: 'r1', startedAt: new Date('2026-08-20T00:00:00Z'), arm: 'B1_NAIVE_RETRY' });
    await s.putRun({ runId: 'r2', startedAt: new Date('2026-08-22T00:00:00Z'), arm: 'REBOUND_EV' });
    await s.putRun({ runId: 'r3', startedAt: new Date('2026-08-21T00:00:00Z'), arm: 'B0_DO_NOTHING' });

    assert.deepEqual((await s.listRuns()).map((r) => r.runId), ['r2', 'r3', 'r1']);

    await s.patchRun('r1', { 'metrics.recoveredPaise': 500000, state: 'DONE' });
    const r1 = await s.getRun('r1');
    assert.equal(r1.metrics.recoveredPaise, 500000);
    assert.equal(r1.arm, 'B1_NAIVE_RETRY', 'patching metrics does not disturb the arm');
  });
}
