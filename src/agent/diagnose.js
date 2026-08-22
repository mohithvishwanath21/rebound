/**
 * DIAGNOSIS
 * =========
 *
 * Turns "a payment failed" into "here is why, and here is how I know."
 *
 * `src/core/taxonomy.js` has held a RULE_TABLE since Day 1 and until now nothing consumed
 * it. This is the consumer. Writing it immediately surfaced four things that were wrong,
 * which is the usual reward for connecting two components that have only ever been
 * described to each other.
 *
 * THE ONE DESIGN DECISION WORTH ARGUING ABOUT: NO CONFIDENCE NUMBER
 * ----------------------------------------------------------------
 * The obvious shape for this function is `{ rootCause, confidence: 0.93 }`. I am not
 * emitting a confidence, and the reason matters.
 *
 * A confidence of 0.93 is a claim that in roughly 93 cases out of 100 that look like this
 * one, this answer is correct. Nothing here has measured that. I would be picking numbers
 * that feel right for each rule, and every downstream consumer — the expected-value
 * calculation above all — would then multiply real money by a number I invented. It would
 * be indistinguishable from a measured probability in every log line and every dashboard,
 * and no reviewer could tell the difference. That is the most expensive kind of dishonesty
 * available in this codebase, because it is unfalsifiable by inspection.
 *
 * What this returns instead is `matchTier`: an ordinal FACT about how the match was made.
 * Matching on `error_reason` is a different epistemic act from matching a substring of a
 * human-readable sentence, and that difference is observable rather than estimated.
 *
 * Per-tier accuracy is then MEASURED by `src/eval/diagnosisAccuracy.js` against latent
 * truth, which is code that is allowed to see the answer key. Once measured, a calibrated
 * probability can be attached — from data, on Day 5. The ordering is deliberate: measure
 * first, then quantify. Not the other way round.
 *
 * TIERS
 * -----
 *   1. RULE   deterministic, ordered, explainable, free. Handles the clear majority.
 *   2. LLM    closed-label, optional, injected, off by default. For the residual only.
 *   3. FALLBACK  UNKNOWN, which is conservative on every axis by construction.
 *
 * Tier 1 always wins. An LLM is never consulted about a case a rule already matched, so it
 * can never talk the system out of a compliance-critical classification.
 */

import {
  ROOT_CAUSES,
  ROOT_CAUSE_IDS,
  RULE_TABLE,
  INVOICE_RULE_TABLE,
  getRootCause,
} from '../core/taxonomy.js';
import { toFailureSignal, toInvoiceSignal } from './observe.js';

/**
 * How the match was made, most specific first. An ordinal fact, not an estimate.
 *
 * REASON      exact match on the provider's machine-readable reason enum
 * SOURCE_STEP match on where in the flow it failed, plus corroborating text
 * TEXT        substring of a human-readable sentence. Brittle by nature: the provider can
 *             reword it in a release and nothing will tell us.
 * FLAG        an explicit flag in our own billing system (invoices only)
 * DEFAULT     a rule that matches everything, used only as the invoice terminal case
 * NONE        no rule matched
 */
export const MatchTier = Object.freeze({
  REASON: 'REASON',
  STATE: 'STATE',
  SOURCE_STEP: 'SOURCE_STEP',
  TEXT: 'TEXT',
  FLAG: 'FLAG',
  DEFAULT: 'DEFAULT',
  NONE: 'NONE',
});

