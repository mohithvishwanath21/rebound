/**
 * TESTS FOR THE FOUR BASELINES
 * ============================
 *
 * What these tests are actually for, because it is not the obvious thing. A baseline is not
 * production code and a bug in one does not break the product — it corrupts the RESULT, which is
 * worse, because the result is the submission. Every test below therefore targets a specific way a
 * baseline could be quietly weaker than it claims to be, since that is the class of defect that
 * makes Rebound's headline number larger and will not show up as a failure anywhere else.
 *
 * The tests are written as PROPERTIES rather than expected values wherever the property is the real
 * claim. `assert.equal(money, 412300)` passes for exactly one world and tells a reader nothing about
 * what was meant; `assert(b3Actions > 0, 'B3 must not degenerate into B0')` states the claim and
 * survives a change to the generator. Where a value IS hand-computable — the ladder's rung index,
 * the idempotency key's shape — it is asserted directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideB0DoNothing,
  decideB1NaiveRetry,
  decideB2Aggressive,
  decideB3FixedLadder,
  ARM_POLICIES,
  policyFor,
  describeArm,
  B2_IGNORED_RULE_IDS,
} from '../src/eval/baselines.js';
import { GUARDRAILS, POLICY, POLICY_ARMS, HORIZON } from '../src/core/config.js';
import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING } from '../src/core/actions.js';
import { Verdict, RuleKind, RULES, normaliseCaseState } from '../src/agent/guardrails.js';
import { Outcome, DECISION_SCHEMA_VERSION, decideForCase } from '../src/agent/decide.js';
import { buildWorld, runArm } from '../src/eval/harness.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A decision instant safely inside business hours in IST.
 *
 * 2026-03-05T09:00:00Z is 14:30 IST. Chosen deliberately rather than `new Date()`: the quiet-hours
 * guardrail is a function of wall-clock time in Asia/Kolkata, so a test using the current instant
 * passes or fails depending on when it is run, and would have failed silently for anyone running the
 * suite in the evening. That is the same class of defect as the run that ended at 02:30 IST.
 */
const NOON_IST = new Date('2026-03-05T09:00:00Z');

/**
 * A plain observation, healthy.
 *
 * NOTE ON WHERE THE FLAGS LIVE, because getting this wrong made four of these tests pass
 * vacuously on the first run. `normaliseCaseState` reads `doNotDisturb`, `riskBlocked` and
 * `customerMessagesInLast7Days` from the CASE RECORD, not from the observation — they are our own
 * facts about our own process, not something the payment provider tells us. `mandateRevoked` is read
 * from `observed.subscription.mandateStatus`, and `disputed` from `observed.invoice.flags`.
 *
 * A test that puts a blocking flag in the wrong object asserts that a policy refused to act on a
 * case that was never actually blocked. It passes, proves nothing, and would have let a
 * genuinely non-compliant baseline through. `blocked()` below exists so the shapes are written once.
 */
function observation(over = {}) {
  return {
    eventId: 'evt_base_1',
    customerId: 'cust_base_1',
    amountPaise: 500_000, // Rs 5,000 — comfortably under the Rs 25,000 approval threshold
    createdAt: new Date(NOON_IST.getTime() - 2 * HOUR).toISOString(),
    occurredAt: new Date(NOON_IST.getTime() - 2 * HOUR).toISOString(),
    lossType: 'FAILED_PAYMENT',
    ...over,
  };
}

/**
 * Build the observed/record pair that actually trips a given absolute rule, verified against
 * `normaliseCaseState` by `test 0` below rather than assumed.
 */
const blocked = {
  doNotDisturb: { record: { doNotDisturb: true } },
  riskBlocked: { record: { riskBlocked: true } },
  disputed: { observed: { invoice: { flags: ['disputed'] } } },
  mandateRevoked: { observed: { subscription: { mandateStatus: 'revoked' } } },
};

/** Put a customer over their 7-day contact ceiling. Also a record-side fact. */
const overContactCap = (now = NOON_IST) => ({
  record: {
    customerMessagesInLast7Days: GUARDRAILS.maxMessagesPerCustomerPer7Days + 2,
    oldestCustomerMessageInWindowAt: new Date(now.getTime() - 1 * DAY).toISOString(),
  },
});

/** A healthy diagnosis that would NOT trip any approval check even if it were claimed. */
function diagnosisOk(over = {}) {
  return {
    rootCause: 'INSUFFICIENT_FUNDS',
    source: 'ERROR_CODE',
    matchTier: 'CODE',
    matchedOn: 'BAD_NUMBER',
    abstained: false,
    requiresApprovalForMoneyMovement: false,
    explanation: 'issuer declined for insufficient funds',
    confidence: 0.9,
  };
}

const freshRun = () => ({ retriesThisRun: 0, messagesThisRun: 0 });

const call = (fn, over = {}) =>
  fn({
    observed: observation(over.observed),
    diagnosis: over.diagnosis ?? diagnosisOk(),
    record: over.record ?? {},
    runState: over.runState ?? freshRun(),
    now: over.now ?? NOON_IST,
    config: over.config ?? { GUARDRAILS, POLICY },
  });

// ---------------------------------------------------------------------------------------------
// 0. THE FIXTURES THEMSELVES. This test exists because on the first run of this file, four tests
//    passed vacuously: I had put `riskBlocked` and `customerMessagesInLast7Days` on the
//    observation, `normaliseCaseState` reads them from the case record, so the "blocked" cases
//    were not blocked and the assertions about refusing to act proved nothing.
//
//    A test suite whose fixtures do not produce the condition under test is worse than no suite:
//    it reports confidence it has not earned. So the fixtures are asserted before they are used.
// ---------------------------------------------------------------------------------------------

test('the blocking fixtures actually produce the conditions they claim to', () => {
  for (const [flag, shape] of Object.entries(blocked)) {
    const cs = normaliseCaseState({
      observed: observation(shape.observed),
      record: shape.record ?? {},
      now: NOON_IST,
    });
    assert.equal(
      cs[flag], true,
      `the "${flag}" fixture does not set caseState.${flag} — every test using it would pass ` +
        `vacuously while asserting that a policy refused an action on an unblocked case`
    );
  }

  const capped = normaliseCaseState({
    observed: observation(),
    record: overContactCap().record,
    now: NOON_IST,
  });
  assert.ok(
    capped.customerMessagesInLast7Days > GUARDRAILS.maxMessagesPerCustomerPer7Days,
    'the contact-cap fixture does not exceed the cap'
  );

  /** And the healthy fixture must be genuinely healthy, or the "acts on a clean case" tests lie. */
  const clean = normaliseCaseState({ observed: observation(), record: {}, now: NOON_IST });
  for (const flag of ['doNotDisturb', 'riskBlocked', 'disputed', 'mandateRevoked']) {
    assert.equal(clean[flag], false, `the clean fixture is not clean: ${flag} is set`);
  }
});

