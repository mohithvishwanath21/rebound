/**
 * GUARDRAIL TESTS
 * ===============
 *
 * The tests in this file exist because a boolean guardrail engine is a plausible-looking design
 * that loses money silently, and because a rule table always returns *an* answer — a misfiled
 * rule looks exactly like a correctly filed one from the inside.
 *
 * The pins that matter most:
 *
 *   - quiet hours must produce DEFER, never FORBID. Under a boolean both come back false, the
 *     decision engine sees no permissible action, and it closes a live case at 2am over a clock.
 *   - `minRetryGapHours` must be a TIMING rule. Filed as BUDGET it permanently forbids a retry
 *     that was six hours away from being legal.
 *   - timing rules must evaluate at the EXECUTION instant. Otherwise a decision taken at 15:00
 *     IST schedules a WhatsApp for 02:40 and every guardrail reports green.
 *   - approval must not be a veto. Folded into FORBID it converts "a human should look at this
 *     ₹80,000" into "this ₹80,000 is not worth chasing".
 *
 * IST reference (UTC+05:30, no DST):
 *   15:00 IST = 09:30Z same day      21:00 IST = 15:30Z same day
 *   23:00 IST = 17:30Z same day      02:40 IST = 21:10Z PREVIOUS day
 *   09:00 IST = 03:30Z same day
 *
 * Run: node --test test/guardrails.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkGuardrails,
  normaliseCaseState,
  Verdict,
  RuleKind,
  RULES,
  APPROVAL_CHECKS,
  effectiveAt,
  InvasivenessLevel,
  invasivenessOf,
} from '../src/agent/guardrails.js';
import { ActionKind, Channel } from '../src/core/actions.js';
import { GUARDRAILS, POLICY } from '../src/core/config.js';

const CONFIG = { GUARDRAILS, POLICY };

const NOON_IST = '2026-08-24T06:30:00Z';      // 12:00 IST — well clear of quiet hours
const AFTERNOON_IST = '2026-08-24T09:30:00Z'; // 15:00 IST
const NIGHT_IST = '2026-08-24T17:30:00Z';     // 23:00 IST — inside quiet hours
const PREDAWN_IST = '2026-08-24T21:10:00Z';   // 02:40 IST on the 25th — inside quiet hours
const MORNING_OPEN = '2026-08-25T03:30:00.000Z'; // 09:00 IST on the 25th — the exit

/** A clean case: nothing spent, no flags, well inside every limit. */
function cs(overrides = {}) {
  return {
    eventId: 'evt_test',
    customerId: 'cust_test',
    amountPaise: 100_000, // ₹1,000
    lossType: 'FAILED_PAYMENT',
    ageDays: 2,
    retriesUsed: 0,
    touchesUsed: 0,
    lastRetryAt: null,
    lastContactAt: null,
    customerMessagesInLast7Days: 0,
    oldestCustomerMessageInWindowAt: null,
    doNotDisturb: false,
    riskBlocked: false,
    disputed: false,
    mandateRevoked: false,
    downtimeWindow: null,
    ...overrides,
  };
}

const retry = (extra = {}) => ({ kind: ActionKind.RETRY_NOW, idempotencyKey: 'rebound:test:1', ...extra });
const link = (extra = {}) => ({ kind: ActionKind.SEND_LINK, channel: Channel.WHATSAPP, ...extra });

// ---------------------------------------------------------------------------------------------
// THE TAXONOMY. A misfiled rule is the bug this whole structure exists to make visible.
// ---------------------------------------------------------------------------------------------

test('every rule has exactly one of the three kinds', () => {
  const kinds = new Set(Object.values(RuleKind));
  for (const rule of RULES) {
    assert.ok(kinds.has(rule.kind), `${rule.id} has an unrecognised kind ${rule.kind}`);
    assert.equal(typeof rule.applies, 'function', `${rule.id} needs an applies()`);
    assert.equal(typeof rule.violated, 'function', `${rule.id} needs a violated()`);
    assert.ok(rule.title, `${rule.id} needs a title for the audit trail`);
  }
});

test('rule ids are unique', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicate id would make the audit trail ambiguous');
});

test('the retry gap is filed as TIMING, not BUDGET', () => {
  /**
   * The named example from the module header. Waiting six hours makes the retry legal, so it is
   * a timing rule. Filed as BUDGET it would return FORBID, the case would look permanently
   * unactionable, and the money would be lost to a rule's category rather than to any policy.
   */
  const gap = RULES.find((r) => r.id === 'TIM_RETRY_GAP');
  assert.ok(gap, 'TIM_RETRY_GAP must exist');
  assert.equal(gap.kind, RuleKind.TIMING);
});

test('case age is filed as BUDGET, not TIMING', () => {
  /**
   * The mirror image, and the reason "always use TIMING for anything clock-shaped" is wrong.
   * Waiting does not make a stale case legal again, it makes it staler. A timing verdict here
   * would defer the case forward forever, one poll at a time, and it would never appear in any
   * report as abandoned — the worst of both outcomes.
   */
  assert.equal(RULES.find((r) => r.id === 'BUD_CASE_AGE').kind, RuleKind.BUDGET);
});

test('the ABSOLUTE set is exactly the seven compliance boundaries', () => {
  /**
   * Pinned as a list rather than a count, because the failure mode is a rule being ADDED here.
   * An absolute rule can never be bought through by any expected value, so promoting a merely
   * expensive condition into this set removes it from the arithmetic permanently and silently.
   * If this assertion fails, the question to answer is whether the new rule is really a
   * compliance boundary or just a very high price.
   */
  const absolutes = RULES.filter((r) => r.kind === RuleKind.ABSOLUTE).map((r) => r.id);
  assert.deepEqual(absolutes.sort(), [
    'ABS_DISPUTED',
    'ABS_DO_NOT_DISTURB',
    'ABS_HUMAN_ONLY_CAUSE',
    'ABS_IDEMPOTENCY_KEY',
    'ABS_KILL_SWITCH',
    'ABS_REVOKED_MANDATE',
    'ABS_RISK_BLOCKED',
  ]);
});

