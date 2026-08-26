/**
 * THE HTTP SURFACE, AGAINST A REAL SERVER ON A REAL PORT
 * =====================================================
 *
 * Every test here talks to a listening `node:http` server over `fetch`. Nothing calls a handler
 * directly with a fake `res`, because three of the defects this file exists to catch live in the
 * space between a handler and a socket: a status code set on a stream that was already written to,
 * a `content-length` computed from a string that was then re-encoded, and a route that matches
 * `/api/cases/../../.env` before the traversal check ever runs. A unit test on the handler passes
 * all three.
 *
 * WHY THIS FILE PINS THE APPROVAL LIFECYCLE AND NOT JUST THE ROUTE SHAPES.
 *
 * Track 03's bar names "compliant escalation" explicitly, and the approval envelope is the only
 * mechanism in this project that implements it. The envelope's whole claim is that consent is
 * SCOPED — that a human who approved a WhatsApp message has not approved a ₹2.2 lakh card retry on
 * the same case. That claim is worth exactly as much as the test that a more invasive substitute is
 * actually refused, so both halves are pinned below: a grant the envelope covers must EXECUTE, and
 * a grant it does not cover must come back to the queue. A test suite that only checked the happy
 * path would let the envelope degrade into a per-case boolean and stay green, and the audit trail
 * would then say a human authorised something they were never shown.
 *
 * THE FIXTURE IS n=40 AND THAT NUMBER IS LOAD-BEARING.
 *
 * At n=12 and n=20 every queued proposal on seed 1 is invasiveness 1 (customer contact), so the
 * envelope-covered path is unreachable and the interesting half of the lifecycle silently does not
 * run. n=40 yields both kinds. `pins the fixture` below asserts that mix directly rather than
 * trusting it, so a change to the approval threshold or the cause mix fails loudly here instead of
 * quietly reducing this file to a shape check.
 *
 * ON THE RUNTIME GROUND-TRUTH SCAN.
 *
 * `sendJson` scans every response body for latent field names and returns 500 rather than 200 if it
 * finds one. `test/boundary.test.js` cannot catch this class of bug — it scans SOURCE for token
 * names, and passed green for eight days while every case record in the store carried
 * `event.failure._generatedVague`, because no source file named it (#75). So `json()` below rescans
 * every body this suite receives, and `the leak guard fires` proves the server-side scan is wired by
 * handing it a session that deliberately leaks.
 *
 * Run: node --test test/api.test.js
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApiServer } from '../src/api/server.js';
import { createSession } from '../src/demo/session.js';
import { GROUND_TRUTH_TOKENS, groundTruthLeaks } from '../src/core/groundTruthTokens.js';
import { invasivenessOf } from '../src/agent/guardrails.js';
import { isWithinHourWindow } from '../src/core/timezone.js';
import { GUARDRAILS } from '../src/core/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', 'web');

const open = [];
after(async () => {
  await Promise.all(open.map((s) => new Promise((r) => s.close(r))));
});

/** Listen on port 0 and let the OS pick, so parallel test files never collide. */
async function serve(session) {
  const server = createApiServer({ session, staticDir: WEB_DIR });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Fetch, and refuse to hand back a body that contains the answer key.
 *
 * The assertion is here rather than in each test so that adding a route to this suite adds the scan
 * for free. Only JSON is scanned: the vendored React bundle is 131 KB of minified third-party code
 * and a chance substring match in it would be a false positive about a file this project does not
 * author.
 */
async function json(base, path, opts = {}) {
  const res = await fetch(base + path, opts);
  const text = await res.text();
  const leaks = groundTruthLeaks(text);
  assert.deepEqual(
    leaks,
    [],
    `${opts.method ?? 'GET'} ${path} served ground-truth field(s) ${leaks.join(', ')} — ` +
      'the read model let a latent field through. See src/api/readModel.js and #75.'
  );
  return { status: res.status, headers: res.headers, body: JSON.parse(text) };
}

const post = (base, path, payload) =>
  json(base, path, {
    method: 'POST',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/**
 * Five sessions, because the behaviour under test depends on WHICH CYCLE comes next.
 *
 * This file's first two drafts both failed the same way, and the mistake is worth recording because
 * it is subtle and it produced a green-looking suite that asserted the opposite of what it claimed.
 * Quiet hours alternate with the 12-hour step, so "the next cycle is 02:30 IST" is true only for a run
 * paused at an odd cycle count. Two tests shared one session; the first advanced its clock; the second
 * then silently ran against the other parity and tested nothing it said it did.
 *
 * So every test whose property depends on the next cycle's HOUR gets its own session:
 *   `consoleRead` — never written to; its shape assertions describe the run as booted.
 *   `lifecycle`   — granted, denied, advanced. Only parity-INDEPENDENT properties live here
 *                   (money moves are not quiet-hours gated, and 400/404/409 refusals never touch the
 *                   clock), so sharing is safe and stays safe.
 *   `quietStep`   — paused after ONE cycle, so its next cycle is 02:30 IST. The envelope-REFUSAL path.
 *   `openStep`    — the default two, so its next cycle is 14:30 IST. The contact-EXECUTES path.
 *   `measured`    — all five arms, to prove the two refusals a measured run must make.
 *
 * Built at module scope rather than in a `before` hook so that a failure to build is reported as a
 * module-load error naming the real cause, instead of as twenty individually failing tests.
 */
const [consoleRead, lifecycle, quietStep, openStep, measured] = await Promise.all([
  createSession({ count: 40, approver: 'HUMAN' }),
  createSession({ count: 40, approver: 'HUMAN' }),
  createSession({ count: 40, approver: 'HUMAN', pauseAfterCycles: 1 }),
  createSession({ count: 40, approver: 'HUMAN' }),
  createSession({ count: 20, approver: 'SIM' }),
]);
const CONSOLE = await serve(consoleRead);
const LIFECYCLE = await serve(lifecycle);
const QUIET_STEP = await serve(quietStep);
const OPEN_STEP = await serve(openStep);
const MEASURED = await serve(measured);

// ---------------------------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------------------------

test('pins the fixture: the queue holds both a contacting and a money-moving proposal', async () => {
  const { body } = await json(CONSOLE, '/api/approvals');
  const levels = body.items.map((i) => i.proposedInvasiveness);
  assert.ok(body.pendingCount >= 2, `expected a populated queue, got ${body.pendingCount}`);
  assert.ok(
    levels.includes(1),
    'no invasiveness-1 (customer contact) proposal in the queue: the envelope-REFUSAL path below ' +
      'cannot run. Raise the fixture size or check the approval threshold.'
  );
  assert.ok(
    levels.includes(2),
    'no invasiveness-2 (money-moving) proposal in the queue: the envelope-COVERED path below ' +
      'cannot run, and this suite has quietly stopped testing the half that matters. Raise the ' +
      'fixture size or check GUARDRAILS.humanApprovalThresholdPaise.'
  );
});

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

test('health names the data source as simulation and reports the guarded token count', async () => {
  const { status, body } = await json(CONSOLE, '/api/health');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.runId, consoleRead.runId);
  /**
   * The string matters, not just the field. This project makes two separate claims — the plumbing
   * works (`npm run doctor`, real test-mode API) and the policy is better (simulation) — and the one
   * thing neither claim survives is being mixed on a single screen. A reader of this endpoint must
   * be able to tell which one they are looking at without reading the source.
   */
  assert.equal(body.dataSource, 'SIMULATION');
  assert.equal(body.groundTruthTokensGuarded, GROUND_TRUTH_TOKENS.length);
});

test('console mode serves no money figures and says why', async () => {
  const { body } = await json(CONSOLE, '/api/run');
  assert.equal(body.mode, 'CONSOLE');
  assert.equal(body.approverKind, 'EXTERNAL');
  assert.equal(body.paused, true);
  assert.ok(body.cyclesRun < body.horizon.cycles);
  /**
   * All three null together. A paused run is a truncated run and its totals are biased twice in our
   * favour — unfinished cases have had less time to fail, and frozen approvals are money the policy
   * never spent — so the correct answer to "what did this recover" is silence, not a number with a
   * footnote.
   */
  assert.equal(body.rows, null);
  assert.equal(body.invariants, null);
  assert.equal(body.counterfactualPaise, null);
  assert.ok(
    body.caveats.some((c) => /NO MONEY FIGURES/.test(c)),
    'console mode must carry the caveat naming the truncation bias'
  );
  assert.ok(body.totalExposurePaise > 0, 'exposure is a property of the batch and is still knowable');
});

test('measured mode serves the arm table, incremental money, and holding invariants', async () => {
  const { body } = await json(MEASURED, '/api/run');
  assert.equal(body.mode, 'MEASURED');
  assert.equal(body.paused, false);
  assert.equal(body.arms.length, 5);
  assert.equal(body.rows.length, 5);
  const broken = Object.entries(body.invariants).filter(([, ok]) => ok === false);
  assert.deepEqual(broken.map(([k]) => k), [], 'a served arm table with a failed invariant is unquotable');
  assert.ok(body.counterfactualPaise >= 0, 'B0_DO_NOTHING is the subtracted denominator');
  assert.ok(
    body.caveats.some((c) => /INCREMENTAL/.test(c)),
    'the incremental-money caveat must travel with the payload, not live in a comment'
  );
  assert.ok(
    body.caveats.some((c) => /ONE world/.test(c)),
    'one world is a demonstration of the mechanism, and the payload must say so'
  );
});

test('cases are sorted by descending exposure and filter on state, loss type and free text', async () => {
  const { body } = await json(CONSOLE, '/api/cases');
  assert.equal(body.total, 40);
  assert.equal(body.cases.length, 40);
  const amounts = body.cases.map((c) => c.amountPaise);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), 'triage order is biggest first');

  const someState = Object.keys(body.states)[0];
  const filtered = await json(CONSOLE, `/api/cases?state=${encodeURIComponent(someState)}`);
  assert.equal(filtered.body.total, body.states[someState]);
  assert.ok(filtered.body.cases.every((c) => c.state === someState));

  const someLoss = Object.keys(body.lossTypes)[0];
  const byLoss = await json(CONSOLE, `/api/cases?lossType=${encodeURIComponent(someLoss)}`);
  assert.equal(byLoss.body.total, body.lossTypes[someLoss]);

  const target = body.cases[0];
  const byQ = await json(CONSOLE, `/api/cases?q=${encodeURIComponent(target.eventId)}`);
  assert.equal(byQ.body.total, 1);
  assert.equal(byQ.body.cases[0].eventId, target.eventId);

  const paged = await json(CONSOLE, '/api/cases?limit=5&offset=2');
  assert.equal(paged.body.cases.length, 5);
  assert.equal(paged.body.total, 40, 'total describes the filtered set, not the page');
  assert.equal(paged.body.cases[0].eventId, body.cases[2].eventId);
});

