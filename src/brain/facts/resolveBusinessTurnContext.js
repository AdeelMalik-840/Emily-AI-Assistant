/**
 * Canonical verified fact packet for Brain v2 — Phase 1 log-only resolver.
 * Prepares facts only; does not change workflow behavior or customer replies.
 */
import { understandTurn } from "../understanding/UnderstandingEngine.js";
import { extractTurnSignals } from "../../services/intentShapeResolver.js";
import { CANONICAL_FACTS_SCHEMA_VERSION } from "./constants.js";
import { resolveCatalogItemFacts } from "./resolveCatalogItemFacts.js";
import { resolvePricingFacts } from "./resolvePricingFacts.js";
import { resolveAvailabilityFacts } from "./resolveAvailabilityFacts.js";
import { resolveMediaFacts } from "./resolveMediaFacts.js";
import { resolveParticipantFacts } from "./resolveParticipantFacts.js";
import { resolveActionPolicyFacts } from "./resolveActionPolicyFacts.js";
import { resolveBusinessProfileFacts } from "./resolveBusinessProfileFacts.js";
import { logCanonicalFactsResolved } from "./logCanonicalFacts.js";
import { getBookingsForItem } from "../../services/inventoryService.js";
import { resolveCatalogBrowseAvailabilityFacts } from "./resolveCatalogBrowseAvailabilityFacts.js";
import { isGenericBrowseListAsk } from "../workflow/browseIntent.js";
import { readFreshLastAvailabilityAssist } from "../availability/availabilityAssistContext.js";
import { readFreshPendingTemporalClarification } from "../availability/temporalClarificationContext.js";
import { decideAvailabilityAssistFollowUp } from "../availability/decideAvailabilityAssistFollowUp.js";
import { isConfidentInventoryUnavailable } from "./resolveItemBookingAwareAvailability.js";
import { findVerifiedAvailabilityAlternatives } from "../../services/availabilityRejectionAlternatives.js";
import { resolveBookingDateWindowFromDuration } from "./resolveBookingDateWindow.js";
import {
  FALLBACK_BUSINESS_TIMEZONE,
} from "./resolveCalendarDateWindow.js";
import { resolveOpenAiChatCompletionsCreate } from "../../services/openaiChatCompletionsCreate.js";
import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";
import { decideEmilyPendingFollowUp } from "../availability/decideEmilyPendingFollowUp.js";
import { readEmilyPendingFromMemory } from "../availability/emilyPendingContext.js";
import { composeUnavailableCustomerReplyFromFacts } from "../workflows/AvailabilityInquiryWorkflow.js";
import {
  applyCustomerSemanticIntentToSignals,
  requestedFieldForCustomerSemanticIntent,
  workflowTypeForCustomerSemanticIntent,
} from "../decisions/projectSemanticIntentFromBrainDecision.js";
import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";

/**
 * @param {unknown} message
 * @returns {string}
 */
function normalizeMessage(message) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasValue(value) {
  return String(value ?? "").trim().length > 0;
}

/**
 * @param {string} normalizedMessage
 * @returns {string[]}
 */
function collectWeakContextSignals(normalizedMessage) {
  const out = [];
  if (
    /\b(chahiye|chahye|chaiye|chaahiye|chyh|chahie|need|want)\b/i.test(normalizedMessage)
  ) {
    out.push("need_context");
  }
  if (/\b(final|done|proceed)\b/i.test(normalizedMessage)) {
    out.push("weak_commitment_keyword");
  }
  if (/\d+\s*(?:din|deen|dino|day|days|ghanty|ghante|ghanta|hour|hours)\b/i.test(normalizedMessage)) {
    out.push("duration_context");
  }
  if (/\b(?:kal|tomorrow)\b/i.test(normalizedMessage)) {
    out.push("date_context");
  }
  if (/\bk\s*(?:lye|liye|lie|keliye)\b/i.test(normalizedMessage)) {
    out.push("for_context");
  }
  return [...new Set(out)];
}

/**
 * Owner-check readiness / turn metadata duration.
 *
 * Explicit / assist duration wins. Otherwise date_context or duration_context (the same
 * weak signals that make owner-check "ready") map to durationDays=1 for readiness only.
 *
 * Window math for date_context ("kal"/tomorrow) is resolved separately via
 * calendar-relative boundaries — do not treat this `1` as a rolling now→now+1d
 * overlap window when calendarRelative is applied.
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   assistDurationDays?: number | null,
 *   normalizedMessage?: string,
 * }} p
 * @returns {number | null}
 */
export function resolveOwnerCheckAlignedDurationDays(p = {}) {
  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Math.max(1, Math.floor(explicit));
  }
  const assist = Number(p.assistDurationDays);
  if (Number.isFinite(assist) && assist >= 1) {
    return Math.max(1, Math.floor(assist));
  }
  const weak = collectWeakContextSignals(String(p.normalizedMessage ?? ""));
  if (weak.includes("date_context") || weak.includes("duration_context")) {
    return 1;
  }
  return null;
}

/**
 * Canonical rental duration for booking/pricing/owner-check windows.
 * Never treats weak readiness `1` (kal/date_context) as rental days.
 * Never inherits `lastDurationDays` without a trusted continuation co-signal.
 *
 * Precedence:
 * 1. explicit current-message duration
 * 2. pending temporal-clarification continuation (already item/TTL-matched
 *    by the caller — narrow, single-purpose carrier, distinct from #3/#5)
 * 3. fresh trusted availability assist
 * 4. active trusted AVR lifecycle duration
 * 5. gated session duration only with trustedContinuation co-signal
 * 6. none
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   pendingClarificationDurationDays?: number | null,
 *   freshAssist?: Record<string, unknown> | null,
 *   activeAvrDurationDays?: number | null,
 *   sessionDurationDays?: number | null,
 *   trustedContinuation?: boolean,
 * }} p
 * @returns {{
 *   days: number | null,
 *   source: "explicit" | "temporal_clarification_continuation" | "assist" | "avr" | "gated_session" | "none",
 *   trustedContinuation: boolean,
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 *   calendarRelative: "tomorrow" | null,
 * }}
 */