test('the verdict is a pure function of the KINDS of rule violated', () => {
  /**
   * The property that makes the rule table safe to edit: precedence is decided by kind, so
   * reordering the array cannot change a verdict. Verified by recomputing the verdict from the
   * violations alone and comparing.
   */
  const scenarios = [
    [retry(), { caseState: {} }],
    [retry({ idempotencyKey: undefined }), { caseState: {} }],
    [retry(), { caseState: { mandateRevoked: true } }],
    [retry(), { caseState: { retriesUsed: 3 } }],
    [retry(), { caseState: { lastRetryAt: '2026-08-24T08:00:00Z' } }],
    [link(), { caseState: { doNotDisturb: true } }],
    [link(), { caseState: {} }, NIGHT_IST],
    [link(), { caseState: { customerMessagesInLast7Days: 2 } }],
    [link(), { caseState: { riskBlocked: true } }, NIGHT_IST],
    [link(), { caseState: { ageDays: 99 } }],
  ];

  for (const [action, opts, now = AFTERNOON_IST] of scenarios) {
    const r = checkGuardrails({ action, caseState: cs(opts.caseState), now, config: CONFIG });

    const kinds = new Set(r.violations.map((v) => v.kind));
    const hasUndatedTiming = r.violations.some((v) => v.kind === RuleKind.TIMING && !v.until);

    let expected = Verdict.ALLOW;
    if (kinds.has(RuleKind.ABSOLUTE) || kinds.has(RuleKind.BUDGET) || hasUndatedTiming) {
      expected = Verdict.FORBID;
    } else if (kinds.has(RuleKind.TIMING)) {
      expected = Verdict.DEFER;
    }

    assert.equal(
      r.verdict,
      expected,
      `${action.kind} at ${now}: violations ${[...kinds].join(',')} should give ${expected}`
    );
  }
});

// ---------------------------------------------------------------------------------------------
// THE REGRESSION THIS ENGINE WAS BUILT AROUND: quiet hours must DEFER.
// ---------------------------------------------------------------------------------------------

test('quiet hours DEFERS a message and carries the instant it becomes legal', () => {
  /**
   * THE PIN. If this ever returns FORBID, a case whose only viable action is a message gets
   * closed permanently at 23:00 because nothing was permitted — a live, recoverable case
   * abandoned over a clock. The money would not be lost to a bad policy, it would be lost to a
   * return type.
   */
  const r = checkGuardrails({ action: link(), caseState: cs(), now: NIGHT_IST, config: CONFIG });

  assert.equal(r.verdict, Verdict.DEFER, 'quiet hours must defer, never forbid');
  assert.equal(r.deferUntil.toISOString(), MORNING_OPEN, 'and it must say when: 09:00 IST');

  const quiet = r.violations.find((v) => v.id === 'TIM_QUIET_HOURS');
  assert.ok(quiet, 'the quiet hours rule must be the one that fired');
  assert.equal(quiet.kind, RuleKind.TIMING);
  assert.match(quiet.message, /quiet hours 21:00-9:00 Asia\/Kolkata/);
});

test('quiet hours defers from the pre-dawn tail to the same morning, not the next one', () => {
  // 02:40 IST is six hours from the window opening, not thirty.
  const r = checkGuardrails({ action: link(), caseState: cs(), now: PREDAWN_IST, config: CONFIG });
  assert.equal(r.verdict, Verdict.DEFER);
  assert.equal(r.deferUntil.toISOString(), MORNING_OPEN);
});

test('quiet hours boundaries: 20:59 permits, 21:00 defers, 09:00 permits', () => {
  const at = (iso) => checkGuardrails({ action: link(), caseState: cs(), now: iso, config: CONFIG }).verdict;
  assert.equal(at('2026-08-24T15:29:00Z'), Verdict.ALLOW, '20:59 IST');
  assert.equal(at('2026-08-24T15:30:00Z'), Verdict.DEFER, '21:00 IST');
  assert.equal(at('2026-08-25T03:29:00Z'), Verdict.DEFER, '08:59 IST');
  assert.equal(at('2026-08-25T03:30:00Z'), Verdict.ALLOW, '09:00 IST');
});

test('quiet hours protects attention, not the ledger: a silent retry at 02:40 is permitted', () => {
  /**
   * A retry at 02:40 disturbs nobody. Blanketing money movement with the same window would forbid
   * exactly the overnight retries that catch a month-start salary credit, for no benefit to any
   * customer. This is a deliberate asymmetry and it is worth a test, because "apply quiet hours
   * to everything" is the change a reviewer would suggest in good faith.
   */
  const r = checkGuardrails({ action: retry(), caseState: cs(), now: PREDAWN_IST, config: CONFIG });
  assert.equal(r.verdict, Verdict.ALLOW);
  assert.equal(r.violations.length, 0);

  // Same instant, a message: deferred.
  const msg = checkGuardrails({ action: link(), caseState: cs(), now: PREDAWN_IST, config: CONFIG });
  assert.equal(msg.verdict, Verdict.DEFER);
});

// ---------------------------------------------------------------------------------------------
// THE EXECUTION INSTANT. Checking the clock at decision time is green-lights-all-the-way-down.
// ---------------------------------------------------------------------------------------------

test('effectiveAt resolves a future schedule and ignores a past one', () => {
  assert.equal(effectiveAt({ scheduledFor: PREDAWN_IST }, AFTERNOON_IST).toISOString(), PREDAWN_IST.replace('Z', '.000Z'));
  // A schedule in the past means "now" — a stale scheduled action must not be evaluated against
  // the clock it was minted under.
  assert.equal(effectiveAt({ scheduledFor: NOON_IST }, AFTERNOON_IST).toISOString(), '2026-08-24T09:30:00.000Z');
  assert.equal(effectiveAt({}, AFTERNOON_IST).toISOString(), '2026-08-24T09:30:00.000Z');
  assert.equal(effectiveAt({ scheduledFor: 'not-a-date' }, AFTERNOON_IST).toISOString(), '2026-08-24T09:30:00.000Z');
});

