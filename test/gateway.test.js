/**
 * Runs the shared gateway contract against BOTH implementations, then adds the
 * mode-specific tests that would be meaningless in the other mode.
 *
 * The contract passing twice is the load-bearing result: it is what licenses the claim that
 * a recovery number measured in simulation was produced by the same decision code that
 * would run against Razorpay.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { runGatewayContract, requestFor, LATENT } from './gatewayContract.js';
import { createSimGateway } from '../src/sim/simGateway.js';
import { createLiveGateway } from '../src/razorpay/liveGateway.js';
import { createFakeRazorpay } from './fakeRazorpay.js';
import { GatewayMode, ReceiptState, RETRY_NOT_CAPTURED_CAVEAT, buildReference } from '../src/razorpay/gateway.js';
import { ActionKind } from '../src/core/actions.js';

const KEY_ID = 'rzp_test_FAKE1234567890';
const KEY_SECRET = 'fakeSecretDoNotUse';
const NOW = new Date('2026-08-22T09:00:00+05:30');

// ------------------------------------------------------------------ the contract, twice

runGatewayContract(
  'SIM',
  () => createSimGateway({ getLatent: () => LATENT, seed: 99, now: () => NOW }),
  { expectedMode: GatewayMode.SIM }
);

runGatewayContract(
  'LIVE_TEST',
  () => {
    const fake = createFakeRazorpay({ now: () => NOW });
    return createLiveGateway({
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      fetchImpl: fake.fetchImpl,
      sleep: async () => {},
      now: () => NOW,
    });
  },
  { expectedMode: GatewayMode.LIVE_TEST }
);

// ------------------------------------------------------------------ shared helpers

function liveWithFake(opts = {}) {
  const fake = createFakeRazorpay({ now: () => NOW });
  const gw = createLiveGateway({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => NOW,
    ...opts,
  });
  return { fake, gw };
}

// ------------------------------------------------------- LIVE_TEST: honesty about scope

test('[LIVE_TEST] a retry never claims to have captured, and says why on the receipt', async () => {
  const { gw } = liveWithFake();
  const r = await gw.retryCharge(requestFor({ action: { kind: ActionKind.RETRY_NOW } }));
  assert.equal(r.state, ReceiptState.ATTEMPTED);
  assert.equal(r.amountCollectedPaise, 0);
  assert.ok(r.providerRef.startsWith('order_'), 'a real order should have been created');
  assert.ok(
    r.caveats.includes(RETRY_NOT_CAPTURED_CAVEAT),
    'the receipt must state that the capture leg was not attempted'
  );
});

test('[LIVE_TEST] an unnotifiable channel creates a real link but does not claim a message went out', async () => {
  const { gw, fake } = liveWithFake();
  const r = await gw.sendPaymentLink(requestFor({ action: { kind: ActionKind.SEND_LINK, channel: 'WHATSAPP' } }));
  assert.equal(r.notified, false, 'Razorpay payment links cannot notify over WhatsApp');
  assert.ok(r.caveats.some((c) => /email and SMS only/i.test(c)));
  assert.ok(r.shortUrl, 'the link itself is still real and payable');
  const stored = fake.linkByReference(r.reference);
  assert.deepEqual(stored.notify, { sms: false, email: false }, 'we must not ask Razorpay to notify over a channel it cannot');
});

test('[LIVE_TEST] EMAIL and SMS each set exactly one notify flag', async () => {
  for (const [channel, expected] of [
    ['EMAIL', { sms: false, email: true }],
    ['SMS', { sms: true, email: false }],
  ]) {
    const { gw, fake } = liveWithFake();
    const r = await gw.sendPaymentLink(requestFor({ action: { kind: ActionKind.SEND_LINK, channel } }));
    assert.equal(r.notified, true);
    assert.deepEqual(fake.linkByReference(r.reference).notify, expected);
  }
});

// ---------------------------------------------------- LIVE_TEST: the guardrail detail

/**
 * The assertion I most want a reviewer to see. A messaging cap that Razorpay's own reminder
 * sequence can route around is not a cap at all, and it would break the contact ledger
 * silently — the customer gets extra messages, our audit trail shows none of them.
 */
