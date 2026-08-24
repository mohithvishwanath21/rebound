/**
 * CLI FLAG PARSING THAT REFUSES TO GUESS
 * ======================================
 *
 * One shared parser, because the alternative was three hand-rolled ones that each ignored anything
 * they did not recognise.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * `model-report.js` accepted only `--name=value`. Written with a space — `--seed day6` — the flag was
 * not matched, no error was raised, and the run silently used the default seed `day5`. It then printed
 * `seed day6` in its own header, because the header was rendered from a variable the parser had never
 * assigned. A report labelled with data it had not used.
 *
 * That is the third instance of one failure mode in this project:
 *
 *   1. `seed >>> 0` turned every string seed into 0, so four days of "different seeds" were one seed.
 *   2. `generateBatch({ count })` — no such parameter — so `--count=200` produced 600 events while
 *      the header printed 200.
 *   3. `--seed day6` fell back to `day5` while claiming to be `day6`.
 *
 * In all three, an input was discarded and the output still looked right. The common repair is to make
 * the discard impossible rather than to be more careful: an unrecognised argument is an error, and a
 * flag written in a form the parser does not support is an error naming the correct form.
 *
 * WHY THIS THROWS INSTEAD OF WARNING
 * ----------------------------------
 * A warning on stderr is invisible in a piped run, in a redirected run, and in any run where the
 * numbers are what the reader came for. These CLIs produce figures that go into a written report, so
 * the failure mode of a warning is a real number stapled to a wrong label — which is worse than a
 * crash, because a crash cannot be quoted.
 */

/**
 * @param {string[]} argv     usually `process.argv.slice(2)`
 * @param {object} spec       { flagName: defaultValue } — value flags, `--name=value`
 * @param {string[]} booleans switches, e.g. ['json', 'quiet']
 * @returns {object} parsed values, keyed as in `spec`, plus each boolean as true/false
 */
export function parseFlags(argv, spec, booleans = []) {
  const valueNames = Object.keys(spec);
  const known = new Set([...valueNames, ...booleans]);
  const out = { ...spec };
  for (const b of booleans) out[b] = false;

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument "${arg}". Flags are written --name=value.`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);

    if (!known.has(name)) {
      // Unknown flags are fatal, not ignored. A typo'd `--tress=500` that silently does nothing is
      // how a run gets reported as having used a setting it did not use.
      const suggestions = [...known].filter((k) => k.startsWith(name.slice(0, 3)));
      throw new Error(
        `unknown flag --${name}. Known flags: ${[...known].map((k) => `--${k}`).join(', ')}` +
        (suggestions.length ? `. Did you mean --${suggestions[0]}?` : '')
      );
    }

    if (eq === -1) {
      if (booleans.includes(name)) { out[name] = true; continue; }
      // The exact bug in the header. `--seed day6` arrives as a bare `--seed`, and the value lands in
      // argv as a separate entry the parser never looks at.
      throw new Error(
        `--${name} needs a value, written with an '=': --${name}=VALUE, not --${name} VALUE. ` +
        `The spaced form was silently ignored by an earlier version of this CLI, which then printed ` +
        `a report labelled with a value it had not used.`
      );
    }

    if (booleans.includes(name)) {
      throw new Error(`--${name} is a switch and takes no value; write --${name}.`);
    }
    // `slice(1).join('=')` so a value containing '=' survives.
    out[name] = body.slice(eq + 1);
  }

  return out;
}

/**
 * Numeric flag with an explicit failure. `Number('abc')` is NaN, and NaN flows silently through
 * arithmetic into an array length or a loop bound and surfaces much later as something unrelated.
 */
export function asNumber(value, name, { integer = true, min = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${name}=${value} is not a number`);
  if (integer && !Number.isInteger(n)) throw new Error(`--${name}=${value} must be a whole number`);
  if (n < min) throw new Error(`--${name}=${value} must be at least ${min}`);
  return n;
}

/**
 * Run flag parsing and validation, and on failure print the message and exit 2 rather than dumping a
 * stack trace.
 *
 * A stack trace is the right output for a bug in the code and the wrong output for a mistyped flag:
 * it buries the one line that says what to type under ten that describe the parser's internals. Exit
 * code 2 rather than 1, by the usual convention that distinguishes "you asked for something
 * impossible" from "the thing you asked for failed".
 */
export function readFlags(argv, spec, booleans = [], validate = (f) => f) {
  try {
    return validate(parseFlags(argv, spec, booleans));
  } catch (err) {
    process.stderr.write(`\n  ${err.message}\n\n`);
    process.exit(2);
  }
}