test('a message DECIDED at 15:00 but SCHEDULED into quiet hours is caught', () => {
  /**
   * THE SECOND PIN. Evaluated at `now`, this action passes every guardrail: 15:00 IST is nowhere
   * near quiet hours. It would be scheduled, and it would wake the customer at 02:40. The rule
   * that forbids 2am messages would have reported green on the decision that sent one.
   */
  const scheduled = link({ scheduledFor: PREDAWN_IST });
  const r = checkGuardrails({ action: scheduled, caseState: cs(), now: AFTERNOON_IST, config: CONFIG });

  assert.equal(r.effectiveAt.toISOString(), '2026-08-24T21:10:00.000Z', 'evaluated at execution time');
  assert.equal(r.verdict, Verdict.DEFER, 'the 02:40 execution must be caught from a 15:00 decision');
  assert.equal(r.deferUntil.toISOString(), MORNING_OPEN);
  assert.ok(r.violations.some((v) => v.id === 'TIM_QUIET_HOURS'));

  // The control: the same message, unscheduled, at the same decision time is fine.
  const immediate = checkGuardrails({ action: link(), caseState: cs(), now: AFTERNOON_IST, config: CONFIG });
  assert.equal(immediate.verdict, Verdict.ALLOW);
});

test('a retry scheduled past the gap is legal even though the gap has not elapsed yet', () => {
  /**
   * The same mechanism working in the merchant's favour, and the reason the gap is compared
   * against the execution instant rather than `now`. Evaluating at decision time would forbid
   * every scheduled retry inside the window — which is the entire purpose of scheduling.
   */
  const now = AFTERNOON_IST;                       // 15:00 IST
  const lastRetryAt = '2026-08-24T08:30:00Z';      // one hour before now; gap clears at 14:30Z
  const caseState = cs({ lastRetryAt });

  const tooSoon = checkGuardrails({ action: retry(), caseState, now, config: CONFIG });
  assert.equal(tooSoon.verdict, Verdict.DEFER, 'retrying right now is inside the 6h gap');
  assert.equal(tooSoon.deferUntil.toISOString(), '2026-08-24T14:30:00.000Z');

  const later = checkGuardrails({
    action: { kind: ActionKind.RETRY_SCHEDULED, idempotencyKey: 'k', scheduledFor: '2026-08-24T15:00:00Z' },
    caseState,
    now,
    config: CONFIG,
  });
  assert.equal(later.verdict, Verdict.ALLOW, 'the same retry, scheduled past the gap, is permitted');
});

// ---------------------------------------------------------------------------------------------
// VERDICT RESOLUTION
// ---------------------------------------------------------------------------------------------

test('FORBID dominates DEFER', () => {
  /**
   * A forbidden action does not become permitted by waiting. Reporting DEFER on one would send
   * the case round the polling loop forever, and each cycle would look like patience.
   */
  const r = checkGuardrails({
    action: link(),
    caseState: cs({ doNotDisturb: true }),  // absolute
    now: NIGHT_IST,                          // and a timing violation at the same time
    config: CONFIG,
  });

  assert.ok(r.violations.some((v) => v.kind === RuleKind.ABSOLUTE));
  assert.ok(r.violations.some((v) => v.kind === RuleKind.TIMING));
  assert.equal(r.verdict, Verdict.FORBID);
  assert.equal(r.deferUntil, null, 'a forbidden action has no future legal moment');
});

test('among several DEFERs the LATEST instant wins', () => {
  /**
   * Satisfying quiet hours at 09:00 is useless if the retry gap does not clear until 14:00.
   * Taking the earliest would schedule an action that is still illegal when it fires.
   *
   *   retry gap:  last retry 08:30Z + 6h  -> legal from 14:30Z
   *   downtime:   observed window ends     -> legal from 17:30Z
   *   expected deferUntil = 17:30Z
   */
  const r = checkGuardrails({
    action: { kind: ActionKind.RETRY_SCHEDULED, idempotencyKey: 'k', scheduledFor: '2026-08-24T11:30:00Z' },
    caseState: cs({
      lastRetryAt: '2026-08-24T08:30:00Z',
      downtimeWindow: { from: '2026-08-24T08:30:00Z', to: '2026-08-24T17:30:00Z' },
    }),
    now: AFTERNOON_IST,
    config: CONFIG,
  });

  assert.equal(r.verdict, Verdict.DEFER);
  assert.equal(r.violations.filter((v) => v.kind === RuleKind.TIMING).length, 2);
  assert.equal(r.deferUntil.toISOString(), '2026-08-24T17:30:00.000Z', 'the later of the two');
});

test('a TIMING violation that cannot name an instant degrades to FORBID', () => {
  /**
   * The customer contact ledger knows the cap is breached but not always when it clears.
   * Deferring to a guessed instant would send the message early and break the cap; forbidding
   * costs one polling cycle. An unknown clearing time must not be assumed to be soon.
   */
  const undated = checkGuardrails({
    action: link(),
    caseState: cs({ customerMessagesInLast7Days: 2, oldestCustomerMessageInWindowAt: null }),
    now: AFTERNOON_IST,
    config: CONFIG,
  });
  const violation = undated.violations.find((v) => v.id === 'TIM_CUSTOMER_MESSAGE_CAP');
  assert.ok(violation, 'the contact cap must fire at 2 of 2');
  assert.equal(violation.kind, RuleKind.TIMING);
  assert.equal(violation.until, null, 'the ledger could not say when');
  assert.equal(undated.verdict, Verdict.FORBID, 'an undated defer is a forbid');

  // With a known oldest message, the window can be computed and the verdict softens.
  const dated = checkGuardrails({
    action: link(),
    caseState: cs({
      customerMessagesInLast7Days: 2,
      oldestCustomerMessageInWindowAt: '2026-08-20T09:30:00Z',
    }),
    now: AFTERNOON_IST,
    config: CONFIG,
  });
  assert.equal(dated.verdict, Verdict.DEFER);
  assert.equal(dated.deferUntil.toISOString(), '2026-08-27T09:30:00.000Z', 'oldest + 7 days');
});

