/**
 * THE ASSUMPTION SENSITIVITY SWEEP (#58)
 * ======================================
 *
 *   node src/eval/cli/sweep.js                          # every row in the catalogue
 *   node src/eval/cli/sweep.js --only=baseline,retry-penalty-x0
 *   node src/eval/cli/sweep.js --report-only            # re-print the table from cached row JSONs
 *   node src/eval/cli/sweep.js --list
 *
 * WHAT THIS ANSWERS, AND THE MUCH LARGER THING IT DOES NOT
 * -------------------------------------------------------
 * `describeAssumptions()` returns `measured: false` for every price in the project. The failed-retry
 * penalty, the patience unit, the review cost, the three contribution margins, the ₹2 floor — all of
 * them are stated, none of them is measured. The five-arm headline is computed on top of that stack,
 * so the only defensible question is not "is the number right" but "does the RANKING survive being
 * wrong about the numbers".
 *
 * This sweep answers that and nothing else. It cannot tell anyone the true failed-retry penalty, and a
 * row that shows the ranking holding at ±30% is not evidence that ±30% is the right band — the band is
 * a declared assumption too. What it can do is find the assumptions the conclusion RESTS on, so that a
 * reader who disagrees with one of my prices knows immediately whether their disagreement matters.
 *
 * THE RULE THIS RUNNER ENFORCES: IT MUST NEVER SELECT ANYTHING
 * -----------------------------------------------------------
 * Nothing here picks a winner. The rows print in catalogue order, never sorted by favourability, and
 * the verdict per row is computed from a definition fixed in `VERDICT` below — written before the runs,
 * and identical for every row including the control. A sweep that chose the best row would be a search
 * over 25 worlds for the one that flatters the project, and reporting the max of 25 noisy comparisons
 * as though it were a measurement is how a sensitivity analysis becomes the opposite of one.
 *
 * `POLICY.evBarSigmaK = 1` was fixed by argument (EV/sigma(EV) = p/sigma(p), amount-invariant) and by
 * the #52 A/B, both of which happened before this file existed. The `ev-bar-k*` rows report the shape
 * of that curve. They do not choose a point on it.
 *
 * WHY A FAILED ROW IS LOUD AND IS NOT COUNTED
 * ------------------------------------------
 * The natural summary of a sweep is "the ranking held in N of 25 worlds". If a crashed row were
 * silently dropped, N would fall and the denominator would fall with it, so the *ratio* would improve
 * every time something broke. A sweep that gets more reassuring as it malfunctions is worse than no
 * sweep, so failures print as FAILED, are excluded from the verdict counts, and the counts always name
 * the number of rows that actually completed.
 *
 * WHY THE GUARDRAIL COUNTERS ARE CHECKED IN EVERY ROW
 * --------------------------------------------------
 * A perturbed price may legitimately change how much money the agent recovers. It may NOT produce a
 * message inside quiet hours or a breach of the contact cap. Those are compliance invariants and they
 * do not have a price, so any row with a non-empty `invariantFailures` is reported as a DEFECT rather
 * than as a data point — the finding in that case is about my code, not about the world.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PERTURBATION_IDS, describePerturbations } from '../perturbations.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_CLI = join(HERE, 'run.js');
const REPO_ROOT = join(HERE, '..', '..', '..');

/**
 * THE VERDICT DEFINITION. Fixed here, applied identically to all 25 rows including the control.
 *
 * `primary` is the project's actual claim against the fixed-ladder baseline — the retry loop everyone
 * already runs — and it deliberately requires BOTH a majority of paired worlds AND a pooled ratio
 * above 1. Requiring both is stricter than either: at n = 5 a single lucky world can carry the pooled
 * figure, and a 3-of-5 sign count with a pooled ratio below 1 means the wins were small and the losses
 * were large. Neither alone is a claim I would want to make out loud.
 *
 * `secondary` records the comparison against the aggressive baseline, which the control row LOSES at
 * 0.71x. It is reported for every row for one reason: if some perturbation flips that loss into a win,
 * that is the single most tempting number in the whole sweep to quote and the least honest, because it
 * would be a win found by searching worlds. Naming it in the table is how I stop myself.
 */
