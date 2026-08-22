/**
 * RESTRICTED AREA — this directory may not read simulator ground truth.
 * =====================================================================
 *
 * Everything under `src/agent/` sees exactly what a real recovery agent deployed at a
 * real merchant would see: Razorpay error fields, payment and invoice history, consent
 * flags, timestamps, and issuer downtime signals. Nothing else.
 *
 * It must never import from `src/sim/**`, and must never reference the latent fields
 * listed in `test/boundary.test.js` — `payerType`, `trueRootCause`, `willSelfRecover`
 * and friends. Those live in a separate Mongo collection precisely so that no
 * convenient join exists. `test/boundary.test.js` fails the build if this is violated,
 * and proves on every run that its detectors still work.
 *
 * The reason is not tidiness. If the agent could read why a payment *actually* failed,
 * the measured recovery lift would be a model grading its own answer key, and every
 * number in the README would be worthless. Reading the answer key is the easiest way to
 * fake a result, and it is easy exactly because it never feels like cheating — it feels
 * like removing a redundant inference step at 2am.
 *
 * `src/eval/**` is allowed to read ground truth. Scoring is the one job that requires
 * comparing beliefs against truth.
 *
 * This file carries no code. It exists so that anyone opening this directory reads the
 * rule before adding to it. (It is also, honestly, a leftover: it began as a deliberate
 * boundary violation used to check the test could catch one — see ENGINEERING_LOG,
 * Day 2 — and the sandbox it was written in would not let me delete it. Repurposing it
 * as the signpost seemed better than leaving a file called `__probe.js` lying around
 * with a stub in it.)
 */

export {};
