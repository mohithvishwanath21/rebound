/**
 * THE ORCHESTRATOR — the part that is allowed to change the world.
 * ===============================================================
 *
 * `decide.js` is a pure function: observation in, decision record out, no side effects, no clock
 * it did not receive, no knowledge that a gateway exists. That purity is what makes every number
 * in this project reproducible. It also means something has to actually *do* the things it
 * decides, and that something is this file.
 *
 * Everything genuinely hard about Day 7 is here, because everything here is irreversible. A
 * decision can be recomputed. A charge cannot be uncharged, and a message cannot be unsent.
 *
 * WHAT ONE CYCLE DOES
 * -------------------
 *   1. ask the store which cases are due at `now`
 *   2. hydrate each case with the facts the guardrails need but nothing was supplying
 *   3. PROPOSE — decide every due case against the run state as it stands. No side effects.
 *   4. order the proposals by expected value, descending
 *   5. COMMIT — walk that order, re-decide each case against the LIVE run state, execute
 *
 * Steps 3-5 are one mechanism, not three, and the reason is in HAZARD 2 below.
 *
 * ---------------------------------------------------------------------------------------------
 * HAZARD 1 — THE ATTEMPT IS PERSISTED BEFORE THE SIDE EFFECT, NOT AFTER
 * ---------------------------------------------------------------------------------------------
 * `decide.js` mints a deterministic idempotency key and its own docblock flags the residual risk:
 * a *derived* key depends on our counter being accurate, a *persisted* key does not. So the
 * attempt row is written PENDING before the gateway call and settled after it.
 *
 * That ordering alone is not enough, and the second half is the part that is easy to get wrong.
 * `putAction` returning false is ambiguous in exactly the place it matters: the key being present
 * proves we *started*, and says nothing about whether the call finished. Two wrong readings:
 *
 *   "key exists, so it's done"     -> abandons an attempt whose money may have moved
 *   "no receipt, so do it again"   -> charges the customer twice
 *
 * Both are real money, and only one of them shows up in a report. So a restart reads the attempt
 * back and branches on its state: SETTLED means skip, PENDING means we died in flight and must
 * ask the provider what actually happened via `fetchStatus`. Neither guessing nor retrying.
 *
 * This is also why `fetchStatus` is implemented in the SIM gateway even though a simulator has no
 * asynchrony to model. If reconciliation only ran against the live API, its first real execution
 * would be in production — or, worse for this project, in front of a judge.
 *
 * ---------------------------------------------------------------------------------------------
 * HAZARD 2 — A BINDING BUDGET MUST BE SPENT ON THE MOST VALUABLE CASES
 * ---------------------------------------------------------------------------------------------
 * The decision engine ranks *actions within one case*. Until this file, nothing ranked *cases
 * against each other*. With a finite per-run retry budget, processing cases in whatever order the
 * store returned them spends the budget on whichever case the generator happened to emit first.
 *
 * What makes that dangerous rather than merely suboptimal is that it is invisible. Guardrails all
 * read healthy — the cap did its job. The action mix looks sensible. Every individual decision is
 * defensible in isolation. The loss is pure expected value and appears in no summary line.
 *
 * Hence propose-then-commit. Pricing every case against the cycle-start state is the only way to
 * get a comparable ordering at all, because pricing case N against a budget already spent by cases
 * 1..N-1 means the ordering depends on the order — circular. But acting on a cycle-start price
 * would be worse: the guardrail would see a budget that no longer exists.
 *
 * So: price against the start state to *rank*, re-decide against the live state to *act*. The
 * consequence is that the committed action can differ from the one that won the case its place in
 * the queue, and when it does, that divergence is written to the audit trail as
 * PROPOSAL_SUPERSEDED. Silently swapping it would leave the trail recording a decision that was
 * never made — and "we wanted to retry and the run budget was gone" is a materially different
 * fact from "we chose to send a link", especially to whoever asks why the expensive case got a
 * cheap action.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE GATEWAY AND THE CLOCK ARE BOTH INJECTED
 * ---------------------------------------------------------------------------------------------
 * The gateway, because `test/boundary.test.js` forbids `src/agent/**` from importing
 * `src/sim/**` — the SIM gateway resolves outcomes against latent truth, and if agent code could
 * reach it the evaluation would be a model grading its own answer key.
 *
 * The clock, because `now` arrives as an argument and `Date.now()` appears nowhere in this file.
 * A scheduler that reads the wall clock cannot be tested: proving that a retry scheduled for
 * +72h fires at +72h and not before would require waiting three days. Passing time in makes a
 * multi-day recovery sequence a loop over timestamps, and makes the whole run reproducible from
 * a seed.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 * ---------------------------------------
 * It does not decide anything. Every choice comes back from `decideForCase`. If a policy question
 * seems to want answering here, it belongs in `decide.js`, `guardrails.js` or `stopping.js` — the
 * value of a pure decision engine collapses the moment execution starts making its own choices.
 *
 * That separation is also why `runCycle` takes a `decide` function rather than importing one. Day 8
 * needs to run a naive-retry baseline through this exact loop — same guardrails, same store, same
 * gateway seed — because a baseline that runs through a different loop measures the loop, not the
 * policy. `decideForCase` remains the default, so nothing that does not ask for a baseline can get
 * one by accident.
 */

import { GUARDRAILS, POLICY } from '../core/config.js';
import { ActionKind, MONEY_MOVING, CUSTOMER_CONTACTING } from '../core/actions.js';
import { decideForCase, Outcome } from './decide.js';
import { CUSTOMER_MESSAGE_WINDOW_DAYS, invasivenessOf } from './guardrails.js';
import { gatewayMethodFor, ReceiptState } from '../razorpay/gateway.js';

const DAY_MS = 86_400_000;

/**
 * The lifecycle of one attempt row. Three states, and the middle one is the whole point.
 *
 * PENDING exists so that "we started" is representable separately from "it finished". A schema
 * with only SETTLED and FAILED forces a crash mid-flight to be recorded as one of them, and both
 * are lies: FAILED says the money definitely did not move, SETTLED says it definitely did.
 */
export const ExecState = Object.freeze({
  PENDING: 'PENDING',
  SETTLED: 'SETTLED',
  SKIPPED: 'SKIPPED',
});

/**
 * Case lifecycle. The four terminal states match `store.js`'s TERMINAL set — `getActiveCases` and
 * `getDueCases` filter on it, so a state added here without adding it there would produce a case
 * that is finished and still gets picked up every cycle forever.
 */
