/**
 * THE STORE — a narrow, domain-specific persistence interface.
 * ===========================================================
 *
 * WHY THIS EXISTS
 *
 * Two forces pushed this into being, and they pointed the same way.
 *
 * First, practical: the sensitivity sweep needs to replay the whole batch under many
 * perturbed assumption sets, across five policy arms. That is thousands of runs. Round-
 * tripping every decision through a database would turn a two-minute analysis into an
 * hour, and an analysis that takes an hour is an analysis I will quietly stop running.
 *
 * Second, and more important for anyone evaluating this: `npm run eval` should work on a
 * clean clone with nothing installed but Node. Requiring a reviewer to stand up MongoDB
 * before they can reproduce a single number is a good way to ensure nobody reproduces
 * any of them. The headline numbers must be reproducible with one command.
 *
 * So persistence is a seam, not an assumption. The in-memory store is the default and is
 * what the eval uses. The Mongo store is what the API and dashboard use, because a
 * persisted, queryable audit trail is a real requirement rather than a nice-to-have —
 * "show an audit trail" is one of the four things Track 03 asks for, and an audit trail
 * that vanishes when the process exits is not one.
 *
 * WHY THE INTERFACE IS DOMAIN-SPECIFIC AND NOT A GENERIC `find(query)`
 *
 * The tempting design is a thin generic wrapper: `collection(name).find(mongoQuery)`.
 * I rejected it. A generic wrapper forces the in-memory implementation to reimplement
 * Mongo's query semantics — `$in`, `$lt`, dotted paths, date coercion — and every gap
 * between the two implementations becomes a bug that appears in exactly one of them.
 * The most likely victim would be the contact-ledger cap, which is a compliance control:
 * a subtly different date comparison between stores means the guardrail holds in
 * evaluation and leaks in production. That is the worst possible place to put a
 * portability bug.
 *
 * Naming the ~15 real access patterns instead keeps both implementations small enough to
 * read end to end, and makes the questions the system actually asks of its data explicit.
 * Adding a method is a deliberate act; adding a query is not.
 *
 * STATUS: the in-memory implementation is complete and covered by test/store.test.js.
 * The Mongo implementation lives in `mongoStore.js` and must satisfy the same test
 * suite — see the note at the top of that file.
 */

import { assertPaise } from '../core/money.js';

/**
 * @typedef {object} Store
 *
 * World (immutable, written once by the seeder)
 * @property {(batch: object) => Promise<void>} putBatch
 * @property {(batchId: string) => Promise<object|null>} getBatch
 * @property {(customers: object[]) => Promise<void>} putCustomers
 * @property {(customerId: string) => Promise<object|null>} getCustomer
 * @property {(events: object[]) => Promise<void>} putEvents
 * @property {(batchId: string) => Promise<object[]>} getEvents
 * @property {(eventId: string) => Promise<object|null>} getEvent
 *
 * Runs
 * @property {(run: object) => Promise<void>} putRun
 * @property {(runId: string, patch: object) => Promise<void>} patchRun
 * @property {(runId: string) => Promise<object|null>} getRun
 * @property {() => Promise<object[]>} listRuns
 *
 * Case state
 * @property {(cases: object[]) => Promise<void>} putCases
 * @property {(runId: string, eventId: string) => Promise<object|null>} getCase
 * @property {(runId: string, eventId: string, patch: object) => Promise<void>} patchCase
 * @property {(runId: string) => Promise<object[]>} getCases
 * @property {(runId: string) => Promise<object[]>} getActiveCases
 *
 * Decisions, actions, audit
 * @property {(decision: object) => Promise<void>} putDecision
 * @property {(runId: string, eventId: string) => Promise<object[]>} getDecisions
 * @property {(action: object) => Promise<boolean>} putAction resolves false if the
 *           idempotency key was already present, which is how a crash-restart is stopped
 *           from charging a customer twice
 * @property {(idempotencyKey: string) => Promise<object|null>} getAction the other half of
 *           that control. `putAction` returning false says "this key has been seen"; it does
 *           NOT say the gateway call finished. Reading the attempt back is what lets the
 *           orchestrator tell a completed attempt from one that died in flight, and those
 *           two need opposite handling: skip the first, reconcile the second.
 * @property {(idempotencyKey: string, patch: object) => Promise<void>} patchAction settle an
 *           attempt with its receipt. Attempts are the one record that is written before the
 *           fact and completed after it, because the whole point is to have persisted the key
 *           BEFORE the side effect it guards.
 * @property {(runId: string) => Promise<object[]>} getActions
 * @property {(runId: string) => Promise<object[]>} getPendingActions attempts written but
 *           never settled — the crash-recovery work list
 * @property {(entry: object) => Promise<void>} appendAudit
 * @property {(runId: string, filter?: {eventId?: string, type?: string}) => Promise<object[]>} getAudit
 *
 * Contact ledger — the per-customer messaging cap, enforced across all of a customer's
 * cases rather than per case. This is the one query whose correctness is a compliance
 * matter, which is why it is a named method with an explicit window.
 * @property {(entry: object) => Promise<void>} recordContact
 * @property {(customerId: string, since: Date) => Promise<number>} countContactsSince
 * @property {(customerId: string, since: Date) => Promise<string|null>} oldestContactSince
 *
 * `oldestContactSince` exists so that a capped customer produces a DEFER with a real instant
 * rather than a FORBID. `TIM_CUSTOMER_MESSAGE_CAP` degrades to FORBID when it cannot say WHEN the
 * window clears — correct, but it means a customer who hit the cap is dropped for the rest of the
 * cycle with no scheduled wakeup. Knowing the oldest message in the window turns that into
 * "unreachable until exactly this instant", which the scheduler can act on.
 *
 * Scheduling
 * @property {(runId: string, dueBy: Date) => Promise<object[]>} getDueCases
 */