test('a case detail carries the decision, its candidates and its explanation', async () => {
  const list = await json(CONSOLE, '/api/cases');
  const { status, body } = await json(CONSOLE, `/api/cases/${list.body.cases[0].eventId}`);
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.decisions) && body.decisions.length > 0);
  assert.ok(Array.isArray(body.audit) && body.audit.length > 0);
  assert.ok(Array.isArray(body.decisions[0].candidates) && body.decisions[0].candidates.length > 0);
  assert.ok(
    body.decisions[0].explain.length > 0,
    'the drawer explains the decision in sentences; an audit trail nobody can read is not one'
  );
});

/**
 * A STOP MUST ARRIVE WITH THE STOPPING RULE'S OWN ARITHMETIC, NOT WITH A CANNED SENTENCE.
 *
 * This exists because it did not. `stopping.js` returns `{ code, detail }`, `decide.js` spreads that
 * onto `decision.stop`, and five consumers — the case patch, the audit entry, the escalation patch, the
 * wait entry and the read model — all asked for `decision.stop.reason`, a field that never existed on
 * that object. Every one of them had a fallback, so nothing threw and nothing failed: the audit trail
 * recorded "nothing available was worth its cost" for every stopped case in every run the project has
 * ever produced, escalations recorded "routed to a human", and the console printed an em-dash where the
 * rule's reasoning belonged. 715 tests were green throughout, because no test read the sentence.
 *
 * Track 03 asks for stopping rules and an audit trail by name, so this asserts the specific thing that
 * was missing rather than the shape that was already fine: the reason reaches the API, it reaches the
 * audit entry, it is the SAME sentence in both, and it is not the fallback.
 */
