# Explaining Rebound out loud

Written for the moment someone asks "so what did you actually build?" — in a five-minute video, or
across a table. It is organised by the question rather than by the code, because that is the order
the questions arrive in. Every claim here is one the repository can back up; where something is not
yet built, it says so.

## The one-sentence version

Rebound treats failed-payment recovery as a budget allocation problem under hard constraints rather
than as a retry loop. For each failed payment it estimates the probability that each available
action recovers the money, multiplies by the amount at stake, subtracts the cost of the action and
the cost of annoying the customer, and takes the best option — or stops, if no option is worth
taking. The stopping rule is the part most systems do not have.

If you only get one more sentence: the reason a retry loop is the wrong shape is that the best
action often is not a retry at all. On the very first real payment this project ever handled, the
card was declined twice for `international_transaction_not_allowed`. Retrying that card had a
recovery probability of approximately zero, because nothing about the card was going to change.
Switching to a different rail collected the money on the first attempt. Same customer, same amount,
same minute; two actions whose expected values were nowhere near each other.

## What is actually proven, and what is only measured

This distinction is the spine of the project and the thing to get right before anything else,
because conflating the two is how demos become dishonest.

The first claim is *the plumbing works*. Authentication, payment link creation, remote idempotency,
reconciling a payment back to the originating decision, redaction of credentials, and reading a
declined attempt back with the reason the provider gave. Every one of these is verified against the
real Razorpay test-mode API by `npm run live-check`, which writes a redacted, committable artifact
into `docs/evidence/` on each run. On 2026-08-22 a real ₹499 payment link was created, declined
twice on card, paid on another rail, and reconciled — `status=paid paid=49900 of 49900`.

The second claim is *the policy is better than the alternatives*. This one is **not** proven against
Razorpay and cannot be, because measuring it would require deliberately failing thousands of real
payments and then treating real customers differently to compare arms. It is measured in simulation,
against documented assumptions, on a held-out test split, with a sensitivity analysis showing how
the result moves when the assumptions move.

The live-check command restates this boundary in its own output on every single run, and a test
asserts the restatement is still there — so it cannot quietly rot into marketing copy.

The honest way to say this out loud: "the integration is real and I can show you the API responses;
the improvement number is simulated and I will tell you exactly which assumptions it rests on."

## Why a simulator at all, and why that is not a cop-out

There is no public dataset of payment failures with counterfactual outcomes, and there could not be
— it would require knowing what would have happened had a different action been taken. So the
world is synthetic, and the honesty comes from three structural choices rather than from a promise.

Latent truth — each simulated customer's real willingness and ability to pay — lives in a separate
collection that the decision code has no code path to. That is not a convention;
`test/boundary.test.js` imports every module under `src/agent/`, `src/api/` and `src/razorpay/` and
fails the build if any of them can reach the truth. A reviewer does not have to trust that the agent
is not cheating; they can read one test.

The random number stream is derived per decision rather than shared, so two policies that happen to
visit cases in a different order still face identical luck on the same case. Without this, comparing
two policies would partly measure scheduling order.

And the simulator's own assumptions are asserted, not assumed: `npm run verify-sim` checks thirty
invariants about the generated world, including several that were originally wrong. The fatigue curve
in the first version made customers *more* likely to pay the more they were contacted, which flattered
the policy under test — the invariant that caught it is still in the file.

## Why one gateway contract with two implementations

Everything that talks to money goes through a single interface with exactly two implementations: one
backed by the simulator, one backed by the real Razorpay API. The same contract test suite runs
against both, and against a fake Razorpay for offline runs.

This is what licenses the strongest sentence available here: a recovery number measured in simulation
was produced by *the same decision code* that would run against Razorpay. Not a reimplementation of
it, not a simplified version — the same code, with a different gateway injected. Dependency injection
rather than a factory, everywhere, specifically so the boundary test keeps its teeth.

## What a fake can and cannot prove

`test/fakeRazorpay.js` speaks the subset of Razorpay's API this project uses, so the live gateway is
exercised on every commit without a network or a key. It is genuinely useful and it has a hard limit,
which is worth stating before anyone else points it out: a fake encodes my beliefs about the API, so
if a belief is wrong, the fake is wrong in the same direction, and the test passes over a real bug.
That is the failure mode you cannot test your way out of.

It happened. Razorpay's duplicate-reference error says `reference_id` with an underscore and sends no
machine-readable reason code. My fake used a different wording and supplied a reason code, so the
matcher short-circuited on the reason and the string branch — the only branch that runs in production
— had zero coverage. Fifteen tests passed over it. The fix was to pin the real 400 as a fixture, and I
confirmed the fix was load-bearing by restoring the old matcher and watching those same fifteen tests
fail.

This is why `live-check` exists at all: it is the thing that can falsify a belief, which a fake by
construction cannot.

## How the customer is protected

Three mechanisms, one of which is built and two of which are Day 6.

Built: Razorpay's own reminder sequence is explicitly disabled on every payment link. This sounds
minor and is not — a messaging cap the provider can route around is not a cap. The customer would
receive extra messages while our audit trail showed none of them, which is both a compliance problem
and a silently corrupted dataset. There is a test asserting `reminder_enable: false`.

Also built: links never accept partial payment, so a recovery is all-or-nothing and cannot be booked
at full value when only part arrived. An early version of the receipt had one field for "amount
requested" and "amount collected", which would have overstated every partial settlement as a full
recovery.

Day 6: the contact-frequency cap and quiet-hours rules as a guardrail engine that filters the action
set *before* expected value is computed, so a forbidden action can never be chosen no matter how
attractive it looks. And the stopping rule: when no surviving action has positive expected value, the
system stops and says why.

## What is not built yet

Being straight about this is better than being caught. As of the end of Day 3 there is no diagnosis
classifier, no probability model, no expected-value engine, no guardrail engine, no orchestrator, no
evaluation harness, no dashboard, and no HTTP API — `npm run api` and `npm run eval` point at files
that do not exist yet. What exists is the world, the money-handling core, the provider integration,
the persistence layer, and the test infrastructure that all of the above will be measured with.

The taxonomy in `src/core/taxonomy.js` has twelve root causes and a rule table, written before any
real API contact — and the first real decline this project ever saw,
`international_transaction_not_allowed`, is not one of them. That gap is the honest starting point for
the diagnosis layer rather than something to paper over.

## The questions I expect, and the short answers

**Is this real or a demo?** Real integration, simulated evaluation, and the code tells you which is
which on every run. There is a redacted evidence file per live run in `docs/evidence/`.

**How do I know the recovery number is not made up?** Because I will show you the assumptions it
depends on and how much it moves when they change, because it is measured on a split the policy never
saw, and because the decision code that produced it is the same code that talks to Razorpay.

**What is the AI here?** A learned estimate of recovery probability per action, combined with amounts
and costs into an expected-value comparison across the actions that survive the guardrails. The
intelligence is in choosing among alternatives and knowing when to stop — not in generating text.

**What stops it from harassing people?** Guardrails applied before the choice rather than after, a
provider configured so it cannot send messages behind our back, and a stopping rule that ends the
sequence when no action is worth taking.

**What broke?** Plenty, and it is all in `ENGINEERING_LOG.md` with symptoms and root causes. The most
instructive one is the fake that agreed with me and was wrong in the same direction. The most
embarrassing is the reconciler that told me a load-bearing belief was contradicted when the truth was
that nobody had paid the link yet.