test('[LIVE_TEST] Razorpay reminders are OFF, so the contact cap cannot be bypassed by the provider', async () => {
  const { gw, fake } = liveWithFake();
  const r = await gw.sendPaymentLink(requestFor());
  assert.equal(fake.linkByReference(r.reference).reminder_enable, false);
});

test('[LIVE_TEST] links never accept partial payment, so a recovery is all-or-nothing', async () => {
  const { gw, fake } = liveWithFake();
  const r = await gw.sendPaymentLink(requestFor());
  assert.equal(fake.linkByReference(r.reference).accept_partial, false);
});

test('[LIVE_TEST] a rail nudge asks for a UPI-only link, which is the mechanism it is betting on', async () => {
  const { gw, fake } = liveWithFake();
  const r = await gw.sendPaymentLink(
    requestFor({ action: { kind: ActionKind.SWITCH_RAIL_NUDGE, channel: 'SMS' }, preferredRail: 'UPI' })
  );
  assert.equal(fake.linkByReference(r.reference).upi_link, true);
  assert.ok(r.caveats.some((c) => /upi_link/i.test(c)));
});

test('[LIVE_TEST] expiry is floored at 15 minutes, which is Razorpay’s own minimum', async () => {
  const { gw, fake } = liveWithFake();
  // Ask for something Razorpay would reject outright.
  const r = await gw.sendPaymentLink(requestFor({ expiresAt: new Date(NOW.getTime() + 60_000) }));
  assert.equal(r.state, ReceiptState.SENT, 'the floor should have rescued an otherwise-invalid request');
  const link = fake.linkByReference(r.reference);
  assert.ok(link.expire_by >= Math.floor(NOW.getTime() / 1000) + 15 * 60);
});

test('[LIVE_TEST] our reference and identifiers travel in notes, so a webhook can find the case', async () => {
  const { gw, fake } = liveWithFake();
  const req = requestFor();
  const r = await gw.sendPaymentLink(req);
  const notes = fake.linkByReference(r.reference).notes;
  assert.equal(notes.rebound_ref, r.reference);
  assert.equal(notes.rebound_run, req.runId);
  assert.equal(notes.rebound_event, req.eventId);
  assert.equal(notes.rebound_action, ActionKind.SEND_LINK);
});

// ------------------------------------------------- LIVE_TEST: idempotency and unknowns

test('[LIVE_TEST] a genuine duplicate resolves to a replay receipt, not an error', async () => {
  const { gw, fake } = liveWithFake();
  const first = await gw.sendPaymentLink(requestFor({ decisionSeq: 4 }));
  const second = await gw.sendPaymentLink(requestFor({ decisionSeq: 4 }));

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true, 'the second create must be reported as a replay');
  assert.equal(second.providerRef, first.providerRef, 'and must resolve to the SAME link');
  assert.equal(fake.links.size, 1, 'Razorpay must hold exactly one link — no duplicate was created');
});

/**
 * Both of these pin lessons from the first real run rather than hypotheticals.
 *
 * The list endpoint returned an envelope I did not expect, and the reference lookup read the
 * wrong key — so a link that provably existed came back as absent. A wrong answer, not an
 * error, which is the kind that survives a green suite.
 */
/**
 * Wrap a fake's transport, rewriting only the reference-lookup response.
 *
 * Note it mirrors the fake's own response shape — `text()` and a `headers.get`, no `json()` —
 * because the client parses text rather than calling `.json()`. Inventing a `json()` method
 * here produced a NETWORK error rather than an obvious "your stub is wrong", which is a small
 * lesson in its own right: a hand-built stub that diverges from the thing it stands in for
 * fails as a transport error, not as a type error.
 */
