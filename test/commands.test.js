/**
 * THE COMMANDS A STRANGER WILL ACTUALLY TYPE.
 *
 * Every other test in this suite checks what the code does once it is running. This one checks the
 * three lines of text that decide whether it runs at all: the script names in `package.json` and the
 * commands the README tells a reviewer to paste.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------------------------
 * `npm run api -- --count=40 --approver=HUMAN` worked on every machine it was written on and dropped
 * every flag on the machine it had to work on. npm's forwarding after `--` depends on the npm version
 * and the shell; on a Windows shell npm echoed `> node src/demo/cli/serve.js` with no arguments and the
 * server started on its defaults. Its defaults are MEASURED mode, whose clock buttons are disabled
 * because the horizon is already complete — correct behaviour, indistinguishable from a broken page.
 * It survived a restart and a reload, because each restart reproduced it faithfully.
 *
 * The same shell behaviour is worse on the other command. `npm run recover-live -- --replay`
 * re-narrates a stored recovery offline. Drop the flag and `npm run recover-live` does not fail — it
 * loads `.env`, calls the real Razorpay API, and issues a new payment link. One shell quirk, and an
 * offline replay becomes a live money operation.
 *
 * So the rule this file enforces: **a flag whose absence changes what a command does, or whose absence
 * changes which controls are live, must live inside the script string where no shell can eat it.**
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE NEGATIVE ASSERTIONS MATTER MORE THAN THE POSITIVE ONES
 * ---------------------------------------------------------------------------------------------
 * Adding `npm run console` fixes nothing on its own. The defect was never a missing script; it was a
 * README sentence recommending the fragile form. A test that only asserts `scripts.console` exists
 * passes happily while the README still tells the reviewer to type the thing that breaks — which is
 * the third time in this project that a presence-only assertion has sat beside a false claim and
 * reported green. The `doesNotMatch` cases below are the point of the file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

/**
 * The documents a stranger reads to learn what to type. ENGINEERING_LOG.md is deliberately absent: it is
 * a record of what happened, it narrates this very defect, and quoting the broken command is the point
 * of the entry. Editing history so a lint passes is the wrong direction of fit.
 */
const DOC_FILES = ['README.md', 'PITCH.md', 'docs/explaining-rebound.md'];

/**
 * The copyable part of a markdown file: fenced code blocks and table rows. Prose is excluded on purpose.
 *
 * The first version of the check below scanned whole files and immediately failed — on the paragraph
 * that explains this fix, which has to *name* the broken command in order to say why it is no longer
 * documented. A check that cannot tell a warning from an instruction forces the documentation to stop
 * explaining itself, which is a worse outcome than the bug. So the rule is positional: the fragile form
 * may be discussed anywhere, and may not appear where a reader with five minutes copies from.
 */
function copyableLines(markdown) {
  const out = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.trimStart().startsWith('|')) out.push(line);
  }
  return out.join('\n');
}

/**
 * The commands whose behaviour depends on a flag arriving. Each entry names the script, the flags that
 * must be inside the script string, and what goes wrong if they are absent — the last field is there so
 * that a future reader deleting a flag has to read the consequence before doing it.
 */
const MUST_BAKE_FLAGS = [
  {
    script: 'console',
    flags: ['--approver=HUMAN', '--count=40'],
    consequenceIfDropped:
      'the server starts in MEASURED mode, where Advance and Run-to-horizon are disabled by design, ' +
      'and the page is indistinguishable from a broken one',
  },
  {
    script: 'replay',
    flags: ['--replay'],
    consequenceIfDropped:
      'recover-live takes the LIVE path: it loads .env, calls the real Razorpay API and issues a new ' +
      'payment link, which is a money operation standing in for an offline replay',
  },
];

for (const { script, flags, consequenceIfDropped } of MUST_BAKE_FLAGS) {
  test(`npm run ${script} carries its own flags, because a shell may eat forwarded ones`, () => {
    const line = pkg.scripts?.[script];
    assert.ok(
      typeof line === 'string' && line.length > 0,
      `package.json has no "${script}" script. Without it the only way to get this behaviour is ` +
        `flag forwarding after \`--\`, and if the shell drops the flags then ${consequenceIfDropped}.`
    );
    for (const flag of flags) {
      assert.ok(
        line.includes(flag),
        `"${script}" must contain ${flag} in the script string itself. If it is removed and passed on ` +
          `the command line instead, then on a shell that drops it, ${consequenceIfDropped}.`
      );
    }
  });
}

