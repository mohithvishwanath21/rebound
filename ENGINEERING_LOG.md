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
