/**
 * THE DASHBOARD ACTUALLY PAINTS — proved without a browser.
 *
 * ================================================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ================================================================================================
 *
 * A React component that reads `detail.approval.checkIds` on a case that was never gated throws
 * `Cannot read properties of null`, React unmounts the tree, and the page goes WHITE. Nothing appears
 * in the server log, nothing appears in the test suite, and the only evidence is a line in a browser
 * console that nobody opens during a five-minute pitch. `test/api.test.js` proves the JSON is correct
 * and says nothing whatsoever about whether anything can render it — every one of its 22 tests would
 * still pass with `web/app.js` deleted.
 *
 * So this file renders the real components against the real API. It loads the vendored React and htm
 * bundles into a `vm` context, loads `web/app.js` as the classic script it is, and then invokes every
 * component function on live responses from a live server — every case in two runs, through the
 * drawer, which is the surface with the most field access and therefore the most ways to be wrong.
 *
 * ================================================================================================
 * WHAT THE HOOK STUBS DO AND DO NOT COVER, STATED PLAINLY
 * ================================================================================================
 *
 * There is no DOM here, so `ReactDOM.createRoot` cannot run and the hooks are stubbed: `useState`
 * returns its initial value, `useEffect` never fires, `useMemo` computes eagerly. That means this
 * suite proves each component renders correctly IN ITS INITIAL STATE and proves nothing about state
 * transitions or effect ordering.
 *
 * That limit is worked around rather than papered over: every state this UI can be in is reachable by
 * PROPS, and the cases below pass them explicitly — a queue with items and without, a clock whose next
 * cycle is quiet and one whose next cycle is legal, a granted case showing the envelope-refusal
 * notice, a measured run that refuses to advance, a broken invariant, a filter that matches nothing, a
 * null detail. The one genuinely uncovered path is `App`'s own fetch-and-set cycle, which
 * `test/api.test.js` covers from the other side.
 *
 * ================================================================================================
 * THE COVERAGE FLOOR
 * ================================================================================================
 *
 * A render test passes trivially if the data happens to contain no interesting cases, and it would
 * then keep passing forever while the interesting branches rot. So the assertions at the bottom pin
 * what the fixture must CONTAIN — a ladder with a chosen candidate, a stamped decision, an
 * AWAIT_APPROVAL outcome and a STOP_PERMANENT outcome, both invasiveness levels in the queue, several
 * distinct case states. If a future change makes those unreachable, this suite fails and says which
 * one went missing instead of going quietly green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createApiServer } from '../src/api/server.js';
import { createSession } from '../src/demo/session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const read = (f) => readFileSync(join(WEB, f), 'utf8');

/* ─── the sandbox ──────────────────────────────────────────────────────────── */

/**
 * `web/app.js` is a classic script, not a module, and that is what makes it testable here: top-level
 * `function` declarations become properties of the context's global object, so every component is
 * reachable by name without an export list the browser would have to pay for. It is also why every
 * component in that file is a `function` rather than a `const` arrow — an arrow binding stays in an
 * unreachable lexical scope, and a component this suite cannot name is a component it cannot prove.
 */
function loadApp() {
  const ctx = vm.createContext({ console });
  const run = (code, filename) => vm.runInContext(code, ctx, { filename });

  run('globalThis.self = globalThis; globalThis.window = globalThis;', 'bootstrap');
  run(read('vendor/react.production.min.js'), 'react.production.min.js');
  run(read('vendor/htm.umd.js'), 'htm.umd.js');

  /**
   * Patched BEFORE app.js runs, because that file destructures the hooks off `React` at load time.
   * Patching afterwards would leave it holding the real implementations, which need a renderer.
   */
  run(
    `
    React.useState = (v) => [typeof v === 'function' ? v() : v, () => {}];
    React.useEffect = () => {};
    React.useCallback = (fn) => fn;
    React.useMemo = (fn) => fn();
    React.useRef = () => ({ current: null });
    globalThis.document = { getElementById: () => ({}) };
    globalThis.__root = null;
    globalThis.ReactDOM = { createRoot: () => ({ render: (el) => { globalThis.__root = el; } }) };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.fetch = () => Promise.reject(new Error('the render harness does not fetch'));
  `,
    'shims'
  );

  run(read('app.js'), 'app.js');
  return { ctx, get: (name) => vm.runInContext(name, ctx) };
}

