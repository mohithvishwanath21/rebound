# Engineering log

Real problems, real fixes. Written as they happen, not reconstructed afterwards.

The Razorpay application form asks "what broke, and how you got out" — and says it's
the answer they read first. This file is the raw material for that answer. Rules for
myself: log the embarrassing ones, log the dead ends, and never smooth over a bug I
didn't actually understand.

Format for each entry:

```
## [Day N] One-line symptom
**Symptom:** what I actually observed
**First hypothesis:** what I thought it was, and why that was wrong
**Root cause:** what it actually was
**Fix:** what I changed
**Lesson:** the generalisable thing I now know
```

---

## [Day 0] Decided against a monorepo after starting one

**Symptom:** Not a bug — a design reversal worth recording. I began scaffolding this as
an npm-workspaces monorepo with five packages.

**First hypothesis:** Clean package boundaries would keep the agent from accidentally
reading simulator internals, which is the one architectural property this project
genuinely needs (see `docs/honesty.md`).

**Root cause of the reversal:** Workspace tooling overhead is real, and I'm solo with a
13-day budget. The boundary I care about is "the agent must not be able to read ground
truth," and I realised I could enforce that far more cheaply: keep latent simulator
truth in a **separate Mongo collection** that the agent code never imports a model for.
The guarantee comes from the data layer, not from the build system.

**Fix:** Single Node package, plain directories under `src/`. One test asserts the agent
never imports the latent-truth model.

**Lesson:** Pick the cheapest mechanism that actually enforces the invariant you care
about. I was reaching for package boundaries out of habit when a collection boundary was
stronger *and* free — package boundaries are a convention a tired developer can violate
at 2am, whereas the agent simply has no code path to the data.

---

## [Day 2] My fatigue curve was backwards, and it was backwards in my own favour

**Symptom:** 25 of 26 simulator invariants passed on the first run. The one failure was
the check that the 4th message to a customer hurts more than the 2nd:

```
FAIL  the drop is convex (4th touch hurts more than the 2nd)
      d1=0.1399 d3=0.0838
```

**First hypothesis:** A bad assertion. I'd written the test from the docstring and assumed
I'd just got a comparison operator the wrong way round at midnight.

**Root cause:** The test was right and the model was wrong. I had written

```js
const remaining = (budget - touchesUsed) / budget;
const fatigue = Math.pow(remaining, A.fatigueExponent);  // exponent 1.6
```

and documented it as *"above 1.0 means fatigue accelerates."* It does the opposite.
Raising *remaining* patience to a power above 1 makes the multiplier fall in shrinking
steps — with a budget of 4 the series is 1 → 0.63 → 0.33 → 0.11 → 0, so the per-touch
damage is 0.37, 0.30, 0.22, 0.11. The **first** message was the expensive one and the
fourth was nearly free.

The uncomfortable part is the direction of the error. Fatigue that gets cheaper per
message quietly rewards volume, which means my simulator was tilted toward the
aggressive baseline I intend to beat — I had accidentally handicapped *myself*. Had the
bug leaned the other way I might never have questioned a passing test.

**Fix:** Reparameterised on patience *spent*, so the constant's name matches its
behaviour: `fatigue = 1 - (touchesUsed / budget) ** exponent`. Now >1 accelerates, =1 is
linear, <1 decelerates. Added an invariant asserting the curvature actually flips when
the exponent crosses 1.0, so the parameter can't drift away from its own name again.

Then a second, worse problem surfaced while fixing the first. Each assumption carries a
declared `sweep` range for the sensitivity analysis, and `fatigueExponent` declares
`[0.6, 2.6]` — deliberately spanning the regime where my policy's main advantage
disappears. But `perturbAssumptions` ignored those ranges and applied a flat ±30%
jitter, which around 1.6 explores only **1.12–2.08**. The sweep could never reach below
1.0. My documentation promised to test the assumption most likely to embarrass me, and
the code structurally could not do it. Nothing failed; the numbers would have looked
fine.

Rewrote the perturbation to sample from each leaf's own declared range (applied as a
ratio, so overrides still compose), and added three guards: that the full sweep reaches
below 1.0, that it reaches above 2.0, and that samples stay inside the declared band.

