/**
 * Canonical Group Turn Contract — single frozen authority for one Group turn.
 *
 * Extends existing pieces (emilyPending, availabilityConversationTransition,
 * customerResponseComposition.kind, customerReplyContract) rather than a
 * second ontology. Downstream Group wording/guards consume this; they must
 * not re-decide intent, item, duration, missing field, or response act.
 */

import { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } from "../availability/emilyPendingContext.js";
import { resolveDurationAskReplyMeaning } from "../policies/durationAskReplyMeaning.js";
import {
  CUSTOMER_CLAIMS,
  itemReferenceRequirementForReplyKind,
  linguisticGuidanceForReplyKind,
  requiredClaimsForReplyKind,
} from "./customerReplyContract.js";

export const CANONICAL_GROUP_TURN_CONTRACT_VERSION = 1;

export const GROUP_RESPONSE_ACTS = Object.freeze({
  ASK_FOR_DURATION: "ASK_FOR_DURATION",
  ASK_FOR_START_DATE: "ASK_FOR_START_DATE",
  ASK_FOR_CLARIFICATION: "ASK_FOR_CLARIFICATION",
  INFORM_AVAILABILITY_CHECK_STARTED: "INFORM_AVAILABILITY_CHECK_STARTED",
  INFORM_UNAVAILABLE: "INFORM_UNAVAILABLE",
  PRESENT_VERIFIED_ALTERNATIVES: "PRESENT_VERIFIED_ALTERNATIVES",
  INFORM_AVAILABILITY: "INFORM_AVAILABILITY",
  INFORM_ITEM_NOT_IN_CATALOG: "INFORM_ITEM_NOT_IN_CATALOG",
  INFORM_MISSING_CATALOG_PRICE: "INFORM_MISSING_CATALOG_PRICE",
  PRESENT_BROWSE_OPTIONS: "PRESENT_BROWSE_OPTIONS",
  PRESENT_VERIFIED_PRICE: "PRESENT_VERIFIED_PRICE",
  INVITE_BOOKING: "INVITE_BOOKING",
  SOCIAL_ACKNOWLEDGE: "SOCIAL_ACKNOWLEDGE",
  INTRODUCE_IMAGES: "INTRODUCE_IMAGES",
  ANSWER_BOOKING_STATUS: "ANSWER_BOOKING_STATUS",
  ANSWER_FROM_TRUSTED_FACTS: "ANSWER_FROM_TRUSTED_FACTS",
});

export const GROUP_UTTERANCE_FUNCTIONS = Object.freeze({
  REQUEST_CUSTOMER_INPUT: "request_customer_input",
  INFORM_STATUS: "inform_status",
  INFORM_FACT: "inform_fact",
  PRESENT_OPTIONS: "present_options",
  ACKNOWLEDGE: "acknowledge",
});

const KIND_TO_REQUIRED_ACT = Object.freeze({
  duration_ask: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
  temporal_clarification: GROUP_RESPONSE_ACTS.ASK_FOR_START_DATE,
  clarification: GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION,
  owner_check_holding: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
  availability_unavailable: GROUP_RESPONSE_ACTS.INFORM_UNAVAILABLE,
  availability_alternatives: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_ALTERNATIVES,
  availability: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY,
  item_not_in_catalog: GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG,
  missing_catalog_price: GROUP_RESPONSE_ACTS.INFORM_MISSING_CATALOG_PRICE,
  browse_options: GROUP_RESPONSE_ACTS.PRESENT_BROWSE_OPTIONS,
  pricing: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE,
  pricing_with_duration: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE,
  availability_approved: GROUP_RESPONSE_ACTS.INVITE_BOOKING,
  social: GROUP_RESPONSE_ACTS.SOCIAL_ACKNOWLEDGE,
  image_intro: GROUP_RESPONSE_ACTS.INTRODUCE_IMAGES,
  booking_status: GROUP_RESPONSE_ACTS.ANSWER_BOOKING_STATUS,
});