function withRewrittenLookup(fake, rewrite) {
  const stub = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null, forEach: () => {} },
    text: async () => JSON.stringify(body),
  });

  return async (url, init) => {
    const u = new URL(url);
    const isLookup =
      (init?.method ?? 'GET') === 'GET' && u.pathname.endsWith('/payment_links') && u.searchParams.get('reference_id');
    if (!isLookup) return fake.fetchImpl(url, init);

    const res = await fake.fetchImpl(url, init);
    const original = JSON.parse(await res.text());
    return stub(rewrite(original.payment_links ?? original.items ?? []));
  };
}

test('[LIVE_TEST] the reference lookup accepts either collection envelope', async () => {
  for (const key of ['payment_links', 'items']) {
    const fake = createFakeRazorpay({ now: () => NOW });
    const gw = createLiveGateway({
      keyId: KEY_ID,
      keySecret: KEY_SECRET,
      fetchImpl: withRewrittenLookup(fake, (rows) => ({ count: rows.length, [key]: rows })),
      sleep: async () => {},
      now: () => NOW,
    });

    const first = await gw.sendPaymentLink(requestFor({ decisionSeq: 9 }));
    const second = await gw.sendPaymentLink(requestFor({ decisionSeq: 9 }));
    assert.equal(second.replayed, true, `envelope key '${key}' must still resolve the replay`);
    assert.equal(second.providerRef, first.providerRef);
  }
});

/**
 * The dangerous half. If `?reference_id=` is ignored rather than honoured, an unfiltered list
 * comes back, and taking items[0] would attach a STRANGER'S payment link — their amount, their
 * status — to our decision's audit trail as a successful replay. Returning UNKNOWN is correct;
 * returning someone else's money is not.
 */
test('[LIVE_TEST] an ignored server-side filter must not yield somebody else\'s link', async () => {
  const fake = createFakeRazorpay({ now: () => NOW });
  const decoy = {
    id: 'plink_SomeoneElse',
    entity: 'payment_link',
    reference_id: 'rbd_NOT_OUR_REFERENCE',
    amount: 999999,
    amount_paid: 999999,
    status: 'paid',
    short_url: 'https://rzp.io/i/decoy',
  };
  const gw = createLiveGateway({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    // The lookup always answers with a link that is NOT ours — i.e. the filter was ignored.
    fetchImpl: withRewrittenLookup(fake, () => ({ count: 1, payment_links: [decoy] })),
    sleep: async () => {},
    now: () => NOW,
  });

  await gw.sendPaymentLink(requestFor({ decisionSeq: 11 }));
  const second = await gw.sendPaymentLink(requestFor({ decisionSeq: 11 }));

  assert.notEqual(second.providerRef, 'plink_SomeoneElse', 'a stranger link must never be reported as our replay');
  assert.equal(second.state, ReceiptState.UNKNOWN, 'unconfirmable is the honest answer here');
  assert.equal(second.amountCollectedPaise, 0, 'and above all it must not book their 9999.99 as our recovery');
});

test('[LIVE_TEST] Razorpay enforces unique reference_id on links but NOT unique receipt on orders', async () => {
  const { gw, fake } = liveWithFake();
  // Two identical retries produce two orders, because Razorpay does not dedupe `receipt`.
  await gw.retryCharge(requestFor({ action: { kind: ActionKind.RETRY_NOW }, decisionSeq: 1 }));
  await gw.retryCharge(requestFor({ action: { kind: ActionKind.RETRY_NOW }, decisionSeq: 1 }));
  assert.equal(fake.orders.size, 2, 'this asymmetry is real, and pretending otherwise hid a bug');

  // Which is only tolerable because an order moves no money. The local store's
  // idempotency key is what stops a second retry being *decided* in the first place.
  const receipts = [...fake.orders.values()].map((o) => o.receipt);
  assert.equal(new Set(receipts).size, 1, 'both orders carry the same reference, so they are reconcilable');
});