/**
 * PRECEDENCE, WRITTEN DOWN BECAUSE IT IS A REAL DECISION AND NOT AN IMPLEMENTATION DETAIL
 * --------------------------------------------------------------------------------------
 *   humanOnly  >  REASON  >  STATE  >  SOURCE_STEP  >  TEXT  >  abstain
 *
 * Reading the list from the left:
 *
 * A human-only classification is never overridden by anything. If a risk control fired, that
 * is the answer, and no corroborating signal is permitted to talk the system into acting.
 *
 * A provider's machine-readable enum beats our own system state, because the enum describes
 * the specific transaction that just failed while our state describes the world in general.
 *
 * Our own system state beats the provider's free text. This is the one that is easy to get
 * backwards. `subscription.mandateStatus` is a field in our database that we control; an error
 * description is a sentence a payments company can reword in any release without telling
 * anybody. When they disagree, trust the thing that cannot silently change.
 *
 * Measured motivation rather than a hunch: five revoked mandates in a 600-event batch produced
 * error text no rule could match, abstained to UNKNOWN, and UNKNOWN permits one cautious
 * retry. Retrying a revoked mandate is not a wasted API call — it is a charge against an
 * authorisation the customer has explicitly withdrawn. The observable status said `revoked`
 * the whole time and nothing was reading it.
 */
const STATE_SIGNAL_TIERS = Object.freeze([MatchTier.TEXT, MatchTier.NONE]);


/** Which tier a rule belongs to, decided by its most specific predicate. */
function tierOf(rule) {
  if (rule.reason) return MatchTier.REASON;
  if (rule.source || rule.step) return MatchTier.SOURCE_STEP;
  if (rule.flagAny) return MatchTier.FLAG;
  if (rule.textAny) return MatchTier.TEXT;
  if (rule.default) return MatchTier.DEFAULT;
  return MatchTier.NONE;
}

/**
 * Evaluate one rule against one signal.
 *
 * Semantics: every predicate the rule declares must hold. A rule with `source`, `step` AND
 * `textAny` requires all three — that is what makes the downtime rule narrow enough to sit
 * above the generic bank decline without swallowing it.
 *
 * Returns the list of predicates that fired, so `matchedOn` can name real evidence rather
 * than just asserting a conclusion.
 */
function evaluate(rule, signal) {
  const fired = [];

  if (rule.reason) {
    if (!signal.reason || !rule.reason.includes(signal.reason)) return null;
    fired.push(`reason=${signal.reason}`);
  }
  if (rule.source) {
    if (!signal.source || !rule.source.includes(signal.source)) return null;
    fired.push(`source=${signal.source}`);
  }
  if (rule.step) {
    if (!signal.step || !rule.step.includes(signal.step)) return null;
    fired.push(`step=${signal.step}`);
  }
  if (rule.flagAny) {
    const hit = (signal.flags ?? []).find((f) => rule.flagAny.includes(f));
    if (!hit) return null;
    fired.push(`flag=${hit}`);
  }
  if (rule.textAny) {
    const hit = rule.textAny.find((needle) => signal.text.includes(needle.toLowerCase()));
    if (!hit) return null;
    fired.push(`text~"${hit}"`);
  }
  if (rule.default) fired.push('default');

  // A rule with no predicates at all would match everything silently. That is a bug in the
  // table rather than a legitimate catch-all, so refuse it loudly instead of obeying it.
  if (fired.length === 0) return null;

  return fired;
}

function runTable(table, signal) {
  for (let i = 0; i < table.length; i += 1) {
    const fired = evaluate(table[i], signal);
    if (fired) {
      return {
        rootCause: table[i].cause,
        matchTier: tierOf(table[i]),
        matchedOn: fired.join(' & '),
        ruleIndex: i,
        // Rules carry `confirmed` when the pattern was verified against the real API rather
        // than written from prior knowledge. Surfacing it means a diagnosis can say whether
        // it rests on evidence or on my memory of the docs.
        evidenceDate: table[i].confirmed ?? null,
      };
    }
  }
  return null;
}

/**
 * The default tier-2 classifier: abstain.
 *
 * The system is complete and demoable with no API key, no network and no account. An LLM is
 * an optional accuracy improvement on the residual, never a dependency — and a stub that
 * abstains is honest in a way that a stub returning a plausible guess would not be.
 */
export const abstainingLlm = Object.freeze({
  name: 'abstain',
  async classify() {
    return null;
  },
});

