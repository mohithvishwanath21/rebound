# Rebound — what it is, and how to say it

Everything below uses real figures from a real run. Reproduce with
`node src/demo/cli/serve.js --approver=SIM --count=40` (seed 1, 40 cases).

Written as a direct `node` call rather than `npm run api -- --count=40`: npm's flag forwarding after
`--` depends on the shell, and a dropped `--count` silently gives you the 80-case default, whose figures
are different from every number quoted below. A reproduction instruction that can quietly reproduce
something else is worse than none.

---

## The one sentence

**Rebound is a recovery agent for failed payments that decides, customer by customer, what single
action is worth taking to get the money back — and stops when nothing is.**

If you only get to say one more sentence: *"A fixed retry ladder does the same three retries and
three emails to everybody. Rebound works out why each payment failed and does something different
for each one, because the right move for a customer with no balance is the opposite of the right
move for a customer who forgot the invoice."*

---

## The problem, for someone who knows nothing

A payment fails. That money is **already earned** — the product shipped, the subscription ran, the
invoice is real. So a failed payment is not a lost sale, it is revenue sitting on the floor.

Today a business does one of two things with it:

**Nothing.** In our batch of 40 cases, ₹9,03,714 was at risk. Left completely alone, ₹14,370 came
back on its own. That is the floor: 1.6%.

**The same thing to everybody.** Three retries, three emails, on a fixed schedule. This is what
almost every dunning tool does. It works on some cases, and on the rest it burns bank fees, spends
the customer's patience, and still doesn't get paid.

The reason the second one is weak is the interesting part, and it's the whole pitch: **the right
action depends on why the payment failed, and the bank does not tell you why.** It returns a code
like `payment_failed`. It does not tell you whether the customer is broke, or forgot, or has a dead
card, or the bank itself was down for ten minutes.

---

## The demo: two customers, one agent, opposite decisions

This is the moment to show. Both are real cases from the same run, decided by the same agent.

### Kavery Foods — ₹2,22,558 — recovered with **one WhatsApp and zero retries**

The agent's diagnosis: the customer forgot the invoice. Not broke, not a bad card — forgotten.

It then priced **23 possible actions** in rupees. Two of them:

| action | what it's worth |
|---|---|
| retry the card right now | **₹1,528** |
| nudge on WhatsApp instead | **₹28,752** |

It nudged. One message, no retries, and **₹2,22,558 arrived in full.**

Say this out loud: *"A fixed ladder would have retried this card three times over six days. Three
failures, three fees, three emails to a customer who was never going to be fixed by a retry — because
the card was fine. The problem was that nobody had asked him. Rebound priced the retry at fifteen
hundred rupees and the WhatsApp at twenty-eight thousand, and picked the twenty-eight thousand."*

### Arjun Nair — ₹1,791 — recovered with **zero messages and two retries**

Diagnosis: insufficient funds. The card works, the account is empty.

Opposite decision. The agent sent **no messages at all** — messaging a broke customer is noise —
and simply retried twice, timed toward the salary window. Recovered in full.

Say this out loud: *"Same agent, same batch, same hour. On one case it messaged and never retried.
On the other it retried and never messaged. No fixed ladder can do both, and that gap is the
product."*

---

## The third thing, which is the one Razorpay will care about

**It refuses to act when acting is illegal, and it says so.**

Sunrise Logistics, ₹2,22,491. The agent wanted to send a WhatsApp nudge worth ₹18,959. It didn't.
Quiet hours. The screen shows twelve actions it wanted to take, every one of them blocked, each
labelled with the exact earliest legal moment: `2026-06-02T03:30Z` — 9am India time. It took the
best *legal* action instead, a retry worth ₹961, and waited for morning to do the rest.

Ten of the twenty-one cycles in this run fall inside quiet hours. On those cycles the agent can do
no customer contact at all, and the tape prints *"no contacting work was legal on this cycle."*
That isn't a dead frame in the demo — that's the compliance rule visibly holding.

And when an action is invasive enough to need a person, it **stops and waits for a signature**. Not
a warning, not a log line — the case freezes. Run the whole batch to the horizon without signing
anything and those cases are still frozen at the end, untouched. Then sign one, and it moves.

---

## The measured result

Same 40 cases. Same world, same model, same random luck, same clock, same scorer. Five policies:

| policy | recovered above do-nothing | attempts |
|---|---|---|
| do nothing | ₹0 | 0 |
| naive retry | ₹3,726 | 85 |
| aggressive bot | ₹2,27,554 | 335 |
| fixed ladder (industry standard) | ₹2,27,175 | 152 |
| **Rebound** | **₹2,81,619** | **105** |

**24% more money than the fixed ladder, on 31% fewer attempts.**

Pooled over five worlds on the held-out split — the number to actually quote, because one seed is
one seed — Rebound returns **1.87× the fixed ladder's money on 14% fewer attempts.**

**Be honest about this, out loud, unprompted:** against the maximally aggressive bot, pooled, we
recover **0.71× its money.** We deliberately give up gross recovery rather than triple customer
contact. Say why: no real merchant runs the aggressive policy, because the money it wins is bought
with fees and goodwill it doesn't measure. Then say the sharper thing — *we know that number
because we built the aggressive bot on purpose to find out, and we're telling you the one figure
that doesn't flatter us.*

---

## Five-minute video shot list

1. **0:00–0:40 — the problem.** ₹9,03,714 at risk across 40 failed payments. Left alone, ₹14,370
   comes back. Say what a fixed ladder does and why it's blunt.
2. **0:40–2:00 — Kavery Foods.** Open the case. Show the priced ladder: retry ₹1,528, WhatsApp
   ₹28,752. Show the chosen action stamped. Show ₹2,22,558 recovered on one touch, zero retries.
3. **2:00–2:40 — Arjun Nair.** The opposite decision. Zero touches, two retries, recovered.
4. **2:40–3:30 — the gate.** Console mode. Press *Run to horizon*, sign nothing, let the whole
   batch run. Point at the cases still frozen. Then sign one and watch it move.
5. **3:30–4:20 — the ledger.** Five arms, one world. The table above. Then the invariant strip:
   money reconciles to receipts, every arm met the same world.
6. **4:20–5:00 — what broke.** Pick one real defect and how it was caught. Close on: *the plumbing
   is real Razorpay test mode (`npm run doctor`), the policy comparison is simulated, and those two
   claims never share a screen.*

---

## Form answer — "What it solves"

> When a payment fails, the revenue is already earned, and most systems either ignore it or run the
> same fixed retry-and-email ladder at every customer. That ladder is blunt because the right action
> depends on why the payment failed, and the bank's error code doesn't say. Rebound diagnoses the
> cause from the payment's own signals, prices every available action in rupees against the specific
> customer and amount, takes the single best one, and stops when no action is worth more than doing
> nothing. Anything invasive freezes until a human signs, quiet hours and contact caps are enforced
> before pricing rather than after, and every decision keeps the full list of what else was
> considered and why it lost. Measured across a batch against four baselines under one world, one
> model and one clock, it returns 1.87× the money of a fixed ladder on 14% fewer customer contacts.

---

## The line that ties it together

*"Most recovery tools are a schedule. Rebound is a decision — and the decision it makes most often
is to leave the customer alone."*
