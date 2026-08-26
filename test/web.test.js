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
  if (t === 'boolean' || t === 'string' || t === 'number') return;
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

const COVERAGE = { classes: new Set(), components: new Set(), failures: [] };

/** Render one component with one set of props, and fail loudly with the path if anything throws. */
function paint(label, componentName, props) {
  const component = get(componentName);
  assert.equal(typeof component, 'function', `web/app.js does not expose a component named ${componentName}`);
  const before = COVERAGE.failures.length;
  walkTree(React.createElement(component, props), label, COVERAGE);
  const added = COVERAGE.failures.slice(before);
  assert.deepEqual(
    added,
    [],
    `<${componentName}> threw while rendering ${label}. In a browser this blanks the page with only a ` +
      `console line to show for it:\n      ${added.join('\n      ')}`
    );
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