export function resolveCanonicalRentalDuration(p = {}) {
  const empty = Object.freeze({
    days: null,
    source: /** @type {const} */ ("none"),
    trustedContinuation: false,
    windowStartAt: null,
    windowEndAt: null,
    calendarRelative: null,
  });

  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(explicit)),
      source: /** @type {const} */ ("explicit"),
      trustedContinuation: false,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  // Narrow, single-purpose carrier: already item-matched and TTL-checked by
  // the caller (readFreshPendingTemporalClarification), and only ever
  // produced by the temporal_unresolved clarification branch itself. Sits
  // above assist/avr because it is the most specific, most recently-known
  // truth for this exact continuation — but explicit current-turn duration
  // (above) always overrides it.
  const pendingClarificationDays = Number(p.pendingClarificationDurationDays);
  if (Number.isFinite(pendingClarificationDays) && pendingClarificationDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(pendingClarificationDays)),
      source: /** @type {const} */ ("temporal_clarification_continuation"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  const assist =
    p.freshAssist && typeof p.freshAssist === "object"
      ? /** @type {Record<string, unknown>} */ (p.freshAssist)
      : null;
  const assistDays = Number(assist?.durationDays);
  if (assist && Number.isFinite(assistDays) && assistDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(assistDays)),
      source: /** @type {const} */ ("assist"),
      trustedContinuation: true,
      windowStartAt: String(assist.windowStartAt ?? "").trim() || null,
      windowEndAt: String(assist.windowEndAt ?? "").trim() || null,
      calendarRelative: null,
    });
  }

  const avrDays = Number(p.activeAvrDurationDays);
  if (Number.isFinite(avrDays) && avrDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(avrDays)),
      source: /** @type {const} */ ("avr"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  const sessionDays = Number(p.sessionDurationDays);
  if (
    p.trustedContinuation === true &&
    Number.isFinite(sessionDays) &&
    sessionDays >= 1
  ) {
    return Object.freeze({
      days: Math.max(1, Math.floor(sessionDays)),
      source: /** @type {const} */ ("gated_session"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  return empty;
}

/**
 * Trusted co-signals that may authorize gated session duration inheritance.
 * Assist / active AVR own the request window. emilyPending and duration-ask
 * pending do NOT — pending often means duration is missing or unrelated.
 *
 * @param {{
 *   freshAssist?: Record<string, unknown> | null,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   activeAvrDurationDays?: number | null,
 *   participantKey?: string | null,
 * }} p
 * @returns {boolean}
 */
export function hasTrustedDurationContinuation(p = {}) {
  if (p.freshAssist) return true;
  const avrDays = Number(p.activeAvrDurationDays);
  if (Number.isFinite(avrDays) && avrDays >= 1) return true;
  // Do not treat emilyPending / collect-duration pending as duration ownership.
  return false;
}

/**
 * Optional active AVR duration from session memory (no new timer service).
 * @param {Record<string, unknown> | null | undefined} memory
 * @returns {number | null}
 */
function readActiveAvrDurationDaysFromMemory(memory) {
  if (!memory || typeof memory !== "object") return null;
  const candidates = [
    memory.activeAvailabilityRequest,
    memory.lastAvailabilityRequest,
    memory.pendingAvailabilityRequest,
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const status = String(row.status ?? "").trim().toLowerCase();
    if (
      status &&
      ["rejected", "expired", "cancelled", "canceled", "superseded", "closed"].includes(
        status
      )
    ) {
      continue;
    }
    const days = Number(row.requestedDuration ?? row.durationDays ?? row.requestedDurationDays);
    if (Number.isFinite(days) && days >= 1) return Math.max(1, Math.floor(days));
  }
  return null;
}

/**
 * Calendar relative for availability overlap only.
 * Explicit numeric duration always wins; "kal"/tomorrow uses calendar window.
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   normalizedMessage?: string,
 * }} p
 * @returns {"tomorrow" | null}
 */
export function resolveAvailabilityCalendarRelative(p = {}) {
  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) return null;
  const weak = collectWeakContextSignals(String(p.normalizedMessage ?? ""));
  if (weak.includes("date_context")) return "tomorrow";
  return null;
}

/**
 * Business IANA timezone for calendar windows.
 * Prefers an explicit caller/profile value; falls back to CarUpNow temporary default.
 *
 * @param {{
 *   businessTimeZone?: string | null,
 *   timeZone?: string | null,
 * }} [p]
 * @returns {string}
 */
export function resolveBusinessTimeZoneForAvailability(p = {}) {
  const fromCaller =
    String(p.businessTimeZone ?? p.timeZone ?? "").trim() || null;
  if (fromCaller) return fromCaller;
  // Future: read structured business-profile timezone when available.
  return FALLBACK_BUSINESS_TIMEZONE;
}

/**
 * Bare chahiye/need/want with resolved item + duration/date is an owner availability check,
 * not a final booking command.
 *
 * @param {string} normalizedMessage
 * @param {Record<string, unknown>} signals
 * @param {{ durationDays?: number | null, hasResolvedItem?: boolean }} [context]
 * @returns {boolean}
 */
export function isWeakNeedOwnerAvailabilityInquiry(
  normalizedMessage,
  signals,
  context = {}
) {
  if (context.hasResolvedItem !== true) return false;
  if (Boolean(signals?.priceAsk) || Boolean(signals?.availabilityAsk)) return false;
  if (Boolean(signals?.strongBookingCommitment)) return false;

  const weakContextSignals = collectWeakContextSignals(normalizedMessage);
  if (!weakContextSignals.includes("need_context")) return false;

  const durationDays = Number(context.durationDays);
  if (Number.isFinite(durationDays) && durationDays >= 1) return true;
  if (weakContextSignals.includes("date_context")) return true;
  if (weakContextSignals.includes("duration_context")) return true;
  return false;
}

/**
 * Canonical price field from turn authority / answerComposer — not signals.priceAsk.
 * @param {string | null | undefined} requestedField
 * @returns {boolean}
 */
function isCanonicalPriceRequestedField(requestedField) {
  const field = String(requestedField ?? "").trim().toLowerCase();
  return field.startsWith("price");
}

/**
 * @param {Record<string, unknown>} p
 */
function buildContextToPersist(p) {
  if (p.memoryAllowed !== true || !hasValue(p.resolvedItemId)) {
    return Object.freeze({
      memoryAllowed: Boolean(p.memoryAllowed),
      rememberResolvedItem: false,
      itemId: null,
      rememberDuration: false,
      durationDays: null,
    });
  }
  const durationDays = Number(p.durationDays);
  const rememberDuration = Number.isFinite(durationDays) && durationDays >= 1;
  return Object.freeze({
    memoryAllowed: true,
    rememberResolvedItem: true,
    itemId: String(p.resolvedItemId),
    rememberDuration,
    durationDays: rememberDuration ? Math.max(1, Math.floor(durationDays)) : null,
  });
}

/**
 * @param {{
 *   normalizedMessage: string,
 *   understanding: Record<string, unknown> | null,
 *   signals: Record<string, unknown>,
 *   itemFacts: Record<string, unknown>,
 *   participantFacts: Record<string, unknown>,
 *   memoryPendingAction?: unknown,
 *   canonicalDurationDays?: number | null,
 *   turnShape?: string | null,
 *   validatedGroupCanonicalAuthority?: boolean,
 * }} p
 */
function resolveBusinessDecision(p) {
  const signals = p.signals ?? {};
  const understanding = p.understanding ?? {};
  const turnShape = String(p.turnShape ?? "").trim();
  const candidateItemId = hasValue(p.itemFacts?.id)
    ? String(p.itemFacts.id)
    : null;
  const resolvedItemId =
    p.validatedGroupCanonicalAuthority === true &&
    p.itemFacts?.status !== "resolved"
      ? null
      : candidateItemId;
  const understandingDuration =
    understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : null;
  const canonicalDuration =
    p.canonicalDurationDays != null && Number.isFinite(Number(p.canonicalDurationDays))
      ? Math.max(1, Math.floor(Number(p.canonicalDurationDays)))
      : null;
  // Single SoT: prefer packed canonical rental duration; fall back to message-only.
  const durationDays = canonicalDuration ?? understandingDuration;
  const requestedField =
    String(understanding?.askedField ?? signals.askedFieldRaw ?? signals.askedField ?? "").trim() || null;
  const weakContextSignals = collectWeakContextSignals(p.normalizedMessage);
  const strongBookingCommand = Boolean(signals.strongBookingCommitment);
  const memoryAllowed = p.participantFacts?.participant?.memoryAllowed === true;
  const hasResolvedItem = hasValue(resolvedItemId);
  const unlistedMentionLabel = String(understanding?.unlistedMentionLabel ?? "").trim() || null;
  const clearBusinessIntentWithoutResolvedItem =
    !hasResolvedItem &&
    Boolean(unlistedMentionLabel) &&
    (signals.photoAsk || signals.priceAsk || signals.availabilityAsk || strongBookingCommand);
  const secondaryIntents = [];
  if (weakContextSignals.length > 0) secondaryIntents.push("context_capture");
  if (signals.availabilityAsk && signals.priceAsk) secondaryIntents.push("availability_context");
  if (durationDays != null) secondaryIntents.push("duration_context");
  const availabilityDurationPending = isAvailabilityDurationPendingAction(p.memoryPendingAction);
  const canonicalItemlessPriceFollowup =
    turnShape === "itemless_price_followup" &&
    isCanonicalPriceRequestedField(requestedField);

  let primaryIntent = "unknown";
  let workflowType = "unknown_clarification";
  let replyType = "clarification";
  let confidence = hasResolvedItem ? "medium" : "low";
  let reason = "no_matching_business_decision";
  let sideEffectsAllowed = [];

  const authoritativeSemanticIntent = cleanCustomerSemanticIntent(
    p.authoritativeSemanticIntent ?? understanding?.authoritativeSemanticIntent
  );
  const authoritativeItemScope = ["specific", "broad", "none"].includes(
    p.authoritativeItemScope
  )
    ? p.authoritativeItemScope
    : null;
  if (authoritativeSemanticIntent) {
    const canonicalWorkflowType = workflowTypeForCustomerSemanticIntent(
      authoritativeSemanticIntent
    );
    const canonicalRequestedField = requestedFieldForCustomerSemanticIntent(
      authoritativeSemanticIntent,
      requestedField
    );
    const canonicalItemReferents = Array.isArray(understanding?.canonicalItemReferents)
      ? understanding.canonicalItemReferents
      : [];
    const boundedExplicitItemIds = Array.isArray(understanding?.resolvedItemIds)
      ? understanding.resolvedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    if (
      p.validatedGroupCanonicalAuthority === true &&
      authoritativeItemScope === "specific" &&
      !hasResolvedItem
    ) {
      return Object.freeze({
        primaryIntent: authoritativeSemanticIntent,
        secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
        workflowType: "clarification",
        replyType: "clarification",
        requestedField: canonicalRequestedField,
        resolvedItemId: null,
        boundedExplicitItemIds: Object.freeze([...boundedExplicitItemIds]),
        durationDays,
        strongBookingCommand: authoritativeSemanticIntent === "booking_request",
        weakContextSignals: Object.freeze(weakContextSignals),
        sideEffectsAllowed: Object.freeze([]),
        contextToPersist: Object.freeze({}),
        confidence: "high",
        reason: "validated_group_item_not_resolved",
      });
    }
    if (authoritativeItemScope === "specific" && canonicalItemReferents.length > 1) {
      return Object.freeze({
        primaryIntent: authoritativeSemanticIntent,
        secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
        workflowType: "clarification",
        replyType: "clarification",
        requestedField: canonicalRequestedField,
        resolvedItemId: null,
        boundedExplicitItemIds: Object.freeze([...boundedExplicitItemIds]),
        durationDays,
        strongBookingCommand: authoritativeSemanticIntent === "booking_request",
        weakContextSignals: Object.freeze(weakContextSignals),
        sideEffectsAllowed: Object.freeze([]),
        contextToPersist: Object.freeze({}),
        confidence: "high",
        reason: "bounded_explicit_item_set_requires_clarification",
      });
    }
    return Object.freeze({
      primaryIntent: authoritativeSemanticIntent,
      secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
      workflowType: canonicalWorkflowType ?? "clarification",
      replyType: canonicalWorkflowType === "browse_options"
          ? "browse_options"
          : canonicalWorkflowType === "availability_inquiry"
            ? "availability_answer"
            : canonicalWorkflowType === "pricing_inquiry" ||
                canonicalWorkflowType === "pricing_with_duration"
              ? "price_answer"
              : canonicalWorkflowType === "booking_request"
                ? "booking_ack"
                : canonicalWorkflowType === "image_catalog_request"
                  ? "image_catalog"
                  : "clarification",
      requestedField: canonicalRequestedField,
      resolvedItemId,
      durationDays,
      strongBookingCommand: authoritativeSemanticIntent === "booking_request",
      weakContextSignals: Object.freeze(weakContextSignals),
      sideEffectsAllowed: Object.freeze(
        authoritativeSemanticIntent === "booking_request"
          ? ["booking_request"]
          : []
      ),
      contextToPersist: buildContextToPersist({
        memoryAllowed,
        resolvedItemId,
        durationDays,
      }),
      confidence: "high",
      reason: "canonical_semantic_intent_authoritative",
    });
  }

  if (signals.photoAsk && hasResolvedItem) {
    primaryIntent = "image_catalog_request";
    workflowType = "image_catalog_request";
    replyType = "image_catalog";
    confidence = "high";
    reason = "explicit_media_request_wins";
  } else if (
    hasResolvedItem &&
    durationDays != null &&
    (signals.priceAsk || canonicalItemlessPriceFollowup)
  ) {
    primaryIntent = "pricing_with_duration";
    workflowType = "pricing_with_duration";
    replyType = "price_answer";
    confidence = "high";
    reason = canonicalItemlessPriceFollowup && !signals.priceAsk
      ? "itemless_price_followup_wins_over_weak_need"
      : weakContextSignals.length > 0
        ? "explicit_rent_question_wins_over_weak_need_duration_context"
        : "explicit_rent_question_with_duration";
  } else if (signals.priceAsk && hasResolvedItem) {
    primaryIntent = "pricing_inquiry";
    workflowType = "pricing_inquiry";
    replyType = "price_answer";
    confidence = "high";
    reason =
      weakContextSignals.length > 0
        ? "explicit_price_question_wins_over_weak_context"
        : "explicit_price_question";
  } else if (
    signals.browseAsk ||
    isGenericBrowseListAsk(p.normalizedMessage)
  ) {
    primaryIntent = "browse_options";
    workflowType = "browse_options";
    replyType = "browse_options";
    confidence = "high";
    reason = "broad_browse_does_not_inherit_trusted_item";
  } else if (signals.availabilityAsk && hasResolvedItem) {
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason = "explicit_availability_question";
  } else if (
    availabilityDurationPending &&
    hasResolvedItem &&
    !signals.priceAsk
  ) {
    // Emily asked for duration on availability — keep context on availability (not booking).
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason =
      durationDays != null || weakContextSignals.includes("duration_context")
        ? "availability_duration_pending_context"
        : "availability_duration_pending_follow_up_context";
  } else if (
    isWeakNeedOwnerAvailabilityInquiry(p.normalizedMessage, signals, {
      durationDays,
      hasResolvedItem,
    })
  ) {
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason = "item_duration_need_is_owner_availability_check";
  } else if (
    hasResolvedItem &&
    (strongBookingCommand || Boolean(signals.bookingCommitment))
  ) {
    // Single booking-intent source of truth for Fix 1/2 gates: workflowType.
    // bookingCommitment already powers WorkflowEngine explicit_booking_commitment;
    // do not require a second stronger phrase test downstream. Weak need /
    // price / availability branches above still win first.
    primaryIntent = "booking_request";
    workflowType = "booking_request";
    replyType = "booking_ack";
    confidence = "high";
    reason = strongBookingCommand
      ? "strong_booking_command"
      : "explicit_booking_commitment";
    sideEffectsAllowed = ["booking_request"];
  } else if (clearBusinessIntentWithoutResolvedItem) {
    primaryIntent = "unlisted_item";
    workflowType = "unlisted_item";
    replyType = "unlisted_item_clarification";
    confidence = "medium";
    reason = "clear_business_intent_item_not_offered";
  } else if (
    hasResolvedItem &&
    durationDays != null &&
    /\b(?:kya|kitna|kitni|kitne|ktna|ho\s*ga|hoga|hogi|banega|banta)\b/i.test(p.normalizedMessage)
  ) {
    primaryIntent = "pricing_with_duration";
    workflowType = "pricing_with_duration";
    replyType = "price_answer";
    confidence = "medium";
    reason = "item_context_duration_amount_followup";
  }

  return Object.freeze({
    primaryIntent,
    secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
    workflowType,
    replyType,
    requestedField,
    resolvedItemId,
    durationDays,
    strongBookingCommand,
    weakContextSignals: Object.freeze(weakContextSignals),
    sideEffectsAllowed: Object.freeze(sideEffectsAllowed),
    contextToPersist: buildContextToPersist({
      memoryAllowed,
      resolvedItemId,
      durationDays,
    }),
    confidence,
    reason,
  });
}

/**
 * Test/helper export — same decision core used by resolveBusinessTurnContext.
 * @param {Parameters<typeof resolveBusinessDecision>[0]} p
 */
export function resolveBusinessDecisionForPendingContext(p) {
  return resolveBusinessDecision(p);
}

/**
 * @param {string} rawMessage
 * @param {{ browseAsk?: boolean }} signals
 * @param {{ intentsRanked?: string[] } | null | undefined} understanding
 */
function shouldResolveCatalogBrowse(rawMessage, signals, understanding) {
  if (Boolean(signals.browseAsk)) return true;
  if (understanding?.intentsRanked?.[0] === "browse_options") return true;
  return isGenericBrowseListAsk(rawMessage);
}

/**
 * @param {{
 *   traceId: string,
 *   businessId: string,
 *   rawMessage: string,
 *   turnContextInput?: import("../contracts/turnContextInput.js").TurnContextInput | null,
 *   turnContext?: import("../contracts/workflow.js").TurnContext | null,
 *   catalogItems?: unknown[],
 *   admittedTurn?: import("../contracts/inbound.js").AdmittedTurn | null,
 *   flags?: import("../config/liveFeatureFlags.js").getEmilyBrainV2LiveFlagSnapshot extends () => infer R ? R : never,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 *   getBusinessProfileFn?: (uid: string) => Promise<unknown>,
 *   log?: boolean,
 * }} params
 */
export async function resolveBusinessTurnContext(params) {
  const traceId = String(params.traceId ?? "").trim();
  const businessId = String(params.businessId ?? "").trim();
  const rawMessage = String(params.rawMessage ?? "").trim();
  const normalizedMessage = normalizeMessage(rawMessage);
  const turnContextInput = params.turnContextInput ?? null;
  const catalogItems = Array.isArray(params.catalogItems) ? params.catalogItems : [];
  const chatType = turnContextInput?.chatType ?? "dm";
  const isGroup = chatType === "group" || turnContextInput?.chatType === "group";

  const admittedTurn =
    params.admittedTurn ??
    (rawMessage
      ? {
          turn: {
            turnId: traceId,
            businessId,
            channelId: turnContextInput?.channel ?? "whatsapp_web",
            chatKey: turnContextInput?.chatId ?? "",
            participantKey: turnContextInput?.participantKey ?? "unknown",
            text: rawMessage,
            normalizedAt: new Date().toISOString(),
          },
          idempotencyKey: `${traceId}::canonical`,
          admissionReason: "canonical_facts_probe",
        }
      : null);

  const authoritativeSemanticIntent = cleanCustomerSemanticIntent(
    turnContextInput?.authoritativeSemanticIntent ??
      params.turnContext?.authoritativeSemanticIntent
  );
  const authoritativeItemScope = ["specific", "broad", "none"].includes(
    params.turnContext?.canonicalSemanticDecision?.itemScope
  )
    ? params.turnContext.canonicalSemanticDecision.itemScope
    : null;
  // A frozen Cloud ownership decision exists for this turn (Cloud DM path).
  // When present, its temporalRequest is the single authoritative temporal
  // owner (kal/tomorrow/parson/explicit dates all included) — the legacy
  // regex signal below is never consulted, avoiding dual-source ambiguity.
  // When absent (Group/legacy/non-canonical callers), the legacy regex
  // remains the sole fallback, unchanged.
  const hasCanonicalSemanticDecision = params.turnContext?.canonicalSemanticDecision != null;
  // AI-proposed structured temporal meaning. Deterministic code below still
  // owns date validity, timezone conversion, year resolution, and the exact
  // window — this only carries the model's structural proposal through.
  const temporalRequest =
    params.turnContext?.canonicalSemanticDecision?.temporalRequest &&
    typeof params.turnContext.canonicalSemanticDecision.temporalRequest === "object"
      ? params.turnContext.canonicalSemanticDecision.temporalRequest
      : null;
  const explicitStartDateFromTemporalRequest =
    temporalRequest?.startDateKind === "explicit_date" &&
    temporalRequest?.startDate &&
    typeof temporalRequest.startDate === "object"
      ? {
          month: Number(temporalRequest.startDate.month),
          day: Number(temporalRequest.startDate.day),
        }
      : null;
  const canonicalRelativeKind =
    temporalRequest?.startDateKind === "relative_tomorrow"
      ? "tomorrow"
      : temporalRequest?.startDateKind === "relative_day_after_tomorrow"
        ? "day_after_tomorrow"
        : null;
  // A trusted date-bearing reference exists (invalid, or a customer date the
  // model could not represent) that must never be silently treated as "no
  // date" — the availability layer fails closed instead of defaulting to now.
  const temporalUnresolvedRequested = temporalRequest?.startDateKind === "unresolved";
  const understanding =
    admittedTurn && params.turnContext
      ? understandTurn({
          admittedTurn,
          turnContext: params.turnContext,
          catalogItems,
        })
      : admittedTurn
        ? understandTurn({
            admittedTurn,
            turnContext: {
              sessionId: traceId,
              businessId,
              chatKey: turnContextInput?.chatId ?? "",
              participantKey: turnContextInput?.participantKey ?? "unknown",
              schemaVersion: 1,
              lastResolvedItemId: String(
                turnContextInput?.authoritativeItem?.id ?? ""
              ).trim() || undefined,
              memorySnapshot: {},
            },
            catalogItems,
          })
        : null;

  const itemMentioned = understanding?.itemSource === "explicit";
  const rawSignals = authoritativeSemanticIntent
    ? {
        priceAsk: false,
        availabilityAsk: false,
        bookingCommitment: false,
        browseAsk: false,
        photoAsk: false,
        detailsAsk: false,
        durationMentioned: understanding?.durationDays != null,
        rentAvailabilityCompound: false,
      }
    : extractTurnSignals({
        message: rawMessage,
        hasDuration: understanding?.durationDays != null,
        itemMentioned,
      });
  const signals = applyCustomerSemanticIntentToSignals(
    rawSignals,
    authoritativeSemanticIntent
  );

  const itemFacts = resolveCatalogItemFacts({
    understanding,
    turnContextInput,
    catalogItems,
  });

  const pricingFacts = resolvePricingFacts({
    catalogRow: itemFacts.catalogRow,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    signals,
    durationDays: understanding?.durationDays ?? turnContextInput?.duration ?? null,
  });

  const mediaFacts = resolveMediaFacts({
    catalogRow: itemFacts.catalogRow,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
  });

  const participantFacts = resolveParticipantFacts(turnContextInput);
  const sourceMessageId = String(turnContextInput?.sourceMessageId ?? "").trim() || null;
  const sourceRowKey = String(turnContextInput?.sourceRowKey ?? "").trim() || null;
  const guaranteeKey = String(turnContextInput?.guaranteeKey ?? "").trim() || null;
  const sourceTurnKey = guaranteeKey || sourceRowKey || sourceMessageId || null;
  const sourceIdentity = {
    participantKey: participantFacts.participant.key,
    participantIdentity: participantFacts.participant.identity,
    participantWaId:
      String(turnContextInput?.participantWaId ?? "").trim().toLowerCase() || null,
    chatId: String(turnContextInput?.chatId ?? "").trim() || null,
    chatType: turnContextInput?.chatType ?? null,
    sourceMessageId,
    sourceRowKey,
    guaranteeKey,
    sourceTurnKey,
  };

  const flags = params.flags ?? {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: false,
    availabilityOwnerNotifyExecute: false,
    availabilityCustomerDmExecute: false,
    dmExecute: false,
  };
  const actionFacts = resolveActionPolicyFacts(flags);

  const memorySnapshot =
    (params.turnContext?.memorySnapshot &&
    typeof params.turnContext.memorySnapshot === "object" &&
    !Array.isArray(params.turnContext.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (params.turnContext.memorySnapshot)
      : null) ||
    (turnContextInput?.memorySnapshot &&
    typeof turnContextInput.memorySnapshot === "object" &&
    !Array.isArray(turnContextInput.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (turnContextInput.memorySnapshot)
      : null) ||
    {};

  const lastAvailabilityAssist = readFreshLastAvailabilityAssist(
    memorySnapshot.lastAvailabilityAssist
  );

  const explicitDurationDaysForFacts =
    understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : turnContextInput?.duration != null && Number.isFinite(Number(turnContextInput.duration))
        ? Math.max(1, Math.floor(Number(turnContextInput.duration)))
        : null;

  const activeAvrDurationDays = readActiveAvrDurationDaysFromMemory(memorySnapshot);
  const participantKeyForDuration =
    String(participantFacts?.participant?.key ?? "").trim() ||
    String(sourceIdentity?.participantKey ?? "").trim() ||
    null;
  const trustedContinuation = hasTrustedDurationContinuation({
    freshAssist: lastAvailabilityAssist,
    memorySnapshot,
    activeAvrDurationDays,
    participantKey: participantKeyForDuration,
  });
  const sessionDurationDays =
    memorySnapshot.lastDurationDays != null &&
    Number.isFinite(Number(memorySnapshot.lastDurationDays))
      ? Math.max(1, Math.floor(Number(memorySnapshot.lastDurationDays)))
      : null;

  // Pending temporal-clarification continuation: only ever consulted when
  // this exact turn is itself carrying a start-date signal (a resolved
  // date, a relative date, or still-unresolved) for the SAME item the
  // clarification was raised for. An ordinary contextual turn with no
  // temporal signal at all (price question, image request, etc.) never
  // reads this, even for the same item within the TTL window — that is the
  // structural boundary that keeps this narrow and non-generic.
  const pendingTemporalClarificationRaw =
    memorySnapshot.pendingTemporalClarification &&
    typeof memorySnapshot.pendingTemporalClarification === "object" &&
    !Array.isArray(memorySnapshot.pendingTemporalClarification)
      ? memorySnapshot.pendingTemporalClarification
      : null;
  const isResolvingTemporalClarification =
    explicitStartDateFromTemporalRequest != null ||
    canonicalRelativeKind != null ||
    temporalUnresolvedRequested === true;
  const nowMsForPendingClarification = Number.isFinite(Number(params.nowMs))
    ? Number(params.nowMs)
    : Date.now();
  const pendingTemporalClarification = isResolvingTemporalClarification
    ? readFreshPendingTemporalClarification(pendingTemporalClarificationRaw, {
        itemId: itemFacts.id,
        nowMs: nowMsForPendingClarification,
      })
    : null;

  const canonicalDuration = resolveCanonicalRentalDuration({
    explicitDurationDays: explicitDurationDaysForFacts,
    pendingClarificationDurationDays: pendingTemporalClarification?.durationDays ?? null,
    freshAssist: lastAvailabilityAssist,
    activeAvrDurationDays,
    sessionDurationDays,
    trustedContinuation,
  });

  // Readiness/metadata duration (may be 1 for date_context). Overlap window is separate.
  // Rental/booking windows must use canonicalDuration.days — never weak readiness 1 alone.
  const durationDaysResolved = resolveOwnerCheckAlignedDurationDays({
    explicitDurationDays: explicitDurationDaysForFacts,
    assistDurationDays: lastAvailabilityAssist?.durationDays,
    normalizedMessage,
  });
  // Single temporal owner for Cloud turns: once a frozen ownership decision
  // exists, its temporalRequest is authoritative (kal/tomorrow included) and
  // the legacy regex signal is never consulted, even when it would disagree.
  // The regex remains the sole source only when no canonical decision exists
  // at all (Group/legacy/non-canonical callers of this function).
  const legacyCalendarRelative = resolveAvailabilityCalendarRelative({
    explicitDurationDays: explicitDurationDaysForFacts,
    normalizedMessage,
  });
  const calendarRelative = hasCanonicalSemanticDecision
    ? canonicalRelativeKind
    : legacyCalendarRelative;
  // True whenever the window's date signal came from the canonical AI
  // decision (duration sizes the window) rather than the legacy regex
  // fallback (fixed 1-day "kal" window, duration suppressed — unchanged).
  const hasNewTemporalContractWindow =
    explicitStartDateFromTemporalRequest != null ||
    temporalUnresolvedRequested ||
    (hasCanonicalSemanticDecision && calendarRelative != null);
  const rentalDurationDays = canonicalDuration.days;
  const availabilityTimeZone = resolveBusinessTimeZoneForAvailability({
    businessTimeZone: params.businessTimeZone ?? params.timeZone ?? null,
  });
  const clockNowMs = Number.isFinite(Number(params.nowMs))
    ? Number(params.nowMs)
    : Date.now();

  const availabilityFacts = await resolveAvailabilityFacts({
    businessId,
    catalogRow: itemFacts.catalogRow,
    itemId: itemFacts.id,
    itemName: itemFacts.name,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    // Prefer canonical rental days; fall back to readiness only when calendarRelative
    // is unset and no rental days (legacy owner-check readiness path).
    // Explicit date / day_after_tomorrow (the new temporal contract) always
    // size their window from the real duration — only legacy kal/tomorrow
    // keeps its original fixed single-day window.
    durationDays:
      hasNewTemporalContractWindow
        ? (rentalDurationDays ?? durationDaysResolved)
        : calendarRelative
          ? null
          : rentalDurationDays ?? durationDaysResolved,
    calendarRelative,
    explicitStartDate: explicitStartDateFromTemporalRequest,
    temporalUnresolved: temporalUnresolvedRequested,
    timeZone: availabilityTimeZone,
    getBookingsForItemFn: params.getBookingsForItemFn,
    ...(function resolveAvailabilityNowMs() {
      if (calendarRelative || hasNewTemporalContractWindow) {
        return { nowMs: clockNowMs };
      }
      const startMs = Date.parse(
        String(canonicalDuration.windowStartAt ?? lastAvailabilityAssist?.windowStartAt ?? "")
      );
      const hasExplicitCurrentDates =
        Array.isArray(understanding?.requestedDates) &&
        understanding.requestedDates.some((d) => String(d ?? "").trim());
      // Reuse stored assist start whenever follow-up keeps the original duration window.
      if (
        (canonicalDuration.source === "assist" || lastAvailabilityAssist) &&
        Number.isFinite(startMs) &&
        !hasExplicitCurrentDates
      ) {
        return { nowMs: startMs };
      }
      return { nowMs: clockNowMs };
    })(),
  });

  /** @type {Array<{ itemId: string, itemLabel: string }>} */
  let verifiedAlternatives = [];
  const availabilityForAlts = availabilityFacts.availability;
  const assistStartMs = Date.parse(String(lastAvailabilityAssist?.windowStartAt ?? ""));
  const assistEndMs = Date.parse(String(lastAvailabilityAssist?.windowEndAt ?? ""));
  const assistWindow =
    lastAvailabilityAssist != null
      ? Number.isFinite(assistStartMs) &&
        Number.isFinite(assistEndMs) &&
        assistEndMs > assistStartMs
        ? {
            startAt: new Date(assistStartMs),
            endAt: new Date(assistEndMs),
            durationDays: lastAvailabilityAssist.durationDays,
            confidence: "assist_stored_window",
          }
        : resolveBookingDateWindowFromDuration(lastAvailabilityAssist.durationDays)
      : null;
  const unavailableWindow =
    availabilityForAlts?.windowApplied === true &&
    availabilityForAlts?.requestedStartAt &&
    availabilityForAlts?.requestedEndAt
      ? {
          start: availabilityForAlts.requestedStartAt,
          end: availabilityForAlts.requestedEndAt,
        }
      : null;
  const shouldLoadAlternatives =
    (isConfidentInventoryUnavailable(availabilityForAlts) &&
      String(itemFacts.id ?? "").trim() !== "") ||
    lastAvailabilityAssist != null;
  if (shouldLoadAlternatives) {
    const excludeId =
      String(
        (isConfidentInventoryUnavailable(availabilityForAlts)
          ? itemFacts.id
          : null) ??
          lastAvailabilityAssist?.unavailableItemId ??
          ""
      ).trim() || null;
    const referenceLabel =
      String(
        itemFacts.displayLabel ??
          itemFacts.name ??
          lastAvailabilityAssist?.unavailableItemLabel ??
          ""
      ).trim() || "item";
    const windowStart =
      unavailableWindow?.start ?? assistWindow?.startAt ?? null;
    const windowEnd = unavailableWindow?.end ?? assistWindow?.endAt ?? null;
    if (excludeId) {
      try {
        verifiedAlternatives = await findVerifiedAvailabilityAlternatives({
          businessId,
          excludeItemId: excludeId,
          referenceItemLabel: referenceLabel,
          limit: 3,
          requestedStart: windowStart,
          requestedEnd: windowEnd,
          catalogRows: catalogItems,
          getBookingsForItemFn: params.getBookingsForItemFn,
        });
      } catch {
        verifiedAlternatives = [];
      }
    }
  }
  availabilityFacts.availability = {
    ...availabilityFacts.availability,
    verifiedAlternatives,
  };

  let unavailableCustomerReply = null;
  let presentedAlternativeItemIds = [];
  if (
    isConfidentInventoryUnavailable(availabilityFacts.availability) &&
    lastAvailabilityAssist == null
  ) {
    const conversationalLabel =
      String(
        itemFacts.displayLabel ??
          itemFacts.name ??
          lastAvailabilityAssist?.unavailableItemLabel ??
          ""
      ).trim() || "item";
    const durationForReply = Math.max(
      1,
      Math.floor(
        Number(
          rentalDurationDays ??
            durationDaysResolved ??
            lastAvailabilityAssist?.durationDays ??
            understanding?.durationDays ??
            1
        ) || 1
      )
    );
    try {
      const composedUnavailable = await composeUnavailableCustomerReplyFromFacts({
        conversationalLabel,
        durationDays: durationForReply,
        alternatives: verifiedAlternatives,
        returnPresentationMetadata: true,
        chatCompletionsCreate:
          typeof params.__unavailableReplyChatCreate === "function"
            ? null
            : resolveOpenAiChatCompletionsCreate(),
        __chatCompletionsCreateForTests:
          typeof params.__unavailableReplyChatCreate === "function"
            ? params.__unavailableReplyChatCreate
            : null,
        __replyForTests:
          typeof params.__unavailableReplyForTests === "string"
            ? params.__unavailableReplyForTests
            : null,
        __presentedItemIdsForTests: Array.isArray(params.__presentedItemIdsForTests)
          ? params.__presentedItemIdsForTests
          : null,
      });
      unavailableCustomerReply = String(composedUnavailable?.reply ?? "").trim() || null;
      presentedAlternativeItemIds = Array.isArray(composedUnavailable?.presentedItemIds)
        ? composedUnavailable.presentedItemIds
        : [];
    } catch {
      unavailableCustomerReply = null;
      presentedAlternativeItemIds = [];
    }
  }

  let availabilityAssistFollowUp = null;
  const canonicalCloudDm =
    String(turnContextInput?.channel ?? params.turnContext?.channel ?? "") ===
      "whatsapp_cloud" &&
    String(turnContextInput?.chatType ?? params.turnContext?.chatType ?? "") !==
      "group" &&
    Boolean(authoritativeSemanticIntent);
  const validatedGroupCanonical =
    turnContextInput?.validatedGroupCanonicalAuthority === true;
  if (
    lastAvailabilityAssist &&
    !canonicalCloudDm &&
    !validatedGroupCanonical
  ) {
    try {
      availabilityAssistFollowUp = await decideAvailabilityAssistFollowUp({
        customerText: rawMessage,
        recentConversation:
          turnContextInput?.conversationHistory ??
          params.turnContext?.conversationHistory ??
          null,
        lastAvailabilityAssist,
        understanding: {
          resolvedItemId: itemFacts.id,
          resolvedItemLabel: itemFacts.displayLabel ?? itemFacts.name,
          signals,
          askedField: understanding?.askedField ?? null,
        },
        verifiedAlternatives,
        requestedDurationDays: rentalDurationDays ?? durationDaysResolved,
        requestedStartAt: lastAvailabilityAssist.windowStartAt,
        requestedEndAt: lastAvailabilityAssist.windowEndAt,
        pendingQuestion: lastAvailabilityAssist.pendingQuestion ?? null,
        pendingPromptType: lastAvailabilityAssist.pendingPromptType ?? null,
        assistStage: lastAvailabilityAssist.assistStage ?? null,
        participantKey:
          String(participantFacts?.participant?.key ?? "").trim() ||
          String(sourceIdentity?.participantKey ?? "").trim() ||
          null,
        __decisionForTests: params.__availabilityAssistFollowUpDecision ?? null,
        __chatCompletionsCreateForTests:
          params.__availabilityAssistFollowUpChatCreate ?? null,
        chatCompletionsCreate:
          typeof params.__availabilityAssistFollowUpChatCreate === "function"
            ? null
            : resolveOpenAiChatCompletionsCreate(),
      });
    } catch {
      availabilityAssistFollowUp = {
        decision: "unclear",
        confidence: 0,
        selectedItemId: null,
        shouldClearAssist: true,
        reason: "assist_follow_up_exception",
        ok: false,
        source: "fallback",
      };
    }
  }

  const catalogBrowseFacts = shouldResolveCatalogBrowse(rawMessage, signals, understanding)
    ? await resolveCatalogBrowseAvailabilityFacts({
        businessId,
        catalogItems,
        getBookingsForItemFn: params.getBookingsForItemFn,
      })
    : null;

  const businessFacts = await resolveBusinessProfileFacts(
    businessId,
    params.getBusinessProfileFn
  );

  const memoryAllowed = participantFacts.participant.memoryAllowed === true;
  const groupItemlessFollowupAllowed =
    memoryAllowed && !turnContextInput?.shouldClarifyItem;

  const resolved = {
    schemaVersion: CANONICAL_FACTS_SCHEMA_VERSION,
    traceId,
    businessId,
    rawMessage,
    normalizedMessage,
    chatType,
    isGroup,

    turn: {
      intent: authoritativeSemanticIntent ?? understanding?.intentsRanked?.[0] ?? null,
      turnShape: turnContextInput?.turnShape ?? null,
      requestedField:
        understanding?.askedField ?? turnContextInput?.requestedField ?? null,
      // Canonical rental days only — never weak readiness `1` as booking duration.
      durationDays: rentalDurationDays,
      confidence: understanding?.itemConfidence ?? null,
      sourceMessageId,
      sourceRowKey,
      guaranteeKey,
      sourceTurnKey,
      ...(canonicalDuration.windowStartAt
        ? { requestedStartAt: canonicalDuration.windowStartAt }
        : hasNewTemporalContractWindow &&
            availabilityFacts.availability?.windowApplied === true &&
            availabilityFacts.availability?.requestedStartAt
          ? { requestedStartAt: availabilityFacts.availability.requestedStartAt }
          : {}),
      ...(canonicalDuration.windowEndAt
        ? { requestedEndAt: canonicalDuration.windowEndAt }
        : hasNewTemporalContractWindow &&
            availabilityFacts.availability?.windowApplied === true &&
            availabilityFacts.availability?.requestedEndAt
          ? { requestedEndAt: availabilityFacts.availability.requestedEndAt }
          : {}),
    },

    duration: Object.freeze({
      days: canonicalDuration.days,
      source: canonicalDuration.source,
      trustedContinuation: canonicalDuration.trustedContinuation,
      windowStartAt: canonicalDuration.windowStartAt,
      windowEndAt: canonicalDuration.windowEndAt,
      calendarRelative,
    }),

    signals: {
      priceAsk: Boolean(signals.priceAsk),
      availabilityAsk: Boolean(signals.availabilityAsk),
      browseAsk: Boolean(signals.browseAsk),
      bookingCommitment: Boolean(signals.bookingCommitment),
      photoAsk: Boolean(signals.photoAsk),
      contactProvided: Boolean(turnContextInput?.contact),
    },

    participant: participantFacts.participant,
    sourceIdentity,
    lastAvailabilityAssist,
    // Raw, unfiltered session value (mirrors lastAvailabilityAssist above) --
    // callers that need to detect/supersede a stale record for a DIFFERENT
    // item re-check freshness/item-match themselves via
    // readFreshPendingTemporalClarification.
    pendingTemporalClarification: pendingTemporalClarificationRaw,
    availabilityAssistFollowUp,
    unavailableCustomerReply,
    presentedAlternativeItemIds: Object.freeze([...presentedAlternativeItemIds]),
    validatedGroupCanonicalAuthority:
      turnContextInput?.validatedGroupCanonicalAuthority === true,

    resolvedItem: {
      status: itemFacts.status,
      id: itemFacts.id,
      name: itemFacts.name,
      displayLabel: itemFacts.displayLabel,
      color: itemFacts.color,
      source: itemFacts.source,
      confidence: itemFacts.confidence,
      candidates: itemFacts.candidates,
    },

    business: businessFacts.business,

    verified: {
      pricing: pricingFacts.pricing,
      priceQuote: pricingFacts.priceQuote,
      availability: availabilityFacts.availability,
      catalogBrowse: catalogBrowseFacts?.catalogBrowse ?? null,
      media: mediaFacts.media,
    },

    resolutionStatus: {
      item: itemFacts.status,
      pricing: pricingFacts.pricing.status,
      availability:
        availabilityFacts.availability.status === "error"
          ? "error"
          : itemFacts.id
            ? "resolved"
            : "unknown",
      media: mediaFacts.media.status,
    },

    actions: actionFacts.actions,
    forbiddenClaims: actionFacts.forbiddenClaims,

    replyConstraints: {
      mustNotInventPrice: true,
      mustNotInventAvailability: true,
      mustNotClaimBlockedActions: true,
      groupItemlessFollowupAllowed,
    },

    sourceEvidence: {
      item: itemFacts.sourceEvidence,
      pricing: pricingFacts.sourceEvidence,
      priceQuote: pricingFacts.sourceEvidence.priceQuote,
      availability: availabilityFacts.sourceEvidence,
      media: mediaFacts.sourceEvidence,
      participant: participantFacts.sourceEvidence,
      turn: {
        sourceMessageId,
        sourceRowKey,
        guaranteeKey,
        sourceTurnKey,
      },
      sourceIdentity,
      actions: actionFacts.sourceEvidence,
      business: businessFacts.sourceEvidence,
    },
  };

  const memoryPendingAction =
    memorySnapshot.pendingAction ??
    readEmilyPendingFromMemory(memorySnapshot) ??
    null;

  resolved.decision = resolveBusinessDecision({
    normalizedMessage,
    understanding,
    signals,
    itemFacts,
    participantFacts,
    memoryPendingAction,
    canonicalDurationDays: rentalDurationDays,
    turnShape: turnContextInput?.turnShape ?? null,
    authoritativeSemanticIntent,
    authoritativeItemScope,
    validatedGroupCanonicalAuthority:
      turnContextInput?.validatedGroupCanonicalAuthority === true,
  });

  resolved.emilyPending = readEmilyPendingFromMemory(memorySnapshot);
  resolved.emilyPendingFollowUp = decideEmilyPendingFollowUp({
    memorySnapshot,
    participantKey:
      String(participantFacts?.participant?.key ?? "").trim() ||
      String(sourceIdentity?.participantKey ?? "").trim() ||
      null,
    understanding: {
      ...(understanding && typeof understanding === "object" ? understanding : {}),
      durationDays: rentalDurationDays ?? understanding?.durationDays ?? null,
      resolvedItemId: itemFacts.id,
      itemSource: understanding?.itemSource ?? null,
      signals,
    },
    signals,
    customerText: rawMessage,
    __decisionForTests: params.__emilyPendingFollowUpDecision ?? null,
  });

  const pendingHint = String(resolved.emilyPendingFollowUp?.workflowHint ?? "")
    .trim()
    .slice(0, 80);
  if (
    !authoritativeSemanticIntent &&
    pendingHint &&
    pendingHint !== "unknown_clarification" &&
    (resolved.decision.workflowType === "unknown_clarification" ||
      (resolved.decision.workflowType === "booking_request" &&
        pendingHint === "availability_inquiry"))
  ) {
    resolved.decision = Object.freeze({
      ...resolved.decision,
      workflowType: pendingHint,
      primaryIntent:
        pendingHint === "availability_inquiry"
          ? "availability_inquiry"
          : resolved.decision.primaryIntent,
      reason: `emily_pending_meaning_${String(resolved.emilyPendingFollowUp?.meaning ?? "hint")}`,
    });
  }

  if (params.log !== false) {
    logCanonicalFactsResolved(resolved);
  }

  return Object.freeze(resolved);
}
