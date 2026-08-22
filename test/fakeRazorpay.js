/**
 * A FAKE RAZORPAY, GOOD ENOUGH TO TEST AGAINST AND HONEST ABOUT NOT BEING RAZORPAY
 * ===============================================================================
 *
 * An in-memory stand-in that speaks the subset of the Razorpay REST API this project uses.
 * It exists so the LIVE gateway is exercised by the same contract as the SIM gateway, with
 * no network and no keys, on every commit.
 *
 * Where the response shapes come from: Razorpay's public API reference. Field names,
 * status vocabularies (`created` / `partially_paid` / `paid` / `expired` / `cancelled`), the
 * `{ error: { code, description, reason, field } }` envelope, the `plink_` / `order_` /
 * `pay_` id prefixes, and the unix-second timestamps are all copied from there rather than
 * invented.
 *
 * WHAT A PASS AGAINST THIS FAKE DOES AND DOES NOT PROVE
 * ----------------------------------------------------
 * It proves my code builds the right requests, handles the documented failures, and never
 * double-charges. It does NOT prove Razorpay behaves the way I've modelled it — a fake can
 * only ever encode my current beliefs, and if a belief is wrong the fake is wrong in
 * exactly the same direction, which is the failure mode you cannot test your way out of.
 * `npm run live-check` is what settles that: it runs the same flow against the real test-mode
 * API and prints the actual responses, so any divergence shows up as a diff rather than as
 * a surprise during a demo.
 *
 * The one behaviour I want to flag as a deliberate modelling choice: this fake enforces
 * unique `reference_id` on payment links (Razorpay does) and does NOT enforce unique
 * `receipt` on orders (Razorpay doesn't). Getting that asymmetry wrong in the fake would
 * have hidden a real bug, so it is asserted directly in `test/gateway.test.js`.
 */

let counter = 0;
const nextId = (prefix) => `${prefix}_TEST${String(++counter).padStart(10, '0')}`;

