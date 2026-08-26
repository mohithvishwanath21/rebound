/*
 * REBOUND CONSOLE — the browser half.
 *
 * No build step, no JSX, no bundler. React 18 arrives as three UMD globals from web/vendor/ and
 * `htm` binds tagged templates to React.createElement, which buys JSX-shaped markup at the cost of
 * one library and zero tooling. The reason is the same reason the server has no dependencies: every
 * claim this project makes is meant to survive `git clone && node`, and the dashboard is the artefact
 * a reviewer is most likely to open.
 *
 * ================================================================================================
 * WHAT THIS FILE IS ALLOWED TO DO, AND THE ONE THING IT IS NOT
 * ================================================================================================
 *
 * It formats. It does not compute. Every rupee on screen is an integer paise value from the API,
 * divided by 100 at the moment it is printed and never before. There is no summing, no averaging and
 * no ratio arithmetic anywhere below — those come from `compareWithinWorld` in src/eval/metrics.js,
 * the same function `npm run eval` calls, so a figure a judge reads here is the figure the
 * engineering log defends. The moment this file computes its own total it becomes possible for the
 * screen and the eval to disagree, and the screen is the one people believe.
 *
 * Two derived values are deliberate exceptions, and neither is money: `isQuiet()` reads an hour off
 * the run clock to label the next cycle, and the EV identity block re-does `gross - costs` in order
 * to DISAGREE with the server if the arithmetic is broken. The read model already ships `checksOut`;
 * printing the subtraction next to it lets a reader check by hand rather than trust a boolean.
 *
 * ================================================================================================
 * THE THING THE UI HAS TO EXPLAIN, NOT HIDE
 * ================================================================================================
 *
 * Quiet hours are 21:00–09:00 IST — twelve hours — and the clock steps twelve hours, so cycles
 * strictly alternate between an hour where customer contact is legal and one where it is not. Ten of
 * twenty-one cycles can do no contacting work at all. The consequence a judge will hit within thirty
 * seconds of clicking Approve: if the next cycle is quiet, the agent will NOT send the message you
 * signed for. It re-decides, and if its new best action is more invasive than your signature covered,
 * the case comes back to the queue.
 *
 * That is the approval envelope working exactly as designed, and it looks identical to a broken
 * button. So the console says so in three places — beside the clock before you act, on the returned
 * request after you act, and on the ladder where the deferred candidates are visible with their
 * earliest legal hour. A compliance feature that cannot be told apart from a bug is not a feature.
 */

/* eslint-env browser */
const { createElement, useState, useEffect, useCallback, useMemo, useRef } = React;
const html = htm.bind(createElement);

/* ─────────────────────────────────────────────────────────────────────────────
 * FORMATTING. Paise in, string out, no arithmetic beyond the division by 100.
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Indian digit grouping, which is not a nicety. 22255800 paise is ₹2,22,558 — two, twenty-two
 * thousand, five hundred and fifty-eight — and rendering it ₹222,558 in a submission to Razorpay
 * would be the first thing a reviewer noticed. `en-IN` does the lakh/crore grouping natively.
 */
function rupees(paise, dash = '—') {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return dash;
  const sign = paise < 0 ? '−' : '';
  return `${sign}₹${Math.round(Math.abs(paise) / 100).toLocaleString('en-IN')}`;
}

const IST_PARTS = {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

/**
 * Everything is stamped in IST, labelled IST, because the guardrail that shapes this whole run is
 * defined in IST. A dashboard that printed the operator's local time would put the quiet-hours story
 * out of reach of anyone not sitting in India.
 */
function ist(value, opts = {}) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleString('en-IN', { ...IST_PARTS, ...opts })} IST`;
}

const HOUR_ONLY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' });

function istHour(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Number(HOUR_ONLY.format(d));
}

/** Mirrors GUARDRAILS.quietHours (21:00–09:00 Asia/Kolkata). Labels only — the server enforces. */
function isQuiet(value) {
  const h = istHour(value);
  if (h === null) return false;
  return h >= 21 || h < 9;
}

function pct(p) {
  return p === null || p === undefined ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** InvasivenessLevel, in the operator's words rather than the enum's. */
/**
 * How long to pause between cycles when running the whole horizon.
 *
 * The server does real work per cycle — decide every open case, rank, execute, persist — so this is a
 * pause for the OPERATOR's eye rather than for the machine. Without it the twenty-one cycles resolve in
 * one repaint and the run looks like a page load instead of an agent working, which defeats the point.
 */
const RUN_STEP_MS = 220;

/**
 * A backstop, not the loop's bound. The real bound is the server's own `cyclesRun >= cyclesTotal`, and
 * a refusal breaks the loop too. This exists because the failure mode of getting that wrong is a browser
 * tab that spins forever mid-pitch, and a wrong number of cycles is a far cheaper bug than a hung page.
 */
const RUN_HARD_CAP = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RUN CYCLES UNTIL ONE OF FOUR THINGS STOPS US.
 *
 * Lifted out of the component on purpose. A loop that calls a server repeatedly is the one piece of this
 * page whose failure mode is not a blank rectangle but a hung tab and a hammered server, and inside a
 * `useCallback` it is unreachable by any test. Out here it takes its clock, its interrupt and its stepper
 * as arguments, so every exit can be proved with fakes and no server at all.
 *
 * The four exits, in the order they are checked:
 *   interrupted — the operator pressed Stop. Checked BEFORE stepping, so Stop cannot be overtaken by a
 *                 cycle that was already in flight when it was pressed.
 *   refused     — the step came back `ran: false`, or came back nothing. The run's state changed under us,
 *                 and retrying would turn one honest refusal into `cap` identical ones.
 *   horizon     — the SERVER says `cyclesRun >= cyclesTotal`. The horizon is the server's fact; deriving it
 *                 here from a count would drift the moment anything else advanced the clock.
 *   cap         — the backstop. Never expected to fire, and reported distinctly so that if it ever does,
 *                 it reads as the bug it is rather than as a normal finish.
 */
async function runToHorizon({ step, shouldStop = () => false, onPause = sleep, cap = RUN_HARD_CAP }) {
  let ran = 0;
  for (let guard = 0; guard < cap; guard += 1) {
    if (shouldStop()) return { ran, stopped: 'interrupted' };
    const body = await step();
    if (!body || body.ran === false) return { ran, stopped: 'refused' };
    ran += 1;
    if (body.cyclesRun >= body.cyclesTotal) return { ran, stopped: 'horizon' };
    await onPause(RUN_STEP_MS);
  }
  return { ran, stopped: 'cap' };
}

/**
 * The scalar fields of a cycle summary, as one line. Strings, numbers and booleans only: the summary is
 * the orchestrator's own record and may carry nested detail, and a `[object Object]` on screen during a
 * demo is worse than an omission.
 */
function scalarLine(summary) {
  return Object.entries(summary ?? {})
    .filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}=${v}`)
    .join(' · ');
}