const { ctx: APP_CTX, get } = loadApp();
const React = get('React');

/* ─── the walker ───────────────────────────────────────────────────────────── */

/**
 * Depth-first through the element tree, calling every function component with its own props.
 * `React.createElement` builds descriptors and does not invoke anything, so without this walk the
 * only thing under test would be `createElement` itself.
 *
 * Every `className` produced along the way is collected, because the second silent failure mode of a
 * hand-written stylesheet is a class that exists in the markup and not in the CSS — invisible in a
 * render test, obvious and ugly on screen.
 */
function walkTree(node, path, out) {
  if (node === null || node === undefined) return;
  const t = typeof node;
  if (t === 'string' || t === 'number') {
    out.text.push(String(node));
    return;
  }
  if (t === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkTree(n, `${path}[${i}]`, out));
    return;
  }
  const { type, props } = node;
  if (typeof props?.className === 'string') {
    for (const token of props.className.split(/\s+/)) if (token) out.classes.add(token);
  }
  if (typeof type === 'function') {
    const name = type.name || 'anonymous';
    out.components.add(name);
    let rendered;
    try {
      rendered = type(props ?? {});
    } catch (err) {
      out.failures.push(`${path}/<${name}>: ${err.message}\n        ${(err.stack ?? '').split('\n')[1]?.trim() ?? ''}`);
      return;
    }
    walkTree(rendered, `${path}/<${name}>`, out);
    return;
  }
  walkTree(props?.children, `${path}/${typeof type === 'string' ? type : 'fragment'}`, out);
}

const COVERAGE = { classes: new Set(), components: new Set(), failures: [], text: [] };

/**
 * Render one component with one set of props, and fail loudly with the path if anything throws.
 *
 * Returns the concatenated text of the rendered tree, so a caller can assert on the words that reach the
 * screen and not merely on the absence of an exception. Copy is load-bearing here: several sentences on
 * this page exist specifically to stop a compliance behaviour from being mistaken for a broken button,
 * and a component that renders without them is broken in the way that matters.
 */
function paint(label, componentName, props) {
  const component = get(componentName);
  assert.equal(typeof component, 'function', `web/app.js does not expose a component named ${componentName}`);
  const local = { classes: COVERAGE.classes, components: COVERAGE.components, failures: COVERAGE.failures, text: [] };
  const before = COVERAGE.failures.length;
  walkTree(React.createElement(component, props), label, local);
  const added = COVERAGE.failures.slice(before);
  assert.deepEqual(
    added,
    [],
    `<${componentName}> threw while rendering ${label}. In a browser this blanks the page with only a ` +
      `console line to show for it:\n      ${added.join('\n      ')}`
  );
  return local.text.join(' ').replace(/\s+/g, ' ');
}

/* ─── one console run and one measured run, served for real ────────────────── */

const open = [];
after(async () => {
  await Promise.all(open.map((s) => new Promise((r) => s.close(r))));
});