test('the downtime deferral is marked as an estimate', () => {
  /**
   * `observedWindow` is inferred from failure clustering and the true window may run past it.
   * Recording the deferral as estimated is what stops the audit trail from asserting a precision
   * the observation does not have. Padding it by an invented margin was the alternative, and it
   * would have put an unmeasured number directly in the decision path.
   */
  const r = checkGuardrails({
    action: retry(),
    caseState: cs({ downtimeWindow: { from: '2026-08-24T09:00:00Z', to: '2026-08-24T12:00:00Z' } }),
    now: AFTERNOON_IST,
    config: CONFIG,
  });
  const v = r.violations.find((x) => x.id === 'TIM_ISSUER_DOWNTIME');
  assert.ok(v);
  assert.equal(v.estimated, true);
  assert.match(v.message, /an estimate, not a guarantee/);
});

// ---------------------------------------------------------------------------------------------
// ABSOLUTES
// ---------------------------------------------------------------------------------------------

test('a revoked mandate is refused, not priced', () => {
  const r = checkGuardrails({ action: retry(), caseState: cs({ mandateRevoked: true }), now: NOON_IST, config: CONFIG });
  assert.equal(r.verdict, Verdict.FORBID);
  assert.ok(r.violations.some((v) => v.id === 'ABS_REVOKED_MANDATE' && v.kind === RuleKind.ABSOLUTE));

  // But asking the customer to re-authorise is the whole point of REQUEST_REAUTH and stays legal.
  const reauth = checkGuardrails({
    action: { kind: ActionKind.REQUEST_REAUTH, channel: Channel.EMAIL },
    caseState: cs({ mandateRevoked: true }),
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(reauth.verdict, Verdict.ALLOW, 'the only action that can recover a revoked mandate');
});

test('money movement without an idempotency key is forbidden', () => {
  /**
   * Enforced here as well as at the gateway. The gateway check protects the customer's card; this
   * one protects the audit trail, because an unkeyed action that reached the scorer would appear
   * in the record as a legitimate candidate that merely lost on expected value.
   */
  const r = checkGuardrails({
    action: { kind: ActionKind.RETRY_NOW },
    caseState: cs(),
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(r.verdict, Verdict.FORBID);
  assert.ok(r.violations.some((v) => v.id === 'ABS_IDEMPOTENCY_KEY'));
});

test('risk-blocked and disputed cases forbid automation but permit escalation', () => {
  /**
   * The reason `isAutomatedOutbound` excludes escalation. A rule table that blocked escalation
   * too would leave these cases with no legal action at all — and escalation is precisely what
   * these rules exist to route them to.
   */
  for (const flag of ['riskBlocked', 'disputed']) {
    const caseState = cs({ [flag]: true });

    for (const action of [retry(), link()]) {
      const r = checkGuardrails({ action, caseState, now: NOON_IST, config: CONFIG });
      assert.equal(r.verdict, Verdict.FORBID, `${action.kind} must be forbidden when ${flag}`);
    }

    const esc = checkGuardrails({ action: { kind: ActionKind.ESCALATE_HUMAN }, caseState, now: NOON_IST, config: CONFIG });
    assert.equal(esc.verdict, Verdict.ALLOW, `escalation must stay available when ${flag}`);
  }
});

test('a human-only cause forbids automation but permits escalation', () => {
  const diagnosis = { rootCause: 'SUSPECTED_FRAUD', physics: { humanOnly: true } };
  const caseState = cs();

  for (const action of [retry(), link()]) {
    const r = checkGuardrails({ action, caseState, diagnosis, now: NOON_IST, config: CONFIG });
    assert.equal(r.verdict, Verdict.FORBID);
    assert.ok(r.violations.some((v) => v.id === 'ABS_HUMAN_ONLY_CAUSE'));
  }

  const esc = checkGuardrails({
    action: { kind: ActionKind.ESCALATE_HUMAN },
    caseState,
    diagnosis,
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(esc.verdict, Verdict.ALLOW);
});

test('the kill switch stops everything except doing nothing', () => {
  const killed = { GUARDRAILS: { ...GUARDRAILS, killSwitch: true }, POLICY };

  for (const action of [retry(), link(), { kind: ActionKind.ESCALATE_HUMAN }, { kind: ActionKind.STOP_PERMANENT }]) {
    const r = checkGuardrails({ action, caseState: cs(), now: NOON_IST, config: killed });
    assert.equal(r.verdict, Verdict.FORBID, `${action.kind} must be stopped by the kill switch`);
  }

  const noop = checkGuardrails({ action: { kind: ActionKind.NO_ACTION_YET }, caseState: cs(), now: NOON_IST, config: killed });
  assert.equal(noop.verdict, Verdict.ALLOW, 'doing nothing remains available, or the engine has no output at all');
});

// ---------------------------------------------------------------------------------------------
// BUDGETS
// ---------------------------------------------------------------------------------------------

test('retry and touch budgets forbid at the cap, not before it', () => {
  const cap = GUARDRAILS.maxRetriesPerCase; // 3
  for (let used = 0; used < cap; used += 1) {
    const r = checkGuardrails({ action: retry(), caseState: cs({ retriesUsed: used }), now: NOON_IST, config: CONFIG });
    assert.equal(r.verdict, Verdict.ALLOW, `${used} of ${cap} retries used should still permit`);
  }
  const spent = checkGuardrails({ action: retry(), caseState: cs({ retriesUsed: cap }), now: NOON_IST, config: CONFIG });
  assert.equal(spent.verdict, Verdict.FORBID);
  assert.ok(spent.violations.some((v) => v.id === 'BUD_RETRIES_PER_CASE'));

  const touches = GUARDRAILS.maxTouchesPerCase; // 5
  const atCap = checkGuardrails({ action: link(), caseState: cs({ touchesUsed: touches }), now: NOON_IST, config: CONFIG });
  assert.equal(atCap.verdict, Verdict.FORBID);
  assert.ok(atCap.violations.some((v) => v.id === 'BUD_TOUCHES_PER_CASE'));
});

test('an abstained diagnosis gets ONE retry, not the full budget', () => {
  /**
   * The taxonomy's `UNKNOWN.retryCanSucceed: true` carries the comment "allow a single cautious
   * attempt". Nothing made it single and nothing made it cautious, so an abstained diagnosis
   * inherited all three retries — the cases we understood least got exactly as many attempts at
   * the customer's card as the cases we understood best. A comment describing a policy is not
   * the policy.
   */
  const abstained = { rootCause: 'UNKNOWN', abstained: true };

  const first = checkGuardrails({ action: retry(), caseState: cs({ retriesUsed: 0 }), diagnosis: abstained, now: NOON_IST, config: CONFIG });
  assert.equal(first.verdict, Verdict.ALLOW, 'the single cautious attempt is permitted');

  const second = checkGuardrails({ action: retry(), caseState: cs({ retriesUsed: 1 }), diagnosis: abstained, now: NOON_IST, config: CONFIG });
  assert.equal(second.verdict, Verdict.FORBID, 'the second attempt on an undiagnosed case is not');
  assert.ok(second.violations.some((v) => v.id === 'BUD_ABSTAINED_RETRY_LIMIT'));

  // A firm diagnosis at the same retry count keeps its full budget — the limit is about evidence,
  // not about the counter.
  const firm = { rootCause: 'INSUFFICIENT_FUNDS', abstained: false };
  const confident = checkGuardrails({ action: retry(), caseState: cs({ retriesUsed: 1 }), diagnosis: firm, now: NOON_IST, config: CONFIG });
  assert.equal(confident.verdict, Verdict.ALLOW);
});

test('run-level circuit breakers bind', () => {
  const msgs = checkGuardrails({
    action: link(),
    caseState: cs(),
    runState: { retriesThisRun: 0, messagesThisRun: GUARDRAILS.maxMessagesPerRun },
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(msgs.verdict, Verdict.FORBID);
  assert.ok(msgs.violations.some((v) => v.id === 'BUD_RUN_MESSAGES'));

  const retries = checkGuardrails({
    action: retry(),
    caseState: cs(),
    runState: { retriesThisRun: GUARDRAILS.maxRetriesPerRun, messagesThisRun: 0 },
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(retries.verdict, Verdict.FORBID);
  assert.ok(retries.violations.some((v) => v.id === 'BUD_RUN_RETRIES'));
});

test('an over-age case forbids outbound action but still permits escalation', () => {
  const caseState = cs({ ageDays: POLICY.maxCaseAgeDays + 1 });
  const r = checkGuardrails({ action: retry(), caseState, now: NOON_IST, config: CONFIG });
  assert.equal(r.verdict, Verdict.FORBID);
  assert.ok(r.violations.some((v) => v.id === 'BUD_CASE_AGE'));

  const esc = checkGuardrails({ action: { kind: ActionKind.ESCALATE_HUMAN }, caseState, now: NOON_IST, config: CONFIG });
  assert.equal(esc.verdict, Verdict.ALLOW);
});

// ---------------------------------------------------------------------------------------------
// APPROVAL IS NOT A VETO
// ---------------------------------------------------------------------------------------------

test('a large amount requires approval while remaining ALLOWED', () => {
  /**
   * THE THIRD PIN. Folding approval into the verdict would convert "a human should look at this
   * ₹30,000 charge" into "this ₹30,000 is not worth chasing" — the same class of error as
   * collapsing DEFER into FORBID, and considerably more expensive.
   */
  const big = cs({ amountPaise: GUARDRAILS.humanApprovalThresholdPaise }); // exactly at the line
  const r = checkGuardrails({ action: retry(), caseState: big, now: NOON_IST, config: CONFIG });

  assert.equal(r.verdict, Verdict.ALLOW, 'approval must not forbid');
  assert.equal(r.requiresApproval, true);
  assert.ok(r.approvalReasons.some((s) => s.startsWith('APR_LARGE_AMOUNT')));
  assert.equal(r.violations.length, 0, 'needing approval is not a violation');

  const justUnder = cs({ amountPaise: GUARDRAILS.humanApprovalThresholdPaise - 1 });
  const under = checkGuardrails({ action: retry(), caseState: justUnder, now: NOON_IST, config: CONFIG });
  assert.equal(under.requiresApproval, false, 'the threshold is inclusive at the top only');
});

test('an unsupported belief requires approval for money movement', () => {
  /**
   * "This is unlikely to work" and "I have no idea whether this works" are different statements
   * and must not authorise the same charge. The probability is identical in both branches below —
   * only the support differs — so nothing except this check could tell them apart.
   */
  const p = 0.11;
  const supported = checkGuardrails({
    action: retry(),
    caseState: cs(),
    belief: { p, support: { state: 'SUPPORTED', rows: 400 } },
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(supported.requiresApproval, false);

  for (const state of ['UNSEEN', 'THIN', 'UNKNOWN']) {
    const r = checkGuardrails({
      action: retry(),
      caseState: cs(),
      belief: { p, support: { state, rows: 0 } },
      now: NOON_IST,
      config: CONFIG,
    });
    assert.equal(r.verdict, Verdict.ALLOW, `${state} support must not forbid`);
    assert.equal(r.requiresApproval, true, `${state} support must require a human`);
    assert.ok(r.approvalReasons.some((s) => s.includes('APR_UNSUPPORTED_BELIEF')));
  }
});

test('a weak or abstained diagnosis requires approval for money movement only', () => {
  const weak = { rootCause: 'UNKNOWN', matchTier: 'TEXT', source: 'RULE', requiresApprovalForMoneyMovement: true, abstained: true };

  const money = checkGuardrails({ action: retry(), caseState: cs(), diagnosis: weak, now: NOON_IST, config: CONFIG });
  assert.equal(money.requiresApproval, true);
  assert.ok(money.approvalReasons.some((s) => s.includes('APR_WEAK_DIAGNOSIS')));
  assert.ok(money.approvalReasons.some((s) => s.includes('APR_ABSTAINED_DIAGNOSIS')));

  /**
   * Messages are not gated on diagnosis strength. A payment link sent on a misdiagnosed case
   * costs 35 paise and some goodwill; a charge attempt on one touches the customer's card. The
   * asymmetry is intentional — gating both equally would queue every weak-diagnosis case for a
   * human and destroy the automation rate for no compliance benefit.
   */
  const msg = checkGuardrails({ action: link(), caseState: cs(), diagnosis: weak, now: NOON_IST, config: CONFIG });
  assert.equal(msg.requiresApproval, false);
});

// ---------------------------------------------------------------------------------------------
// THE APPROVAL ENVELOPE — what a grant does and, mostly, what it does not do
// ---------------------------------------------------------------------------------------------

/**
 * A grant as a human's signature would be recorded: the specific checks the reviewer was shown,
 * the invasiveness of the action they were shown, who signed, and when.
 */
function grant(overrides = {}) {
  return {
    state: 'GRANTED',
    by: 'priya@example.com',
    grantedAt: NOON_IST,
    clearedCheckIds: ['APR_LARGE_AMOUNT'],
    approvedInvasiveness: InvasivenessLevel.MONEY,
    ...overrides,
  };
}

const HUGE = GUARDRAILS.humanApprovalThresholdPaise * 12; // ~₹3,00,000, the p100 case in the batch

test('a live grant lets the money move, and says whose signature moved it', () => {
  /**
   * THE TEST THIS WHOLE MECHANISM EXISTS FOR, and the one whose absence hid a real defect.
   *
   * Measured before the grant path existed: 16 of 80 cases held ₹16,77,043 — 92.9% of the entire
   * batch exposure — above the approval threshold, and every one of them sat in the queue forever
   * because nothing could ever clear the check. An approval gate with no grant path is not a
   * control, it is a leak that reports itself as caution.
   *
   * Note what is asserted: not merely that the action is ALLOWED (it always was — approval is not
   * a veto, per the pin above), but that `requiresApproval` goes FALSE so the orchestrator stops
   * re-queueing it, and that the audit trail names the signer.
   */
  const before = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE }),
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(before.requiresApproval, true, 'without a grant this case is held — the premise');

  const after = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, approval: grant() }),
    now: NOON_IST,
    config: CONFIG,
  });

  assert.equal(after.requiresApproval, false, 'a granted case must not bounce straight back into the queue');
  assert.deepEqual(after.approvalReasons, []);
  assert.deepEqual(after.clearedByApproval, ['APR_LARGE_AMOUNT'], 'the cleared check is named, not merely absent');
  assert.equal(after.approvedBy, 'priya@example.com', 'an audit trail that cannot name the signer is not one');
  assert.equal(after.verdict, Verdict.ALLOW);
});

test('a grant to contact the customer is not a grant to charge their card', () => {
  /**
   * The invasiveness ladder. A reviewer who approved a WhatsApp nudge on a ₹3,00,000 case has
   * consented to a 35-paise message, and reading that as consent to attempt the charge is how an
   * approval control becomes worse than no approval control — it manufactures a signature for a
   * decision nobody made.
   *
   * Both branches below carry an otherwise-identical live grant clearing the same check id. Only
   * the ceiling differs, so nothing except the ladder could separate them.
   */
  const contactOnly = grant({ approvedInvasiveness: InvasivenessLevel.CONTACT });

  const message = checkGuardrails({
    action: link(),
    caseState: cs({ amountPaise: HUGE, approval: contactOnly }),
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(message.requiresApproval, false, 'the message they approved goes out');
  assert.deepEqual(message.clearedByApproval, ['APR_LARGE_AMOUNT']);

  const charge = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, approval: contactOnly }),
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(charge.requiresApproval, true, 'the charge they did not approve is held');
  assert.deepEqual(charge.clearedByApproval, [], 'and is not recorded as cleared by anyone');
  assert.equal(charge.approvedBy, 'priya@example.com', 'the grant is still live — it just does not reach this far');
});

test('the invasiveness ladder orders contact below money', () => {
  assert.ok(
    invasivenessOf(ActionKind.SEND_LINK) < invasivenessOf(ActionKind.RETRY_NOW),
    'if these ever compare equal, a message grant silently authorises a charge'
  );
  assert.equal(invasivenessOf({ kind: ActionKind.RETRY_NOW }), InvasivenessLevel.MONEY, 'accepts an action or a kind');
  assert.equal(invasivenessOf(ActionKind.NO_ACTION_YET), InvasivenessLevel.NONE);
});

test('a grant expires, and an expiring grant re-gates the case rather than failing open', () => {
  /**
   * Nine days after a reviewer signed off on retrying a card, the customer may have paid,
   * disputed, or churned — and the reviewer would want to be asked again. A grant with no expiry
   * is permanent authority obtained once, which is the shape of every real approval-control
   * failure. The important half of this test is the last assertion: expiry must send the case back
   * to a human, not quietly let the action through unsigned.
   */
  const hours = GUARDRAILS.approvalValidForHours;
  const at = (h) => new Date(new Date(NOON_IST).getTime() + h * 3_600_000).toISOString();

  const justInside = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, approval: grant() }),
    now: at(hours - 1),
    config: CONFIG,
  });
  assert.equal(justInside.requiresApproval, false, `a grant is still good at ${hours - 1}h`);

  const justOutside = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, approval: grant() }),
    now: at(hours + 1),
    config: CONFIG,
  });
  assert.equal(justOutside.requiresApproval, true, `a grant is stale at ${hours + 1}h`);
  assert.deepEqual(justOutside.clearedByApproval, []);
  assert.equal(justOutside.approvedBy, null, 'an expired signature must not appear on the record as a live one');
});