export const CaseState = Object.freeze({
  OPEN: 'OPEN',
  SCHEDULED: 'SCHEDULED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  RECOVERED: 'RECOVERED',
  /**
   * The customer paid with no intervention from us.
   *
   * A SEPARATE terminal state rather than `RECOVERED` with a flag, and the separation is the whole
   * value of it. Every metric in the project that totals the agent's contribution filters on
   * `RECOVERED`; had self-recovery reused that state with a `recoveredBy: 'SELF'` discriminator, each
   * of those totals would have silently absorbed money the agent never earned, and the resulting
   * figure would look like a better result rather than a bug. Two states means the default behaviour
   * of any careless sum is to EXCLUDE self-recovery, which is the safe direction to be careless in.
   *
   * Note `recoveredPaise` is deliberately NOT set on these cases — `selfRecoveredPaise` is. Same
   * reasoning: the field a metric reaches for by habit must not contain the money it should not count.
   */
  RECOVERED_SELF: 'RECOVERED_SELF',
  STOPPED: 'STOPPED',
  ESCALATED: 'ESCALATED',
  EXPIRED: 'EXPIRED',
});

/** Audit entry types this file emits. Named so the dashboard and tests share one vocabulary. */
export const AuditType = Object.freeze({
  CYCLE_STARTED: 'CYCLE_STARTED',
  CYCLE_FINISHED: 'CYCLE_FINISHED',
  CASE_DECIDED: 'CASE_DECIDED',
  PROPOSAL_SUPERSEDED: 'PROPOSAL_SUPERSEDED',
  ATTEMPT_STARTED: 'ATTEMPT_STARTED',
  ATTEMPT_SETTLED: 'ATTEMPT_SETTLED',
  ATTEMPT_FAILED: 'ATTEMPT_FAILED',
  ATTEMPT_RECONCILED: 'ATTEMPT_RECONCILED',
  ATTEMPT_DUPLICATE: 'ATTEMPT_DUPLICATE',
  CONTACT_RECORDED: 'CONTACT_RECORDED',
  MONEY_RECOVERED: 'MONEY_RECOVERED',
  /**
   * The world resolved a case for free. Emitted by the harness, not by `runCycle` — the agent has no
   * way to know this happened and must not be told, or it could learn to wait on cases that pay
   * themselves. It is in this enum because the audit trail is a single vocabulary and a reader of the
   * trail needs to see why a case closed without an attempt against it.
   */
  SELF_RECOVERED: 'SELF_RECOVERED',
  CASE_SCHEDULED: 'CASE_SCHEDULED',
  CASE_WAITING: 'CASE_WAITING',
  /**
   * The policy WANTED to postpone and was not allowed to (#67). Its own type rather than a field on
   * CASE_SCHEDULED, because it is the opposite event: nothing was scheduled.
   *
   * This exists because a refusal that shows up only as an absence is unreviewable. Before the fix,
   * one case scheduled itself sixteen times in sixteen cycles and every line looked like a first,
   * reasonable decision — the timestamp differed each time. After it, cycle N schedules and cycle
   * N+1 acts, and without this event those two cycles read as two unrelated decisions with nothing
   * on the page explaining why the same case with the same numbers chose differently.
   *
   * It is also the metric. Counting DEFERRAL_REFUSED is how the eval reports how often the
   * commitment rule actually bound, which is the difference between "the fix works" and "the fix
   * never fired and something else changed the numbers".
   */
  DEFERRAL_REFUSED: 'DEFERRAL_REFUSED',
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
  /**
   * A human resolved a pending request. Two types rather than one with an `outcome` field, for the
   * same reason `RECOVERED_SELF` is its own state: the dashboard's approval queue and every
   * compliance question ("show me everything that was authorised above the threshold") filter on
   * type, and a filter that has to remember to also read a discriminator is a filter that will
   * eventually forget.
   */
  APPROVAL_GRANTED: 'APPROVAL_GRANTED',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  CASE_ESCALATED: 'CASE_ESCALATED',
  CASE_STOPPED: 'CASE_STOPPED',
  CASE_EXPIRED: 'CASE_EXPIRED',
});

const iso = (t) => (t == null ? null : new Date(t).toISOString());

/**
 * Hydrate a stored case with the facts the guardrails read but nothing was writing.
 *
 * `normaliseCaseState` in guardrails.js reads `customerMessagesInLast7Days`, and until now no
 * code populated it — so the per-customer messaging cap was enforced in code and fed zero. A
 * compliance control that always sees zero is not a control, and the failure is silent in exactly
 * the direction that matters: it never blocks, so nothing ever looks wrong.
 *
 * The count is deliberately read from the contact LEDGER rather than from the case's own
 * `touchesUsed`, because the cap is per *customer* and a customer can have several failed
 * payments open at once. Counting per case is how you message someone nine times about three
 * invoices while every individual case reports three touches and looks polite.
 */
async function hydrateCase({ store, caseRecord, now, config }) {
  const since = new Date(now.getTime() - CUSTOMER_MESSAGE_WINDOW_DAYS * DAY_MS);
  if (!caseRecord.customerId) {
    return { ...caseRecord, customerMessagesInLast7Days: 0, oldestCustomerMessageInWindowAt: null };
  }
  const contacts = await store.countContactsSince(caseRecord.customerId, since);
  /**
   * Read the oldest in-window message too, and only when the cap is actually reached — because
   * that instant is the ONLY thing that lets `TIM_CUSTOMER_MESSAGE_CAP` return DEFER with a real
   * wakeup instead of degrading to FORBID and dropping the customer for the rest of the cycle. The
   * window is `CUSTOMER_MESSAGE_WINDOW_DAYS`, imported from the guardrail rather than a config
   * field that did not exist, so the count and the rule's deferral instant are provably the same
   * window.
   */
  const cap = config.GUARDRAILS.maxMessagesPerCustomerPer7Days;
  const oldest =
    cap != null && contacts >= cap
      ? await store.oldestContactSince(caseRecord.customerId, since)
      : null;
  return {
    ...caseRecord,
    customerMessagesInLast7Days: contacts,
    oldestCustomerMessageInWindowAt: oldest,
  };
}

/**
 * Execute one decision. The only function in the project that moves money.
 *
 * Returns a report rather than throwing on a business-level refusal, because "this was already
 * done" and "the network died" need different handling by the caller and collapsing both into an
 * exception loses that. A genuine gateway error does propagate — see the note at the call site.
 *
 * @returns {Promise<{executed: boolean, duplicate: boolean, reconciled: boolean, receipt: object|null}>}
 */
