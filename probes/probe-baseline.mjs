import { GUARDRAILS, POLICY } from './src/core/config.js';
import { ActionKind, Channel } from './src/core/actions.js';
import { checkGuardrails, normaliseCaseState, RULES } from './src/agent/guardrails.js';

const HOUR = 3_600_000;
const NOON_IST = new Date('2026-03-05T09:00:00Z');
const MID_IST = new Date('2026-03-05T19:00:00Z');

const obs = (o = {}) => ({
  eventId: 'evt_base_1', customerId: 'cust_base_1', amountPaise: 500_000,
  lossType: 'FAILED_PAYMENT', createdAt: new Date(NOON_IST.getTime() - 2 * HOUR).toISOString(),
  doNotDisturb: false, riskBlocked: false, disputed: false, mandateRevoked: false,
  customerMessagesInLast7Days: 0, ...o,
});
const diag = { rootCause: 'INSUFFICIENT_FUNDS', source: 'ERROR_CODE', matchTier: 'CODE',
  abstained: false, requiresApprovalForMoneyMovement: false, explanation: 'x', confidence: 0.9 };

function show(label, { observed = {}, record = {}, now = NOON_IST, action }) {
  const cs = normaliseCaseState({ observed: obs(observed), record, now });
  const g = checkGuardrails({ action, caseState: cs, diagnosis: diag,
    runState: { retriesThisRun: 0, messagesThisRun: 0 }, now, config: { GUARDRAILS, POLICY },
    diagnosisClaimed: false });
  console.log(`\n=== ${label} ===`);
  console.log('  verdict:', g.verdict, '| violations:', g.violations.map(v => `${v.id}(${v.kind})`).join(', ') || 'none');
  console.log('  requiresApproval:', g.requiresApproval, g.approvalCheckIds);
}

// A) Why did B1 retry a risk-blocked case?
show('RETRY_NOW on riskBlocked', { observed: { riskBlocked: true }, action: { kind: ActionKind.RETRY_NOW, idempotencyKey: 'k' } });
show('RETRY_NOW on disputed', { observed: { disputed: true }, action: { kind: ActionKind.RETRY_NOW, idempotencyKey: 'k' } });
show('RETRY_NOW on mandateRevoked', { observed: { mandateRevoked: true }, action: { kind: ActionKind.RETRY_NOW, idempotencyKey: 'k' } });

console.log('\n--- normaliseCaseState passthrough for riskBlocked ---');
console.log(JSON.stringify(normaliseCaseState({ observed: obs({ riskBlocked: true, disputed: true }), record: {}, now: NOON_IST }), null, 1).slice(0, 900));

// B) Why did B2 not reach a contacting action?
show('RETRY_NOW at retry cap', { record: { retriesUsed: GUARDRAILS.maxRetriesPerCase }, action: { kind: ActionKind.RETRY_NOW, idempotencyKey: 'k' } });

// C) Why did the contact cap not fire for B3?
show('SEND_LINK/SMS with cap exceeded', {
  observed: { customerMessagesInLast7Days: GUARDRAILS.maxMessagesPerCustomerPer7Days + 2,
              oldestCustomerMessageInWindowAt: new Date(NOON_IST.getTime() - 24 * HOUR).toISOString() },
  record: { retriesUsed: 1, touchesUsed: 1 },
  action: { kind: ActionKind.SEND_LINK, channel: Channel.SMS, idempotencyKey: 'k' },
});
show('SEND_LINK/SMS at midnight IST', { now: MID_IST, record: { retriesUsed: 3, touchesUsed: 2 },
  action: { kind: ActionKind.SEND_LINK, channel: Channel.SMS, idempotencyKey: 'k' } });

console.log('\n--- rule ids and kinds ---');
for (const r of RULES) console.log(' ', r.kind.padEnd(9), r.id);
