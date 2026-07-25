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
import { decideAvailabilityAssistFollowUp } from "../availability/decideAvailabilityAssistFollowUp.js";
import { isConfidentInventoryUnavailable } from "./resolveItemBookingAwareAvailability.js";
import { findVerifiedAvailabilityAlternatives } from "../../services/availabilityRejectionAlternatives.js";
import { resolveBookingDateWindowFromDuration } from "./resolveBookingDateWindow.js";
import { resolveOpenAiChatCompletionsCreate } from "../../services/openaiChatCompletionsCreate.js";
import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";
import { decideEmilyPendingFollowUp } from "../availability/decideEmilyPendingFollowUp.js";
import { readEmilyPendingFromMemory } from "../availability/emilyPendingContext.js";
import { composeUnavailableCustomerReplyFromFacts } from "../workflows/AvailabilityInquiryWorkflow.js";

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
 * }} p
 */
function resolveBusinessDecision(p) {
  const signals = p.signals ?? {};
  const understanding = p.understanding ?? {};
  const resolvedItemId = hasValue(p.itemFacts?.id) ? String(p.itemFacts.id) : null;
  const durationDays =
    understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : null;
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

  let primaryIntent = "unknown";
  let workflowType = "unknown_clarification";
  let replyType = "clarification";
  let confidence = hasResolvedItem ? "medium" : "low";
  let reason = "no_matching_business_decision";
  let sideEffectsAllowed = [];

  if (signals.photoAsk && hasResolvedItem) {
    primaryIntent = "image_catalog_request";
    workflowType = "image_catalog_request";
    replyType = "image_catalog";
    confidence = "high";
    reason = "explicit_media_request_wins";
  } else if (signals.priceAsk && hasResolvedItem && durationDays != null) {
    primaryIntent = "pricing_with_duration";
    workflowType = "pricing_with_duration";
    replyType = "price_answer";
    confidence = "high";
    reason =
      weakContextSignals.length > 0
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
  } else if (strongBookingCommand && hasResolvedItem) {
    primaryIntent = "booking_request";
    workflowType = "booking_request";
    replyType = "booking_ack";
    confidence = "high";
    reason = "strong_booking_command";
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
  const signals = extractTurnSignals({
    message: rawMessage,
    hasDuration: understanding?.durationDays != null,
    itemMentioned,
  });

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

  const durationDaysForFacts =
    understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : turnContextInput?.duration != null && Number.isFinite(Number(turnContextInput.duration))
        ? Math.max(1, Math.floor(Number(turnContextInput.duration)))
        : null;

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

  const durationDaysResolved =
    durationDaysForFacts ??
    (lastAvailabilityAssist?.durationDays != null
      ? Math.max(1, Math.floor(Number(lastAvailabilityAssist.durationDays)))
      : null);

  const availabilityFacts = await resolveAvailabilityFacts({
    businessId,
    catalogRow: itemFacts.catalogRow,
    itemId: itemFacts.id,
    itemName: itemFacts.name,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    durationDays: durationDaysResolved,
    getBookingsForItemFn: params.getBookingsForItemFn,
  });

  /** @type {Array<{ itemId: string, itemLabel: string }>} */
  let verifiedAlternatives = [];
  const availabilityForAlts = availabilityFacts.availability;
  const assistWindow =
    lastAvailabilityAssist != null
      ? resolveBookingDateWindowFromDuration(lastAvailabilityAssist.durationDays)
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
          durationDaysResolved ??
            lastAvailabilityAssist?.durationDays ??
            understanding?.durationDays ??
            1
        ) || 1
      )
    );
    try {
      unavailableCustomerReply = await composeUnavailableCustomerReplyFromFacts({
        conversationalLabel,
        durationDays: durationForReply,
        alternatives: verifiedAlternatives,
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
      });
    } catch {
      unavailableCustomerReply = null;
    }
  }

  let availabilityAssistFollowUp = null;
  if (lastAvailabilityAssist) {
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
        requestedDurationDays: durationDaysResolved,
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
      intent: understanding?.intentsRanked?.[0] ?? null,
      turnShape: turnContextInput?.turnShape ?? null,
      requestedField:
        understanding?.askedField ?? turnContextInput?.requestedField ?? null,
      durationDays: durationDaysResolved ?? understanding?.durationDays ?? turnContextInput?.duration ?? null,
      confidence: understanding?.itemConfidence ?? null,
      sourceMessageId,
      sourceRowKey,
      guaranteeKey,
      sourceTurnKey,
    },

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
    availabilityAssistFollowUp,
    unavailableCustomerReply,

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
      durationDays: durationDaysResolved ?? understanding?.durationDays ?? null,
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