test('[LIVE_TEST] a timeout on create is reconciled by asking, not by assuming', async () => {
  const { gw, fake } = liveWithFake();
  // The link genuinely gets created, then the response is lost. This is the dangerous case.
  const reference = buildReference({
    runId: 'run_contract_1',
    eventId: 'evt_000001',
    actionKind: ActionKind.SEND_LINK,
    channel: 'EMAIL',
    decisionSeq: 1,
  });
  await gw.sendPaymentLink(requestFor()); // creates it for real
  assert.equal(fake.links.size, 1);

  fake.faults.timeoutNext = 1; // now the retry of the same decision times out
  const r = await gw.sendPaymentLink(requestFor());
  assert.equal(r.reference, reference);
  assert.equal(r.replayed, true, 'we should have found the existing link rather than guessed');
  assert.equal(r.state, ReceiptState.SENT);
  assert.equal(fake.links.size, 1, 'and above all, not created a second one');
});

test('[LIVE_TEST] an unresolvable unknown stays UNKNOWN and never becomes FAILED', async () => {
  const { gw } = liveWithFake();
  const fakeAllTimeouts = {
    fetchImpl: async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    },
  };
  const gw2 = createLiveGateway({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    fetchImpl: fakeAllTimeouts.fetchImpl,
    sleep: async () => {},
    now: () => NOW,
  });
  const r = await gw2.sendPaymentLink(requestFor());
  assert.equal(r.state, ReceiptState.UNKNOWN);
  assert.equal(r.amountCollectedPaise, 0);
  assert.ok(
    r.caveats.some((c) => /reconciler must resolve/i.test(c)),
    'FAILED would invite a retry that could double up; UNKNOWN forces reconciliation'
  );
  assert.ok(gw); // the happy-path gateway is unused here; kept to make the contrast explicit
});

// ------------------------------------------------- LIVE_TEST: the full recovery path

test('[LIVE_TEST] end to end: link created, paid with a test card, recovery reconciled', async () => {
  const { gw, fake } = liveWithFake();

  const sent = await gw.sendPaymentLink(requestFor({ amountPaise: 41000 }));
  assert.equal(sent.state, ReceiptState.SENT);
  assert.equal(sent.amountCollectedPaise, 0, 'sending a link recovers nothing by itself');

  // A human pays it. In the real flow this is a test card on Razorpay's checkout page.
  fake.payLink(sent.providerRef);

  const view = await gw.fetchStatus({ providerRef: sent.providerRef });
  assert.equal(view.state, ReceiptState.CAPTURED);
  assert.equal(view.amountPaidPaise, 41000);
  assert.equal(view.referenceId, sent.reference, 'the reference is what joins Razorpay back to our case');
});

test('[LIVE_TEST] a partially paid link is not counted as a recovery', async () => {
  const { gw, fake } = liveWithFake();
  const sent = await gw.sendPaymentLink(requestFor({ amountPaise: 41000 }));
  fake.payLink(sent.providerRef, { amountPaise: 20000 });

  const view = await gw.fetchStatus({ providerRef: sent.providerRef });
  assert.equal(view.providerStatus, 'partially_paid');
  assert.notEqual(view.state, ReceiptState.CAPTURED, 'we send accept_partial:false, so a partial is an anomaly');
});

test('[LIVE_TEST] fetchStatus rejects an id whose prefix it does not recognise', async () => {
  const { gw } = liveWithFake();
  await assert.rejects(() => gw.fetchStatus({ providerRef: 'sub_TEST123' }), /unrecognised Razorpay id prefix/);
});

// -------------------------------------------------------------- SIM: mode specifics

test('[SIM] receipts are labelled as simulated and carry no provider record', async () => {
  const gw = createSimGateway({ getLatent: () => LATENT, seed: 1, now: () => NOW });
  const r = await gw.sendPaymentLink(requestFor());
  assert.ok(r.caveats.some((c) => /SIMULATED/.test(c)));
  assert.equal(r.raw, null, 'there is no provider response to check a SIM receipt against');
});

