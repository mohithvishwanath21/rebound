/**
 * `npm run describe-sim`
 *
 * Prints every assumption the simulator makes, with its value, its justification, and
 * the range it is swept over.
 *
 * This command exists for one purpose: to make it impossible for me to overclaim.
 *
 * Rebound reports two kinds of result and they must never be blended. The plumbing
 * claim — "this really does recover a real payment" — is proven against Razorpay's
 * test-mode APIs with real payment IDs in the audit trail. The policy claim — "these
 * decisions recover more money than the alternatives" — is measured in simulation, and a
 * simulation is only as credible as its stated assumptions. Every number below is a
 * judgement call I made, not a measurement I took, and anyone evaluating this should be
 * able to read all of them in one place and in under two minutes.
 *
 * If a judge thinks one of these is wrong, the sweep range tells them whether it
 * matters. `npm run eval -- --sweep` re-runs the comparison across these ranges and
 * reports whether the ranking between policies ever flips.
 */

import { ASSUMPTIONS } from '../responseModel.js';
import { CAUSE_GIVEN_PAYER, DEFAULT_PARAMS, TEST_PARAM_SHIFT, GENERATOR_VERSION } from '../generator.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const OFF = '\x1b[0m';

const isLeaf = (v) => v && typeof v === 'object' && 'value' in v && 'basis' in v;

/** Wrap prose to a width, indented, so long justifications stay readable in a terminal. */
function wrap(text, width, indent) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += ' ' + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join('\n');
}

function fmtValue(v) {
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (v && typeof v === 'object') return '{ see matrix below }';
  return String(v);
}

let judgementCount = 0;
let measuredCount = 0;

function printLeaf(path, spec) {
  const tag = /^JUDGEMENT/i.test(spec.basis) ? `${YELLOW}JUDGEMENT${OFF}` : `${CYAN}GROUNDED${OFF}`;
  if (/^JUDGEMENT/i.test(spec.basis)) judgementCount++;
  else measuredCount++;

  const sweep = Array.isArray(spec.sweep) ? `  swept ${spec.sweep[0]} → ${spec.sweep[1]}` : '';
  console.log(`\n  ${BOLD}${path}${OFF} = ${fmtValue(spec.value)}   [${tag}]${DIM}${sweep}${OFF}`);
  console.log(`${DIM}${wrap(spec.basis.replace(/^JUDGEMENT\.\s*/i, ''), 76, '      ')}${OFF}`);

  // Matrix-valued assumptions get their contents printed, because "actionFit is a
  // judgement" is not a disclosure — the individual cells are the actual claims.
  if (spec.value && typeof spec.value === 'object' && !Array.isArray(spec.value)) {
    const rows = Object.entries(spec.value);
    const firstRow = rows[0]?.[1];
    if (firstRow && typeof firstRow === 'object') {
      const cols = Object.keys(firstRow);
      const w = Math.max(...rows.map(([r]) => r.length)) + 2;
      console.log(`\n      ${''.padEnd(w)}${cols.map((c) => c.slice(0, 11).padStart(13)).join('')}`);
      for (const [rowName, row] of rows) {
        const cells = cols.map((c) => {
          const val = row[c];
          const s = val === 0 ? '0 ' : Number(val).toFixed(2);
          return (val === 0 ? `${BOLD}${s}${OFF}` : s).padStart(val === 0 ? 13 + BOLD.length + OFF.length : 13);
        });
        console.log(`      ${rowName.padEnd(w)}${cells.join('')}`);
      }
      console.log(`${DIM}      Bold 0 = structural zero: not a small probability, an impossible one.${OFF}`);
    } else {
      for (const [k, v] of rows) console.log(`      ${k.padEnd(24)} ${fmtValue(v)}`);
    }
  }
}

function walk(obj, prefix = '') {
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isLeaf(val)) printLeaf(path, val);
    else if (val && typeof val === 'object') walk(val, path);
  }
}

