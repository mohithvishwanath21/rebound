/**
 * Small statistics helpers that more than one layer needs.
 *
 * This file exists for a dependency-direction reason rather than a size reason. `percentile` is
 * needed by `src/sim/approver.js` (to describe the reviewer's realised waits) and by
 * `src/eval/metrics.js` (to describe the same waits as the audit trail records them). Putting it in
 * either one would have made the other import across a seam it should not: `src/eval/**` may import
 * `src/sim/**`, but `src/sim/**` importing the scoring layer would invert the arrangement the whole
 * evaluation rests on — the world does not get to know how it is being graded. `src/core/**` is the
 * one place both sides may depend on, so it goes here.
 *
 * Duplicating the four lines in both files was the other option, and it is the one that eventually
 * produces two percentile conventions and a table where two columns are not comparable.
 */

/**
 * Nearest-rank percentile. NOT interpolated.
 *
 * Interpolation invents a value nobody observed. These samples are small — a single world produces a
 * handful of approvals — and for a claim like "the reviewer's p90 wait was 41 hours" it is far more
 * useful to name a wait that actually happened than to average two that did.
 *
 * `p = 100` therefore returns the maximum, which is why callers can use this for a max instead of
 * carrying a second code path.
 *
 * Returns null on an empty list rather than 0 or NaN. Zero would be a lie (no wait was observed, and
 * "the p50 wait was 0h" reads as instant approval), and NaN propagates silently through arithmetic.
 * Every caller here already has to distinguish "no approvals happened" from "approvals were fast",
 * and null forces that distinction to be handled.
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Arithmetic mean, or null on an empty list — same reasoning as `percentile`. */
export function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