export async function executeDecision({
  store,
  gateway,
  runId,
  decision,
  now,
  config = { GUARDRAILS, POLICY },
  caseRecord = null,
}) {
  const at = new Date(now);
  const eventId = decision.eventId;
  const chosen = decision.chosen;

  const base = { executed: false, duplicate: false, reconciled: false, receipt: null };

  // ---- outcomes that move no money -----------------------------------------------------------
  // Handled first and explicitly. Each one still writes to the audit trail, because "we looked at
  // this and deliberately did nothing" is a decision a reviewer is entitled to see, and an
  // absence in a log is indistinguishable from a case that was never processed.
  if (decision.outcome !== Outcome.ACT) {
    await applyNonActingOutcome({ store, runId, decision, at });
    return base;
  }

  if (!chosen?.action) {
    throw new Error(`executeDecision: outcome ACT with no chosen action for ${eventId}`);
  }

  const action = chosen.action;
  const method = gatewayMethodFor(action.kind);

  /**
   * An ACT outcome whose action routes to no gateway method is a construction bug, not a no-op.
   * Returning quietly here is how SWITCH_RAIL_NUDGE could be added to the action space, chosen by
   * the policy, counted as executed, and never actually sent — the batch would report money it
   * never tried to recover.
   */
  if (!method) {
    throw new Error(
      `executeDecision: ${action.kind} was chosen as an ACT but routes to no gateway method`
    );
  }
  if (typeof gateway[method] !== 'function') {
    throw new Error(`executeDecision: gateway has no ${method}() for ${action.kind}`);
  }

  const key = action.idempotencyKey ?? chosen.idempotencyKey;
  if (!key) {
    throw new Error(`executeDecision: ${action.kind} on ${eventId} has no idempotency key`);
  }

  // ---- HAZARD 1: has this attempt been started before? ---------------------------------------
  const prior = await store.getAction(key);

  if (prior && prior.state === ExecState.SETTLED) {
    /**
     * Done, and we know it. The only correct move is to not do it again.
     */
    await store.appendAudit({
      runId, eventId, type: AuditType.ATTEMPT_DUPLICATE, at,
      detail: {
        idempotencyKey: key,
        because: 'this attempt is already settled; re-executing it would duplicate the side effect',
        priorReceiptState: prior.receipt?.state ?? null,
      },
    });
    return { ...base, duplicate: true, receipt: prior.receipt ?? null };
  }

  if (prior && prior.state === ExecState.PENDING) {
    /**
     * THE EXPENSIVE CASE. We wrote the key, then something stopped us before we recorded an
     * outcome. We do not know whether the gateway call happened. Ask.
     */
    return reconcilePendingAttempt({ store, gateway, runId, decision, prior, at, caseRecord });
  }

  // ---- write the attempt BEFORE the call it guards -------------------------------------------
  /**
   * The ordering here IS the control, and it is worth being precise about why this line comes
   * before the `await gateway[method]` below rather than after it.
   *
   * The gateway call is the slowest thing in the loop and therefore the likeliest moment to be
   * killed. If the write came second, the window between the side effect and the record of it
   * would be exactly the window in which a crash is most probable — money moves, nothing knows.
   * Writing first inverts the failure mode: the worst outcome becomes a recorded attempt that may
   * not have happened, which is recoverable by asking, versus an unrecorded one that did, which
   * is not recoverable by anything.
   */
  const started = await store.putAction({
    runId,
    eventId,
    customerId: decision.customerId ?? caseRecord?.customerId ?? null,
    kind: action.kind,
    channel: action.channel ?? null,
    idempotencyKey: key,
    state: ExecState.PENDING,
    decisionSeq: decision.decisionSeq ?? 0,
    amountPaise: decision.amountPaise ?? caseRecord?.amountPaise ?? 0,
    evPaise: chosen.evPaise ?? null,
    scheduledFor: iso(action.scheduledFor),
    startedAt: at,
  });

  /**
   * `putAction` returning false after `getAction` returned null means another writer inserted the
   * same key between the two calls. In this single-process orchestrator that cannot happen, but
   * against Mongo with two workers it can, and the safe reading is "somebody else owns this
   * attempt" — so we decline rather than race them to the gateway.
   */
  if (!started) {
    await store.appendAudit({
      runId, eventId, type: AuditType.ATTEMPT_DUPLICATE, at,
      detail: { idempotencyKey: key, because: 'the key was claimed concurrently by another writer' },
    });
    return { ...base, duplicate: true };
  }

  await store.appendAudit({
    runId, eventId, type: AuditType.ATTEMPT_STARTED, at,
    detail: {
      idempotencyKey: key, kind: action.kind, channel: action.channel ?? null,
      evPaise: chosen.evPaise ?? null,
      note: 'persisted before the gateway call, so a crash from here on is recoverable',
    },
  });

  // ---- the side effect ------------------------------------------------------------------------
  let receipt;
  try {
    receipt = await gateway[method]({
      runId,
      eventId,
      customerId: decision.customerId ?? caseRecord?.customerId ?? null,
      action,
      amountPaise: decision.amountPaise ?? caseRecord?.amountPaise ?? 0,
      decisionSeq: decision.decisionSeq ?? 0,
      customer: caseRecord?.customer ?? decision.customer ?? null,
      /**
       * The event travels with the request the same way `customer` does. The LIVE gateway does
       * not read it, but the SIM gateway must: its response model prices recovery against the
       * loss's own physics (`occurredAt`, `rail`, `lossType`, `amountPaise`), and with no event
       * it would be resolving every outcome against `undefined`. `executeDecision` is the only
       * place that holds both the decision and the hydrated case, so it is the only place that
       * can supply it — sourced from the case record, never from latent truth.
       */
      event: caseRecord?.event ?? decision.event ?? null,
      idempotencyKey: key,
      now: at,
    });
  } catch (err) {
    /**
     * The attempt stays PENDING on purpose. Marking it FAILED here would be a claim we cannot
     * support: a thrown error means we do not know whether the request reached the provider, and
     * `FAILED` asserts that it did and was refused. Leaving it PENDING puts it on
     * `getPendingActions` — the crash-recovery work list — so the next cycle reconciles it.
     *
     * The error is then re-raised rather than swallowed. A gateway that has started failing is
     * not a per-case condition, and continuing the batch would turn one outage into several
     * hundred half-attempts.
     */
    await store.appendAudit({
      runId, eventId, type: AuditType.ATTEMPT_FAILED, at,
      detail: {
        idempotencyKey: key,
        error: String(err?.message ?? err),
        because:
          'the gateway call threw, so whether the side effect happened is unknown; the attempt ' +
          'stays PENDING for reconciliation rather than being recorded as failed',
      },
    });
    throw err;
  }

  await settleAttempt({ store, runId, decision, key, receipt, at, caseRecord, reconciled: false });
  return { ...base, executed: true, receipt };
}

/**
 * Resolve an attempt that was started and never settled, by asking the provider.
 *
 * The alternative designs are both worse and both tempting. Skipping treats a started attempt as
 * a finished one and abandons money that may have moved. Re-executing treats it as unstarted and
 * risks a second charge. Only the provider knows, so only the provider can answer.
 */
