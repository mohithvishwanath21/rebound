# Rebound, in plain English

For explaining to a friend in five minutes. No jargon.

## The problem

When an online payment fails, a lot of that money is simply never collected.
Card declined, subscription renewal bounced, invoice ignored. Most companies retry the
card two or three times, send a couple of emails, and eventually give up.

## Why that is a bad way to do it

Because retrying often *cannot* work, no matter how many times you try.

This actually happened to us on Day 3. We created a real ₹499 payment link and tried to
pay it with a card. Declined. Tried again. Declined again. Razorpay told us why: this
business only accepts Indian cards.

So retrying that card was completely pointless. It would fail the same way forever.
We sent the same person to netbanking instead, and the ₹499 arrived on the first try.

Same customer. Same amount. Same minute. One action worth nothing, the other worth ₹499.
A system that only knows how to "retry" cannot tell those two apart.

## What Rebound does instead

For every failed payment, it looks at all the things it *could* do — retry now, retry
later, send a payment link, switch to UPI, message the customer, send it to a human, or
do nothing — and for each one it asks:

How likely is this to actually get the money? Multiply that by how much money is at stake.
Then subtract what the action costs, and subtract how much it annoys the customer.

Whatever scores highest, it does. And if nothing scores above zero, **it stops.**

That stopping part is the bit almost nobody builds. Knowing when to give up on a customer
is worth real money, because chasing someone who will never pay costs you the cost of
chasing *and* the goodwill of the customer.

## What we built so far

**Days 1–2: a fake world.** Thousands of made-up customers whose payments fail for
different reasons, who behave realistically — some pay if you just ask nicely, some never
will, and all of them get annoyed if you message them too often.

Why fake? Two reasons. You cannot run experiments on real paying customers. And no
dataset in the world can tell you "here is what would have happened if you had done
something different," which is exactly what you need to know if you want to compare
strategies.

The fake world has guardrails so the system cannot cheat. The answers about which
customers will actually pay are kept in a completely separate place, and there is a test
that fails the build if the decision-making code can reach them. So it has to genuinely
figure things out rather than peek.

**Day 3: connected it to real Razorpay.** Not a mock, not a screenshot. The code created a
real payment link, real money moved in test mode, and the code matched that payment back
to the decision that caused it. Every run saves Razorpay's actual responses into a file we
can show people.

## The part I am most proud of

There are two very different claims you could make about a project like this, and mixing
them up is how demos turn into lies.

**"The payment stuff works."** That one is proven, for real, against Razorpay, with saved
receipts.

**"My decision-making is smarter than the normal approach."** That one is measured in the
fake world, and I will happily tell you every assumption it depends on.

Most hackathon projects quietly blur those two so the whole thing sounds proven. Rebound
prints the difference on screen every single time it runs, and there is a test that fails
if someone deletes that message.

I also built a tool whose only job is to check whether my assumptions about Razorpay are
actually true. It caught me being wrong several times — including one case where my own
test was wrong in exactly the same way my code was wrong, so fifteen tests passed over a
real bug. That is in the engineering log, because it is more interesting than anything
that worked first time.

## Where it stands

Right now: the fake world, the money handling, the real Razorpay connection, the database
layer, and 163 tests plus 30 sanity checks on the fake world. All passing.

Still to build: the part that diagnoses *why* each payment failed, the part that predicts
how likely each action is to work, the decision engine, the safety rules about not
spamming people, and a dashboard to watch it all happen.

## If you only remember one thing

Getting failed payments back is not a retry loop. It is deciding where to spend limited
attempts and limited customer patience — and knowing when to stop.