test('a stopped case carries the stopping rule’s own reason, to the API and to the audit trail', async () => {
  const list = await json(CONSOLE, '/api/cases?state=STOPPED');
  assert.ok(list.body.cases.length > 0, 'the fixture must stop at least one case for this to mean anything');

  const CANNED = ['nothing available was worth its cost', 'routed to a human', 'the policy chose to wait'];
  let checked = 0;

  for (const row of list.body.cases) {
    const { body } = await json(CONSOLE, `/api/cases/${row.eventId}`);
    if (!body.stop) continue;
    checked += 1;

    assert.ok(body.stop.code, `${row.eventId}: a stop must name its rule`);
    assert.ok(
      typeof body.stop.reason === 'string' && body.stop.reason.length > 12,
      `${row.eventId}: stop.reason came back ${JSON.stringify(body.stop.reason)} — this is the exact defect: ` +
        `the sentence lives in the engine's stop.detail and reading .reason silently yields null`
    );
    assert.ok(
      !CANNED.includes(body.stop.reason),
      `${row.eventId}: stop.reason is the generic fallback, so the rule's own words were lost again`
    );

    const stopped = body.audit.filter((e) => e.type === 'CASE_STOPPED');
    assert.equal(stopped.length >= 1, true, `${row.eventId}: a stop is an audited event`);
    assert.equal(
      stopped[0].detail?.because,
      body.stop.reason,
      `${row.eventId}: the trail and the screen must quote the same sentence, or one of them is decoration`
    );
    assert.equal(stopped[0].detail?.code, body.stop.code);

    /**
     * The DECISION-level stop is a separate mapping in the read model from the CASE-level one, and it
     * had the same bug independently. The drawer renders the decision; the case header renders the case.
     * Fixing one and not the other leaves the defect on screen in the other half of the same panel, so
     * both are asserted here and against each other.
     */
    const deciding = body.decisions.filter((d) => d.stop);
    assert.ok(
      deciding.length > 0,
      `${row.eventId}: the case is stopped, so at least one decision must carry the stop that did it`
    );
    const last = deciding[deciding.length - 1];
    assert.ok(
      typeof last.stop.reason === 'string' && last.stop.reason.length > 12,
      `${row.eventId}: the decision's own stop.reason is ${JSON.stringify(last.stop.reason)} — the read ` +
        `model must source it from the engine's stop.detail here too, not only on the case`
    );
    assert.equal(last.stop.reason, body.stop.reason, `${row.eventId}: the decision and the case must agree`);
    assert.equal(last.stop.code, body.stop.code);
  }

  assert.ok(checked > 0, 'no stopped case carried a stop record, so nothing above was actually asserted');

  /**
   * One case is checked in detail: NEGATIVE_EV is the stop code whose reason is pure arithmetic, and it
   * is the one the console puts on its largest screen. If the wording in `stopping.js` changes this
   * assertion should change with it — that is the point of pinning a substring rather than a shape.
   */
  const negative = [];
  for (const row of list.body.cases) {
    const { body } = await json(CONSOLE, `/api/cases/${row.eventId}`);
    if (body.stop?.code === 'NEGATIVE_EV') negative.push(body.stop.reason);
  }
  if (negative.length > 0) {
    assert.match(
      negative[0],
      /best available recovery action \(.+\) is worth \d+ paise, below the \d+ paise bar/,
      'the NEGATIVE_EV reason states the two numbers a reviewer would need to disagree with it'
    );
  }
});