export function createFakeRazorpay({ now = () => new Date() } = {}) {
  const links = new Map(); // id -> link
  const byReference = new Map(); // reference_id -> id
  const orders = new Map();
  const payments = new Map();

  /** Faults the tests inject to exercise the unhappy paths. */
  const faults = { failNextWith: null, timeoutNext: 0, duplicateNext: false };

  const unix = () => Math.floor(now().getTime() / 1000);

  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => (k.toLowerCase() === 'x-razorpay-request-id' ? `req_TEST${counter}` : null),
      forEach: (fn) => fn(`req_TEST${counter}`, 'x-razorpay-request-id'),
    },
    text: async () => JSON.stringify(body),
  });

  const errorBody = (code, description, extra = {}) => ({ error: { code, description, source: 'business', step: 'payment_initiation', ...extra } });

  function createLink(body) {
    if (!body.amount || body.amount < 100) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'The amount must be atleast INR 1.00', { field: 'amount' }));
    }
    if (!body.reference_id) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'reference_id is required', { field: 'reference_id' }));
    }
    if (String(body.reference_id).length > 40) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'reference_id may not be greater than 40 characters', { field: 'reference_id' }));
    }
    // Razorpay enforces this. It is the remote half of the idempotency guarantee.
    //
    // The wording and the null fields below are copied verbatim from a real 2026-08-22
    // response, and both corrections matter:
    //
    //   1. It is `reference_id` with an underscore, and the offending value is interpolated
    //      into the sentence. I had written "the given reference id" from memory, and my
    //      matcher was tuned to my wording rather than Razorpay's.
    //   2. Razorpay sends `reason: null` and `field: null`. My fake used to supply
    //      `reason: 'duplicate_reference_id'`, which made `isDuplicateReference` short-circuit
    //      on the reason code and never reach the string match — so the only branch that
    //      actually runs against the real API had no offline coverage at all.
    //
    // Do not "improve" this fixture. A fake that is kinder than the real thing is worse than
    // no fake, because it converts an unverified belief into a passing test.
    if (byReference.has(body.reference_id)) {
      return json(
        400,
        errorBody(
          'BAD_REQUEST_ERROR',
          `payment link with given reference_id: ${body.reference_id} already exists. ` +
            'Please create a payment link with a different reference_id',
          { reason: null, field: null }
        )
      );
    }
    if (body.upi_link && body.accept_partial) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'upi_link cannot be used with accept_partial'));
    }
    if (body.expire_by && body.expire_by < unix() + 15 * 60) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'expire_by should be at least 15 minutes from now', { field: 'expire_by' }));
    }

    const id = nextId('plink');
    const link = {
      id,
      entity: 'payment_link',
      amount: body.amount,
      amount_paid: 0,
      currency: body.currency ?? 'INR',
      accept_partial: Boolean(body.accept_partial),
      description: body.description ?? null,
      customer: body.customer ?? {},
      expire_by: body.expire_by ?? null,
      expired_at: 0,
      cancelled_at: 0,
      notes: body.notes ?? {},
      notify: body.notify ?? { sms: false, email: false },
      reference_id: body.reference_id,
      reminder_enable: Boolean(body.reminder_enable),
      payments: null,
      short_url: `https://rzp.io/i/TEST${id.slice(-6)}`,
      status: 'created',
      upi_link: Boolean(body.upi_link),
      created_at: unix(),
      updated_at: unix(),
    };
    links.set(id, link);
    byReference.set(body.reference_id, id);
    return json(200, link);
  }

  /** Simulate a human paying a link with a test card. Used by the reconciliation tests. */
  function payLink(linkId, { amountPaise } = {}) {
    const link = links.get(linkId);
    if (!link) throw new Error(`fake: no such link ${linkId}`);
    const paid = amountPaise ?? link.amount;
    const payment = {
      id: nextId('pay'),
      entity: 'payment',
      amount: paid,
      currency: 'INR',
      status: 'captured',
      method: link.upi_link ? 'upi' : 'card',
      order_id: nextId('order'),
      notes: { ...link.notes },
      created_at: unix(),
    };
    payments.set(payment.id, payment);
    link.amount_paid = paid;
    link.status = paid >= link.amount ? 'paid' : 'partially_paid';
    link.updated_at = unix();
    return { link, payment };
  }

  function createOrder(body) {
    if (!body.amount || body.amount < 100) {
      return json(400, errorBody('BAD_REQUEST_ERROR', 'The amount must be atleast INR 1.00', { field: 'amount' }));
    }
    // Deliberately NOT unique on `receipt` — matching Razorpay's actual default.
    const id = nextId('order');
    const order = {
      id,
      entity: 'order',
      amount: body.amount,
      amount_paid: 0,
      amount_due: body.amount,
      currency: body.currency ?? 'INR',
      receipt: body.receipt ?? null,
      status: 'created',
      attempts: 0,
      notes: body.notes ?? {},
      created_at: unix(),
    };
    orders.set(id, order);
    return json(200, order);
  }

  /** The injected `fetch`. Routing mirrors Razorpay's URL layout. */
  async function fetchImpl(url, init = {}) {
    if (faults.timeoutNext > 0) {
      faults.timeoutNext -= 1;
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }
    if (faults.failNextWith) {
      const { status, body } = faults.failNextWith;
      faults.failNextWith = null;
      return json(status, body);
    }

    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (method === 'POST' && path === '/payment_links') {
      if (faults.duplicateNext) {
        faults.duplicateNext = false;
        // Same real shape as createLink's own collision: real wording, no reason code. This
        // fault injects a duplicate refusal for a reference the fake has NOT stored, which is
        // how the DUPLICATE_NOT_FOUND path gets exercised.
        return json(
          400,
          errorBody(
            'BAD_REQUEST_ERROR',
            `payment link with given reference_id: ${body?.reference_id} already exists. ` +
              'Please create a payment link with a different reference_id',
            { reason: null, field: null }
          )
        );
      }
      return createLink(body);
    }

    if (method === 'GET' && path === '/payment_links') {
      const ref = u.searchParams.get('reference_id');
      const id = ref ? byReference.get(ref) : null;
      const items = id ? [links.get(id)] : [];
      // `payment_links`, not `items`.
      //
      // The 2026-08-22 live run refused a duplicate and then could not find the link it had
      // just refused to duplicate, because the gateway read `body.items` — the envelope every
      // OTHER Razorpay collection uses. This fixture used `items` too, so the belief and the
      // fake were wrong together and the offline suite was perfectly happy.
      //
      // `count` is kept because it costs nothing, but note the gateway no longer trusts the
      // server-side filter at all: it re-matches on reference_id locally, because a filter
      // that is ignored rather than honoured would otherwise hand back a stranger's link as
      // the replay of our own decision.
      return json(200, { count: items.length, entity: 'collection', payment_links: items });
    }

    if (method === 'GET' && path.startsWith('/payment_links/')) {
      const id = path.split('/')[2];
      const link = links.get(id);
      return link ? json(200, link) : json(400, errorBody('BAD_REQUEST_ERROR', 'The id provided does not exist'));
    }

    if (method === 'POST' && path === '/orders') return createOrder(body);

    if (method === 'GET' && path.startsWith('/orders/')) {
      const order = orders.get(path.split('/')[2]);
      return order ? json(200, order) : json(400, errorBody('BAD_REQUEST_ERROR', 'The id provided does not exist'));
    }

    if (method === 'GET' && path.startsWith('/payments/')) {
      const payment = payments.get(path.split('/')[2]);
      return payment ? json(200, payment) : json(400, errorBody('BAD_REQUEST_ERROR', 'The id provided does not exist'));
    }

    return json(404, errorBody('BAD_REQUEST_ERROR', `The requested URL was not found on the server: ${method} ${path}`));
  }

  return {
    fetchImpl,
    payLink,
    faults,
    // Inspection helpers for assertions — a test should be able to check what Razorpay
    // would have stored, not merely what our client claimed.
    links,
    orders,
    payments,
    linkByReference: (ref) => links.get(byReference.get(ref)) ?? null,
    reset() {
      links.clear();
      byReference.clear();
      orders.clear();
      payments.clear();
      faults.failNextWith = null;
      faults.timeoutNext = 0;
      faults.duplicateNext = false;
    },
  };
}
