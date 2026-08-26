#!/usr/bin/env node
/**
 * npm run api
 *
 * Runs one real batch through the eval harness, then serves it — the JSON API and the dashboard on the
 * same port, from a store built by the same code path `npm run eval` uses.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE IS IN `src/demo/cli` AND NOT IN `src/api/cli`
 * ---------------------------------------------------------------------------------------------
 * `test/boundary.test.js` forbids `src/api/**` from importing `src/sim/**`, because the simulator holds
 * the answer key and the API's whole claim is that the agent never saw it. Building a world requires
 * the simulator. A bootstrap placed under `src/api/cli/` would have imported `../../demo/session.js`
 * and passed the scan — the check reads direct imports, not the transitive graph — which is exactly
 * the kind of technically-green circumvention that makes a check stop meaning anything.
 *
 * So the composition root lives on the side of the boundary that is allowed to know both halves. The
 * server is handed a finished session and cannot reach back. `package.json` used to point `npm run api`
 * at `src/api/server.js`; that file is now a pure module with no side effects, and this is its entry.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS COMMAND DOES NOT CLAIM
 * ---------------------------------------------------------------------------------------------
 * `dataSource: 'SIMULATION'` on `/api/health`, and the caveat block on `/api/run`, both say it: every
 * rupee served here is simulated, and this is ONE world. The claim that the Razorpay integration works
 * is made by `npm run doctor` against the real test-mode API and by nothing else. Two claims, two
 * commands, never one screen.
 *
 * Flags (all --name=value; the spaced form is a hard error — see eval/cli/flags.js):
 *   --port=8787        HTTP port. `PORT` in the environment wins if this flag is absent.
 *   --seed=1           seeds generation, the model, the gateway draws and the reviewer
 *   --count=80         cases in the batch
 *   --split=TRAIN      TRAIN by default on purpose; see src/demo/session.js
 *   --cycles=21        defaults to HORIZON.cycles
 *   --step-hours=12    defaults to HORIZON.stepHours
 *   --approver=SIM     SIM (seeded reviewer, eval-comparable) or HUMAN (queue waits for you)
 *   --open             print the URL only, skip the summary table
 *   --quiet            suppress progress lines while the batch runs
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createApiServer } from '../../api/server.js';
import { createSession } from '../session.js';
import { HORIZON } from '../../core/config.js';
import { readFlags, asNumber } from '../../eval/cli/flags.js';

/**
 * `fileURLToPath`, not `new URL(...).pathname`. On Windows the latter yields `/C:/MohithFiles/...`,
 * with a leading slash and percent-encoded spaces, and every subsequent `stat` fails on a path that
 * looks correct in a log line. `test/boundary.test.js` has a regression test pinning this.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', '..', '..', 'web');

/**
 * 8787 rather than 3000 or 8080.
 *
 * Both of those are occupied on any machine that has ever run a dev server, and an EADDRINUSE thirty
 * seconds into a demo is a self-inflicted wound. There is no framework convention to honour here — the
 * server is `node:http` — so the only requirement is that the number be unusual and written down.
 */
const DEFAULT_PORT = '8787';

const f = readFlags(
  process.argv.slice(2),
  {
    port: process.env.PORT ?? DEFAULT_PORT,
    seed: '1',
    count: '80',
    split: 'TRAIN',
    cycles: String(HORIZON.cycles),
    'step-hours': String(HORIZON.stepHours),
    approver: 'SIM',
    now: '2026-06-01T09:00:00.000Z',
  },
  ['open', 'quiet'],
  (raw) => {
    const split = String(raw.split).toUpperCase();
    if (split !== 'TRAIN' && split !== 'TEST') throw new Error(`--split=${raw.split} must be TRAIN or TEST`);
    const approver = String(raw.approver).toUpperCase();
    if (approver !== 'SIM' && approver !== 'HUMAN') {
      throw new Error(
        `--approver=${raw.approver} must be SIM or HUMAN. SIM runs the seeded reviewer and its money ` +
          'figures are comparable with the eval; HUMAN leaves the approval queue for you to answer and ' +
          'its money figures are not.'
      );
    }
    if (Number.isNaN(new Date(raw.now).getTime())) throw new Error(`--now=${raw.now} is not a parsable date`);
    return {
      ...raw,
      split,
      approver,
      port: asNumber(raw.port, 'port', { min: 1 }),
      count: asNumber(raw.count, 'count', { min: 1 }),
      cycles: asNumber(raw.cycles, 'cycles', { min: 1 }),
      stepHours: asNumber(raw['step-hours'], 'step-hours', { integer: false, min: 0.25 }),
    };
  }
);