test('the audit trail is newest-first, so a page of it is not a page of cycle 0', async () => {
  const { body } = await json(CONSOLE, '/api/audit?limit=50');
  assert.ok(body.total > 50);
  assert.equal(body.entries.length, 50);
  const times = body.entries.map((e) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const typed = await json(CONSOLE, '/api/audit?type=CASE_DECIDED');
  assert.ok(typed.body.total > 0);
  assert.ok(typed.body.entries.every((e) => e.type === 'CASE_DECIDED'));
});

// ---------------------------------------------------------------------------------------------
// The approval lifecycle
// ---------------------------------------------------------------------------------------------

test('a grant is refused without an accountable name', async () => {
  const { body: queue } = await json(LIFECYCLE, '/api/approvals');
  const id = queue.items[0].eventId;
  /**
   * `by` is required and deliberately not defaulted. An approval record whose approver field reads
   * "system" because the caller omitted a name is worse than an absent field: it reads like an
   * accountable decision and is not one, and accountability is the only thing this record is for.
   */
  const noBy = await post(LIFECYCLE, `/api/approvals/${id}`, { grant: true });
  assert.equal(noBy.status, 400);
  assert.match(noBy.body.message, /by/);
  const noGrant = await post(LIFECYCLE, `/api/approvals/${id}`, { by: 'mohit' });
  assert.equal(noGrant.status, 400);
  assert.match(noGrant.body.message, /grant/);
  const unknown = await post(LIFECYCLE, '/api/approvals/evt_nope', { grant: true, by: 'mohit' });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'NO_SUCH_CASE');
});

