/**
 * THE READ MODEL — the only shape the browser is ever given.
 *
 * Every function here builds its output field by field from an ALLOWLIST. None of them spread a
 * stored record (`{ ...caseRecord }`) into a response, and that is the whole point rather than a
 * style preference. A spread inherits whatever the store happens to hold, so it turns "the browser
 * sees what we decided to show" into "the browser sees what nobody removed" — and #75 is the
 * standing proof that those are different. The store held `event.failure._generatedVague`, the
 * generator's answer key for which failures were made deliberately unmatchable, for eight days.
 *
 * So the rule is: adding a field to the dashboard requires naming it here. That is a small, dull tax
 * that makes the interesting failure impossible.
 *
 * Three other things this module owns, because they are all the same decision:
 *
 * 1. PII. Synthetic customers still have names, emails and phone numbers, and a pitch video is a
 *    public artefact. Emails and phones are masked on the way out. A real operator console would
 *    show them and gate the view on a role; masking is the honest default when the audience is a
 *    stranger watching a recording.
 *
 * 2. MONEY STAYS IN PAISE, AS INTEGERS. No division, no formatting, no floats anywhere in this
 *    file. The browser formats for display. Rupee conversion in a serialiser is how `1234.56` and
 *    `1234.5600000000001` end up in the same table.
 *
 * 3. NOTHING HERE COMPUTES A METRIC. Batch figures come from `compareWithinWorld` in
 *    `src/eval/metrics.js` — the same function the eval CLI uses, called on the same run. If the
 *    dashboard computed its own totals it would eventually disagree with the eval, and the number a
 *    judge sees on screen would not be the number the engineering log defends.
 */

