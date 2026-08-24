/**
 * THE EVALUATION CLOCK
 * ====================
 *
 * A single frozen instant that every evaluation anchors to.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * `generateBatch({ seed, split, now = new Date() })` defaults `now` to wall-clock time. For a live
 * orchestrator that default is correct — it really does want to know what time it is. For an
 * evaluation it is a silent reproducibility bug, and it took a while to notice.
 *
 * The symptom: running `npm run model-report` twice, two minutes apart, produced different numbers.
 * The GBM's held-out regret moved from ₹1,70,078 to ₹1,77,087, and the logistic arm's ECE moved in
 * the fourth decimal place — while every seed in the pipeline was fixed and every model was
 * deterministic. I went looking for an unseeded `Math.random` and there wasn't one.
 *
 * The mechanism is that the seeded RNG decides the *shape* of each event — cause, amount, payer
 * type, how many days before `now` it occurred — but `now` itself sets where that shape lands on a
 * calendar. Shift the anchor by ninety seconds and every `occurredAt` shifts with it. Most features
 * do not care. Two care a great deal: `ageDays`, and `salaryWindowProximity`, which reads the DAY OF
 * THE MONTH. An event anchored at 23:59 on the 31st and the same event anchored at 00:01 on the 1st
 * get materially different recovery probabilities, so the Bernoulli draws differ, so the labels
 * differ, so every model trains on slightly different data.
 *
 * WHY IT MATTERS MORE THAN THE SIZE OF THE WOBBLE SUGGESTS
 * ------------------------------------------------------
 * The drift was small — well under a percentage point on the headline metrics. That is precisely
 * what makes it dangerous. A run-to-run wobble of that size is exactly the magnitude of a genuine
 * improvement from a modelling change, so any A/B comparison across runs would have been measuring
 * the clock as much as the change. And I have written "anybody who clones this repo can reproduce
 * every figure it prints" into three separate files, which was not true.
 *
 * Day 4's numbers are unaffected, and it is worth being precise about why rather than just asserting
 * it: diagnosis reads the failure payload — error reason, source, step, description — and never
 * reads a timestamp. So the diagnosis report was reproducible by luck of what it happens to depend
 * on, not by design. That is not a defence, it is the same bug with no consequences yet.
 *
 * WHY NOT CHANGE THE DEFAULT IN `generateBatch`
 * --------------------------------------------
 * Because the default is right for its other caller. `npm run seed` populates a database for the
 * API and dashboard to serve, and events dated to 1970 or to a hard-coded day in the past would
 * make the UI nonsensical. The bug is not the default; it is an evaluation relying on one.
 * Evaluations pin the clock explicitly, here, in one place, where it is visible.
 */

/**
 * 2026-08-22, midnight UTC — the date the first real Razorpay decline was traced through this
 * system, which makes it the natural reference point for the project.
 *
 * Mid-month on purpose. Anchoring on the 1st would put every generated event inside the
 * salary-credit window and make `salaryWindowProximity` nearly constant, which would quietly
 * destroy the timing signal the model is supposed to learn. Anchoring mid-month spreads the
 * generated occurrence dates across the whole month, in and out of the window.
 */
export const EVAL_NOW = new Date('2026-08-22T00:00:00.000Z');

/** Fresh Date each call, so a caller mutating it cannot corrupt every later evaluation. */
export function evalNow() {
  return new Date(EVAL_NOW.getTime());
}