test('the README does not tell a reviewer to use the flag-forwarding form of these commands', () => {
  /**
   * WHY THE BAN IS BLANKET RATHER THAN A LIST OF THE TWO DANGEROUS COMMANDS
   * -----------------------------------------------------------------------
   * The first draft of this test banned forwarding only for `--approver=HUMAN` and `--replay`, on the
   * reasoning that those two are silent and consequential while `npm run api -- --seed=7` merely gives
   * you the wrong seed. Then PITCH.md turned up saying "reproduce these figures with
   * `npm run api -- --approver=SIM --count=40`". A dropped `--count` there is not harmless: it hands a
   * judge the 80-case default and a table of numbers that do not match the ones quoted, which reads as
   * fabricated figures rather than as a shell quirk.
   *
   * There is no category of documented command where silently running something else is acceptable. So
   * the rule is simply: in copyable text, reach a behaviour either through a flagless npm script or
   * through a direct `node` call. Both are immune to forwarding. Neither is longer to type.
   */
  for (const file of DOC_FILES) {
    const commands = copyableLines(readFileSync(join(ROOT, file), 'utf8'));
    const offenders = [...commands.matchAll(/npm run ([a-z0-9-]+)\s+--\s+(--[a-z0-9-]+)/g)];
    assert.deepEqual(
      offenders.map((m) => `${m[1]} ${m[2]}`),
      [],
      `${file} hands a reader a forwarded-flag command (${offenders
        .map((m) => `npm run ${m[1]} -- ${m[2]}`)
        .join(', ')}). npm's forwarding after \`--\` depends on the shell; on a Windows shell every flag ` +
        'was dropped and the command silently ran on its defaults. Use a flagless npm script (see ' +
        '`console`, `replay`) or spell out the direct `node src/...` call.'
    );
  }
});

test('the README table actually offers the flagless routes it is supposed to', () => {
  /**
   * The paired positive assertion. Without it, the ban above is satisfiable by deleting the commands
   * from the README entirely — which is the failure mode of every negative-only check.
   */
  const commands = copyableLines(readme);
  for (const expected of ['npm run console', 'npm run replay', 'npm run eval']) {
    assert.ok(
      commands.includes(expected),
      `the README command table no longer offers \`${expected}\`. The ban on forwarded flags is only ` +
        'useful if a working alternative is documented in its place.'
    );
  }
});

test('every npm script the README names actually exists', () => {
  /**
   * A reviewer with five minutes will paste a command from the README and will not debug it. A renamed
   * script is a broken front door, and nothing else in this suite would notice: the code the script
   * points at keeps passing its own tests under its own name.
   */
  const named = new Set();
  for (const m of readme.matchAll(/`npm run ([a-z0-9-]+)/g)) named.add(m[1]);
  assert.ok(named.size >= 5, `expected the README to name several commands, found ${named.size}`);
  const missing = [...named].filter((name) => !Object.hasOwn(pkg.scripts ?? {}, name));
  assert.deepEqual(
    missing,
    [],
    `the README names ${missing.length} npm script(s) that package.json does not define: ` +
      `${missing.join(', ')}. A reviewer pasting one of these gets an npm error as their first ` +
      'impression of the project.'
  );
});

test('the two claims still have separate commands, and neither is the console', () => {
  /**
   * Not about flags. This pins the split the whole submission rests on: `doctor`/`recover-live` speak
   * to the real API, `eval` produces the money comparison in the simulator, and no single script does
   * both. If someone ever adds convenience — one command that starts the console and prints the arm
   * table — this test is where it should fail first.
   */
  assert.match(pkg.scripts.doctor, /razorpay/, 'doctor is the real-API claim and must run the razorpay CLI');
  assert.match(pkg.scripts.eval, /eval/, 'eval is the money claim and must run the eval harness');
  assert.doesNotMatch(
    pkg.scripts.console,
    /eval\/cli/,
    'the console must not invoke the eval CLI: a paused run is truncated, and a truncated run is biased ' +
      'twice in our favour, so no money figure may be produced on that screen'
  );
});