const clone = (x) => (x === undefined ? x : structuredClone(x));

/**
 * Apply a shallow patch with dotted-path support, e.g. { 'approval.state': 'GRANTED' }.
 *
 * Deliberately shallow-with-dots rather than a full deep merge. A deep merge would make
 * it ambiguous whether assigning an object replaces or merges it, and that ambiguity is
 * how a partial update silently drops a field. Dotted paths force the caller to say
 * exactly which leaf they mean.
 */
function applyPatch(target, patch) {
  for (const [path, value] of Object.entries(patch)) {
    if (!path.includes('.')) {
      target[path] = clone(value);
      continue;
    }
    const parts = path.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
      if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
      node = node[part];
    }
    node[parts.at(-1)] = clone(value);
  }
  return target;
}

/**
 * In-memory store. Used by the eval harness and the tests.
 *
 * Every read returns a structured clone. That costs a little speed and buys the property
 * that callers cannot mutate stored state by accident — which the Mongo store gives for
 * free, and which would otherwise be a behavioural difference between the two
 * implementations. Matching the *stricter* store's semantics is the point: code written
 * against this one cannot rely on aliasing that would break in production.
 */
export function createMemoryStore() {
  const batches = new Map();
  const customers = new Map();
  const events = new Map();
  const eventsByBatch = new Map();
  const runs = new Map();
  const cases = new Map();          // `${runId}::${eventId}` -> case
  const casesByRun = new Map();     // runId -> Set of keys
  const decisions = [];
  const actions = [];
  const actionKeys = new Set();
  const audit = [];
  const contacts = [];

  const caseKey = (runId, eventId) => `${runId}::${eventId}`;

  const TERMINAL = new Set(['RECOVERED', 'STOPPED', 'ESCALATED', 'EXPIRED']);

  return {
    kind: 'MEMORY',

    // ------------------------------------------------------------------ world
    async putBatch(batch) {
      batches.set(batch.batchId, clone(batch));
    },
    async getBatch(batchId) {
      return clone(batches.get(batchId)) ?? null;
    },
    async putCustomers(list) {
      for (const c of list) customers.set(c.customerId, clone(c));
    },
    async getCustomer(customerId) {
      return clone(customers.get(customerId)) ?? null;
    },
    async putEvents(list) {
      for (const e of list) {
        assertPaise(e.amountPaise, `event ${e.eventId} amountPaise`);
        events.set(e.eventId, clone(e));
        if (!eventsByBatch.has(e.batchId)) eventsByBatch.set(e.batchId, []);
        eventsByBatch.get(e.batchId).push(e.eventId);
      }
    },
    async getEvents(batchId) {
      return (eventsByBatch.get(batchId) ?? []).map((id) => clone(events.get(id)));
    },
    async getEvent(eventId) {
      return clone(events.get(eventId)) ?? null;
    },

    // ------------------------------------------------------------------- runs
    async putRun(run) {
      runs.set(run.runId, clone(run));
    },
    async patchRun(runId, patch) {
      const run = runs.get(runId);
      if (!run) throw new Error(`patchRun: unknown run ${runId}`);
      applyPatch(run, patch);
    },
    async getRun(runId) {
      return clone(runs.get(runId)) ?? null;
    },
    async listRuns() {
      return [...runs.values()].map(clone).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    },

    // ------------------------------------------------------------------ cases
    async putCases(list) {
      for (const c of list) {
        const key = caseKey(c.runId, c.eventId);
        cases.set(key, clone(c));
        if (!casesByRun.has(c.runId)) casesByRun.set(c.runId, new Set());
        casesByRun.get(c.runId).add(key);
      }
    },
    async getCase(runId, eventId) {
      return clone(cases.get(caseKey(runId, eventId))) ?? null;
    },
    async patchCase(runId, eventId, patch) {
      const c = cases.get(caseKey(runId, eventId));
      if (!c) throw new Error(`patchCase: unknown case ${runId}/${eventId}`);
      applyPatch(c, patch);
    },
    async getCases(runId) {
      return [...(casesByRun.get(runId) ?? [])].map((k) => clone(cases.get(k)));
    },
    async getActiveCases(runId) {
      return [...(casesByRun.get(runId) ?? [])]
        .map((k) => cases.get(k))
        .filter((c) => !TERMINAL.has(c.state))
        .map(clone);
    },
    async getDueCases(runId, dueBy) {
      const t = dueBy.getTime();
      return [...(casesByRun.get(runId) ?? [])]
        .map((k) => cases.get(k))
        .filter((c) => !TERMINAL.has(c.state))
        .filter((c) => !c.nextActionAt || new Date(c.nextActionAt).getTime() <= t)
        .map(clone);
    },

    // ------------------------------------------------- decisions and actions
    async putDecision(decision) {
      decisions.push(clone(decision));
    },
    async getDecisions(runId, eventId) {
      return decisions
        .filter((d) => d.runId === runId && (eventId === undefined || d.eventId === eventId))
        .map(clone)
        .sort((a, b) => a.decisionSeq - b.decisionSeq);
    },

    /**
     * Returns false when the idempotency key has been seen before.
     *
     * The caller is expected to treat that as "already done, do not re-execute" rather
     * than as an error. This is the mechanism that makes a crash mid-run safe to restart:
     * the key is derived deterministically from runId + eventId + decisionSeq + action,
     * so a replay produces the same key and is rejected here instead of sending a second
     * message or attempting a second charge.
     */
    async putAction(action) {
      if (!action.idempotencyKey) throw new Error('putAction: idempotencyKey is required');
      if (actionKeys.has(action.idempotencyKey)) return false;
      actionKeys.add(action.idempotencyKey);
      actions.push(clone(action));
      return true;
    },
    async getActions(runId) {
      return actions.filter((a) => a.runId === runId).map(clone);
    },

    /**
     * Read one attempt back by its key.
     *
     * Exists because `putAction` returning false is genuinely ambiguous about the thing that
     * matters most. The key being present proves we got as far as writing it; it says nothing
     * about whether the gateway call that followed ever completed. A restart that treats those
     * two situations the same either re-charges a customer or silently abandons an attempt
     * whose money may already have moved.
     */
    async getAction(idempotencyKey) {
      return clone(actions.find((a) => a.idempotencyKey === idempotencyKey)) ?? null;
    },

    /**
     * Settle an attempt. Deliberately keyed on the idempotency key rather than on position,
     * because the key is the only identifier that survives a process restart.
     */
    async patchAction(idempotencyKey, patch) {
      const a = actions.find((x) => x.idempotencyKey === idempotencyKey);
      if (!a) throw new Error(`patchAction: unknown action ${idempotencyKey}`);
      applyPatch(a, patch);
    },

    /**
     * Attempts written but never settled. On a clean run this is empty at the end, and a
     * non-empty list is the honest signal that something died mid-flight rather than an
     * absence nobody notices.
     */
    async getPendingActions(runId) {
      return actions.filter((a) => a.runId === runId && a.state === 'PENDING').map(clone);
    },

    async appendAudit(entry) {
      // Append-only by construction: there is deliberately no update or delete method.
      audit.push(clone({ ...entry, seq: audit.length }));
    },
    async getAudit(runId, filter = {}) {
      return audit
        .filter((a) => a.runId === runId)
        .filter((a) => (filter.eventId ? a.eventId === filter.eventId : true))
        .filter((a) => (filter.type ? a.type === filter.type : true))
        .map(clone);
    },

    // -------------------------------------------------------- contact ledger
    async recordContact(entry) {
      contacts.push(clone(entry));
    },
    async countContactsSince(customerId, since) {
      const t = since.getTime();
      return contacts.filter(
        (c) => c.customerId === customerId && new Date(c.sentAt).getTime() >= t
      ).length;
    },
    async oldestContactSince(customerId, since) {
      const t = since.getTime();
      const within = contacts
        .filter((c) => c.customerId === customerId && new Date(c.sentAt).getTime() >= t)
        .map((c) => new Date(c.sentAt).getTime());
      if (within.length === 0) return null;
      return new Date(Math.min(...within)).toISOString();
    },

    /** Test and debug affordance; not part of the interface the agent uses. */
    _stats() {
      return {
        batches: batches.size,
        customers: customers.size,
        events: events.size,
        runs: runs.size,
        cases: cases.size,
        decisions: decisions.length,
        actions: actions.length,
        audit: audit.length,
        contacts: contacts.length,
      };
    },
  };
}

/**
 * Factory. `kind` comes from the STORE env var so the same code path serves the eval
 * (memory) and the API (mongo) without either knowing which it got.
 */
export async function createStore({ kind = 'MEMORY', uri } = {}) {
  if (kind === 'MEMORY') return createMemoryStore();
  if (kind === 'MONGO') {
    const { createMongoStore } = await import('./mongoStore.js');
    return createMongoStore({ uri });
  }
  throw new Error(`Unknown store kind: ${kind}. Expected MEMORY or MONGO.`);
}