const ACT_TO_UTTERANCE_FUNCTION = Object.freeze({
  [GROUP_RESPONSE_ACTS.ASK_FOR_DURATION]:
    GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT,
  [GROUP_RESPONSE_ACTS.ASK_FOR_START_DATE]:
    GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT,
  [GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION]:
    GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT,
  [GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED]:
    GROUP_UTTERANCE_FUNCTIONS.INFORM_STATUS,
  [GROUP_RESPONSE_ACTS.INFORM_UNAVAILABLE]: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_ALTERNATIVES]:
    GROUP_UTTERANCE_FUNCTIONS.PRESENT_OPTIONS,
  [GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY]: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG]:
    GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.INFORM_MISSING_CATALOG_PRICE]:
    GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.PRESENT_BROWSE_OPTIONS]:
    GROUP_UTTERANCE_FUNCTIONS.PRESENT_OPTIONS,
  [GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE]: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.INVITE_BOOKING]: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.SOCIAL_ACKNOWLEDGE]: GROUP_UTTERANCE_FUNCTIONS.ACKNOWLEDGE,
  [GROUP_RESPONSE_ACTS.INTRODUCE_IMAGES]: GROUP_UTTERANCE_FUNCTIONS.INFORM_STATUS,
  [GROUP_RESPONSE_ACTS.ANSWER_BOOKING_STATUS]: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  [GROUP_RESPONSE_ACTS.ANSWER_FROM_TRUSTED_FACTS]:
    GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
});

function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {string} kind
 * @returns {string}
 */
export function requiredResponseActForReplyKind(kind) {
  return (
    KIND_TO_REQUIRED_ACT[String(kind ?? "").trim()] ||
    GROUP_RESPONSE_ACTS.ANSWER_FROM_TRUSTED_FACTS
  );
}

/**
 * @param {string} requiredAct
 * @returns {string}
 */
export function utteranceFunctionForResponseAct(requiredAct) {
  return (
    ACT_TO_UTTERANCE_FUNCTION[String(requiredAct ?? "").trim()] ||
    GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT
  );
}

/**
 * @param {string} requiredAct
 * @returns {boolean}
 */
export function isRequestCustomerInputAct(requiredAct) {
  return (
    utteranceFunctionForResponseAct(requiredAct) ===
    GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT
  );
}

/**
 * Inform/status acts must never ship a customer question. Present-options
 * may ask preference only when the frozen kind allows it (browse, 2+ items).
 * @param {string} requiredAct
 * @returns {boolean}
 */
export function isInformResponseAct(requiredAct) {
  const fn = utteranceFunctionForResponseAct(requiredAct);
  return (
    fn === GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT ||
    fn === GROUP_UTTERANCE_FUNCTIONS.INFORM_STATUS
  );
}

/**
 * Runtime-owned envelope for the ONE Group semantic Brain. Not a candidate
 * list. Not derived from customer wording.
 *
 * @param {{
 *   emilyPending?: Record<string, unknown> | null,
 *   pendingTemporalClarification?: Record<string, unknown> | null,
 *   trustedFreshItemFocus?: Record<string, unknown> | null,
 * }} [p]
 * @returns {Record<string, unknown> | null}
 */
export function buildTrustedGroupContinuationContext(p = {}) {
  const pending =
    p.emilyPending && typeof p.emilyPending === "object" && !Array.isArray(p.emilyPending)
      ? p.emilyPending
      : null;
  const focus =
    p.trustedFreshItemFocus &&
    typeof p.trustedFreshItemFocus === "object" &&
    !Array.isArray(p.trustedFreshItemFocus)
      ? p.trustedFreshItemFocus
      : null;
  const pendingItemId = clean(pending?.itemId, 160) || null;
  const focusItemId = clean(focus?.itemId, 160) || null;
  if (
    pending &&
    String(pending.pendingStage ?? "").trim() ===
      EMILY_PENDING_STAGE_AVAILABILITY_DURATION
  ) {
    // NEED_DURATION is only safe when runtime can bind the same item through
    // trustedFreshItemFocus. Advertising continuation from a stale/raw pending
    // while focus is absent caused Group semantic hard-blocks on duration-only
    // answers (model used trusted_fresh_focus / remembered item name; validation
    // rejected). Require a bindable focus, and refuse item-id mismatch.
    if (!focusItemId) return null;
    if (pendingItemId && pendingItemId !== focusItemId) return null;
    return Object.freeze({
      activeTransactionType: "availability",
      activeTransactionState: "NEED_DURATION",
      expectedMissingField: "duration",
      trustedActiveItemId: focusItemId,
      trustedActiveItemReference:
        clean(pending.customerReference, 160) ||
        clean(focus.customerReference, 160) ||
        clean(focus.itemLabel, 160) ||
        null,
    });
  }
  const temporal =
    p.pendingTemporalClarification &&
    typeof p.pendingTemporalClarification === "object" &&
    !Array.isArray(p.pendingTemporalClarification)
      ? p.pendingTemporalClarification
      : null;
  const temporalItemId = clean(temporal?.itemId, 160) || null;
  if (temporalItemId) {
    return Object.freeze({
      activeTransactionType: "availability",
      activeTransactionState: "NEED_TEMPORAL_CLARIFICATION",
      expectedMissingField: "start_date",
      trustedActiveItemId: temporalItemId,
      trustedActiveItemReference: clean(temporal.customerReference, 160) || null,
    });
  }
  return null;
}