async function serve(session) {
  const server = createApiServer({ session, staticDir: WEB });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  open.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const json = async (base, path) => {
  const res = await fetch(base + path);
  const body = await res.json();
  assert.ok(res.ok, `GET ${path} returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
};

/**
 * n=40 for the console run, matching `test/api.test.js`, and for the same load-bearing reason: at
 * n=20 every queued proposal on seed 1 is invasiveness 1, so the money-moving half of the approval
 * envelope never appears on screen and the queue rendering that matters most goes untested.
 */
const [consoleSession, measuredSession] = await Promise.all([
  createSession({ count: 40, approver: 'HUMAN' }),
  createSession({ count: 20, approver: 'SIM' }),
]);
const CONSOLE = await serve(consoleSession);
const MEASURED = await serve(measuredSession);

const cRun = await json(CONSOLE, '/api/run');
const cCases = await json(CONSOLE, '/api/cases');
const cAppr = await json(CONSOLE, '/api/approvals');
const mRun = await json(MEASURED, '/api/run');
const mCases = await json(MEASURED, '/api/cases');
const mAppr = await json(MEASURED, '/api/approvals');

const noop = () => {};
const FILTERS = { state: '', lossType: '', q: '' };

/* ─── formatters ───────────────────────────────────────────────────────────── */

test('money is formatted in lakhs and crores, from integer paise, with no float drift', () => {
  const rupees = get('rupees');
  assert.equal(rupees(22255800), '₹2,22,558', 'Indian digit grouping is not optional in a Razorpay submission');
  assert.equal(rupees(123456789000), '₹1,23,45,67,890', 'crore grouping');
  assert.equal(rupees(0), '₹0');
  assert.equal(rupees(null), '—');
  assert.equal(rupees(undefined), '—');
  assert.equal(rupees(-22382400), '−₹2,23,824', 'a negative comparison must read as a deficit, not as a stray hyphen');
  assert.equal(rupees(1), '₹0', 'sub-rupee paise round rather than printing a decimal in a ledger column');
});

test('timestamps are stamped and labelled IST, because the guardrails are defined in IST', () => {
  const ist = get('ist');
  assert.match(ist('2026-06-01T09:00:00.000Z'), /01 Jun, 14:30 IST/);
  assert.equal(ist(null), '—');
  assert.equal(ist('not a date'), '—');
});

/**
 * The quiet-hours labels are the one place the UI derives a guardrail rather than reading it, so the
 * boundaries are pinned at the exact hours GUARDRAILS.quietHours names. An off-by-one here tells the
 * operator a message will go out when it will not.
 */
test('quiet hours are labelled at the same boundaries the guardrail enforces', () => {
  const isQuiet = get('isQuiet');
  assert.equal(isQuiet('2026-06-01T03:30:00.000Z'), false, '09:00 IST exactly — contact becomes legal');
  assert.equal(isQuiet('2026-06-01T09:00:00.000Z'), false, '14:30 IST — mid-afternoon');
  assert.equal(isQuiet('2026-06-01T15:30:00.000Z'), true, '21:00 IST exactly — quiet begins');
  assert.equal(isQuiet('2026-06-01T21:00:00.000Z'), true, '02:30 IST — the cycle after a legal one');
  assert.equal(isQuiet('2026-06-01T18:30:00.000Z'), true, 'midnight IST');
});

test('a twelve-hour step against a twelve-hour window alternates, and the UI computes it', () => {
  const isQuiet = get('isQuiet');
  const step = cRun.horizon.stepHours * 3600 * 1000;
  let at = new Date(cRun.startAt).getTime();
  const pattern = [];
  for (let i = 0; i < cRun.horizon.cycles; i += 1) {
    pattern.push(isQuiet(new Date(at).toISOString()));
    at += step;
  }
  const quiet = pattern.filter(Boolean).length;
  assert.equal(quiet, 10, `10 of ${cRun.horizon.cycles} cycles are quiet — arithmetic, not a seed artefact`);
  for (let i = 1; i < pattern.length; i += 1) {
    assert.notEqual(pattern[i], pattern[i - 1], `cycles ${i - 1} and ${i} must alternate`);
  }
});

/* ─── the page, surface by surface ─────────────────────────────────────────── */

test('the masthead renders for both modes and before the run has loaded', () => {
  paint('masthead/measured', 'Masthead', { run: mRun });
  paint('masthead/console', 'Masthead', { run: cRun });
  paint('masthead/loading', 'Masthead', { run: null });
});

test('the thesis renders a money claim when measured and refuses to when paused', () => {
  paint('thesis/measured', 'Thesis', { run: mRun });
  paint('thesis/console', 'Thesis', { run: cRun });
  assert.equal(cRun.rows, null, 'console mode must serve no arm table, or the thesis would quote a truncated run');
  assert.ok(mRun.rows.some((r) => r.arm === mRun.arm), 'the measured table must contain the browsed arm');
});

test('the arm ledger renders, and disappears rather than inventing rows when there are none', () => {
  paint('ledger/measured', 'ArmLedger', { run: mRun });
  paint('ledger/console-null-rows', 'ArmLedger', { run: cRun });
  paint('invariants/all-hold', 'Invariants', { run: mRun });
  paint('invariants/one-broken', 'Invariants', {
    run: { ...mRun, invariants: { ...mRun.invariants, allMoneyReconciles: false } },
  });
});

test('the approval queue renders with items, empty, with a simulated reviewer, and unsigned', () => {
  const base = {
    run: cRun,
    approvals: cAppr,
    granted: {},
    busy: false,
    onResolve: noop,
    onAdvance: noop,
    signer: 'mohit',
    setSigner: noop,
    lastStep: null,
  };
  paint('queue/console-with-items', 'Queue', base);
  paint('queue/measured-sim-reviewer', 'Queue', { ...base, run: mRun, approvals: mAppr });
  paint('queue/console-empty', 'Queue', { ...base, approvals: { ...cAppr, items: [], pendingCount: 0 } });
  paint('queue/unsigned', 'Queue', { ...base, signer: '' });
  paint('queue/busy', 'Queue', { ...base, busy: true });
});

/**
 * The envelope-refusal notice is the single most instructive thing in this console and the single
 * easiest to mistake for a broken button, so its rendering is pinned separately with a granted case
 * whose new proposal is more invasive than the signature it was given.
 */
test('a case returned by the envelope renders the notice that explains why', () => {
  assert.ok(cAppr.items.length > 0, 'the console fixture must have something pending');
  const item = cAppr.items[0];
  paint('queue/regate-notice', 'Queue', {
    run: cRun,
    approvals: cAppr,
    granted: { [item.eventId]: { invasiveness: 1, action: 'SWITCH_RAIL_NUDGE:WHATSAPP' } },
    busy: false,
    onResolve: noop,
    onAdvance: noop,
    signer: 'mohit',
    setSigner: noop,
    lastStep: null,
  });
});

test('the clock renders every state it can be in, including both refusals', () => {
  const base = { run: cRun, busy: false, onAdvance: noop, lastStep: null };
  paint('clock/next-cycle-legal', 'Clock', base);
  paint('clock/next-cycle-quiet', 'Clock', { ...base, run: { ...cRun, clockAt: '2026-06-01T21:00:00.000Z' } });
  paint('clock/measured-refuses', 'Clock', { ...base, run: mRun });
  paint('clock/horizon-complete', 'Clock', { ...base, run: { ...cRun, cyclesRun: cRun.horizon.cycles } });
  paint('clock/step-ran', 'Clock', {
    ...base,
    lastStep: { ran: true, cycle: 2, clockAt: cRun.clockAt, summary: { decided: 12, acted: 3, note: 'none' } },
  });
  paint('clock/step-refused', 'Clock', {
    ...base,
    run: mRun,
    lastStep: { ran: false, because: 'This is a MEASURED run: its horizon is complete.', summary: null },
  });
});

/* ─── running the horizon ──────────────────────────────────────────────────── */

/**
 * Cycle 3 lands at 02:30 IST and cycle 4 at 14:30 IST, so one tape row must be labelled quiet and the
 * other open. Cycle 2 carries a null summary, which is the row a cycle produces when the guardrail let
 * nothing through — the case that would print `[object Object]` or a bare blank if the fallback were missing.
 */
const TAPE = [
  { cycle: 4, clockAt: '2026-06-02T09:00:00.000Z', summary: { decided: 12, acted: 3, deferred: 4 }, states: null },
  { cycle: 3, clockAt: '2026-06-01T21:00:00.000Z', summary: { decided: 11, acted: 0 }, states: null },
  { cycle: 2, clockAt: '2026-06-01T09:00:00.000Z', summary: null, states: null },
];

/** Deliberately carries a state STATE_ORDER does not know about, to prove the append path. */
const STATES = { OPEN: 21, SCHEDULED: 3, AWAITING_APPROVAL: 9, RECOVERED: 5, STOPPED: 2, A_NEW_STATE: 1 };

test('the standings tally is the server\'s, is ordered, and hides no unfamiliar state', () => {
  const text = paint('standings/with-unknown', 'Standings', { states: STATES });
  assert.match(text, /open 21/, 'the tally must print the count the server sent');
  assert.match(text, /awaiting approval 9/, 'underscores become spaces so the chip reads as English');
  assert.match(
    text,
    /a new state 1/,
    'a lifecycle state STATE_ORDER has never heard of must still appear — dropping it would leave a ' +
      'tally that silently does not add up to the batch'
  );
  assert.ok(text.indexOf('open 21') < text.indexOf('recovered 5'), 'the order is fixed, not object-key order');
  paint('standings/null', 'Standings', { states: null });
  paint('standings/empty', 'Standings', { states: {} });
});

test('the tape labels each cycle quiet or open, and survives a cycle that did nothing', () => {
  const text = paint('tape/three-rows', 'Tape', { tape: TAPE });
  assert.match(text, /quiet/, 'cycle 3 lands at 02:30 IST');
  assert.match(text, /open/, 'cycle 4 lands at 14:30 IST');
  assert.match(text, /decided=12 · acted=3/, 'the cycle summary is the server\'s own scalars');
  assert.match(
    text,
    /no contacting work was legal on this cycle/,
    'a cycle with no summary must say why rather than render an empty row'
  );
  assert.doesNotMatch(text, /\[object Object\]/, 'nested summary fields must never reach the screen');
  paint('tape/empty', 'Tape', { tape: [] });
  paint('tape/null', 'Tape', { tape: null });
});

test('the clock offers a run only where a run is legal, and an interrupt while one is going', () => {
  const base = { run: cRun, busy: false, onAdvance: noop, onRun: noop, onStop: noop, states: STATES, tape: [] };

  const idle = paint('clock/run-idle', 'Clock', { ...base, lastStep: null, running: false });
  assert.match(idle, /Run to horizon/, 'console mode must offer the run');

  const going = paint('clock/running', 'Clock', { ...base, lastStep: null, running: true, tape: TAPE });
  assert.match(going, /Stop/, 'a run must be interruptible or it cannot be demonstrated safely');
  assert.doesNotMatch(going, /Run to horizon/, 'the run control becomes the interrupt, it does not sit beside it');
  assert.match(
    going,
    /No money appears while this runs/,
    'the reason console mode reports no money has to be on screen DURING the run, which is exactly when a ' +
      'viewer would otherwise assume the number is coming'
  );

  paint('clock/measured-no-run', 'Clock', { ...base, run: mRun, lastStep: null, running: false });
});

/**
 * The payoff beat of the whole console: run the horizon without signing anything, and the cases that
 * needed a signature are still sitting there at the end. If this sentence goes missing, the demo shows an
 * agent that left money on the table and offers no reason why.
 */
test('a finished run with unsigned cases says the gate is what held them', () => {
  const finished = { ...cRun, cyclesRun: cRun.horizon.cycles };
  const text = paint('clock/finished-with-frozen', 'Clock', {
    run: finished,
    busy: false,
    onAdvance: noop,
    onRun: noop,
    onStop: noop,
    lastStep: null,
    running: false,
    tape: TAPE,
    states: STATES,
  });
  assert.match(text, /9 cases are still waiting for a signature/);
  assert.match(text, /Nothing was spent on them and nothing came back from them/);
  assert.match(text, /Horizon complete/, 'and the button must say so rather than inviting another click');

  const singular = paint('clock/finished-one-frozen', 'Clock', {
    run: finished,
    busy: false,
    onAdvance: noop,
    lastStep: null,
    states: { ...STATES, AWAITING_APPROVAL: 1 },
    tape: [],
  });
  assert.match(singular, /1 case is still waiting/, 'the sentence has to read correctly at n=1');

  const none = paint('clock/finished-none-frozen', 'Clock', {
    run: finished,
    busy: false,
    onAdvance: noop,
    lastStep: null,
    states: { ...STATES, AWAITING_APPROVAL: undefined },
    tape: [],
  });
  assert.doesNotMatch(none, /waiting for a signature/, 'with nothing frozen the sentence must not appear at all');
});

test('the case register renders full, filtered to nothing, and before its data arrives', () => {
  const base = { cases: cCases, filters: FILTERS, setFilters: noop, openId: null, onOpen: noop };
  paint('register/full', 'Register', base);
  paint('register/row-open', 'Register', { ...base, openId: cCases.cases[0].eventId });
  paint('register/no-match', 'Register', { ...base, filters: { ...FILTERS, q: 'zzzz-no-such-customer' } });
  paint('register/null-cases', 'Register', { ...base, cases: null });
});

test('the caveat block renders every sentence the API serves, in both modes', () => {
  paint('caveats/measured', 'Caveats', { run: mRun });
  paint('caveats/console', 'Caveats', { run: cRun });
  assert.ok(mRun.caveats.length >= 4, 'measured mode must carry the incremental-money and one-world caveats');
  assert.ok(
    cRun.caveats.some((c) => /NO MONEY FIGURES/.test(c)),
    'console mode must say on screen that it reports no money'
  );
});

test('the app shell renders before any data has loaded', () => {
  paint('app/pre-load', 'App', {});
});

/* ─── the drawer, against every case in both runs ──────────────────────────── */

const SEEN = { states: new Set(), outcomes: new Set(), ladders: 0, stamped: 0, receipts: 0, gated: 0, drawn: 0 };

test('every case in both runs opens in the drawer without throwing', async () => {
  for (const [base, list, tag] of [
    [CONSOLE, cCases.cases, 'console'],
    [MEASURED, mCases.cases, 'measured'],
  ]) {
    for (const c of list) {
      const detail = await json(base, `/api/cases/${encodeURIComponent(c.eventId)}`);
      SEEN.states.add(detail.state);
      if (detail.approval) SEEN.gated += 1;
      if ((detail.actions ?? []).some((a) => a.receipt)) SEEN.receipts += 1;
      for (const d of detail.decisions ?? []) {
        SEEN.outcomes.add(d.outcome);
        if ((d.candidates ?? []).length > 0) SEEN.ladders += 1;
        if ((d.candidates ?? []).some((k) => k.chosen)) SEEN.stamped += 1;
      }
      paint(`drawer/${tag}/${c.eventId}`, 'Drawer', { detail, onClose: noop });
      SEEN.drawn += 1;
    }
  }
  paint('drawer/null-detail', 'Drawer', { detail: null, onClose: noop });
  assert.ok(SEEN.drawn >= 50, `only ${SEEN.drawn} drawers rendered — the fixture shrank`);
});

/**
 * THE COVERAGE FLOOR. Without these, the suite above passes on a fixture containing nothing
 * interesting, and keeps passing while the branches that matter rot.
 */
test('the fixture actually exercised the branches this suite claims to cover', () => {
  assert.ok(SEEN.ladders >= 100, `${SEEN.ladders} candidate ladders rendered; expected 100+`);
  assert.ok(SEEN.stamped >= 50, `${SEEN.stamped} decisions carried a chosen candidate; expected 50+`);
  assert.ok(SEEN.gated >= 5, `${SEEN.gated} cases carried an approval record; expected 5+`);
  assert.ok(SEEN.receipts >= 5, `${SEEN.receipts} cases carried a receipt; expected 5+`);
  for (const state of ['RECOVERED', 'STOPPED', 'AWAITING_APPROVAL']) {
    assert.ok(SEEN.states.has(state), `no ${state} case was rendered — the drawer's ${state} branch is untested`);
  }
  for (const outcome of ['ACT', 'AWAIT_APPROVAL', 'STOP_PERMANENT']) {
    assert.ok(SEEN.outcomes.has(outcome), `no ${outcome} decision was rendered — the ladder's stamp text is untested`);
  }
  const invasiveness = new Set(cAppr.items.map((i) => i.proposedInvasiveness));
  assert.ok(
    invasiveness.has(1) && invasiveness.has(2),
    `the queue held only invasiveness ${[...invasiveness].join('/')} — the envelope has two halves and this ` +
      'fixture renders one. Raise the case count until both appear.'
  );
});