**Lesson:** Two things I'll carry forward. First, when a test contradicts a comment, find
out which is lying before you touch either — the comment was the bug both times here.
Second, and the one I actually care about: check which way your bugs lean. An honest
sensitivity analysis has to be *able* to produce the result you don't want, and "we swept
±30%" sounds rigorous while guaranteeing nothing about what was covered. Ranges in a
docstring that no code reads are decoration. Wire the documentation to the executable, or
assume it's false.

---

## [Day 2] No database, no package registry — and it made the architecture better

**Symptom:** Went to install dependencies and load the seeded world into MongoDB. Neither
was available: `npm ping` returned `403 Forbidden` from the registry, and there was no
`mongod` on the machine. I could run nothing but dependency-free Node.

**First hypothesis:** A blocker to route around — get Mongo running, then continue. I
started thinking about how much of the plan to defer until I had it.

**Root cause of the reversal:** It isn't a blocker, it's a constraint that exposed a design
flaw I'd have shipped otherwise. My plan had every component writing through mongoose
models, which would have meant three things I didn't want:

1. The sensitivity sweep replays the whole batch under many perturbed assumption sets
   across five policy arms — thousands of runs. Round-tripping every decision through a
   database turns a two-minute analysis into an hour-long one, and an analysis that takes
   an hour is an analysis I quietly stop running.
2. A reviewer cloning the repo would need to stand up MongoDB before reproducing a single
   number. That is an excellent way to ensure nobody reproduces any of them.
3. I couldn't test the thing I was writing, which is how untested code acquires the
   confidence of tested code.

**Fix:** Persistence is now a seam. `src/db/store.js` defines a narrow, domain-specific
interface with an in-memory implementation; the eval uses it by default, so `npm run eval`
works on a clean clone with nothing but Node. Mongo becomes a second implementation behind
the same interface, used by the API and dashboard where a persisted, queryable audit trail
is a real requirement — "show an audit trail" is one of four things Track 03 asks for, and
one that vanishes on process exit isn't one.

The interface names ~15 real access patterns rather than exposing a generic
`find(mongoQuery)`. I considered the generic wrapper and rejected it: it would force the
in-memory store to reimplement Mongo's query semantics, and every gap between the two
becomes a bug that appears in exactly one of them. The likely victim is
`countContactsSince`, which enforces the per-customer messaging cap — a subtly different
date comparison between stores means the guardrail holds in evaluation and leaks in
production. That's the worst possible place to put a portability bug.

Both implementations run the *same* assertions, in `test/storeContract.js`. The in-memory
one passes 13 of them now; the Mongo one has to pass all 13 before I trust a number that
came out of it.

Also seeded worlds to committed JSON instead of straight to the database, with observable
world and latent truth in separate files mirroring the collection split. Re-seeding is
byte-identical, verified.

**Lesson:** When the environment takes a tool away, check whether the tool was load-bearing
or just familiar. I reached for Mongo everywhere because the project is nominally MERN, not
because the eval needed a database — and "MERN" described my habits rather than this
program's requirements. The constraint also handed me a property I wanted anyway and would
not have prioritised: one command, no infrastructure, reproduces the headline numbers.

---

## [Day 3] Every partial settlement would have been booked at full value

**Symptom:** None. Nothing failed. I caught this reading my own diff, which is the only
reason it is in this file instead of in the submission.

The gateway receipt had one money field, `amountPaise`, and the SIM gateway filled it in
like this:

```js
amountCollectedPaise: outcome.recovered ? req.amountPaise : 0,   // WRONG
```

**First hypothesis:** That it was fine. `req.amountPaise` is the amount we asked for, and if
the outcome says `recovered`, the customer paid — so the amount asked for is the amount
collected. That reasoning is correct for four of the five payer types.

**Root cause:** It is false for the fifth. `simulateActionOutcome` already models partial
settlement: a customer in dispute who does agree to pay often pays less, capped at what they
were ever willing to pay, and the function returns that reduced figure as
`outcome.amountPaise`. I was reading the *requested* amount instead of the *arrived* amount.

Every haircut would have been recorded at full invoice value. The headline number of this
entire project is "rupees recovered," so this bug inflates precisely the one figure everything
else is in service of — and it does it invisibly. Each individual receipt still looks
perfectly well-formed. There is no error, no warning, no failing test. You would only ever
find it by asking "where does this number come from" one more time than feels necessary.

**Fix:** Split the concept in two on the receipt. `amountPaise` is what we asked for,
`amountCollectedPaise` is what arrived, and the difference is now visible rather than
assumed. Then two invariants in `assertReceiptShape`, checked on every receipt in both modes:

