/**
 * THE GROUND-TRUTH DENYLIST, IN ONE PLACE.
 *
 * These are the field names the simulator uses for the answer key. An agent that can read any of
 * them is not solving the problem; it is looking up the solution. `test/boundary.test.js` scans
 * `src/agent`, `src/api`, `src/razorpay` and `src/ml` for literal references to them at build time.
 *
 * WHY THE LIST MOVED HERE FROM INSIDE THAT TEST FILE.
 *
 * Day 10 needed a SECOND consumer. The dashboard serves case records over HTTP, and the store's
 * case records turned out to carry `_generatedVague` on `event.failure` — see #75. A build-time
 * scan for the token cannot catch that, because no agent-side source file mentions the field; the
 * generator writes it, the store copies the event wholesale, and an API that returns a case record
 * ships the answer key to a browser with no source file ever naming it. So there is now a runtime
 * check over real HTTP responses in `test/api.test.js` as well, and two checks reading two copies of
 * a denylist is a bug waiting for one of them to be updated alone.
 *
 * WHY THIS FILE IS IN `src/core` AND NOT IN `src/api`.
 *
 * `src/api/**` is one of the directories the boundary scan restricts, and the scan is a substring
 * search. A denylist placed there would be a file full of forbidden tokens inside a forbidden
 * directory: the check would report itself and the honest response would be to add an exemption,
 * which is how a scan like this stops meaning anything. `src/core` is unrestricted, so the list can
 * be named openly where neither the agent nor the API has any reason to import it.
 *
 * A denylist only catches names somebody thought of, so it is the weaker of the two mechanisms in
 * this project. The stronger one is the allowlist: `src/agent/observe.js` projects events for the
 * agent, and `src/api/readModel.js` projects records for the browser. Both start from nothing and
 * add fields deliberately, so the next latent nobody thought of is invisible by default. This list
 * exists to catch the intent; the allowlists stop the data.
 */

/** Field names that appear only in ground truth. Extend this, never an exemption list. */
export const GROUND_TRUTH_TOKENS = Object.freeze([
  'latent_truth',
  'LatentTruth',
  'latentTruth',
  'trueRootCause',
  'payerType',
  'willSelfRecover',
  'patienceBudget',
  'workingRails',
  'fundsAvailableFrom',
  'maxWillingToPayPaise',
  'trueDowntimeWindow',
  '_generatedVague',
  'trueCause',
  /**
   * Added on Day 10 while writing the runtime check, by asking what the generator draws that is not
   * already listed. `selfRecoverAt` is the instant an untouched case would have paid on its own —
   * the single most valuable field in the world model, because an agent reading it would skip
   * exactly the cases that need no help and post a recovery rate nothing could reproduce. It was
   * never in the build-time list.
   */
  'selfRecoverAt',
]);

/**
 * Every token that appears anywhere in `value`, serialised. Used by the runtime check.
 *
 * Deliberately crude — it stringifies and substring-searches, so it catches a latent hiding as a
 * key OR as a value, at any depth, including inside a field the projection copied by accident. A
 * structural walk would be tidier and would miss `{"note":"payerType=NEVER_PAYING"}`.
 */
export function groundTruthLeaks(value) {
  const blob = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return GROUND_TRUTH_TOKENS.filter((token) => blob.includes(token));
}
