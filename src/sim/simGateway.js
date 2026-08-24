/**
 * SIM GATEWAY — the world, not the agent.
 *
 * Implements the same interface as `src/razorpay/liveGateway.js`, so the orchestrator
 * cannot tell them apart. That is the whole point: a number measured under SIM is produced
 * by byte-for-byte the same decision code that would run against Razorpay.
 *
 * WHY THIS FILE LIVES IN src/sim/ AND NOT IN src/razorpay/
 * -------------------------------------------------------
 * It resolves outcomes against latent truth — it has to, it *is* the world — so it reads
 * `payerType`, `patienceBudget`, `fundsAvailableFrom` and friends. `test/boundary.test.js`
 * forbids those tokens anywhere under `src/agent/**`, `src/api/**` or `src/razorpay/**`.
 * Putting the simulated gateway in `src/razorpay/` would have quietly made the restricted
 * area a place where ground truth is legal, which would dissolve the one architectural
 * guarantee this project actually needs. So it sits here, and the wiring is injected.
 *
 * Read the direction of the imports: sim imports the interface from razorpay/gateway.js,
 * never the reverse.
 *
 * WHAT THIS GATEWAY IS AND IS NOT RESPONSIBLE FOR
 * ----------------------------------------------
 * It is responsible for: did the action reach the customer, did money arrive, and what did
 * that cost. It is NOT responsible for deciding whether the action was wise, for advancing
 * the clock, or for counting fatigue — the orchestrator owns time and the case state, and
 * passes `touchesUsed` in. Keeping this thing stateless about time is what lets the eval
 * replay a batch under perturbed assumptions without a reset step that could leak state
 * between arms.
 */

import {
  GatewayMode,
  ReceiptState,
  buildReference,
  makeReceipt,
  validateActionRequest,
} from '../razorpay/gateway.js';
import { simulateActionOutcome, materialiseAssumptions } from './responseModel.js';
import { makeRng, deriveSeed } from '../core/rng.js';

/**
 * @param {object} o
 * @param {function} o.getLatent  - (eventId) => latent record. Injected by the eval harness,
 *                                  which is the only thing allowed to hold the truth store.
 * @param {number}   o.seed       - so a whole run is reproducible from one integer
 * @param {object}   [o.assumptions] - a materialised (possibly perturbed) assumption set.
 *                                  Omitted means baseline. This is the ONLY place in the
 *                                  system permitted to make that choice — see the guard at
 *                                  the top of `recoveryProbability` for why the model itself
 *                                  refuses to default.
 */