/**
 * Diagnose one observed event.
 *
 * @param observation  an observable view from `observe()`, or anything `toFailureSignal`
 *                     understands. Never a raw generator event with truth still attached.
 * @param llm          optional tier-2 classifier: `{ name, classify({ signal, allowedLabels }) }`
 */
export async function diagnose(observation, { llm = abstainingLlm } = {}) {
  const isInvoice =
    observation?.lossType === 'OVERDUE_INVOICE' || (!observation?.failure && observation?.invoice);

  if (isInvoice) {
    const signal = toInvoiceSignal(observation);
    const hit = runTable(INVOICE_RULE_TABLE, signal);
    // INVOICE_RULE_TABLE terminates in a `default` rule, so a miss here means the table was
    // edited badly rather than that the case is unusual.
    return finalise(hit ?? nothingMatched(), 'RULE', signal);
  }

  const signal = toFailureSignal(observation);

  const hit = runTable(RULE_TABLE, signal);

  // ---- Observable state, which may outrank a weak text match. See PRECEDENCE above. ----
  const state = stateSignal(observation);
  if (state) {
    if (!hit) return finalise(state, 'RULE', signal);
    const ruleIsHumanOnly = Boolean(getRootCause(hit.rootCause).humanOnly);
    if (!ruleIsHumanOnly && STATE_SIGNAL_TIERS.includes(hit.matchTier)) {
      return finalise(state, 'RULE', signal);
    }
  }

  if (hit) return finalise(hit, 'RULE', signal);

  // ---- Tier 2. Only ever reached when tier 1 found nothing. ----
  const guess = await askLlm(llm, signal);
  if (guess) return finalise(guess, 'LLM', signal);

  return finalise(nothingMatched(), 'FALLBACK', signal);
}

function nothingMatched() {
  return { rootCause: 'UNKNOWN', matchTier: MatchTier.NONE, matchedOn: null, ruleIndex: -1, evidenceDate: null };
}

/**
 * Diagnosis from state we can observe in our own systems, independent of the provider's text.
 *
 * Only one signal so far, and it is deliberately narrow: a subscription whose mandate reads
 * `revoked`. Note what this does NOT do — it does not treat `active` as evidence that the
 * mandate is fine. The generator models a real integration hazard where a revoked mandate
 * still reads `active` because the status has not propagated yet, so the absence of the signal
 * carries no information and must not be read as reassurance.
 *
 * Asymmetric on purpose: `revoked` is load-bearing, `active` is ignored.
 */
function stateSignal(observation) {
  if (observation?.subscription?.mandateStatus === 'revoked') {
    return {
      rootCause: 'MANDATE_REVOKED',
      matchTier: MatchTier.STATE,
      matchedOn: 'subscription.mandateStatus=revoked',
      ruleIndex: -1,
      evidenceDate: null,
    };
  }
  return null;
}

/**
 * CLOSED-LABEL, AND ENFORCED HERE RATHER THAN REQUESTED IN THE PROMPT.
 *
 * A prompt can ask a model to pick from a fixed list. A model can decline to. If an invented
 * label reached the taxonomy, `getRootCause()` would fall back to UNKNOWN and the invented
 * string would end up in the audit trail as though it were a real class — a category that
 * exists in the logs and nowhere in the code.
 *
 * So the label is validated against ROOT_CAUSE_IDS after the fact. A model that hallucinates
 * gets discarded and the case falls through to UNKNOWN, which is exactly where an
 * unclassifiable case belongs.
 *
 * A thrown error is also treated as an abstention: tier 2 is an optional accuracy
 * improvement, and an outage in it must degrade diagnosis quality without failing the run.
 */
async function askLlm(llm, signal) {
  if (!llm || typeof llm.classify !== 'function') return null;

  let out = null;
  try {
    out = await llm.classify({ signal, allowedLabels: ROOT_CAUSE_IDS });
  } catch {
    return null;
  }

  const label = out?.rootCause;
  if (typeof label !== 'string' || !Object.hasOwn(ROOT_CAUSES, label)) return null;

  // UNKNOWN from a model carries no more information than not asking, and tagging it as an
  // LLM-tier result would overstate what happened.
  if (label === 'UNKNOWN') return null;

  return {
    rootCause: label,
    matchTier: MatchTier.NONE,
    matchedOn: `llm:${llm.name ?? 'unnamed'}${out.rationale ? ` — ${String(out.rationale).slice(0, 200)}` : ''}`,
    ruleIndex: -1,
    evidenceDate: null,
  };
}