test('a malformed or non-granted approval record authorises nothing', () => {
  /**
   * Fails closed on every ambiguity, because the failure mode worth engineering against is not a
   * crash — it is a plausible wrong answer. Each record below is one a real bug could produce: a
   * request that was never answered, a denial, a grant whose timestamp was dropped by a partial
   * write, a grant that forgot to record its ceiling, a grant that forgot which checks it answered.
   */
  const bad = {
    'a request nobody has answered yet': { state: 'PENDING', clearedCheckIds: ['APR_LARGE_AMOUNT'] },
    'an outright denial': { ...grant(), state: 'DENIED' },
    'no state at all': { ...grant(), state: undefined },
    'a grant with no timestamp': { ...grant(), grantedAt: null },
    'a grant with an unparseable timestamp': { ...grant(), grantedAt: 'last tuesday' },
    'a grant that forgot its ceiling': { ...grant(), approvedInvasiveness: undefined },
    'a grant that forgot which checks it answered': { ...grant(), clearedCheckIds: undefined },
    'a grant whose cleared ids are not a list': { ...grant(), clearedCheckIds: 'APR_LARGE_AMOUNT' },
    'nothing at all': null,
  };

  for (const [description, approval] of Object.entries(bad)) {
    const r = checkGuardrails({
      action: retry(),
      caseState: cs({ amountPaise: HUGE, approval }),
      now: NOON_IST,
      config: CONFIG,
    });
    assert.equal(r.requiresApproval, true, `${description} must not authorise a charge`);
    assert.deepEqual(r.clearedByApproval, [], `${description} must not appear as a clearance`);
  }
});