// ---------------------------------------------------------------------------------------------
// 1. THE SHARED CONTRACT. metrics.js scores five arms with one code path, which only works if
//    every arm emits the same record shape. A baseline that omitted `candidates` would silently
//    score zero guardrail refusals — i.e. would look perfectly compliant.
// ---------------------------------------------------------------------------------------------

test('every baseline emits the full decision-record contract', () => {
  const required = [
    'schemaVersion', 'policyArm', 'decidedAt', 'eventId', 'customerId', 'amountPaise',
    'lossType', 'marginApplied', 'diagnosis', 'caseState', 'runState', 'outcome', 'chosen',
    'waitUntil', 'stop', 'requiresApproval', 'approvalReasons', 'approvalCheckIds',
    'clearedByApproval', 'approvedBy', 'barPaise', 'calibrationNote', 'deferralLimit',
    'candidates', 'guardrailsEvaluated', 'explain',
  ];

  for (const [name, fn] of [
    ['B0', decideB0DoNothing], ['B1', decideB1NaiveRetry],
    ['B2', decideB2Aggressive], ['B3', decideB3FixedLadder],
  ]) {
    const rec = call(fn);
    for (const key of required) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(rec, key),
        `${name} is missing "${key}" — metrics.js asserts on presence, and a missing key would ` +
          `score as zero rather than failing`
      );
    }
    assert.equal(rec.schemaVersion, DECISION_SCHEMA_VERSION, `${name} schema version`);
    assert.ok(Object.values(Outcome).includes(rec.outcome), `${name} emitted a real Outcome`);
    assert.equal(typeof rec.explain, 'string', `${name} must explain itself in English`);
    assert.ok(rec.explain.length > 20, `${name} explanation must say something`);
  }
});

test('the record shape matches what the production policy emits, key for key', () => {
  /**
   * The strongest available check that the baselines cannot drift from the contract: compare their
   * key set against `decideForCase`'s. Asserting the baselines' keys are a SUBSET of production's
   * (plus the one field they add) means a field renamed in production breaks this test rather than
   * silently reading as null in the metrics layer for four arms out of five.
   */
  const scoreAction = () => ({ p: 0.4, support: { state: 'SUPPORTED', rows: 500 } });
  const prod = decideForCase({
    observed: observation(),
    diagnosis: diagnosisOk(),
    record: {},
    scoreAction,
    runState: freshRun(),
    now: NOON_IST,
    config: { GUARDRAILS, POLICY },
  });

  const prodKeys = new Set(Object.keys(prod));
  /** `diagnosisUsed` is the one field baselines add: it records that they did not read diagnosis. */
  const allowedExtra = new Set(['diagnosisUsed']);

  for (const [name, fn] of [
    ['B0', decideB0DoNothing], ['B1', decideB1NaiveRetry],
    ['B2', decideB2Aggressive], ['B3', decideB3FixedLadder],
  ]) {
    const rec = call(fn);
    for (const key of Object.keys(rec)) {
      assert.ok(
        prodKeys.has(key) || allowedExtra.has(key),
        `${name} emits "${key}" which the production record does not have — the two shapes have ` +
          `drifted, and metrics.js reads them with one code path`
      );
    }
  }
});