/* ─── the run loop, every exit, with fakes ─────────────────────────────────── */

/**
 * The loop is the only code on this page whose failure mode is not a blank rectangle. A wrong break
 * condition gives a hung tab and two hundred POSTs at a server, in front of a judge. So all four exits are
 * proved here with a fake stepper and no pause, and then the contract the loop leans on is proved against
 * the real server below.
 *
 * These assert field by field rather than with `deepStrictEqual`. `runToHorizon` returns an object built
 * inside the `vm` context, so its prototype is that realm's `Object.prototype` and a strict deep-equal
 * fails with "same structure but not reference-equal" even when every value matches. Field assertions also
 * say which part disagreed, which a whole-object diff does not.
 */
const outcome = (out) => `${out.stopped} after ${out.ran}`;

test('the run loop stops at the horizon, and reports how many cycles it ran', async () => {
  const runToHorizon = get('runToHorizon');
  const calls = [];
  const step = async () => {
    const cycle = calls.length + 3;
    calls.push(cycle);
    return { ran: true, cycle, cyclesRun: cycle, cyclesTotal: 21 };
  };
  const out = await runToHorizon({ step, onPause: async () => {} });
  assert.equal(outcome(out), 'horizon after 19');
  assert.equal(calls.length, 19, 'cycles 3 through 21 inclusive');
});

