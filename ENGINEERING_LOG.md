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

## [Day 3] Razorpay refused to duplicate a link, then told me that link did not exist

**Symptom:** Second live run, and this time the duplicate refusal was recognised correctly — B1
CONFIRMED. But the very next line:

```
CONFIRMED    B1   Razorpay REJECTS a duplicate reference_id on payment links
                  the duplicate was refused (receipt state=UNKNOWN)
UNVERIFIED   B1b  after a refusal we can locate the existing link by reference_id
                  refused, but the lookup did not resolve it: code=DUPLICATE_NOT_FOUND
```

Razorpay had just refused to create a second link *because one already existed*, and the
follow-up `GET /payment_links?reference_id=…` returned 200 with nothing in it. Two statements
from the same API, one minute apart, that cannot both be true.

**First hypothesis:** That `?reference_id=` is not a supported filter and was being ignored. But
an ignored filter returns the *unfiltered* list, which on this account is non-empty. Empty is
not what "ignored" looks like.

**Root cause:** I read the wrong key off the response. Most Razorpay collections come back as
`{count, entity, items}`, so I wrote `body?.items ?? []` and never questioned it. The
fetch-all-payment-links response puts the array under **`payment_links`**. So `items` was
`undefined`, the fallback made it `[]`, and a link that demonstrably existed read as absent.

Two things made this survive to a live run. My fake used `items` as well, because the same
assumption wrote both. And nothing earlier had ever inspected a *list* body: `AUTH` calls
`GET /payment_links?count=1` but only asserts `status === 200`, and the `JOIN` check fetches a
single link by id, which returns the object directly. The list envelope had no coverage
anywhere despite being requested on every run.

**Fix:** Accept either key, and — the more important half — **stop trusting the server-side
filter entirely.** The original returned `items[0]` on the assumption the query had filtered. If
that parameter is ever ignored, an unfiltered list comes back and `items[0]` is *somebody
else's payment link*, which this function would hand back as the replay of our decision,
attaching a stranger's amount and paid status to our audit trail. A wrong recovery number is
worse than a missing one, so the match is now re-verified locally against the exact reference
and the server filter is treated as an optimisation. There is a test that feeds the lookup a
decoy paid link for ₹9,999.99 and asserts the receipt comes back UNKNOWN with zero collected.

Also added a `reference_lookup_empty` diagnostic that logs the response's *keys* — safe to
print, where the objects are not, since a payment link carries customer contact details.

**Lesson:** A missing key and an empty result are indistinguishable once `?? []` sits between
them, and that idiom turns "I misunderstood the response" into "there is nothing there" —
silently, with a 200. Where a lookup drives a money decision, absence deserves to be
distinguished from misparse; the diagnostic exists so the next occurrence answers "what shape
was it actually" without another round trip. And the wider pattern, third time now: I keep
generalising one endpoint's behaviour to a sibling endpoint. Unique `reference_id` on links did
not imply unique `receipt` on orders; `{items}` on other collections did not imply `{items}` on
payment links. Consistency across an API is a hope, not a specification.

---

## [Day 3] Worked on POSIX, wrote to C:\C:\ on Windows

**Symptom:** Every check passed, the payment link printed, and then the last line of the run:

```
live-check failed: ENOENT: no such file or directory,
  mkdir 'C:\C:\MohithFiles\OldLaptopFiles\Rebound\rebound\docs\evidence'
```

**Root cause:** `new URL('../../../docs/evidence/', import.meta.url).pathname`. On Windows that
yields `/C:/MohithFiles/…` — with a leading slash, which makes it look like a relative path, so
`mkdirSync` resolved it against the drive and produced the doubled `C:\C:\`. On POSIX the same
expression is simply correct, which is exactly why it shipped: my whole test suite runs on
Linux, and this is a bug that only exists on the machine the operator is actually using.

**Fix:** `fileURLToPath()`, which is the function that exists for this — it handles the drive
letter, the leading slash, and percent-decoding, so a path containing a space would also have
broken the old version. Plus `path.join` instead of string concatenation, so a directory passed
without a trailing separator works. Same for the pretty-printed path in the summary line, which
matched only forward slashes.

**Lesson:** `URL.pathname` is not a filesystem path, it is a URL component that resembles one on
one family of operating systems. Any time a file path is derived from `import.meta.url`, it goes
through `fileURLToPath` — no exceptions, because the failure is invisible on the machine where
the tests run. Worth noting honestly: **I could not verify this fix myself.** My sandbox is
Linux, where `fileURLToPath` on a `file:///C:/…` URL returns the same string as `.pathname`, so
the two are indistinguishable here. The fix is the documented one and I am confident in it, but
the confirmation had to come from the Windows run — a reminder that "my tests pass" is scoped
to the platform they passed on.

---

## [Day 3] My own verification tool told me a lie, in the direction of blaming me

**Symptom:** I created a payment link, did not pay it, and ran the reconciler to see what it
would say. It said this:

```
  CONTRADICTED RECOVERED  a paid test-mode link reads back as CAPTURED with the amount that arrived
               status=created paid=0 of 49900 reference=rbd_SL1_vecheck1_58a43c528f

  Not paid yet.

  2 confirmed, 1 not confirmed
  1 load-bearing belief(s) contradicted. Fix the code, not the fake.
```

Read the last two lines together. The tool has correctly observed "not paid yet" and then
concluded that a belief about Razorpay was false and that I should change my code. Both halves
of that conclusion are wrong. Nothing about Razorpay was contradicted — nobody had paid the
link. The correct next step was to open a URL and type a test card number.

**First hypothesis:** A cosmetic problem with the summary line. It is not cosmetic: the run also
exited non-zero, so if this command were gating a commit, an unpaid link would have blocked the
commit with a message accusing the integration of being broken.

**Root cause:** `reconcile()` computed one boolean, `view.state === CAPTURED`, and the ledger had
exactly two rendering states. So the single flag was carrying two completely different facts:

- the link is paid and Razorpay reported it differently than I claimed → **my belief is false**
- the link is not paid → **nothing has been tested, and nothing has been learned**

Collapsing those into `held: false` was what produced a confident false statement. The
`!r.held` filter in the summary then swept it up, because `null` is falsy too — so even making
`held` three-valued would not have fixed the report on its own.

**Fix:** `held` is now genuinely three-valued — `true`, `false`, or `null` for "the precondition
for learning anything was never met" — with `pending: true` alongside it so the intent is
explicit rather than inferred from a nullish check. The ledger renders a fourth tag, `PENDING`,
and the summary partitions into three disjoint buckets instead of filtering on falsiness. There
is a third exit code too, which matters more than it looks: `0` would let a gate treat "nobody
paid the link" as a proven recovery, `1` asserts something false about Razorpay, so an
incomplete run exits `2`. And `RECOVERED` is still fatal the moment money actually arrives — the
regression test for that exists precisely because making PENDING non-fatal could otherwise have
quietly made the whole check incapable of failing.

I verified the fix was load-bearing the same way as the duplicate-reference bug: I reverted the
three-way partition and re-ran. The new test fails, alone, with the old behaviour restored.

**Lesson:** This is the fourth time in three days that one name has been made to carry two
properties, and I now treat it as the defect class I am most prone to. The previous three were
`amountPaise` versus `amountCollectedPaise` (requested versus arrived), `idempotent` versus
`safeToRetry` (a request can be safe to repeat without being deduplicated), and B1 versus B1b
(Razorpay refused the duplicate, but I could not then find the link). Every single one produced
a confidently worded false statement rather than a crash, which is why they survived a green
suite.

The sharper version of the lesson is about verification tools specifically. A checker's entire
value is that its verdicts can be trusted, so a false negative in a checker is worse than the
same bug in ordinary code — it spends the operator's attention on a fix that does not exist and
teaches them to discount the tool. "Not tested yet" and "tested and failed" are different
states, and any harness that reports on beliefs needs a way to say the first one out loud.

---

## [Day 3] My reconciler was blind to the one event the product is about

**Symptom:** After fixing the PENDING bug, the reconciler ran twice more against the real API and
said the same thing both times:

```
  PENDING      RECOVERED  status=created paid=0 of 49900
```

Correct, and useless. I could not tell from it whether the checkout page had never been opened or
whether it had been opened and the card declined.

**Root cause:** A payment link sits at `status: created` with `amount_paid: 0` in both cases.
Razorpay has no separate status for "attempted and failed" on the link entity, so the two
situations are genuinely indistinguishable *from the link alone* — and the link was the only thing
I was looking at.

The uncomfortable part is which distinction I dropped. Rebound is a payment-failure recovery
system; a declined attempt with an `error_reason` attached is the input event of the entire
product, and the decline vocabulary is exactly what the diagnosis layer is supposed to classify. I
built a reconciler for a recovery tool that could not see a failed payment. Not a subtle gap — a
blind spot pointing directly at the domain.

**Fix:** `explainWhyNothingArrived()` now asks two sources whenever nothing has arrived: the link's
own `payments` array, and the account's recent payments joined back to this link by the
`notes.rebound_ref` we stamp on every request. That note existed for webhook correlation; this is
the second thing it has paid for. When a decline is found the run prints `error_code`,
`error_reason` and the description, and records `ATTEMPT_VISIBLE` as confirmed. When nothing is
found it records PENDING and says, in as many words, that an empty result is *consistent with*
nobody having opened the page but is **not proof of it**, because I have not yet observed a
declined attempt and do not know whether one would appear there.

Three supporting decisions worth naming. The diagnostic lives in the CLI, not the gateway:
production learns about failures from webhooks, and putting a polling query on the gateway would
imply the agent may go fishing for truth, which the architecture forbids. It degrades rather than
crashes — a test kills the list endpoint and asserts the main verdict survives, because a
diagnostic that can break the command it is diagnosing is worse than none. And the fake now models
a decline as "link untouched, failed payment on the account, nothing appended to `link.payments`",
which is a *belief* about Razorpay, labelled as one in the fixture comment.

**Lesson:** Two lessons, and the second is the one I want to keep.

The narrow one: when a provider's status field cannot distinguish two states you care about, the
answer is another query, not a cleverer reading of the same field.

The broader one is about where to look for blind spots. I found the `amountPaise` bug, the
`idempotent` bug and the PENDING bug by asking "could this label be covering two things?" — a
question about names. This one needed a different question: "what does my domain care about that
my tool cannot see?" I had tested the reconciler thoroughly against everything it did. Nothing in
a green suite, or in the name of a variable, was ever going to point at the case I had not
modelled at all. Coverage measures the code you wrote; it is silent about the code you did not
think to write.

---

## [Day 3] The diagnostic worked, and the first thing it told me was that I could not count

**Symptom:** The new decline diagnostic ran against the real API and immediately earned its
keep — `3 confirmed` where the previous run said `2`, because `ATTEMPT_VISIBLE` came back true.
There had been a real declined payment all along, invisible to every previous run:

```
ATTEMPT_VISIBLE | held=True
    failed/BAD_REQUEST_ERROR/international_transaction_not_allowed
    failed/BAD_REQUEST_ERROR/international_transaction_not_allowed
```

Then I read it twice. Two entries, byte-identical. Was the customer declined twice, or declined
once and counted twice? The HTTP log shows a single `GET /payments` and a single link fetch, so
both readings fit, and my own output could not tell me which.

**Root cause:** `[...onLink, ...matched]` — a concatenation of the link's `payments` array and the
account's recent payments, with no deduplication. If a failed payment appears in both places, and
it may well, one attempt is reported as two.

**Fix:** Merge by payment id into a map, and record which source each one came from, so the output
now reads `seen_in=link+account` and `distinct=1` rather than silently listing the same payment
twice. Two tests pin both readings: one decline visible in two places counts once, two genuinely
different declines count twice. The provenance string also settles, by observation, the question I
explicitly refused to guess at in the previous commit — whether Razorpay puts failures on the link
entity at all.

**Lesson:** The narrow version is that merging two overlapping sources is a join, and a join
without a key is a guess. But the reason this one mattered enough to stop and fix is where the
number was heading. "How many times have we already asked this customer" is a feature of the
recovery model and a term in the patience penalty. A double-counting attempt counter would not have
produced an error; it would have produced a slightly pessimistic model that looked entirely
reasonable, and I would have been tuning coefficients on top of a miscount. Diagnostics feed
features. A bug in a number is more dangerous than a bug in a code path, because numbers do not
throw.

**The finding underneath the bug, which is worth more than the fix:** the decline reason is
`international_transaction_not_allowed`. Razorpay's own vocabulary, observed rather than invented,
and it is close to a perfect illustration of this project's thesis. Retrying that same card is
futile — the probability of recovery on retry is approximately zero, because nothing about the card
or the account will be different next time. Offering a different rail, UPI or netbanking, has a
high probability of recovering the identical rupee. Same customer, same amount, same moment; two
actions whose expected values are nowhere near each other. A system that responds to failure with
"retry, back off, retry" cannot see that difference, and this is the first evidence-backed entry in
the Day 4 taxonomy rather than one I made up.

---

## [Day 3] ₹499 recovered for real, and the run could not say how

**Symptom:** Not a bug this time — the end of Day 3. A real payment link on a real Razorpay
test-mode account, paid, read back correctly:

```
  CONFIRMED    RECOVERED  status=paid paid=49900 of 49900 reference=rbd_SL1_vecheck1_58a43c528f
  3 confirmed, 0 not confirmed
```

Then I looked at what that line does and does not say. It proves a rupee moved and that my code
reads the amount back correctly. It says nothing about *how* the money arrived — and in this
particular case, how it arrived was the whole story.

The sequence on that link, from the account's own records: two card attempts, both declined with
`international_transaction_not_allowed`, followed by one success on a different rail. Same customer,
same ₹499, same link. A retry-and-back-off system would still be retrying that card, and it would
never have collected the money, because nothing about the card was going to change. Switching the
mechanism collected it on the first try.

That is the thesis of this project, and it happened by accident on a live account while I was
debugging something else. The evidence file recorded none of it.

**Fix:** `describeHowItArrived()` now runs whenever `RECOVERED` holds, identifies the captured
payment from the link's own history or from the account list, and records `RECOVERED_VIA` with the
method. If the method cannot be determined the check is PENDING, not confirmed — an unexplained
recovery is not a clean run, so it exits 2. The join logic that both this and the decline diagnostic
need is now one function, because a join written twice is a join that will diverge.

One asymmetry is worth flagging as a belief rather than a fact: the fake appends successful payments
to the link entity and appends nothing for failures. The failure half is confirmed
(`link=0 account=2`, observed). The success half is still only documented, and if a real run reports
`seen_in=account` for a capture, the fixture is wrong and this log gets another entry — I am not
going to assume symmetry, having been caught by an asymmetry twice already this week.

**Lesson:** "Measured money recovered" is a two-part claim, and I had only instrumented the first
part. The amount is the easy half; the mechanism is the half that distinguishes a decision engine
from a retry loop, and it is the half a judge will ask about. More generally: when a system's whole
argument is that *which action you choose* matters, the action taken has to be a first-class field in
the audit trail, not something reconstructable by someone willing to cross-reference two API
endpoints by hand.

Day 3 closes with the load-bearing claim proven end to end against the real API: authentication,
creation, remote idempotency, the reference join, redaction, a declined attempt with its reason, and
₹499 recovered and reconciled. What is explicitly NOT proven, and is stated on every run: that the
recovery policy is any good. That number comes from simulation, and it is next.

---

## [Day 4] The rule table classified 100% of failures and had never once said "I don't know"

**Symptom:** The diagnosis layer's first scored run reported 89.0% accuracy and an abstention rate of
exactly 0.0%. The generator deliberately gives about 12% of failures an error message chosen to be
unmatchable, so 0.0% was arithmetically impossible unless something was matching them anyway.

**First hypothesis:** The vague-message rate wasn't firing — a seeding bug in the generator, or the
vague branch never being taken.

**Root cause:** `payment_failed` was in DO_NOT_HONOUR's `reason` list. Razorpay sends
`error_reason: payment_failed` in two completely different situations: when the issuer declined for a
specific stated reason, and when there is no information available at all. One string, two meanings.
Matching it meant every uninformative failure was confidently labelled "the bank declined this," and
because the rule table returns on first match, the tier-2 classifier and the UNKNOWN fallback were
unreachable dead code. Both had been written, neither had ever run.

**Fix:** Removed `payment_failed` from the reason list. Abstention went from 0.0% to 6.8% and
accuracy went *up* to 91.3%, because the cases it had been guessing on were cases it was getting
wrong. `test/diagnose.test.js` now asserts a `payment_failed` payload abstains.

**Lesson:** A table that never abstains looks exactly like a table that is always right, and both
produce a single confident label per input. The distinguishing measurement is not accuracy — it is
the abstention rate, checked against how many cases you *know* are unanswerable. This is the sixth
time this project has been bitten by one name covering two properties, and the first time the name
belonged to somebody else's API.

---

## [Day 4] A compliance rule read 28 dead cards as suspected fraud

**Symptom:** The largest single confusion in the first scored run was 28 of 600 events where the true
cause was EXPIRED_INSTRUMENT and the diagnosis was RISK_BLOCKED.

**First hypothesis:** Overlapping error text between two genuinely similar failure classes, needing a
narrower rule for the expiry case.

**Root cause:** RISK_BLOCKED carried the text pattern `'blocked by'`, which matches the entirely
ordinary sentence "The card is blocked by the issuing bank." RISK_BLOCKED is `humanOnly: true`, so
each of those 28 cards was frozen and queued for a human to review as a suspected fraud case. A
customer whose card had simply expired would have been treated as a risk subject, and the operator
queue would fill with 28 non-incidents per batch.