test('no approval check applies to a NONE-invasiveness action', () => {
  /**
   * A REACHABILITY PIN, written because a mutation test embarrassed me.
   *
   * `grantClears` defaults a missing envelope to `-1` rather than `0`, so a grant that forgot to
   * record what it authorised authorises nothing. I tried to write a test that failed when that
   * default was loosened to `0`, and none did — because `MONEY <= 0` and `CONTACT <= 0` are both
   * false, the only actions the loosened default would wrongly clear are NONE-level ones, and no
   * approval check currently applies to those. The branch is unreachable, so the honest thing is
   * to pin the reason it is unreachable rather than to write a test that passes either way.
   *
   * Every concern below is triggered simultaneously — a ₹3,00,000 amount, an abstained TEXT-tier
   * diagnosis, an unsupported belief — so a check that applied at all would fire here. If someone
   * later adds an approval check that reaches a NONE-level action, this test fails and points at
   * the `?? -1` in `grantClears`, which is exactly the note that would otherwise go unread.
   */
  const weak = {
    rootCause: 'UNKNOWN',
    matchTier: 'TEXT',
    source: 'RULE',
    requiresApprovalForMoneyMovement: true,
    abstained: true,
  };

  const noneKinds = Object.values(ActionKind).filter(
    (k) => invasivenessOf(k) === InvasivenessLevel.NONE
  );
  assert.ok(noneKinds.length >= 3, 'sanity: NO_ACTION_YET, ESCALATE_HUMAN and STOP_PERMANENT are NONE');

  for (const kind of noneKinds) {
    const r = checkGuardrails({
      action: { kind },
      caseState: cs({ amountPaise: HUGE }),
      diagnosis: weak,
      belief: { p: 0.1, support: { state: 'UNSEEN', rows: 0 } },
      now: NOON_IST,
      config: CONFIG,
    });
    assert.equal(
      r.requiresApproval,
      false,
      `${kind} is NONE-invasiveness; an approval check reaching it makes grantClears' default load-bearing`
    );
  }
});