```js
// A receipt that did not capture must have collected exactly zero.
// Collected must never exceed requested.
```

Those hold for LIVE_TEST too, where `amountCollectedPaise` reads Razorpay's own `amount_paid`
rather than the amount on the link.

**Lesson:** "Requested" and "received" are different quantities and deserve different names,
even when they are equal in the common case — *especially* then, because that is what makes
the conflation survive review. The general shape: when one variable is standing in for two
concepts, the bug appears only in the minority case, and the minority case is the one nobody
writes a test for. Related, and the reason I now look for these specifically: this is the
second bug in three days that leaned in a flattering direction. The Day 2 fatigue curve
handicapped me; this one would have paid me. A bug that inflates your own headline metric is
not a different kind of mistake from one that deflates it, but it is the kind you have to go
looking for, because nothing about it feels wrong while you're writing it.

---

## [Day 3] I asserted an idempotency guarantee that Razorpay never made

**Symptom:** Again no failure — a comment I could not defend when I reread it. On the
order-create call I had written:

```js
idempotent: true,   // receipt is our unique key, so a replay is safe
```

**First hypothesis:** That this was simply true. I had built `buildReference()` to produce
one deterministic key per decision and threaded it through as both the local store's
idempotency key and the remote identifier, so "the remote end dedupes on it" felt like
something I had already established.

**Root cause:** I had established it for the wrong endpoint. Razorpay enforces uniqueness on
a payment link's `reference_id` — that part is real, and it is what makes the duplicate-link
path safe. It does **not** enforce uniqueness on an Order's `receipt` field by default. So a
replayed order create does not resolve to the existing order; it creates a second one. My
comment claimed a remote guarantee that only existed on a different endpoint, and I had
generalised from one to the other without checking.

Retrying an order create is nonetheless safe, but for an entirely different reason: creating
an order moves no money. A duplicate is a harmless extra record, not a second charge. Same
conclusion, completely different argument — and the argument is what a future reader would
rely on when deciding whether some *other* call is safe to retry.

**Fix:** Renamed the flag from `idempotent` to `safeToRetry` everywhere, because two distinct
properties were hiding under one word. "Idempotent" is a claim about the provider's
behaviour. "Safe to retry" is a claim about the consequences. The retry loop only ever needed
the second one, and naming it after the property actually being relied on forces whoever sets
it to reason about consequences instead of trusting a remote uniqueness check they have not
verified. The reasoning is written out in full in `errors.js` above `isRetryable()`.

Then I encoded the asymmetry in the fake — `test/fakeRazorpay.js` deliberately enforces unique
`reference_id` on links and deliberately does not on order `receipt` — and asserted it
directly, so the distinction cannot quietly collapse again:

```
[LIVE_TEST] Razorpay enforces unique reference_id on links but NOT unique receipt on orders
```

And because a fake can only ever encode my beliefs, the same two beliefs are checked against
the real API by `npm run live-check` as B1 and B2.

**Lesson:** A partially failed `sed` during the rename is worth recording too. The pattern
matched the call sites but not the parameter destructuring, so for a few minutes the function
read `isRetryable(err, { safeToRetry })` while the signature still destructured `idempotent`
— which would have passed `undefined` and silently disabled *every* retry in the system.
Tests still passed, because the tests that care about retrying pass the flag explicitly. I
found it by grepping for the old name after the rename rather than trusting the command's
exit code. Renaming a boolean that gates a safety decision is not a mechanical edit: check
the destructuring, and check it by reading, not by whether anything went red.

---

## [Day 3] The one command I could not test was the one I could least afford to get wrong

**Symptom:** `npm run live-check` — the script that proves the Razorpay integration actually
works — is meant to be run by hand, against real credentials, roughly once, possibly with a
judge watching. I wrote it, and then noticed I had no way to run it: no keys and no network in
my build environment. It was about to be committed having never executed.

**First hypothesis:** That this is just how it is. It talks to a remote API, so it can only be
tested against the remote API, and the first real run *is* the test.

**Root cause of the reversal:** That's a statement about the network hop, not about the
script. Almost none of what could break in a 300-line CLI is network-shaped: argument
parsing, the order the checks run in, the abort paths, the ledger, the evidence file, whether
redaction is applied before the first request. All of that is testable offline. Accepting
"it's a live script" as a reason not to test it was me confusing the one untestable line for
the whole file.