async function reconcilePendingAttempt({ store, gateway, runId, decision, prior, at, caseRecord }) {
  const key = prior.idempotencyKey;

  if (typeof gateway.fetchStatus !== 'function') {
    throw new Error(
      `cannot reconcile pending attempt ${key}: the gateway exposes no fetchStatus(). Skipping ` +
      `would abandon a possibly-completed charge and retrying would risk a duplicate, so ` +
      `neither is available as a default.`
    );
  }

  const status = await gateway.fetchStatus({
    providerRef: prior.providerRef ?? prior.reference ?? null,
    idempotencyKey: key,
    kind: prior.kind,
  });

  /**
   * The provider's answer is the receipt. Note that ATTEMPTED — "accepted, outcome not yet
   * decided" — settles the ATTEMPT while leaving the CASE open: we now know the request landed,
   * which is what the pending row was ambiguous about, and we still do not know if money arrives.
   * Those are different questions and conflating them is what the ReceiptState.UNKNOWN case in
   * gateway.js exists to prevent.
   */
  const receipt = {
    mode: gateway.mode ?? null,
    actionKind: prior.kind,
    state: status.state ?? ReceiptState.UNKNOWN,
    amountPaise: prior.amountPaise ?? 0,
    amountCollectedPaise: status.amountPaidPaise ?? 0,
    providerRef: status.providerRef ?? prior.providerRef ?? null,
    providerStatus: status.providerStatus ?? null,
    at: iso(at),
    caveats: ['RECONCILED: this receipt came from a status query after a crash, not from the original call'],
  };

  await store.appendAudit({
    runId,
    eventId: prior.eventId,
    type: AuditType.ATTEMPT_RECONCILED,
    at,
    detail: {
      idempotencyKey: key,
      providerRef: receipt.providerRef,
      resolvedState: receipt.state,
      because:
        'the attempt was PENDING at start of cycle, meaning we died between persisting the key ' +
        'and recording an outcome. The provider was asked rather than the attempt being skipped ' +
        '(which abandons possibly-moved money) or repeated (which risks a double charge).',
    },
  });

  await settleAttempt({ store, runId, decision, key, receipt, at, caseRecord, reconciled: true });

  return { executed: false, duplicate: true, reconciled: true, receipt };
}

/**
 * Record the outcome of an attempt and advance the case to match.
 *
 * Shared by the normal path and the reconciliation path deliberately: the consequences of a
 * captured payment must not depend on whether we learned about it from the original call or from
 * a status query, and duplicating this logic is how those two drift apart.
 */
async function settleAttempt({ store, runId, decision, key, receipt, at, caseRecord, reconciled }) {
  const eventId = decision.eventId;
  const action = decision.chosen.action;
  const collected = receipt.amountCollectedPaise ?? 0;

  await store.patchAction(key, {
    state: ExecState.SETTLED,
    settledAt: at,
    reconciled: Boolean(reconciled),
    receipt,
  });

  await store.appendAudit({
    runId, eventId, type: AuditType.ATTEMPT_SETTLED, at,
    detail: {
      idempotencyKey: key,
      receiptState: receipt.state,
      amountCollectedPaise: collected,
      reconciled: Boolean(reconciled),
    },
  });

  // ---- counters ------------------------------------------------------------------------------
  /**
   * Incremented from the value we read, not with an atomic $inc, because the store interface is
   * deliberately narrow and this orchestrator is single-writer per run. If a second worker is
   * ever added, this is the line that breaks, so it is called out rather than left to be
   * discovered: two workers would both read N and both write N+1, and the run cap would leak.
   */
  const patch = {};
  if (MONEY_MOVING.has(action.kind)) {
    patch.retriesUsed = (caseRecord?.retriesUsed ?? 0) + 1;
    patch.lastRetryAt = at;
  }
  if (CUSTOMER_CONTACTING.has(action.kind)) {
    patch.touchesUsed = (caseRecord?.touchesUsed ?? 0) + 1;
    patch.lastContactAt = at;

    /**
     * THE LEDGER WRITE THAT MAKES THE COMPLIANCE CAP REAL.
     *
     * `hydrateCase` reads this back per customer before every decision. Without this line the cap
     * reads zero forever and never binds — which is why it is here, beside the side effect, and
     * not in the caller where it could be forgotten on one of several paths.
     */
    await store.recordContact({
      customerId: decision.customerId ?? caseRecord?.customerId ?? null,
      channel: action.channel ?? null,
      sentAt: at,
      eventId,
      runId,
      idempotencyKey: key,
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.CONTACT_RECORDED, at,
      detail: { channel: action.channel ?? null, customerId: decision.customerId ?? caseRecord?.customerId ?? null },
    });
  }

  // ---- did money actually arrive? -------------------------------------------------------------
  if (receipt.state === ReceiptState.CAPTURED && collected > 0) {
    patch.state = CaseState.RECOVERED;
    patch.recoveredPaise = collected;
    patch.recoveredAt = at;
    patch.nextActionAt = null;
    await store.appendAudit({
      runId, eventId, type: AuditType.MONEY_RECOVERED, at,
      detail: { amountPaise: collected, viaKind: action.kind, channel: action.channel ?? null, reconciled: Boolean(reconciled) },
    });
  } else {
    /**
     * Not recovered. The case goes back to OPEN with no wakeup time, so the next cycle
     * re-decides it from scratch rather than re-running the action that just failed. Re-deciding
     * is the point: `touchesUsed` and `retriesUsed` have both changed, so the same case now
     * prices differently, and a case that has burnt three attempts should be looking at its
     * stopping rules rather than at a fourth attempt.
     */
    patch.state = CaseState.OPEN;
    patch.nextActionAt = null;
  }

  await store.patchCase(runId, eventId, patch);
}

/**
 * Apply an outcome that touches no gateway: WAIT, AWAIT_APPROVAL, ESCALATE_HUMAN, STOP_PERMANENT.
 *
 * All four write both a case-state change and an audit entry. The audit entry is the part that is
 * easy to skip and the part Track 03 explicitly asks for — a stopping rule that stops without
 * recording why it stopped is indistinguishable from a case that fell through a crack.
 */