/**
 * Privacy-safe requestedDuration diagnostics. Never includes customer text.
 * @param {unknown} requestedDuration
 * @returns {Record<string, unknown>}
 */
export function compactRequestedDurationDiagnostics(requestedDuration) {
  const row =
    requestedDuration && typeof requestedDuration === "object" && !Array.isArray(requestedDuration)
      ? requestedDuration
      : null;
  const components = Array.isArray(row?.components) ? row.components : [];
  const evidence =
    row?.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
      ? row.evidence
      : null;
  return {
    status: clean(row?.status, 40) || null,
    componentsCount: components.length,
    components: components.slice(0, 4).map((entry) => ({
      value: Number.isInteger(Number(entry?.value)) ? Number(entry.value) : null,
      unit: clean(entry?.unit, 20) || null,
    })),
    units: components
      .map((entry) => clean(entry?.unit, 20))
      .filter(Boolean),
    evidencePresent: Boolean(evidence && clean(evidence.source, 40) === "current_turn"),
    evidenceSurfaceText: clean(evidence?.surfaceText, 80) || null,
    evidenceStart: Number.isInteger(evidence?.start) ? evidence.start : null,
    evidenceEnd: Number.isInteger(evidence?.end) ? evidence.end : null,
  };
}

/**
 * Compact continuation for the ownership prompt JSON (identity only).
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function compactTrustedGroupContinuationForPrompt(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const activeTransactionType = clean(raw.activeTransactionType, 80) || null;
  const activeTransactionState = clean(raw.activeTransactionState, 80) || null;
  const expectedMissingField = clean(raw.expectedMissingField, 80) || null;
  const trustedActiveItemId = clean(raw.trustedActiveItemId, 160) || null;
  if (
    !activeTransactionType ||
    !activeTransactionState ||
    !expectedMissingField ||
    !trustedActiveItemId
  ) {
    return null;
  }
  return {
    activeTransactionType,
    activeTransactionState,
    expectedMissingField,
    trustedActiveItemId,
    trustedActiveItemReference: clean(raw.trustedActiveItemReference, 160) || null,
  };
}

/**
 * Stamp the frozen response act onto an existing composition object.
 * @param {Record<string, unknown>} composition
 * @returns {Record<string, unknown>}
 */
export function stampCanonicalGroupResponseAct(composition) {
  const row =
    composition && typeof composition === "object" && !Array.isArray(composition)
      ? composition
      : {};
  const kind = clean(row.kind, 80);
  const requiredAct = requiredResponseActForReplyKind(kind);
  return Object.freeze({
    ...row,
    requiredAct,
    utteranceFunction: utteranceFunctionForResponseAct(requiredAct),
    speaker: "EMILY",
    target: "customer",
  });
}

/**
 * Group customer-facing reply contract, including the frozen response act.
 * Moved here from the live pipeline so compose/guard share one builder.
 *
 * @param {{
 *   replyKind: string,
 *   trustedCustomerFacts?: Record<string, unknown> | null,
 *   customerMessageText?: string | null,
 * }} p
 */