test('a grant the envelope covers makes the agent execute at the new instant', async () => {
  const { body: queue } = await json(LIFECYCLE, '/api/approvals');
  const before = await json(LIFECYCLE, '/api/run');
  const money = queue.items.find((i) => i.proposedInvasiveness === 2);
  const granted = await post(LIFECYCLE, `/api/approvals/${money.eventId}`, {
    grant: true,
    by: 'mohit',
    note: 'verified against the ledger',
  });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.applied, true);
  assert.equal(granted.body.state, 'GRANTED');
  /**
   * Back to OPEN, not straight to an execution. The re-decide is the point: the belief, the
   * guardrails and the contact ledger are all re-evaluated at the landing instant, so a grant can
   * never execute a stale proposal.
   *
   * A money move is used here rather than a contact action because money moves are not quiet-hours
   * gated, so this property holds at either parity and the test can safely share a session.
   */
  assert.equal(granted.body.case.state, 'OPEN');

  const stepped = await post(LIFECYCLE, '/api/advance');
  assert.equal(stepped.status, 200);
  assert.equal(stepped.body.ran, true);
  assert.ok(stepped.body.summary, 'a cycle that ran reports what it did');
  assert.equal(stepped.body.run.cyclesRun, before.body.cyclesRun + 1);

  const after = await json(LIFECYCLE, `/api/cases/${money.eventId}`);
  const second = after.body.decisions.at(-1);
  assert.equal(second.outcome, 'ACT', 'the envelope covered the new best action, so it should have acted');
  assert.equal(second.approvedBy, 'mohit');
  assert.ok(
    second.clearedByApproval.length > 0,
    'the decision record must name which checks the signature cleared, not merely that one existed'
  );
  assert.ok(after.body.actions.length > 0, 'an ACT with no action row is a decision that went nowhere');
  const kinds = after.body.audit.map((e) => e.type);
  assert.ok(kinds.includes('APPROVAL_GRANTED'));
  assert.ok(kinds.includes('ATTEMPT_STARTED'));
});

test('a grant the envelope does not cover returns the case to the queue', async () => {
  /**
   * THE ENVELOPE IS THE POINT OF THE WHOLE MECHANISM.
   *
   * This runs against `quietStep`, paused after one cycle, so the next cycle is 02:30 IST. The
   * largest contacting proposal in the fixture is a ₹2.2 lakh overdue invoice whose approved action is
   * a WhatsApp nudge (invasiveness 1). At 02:30 every contacting candidate defers, so the agent's best
   * available action becomes a card retry at invasiveness 2 — outside what was signed for. It must come
   * back for a fresh signature rather than ride through on consent given for something else.
   *
   * If this ever fails by finding the case OPEN, SETTLED or RECOVERED, the envelope has degenerated
   * into a per-case boolean and a human's name is now attached to a charge they never saw.
   */
  const { body: queue } = await json(QUIET_STEP, '/api/approvals');
  const contact = queue.items
    .filter((i) => i.proposedInvasiveness === 1)
    .sort((a, b) => b.amountPaise - a.amountPaise)[0];
  const grantedInvasiveness = contact.proposedInvasiveness;

  const granted = await post(QUIET_STEP, `/api/approvals/${contact.eventId}`, { grant: true, by: 'mohit' });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.case.state, 'OPEN');

  const stepped = await post(QUIET_STEP, '/api/advance');
  assert.equal(stepped.body.ran, true);
  assert.equal(stepped.body.run.cyclesRun, 2);

  const after = await json(QUIET_STEP, `/api/cases/${contact.eventId}`);
  assert.equal(after.body.state, 'AWAITING_APPROVAL', 'a more invasive substitute must re-gate');
  assert.equal(after.body.approvalState, 'PENDING');
  assert.ok(
    after.body.approval.proposedInvasiveness > grantedInvasiveness,
    `re-gated on invasiveness ${after.body.approval.proposedInvasiveness}, which is not above the ` +
      `${grantedInvasiveness} that was granted — this test is no longer exercising the envelope`
  );
  assert.equal(after.body.actions.length, 0, 'nothing may have executed under the wrong signature');
});