async function applyNonActingOutcome({ store, runId, decision, at }) {
  const eventId = decision.eventId;

  if (decision.outcome === Outcome.WAIT) {
    /**
     * A WAIT with no `waitUntil` would set `nextActionAt` to null, and a case with a null
     * `nextActionAt` is DUE — `getDueCases` treats absence as "no constraint". So the case would
     * be re-decided immediately, decide to wait again, and spin. Falling back to the next cycle
     * boundary makes the degenerate case merely slow instead of infinite.
     */
    const until = decision.waitUntil ? new Date(decision.waitUntil) : null;
    await store.patchCase(runId, eventId, {
      state: CaseState.SCHEDULED,
      nextActionAt: until,
      waitingBecause: decision.stop?.code ?? 'WAIT',
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.CASE_WAITING, at,
      detail: { until: iso(until), because: decision.stop?.detail ?? decision.stop?.code ?? 'the policy chose to wait' },
    });
    return;
  }

  if (decision.outcome === Outcome.AWAIT_APPROVAL) {
    /**
     * Two fields here exist solely so that `resolveApproval` never has to guess what the reviewer
     * was looking at.
     *
     * `checkIds` is the machine-readable form of `reasons`, so a grant can clear exactly the
     * concerns that were on screen and no others. `proposedInvasiveness` is the rung of the
     * invasiveness ladder the proposed action sits on, captured HERE rather than derived later from
     * the signature string — a grant recorded days after the request must not depend on parsing
     * `rebound:evt_123:RETRY_SCHEDULED@2026-03-04T…` back into an action kind.
     *
     * Both are snapshots of the request, deliberately. If the world moves and the agent would now
     * want a more invasive action, the envelope no longer covers it and the case comes back for a
     * fresh signature. That is the intended behaviour, not a limitation.
     */
    await store.patchCase(runId, eventId, {
      state: CaseState.AWAITING_APPROVAL,
      nextActionAt: null,
      'approval.state': 'PENDING',
      'approval.requestedAt': at,
      'approval.reasons': decision.approvalReasons ?? [],
      'approval.checkIds': decision.approvalCheckIds ?? [],
      'approval.proposedAction': decision.chosen?.signature ?? null,
      'approval.proposedInvasiveness': decision.chosen?.action
        ? invasivenessOf(decision.chosen.action)
        : null,
      'approval.evPaise': decision.chosen?.evPaise ?? null,
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.APPROVAL_REQUESTED, at,
      detail: {
        proposed: decision.chosen?.signature ?? null,
        evPaise: decision.chosen?.evPaise ?? null,
        reasons: decision.approvalReasons ?? [],
        because: 'money movement on this case is not authorised without a human',
      },
    });
    return;
  }

  if (decision.outcome === Outcome.ESCALATE_HUMAN) {
    await store.patchCase(runId, eventId, {
      state: CaseState.ESCALATED,
      nextActionAt: null,
      'escalation.at': at,
      'escalation.code': decision.stop?.code ?? null,
      'escalation.reason': decision.stop?.detail ?? null,
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.CASE_ESCALATED, at,
      detail: { code: decision.stop?.code ?? null, because: decision.stop?.detail ?? 'routed to a human' },
    });
    return;
  }

  /**
   * `decision.stop.detail`, NOT `decision.stop.reason` — AND THE DIFFERENCE COST THE AUDIT TRAIL.
   *
   * `decide.js` builds the stop as `{ ...disposition.reason, standing, blockedEscalation }`, and
   * `disposition.reason` is `{ code, detail }`. So the sentence that explains a stop — "best available
   * recovery action (SWITCH_RAIL_NUDGE) is worth 180 paise, below the 200 paise bar (bar is 1 x sigma
   * of 151 paise, floored at 200)" — has always lived in `.detail`. Five call sites here and in the read
   * model asked for `.reason`, a field that has never existed on that object, so every one of them fell
   * through to its own generic string: every stopped case in every run recorded "nothing available was
   * worth its cost", every escalation recorded "routed to a human", and the console printed an em-dash.
   *
   * Nothing failed. 642 tests were green, because no test read the words and the fallback made every
   * record look plausible. It surfaced only when the spotlight put the stop on the largest screen in the
   * console under the note "the least flattering screen here and the one worth the most" — and the
   * reason field on it was blank. The stopping rules are a judged part of this project; a canned sentence
   * where the rule's own arithmetic belongs is the worst kind of quiet defect.
   */
  if (decision.outcome === Outcome.STOP_PERMANENT) {
    await store.patchCase(runId, eventId, {
      state: CaseState.STOPPED,
      nextActionAt: null,
      'stop.at': at,
      'stop.code': decision.stop?.code ?? null,
      'stop.reason': decision.stop?.detail ?? null,
      'stop.standing': decision.stop?.standing ?? null,
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.CASE_STOPPED, at,
      detail: {
        code: decision.stop?.code ?? null,
        because: decision.stop?.detail ?? 'nothing available was worth its cost',
        standing: decision.stop?.standing ?? null,
      },
    });
    return;
  }

  throw new Error(`applyNonActingOutcome: unhandled outcome ${decision.outcome} on ${eventId}`);
}

/**
 * A human resolves a pending approval request.
 *
 * =================================================================================================
 * WHAT A GRANT AUTHORISES, AND WHY IT IS NOT "THIS ACTION" AND NOT "THIS CASE"
 * =================================================================================================
 * There were three candidate designs and the two obvious ones are both wrong.
 *
 * "The grant authorises the SPECIFIC proposed action." Tempting, because it sounds maximally
 * conservative. It is actually unsafe: the signature was minted hours or days ago, and
 * `scheduleAction`'s docblock already explains at length why a stored intent must never be executed
 * later — between request and grant the customer may have paid, disputed, revoked the mandate, or
 * used up their contact budget on a different invoice. Executing the approved signature would act
 * on a stale belief and a stale guardrail check, with a human's name attached to it.
 *
 * "The grant unlocks the CASE." Simple, and it silently converts consent-to-message into
 * consent-to-charge. A reviewer who approved a payment link would find a ₹2,99,915 retry executed
 * under their signature, and the audit trail would say a human approved it. That is worse than
 * having no approval mechanism, because it manufactures false accountability.
 *
 * So a grant is an ENVELOPE: it clears the specific concerns the reviewer was shown
 * (`approval.checkIds`), on this case, for actions no more invasive than the one proposed
 * (`approval.proposedInvasiveness`), for `GUARDRAILS.approvalValidForHours`. The agent then
 * RE-DECIDES at the current instant. If its new best action fits inside the envelope it executes;
 * if a new concern has appeared, or it now wants something more invasive, the case returns to the
 * queue for a fresh signature. `grantClears` in guardrails.js is the single enforcement point.
 *
 * A DENIAL is terminal. A reviewer saying no to chasing an invoice is saying do not chase it, and
 * leaving the case OPEN would have the agent propose a slightly cheaper action next cycle and
 * re-ask — which is how an automated system nags a human into approving something. The narrower
 * design (deny only this action, allow others) is deliberately NOT built: it is more expressive and
 * it hands the agent a way to grind down a refusal.
 *
 * @param grant  true to authorise, false to refuse
 * @param by     who decided. Required — an approval with no accountable name is not an approval,
 *               and the whole value of this record is that it answers "who said yes".
 */
