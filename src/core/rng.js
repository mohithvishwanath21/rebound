/**
 * Seeded, deterministic pseudo-random number generation.
 *
 * Why this file exists at all: every number in the pitch video has to be
 * reproducible from the repo. `Math.random()` would make the evaluation
 * unrepeatable, which would quietly turn "measured lift" into "a lift I saw once."
 * With a seeded RNG, `npm run eval -- --seed 42` produces byte-identical results
 * on a judge's machine.
 *
 * mulberry32: small, fast, good enough statistical quality for simulation work.
 * Not cryptographic — never use this for anything security-related.
 */

/**
 * Turn any seed — string or number — into a 32-bit unsigned integer.
 *
 * THIS FUNCTION EXISTS BECAUSE OF A BUG THAT INVALIDATED EVERY "DIFFERENT SEED" IN THE PROJECT.
 *
 * The original code was `let a = seed >>> 0`, which looks harmless and is correct for numbers. But
 * in JavaScript `>>>` coerces its operand with ToUint32, and ToUint32 of a non-numeric string is
 * NaN, and NaN >>> 0 is 0. So EVERY string seed collapsed to zero, silently:
 *
 *     'same'     >>> 0  ===  0
 *     'different' >>> 0  ===  0
 *     'day5'     >>> 0  ===  0
 *
 * `deriveSeed` began with the same line, so `deriveSeed('day4', 'events')` and
 * `deriveSeed('day5', 'events')` returned the identical number — the hash depended only on the
 * label. The consequence was that every seed string used anywhere in this project produced
 * byte-identical data: the same customers, the same events, the same Bernoulli draws, the same
 * fit/validation split, the same GBM subsample.
 *
 * Note carefully what this did and did not break, because the distinction is the whole lesson.
 * It did NOT break reproducibility — every run was deterministic, and the numbers in the report were
 * real. What it broke was seed VARIATION, which is a different property and the one that supports
 * every claim of the form "this result is not an artefact of one draw." A `--seed` flag that does
 * nothing is worse than no flag at all, because it invites exactly that claim.
 *
 * It was found by a test asserting that two different seeds give different splits — a property so
 * obvious that it nearly went unwritten.
 *
 * FNV-1a over the string form of the seed. Not cryptographic, just well-mixed and dependent on
 * every character, which is the entire requirement.
 */
function hashSeed(seed) {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) throw new TypeError(`makeRng: seed must be finite, got ${seed}`);
    // Mix rather than truncate, so adjacent integer seeds give well-separated streams. Sequential
    // seeds are the common case (--seed 1, 2, 3 in a sensitivity sweep) and mulberry32 started from
    // adjacent state produces visibly correlated early output.
    let a = seed >>> 0;
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b) >>> 0;
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b) >>> 0;
    return (a ^ (a >>> 16)) >>> 0;
  }
  if (typeof seed !== 'string') {
    throw new TypeError(`makeRng: seed must be a string or number, got ${typeof seed}`);
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Create an independent RNG stream from a string or numeric seed. */
export function makeRng(seed) {
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Uniform in [0, 1). */
    next,

    /** Uniform float in [min, max). */
    float: (min, max) => min + next() * (max - min),

    /** Uniform integer in [min, max] inclusive. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),

    /** True with probability p. */
    bool: (p = 0.5) => next() < p,

    /** Uniformly pick one element. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],

    /**
     * Pick from `{ key: weight }` proportionally to weight.
     * Used everywhere in the generator so distributions stay declarative
     * and reviewable rather than buried in if-chains.
     */
    weighted: (weights) => {
      const entries = Object.entries(weights).filter(([, w]) => w > 0);
      const total = entries.reduce((acc, [, w]) => acc + w, 0);
      if (total <= 0) throw new Error('weighted() needs at least one positive weight');
      let r = next() * total;
      for (const [key, w] of entries) {
        r -= w;
        if (r <= 0) return key;
      }
      return entries[entries.length - 1][0];
    },

    /** Fisher-Yates, returns a new array. */
    shuffle: (arr) => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },

    /** Standard normal via Box-Muller. */
    normal: (mean = 0, stdDev = 1) => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return mean + z * stdDev;
    },

    /**
     * Log-normal. This is the right shape for transaction amounts: most
     * payments are small, with a long right tail of large ones. A uniform or
     * normal amount distribution would make the high-value approval gate
     * (>₹25,000) fire far too often and misrepresent the problem.
     */
    logNormal: (mu, sigma) => Math.exp(mu + sigma * (() => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    })()),

    /** Exponential with the given mean. Good for inter-arrival gaps. */
    exponential: (mean) => -Math.log(1 - next()) * mean,
  };
}

/**
 * Derive a child seed from a parent seed and a string label.
 *
 * Lets each subsystem (customers, events, response outcomes) draw from an
 * independent stream. Without this, adding one extra random call in the
 * generator would shift every downstream number and silently invalidate a
 * comparison between two runs. With it, the customer population stays fixed
 * even if event generation changes.
 *
 * The parent seed may be a string or a number, and BOTH contribute. See `hashSeed` above for the
 * bug that made this comment necessary: the original implementation started from `parentSeed >>> 0`,
 * which is 0 for every string, so the derived seed depended only on the label and every named seed
 * in the project produced identical data.
 *
 * The NUL separator matters. Concatenating seed and label directly would make
 * `deriveSeed('day', '5events')` and `deriveSeed('day5', 'events')` collide, which is a small class
 * of bug but exactly the same class as the one being fixed here.
 */
export function deriveSeed(parentSeed, label) {
  if (typeof label !== 'string') throw new TypeError('deriveSeed: label must be a string');
  return hashSeed(`${parentSeed}\u0000${label}`);
}