test('a grant clears only the concerns it was shown, so a new one re-gates the case', () => {
  /**
   * The narrowest and most easily-lost property. A reviewer looking at "₹3,00,000, above the
   * threshold" has answered exactly that question. If the diagnosis later degrades — a re-observed
   * case whose cause is now UNKNOWN — that is a fact the reviewer never saw, and the old signature
   * must not cover it.
   *
   * The tempting shortcut here is "GRANTED means the case is unlocked". This test is what that
   * shortcut breaks, and it is the reason the grant carries a list of check ids at all.
   */
  const weak = {
    rootCause: 'UNKNOWN',
    matchTier: 'TEXT',
    source: 'RULE',
    requiresApprovalForMoneyMovement: true,
    abstained: true,
  };

  const r = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, approval: grant() }),
    diagnosis: weak,
    now: NOON_IST,
    config: CONFIG,
  });

  assert.equal(r.requiresApproval, true, 'a concern the reviewer never saw must go back to a human');
  assert.deepEqual(r.clearedByApproval, ['APR_LARGE_AMOUNT'], 'while the concern they did see stays cleared');
  assert.ok(
    r.approvalReasons.every((s) => !s.startsWith('APR_LARGE_AMOUNT')),
    'the answered question is not asked again'
  );
  assert.ok(r.approvalReasons.some((s) => s.startsWith('APR_WEAK_DIAGNOSIS')));

  // And the inverse: a grant covering both concerns clears both.
  const both = checkGuardrails({
    action: retry(),
    caseState: cs({
      amountPaise: HUGE,
      approval: grant({
        clearedCheckIds: ['APR_LARGE_AMOUNT', 'APR_WEAK_DIAGNOSIS', 'APR_ABSTAINED_DIAGNOSIS'],
      }),
    }),
    diagnosis: weak,
    now: NOON_IST,
    config: CONFIG,
  });
  assert.equal(both.requiresApproval, false);
  assert.equal(both.clearedByApproval.length, 3);
});