const VERDICT = {
  primary: { versus: 'vsB3', label: 'beats fixed ladder (>=3/5 worlds AND pooled ratio > 1)' },
  secondary: { versus: 'vsB2', label: 'vs aggressive (control LOSES this at 0.71x)' },
};

function parseFlags(argv) {
  const f = {
    only: null,
    seeds: '1,2,3,4,5',
    count: 80,
    split: 'TEST',
    evBarSigmaK: 1,
    out: '/tmp/sweep',
    workers: 2,
    reportOnly: false,
    reuse: false,
    list: false,
    json: false,
  };
  for (const arg of argv) {
    const [k, v] = arg.includes('=') ? arg.split('=') : [arg, null];
    switch (k) {
      case '--only': f.only = v.split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--seeds': f.seeds = v; break;
      case '--count': f.count = Number(v); break;
      case '--split': f.split = v; break;
      case '--ev-bar-sigma-k': f.evBarSigmaK = Number(v); break;
      case '--out': f.out = v; break;
      case '--workers': f.workers = Number(v); break;
      case '--report-only': f.reportOnly = true; break;
      case '--reuse': f.reuse = true; break;
      case '--list': f.list = true; break;
      case '--json': f.json = true; break;
      default:
        throw new Error(`sweep: unknown flag "${k}". Flags need an = sign, e.g. --only=baseline.`);
    }
  }
  if (f.only) {
    for (const id of f.only) {
      if (!PERTURBATION_IDS.includes(id)) {
        throw new Error(
          `sweep: --only contains "${id}", which is not a perturbation id.\nKnown:\n  ${PERTURBATION_IDS.join('\n  ')}`
        );
      }
    }
  }
  return f;
}

/** Run one row as a child process, writing its full JSON to `<out>/<id>.json`. */
async function runRow({ id, f }) {
  const outPath = join(f.out, `${id}.json`);
  if (f.reuse && existsSync(outPath)) return { id, outPath, reused: true, code: 0 };

  const args = [
    RUN_CLI,
    `--perturb=${id}`,
    `--seeds=${f.seeds}`,
    `--count=${f.count}`,
    `--split=${f.split}`,
    `--ev-bar-sigma-k=${f.evBarSigmaK}`,
    '--json',
  ];

  const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
  const chunks = [];
  const errChunks = [];
  child.stdout.on('data', (d) => chunks.push(d));
  child.stderr.on('data', (d) => errChunks.push(d));

  const code = await new Promise((resolve) => child.on('close', resolve));
  const stdout = Buffer.concat(chunks).toString('utf8');
  const stderr = Buffer.concat(errChunks).toString('utf8');

  if (code === 0 && stdout.trim()) await writeFile(outPath, stdout);
  return { id, outPath, code, stderr: stderr.slice(-2000), reused: false };
}

/** A tiny fixed-width worker pool. Two by default, because the box has two cores. */
async function mapWithWorkers(items, workers, fn) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Sum a metric over every world for one arm. */
function sumOverWorlds(json, armId, key) {
  let total = 0;
  for (const world of json.perWorld) {
    for (const row of world.rows) if (row.arm === armId) total += row[key] ?? 0;
  }
  return total;
}

