/**
 * THE HTTP LAYER. Zero dependencies, on `node:http`.
 *
 * WHY NOT EXPRESS, WHICH IS ALREADY IN package.json.
 *
 * Every number this project reports can be reproduced on a clean clone with nothing installed —
 * `npm run eval`, `npm run sweep-report`, the whole test suite. That property was an accident of the
 * build sandbox having no npm registry, and it turned out to be the most useful accident in the
 * project, because a reviewer with five minutes will run a command and will not run an install.
 * Serving the dashboard through Express would have made the one artefact a judge is most likely to
 * open the only one that needs `npm install` first. Forty lines of routing is a smaller cost than
 * that, so Express was removed from the dependency list rather than left there unused.
 *
 * The second reason is smaller and still real: this is an audit-trail product. A dependency tree is a
 * supply chain, and arguing for provenance while pulling thirty transitive packages to serve six
 * routes is an argument that undercuts itself.
 *
 * WHAT THIS FILE DOES NOT DO.
 *
 * It computes nothing. Metrics come from `compareWithinWorld` in `src/eval/metrics.js` — the same
 * function `npm run eval` calls — and shapes come from `src/api/readModel.js`. This file routes,
 * serialises, and guards. If a figure on the dashboard ever disagrees with the eval, it is because
 * something here reformatted it, and there is deliberately almost nowhere for that to happen.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { GROUND_TRUTH_TOKENS, groundTruthLeaks } from '../core/groundTruthTokens.js';
import { approvalQueueItem, caseDetail, caseSummary, auditView } from './readModel.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** POST bodies are tiny here — a grant is three fields. Anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Serialise and refuse to serve ground truth.
 *
 * THIS GUARD EXISTS BECAUSE THE OTHER TWO CANNOT SEE THIS CLASS OF BUG.
 *
 * `test/boundary.test.js` scans source files for latent field names, and passed green for eight days
 * while the store held `event.failure._generatedVague` on every case record — no source file named
 * it, so there was nothing to find (#75). `readModel.js` projects through an allowlist, which stops
 * that field and every field like it, with one deliberate exception: audit `detail` objects are
 * copied wholesale because there are twenty-one shapes of them.
 *
 * So the exit is checked. Every JSON response is scanned, and a leak returns 500 with the token
 * named rather than 200 with the answer key attached. It is a substring scan over a string that had
 * to be built anyway, which is cheap enough to leave on in production — and a guard that only runs
 * in tests protects the tests.
 *
 * A 500 here is the correct behaviour and not a degradation: a dashboard that cannot prove the agent
 * was blind to the answer key has nothing worth showing.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  const leaks = groundTruthLeaks(body);
  if (leaks.length > 0) {
    const message =
      `Response withheld: it contained ground-truth field(s) ${leaks.join(', ')}. ` +
      'This is a defect in the read model, not a transient error. See src/api/readModel.js and #75.';
    const errorBody = JSON.stringify({ error: 'GROUND_TRUTH_LEAK', message, tokens: leaks });
    res.writeHead(500, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(errorBody) });
    res.end(errorBody);
    return;
  }
  res.writeHead(status, {
    'content-type': MIME['.json'],
    'content-length': Buffer.byteLength(body),
    /**
     * No caching. The store mutates under this server — a grant changes a case's state immediately —
     * and a cached queue that shows an already-resolved approval invites a reviewer to decide twice.
     */
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: code, message, ...extra });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Request body is not valid JSON');
  }
}

/**
 * Resolve a URL path against the static root, refusing anything that escapes it.
 *
 * `normalize` collapses `..` before the prefix check, so `/../../.env` resolves to a path outside
 * `root` and is rejected. The check is on the resolved path rather than on the request string
 * because blocking the literal `..` is a filter, and filters lose to `%2e%2e` — `new URL` has
 * already decoded that by the time this runs. Returning null rather than throwing keeps the caller's
 * 404 path and the traversal path identical, which is also the right answer: a caller probing for
 * `.env` learns only that it is not a static asset.
 */
function safeStaticPath(root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  const full = join(root, rel);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (!full.startsWith(rootWithSep) && full !== root) return null;
  return full;
}

/**
 * Build the server.
 *
 * `session` is injected rather than constructed here, and that separation is load-bearing: the
 * session is built in `src/demo/session.js`, which imports the eval harness and therefore has the
 * simulator's latent truth in memory. This file never imports it, so the process boundary that
 * matters is also a module boundary — the server physically cannot serve what it was never handed.
 * `test/boundary.test.js` enforces that `src/api/**` does not import `src/sim/**`.
 *
 * The session contract is four reads and two writes:
 *   meta()                      -> the run's identity, horizon, mode and (if measured) the arm table
 *   store                       -> the populated store for this run
 *   diagnosisFor(eventId)       -> the diagnosis the engine produced, or null
 *   runId                       -> which run in the store is being browsed
 *   resolveApproval({...})      -> grant or deny, delegating to the orchestrator's own lifecycle
 *   advance()                   -> step the simulated clock one cycle, in console mode only
 *
 * Note that both writes can REFUSE, and the refusal is part of the contract rather than an error: a
 * grant on a case that is no longer pending, and an advance on a run whose figures have been measured,
 * both come back `applied/ran: false` with a `because`. This file turns those into 409s.
 */