test('[SIM] identical inputs and seed give identical outcomes; a different seed may differ', async () => {
  const run = (seed) =>
    createSimGateway({ getLatent: () => LATENT, seed, now: () => NOW }).sendPaymentLink(requestFor({ decisionSeq: 2 }));
  const a = await run(7);
  const b = await run(7);
  assert.equal(a.state, b.state, 'same seed must reproduce exactly');
  assert.equal(a.amountCollectedPaise, b.amountCollectedPaise);
});

/**
 * The confound this guards against: with one shared RNG stream, two policy arms that
 * happen to visit cases in a different order would face different luck, and comparing them
 * would partly measure scheduling order rather than policy quality. Deriving a stream per
 * decision removes it — the same decision on the same case gets the same luck regardless of
 * what else the policy did first.
 */
test('[SIM] outcomes do not depend on the order in which cases are processed', async () => {
  const decisions = [1, 2, 3, 4, 5].map((seq) => requestFor({ decisionSeq: seq }));

  const forward = createSimGateway({ getLatent: () => LATENT, seed: 42, now: () => NOW });
  const inOrder = [];
  for (const d of decisions) inOrder.push(await forward.sendPaymentLink(d));

  const backward = createSimGateway({ getLatent: () => LATENT, seed: 42, now: () => NOW });
  const reversed = [];
  for (const d of [...decisions].reverse()) reversed.push(await backward.sendPaymentLink(d));
  reversed.reverse();

  for (let i = 0; i < decisions.length; i++) {
    assert.equal(
      inOrder[i].state,
      reversed[i].state,
      `decision ${i + 1} changed outcome when processed in a different order`
    );
    assert.equal(inOrder[i].amountCollectedPaise, reversed[i].amountCollectedPaise);
  }
});

test('[SIM] a settling disputer is credited the haircut, not the invoice', async () => {
  const disputing = {
    ...LATENT,
    payerType: 'DISPUTING',
    trueRootCause: 'CUSTOMER_DISPUTE',
    maxWillingToPayPaise: 25000,
    responsiveness: 1,
  };
  // Swept across seeds rather than pinned to one, because the property under test is "whenever a
  // dispute settles, it settles at the haircut" — and a disputing payer settles rarely, so a single
  // seed only demonstrates that property if it happens to get lucky.
  //
  // The original version used `seed: 3` and 60 draws, with its own assertion message admitting the
  // risk: "otherwise this proves nothing." It passed for weeks, then broke the moment `deriveSeed`
  // was fixed to actually respect its seed — not because the simulator changed, but because the
  // stream did. A test that depends on a lucky draw is a test that will fail for an unrelated reason
  // at an inconvenient moment, and it did.
  let captures = 0;
  let attempts = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const gw = createSimGateway({ getLatent: () => disputing, seed, now: () => NOW });
    for (let seq = 1; seq <= 60; seq++) {
      attempts += 1;
      const r = await gw.sendPaymentLink(requestFor({ decisionSeq: seq, amountPaise: 41000 }));
      if (r.state !== ReceiptState.CAPTURED) continue;
      captures += 1;
      assert.ok(
        r.amountCollectedPaise <= 25000,
        `credited ${r.amountCollectedPaise} but the payer would only ever pay 25000`
      );
      assert.ok(r.amountCollectedPaise < r.amountPaise, 'a haircut must show as collected < requested');
    }
  }
  assert.ok(captures > 0, `expected at least one settlement across ${attempts} draws, saw none`);
});

test('[SIM] refuses to run without a latent record rather than inventing one', async () => {
  const gw = createSimGateway({ getLatent: () => null, seed: 1, now: () => NOW });
  await assert.rejects(() => gw.sendPaymentLink(requestFor()), /no latent record/);
});

test('[SIM] cannot be constructed without a truth source, so it can never silently fake outcomes', () => {
  assert.throws(() => createSimGateway({}), /getLatent/);
});