test('the run loop stops on a refusal instead of retrying it', async () => {
  const runToHorizon = get('runToHorizon');
  let n = 0;
  const step = async () => {
    n += 1;
    if (n === 3) return { ran: false, because: 'the horizon is finished' };
    return { ran: true, cycle: n, cyclesRun: n, cyclesTotal: 21 };
  };
  const out = await runToHorizon({ step, onPause: async () => {} });
  assert.equal(outcome(out), 'refused after 2');
  assert.equal(n, 3, 'it must not step again after being refused once');
});

test('the run loop treats a missing body as a refusal rather than a cycle', async () => {
  const runToHorizon = get('runToHorizon');
  const out = await runToHorizon({ step: async () => null, onPause: async () => {} });
  assert.equal(outcome(out), 'refused after 0');
});

/**
 * Stop is checked BEFORE stepping. If it were checked after, a Stop pressed while a cycle was in flight
 * would still let that cycle land, and on a money-moving action "I pressed stop and it charged anyway" is
 * the worst sentence this console could produce.
 */
test('the run loop honours an interrupt before it steps, not after', async () => {
  const runToHorizon = get('runToHorizon');
  let n = 0;
  const step = async () => {
    n += 1;
    return { ran: true, cycle: n, cyclesRun: n, cyclesTotal: 21 };
  };
  const out = await runToHorizon({ step, shouldStop: () => n >= 2, onPause: async () => {} });
  assert.equal(outcome(out), 'interrupted after 2');
  assert.equal(n, 2, 'no cycle may run after the interrupt is seen');

  let m = 0;
  const counted = async () => {
    m += 1;
    return { ran: true, cycle: m, cyclesRun: m, cyclesTotal: 21 };
  };
  const immediate = await runToHorizon({ step: counted, shouldStop: () => true, onPause: async () => {} });
  assert.equal(outcome(immediate), 'interrupted after 0', 'Stop before the first cycle runs nothing');
  assert.equal(m, 0, 'and the stepper is never called at all');
});