export function createSimGateway({ getLatent, seed = 1, assumptions, now = () => new Date() }) {
  if (typeof getLatent !== 'function') {
    throw new Error('createSimGateway needs getLatent(eventId). The eval harness supplies it.');
  }

  // Materialised once at construction rather than per call, so every decision inside one
  // run provably faces the same world. Resolving it per call would leave room for an
  // assumption set to change mid-run, which would make the run's headline number
  // uninterpretable while still looking perfectly well-formed.
  const A = assumptions ?? materialiseAssumptions();

  /**
   * One independent RNG stream per (event, action, decisionSeq), derived from the run seed.
   *
   * A single shared stream would make every outcome depend on the ORDER in which cases were
   * processed, so two policy arms that happen to touch cases in a different sequence would
   * face different luck. Comparing them would then be measuring scheduling order as much as
   * policy quality. Per-decision derivation removes that confound entirely: an identical
   * decision on an identical case gets identical luck in every arm.
   */
  const rngFor = (reference) => makeRng(deriveSeed(seed, reference));

  async function execute(req, { kind }) {
    validateActionRequest(req);
    const at = now();
    const reference = buildReference({
      runId: req.runId,
      eventId: req.eventId,
      actionKind: req.action.kind,
      channel: req.action.channel ?? null,
      decisionSeq: req.decisionSeq ?? 1,
    });

    const latent = getLatent(req.eventId);
    if (!latent) throw new Error(`SIM gateway: no latent record for event ${req.eventId}`);

    /**
     * A SIM-ONLY REQUIREMENT, ENFORCED HERE RATHER THAN IN `validateActionRequest`.
     *
     * The response model prices recovery against the loss's own physics — how old it is, which
     * rail it was on, what kind of loss, how much. LIVE reads none of that, so putting the check
     * in the shared validator would make every LIVE call carry a field it ignores. The shared
     * validator exists to stop SIM being more PERMISSIVE than LIVE; this is the opposite case,
     * SIM needing more than LIVE, and it belongs with the mode that needs it.
     *
     * Explicit because the failure without it is illegible: `event.occurredAt` on `undefined`
     * throws four frames deep in the response model, and `event.occurredAt` merely *missing*
     * is worse — it makes the case age NaN, which propagates silently into every probability
     * and produces a report full of plausible-looking numbers computed from nothing.
     */
    if (!req.event) {
      throw new Error(
        `SIM gateway: no event on the request for ${req.eventId}. The response model prices ` +
        'outcomes against the loss itself, so the caller must pass the event it is acting on.'
      );
    }
    if (Number.isNaN(new Date(req.event.occurredAt).getTime())) {
      throw new Error(
        `SIM gateway: event ${req.eventId} has an unparsable occurredAt (${req.event.occurredAt}). ` +
        'Case age would be NaN and every probability derived from it meaningless.'
      );
    }

    const outcome = simulateActionOutcome({
      action: req.action,
      latent,
      event: req.event,
      now: at,
      touchesUsed: req.touchesUsed ?? 0,
      assumptions: A,
      rng: rngFor(reference),
    });

    // Money moving is silent to the customer and either lands or doesn't. Contacting the
    // customer always "succeeds" as a dispatch — whether they act on it is a separate,
    // later event, and conflating the two is how naive models overcount recoveries.
    const contacting = kind === 'CONTACT';
    const state = outcome.recovered
      ? ReceiptState.CAPTURED
      : contacting
        ? ReceiptState.SENT
        : ReceiptState.FAILED;

    return makeReceipt({
      mode: GatewayMode.SIM,
      actionKind: req.action.kind,
      reference,
      state,
      amountPaise: req.amountPaise,
      // `outcome.amountPaise`, not `req.amountPaise`. A disputing customer who settles pays
      // a haircut, and crediting the requested figure would overstate every such recovery.
      amountCollectedPaise: outcome.recovered ? outcome.amountPaise : 0,
      // A stable fake id, shaped like Razorpay's so nothing downstream can accidentally
      // depend on the format difference between modes.
      providerRef: `${contacting ? 'plink' : 'order'}_SIM${reference.slice(-10)}`,
      shortUrl: contacting ? `https://sim.invalid/l/${reference.slice(-10)}` : null,
      notified: contacting,
      replayed: false,
      errorCode: state === ReceiptState.FAILED ? (outcome.failureCode ?? 'SIM_NOT_RECOVERED') : null,
      errorDescription: state === ReceiptState.FAILED ? (outcome.reason ?? 'Simulated attempt did not recover') : null,
      // SIM receipts carry no `raw`: there is no provider record to check them against, and
      // an empty object would invite code that treats the two modes as interchangeable
      // sources of evidence. They are not — one is measured, the other is proven.
      caveats: ['SIMULATED. No Razorpay call was made and no money moved.'],
      at,
      raw: null,
    });
  }

  return {
    mode: GatewayMode.SIM,

    retryCharge: (req) => execute(req, { kind: 'MONEY' }),
    sendPaymentLink: (req) => execute(req, { kind: 'CONTACT' }),
    requestReauth: (req) => execute(req, { kind: 'CONTACT' }),

    /**
     * In SIM there is nothing to poll: `execute` already resolved the outcome, because the
     * simulator has no asynchrony to model. Returning a coherent view anyway keeps the
     * orchestrator's reconciliation path exercised under SIM instead of being dead code
     * that only ever runs against the real API — which is where it would first be tested,
     * in front of a judge.
     */
    async fetchStatus({ providerRef }) {
      if (!providerRef) throw new Error('fetchStatus needs a providerRef');
      const isLink = providerRef.startsWith('plink_');
      return {
        kind: isLink ? 'PAYMENT_LINK' : 'ORDER',
        providerRef,
        state: ReceiptState.ATTEMPTED,
        providerStatus: 'created',
        amountPaise: null,
        amountPaidPaise: 0,
        referenceId: null,
        raw: null,
      };
    },

    async close() {},
  };
}

/**
 * The action -> gateway-method mapping moved to `src/razorpay/gateway.js`.
 *
 * It was defined here, described as "shared by the orchestrator", and could not be shared with
 * the orchestrator at all: `boundary.test.js` stops `src/agent/**` importing `src/sim/**`. It
 * describes the gateway interface rather than the simulation, so it belongs with the interface.
 * Re-exported here so any existing reader of this module still finds it, with one definition.
 */
export { gatewayMethodFor } from '../razorpay/gateway.js';