test('the default pause instant lets a granted contact action actually execute', async () => {
  /**
   * The counterpart to the test above, and the reason `pauseAfterCycles` defaults to 2. Same fixture,
   * same grant, one cycle further on — so the next cycle is 14:30 IST, contact is legal, the envelope
   * covers it, and the nudge goes out. Both tests must hold: the envelope refuses what it does not
   * cover AND permits what it does. Only one of those is a compliance property; the other is whether
   * the product works.
   */
  const { body: queue } = await json(OPEN_STEP, '/api/approvals');
  const contact = queue.items
    .filter((i) => i.proposedInvasiveness === 1)
    .sort((a, b) => b.amountPaise - a.amountPaise)[0];
  await post(OPEN_STEP, `/api/approvals/${contact.eventId}`, { grant: true, by: 'mohit' });
  await post(OPEN_STEP, '/api/advance');

  const after = await json(OPEN_STEP, `/api/cases/${contact.eventId}`);
  assert.notEqual(after.body.state, 'AWAITING_APPROVAL', 'the envelope covered this; it should have acted');
  const acted = after.body.actions.filter((a) => a.kind === 'SWITCH_RAIL_NUDGE' || a.kind === 'SEND_LINK');
  assert.ok(acted.length > 0, `expected a contacting action to have executed, got ${JSON.stringify(after.body.actions.map((a) => a.kind))}`);
  const last = after.body.decisions.at(-1);
  assert.equal(last.approvedBy, 'mohit', 'the executing decision must name whose signature it used');
});

test('no customer-contacting action ever executes inside quiet hours', async () => {
  /**
   * The compliance invariant, asserted over every action in the run rather than over the case this
   * suite happened to click on. Ten of the twenty-one cycles fall at 02:30 IST; an off-by-one in the
   * quiet-hours window would show up as a handful of 2am WhatsApp messages and as nothing else.
   */
  const all = [
    ...(await lifecycle.store.getActions(lifecycle.runId)),
    ...(await quietStep.store.getActions(quietStep.runId)),
    ...(await openStep.store.getActions(openStep.runId)),
  ];
  assert.ok(all.length > 0);
  const offenders = all.filter(
    (a) =>
      invasivenessOf(a.kind) === 1 &&
      a.startedAt &&
      isWithinHourWindow(new Date(a.startedAt), GUARDRAILS.quietHours)
  );
  assert.deepEqual(
    offenders.map((a) => `${a.eventId} ${a.kind}:${a.channel} at ${a.startedAt}`),
    [],
    'customer contact executed inside quiet hours'
  );
});

test('resolving an approval twice is a conflict, not a success and not a crash', async () => {
  const { body: queue } = await json(LIFECYCLE, '/api/approvals');
  const id = queue.items[0].eventId;
  const first = await post(LIFECYCLE, `/api/approvals/${id}`, { grant: true, by: 'mohit' });
  assert.equal(first.status, 200);
  /**
   * A double-click, a retried request, or a race with the simulated reviewer all land here. 200
   * would let the UI show a case as granted twice; 500 would make an idempotent retry look like a
   * crash. 409 with a sentence is the only answer that is true.
   */
  const again = await post(LIFECYCLE, `/api/approvals/${id}`, { grant: true, by: 'mohit' });
  assert.equal(again.status, 409);
  assert.equal(again.body.applied, false);
  assert.match(again.body.because, /only a PENDING request/);
});

