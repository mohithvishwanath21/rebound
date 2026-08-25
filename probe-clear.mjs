/** Throwaway: what is the schedule/act pattern over 10 cycles, and is deferral.wakeAt cleared? */
import { runCycle, AuditType, CaseState } from './src/agent/orchestrator.js';
import { createMemoryStore } from './src/db/store.js';
import { ActionKind, MONEY_MOVING } from './src/core/actions.js';
import { GUARDRAILS, POLICY } from './src/core/config.js';
import { ReceiptState, validateActionRequest } from './src/razorpay/gateway.js';

const CONFIG = { GUARDRAILS, POLICY };
const NOW = new Date('2026-08-24T09:30:00Z');
const HOUR = 3_600_000;
const observed = (over = {}) => ({
  eventId: 'evt_1', customerId: 'cust_1', amountPaise: 1_600_000, lossType: 'FAILED_PAYMENT',
  occurredAt: '2026-08-22T09:30:00Z', detectedAt: '2026-08-22T09:30:00Z', rail: 'CARD',
  errorCode: 'insufficient_funds', ...over,
});
const FIRM = { rootCause: 'INSUFFICIENT_FUNDS', source: 'RULE', matchTier: 'CODE', matchedOn: 'reason_code',
  abstained: false, requiresApprovalForMoneyMovement: false, physics: { retryCanSucceed: true, humanOnly: false },
  explanation: 'x' };
const score = () => ({ action }) => {
  const d = action.kind === ActionKind.RETRY_SCHEDULED && action.scheduledFor
    ? Math.max(0, (new Date(action.scheduledFor).getTime() - NOW.getTime()) / 86_400_000) : 0;
  const u = d / 0.25;
  return { p: MONEY_MOVING.has(action.kind) ? 0.12 + 0.06 * (u / (1 + u * u)) : 0.1, support: { state: 'SUPPORTED', rows: 500 } };
};
const store = createMemoryStore();
await store.putRun({ runId: 'r1', startedAt: NOW, arm: 'REBOUND_EV' });
await store.putCases([{ runId: 'r1', eventId: 'evt_1', customerId: 'cust_1', state: CaseState.OPEN,
  retriesUsed: 0, touchesUsed: 0, amountPaise: 1_600_000,
  customer: { customerId: 'cust_1', email: 'x@example.invalid', phone: '+919000000000' },
  event: { eventId: 'evt_1', amountPaise: 1_600_000, lossType: 'FAILED_PAYMENT', occurredAt: '2026-08-22T09:30:00Z', rail: 'CARD' } }]);
const gw = () => { const calls = []; const run = async (req) => { validateActionRequest(req); calls.push(req);
  return { mode: 'SIM', actionKind: req.action.kind, reference: `ref_${calls.length}`, state: ReceiptState.FAILED,
    amountPaise: req.amountPaise, amountCollectedPaise: 0, providerRef: `o_${calls.length}`, at: NOW.toISOString(), caveats: ['STUB'] }; };
  return { mode: 'SIM', calls, retryCharge: run, sendPaymentLink: run, requestReauth: run,
    fetchStatus: async ({ providerRef }) => ({ kind: 'ORDER', providerRef, state: ReceiptState.ATTEMPTED, providerStatus: 'created', amountPaidPaise: 0 }),
    close: async () => {} }; };
const gateway = gw();
for (let cycle = 0; cycle < 10; cycle += 1) {
  const at = new Date(NOW.getTime() + cycle * 12 * HOUR);
  await runCycle({ store, gateway, runId: 'r1', now: at, cycle, config: CONFIG, scoreAction: score(),
    observeCase: (c) => observed({ eventId: c.eventId, customerId: c.customerId, amountPaise: c.amountPaise }),
    diagnoseCase: () => FIRM });
  const [c] = await store.getCases('r1');
  console.log(`cycle ${cycle} @${at.toISOString().slice(5, 16)}  state=${String(c.state).padEnd(10)} ` +
    `wakeAt=${String(c.deferral?.wakeAt ? new Date(c.deferral.wakeAt).toISOString().slice(5, 16) : null).padEnd(12)} ` +
    `lastClass=${String(c.deferral?.lastClass).padEnd(16)} counts=${JSON.stringify(c.deferral?.counts ?? {})} retries=${c.retriesUsed}`);
}
const audit = await store.getAudit('r1');
const tally = {};
for (const a of audit) tally[a.type] = (tally[a.type] ?? 0) + 1;
console.log('\naudit:', tally);
console.log('\nrefusals:');
for (const a of audit.filter((x) => x.type === 'DEFERRAL_REFUSED')) {
  console.log(`  cycle ${a.detail.cycle}  boundBy=${String(a.detail.boundBy).padEnd(11)} count=${a.detail.deferralsSoFar}/${a.detail.cap} withheld=${a.detail.withheldCandidates} instead=${a.detail.insteadChose ?? a.detail.insteadOutcome}`);
}
console.log('\nCASE_SCHEDULED lines:');
for (const a of audit.filter((x) => x.type === 'CASE_SCHEDULED')) {
  console.log(`  ${a.detail.intent}  deferral ${a.detail.deferralOfClass} of ${a.detail.deferralCap}`);
}