const say = (line) => {
  if (!f.quiet) process.stdout.write(`  ${line}\n`);
};

const RUPEE = (paise) =>
  paise === null || paise === undefined
    ? '—'
    : `Rs ${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

say('');
if (f.approver === 'SIM') {
  say(`Rebound — measuring a batch before serving it (seed ${f.seed}, ${f.split}, n=${f.count})`);
  say('Five policy arms run the full horizon, so the money on screen can be incremental over doing');
  say('nothing rather than a gross total that flatters us. Ten to twenty seconds, depending on n.');
} else {
  say(`Rebound console — one arm, paused for you (seed ${f.seed}, ${f.split}, n=${f.count})`);
  say('No simulated reviewer: the approval queue is yours. Grant or deny, then advance the clock and');
  say('watch the agent re-decide. No money figures in this mode — a paused run is not measurable.');
}
say('');

const t0 = Date.now();
const session = await createSession({
  seed: f.seed,
  split: f.split,
  count: f.count,
  cycles: f.cycles,
  stepHours: f.stepHours,
  approver: f.approver,
  startAt: new Date(f.now),
  onProgress: (line) => say(`  · ${line}`),
});
const elapsedMs = Date.now() - t0;

const meta = session.meta();

if (!f.open) {
  say('');
  say(`built in ${(elapsedMs / 1000).toFixed(1)}s · run ${meta.runId} · mode ${meta.mode}`);
  say('');
  if (meta.rows) {
    say(`  ${'arm'.padEnd(18)}${'recovered'.padStart(14)}${'incremental'.padStart(14)}${'attempts'.padStart(10)}${'messages'.padStart(10)}${'frozen'.padStart(14)}`);
    for (const r of meta.rows) {
      say(
        `  ${String(r.arm).padEnd(18)}${RUPEE(r.recoveredPaise).padStart(14)}` +
          `${RUPEE(r.incrementalPaise).padStart(14)}${String(r.attempts ?? '—').padStart(10)}` +
          `${String(r.messages ?? '—').padStart(10)}${RUPEE(r.frozenPaise).padStart(14)}`
      );
    }
    say('');
    say(`  at risk in this batch      ${RUPEE(meta.totalExposurePaise)}`);
    say(`  would have arrived anyway  ${RUPEE(meta.counterfactualPaise)}   (B0_DO_NOTHING, subtracted above)`);
    const rebound = meta.rows.find((r) => r.arm === meta.arm) ?? null;
    const b3 = meta.rows.find((r) => r.arm === 'B3_FIXED_LADDER') ?? null;
    if (rebound && b3) {
      say(
        `  Rebound vs the fixed ladder: ${RUPEE(rebound.incrementalPaise)} vs ${RUPEE(b3.incrementalPaise)} incremental`
      );
    }
    say('');
    /**
     * The invariant block is printed BEFORE the URL, not after and not only on failure. Every figure
     * above is void if any of these is false — money that does not reconcile against the receipts, or a
     * world the arms did not share — and a reader who sees the table first and the warning last has
     * already formed an impression.
     */
    const broken = Object.entries(meta.invariants).filter(([, ok]) => ok === false);
    if (broken.length > 0) {
      say(`  !! ${broken.length} INVARIANT(S) FAILED: ${broken.map(([k]) => k).join(', ')}`);
      say('  Nothing in the table above may be quoted. This is a defect, not a bad seed.');
    } else {
      say(`  all ${Object.keys(meta.invariants).length} cross-arm invariants hold`);
    }
    say('');
  } else {
    say(`  paused at cycle ${meta.cyclesRun} of ${meta.horizon.cycles} · run clock ${meta.clockAt}`);
    say(`  at risk in this batch      ${RUPEE(meta.totalExposurePaise)}`);
    say('  no money figures in console mode, on purpose — see the caveat below');
    say('');
  }
  for (const caveat of meta.caveats) say(`  · ${caveat}`);
  say('');
}

if (!existsSync(WEB_DIR)) {
  say(`(no web/ directory at ${WEB_DIR} — serving the JSON API only)`);
}

const server = createApiServer({ session, staticDir: existsSync(WEB_DIR) ? WEB_DIR : null });

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    process.stderr.write(
      `\n  Port ${f.port} is already in use. Start on another one:\n` +
        `    node src/demo/cli/serve.js --port=${f.port + 1}${f.approver === 'HUMAN' ? ' --count=40 --approver=HUMAN' : ''}\n\n` +
        '  Written as a direct node call, not `npm run api -- --port=...`, on purpose: npm\n' +
        '  forwarding after `--` depends on your shell and has silently dropped every flag\n' +
        '  before now, which starts the server on defaults you did not ask for.\n\n'
    );
    process.exit(2);
  }
  throw err;
});

server.listen(f.port, '127.0.0.1', () => {
  process.stdout.write(`\n  Rebound console:  http://127.0.0.1:${f.port}\n`);
  process.stdout.write(`  API health:       http://127.0.0.1:${f.port}/api/health\n`);
  /**
   * Bound to 127.0.0.1 rather than 0.0.0.0. There is no authentication on the approval endpoint — a
   * POST grants a real approval in the run — and a demo server that answers on every interface is one
   * shared wifi network away from a stranger clearing your queue. Loopback is the correct default for
   * a single-operator console, and changing it should require editing this line and reading this note.
   */
  process.stdout.write('  Loopback only, no auth: POST /api/approvals grants approvals for real.\n\n');
  /**
   * WHY THE MODE IS RESTATED HERE, ON THE LAST LINE BEFORE THE PROMPT
   * -----------------------------------------------------------------
   * The banner at the top already says `mode MEASURED`, and it is true, and it is useless: by the time
   * the URL appears it has scrolled behind an arm table. A MEASURED run's Advance and Run-to-horizon
   * buttons are disabled by design — the horizon is already complete, so there is nothing to advance —
   * and the page states that correctly in the sentence under them. But a greyed button is read as a
   * broken button, and the person reading it is standing in a terminal, not in the source.
   *
   * This cost a real half-hour: `npm run api -- --approver=HUMAN` had every flag eaten by the shell,
   * npm echoed the command with no arguments, the server came up MEASURED, and the symptom presented
   * as an unclickable button that survived a restart and a reload — because each restart reproduced it.
   * Nothing was broken. Nothing said so where it would be read.
   *
   * The rule this encodes: when a flag silently changes which controls are live, the mode belongs on
   * the last line printed, next to the URL the person is about to click.
   */
  if (meta.mode === 'MEASURED') {
    process.stdout.write(
      '  MODE: MEASURED. The horizon is already run, so "Advance 12 hours" and "Run to horizon"\n' +
        '  are DISABLED on that page — by design, not a fault. For the clickable console with a\n' +
        '  live approval queue, stop this and run:  npm run console\n\n'
    );
  } else {
    process.stdout.write(
      `  MODE: CONSOLE, paused at cycle ${meta.cyclesRun} of ${meta.horizon.cycles}. The clock buttons are live.\n` +
        '  No money figures in this mode, on purpose. A run reaches its horizon once; to replay it,\n' +
        '  restart this command and reload the page (F5).\n\n'
    );
  }
});

/**
 * Ctrl-C exits cleanly rather than leaving the port held while node waits on open sockets. The store
 * is in memory, so nothing is lost — but a half-closed server that will not restart on the same port
 * is the most annoying possible failure during a rehearsal.
 */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write('\n  stopping\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