function summariseRow(id, json, meta) {
  const p = json.pooled[VERDICT.primary.versus];
  const s = json.pooled[VERDICT.secondary.versus];

  const attemptsRebound = sumOverWorlds(json, 'REBOUND_EV', 'attempts');
  const attemptsB3 = sumOverWorlds(json, 'B3_FIXED_LADDER', 'attempts');
  const messagesRebound = sumOverWorlds(json, 'REBOUND_EV', 'messages');
  const messagesB3 = sumOverWorlds(json, 'B3_FIXED_LADDER', 'messages');

  const signs = `${p.incremental.positive}/${p.incremental.n}`;
  const pooledRatio = p.pooled.incrementalRatio.value;
  const holds = p.incremental.positive * 2 > p.incremental.n && pooledRatio > 1;

  return {
    id,
    family: meta.family,
    label: meta.label,
    refit: meta.refit,
    expectNoMovement: meta.expectNoMovement,
    /**
     * THE FINGERPRINT. Five numbers describing what the agent actually DID and what the world did
     * back, used only to answer "did this perturbation reach the arithmetic at all".
     *
     * It exists because the first smoke run printed four rows with identical money and I nearly read
     * that as robustness. Two different things were hiding inside it. `self-recovery-x1.3` had not
     * reached the world at all — a wiring bug. `retry-penalty-x0` HAD reached it and moved retry
     * attempts from 226 to 251 while recovering exactly the same rupees, which is not a null at all:
     * it is the sharpest result in the sweep, because it says the penalty's whole contribution is
     * avoided waste rather than extra recovery. A table that prints only the money term cannot tell
     * those two apart, and they need opposite responses.
     */
    fingerprint: {
      attempts: attemptsRebound,
      retries: sumOverWorlds(json, 'REBOUND_EV', 'retries'),
      failedRetries: sumOverWorlds(json, 'REBOUND_EV', 'failedRetries'),
      messages: messagesRebound,
      recoveredPaise: sumOverWorlds(json, 'REBOUND_EV', 'recoveredPaise'),
      netPaise: sumOverWorlds(json, 'REBOUND_EV', 'netPaise'),
      incrementalPaise: sumOverWorlds(json, 'REBOUND_EV', 'incrementalPaise'),
      selfRecoveredPaise: sumOverWorlds(json, 'REBOUND_EV', 'selfRecoveredPaise'),
      stoppedCases: sumOverWorlds(json, 'REBOUND_EV', 'stoppedCases'),
      approvalsRequested: sumOverWorlds(json, 'REBOUND_EV', 'approvalsRequested'),
    },
    primary: {
      signs,
      positive: p.incremental.positive,
      n: p.incremental.n,
      meanIncrementalPaise: p.incremental.mean,
      sdPaise: p.incremental.sd,
      minPaise: p.incremental.min,
      maxPaise: p.incremental.max,
      pooledIncrementalRatio: pooledRatio,
      holds,
    },
    secondary: {
      signs: `${s.incremental.positive}/${s.incremental.n}`,
      pooledIncrementalRatio: s.pooled.incrementalRatio.value,
      wins: s.incremental.positive * 2 > s.incremental.n && s.pooled.incrementalRatio.value > 1,
    },
    attempts: { rebound: attemptsRebound, b3: attemptsB3, ratio: attemptsB3 ? attemptsRebound / attemptsB3 : null },
    messages: { rebound: messagesRebound, b3: messagesB3 },
    invariantFailures: json.invariantFailures ?? [],
    breakerWarnings: json.breakerWarnings ?? [],
    evBarSigmaK: json.config.evBarSigmaK,
    evBarSigmaKSource: json.config.evBarSigmaKSource,
  };
}

/** Which fingerprint terms differ from the control, if any. */
function movedTerms(row, baseline) {
  if (!baseline || row.id === baseline.id) return null;
  return Object.keys(row.fingerprint).filter((k) => row.fingerprint[k] !== baseline.fingerprint[k]);
}

const rupees = (paise) => `${paise < 0 ? '-' : '+'}Rs.${Math.abs(Math.round(paise / 100)).toLocaleString('en-IN')}`;