/**
 * A server that never reports the end of its horizon must not spin the browser forever, and the cap must be
 * distinguishable from a clean finish — App turns `cap` into a visible defect notice rather than letting the
 * page look like a completed run.
 */
test('the run loop cannot spin forever, and says so distinctly when it is capped', async () => {
  const runToHorizon = get('runToHorizon');
  let n = 0;
  const step = async () => {
    n += 1;
    return { ran: true, cycle: n, cyclesRun: 1, cyclesTotal: 21 };
  };
  const out = await runToHorizon({ step, onPause: async () => {}, cap: 7 });
  assert.equal(outcome(out), 'cap after 7');
  assert.notEqual(out.stopped, 'horizon', 'a capped run must never be reported as a finished one');
});

/**
 * n=40, not a smaller batch. At n=8 on seed 1 this arm never needs an approval, so `createSession` advances
 * straight to the end of the horizon and hands back a COMPLETED run — the first advance is then a refusal
 * and the horizon exit is never exercised. That is correct behaviour and a useless fixture, and it cost a
 * failing test to notice.
 */
test('the server really does report the end of its horizon, which is what the loop waits for', async () => {
  const stepped = await createSession({ count: 40, approver: 'HUMAN' });
  const base = await serve(stepped);
  const before = await json(base, '/api/run');
  assert.equal(before.mode, 'CONSOLE');
  assert.ok(before.cyclesRun < before.horizon.cycles, 'the fixture must start mid-horizon or it proves nothing');

  let last = null;
  let steps = 0;
  while (steps < 60) {
    const res = await fetch(`${base}/api/advance`, { method: 'POST' });
    last = await res.json();
    steps += 1;
    if (last.ran === false) break;
    if (last.cyclesRun >= last.cyclesTotal) break;
  }
  assert.equal(last.ran, true, 'the last successful step should be a real cycle, not a refusal');
  assert.equal(
    last.cyclesRun,
    last.cyclesTotal,
    'the loop breaks on cyclesRun >= cyclesTotal, so the server must actually reach equality'
  );
  assert.ok(steps < 60, `took ${steps} steps — the loop would have hit its own cap`);

  const past = await fetch(`${base}/api/advance`, { method: 'POST' });
  const body = await past.json();
  assert.equal(past.status, 409, 'advancing past the horizon is a conflict, not a success');
  assert.equal(body.ran, false);
  assert.match(body.because ?? '', /horizon/i, 'and it must say why, because the UI prints that sentence');
});