**Fix:** Narrowed the pattern set to `['risk', 'fraud', 'security check', 'flagged for review']` —
phrases that only appear when a risk system is actually the thing talking.

**Lesson:** RISK_BLOCKED sits near the top of the table on purpose, because a risk hold must never be
overridden by a cheaper explanation below it. But ordering by compliance also *amplifies* compliance
false positives: the earlier a rule sits, the more traffic it sees, so a rule placed at the top must
be the narrowest rule in the table rather than the broadest. Getting the ordering right and the
patterns wrong is worse than getting neither right, because the mistakes are now systematic.

---

## [Day 4] A field commented "stripped before the agent sees it" was not stripped by anything

**Symptom:** Found by reading, not by a failing test. `buildFailurePayload()` attaches
`_generatedVague: true` to exactly those failures whose error text was deliberately made unmatchable,
with a comment saying it is removed before the agent sees it.

**First hypothesis:** None. The comment was simply false.

**Root cause:** Nothing removed it. No test enforced it. It was not in `test/boundary.test.js`'s
denylist either — because when that list was written, the field did not exist yet. This is the answer
key for the only metric Day 4 produces: an agent that reads it knows in advance which cases are hard,
can abstain on precisely those, and posts a diagnosis accuracy that no real integration could ever
reproduce. Nothing had read it yet, so nothing was wrong with the numbers. It was live ammunition
sitting in the observable payload waiting for someone to reach for it.

**Fix:** Two mechanisms, chosen because they fail differently. `src/agent/observe.js` now projects
every event through an explicit ALLOWLIST, so anything not named is dropped at runtime — including
fields nobody has invented yet. And `_generatedVague` was added to the boundary denylist, which fails
the build if agent code so much as mentions it.

**Lesson:** A denylist can only catch names somebody thought of, which makes it a poor default for a
boundary that has to hold against future edits. The allowlist stops the data; the denylist stops the
*intent*. Neither subsumes the other, and the general form is that a comment asserting an invariant
is a to-do item, not an invariant. Every "X is stripped/validated/checked elsewhere" comment in a
codebase is worth grepping for the code that does it.

---

## [Day 4] The webhook normaliser dropped the three fields its only consumer needed most

**Symptom:** Noticed while wiring diagnosis to the two paths a failure can arrive by.
`normaliseWebhook()` returned `errorCode` and `errorDescription` and nothing else about the error.

**First hypothesis:** An oversight in a rarely-touched file.

**Root cause:** The normaliser was written on Day 3, before anything consumed it, so "the error
fields" meant whatever looked like an error field at the time. The rule table matches most
specifically on `error_reason`, then on `error_source` plus `error_step` — precisely the three being
discarded. The consequence is the quiet kind: a failure arriving by webhook could only ever reach the
free-text tier, the tier a payments company can invalidate by rewording a sentence, while the
identical failure arriving through a polled API read classified at the top tier. No exception, no
warning, no reason to suspect it. Just systematically worse diagnoses on one of two code paths, and
the text tier turns out to be the worst tier there is (see below).

**Fix:** `normaliseWebhook` now returns `errorReason`, `errorSource`, `errorStep` and `method`.
`test/diagnose.test.js` asserts the *agreement property* rather than the field list — the same
failure delivered by webhook and by polling must produce the same root cause at the same match tier.
That test would have caught this; a shape assertion on the return value would not have.

**Lesson:** Writing a producer before its consumer exists means guessing at the contract, and the
guess fails silently because both sides are individually plausible. Where two code paths are supposed
to be equivalent, the test worth writing asserts they *agree*, not that each one matches a snapshot I
wrote by hand.

---

## [Day 4] Measured: the free-text tier is 0% accurate, on both splits

Not a bug — a result, and the one Day 4 exists to have produced.

`diagnose()` deliberately emits no confidence number. A confidence of 0.93 claims that in roughly 93
of 100 similar cases the answer is right, and nothing here had measured that; inventing it would mean
the expected-value engine multiplies real money by a number I made up, indistinguishable from a
measured probability in every log line. So the engine emits `matchTier` instead — an observable fact
about *how* the match was made — and `src/eval/diagnosisAccuracy.js` measures the hit rate per tier.

The first run of that measurement:

| tier | TRAIN n | TRAIN acc | TEST n | TEST acc |
|---|---|---|---|---|
| REASON | 432 | 100.0% | 378 | 100.0% |
| STATE | 4 | 100.0% | 5 | 100.0% |
| SOURCE_STEP | 8 | 100.0% | 7 | 100.0% |
| FLAG | 8 | 100.0% | 10 | 100.0% |
| DEFAULT | 106 | 94.3% | 131 | 93.9% |
| **TEXT** | **5** | **0.0%** | **13** | **0.0%** |
| NONE (abstained) | 37 | — | 56 | — |

Two things fall out of this. The precedence order I wrote from reasoning — enum beats state beats
text — is exactly the order the measurement produces, which is the cheapest possible validation of a
design decision. And the text tier is not merely weaker than matching an enum. It is wrong every
single time, 18 for 18 across both splits.

That is structural rather than unlucky. Text matching only ever runs on payloads whose reason enum
already failed to match, and that is precisely the population where the sentence is uninformative
too. Checked in isolation the text patterns classify correctly — feed one the string it looks for and
it returns the right cause. They are not wrong in principle; they are wrong on the only population
where they actually fire. Those two facts look contradictory in a summary and are both true.

I did not delete the rules, because that 0% is measured against error text I wrote myself and real
providers may phrase things more usefully. Instead a TEXT-tier match now sets
`requiresApprovalForMoneyMovement`, the same flag an LLM-tier guess gets: a belief this weak does not
get to charge a customer on its own authority. Day 6's guardrail engine reads that flag.

**Where Day 4 ends.** TRAIN 92.0% accuracy, 6.2% abstention, 10 unsafe-retry beliefs (1.7%) worth
₹11,983 of ₹64,45,145 at risk. Held-out TEST 87.2%, 9.3% abstention, 20 unsafe (3.3%) of ₹73,03,807 —
a 4.8-point generalisation gap that is published rather than tuned away. `missedHumanOnly` is 6 on
TRAIN and `falseHumanOnly` is 0, which is the safe direction to be wrong in but not a free lunch: the
6 are unflagged invoice disputes, and there is currently no observable signal that distinguishes them
from ordinary forgetfulness. Naming that is more useful than a metric that hides it.

The residual unsafe-retry risk now lives almost entirely in one place: UNKNOWN itself carries
`retryCanSucceed: true`, so every abstention permits one cautious attempt. Whether that is the right
default is a policy question, not a diagnosis question, and Day 6 owns it.

> **CORRECTION, 2026-08-24 — every number in this entry was regenerated.** Day 5's seed fix
> (`'day4' >>> 0 === 0`, see below) changed what `--seed day4` actually generates, so the figures
> above were computed on a different batch than the command now produces. They are left in place
> rather than quietly overwritten, because the point of this log is what happened. Current numbers:
>
> | | TRAIN then | TRAIN now | TEST then | TEST now |
> |---|---|---|---|---|
> | accuracy | 92.0% | 90.3% | 87.2% | 89.2% |
> | abstained | 6.2% | 7.7% | 9.3% | 7.8% |
> | unsafe retry beliefs | 10 (1.7%) | 16 (2.7%) | 20 (3.3%) | 19 (3.2%) |
> | value at unsafe risk | ₹11,983 | ₹11,529 | — | ₹73,428 |
> | missed human-only | 6 | 8 | — | 8 |
> | froze unnecessarily | 0 | 0 | 0 | 0 |
>
> **What changed:** the generalisation gap. It was 4.8 points and is now 1.2 points (90.3% → 89.2%),
> so the sentence above describing a 4.8-point gap "published rather than tuned away" is no longer
> the right size, and the honest reading is that one draw showed a wide gap and another showed a
> narrow one. That is a fact about a 600-event sample, not about the rule table, and it is the second
> time this project has been reminded that a single seed is one observation.
>
> **What survived, which is the more important half:** every conclusion the entry actually rests on.
> The TEXT tier is still 0% accurate — now 14 for 14 across both splits rather than 18 for 18. REASON,
> FLAG, SOURCE_STEP and STATE are still 100%, DEFAULT still ~93%, and the precedence order I reasoned
> my way to is still exactly the order the measurement produces. `falseHumanOnly` is still 0 and
> `missedHumanOnly` is still entirely unflagged invoice disputes. Abstention is still non-zero, which
> was the whole point of the entry.
>
> **One new thing the regenerated run shows.** On TEST, 19 unsafe-retry beliefs carry ₹73,428 of
> exposure, against 16 beliefs carrying ₹11,529 on TRAIN — a similar count holding six times the
> money. So unsafe-retry exposure is concentrated in a handful of high-value cases rather than spread
> evenly, which is a direct input to Day 6: a guardrail that gates on *value* catches most of the
> exposure while touching few cases, and a guardrail that gates on *count* does not. I would not have
> found that without being made to re-run the report.

---

## [Day 5] An identity I asserted, a residual a thousand times too large, and the error flattered me