function printTable(rows, baseline) {
  const pad = (s, n) => String(s).padEnd(n);

  console.log('');
  console.log('  PERTURBATION                    FAM     RFT  SIGN  POOLED  MEAN PAIRED   ACTIONS     vsB2    VERDICT');
  console.log('  ' + '-'.repeat(106));

  for (const r of rows) {
    if (r.failed) {
      console.log(`  ${pad(r.id, 32)}${pad('-', 8)}${pad('-', 5)}${pad('-', 6)}${pad('-', 8)}${pad('-', 14)}${pad('-', 12)}${pad('-', 8)}FAILED (${r.code})`);
      continue;
    }
    const moved = movedTerms(r, baseline);
    const flip = baseline && r.primary.holds !== baseline.primary.holds;
    const defect = r.invariantFailures.length > 0;

    /**
     * Verdict precedence: a defect outranks a flip, a no-op outranks both. All three are statements
     * about whether the row can be read at all, and they have to be resolved before its money can be.
     * A no-op row has no verdict — reporting one would be reporting the control twice.
     */
    const verdict = defect
      ? `DEFECT (${r.invariantFailures.length} invariant)`
      : r.id === baseline?.id
        ? 'CONTROL'
        : moved && moved.length === 0
          ? (r.expectNoMovement ? 'no-op (PREDICTED)' : 'NO-OP -- SUSPECT WIRING')
          : flip
            ? (r.primary.holds ? 'FLIP -> holds' : 'FLIP -> fails')
            : (r.primary.holds ? 'holds' : 'fails (as control)');

    const attemptsCell =
      baseline && r.id !== baseline.id && r.fingerprint.attempts !== baseline.fingerprint.attempts
        ? `${r.fingerprint.attempts} (${r.fingerprint.attempts > baseline.fingerprint.attempts ? '+' : ''}${r.fingerprint.attempts - baseline.fingerprint.attempts})`
        : String(r.fingerprint.attempts);

    console.log(
      `  ${pad(r.id, 32)}${pad(r.family, 8)}${pad(r.refit ? 'y' : 'N', 5)}${pad(r.primary.signs, 6)}` +
        `${pad(r.primary.pooledIncrementalRatio.toFixed(2) + 'x', 8)}${pad(rupees(r.primary.meanIncrementalPaise), 14)}` +
        `${pad(attemptsCell, 12)}${pad(r.secondary.pooledIncrementalRatio.toFixed(2) + 'x', 8)}${verdict}`
    );
  }
  console.log('  ' + '-'.repeat(106));
  console.log('');
  console.log('  SIGN     worlds where Rebound beat the fixed ladder on incremental recovery, out of n.');
  console.log('  POOLED   pooled incremental ratio vs B3_FIXED_LADDER. MEAN PAIRED = mean paired difference.');
  console.log('  ACTIONS  every action Rebound attempted — retries PLUS messages — and the change against');
  console.log('            the control. In the control that is 688 retries and 691 messages. A row can move');
  console.log('            this a long way while leaving the money untouched; that is a result, not a null.');
  console.log('  vsB2     pooled incremental ratio vs B2_AGGRESSIVE. The control LOSES this comparison. It is');
  console.log('           shown so a row which flips it cannot be quoted without the other 24 rows beside it.');
  console.log('  RFT      was the model refitted in the perturbed world. N means the row measures robustness');
  console.log('           to a miscalibrated model — a different question, and one that cannot attribute a flip.');
  console.log('  NO-OP    every term of the fingerprint equals the control, to the paise. Read as a suspected');
  console.log('           wiring bug, not as robustness, unless the catalogue pre-registered the null.');
  console.log('');
  console.log(`  Actions, control row: Rebound ${baseline?.attempts.rebound ?? "?"} (${baseline?.fingerprint.retries ?? "?"} retries + ${baseline?.fingerprint.messages ?? "?"} messages) vs fixed ladder ${baseline?.attempts.b3 ?? "?"}.`);
  console.log('');
}