/* ─── the static contract ──────────────────────────────────────────────────── */

/**
 * Every class the components actually produced must exist in the stylesheet.
 *
 * A typo'd class name is invisible to every other check in this project: the JSON is right, the
 * component renders, the test passes, and the element arrives on screen unstyled. Collecting the
 * classes during the render above rather than by grepping the source means the dynamic ones —
 * `chip ${tone}`, `row${open ? ' row-open' : ''}` — are checked in the exact combinations they ship in.
 */
test('every class the components emit is defined in app.css', () => {
  const css = read('app.css');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  const missing = [...COVERAGE.classes].filter((c) => !defined.has(c)).sort();
  assert.deepEqual(
    missing,
    [],
    `these classes are rendered but never styled, so they ship unstyled: ${missing.join(', ')}`
  );
  assert.ok(COVERAGE.classes.size >= 40, `only ${COVERAGE.classes.size} classes were exercised; expected 40+`);
});

/**
 * Load order is not cosmetic. React defines the global that ReactDOM attaches to, and htm binds
 * React.createElement, so any other order fails with a bare "React is not defined" and a white page.
 */
test('index.html loads the vendored bundles in the only order that works', () => {
  const indexHtml = read('index.html');
  const scripts = [...indexHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    '/vendor/react.production.min.js',
    '/vendor/react-dom.production.min.js',
    '/vendor/htm.umd.js',
    '/app.js',
  ]);
  assert.doesNotMatch(
    indexHtml,
    /https?:\/\//,
    'no external URL may appear in index.html: this page has to render with no network at all'
  );
});