export function buildCanonicalGroupResponseContract({
  replyKind,
  trustedCustomerFacts = null,
  customerMessageText = null,
} = {}) {
  const kind = clean(replyKind, 80);
  const facts =
    trustedCustomerFacts && typeof trustedCustomerFacts === "object"
      ? trustedCustomerFacts
      : {};
  const asks =
    kind === "duration_ask"
      ? "rental_period"
      : kind === "temporal_clarification"
        ? "start_date"
        : null;
  const requiredAct = requiredResponseActForReplyKind(kind);
  const utteranceFunction = utteranceFunctionForResponseAct(requiredAct);
  const replyMeaning = resolveDurationAskReplyMeaning({
    kind,
    business: facts.business,
    replyMeaning: facts.replyMeaning,
  });
  const objective = {
    owner_check_holding: "acknowledge_and_hold",
    duration_ask: "collect_missing_rental_period",
    temporal_clarification: "collect_missing_start_date",
    pricing: "answer_pricing_from_trusted_facts",
    pricing_with_duration: "answer_pricing_from_trusted_facts",
    availability: "answer_availability_from_trusted_facts",
    availability_unavailable: "state_unavailable_offer_alternatives",
    availability_alternatives: "present_verified_alternatives",
    item_not_in_catalog: "inform_item_not_currently_offered",
    missing_catalog_price: "inform_catalog_price_not_set",
    browse_options: "present_verified_browse_options",
    availability_approved: "invite_booking_from_confirmed_availability",
    clarification: "collect_missing_clarification",
    image_intro: "introduce_trusted_images",
    booking_status: "answer_booking_status_from_trusted_facts",
  }[kind] ?? "answer_from_trusted_facts";
  const forbidden = [
    CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
  ];
  if (
    [
      "owner_check_holding",
      "duration_ask",
      "temporal_clarification",
      "clarification",
      "image_intro",
      "item_not_in_catalog",
      "missing_catalog_price",
    ].includes(kind)
  ) {
    forbidden.push(
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED
    );
  }
  if (kind === "duration_ask" || kind === "temporal_clarification") {
    forbidden.push(CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE);
  }
  const allowed =
    kind === "availability_unavailable"
      ? [CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE]
      : ["pricing", "pricing_with_duration"].includes(kind)
        ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED]
        : kind === "availability_approved"
          ? [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED]
          : kind === "owner_check_holding"
            ? [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED]
            : kind === "item_not_in_catalog"
              ? [CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE]
              : [];
  return Object.freeze({
    replyKind: kind,
    replyObjective: objective,
    requiredAct,
    utteranceFunction,
    speaker: "EMILY",
    target: "customer",
    customerInputRequired: asks != null,
    requestedInput: asks,
    allowedClaims: Object.freeze(allowed),
    forbiddenClaims: Object.freeze(forbidden),
    requiredClaims: Object.freeze(requiredClaimsForReplyKind(kind)),
    itemReferenceRequirement: itemReferenceRequirementForReplyKind(kind, facts),
    trustedCustomerFacts: Object.freeze({ ...facts }),
    executionState: Object.freeze({
      availabilityCheckStarted:
        kind === "owner_check_holding" ? true : asks != null ? false : null,
    }),
    customerFacingPersona: Object.freeze({
      actor: "EMILY",
      firstPersonGrammar: "feminine_or_gender_neutral",
      firstPersonAgency: "required",
    }),
    verifiedTiming: Object.freeze({ hasVerifiedTime: false, timeText: null }),
    linguisticGuidance: linguisticGuidanceForReplyKind(kind, replyMeaning),
    replyMeaning,
    customerMessageText: clean(customerMessageText, 800) || null,
    interactionGuidance: asks
      ? Object.freeze({
          knownInformation: ["current_intent", "resolved_item"],
          missingInformation: [asks],
          askOnlyForMissingInformation: true,
          doNotReconfirmKnownInformation: true,
          avoidRedundantQuestions: true,
          responseMode: "single_missing_input",
        })
      : null,
  });
}

/**
 * Frozen turn contract after canonical facts + workflow composition exist.
 *
 * @param {{
 *   resolvedBusinessTurnContext?: Record<string, unknown> | null,
 *   customerResponseComposition?: Record<string, unknown> | null,
 *   trustedGroupContinuation?: Record<string, unknown> | null,
 * }} [p]
 * @returns {Record<string, unknown> | null}
 */
export function buildCanonicalGroupTurnContract(p = {}) {
  const facts =
    p.resolvedBusinessTurnContext &&
    typeof p.resolvedBusinessTurnContext === "object"
      ? p.resolvedBusinessTurnContext
      : null;
  if (facts?.validatedGroupCanonicalAuthority !== true) return null;
  const composition =
    p.customerResponseComposition &&
    typeof p.customerResponseComposition === "object"
      ? p.customerResponseComposition
      : {};
  const stamped = stampCanonicalGroupResponseAct(composition);
  const item = facts.resolvedItem && typeof facts.resolvedItem === "object"
    ? facts.resolvedItem
    : {};
  const decision = facts.decision && typeof facts.decision === "object"
    ? facts.decision
    : {};
  const continuation =
    p.trustedGroupContinuation && typeof p.trustedGroupContinuation === "object"
      ? p.trustedGroupContinuation
      : null;
  return Object.freeze({
    schemaVersion: CANONICAL_GROUP_TURN_CONTRACT_VERSION,
    provenance: "canonical_group_turn_contract_v1",
    transaction: Object.freeze({
      type:
        clean(decision.workflowType, 80) ||
        clean(continuation?.activeTransactionType, 80) ||
        null,
      state:
        clean(facts.availabilityConversationTransition?.resultingState, 80) ||
        clean(continuation?.activeTransactionState, 80) ||
        null,
    }),
    item: Object.freeze({
      id: clean(item.id, 160) || null,
      customerReference: clean(item.customerReference, 160) || null,
    }),
    semantic: Object.freeze({
      intent: clean(decision.primaryIntent, 80) || null,
      turnScope: clean(facts.turnContext?.canonicalSemanticDecision?.turnScope, 80) || null,
    }),
    requestedDuration: Object.freeze({
      status: clean(facts.durationSemanticStatus, 80) || null,
      normalizedDays:
        Number.isFinite(Number(facts.turn?.durationDays)) &&
        Number(facts.turn.durationDays) >= 1
          ? Math.floor(Number(facts.turn.durationDays))
          : null,
    }),
    requestedDate: Object.freeze({
      startDateKind:
        clean(facts.availabilityConversationTransition?.modelTemporalRequest, 80) ||
        null,
      trustedTemporalConstraintPresent:
        facts.availabilityConversationTransition?.trustedTemporalConstraintPresent ===
        true,
    }),
    execution: Object.freeze({
      requiredAction: clean(stamped.kind, 80) || null,
      result: clean(facts.availabilityConversationTransition?.resultingState, 80) || null,
    }),
    response: Object.freeze({
      requiredAct: stamped.requiredAct,
      requestedField: stamped.missingField ?? null,
      speaker: "EMILY",
      target: "customer",
      utteranceFunction: stamped.utteranceFunction,
    }),
  });
}