function printFindings(rows, baseline) {
  const ran = rows.filter((r) => !r.failed);
  const defects = ran.filter((r) => r.invariantFailures.length > 0);
  const failed = rows.filter((r) => r.failed);
  /**
   * The control is excluded from the denominator. It cannot flip against itself, so counting it would
   * add one guaranteed "held" to every summary — a free point that makes a 24-row sweep read as
   * slightly more robust than it is, and that gets worse the more rows crash.
   */
  const clean = ran.filter((r) => r.invariantFailures.length === 0 && r.id !== baseline?.id);
  const flips = clean.filter((r) => baseline && r.primary.holds !== baseline.primary.holds);
  const b2Flips = clean.filter((r) => baseline && r.secondary.wins !== baseline.secondary.wins);
  const noops = clean.filter((r) => (movedTerms(r, baseline) ?? ['x']).length === 0);
  const suspectNoops = noops.filter((r) => !r.expectNoMovement);
  const moneyOnlyNulls = clean.filter((r) => {
    const m = movedTerms(r, baseline) ?? [];
    return m.length > 0 && !m.includes('incrementalPaise') && !m.includes('recoveredPaise');
  });

  console.log('  WHAT THIS SWEEP FOUND');
  console.log('  ' + '-'.repeat(104));
  console.log(`  Rows requested: ${rows.length}. Completed: ${ran.length}. Crashed: ${failed.length}. With invariant defects: ${defects.length}.`);
  console.log(`  Of the ${clean.length} clean completed rows excluding the control, the primary verdict`);
  console.log(`  (${VERDICT.primary.label})`);
  console.log(`  matched the control in ${clean.length - flips.length} and flipped in ${flips.length}.`);

  if (suspectNoops.length) {
    console.log('');
    console.log('  READ THIS BEFORE THE VERDICTS. These rows are identical to the control on every term of');
    console.log('  the fingerprint, and the catalogue did NOT predict that. Until each one is explained, the');
    console.log('  honest reading is that the perturbation never reached the arithmetic, and a sweep whose');
    console.log('  perturbations do not land reports the control 25 times and calls it robustness:');
    for (const r of suspectNoops) console.log(`    ${r.id}  (${r.family})  ${r.label}`);
  }
  if (moneyOnlyNulls.length) {
    console.log('');
    console.log('  These rows changed what the agent DID without changing what it recovered. That is a real');
    console.log('  finding and the table would have hidden it behind an unchanged money column:');
    for (const r of moneyOnlyNulls) {
      const m = movedTerms(r, baseline) ?? [];
      const d = r.fingerprint.attempts - baseline.fingerprint.attempts;
      console.log(`    ${r.id}  attempts ${d >= 0 ? '+' : ''}${d}, same recovery. Moved: ${m.join(', ')}`);
    }
  }
  if (flips.length) {
    console.log('');
    console.log('  THE RANKING FLIPPED HERE. These are the assumptions the conclusion actually rests on:');
    for (const r of flips) {
      console.log(`    ${r.id}  (${r.family}${r.refit ? '' : ', NOT refitted'})  ${r.primary.signs} signs vs fixed ladder, ${r.primary.pooledIncrementalRatio.toFixed(2)}x, ${rupees(r.primary.meanIncrementalPaise)}`);
      console.log(`      ${r.label}`);
    }
  }
  if (b2Flips.length) {
    console.log('');
    console.log('  The comparison against the AGGRESSIVE baseline also moved in these rows. The control loses');
    console.log('  that comparison, so a row where it wins is a world found by searching, not a result.');
    console.log('  BOTH sign counts are printed because they are counts of DIFFERENT comparisons: the sign');
    console.log('  count in the table above is vs the fixed ladder, and the one here is vs the aggressive');
    console.log('  baseline. The same row can legitimately read 5/5 there and 4/5 here; that is two facts,');
    console.log('  not a contradiction.');
    for (const r of b2Flips)
      console.log(
        `    ${r.id}  ${r.secondary.signs} signs vs aggressive (${r.primary.signs} vs fixed ladder), ${r.secondary.pooledIncrementalRatio.toFixed(2)}x`
      );
  }
  if (defects.length) {
    console.log('');
    console.log('  INVARIANT DEFECTS — these rows report a bug in the code, not a fact about the world:');
    for (const r of defects) console.log(`    ${r.id}: ${JSON.stringify(r.invariantFailures).slice(0, 300)}`);
  }
  if (failed.length) {
    console.log('');
    console.log('  CRASHED ROWS — excluded from every count above:');
    for (const r of failed) console.log(`    ${r.id} (exit ${r.code}) ${String(r.stderr ?? '').split('\n').filter(Boolean).slice(-1)[0] ?? ''}`);
  }
  console.log('');
  console.log('  A row that shows no movement is only informative if it COULD have moved. The catalogue');
  console.log('  states an expectation for each row in its `why` field, and two of them pre-register a null:');
  console.log('  channels-x0.7 / x1.3 (channel prices are 1-4 paise against amounts in the thousands of');
  console.log('  rupees, so they cannot move an argmax) and that null is a confirmed prediction. Any OTHER');
  console.log('  row printing no movement should be read as a possible wiring bug first and a finding second.');
  console.log('');
}