const INVASIVENESS = { 0: 'no contact', 1: 'contacts the customer', 2: 'moves money' };
const invasivenessWords = (n) => INVASIVENESS[n] ?? 'unknown';

/** Action signatures are SCREAMING_SNAKE:CHANNEL. Humanised for headings, kept raw in mono fields. */
function humanise(signature) {
  if (!signature) return '—';
  return signature
    .split(':')
    .map((part) => part.replace(/_/g, ' ').toLowerCase())
    .join(' · ');
}

const STATE_TONE = {
  RECOVERED: 'chip-credit',
  RECOVERED_SELF: 'chip-ink',
  STOPPED: 'chip-debit',
  ESCALATED: 'chip-debit',
  AWAITING_APPROVAL: 'chip-stamp',
  SCHEDULED: 'chip-ink',
  OPEN: 'chip-ink',
};
const VERDICT_TONE = { ALLOW: 'chip-ink', DEFER: 'chip-stamp', DENY: 'chip-debit' };

/* ─────────────────────────────────────────────────────────────────────────────
 * TRANSPORT
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * One fetch wrapper, and it treats a 409 as data rather than as an error.
 *
 * Both writes in this API can refuse — a grant on a case that is no longer pending, an advance on a
 * run whose figures have been measured — and each refusal carries a `because` sentence written to be
 * shown to the operator. Throwing on `!res.ok` would swallow exactly the sentences that explain the
 * product's stopping rules, so the status comes back alongside the body and the caller decides.
 */
async function call(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, ok: res.ok, body };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * SMALL PARTS
 * ───────────────────────────────────────────────────────────────────────────── */

/**
 * Every component here is a `function` declaration rather than a `const` arrow, and that is a
 * testability decision rather than a style one. `test/web.test.js` runs this file in a `vm` context and
 * renders each component against real API responses, which is the only way to catch a malformed
 * template or a typo'd field without a browser — and in a classic script, top-level `function`
 * declarations land on the global object while top-level `const` bindings stay in an unreachable
 * lexical scope. Arrow components would be invisible to the test that proves they paint.
 */
function Chip({ tone = 'chip-ink', children, title }) {
  return html`<span className=${`chip ${tone}`} title=${title}>${children}</span>`;
}