console.log(`\n${BOLD}REBOUND — SIMULATOR ASSUMPTIONS${OFF}`);
console.log('='.repeat(78));
console.log(wrap(
  'Every value below is an input to the POLICY claim ("these decisions recover more ' +
  'money"), which is measured in simulation. None of it affects the PLUMBING claim ' +
  '("this recovers a real payment"), which is proven against Razorpay test-mode APIs ' +
  'and needs no assumptions at all. The two are reported separately and never summed.',
  76, '  '
));
console.log(`\n  Generator version: ${GENERATOR_VERSION}`);

console.log(`\n\n${BOLD}RESPONSE MODEL${OFF}`);
console.log('-'.repeat(78));
walk(ASSUMPTIONS);

console.log(`\n\n${BOLD}WORLD GENERATOR PARAMETERS${OFF}`);
console.log('-'.repeat(78));
console.log(wrap(
  'These shape the population, not the response to actions. The TEST split shifts the ' +
  'starred values, so the held-out batch measures generalisation to a different world ' +
  'rather than just a different random draw from the same one.', 76, '  '
));
console.log('');
for (const [k, v] of Object.entries(DEFAULT_PARAMS)) {
  const shifted = k in TEST_PARAM_SHIFT;
  const label = `${k}${shifted ? ' *' : ''}`;
  if (v && typeof v === 'object') {
    console.log(`  ${BOLD}${label}${OFF}`);
    for (const [k2, v2] of Object.entries(v)) {
      if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
        const inner = Object.entries(v2).map(([k3, v3]) => `${k3}=${fmtValue(v3)}`).join('  ');
        console.log(`      ${k2.padEnd(24)} ${inner}`);
      } else {
        console.log(`      ${k2.padEnd(24)} ${fmtValue(v2)}`);
      }
    }
  } else {
    console.log(`  ${label.padEnd(30)} ${fmtValue(v)}`);
  }
}
console.log(`\n${DIM}  * = shifted in the held-out TEST split${OFF}`);

console.log(`\n\n${BOLD}P(root cause | payer type) — why diagnosis is not a lookup${OFF}`);
console.log('-'.repeat(78));
console.log(wrap(
  'The agent observes an error code and must infer the payer type. These distributions ' +
  'overlap deliberately: the same generic decline is emitted by several different payer ' +
  'types, so no rule can map code to truth. That overlap is the actual problem being ' +
  'solved, and it is the reason a calibrated probability beats a decision table.',
  76, '  '
));
for (const [payerType, byLoss] of Object.entries(CAUSE_GIVEN_PAYER)) {
  console.log(`\n  ${BOLD}${payerType}${OFF}`);
  for (const [lossType, dist] of Object.entries(byLoss)) {
    const parts = Object.entries(dist)
      .filter(([, p]) => p > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([cause, p]) => `${cause} ${(p * 100).toFixed(0)}%`);
    console.log(`      ${lossType.padEnd(21)} ${parts.join(', ')}`);
  }
}

console.log(`\n\n${BOLD}SUMMARY${OFF}`);
console.log('-'.repeat(78));
const plural = (n, one, many) => (n === 1 ? one : many);
console.log(`  ${judgementCount} of these ${plural(judgementCount, 'value is an explicit judgement call', 'values are explicit judgement calls')}.`);
console.log(`  ${measuredCount} ${plural(measuredCount, 'is', 'are')} grounded in an external reference.`);
console.log(wrap(
  'That ratio is the honest headline: this is a reasoned model of recovery behaviour, ' +
  'not a fitted one. It is why results are always reported with a sensitivity sweep, ' +
  'why the sweep ranges above are wide, and why any claim of a specific recovery ' +
  'percentage is stated as a range with its assumptions attached.', 76, '  '
));
console.log(`\n${DIM}  Run \`npm run eval -- --sweep\` to see whether any of these change the ranking.${OFF}\n`);