function normalizeComparableSpan(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Structural current-turn echo check: the inbound customer span is treated
 * as an identity, not a language dictionary. Used only for
 * request_customer_input acts so a reply cannot "satisfy" an ask by
 * restating the customer's still-untrusted turn.
 *
 * @param {string} replyText
 * @param {string} customerMessage
 * @returns {boolean}
 */
export function replyEchoesCurrentCustomerTurn(replyText, customerMessage) {
  const inbound = normalizeComparableSpan(customerMessage);
  const reply = normalizeComparableSpan(replyText);
  if (!inbound || !reply) return false;
  const tokens = inbound.split(" ").filter(Boolean);
  if (tokens.length < 2 && inbound.length < 8) return false;
  if (inbound.length < 4) return false;
  return reply.includes(inbound);
}

/**
 * Does the parsed composer JSON satisfy the frozen required response act?
 * Does not rewrite text or choose workflow. Self-declared fields must match
 * the frozen contract; request acts also fail if they echo the current
 * untrusted customer turn.
 *
 * @param {{
 *   replyText?: string | null,
 *   customerMessage?: string | null,
 *   parsed?: Record<string, unknown> | null,
 *   requiredAct?: string | null,
 *   utteranceFunction?: string | null,
 *   requestedInput?: string | null,
 *   customerInputRequired?: boolean,
 * }} p
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateReplyAgainstFrozenResponseAct(p = {}) {
  const requiredAct = clean(p.requiredAct, 80);
  if (!requiredAct) return { ok: true };
  const parsed =
    p.parsed && typeof p.parsed === "object" && !Array.isArray(p.parsed)
      ? p.parsed
      : null;
  if (!parsed) {
    return { ok: false, reason: "required_response_act_not_declared" };
  }
  if (clean(parsed.responseAct, 80) !== requiredAct) {
    return { ok: false, reason: "required_response_act_not_satisfied" };
  }
  const expectedFunction =
    clean(p.utteranceFunction, 80) || utteranceFunctionForResponseAct(requiredAct);
  if (clean(parsed.utteranceFunction, 80) !== expectedFunction) {
    return { ok: false, reason: "required_utterance_function_not_satisfied" };
  }
  if (isRequestCustomerInputAct(requiredAct)) {
    const requestedInput = clean(p.requestedInput, 40) || null;
    if (
      parsed.customerInputRequested !== true ||
      (requestedInput && clean(parsed.requestedInput, 40) !== requestedInput)
    ) {
      return { ok: false, reason: "DURATION_INPUT_CONTRACT_NOT_SATISFIED" };
    }
    if (
      replyEchoesCurrentCustomerTurn(
        String(p.replyText ?? ""),
        String(p.customerMessage ?? "")
      )
    ) {
      return { ok: false, reason: "required_response_act_echoes_customer_turn" };
    }
  }
  if (isInformResponseAct(requiredAct)) {
    if (parsed.customerInputRequested === true) {
      return { ok: false, reason: "INFORM_ACT_MUST_NOT_ASK_CUSTOMER" };
    }
    if (String(p.replyText ?? "").includes("?")) {
      return { ok: false, reason: "INFORM_ACT_MUST_NOT_ASK_QUESTION" };
    }
    if (
      requiredAct === GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG &&
      parsed.completedFactApology !== false
    ) {
      return { ok: false, reason: "INFORM_ACT_MUST_NOT_APOLOGIZE" };
    }
  }
  return { ok: true };
}