test('app.js reaches the browser through the same server that serves the API', async () => {
  for (const [path, type, cache] of [
    ['/', 'text/html', 'no-store'],
    ['/app.js', 'text/javascript', 'no-store'],
    ['/app.css', 'text/css', 'no-store'],
    ['/vendor/react.production.min.js', 'text/javascript', 'max-age'],
  ]) {
    const res = await fetch(CONSOLE + path);
    assert.equal(res.status, 200, `GET ${path}`);
    assert.match(res.headers.get('content-type') ?? '', new RegExp(type), `content-type of ${path}`);
    assert.match(res.headers.get('cache-control') ?? '', new RegExp(cache), `cache-control of ${path}`);
  }
});

/**
 * The UI must not compute money. Every rupee on screen is an integer paise value from the API divided
 * by 100 at print time; the moment this file starts summing, the screen and `npm run eval` can
 * disagree, and the screen is the one people believe. `rupees()` owns the only division, and the two
 * exceptions are named rather than left to be discovered.
 */
test('the browser divides paise in exactly one place and sums nothing', () => {
  const source = read('app.js');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const divisions = [...body.matchAll(/\/\s*100\b/g)];
  assert.equal(divisions.length, 1, 'paise should be divided by 100 in rupees() and nowhere else');
  assert.match(body, /function rupees/, 'rupees() owns the conversion');
  assert.doesNotMatch(body, /\.reduce\(/, 'a reduce over money in the UI is a total the eval never computed');
  const paiseMath = [...body.matchAll(/Paise\s*[-+*]\s*\w*Paise/g)].map((m) => m[0]);
  assert.deepEqual(paiseMath, [], `arithmetic on paise fields in the UI: ${paiseMath.join(', ')}`);
});

test('every component in app.js was rendered by this suite', () => {
  const source = read('app.js');
  const declared = [...source.matchAll(/^function ([A-Z]\w*)\(/gm)].map((m) => m[1]);
  const unrendered = declared.filter((name) => !COVERAGE.components.has(name));
  assert.deepEqual(
    unrendered,
    [],
    `declared but never rendered, so nothing proves they paint: ${unrendered.join(', ')}`
  );
  assert.ok(declared.length >= 15, `only ${declared.length} components found; expected 15+`);
});