export async function resolveApproval({ store, runId, eventId, grant, by, at = new Date(), note = null }) {
  if (!by) {
    throw new TypeError(
      'resolveApproval({ by }) is required: an approval that cannot name who granted it provides ' +
        'no accountability, which is the only thing an approval record is for.'
    );
  }

  const c = await store.getCase(runId, eventId);
  if (!c) throw new Error(`resolveApproval: unknown case ${runId}/${eventId}`);

  /**
   * Refuse to resolve anything that is not actually pending, rather than resolving it anyway.
   *
   * This is the idempotency guard for the approval path. A double-click in the dashboard, a retried
   * HTTP request, or an approver acting on a case that self-recovered in the meantime all land here.
   * Granting a case that has already been recovered, denied, or paid would move it back out of a
   * terminal state and hand the policy a case the world has finished with.
   */
  if (c.state !== CaseState.AWAITING_APPROVAL || c.approval?.state !== 'PENDING') {
    return {
      applied: false,
      because:
        `case is ${c.state} with approval ${c.approval?.state ?? 'absent'}; ` +
        'only a PENDING request on an AWAITING_APPROVAL case can be resolved',
    };
  }

  const decidedAt = new Date(at);

  if (!grant) {
    await store.patchCase(runId, eventId, {
      state: CaseState.STOPPED,
      nextActionAt: null,
      'approval.state': 'DENIED',
      'approval.by': by,
      'approval.decidedAt': decidedAt,
      'approval.note': note,
      'stop.at': decidedAt,
      'stop.code': 'APPROVAL_DENIED',
      'stop.reason': `${by} declined to authorise recovery on this case`,
    });
    await store.appendAudit({
      runId, eventId, type: AuditType.APPROVAL_DENIED, at: decidedAt,
      detail: {
        by,
        note,
        proposed: c.approval?.proposedAction ?? null,
        amountPaise: c.amountPaise ?? null,
        waitedHours: hoursBetween(c.approval?.requestedAt, decidedAt),
        because: 'a human declined; the case is closed rather than re-proposed more cheaply',
      },
    });
    return { applied: true, state: 'DENIED' };
  }

  await store.patchCase(runId, eventId, {
    /**
     * Back to OPEN with a null `nextActionAt`, which makes the case DUE on the next cycle. Not
     * straight to an execution: the re-decide is the point. See the envelope discussion above.
     */
    state: CaseState.OPEN,
    nextActionAt: null,
    'approval.state': 'GRANTED',
    'approval.by': by,
    'approval.decidedAt': decidedAt,
    'approval.note': note,
    /**
     * `grantedAt` duplicates `decidedAt` today and is read by `liveGrant` for expiry. Kept as its
     * own field because the two answer different questions — when the clock on this authority
     * started, versus when the human happened to click — and a later change to record, say, a
     * post-dated authorisation must not silently move the expiry basis.
     */
    'approval.grantedAt': decidedAt,
    'approval.clearedCheckIds': c.approval?.checkIds ?? [],
    'approval.approvedInvasiveness': c.approval?.proposedInvasiveness ?? null,
  });

  await store.appendAudit({
    runId, eventId, type: AuditType.APPROVAL_GRANTED, at: decidedAt,
    detail: {
      by,
      note,
      proposed: c.approval?.proposedAction ?? null,
      amountPaise: c.amountPaise ?? null,
      clearedCheckIds: c.approval?.checkIds ?? [],
      approvedInvasiveness: c.approval?.proposedInvasiveness ?? null,
      validUntil: iso(
        new Date(decidedAt.getTime() + (GUARDRAILS.approvalValidForHours ?? 0) * 3_600_000)
      ),
      waitedHours: hoursBetween(c.approval?.requestedAt, decidedAt),
      because:
        'authorises actions no more invasive than the one proposed, on this case, until the ' +
        'grant expires; the agent re-decides rather than executing the stale proposal',
    },
  });

  return { applied: true, state: 'GRANTED' };
}

/** Null-safe elapsed hours, for the audit detail that shows how long a human took. */
function hoursBetween(from, to) {
  if (!from) return null;
  const a = new Date(from).getTime();
  if (!Number.isFinite(a)) return null;
  return Number(((new Date(to).getTime() - a) / 3_600_000).toFixed(2));
}

/**
 * A scheduled action is a wakeup, not an execution.
 *
 * `POLICY.candidateRetryOffsetsHours` starts at 6, so a chosen RETRY_SCHEDULED always lands in
 * the future. We record the intent and set `nextActionAt`; the action itself happens on a later
 * cycle.
 *
 * WHY THE CASE IS RE-DECIDED AT WAKEUP RATHER THAN THE STORED INTENT BEING EXECUTED.
 * Between now and +72h the world moves: the customer may pay by themselves, dispute the charge,
 * revoke the mandate, or be messaged about a different invoice and use up the contact budget.
 * Executing a stored intent would act on a three-day-old belief and a three-day-old guardrail
 * check. Re-deciding costs one more pass through a pure function and buys a decision that is
 * correct at the moment it takes effect — which is the same landing-instant principle the pricing
 * fix in `recoveryModel.js` was about, applied to authorisation instead of probability.
 */
async function scheduleAction({ store, runId, decision, at, config = { GUARDRAILS, POLICY } }) {
  const eventId = decision.eventId;
  const when = new Date(decision.chosen.action.scheduledFor);
  const cls = decision.chosen.action.kind;

  /**
   * THE DEFERRAL LEDGER (#67). Three fields, and each one is load-bearing.
   *
   * `deferral.wakeAt` is what lets the next decision know it is standing on an instant IT chose,
   * rather than merely being decided at some moment that happens to be later. Without it the fix
   * cannot distinguish a case legitimately waiting for a future salary date from a case re-arming
   * the same six-hour wait for the sixteenth time, and a rule that cannot tell those apart deletes
   * scheduled retries outright.
   *
   * `deferral.lastClass` scopes the refusal, so waking from a retry deferral does not silence the
   * contacting actions.
   *
   * `deferral.counts.<CLASS>` is the budget. Read-then-write because `applyPatch` sets values and
   * has no increment operator, which is safe here: the orchestrator processes one case at a time
   * within a cycle, and two cycles cannot overlap on the same case because the second reads the
   * `nextActionAt` the first wrote. Worth stating explicitly because read-then-write on a shared
   * store is exactly the shape that stops being safe the moment anything runs concurrently, and the
   * Mongo-backed store (#8) would need `$inc` here rather than this.
   */
  const priorCounts = decision.caseState?.deferralCounts ?? {};
  const priorForClass = priorCounts[cls] ?? 0;

  await store.patchCase(runId, eventId, {
    state: CaseState.SCHEDULED,
    nextActionAt: when,
    'scheduled.intent': decision.chosen.signature,
    'scheduled.evPaise': decision.chosen.evPaise,
    'scheduled.decidedAt': at,
    'deferral.lastClass': cls,
    'deferral.wakeAt': when,
    [`deferral.counts.${cls}`]: priorForClass + 1,
  });

  await store.appendAudit({
    runId, eventId, type: AuditType.CASE_SCHEDULED, at,
    detail: {
      intent: decision.chosen.signature,
      wakeAt: iso(when),
      evPaise: decision.chosen.evPaise,
      /**
       * The count is printed BESIDE the intent, so a reader scanning the trail sees "deferral 3 of 3"
       * rather than sixteen structurally identical lines that each look like a first decision. The
       * loop hid for two days because every line was unique — the timestamp differed every time.
       */
      deferralOfClass: priorForClass + 1,
      deferralCap: config?.POLICY?.maxDeferralsPerCase ?? null,
      note: 'the case will be re-decided at wakeup, not executed from this stored intent',
    },
  });
}

