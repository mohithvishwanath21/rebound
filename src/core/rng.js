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

/** Create an independent RNG stream from a numeric seed. */
export function makeRng(seed) {
  let a = seed >>> 0;
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
 */
export function deriveSeed(parentSeed, label) {
  let h = parentSeed >>> 0;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}