**Fix:** Restructured it so it is runnable: `main()` takes an injected `fetchImpl`, output goes
through a swappable sink, and the auto-run is guarded by an `import.meta.url` check so
importing it doesn't fire a real API call. Then `test/liveCheck.test.js` runs the whole command
against `test/fakeRazorpay.js` — happy path, auth failure, unpaid reconcile, `--help`, missing
key, and a deliberately permissive fake that allows duplicate references so I can prove the
command actually fails when a load-bearing belief is contradicted.

The first run of that test found a real bug immediately:

```js
const http = createRazorpayClient({ onLog });   // no keyId, no keySecret
```

`createRazorpayClient` takes no environment defaults on purpose — it is library code and
should not read global state — so this would have thrown *"Razorpay client needs keyId and
keySecret"* on Mohit's very first live run, with a correct `.env` sitting right there. The
error message would have sent me looking at the `.env` file, which was fine, instead of at
the call site, which wasn't.

That bug is also the reason the test injects `fetchImpl` rather than a finished client. My
first version injected the built client, which meant the credential wiring — the exact broken
line — was the one thing the test stepped over. A seam placed for convenience tests the code
on either side of it and not the code you replaced.

**Lesson:** "It needs a network" is a property of one line, not a licence for the other three
hundred. When something feels untestable, find the actual irreducible dependency and inject
at that boundary — it is almost always narrower than the first instinct, and the gap between
"the whole integration is unverified" and "one network hop is unverified" is most of the
value. Second, and more uncomfortable: a test seam positioned where it's easy to write skips
whatever sits inside it. I placed mine one layer too high and it silently excluded the only
bug present.

---

## [Day 3] Refusing to let the simulator default its own assumptions

**Symptom:** The gateway contract failed 14 tests with
`Cannot read properties of undefined (reading 'actionFit')`. The SIM gateway never
materialised an assumption set, so `recoveryProbability` received `undefined`.

**First hypothesis:** Trivial fix — give the parameter a default:
`assumptions = materialiseAssumptions()`. One line, tests go green.

**Root cause of the reversal:** That default would have been the most expensive convenience
in the project. The sensitivity sweep works by handing each arm a *different* perturbed
assumption set. If any arm ever failed to thread its set through, a silent default would run
it against the baseline instead — every arm would secretly agree, and the sweep would report
"the result is robust to our assumptions" for the single reason that no assumption ever
varied. A false claim about the exact thing the sweep exists to be honest about, and
invisible, because the numbers would look fine.

This is the same failure mode as the Day 2 perturbation range bug: documentation promising a
rigour the code structurally could not deliver. I nearly reintroduced it three days later
through a one-line default.

**Fix:** The opposite of the obvious repair. `recoveryProbability` now throws if the
assumption set is missing, with a message explaining why it has no default. The only place
allowed to choose the baseline is `createSimGateway`, which materialises it once at
construction — once per run, not per call, so every decision inside one run provably faces the
same world.

**Lesson:** A default parameter is a policy decision about what happens when a caller forgets.
Usually the answer is "do the sensible thing"; when the forgotten value is what makes a
measurement meaningful, the sensible thing is to stop. Worth asking of any convenient default:
if this fires when I didn't intend it to, do I get a wrong answer or a loud one?

---

## [Day 3] My fake was right about the rule and wrong about the wording, so 15 tests passed over a real bug

**Symptom:** The first real run against Razorpay. Auth confirmed, redaction confirmed against
the live credential, a real payment link created — then B1, the check the entire idempotency
story rests on, died:

```
POST /payment_links 400
description: "payment link with given reference_id: rbd_SL1_vecheck1_0f12738a7a already exists.
              Please create a payment link with a different reference_id"
reason: null   field: null   retryable: false
live-check failed: RazorpayValidationError
```

**First hypothesis:** That my belief was wrong and Razorpay does not provide the uniqueness
guarantee I had built on. That would have been bad — the replay-safety argument for the whole
executor rests on it.

**Root cause:** The belief was *correct*. Razorpay refused the duplicate, which is exactly what
I claimed it would do. My **code** failed to recognise the refusal, for two compounding reasons.

First, the wording. My matcher looked for the substring `'reference id'`. Razorpay writes
`reference_id`, with an underscore. I had written the fake's message from memory:

```
mine:      "Payment link with the given reference id already exists"
Razorpay:  "payment link with given reference_id: rbd_… already exists. Please create a …"
```

Second, and worse: my fake also returned `reason: 'duplicate_reference_id'`. Razorpay returns
`reason: null`. `isDuplicateReference` checks `reason` first and returns early — so in every
offline test the function short-circuited on a field the real API never sends, and **the string
branch, the only branch that runs in production, had zero coverage.** The fake was strictly
kinder than reality on two axes at once.

This is the failure mode I had written into `test/liveCheck.test.js` as a caveat and then walked
straight into anyway: a fake encodes my beliefs, so when a belief is wrong the fake is wrong in
the same direction and cheerfully agrees with me. Not a gap in the test suite — a gap the test
suite *structurally cannot see*.

**Fix:** Three changes, in increasing order of importance.

1. Normalise before matching: fold all non-alphanumerics to spaces so `reference_id`,
   `reference-id` and `reference id:` are one thing, and require the field name plus a
   collision phrase rather than a contiguous quote of someone else's copy.
2. Correct the fake to Razorpay's verbatim response — real wording, `reason: null`,
   `field: null` — with a comment telling my future self not to "improve" it. A fake that is
   kinder than the real thing is worse than no fake, because it converts an unverified belief
   into a passing test.
3. Pin the real 400 as a fixture in `test/httpClient.test.js`, so the exact string that broke
   production is now the thing under test.

Then I measured whether the fix was load-bearing rather than assuming it: I put the original
buggy matcher back and re-ran. **15 tests fail now, including the whole live-check suite.**
Before the fake was corrected, those same 15 passed with the bug present. That number is the
honest measure of what the fixture change bought — it converted 15 decorative tests into 15
that actually detect this class of error.

**Lesson:** The one I'll carry furthest from this project. Every fake is a *hypothesis* about a
system you don't control, and a green suite tells you your code agrees with your hypothesis,
never that your hypothesis is true. Two practices follow. Write fixtures from a captured real
response, verbatim, never from memory — the paraphrase is where the belief leaks in. And when a
matcher has a fast path and a slow path, check which one your tests actually take, because a
convenience field in a fixture can silently exclude the only branch that will ever run for
real. The reason this cost one command instead of two days is that the live check was built to
state each result as a claim about *Razorpay* rather than about my code — so the output told me
the rule held and the parse failed, which is a five-minute fix, instead of just "400".

**Second bug found in the same fix:** B1 was reporting two beliefs under one label — "Razorpay
refuses duplicates" and "we can then find the link it refused." A refusal whose lookup failed
would have printed *"idempotency is NOT provided remotely"*, a claim about Razorpay flatly
contradicted by the response being reported. Split into B1 (their behaviour, fatal) and B1b
(our lookup, not fatal — an UNKNOWN receipt is the correct response to an unconfirmable
outcome). That is the third time on this project that one name covering two properties has
produced a false statement, after `amountPaise` and `idempotent`. I now treat "can I say this
in one sentence with an *and* in it" as a design smell.

---

## [Day 3] A 401 that no error message would ever explain

**Symptom:** `npm run live-check` failed instantly on `AUTH`. HTTP 401, authentication failed.
The `.env` looked completely fine.

**First hypothesis:** Wrong secret, or a key pair from different generations. Both plausible,
and neither checkable — because every path in this project deliberately refuses to print
credentials, which is correct and also meant I had no way to look.

**Root cause:** The key ID was 21 characters. Razorpay test key IDs are 23 (`rzp_test_` plus
14). Two characters had been clipped, almost certainly by a double-click selection in the
dashboard stopping at a character it treated as a word boundary. The secret was fine.

**Fix:** `npm run doctor` — a local-only, no-network command that reports the *shape* of the
credentials without ever printing them: prefix, length against the expected length, whitespace,
quote characters accidentally included, whether the two values were pasted into each other's
variables. It found it on the first run.

**Lesson:** "Never print secrets" is right, and it removes the ordinary debugging move, so the
missing tool is one that reports shape rather than content. Length, prefix, and character class
are enough to find most credential paste errors and reveal nothing useful to an attacker. Worth
building the moment a project has a secret in it — mine took twenty minutes and turned an
open-ended 401 into a single line of output. I also miscounted the length in my own test
fixture while writing this (20 characters while asserting 21), which is a decent argument for
having the machine count rather than the person.

---