/** Is this decision an action we should perform later rather than now? */
const isFutureScheduled = (decision, now) =>
  decision.outcome === Outcome.ACT &&
  decision.chosen?.action?.kind === ActionKind.RETRY_SCHEDULED &&
  decision.chosen.action.scheduledFor != null &&
  new Date(decision.chosen.action.scheduledFor).getTime() > new Date(now).getTime();

/**
 * Run one cycle: everything due at `now`, in descending order of expected value.
 *
 * @param store        a Store
 * @param gateway      injected, so `src/agent` never imports `src/sim`
 * @param runId
 * @param now          the clock. Never `Date.now()` — see the header.
 * @param scoreAction  the probability model, passed through to `decide`
 * @param observeCase  case record -> the observation the agent is allowed to see
 * @param diagnoseCase (observed) -> diagnosis
 * @param decide       the policy. Defaults to `decideForCase`; a baseline arm supplies its own.
 *                     Used in BOTH passes — see the note at the commit-pass call site for why
 *                     using it in only one would silently score a baseline's proposal with our
 *                     policy's commit.
 * @param cycle        cycle index, for the audit trail
 */
export async function runCycle({
  store,
  gateway,
  runId,
  now,
  config = { GUARDRAILS, POLICY },
  scoreAction,
  observeCase,
  diagnoseCase,
  decide = decideForCase,
  cycle = 0,
  policyArm,
}) {
  if (typeof scoreAction !== 'function') throw new TypeError('runCycle({ scoreAction }) is required');
  if (typeof observeCase !== 'function') throw new TypeError('runCycle({ observeCase }) is required');
  if (typeof diagnoseCase !== 'function') throw new TypeError('runCycle({ diagnoseCase }) is required');
  if (typeof decide !== 'function') throw new TypeError('runCycle({ decide }) must be a function');

  const at = new Date(now);
  const due = await store.getDueCases(runId, at);

  await store.appendAudit({
    runId, eventId: null, type: AuditType.CYCLE_STARTED, at,
    detail: { cycle, dueCases: due.length },
  });

  /**
   * The run state the whole cycle is measured against. Read once from the run record so that a
   * multi-cycle run carries its budget forward — a per-cycle reset would make the run caps
   * meaningless, since a long enough run would simply have more cycles.
   */
  const run = (await store.getRun(runId)) ?? {};
  const runState = {
    retriesThisRun: run.retriesThisRun ?? 0,
    messagesThisRun: run.messagesThisRun ?? 0,
  };
  const proposalRunState = { ...runState };

  // ---- PROPOSE ------------------------------------------------------------------------------
  /**
   * Price every due case against the state as it stands right now. No side effects, no budget
   * consumed. This pass exists only to produce an ordering, and it has to be priced against a
   * fixed state or the ordering would depend on the order — which is the thing we are trying to
   * choose.
   */
  const proposals = [];
  for (const raw of due) {
    const caseRecord = await hydrateCase({ store, caseRecord: raw, now: at, config });
    const observed = await observeCase(caseRecord);
    const diagnosis = await diagnoseCase(observed, caseRecord);
    const decision = decide({
      observed, diagnosis, record: caseRecord, scoreAction,
      runState: proposalRunState, now: at, config, policyArm,
    });
    proposals.push({ caseRecord, observed, diagnosis, decision });
  }

  /**
   * Order by the EV of the chosen action, descending. Cases with no chosen action sort last at
   * -Infinity, which is correct rather than merely convenient: a case we are about to stop or
   * escalate consumes no budget, so its position cannot deprive anything of budget.
   *
   * The eventId tiebreak is there for the same reason `decide.js` breaks ties on signature: two
   * cases at identical EV must not be able to swap places between runs, or the reproducibility
   * claim in VERIFY.md stops holding.
   */
  const ordered = proposals.slice().sort((a, b) => {
    const ea = a.decision.chosen?.evPaise ?? -Infinity;
    const eb = b.decision.chosen?.evPaise ?? -Infinity;
    if (ea !== eb) return eb - ea;
    return String(a.decision.eventId).localeCompare(String(b.decision.eventId));
  });

  // ---- COMMIT -------------------------------------------------------------------------------
  const executed = [];

  for (const proposal of ordered) {
    const { observed, diagnosis } = proposal;

    /**
     * Re-hydrate the case against the ledger as it stands NOW, not as it stood when this case was
     * priced. The run budget is not the only thing earlier cases consume: a SEND_LINK executed two
     * iterations ago wrote a row to the contact ledger, and if that message went to THIS customer,
     * the per-customer cap has moved since the propose pass read it.
     *
     * Without this line the cross-case cap only ever binds across cycles, never within one — so a
     * customer with four open invoices in the same batch gets four messages in one morning, every
     * per-case counter reads politely low, and the guardrail that exists precisely to catch that
     * reports ALLOW each time. It is the same class of error as the run budget being priced once:
     * a control checked against a stale snapshot is a control that cannot bind.
     */
    const caseRecord = await hydrateCase({
      store, caseRecord: proposal.caseRecord, now: at, config,
    });

    /**
     * Re-decide against the LIVE run state. This is the pass whose guardrail check is
     * authoritative, because it is the only one that sees the budget as it will actually be at
     * the moment of the side effect. The proposal's job was to earn this case its place in the
     * queue; it does not get to authorise anything.
     *
     * `decide` and not `decideForCase`, and this is the call that matters. The propose pass only
     * produces an ordering; THIS is the one whose output gets executed. An injection point wired
     * into propose alone would let a baseline choose the queue order and then hand every actual
     * action back to the EV policy — a comparison in which both arms do the same thing and one of
     * them gets the credit.
     */
    const decision = decide({
      observed, diagnosis, record: caseRecord, scoreAction,
      runState, now: at, config, policyArm,
    });

    const proposed = proposal.decision;
    const diverged =
      proposed.outcome !== decision.outcome ||
      (proposed.chosen?.signature ?? null) !== (decision.chosen?.signature ?? null);

    await store.putDecision({ runId, ...decision });
    await store.appendAudit({
      runId, eventId: decision.eventId, type: AuditType.CASE_DECIDED, at,
      detail: {
        cycle,
        outcome: decision.outcome,
        chosen: decision.chosen?.signature ?? null,
        evPaise: decision.chosen?.evPaise ?? null,
        p: decision.chosen?.p ?? null,
        barPaise: decision.barPaise,
        candidatesConsidered: decision.candidates.length,
      },
    });

    if (diverged) {
      /**
       * The committed action differs from the one that won this case its place in the queue.
       * Almost always this is the run budget binding: an earlier, more valuable case spent the
       * retry, so the guardrail now returns FORBID for the same action it permitted moments ago.
       *
       * `because` is lifted from the engine's own rejection annotation for the superseded
       * candidate rather than composed here, so the audit trail quotes the guardrail that
       * actually refused it instead of this file's guess about which one did.
       */
      const superseded = decision.candidates.find((c) => c.signature === proposed.chosen?.signature);
      const because =
        superseded?.rejectedBecause ??
        (proposed.outcome !== decision.outcome
          ? `the outcome changed from ${proposed.outcome} to ${decision.outcome} once the live run state was applied`
          : 'the live run state differed from the state this case was priced against');

      await store.appendAudit({
        runId, eventId: decision.eventId, type: AuditType.PROPOSAL_SUPERSEDED, at,
        detail: {
          cycle,
          proposedOutcome: proposed.outcome,
          proposedAction: proposed.chosen?.signature ?? null,
          proposedEvPaise: proposed.chosen?.evPaise ?? null,
          committedOutcome: decision.outcome,
          committedAction: decision.chosen?.signature ?? null,
          committedEvPaise: decision.chosen?.evPaise ?? null,
          evForgonePaise:
            (proposed.chosen?.evPaise ?? 0) - (decision.chosen?.evPaise ?? 0),
          because,
        },
      });
    }

    /**
     * A postponement the policy wanted and was refused is recorded BEFORE the outcome is applied,
     * because it is a fact about how this decision was reached rather than about what it did. It is
     * emitted on the committed decision only — the pre-pass proposal is discarded, and auditing a
     * refusal that a superseded proposal encountered would double-count the mechanism.
     */
    if (decision.deferralLimit) {
      await store.appendAudit({
        runId, eventId: decision.eventId, type: AuditType.DEFERRAL_REFUSED, at,
        detail: {
          cycle,
          boundBy: decision.deferralLimit.boundBy,
          actionClass: decision.deferralLimit.class,
          deferralsSoFar: decision.deferralLimit.count,
          cap: decision.deferralLimit.cap,
          withheldCandidates: decision.deferralLimit.withheldCandidates,
          because: decision.deferralLimit.because,
          /** What it did instead, so the refusal and its consequence are one line in the trail. */
          insteadChose: decision.chosen?.signature ?? null,
          insteadOutcome: decision.outcome,
        },
      });
    }

    // A scheduled retry is a wakeup, not an execution.
    if (isFutureScheduled(decision, at)) {
      await scheduleAction({ store, runId, decision, at, config });
      executed.push({ decision, divergedFromProposal: diverged, scheduled: true, result: null });
      continue;
    }

    /**
     * A WAKEUP IS SPENT ONCE IT IS STOOD ON, and forgetting to say so is a bug I nearly shipped.
     *
     * The commitment rule fires when `deferral.wakeAt` is in the past. If the field survived the
     * cycle that consumed it, it would stay in the past forever and `deferral.lastClass` would stay
     * set — so a case that deferred once, woke, and retried immediately could never schedule again
     * for the rest of its life. `maxDeferralsPerCase: 3` would be a number in a config file that no
     * case could ever reach, and the eval would report a cap that was never the binding constraint.
     * The commitment rule would have quietly become "one deferral per case, ever", which is a
     * different and much blunter policy than the one I am about to measure and defend.
     *
     * Cleared here rather than inside the decision engine because the engine is pure — and cleared
     * only on the paths that did NOT schedule something new, since `scheduleAction` above overwrites
     * both fields with the fresh wakeup and clearing after it would erase the commitment before it
     * could ever bind.
     *
     * `deferral.counts` deliberately SURVIVES. The budget is per case for its whole life; resetting
     * it on every action would let a case alternate retry, defer, retry, defer indefinitely and
     * never breach a cap — the same loop with one extra step, which is exactly the kind of fix that
     * passes its own test.
     */
    const spentWakeAt = decision.caseState?.deferralWakeAt;
    if (spentWakeAt && new Date(spentWakeAt).getTime() <= new Date(at).getTime()) {
      await store.patchCase(runId, decision.eventId, {
        'deferral.lastClass': null,
        'deferral.wakeAt': null,
      });
    }

    const result = await executeDecision({
      store, gateway, runId, decision, now: at, config, caseRecord,
    });

    /**
     * Budget is consumed on the basis of what was ATTEMPTED, not what succeeded. A failed retry
     * still cost a gateway call and still consumed the customer's patience; counting only
     * successes would let a run make unlimited failing attempts while reporting a healthy cap.
     */
    if (result.executed) {
      if (MONEY_MOVING.has(decision.chosen.action.kind)) runState.retriesThisRun += 1;
      if (CUSTOMER_CONTACTING.has(decision.chosen.action.kind)) runState.messagesThisRun += 1;
    }

    executed.push({ decision, divergedFromProposal: diverged, scheduled: false, result });
  }

  await store.patchRun(runId, {
    retriesThisRun: runState.retriesThisRun,
    messagesThisRun: runState.messagesThisRun,
    lastCycleAt: at,
    cyclesRun: (run.cyclesRun ?? 0) + 1,
  });

  const summary = summariseCycle({ cycle, at, due, executed });

  await store.appendAudit({
    runId, eventId: null, type: AuditType.CYCLE_FINISHED, at, detail: summary,
  });

  return { cycle, at, due, proposals: ordered, executed, runState, summary };
}