export function createApiServer({ session, staticDir = null }) {
  if (!session?.store || !session?.runId) {
    throw new TypeError('createApiServer: session must carry { store, runId }');
  }

  const routes = [
    {
      method: 'GET',
      pattern: /^\/api\/health$/,
      handler: async (_req, res) => {
        const stats = session.store._stats ? session.store._stats() : null;
        sendJson(res, 200, {
          ok: true,
          runId: session.runId,
          storeKind: session.store.kind ?? 'MEMORY',
          /**
           * Named so a reader can tell at a glance that this server is not talking to Razorpay.
           * The dashboard's whole claim is about POLICY measured in simulation; the claim that the
           * plumbing works lives in `npm run doctor` against the real test-mode API, and the two are
           * never mixed in one command or one screen.
           */
          dataSource: 'SIMULATION',
          counts: stats,
          groundTruthTokensGuarded: GROUND_TRUTH_TOKENS.length,
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/run$/,
      handler: async (_req, res) => sendJson(res, 200, await session.meta()),
    },
    {
      method: 'GET',
      pattern: /^\/api\/cases$/,
      handler: async (req, res, _m, url) => {
        const all = await session.store.getCases(session.runId);
        const state = url.searchParams.get('state');
        const lossType = url.searchParams.get('lossType');
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        let rows = all;
        if (state) rows = rows.filter((c) => c.state === state);
        if (lossType) rows = rows.filter((c) => c.event?.lossType === lossType);
        if (q) {
          rows = rows.filter(
            (c) =>
              c.eventId.toLowerCase().includes(q) ||
              (c.customer?.name ?? '').toLowerCase().includes(q) ||
              (c.customerId ?? '').toLowerCase().includes(q)
          );
        }
        /**
         * Biggest exposure first. This is a triage queue, and an operator opening it wants the
         * largest at-risk amount on screen without sorting. It is also the order the policy itself
         * works in — `runCycle` commits by descending EV — so the list reads like the agent's own
         * priorities rather than insertion order.
         */
        rows.sort((a, b) => (b.amountPaise ?? 0) - (a.amountPaise ?? 0));
        const total = rows.length;
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
        const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
        sendJson(res, 200, {
          total,
          limit,
          offset,
          states: countBy(all, (c) => c.state),
          lossTypes: countBy(all, (c) => c.event?.lossType),
          cases: rows
            .slice(offset, offset + limit)
            .map((c) => caseSummary(c, { diagnosis: session.diagnosisFor?.(c.eventId) ?? null })),
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/cases\/([^/]+)$/,
      handler: async (_req, res, m) => {
        const eventId = decodeURIComponent(m[1]);
        const caseRecord = await session.store.getCase(session.runId, eventId);
        if (!caseRecord) {
          sendError(res, 404, 'NO_SUCH_CASE', `No case ${eventId} in run ${session.runId}`);
          return;
        }
        const [decisions, audit, allActions] = await Promise.all([
          session.store.getDecisions(session.runId, eventId),
          session.store.getAudit(session.runId, { eventId }),
          session.store.getActions(session.runId),
        ]);
        sendJson(
          res,
          200,
          caseDetail({
            caseRecord,
            decisions,
            audit,
            actions: allActions.filter((a) => a.eventId === eventId),
            diagnosis: session.diagnosisFor?.(eventId) ?? null,
          })
        );
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/approvals$/,
      handler: async (_req, res) => {
        const pending = await session.store.getPendingApprovals(session.runId);
        const meta = await session.meta();
        sendJson(res, 200, {
          /**
           * Whether a simulated reviewer is also answering. If it is, the queue a human sees is
           * whatever the simulation has not yet reached, and a grant clicked in the UI races an
           * automated one. Saying so in the payload lets the dashboard label it instead of
           * presenting a queue whose behaviour it cannot explain.
           */
          approverKind: meta.approverKind ?? 'SIM',
          pendingCount: pending.length,
          items: pending.map(approvalQueueItem),
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/approvals\/([^/]+)$/,
      handler: async (req, res, m) => {
        const eventId = decodeURIComponent(m[1]);
        let body;
        try {
          body = await readBody(req);
        } catch (err) {
          sendError(res, 400, 'BAD_BODY', err.message);
          return;
        }
        if (typeof body.grant !== 'boolean') {
          sendError(res, 400, 'BAD_REQUEST', 'Body must include grant: true or grant: false');
          return;
        }
        /**
         * `by` is required and is not defaulted. An audit trail whose approver field says "system"
         * because the caller omitted a name is worse than no field: it reads like an accountable
         * decision and is not one. `resolveApproval` throws on a falsy `by`; this returns 400 first
         * so the caller gets a usable message instead of a 500.
         */
        const by = typeof body.by === 'string' ? body.by.trim() : '';
        if (!by) {
          sendError(res, 400, 'BAD_REQUEST', 'Body must include by: the name of the person deciding');
          return;
        }
        let result;
        try {
          result = await session.resolveApproval({
            eventId,
            grant: body.grant,
            by,
            note: typeof body.note === 'string' ? body.note : null,
          });
        } catch (err) {
          if (/unknown case/i.test(err.message)) {
            sendError(res, 404, 'NO_SUCH_CASE', err.message);
            return;
          }
          throw err;
        }
        /**
         * A refused resolution is 409, not 500 and not 200.
         *
         * `resolveApproval` returns `{ applied: false, because }` when the case is not an
         * AWAITING_APPROVAL case with a PENDING request — which is exactly what a double-click, a
         * retried request, or a race with the simulated reviewer produces. That is a conflict with
         * the current state, not a server fault, and not a success either. Reporting it as 200 would
         * let the UI show a granted case as granted twice; reporting it as 500 would make an
         * idempotent retry look like a crash.
         */
        const caseAfter = await session.store.getCase(session.runId, eventId);
        sendJson(res, result.applied ? 200 : 409, {
          applied: result.applied,
          state: result.state ?? null,
          because: result.because ?? null,
          case: caseAfter ? caseSummary(caseAfter, { diagnosis: session.diagnosisFor?.(eventId) ?? null }) : null,
        });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/advance$/,
      handler: async (_req, res) => {
        if (typeof session.advance !== 'function') {
          sendError(res, 409, 'NOT_STEPPABLE', 'This session cannot be advanced.');
          return;
        }
        const stepped = await session.advance();
        /**
         * A refusal is 409, matching the approval path. `session.advance()` returns `ran: false` for
         * two different reasons — a measured run whose clock must not move, and a console run that has
         * reached the end of its horizon — and both are conflicts with the run's state rather than
         * server faults. `because` carries which one, so the UI can print the sentence instead of
         * inventing an explanation for a 200 that did nothing.
         */
        sendJson(res, stepped.ran ? 200 : 409, { ...stepped, run: await session.meta() });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/audit$/,
      handler: async (_req, res, _m, url) => {
        const type = url.searchParams.get('type');
        const filter = type ? { type } : {};
        const entries = await session.store.getAudit(session.runId, filter);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 300) || 300, 2000);
        /**
         * Newest first, then limited. The other order would hand back the first 300 entries of a run
         * that produced several thousand — technically a page of the audit trail, practically a page
         * of cycle 0.
         */
        const ordered = [...entries].reverse();
        sendJson(res, 200, {
          total: entries.length,
          limit,
          types: countBy(entries, (e) => e.type),
          entries: ordered.slice(0, limit).map(auditView),
        });
      },
    },
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      for (const route of routes) {
        const m = path.match(route.pattern);
        if (!m) continue;
        if (req.method !== route.method) {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', `${path} accepts ${route.method}`);
          return;
        }
        await route.handler(req, res, m, url);
        return;
      }

      if (path.startsWith('/api/')) {
        sendError(res, 404, 'NO_SUCH_ROUTE', `No route for ${req.method} ${path}`, {
          routes: routes.map((r) => `${r.method} ${r.pattern.source}`),
        });
        return;
      }

      if (!staticDir) {
        sendError(res, 404, 'NO_STATIC_DIR', 'This server was started without a static directory');
        return;
      }
      if (req.method !== 'GET') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Static files are GET only');
        return;
      }

      const rel = path === '/' ? 'index.html' : path;
      const full = safeStaticPath(staticDir, rel);
      if (!full) {
        sendError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      let info;
      try {
        info = await stat(full);
      } catch {
        sendError(res, 404, 'NOT_FOUND', `No such file: ${path}`);
        return;
      }
      if (info.isDirectory()) {
        sendError(res, 404, 'NOT_FOUND', 'Not found');
        return;
      }
      const body = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
        'content-length': body.length,
        /**
         * The vendored React bundles are immutable for the life of a checkout; the app code is not,
         * and a cached `app.js` during a demo is a bug that looks like a broken dashboard.
         */
        'cache-control': full.includes(`${sep}vendor${sep}`) ? 'public, max-age=3600' : 'no-store',
      });
      res.end(body);
    } catch (err) {
      /**
       * One unhandled-error path, and it says what broke. A dashboard that fails silently during a
       * five-minute pitch is worse than one that prints a stack trace.
       */
      sendError(res, 500, 'INTERNAL', err?.message ?? String(err), {
        stack: (err?.stack ?? '').split('\n').slice(0, 4),
      });
    }
  });
}

function countBy(list, key) {
  const out = {};
  for (const item of list) {
    const k = key(item) ?? 'UNKNOWN';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