function Eyebrow({ children }) {
  return html`<span className="eyebrow">${children}</span>`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * MASTHEAD
 * ───────────────────────────────────────────────────────────────────────────── */

function Masthead({ run }) {
  const quiet = run && isQuiet(run.clockAt);
  return html`
    <header className="masthead">
      <div className="masthead-in">
        <h1 className="wordmark">Rebound</h1>
        <span className="masthead-sub">
          ${run ? `${run.runId} · seed ${run.seed} · ${run.split} · n=${run.n}` : 'loading'}
        </span>
        <span className="masthead-spacer"></span>
        ${run &&
        html`
          <${Chip} tone=${run.mode === 'MEASURED' ? 'chip-credit' : 'chip-stamp'}>
            ${run.mode === 'MEASURED' ? 'measured · all five arms' : 'console · you review'}
          <//>
          <${Chip} tone="chip-ink" title="Every figure here is simulated policy. The Razorpay integration is proved separately by npm run doctor.">
            simulation
          <//>
          <span className="masthead-sub">
            run clock ${ist(run.clockAt)} · ${quiet ? 'quiet hours' : 'contact legal'}
          </span>
        `}
      </div>
    </header>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE THESIS
 *
 * Not a KPI card. The headline number is set inside the sentence that qualifies it, because the
 * number alone is the one thing in this project that could be quoted dishonestly: gross recovery
 * overstates the result by roughly two thirds, and "over and above what arrived with no agent at
 * all" is the clause that makes the figure mean what it says. Splitting them across a big-number
 * card and a footnote is how that clause gets lost.
 * ───────────────────────────────────────────────────────────────────────────── */

function Thesis({ run }) {
  const ours = run.rows ? run.rows.find((r) => r.arm === run.arm) : null;

  if (!ours) {
    return html`
      <section className="thesis">
        <p className="thesis-lede">Paused at cycle ${run.cyclesRun} of ${run.horizon.cycles} — you are the reviewer</p>
        <span className="thesis-figure thesis-figure-muted">${rupees(run.totalExposurePaise)}</span>
        <p className="thesis-tail">at risk across ${run.n} cases. No recovery total is computed in this mode.</p>
        <p className="thesis-note">
          A paused run is a truncated run, and truncation is biased twice in our favour: cases still in flight have
          had less time to fail, and every case frozen in the approval queue is money the policy never spent trying.
          Quoting a total from here would flatter the result, so none is computed. Run <code>npm run api</code>
          without <code>--approver=HUMAN</code> for the measured comparison.
        </p>
      </section>
    `;
  }

  const b3 = run.rows.find((r) => r.arm === 'B3_FIXED_LADDER') ?? null;
  return html`
    <section className="thesis">
      <p className="thesis-lede">Of ${rupees(run.totalExposurePaise)} at risk across ${run.n} cases, Rebound brought back</p>
      <span className="thesis-figure">${rupees(ours.incrementalPaise)}</span>
      <p className="thesis-tail">
        over and above the ${rupees(run.counterfactualPaise)} that arrived with no agent at all.
      </p>
      <p className="thesis-note">
        Incremental, not gross: B0_DO_NOTHING measures what customers pay unprompted, and that is subtracted from
        every arm below. It spent ${ours.attempts} attempts and ${ours.messages} messages doing it
        ${b3 ? html` — against the fixed ladder's ${b3.attempts} attempts for ${rupees(b3.incrementalPaise)}` : ''}.
        One world, one seed; the reported result is pooled over five worlds on the held-out split.
      </p>
    </section>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE ARM LEDGER
 * ───────────────────────────────────────────────────────────────────────────── */

const LEDGER_COLUMNS = [
  { key: 'incrementalPaise', label: 'incremental', money: true, credit: true },
  { key: 'recoveredPaise', label: 'recovered gross', money: true },
  { key: 'attempts', label: 'attempts' },
  { key: 'messages', label: 'messages' },
  { key: 'retries', label: 'retries' },
  { key: 'frozenPaise', label: 'frozen in queue', money: true },
  { key: 'stoppedCases', label: 'stopped' },
];

function ArmLedger({ run }) {
  if (!run.rows) return null;
  return html`
    <section className="block">
      <${Eyebrow}>Five policies, one world, one model, one clock, one scorer<//>
      <div className="ledger-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th className="ledger-head ledger-head-l" scope="col">arm</th>
              ${LEDGER_COLUMNS.map((c) => html`<th className="ledger-head" scope="col" key=${c.key}>${c.label}</th>`)}
              <th className="ledger-head" scope="col">vs ladder</th>
            </tr>
          </thead>
          <tbody>
            ${run.rows.map((r) => {
              const ours = r.arm === run.arm;
              return html`
                <tr key=${r.arm} className=${ours ? 'ledger-row-ours' : 'ledger-row-base'}>
                  <th className="ledger-arm" scope="row">${r.arm.replace(/_/g, ' ')}</th>
                  ${LEDGER_COLUMNS.map(
                    (c) => html`
                      <td key=${c.key} className=${`ledger-cell${c.credit && r[c.key] > 0 ? ' ledger-credit' : ''}`}>
                        ${c.money ? rupees(r[c.key]) : (r[c.key] ?? '—')}
                      </td>
                    `
                  )}
                  <td className="ledger-cell" title=${r.vsB3Ratio?.reason ?? ''}>
                    ${r.vsB3Ratio && r.vsB3Ratio.value !== null && r.vsB3Ratio.reason === null
                      ? `${r.vsB3Ratio.value.toFixed(2)}×`
                      : '—'}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
      <div className="ledger-foot">
        <span>at risk <span className="ledger-foot-v">${rupees(run.totalExposurePaise)}</span></span>
        <span>would have arrived anyway <span className="ledger-foot-v">${rupees(run.counterfactualPaise)}</span></span>
        <span>horizon <span className="ledger-foot-v">${run.horizon.cycles} cycles × ${run.horizon.stepHours}h</span></span>
        <span>reviewer <span className="ledger-foot-v">${run.approverKind}${run.approverSlaHours ? ` · ${run.approverSlaHours}h SLA` : ''}</span></span>
      </div>
      <${Invariants} run=${run} />
    </section>
  `;
}

/**
 * The invariant strip, rendered whether it passes or fails and placed above the fold of the reader's
 * attention rather than in a footer. Every figure in the table is void if any of these is false —
 * money that does not reconcile against its receipts, or arms that did not share a world — and a
 * reader who sees the numbers first and the warning last has already formed an impression.
 */
function Invariants({ run }) {
  if (!run.invariants) return null;
  const broken = Object.entries(run.invariants).filter(([, ok]) => ok === false);
  const total = Object.keys(run.invariants).length;
  if (broken.length === 0) {
    return html`<p className="invariants">All ${total} cross-arm invariants hold — money reconciles to receipts, and every arm met the same world</p>`;
  }
  return html`
    <p className="invariants invariants-bad">
      ${broken.length} of ${total} invariants failed: ${broken.map(([k]) => k).join(', ')}. Nothing in this table may be
      quoted. This is a defect, not a bad seed.
    </p>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE APPROVAL QUEUE
 * ───────────────────────────────────────────────────────────────────────────── */

function Queue({
  run,
  approvals,
  granted,
  busy,
  onResolve,
  onAdvance,
  signer,
  setSigner,
  lastStep,
  running = false,
  onRun = null,
  onStop = null,
  tape = [],
  states = null,
}) {
  const items = approvals?.items ?? [];
  const simReviewer = (approvals?.approverKind ?? run.approverKind) === 'SIM';

  return html`
    <section className="panel" aria-labelledby="queue-title">
      <div className="panel-head">
        <h2 className="panel-title" id="queue-title">Awaiting your signature</h2>
        <${Chip} tone=${items.length ? 'chip-stamp' : 'chip-ink'}>${items.length} pending<//>
      </div>

      ${simReviewer
        ? html`<p className="panel-empty">
            A seeded reviewer answered this queue on a ${run.approverSlaHours}-hour SLA, identically for every arm, so
            it is empty by design rather than because nothing was gated. Restart with
            <code>npm run api -- --approver=HUMAN</code> to review it yourself.
          </p>`
        : items.length === 0
          ? html`<p className="panel-empty">
              Nothing is waiting on a human right now. The agent gates a decision when the amount clears the approval
              threshold or when its diagnosis abstained; advance the clock and it will ask when it needs to.
            </p>`
          : null}

      ${!simReviewer && items.length > 0
        ? html`
            <div className="panel-body">
              <label className="eyebrow" htmlFor="signer">Signing as</label>
              <input
                id="signer"
                className="field field-grow"
                value=${signer}
                onInput=${(e) => setSigner(e.target.value)}
                placeholder="your name"
                aria-describedby="signer-note"
              />
              <p className="req-because" id="signer-note">
                Recorded against every approval in the audit trail. The API refuses a grant without it: an approver
                field that says “system” because the caller omitted a name reads like an accountable decision and is
                not one.
              </p>
            </div>
          `
        : null}

      ${items.map(
        (item) => html`
          <article className="req" key=${item.eventId}>
            <div className="req-top">
              <div>
                <div className="req-who">${item.customerName ?? 'unknown customer'}</div>
                <span className="req-id">${item.eventId} · ${(item.lossType ?? '').replace(/_/g, ' ').toLowerCase()}</span>
              </div>
              <div className="req-amount">${rupees(item.amountPaise)}</div>
            </div>

            <p className="req-wants">
              It wants to <strong>${humanise(item.proposedAction)}</strong>, which
              ${' '}${invasivenessWords(item.proposedInvasiveness)}. Expected value
              ${' '}<span className="mono">${rupees(item.evPaise)}</span>.
            </p>
            <p className="req-because">
              Gated because ${item.reasons.length ? item.reasons.join('; ') : 'a guardrail required a human'}.
              Requested ${ist(item.requestedAt)}.
            </p>

            ${granted[item.eventId]
              ? html`
                  <div className="regate">
                    <span className="regate-head">Returned to you rather than spent on something else</span>
                    You signed for ${humanise(granted[item.eventId].action)} (${invasivenessWords(granted[item.eventId].invasiveness)}).
                    At the next cycle the agent's best action was ${humanise(item.proposedAction)}, which
                    ${' '}${invasivenessWords(item.proposedInvasiveness)} — outside what your signature covered, so the gate
                    refused to reuse it and asked again. Consent to a message does not become consent to a charge.
                  </div>
                `
              : null}

            <div className="req-actions">
              <button
                className="btn"
                disabled=${busy || running || !signer.trim()}
                onClick=${() => onResolve(item, true)}
              >
                Approve
              </button>
              <button
                className="btn btn-quiet"
                disabled=${busy || running || !signer.trim()}
                onClick=${() => onResolve(item, false)}
              >
                Decline
              </button>
            </div>
          </article>
        `
      )}

      <${Clock}
        run=${run}
        busy=${busy}
        onAdvance=${onAdvance}
        lastStep=${lastStep}
        running=${running}
        onRun=${onRun}
        onStop=${onStop}
        tape=${tape}
        states=${states}
      />
    </section>
  `;
}

/**
 * The clock, and the sentence that keeps the next click from looking like a bug.
 *
 * The alternation is arithmetic — a twelve-hour step against a twelve-hour window cannot do anything
 * else — so the label is computed from the run clock rather than hardcoded, and it is stated BEFORE
 * the operator acts. Discovering it afterwards, from a message that did not send, is the difference
 * between a compliance feature and a broken button.
 */
/**
 * WHERE THE BATCH STANDS, RIGHT NOW.
 *
 * The counts are the server's own — `/api/cases` returns `states` counted over every case in the run,
 * not over the filtered page — so this component tallies nothing. That is deliberate twice over: a
 * browser-side tally would drift from the eval the moment a filter was applied, and it would put a
 * derived metric on the one screen a judge is most likely to believe.
 *
 * The order is fixed rather than taken from the object, so the chips do not reshuffle between cycles
 * while someone is watching them change. Any state not in the list is appended rather than dropped: a
 * new lifecycle state must show up as an unfamiliar chip, not vanish into a total that no longer adds up.
 */
const STATE_ORDER = ['OPEN', 'SCHEDULED', 'AWAITING_APPROVAL', 'RECOVERED', 'RECOVERED_SELF', 'STOPPED', 'ESCALATED'];

function Standings({ states }) {
  if (!states) return null;
  const known = STATE_ORDER.filter((s) => states[s] !== undefined);
  const unknown = Object.keys(states)
    .filter((s) => !STATE_ORDER.includes(s))
    .sort();
  const order = [...known, ...unknown];
  if (order.length === 0) return null;
  return html`
    <div className="standings">
      ${order.map(
        (s) => html`
          <${Chip} key=${s} tone=${STATE_TONE[s] ?? 'chip-ink'} title=${s}>
            ${s.replace(/_/g, ' ').toLowerCase()}${' '}${states[s]}
          <//>
        `
      )}
    </div>
  `;
}

/**
 * THE TAPE — one line per cycle, newest at the top.
 *
 * Newest-first rather than chronological, because during a run the operator's eye should stay at a fixed
 * point on the screen instead of chasing a list that grows downward off the panel.
 *
 * Every row carries whether its cycle fell inside quiet hours, which is the whole reason this strip
 * earns its space: roughly half the cycles do no contacting work, and on a tape that says so, that reads
 * as the guardrail holding. Without the label the same run reads as an agent that keeps doing nothing.
 */
function Tape({ tape }) {
  if (!tape || tape.length === 0) return null;
  return html`
    <div className="tape">
      <${Eyebrow}>Cycle tape<//>
      ${tape.map((t) => {
        const quiet = isQuiet(t.clockAt);
        const line = scalarLine(t.summary);
        return html`
          <div className="tape-row" key=${t.cycle}>
            <span className="tape-cycle">${String(t.cycle).padStart(2, '0')}</span>
            <span className="tape-when">${ist(t.clockAt)}</span>
            <${Chip} tone=${quiet ? 'chip-stamp' : 'chip-credit'}>${quiet ? 'quiet' : 'open'}<//>
            <span className="tape-figs">${line || 'no contacting work was legal on this cycle'}</span>
          </div>
        `;
      })}
    </div>
  `;
}

function Clock({
  run,
  busy,
  onAdvance,
  lastStep,
  running = false,
  onRun = null,
  onStop = null,
  tape = [],
  states = null,
}) {
  const nextAt = new Date(new Date(run.clockAt).getTime() + run.horizon.stepHours * 3600 * 1000).toISOString();
  const nextQuiet = isQuiet(nextAt);
  const finished = run.cyclesRun >= run.horizon.cycles;
  const steppable = run.mode === 'CONSOLE';
  const line = scalarLine(lastStep?.summary);
  const done = Math.min(run.cyclesRun, run.horizon.cycles);
  const frozen = states?.AWAITING_APPROVAL ?? 0;

  return html`
    <div className="clock">
      <p className="clock-now">
        cycle ${run.cyclesRun} of ${run.horizon.cycles} · now ${ist(run.clockAt)} · next cycle ${ist(nextAt)}
        ${' '}<${Chip} tone=${nextQuiet ? 'chip-stamp' : 'chip-credit'}>${nextQuiet ? 'quiet hours' : 'contact legal'}<//>
      </p>

      <div
        className="progress"
        role="progressbar"
        aria-valuenow=${done}
        aria-valuemin=${0}
        aria-valuemax=${run.horizon.cycles}
        aria-label="cycles run"
      >
        <div className="progress-fill" style=${{ width: `${(done / run.horizon.cycles) * 100}%` }} />
      </div>

      <${Standings} states=${states} />

      <div className="runbar">
        <button
          className="btn"
          disabled=${busy || running || finished || !steppable}
          onClick=${onAdvance}
        >
          ${finished ? 'Horizon complete' : `Advance ${run.horizon.stepHours} hours`}
        </button>
        ${running
          ? html`<button className="btn btn-quiet" onClick=${onStop}>Stop</button>`
          : html`
              <button
                className="btn btn-quiet"
                disabled=${busy || finished || !steppable || !onRun}
                onClick=${onRun}
              >
                Run to horizon
              </button>
            `}
      </div>

      <p className="clock-why">
        ${run.mode !== 'CONSOLE'
          ? html`This run's horizon is finished and its arm comparison is computed. Advancing would describe a world
              that no longer matches the table above, so the server refuses.`
          : running
            ? html`Running. Each cycle is a real pass over every open case — diagnose, price every permitted action,
                take the best one if it clears the bar, and persist why. <strong>No money appears while this
                runs</strong>, because a run you can stop halfway is a truncated run, and truncation flatters us.`
            : nextQuiet
              ? html`The next cycle lands inside quiet hours (21:00–09:00 IST), so <strong>no message will go out on
                    it</strong>. Quiet hours are twelve hours wide and the clock steps twelve hours, so cycles alternate:
                    half of them can do no customer contact at all. If you approve a message now, the agent re-decides at
                    02:30, and if its best remaining action moves money instead, it will come back here rather than reuse
                    your signature.`
              : html`The next cycle lands in legal contacting hours, so an approved message goes out on it. The one after
                  that will not — quiet hours are twelve hours wide and the clock steps twelve hours, so they alternate.`}
      </p>

      ${finished && steppable && frozen > 0
        ? html`
            <p className="clock-why">
              The horizon is finished and <strong>${frozen} ${frozen === 1 ? 'case is' : 'cases are'} still waiting for a
              signature</strong>. Nothing was spent on them and nothing came back from them: the gate held for the entire
              run because nobody signed. That is the real cost of compliant escalation, and it is why the queue sits at the
              top of this screen rather than the bottom.
            </p>
          `
        : null}

      ${lastStep
        ? html`
            <div className="clock-said">
              ${lastStep.ran
                ? `Ran cycle ${lastStep.cycle}. The clock is now ${ist(lastStep.clockAt)}.`
                : `Refused: ${lastStep.because}`}
              ${line ? html`<span className="clock-said-figures">${line}</span>` : null}
            </div>
          `
        : null}

      <${Tape} tape=${tape} />
    </div>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE CASE REGISTER
 * ───────────────────────────────────────────────────────────────────────────── */

function Register({ cases, filters, setFilters, openId, onOpen }) {
  const q = filters.q.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!cases) return [];
    if (!q) return cases.cases;
    return cases.cases.filter(
      (c) =>
        c.eventId.toLowerCase().includes(q) ||
        (c.customerName ?? '').toLowerCase().includes(q) ||
        (c.customerId ?? '').toLowerCase().includes(q)
    );
  }, [cases, q]);

  return html`
    <section className="panel" aria-labelledby="register-title">
      <div className="panel-head">
        <h2 className="panel-title" id="register-title">Case register</h2>
        <${Chip}>${rows.length} of ${cases?.total ?? 0} · largest exposure first<//>
      </div>

      <div className="filters">
        <input
          className="field field-grow"
          value=${filters.q}
          onInput=${(e) => setFilters({ ...filters, q: e.target.value })}
          placeholder="find a case or customer"
          aria-label="Find a case or customer"
        />
        <select
          className="field"
          value=${filters.state}
          onChange=${(e) => setFilters({ ...filters, state: e.target.value })}
          aria-label="Filter by state"
        >
          <option value="">every state</option>
          ${Object.entries(cases?.states ?? {}).map(
            ([k, n]) => html`<option key=${k} value=${k}>${k.toLowerCase().replace(/_/g, ' ')} (${n})</option>`
          )}
        </select>
        <select
          className="field"
          value=${filters.lossType}
          onChange=${(e) => setFilters({ ...filters, lossType: e.target.value })}
          aria-label="Filter by loss type"
        >
          <option value="">every loss type</option>
          ${Object.entries(cases?.lossTypes ?? {}).map(
            ([k, n]) => html`<option key=${k} value=${k}>${k.toLowerCase().replace(/_/g, ' ')} (${n})</option>`
          )}
        </select>
      </div>

      <div className="rows">
        ${rows.length === 0
          ? html`<p className="panel-empty">No case matches that filter.</p>`
          : rows.map(
              (c) => html`
                <button
                  key=${c.eventId}
                  className=${`row${c.eventId === openId ? ' row-open' : ''}`}
                  onClick=${() => onOpen(c.eventId)}
                  aria-label=${`Open ${c.eventId}, ${c.customerName}, ${rupees(c.amountPaise)}`}
                >
                  <span className="row-who">${c.customerName ?? c.customerId}</span>
                  <span className="row-amount">${rupees(c.amountPaise)}</span>
                  <span className="row-meta">
                    ${c.eventId} · ${(c.rootCause ?? 'undiagnosed').replace(/_/g, ' ').toLowerCase()}
                    ${c.retriesUsed || c.touchesUsed ? ` · ${c.retriesUsed}r ${c.touchesUsed}t` : ''}
                  </span>
                  <span className="row-state">
                    <${Chip} tone=${STATE_TONE[c.state] ?? 'chip-ink'}>${(c.state ?? '').replace(/_/g, ' ')}<//>
                  </span>
                </button>
              `
            )}
      </div>
    </section>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE DRAWER — the candidate ladder
 *
 * This is the screen the whole submission is built to reach. Track 03 asks for an audit trail, and an
 * audit trail is not a log of what happened: it is a record of what was considered. Every other
 * dashboard shows the action taken. This one shows all twenty-three the engine priced, in the order
 * it ranked them, each with the sentence explaining why it lost — and then the arithmetic behind the
 * one that won, in components that subtract to the total in front of the reader.
 * ───────────────────────────────────────────────────────────────────────────── */

function Ladder({ decision }) {
  const candidates = decision.candidates ?? [];
  const chosen = candidates.find((c) => c.chosen) ?? null;
  const acted = decision.outcome === 'ACT';

  return html`
    <div>
      <h3 className="sect-title">The agent priced ${candidates.length} actions and chose one</h3>
      <p className="sect-note">
        Ranked by expected value at ${ist(decision.decidedAt)}. The bar to act at all was
        ${' '}<span className="mono">${rupees(decision.barPaise)}</span>; anything below it loses to doing nothing.
      </p>
      ${candidates.map(
        (k) => html`
          <div key=${`${k.rank}-${k.signature}`} className=${`rung${k.chosen ? ' rung-chosen' : ''}`}>
            <span className="rung-rank">${String(k.rank).padStart(2, '0')}</span>
            <span className="rung-sig">${humanise(k.signature)}</span>
            <span className=${`rung-ev${k.chosen ? '' : ' rung-ev-dim'}`}>
              ${k.priced ? rupees(k.evPaise) : 'not priced'}
            </span>
            <div className="rung-tags">
              <${Chip} tone=${VERDICT_TONE[k.verdict] ?? 'chip-ink'}>${k.verdict}<//>
              ${k.priced ? html`<${Chip}>recovers ${pct(k.p)}<//>` : null}
              ${k.support && k.support !== 'SUPPORTED' ? html`<${Chip} tone="chip-debit">${k.support}<//>` : null}
              ${k.requiresApproval ? html`<${Chip} tone="chip-stamp">needs a signature<//>` : null}
              ${k.deferUntil ? html`<${Chip} tone="chip-stamp">earliest ${ist(k.deferUntil)}<//>` : null}
            </div>
            ${k.rejectedBecause || k.violations.length
              ? html`<p className="rung-why">
                  ${k.rejectedBecause ?? k.violations.map((v) => v.message).join(' · ')}
                </p>`
              : null}
            ${k.chosen
              ? html`<span className="stamp">
                  chosen · ${acted ? 'executed' : decision.outcome === 'AWAIT_APPROVAL' ? 'held for signature' : String(decision.outcome).replace(/_/g, ' ')}
                </span>`
              : null}
          </div>
        `
      )}
      ${chosen ? html`<${Arithmetic} chosen=${decision.chosen} />` : null}
    </div>
  `;
}

/**
 * EV = p × amount × margin − channel − review − expected-failure penalty − patience penalty.
 *
 * Printed as components rather than as a result, because the formula is the entire intellectual claim
 * of the project and a judge who cannot check it has to take it on faith. `checksOut` arrives from
 * the read model; the subtraction is shown beside it so the boolean is verifiable rather than
 * reassuring. Every component is an integer paise value rounded at source, so the identity holds
 * exactly and a mismatch is a defect rather than a float artefact.
 */
function Arithmetic({ chosen }) {
  if (!chosen) return null;
  const c = chosen.components ?? {};
  const costs = [
    ['channel', c.channelPaise],
    ['human review', c.humanReviewPaise],
    ['expected failure penalty', c.expectedFailurePenaltyPaise],
    ['patience penalty', c.patiencePenaltyPaise],
  ];
  const ok = chosen.checksOut?.costsSumToTotal && chosen.checksOut?.grossMinusCostsIsEv;
  return html`
    <div className="sect">
      <h3 className="sect-title">The arithmetic behind it</h3>
      <p className="sect-note">
        Expected value is recovery probability × amount × margin, minus every cost of trying. Check it by hand — the
        components are integer paise and subtract exactly.
      </p>
      <dl className="kv">
        <dt className="kv-k">probability × amount × margin</dt>
        <dd className="kv-v">${pct(c.p)} × ${rupees(c.amountPaise)} × ${c.margin ?? '—'} = ${rupees(chosen.grossPaise)}</dd>
        ${costs.map(
          ([label, value]) => html`
            <dt className="kv-k" key=${`k-${label}`}>less ${label}</dt>
            <dd className="kv-v" key=${`v-${label}`}>${rupees(value)}</dd>
          `
        )}
        <dt className="kv-k">expected value</dt>
        <dd className="kv-v">
          ${rupees(chosen.grossPaise)} − ${rupees(chosen.totalCostPaise)} = <strong>${rupees(chosen.evPaise)}</strong>
          ${' '}${ok
            ? html`<${Chip} tone="chip-credit">identity holds<//>`
            : html`<${Chip} tone="chip-debit">arithmetic disagrees — defect<//>`}
        </dd>
        <dt className="kv-k">idempotency key</dt>
        <dd className="kv-v">${chosen.idempotencyKey ?? '—'}</dd>
      </dl>
    </div>
  `;
}

function TheGate({ detail, decision }) {
  const a = detail.approval;
  if (!a && !decision?.requiresApproval) return null;
  return html`
    <div className="sect">
      <h3 className="sect-title">The gate</h3>
      <p className="sect-note">
        A signature is an envelope, not a password: it names the checks it clears and caps how invasive the action may
        be. Both must hold at the moment the agent acts, or it asks again.
      </p>
      <dl className="kv">
        <dt className="kv-k">state</dt>
        <dd className="kv-v">${a?.state ?? 'not gated'}</dd>
        <dt className="kv-k">what was asked for</dt>
        <dd className="kv-v">${a?.proposedAction ?? '—'} · ${invasivenessWords(a?.proposedInvasiveness)}</dd>
        <dt className="kv-k">invasiveness signed for</dt>
        <dd className="kv-v">
          ${a?.approvedInvasiveness === null || a?.approvedInvasiveness === undefined
            ? '—'
            : `${a.approvedInvasiveness} — ${invasivenessWords(a.approvedInvasiveness)}`}
        </dd>
        <dt className="kv-k">checks named</dt>
        <dd className="kv-v">${(a?.checkIds ?? []).join(', ') || '—'}</dd>
        <dt className="kv-k">checks the signature cleared</dt>
        <dd className="kv-v">${(a?.clearedCheckIds ?? []).join(', ') || 'none'}</dd>
        <dt className="kv-k">decided by</dt>
        <dd className="kv-v">${a?.by ?? '—'} ${a?.decidedAt ? `· ${ist(a.decidedAt)}` : ''}</dd>
        ${decision
          ? html`
              <dt className="kv-k">cleared on this decision</dt>
              <dd className="kv-v">${(decision.clearedByApproval ?? []).join(', ') || 'nothing'} ${decision.approvedBy ? `· ${decision.approvedBy}` : ''}</dd>
            `
          : null}
        ${a?.note ? html`<dt className="kv-k">note</dt><dd className="kv-v">${a.note}</dd>` : null}
      </dl>
    </div>
  `;
}

function Attempts({ actions }) {
  if (!actions.length) return null;
  return html`
    <div className="sect">
      <h3 className="sect-title">Attempts and receipts</h3>
      <p className="sect-note">A money figure with no receipt is not money. Each attempt below carries the one it settled against.</p>
      ${actions.map(
        (a) => html`
          <div className="rung" key=${a.idempotencyKey}>
            <span className="rung-rank">${a.state === 'SETTLED' ? '✓' : '·'}</span>
            <span className="rung-sig">${humanise(`${a.kind}${a.channel ? `:${a.channel}` : ''}`)}</span>
            <span className="rung-ev">${rupees(a.receipt?.amountCollectedPaise ?? 0)}</span>
            <div className="rung-tags">
              <${Chip} tone=${a.receipt?.state === 'CAPTURED' ? 'chip-credit' : 'chip-debit'}>
                receipt ${a.receipt?.state ?? 'none'}
              <//>
              <${Chip}>${a.receipt?.mode ?? '—'}<//>
              <${Chip}>${ist(a.startedAt)}<//>
              ${a.receipt?.providerRef ? html`<${Chip}>${a.receipt.providerRef}<//>` : null}
            </div>
          </div>
        `
      )}
    </div>
  `;
}

function Trail({ audit }) {
  if (!audit.length) return null;
  return html`
    <div className="sect">
      <h3 className="sect-title">Audit trail</h3>
      <p className="sect-note">${audit.length} entries, newest first. Written at decision time by the orchestrator, not reconstructed here.</p>
      <ul className="trail">
        ${[...audit].reverse().map(
          (e) => html`
            <li className="trail-item" key=${e.seq}>
              <div className="trail-top">
                <span className="trail-type">${e.type.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="trail-at">#${e.seq} · ${ist(e.at)}</span>
              </div>
              ${e.detail
                ? html`<p className="trail-detail">
                    ${Object.entries(e.detail)
                      .filter(([, v]) => ['number', 'string', 'boolean'].includes(typeof v))
                      .map(([k, v]) => `${k}=${v}`)
                      .join(' · ')}
                  </p>`
                : null}
            </li>
          `
        )}
      </ul>
    </div>
  `;
}

function Drawer({ detail, onClose }) {
  const [pick, setPick] = useState(0);
  const closeRef = useRef(null);

  useEffect(() => setPick(Math.max(0, (detail?.decisions?.length ?? 1) - 1)), [detail?.eventId, detail?.decisions?.length]);
  useEffect(() => {
    closeRef.current?.focus();
  }, [detail?.eventId]);

  if (!detail) return null;
  const decisions = detail.decisions ?? [];
  const decision = decisions[Math.min(pick, decisions.length - 1)] ?? null;

  return html`
    <div>
      <button className="scrim" onClick=${onClose} aria-label="Close case"></button>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label=${`Case ${detail.eventId}`}>
        <div className="drawer-head">
          <div className="drawer-top">
            <div>
              <h2 className="drawer-who">${detail.customerName ?? detail.customerId}</h2>
              <span className="drawer-id">
                ${detail.eventId} · ${detail.customerId} · ${detail.segment} · ${(detail.lossType ?? '').replace(/_/g, ' ').toLowerCase()}
              </span>
            </div>
            <div>
              <div className="drawer-amount">${rupees(detail.amountPaise)}</div>
              <button className="close" onClick=${onClose} ref=${closeRef}>Close</button>
            </div>
          </div>
          <div className="drawer-chips">
            <${Chip} tone=${STATE_TONE[detail.state] ?? 'chip-ink'}>${(detail.state ?? '').replace(/_/g, ' ')}<//>
            ${detail.rootCause
              ? html`<${Chip} tone=${detail.diagnosisAbstained ? 'chip-debit' : 'chip-ink'}>
                  ${detail.diagnosisAbstained ? 'abstained · ' : ''}${detail.rootCause.replace(/_/g, ' ').toLowerCase()}
                <//>`
              : null}
            ${detail.rail ? html`<${Chip}>${detail.rail.toLowerCase()}<//>` : null}
            ${detail.recoveredPaise ? html`<${Chip} tone="chip-credit">recovered ${rupees(detail.recoveredPaise)}<//>` : null}
            ${detail.selfRecoveredPaise
              ? html`<${Chip}>paid unprompted ${rupees(detail.selfRecoveredPaise)}<//>`
              : null}
            ${detail.stopCode ? html`<${Chip} tone="chip-debit">${detail.stopCode.replace(/_/g, ' ').toLowerCase()}<//>` : null}
          </div>
        </div>

        <div className="drawer-scroll">
          ${detail.errorReason
            ? html`<div className="sect sect-first">
                <h3 className="sect-title">What our systems recorded</h3>
                <p className="sect-note">
                  The gateway's own words — the text the diagnosis engine matched on, so a reader who disagrees with the
                  root cause can say why.
                </p>
                <dl className="kv">
                  <dt className="kv-k">reason</dt>
                  <dd className="kv-v">${detail.errorReason}</dd>
                  <dt className="kv-k">description</dt>
                  <dd className="kv-v">${detail.event?.failure?.errorDescription ?? '—'}</dd>
                  <dt className="kv-k">code · step · source</dt>
                  <dd className="kv-v">
                    ${detail.event?.failure?.errorCode ?? '—'} · ${detail.event?.failure?.errorStep ?? '—'} ·
                    ${detail.event?.failure?.errorSource ?? '—'}
                  </dd>
                </dl>
              </div>`
            : null}

          ${decisions.length > 1
            ? html`
                <div className="sect">
                  <${Eyebrow}>${decisions.length} decisions on this case<//>
                  <div className="picker">
                    ${decisions.map(
                      (d, i) => html`
                        <button
                          key=${d.decidedAt}
                          className=${`pick${i === pick ? ' pick-on' : ''}`}
                          onClick=${() => setPick(i)}
                        >
                          ${ist(d.decidedAt)} · ${String(d.outcome).replace(/_/g, ' ').toLowerCase()}
                        </button>
                      `
                    )}
                  </div>
                </div>
              `
            : null}

          ${decision
            ? html`
                <div className=${decisions.length > 1 || detail.errorReason ? 'sect' : 'sect sect-first'}>
                  <${Ladder} decision=${decision} />
                </div>
                ${decision.explain?.length
                  ? html`
                      <div className="sect">
                        <h3 className="sect-title">In the agent's words</h3>
                        <p className="sect-note">Written at decision time and passed through untouched, so this screen cannot tell a different story from the trail.</p>
                        <ol className="steps">
                          ${decision.explain.map((line, i) => html`<li className="step" key=${i}><span>${line}</span></li>`)}
                        </ol>
                      </div>
                    `
                  : null}
                <${TheGate} detail=${detail} decision=${decision} />
              `
            : html`<p className="panel-empty">No decision was recorded for this case.</p>`}

          <${Attempts} actions=${detail.actions ?? []} />
          <${Trail} audit=${detail.audit ?? []} />
        </div>
      </aside>
    </div>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * THE CAVEATS
 *
 * Served by the API, printed verbatim, and placed on the page rather than in a tooltip. A judge who
 * reads only this dashboard should finish with the same understanding as one who reads the
 * engineering log — which means the sentences that limit the claim have to be as legible as the claim.
 * ───────────────────────────────────────────────────────────────────────────── */

function Caveats({ run }) {
  return html`
    <section className="caveats">
      <${Eyebrow}>What this screen does not claim<//>
      <ul className="caveat-list">
        ${run.caveats.map((c, i) => html`<li className="caveat" key=${i}>${c}</li>`)}
      </ul>
    </section>
  `;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * APP
 * ───────────────────────────────────────────────────────────────────────────── */

function App() {
  const [run, setRun] = useState(null);
  const [cases, setCases] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [detail, setDetail] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [filters, setFilters] = useState({ state: '', lossType: '', q: '' });
  const [signer, setSigner] = useState('mohit');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [lastStep, setLastStep] = useState(null);
  const [running, setRunning] = useState(false);
  const [tape, setTape] = useState([]);
  /**
   * A ref rather than state, because the run loop reads it between awaits. A state flag would be captured
   * in the loop's closure at the moment the run started and would still read `false` after Stop was clicked.
   */
  const stopRef = useRef(false);
  /**
   * Which cases this operator has personally signed for, and at what invasiveness. Kept because the
   * server has no reason to remember it: once a grant is consumed or refused the case record holds
   * only its current request. Without this the most instructive moment in the console — a case coming
   * back because the agent's new best action outgrew the signature — is indistinguishable from a case
   * that was simply gated twice.
   */
  const [granted, setGranted] = useState({});

  const loadDetail = useCallback(async (eventId) => {
    if (!eventId) return setDetail(null);
    const { ok, body } = await call(`/api/cases/${encodeURIComponent(eventId)}`);
    if (!ok) return setErr(body.message ?? 'Could not load that case');
    setDetail(body);
  }, []);

  const reload = useCallback(
    async (eventId = openId) => {
      try {
        const params = new URLSearchParams();
        if (filters.state) params.set('state', filters.state);
        if (filters.lossType) params.set('lossType', filters.lossType);
        const [r, c, a] = await Promise.all([
          call('/api/run'),
          call(`/api/cases?${params}`),
          call('/api/approvals'),
        ]);
        if (!r.ok) throw new Error(r.body.message ?? 'GET /api/run failed');
        setRun(r.body);
        setCases(c.body);
        setApprovals(a.body);
        setErr(null);
        if (eventId) await loadDetail(eventId);
        /**
         * Returned as well as set, because the run loop needs the tally AT THIS CYCLE to put on the tape.
         * Reading it back out of state would give the loop whatever React had committed by then, which is
         * a different cycle's numbers on a row labelled with this one.
         */
        return { run: r.body, cases: c.body, approvals: a.body };
      } catch (e) {
        setErr(e.message);
        return null;
      }
    },
    [filters.state, filters.lossType, openId, loadDetail]
  );

  useEffect(() => {
    reload();
  }, [filters.state, filters.lossType]);

  useEffect(() => {
    loadDetail(openId);
  }, [openId, loadDetail]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') setOpenId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onResolve = useCallback(
    async (item, grant) => {
      setBusy(true);
      try {
        const { ok, body } = await call(`/api/approvals/${encodeURIComponent(item.eventId)}`, {
          method: 'POST',
          body: JSON.stringify({ grant, by: signer.trim(), note: grant ? null : 'declined in the console' }),
        });
        if (!ok) {
          setErr(body.because ?? body.message ?? 'The server refused that.');
        } else {
          setErr(null);
          setGranted((prev) =>
            grant
              ? { ...prev, [item.eventId]: { invasiveness: item.proposedInvasiveness, action: item.proposedAction } }
              : prev
          );
        }
        await reload();
      } catch (e) {
        setErr(e.message);
      } finally {
        setBusy(false);
      }
    },
    [signer, reload]
  );

  /**
   * ONE CYCLE, WHICHEVER BUTTON ASKED FOR IT.
   *
   * Both the single step and the run-to-horizon loop go through here so there is exactly one place that
   * knows what a cycle does to this page. The tape row is appended AFTER the reload, from the reload's own
   * return value, so the counts on a row are the counts as of the cycle that row names.
   */
  const stepOnce = useCallback(async () => {
    const { ok, body } = await call('/api/advance', { method: 'POST' });
    setLastStep(body);
    if (!ok || body.ran === false) return body;
    const after = await reload();
    setTape((prev) => [
      { cycle: body.cycle, clockAt: body.clockAt, summary: body.summary, states: after?.cases?.states ?? null },
      ...prev,
    ]);
    return body;
  }, [reload]);

  const onAdvance = useCallback(async () => {
    setBusy(true);
    try {
      await stepOnce();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }, [stepOnce]);

  /**
   * RUN THE WHOLE HORIZON, VISIBLY.
   *
   * The reason this exists: the batch has already been run by the time the browser loads, so without it
   * the console's first impression is a finished report rather than an agent working — and the thing being
   * judged is the agent. The loop itself lives in `runToHorizon` where it can be tested.
   *
   * Note what does NOT stop it: cases piling up in the approval queue. If nobody signs, the gate holds and
   * those cases finish the horizon frozen. That is the honest outcome, and the clock says so afterwards.
   */
  const onRunToHorizon = useCallback(async () => {
    stopRef.current = false;
    setRunning(true);
    setErr(null);
    try {
      const { stopped } = await runToHorizon({ step: stepOnce, shouldStop: () => stopRef.current });
      if (stopped === 'cap') {
        setErr(
          'The run stopped at its safety cap without the server reporting the end of the horizon. That is a ' +
            'defect rather than a finished run — the figures on screen are mid-flight.'
        );
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setRunning(false);
    }
  }, [stepOnce]);

  const onStop = useCallback(() => {
    stopRef.current = true;
  }, []);

  if (err && !run) {
    return html`
      <main className="shell">
        <p className="err">${err}</p>
        <p className="thesis-note">
          The server is reachable at <code>/api/health</code>. If that responds and this does not, the failure is in
          this page rather than the run.
        </p>
      </main>
    `;
  }
  if (!run) {
    return html`<div className="boot"><p className="boot-mark">Rebound</p><p className="boot-line">Running the batch…</p></div>`;
  }

  return html`
    <${Masthead} run=${run} />
    <main className="shell">
      <${Thesis} run=${run} />
      <${ArmLedger} run=${run} />
      <div className="split">
        <${Queue}
          run=${run}
          approvals=${approvals}
          granted=${granted}
          busy=${busy}
          onResolve=${onResolve}
          onAdvance=${onAdvance}
          signer=${signer}
          setSigner=${setSigner}
          lastStep=${lastStep}
          running=${running}
          onRun=${onRunToHorizon}
          onStop=${onStop}
          tape=${tape}
          states=${cases?.states ?? null}
        />
        <${Register} cases=${cases} filters=${filters} setFilters=${setFilters} openId=${openId} onOpen=${setOpenId} />
      </div>
      ${err ? html`<p className="err">${err}</p>` : null}
      <${Caveats} run=${run} />
    </main>
    ${openId ? html`<${Drawer} detail=${detail} onClose=${() => setOpenId(null)} />` : null}
  `;
}

ReactDOM.createRoot(document.getElementById('root')).render(createElement(App));