test('a denial is terminal and stops the case rather than re-proposing it cheaper', async () => {
  const { body: queue } = await json(LIFECYCLE, '/api/approvals');
  const id = queue.items[0].eventId;
  const denied = await post(LIFECYCLE, `/api/approvals/${id}`, {
    grant: false,
    by: 'mohit',
    note: 'do not chase this customer',
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.state, 'DENIED');
  assert.equal(denied.body.case.state, 'STOPPED');
  assert.equal(denied.body.case.stopCode, 'APPROVAL_DENIED');
  /**
   * And it stays stopped. Leaving the case OPEN would have the agent propose a slightly cheaper
   * action next cycle and re-ask, which is how an automated system nags a human into approving
   * something it was already refused.
   */
  await post(LIFECYCLE, '/api/advance');
  const after = await json(LIFECYCLE, `/api/cases/${id}`);
  assert.equal(after.body.state, 'STOPPED');
  assert.equal(after.body.approvalState, 'DENIED');
});

test('a measured run refuses to be advanced, because its figures are already computed', async () => {
  const before = await json(MEASURED, '/api/run');
  const stepped = await post(MEASURED, '/api/advance');
  assert.equal(stepped.status, 409);
  assert.equal(stepped.body.ran, false);
  assert.match(stepped.body.because, /MEASURED/);
  const after = await json(MEASURED, '/api/run');
  assert.equal(after.body.cyclesRun, before.body.cyclesRun, 'the refusal must actually refuse');
  assert.deepEqual(after.body.rows, before.body.rows);
});

test('a console run reports its operator actions so a stale table cannot pass as fresh', async () => {
  const { body } = await json(LIFECYCLE, '/api/run');
  assert.ok(body.operatorActions >= 3, `expected the grants and the denial to be counted, got ${body.operatorActions}`);
});

// ---------------------------------------------------------------------------------------------
// Refusals, guards and static assets
// ---------------------------------------------------------------------------------------------

test('unknown routes, wrong methods and unknown cases are distinguishable', async () => {
  const noRoute = await json(CONSOLE, '/api/nope');
  assert.equal(noRoute.status, 404);
  assert.equal(noRoute.body.error, 'NO_SUCH_ROUTE');
  const wrongMethod = await json(CONSOLE, '/api/health', { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error, 'METHOD_NOT_ALLOWED');
  const noCase = await json(CONSOLE, '/api/cases/evt_does_not_exist');
  assert.equal(noCase.status, 404);
  assert.equal(noCase.body.error, 'NO_SUCH_CASE');
});

test('path traversal is refused, including percent-encoded', async () => {
  /**
   * `..%2f` and friends are already decoded by `new URL` before the handler sees them, which is why
   * the check is on the RESOLVED path and not on the request string: blocking the literal `..` is a
   * filter, and filters lose. A 404 rather than a 403 is deliberate — a caller probing for `.env`
   * learns only that it is not a static asset.
   */
  for (const path of [
    '/../.env',
    '/..%2f.env',
    '/%2e%2e/%2e%2e/.env',
    '/vendor/../../.env',
    '/....//.env',
  ]) {
    const res = await fetch(CONSOLE + path);
    assert.equal(res.status, 404, `${path} must not be served`);
    const text = await res.text();
    assert.ok(!/RAZORPAY/i.test(text), `${path} returned something that looks like credentials`);
  }
});

test('an oversized body is rejected rather than buffered', async () => {
  const res = await fetch(`${CONSOLE}/api/approvals/evt_000009`, {
    method: 'POST',
    body: JSON.stringify({ grant: true, by: 'x'.repeat(70 * 1024) }),
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'BAD_BODY');
});

test('malformed JSON is a 400 with a usable message, not a stack trace', async () => {
  const res = await fetch(`${CONSOLE}/api/approvals/evt_000009`, { method: 'POST', body: '{not json' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).message, /valid JSON/);
});

test('the leak guard fires: a session that serves ground truth gets a 500, not a 200', async () => {
  /**
   * The one test in this file that proves the guard rather than relying on it. Everything else here
   * asserts that real payloads are clean, which is a statement about the read model; this asserts
   * that a dirty payload would be STOPPED, which is a statement about the server. Both matter, and
   * only the second one survives someone adding a route that forgets the allowlist.
   */
  const token = GROUND_TRUTH_TOKENS[0];
  const leaky = {
    store: consoleRead.store,
    runId: consoleRead.runId,
    meta: () => ({ mode: 'CONSOLE', smuggled: { [token]: '2026-06-04T00:00:00.000Z' } }),
  };
  const base = await serve(leaky);
  const res = await fetch(`${base}/api/run`);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'GROUND_TRUTH_LEAK');
  assert.deepEqual(body.tokens, [token]);
});

test('static assets are served, with the vendored bundles cached and app code not', async () => {
  const vendor = await fetch(`${CONSOLE}/vendor/htm.umd.js`);
  assert.equal(vendor.status, 200);
  assert.match(vendor.headers.get('content-type'), /javascript/);
  /**
   * The vendored React bundles are immutable for the life of a checkout, so they may be cached. App
   * code may not: a stale `app.js` during a rehearsal is a bug that presents as a broken dashboard.
   */
  assert.match(vendor.headers.get('cache-control'), /max-age/);
  const api = await fetch(`${CONSOLE}/api/health`);
  assert.equal(api.headers.get('cache-control'), 'no-store');
});