/**
 * Roll a cycle up into countable facts.
 *
 * `recoveredPaise` is the number Track 03 asks for and therefore the one most worth being careful
 * about: it sums money the gateway said it CAPTURED, not money we hoped to recover and not the EV
 * we priced. Under SIM it is simulated money and every caller that prints it is required to say
 * so — the two-claim boundary this project keeps is that the plumbing is proven and the policy is
 * measured, and a rupee figure that quietly slides between those is the one thing that would
 * discredit both.
 */
export function summariseCycle({ cycle, at, due, executed }) {
  const outcomes = {};
  let recoveredPaise = 0;
  let attempts = 0;
  let scheduled = 0;
  let diverged = 0;
  let reconciled = 0;
  let duplicates = 0;

  for (const x of executed) {
    outcomes[x.decision.outcome] = (outcomes[x.decision.outcome] ?? 0) + 1;
    if (x.divergedFromProposal) diverged += 1;
    if (x.scheduled) scheduled += 1;
    if (x.result?.executed) attempts += 1;
    if (x.result?.reconciled) reconciled += 1;
    if (x.result?.duplicate) duplicates += 1;
    if (x.result?.receipt?.state === ReceiptState.CAPTURED) {
      recoveredPaise += x.result.receipt.amountCollectedPaise ?? 0;
    }
  }

  return {
    cycle,
    at: iso(at),
    dueCases: due.length,
    decided: executed.length,
    outcomes,
    attempts,
    scheduledWakeups: scheduled,
    recoveredPaise,
    proposalsSuperseded: diverged,
    reconciled,
    duplicatesSkipped: duplicates,
  };
}