**Symptom:** `brierDecomposition` asserted Murphy's classic three-term identity, `Brier =
reliability − resolution + uncertainty`, and expected a recomposition residual somewhere around
1e-15. The measured residual was −1.05e-3 — a thousand times too large to be floating point.

**First hypothesis:** An indexing bug. The reliability curve and the decomposition each re-derive bin
membership, so the obvious suspect was the two of them disagreeing about which row sat in which bin.

**Root cause:** The identity is exact only when every prediction inside a bin is *identical*. That is
true of a forecaster emitting a handful of discrete values — a weather service that only ever says
10%, 20%, 30% — and it is not true of a continuous model chopped into equal-count bins. Expanding
`(pᵢ − yᵢ)²` around each bin's mean prediction rather than treating the bin as constant produces two
further terms, and the textbook version silently drops both:

    Brier = reliability − resolution + uncertainty + withinBinVariance − 2·withinBinCovariance

**Fix:** Compute and report all five terms, and assert the five-term recomposition to 1e-12 in
`test/ml.test.js`. The comment that claimed an exact three-term identity now says what is actually
true and why, so the next person to read it does not have to rediscover this.

**Lesson:** The *sign* of the residual was the useful part, and I nearly did not look at it. Negative
means the covariance term dominates: even inside a single bin, the model's higher predictions still
correspond to higher observed recovery. That is genuine discriminating power which a 10-bin grouping
is too coarse to credit, so the `resolution` term was *understating* the model. The residual was
hidden resolution, not hidden error. Which is the more dangerous direction for a discrepancy to point
in, because an anomaly that flatters you is one you are inclined to accept and move on from — and I
would have, if the magnitude had been 1e-5 instead of 1e-3.

---

## [Day 5] The same report, run twice, two minutes apart, printed different numbers

**Symptom:** `npm run model-report` was not reproducible. Two runs minutes apart moved the GBM's
held-out regret from ₹1,70,078 to ₹1,77,087, and the logistic arm's ECE in the fourth decimal place —
with every seed in the pipeline fixed and every model deterministic.

**First hypothesis:** An unseeded `Math.random()` somewhere in the feature or dataset path. I went
looking for one. There wasn't one.

**Root cause:** `generateBatch({ seed, split, now = new Date() })` defaults `now` to wall-clock time.
The seeded RNG decides the *shape* of each event — cause, amount, payer type, how many days before
`now` it happened — but `now` decides where that shape lands on a calendar. Two features read the
calendar: `ageDays`, and `salaryWindowProximity`, which reads the day of the month. Shift the anchor
and those two features shift, so the recovery probabilities shift, so the Bernoulli draws shift, so
every model trains on subtly different data. An event anchored at 23:59 on the 31st and the same event
anchored at 00:01 on the 1st are not the same event.

**Fix:** `src/eval/evalClock.js` — one frozen instant, `2026-08-22T00:00:00Z`, that every evaluation
anchors to explicitly. Deliberately mid-month: anchoring on the 1st would put every generated event
inside the salary-credit window, make `salaryWindowProximity` nearly constant, and quietly destroy
the timing signal the model is supposed to learn. `evalNow()` returns a fresh `Date` each call so a
caller mutating it cannot corrupt every later evaluation. The default in `generateBatch` stays, because
it is correct for its other caller — `npm run seed` populates a database the dashboard serves, and
events dated to a hard-coded day in the past would make the UI nonsensical. The bug was never the
default; it was an evaluation relying on one.

**Lesson:** The drift was small, well under a percentage point, and that is exactly what made it
dangerous rather than tolerable. A run-to-run wobble of that size is the same magnitude as a real
improvement from a modelling change, so every A/B comparison across runs would have been measuring
the clock as much as the change. Also worth being precise about Day 4: its numbers are unaffected,
because diagnosis reads the failure payload and never reads a timestamp. That is reproducibility by
luck of what the code happens to depend on, not by design — the same bug with no consequences yet,
which is not the same thing as not having the bug.

---

## [Day 5] I watched the test set to decide when to stop training

**Symptom:** An early GBM smoke test showed the model looking excellent and still improving at round
200. Encouraging, and false.

**First hypothesis:** No hypothesis — this is the failure I did not notice as a failure. It looked
like a good result.

**Root cause:** That smoke test passed the TEST rows in as `validation`. Early stopping uses
`validation` to choose when to stop and which round to keep, so watching TEST to make that decision
makes TEST part of training. The resulting number is in-sample wearing a held-out label. When I
re-ran it with validation carved out of the *training* split instead, the boosting curve told a
different story: validation loss bottomed around round 150 at 0.3219 and then climbed steadily to
0.3253 by round 299. Textbook overfitting, plainly visible — but only because the curve was printed
per round rather than summarised into a final loss.

**Fix:** `validation` must come from the training split, documented at the parameter. Early stopping
now also *truncates* the ensemble back to `bestRound + 1` rather than keeping the extra trees and
merely reporting where the best round was — reporting it without truncating means shipping the
overfitted model and printing a note about it. On the current seed the GBM grows 209 trees and keeps
179, best round 178. `test/ml.test.js` pins `treesUsed === bestRound + 1`.

**Lesson:** Two separate things. The fix is the split, not the metric — no amount of care about which
loss you watch helps if you are watching it on the wrong rows. And a summarised final loss cannot show
you a curve that turned; the only reason this was catchable at all is that the report prints the whole
boosting history. Printing more than you think you need is how you find the thing you were not
looking for.

---

## [Day 5] Four days of "different seeds" were all the same seed

**Symptom:** A test I wrote almost as an afterthought, and nearly did not write for being too obvious
to bother with — two different seeds should produce two different train/test splits — failed. Then it
got worse: four different string seeds all derived the identical child seed, **3110982872**.

**First hypothesis:** A cache in the dataset builder, or `deriveSeed` being handed a constant
somewhere up the call stack that I had not noticed.

**Root cause:** `makeRng` and `deriveSeed` both began with `seed >>> 0`. Correct for numbers. For
strings, catastrophic: `>>>` coerces its operand with ToUint32, ToUint32 of a non-numeric string is
`NaN`, and `NaN >>> 0` is `0`.

    'day4'     >>> 0  ===  0
    'day5'     >>> 0  ===  0
    'anything' >>> 0  ===  0

So every string seed collapsed to zero and `deriveSeed(parent, label)` hashed only the label. Every
named seed used anywhere in this repo, across four days of work, produced byte-identical customers,
byte-identical events, byte-identical Bernoulli outcome draws, byte-identical fit/validation splits
and byte-identical GBM subsamples. The `--seed` flag was decorative.

**Fix:** `hashSeed()` — FNV-1a over strings, and a bit-mixer rather than a truncation for numbers, so
that adjacent integer seeds give well-separated streams (sequential seeds are the common case in a
sensitivity sweep, and mulberry32 started from adjacent state produces visibly correlated early
output). Anything that is not a finite number or a string now throws a `TypeError`, so an unhashable
seed is an error at the call site instead of a silent fall back to stream zero. `deriveSeed` joins
seed and label with a NUL byte, because plain concatenation would let `('day', '5events')` and
`('day5', 'events')` collide — a much smaller bug of precisely the same species. `test/rng.test.js`
pins all of it, including that every character of the seed contributes and not just the first or last.

**Lesson:** This survived four days because it broke the property nobody was testing while preserving
the one everybody was. Runs were still perfectly *deterministic* — `npm test` passed, the report
reproduced byte-for-byte, and the reproducibility claim in the README was true. What was silently
false was seed *variation*, which is a different property, and the one underwriting every sentence of
the form "this result is not an artefact of one particular draw." Determinism and variation are not
the same guarantee and verifying one tells you nothing about the other. A `--seed` flag that does
nothing is worse than no flag at all, because its presence invites exactly the claim it cannot
support. The general form: when a bug disables variation, every test of reproducibility passes
*harder*.

---

## [Day 5] The seed fix broke a test, and the test deserved to break

**Symptom:** With seed hashing fixed, `[SIM] a settling disputer is credited the haircut, not the
invoice` failed for the first time in four days.

**First hypothesis:** The fix had changed simulator behaviour, and the settlement path was now wrong.

**Root cause:** It had not. Nothing in the settlement logic changed — the *stream* changed. The test
drew 60 samples from `seed: 3` and asserted that at least one produced a partial settlement, which had
always depended on getting a lucky draw. Its own failure message admitted this: it read, in effect,
"if this fails, try another seed." That is a note-to-self that the assertion was measuring the seed
rather than the code.

**Fix:** Sweep seeds 1 through 12, 60 draws each, and assert the behaviour appears somewhere in the
sweep. The test now records in a comment that it passed for weeks and broke the moment `deriveSeed`
started working.

**Lesson:** A green test whose failure message tells you to change the seed was never testing what its
name claims. Note the ordering, because it is the more useful half: the seed bug was *hiding* this
brittleness, since a frozen stream makes a lucky draw look like a law. Fixing infrastructure should be
expected to expose tests that had been quietly leaning on the broken behaviour, and when it does,
those failures are findings rather than regressions. The instinct to treat a new red test as damage
caused by the fix is exactly backwards.

---

## [Day 5] The report generated its own numbers and hard-coded its own conclusions

**Symptom:** `formatFindings` printed that Platt scaling produced "a −11.0% reduction" in regret while
the table directly above it showed regret going *up*. A second finding asserted that calibration "did
NOT transfer" to the held-out split, on a run where it plainly had.

**First hypothesis:** A sign error in the percentage arithmetic.

**Root cause:** Worse than a sign error, and more embarrassing given what the function is for. The
magnitudes were computed from the run; the *verdicts* were English I had written by hand while looking
at one particular run's output. So the numbers moved when the data moved and the conclusions did not.
`formatFindings` exists specifically to stop a report drifting away from its data, and I had
reintroduced the identical failure one level up, inside the tool built to prevent it. A second,
quieter version of the same thing: the "best model" was selected by Brier while the finding text
discussed money.

**Fix:** Every verdict is now derived from the sign of the quantity it describes — `beatLookup`,
`brierHelped && eceHelped`, and so on — with the finding numbering itself computed, so a finding that
does not apply is not printed rather than printed with the wrong tense. The report now computes *two*
winners, `bestBrier` and `bestMoney`, and says so when they differ. And the arm chosen for Platt
scaling is now selected by VALID regret rather than VALID Brier, because regret is what selects the
model we ship — previously finding 4 tested calibration on `gbm` while finding 3 concluded we ship
`logistic`. Selection still never looks at TEST.

**Lesson:** Generated numbers with hand-written conclusions is a worse pattern than a fully
hand-written report, because it looks automated and audits like automation while the load-bearing
claim is still a stale sentence. If a value is computed, the verdict about that value has to be
computed from it too. The tell to watch for is any sentence in a generated report containing a word
like "improved," "did not," or "reduction" that is not sitting inside a branch.

---

## [Day 5] The model that won the leaderboard lost ₹1.5 lakh

**Symptom:** Not a bug — the day's headline result, and the reason the whole five-arm comparison was
worth building. On held-out TEST, the GBM wins on every standard metric and loses badly on money:

| arm | Brier | AUC | ECE | value captured | regret |
|---|---|---|---|---|---|
| constant | 0.09283 | 0.5000 | 0.02389 | 50.5% | ₹25,41,107 |
| lookup (GROUP BY) | 0.08797 | 0.7027 | 0.01905 | 94.0% | ₹3,07,099 |
| **logistic** | 0.08518 | 0.7502 | 0.01419 | **96.3%** | **₹1,90,825** |
| gbm | **0.08464** | **0.7539** | **0.01371** | 93.4% | ₹3,40,927 |
| oracle | 0.07218 | 0.8759 | 0.01388 | 96.8% | ₹1,66,027 |

GBM is better at predicting and ₹1,50,102 worse at deciding.

**First hypothesis:** A bug in the regret calculation. This is the reading I wanted, because the
alternative meant the metric I had spent the day building the pipeline around was the wrong metric.

**Root cause:** Both numbers are correct, and they are measuring different things. Brier, log loss,
AUC and ECE are computed over all 19,800 rows *pooled*. But an action is never selected by comparing
one case to another — it is selected by ranking the ~33 candidate actions *within a single case* and
taking the argmax expected value. Pooled metrics are structurally blind to within-case ordering. A
model can be better on average across the whole population and worse at the only comparison that
actually spends money. GBM picks the best available action on 58.8% of cases; logistic picks it on
61.6%.

**Fix:** No code fix — a decision. Day 6's engine is built on logistic, and arms are selected on
regret rather than Brier. The oracle result makes the same point from the other end: it is 49.6 points
better than GBM at *predicting* (82.2% of the learnable Brier gap captured, versus 32.6%) and only
picks the best action 67.0% of the time versus 58.8%. Enormous gains in prediction quality buy modest
gains in decision quality, because most cases have an obvious best action that a mediocre model also
finds.

**Lesson:** Measure the quantity you are going to act on. Had I stopped at the Brier table — which is
where a model comparison normally stops — I would have shipped the GBM, reported a genuine 0.6%
improvement in Brier, and lost 79% more money than necessary, with every metric on the slide
supporting the decision. There is a convenient corollary I want to flag rather than lean on: the
model that wins is also the auditable one, whose coefficients print as readable domain claims. That is
a real advantage for a system that moves money, and it would have been a *bad* argument if the
measurement had gone the other way. The argument has to run from the measurement to the choice, never
back from the choice I would have preferred.

---

## [Day 5] The same Windows path bug, in a new file, five days after I wrote down the lesson

**Symptom:** `npm test` on Windows: 245 of 246 passing, with `the simulator keeps ground truth in its
own collection` failing on `ENOENT: no such file or directory, open
'C:\C:\MohithFiles\OldLaptopFiles\Rebound\rebound\src\sim\latentTruth.js'`. Note the doubled drive
letter. On Linux the same suite was 246 of 246.

**First hypothesis:** Briefly, and alarmingly, that the boundary had actually broken — that test name
reads like the honesty guarantee failing. It was not: the other three boundary tests, including the
import-graph scan that does the real enforcement, all passed. This one test reads two files from disk
and could not find them.

**Root cause:** `const SRC = new URL('../src/', import.meta.url).pathname`. On POSIX that yields
`/sessions/.../src/`, a correct absolute path. On Windows it yields `/C:/MohithFiles/.../src/` — with
a leading slash — and `path.join` then treats it as drive-relative, producing `C:\C:\...`. The correct
form is `fileURLToPath(new URL('../src/', import.meta.url))`.

This is the *same bug* as the Day 3 entry "Worked on POSIX, wrote to C:\C:\ on Windows". I had already
diagnosed it, already written the fix, and `src/core/env.js` and `src/razorpay/cli/live-check.js`
already do it correctly — live-check even carries a comment warning about this exact trap. Then I
wrote the broken form into a new file five days later.

**Fix:** `fileURLToPath` in `test/boundary.test.js`, plus — the part that matters — a static check
that scans `src/` and `test/` and fails if any file builds a filesystem path from
`new URL(...import.meta.url...).pathname`. Deliberately narrow, so that legitimate `.pathname` on a
network URL (which the Razorpay fakes use to route requests) is untouched; a check that flagged those
would be disabled inside a week. With a negative control, because a detector that has never fired is
indistinguishable from one that does not work.

That check immediately failed on `test/boundary.test.js` itself, because the negative control had the
bad form spelled out as a string literal and the scan reads every file in `test/`. The counter-example
is now assembled from fragments at runtime. A static check that walks the tree cannot keep its own
counter-example as a literal — a small, funny constraint that I did not anticipate.

**Lesson:** Writing a lesson into a log does not prevent its recurrence. Only a check does. Both times
this bug appeared, the reason it survived was environmental asymmetry: the tests run on Linux, the
project lives on Windows, and `.pathname` is correct on one and silently wrong on the other. Any
defect that is invisible in the environment where verification happens will keep coming back no matter
how well it is documented, so it has to be converted from knowledge into an assertion. Same shape as
the seed bug: a failure that the normal test run structurally cannot see.

Second, smaller lesson about naming. This surfaced as `the simulator keeps ground truth in its own
collection` FAILING, which for a few seconds looked like the project's central honesty claim
collapsing. A test whose name asserts a guarantee will, when it breaks for an unrelated plumbing
reason, appear to disprove that guarantee. Splitting the file-reading assertions from the
boundary-enforcement assertions would have made the failure legible immediately.

---

## Day 5, addendum — I picked the model by reading the held-out test set

**Found by:** reviewing my own Day 5 report before starting Day 6, because two of its findings named
different arms and I wanted to know which one Day 6 was supposed to use.

**The symptom.** Finding 3 concluded that `logistic` was "the arm to build the decision engine on," and
added that "the argument runs from the measurement, not from the preference." Finding 4 recalibrated
`lookup`. The report recommended two different models in two adjacent paragraphs and did not notice.

**The actual defect, which is worse than the inconsistency.** Finding 3 read its conclusion off the
TEST column. TEST is the batch reserved for final reporting. Choosing a component by looking at it
converts a held-out number into a fitted one, and every subsequent figure quoted from that batch is
then optimistic by an unknown amount. The sentence claiming the argument ran from measurement rather
than preference made it worse: the reasoning after the peek was fine, and that is exactly what makes
this kind of error easy to commit and hard to spot. Being careful downstream of an illegitimate look
does not repair it.

**Why the obvious fix was also wrong.** Select on VALID instead. VALID is 120 events, and on it four
arms sit within ₹1,650 of one another. A split that small does not have the resolution to separate
them — it will still name a winner, and that winner is a coin flip wearing a decimal point. Swapping
one under-powered single split for another would have preserved the appearance of rigour while
changing nothing.

**The repair.** `src/eval/armSelection.js` and `npm run select-arm`. Twenty independently generated
worlds; inside each, a 64/16/20 fit / tune / select division. The tune split exists so `gbm`'s early
stopping has data to consult that is not the scoring set, since otherwise one arm gets to look at the
selection data and three do not. Regret is normalised per world as `regret / best-available`, because
raw rupees are not comparable across worlds whose total recoverable value differs by a factor of
several. Every comparison is paired within a world: between-world regret runs from 0.9% to 15.0%, that
spread is shared by every arm, and an unpaired comparison would mostly be measuring which worlds got
drawn. The selection rule and the tiebreak preference order were written into the file's docblock
before the sweep was first run, and the output records `selectedBy: 'measurement' | 'tiebreak'` so a
preference can never be reported as a finding.

The structural guarantee is that the file cannot generate the reserved batch at all. Not "does not" —
`test/armSelection.test.js` scans the source and fails if the reserved seed appears in executable code
or if any seed reaches the generator without a namespace prefix. Same reasoning as the ground-truth
boundary check: make the wrong thing impossible rather than merely avoided, because avoidance depends
on whoever edits the file next remembering why.

### What the sweep found, including the parts that contradict Day 5

| arm | mean norm. regret | sd | mean rank | worlds won | mean Brier |
|---|---|---|---|---|---|
| logistic | 3.52% | 3.16% | 1.90 | 7/20 | 0.09518 |
| gbm | 3.83% | 3.44% | 2.35 | 5/20 | 0.09594 |
| lookup | 3.85% | 3.15% | 1.75 | 8/20 | 0.09945 |
| constant | 52.46% | 9.42% | 4.00 | 0/20 | 0.10511 |

Paired: logistic − gbm = −0.31% ± 0.32%, t = −0.95, 14-6. logistic − lookup = −0.32% ± 0.29%,
t = −1.09, **8-11**. gbm − lookup = −0.02%, t = −0.05, 7-13. All three against constant: t ≈ −19.

**1. The selection is a tie, and is labelled one.** `logistic`, `gbm` and `lookup` are mutually
inseparable at the pre-declared |t| ≥ 2.0 bar. `logistic` was chosen by the declared preference order,
on the functional grounds that the Day 6 engine has to score candidate actions it holds few or no fit
rows for. The output says `BY TIEBREAK, NOT BY MEASUREMENT`. That phrasing is the deliverable: a
procedure that cannot separate two arms should say so rather than emit a confident ranking of noise.

**2. Day 5's headline does not replicate.** I reported that `gbm` won Brier while losing ₹1,50,102 in
regret. Across twenty worlds `logistic` wins *both* metrics and the regret gap to `gbm` is statistical
noise. The ₹1,50,102 was substantially one seed. The *mechanism* I described is still true and still
matters — Brier is pooled over all 19,800 rows while an action is chosen by ranking ~33 candidates
within one case, so a pooled metric structurally cannot see the ordering that spends money — but I
attached a general claim to a single draw and quoted the rupee figure as though it were an effect size.

**3. The ML layer does not measurably beat a GROUP BY on this generator.** Day 5's finding 1 claimed a
37.9% regret reduction against `lookup` on TEST and concluded "the model earns its place." Paired over
twenty worlds the difference is −0.32% ± 0.29% and `lookup` wins more worlds than `logistic` does.
This is the finding I least wanted and it is the one with the most evidence behind it.

### The hypothesis I formed to explain that away, and how it died

The contradiction had an appealing explanation with a real mechanism. The headline TEST batch applies
`TEST_PARAM_SHIFT`; the sweep's select split does not. A GROUP BY stores an observed rate per
(cause, action) cell, so when the population moves those cells go stale in a way more data cannot fix,
whereas a parametric model interpolates. That would have made the ML layer's value *robustness under
drift* — narrower than "more accurate," more useful, and the property that actually matters for
recovery, where the cause mix drifts constantly.

I added a shifted scoring world to test it. The regret difference moved the right way — logistic −
lookup went from −0.32% (t = −1.09) in distribution to −1.14% (t = −1.68) under shift, and the win
count flipped from 8-11 to 10-9 — and at that point the honest options were to stop or to add worlds
until t crossed 2.0. Adding worlds until a number crosses a line is not a test.

So I measured the mechanism instead. `fitLookupTable` now reports coverage: what fraction of scored
rows landed on a cell with real support, versus on a thin cell collapsed to the base rate, versus on a
cell never seen at all. **The fallback rate is exactly 0.00% on both sets across all twenty worlds, and
66 of 66 cells clear `minCount`.** `TEST_PARAM_SHIFT` perturbs the payer mix, the rate of unmatchable
error text and the amount distribution — it introduces no new cause and no new action, so the *set* of
cells is identical either side of the shift. With every cell populated there is no coverage to lose.
The hypothesis was wrong, not underpowered, and more worlds would never have revealed that; a
2,000-world sweep would have produced a significant p-value for a mechanism that cannot operate here.

A narrower version survives and this sweep cannot test it: every cell is populated, but under shift
each one averages over a different internal mix, so a stored cell mean is stale rather than missing.
Separating rate-staleness from coverage-loss needs a shift to the cause mix itself. That is a Day 8-9
sensitivity job and it is now written down as one rather than assumed.

**Lesson (statistical).** When a measured difference is not separable, the useful next move is to
measure the proposed mechanism directly rather than to buy power. The mechanism measurement here is
exact, has no standard error, cost one function, and returned a clean negative that no amount of
additional sampling would have produced. Chasing significance on the downstream symptom would have
taken twenty minutes of compute to arrive at a confident wrong answer.

**Lesson (about myself).** I generated that hypothesis immediately after the sweep contradicted my
earlier claim, and it happened to restore the conclusion I had already published in a more
sophisticated form. It was well-reasoned, it had a mechanism, and it was false. The reason it got
tested rather than written up is that the shifted set was already implemented as a comparison rather
than as a defence — but I should record that the motivation was not neutral.

### An unrelated defect the instrumentation exposed

`lookup.predictRow` returns a number for every row, including rows whose cell it has never seen — the
global base rate, indistinguishable by value from a well-supported estimate. For a scoring run that is
a nuisance. For Day 6 it is a correctness problem: "recovery is unlikely" and "I have no data" call for
different behaviour, and returning one float collapses them. The diagnosis layer already draws that
distinction and abstains; the probability layer did not, and nothing noticed until something asked for
coverage. Day 6's stopping rules have to read support, not just probability.

On this generator the gap never fires, because the cells are dense. On real data, where rare causes
meet rare instruments, it would fire constantly — so the instrumentation is not merely diagnostic, it
is the thing that will matter first outside the simulator.

### Corrections applied to earlier artefacts

- `formatFindings` finding 3 no longer names an arm for Day 6; it reports the dissociation and defers
  to `select-arm`. Finding 1 no longer says "the model earns its place" and now states that a single
  split cannot separate arms, with the sweep result beside it.
- `VERIFY.md` section 5 carries a correction on the ₹1,50,102 figure, and section 6 documents the
  sweep. The stale note claiming `--seed day6` is silently ignored is gone — it now exits 2.
- Commit `35d87f8`'s message quotes Platt parameters (a=1.1684, b=0.0407 on `gbm`) that the seed fix
  invalidated; the current run gives a=0.9196, b=-0.3294 on `lookup`. A commit message cannot be
  rewritten without rewriting history, so the correction lives here.

**Where this leaves the project's central claim.** Weaker on one axis and clearer overall. I cannot say
the ML layer beats a GROUP BY at estimating recovery probability on this simulator; on the evidence it
does not. What the probability layer has to earn its place on instead is calibration under a
value-weighted decision, the ability to score an action with few supporting rows, and an auditable
coefficient table a reviewer can disagree with. Those are Day 6 properties, and none of them is
measured by the table above. Track 3 asks for measured money recovered with compliant escalation,
stopping rules and an audit trail — not for a model that wins a Brier contest. Having the probability
estimate turn out to be the easy part is inconvenient for the story I was going to tell and probably
right about where the difficulty actually lives.

---

## [Day 6] The same bug three times: a filter that quietly included the do-nothing actions

**Found by:** writing hand-computed tests for the stopping rules and being unable to construct a case
that produced `NO_PERMITTED_ACTION`.

Three stop codes — `NO_PERMITTED_ACTION`, `BUDGET_EXHAUSTED`, `TOO_OLD` — were unreachable. So was the
`NEGATIVE_EV` blocked branch. The cause was one line in each place: a filter over scored candidates
that did not exclude the actions which collect no money. `NO_ACTION_YET`, `STOP_PERMANENT` and
`ESCALATE_HUMAN` are always available and always priced, so "are there any actions left?" was always
answered yes, and every branch downstream of "no, there are none" was dead code that no test had ever
entered.

The fix is `RECOVERING_KINDS`, and the reason it needs a comment rather than just a name is that the
mistake is conceptually seductive:

> the probability that justifies a STOP is not the probability of the action we are about to take
> (there isn't one), it is the probability of the best action we are declining to take.

Four instances of one mistake in one day. What they share is a set-membership question asked about the
wrong set — "all candidates" when the intended set was "candidates that could recover money." I have
started treating any `.filter()` over candidates as a place to state which set is meant and why, since
the failure is silent by construction: the code runs, produces a decision, and simply never reaches
the branch that would have disagreed.

**Lesson.** Unreachable code does not announce itself in a passing suite; it announces itself when you
try to write the test that reaches it and cannot. That is an argument for writing the hand-computed
test for every branch you believe exists, rather than for the branches that are convenient to reach.

---

## [Day 6] Three tests failed and the tests were wrong, which I nearly did not check

**Found by:** `node --test test/decide.test.js`.

I had asserted that the engine would choose `SEND_LINK:EMAIL`. It chose `REQUEST_REAUTH:EMAIL`. The
instinct was to fix the source, and the reason I did not is that `enumerateCandidateActions` has a
docblock saying it is *deliberately* generous — it offers a reauth request for an overdue invoice even
though that reads as incoherent, because whether it works is a measurable question and suppressing it
would answer that question by assertion. Ranking incoherent options down is the scorer's job.

So the engine was right and my expectation was a habit. Two of the three tests now assert the action
*class* (`CUSTOMER_CONTACTING.has(kind)`) rather than a specific signature, because what those tests
care about is that a message was chosen, not which one — and pinning the alphabet where the meaning is
"some customer contact" is how a test becomes a tripwire for harmless changes.

I also added a test that did not exist: that the ordering among messages tracks the response model.
Writing it exposed a bug in my own helper — I wrote `(action) => ...` where `scoreAction` receives a
single object, so every kind fell through to the default, all probabilities went flat, and the
alphabetical tiebreak picked the winner. The test passed for a reason that had nothing to do with what
it claimed to check. A constant scorer defeats the entire point of a scorer-driven ranking, and it
looks exactly like a working test.

**Lesson.** When a test fails, the first question is which side is wrong, and the answer is in the
source's stated intent rather than in my memory of it. The second lesson is narrower and sharper: a
test whose fixture accidentally makes all inputs identical will pass, and it will pass for every
future change too.

---

## [Day 6] `Platt a=1.0000 b=0.0000` — a calibration step that provably could not do anything

**Found by:** reading my own report header, because the parameters were suspiciously round.

The decide-report fitted Platt scaling on the same rows the lookup table's group means were computed
from, and printed the identity transform. This is not a bug in `fitPlatt`. It is arithmetic: a GROUP BY
predicts each cell's empirical mean, so in-sample it is *already* perfectly calibrated, the gradient of
the log-loss is zero at `a=1, b=0`, and the optimiser correctly refuses to move. The calibrator did its
job perfectly and the job was vacuous.

What makes this worth an entry is that it would have shipped. The report said "+ Platt", the numbers
were plausible, nothing crashed, and the stopping rules — which depend on the *calibrated level* of p,
not on the ranking — would have been reading uncalibrated probabilities while the header asserted
otherwise. The whole reason calibration sits at that seam is that stopping needs a level; a calibration
step that cannot move is a stopping rule with no foundation, wearing a label that says it has one.

The fix is `splitByEvent(rows, { fraction: 0.8 })` — split on **eventId**, never on rows, because all
33 rows for one event share a diagnosis, an amount and a latent payer, so a random row split puts
near-duplicates on both sides and the held-out set is held out in name only. Fitted properly:
`a=0.7364, b=-0.5789`. And a `plattIsIdentity` flag now prints `!! exactly the identity — the
calibrator saw in-sample rows and could not move`, because I would rather the next occurrence be loud
than rediscovered.

**Lesson.** Round numbers from an optimiser are a symptom. More generally: when a component's output
is suspiciously perfect, check whether it was asked a question it could not fail.

---

## [Day 6] A queue whose total contradicted its own summary table

**Found by:** comparing two numbers in my own report output — the human queue said ₹17,38,594 and the
`AWAIT_APPROVAL` bucket it was supposedly listing said ₹15,50,661.

`summariseBatch` filtered the approval queue on `AWAIT_APPROVAL || ESCALATE_HUMAN`. The second number
was correct; the queue was two different things concatenated. It also printed, as an approval reason,
the string "INVOICE_DISPUTED is a human-only cause" — which is not something a reviewer can approve.

The repair is conceptual rather than a filter change. These are two queues with two different jobs:

- **`AWAIT_APPROVAL`** — an action is already chosen, priced, and has an idempotency key minted. The
  reviewer answers yes or no in thirty seconds and the key does not change on approval.
- **`ESCALATE_HUMAN`** — there is no proposed action. A person owns the case and has to decide what to
  do. Unbounded work, different SLA.

Merging them produces a number that is useless for staffing either activity. The regression pin asserts
each queue's exposure equals its own outcome bucket, so the two can never drift apart again, and the
report prints both plus a clearly-labelled combined total.

**Lesson.** The bug was visible in the output the whole time; I found it by reading two numbers against
each other rather than by testing. That is an argument for reports that print totals which *must*
reconcile — a summary that cannot contradict itself also cannot warn you.

---

## [Day 6] The support table printed `NOT_APPLICABLE` for the entire batch

**Found by:** the report's own output being obviously wrong.

Two causes stacked. The audit record flattens `support` to a string for the trail, and I was reading it
as an object. Then, having fixed that, the table still read `NONE` for escalated cases — because I was
reading the *chosen* action's support, and an escalated case's chosen action is `ESCALATE_HUMAN`, which
by design has no probability and therefore no support. Fixed to read the best priced *recovering*
candidate: the support that matters is the support behind the estimate the decision actually rested on.

This is the do-nothing-action bug family again, in its fifth appearance and in a different disguise —
a question asked about `chosen` when the intended subject was "the best action that could have
recovered money."

**A related dishonesty, in my own prose rather than my code.** The report told the reader that
`--split=TEST` would show the fallback rate the stopping rules cope with. It does not: TEST is 96.5%
`SUPPORTED` with zero unseen cells, because `TEST_PARAM_SHIFT` perturbs the payer mix but introduces no
new cause and no new action, so the *set* of cells is identical either side of it. I had written a
verification instruction that would have produced a reassuring number and taught the reader the
opposite of the truth.

Replaced with a stated limitation and a measured diagnostic. At the shipped key granularity
`(cause, action)` there are 66 cells, 0.0% unseen, 0.0% fallback. At a granularity a real merchant
would have — `cause | action | matchTier | touchesUsed`, 408 cells — held-out rows are 0.3% unseen and
4.3% fallback. So the support asymmetry rests on its unit tests plus that 4.3% estimate, and the report
now says so instead of implying a batch demonstration it cannot give.

**Lesson.** A verification instruction that has never been run is an unverified claim with extra
authority, because the reader assumes someone followed it.

---

## [Day 6] The boundary test failed the CLI I had just finished, and the exemption I wanted was wrong

**Found by:** `test/boundary.test.js`, which asserts that `src/agent/**` never imports `src/sim/**`.

I had written the report CLI at `src/agent/cli/decide-report.js`. It has to generate a batch, so it
imports the simulator, so it broke the rule that keeps the agent unable to see ground truth.

The tempting fix was a one-line exemption — it is only a CLI, it only *reports*, it will never run in
production. Every clause of that is true and it is still wrong: the rule's value is that it is
unconditional. Grant it once for an honest reason and the next import has a precedent to point at, and
the precedent will be cited by someone who does not know why the boundary exists. Moving the file to
`src/eval/cli/` cost four minutes.

**Lesson.** When a structural rule blocks you, the question is whether the rule is wrong or the code is
in the wrong place. It was the second one, and the rule earned its keep by being annoying at exactly
the right moment.

---

## [Day 6] The finding that matters most: the simulator never reads the time a retry was scheduled for

**Found by:** an audit trail that looked fine. Case `evt_000001` ranked seven `RETRY_SCHEDULED`
candidates spanning six hours to seven days out, and every one of them scored **₹41** — an exact tie in
paise, resolved by the alphabetical tiebreak. Nothing was red. A tie that wide across a whole day of
candidate slots is not a coincidence.

`recoveryProbability` never reads `action.scheduledFor`. The funds-timing branch computes the
salary-window boost from `now` — the instant of the **decision** — which is by definition identical for
every candidate being compared against each other. So the simulator is structurally incapable of
preferring one slot to another.

Its own documentation says otherwise, in three places. `salaryWindowBoost` is described as "the largest
single timing effect in the model" and as "the mechanism that rewards RETRY_SCHEDULED over RETRY_NOW."
The funds branch says its decay is "what makes *which* scheduled slot the agent picks matter, not
merely that it scheduled at all." And `dataset.js` offers three scheduled offsets specifically so that
"the timing effect" is learnable. All three comments describe a mechanism the code does not implement.

**Measured, for a `TEMPORARILY_SHORT` payer whose salary lands in two days:**

| scheduled slot | as the dataset labels it today | if the scheduled instant were honoured |
|---|---|---|
| +6h — before the credit | 0.032094 | 0.031146 |
| +3d — just after the credit | 0.032094 | **0.800953** |
| +9d — window has decayed | 0.032094 | 0.244365 |

A 25× difference in recovery probability, on the decision the product is most distinctive about,
invisible to the ground truth every number in this repo has been measured against. Reproduce with
`node src/eval/cli/probe-timing.js`.

**Three defects, not one, and the order matters.**

1. **The simulator cannot express the effect.** `preFundsPenalty` (0.06) is levied on every scheduled
   retry including ones deliberately timed to land *after* the money arrives — the penalty for charging
   an empty account applied to a retry chosen to avoid it. That single line is why scheduling is worth
   nothing here.
2. **The shipped model key cannot learn it.** The lookup table groups on `(diagnosedCause, actionKind)`
   and all seven offsets share a kind. Fixing only the simulator would be *worse than today*: the
   engine would keep choosing timing by tiebreak against a ground truth that had started caring, so
   the loss would become real money instead of a wash.
3. **The engine's answer to "when?" is currently a string sort.** With probabilities flat, all seven
   candidates tie and the deterministic tiebreak decides. It picks the soonest slot — but only because
   `actionSignature` embeds an ISO-8601 UTC instant and ISO-8601 in UTC happens to sort
   lexicographically in chronological order. "Act as soon as permitted" is a defensible policy; it is
   not defensible to arrive at it by accident and describe it as a decision.

**A consequence for Days 8-9 that would have been invisible.** The sensitivity sweep varies
`salaryWindowBoost` over [1.6, 3.2]. If no candidate's probability moves with it, the sweep reports
"robust to this assumption" for the sole reason that the assumption cannot act. `recoveryProbability`
already refuses to default its assumption set precisely to prevent a sweep from reporting robustness it
never measured — the same file guards one route to a meaningless sweep and contains another.

**Pinned before fixed.** `test/retryTiming.test.js` — three `node:test` `todo` tests asserting the
behaviour the simulator documents and lacks, plus four passing tests pinning what must survive the fix
(a structural zero stays zero however cleverly it is scheduled; the boost cannot push p above 1; the
tiebreak's meaning; the model key's blindness). `todo` rather than a passing test of current behaviour,
because a green test asserting that timing does not matter would eventually be read as a
specification — and `todo` rather than a failing test, because a red suite trains you to ignore red.
Suite: 400 tests, 397 pass, 0 fail, 3 todo.

**Lesson.** Every one of the seven defects this day produced was found by reading output, not by
running tests — and this one was found in output that contained no error at all, just seven identical
numbers where seven different numbers were the entire point. A green suite means the code does what the
tests say. It says nothing about whether the tests, or the ground truth underneath them, describe the
problem. The most expensive errors in this project so far have all lived in the gap between a comment
asserting a mechanism and code implementing one, and the only tool that has reliably found them is
looking at the numbers and asking why they are that shape.

---

## Day 6, addendum: the timing fix, and what it revealed about every regret number I had reported

The previous entry ended with a pinned defect and three `todo` tests: `recoveryProbability` never read
`action.scheduledFor`, so every candidate was priced at the instant it was *decided* rather than the
instant it would *land*. This entry is what happened when I fixed it. The fix itself is nine lines.
The consequence is that the headline number this project had been reporting for two days was measured
on a problem roughly three times easier than the real one.

### The fix, and the part of it I nearly got wrong

The obvious change is to derive `effectiveAt = action.scheduledFor ?? now` and use it for the
funds-timing branch, so a retry scheduled to land after a salary credit stops being charged
`preFundsPenalty` for the crime of arriving before one. That much I had planned.

What I had not planned was age decay. Moving only the funds branch makes waiting **free**: the
salary-window boost appears once you wait long enough, and nothing charges you for the waiting. A
policy optimising against that ground truth learns to schedule as late as the guardrails permit,
which is not a recovery strategy, it is a stalling strategy that happens to score well. Age decay had
to move to the landing instant too, and with both moved the optimum is interior — for a credit two
days out, +3d beats both +6h and +9d. That is the shape a timing decision has to have for choosing a
slot to be a decision at all rather than a monotone preference for "later".

I only noticed because I wrote the test `waiting longer is not free, so the optimum is interior rather
than "wait forever"`, and I only wrote it because the three pre-registered `todo` tests were about the
*presence* of a timing effect and I asked what they did not cover. The pins caught the defect; they
did not specify the fix. Those are different jobs and I had been treating them as one.

Downtime moved to the landing instant as well, on the same principle: scheduling past a known outage
is a legitimate thing for a policy to do, and it was previously impossible to express.

One deliberate asymmetry. A `scheduledFor` in the past is clamped to `now`, because a stale action
arriving late is normal operations. A `scheduledFor` that does not parse **throws**, because `NaN`
propagates silently through every multiplication, `clamp01(NaN)` returns `NaN`, and the case would
then carry a probability against which every comparison is false — neither high nor low, just quietly
excluded from every decision. Silence is the worst available outcome, so it is the one behaviour
explicitly forbidden.

### The consistency argument, which is why this counts as a fix rather than a change

Two other layers already agreed with the corrected version. `src/agent/guardrails.js` evaluates
TIMING rules at the execution instant. `src/ml/features.js` computes `salaryWindow`, `delayDays` and
`isScheduled` from `action.scheduledFor`, with a comment saying the proxy is "applied to the time the
money would actually be taken, which for a scheduled retry is the future slot and not now."

So the feature builder and the guardrails were right, and the ground truth was the one layer that
disagreed. That is the worst layer to be wrong in, because everything else is measured against it: the
features were correctly describing a property of the world that the labels had been instructed not to
have.

**And here I drew the wrong conclusion, which is worth leaving in rather than editing out.** I recorded
that this voided the expensive half of the planned fix — that the model already had timing features, so
only the simulator needed changing. That is true of the `logistic` and `gbm` arms and false of the
thing that actually ships. `src/eval/cli/decide-report.js:164` builds its scorer as
`createRecoveryScorer({ model: lookup, ... modelName: 'lookup+platt' })`: the decision engine reads a
`(diagnosedCause, actionKind)` GROUP BY, and `features.js` never enters the path. Two slots sharing a
kind share a cell by construction, so no feature work in `features.js` can help it.

The audit trail says so plainly, and it is the same audit trail that found the original defect. After
the fix, case `evt_000001` still ranks seven `RETRY_SCHEDULED` candidates at exactly ₹31 each, still
resolved by the alphabetical tiebreak. The ground truth now separates those slots by up to 25x and the
agent still cannot see any difference between them.

That is precisely the failure the previous entry predicted in writing — "fixing only the loud half
would leave the engine still choosing timing by tiebreak against a ground truth that had started
caring about it, which is worse than today, since the loss would then be real money rather than a
wash." I wrote that warning, then read `features.js`, concluded the second half was unnecessary, and
walked into it anyway. The reason is instructive: I checked whether the *features* existed instead of
checking what the *engine* imported, and "the feature exists" and "the model that ships can use it"
are different claims. So part of the tripled regret below is not the problem getting harder — it is
the agent being newly, measurably wrong.

This is now the top open item. It is also why the tripling is not a reason to revert: the honest
sequence is a ground truth that models the decision, then an agent that can see it.

### The pre-registration, and how it scored

Before running anything I wrote down four predictions with a kill condition, specifically because the
log already records me forming a convenient mechanism-backed hypothesis immediately after a Day 5
defect and being wrong. The kill condition was: if |t| stays below the pre-declared 2.0, report "still
not separable" and do **not** add worlds until it crosses.

| # | prediction | outcome |
|---|---|---|
| 1 | lookup's regret worsens | Confirmed but uninformative as written — 3.85% -> 12.42%, and *every* arm roughly tripled, so it says nothing about lookup specifically |
| 2 | logistic − lookup goes below −0.32% with \|t\| > 2.0 | **Split.** In distribution −0.42%, t = −1.36: still not separable. Under shift −1.51%, t = −2.46: separable. My prediction never said which set, which is a defect in the pre-registration, not a win |
| 3 | the `salaryWindow` coefficient moves away from ~0 | **Premise falsified.** It was 0.2375 before the fix, not ~0. It did rise to 0.3953 (+66%) |
| 4 | Brier moves much less than regret | Confirmed far more strongly than intended — see below |

Prediction 3 is the one worth dwelling on, because I was wrong about the mechanism and being wrong
sharpened it. I had reasoned that if the label cannot vary with a feature, the fitted weight should be
approximately zero. But `salaryWindowProximity` was never inert: it varies **between cases**, because
different failures occur at different points in the month, and the true probability did depend on
whether *now* sat inside a credit window. What was inert was its variation **within** a case, between
candidate slots — there the feature moved and the label did not, which does not zero a coefficient, it
*attenuates* it. So 0.2375 was a blend of real between-case signal and noise-diluted within-case
variation, and 0.3953 is what it becomes when the within-case part starts carrying signal too. The
correct statement is not "the feature was dead" but "one of the two axes the feature varies along had
been disconnected from the labels", which I could not have written before measuring.

### The finding I did not predict, which matters more than the four I did

Normalised regret, 20 paired worlds, same seeds, only the simulator's timing behaviour differing:

| arm | in-dist before | in-dist after | shift before | shift after |
|---|---|---|---|---|
| logistic | 3.52% | 12.00% | 3.42% | 9.25% |
| gbm | 3.83% | 11.18% | 3.40% | 9.90% |
| lookup | 3.85% | 12.42% | 4.55% | 10.76% |

**Regret roughly tripled for every arm.** And in the same comparison Brier slightly *improved*
(logistic 0.09518 -> 0.09056).

Those two facts together are the whole thesis of this project, arrived at accidentally. Before the fix
every scheduled slot carried an identical true probability, so the candidate set contained large
groups of exact ties and picking the "wrong" slot cost nothing. Regret was low because the hardest
decision in the product — *when* to retry — had been silently deleted from the problem. Restoring it
did not degrade the models; it restored a decision they can get wrong. Meanwhile the labels became
more predictable in aggregate, because `salaryWindow` now genuinely predicts, so pooled probability
accuracy went **up** while decision quality went **down**.

Day 5 finding 2 argued that Brier and regret can dissociate because a pooled metric cannot see
within-case ordering. It argued this from a ₹1,50,102 gap on one seed that a 20-world sweep then
mostly attributed to noise. Here the two metrics move in *opposite directions* across the same
intervention, which is a far stronger demonstration than the one I originally shipped — and it is
stronger precisely because I was not looking for it.

The uncomfortable part: every regret and "share of recoverable value" figure this repo printed before
this commit was computed on the easier problem. They were not wrong arithmetic. They answered a
question about a world in which retry timing did not matter, while the write-up presented them as
answering a question about a world in which it is the central decision.

### Where the ML layer actually earns its place, stated narrowly

Under shift, logistic − lookup is −1.51% with t = −2.46 and logistic winning 15 worlds to 4. Before
the fix the same comparison was −1.14%, t = −1.68, 10-9 — a coin flip. In distribution it remains not
separable (t = −1.36), so the kill condition applies there and the honest report is "still not
separable".

The mechanism is checkable rather than asserted, and it predicts exactly that split. The fallback rate
is 0.00% on both sets with 66 of 66 cells populated, so the advantage cannot be coverage. It is
stale-mean: `TEST_PARAM_SHIFT` moves `TEMPORARILY_SHORT` from 0.24 to 0.27, and that is the *only*
payer type whose recovery probability now depends on when a retry lands. So the shift adds 12.5% more
of exactly the payers whose outcome is slot-dependent, the `(cause, action)` cell averages over a
changed internal mix and cannot follow it, and a model reading `salaryWindow` can. In distribution the
cells are fitted on the mix they are scored on, so there is little staleness to exploit — which is why
the effect appears on one set and not the other, and why that asymmetry is evidence rather than noise.

This is the "narrower version survives and this sweep cannot test it" paragraph that `select-arm` had
been printing about itself since Day 5. It can test it now, and the answer is yes.

What it does **not** establish is that ML beats a GROUP BY. The shift happens to move the population
along the one axis the features can see and the cell key cannot, which is close to the best case for
the ML arms. The claim the evidence supports is conditional: when the population moves in a way the
features can represent and the key cannot, the ML layer earns its place. That is narrower than "ML
wins" and it is what went into the report.

### Two process defects found on the way

**A pre-registration I broke by accident.** `npm run select-arm` defaults to ten worlds. The Day 6
figure came from an explicit `--seeds=20`, and VERIFY.md section 6 told readers to expect "twenty
independently generated worlds" from a command that runs ten — a documented instruction that does not
match the code, which is the same family as the unrun verification instruction in the previous entry.
Worse, I ran the default first and *saw* t = −1.98 in distribution and t = −2.22 under shift before
realising the design mismatch. Re-running at 20 restored the pre-registered design, but I had already
seen a result, and choosing between two numbers after seeing both is exactly what pre-registration
exists to prevent. So both are recorded here, and the 20-world figures are the ones reported because
20 was the design, not because of how they came out. A 6-world run, for what it is worth, separates on
*both* sets — small-n runs are noisier in the flattering direction, which is itself a reason the
default being 10 while the docs say 20 is not a harmless discrepancy.

**A report that contradicted its own numbers, for the third time.** `armSelection.js` opened its
mechanism section with the hard-coded words `The regret answer above is "not separable" on both sets`,
and concluded that "the ML layer does not earn its place on this generator by accuracy". Both were
true when written. After the fix the table two screens up said t = −2.46, separable — and the prose
still announced that nothing had separated. The narrative is now a function of the computed
separability flags, with three branches, all of which I confirmed reachable by running sweeps that hit
them. A stale hard-coded conclusion is more dangerous than a wrong number: the number carries a
standard error and invites scrutiny, while the sentence sounds like a considered judgement. This is
the third instance of this specific failure in this project, after the Day 5 "the report generated its
own numbers and hard-coded its own conclusions" and the labelled-with-data-it-had-not-used seed bug.

### What is now stale

The batch decision report moved: ACT 152 -> 159 cases, AWAIT_APPROVAL 34 -> 27, agent's own expected
recovery ₹2,20,805 -> ₹2,43,414. The money shares barely moved (16.5% -> 16.7% and 74.4% -> 74.2%),
because the seven cases that changed queue carry ₹4,193 between them. `requiresApproval` is a property
of the *chosen* action, so those seven now select a differently-priced action that does not need a
human — a benign consequence, checked rather than assumed.

`model-report` moved on every split. The one worth recording is a claim this project used to lead
with: on TEST, `logistic` used to leave ₹1,50,102 less money on the table than `gbm`, and VERIFY.md
already carried a warning that the 20-world sweep did not reproduce that magnitude and the original
write-up had leaned on it too hard. Post-fix the same gap is **₹5,249** — 1.2% of regret. So two
independent routes, a paired multi-world sweep and a change to the ground truth, arrive at the same
correction. The dissociation between Brier and regret is real; the rupee figure on one seed never was
the evidence for it, and the far better evidence is this fix, where Brier improved and regret tripled
in the same intervention.

Also stale and now corrected in VERIFY.md: the lookup arm captures 89.1% of recoverable value on TEST,
not 94%; the oracle captures 81.5% of the learnable Brier gap and picks the best action 70.8% of the
time, not 82.2% and 67.0%.

Suite is 402 tests, 402 pass, 0 fail, **0 todo**. The three pins are live assertions. Nothing else in
the suite broke, and that is worth stating: not one existing test had priced a scheduled retry, which
is precisely how a 25x effect survived 400 tests.

One near-miss worth recording, because it is the same mistake this log opened the Day 6 entry with. I
looked at the post-fix TEST table, saw `gbm 0.08163 / logistic 0.08220`, matched those against figures
I half-remembered from the old write-up, and concluded out loud that `model-report` was *unaffected* by
the fix — which would have been alarming, since `select-arm` had visibly tripled. It was a misreading:
the numbers I was matching against had never been in VERIFY.md at all. A `diff` of the two runs settled
it in thirty seconds and showed all 25 hunks changed. The lesson is not "be careful", it is that
comparing a fresh number against a remembered one is not a check, and the cheap mechanical comparison
was available the whole time.

---


### Closing the second half: the engine now scores with the arm the selection procedure names

The fix above made the ground truth care about *when* a retry lands. The engine still could not see
it, because `decide-report.js` built its scorer from the `(diagnosed cause, action kind)` lookup table.
Two `RETRY_SCHEDULED` candidates a week apart share a cause and a kind, so they shared a cell and one
rate. Seven of them ranked at exactly ₹31.

`src/agent/recoveryModel.js` now accepts either a row-based model (`predictRow`) or a feature model
(`predict` over the vector from `buildFeatures`), and `decide-report.js` passes the logistic arm. The
ranking separates immediately — ₹12, ₹11, ₹11, ₹10, ₹9, monotone in the slot, with
`SWITCH_RAIL_NUDGE:WHATSAPP` now interleaving at rank 5 instead of sitting under a block of ties.

**The engine was already correct; the seam was the lossy part.** `decide.js` had been calling
`scoreAction` with `context.now = guard.effectiveAt` — the execution instant — since Day 6, with a
docblock explaining that scoring at `now` "would price every scheduled retry as though it fired
immediately and the timing effect would vanish from the decision while remaining visible in the
training data." That is exactly what was happening, and the reason was one layer further out than the
comment was looking. Guardrails, `features.js` and `decide.js` all handled timing correctly. The
simulator was wrong (fixed above) and the seam threw the information away because the model on the
other side had nowhere to put it. Four layers, two defects, and both in the places nobody was reading.

**Probability and support now come from different models, and that is the design rather than a
workaround.** A logistic returns a confident number for a `(cause, action)` region it never saw, which
is precisely what the stopping rules exist to catch — so swapping the arm naively would have set
`hasSupport` false and escalated the entire batch while the guardrail summary still read healthy. The
logistic estimates `p`; the table reports how many rows back that region. Support answers a question
about the *training data*, not about the estimator, so the coarse instrument is the right one for it.

**What it changed in the batch.** ACT 159 → 152, STOP_PERMANENT 2 → 8, `NEGATIVE_EV` now closing eight
cases worth ₹1,535 in total. The new arm prices small, old, hopeless cases below the cost of touching
them. More stopping, not less, and on the cases where stopping is nearly free.

#### The process failure, which is the part worth keeping

This shipped wrong for six days behind a fully green suite, and I want to be precise about why rather
than filing it as carelessness.

The choice of `lookup` **was** documented, in `recoveryModel.js`, on good grounds: a 20-world paired
sweep had found no arm measurably beating a GROUP BY, so shipping a booster would have rested the
architecture claim on a difference the eval could not detect. That was right when written. It stopped
being right when the simulator changed, because the sweep it rested on had been run in a world where
the one thing a feature model can express and a GROUP BY cannot was switched off. **A justification can
expire without anyone editing it, and nothing in the repo was watching the expiry date.** That is a
more uncomfortable failure than a wrong decision, because the decision was defensible at every point.

Earlier in this same entry I wrote that the fix's expensive half was void because the timing features
already existed. They did — in `features.js`, consumed by the logistic and gbm arms, and not by the
thing that ships. I checked whether the *feature* existed instead of what the *engine imported*, having
already written down the warning that fixing only the loud half would be worse than today. The
correction is left in place above rather than edited out.

And the reason no test caught it: every test asserted the seam *could* carry a timing distinction, and
none asserted that the shipped entry point *did*. So `test/recoveryModel.test.js` now ends with a
source-level assertion on how `decide-report.js` constructs its scorer, verified by reverting the
wiring and watching it fail. Its docblock states that source-text checks are a weaker instrument than
behavioural ones and why the property being architectural makes it the right one here — the same
argument `boundary.test.js` and `armSelection.test.js` already make.

Suite 406 pass, 0 fail, 0 todo.

**Still open, small:** the belief object now carries a `timing` field (`salaryWindow`, `delayDays`,
`isScheduled`) so the audit trail can show *why* two slots differ rather than only that they do, but
`explainDecision` does not print it yet. That belongs with the Day 7 audit trail. *(Closed on Day 7 —
and printing it is what exposed the train/serve skew below. The trail deliberately does not print
`delayDays`, because that column is inert at serving; see "Landing in 0.0 days about a slot six hours
out".)*

#### A t-statistic quoted without its sample size

Closing the wiring left one loose end I only found by refusing to take a remembered number on trust.
The new source-level test fails with the message "the CLI is not scoring with the arm select-arm
selects" — a claim about what a *command prints*, so I ran the command rather than assuming it still
said what it said on Day 6.

It prints `SELECTED: logistic — BY TIEBREAK, NOT BY MEASUREMENT`, and the in-distribution regret
leader is `gbm`, not the arm that ships. Both were already recorded accurately in the Day 6 entry and
in VERIFY.md. But the shipped-arm docblock in `decide-report.js` said only "`npm run select-arm` prints
`SELECTED: logistic`", which reads as a measured win to anyone who does not run it. Truncating a
sentence at the clause that flatters you is not a wrong number, and it is not a lie; it is the way a
labelled judgement call quietly becomes a finding. Both halves of the line are now in the docblock.

The second half is worse and is mine. `recoveryModel.js` and `retryTiming.test.js` both quoted
−0.42%/t = −1.36 in distribution and −1.51%/t = −2.46 under shift with no sample size attached. Those
are the twenty-world figures. `npm run select-arm` defaults to **ten** worlds and prints −0.85%/t =
−1.98 and −2.51%/t = −2.22. I confirmed the sweep is deterministic — two consecutive runs are
byte-identical apart from the elapsed-time line — so a reader running the documented command gets
numbers that do not match the source comments and has no way to tell which of us is wrong. VERIFY.md
line 177 does say `--seeds=20`; the two source files did not, and a figure travels further than the
page it was first printed on. Every citation now carries the flag that reproduces it.

Note the conclusion is unchanged at either n: not separable in distribution, separable under shift.
That is what makes this worth writing down rather than quietly fixing. The numbers agreed, so nothing
would have broken — the failure mode is a reader losing confidence in figures that were correct all
along, which costs more than an error a test can catch.

---

## [Day 7] The loop crashed on its first real run, and 417 green tests were the reason

**Symptom:** `npm run orchestrate-report`, the first command in this project to actually run the whole
loop — decide, guardrail, execute, settle, schedule, advance the clock, repeat — threw on cycle one. An
`undefined` dereference four frames inside the simulated gateway. The full test suite had been green
before I wrote the CLI and was still green after the crash.

**First hypothesis:** a bug in the new CLI, since that was the new code. Wrong, and wrong in a way I
should have caught faster: the CLI is a hundred lines of argument parsing and printing. It called
`runCycle`, which is what everything else calls, and the crash was inside the gateway.

**Root cause:** `executeDecision` in `src/agent/orchestrator.js` built its gateway request with
`customer` and no `event`. The simulated gateway prices every outcome against the loss's own physics —
whether the card is dead, whether the mandate is revoked, how old the debt is — so it was resolving
every outcome against `undefined`.

But the missing field is not the interesting part. The interesting part is why no test noticed for a
whole day of building. `stubGateway` in `test/orchestrator.test.js` never called
`validateActionRequest` and never read `event`. **It accepted more than production accepted.** A double
that is more permissive than the seam it stands in for is not a double; it is a second implementation
with a weaker contract, and the only thing it can prove is that the code agrees with itself. Nine
orchestrator tests exercised the exact call path that crashed, and all nine passed, because the thing
they were calling would take anything.

**Fix:** three places, not one, because a single-point fix here leaves the hole open for the next field
somebody forgets.

The orchestrator now passes the event. The stub now runs `validateActionRequest` — the same function
production runs — so the double can no longer be more forgiving than the real thing. And `simGateway`
raises an explicit, named error when `event` is missing, instead of dereferencing into nothing four
frames deep.

While adding that guard I found a worse sibling and fixed it too. A *missing* `occurredAt` did not
crash at all: the case age came out `NaN`, `NaN` propagated through the age-decay term, and the report
filled with plausible-looking numbers computed from nothing. That one now raises as well. A crash costs
me twenty minutes. A silent `NaN` costs me a figure I might have put in the pitch.

**Lesson:** the value of a test double is capped by how closely it refuses things. I have written the
"my fake was right about the rule and wrong about the wording" entry once already on Day 3, and this is
the same failure with the polarity flipped — there the fake was too strict about a message, here it was
too loose about a field. The general form: **a double must reject everything production rejects, or the
tests using it are measuring a contract nobody ships.** The cheapest way to guarantee that is to have
the double call production's own validator, which costs one line and is now what it does.

---

## [Day 7] The recovery rate was true, and its denominator was doing all the work

**Symptom:** Not a crash. The first clean run reported ₹4,311 recovered against ₹11,20,352 at risk —
0.4%. I typed "0.4% recovery rate" into the report, looked at it, and could not tell whether that
number was about the policy at all.

**Root cause:** it mostly is not. Of the money at risk, 77.0% was parked awaiting human approval and
7.1% escalated, leaving 15.9% — ₹1,78,203 — that the agent was ever permitted to touch. The approval
threshold is ₹25,000 and a handful of large invoices carry most of the book, so dividing by everything
at risk is very nearly a measurement of *where I set that threshold*, not of how well the policy
chases money. The same ₹4,311 is 2.4% of the autonomous slice.

Both numbers are arithmetically correct and each one, alone, misleads in a different direction. The
total-book rate makes the policy look useless when what it is really reporting is a compliance
boundary. The autonomous-slice rate flatters the policy by hiding how much of the book needed a person.

**Fix:** the report prints the three-way exposure split — awaiting human, escalated, autonomous — above
the recovery figure, then prints the rate against *both* denominators, side by side, named. The JSON
carries all four amounts as explicit fields (`totalPaise`, `awaitingHumanPaise`, `escalatedPaise`,
`autonomousPaise`) so the dashboard I build on Day 10 cannot quietly pick the flattering one, plus
`recoveryIsSimulated: true`, `hasBaseline: false` and `selfRecoveryCounterfactualIncluded: false`.

That last flag is the one I would want an adversarial judge to see first. `checkSelfRecovery` exists in
the response model — some of these customers would have paid on their own — and this command does not
call it. So ₹4,311 has had *nothing* subtracted from it. It is not net recovery, it is not incremental
recovery, and it is not evidence the policy beats doing nothing. It is "the loop ran, and this is what
the receipts said." The comparison that would make it a claim about value is Day 8's job, and until
then the flag says so in the machine-readable output rather than only in prose I could later trim.

**Lesson:** **a recovery rate is only as honest as its denominator, and when two defensible
denominators exist the choice between them is a claim, so print both.** Reporting one and calling it
"the" recovery rate would not have been a wrong number — which is exactly what makes it the kind of
thing that survives into a pitch deck. Also worth naming: the 77% awaiting approval is not a failure
row. Track 03 asks for compliant escalation, and that percentage *is* the escalation working. I nearly
wrote it up as a shortfall before noticing I was apologising for the feature.

---

## [Day 7] "Landing in 0.0 days" about a slot six hours out

**Symptom:** I added the timing sentence to the audit trail so the decision could explain why one
scheduled slot outscored another instead of merely asserting that it did. It printed: *"this is a
scheduled retry landing in 0.0 days"* — about a retry scheduled for six hours later.

**First hypothesis:** a formatting bug. `toFixed(1)` on a fraction of a day, hours divided by the wrong
constant, something arithmetic. It was not: the value being printed really was exactly zero.

**Root cause:** a train/serve feature skew, and the sixth day of the retry-timing story rather than a
new bug. `src/eval/dataset.js` builds its feature vectors with `context.now` set to the *decision*
instant. `src/agent/decide.js` — correctly, per the landing-instant principle established on Day 6 —
scores every candidate at `guard.effectiveAt`, the instant the action *lands*. The `delayDays` column is
computed as `scheduledFor − now`. At serving, `now == scheduledFor`, so **`delayDays` is structurally
pinned at zero for every scheduled retry that has ever been scored in production.**

I wrote a probe that builds the same case's vector both ways and diffs all 140 columns. Three differ:

| column | training | serving | |
|---|---|---|---|
| `delayDays` | 0.25 / 3 / 9 | always 0 | skew |
| `ageDays` | 1.0942 | 1.5228 | skew |
| `ageDecayProxy` | 0.3348 | 0.2181 | skew |
| `salaryWindow` | proximity of the slot | proximity of the slot | consistent |

A coefficient alone does not size the damage. `node src/eval/cli/probe-coefficients.js` now prints
weight times the training range for each of these — the log-odds the model learned to spend and the
engine cannot:

```
delayDays      w=-0.0650  train range [0.000, 9.000]  swing -0.5854   PINNED AT 0 at serving
ageDays        w=-0.3265  train range [0.002, 1.462]  swing -0.4765   shifts forward at serving
ageDecayProxy  w= 0.2789  train range [0.232, 0.998]  swing  0.2137   shifts forward at serving
salaryWindow   w= 0.3953  train range [0.000, 1.000]  swing  0.3953   consistent — the control
```

So the dead column carries the **largest** swing of the four — bigger than `ageDays`, and bigger than
`salaryWindow`, which is the timing column the model leans on hardest. The model learned a real
preference for shorter delays and then, at serving, was handed a constant.

Two things keep this from being worse than it looks. `salaryWindow` reads `action.scheduledFor`
regardless of `context.now`, so it is byte-identical on both sides — which also corrects something I
had believed for a day: passing the landing instant into the scorer was *not* what made the salary
window visible to the model. That was already right. Its only measured effects were zeroing `delayDays`
and ageing the case forward. And the two remaining skewed columns are both age, moving in the direction
the delay would have moved the prediction anyway, so `delayDays` may be largely redundant with them.
May be. That is a measurement I have not made.

**Fix, and the part I deliberately did not fix.** The audit line now derives its delay from
`effectiveAt − decidedAt` — two timestamps, which cannot degenerate — and never from the feature. It
prints "landing in 0.3 days" for the six-hour slot and "landing in 2.0 days" for a two-day slot. The
docblock states plainly that `delayDays` is inert at serving rather than quietly substituting a
plausible number, because the whole point of the line is to explain a probability and a fabricated
input explains nothing.

The skew itself is open, as task #51, and that is a decision rather than a backlog accident. Two
internally coherent conventions exist: decision-time features with an explicit delay column, or
landing-time features with the delay absorbed into age. The defect is that training uses one and
serving the other. Picking either changes every trained model and every regret figure this repo has
reported, and I have already had one experience this week of a timing change tripling every number in
the project. So it goes into the Day 8 eval where its effect on recovered money can be *measured*,
pre-registered, and not selected on the held-out split — the same discipline as the original go/no-go.
Fixing it by eye tonight would feel productive and would produce numbers I could not defend.

The regression pin is the shape worth copying. It asserts **both** that `timing.delayDays` is 0 **and**
that the printed sentence says 2.0 days. Asserting only the sentence would pass in any world where the
feature and the timestamps happen to agree, which is every world except the broken one.

**Lesson:** two of them, and the second is the one I keep re-learning.

**A feature is defined by the function that builds it *and* the arguments it is called with.** On Day 6
I confirmed `features.js` computed the timing columns correctly and concluded the timing fix was
complete; the engine was importing a scoring arm that could not see them. Today I confirmed the columns
were correct again, and the *caller* was passing a different clock. Same lesson, second bill.

**Printing a number is a test.** Two of the three most consequential defects in this project were found
by rendering a value into an English sentence and noticing the sentence was false — the seven-way tie
in identical paise on Day 6, and "landing in 0.0 days" today. Neither had a failing assertion anywhere
near it. Prose has a property unit tests lack: it forces a value into a claim, and claims can be
obviously wrong in a way that a float in a table cannot.

---

## [Day 7] I wrote the coefficient into the docs from memory, and it was wrong by a third

**Symptom:** Writing up the skew above, I quoted the `delayDays` weight as −0.0490 with a −0.4286
log-odds swing, and the `ageDays` weight as −0.4385, in both VERIFY.md and this log. Then, because
VERIFY.md opens with the sentence "nothing here asks you to take a number on trust", I ran the repo's
own coefficient probe before shipping the paragraph. It prints **−0.0650**, swing **−0.5854**, and
`ageDays` **−0.3265**.

**Root cause:** the figures I remembered came from a fit I had run earlier against a different
configuration — the orchestrator path fits with `l2: 1e-4` on seed `day7`; `probe-coefficients.js` uses
`l2: 1e-3` on seed `day5`. Neither number is wrong. They answer the same question about two different
fits, and I had recorded one without recording which.

The correction also *strengthened* the finding, which is the part I want to remember. At the
reproducible numbers, `delayDays` carries the largest swing of the four columns involved — larger than
`ageDays`, larger than `salaryWindow`. I had written it up as "comparable in magnitude to `ageDays`".
Had I shipped the remembered figures, I would have understated my own defect and then been unable to
reproduce the understatement.

**Fix:** `probe-coefficients.js` gained a `TRAIN/SERVE SKEW` block that prints weight, training range
and the product of the two for all four columns, with `salaryWindow` labelled in the output as the
control. Both documents now quote that block and name the command above the numbers. A figure with no
command attached is a figure I will eventually misremember.

**Lesson:** this is the **third** time this exact failure has appeared in this project — the Day 5
"different seeds were all the same seed", the Day 6 t-statistic quoted without its `--seeds=20` flag,
and now a coefficient quoted without its `l2` and its seed. The pattern is stable enough to state as a
rule: **a number that is not printed by a command is not a finding, it is a recollection.** The fix is
never "be more careful"; it is to make the command print it, then quote the command. I had already
written that lesson down on Day 6 and still did it again on Day 7, which is the honest reason it is now
enforced by the probe rather than by my intentions.

---

## [Day 7] The agent retried an expired card three times, and the arithmetic was right

**Symptom:** Reading the audit trail of a single case in the first clean run — `evt_000020`, ₹2,977,
diagnosed `EXPIRED_INSTRUMENT` at REASON tier from `reason=card_expired` — I found three `RETRY_NOW`
attempts across three cycles, at p = 0.009, 0.007, 0.006. All three failed. Nothing was recovered.

The trail says it in its own words, which is worse than any summary I could write:

```
Tue Aug 25 03:  CASE_DECIDED   ACT -> RETRY_NOW (EV ₹19, p=0.009, bar ₹2, 23 candidates)
Tue Aug 25 03:  ATTEMPT_SETTLED  FAILED
Wed Aug 26 03:  CASE_DECIDED   ACT -> RETRY_NOW (EV ₹13, p=0.007, bar ₹2, 23 candidates)
Wed Aug 26 03:  ATTEMPT_SETTLED  FAILED
Wed Aug 26 15:  CASE_DECIDED   ACT -> RETRY_NOW (EV ₹12, p=0.006, bar ₹2, 23 candidates)
Wed Aug 26 15:  ATTEMPT_SETTLED  FAILED
```

**Root cause:** the expected-value arithmetic is correct and the policy floor is too low. I nearly
wrote this entry with hand-waved numbers — "about ₹18 gross against about ₹6 of penalty" — and then
reconstructed the decomposition properly, which produced a much sharper finding than the one I was
about to record. The case is `FAILED_SUBSCRIPTION`, contribution margin 0.75. At p = 0.006 on ₹2,977:

```
gross                 0.006 x 297700 x 0.75  =  1340 paise   ₹13.40
expected decline cost (1 - 0.006) x 200      =   199 paise    ₹1.99
                                                ----------
EV                                              1141 paise   ₹11.41
bar to act (minEvToActPaise)                     200 paise    ₹2.00
```

Look at the two constants. `failedRetryPenaltyPaise` is **200 paise** and `minEvToActPaise` is also
**200 paise**. I set the price of annoying a customer with a doomed retry to exactly the same number as
the minimum expected value required to do anything at all. So any action with more than about ₹4 of
gross upside clears the bar no matter how hopeless it is, and a ₹2,977 invoice at a 0.6% chance has ₹13.
The engine is doing precisely what it was told. What it was told is wrong.

The trouble is that "retried a card it had itself diagnosed as expired, three times" is the first thing
an adversarial judge will find in this trail, and no amount of correct EV decomposition makes that a
good look. It also points at something real rather than cosmetic: `diagnosis.physics.retryCanSucceed`
exists and the decision does not gate on it. A near-zero probability and a *structurally impossible*
action are different states, and the engine currently treats the second as a small version of the
first.

**Fix:** none yet, deliberately — logged as task #52, blocked on the Day 8 eval. Three candidate knobs
would each suppress this: raise `failedRetryPenaltyPaise` so a decline costs what annoying a customer
actually costs, raise `minEvToActPaise` off the floor, or add a hard physics gate that refuses retries
when `retryCanSucceed` is false. They are not equivalent — the first two are prices and the third is a
prohibition — and choosing by taste is how a policy accumulates knobs that were tuned to make one trail
read nicely. The sensitivity sweep is where that choice gets made, with `failedRetryPenaltyPaise` swept
widest because it is the one I have the least evidence for.

---

## [Day 8] 9.6% of the portfolio was paid before the agent woke up, and fixing it flatters me

**This entry is a PRE-REGISTRATION. It is written before I have run the arm comparison, and it says
what I expect the change to do and which direction that benefits me. If you are reading the Day 8
results, read this first and then check whether the entry that follows kept its word.**

**Symptom:** before wiring `checkSelfRecovery` into the run loop I probed whether self-recovery even
fires inside the 3.5-day run window. It does — and mostly before the agent gets a turn:

```
cases with willSelfRecover                        14 / 80   (17.5%)
of those, selfRecoverAt ALREADY PAST at run start  10 / 14
selfRecoverAt minus run start, days:
  min -17.46   p25 -6.84   median -3.01   p75 1.35   max 6.70
self-recovering exposure at cycle 0            ₹1,07,871
self-recovering exposure by cycle 7            ₹1,21,056
total portfolio exposure                       ₹11,20,352
agent recovery, same world (Day 7 figure)          ₹4,311
```

₹1,07,871 resolves itself at cycle 0, before any policy acts. That is 9.6% of the whole portfolio and
**25 times** what the agent recovers. Had I wired self-recovery in without looking, `B0_DO_NOTHING`
would have posted a six-figure recovery, every active arm would have inherited the same six figures for
free, and the incremental column — the entire point of the exercise — would have been ₹4,311 of signal
sitting on top of ₹1,07,871 of noise common to all five arms.

**Root cause:** two lines of the generator, each reasonable, jointly incoherent.

```js
const occurredAt   = new Date(now.getTime() - ageDays * DAY_MS);          // generator.js:400, ageDays ~ U(0.2, 21)
latent.selfRecoverAt = new Date(occurredAt.getTime() + rng.float(0.5, 12) * DAY_MS);   // generator.js:537
```

`ageDays` runs to 21 days; the self-recovery delay tops out at 12. So a case that failed 20 days ago
gets a `selfRecoverAt` up to 19.5 days in the past. Stated in English, the world is asserting: *this
customer paid you seventeen days ago, and the invoice is still sitting in your open-recovery queue.*
Those two facts cannot both be true. A case that self-recovered would have closed.

The bug is not the 12-day window and it is not the 21-day history. It is that **the queue is a
survivorship-conditioned sample and the generator draws as if it were not.** Our input is the set of
losses *still unpaid at `now`*, and conditioning on that removes precisely the fast self-recoverers.
This is length bias, the same effect that makes the average bus wait longer than half the average
headway.

**Fix (pre-registered, and the arithmetic committed to before measuring):** draw the latent from the
conditional distribution the queue actually implies. With `q` the unconditional propensity and
`d ~ U(0.5, 12)` the delay, a case is observed only if it did *not* already self-recover, so

```
pOutlasts = P(d > ageDays)  = clamp01((12 - max(0.5, ageDays)) / 11.5)
qGivenOpen = q*pOutlasts / (q*pOutlasts + (1 - q))            <- Bayes
d          ~ U(max(0.5, ageDays), 12)                         <- truncated, so selfRecoverAt > now always
```

Note this is *not* merely rescheduling the same 14 cases into the future. It correctly makes an old
case **less likely to be a self-recoverer at all**, because its continued existence in the queue is
evidence against it. For `ageDays >= 12` the posterior is exactly zero: the whole window elapsed and
they did not pay. That is 43.3% of the batch.

Predicted effect, computed analytically before running anything (`/tmp/survival.mjs`, reproduced in
`test/generator.test.js`): the posterior lands at **0.29–0.33x** the unconditional rate across every
loss-type/payer-type cell, so **14 self-recoverers becomes about 4.3**, all of them firing inside the
window rather than before it.

**The part I have to say out loud: this change moves in my own favour, and I noticed that before I
made it.** It cuts B0's recovery by roughly two thirds. B0 is the baseline my policy is measured
against, so weakening it inflates my headline incremental figure — and I am the one who decided the
generator was wrong. That is exactly the shape of [the Day 5 addendum
mistake](#day-5-addendum--i-picked-the-model-by-reading-the-held-out-test-set): the hypothesis that
happens to restore the flattering conclusion is the one that gets the least scrutiny.

Three constraints I am binding myself to, before any number exists:

1. The justification is **world semantics, not results.** It stands or falls on whether a paid invoice
   can sit in an open queue. It cannot, so the fix is right even if it hurt me.
2. Day 8 reports B0 under **both conventions** — `STALE` (current: self-recovery may precede run
   start) and `SURVIVED` (conditioned). A reader gets to see exactly what the choice bought me.
3. The prediction above is on the record. If the measured drop is not near 0.29–0.33x, my model of the
   world is wrong somewhere else and the discrepancy is the finding.

**A second defect found in the same block, unrelated but worse:** `baseSelf` in the generator is
`{0.18, 0.12, 0.25}` — character-for-character `ASSUMPTIONS.selfRecoveryRate`, and a *copy*. Nothing
connects them. That assumption's own `basis` field reads "Load-bearing for the B0 baseline: set it high
and every policy looks less impressive," and `perturbAssumptions` dutifully perturbs it. So the Day 8
sensitivity sweep would have swept the single assumption most able to embarrass this project, printed a
result for it, and moved nothing at all. Logged as #59, fixed alongside this, with a test that doubling
the rate must produce strictly more self-recoverers — and with the wiring verified as a byte-identical
no-op first, so the refactor and the sensitivity result cannot be confounded.

**Lesson:** three, and the middle one is the one I did not expect to find.

**A stopping rule whose floor equals its own penalty is not a stopping rule.** ₹2 to act and ₹2 to fail
means the two constants cancel and the policy reduces to "act if gross upside exceeds roughly twice the
penalty" — which on a mid-sized invoice is satisfied at well under a 1% success chance. Two numbers that
happen to be equal because I picked both by feel on Day 6, and their equality is doing more work than
either of them individually.

**Reconstructing the arithmetic beat asserting it, again.** I had "about ₹18 against about ₹6" in the
draft and it was plausible enough that I nearly shipped it. The real decomposition is ₹13.40 against
₹1.99 with a 0.75 margin, and it exposed the equal-constants coincidence that the wrong numbers hid.
That is the second time in one entry-writing session that computing something I could have estimated
turned a vague observation into a specific defect.

**The case worth reading in any batch output is not the aggregate, it is the single trail an opponent
would quote.** I found this by printing one case's full lifecycle into the report and reading it as a
story, which is the same technique that found the two defects above. Aggregates hide the embarrassing
case; that is what aggregates are for.


---

## [Day 8] The agent was a perfect procrastinator, and it audited beautifully while doing nothing

**This entry is a PRE-REGISTRATION. It is written before the fix exists and before any post-fix number
has been printed. It says what I expect, how much, what would falsify it, and — the part that matters —
which direction the error runs. If you are reading the Day 8 results, read this first and then check
whether the entry that follows kept its word.**

### The symptom, and why every report I had built was blind to it

The approval-gate delta came out *bit-identical* at 8 cycles and at 20 cycles: pooled ₹1,89,319 both
times, in all five worlds, while grants nearly tripled. I first read horizon-invariance as good news —
evidence the approver's value was real and not a function of how long I let the clock run. Then I asked
why more clock bought literally nothing, and instrumented attempts instead of money:

```
seed w01, 16 cycles x 12h, 80 TRAIN cases, g120

  cyc 10-15:  DUE 51   DECIDED 51   ACT ~51   WAKEUPS ~51   ATTEMPTS 0   recovered Rs 0

  CASE_SCHEDULED events: 796   ATTEMPT_STARTED events: 78
  ratio: 10.2 schedulings per attempt
  most-rescheduled case: 16 times   median: 15
  59 of 80 cases still SCHEDULED at the end

  evt_000003  Rs 16,721.00  attempts=0
    03-02T09:00  SCHEDULED -> wake 03-02T15:00 (+6.0h)  ev=Rs 6,385.63  RETRY_SCHEDULED:...
    03-02T21:00  SCHEDULED -> wake 03-03T03:00 (+6.0h)  ev=Rs 5,907.94  wakeAt slid +12.0h
    ...  fourteen more, +6.0h every single time  ...
    03-09T21:00  SCHEDULED -> wake 03-10T03:00 (+6.0h)  ev=Rs 2,997.65  wakeAt slid +12.0h
    --> 16 schedulings, 0 attempts
    --> distinct intents across those schedulings: 1 (THE SAME ONE, re-armed)
```

**Mechanism.** `POLICY.candidateRetryOffsetsHours` starts at 6, and the recovery model says P(recover)
rises with retry delay at that granularity. So EV(retry in 6h) > EV(retry now) — at *every* instant.
The case wakes at its own scheduled time, `runCycle` re-decides from scratch (deliberately: the #37
landing-instant principle, so a three-day-old belief never authorises a charge), the same inequality
holds because nothing about it depended on the clock, and it arms another +6h wakeup. **A
time-invariant preference for waiting never resolves.** The action is permanently imminent and never
happens. Note the EV decaying ₹6,385 → ₹2,997 down that trace: the agent could see itself getting
poorer by waiting and still chose to wait, because it was comparing "now" against "six hours from now"
and never against "ever".

**Why it hid for two days, which is the part worth keeping.** Offsets start at 6h and the cycle step is
12h, so a case deferred +6h *is* legitimately due next cycle. Nothing looks wrong from outside: queue
depth is healthy, the audit trail shows diligent 12-hourly re-decisioning with full EV decomposition on
every row, guardrail violations are zero, the action mix is sensible, and the recovery figure is merely
*small*. **It reads as a cautious policy rather than a broken one** — and "cautious" is exactly the
adjective I wanted to be able to claim, so I had no instinct to look harder.

**What actually exposed it: money per cycle cannot distinguish "we tried and failed" from "we never
tried."** Every report in this repo printed money. Counting `ATTEMPT_STARTED` per cycle took four lines
and broke the case open immediately. Every money figure from here on gets an attempt count beside it.

**And the humbling detail.** `applyNonActingOutcome` already contains this comment, written by me on
Day 7, about the `Outcome.WAIT` branch: *"So the case would be re-decided immediately, decide to wait
again, and spin. Falling back to the next cycle boundary makes the degenerate case merely slow instead
of infinite."* I identified this exact failure mode, guarded the branch I was looking at, and never
asked whether the neighbouring branch — `scheduleAction`, the RETRY_SCHEDULED path — had the same hole.
It did. **Reasoning about a failure mode in one branch does not immunise the file.**

### The fix I am committing to before I measure it

**A deferral is a commitment, not a preference.** When a case is woken at an instant it chose for
itself, the candidate set excludes deferring the same class of action any further: it must act, escalate,
or stop. Re-decision is preserved in full — the belief, the guardrails and the approval envelope are all
re-evaluated at the landing instant, exactly as #37 requires — but the agent is not permitted to spend
its own wakeup re-arming that wakeup. Plus `POLICY.maxDeferralsPerCase` as a hard backstop with its own
named audit event, so the invariant holds even if some path I have not thought of reaches the same loop
from another direction.

Two designs I considered and rejected. A **discount rate on delayed EV** is the textbook answer and
would fall out of the arithmetic cleanly, but it requires a discount rate I cannot justify from anything
in this project — I would be picking a number by feel to fix a bug, and this log already has one entry
about two constants I picked by feel cancelling each other out. **True optimal stopping** is correct and
is a week of work I do not have.

### Predictions, on the record, before the fix exists

Sharp (mechanism — these should be near-deterministic, and I expect to be held to them):

1. `(CASE_SCHEDULED + CASE_WAITING) : ATTEMPT_STARTED` falls from **10.2 to below 3.0** in all five
   worlds. Both event types counted, deliberately: fixing the retry path and displacing the loop into
   the WAIT path would be the obvious way to satisfy a narrower metric while changing nothing.
2. Cases still `SCHEDULED` at the horizon falls from **59/80 to under 25/80**.
3. No case defers the same action class more than `maxDeferralsPerCase` times, and every case that
   defers at all either attempts or reaches a terminal state inside the horizon.

Directional (money — softer, and I am committing to a band so I cannot claim a hit either way):

4. Attempts roughly **double to triple** (78 → 150–250 on w01/16 cycles).
5. Recovered money **rises**, and I predict the day7 g120 figure moves from **₹12,300 to somewhere
   between ₹60,000 and ₹2,50,000** — a 5x to 20x band. Wide because I genuinely do not know; stated
   anyway, because a prediction I cannot miss is not a prediction.

### Falsifiers, and both of them are informative

- **If the ratio drops below 3 and money does NOT materially rise**, the deferral loop was not what was
  suppressing recovery, and ₹12,300 is close to this policy's real ceiling on this world. That is a far
  worse finding for Rebound than the bug is, and it would need to be reported as the headline.
- **If money goes DOWN**, then the deferrals were partly earning their keep — the timing edge that Days
  5–7 are built on is real and I have just blunted it by forcing act-or-stop at an arbitrary instant. In
  that case the correct fix is the *budget* alone (`maxDeferralsPerCase`, letting the agent defer a few
  times and then commit) rather than the hard commitment rule, and I will say so rather than keeping the
  version that produced the bigger number.

### The direction of the error, stated plainly because it flatters me

**Every recovery figure this project has produced came from an agent that mostly never acts.** The
₹12,300 on the g120 day7 world, the ₹1,89,319 pooled approval delta, the "approval value is
horizon-invariant at 1.00x" finding — all of them artifacts of a stationary loop, and all of them
*understating* Rebound. Fixing this makes my numbers go up. That is precisely why the prediction above
is written down before the fix runs: a large improvement I predicted in advance is evidence, and the
same improvement announced afterwards is a number I went looking for.

**And the caveat that survives the fix.** This bug suppresses *every* arm, not just mine. `B1_NAIVE_RETRY`
never defers at all, so it was never in the loop — which means the pre-fix comparison would have made a
naive baseline look competitive with an EV policy for reasons having nothing to do with either policy.
The post-fix number is not a win on its own. **The comparison that matters (#57) is arm against arm
after the fix, in the same worlds, paired** — never before against after.

### Reproduce

```
node --test test/*.test.js                       # test/deferral.test.js — 4 tests fail before the fix, 7 after
PROBE_SEED=w01 PROBE_CYCLES=16 node probe-spin.mjs   # ratio, before and after
npm run orchestrate-report                       # the day7 g120 headline, with attempt counts
```

---

## [Day 8] The commitment rule, graded: three predictions hit, one missed, and the miss was my instrument

The fix is in and measured. Grading against the block above, in the order it was written, before any
commentary — and one of the four sharp predictions **failed**.

| # | prediction | result | |
|---|---|---|---|
| 1 | postpone:attempt ratio **< 3.0** in every world | 0.90, 0.99, 0.91, 0.97, 0.97 — worst **0.99** | **PASS** |
| 2 | cases still `SCHEDULED` **< 25/80** in every world | 34, 35, 38, 36, 36 — worst **38/80** | **FAIL** |
| 3a | same-class deferrals ≤ `maxDeferralsPerCase` | exactly **3** in all five, cap 3 | **PASS** |
| 3b | every postponing case attempts or terminates in-horizon | **0** never resolved (was 39–53) | **PASS** |

Paired, same seeds, same 16×12h horizon, grant-everything approver so the gate could not confound it:

| seed | postpone:attempt | cases stuck | never resolved | money recovered |
|---|---|---|---|---|
| day7 | 10.26 → **0.90** | 59 → 34 | 39 → 0 | ₹14,760 → **₹2,33,442** |
| w01 | 10.63 → **0.99** | 59 → 35 | 39 → 0 | ₹1,57,444 → **₹4,95,716** |
| w02 | 11.73 → **0.91** | 60 → 38 | 46 → 0 | ₹41,196 → **₹3,34,478** |
| w03 | 17.58 → **0.97** | 64 → 36 | 53 → 0 | ₹1,511 → **₹4,97,536** |
| w04 | 15.74 → **0.97** | 65 → 36 | 52 → 0 | ₹5,880 → **₹5,48,007** |
| **pooled** | **12.76 → 0.95** | | **230 → 0** | **₹2,20,791 → ₹21,09,179** |

Directional predictions 4 and 5: attempts per world 236–272 against a predicted band of 150–250, so
**four of five inside the band and one above it**. Money pooled **9.55x** against a predicted 5x–20x
band, and up in **5 of 5** worlds.

**How the money figure must be quoted, because the obvious way is misleading.** Per-world ratios are
3.15x, 8.12x, 15.82x, 93.2x, 329.3x — and the two enormous ones are enormous because the pre-fix
denominators were ₹5,880 and ₹1,511. A 329x is not a finding, it is a division by something close to
zero. The defensible statement is the paired delta: **every world gained between ₹2.19L and ₹5.42L,
pooled +₹18.88L.** Quoting "up to 329x" would be true, arithmetically correct, and dishonest.

### Prediction 2 failed, and the reason is that I measured the wrong thing

34–38 of 80 cases still end `SCHEDULED`. I predicted under 25. The tempting move here is to note that
59–65 → 34–38 is a big improvement and treat the threshold as roughly met. That is exactly the move the
pre-registration exists to prevent, so: **prediction 2 is a miss.**

Then I measured *why*, with `probe-stuck.mjs`, rather than reasoning about it. Decomposing the stuck
cases across three worlds:

| | day7 | w01 | w02 |
|---|---|---|---|
| end `SCHEDULED` | 34 | 35 | 38 |
| holding a pending retry deferral | **0** | **0** | **0** |
| waiting on a guardrail (the `WAIT` path) | **34** | **35** | **38** |
| of those, never attempted anything | **0** | **0** | **0** |

Every single one is a quiet-hours `WAIT`, on a case that had already attempted at least once. Not one
holds a deferral.

**`CaseState.SCHEDULED` is written by two paths and I only reasoned about one.** `scheduleAction` writes
it for a chosen `RETRY_SCHEDULED` — the deferral this fix is about. `applyNonActingOutcome` writes the
same state for `Outcome.WAIT`, a guardrail deferral that resolves on its own when the clock moves. My
threshold could not tell them apart, so it was never a measurement of the spin loop.

It is worse than merely ambiguous. The run's last cycle is `startAt + 15×12h` = **21:00 UTC = 02:30
IST**, inside quiet hours. Ending a run in the middle of the night *guarantees* a large residue of
cases correctly waiting until 09:00. I was measuring the calendar.

The quantity I actually meant is prediction 3b — postponed, never attempted, never terminated — and it
went **39–53 → 0 in all five worlds**. That is the claim, it passed, and it is the one to quote.

**The lesson, and it is a variant of one already in this log.** A threshold is only as good as the
uniqueness of the state it names. `SCHEDULED` looked like a specific fact and was a union of two
mechanisms. Before pre-registering a threshold on a state, check how many code paths can write it — the
same shape as the earlier finding that money-per-cycle cannot distinguish "tried and failed" from "never
tried", which is why every money figure in this log now carries an attempt count. I did not carry it
across to state counts.

**Consequence for #62.** The horizon must end on a cycle that is not inside quiet hours, or the metric
must be attempt-based rather than state-based. An odd number of 12h steps from a 09:00 UTC start always
lands at 21:00 UTC, so this affects every figure I have quoted for cases-in-flight.

### What mutation testing found, including two things nothing was guarding

Five mutations. Three bit immediately; **two did not**, and both mattered.

- `nowMs >= wakeMs` → `>`: 2 fail. The on-the-dot wakeup is the common case, not an edge case.
- BUDGET branch disabled: 1 fail.
- withholding ignores the action class (the over-broad fix): 2 fail — the scoping test earns its keep.
- **the consumed wakeup is never cleared: 0 fail.** All 461 tests green against a build where a case
  that deferred once could never schedule again for the rest of its life. `maxDeferralsPerCase: 3`
  would have been a number no case could reach, I would have shipped "one deferral per case, ever"
  while reporting a cap of three, and #58 would have swept a knob that does nothing. The postpone:attempt
  ratio would have looked *better*. **A bug that improves the headline metric will not be found by
  reading the headline metric** — the second time this project has met that shape.
- **the cap raised to 999: 0 fail.** Correct of the budget test, which reads the cap from `POLICY` so it
  survives #58's sweep. But it left nothing asserting the cap is *reachable*, and a backstop set beyond
  any realistic horizon is decoration.

Both gaps are now closed by tests 6 and 7, which assert properties rather than values: no cycle may end
holding a wakeup in its own past, the class must be deferrable more than once, and `COMMITMENT` must
fire before `BUDGET` inside a ten-cycle run. Suite: **463 tests, 463 pass.**

### What the fix does not settle

- **The comparison still has not happened.** Every number above is before-vs-after on one arm, which is
  the comparison the pre-registration explicitly warned against treating as a result: *"The comparison
  that matters (#57) is arm against arm after the fix, in the same worlds, paired — never before against
  after."* That still stands, and one clause of the pre-registration needs correcting: I wrote that "this
  bug suppresses every arm, not just mine." It does not. Only the EV arm chooses `RETRY_SCHEDULED` from
  the offset list; `B1_NAIVE_RETRY` and `B2_AGGRESSIVE` retry immediately and never defer, so they were
  never in the loop and never suppressed. The suppression was **asymmetric and against my own arm**,
  which makes the pre-fix ₹12,300 headline an understatement of Rebound specifically — and makes it even
  less legitimate to read any advantage out of the before/after table. #57 is the only thing that can
  say whether the EV policy beats a naive one.
- **The commitment rule is cruder than a discount rate**, and I still think a discount rate is the
  better long-run answer. It stays out because choosing its value by feel and then reporting the money
  that value produced is not a measurement. The hard limit is auditable: a reviewer can count deferrals
  in the trail and check the rule held.
- **#52 needs re-reading.** Some of what I filed as "the agent retries hopeless instruments because the
  EV bar is only ₹2" may have been the loop, not the bar. Attempts went 332 → 1,241; whether the new
  ones are worth making is a different question from whether they happen.


## Day 8 — #57, the five-arm paired comparison, and the two bugs that voided every figure I had

`npm run eval` is the Track 03 headline command: five policies, the same worlds, the same luck, one
scorer. Five worlds x 80 cases on the held-out TEST split, 21 cycles x 12h = 10 days, ~57s, exit 1 if
any invariant fails. The command was the easy part. Getting a number out of it that I am willing to
defend took two fixes, and **both of them had been moving the headline in my favour.**

### Bug one: B3 fired one retry and stalled for nine days

The first full run looked spectacular. Rebound ahead of the honest baseline in 5 of 5 worlds, mean
+Rs 18,183 incremental, pooled 1.81x. I went looking for why B1 and B3 recovered *identical* gross
money in two of the five seeds, which should not happen between a one-shot retry policy and a
five-rung ladder.

`probe-ladder.mjs` printed the actions-per-case histogram for B3: `{"1": 65}`. Sixty-five of eighty
cases received exactly one action across a ten-day horizon, and 55 cases ended terminal in SCHEDULED.
`probe-b3stall.mjs` dumped every decision for one case and showed the mechanism — eleven decisions,
each one choosing `RETRY_SCHEDULED` for `now + 24h`:

```
cycle=1  at=2026-08-24T21:30:00Z  chose RETRY_SCHEDULED for 2026-08-25T21:30:00Z
cycle=2  at=2026-08-25T09:30:00Z  chose RETRY_SCHEDULED for 2026-08-26T09:30:00Z
cycle=3  at=2026-08-25T21:30:00Z  chose RETRY_SCHEDULED for 2026-08-26T21:30:00Z
```

B3 anchored its "+24h" rung to `now`. The orchestrator correctly treats a future `RETRY_SCHEDULED` as
a wakeup and re-decides when it lands — so every re-decision produced a *fresh* +24h, `retriesUsed`
never incremented, the rung never advanced, and **zero scheduled retries ever executed.** The ladder
was a treadmill.

Fixed by anchoring the rungs to the instant the payment actually failed, derived from
`caseState.ageDays`, and materialising a rung whose due time has passed as a plain `RETRY_NOW`. The
anchor comes from `ageDays` rather than off the observation deliberately: the guardrail engine ages
the case by `ageDays`, and a ladder anchored to a different instant than the rules are enforced
against would drift apart under exactly the conditions nobody tests.

Seed 2 after the fix: 83 -> 296 actions, 51 of 80 cases reaching all five rungs, 50 STOPPED,
recovery Rs 7,187 -> Rs 14,987. **B3 more than doubled.**

**Why this was the worst kind of bug.** A crippled B3 recovers less, which *inflates* Rebound's
margin. The headline moved in the flattering direction — the direction that does not prompt anyone to
look. "Rebound beats the honest baseline in 5 of 5 worlds" was, until this fix, a win over a baseline
that fired one retry and went to sleep. Re-measured on a working B3: **4 of 5 worlds, mean
+Rs 11,168, pooled 1.38x.** That is the number.

**Why 32 unit tests and 8 mutations missed it.** Every test asked "given this state, what does B3
choose?" and B3 always chose correctly *for that state*. **No unit test on a single decision can see
a policy that never advances.** The fix ships with trajectory tests — run the arm for a full horizon
and assert progression: at least a quarter of cases must get past rung 2, and no arm may leave the
majority of its cases frozen in OPEN or SCHEDULED. One of them fails against the old code.

This is the sixth time a bug that flattered the headline metric was not found by reading the headline
metric. The pattern is now explicit in my process: when a result improves, find the mechanism before
believing the number.

### Bug two: two money columns on two different bases, printed side by side

With B3 working I read the per-world table again and found B1 in seed 5 showing **net Rs 77,454
beside incremental Rs 49,550**. Net is after costs. It cannot exceed the money it is derived from.

It was not an arithmetic error. `netPaise` was margin-weighted **gross** recovery minus costs, while
`incrementalPaise` nets out B0's counterfactual. Different bases. They diverge precisely when an arm
*cannibalises* self-recovery: B1 reached cases first and the world's realised self-recovery collapsed
from Rs 35,246 under B0 to Rs 1,585. So B1's gross was full of money that was coming anyway, and the
gross-basis net proudly reported all of it.

Two adjacent money columns on two different bases is a misread waiting to happen, and the larger
number was the wrong one. Added `netIncrementalPaise`: margin-weighted (agent + self) money, minus
the margin-weighted counterfactual, minus costs — every rupee weighted at **its own case's** margin
on both sides of the subtraction, not at an arm-level average. B0 now nets to exactly 0 by
construction, which is the check that the counterfactual is being subtracted on the basis it was
measured on.

### And a false claim sitting in a docblock and a test title

While fixing that I re-read `poolAcrossWorlds` and found it asserting that the incremental paired
difference is "identical to the gross one, because the counterfactual cancels" — with a passing test
titled the same way. The test passed because its fixture had equal self-recovery on both arms.

The general claim is false. B0 cancels; the self term does not:

```
incremental(A) - incremental(B) = (rec_A - rec_B) + (self_A - self_B)
```

Measured on the five-world default: gross mean +Rs 11,398 against incremental mean +Rs 11,168. The
test is now titled for its precondition and is joined by a hand-computed counterexample where the two
differences have **opposite signs** — an arm 3 lakh ahead on gross and 2 lakh behind on incremental.
A comment that tells a reader "you can ignore this column" is worse than no comment.

### What the run reports, and the two columns that are not cross-arm comparable

Both discovered by reading my own first output and finding it misleading.

- **`refused`** counts refused *candidates*, and the arms enumerate wildly different numbers of
  candidates per cycle — Rebound prices the whole action space, B1 considers one thing. Rebound's 488
  against B3's 106 would read as "4.6x more restrained" and means nothing of the sort. Its honest use
  is the zero test: non-zero is evidence the guardrail engine binds on this arm at all. `quiet!`,
  `cap!` and `ABS!` *are* comparable — they count rules actually broken by actions actually taken.
- **Horizon truncation flatters Rebound.** My first smoke run at `--cycles=7` had every baseline at
  exactly Rs 0 and Rebound at Rs 1,222, because 3.5 days cuts off arms that *space* their attempts.
  The report now prints a HORIZON TRUNCATION block with per-arm `pendingActions` whenever the horizon
  is short of 10 days. `eval-smoke` cuts worlds and cases to run in 12s and keeps all 21 cycles.

### Measured, five worlds x 80 cases, TEST split, 10 days

Rebound vs **B3_FIXED_LADDER**, the compliant and competently designed baseline:

| | value |
|---|---|
| incremental money | mean **+Rs 11,168** |
| range | **-Rs 14,902 to +Rs 21,727** |
| sd (n=5) | Rs 15,256 |
| direction | **ahead in 4 of 5 worlds, behind in 1** |
| pooled | Rs 2,02,899 vs Rs 1,47,057 = **1.38x** |

Rebound vs **B2_AGGRESSIVE**, the rule-breaker: mean +Rs 2,714, range -Rs 29,831 to +Rs 24,429,
sd Rs 20,346, ahead in 3 of 5. **The sd dwarfs the mean. That is a tie and I will call it one.**

Compliance, stable across all five worlds: B2 sent **516-571 quiet-hours messages** and **934-1,027
contact-cap breaches** per world. B1, B3 and Rebound sent **zero of each**. Zero absolute breaches by
any arm, including B2.

**The claim I am willing to defend:** Rebound *matches* the rule-breaker's money while breaking zero
rules, and beats the honest baseline in 4 of 5 worlds. That is narrower than 1.81x and 5-of-5, and it
is the first version of this claim that survives its own invariant checks.

### Verification

556 tests pass. The invariant gate is mutation-tested: forcing `b0RecoveredZero`,
`allMoneyReconciles` or `noAbsoluteBreaches` false each suppresses the headline and exits 1, against
a control that prints it and exits 0. `netIncrementalPaise` is mutation-tested five ways — dropping
the counterfactual, dropping costs, falling back to the gross basis without B0, leaving self money
unweighted, and loosening the finite-guard to `!== null` — and all five are caught. That last one was
a real find: `undefined !== null` is true, so a missing figure would have pushed `NaN` into the pool
and every statistic would have read NaN while `n` still said 5.

`npm run eval-smoke` is wired into `npm run check`.


---

## Day 8 — #61, the simulated approver, and the prediction I wrote down before I ran it

### Pre-registered, before a single line of the approver existed

The approval gate freezes real money. Measured across five worlds it holds about 72% of Rebound's
exposure in `AWAITING_APPROVAL`, roughly 8–9 cases of 80, and until now nothing ever answered those
requests: the queue was write-only. Every figure in the five-arm table was therefore measured in a
world with no reviewer in it.

I am writing the prediction here first because the temptation with this change is obvious. Unfreezing
a queue can only add money, so if I ran it and then wrote up whatever came out, I would be reporting
a number I chose the direction of in advance. So:

1. **Every arm's recovery rises, not just Rebound's.** `APR_LARGE_AMOUNT` gates all five arms —
   B1, B2 and B3 queue their high-value charges exactly as Rebound does. If only Rebound improved,
   that would be a bug in how I wired the approver, not a result.
2. **Rebound's advantage over B3 widens.** Rebound is gated by four checks (large amount, plus weak
   and abstained diagnosis) where the baselines are gated by one, so Rebound has the bigger queue and
   therefore more to gain from having it answered. I expect the mean incremental advantage to rise
   from **+₹11,168** and the sign count to stay at **4 of 5 or better**.
3. **`AWAITING_APPROVAL` at the horizon falls from ~8–9 of 80 to 3 or fewer** for Rebound. Anything
   above that means requests are being raised faster than an 18-hour reviewer can clear them, which
   would itself be a finding worth reporting.
4. **Rebound's guardrail violations stay at exactly 0.** A grant clears the named checks it was shown
   and nothing else. If quiet-hours or contact-cap breaches appear after this change, the grant is
   being read as a general licence — the precise failure the envelope design exists to prevent, and
   the thing I most want this measurement to be able to catch.
5. **Denials are terminal, so ~30% of the queue closes permanently.** This is the reason prediction 2
   is not a certainty: Rebound's larger queue also eats more permanent refusals.

Where I am least confident: variance. The queued cases are the high-value ones by construction, so
granting them adds the widest-amount cases to the recovered set. The mean should rise; the standard
deviation may rise faster, and at n=5 that could leave the advantage less distinguishable from noise
than it was before. If that happens I will report it as a widening, not as an improvement.

### The result, against the predictions as written

Command: `node src/eval/cli/run.js --seeds=1,2,3,4,5 --count=80 --split=TEST`, 21 cycles x 12h = 10
days, five worlds of 80 cases on the held-out split. Suite at 605 tests, 0 failures.

**Prediction 1 — every arm improves, not just Rebound. HELD, and the evidence is stronger than the
prediction.** All four acting arms queue and resolve approvals: B1 asked 4-11 per world, B2 6-23, B3
4-13, Rebound 12-34. If the approver had been wired to Rebound alone, Rebound's margin over the
baselines could only have grown. Instead **B2 improved enough to overtake Rebound**, which is the
opposite of the failure this prediction was written to catch. I would rather have been wrong about the
ranking than right about it for the wrong reason.

**Prediction 2 — the advantage over B3 widens from +Rs 11,168, sign count stays 4 of 5. HELD, and I am
reporting it as a widening rather than an improvement, exactly as committed.** Incremental money vs B3:
mean **+Rs 78,530**, range **-Rs 40,591 to +Rs 3,83,975**, sd **Rs 1,72,568**, n=5, Rebound ahead in
**4 of 5** worlds. The pre-registered uncertainty was that the sd would rise faster than the mean, and
it did: the sd is more than twice the mean and the range crosses zero. The pooled ratio of 1.93x is
carried almost entirely by seed 1, where Rebound takes Rs 4,56,975 against B3's Rs 73,000; drop that
world and the effect is modest. **The defensible claim is the sign count, not the ratio**, and anyone
quoting "1.93x" without "4 of 5 worlds, sd larger than the mean, one world negative" is quoting me
dishonestly.

**Prediction 3 — Rebound's frozen queue falls from ~8-9 of 80 to 3 or fewer. HELD.** Cases still
AWAITING_APPROVAL at the horizon, per world: **2, 0, 2, 0, 0**. Frozen exposure falls to Rs 54,350 /
Rs 0 / Rs 2,064 / Rs 0 / Rs 0 against roughly 72% of exposure before the reviewer existed.

**Prediction 4 — Rebound's guardrail violations stay at exactly 0. HELD in all five worlds.** Quiet-hours
messages 0, contact-cap breaches 0, absolute breaches 0, worst rolling 7-day window **exactly 2 of 2 —
the cap binds and is never crossed**. The comparison that makes this mean something is B2 in the same
worlds: 549-578 messages sent inside quiet hours, 966-1040 past the per-customer cap, and a worst
window of **30 to 45 messages to one customer in seven days against a cap of 2**.

**Prediction 5 — denials are terminal, so a real fraction of the queue closes permanently. HELD.**
Rebound collected 38 grants against 21 denials across the five worlds, so **35.6% of resolved requests
were refused**, and the refused exposure runs Rs 30,488 to Rs 2,65,328 per world. That is money the
policy is permanently barred from by a human decision it does not control, and it is printed beside the
frozen column precisely so `frozen: 0` cannot be read as "nothing was blocked".

### The thing I did not predict, stated before anything else here gets quoted

**Rebound now LOSES to B2.** Incremental money vs B2: mean **-Rs 42,194**, ahead in only **2 of 5**
worlds, pooled **0.79x**. Before the reviewer existed this comparison was a tie. Unfreezing the queue
helped B2 more than it helped Rebound, because B2 queues fewer requests per world and had less of its
exposure stuck.

I am not going to file that under "B2 cheats so it does not count", because that is the move that would
make this log worthless. The measured position is: **on money alone, over ten days, on held-out worlds,
the rule-breaking baseline beats us.** What is also measured, in the same table, is what it costs to be
B2 — roughly 1,100 messages per world of which about half land inside quiet hours, 30-45 messages to a
single customer inside one week against a cap of 2, and a message volume that the run's own circuit-breaker
audit flags as **"YES - production would have truncated this arm"** at 1,155 messages against a production
cap of 250. So B2's figure is not a number a merchant could actually run; it is the number you get when
you switch the compliance rules off, and the honest framing of the headline is Rebound against B3.

That framing was already the stated design of the experiment — B3 is named in `compareWithinWorld` as the
comparison that matters — so this is not a retreat invented after seeing the result. But the B2 column
moved against us and the pitch must say so out loud rather than let a judge find it.

### Two defects this measurement found, both in code written the same day

**`approvalsReconcile` compared the wrong two quantities, and failed in all five worlds.** The invariant
asserted that the reviewer's own tally equals the per-case approval census. Rebound's reviewer logged
**19 grants while only 9 cases ended in GRANTED**, because 7 cases had their authorisation envelope
expire and returned for a fresh signature, one of them four times. Those are different units: the census
counts CASES in a final state, the reviewer's log counts DECISIONS, and over ten days one case can
legitimately collect several. `summariseApprovals` says exactly this in its own docblock about
`accountsFor` being an inequality, and I wired an equality to the wrong field anyway on the same day.
Now compared against the audit event counts, `grantedAudits`/`deniedAudits`, which matched 19 to 19.
Denials were the clue: terminal, so they cannot repeat, and they matched 9 to 9 on both sides while the
grants disagreed. Three regression tests added, including one asserting the divergence is PERMITTED —
the assertion that would have prevented the bug.

**The failure message printed one side of a two-sided comparison,** so the run told me the numbers
disagreed without telling me what disagreed with what, and finding out cost a probe. Both sides are on
the comparison row now.

**And a reporting drift caught while fixing them:** the INVARIANTS block prints a hand-maintained list
of passing checks that had not been updated since #62. The run was enforcing nine invariants and
reporting five. That understates rather than overstates, but the entire point of printing the list is
that somebody can count it.

### Two more mistakes worth recording, because both were mine and both were caught by a test

`ASSUMPTIONS.approverSlaHours.sweep` was written `[6, 48]` by eye, while `createSimApprover` refuses any
mean SLA above half of `GUARDRAILS.approvalValidForHours` (36h) — so the declared sweep asked for worlds
the guard exists to reject, and #58's sensitivity run would have died partway through with a config
error instead of producing a result. The bound is now **derived** from `approvalValidForHours` rather
than hardcoded a second time, so the two cannot drift apart, and a test asserts the relationship rather
than the number.

`test/baselines.test.js` "no arm leaves the majority of its cases frozen" began failing on B2 at 13 of
24 — and **the test was wrong, not B2**. Measuring the frozen cases instead of relaxing the threshold
showed only 2 of the 13 had ever touched the approval queue; the other 11 carried **21 actions each**,
one on every one of the 21 cycles. That is not a stalled policy, it is B2 working as specified: it stops
only on `ARM_ABSOLUTELY_BLOCKED`, and the fixture itself raises the message and retry caps to 10,000,
removing the one budget that could ever stop it. The test removed B2's only stopping condition and then
failed it for not stopping. A terminal state label cannot tell "gave up" from "still working when the
clock ran out", so the assertion now measures the **mechanism** — unresolved AND fewer than 2 actions
across ten days, which is the actual stall signature it was written for.

Worth noting the direction: relaxing that threshold to 0.55 would have taken thirty seconds, and a
baseline that looks like it resolved less makes Rebound's margin look bigger. That is the ninth time on
this project that a bug pointing the flattering way was invisible from the headline metric.

---

## #51 — the train/serve skew, and what the ground truth says about which side is wrong

Written before the measurement, so the predictions below are pre-registered rather than reconstructed.

Day 7 pinned a skew across three feature columns and deliberately left it open, because the note I
wrote at the time said there were two coherent designs — delay-explicit features with a delay column,
or landing-time features with the delay absorbed into age — and that picking between them changes every
trained model, so it belonged in an eval where money could arbitrate.

Reading the code again, that framing was wrong in a way worth recording. **There was never a choice to
make, because a third party had already made it: the simulator that generates the labels.**
`src/sim/responseModel.js` resolves `effectiveAt = max(scheduledFor, now)` and then computes
`ageDays` from it — line 523, `(effectiveAt - event.occurredAt)`. The label for a nine-day scheduled
retry is drawn against the case's age *when the retry lands*. So `ageDays` in the feature vector was
not one of two defensible conventions; it was measuring a different quantity than the label it was
being fitted against. The model was asked to predict the outcome of an action landing on day 12 from a
feature saying the case was three days old.

And `delayDays` was not inherently broken either. It is computed as `scheduledFor - context.now`, and
`decide.js` passed `context.now = guard.effectiveAt` — the landing instant itself. The subtraction was
correct; it was handed two copies of the same instant. Nothing was wrong with the column. One call site
was collapsing it.

Both are one fix: a feature vector needs BOTH instants. The decision instant, because the delay is the
difference between them, and the landing instant, because that is where the physics happen. So
`buildFeatures` now takes `context.now` as the decision instant only and derives the landing instant
itself, by importing `effectiveAt` from the guardrail engine rather than restating the
`max(scheduledFor, now)` rule. Restating it is precisely how the two sides drifted apart the first time.

### Predictions

1. **`delayDays` stops being structurally zero at serving.** Directional and near-certain — it is what
   the fix does. Recorded so that if it does NOT change, the fix did not land where I think it did.
2. **The trained model changes and Day 5's figures move.** Every scheduled-retry row's `ageDays`,
   `ageDecayProxy` and `salaryWindow` shift. I do not predict the direction of calibration.
3. **Recovered money on TRAIN goes UP, but by less than 10%.** The mechanism is real, but the two age
   columns already moved in the same direction the delay would have, so I expect substantial
   redundancy. If money moves more than 10% I have mis-modelled how much the timing columns carry.
4. **It could go DOWN and that would not falsify the fix.** Correcting a feature to match its label can
   lower a metric that a leak was flattering — a model fitted on decision-time age was, for scheduled
   retries, being fed a systematically YOUNGER case than the one it was scored against, i.e. an
   optimistic view. Losing that is a correction, not a regression. Stated here so I cannot retreat to
   it only if the number disappoints.
5. **The prediction most likely to be wrong:** that this is small. I have said "probably redundant"
   about the timing columns twice now, and the retry-timing defect was not small either time.
