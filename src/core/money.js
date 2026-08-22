/**
 * Money is ALWAYS an integer number of paise. Never a float, never rupees.
 *
 * This is not pedantry. 0.1 + 0.2 !== 0.3 in IEEE-754, and a recovery agent that
 * accumulates thousands of amounts across a batch will silently drift. Razorpay's
 * own APIs take amounts in paise as integers for exactly this reason, so staying in
 * paise end-to-end also means zero conversion at the API boundary.
 *
 * Rule enforced throughout the codebase: any variable holding money is named
 * `*Paise` and holds an integer. Rupees exist only for display.
 */

/** Convert rupees (may be fractional) to integer paise. */
export function rupeesToPaise(rupees) {
  return Math.round(rupees * 100);
}

/** For display only. Never feed this back into arithmetic. */
export function paiseToRupees(paise) {
  return paise / 100;
}

/**
 * Format paise as Indian-locale currency, e.g. 123456789 -> "₹12,34,567.89".
 * Uses the en-IN locale so grouping is lakh/crore style, which is what a
 * Razorpay merchant expects to see.
 */
export function formatINR(paise, { withDecimals = true } = {}) {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const value = abs / 100;
  const formatted = value.toLocaleString('en-IN', {
    minimumFractionDigits: withDecimals ? 2 : 0,
    maximumFractionDigits: withDecimals ? 2 : 0,
  });
  return `${sign}₹${formatted}`;
}

/** Compact form for dashboard tiles: ₹1.2L, ₹3.4Cr. */
export function formatINRCompact(paise) {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? '-' : '';
  if (rupees >= 1e7) return `${sign}₹${(rupees / 1e7).toFixed(2)}Cr`;
  if (rupees >= 1e5) return `${sign}₹${(rupees / 1e5).toFixed(2)}L`;
  if (rupees >= 1e3) return `${sign}₹${(rupees / 1e3).toFixed(1)}K`;
  return `${sign}₹${rupees.toFixed(0)}`;
}

/** Sum a list of paise amounts. Integer-safe. */
export function sumPaise(amounts) {
  return amounts.reduce((acc, n) => acc + n, 0);
}

/**
 * Assert an amount is a valid paise integer. Called at trust boundaries
 * (generator output, API input, adapter calls) so a float can never leak in.
 */
export function assertPaise(value, label = 'amount') {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of paise, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must be non-negative, got ${value}`);
  }
  return value;
}