test('a grant on a large case does not override an absolute prohibition', () => {
  /**
   * Approval and permission are different axes and must stay that way. A human can authorise an
   * action that was merely gated; nobody can authorise one that is forbidden — a revoked mandate
   * means the customer withdrew consent to be charged, and no amount of internal sign-off
   * reinstates it. Collapsing these would turn the approval queue into a way to launder every
   * guardrail in the table.
   */
  const r = checkGuardrails({
    action: retry(),
    caseState: cs({ amountPaise: HUGE, mandateRevoked: true, approval: grant() }),
    now: NOON_IST,
    config: CONFIG,
  });

  assert.equal(r.verdict, Verdict.FORBID, 'a signature does not reinstate a withdrawn mandate');
  assert.ok(r.violations.some((v) => v.id === 'ABS_REVOKED_MANDATE'));
});

test('every approval check has an id and returns strings or null', () => {
  for (const c of APPROVAL_CHECKS) {
    assert.match(c.id, /^APR_/, 'approval check ids are prefixed so the audit trail groups them');
    assert.equal(typeof c.applies, 'function');
    assert.equal(typeof c.reason, 'function');
  }
});

// ---------------------------------------------------------------------------------------------
// THE AUDIT SURFACE
// ---------------------------------------------------------------------------------------------

test('every rule is recorded for every action, including the ones that did not apply', () => {
  /**
   * "Was this checked?" is a different question from "did this fire?", and it is the one an
   * auditor asks. In a log that lists only violations, absence of a check and absence of a
   * violation look identical.
   */
  const r = checkGuardrails({ action: link(), caseState: cs(), now: NOON_IST, config: CONFIG });

  assert.equal(r.evaluated.length, RULES.length, 'one entry per rule, always');
  assert.deepEqual(
    r.evaluated.map((e) => e.id).sort(),
    RULES.map((x) => x.id).sort()
  );

  const notApplied = r.evaluated.filter((e) => !e.applied);
  assert.ok(notApplied.length > 0, 'a message should have money-movement rules recorded as not applied');
  assert.ok(notApplied.every((e) => e.passed === true), 'a rule that did not apply did not fail');

  // ABS_REVOKED_MANDATE applies only to money movement, so on a message it must be recorded as
  // considered-and-irrelevant rather than omitted.
  const mandate = r.evaluated.find((e) => e.id === 'ABS_REVOKED_MANDATE');
  assert.equal(mandate.applied, false);
});

test('violations carry enough to explain themselves without the code', () => {
  const r = checkGuardrails({ action: link(), caseState: cs({ touchesUsed: 5 }), now: NIGHT_IST, config: CONFIG });
  for (const v of r.violations) {
    assert.ok(v.id && v.kind && v.title && v.message, `${v.id} is missing a field the drawer renders`);
    assert.equal(typeof v.message, 'string');
    assert.ok(v.message.length > 10, `${v.id}: "${v.message}" is not an explanation`);
  }
});

// ---------------------------------------------------------------------------------------------
// normaliseCaseState
// ---------------------------------------------------------------------------------------------

test('normaliseCaseState defaults flags permissively and counters strictly', () => {
  /**
   * Both directions are chosen rather than inherited from `??` convenience. A missing
   * `doNotDisturb` means we have no opt-out on file, so contact is permitted. A missing
   * `retriesUsed` defaulting to anything other than 0 would silently block every fresh case —
   * the agent would appear to work and would never act.
   */
  const s = normaliseCaseState({ observed: { eventId: 'e1', amountPaise: 5000 }, record: {}, now: NOON_IST });

  assert.equal(s.doNotDisturb, false);
  assert.equal(s.riskBlocked, false);
  assert.equal(s.disputed, false);
  assert.equal(s.mandateRevoked, false);

  assert.equal(s.retriesUsed, 0);
  assert.equal(s.touchesUsed, 0);
  assert.equal(s.customerMessagesInLast7Days, 0);
  assert.equal(s.lastRetryAt, null);
});

test('normaliseCaseState computes age from the observation, never negative', () => {
  const s = normaliseCaseState({
    observed: { eventId: 'e1', occurredAt: '2026-08-20T06:30:00Z' },
    now: NOON_IST, // 2026-08-24T06:30:00Z
  });
  assert.equal(s.ageDays, 4);

  // A clock skew that puts the event in the future must not produce a negative age, which would
  // sail under every age limit.
  const future = normaliseCaseState({
    observed: { eventId: 'e1', occurredAt: '2026-09-01T06:30:00Z' },
    now: NOON_IST,
  });
  assert.equal(future.ageDays, 0);
});

test('normaliseCaseState reads mandate revocation from the observation, not from our record', () => {
  /**
   * The observation is the copy that may disagree with the provider, and that disagreement is
   * modelled on purpose. Reading the observable is what a real deployment would do, and it is why
   * the revoked-mandate rule can fire at all.
   */
  const s = normaliseCaseState({
    observed: { eventId: 'e1', subscription: { mandateStatus: 'revoked' } },
    now: NOON_IST,
  });
  assert.equal(s.mandateRevoked, true);

  const active = normaliseCaseState({
    observed: { eventId: 'e1', subscription: { mandateStatus: 'active' } },
    now: NOON_IST,
  });
  assert.equal(active.mandateRevoked, false);
});

test('normaliseCaseState picks up a disputed flag from the invoice', () => {
  const s = normaliseCaseState({
    observed: { eventId: 'e1', invoice: { flags: ['disputed', 'partial_payment'] } },
    now: NOON_IST,
  });
  assert.equal(s.disputed, true);
});

test('checkGuardrails rejects a call with no action or no case state', () => {
  assert.throws(() => checkGuardrails({ caseState: cs() }), TypeError);
  assert.throws(() => checkGuardrails({ action: retry() }), TypeError);
  assert.throws(() => checkGuardrails({ action: {}, caseState: cs() }), TypeError);
});