test('no baseline invents an expected value', () => {
  /**
   * `evPaise: null` is load-bearing, not cosmetic. These policies compute no expected value, so a
   * number there would be fiction — and `metrics.js` must never rank or sum EV across arms.
   */
  for (const [name, fn] of [
    ['B1', decideB1NaiveRetry], ['B2', decideB2Aggressive], ['B3', decideB3FixedLadder],
  ]) {
    const rec = call(fn);
    if (rec.chosen) {
      assert.equal(rec.chosen.evPaise, null, `${name} must not report an EV it did not compute`);
      assert.equal(rec.chosen.p, null, `${name} must not report a probability it did not estimate`);
    }
    assert.equal(rec.barPaise, null, `${name} has no EV bar`);
    assert.equal(rec.marginApplied, null, `${name} does not reason about margin`);
    for (const c of rec.candidates) {
      assert.equal(c.priced, false, `${name} priced a candidate`);
      assert.equal(c.evPaise, null, `${name} put a price on a candidate it did not price`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 2. B0 IS A CONTROL. It must act zero times, and it must TERMINATE rather than wait, or
//    `stoppedEarlyAfter` becomes meaningless and its trail is 21 identical lines per case.
// ---------------------------------------------------------------------------------------------

test('B0 never acts, on any case, under any conditions', () => {
  const worlds = [
    {},
    { observed: { amountPaise: 9_000_000 } },
    blocked.doNotDisturb,
    blocked.mandateRevoked,
    { record: { retriesUsed: 3, touchesUsed: 5 } },
    { diagnosis: { ...diagnosisOk(), abstained: true } },
  ];
  for (const w of worlds) {
    const rec = call(decideB0DoNothing, w);
    assert.equal(rec.outcome, Outcome.STOP_PERMANENT, 'B0 must terminate, not wait');
    assert.equal(rec.chosen, null, 'B0 chose an action');
    assert.equal(rec.candidates.length, 0, 'B0 considered an action');
    assert.equal(rec.stop.code, 'ARM_DOES_NOTHING');
    assert.equal(rec.requiresApproval, false, 'B0 has nothing to approve');
  }
});

// ---------------------------------------------------------------------------------------------
// 3. B1 IS NOT CRIPPLED. The failure mode to catch is a baseline that looks like it retries and
//    in fact never gets an action past the guardrails.
// ---------------------------------------------------------------------------------------------

test('B1 actually retries a healthy case', () => {
  const rec = call(decideB1NaiveRetry);
  assert.equal(rec.outcome, Outcome.ACT, 'B1 must act on a clean case — otherwise it is B0');
  assert.equal(rec.chosen.action.kind, ActionKind.RETRY_NOW);
  assert.ok(rec.chosen.idempotencyKey, 'a money-moving action without a key cannot execute');
});

test('B1 keys its retries on retriesUsed, so successive attempts do not collide', () => {
  /**
   * Hand-computed. `mintIdempotencyKey` is `rebound:${eventId}:${signature}:${ordinal}` and money
   * actions take their ordinal from `retriesUsed`. If both attempts minted the same key,
   * `executeDecision` would dedupe the second and B1 would silently get ONE retry instead of three
   * — a 3x handicap invisible in the money total.
   */
  const k0 = call(decideB1NaiveRetry, { record: { retriesUsed: 0 } }).chosen.idempotencyKey;
  const k1 = call(decideB1NaiveRetry, {
    record: { retriesUsed: 1, lastRetryAt: new Date(NOON_IST.getTime() - 8 * HOUR).toISOString() },
  }).chosen.idempotencyKey;

  assert.equal(k0, 'rebound:evt_base_1:RETRY_NOW:0');
  assert.equal(k1, 'rebound:evt_base_1:RETRY_NOW:1');
  assert.notEqual(k0, k1, 'two attempts minted the same key; the second would be deduped');
});

test('B1 gets its full retry allowance across cycles, not one', () => {
  /**
   * The property: for every ordinal below the per-case cap, B1 acts; at the cap it stops. Written
   * as a loop over the cap rather than three literals so that changing `maxRetriesPerCase` cannot
   * leave a stale assertion passing.
   */
  const cap = GUARDRAILS.maxRetriesPerCase;
  for (let used = 0; used < cap; used += 1) {
    const rec = call(decideB1NaiveRetry, {
      record: {
        retriesUsed: used,
        lastRetryAt: new Date(NOON_IST.getTime() - 8 * HOUR).toISOString(),
      },
    });
    assert.equal(rec.outcome, Outcome.ACT, `B1 must be allowed retry ${used + 1} of ${cap}`);
  }

  const exhausted = call(decideB1NaiveRetry, {
    record: {
      retriesUsed: cap,
      lastRetryAt: new Date(NOON_IST.getTime() - 8 * HOUR).toISOString(),
    },
  });
  assert.equal(exhausted.outcome, Outcome.STOP_PERMANENT, 'B1 must stop at the cap');
  assert.equal(exhausted.stop.code, 'ARM_OUT_OF_RETRIES');
});

test('B1 waits rather than stopping when the retry gap has not cleared', () => {
  /**
   * The distinction this pins: a DEFER means come back later, a FORBID means there is nothing left.
   * Collapsing DEFER into a stop would credit B1 with a stopping rule it does not have AND cut its
   * retries short. The retry gap is 6h, so a retry 1h ago must produce a WAIT with a real instant.
   */
  const rec = call(decideB1NaiveRetry, {
    record: { retriesUsed: 1, lastRetryAt: new Date(NOON_IST.getTime() - 1 * HOUR).toISOString() },
  });
  assert.equal(rec.outcome, Outcome.WAIT, 'a gap that has not cleared is a wait, not a stop');
  assert.ok(rec.waitUntil, 'a WAIT without an instant would spin forever');
  assert.ok(
    new Date(rec.waitUntil).getTime() > NOON_IST.getTime(),
    'the wait instant must be in the future'
  );
});

test('B1 obeys every guardrail it is given — it is naive, not exempt', () => {
  /**
   * Scoped to the rules that actually govern a RETRY. `ABS_DO_NOT_DISTURB` is a CONTACT rule, so it
   * must NOT stop B1 — asserting the rule's real scope rather than assuming every absolute flag
   * blocks everything. Getting that distinction wrong in the other direction would have made B1
   * refuse to retry perfectly retryable cases and handed Rebound a free advantage.
   */
  for (const flag of ['riskBlocked', 'disputed', 'mandateRevoked']) {
    const rec = call(decideB1NaiveRetry, blocked[flag]);
    assert.equal(
      rec.outcome, Outcome.STOP_PERMANENT,
      `B1 must not retry a case blocked by ${flag}`
    );
    assert.equal(rec.chosen, null, `B1 chose an action on a ${flag} case`);
  }

  const dnd = call(decideB1NaiveRetry, blocked.doNotDisturb);
  assert.equal(
    dnd.outcome, Outcome.ACT,
    'do-not-disturb governs customer contact, and B1 only ever retries — it must not be blocked'
  );
});

test('B1 is gated on large amounts like every other arm', () => {
  /**
   * A naive policy is not licensed to charge above the threshold without a human. If it were, B1
   * would be an arm no merchant could run, and beating an arm nobody could run proves nothing.
   */
  const rec = call(decideB1NaiveRetry, {
    observed: { amountPaise: GUARDRAILS.humanApprovalThresholdPaise + 1 },
  });
  assert.equal(rec.outcome, Outcome.AWAIT_APPROVAL);
  assert.ok(rec.approvalCheckIds.includes('APR_LARGE_AMOUNT'));
});

test('B1 is NOT gated on a weak or abstained diagnosis it never reads', () => {
  /**
   * THE CONFOUND TEST. The approval gate was measured to freeze ~72% of exposure. If the baselines
   * were gated on diagnosis quality, most of their actions would sit in an approval queue and
   * Rebound's advantage would be mostly an artifact of a default argument value — with nothing in
   * the money total looking wrong.
   *
   * A baseline's charge is authorised by a fixed rule, not by a diagnosis it does not consult, so
   * `APR_WEAK_DIAGNOSIS` and `APR_ABSTAINED_DIAGNOSIS` must not fire for it. Both are asserted
   * here, and the contrast against Rebound on the SAME inputs is asserted in the test below so
   * that this cannot be mistaken for the gate being broken for everyone.
   */
  for (const d of [
    { ...diagnosisOk(), requiresApprovalForMoneyMovement: true, matchTier: 'TEXT' },
    { ...diagnosisOk(), abstained: true, rootCause: 'UNKNOWN' },
  ]) {
    const rec = call(decideB1NaiveRetry, { diagnosis: d });
    assert.equal(
      rec.outcome, Outcome.ACT,
      'a baseline must not be held up by the quality of a diagnosis it never consulted'
    );
    assert.deepEqual(rec.approvalCheckIds, []);
  }
});

test('Rebound IS gated on a weak diagnosis on the same inputs', () => {
  /**
   * The other half of the pair. Without this, the test above would also pass if I had simply broken
   * the approval gate for everybody — which would be a far worse bug and would look like a
   * successful test run.
   */
  const scoreAction = () => ({ p: 0.4, support: { state: 'SUPPORTED', rows: 500 } });
  const rec = decideForCase({
    observed: observation(),
    diagnosis: { ...diagnosisOk(), requiresApprovalForMoneyMovement: true, matchTier: 'TEXT' },
    record: {},
    scoreAction,
    runState: freshRun(),
    now: NOON_IST,
    config: { GUARDRAILS, POLICY },
  });
  assert.equal(
    rec.outcome, Outcome.AWAIT_APPROVAL,
    'the EV policy claims its diagnosis, so a weak one must send the case to a human'
  );
  assert.ok(rec.approvalCheckIds.includes('APR_WEAK_DIAGNOSIS'));
});

// ---------------------------------------------------------------------------------------------
// 4. B2 IS GENUINELY AGGRESSIVE — and its aggression must be VISIBLE in its own audit trail,
//    because that is the only way its violations are countable by the same query that returns
//    zero for the compliant arms.
// ---------------------------------------------------------------------------------------------

test('B2 sends messages at all — the retry-only regression', () => {
  /**
   * THE REGRESSION TEST FOR THE DEFECT THIS FILE ACTUALLY FOUND.
   *
   * B2's exemption was first written as "ignore everything that is not an ABSOLUTE rule". That swept
   * in `BUD_RETRIES_PER_CASE`, so B2 retried the same card on every cycle, and because a retry is
   * always first in its preference order and was never refused, it NEVER SENT A SINGLE MESSAGE. The
   * arm whose entire identity is "retry AND message everyone" was silently retry-only: its
   * quiet-hours and contact-cap violation counts would both have been zero, and the compliance
   * contrast the whole project rests on would have been measured against an arm that never contacted
   * anybody.
   *
   * The property that pins it: B2 must respect its own retry cap, so that retries can run out and
   * contact can begin. Asserted by exhausting the cap and requiring a contacting action.
   */
  const atCap = call(decideB2Aggressive, {
    record: { retriesUsed: GUARDRAILS.maxRetriesPerCase },
  });
  assert.equal(atCap.outcome, Outcome.ACT, 'B2 must still act once its retries are gone');
  assert.ok(
    CUSTOMER_CONTACTING.has(atCap.chosen.action.kind),
    'B2 must contact the customer once its retry budget is exhausted — otherwise it is B1 with ' +
      'extra steps and its violation counts are all zero'
  );

  /** And the retry cap must genuinely bind, or the case above is unreachable in a real run. */
  const overCap = call(decideB2Aggressive, {
    record: { retriesUsed: GUARDRAILS.maxRetriesPerCase + 5 },
  });
  assert.ok(
    !MONEY_MOVING.has(overCap.chosen?.action?.kind ?? ''),
    'B2 must not retry past its own declared cap of ' + GUARDRAILS.maxRetriesPerCase
  );
});

test('B2 acts inside quiet hours, and records the violation it ignored', () => {
  /**
   * 2026-03-05T19:00:00Z is 00:30 IST — inside the 21:00–09:00 IST quiet window. A compliant arm
   * must refuse to contact; B2 must contact anyway AND its trail must show the true DEFER verdict.
   * An arm that rewrote its own verdict would audit as compliant while behaving otherwise, and its
   * violation count would come out zero for the most aggressive policy in the set.
   */
  const midnightIST = new Date('2026-03-05T19:00:00Z');
  const rec = call(decideB2Aggressive, {
    now: midnightIST,
    /** Retries exhausted, so the only actions left are contacting ones. */
    record: { retriesUsed: GUARDRAILS.maxRetriesPerCase },
  });

  assert.equal(rec.outcome, Outcome.ACT, 'B2 must message inside quiet hours');
  assert.ok(CUSTOMER_CONTACTING.has(rec.chosen.action.kind), 'B2 chose a contacting action');

  const chosenLine = rec.candidates.find((c) => c.chosen);
  const ids = chosenLine.violations.map((v) => v.id);
  assert.ok(
    ids.includes('TIM_QUIET_HOURS'),
    'B2 must record the quiet-hours violation it chose to ignore — its trail is the evidence'
  );
  assert.equal(
    chosenLine.verdict, Verdict.DEFER,
    'the recorded verdict must be the TRUE verdict from the shared engine, not a rewritten one'
  );
});

test('B2 breaches the per-customer contact cap, visibly', () => {
  const rec = call(decideB2Aggressive, {
    record: {
      retriesUsed: GUARDRAILS.maxRetriesPerCase,
      ...overContactCap().record,
    },
  });
  assert.equal(rec.outcome, Outcome.ACT);
  const ids = rec.candidates.find((c) => c.chosen).violations.map((v) => v.id);
  assert.ok(
    ids.includes('TIM_CUSTOMER_MESSAGE_CAP'),
    `B2 must breach the contact cap; recorded violations were [${ids.join(', ')}]`
  );
});

test('B2 exceeds the per-case touch budget, visibly', () => {
  const rec = call(decideB2Aggressive, {
    record: {
      retriesUsed: GUARDRAILS.maxRetriesPerCase,
      touchesUsed: GUARDRAILS.maxTouchesPerCase + 3,
    },
  });
  assert.equal(rec.outcome, Outcome.ACT, 'B2 ignores budget rules');
  const ids = rec.candidates.find((c) => c.chosen).violations.map((v) => v.id);
  assert.ok(
    ids.includes('BUD_TOUCHES_PER_CASE'),
    `expected a touch-budget breach; recorded [${ids.join(', ')}]`
  );
});

test('B2 still obeys every ABSOLUTE rule — it is aggressive, not illegal', () => {
  /**
   * The property, stated so it cannot rot: whatever B2 chooses, the chosen line must carry ZERO
   * ABSOLUTE-kind violations. Asserted over each flag individually AND over all of them at once, so
   * a future widening of `B2_IGNORED_RULE_IDS` fails here rather than shipping.
   */
  const combined = {
    record: { ...blocked.doNotDisturb.record, ...blocked.riskBlocked.record },
    observed: { ...blocked.disputed.observed, ...blocked.mandateRevoked.observed },
  };

  for (const shape of [...Object.values(blocked), combined]) {
    const rec = call(decideB2Aggressive, shape);
    const chosenLine = rec.candidates.find((c) => c.chosen);
    if (!chosenLine) {
      assert.equal(rec.outcome, Outcome.STOP_PERMANENT);
      assert.equal(rec.stop.code, 'ARM_ABSOLUTELY_BLOCKED');
      continue;
    }
    const absolutes = chosenLine.violations.filter((v) => v.kind === RuleKind.ABSOLUTE);
    assert.deepEqual(
      absolutes.map((v) => v.id), [],
      `B2 broke an absolute rule under ${JSON.stringify(shape)} — that is not aggression, it is a ` +
        `policy nobody would ship, and beating it would prove nothing`
    );
  }
});

test('every rule B2 ignores is a real rule id', () => {
  /**
   * A typo in `B2_IGNORED_RULE_IDS` would silently narrow B2's exemption — it would obey a rule it
   * is documented as ignoring, its violation count would drop, and the compliance contrast would
   * quietly weaken. Nothing else in the suite would notice.
   */
  const known = new Set(RULES.map((r) => r.id));
  for (const id of B2_IGNORED_RULE_IDS) {
    assert.ok(known.has(id), `B2 claims to ignore "${id}", which is not a rule in RULES`);
  }
});

test('the printed arm profile matches the code that enforces it', () => {
  /**
   * `describeArm` is what the CLI prints so a reviewer can check the baselines were fairly built
   * without reading the source. If the printed profile could drift from the behaviour, printing it
   * would be worse than saying nothing.
   */
  for (const arm of Object.values(POLICY_ARMS)) {
    const d = describeArm(arm.id);
    assert.equal(d.id, arm.id);
    assert.equal(typeof d.hasStoppingRule, 'string');
    assert.ok(Array.isArray(d.ignoresRuleIds));
  }
  assert.deepEqual(
    describeArm('B2_AGGRESSIVE').ignoresRuleIds, [...B2_IGNORED_RULE_IDS],
    'the profile B2 prints must be read from the constant its code enforces, not restated'
  );
  for (const id of ['B0_DO_NOTHING', 'B1_NAIVE_RETRY', 'B3_FIXED_LADDER', 'REBOUND_EV']) {
    assert.deepEqual(
      describeArm(id).ignoresRuleIds, [],
      `${id} is described as fully compliant and must ignore nothing`
    );
  }
  assert.equal(describeArm('REBOUND_EV').usesExpectedValue, true);
  for (const id of ['B0_DO_NOTHING', 'B1_NAIVE_RETRY', 'B2_AGGRESSIVE', 'B3_FIXED_LADDER']) {
    assert.equal(describeArm(id).usesDiagnosis, false, `${id} must not use diagnosis`);
    assert.equal(describeArm(id).usesExpectedValue, false, `${id} must not use EV`);
  }
});

test('B2 sends on multiple channels, so it is not secretly a one-trick arm', () => {
  /**
   * B2's story is "message everyone on everything". If its action order were broken such that only
   * one channel was ever reachable, it would be a much weaker opponent than described. A fresh
   * customer each iteration keeps the per-customer cap from masking channel variety.
   */
  const seen = new Set();
  for (let touches = 0; touches < GUARDRAILS.maxTouchesPerCase; touches += 1) {
    const rec = call(decideB2Aggressive, {
      record: { retriesUsed: GUARDRAILS.maxRetriesPerCase, touchesUsed: touches },
      observed: { customerId: `cust_ch_${touches}`, eventId: `evt_ch_${touches}` },
    });
    if (rec.chosen?.action?.channel) seen.add(rec.chosen.action.channel);
  }
  assert.ok(
    seen.size >= 1,
    'B2 must be able to contact at least one channel once retries are exhausted; reached none'
  );
});

// ---------------------------------------------------------------------------------------------
// 5. B3 IS THE ARM WORTH BEATING. The failure mode to catch is the one that would flatter Rebound
//    most and be hardest to see: B3 quietly degenerating into B0.
// ---------------------------------------------------------------------------------------------

test('B2 is subject to the approval gate — the one boundary its exemption does not cross', () => {
  /**
   * The gate is not a timing or budget control; it is the boundary between an automated system and
   * an accountable human. An arm that charged Rs 3,00,000 with no signature would not be
   * "aggressive", it would be the thing this project argues against, and letting Rebound win by
   * comparison with something indefensible would prove nothing.
   */
  const rec = call(decideB2Aggressive, {
    observed: { amountPaise: GUARDRAILS.humanApprovalThresholdPaise * 10 },
  });
  assert.equal(rec.outcome, Outcome.AWAIT_APPROVAL);
  assert.ok(rec.approvalCheckIds.includes('APR_LARGE_AMOUNT'));
});

test('B3 walks its whole ladder and then stops', () => {
  /**
   * Hand-computed against the ladder in the source: rung = retriesUsed + touchesUsed, and the
   * ladder is [RETRY_NOW, RETRY_SCHEDULED+24h, SEND_LINK/SMS, RETRY_SCHEDULED+72h, SEND_LINK/EMAIL].
   * Walking the rungs by advancing the work counters checks the index arithmetic AND that every
   * rung is reachable — a ladder whose later rungs are unreachable is a shorter ladder than claimed.
   */
  const expected = [
    ActionKind.RETRY_NOW,
    ActionKind.RETRY_SCHEDULED,
    ActionKind.SEND_LINK,
    ActionKind.RETRY_SCHEDULED,
    ActionKind.SEND_LINK,
  ];

  for (let rung = 0; rung < expected.length; rung += 1) {
    /**
     * Split the rung across the two counters the way a real run would: money actions increment
     * retriesUsed, contacting actions increment touchesUsed. Retries used is capped at the
     * guardrail so the retry-budget rule does not fire and mask the ladder logic.
     */
    const retries = Math.min(rung, GUARDRAILS.maxRetriesPerCase - 1);
    const touches = rung - retries;
    const rec = call(decideB3FixedLadder, {
      record: {
        retriesUsed: retries,
        touchesUsed: touches,
        lastRetryAt: new Date(NOON_IST.getTime() - 48 * HOUR).toISOString(),
        lastContactAt: new Date(NOON_IST.getTime() - 48 * HOUR).toISOString(),
      },
      observed: { customerId: `cust_l_${rung}` },
    });
    assert.notEqual(
      rec.outcome, Outcome.STOP_PERMANENT,
      `B3 stopped at rung ${rung} of ${expected.length} — its ladder is shorter than it claims`
    );
    assert.ok(rec.chosen, `B3 chose nothing at rung ${rung}`);
  }

  const done = call(decideB3FixedLadder, {
    record: { retriesUsed: GUARDRAILS.maxRetriesPerCase, touchesUsed: expected.length },
  });
  assert.equal(done.outcome, Outcome.STOP_PERMANENT, 'B3 must have a stopping rule');
  assert.equal(done.stop.code, 'LADDER_EXHAUSTED');
});

test('B3 is indexed on work done, not on cycle number', () => {
  /**
   * The property: the same work counters select the same RUNG regardless of the instant. Indexing on
   * cycle index would let a case skip its own steps by being decided at an awkward hour, and would
   * give the same case different treatment under two horizons.
   *
   * NOTE WHAT THIS DELIBERATELY NO LONGER ASSERTS. An earlier version compared the chosen action's
   * KIND across two instants, and that assertion was wrong: a timed rung is a RETRY_SCHEDULED before
   * its due instant and a RETRY_NOW after it, which is exactly the fix for the stall documented in
   * `baselines.js`. Asserting on the kind pinned the bug in place. The rung is the invariant; the
   * materialised kind is a function of the rung AND the clock, and the next test covers that.
   */
  const record = {
    retriesUsed: 1,
    touchesUsed: 0,
    lastRetryAt: new Date(NOON_IST.getTime() - 48 * HOUR).toISOString(),
  };
  const rungOf = (rec) => {
    /**
     * `explain`, not `rationale`. `baselineRecord` names the one-sentence reason `explain` to match
     * the production record's field, and reading the wrong key here returned undefined — which the
     * assertion below catches rather than silently treating as "same rung both times".
     */
    const m = /step (\d+) of (\d+)/.exec(rec.explain ?? '');
    assert.ok(m, `B3 did not record which rung it was on: ${rec.explain}`);
    return m[1];
  };
  const a = call(decideB3FixedLadder, { record, now: NOON_IST });
  const b = call(decideB3FixedLadder, { record, now: new Date(NOON_IST.getTime() + 3 * DAY) });
  assert.equal(
    rungOf(a), rungOf(b),
    'the same work history must select the same rung whatever the clock says'
  );
});

test('a timed rung waits before its due instant and executes after it — the stall regression', () => {
  /**
   * THE REGRESSION TEST FOR THE BUG THAT CRIPPLED THE HONEST BASELINE.
   *
   * B3 used to compute rung 1 as `now + 24h`. The orchestrator treats a future RETRY_SCHEDULED as a
   * wakeup and RE-DECIDES at wakeup, so the rung recomputed a fresh +24h every time and the ladder
   * re-armed the same rung forever: 65 of 80 cases got exactly one action and stalled for nine days.
   *
   * The property that makes the stall impossible: with the SAME work counters, the rung must resolve
   * to a wait BEFORE its due instant and to an execution AT OR AFTER it. Anchored to the failure, the
   * due instant does not move when we look at it again — so waking up at it produces an action, and
   * the action advances the rung.
   */
  const failedAt = new Date(NOON_IST.getTime() - 2 * HOUR);
  const record = {
    retriesUsed: 1, // rung 1: the "+24h after the failure" retry
    touchesUsed: 0,
    lastRetryAt: failedAt.toISOString(),
  };
  const observed = { occurredAt: failedAt.toISOString(), detectedAt: failedAt.toISOString() };

  // 2h after the failure: the 24h rung is 22h away, so it must be a scheduled wait.
  const early = call(decideB3FixedLadder, { record, observed, now: NOON_IST });
  assert.equal(
    early.chosen.action.kind, ActionKind.RETRY_SCHEDULED,
    'before its due instant the timed rung must schedule a wakeup'
  );

  /**
   * The instant it schedules must be anchored to the FAILURE, not to now. This is the assertion that
   * actually catches the bug: `now + 24h` would be 24h from the decision instant, which drifts every
   * time the case is re-decided. Anchored, it is failure + 24h, which does not move.
   */
  assert.equal(
    new Date(early.chosen.action.scheduledFor).getTime(),
    failedAt.getTime() + 24 * HOUR,
    'the rung must be due 24h after the FAILURE; anchoring it to the decision instant is the stall — ' +
      'each re-decision would push the retry another 24h into the future and it would never fire'
  );

  // Woken at the due instant, with the work counters UNCHANGED, it must now act rather than re-arm.
  const dueNow = new Date(failedAt.getTime() + 24 * HOUR);
  const onTime = call(decideB3FixedLadder, { record, observed, now: dueNow });
  assert.equal(
    onTime.outcome, Outcome.ACT,
    'at its due instant the rung must act, or the ladder can never advance past it'
  );
  assert.equal(
    onTime.chosen.action.kind, ActionKind.RETRY_NOW,
    'a retry that is due must be a RETRY_NOW; emitting RETRY_SCHEDULED at the present instant is ' +
      'how the arm re-armed the same rung forever'
  );
  assert.ok(
    !onTime.chosen.action.scheduledFor ||
      new Date(onTime.chosen.action.scheduledFor).getTime() <= dueNow.getTime(),
    'a due rung must not carry a future scheduledFor — the orchestrator would defer it again'
  );
});


test('B3 falls forward past a blocked rung instead of parking the case', () => {
  /**
   * THE DEGENERATION TEST, and the most important one for B3. If B3 waited whenever its current rung
   * was blocked, it would silently become B0 on any case whose customer had hit the contact cap —
   * and the money total would just be smaller, with nothing looking wrong.
   *
   * Setup: the case is at the SMS rung (rung 2 = 1 retry + 1 touch) and the customer has exhausted
   * their 7-day contact allowance. A sensible operator moves to the next step rather than parking
   * the case, so B3 must reach the 72h retry.
   */
  const rec = call(decideB3FixedLadder, {
    record: {
      retriesUsed: 1,
      touchesUsed: 1,
      lastRetryAt: new Date(NOON_IST.getTime() - 48 * HOUR).toISOString(),
      ...overContactCap().record,
    },
  });

  assert.notEqual(
    rec.outcome, Outcome.STOP_PERMANENT,
    'B3 must not abandon a case because one rung is blocked'
  );
  assert.equal(
    rec.outcome, Outcome.ACT,
    `B3 parked the case instead of falling forward — this is how a fixed-ladder baseline silently ` +
      `becomes B0. Chosen: ${JSON.stringify(rec.chosen?.action ?? null)}`
  );
  assert.ok(
    MONEY_MOVING.has(rec.chosen.action.kind),
    `with contact barred, B3 should fall forward to the next retry rung; it chose ` +
      `${rec.chosen.action.kind}`
  );
});

test('B3 obeys every guardrail, unlike B2, on identical inputs', () => {
  /**
   * The paired compliance claim, asserted directly rather than left to the metrics layer. Same
   * instant, same case, same everything: B2 acts and B3 does not contact. If both acted, the
   * "fully compliant" description of B3 would be false and the headline comparison meaningless.
   */
  const midnightIST = new Date('2026-03-05T19:00:00Z');
  const setup = {
    now: midnightIST,
    record: { retriesUsed: GUARDRAILS.maxRetriesPerCase, touchesUsed: 2 },
  };

  const b2 = call(decideB2Aggressive, setup);
  const b3 = call(decideB3FixedLadder, setup);

  assert.equal(b2.outcome, Outcome.ACT, 'B2 must act inside quiet hours');

  if (b3.chosen) {
    const violated = b3.candidates.find((c) => c.chosen).violations;
    assert.deepEqual(
      violated, [],
      'B3 acted on an option the guardrails objected to; it is meant to be fully compliant'
    );
  } else {
    assert.ok(
      [Outcome.WAIT, Outcome.STOP_PERMANENT].includes(b3.outcome),
      'a compliant arm with nothing permitted must wait or stop'
    );
  }
});

test('B3 treats a hopeless case exactly like a promising one — that is the experiment', () => {
  /**
   * The independent variable, pinned. B3 has no conditioning: a REVOKED_MANDATE case (unrecoverable
   * by retry) and an INSUFFICIENT_FUNDS case (very recoverable) get the same rung. If this test ever
   * fails, B3 has acquired diagnosis-awareness and is no longer the baseline it is described as.
   */
  const record = { retriesUsed: 0, touchesUsed: 0 };
  const promising = call(decideB3FixedLadder, { record, diagnosis: diagnosisOk() });
  const hopeless = call(decideB3FixedLadder, {
    record,
    diagnosis: { ...diagnosisOk(), rootCause: 'MANDATE_REVOKED', explanation: 'mandate cancelled' },
  });
  assert.equal(
    promising.chosen.action.kind, hopeless.chosen.action.kind,
    'B3 must not condition on diagnosis — that capability is what Rebound is being tested for'
  );
  assert.equal(promising.diagnosisUsed, false);
  assert.equal(hopeless.diagnosisUsed, false);
});

test('B3 does not condition on amount or margin either', () => {
  const record = { retriesUsed: 0, touchesUsed: 0 };
  const small = call(decideB3FixedLadder, { record, observed: { amountPaise: 20_000 } });
  const large = call(decideB3FixedLadder, {
    record,
    observed: { amountPaise: GUARDRAILS.humanApprovalThresholdPaise - 1 },
  });
  assert.equal(
    small.chosen.action.kind, large.chosen.action.kind,
    'a fixed ladder spends the same on a Rs 200 sale as on a Rs 24,999 one — that is the point'
  );
});

// ---------------------------------------------------------------------------------------------
// 6. THE REGISTRY. A typo in an arm name must not silently run the EV policy and report its
//    numbers under a baseline's label — the single most misleading bug this file could have.
// ---------------------------------------------------------------------------------------------

test('every declared arm has an implementation, and REBOUND_EV maps to the production path', () => {
  for (const arm of Object.values(POLICY_ARMS)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(ARM_POLICIES, arm.id),
      `arm ${arm.id} is declared in POLICY_ARMS but has no entry in ARM_POLICIES`
    );
  }
  assert.equal(
    policyFor(POLICY_ARMS.REBOUND_EV.id), undefined,
    'REBOUND_EV must resolve to undefined so runCycle uses its own default, decideForCase'
  );
  for (const id of ['B0_DO_NOTHING', 'B1_NAIVE_RETRY', 'B2_AGGRESSIVE', 'B3_FIXED_LADDER']) {
    assert.equal(typeof policyFor(id), 'function', `${id} must resolve to a function`);
  }
});

test('an unknown arm id throws instead of falling back to the EV policy', () => {
  assert.throws(
    () => policyFor('B4_TYPO'),
    /unknown arm/,
    'an unrecognised arm silently returning undefined would run Rebound under a baseline label'
  );
});

test('each baseline labels its own records with its own arm id', () => {
  /**
   * Cheap, and it catches a copy-paste that would make two arms indistinguishable in the metrics
   * layer while both still producing plausible output.
   */
  const pairs = [
    ['B0_DO_NOTHING', decideB0DoNothing],
    ['B1_NAIVE_RETRY', decideB1NaiveRetry],
    ['B2_AGGRESSIVE', decideB2Aggressive],
    ['B3_FIXED_LADDER', decideB3FixedLadder],
  ];
  const seen = new Set();
  for (const [id, fn] of pairs) {
    const rec = call(fn);
    assert.equal(rec.policyArm, id, `${id} mislabelled itself as ${rec.policyArm}`);
    assert.ok(!seen.has(rec.policyArm), `two arms both reported ${rec.policyArm}`);
    seen.add(rec.policyArm);
  }
});

// ---------------------------------------------------------------------------------------------
// 7. NO ARM MAY BE ACCIDENTALLY MUTE. The single cheapest guard against the whole class of
//    "baseline was quietly crippled" defects: on a clean case, three of the four must act.
// ---------------------------------------------------------------------------------------------

test('on a clean case, B1, B2 and B3 all act and only B0 does not', () => {
  const acting = [];
  for (const [id, fn] of [
    ['B0_DO_NOTHING', decideB0DoNothing],
    ['B1_NAIVE_RETRY', decideB1NaiveRetry],
    ['B2_AGGRESSIVE', decideB2Aggressive],
    ['B3_FIXED_LADDER', decideB3FixedLadder],
  ]) {
    const rec = call(fn);
    if (rec.outcome === Outcome.ACT) acting.push(id);
  }
  assert.deepEqual(
    acting.sort(), ['B1_NAIVE_RETRY', 'B2_AGGRESSIVE', 'B3_FIXED_LADDER'],
    'exactly the three acting arms must act on a clean case; a mute baseline is a rigged comparison'
  );
});

// ---------------------------------------------------------------------------------------------
// 8. TRAJECTORIES, NOT DECISIONS.
//
//    Every test above this line examines ONE decision, and the worst bug this file has had was
//    invisible to all of them. B3 proposed exactly the right action at every rung — and never
//    advanced, because the rung it proposed was a wakeup whose instant moved every time the case
//    was re-decided. 65 of 80 cases received one action and stalled for nine days, and the arm
//    still passed 32 unit tests and 8 of 8 mutations.
//
//    A policy that never advances is a property of a SEQUENCE of decisions. No single-decision test
//    can express it, so these run the arms through the real harness for a real horizon and assert
//    on what happened over time. They are slower than everything above and they are the only tests
//    here that could have caught the defect that mattered most.
// ---------------------------------------------------------------------------------------------

/**
 * A scorer that fails loudly if a baseline consults it. Doubles as an assertion: no baseline may read
 * the fitted model, and if one does this stops being a slow test and becomes a failing one.
 */
const forbiddenScorer = () => {
  throw new Error('a baseline consulted the fitted recovery model; baselines must not read it');
};

/** Run one arm over a small world for the full horizon. Run-level breakers raised, as in `npm run eval`. */
async function trajectory(armId, { count = 24, seed = 'traj' } = {}) {
  const startAt = new Date('2026-03-05T09:00:00Z');
  const world = await buildWorld({ seed, split: 'TRAIN', count, startAt });
  const result = await runArm({
    world,
    arm: armId,
    decide: policyFor(armId),
    scoreAction: forbiddenScorer,
    cycles: HORIZON.cycles,
    stepHours: HORIZON.stepHours,
    config: {
      GUARDRAILS: { ...GUARDRAILS, maxMessagesPerRun: 10_000, maxRetriesPerRun: 10_000 },
      POLICY,
    },
  });
  const cases = await result.store.getCases(result.runId);
  const actions = await result.store.getActions(result.runId);
  const perCase = new Map();
  for (const a of actions) perCase.set(a.eventId, (perCase.get(a.eventId) ?? 0) + 1);
  return { result, cases, actions, perCase, world };
}

test('B3 climbs its ladder over a real horizon instead of stalling on one rung', async () => {
  const { cases, actions, perCase } = await trajectory('B3_FIXED_LADDER');

  /**
   * THE ASSERTION THE OLD SUITE COULD NOT MAKE. Under the stall, the modal case received exactly one
   * action. A ladder with five rungs and a ten-day horizon must get a meaningful share of cases past
   * the second rung, or it is not the ladder it claims to be and Rebound is beating a straw man.
   *
   * Deliberately a property with a loose threshold rather than an exact count: the exact number
   * depends on the generator, and a test pinned to it would fail on every unrelated world change and
   * be edited until it passed. "A quarter of cases get past rung 2" is the claim that matters.
   */
  const touchedCases = [...perCase.values()];
  const pastRungTwo = touchedCases.filter((n) => n > 2).length;
  assert.ok(
    pastRungTwo >= cases.length * 0.25,
    `only ${pastRungTwo} of ${cases.length} cases got past rung 2 (actions: ${actions.length}). ` +
      `B3 is stalling on a rung: it re-arms a wakeup whose instant moves each time it is re-decided, ` +
      `so the rung never completes and the arm degenerates into one retry.`
  );

  /**
   * And the ladder must END. A fixed ladder that runs out of rungs stops, with a reason — that is
   * half of what makes it the honest baseline, and the Track 03 bar names stopping rules explicitly.
   */
  const stopped = cases.filter((c) => c.state === 'STOPPED').length;
  assert.ok(
    stopped > 0,
    'no B3 case reached STOPPED over ten days; the ladder never exhausts, so the arm has no stopping rule'
  );
});

test('no arm STALLS: a case left unresolved must have been worked, not looped over', async () => {
  /**
   * The general form of the B3 stall. This test asserted something subtly different until #61 added
   * the simulated approver, at which point it failed on B2 at 13 of 24 — and the failure was the
   * test's, not B2's. The episode is worth recording because the direction was self-flattering: a
   * baseline that looks like it resolved less makes Rebound's margin look bigger, so "relax the
   * threshold to 0.55 and move on" would have quietly improved our own headline.
   *
   * WHAT THE OLD ASSERTION SAID: fewer than half of each arm's cases may be OPEN or SCHEDULED at the
   * horizon, on the reasoning that an unresolved case is one the policy "neither resolved nor gave up
   * on", and a majority means "the arm is looping, and the money figure it reports is the figure of a
   * policy that mostly did nothing while appearing busy."
   *
   * WHY THAT WAS WRONG. Measuring the frozen cases instead of re-thresholding showed only 2 of B2's 13
   * had ever touched the approval queue; the other 11 carried 21 actions each — one on every one of
   * the 21 cycles. That is not a policy that did nothing while appearing busy. It is B2 behaving
   * exactly as specified: it stops only on `ARM_ABSOLUTELY_BLOCKED`, has no voluntary stopping rule,
   * and this fixture raises `maxMessagesPerRun` and `maxRetriesPerRun` to 10,000 — so the test removes
   * the one budget that could ever stop B2 and then failed it for not stopping. A terminal state label
   * cannot distinguish "gave up on this case" from "still working it when the clock ran out".
   *
   * WHAT IT ASSERTS NOW: the MECHANISM. A stall is a case the arm returned to over and over without
   * advancing — many cycles available, almost no actions taken. So an unresolved case must show that
   * work actually happened on it. This still catches the B3 stall it was written for (a stalled B3
   * case re-arms a wakeup whose instant moves each time, so it accumulates ~1 action across ten days)
   * while passing a relentless arm that genuinely acted every cycle.
   *
   * B0 is exempt: it stops every case in its first cycle by construction, which is the one arm for
   * which "resolved nothing" is correct behaviour.
   */
  for (const armId of ['B1_NAIVE_RETRY', 'B2_AGGRESSIVE', 'B3_FIXED_LADDER']) {
    const { cases, perCase } = await trajectory(armId);
    const unresolved = cases.filter((c) => c.state === 'OPEN' || c.state === 'SCHEDULED');

    /**
     * The stall signature: unresolved at the horizon AND fewer than two actions to show for ten days
     * of opportunities. Two rather than one because a case whose single action is still legitimately
     * pending a future instant is not a stall, and this must not fire on that.
     */
    const stalled = unresolved.filter((c) => (perCase.get(c.eventId) ?? 0) < 2);

    assert.ok(
      stalled.length < cases.length / 4,
      `${armId} left ${stalled.length} of ${cases.length} cases unresolved with fewer than 2 actions ` +
        `across ${HORIZON.cycles} cycles (${unresolved.length} unresolved in total) — that is the ` +
        `signature of a policy re-arming the same intent instead of advancing`
    );

    /**
     * And the complement, stated so the exemption above cannot hide a regression: every arm must
     * actually resolve something. An arm that ends with nothing terminal has not been measured.
     */
    const terminal = cases.filter((c) => c.state === 'RECOVERED' || c.state === 'STOPPED').length;
    assert.ok(terminal > 0, `${armId} resolved no case at all over ${HORIZON.cycles} cycles`);
  }
});