/** Mask an email as `m****t@example.com`. Keeps the domain, which is the part that aids triage. */
function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${'*'.repeat(local.length)}@${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

/** Mask a phone to its last two digits. Enough to match against a support ticket, not enough to dial. */
function maskPhone(phone) {
  if (typeof phone !== 'string' || phone.length < 3) return null;
  return `${'*'.repeat(Math.max(0, phone.length - 2))}${phone.slice(-2)}`;
}

/** Dates arrive from the store as `Date` objects in memory and strings from JSON. Normalise to ISO. */
function iso(value) {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * The customer, as an operator triaging a queue needs them.
 *
 * `railStats` and `stats` are deliberately omitted. They are large, they are the model's feature
 * material rather than an operator's, and nothing in the UI reads them — three good reasons, and the
 * fourth is that they are the kind of derived blob that quietly grows a new field.
 */
function customerView(customer) {
  if (!customer) return null;
  return {
    customerId: customer.customerId ?? null,
    name: customer.name ?? null,
    email: maskEmail(customer.email),
    phone: maskPhone(customer.phone),
    segment: customer.segment ?? null,
    preferredRail: customer.preferredRail ?? null,
    consent: customer.consent ?? null,
    dnd: customer.dnd ?? null,
  };
}

/**
 * The failure as our own systems recorded it — the gateway's words, which is what makes the
 * diagnosis auditable. A reader who disagrees with a root cause should be able to see the text the
 * engine matched on and say so.
 */
function failureView(failure) {
  if (!failure) return null;
  return {
    errorCode: failure.errorCode ?? null,
    errorReason: failure.errorReason ?? null,
    errorSource: failure.errorSource ?? null,
    errorStep: failure.errorStep ?? null,
    errorDescription: failure.errorDescription ?? null,
    method: failure.method ?? null,
    bank: failure.bank ?? null,
    network: failure.network ?? null,
  };
}

/** One row in the case list. Everything a triage decision needs and nothing else. */
export function caseSummary(caseRecord, { diagnosis = null } = {}) {
  const c = caseRecord;
  return {
    eventId: c.eventId,
    customerId: c.customerId,
    customerName: c.customer?.name ?? null,
    segment: c.customer?.segment ?? null,
    lossType: c.event?.lossType ?? null,
    amountPaise: c.amountPaise ?? null,
    state: c.state ?? null,
    /**
     * Three money fields that must never be summed together, kept separate here for the same reason
     * they are separate on the case record: `recoveredPaise` is money a receipt confirms we
     * collected, `selfRecoveredPaise` is money the customer paid with no action from us, and
     * `amountPaise` is exposure. Merging the first two is the single easiest way to overstate this
     * project, so the API refuses to offer a field that has done it for you.
     */
    recoveredPaise: c.recoveredPaise ?? 0,
    selfRecoveredPaise: c.selfRecoveredPaise ?? 0,
    retriesUsed: c.retriesUsed ?? 0,
    touchesUsed: c.touchesUsed ?? 0,
    openedAt: iso(c.openedAt),
    nextActionAt: iso(c.nextActionAt),
    lastContactAt: iso(c.lastContactAt),
    waitingBecause: c.waitingBecause ?? null,
    approvalState: c.approval?.state ?? null,
    approvalReasons: c.approval?.reasons ?? [],
    stopCode: c.stop?.code ?? null,
    escalationCode: c.escalation?.code ?? null,
    rail: c.event?.rail ?? null,
    errorReason: c.event?.failure?.errorReason ?? null,
    rootCause: diagnosis?.rootCause ?? null,
    diagnosisAbstained: diagnosis?.abstained ?? null,
  };
}

/**
 * The EV arithmetic behind one action, in the form the drawer prints.
 *
 * The components are passed through individually rather than copied, because the arithmetic claim
 * being made is specific: gross minus the four costs equals EV, exactly, in integer paise.
 * `expectedValue.js` rounds each component separately so that identity holds by construction, and
 * the drawer's job is to let a reader check it by hand. `checksOut` does the subtraction here so a
 * disagreement shows up as a red flag in the UI instead of as a reader's arithmetic error.
 */
function evView(node) {
  if (!node) return null;
  const cm = node.components ?? {};
  const costParts = [
    cm.channelPaise ?? 0,
    cm.humanReviewPaise ?? 0,
    cm.expectedFailurePenaltyPaise ?? 0,
    cm.patiencePenaltyPaise ?? 0,
  ];
  const summedCosts = costParts.reduce((s, x) => s + x, 0);
  return {
    evPaise: node.evPaise ?? null,
    grossPaise: node.grossPaise ?? null,
    totalCostPaise: node.totalCostPaise ?? null,
    components: {
      p: cm.p ?? null,
      margin: cm.margin ?? null,
      amountPaise: cm.amountPaise ?? null,
      channelPaise: cm.channelPaise ?? 0,
      humanReviewPaise: cm.humanReviewPaise ?? 0,
      expectedFailurePenaltyPaise: cm.expectedFailurePenaltyPaise ?? 0,
      patiencePenaltyPaise: cm.patiencePenaltyPaise ?? 0,
      touchesUsed: cm.touchesUsed ?? null,
    },
    /**
     * Two independent identities, both computed here so the UI can show a tick or a warning rather
     * than asking the reader to trust the label. If either is false the decision record is
     * internally inconsistent and that is a defect, not a rounding artefact.
     */
    checksOut: {
      costsSumToTotal: summedCosts === (node.totalCostPaise ?? null),
      grossMinusCostsIsEv: (node.grossPaise ?? 0) - (node.totalCostPaise ?? 0) === (node.evPaise ?? null),
    },
  };
}

/** One candidate action the engine priced and ranked — the rows of the drawer's "why not" table. */
function candidateView(k) {
  return {
    rank: k.rank ?? null,
    signature: k.signature ?? null,
    kind: k.kind ?? null,
    channel: k.channel ?? null,
    scheduledFor: iso(k.scheduledFor),
    verdict: k.verdict ?? null,
    priced: k.priced ?? false,
    eligible: k.eligible ?? true,
    evPaise: k.evPaise ?? null,
    grossPaise: k.grossPaise ?? null,
    totalCostPaise: k.totalCostPaise ?? null,
    p: k.p ?? null,
    support: k.support ?? null,
    timing: k.timing ?? null,
    deferUntil: iso(k.deferUntil),
    chosen: k.chosen ?? false,
    rejectedBecause: k.rejectedBecause ?? null,
    requiresApproval: k.requiresApproval ?? false,
    violations: (k.violations ?? []).map((v) => ({ id: v.id, kind: v.kind, message: v.message })),
  };
}

/**
 * One decision, with the reasoning intact.
 *
 * `explain` is passed through verbatim. It is the engine's own sentences about what it did, written
 * at decision time, and rewriting them in the UI would let the dashboard tell a different story from
 * the audit trail. Same for `rejectedBecause` on each candidate.
 */
export function decisionView(d) {
  return {
    decidedAt: iso(d.decidedAt),
    policyArm: d.policyArm ?? null,
    outcome: d.outcome ?? null,
    caseState: d.caseState ?? null,
    lossType: d.lossType ?? null,
    amountPaise: d.amountPaise ?? null,
    marginApplied: d.marginApplied ?? null,
    barPaise: d.barPaise ?? null,
    calibrationNote: d.calibrationNote ?? null,
    diagnosis: d.diagnosis
      ? {
          rootCause: d.diagnosis.rootCause ?? null,
          source: d.diagnosis.source ?? null,
          matchTier: d.diagnosis.matchTier ?? null,
          matchedOn: d.diagnosis.matchedOn ?? null,
          abstained: d.diagnosis.abstained ?? null,
          requiresApprovalForMoneyMovement: d.diagnosis.requiresApprovalForMoneyMovement ?? null,
          explanation: d.diagnosis.explanation ?? null,
        }
      : null,
    chosen: d.chosen
      ? {
          action: d.chosen.action ?? null,
          signature: d.chosen.signature ?? null,
          idempotencyKey: d.chosen.idempotencyKey ?? null,
          effectiveAt: iso(d.chosen.effectiveAt),
          timing: d.chosen.timing ?? null,
          support: d.chosen.support ?? null,
          ...evView(d.chosen),
        }
      : null,
    waitUntil: iso(d.waitUntil),
    stop: d.stop
      ? {
          code: d.stop.code ?? null,
          reason: d.stop.reason ?? null,
          standing: d.stop.standing ?? null,
          blockedEscalation: d.stop.blockedEscalation ?? null,
        }
      : null,
    requiresApproval: d.requiresApproval ?? false,
    approvalReasons: d.approvalReasons ?? [],
    approvalCheckIds: d.approvalCheckIds ?? [],
    clearedByApproval: d.clearedByApproval ?? [],
    approvedBy: d.approvedBy ?? null,
    deferralLimit: d.deferralLimit
      ? {
          boundBy: d.deferralLimit.boundBy ?? null,
          class: d.deferralLimit.class ?? null,
          count: d.deferralLimit.count ?? null,
          cap: d.deferralLimit.cap ?? null,
          because: d.deferralLimit.because ?? null,
        }
      : null,
    candidates: (d.candidates ?? []).map(candidateView),
    guardrailsEvaluated: (d.guardrailsEvaluated ?? []).map((g) => ({
      id: g.id ?? null,
      kind: g.kind ?? null,
      verdict: g.verdict ?? null,
      message: g.message ?? null,
    })),
    explain: d.explain ?? [],
  };
}

/** One executed action and the receipt behind it. A money figure with no receipt is not money. */
export function actionView(a) {
  return {
    idempotencyKey: a.idempotencyKey ?? null,
    kind: a.kind ?? null,
    channel: a.channel ?? null,
    state: a.state ?? null,
    amountPaise: a.amountPaise ?? null,
    evPaise: a.evPaise ?? null,
    scheduledFor: iso(a.scheduledFor),
    startedAt: iso(a.startedAt),
    settledAt: iso(a.settledAt),
    reconciled: a.reconciled ?? null,
    receipt: a.receipt
      ? {
          mode: a.receipt.mode ?? null,
          actionKind: a.receipt.actionKind ?? null,
          state: a.receipt.state ?? null,
          amountPaise: a.receipt.amountPaise ?? null,
          amountCollectedPaise: a.receipt.amountCollectedPaise ?? null,
          providerRef: a.receipt.providerRef ?? null,
          providerStatus: a.receipt.providerStatus ?? null,
          at: iso(a.receipt.at),
          caveats: a.receipt.caveats ?? [],
        }
      : null,
  };
}

/**
 * One audit entry.
 *
 * `detail` is the only place in this module where an object is copied wholesale, and it is a
 * considered exception: every `detail` is composed by our own orchestrator out of agent-side values,
 * the shapes differ per type, and an allowlist per type would be twenty-one shapes to maintain
 * against a writer that already knows what it is writing. The exception is made safe from the other
 * end instead — `sendJson` in `server.js` scans every outgoing payload against the ground-truth
 * denylist and fails the request rather than serving a leak. That guard is what makes copying here
 * defensible; without it this line would be the hole.
 */
export function auditView(e) {
  return {
    seq: e.seq ?? null,
    type: e.type ?? null,
    at: iso(e.at),
    eventId: e.eventId ?? null,
    detail: e.detail ?? null,
  };
}

/** The full drawer: one case, every decision, every action, the whole trail. */
export function caseDetail({ caseRecord, decisions = [], actions = [], audit = [], diagnosis = null }) {
  return {
    ...caseSummary(caseRecord, { diagnosis }),
    customer: customerView(caseRecord.customer),
    event: {
      eventId: caseRecord.event?.eventId ?? null,
      lossType: caseRecord.event?.lossType ?? null,
      amountPaise: caseRecord.event?.amountPaise ?? null,
      currency: caseRecord.event?.currency ?? null,
      occurredAt: iso(caseRecord.event?.occurredAt),
      detectedAt: iso(caseRecord.event?.detectedAt),
      rail: caseRecord.event?.rail ?? null,
      priorAttempts: caseRecord.event?.priorAttempts ?? null,
      failure: failureView(caseRecord.event?.failure),
      /**
       * `downtime` and `subscription` are shown because they are inputs the engine reasons about —
       * a rail outage is why WAIT can beat RETRY — and they are observable: a merchant sees their
       * own gateway status page. `trueDowntimeWindow` is the latent version and is not here.
       */
      downtime: caseRecord.event?.downtime ?? null,
      subscription: caseRecord.event?.subscription ?? null,
    },
    approval: caseRecord.approval
      ? {
          state: caseRecord.approval.state ?? null,
          requestedAt: iso(caseRecord.approval.requestedAt),
          decidedAt: iso(caseRecord.approval.decidedAt),
          grantedAt: iso(caseRecord.approval.grantedAt),
          by: caseRecord.approval.by ?? null,
          note: caseRecord.approval.note ?? null,
          reasons: caseRecord.approval.reasons ?? [],
          checkIds: caseRecord.approval.checkIds ?? [],
          clearedCheckIds: caseRecord.approval.clearedCheckIds ?? [],
          proposedAction: caseRecord.approval.proposedAction ?? null,
          proposedInvasiveness: caseRecord.approval.proposedInvasiveness ?? null,
          approvedInvasiveness: caseRecord.approval.approvedInvasiveness ?? null,
          evPaise: caseRecord.approval.evPaise ?? null,
        }
      : null,
    stop: caseRecord.stop
      ? {
          code: caseRecord.stop.code ?? null,
          reason: caseRecord.stop.reason ?? null,
          standing: caseRecord.stop.standing ?? null,
          at: iso(caseRecord.stop.at),
        }
      : null,
    escalation: caseRecord.escalation
      ? {
          code: caseRecord.escalation.code ?? null,
          reason: caseRecord.escalation.reason ?? null,
          at: iso(caseRecord.escalation.at),
        }
      : null,
    decisions: decisions.map(decisionView),
    actions: actions.map(actionView),
    audit: audit.map(auditView),
  };
}

/** One row of the approval queue. The reviewer's decision needs the amount and the reason, together. */
export function approvalQueueItem(caseRecord) {
  return {
    eventId: caseRecord.eventId,
    customerId: caseRecord.customerId,
    customerName: caseRecord.customer?.name ?? null,
    amountPaise: caseRecord.amountPaise ?? null,
    lossType: caseRecord.event?.lossType ?? null,
    requestedAt: iso(caseRecord.approval?.requestedAt),
    reasons: caseRecord.approval?.reasons ?? [],
    checkIds: caseRecord.approval?.checkIds ?? [],
    proposedAction: caseRecord.approval?.proposedAction ?? null,
    proposedInvasiveness: caseRecord.approval?.proposedInvasiveness ?? null,
    evPaise: caseRecord.approval?.evPaise ?? null,
  };
}