/**
 * Attach the recovery physics and the flags a decision engine needs.
 *
 * `abstained` is the field Day 6 must respect: a diagnosis nobody could make is not the same
 * as a diagnosis of "nothing much wrong", and the two must not be allowed to look alike.
 *
 * `requiresApprovalForMoneyMovement` is set for LLM-tier results. A deterministic rule that
 * matched an enum is explainable to an auditor line by line; a model's opinion is not, and
 * the gap between those two should show up as a human in the loop rather than as a footnote.
 */
function finalise(hit, source, signal) {
  const cause = getRootCause(hit.rootCause);
  const abstained = hit.rootCause === 'UNKNOWN';

  /**
   * WHICH BELIEFS ARE TOO WEAK TO MOVE MONEY ON THEIR OWN.
   *
   * Two categories, and the second one is here because it was measured, not because it felt
   * right.
   *
   * LLM tier: a model's opinion cannot be explained to an auditor line by line, and a
   * deterministic enum match can. That gap should surface as a human in the loop.
   *
   * TEXT tier: on the first corpus this was ever scored against, free-text matching was
   * 0.0% accurate — 5 of 5 wrong on TRAIN, 13 of 13 wrong on TEST. Not merely weaker than
   * matching an enum. Wrong every single time. The reason is structural rather than bad luck:
   * text matching only ever runs on payloads whose reason enum already failed to match, which
   * is precisely the population where the sentence is uninformative too.
   *
   * I am not deleting these rules, because that 0% is measured against error text I wrote
   * myself and real providers may phrase things more helpfully. But a match this weak must not
   * be allowed to authorise a charge on its own authority.
   */
  const weakTier = hit.matchTier === MatchTier.TEXT;

  return {
    rootCause: cause.id,
    source,
    matchTier: hit.matchTier,
    matchedOn: hit.matchedOn,
    ruleIndex: hit.ruleIndex,
    evidenceDate: hit.evidenceDate,
    abstained,
    requiresApprovalForMoneyMovement: source === 'LLM' || weakTier,


    // Physics the policy reads. Copied out rather than referenced so an audit record is a
    // complete account of what was believed at decision time, even if the taxonomy changes
    // later. A stored decision that silently re-interprets itself is not an audit trail.
    physics: {
      fault: cause.fault,
      retryCanSucceed: cause.retryCanSucceed,
      timingSensitive: Boolean(cause.timingSensitive),
      prefersSalaryWindow: Boolean(cause.prefersSalaryWindow),
      automationAllowed: cause.automationAllowed,
      messagingAppropriate: cause.messagingAppropriate,
      railSwitchHelps: Boolean(cause.railSwitchHelps),
      railSwitchIsPrimary: Boolean(cause.railSwitchIsPrimary),
      needsNewInstrument: Boolean(cause.needsNewInstrument),
      requiresReauth: Boolean(cause.requiresReauth),
      humanOnly: Boolean(cause.humanOnly),
    },

    // What was actually looked at. Without this an audit trail records a verdict and not the
    // evidence, which is the difference between a decision and an assertion.
    observed: {
      code: signal.code ?? null,
      reason: signal.reason ?? null,
      errorSource: signal.source ?? null,
      step: signal.step ?? null,
      flags: signal.flags ?? undefined,
      textLength: signal.text ? signal.text.length : 0,
    },

    explanation: cause.explanation,
  };
}

/** Diagnose a batch. Sequential on purpose: tier 2 may be rate-limited or metered. */
export async function diagnoseAll(observations, opts = {}) {
  const out = [];
  for (const o of observations) out.push(await diagnose(o, opts));
  return out;
}