async function main() {
  const f = parseFlags(process.argv.slice(2));
  const catalogue = describePerturbations();
  const metaById = new Map(catalogue.map((c) => [c.id, c]));

  if (f.list) {
    for (const c of catalogue) console.log(`${c.id}\n  [${c.family}] ${c.label}${c.refit ? '' : '  (model NOT refitted)'}\n`);
    return;
  }

  const ids = f.only ?? PERTURBATION_IDS;
  await mkdir(f.out, { recursive: true });

  if (!f.reportOnly) {
    console.error(`sweep: running ${ids.length} row(s) x ${f.seeds.split(',').length} seeds, ${f.workers} worker(s), out=${f.out}`);
    const t0 = Date.now();
    const outcomes = await mapWithWorkers(ids, f.workers, async (id) => {
      const started = Date.now();
      const r = await runRow({ id, f });
      console.error(
        `  ${r.code === 0 ? (r.reused ? 'cached' : 'ok    ') : 'FAILED'}  ${id}  ${((Date.now() - started) / 1000).toFixed(1)}s`
      );
      return r;
    });
    console.error(`sweep: ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
    for (const o of outcomes) if (o.code !== 0) console.error(`  ${o.id} stderr tail: ${o.stderr}`);
  }

  // Read back from disk rather than from memory, so --report-only and a fresh run print the same table
  // from the same bytes. A summary computed in the process that produced it can drift from the artefact
  // a reader would check.
  const rows = [];
  for (const id of ids) {
    const p = join(f.out, `${id}.json`);
    if (!existsSync(p)) {
      rows.push({ id, failed: true, code: 'no output' });
      continue;
    }
    try {
      const json = JSON.parse(await readFile(p, 'utf8'));
      rows.push(summariseRow(id, json, metaById.get(id)));
    } catch (err) {
      rows.push({ id, failed: true, code: `unreadable: ${err.message}` });
    }
  }

  const baseline = rows.find((r) => r.id === 'baseline' && !r.failed) ?? null;

  if (f.json) {
    console.log(JSON.stringify({ verdictDefinition: VERDICT, flags: f, rows, baselineId: baseline?.id ?? null }, null, 2));
    return;
  }

  console.log('');
  console.log('  ASSUMPTION SENSITIVITY SWEEP');
  console.log(`  ${ids.length} row(s), seeds ${f.seeds}, ${f.count} cases, ${f.split} split, k=${f.evBarSigmaK}`);
  console.log('  Nothing here selects a policy. Rows print in catalogue order, never sorted by result.');
  if (!baseline) {
    console.log('');
    console.log('  NO CONTROL ROW IN THIS SHARD. Verdicts below are absolute, not flips — run with');
    console.log('  --only=baseline,... or --report-only over a directory that has baseline.json.');
  }
  printTable(rows, baseline);
  printFindings(rows, baseline);
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
