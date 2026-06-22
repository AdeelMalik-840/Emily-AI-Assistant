import {
  extractContactPhoneFromText,
  looksSyntheticPhoneSource,
  normalizePhoneDigits,
} from "../utils/extractContactPhoneFromText.js";
import {
  classifyConversationIntentWithLLM,
  extractBookingSlotsWithLLM,
  extractGenericSlotsWithLLM,
  generateReply,
} from "./openai.js";
import { buildContextData } from "./contextHelpers.js";
import {
  getBusinessKnowledge,
  maybePersistKnowledgeFromMessage,
  getBusinessProfile,
  businessProfileForContext,
  profileContributesToKnowledge,
  mergeKnowledgeWithRawProfile,
  jsonReplacerForFirestore,
} from "./businessProfile.js";
import {
  extractEntity,
  extractDuration,
  getEntityConfidenceThreshold,
} from "./entityExtraction.js";
import {
  getNormalizedDaysFromDurationPreference,
  parseUserDuration,
} from "../duration/parseDuration.js";
import { detectBookingEvent } from "./eventDetection.js";
import {
  findItemByName,
  findItemById,
  getItemsForBusiness,
  getBestTokenMatch,
  getBestTokenMatchWithScore,
  getBookingsForItem,
  computeAvailabilityFromBookings,
  computeUserFacingAvailability,
  createBooking,
  getAlternativeAvailableItems,
  pickAlternativeAvailableItemsFromCatalogRows,
  summarizeBrowseAvailabilityFromCatalogRows,
  normalizeCatalogItem,
} from "./inventoryService.js";
import {
  appendConversationTurn,
  chatSessionKey,
  getLastEntityName,
  getRecentAssistantReplies,
  getRecentChatHistoryForPrompt,
  setLastEntityName,
} from "./memory.js";
import {
  applyEmilyTurn,
  collectCatalogItemImageUrls,
  detectShowImagesRequest,
  formatMatchedCatalogForPrompt,
  getEmilySessionState,
  intentForContextLayer,
  matchCatalogAgainstMessage,
} from "./conversationIntelligence.js";
import {
  resolveEmilyContextLabel,
  resolvePricingFallbackReply,
} from "../config/aiRuntime.js";
import { extractRecentAssistantTextsFromPromptBlock } from "./conversationStore.js";
import { normalizeEmilyResponse } from "./normalizeEmilyResponse.js";
import {
  assistantReplySimilarity,
  dedupeAgainstPriorAssistantReplies,
  polishWhatsAppBusinessTone,
} from "./whatsappReplyTone.js";
import {
  isEntityEstablishedInRecentThread,
  labelFromMatchedItem,
} from "./entityReferenceHint.js";
import {
  normalizeText,
  isGreeting,
  tryPreAiReply,
} from "./preAiRouting.js";
import { resolveGroupParticipantContextKey } from "./groupParticipantContext.js";
import { isEnglishOnlyGreetingMessage } from "./greetingLanguage.js";
import {
  SOURCE_LIMITED_CONTEXT,
  SOURCE_NO_PROFILE_FALLBACK,
  SOURCE_STRUCTURED_PROFILE,
} from "./messageFeedback.js";
import { planGroupHybridDelivery } from "./replyRouting.js";
import { randomUUID } from "node:crypto";
import { logBookingEvent } from "../utils/bookingLogger.js";
import db from "../config/firebase.js";
import {
  buildDeliveryDetailReply,
  buildBookingLogisticsCompletionPatch,
  buildBookingDetailsClarificationReply,
  findApprovedBookingForDm,
  findApprovedBookingForGroupDetails,
  getBookingLogisticsCompletionState,
  isBookingAttachAvailabilityQuery,
  detectBroadDeliveryAreaHint,
  isLogisticsComplete,
  isInformationalItemQuestion,
  isWeekdayOrDateOnlyMessage,
  parseDeliveryDetails,
  resolveLogisticsCompletionPolicy,
} from "./bookingDmFlow.js";
import {
  decideConversationRoute,
  applyIntentPriority,
  isConversationAiRoute,
  isInformationalRoute,
  isExplicitPricingOrDetailsQuestion,
  hasStrongBookingCommitPhrase,
} from "./conversationRouter.js";
import {
  isAnswerRequestedFieldPolicy,
  isPricingOrDetailsFieldQuestion,
  resolveTurnIntentShape,
} from "./intentShapeResolver.js";
import {
  normalizeFuzzyTurn,
  resolveFuzzyCatalogOutbound,
  inferCatalogQuestionIntent,
} from "./fuzzyTurnNormalizer.js";
import {
  applyToneGuard,
  composeInformationalAnswer,
  detectAskedField,
} from "./answerComposer.js";
import {
  buildAvailabilityContextSkeleton,
  catalogRowToTopAvailabilityItem,
  composeStructuredAvailabilityCustomerReply,
  enforceAvailabilityTruthOnReply,
} from "./availabilityContext.js";
import {
  guardAvailabilityAiReply,
  isAvailabilityAiEligible,
} from "./availabilityAi.js";
import { generateAvailabilityReplyFromFacts } from "./availabilityAiReply.js";
import {
  applyResponseStrategy,
  decideResponseStrategy,
} from "./responseStrategy.js";
import { sanitizeContextForResolvedItemChange } from "./bookingContextSanitizer.js";
import {
  findConservativeFuzzyCatalogMention,
  hasExplicitNewItemMention,
} from "./currentTurnAuthority.js";
import {
  resolveTurnContext,
  isItemlessPriceDurationFollowup as isItemlessPriceDurationFollowupShape,
  ITEMLESS_PRICE_CLARIFICATION_REPLY,
} from "./turnContextAuthority.js";
import {
  buildSameSessionBookingContinuationReply,
  isAwaitingBookingContactCapture,
  isSameSessionBookingContinuation,
  maybeHandleGroupBookingSlotCapture,
  maybeHandlePendingEngagementCommitWithoutQualifier,
  reconcileItemContextWithExplicitMessage,
  resolveExplicitUnlistedMention,
} from "./bookingStabilityHelpers.js";
import { resolveParticipantIdentity } from "./participantIdentity.js";
import {
  shouldBlockBookingForAssistantOrigin,
  INBOUND_SOURCE_REAL_CUSTOMER,
} from "./inboundOriginGuard.js";

async function createBookingFromValidatedIntent({
  callerTag,
  isGroupInbound,
  itemId,
  itemName,
  durationDays,
  hasParticipantIdentity,
  ownerApprovalFirstRequest,
  traceId,
  userId,
  createBookingArgs,
  inboundSourceOrigin = INBOUND_SOURCE_REAL_CUSTOMER,
  inboundMessage = "",
  playwrightChatKey = null,
  groupName = null,
} = {}) {
  const flowId = String(traceId ?? "").trim() || null;
  const assistantBookingBlock = shouldBlockBookingForAssistantOrigin({
    message: inboundMessage,
    sourceOrigin: inboundSourceOrigin,
    chatKey: String(playwrightChatKey ?? groupName ?? "").trim(),
    itemId,
    durationDays,
  });
  if (assistantBookingBlock.blocked) {
    console.warn("[booking_create_gate_blocked]", {
      callerTag,
      reason: assistantBookingBlock.reason,
    });
    console.warn("[BOOKING_GATE]", {
      ...(flowId ? { flowId } : {}),
      action: "blocked",
      callerTag: String(callerTag ?? "").trim() || null,
      reason: assistantBookingBlock.reason,
    });
    return { ok: false, code: "GATE_ASSISTANT_ORIGIN_BLOCKED" };
  }
  console.log("[booking_create_gate_entered]", {
    callerTag: String(callerTag ?? "").trim() || null,
    isGroupInbound: Boolean(isGroupInbound),
    itemId: String(itemId ?? "").trim() || null,
    durationDays: Number.isFinite(Number(durationDays)) ? Number(durationDays) : null,
    hasParticipantIdentity: Boolean(hasParticipantIdentity),
    ownerApprovalFirstRequest: Boolean(ownerApprovalFirstRequest),
  });
  console.log("[BOOKING_GATE]", {
    ...(flowId ? { flowId } : {}),
    action: "entered",
    callerTag: String(callerTag ?? "").trim() || null,
    isGroupInbound: Boolean(isGroupInbound),
    itemId: String(itemId ?? "").trim() || null,
    durationDays: Number.isFinite(Number(durationDays)) ? Number(durationDays) : null,
  });

  if (!userId || !String(itemId ?? "").trim()) {
    console.warn("[booking_create_gate_blocked]", { callerTag, reason: "MISSING_ITEM_OR_USER" });
    console.warn("[BOOKING_GATE]", {
      ...(flowId ? { flowId } : {}),
      action: "blocked",
      callerTag: String(callerTag ?? "").trim() || null,
      reason: "MISSING_ITEM_OR_USER",
    });
    return { ok: false, code: "GATE_MISSING_ITEM_OR_USER" };
  }
  if (!Number.isFinite(Number(durationDays)) || Number(durationDays) <= 0) {
    console.warn("[booking_create_gate_blocked]", { callerTag, reason: "MISSING_DURATION" });
    console.warn("[BOOKING_GATE]", {
      ...(flowId ? { flowId } : {}),
      action: "blocked",
      callerTag: String(callerTag ?? "").trim() || null,
      reason: "MISSING_DURATION",
    });
    return { ok: false, code: "GATE_MISSING_DURATION" };
  }
  if (isGroupInbound && ownerApprovalFirstRequest && !hasParticipantIdentity) {
    console.warn("[booking_create_gate_blocked]", {
      callerTag,
      reason: "MISSING_PARTICIPANT_IDENTITY_FOR_REPLY_PRIVATE",
    });
    console.warn("[BOOKING_GATE]", {
      ...(flowId ? { flowId } : {}),
      action: "blocked",
      callerTag: String(callerTag ?? "").trim() || null,
      reason: "MISSING_PARTICIPANT_IDENTITY_FOR_REPLY_PRIVATE",
    });
    return { ok: false, code: "GATE_MISSING_PARTICIPANT_IDENTITY" };
  }

  console.log("[booking_create_gate_allowed]", {
    callerTag: String(callerTag ?? "").trim() || null,
    itemId: String(itemId ?? "").trim() || null,
    itemName: String(itemName ?? "").trim() || null,
    durationDays: Math.max(1, Math.floor(Number(durationDays))),
  });
  console.log("[BOOKING_GATE]", {
    ...(flowId ? { flowId } : {}),
    action: "allowed",
    callerTag: String(callerTag ?? "").trim() || null,
    itemId: String(itemId ?? "").trim() || null,
    durationDays: Math.max(1, Math.floor(Number(durationDays))),
  });

  return createBooking(traceId, userId, createBookingArgs);
}

/**
 * Extract a best-effort location/address slot from a mixed delivery-method message.
 * Rule-based only (no LLM). Keeps readable casing by operating on the original text,
 * while using lowercase for detection.
 *
 * Examples:
 * - "Faisal town m delivery ho jye ge?" -> "Faisal town"
 * - "delivery DHA phase 2 kar dein" -> "DHA phase 2"
 *
 * Returns null when the message doesn't contain a usable location or is only an ack + delivery word.
 * @param {string} text
 * @returns {string | null}
 */
export function extractLocationSlotFromDeliveryText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Avoid false "locations" that are just delivery intent / acknowledgements.
  const onlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)\b/i.test(lower);
  const onlyDeliveryWord =
    /^(?:han|haan|jee|ji|yes|ok|okay|theek|done|sure)?\s*(?:delivery|deliver)\s*$/i.test(
      lower
    );
  if (onlyDeliveryWord || (onlyAck && /\bdelivery\b/i.test(raw) && raw.split(/\s+/).length <= 2)) {
    return null;
  }

  /**
   * @param {string} candidate
   */
  function cleanCandidate(candidate) {
    let out = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (!out) return "";

    // Strip obvious leading/trailing punctuation.
    out = out.replace(/^[\s,.:;!?'"()\-]+/, "").replace(/[\s,.:;!?'"()\-]+$/, "");

    // Remove delivery / pickup and question/filler fragments (case-insensitive).
    const cleanupPatterns = [
      /\b(delivery|deliver|deliver(?:y)?|bhej(?:na|do)?|send|drop)\b/gi,
      /\b(pick\s*up|pickup|self|khud)\b/gi,
      /\b(address|location)\b/gi,
      /\b(kya|kab|kahan|kidhar|how|where|when|possible)\b/gi,
      /\b(ho\s*jaye(?:\s*gi|\s*ga)?|ho\s*jye(?:\s*gi|\s*ga)?|ho\s*jaye\s*ga|ho\s*jaye\s*gi)\b/gi,
      /\b(hai|hain|ho|hoga|hogi|kr\s*dein|kar\s*dein|kar\s*den|kr\s*do|kar\s*do|pls|plz|please)\b/gi,
      /\b(krni|karni|krna|karna|krwani|karwani)\b/gi,
      /\b(mein|mei|me|main|m|tak)\b/gi,
    ];
    for (const re of cleanupPatterns) {
      out = out.replace(re, " ");
    }
    out = out.replace(/\s+/g, " ").trim();

    // After cleanup, reject low-signal leftovers.
    const outLower = out.toLowerCase();
    if (!outLower) return "";
    if (/^(delivery|deliver|pickup|pick\s*up)$/i.test(outLower)) return "";
    if (/^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(outLower)) return "";
    return out;
  }

  // Pattern 1: "<location> mein/me/m delivery ..."
  {
    const m = /^(.+?)\s+(?:m|me|mei|mein|main)\s+(?:delivery|deliver|bhej|send)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 2: "<location> tak delivery ..."
  {
    const m = /^(.+?)\s+tak\s+(?:delivery|deliver|bhej|send)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 3: "delivery <location> ..."
  {
    const m = /\b(?:delivery|deliver|bhej|send)\b\s+(.+?)(?:\?|$|\b(kar|kr|ho|hai|hain|possible|pls|plz|please)\b)/i.exec(
      raw
    );
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 4: "<location> address/location ..."
  {
    const m = /^(.+?)\s+\b(?:address|location)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 5: "address/location: <location>"
  {
    const m = /\b(?:address|location)\b\s*[:\-]?\s*(.+)$/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 6: "ghar/office/shop <area> ..."
  {
    const m = /\b(?:ghar|home|office|shop)\b\s+(.+)$/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Fallback: if it looks like a location-ish phrase embedded in delivery intent, extract the longest
  // non-question fragment around common area tokens.
  const hasAreaToken = /\b(sector|phase|block|street|road|near|opposite|town|city|area|dha|bahria)\b/i.test(
    raw
  );
  if (hasAreaToken) {
    const cleaned = cleanCandidate(raw);
    if (cleaned) return cleaned;
  }

  return null;
}

/**
 * Rule-based interpretation of delivery method + optional location slot.
 * @param {string} text
 */
export function interpretDeliveryMethodMessage(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const isOnlyAck = isLikelyAffirmationToken(lower);
  const looksQuestion =
    raw.includes("?") || /\b(kya|kab|kahan|kidhar|how|where|when)\b/i.test(raw);

  const pickupSignals = [
    /\bpick\s*up\b/i,
    /\bpickup\b/i,
    /\bself\b/i,
    /\bkhud\b/i,
    /\bme\s+pick(?:up)?\b/i,
    /\bmain\s+pick(?:up)?\b/i,
    /\ble\s+lunga\b/i,
    /\ble\s+loon(?:ga|gi)?\b/i,
  ];
  const deliverySignals = [
    /\bdeliver\b/i,
    /\bdelivery\b/i,
    /\bbhej\b/i,
    /\bghar\b/i,
    /\baddress\b/i,
    /\blocation\b/i,
    /\bdeliver\s+kar\b/i,
  ];

  if (isPickupLocationQuestion(raw) || isDeliveryCoverageQuestion(raw)) {
    return { method: null, location: null, confidence: "low" };
  }

  const hasPickup = pickupSignals.some((re) => re.test(raw));
  if (hasPickup) {
    return { method: "pickup", location: null, confidence: "high" };
  }

  const hasDelivery = deliverySignals.some((re) => re.test(raw));
  const hasLocationShape =
    /\b(sector|phase|block|street|road|near|opposite|town|city|area|dha|bahria)\b/i.test(
      raw
    ) || raw.length >= 12;

  // Treat short, non-ack, non-question replies as likely location answers (e.g. "Faisal town").
  const shortLikelyLocation = wordCount >= 1 && wordCount <= 5 && !isOnlyAck && !looksQuestion;

  if (hasDelivery || hasLocationShape || shortLikelyLocation) {
    let location = null;
    // Prefer explicit slot extraction for mixed delivery messages.
    if (hasDelivery) {
      location = extractLocationSlotFromDeliveryText(raw);
    }
    // Location-only replies should still map to a location even without the delivery keyword.
    if (!location && shortLikelyLocation && !hasDelivery) {
      location = raw;
    }
    // If we have a location-shape message that also contains delivery keyword, try extracting too.
    if (!location && hasLocationShape) {
      location = extractLocationSlotFromDeliveryText(raw);
    }

    return {
      method: "delivery",
      location: location || null,
      confidence: hasDelivery ? "high" : shortLikelyLocation ? "medium" : "low",
    };
  }

  return { method: null, location: null, confidence: "low" };
}

function isPickupLocationQuestion(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const hasQuestionShape =
    raw.includes("?") || /\b(kya|kia|kahan|kidhar|where|address|location|point)\b/i.test(raw);
  if (!hasQuestionShape) return false;
  return (
    /\bpick\s*up\b.*\b(kahan|kidhar|where|address|location|point)\b/i.test(lower) ||
    /\bpickup\b.*\b(kahan|kidhar|where|address|location|point)\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\bpick\s*up\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\bpickup\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\b(lena|lain|lenay|lene|collect)\b/i.test(lower)
  );
}

function isDeliveryCoverageQuestion(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const hasDelivery = /\b(delivery|deliver)\b/i.test(lower);
  if (!hasDelivery) return false;
  const hasCoverageShape =
    raw.includes("?") ||
    /\b(kahan|kidhar|where|area|areas|coverage|cover|tak|hoti|hota)\b/i.test(
      raw
    );
  if (!hasCoverageShape) return false;
  return (
    /\b(delivery|deliver)\b.*\b(kahan|kidhar|where|area|areas|coverage|cover|tak|hoti|hota)\b/i.test(
      lower
    ) ||
    /\b(kahan|kidhar|where)\b.*\b(delivery|deliver)\b/i.test(lower)
  );
}

function cleanLogisticsText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeDeliveryCoverageAreas(value) {
  if (Array.isArray(value)) {
    return value.map((x) => cleanLogisticsText(x)).filter(Boolean);
  }
  const raw = cleanLogisticsText(value);
  if (!raw) return [];
  return raw
    .split(/[,|\n]+/)
    .map((x) => cleanLogisticsText(x))
    .filter(Boolean);
}

function normalizeBusinessLogistics(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    defaultPickupLocation: cleanLogisticsText(src.defaultPickupLocation),
    pickupInstructions: cleanLogisticsText(src.pickupInstructions),
    pickupAvailableHours: cleanLogisticsText(src.pickupAvailableHours),
    deliveryCoverageAreas: normalizeDeliveryCoverageAreas(src.deliveryCoverageAreas),
    deliveryChargesNote: cleanLogisticsText(src.deliveryChargesNote),
  };
}

function sentence(value) {
  const text = cleanLogisticsText(value);
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function buildDeliveryMethodChoicePrompt({ acknowledgement = false } = {}) {
  return acknowledgement
    ? "Theek hai, pickup rakh dun ya delivery chahiye?"
    : "Aap pickup karna chahenge ya delivery?";
}

function appendDeliveryMethodChoicePrompt(reply, { acknowledgement = false } = {}) {
  const base = cleanLogisticsText(reply);
  const prompt = buildDeliveryMethodChoicePrompt({ acknowledgement });
  if (!base) return prompt;
  if (/\b(pickup\s+(?:karna|rakh|rakhun)|delivery\s+chahiye|pickup.*delivery|delivery.*pickup)\b/i.test(base)) {
    return base;
  }
  return `${base} ${prompt}`;
}

export function buildLogisticsQuestionReplyFromProfile(message, logisticsInput = {}) {
  const logistics = normalizeBusinessLogistics(logisticsInput);
  if (isPickupLocationQuestion(message)) {
    const parts = [];
    if (logistics.defaultPickupLocation) {
      parts.push(`Pickup ${logistics.defaultPickupLocation} se ho ga.`);
      if (logistics.pickupAvailableHours) {
        parts.push(`Pickup timing ${logistics.pickupAvailableHours} hai.`);
      }
      if (logistics.pickupInstructions) {
        parts.push(sentence(logistics.pickupInstructions));
      }
      return {
        handled: true,
        kind: "pickup_location",
        reply: parts.join(" ").trim(),
      };
    }
    return {
      handled: true,
      kind: "pickup_location",
      reply:
        "Pickup point abhi saved nahi hai. Delivery chahiye ho to address share kar dein, warna pickup point confirm karna hoga.",
    };
  }

  if (isDeliveryCoverageQuestion(message)) {
    if (logistics.deliveryCoverageAreas.length > 0) {
      const parts = [
        `Delivery ${logistics.deliveryCoverageAreas.join(", ")} mein ho sakti hai.`,
      ];
      if (logistics.deliveryChargesNote) {
        parts.push(sentence(logistics.deliveryChargesNote));
      }
      return {
        handled: true,
        kind: "delivery_coverage",
        reply: parts.join(" ").trim(),
      };
    }
    return {
      handled: true,
      kind: "delivery_coverage",
      reply:
        "Delivery area abhi saved nahi hai. Aap address share kar dein, confirm kar ke bata denge.",
    };
  }

  return { handled: false, kind: null, reply: "" };
}

function buildBookingInformationalFallbackReply(message = "", booking = {}) {
  const raw = String(message ?? "");
  const itemLabel =
    buildDisplayLabel(booking) ||
    String(booking?.itemName ?? booking?.itemLabel ?? booking?.name ?? "Is item").trim() ||
    "Is item";
  const condition =
    String(
      booking?.condition ??
        booking?.itemCondition ??
        booking?.attributes?.condition ??
        booking?.state?.condition ??
        ""
    ).trim();
  const conditionNote =
    String(
      booking?.conditionNote ??
        booking?.itemConditionNote ??
        booking?.attributes?.conditionNote ??
        ""
    ).trim();
  if (/\b(condition|halat|haalat)\b/i.test(raw)) {
    if (condition) {
      return `${itemLabel} ${condition} mein hai.${conditionNote ? ` ${conditionNote}.` : ""}`;
    }
    return "Iski exact condition abhi clear nahi hai. Booking se pehle confirm kar lena best rahega.";
  }
  if (/\b(new|used)\b/i.test(raw)) {
    if (condition) return `${itemLabel} ${condition} mein hai.`;
    return "New/used detail abhi clear nahi hai. Booking se pehle confirm kar lena best rahega.";
  }
  if (/\b(mileage|milage|low mileage)\b/i.test(raw)) {
    const mileage = String(booking?.mileage ?? booking?.attributes?.mileage ?? "").trim();
    return mileage ? `${itemLabel} mileage ${mileage} hai.` : "Mileage detail abhi clear nahi hai.";
  }
  return "Is detail ko booking se pehle confirm kar lena best rahega.";
}

async function loadBusinessLogisticsForUser(userId) {
  const uid = String(userId ?? "").trim();
  if (!uid) return {};
  try {
    const snap = await db.collection("businesses").doc(uid).get();
    const data = snap?.exists ? snap.data() || {} : {};
    const profile =
      data?.businessProfile && typeof data.businessProfile === "object" && !Array.isArray(data.businessProfile)
        ? data.businessProfile
        : {};
    return normalizeBusinessLogistics(profile?.logistics);
  } catch (err) {
    console.warn("[business_logistics_load_failed]", {
      userId: uid || null,
      reason: String(err?.message ?? err ?? "unknown"),
    });
    return {};
  }
}

/**
 * Extract a delivery time phrase from natural language.
 * Rule-based only (no LLM). Stores the raw meaningful phrase for now.
 *
 * Examples:
 * - "kal 5 baje" -> { timeText: "kal 5 baje", confidence: "high" }
 * - "evening" -> { timeText: "evening", confidence: "medium" }
 * - "haan" -> { timeText: null, confidence: "low" }
 *
 * @param {string} text
 * @returns {{ timeText: string | null, confidence: "high" | "medium" | "low" }}
 */
export function extractDeliveryTime(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { timeText: null, confidence: "low" };
  const lower = raw.toLowerCase();

  // Reject pure acknowledgements.
  if (/^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower)) {
    return { timeText: null, confidence: "low" };
  }

  const hasQuestionWord =
    raw.includes("?") || /\b(kya|kab|when|time)\b/i.test(raw);

  const dayTokenMatch = /\b(aaj|kal|today|tomorrow)\b/i.exec(lower);
  const dayToken = dayTokenMatch ? dayTokenMatch[0] : "";

  // Numeric time patterns
  const time12h = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(raw);
  const timeBaje = /\b(\d{1,2})(?::(\d{2}))?\s*(baje|bajay)\b/i.exec(raw);
  const timeOclock = /\b(\d{1,2})(?::(\d{2}))?\s*(o'?clock)\b/i.exec(raw);

  const partOfDayMatch =
    /\b(morning|evening|afternoon|night|raat|shaam)\b/i.exec(lower);
  const partOfDay = partOfDayMatch ? partOfDayMatch[0] : "";

  const isOnlyDeliveryWord = /^(delivery|deliver)\s*$/i.test(lower);
  if (isOnlyDeliveryWord) return { timeText: null, confidence: "low" };

  const hasNumeric = Boolean(time12h || timeBaje || timeOclock);

  if (hasNumeric) {
    // Prefer keeping the full message if it's short enough and includes day/time.
    const short = raw.split(/\s+/).filter(Boolean).length <= 6;
    const timeText = short ? raw : [dayToken, time12h?.[0] || timeBaje?.[0] || timeOclock?.[0]]
      .filter(Boolean)
      .join(" ")
      .trim();
    return { timeText: timeText || raw, confidence: "high" };
  }

  if (partOfDay) {
    // If user says "kal evening", keep both.
    const composite = [dayToken, partOfDay].filter(Boolean).join(" ").trim();
    return { timeText: composite || partOfDay, confidence: dayToken ? "high" : "medium" };
  }

  if (dayToken && !hasQuestionWord) {
    // "kal" alone is a usable time anchor; treat as medium.
    return { timeText: dayTokenMatch?.[0] ? raw : dayToken, confidence: "medium" };
  }

  return { timeText: null, confidence: "low" };
}

function isMeaningfulDeliveryAddressToken(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return false;
  const compact = t.replace(/\s+/g, "");
  if (!/[a-z0-9\u0600-\u06FF]/i.test(compact)) return false;
  if (/[\u0600-\u06FF]/.test(compact)) return compact.length >= 2;
  if (/^[a-z]\d{1,2}$/i.test(compact)) return true;
  if (/^[a-z]-\d{1,2}$/i.test(compact)) return true;
  if (compact.length >= 2 && /^[a-z0-9.\-]+$/i.test(compact)) return true;
  return false;
}

/**
 * Tokens left after stripping common delivery-intent words (evaluation only; does not change stored address).
 * @param {string} cleaned
 * @returns {string[]}
 */
export function getMeaningfulDeliveryAddressTokensForEval(cleaned) {
  let seval = String(cleaned ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!seval) return [];
  seval = seval.replace(
    /\b(?:delivery|deliver|bhej|send|drop|pickup|pick\s*up|self|khud|krni|karni|krna|karna|krwani|karwani|kr|kar|db|do|de|den|hai|hain|ho|chahiye|chaiye|pls|plz|please|mein|mei|me|main|sy|se|par|pe|tak|wala|wali|walay|m)\b/gi,
    " "
  );
  seval = seval.replace(/\s+/g, " ").trim();
  if (!seval) return [];
  return seval
    .split(/\s+/)
    .map((w) => w.replace(/^[\s,.:;!?'"()\-]+|[\s,.:;!?'"()\-]+$/g, "").trim())
    .filter(Boolean)
    .filter(isMeaningfulDeliveryAddressToken);
}

function evaluateDeliveryAddressQualityAfterSanity(cleaned) {
  const s = String(cleaned ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, reason: "empty_after_clean", meaningfulTokens: [] };
  if (!/[a-z0-9\u0600-\u06FF]/i.test(s)) return { ok: false, reason: "punctuation_only", meaningfulTokens: [] };
  const meaningfulTokens = getMeaningfulDeliveryAddressTokensForEval(s);
  if (!meaningfulTokens.length) return { ok: false, reason: "no_meaningful_tokens", meaningfulTokens: [] };
  return { ok: true, reason: "ok", meaningfulTokens };
}

/**
 * Generic booking-FSM check: reject empty, phone-like, punctuation-only, and filler-only / one-letter junk.
 * @param {string} cleaned Already normalized (e.g. after {@link validateBookingSlotForState} cleanAddress).
 */
export function isValidDeliveryAddressCandidate(cleaned) {
  const s = String(cleaned ?? "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return false;
  return evaluateDeliveryAddressQualityAfterSanity(s).ok;
}

/**
 * Centralized booking slot validation for the booking state machine.
 * No new architecture: just one acceptance/ambiguity layer.
 *
 * @param {{ state: string, messageText: string, llmSlots?: any, booking?: any }} p
 * @returns {{
 *  accepted: { deliveryMethod?: ("delivery"|"pickup"), deliveryAddress?: string, deliveryTime?: string, contactPhone?: string },
 *  ambiguous: string[],
 *  rejected: string[],
 *  nextReplyOverride: string | null
 * }}
 */
export function validateBookingSlotForState({
  state,
  messageText,
  llmSlots,
  booking,
} = {}) {
  const s = String(state ?? "").trim();
  const raw = String(messageText ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  const b = booking && typeof booking === "object" ? booking : {};
  const slots = llmSlots && typeof llmSlots === "object" ? llmSlots : {};

  console.log("[booking_slot_validation_started]", {
    bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
    state: s || null,
    rawTextPreview: raw.slice(0, 120) || null,
  });

  /** @type {any} */
  const accepted = {};
  const ambiguous = [];
  const rejected = [];
  let nextReplyOverride = null;

  const looksLikePhone = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  };

  const cleanAddress = (value) => {
    let out = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!out) return "";
    out = out
      .replace(/\b(delivery|deliver|deliver(?:y)?|bhej(?:na|do)?|send|drop)\b/gi, " ")
      .replace(/\b(pick\s*up|pickup|self|khud)\b/gi, " ")
      .replace(/\b(kar\s*dein|kr\s*dein|kar\s*den|kr\s*den|kar\s*do|kr\s*do)\b/gi, " ")
      .replace(/\b(sy|se)\s+pick\s*(?:up)?\s*(?:krni|karni)\b/gi, " ")
      .replace(/\bpick\s*(?:up)?\s*(?:krni|karni)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    out = out.replace(/^[,.:;!?'"()\-]+|[,.:;!?'"()\-]+$/g, "").trim();
    return out;
  };

  function isLowSignalSlotValue(slotName, value) {
    if (!value) return true;
    const v = String(value).toLowerCase().replace(/\s+/g, " ").trim();
    if (!v) return true;
    if (slotName === "deliveryAddress") {
      const denylist = [
        "krni",
        "karni",
        "krna",
        "karna",
        "krwani",
        "karwani",
        "hai",
        "ho",
        "haan",
        "jee",
        "pls",
        "plz",
        "please",
      ];
      if (denylist.includes(v)) return true;
    }
    return false;
  }

  const tryAcceptBookingDeliveryAddressSlot = (addrRaw) => {
    const addrStr = String(addrRaw ?? "").trim();
    const bookingId = String(b?.id ?? b?.bookingId ?? "").trim() || null;
    if (!addrStr) return;

    const cleaned = cleanAddress(addrStr);
    console.log("[address_validation_started]", {
      bookingId,
      state: s,
      rawTextPreview: raw.slice(0, 160) || null,
      rawAddress: addrStr,
      cleanedAddress: cleaned || null,
    });

    let meaningfulTokens = [];
    let acceptedAddr = false;
    /** @type {string | null} */
    let rejectReason = null;

    if (!cleaned) {
      rejectReason = "empty_after_clean";
    } else if (looksLikePhone(cleaned)) {
      rejectReason = "phone_like";
    } else if (isLowSignalSlotValue("deliveryAddress", cleaned)) {
      rejectReason = "low_signal_word";
      console.log("[delivery_address_rejected_low_signal]", {
        original: addrStr.slice(0, 120) || null,
        cleaned: cleaned.slice(0, 120) || null,
      });
    } else {
      const q = evaluateDeliveryAddressQualityAfterSanity(cleaned);
      meaningfulTokens = q.meaningfulTokens;
      if (q.ok) acceptedAddr = true;
      else rejectReason = q.reason;
    }

    const nextStateGuess =
      s === "awaiting_delivery_location"
        ? "awaiting_delivery_location"
        : accepted.deliveryMethod === "delivery" ||
            String(slots.deliveryMethod ?? "").trim().toLowerCase() === "delivery"
          ? "awaiting_delivery_location"
          : "awaiting_delivery_method";

    console.log("[address_validation_result]", {
      bookingId,
      accepted: acceptedAddr,
      reason: acceptedAddr ? "accepted" : rejectReason,
      cleanedAddress: cleaned || null,
      meaningfulTokens,
      nextState: nextStateGuess,
    });

    if (acceptedAddr) {
      accepted.deliveryAddress = cleaned;
      return;
    }

    rejected.push("deliveryAddress");
    console.log("[booking_address_rejected]", {
      bookingId,
      rawTextPreview: raw.slice(0, 160) || null,
      rawAddress: addrStr,
      cleanedAddress: cleaned || null,
      reason: rejectReason,
    });

    if (
      rejectReason === "no_meaningful_tokens" ||
      rejectReason === "punctuation_only" ||
      rejectReason === "low_signal_word" ||
      rejectReason === "empty_after_clean"
    ) {
      ambiguous.push("invalid_delivery_address");
    }
  };

  const isDigitsOnly = /^\d{1,3}$/.test(lower);
  const isOnlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower);
  const hasDurationWord = /\b(din|days?)\b/i.test(raw);
  const hasTimeMarker =
    /\b(baje|bjay|am|pm|raat|shaam|evening|morning|afternoon|night|aaj|kal|today|tomorrow)\b/i.test(
      raw
    ) || /:\d{2}\b/.test(raw);
  const broadAreaHint = detectBroadDeliveryAreaHint(raw);

  if (s === "awaiting_delivery_method") {
    if (broadAreaHint?.areaOnly && broadAreaHint?.isCoverageQuestion) {
      ambiguous.push("delivery_coverage_question");
      rejected.push("deliveryMethod", "deliveryAddress");
      nextReplyOverride = null;
      return { accepted, rejected, ambiguous, nextReplyOverride };
    }
    const method = String(slots.deliveryMethod ?? "").trim().toLowerCase();
    if (!isOnlyAck && !String(b?.deliveryMethod ?? "").trim()) {
      if (broadAreaHint?.areaOnly && !broadAreaHint?.hasDeliveryIntent) {
        rejected.push("deliveryMethod");
        accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
        nextReplyOverride = `${broadAreaHint.normalizedArea} mein delivery chahiye ya pickup?`;
      } else if (method === "delivery" || method === "pickup") accepted.deliveryMethod = method;
      else if (method) rejected.push("deliveryMethod");
    }
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (
      broadAreaHint?.areaOnly &&
      broadAreaHint?.hasDeliveryIntent &&
      !broadAreaHint?.isCoverageQuestion
    ) {
      accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
      accepted.deliveryArea = broadAreaHint.normalizedArea;
      if (!accepted.deliveryMethod) accepted.deliveryMethod = "delivery";
      nextReplyOverride = `${broadAreaHint.normalizedArea} noted 👍 Exact kis area mein delivery chahiye?`;
    } else if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      tryAcceptBookingDeliveryAddressSlot(addrRaw);
    }
  } else if (s === "awaiting_delivery_location") {
    if (broadAreaHint?.areaOnly) {
      accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
      accepted.deliveryArea = broadAreaHint.normalizedArea;
      rejected.push("deliveryAddress");
      nextReplyOverride = `${broadAreaHint.normalizedArea} noted 👍 Exact kis area mein delivery chahiye?`;
      return { accepted, rejected, ambiguous, nextReplyOverride };
    }
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      tryAcceptBookingDeliveryAddressSlot(addrRaw);
    }
    if (!accepted.deliveryAddress && looksLikePhone(raw)) {
      ambiguous.push("phone_in_address_state");
      nextReplyOverride = "Location/address thoda clear bata dein.";
    }
  } else if (s === "awaiting_delivery_time") {
    const t = String(slots.deliveryTime ?? "").replace(/\s+/g, " ").trim();
    if (!String(b?.deliveryTime ?? "").trim() && t) {
      if (hasDurationWord && !hasTimeMarker) {
        // "12 din" is not a time. We don't store duration in this state machine.
        ambiguous.push("duration_in_time_state");
        rejected.push("deliveryTime");
        nextReplyOverride = "Time kya rakhna hai? Jaise 12 bjy rat.";
      } else if (isDigitsOnly && !hasTimeMarker) {
        ambiguous.push("number_only");
        rejected.push("deliveryTime");
        nextReplyOverride = "12 bjy ka time rakhna hai?";
      } else {
        accepted.deliveryTime = t;
      }
    }
  } else if (s === "awaiting_contact") {
    const p = String(slots.contactPhone ?? "").trim();
    if (
      !String(b?.customerPhone ?? "").trim() &&
      !String(b?.contactPhone ?? "").trim() &&
      p
    ) {
      const digits = String(p).replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 15) accepted.contactPhone = digits;
      else rejected.push("contactPhone");
    }
  }

  if (ambiguous.length > 0) {
    console.log("[booking_slot_validation_ambiguous]", {
      bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
      state: s || null,
      ambiguous,
    });
  }
  console.log("[booking_slot_validation_result]", {
    bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
    state: s || null,
    acceptedKeys: Object.keys(accepted),
    rejected,
    ambiguous,
    nextReplyOverride: nextReplyOverride || null,
  });

  return { accepted, ambiguous, rejected, nextReplyOverride };
}

function normalizeSlotTextForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawTextCorrespondsToMessage(rawText, messageText, proposedValue = null) {
  const raw = normalizeSlotTextForMatch(rawText);
  const msg = normalizeSlotTextForMatch(messageText);
  if (!raw || !msg) return false;
  if (msg.includes(raw)) return true;
  const valueText = proposedValue != null ? String(proposedValue).trim() : "";
  if (valueText && !msg.split(" ").includes(valueText)) return false;
  const rawTokens = raw.split(" ").filter((t) => t.length >= 2 && t !== valueText);
  if (rawTokens.length === 0) return Boolean(valueText);
  const msgTokens = new Set(msg.split(" "));
  return rawTokens.some((token) => msgTokens.has(token));
}

function normalizedDurationFromSlot(value, unitGuess) {
  const v = Math.floor(Number(value));
  const unit = String(unitGuess ?? "").trim().toLowerCase();
  if (!Number.isFinite(v) || v <= 0) return null;
  if (!["hours", "days", "weeks", "months"].includes(unit)) return null;
  if (unit === "hours") {
    if (v > 24 * 365) return null;
    return { value: v, unit: "hours", normalizedDays: Math.max(1, Math.ceil(v / 24)), normalizedHours: v };
  }
  if (unit === "days") {
    if (v > 365) return null;
    return { value: v, unit: "days", normalizedDays: v };
  }
  if (unit === "weeks") {
    if (v > 52) return null;
    return { value: v, unit: "weeks", normalizedDays: v * 7 };
  }
  if (v > 24) return null;
  return { value: v, unit: "months", normalizedDays: v * 30 };
}

function logGenericSlotDecision(tag, payload) {
  console.log(tag, {
    slotType: payload.slotType,
    rawText: payload.rawText || null,
    proposedValue: payload.proposedValue ?? null,
    proposedUnit: payload.proposedUnit ?? null,
    confidence: payload.confidence || null,
    validatorResult: payload.validatorResult,
    rejectionReason: payload.rejectionReason || null,
    isGroupInbound: Boolean(payload.isGroupInbound),
    deterministicParserAlreadySucceeded: Boolean(payload.deterministicParserAlreadySucceeded),
  });
}

/**
 * Validate generic LLM slot proposals. This function is proposal-only: it never
 * mutates booking state, memory, price, contact, address, or approval fields.
 * @param {{
 *   proposal?: any,
 *   messageText?: string,
 *   deterministicSlots?: { duration?: any },
 *   currentItem?: any,
 *   hasExplicitEntity?: boolean,
 *   isGroupInbound?: boolean,
 *   resolveCatalogItem?: (raw: string) => Promise<any>
 * }} p
 */
export async function validateGenericSlotProposalForTurn({
  proposal,
  messageText = "",
  deterministicSlots = {},
  currentItem = null,
  hasExplicitEntity = false,
  isGroupInbound = false,
  resolveCatalogItem = null,
} = {}) {
  const slots = proposal?.slots && typeof proposal.slots === "object" ? proposal.slots : {};
  /** @type {Record<string, any>} */
  const accepted = {};
  /** @type {Record<string, string>} */
  const rejected = {};
  const forbiddenFields = Array.isArray(proposal?.rejectedForbiddenFields)
    ? proposal.rejectedForbiddenFields
    : [];
  const unknownSlotKeys = Array.isArray(proposal?.rejectedUnknownSlotKeys)
    ? proposal.rejectedUnknownSlotKeys
    : [];

  for (const field of forbiddenFields) {
    rejected[field] = "forbidden_field";
    logGenericSlotDecision("[slot_proposal_rejected]", {
      slotType: field,
      validatorResult: "rejected",
      rejectionReason: "forbidden_field",
      isGroupInbound,
    });
  }
  for (const key of unknownSlotKeys) {
    if (rejected[key] === "forbidden_field") continue;
    rejected[key] = "unknown_slot_key";
    logGenericSlotDecision("[slot_proposal_rejected]", {
      slotType: key,
      validatorResult: "rejected",
      rejectionReason: "unknown_slot_key",
      isGroupInbound,
    });
  }

  const duration = slots.duration;
  if (duration) {
    const deterministicParserAlreadySucceeded = Boolean(deterministicSlots?.duration);
    const baseLog = {
      slotType: "duration",
      rawText: duration.rawText,
      proposedValue: duration.value,
      proposedUnit: duration.unitGuess,
      confidence: duration.confidence,
      isGroupInbound,
      deterministicParserAlreadySucceeded,
    };
    if (deterministicParserAlreadySucceeded) {
      rejected.duration = "deterministic_parser_already_succeeded";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else if (duration.confidence !== "high") {
      rejected.duration = "confidence_not_high";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else if (!rawTextCorrespondsToMessage(duration.rawText, messageText, duration.value)) {
      rejected.duration = "raw_text_not_in_message";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else {
      const parsed = normalizedDurationFromSlot(duration.value, duration.unitGuess);
      if (!parsed) {
        rejected.duration = "invalid_or_unreasonable_duration";
        logGenericSlotDecision("[slot_proposal_rejected]", {
          ...baseLog,
          validatorResult: "rejected",
          rejectionReason: rejected.duration,
        });
      } else {
        accepted.duration = parsed;
        logGenericSlotDecision("[slot_proposal_accepted]", {
          ...baseLog,
          validatorResult: "accepted",
        });
      }
    }
  }

  const itemReference = slots.itemReference;
  if (itemReference) {
    const baseLog = {
      slotType: "itemReference",
      rawText: itemReference.rawText,
      proposedValue: itemReference.value,
      confidence: itemReference.confidence,
      isGroupInbound,
    };
    if (itemReference.confidence !== "high") {
      rejected.itemReference = "confidence_not_high";
    } else if (!rawTextCorrespondsToMessage(itemReference.rawText, messageText, itemReference.value)) {
      rejected.itemReference = "raw_text_not_in_message";
    } else if (itemReference.referenceType === "explicit_item") {
      if (typeof resolveCatalogItem !== "function" || !itemReference.value) {
        rejected.itemReference = "explicit_item_not_resolved";
      } else {
        const resolved = await resolveCatalogItem(itemReference.value);
        if (resolved) accepted.itemReference = { type: "explicit_item", item: resolved };
        else rejected.itemReference = "explicit_item_not_resolved";
      }
    } else if (itemReference.referenceType === "current_item") {
      const currentId = normalizeId(currentItem?.id ?? currentItem?.itemId);
      if (currentId && !hasExplicitEntity) {
        accepted.itemReference = { type: "current_item", item: currentItem };
      } else {
        rejected.itemReference = hasExplicitEntity ? "explicit_entity_present" : "current_item_missing";
      }
    } else {
      rejected.itemReference = "unknown_item_reference";
    }
    logGenericSlotDecision(rejected.itemReference ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.itemReference ? "rejected" : "accepted",
      rejectionReason: rejected.itemReference || null,
    });
  }

  const requestedField = slots.requestedField;
  if (requestedField) {
    const fieldMap = {
      price: "price",
      condition: "condition",
      color: "attribute_color",
      model: "model",
      mileage: "mileage",
      photos: "media",
      availability: "availability",
    };
    const baseLog = {
      slotType: "requestedField",
      rawText: requestedField.rawText,
      proposedValue: requestedField.field,
      confidence: requestedField.confidence,
      isGroupInbound,
    };
    if (requestedField.confidence !== "high") {
      rejected.requestedField = "confidence_not_high";
    } else if (!fieldMap[requestedField.field]) {
      rejected.requestedField = "unknown_requested_field";
    } else if (!rawTextCorrespondsToMessage(requestedField.rawText, messageText, requestedField.field)) {
      rejected.requestedField = "raw_text_not_in_message";
    } else {
      accepted.requestedField = fieldMap[requestedField.field];
    }
    logGenericSlotDecision(rejected.requestedField ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.requestedField ? "rejected" : "accepted",
      rejectionReason: rejected.requestedField || null,
    });
  }

  const deliveryLocationHint = slots.deliveryLocationHint;
  if (deliveryLocationHint) {
    const confidenceOk =
      deliveryLocationHint.confidence === "high" ||
      (deliveryLocationHint.confidence === "medium" && deliveryLocationHint.isCompleteAddress !== true);
    const baseLog = {
      slotType: "deliveryLocationHint",
      rawText: deliveryLocationHint.rawText,
      proposedValue: deliveryLocationHint.value,
      confidence: deliveryLocationHint.confidence,
      isGroupInbound,
    };
    if (!confidenceOk) {
      rejected.deliveryLocationHint = "confidence_too_low";
    } else if (!deliveryLocationHint.value) {
      rejected.deliveryLocationHint = "missing_location_value";
    } else if (!rawTextCorrespondsToMessage(deliveryLocationHint.rawText, messageText, deliveryLocationHint.value)) {
      rejected.deliveryLocationHint = "raw_text_not_in_message";
    } else {
      accepted.deliveryLocationHint = {
        value: deliveryLocationHint.value,
        isCompleteAddress: deliveryLocationHint.isCompleteAddress === true,
      };
    }
    logGenericSlotDecision(
      rejected.deliveryLocationHint ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]",
      {
        ...baseLog,
        validatorResult: rejected.deliveryLocationHint ? "rejected" : "accepted",
        rejectionReason: rejected.deliveryLocationHint || null,
      }
    );
  }

  const deliveryMethod = slots.deliveryMethod;
  if (deliveryMethod) {
    const lower = String(messageText ?? "").toLowerCase();
    const hasMethodSignal =
      deliveryMethod.value === "pickup"
        ? /\b(pick\s*up|pickup|self|khud)\b/i.test(lower)
        : /\b(deliver|delivery|bhej|drop)\b/i.test(lower);
    const baseLog = {
      slotType: "deliveryMethod",
      rawText: deliveryMethod.rawText,
      proposedValue: deliveryMethod.value,
      confidence: deliveryMethod.confidence,
      isGroupInbound,
    };
    if (deliveryMethod.confidence !== "high") {
      rejected.deliveryMethod = "confidence_not_high";
    } else if (deliveryMethod.value !== "pickup" && deliveryMethod.value !== "delivery") {
      rejected.deliveryMethod = "unknown_delivery_method";
    } else if (!hasMethodSignal) {
      rejected.deliveryMethod = "missing_method_signal";
    } else if (!rawTextCorrespondsToMessage(deliveryMethod.rawText, messageText, deliveryMethod.value)) {
      rejected.deliveryMethod = "raw_text_not_in_message";
    } else {
      accepted.deliveryMethod = deliveryMethod.value;
    }
    logGenericSlotDecision(rejected.deliveryMethod ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.deliveryMethod ? "rejected" : "accepted",
      rejectionReason: rejected.deliveryMethod || null,
    });
  }

  const dateOrTime = slots.dateOrTime;
  if (dateOrTime) {
    const baseLog = {
      slotType: "dateOrTime",
      rawText: dateOrTime.rawText,
      proposedValue: dateOrTime.value,
      confidence: dateOrTime.confidence,
      isGroupInbound,
    };
    const looksLikeDuration =
      /\b(hours?|hrs?|days?|din|weeks?|months?|mahina|mahinay)\b/i.test(String(dateOrTime.rawText ?? "")) ||
      /\b(hours?|hrs?|days?|din|weeks?|months?|mahina|mahinay)\b/i.test(String(dateOrTime.value ?? ""));
    if (dateOrTime.confidence !== "high") {
      rejected.dateOrTime = "confidence_not_high";
    } else if (!dateOrTime.value || dateOrTime.type === "unknown") {
      rejected.dateOrTime = "unknown_date_or_time";
    } else if (looksLikeDuration) {
      rejected.dateOrTime = "duration_not_delivery_time";
    } else if (!rawTextCorrespondsToMessage(dateOrTime.rawText, messageText, dateOrTime.value)) {
      rejected.dateOrTime = "raw_text_not_in_message";
    } else {
      accepted.dateOrTime = { value: dateOrTime.value, type: dateOrTime.type };
    }
    logGenericSlotDecision(rejected.dateOrTime ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.dateOrTime ? "rejected" : "accepted",
      rejectionReason: rejected.dateOrTime || null,
    });
  }

  return { accepted, rejected, forbiddenFields, unknownSlotKeys };
}

/**
 * Resolve a booking/customer contact phone with a strict priority order.
 * Returns normalized digits only (10–15). Rejects synthetic/group identifiers.
 *
 * @param {{ booking: any, participantPhoneForDm?: string | null, sessionKey?: string | null }} p
 * @returns {{ phone: string | null, source: string }}
 */
export function resolveBookingContactPhone({
  booking,
  participantPhoneForDm,
  sessionKey,
} = {}) {
  const b = booking && typeof booking === "object" ? booking : {};

  const candidates = [
    { source: "booking.customerPhone", value: b?.customerPhone },
    { source: "booking.contactPhone", value: b?.contactPhone },
    { source: "participantPhoneForDm", value: participantPhoneForDm },
    { source: "booking.sourceIdentity.participantPhone", value: b?.sourceIdentity?.participantPhone },
    { source: "booking.sourceParticipantPhone", value: b?.sourceParticipantPhone },
    { source: "booking.originalCustomerPhone", value: b?.originalCustomerPhone },
    { source: "booking.dmTargetPhone", value: b?.dmTargetPhone },
  ];

  for (const c of candidates) {
    const raw = String(c.value ?? "").trim();
    if (!raw) continue;
    if (looksSyntheticPhoneSource(raw)) continue;
    const phone = normalizePhoneDigits(raw);
    if (phone) return { phone, source: c.source };
  }

  // Conservative: extract a phone-looking token from sessionKey only if it clearly contains digits.
  const sk = String(sessionKey ?? "").trim();
  if (sk && !looksSyntheticPhoneSource(sk)) {
    const tokens = sk.split(/[^0-9+]+/).filter(Boolean);
    for (const t of tokens) {
      const phone = normalizePhoneDigits(t);
      if (phone) return { phone, source: "sessionKey" };
    }
  }

  return { phone: null, source: "none" };
}

export { extractContactPhoneFromText };

/**
 * Apply LLM slot extraction (optional) for booking states, while keeping state transitions deterministic.
 * This is used by the booking state machine to optionally accept LLM slots before rule-based fallback.
 *
 * @param {{
 *  state: string,
 *  messageText: string,
 *  booking: any,
 *  participantPhoneForDm?: string | null,
 *  sessionKey?: string | null,
 *  llm?: (args: { state: string, messageText: string, booking: any }) => Promise<any>
 * }} p
 * @returns {Promise<{ accepted: { deliveryMethod?: "delivery"|"pickup", deliveryAddress?: string, deliveryTime?: string, contactPhone?: string }, llm: any | null }>}
 */
export async function applyBookingSlotLlmExtraction({
  state,
  messageText,
  booking,
  participantPhoneForDm,
  sessionKey,
  llm,
} = {}) {
  const s = String(state ?? "").trim();
  const msg = String(messageText ?? "").trim();
  const b = booking && typeof booking === "object" ? booking : {};
  if (!s || !msg) return { accepted: {}, llm: null };

  const fn =
    typeof llm === "function"
      ? llm
      : (args) => extractBookingSlotsWithLLM(args);

  const result = await fn({ state: s, messageText: msg, booking: b });
  const conf = result?.confidence || {};
  const slots = result?.slots || {};
  const ok = (k) => conf?.[k] === "high" || conf?.[k] === "medium";

  /** @type {Record<string, any>} */
  const accepted = {};

  if (s === "awaiting_delivery_method") {
    if (!String(b?.deliveryMethod ?? "").trim() && ok("deliveryMethod")) {
      if (slots.deliveryMethod === "delivery" || slots.deliveryMethod === "pickup") {
        accepted.deliveryMethod = slots.deliveryMethod;
      }
    }
    if (!String(b?.deliveryAddress ?? "").trim() && ok("deliveryAddress")) {
      const addr = String(slots.deliveryAddress ?? "").trim();
      if (addr) accepted.deliveryAddress = addr;
    }
  } else if (s === "awaiting_delivery_location") {
    if (!String(b?.deliveryAddress ?? "").trim() && ok("deliveryAddress")) {
      const addr = String(slots.deliveryAddress ?? "").trim();
      if (addr) accepted.deliveryAddress = addr;
    }
  } else if (s === "awaiting_delivery_time") {
    if (!String(b?.deliveryTime ?? "").trim() && ok("deliveryTime")) {
      const t = String(slots.deliveryTime ?? "").trim();
      if (t) accepted.deliveryTime = t;
    }
  } else if (s === "awaiting_contact") {
    // Prefer metadata resolver elsewhere; only accept message-provided contactPhone here.
    const existing = resolveBookingContactPhone({
      booking: b,
      participantPhoneForDm,
      sessionKey,
    });
    if (!existing.phone && ok("contactPhone")) {
      const p = String(slots.contactPhone ?? "").trim();
      if (p) accepted.contactPhone = p;
    }
  }

  return { accepted, llm: result || null };
}

function bookingOwnerApprovalFirstEnabled() {
  return /^true$/i.test(String(process.env.BOOKING_OWNER_APPROVAL_FIRST ?? "").trim());
}

const ACTIVE_BOOKING_MEMORY_STATUSES = new Set([
  "pending_approval",
  "approved",
  "confirmed",
  "owner_approved_waiting_customer_details",
]);
const BOOKING_STATE_EXPIRY_MS = 60 * 60 * 1000;
const BOOKING_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

function pendingEngagementStateIsActive(memory) {
  return Boolean(
    memory?.bookingState &&
      String(memory.bookingState.approvalStage ?? "").trim() ===
        "pending_owner_approval" &&
      memory?.pendingEngagementState &&
      typeof memory.pendingEngagementState === "object" &&
      String(memory.pendingEngagementState.expectedReplyType ?? "").trim() ===
        "qualifier"
  );
}

function normalizeQualifierAnswer({ rawAnswer, qualifierKey, allowedValues }) {
  const answer = String(rawAnswer ?? "").trim();
  const normalized = answer.toLowerCase().replace(/\s+/g, " ");
  const allowed = new Set(Array.isArray(allowedValues) ? allowedValues : []);
  if (qualifierKey !== "usage_area") return null;
  const outside =
    /\b(outside|outstation|highway|intercity|inter-city|bahar|baahir|bahr)\b/i.test(
      normalized
    ) || /\bcity\s*(?:se\s*)?bahar\b/i.test(normalized);
  const inside =
    /\b(inside|within|local|local use|andar|shehar|shahar)\b/i.test(normalized) ||
    /\bcity\s*(?:ke|kay|k)?\s*andar\b/i.test(normalized);
  if (outside && allowed.has("outside_city")) return "outside_city";
  if (inside && allowed.has("inside_city")) return "inside_city";
  return null;
}

export function buildPendingQualifierState({
  bookingId,
  qualifierKey = "usage_area",
  allowedValues = ["inside_city", "outside_city"],
  rawAnswer = null,
} = {}) {
  return {
    bookingId: String(bookingId ?? "").trim() || null,
    expectedReplyType: "qualifier",
    qualifierKey,
    allowedValues,
    rawAnswer,
  };
}

export async function maybeHandlePendingEngagementQualifier({
  db: dbInstance = db,
  userId,
  message,
  memory,
  routingCtx,
  applyOutbound = applyHybridOutboundResult,
  knowledgeMeta = messageMetaForKnowledge(true),
} = {}) {
  if (!pendingEngagementStateIsActive(memory)) return null;
  const pending = memory.pendingEngagementState;
  const bookingId =
    String(pending.bookingId ?? "").trim() ||
    String(memory.bookingState?.bookingId ?? "").trim();
  const qualifierKey = String(pending.qualifierKey ?? "").trim();
  const allowedValues = Array.isArray(pending.allowedValues)
    ? pending.allowedValues.map((value) => String(value).trim()).filter(Boolean)
    : [];
  if (routingCtx?.isGroupInbound === true) {
    console.log("[group_logistics_mutation_blocked]", {
      bookingId,
      attemptedFields: [qualifierKey || "qualifier"],
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      groupName: routingCtx?.groupName ?? null,
      chatKey: routingCtx?.chatKey ?? null,
      reason: "GROUP_PENDING_QUALIFIER_BLOCKED",
    });
    delete memory.pendingEngagementState;
    return applyOutbound(
      {
        reply: groupSafeRequestReceivedReply({ itemAndDurationKnown: true }),
        text: groupSafeRequestReceivedReply({ itemAndDurationKnown: true }),
        type: "AI_MESSAGE",
        meta: {
          pendingEngagementHandled: false,
          bookingId,
          groupPrivateDetailBlocked: true,
        },
        messageMeta: knowledgeMeta,
      },
      routingCtx
    );
  }
  const matchedValue = normalizeQualifierAnswer({
    rawAnswer: message,
    qualifierKey,
    allowedValues,
  });
  if (!matchedValue || !bookingId) return null;

  const nextPendingState = buildPendingQualifierState({
    bookingId,
    qualifierKey,
    allowedValues,
    rawAnswer: String(message ?? "").trim(),
  });
  memory.pendingEngagementState = {
    ...nextPendingState,
    answeredAt: new Date().toISOString(),
  };
  memory.qualifiers = {
    ...(memory.qualifiers && typeof memory.qualifiers === "object"
      ? memory.qualifiers
      : {}),
    [qualifierKey]: matchedValue,
  };
  if (memory.bookingState && typeof memory.bookingState === "object") {
    memory.bookingState.qualifiers = {
      ...(memory.bookingState.qualifiers &&
      typeof memory.bookingState.qualifiers === "object"
        ? memory.bookingState.qualifiers
        : {}),
      [qualifierKey]: matchedValue,
    };
    memory.bookingState.updatedAt = new Date().toISOString();
  }

  await dbInstance
    .collection("businesses")
    .doc(String(userId))
    .collection("bookings")
    .doc(bookingId)
    .update({
      pendingEngagementState: {
        ...nextPendingState,
        matchedValue,
      },
      qualifiers: {
        [qualifierKey]: matchedValue,
      },
      [qualifierKey]: matchedValue,
      updatedAt: new Date(),
    });
  console.log("[pending_engagement_qualifier_stored]", {
    bookingId,
    qualifierKey,
    matchedValue,
  });

  return applyOutbound(
    {
      reply: "Noted 👍",
      text: "Noted 👍",
      type: "AI_MESSAGE",
      meta: {
        pendingEngagementHandled: true,
        bookingId,
        qualifierKey,
        qualifierValue: matchedValue,
      },
      messageMeta: knowledgeMeta,
    },
    routingCtx
  );
}

function normalizedBookingStateStatus(bookingState) {
  const status = String(bookingState?.status ?? "").trim().toLowerCase();
  const approvalStage = String(bookingState?.approvalStage ?? "").trim().toLowerCase();
  return approvalStage === "owner_approved_waiting_customer_details"
    ? approvalStage
    : status;
}

function bookingStateIsActive(bookingState) {
  return ACTIVE_BOOKING_MEMORY_STATUSES.has(normalizedBookingStateStatus(bookingState));
}

function bookingStateAgeMs(bookingState, now = Date.now()) {
  const ms = Date.parse(String(bookingState?.updatedAt ?? ""));
  return Number.isFinite(ms) ? now - ms : 0;
}

function bookingStateIsExpired(bookingState, now = Date.now()) {
  return bookingStateAgeMs(bookingState, now) > BOOKING_STATE_EXPIRY_MS;
}

function pruneExpiredBookingStates(memory, now = Date.now()) {
  if (!memory || typeof memory !== "object") return;
  if (memory.bookingState && bookingStateIsExpired(memory.bookingState, now)) {
    console.log("[booking_state_expired]", {
      bookingId: memory.bookingState.bookingId ?? null,
      itemId: memory.bookingState.itemId ?? null,
      status: memory.bookingState.status ?? null,
    });
    delete memory.bookingState;
    delete memory.bookingCreated;
  }
  const byItem =
    memory.bookingStatesByItemId &&
    typeof memory.bookingStatesByItemId === "object" &&
    !Array.isArray(memory.bookingStatesByItemId)
      ? memory.bookingStatesByItemId
      : null;
  if (!byItem) return;
  for (const [itemId, state] of Object.entries(byItem)) {
    if (bookingStateIsExpired(state, now)) {
      console.log("[booking_state_expired]", {
        bookingId: state?.bookingId ?? null,
        itemId,
        status: state?.status ?? null,
      });
      delete byItem[itemId];
    }
  }
}

export function setStructuredBookingState(memory, booking) {
  if (!memory || typeof memory !== "object") return null;
  const bookingId = String(booking?.bookingId ?? booking?.id ?? "").trim();
  const itemId = normalizeId(booking?.itemId);
  pruneExpiredBookingStates(memory);
  const status = String(booking?.status ?? "pending_approval").trim() || "pending_approval";
  const approvalStage = String(booking?.approvalStage ?? "").trim();
  const durationNumber = Number(booking?.durationDays);
  const durationHoursNumber = Number(booking?.durationHours);
  const scopedSessionKey = String(booking?.sessionKey ?? "").trim();
  const channel = String(booking?.channel ?? "").trim().toLowerCase();
  const bookingState = {
    bookingId: bookingId || null,
    itemId: itemId || null,
    status,
    approvalStage: approvalStage || null,
    durationDays: Number.isFinite(durationNumber)
      ? Math.max(1, Math.floor(durationNumber))
      : null,
    ...(Number.isFinite(durationHoursNumber) && durationHoursNumber > 0
      ? { durationHours: Math.max(1, Math.floor(durationHoursNumber)) }
      : {}),
    ...(booking?.billingUnit != null && String(booking.billingUnit).trim() !== ""
      ? { billingUnit: String(booking.billingUnit).trim() }
      : {}),
    ...(booking?.billingRatePercentOfDaily != null &&
    Number.isFinite(Number(booking.billingRatePercentOfDaily))
      ? {
          billingRatePercentOfDaily: Math.max(
            1,
            Math.min(100, Math.floor(Number(booking.billingRatePercentOfDaily)))
          ),
        }
      : {}),
    ...(booking?.calculatedPrice != null && Number.isFinite(Number(booking.calculatedPrice))
      ? { calculatedPrice: Math.round(Number(booking.calculatedPrice)) }
      : {}),
    ...(booking?.currency != null && String(booking.currency).trim() !== ""
      ? { currency: String(booking.currency).trim().toUpperCase() }
      : {}),
    sessionKey: scopedSessionKey || null,
    channel: channel || null,
    updatedAt: new Date().toISOString(),
  };
  memory.bookingState = bookingState;
  if (itemId) {
    const previous =
      memory.bookingStatesByItemId &&
      typeof memory.bookingStatesByItemId === "object" &&
      !Array.isArray(memory.bookingStatesByItemId)
        ? memory.bookingStatesByItemId
        : {};
    memory.bookingStatesByItemId = {
      ...previous,
      [itemId]: bookingState,
    };
  }
  delete memory.bookingCreated;
  console.log("[booking_state_set]", {
    bookingId: bookingState.bookingId,
    itemId: bookingState.itemId,
    status: bookingState.status,
    approvalStage: bookingState.approvalStage,
    durationDays: bookingState.durationDays,
    sessionKey: bookingState.sessionKey,
    channel: bookingState.channel,
  });
  return bookingState;
}

/**
 * Booking-continuation shape from the *current* user message only (not memory duration).
 * Used to gate owner-approval shortcuts and duplicate-booking replies for pricing/details turns.
 */
function isBookingContinuationShapedCurrentTurn(
  message,
  extractedDurationDays,
  contactValidCurrent,
  events
) {
  const m = String(message ?? "");
  if (
    isExplicitPricingOrDetailsQuestion(m) &&
    !hasStrongBookingCommitPhrase(m)
  ) {
    console.log("[pricing_intent_precedence_applied]", {
      messagePreview: m.slice(0, 160),
      extractedDurationDays: Number.isFinite(extractedDurationDays)
        ? extractedDurationDays
        : null,
      explicitPricingOrDetailsQuestion: true,
      bookingContinuationBlocked: true,
      reason: "pricing_with_duration",
    });
    return false;
  }
  const dm = Number.isFinite(extractedDurationDays);
  const dc = contactValidCurrent === true;
  const durationPhrase =
    /\b\d+\s*(?:din|deen|dino|day|days|hour|hours|hr|hrs|ghanta|ghantay|ghanty|ghante|ghantey|ghnty|ghntay|ghnte|gnty|gntay|gnte|gantay|gante|gantey|week|weeks)\b/i.test(m) ||
    /^\s*\d+\s*$/i.test(m.trim());
  const commitVerb =
    /\b(book|booking|bookings|reserve|reservation|confirm|confirmed|order|orders|mangwa|mangwao|chahiye|chaiye|chaahiye|kardo|kar\s*do|kara\s*do|lagwa)\b/i.test(
      m
    );
  const rentCommit = /\brent\s*(kar|karna|lena|leni)\b/i.test(m);
  if (dm || dc || durationPhrase) return true;
  if (events?.confirmationIntent) return true;
  if (rentCommit) return true;
  if (commitVerb) return true;
  if (events?.transactionalIntent && !isExplicitPricingOrDetailsQuestion(m))
    return true;
  if (isExplicitPricingOrDetailsQuestion(m) && commitVerb) return true;
  return false;
}

function shouldSuppressDuplicateAlreadyReceivedReply(
  message,
  extractedDurationDays,
  contactValid,
  events
) {
  return (
    isExplicitPricingOrDetailsQuestion(message) &&
    !isBookingContinuationShapedCurrentTurn(
      message,
      extractedDurationDays,
      contactValid,
      events
    )
  );
}

export function clearStructuredBookingState(memory, reason = "UNKNOWN") {
  if (!memory || typeof memory !== "object") return false;
  const hadState = memory.bookingState != null || memory.bookingCreated != null;
  if (!hadState) return false;
  const previous =
    memory.bookingState && typeof memory.bookingState === "object"
      ? {
          bookingId: memory.bookingState.bookingId ?? null,
          itemId: memory.bookingState.itemId ?? null,
          status: memory.bookingState.status ?? null,
          approvalStage: memory.bookingState.approvalStage ?? null,
        }
      : null;
  delete memory.bookingState;
  delete memory.bookingCreated;
  console.log("[booking_state_cleared]", {
    reason,
    previous,
  });
  return true;
}

export function isDuplicateActiveBookingState(memory, candidate = {}) {
  pruneExpiredBookingStates(memory);
  const candidateItemId = normalizeId(candidate.itemId);
  const byItem =
    memory?.bookingStatesByItemId &&
    typeof memory.bookingStatesByItemId === "object" &&
    !Array.isArray(memory.bookingStatesByItemId)
      ? memory.bookingStatesByItemId
      : {};
  const state =
    candidateItemId && byItem[candidateItemId] && typeof byItem[candidateItemId] === "object"
      ? byItem[candidateItemId]
      : memory?.bookingState && typeof memory.bookingState === "object"
        ? memory.bookingState
        : null;
  const candidateDuration = Number(candidate.durationDays);
  const stateDuration = Number(state?.durationDays);
  const active = bookingStateIsActive(state);
  const sameItem = Boolean(candidateItemId) && candidateItemId === normalizeId(state?.itemId);
  const sameDuration =
    Number.isFinite(candidateDuration) &&
    Number.isFinite(stateDuration) &&
    Math.max(1, Math.floor(candidateDuration)) === Math.max(1, Math.floor(stateDuration));
  const candidateSessionKey = String(candidate.sessionKey ?? "").trim();
  const stateSessionKey = String(state?.sessionKey ?? "").trim();
  const sameSession =
    !candidateSessionKey || !stateSessionKey || candidateSessionKey === stateSessionKey;
  const candidateChannel = String(candidate.channel ?? "").trim().toLowerCase();
  const stateChannel = String(state?.channel ?? "").trim().toLowerCase();
  const sameChannel = !candidateChannel || !stateChannel || candidateChannel === stateChannel;
  const recent = bookingStateAgeMs(state) <= BOOKING_DUPLICATE_WINDOW_MS;
  const duplicate = Boolean(
    active && sameItem && sameDuration && sameSession && sameChannel && recent
  );
  console.log("[booking_duplicate_guard]", {
    duplicate,
    active,
    candidateItemId: candidateItemId || null,
    stateItemId: normalizeId(state?.itemId) || null,
    candidateDuration: Number.isFinite(candidateDuration)
      ? Math.max(1, Math.floor(candidateDuration))
      : null,
    stateDuration: Number.isFinite(stateDuration)
      ? Math.max(1, Math.floor(stateDuration))
      : null,
    status: state?.status ?? null,
    approvalStage: state?.approvalStage ?? null,
    sameSession,
    sameChannel,
    recent,
  });
  return duplicate;
}

function directInformationalReply(message, item) {
  const raw = String(message ?? "").toLowerCase();
  const src = item && typeof item === "object" ? item : {};
  const label =
    buildDisplayLabel(src) || String(src.displayLabel ?? src.name ?? "").trim();
  const color =
    src.color ??
    src.colour ??
    src.attributes?.color ??
    src.attributes?.colour ??
    src.state?.color ??
    src.state?.colour ??
    null;
  if (/\b(colou?r)\b/i.test(raw) && color != null && String(color).trim()) {
    return label
      ? `${label} ${String(color).trim()} color mein hai.`
      : `${String(color).trim()} color mein hai.`;
  }
  const price =
    src.price ??
    src.pricePerDay ??
    src.dailyRate ??
    src.rent ??
    src.rate ??
    src.attributes?.price ??
    src.attributes?.rate ??
    null;
  if (
    /\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/i.test(raw) &&
    price != null &&
    String(price).trim()
  ) {
    return label
      ? `${label} ka rate ${String(price).trim()} hai.`
      : `Rate ${String(price).trim()} hai.`;
  }
  return "";
}

/** @param {boolean} hasUsefulBusinessData */
function messageMetaForKnowledge(hasUsefulBusinessData) {
  return {
    isFlagged: !hasUsefulBusinessData,
    sourceOfAnswer: hasUsefulBusinessData
      ? SOURCE_STRUCTURED_PROFILE
      : SOURCE_LIMITED_CONTEXT,
  };
}

/**
 * Firestore thread + in-memory turns for normalization (avoid duplicate reply shapes when memory is cold).
 * @param {string[]} historyList
 * @param {string[]} memoryList
 * @param {number} max
 */
function mergeAssistantReplyListsForNorm(historyList, memoryList, max = 8) {
  const out = [];
  const seen = new Set();
  for (const t of [...historyList, ...memoryList]) {
    const s = String(t ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase().slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out.slice(-max);
}

/**
 * Recent assistant line offered browsing / "pick a specific option" (flexible Roman Urdu + English).
 * Intentionally allows words between "aur" and "option" (e.g. "koi aur available option").
 */
function assistantReplySignalsCatalogSelectionPrompt(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  const patterns = [
    /\bspecific\s+option\b/i,
    /\boption\s+poochna\b/i,
    /\b(?:koi\s+aur|another|other)\b[\s\S]{0,80}?\boption\b/i,
    /\baur\b[\s\S]{0,48}?\bavailable\b[\s\S]{0,48}?\boption\b/i,
    /\bavailable\s+options?\b/i,
    /\bavailable\s+option\b/i,
    /\boption\b[\s\S]{0,48}?\bnazar\b/i,
    /\bnazar\b[\s\S]{0,48}?\boption\b/i,
    /\bdekhna\s+chahenge\b/i,
    /\bwhich\s+option\b/i,
    /\b(?:kaunsa|konsa)\s+option\b/i,
  ];
  return patterns.some((re) => re.test(s));
}

const defaultPhraseLibrary = {
  askContact: [
    "Aap apna naam aur number share kar dein",
    "Naam aur contact number de dein please",
    "Contact details share kar dein taake confirm kar doon",
  ],
  acknowledgeDuration: [
    (d) => `Perfect, ${d} days noted`,
    (d) => `${d} days noted`,
  ],
  availability: [
    (item) => {
      const label = buildDisplayLabel(item) || "this option";
      return `Yes, ${label} is available right now. For how long would you like it?`;
    },
  ],
};

function getPhraseLibrary(businessConfig) {
  return businessConfig?.phrases || defaultPhraseLibrary;
}

function pick(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildPhraseReply({ stage, item, duration, businessConfig, style }) {
  const phrases = getPhraseLibrary(businessConfig);
  const toSingleMessageText = (value) => {
    if (Array.isArray(value)) {
      return value
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .join("\n")
        .trim();
    }
    return String(value ?? "").trim();
  };

  if (stage === "availability") {
    if (item && typeof item === "object" && item.isAvailable !== true) {
      return null;
    }
    if (!businessConfig?.phrases) {
      const label = buildDisplayLabel(item) || "this option";
      if (style === "casual_local") {
        return `Ji, ${label} available hai. Kitne time ke liye chahiye?`;
      }
      return `Yes, ${label} is available right now. For how long would you like it?`;
    }
    const fn = pick(phrases.availability);
    return toSingleMessageText(typeof fn === "function" ? fn(item) : fn);
  }

  if (stage === "askContact") {
    if (!businessConfig?.phrases) {
      return buildAskContactReply({ duration, style });
    }
    const ack = pick(phrases.acknowledgeDuration);
    const contact = pick(phrases.askContact);

    const ackText =
      typeof ack === "function" && duration != null ? ack(duration) : "";

    if (ackText) {
      return toSingleMessageText(`${ackText}\n${contact}`);
    }

    return toSingleMessageText(contact);
  }

  return null;
}

function detectConversationStyle(messages) {
  const parts = Array.isArray(messages)
    ? messages
        .map((m) => String(m ?? "").trim())
        .filter(Boolean)
        .slice(-4)
    : [];
  const text = parts.join(" ").trim();
  if (!text) return "neutral_english";

  const asciiLetters = (text.match(/[a-z]/gi) || []).length;
  const urduChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean);
  const shortCasualTurns = parts.filter((p) => p.split(/\s+/).length <= 6).length;
  const englishFunctionWords = (text.match(/\b(the|and|for|with|please|right|available|would|you|your)\b/gi) || []).length;
  const compactLocalTokens = words.filter(
    (w) =>
      /^[a-z]+$/i.test(w) &&
      w.length >= 2 &&
      !/[aeiou]{2,}/i.test(w) &&
      /[bcdfghjklmnpqrstvwxyz]{2,}/i.test(w)
  ).length;

  if (urduChars > 0) return "casual_local";
  if (asciiLetters > 0 && words.length > 0) {
    const englishDensity = englishFunctionWords / Math.max(1, words.length);
    if (shortCasualTurns >= 2 && englishDensity < 0.28) return "casual_local";
    if (compactLocalTokens >= 2 && englishDensity < 0.34) return "casual_local";
  }
  return "neutral_english";
}

function buildUnavailableReply({ itemLabel, style }) {
  const label = String(itemLabel ?? "").trim();
  if (style === "casual_local") {
    return `Sorry, ${label || "yeh option"} abhi available nahi hai. Kya aap koi aur option dekhna chahenge?`;
  }
  return `Sorry, ${label || "this option"} is not available right now. Would you like to check another option?`;
}

/**
 * Composer-only unavailable item reply (same spine as early availability question).
 * Does not invoke narrow availability AI.
 * @param {{
 *   itemLabel: string,
 *   reqId: string | null,
 *   blockingStatusesSeen: string[],
 *   alternativeItems: Array<{ id?: string, name?: string }>,
 *   alternativeSummarySkipped: boolean,
 *   catalogLength: number,
 *   styleKey: "casual_local" | "neutral_english",
 *   normalizedCatalogForTurn: unknown[],
 * }} p
 */
function composeBookingUnavailableItemAvailabilityContextReply(p) {
  const itemLabel = String(p.itemLabel ?? "").trim() || "yeh option";
  const reqId = p.reqId != null ? String(p.reqId).trim() || null : null;
  const blockingStatusesSeen = Array.isArray(p.blockingStatusesSeen)
    ? p.blockingStatusesSeen
    : [];
  const altRows = Array.isArray(p.alternativeItems) ? p.alternativeItems : [];
  const topItems = altRows
    .map((a) => {
      const id = String(a.id ?? "").trim();
      const match = (Array.isArray(p.normalizedCatalogForTurn) ? p.normalizedCatalogForTurn : []).find(
        (r) => String(r.id ?? r.itemId ?? "").trim() === id
      );
      return match
        ? catalogRowToTopAvailabilityItem(
            /** @type {Record<string, unknown>} */ (match),
            buildDisplayLabel
          )
        : {
            itemId: id,
            displayLabel: String(a.name ?? "").trim(),
            priceDaily: null,
            category: null,
            tags: [],
          };
    })
    .slice(0, 5);
  const summarySkipped = p.alternativeSummarySkipped === true;
  const summaryStatus = summarySkipped ? "missing" : "fresh";
  const otherAvailableCount = summarySkipped ? 0 : altRows.length;
  const catalogLen = Number.isFinite(Number(p.catalogLength))
    ? Math.max(0, Math.floor(Number(p.catalogLength)))
    : 0;
  const availabilityCtx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: reqId,
      displayLabel: itemLabel,
      availabilityStatus: "unavailable",
      blockingReason:
        blockingStatusesSeen.length > 0
          ? String(blockingStatusesSeen[0])
          : "ALREADY_BOOKED",
    },
    inventorySummary: {
      status: summaryStatus,
      totalItems: catalogLen,
      availableCount: otherAvailableCount,
      unavailableCount: null,
      topAvailableItems: topItems,
      maxItemsShown: 5,
    },
    policy: {},
    alternativeSummarySkipped: summarySkipped,
  });
  const composed = composeStructuredAvailabilityCustomerReply(
    availabilityCtx,
    p.styleKey
  );
  const reply = enforceAvailabilityTruthOnReply(
    composed,
    availabilityCtx,
    p.styleKey
  );
  return {
    reply,
    availabilityCtx,
    meta: {
      summaryStatus,
      availableCount: otherAvailableCount,
      topItemCount: topItems.length,
      alternativeSummarySkipped: summarySkipped,
    },
  };
}

/**
 * Early booking / duration path: unavailable item reply aligned with
 * {@link composeStructuredAvailabilityCustomerReply} + truth enforce (no narrow availability AI).
 * @param {{
 *   userId: string,
 *   catalogRow: Record<string, unknown>,
 *   availabilitySnapshot: { blockingStatusesSeen?: string[] },
 *   normalizedCatalogForTurn: unknown[],
 *   styleKey: "casual_local" | "neutral_english",
 *   traceId?: string | null,
 *   logKind?: "booking_unavailable" | "booking_blocked",
 *   memory?: Record<string, unknown> | null,
 * }} p
 */
async function buildBookingDurationUnavailableStructuredCustomerReply(p) {
  const userId = String(p.userId ?? "").trim();
  const row = p.catalogRow && typeof p.catalogRow === "object" && !Array.isArray(p.catalogRow)
    ? p.catalogRow
    : null;
  const av = p.availabilitySnapshot && typeof p.availabilitySnapshot === "object"
    ? p.availabilitySnapshot
    : {};
  const catalog = Array.isArray(p.normalizedCatalogForTurn) ? p.normalizedCatalogForTurn : [];
  const styleKey = p.styleKey === "casual_local" ? "casual_local" : "neutral_english";
  const traceId = p.traceId != null ? String(p.traceId).trim() || null : null;
  const logKind = p.logKind === "booking_blocked" ? "booking_blocked" : "booking_unavailable";
  const builtLogName =
    logKind === "booking_blocked"
      ? "[booking_blocked_availability_context_built]"
      : "[booking_unavailable_availability_context_built]";
  const replyLogName =
    logKind === "booking_blocked"
      ? "[booking_blocked_reply_source]"
      : "[booking_unavailable_reply_source]";
  const missingLogName =
    logKind === "booking_blocked"
      ? "[booking_blocked_availability_context_missing]"
      : "[booking_unavailable_availability_context_missing]";

  if (!userId || !row) {
    console.log(missingLogName, {
      traceId,
      requestedItemId: null,
      reason: "MISSING_USER_OR_ROW",
      catalogCount: catalog.length,
      summaryStatus: null,
    });
    return null;
  }

  const itemLabel =
    buildDisplayLabel(/** @type {Record<string, unknown>} */ (row)) ||
    String(row.name ?? "").trim() ||
    "yeh option";
  const reqId = String(row.itemId ?? row.id ?? "").trim() || null;
  const blockingStatusesSeen = Array.isArray(av.blockingStatusesSeen)
    ? av.blockingStatusesSeen
    : [];

  /** @type {Array<{ id: string, name: string }>} */
  let alternativeItems = [];
  let alternativeSummarySkipped = false;
  const MAX_CATALOG_FOR_ALT_SNAPSHOT = 400;

  if (catalog.length > MAX_CATALOG_FOR_ALT_SNAPSHOT) {
    alternativeSummarySkipped = true;
  } else if (catalog.length > 0) {
    const rowId = String(row.id ?? row.itemId ?? "").trim();
    const rowName = String(row.name ?? "").trim();
    if (rowId) {
      const raw = await pickAlternativeAvailableItemsFromCatalogRows(
        userId,
        rowId,
        rowName,
        catalog,
        { limit: 5, maxRankedCandidates: 150 }
      );
      alternativeItems = raw.map((x) => ({
        id: String(x.id ?? x.itemId ?? "").trim(),
        name: String(x.name ?? "").trim(),
      }));
    }
  } else {
    const rowId = String(row.id ?? row.itemId ?? "").trim();
    if (rowId) {
      const raw = await getAlternativeAvailableItems(
        userId,
        rowId,
        String(row.name ?? "").trim(),
        5
      );
      alternativeItems = raw.map(({ id, name }) => ({
        id: String(id ?? "").trim(),
        name: String(name ?? "").trim(),
      }));
    }
  }

  const composed = composeBookingUnavailableItemAvailabilityContextReply({
    itemLabel,
    reqId,
    blockingStatusesSeen,
    alternativeItems,
    alternativeSummarySkipped,
    catalogLength: catalog.length,
    styleKey,
    normalizedCatalogForTurn: catalog,
  });

  console.log(builtLogName, {
    traceId,
    source:
      logKind === "booking_blocked"
        ? "BOOKING_BLOCKED_AVAILABILITY_CHECK"
        : "booking_duration_unavailable",
    requestedItemId: reqId,
    requestedItemLabel: itemLabel,
    summaryStatus: composed.meta.summaryStatus,
    availableCount: composed.meta.availableCount,
    topItemCount: composed.meta.topItemCount,
    alternativeSummarySkipped: composed.meta.alternativeSummarySkipped,
  });

  const preview = String(composed.reply ?? "").trim().slice(0, 220) || null;
  console.log(replyLogName, {
    traceId,
    source: "availability_context",
    previousSource:
      logKind === "booking_blocked"
        ? "BOOKING_BLOCKED_AVAILABILITY_CHECK/buildUnavailableReply"
        : "buildUnavailableReply",
    summaryStatus: composed.meta.summaryStatus,
    availableCount: composed.meta.availableCount,
    replyPreview: preview,
  });

  const meta = composed.meta;
  if (
    p.memory &&
    typeof p.memory === "object" &&
    meta.alternativeSummarySkipped !== true &&
    String(meta.summaryStatus ?? "").trim().toLowerCase() === "fresh" &&
    Number.isFinite(Number(meta.availableCount)) &&
    Number(meta.availableCount) === 0
  ) {
    markAvailabilityFreshNoOtherOptionsStructured(p.memory);
  }

  return composed.reply;
}

/**
 * @param {Record<string, unknown> | null | undefined} itemLike
 * @param {string} [fallbackLabel]
 */
function catalogRowFromItemLike(itemLike, fallbackLabel = "") {
  const ic = itemLike && typeof itemLike === "object" && !Array.isArray(itemLike) ? itemLike : null;
  const id = normalizeId(ic?.itemId ?? ic?.id);
  if (!id) return null;
  const label =
    buildDisplayLabel(ic) ||
    String(ic?.name ?? "").trim() ||
    String(fallbackLabel ?? "").trim();
  return {
    ...ic,
    id,
    itemId: id,
    name: label || String(ic?.name ?? "").trim(),
  };
}

function buildCollectDurationAvailabilityUnknownReply({ itemLabel, style }) {
  const label = String(itemLabel ?? "").trim();
  if (style === "casual_local") {
    return label
      ? `Main abhi ${label} ki availability confirm kar ke bata deta hun.`
      : "Main abhi availability confirm kar ke bata deta hun.";
  }
  return label
    ? `I’ll confirm availability for ${label} and get back to you shortly.`
    : "I’ll confirm availability and get back to you shortly.";
}

/**
 * Structured unavailable reply from catalog row + hydration snapshot (composer + truth enforce).
 * @param {{
 *   userId: string,
 *   catalogRow: Record<string, unknown> | null,
 *   availabilitySnapshot?: { blockingStatusesSeen?: string[], isAvailable?: boolean },
 *   normalizedCatalogForTurn: unknown[],
 *   styleKey: "casual_local" | "neutral_english",
 *   conversationStyle?: string,
 *   traceId?: string | null,
 *   logKind?: "booking_unavailable" | "booking_blocked",
 *   memory?: Record<string, unknown> | null,
 * }} p
 */
async function resolveStructuredUnavailableCustomerReply(p) {
  const styleKey = p.styleKey === "casual_local" ? "casual_local" : "neutral_english";
  const row = catalogRowFromItemLike(p.catalogRow);
  const itemLabel =
    (row && (buildDisplayLabel(row) || String(row.name ?? "").trim())) || "yeh option";
  if (!row || !String(p.userId ?? "").trim()) {
    return buildUnavailableReply({
      itemLabel,
      style: p.conversationStyle === "casual_local" ? "casual_local" : "neutral_english",
    });
  }
  try {
    const structuredReply = await buildBookingDurationUnavailableStructuredCustomerReply({
      userId: String(p.userId ?? "").trim(),
      catalogRow: row,
      availabilitySnapshot: p.availabilitySnapshot ?? {},
      normalizedCatalogForTurn: p.normalizedCatalogForTurn,
      styleKey,
      traceId: p.traceId ?? null,
      logKind: p.logKind,
      memory: p.memory,
    });
    const text = String(structuredReply ?? "").trim();
    if (text) return text;
  } catch (err) {
    console.warn("[structured_unavailable_reply_failed]", {
      traceId: p.traceId ?? null,
      error: String(err?.message ?? err),
    });
  }
  return buildUnavailableReply({
    itemLabel,
    style: p.conversationStyle === "casual_local" ? "casual_local" : "neutral_english",
  });
}

/**
 * Hydrated user-facing availability wins over early booking-window check before any booking create.
 * @param {{
 *   userId: string,
 *   catalogRow: Record<string, unknown>,
 *   earlyAvailabilitySnapshot?: { isAvailable?: boolean, blockingStatusesSeen?: string[] },
 *   normalizedCatalogForTurn: unknown[],
 *   styleKey: "casual_local" | "neutral_english",
 *   conversationStyle?: string,
 *   traceId?: string | null,
 *   logKind?: "booking_unavailable" | "booking_blocked",
 *   memory?: Record<string, unknown> | null,
 *   hydrationSource?: string,
 * }} p
 * @returns {Promise<{ blocked: boolean, reply?: string, hydrated?: { isAvailable: boolean, blockingStatusesSeen?: string[] } }>}
 */
async function blockCustomerBookingIfHydratedUnavailable(p) {
  const row = catalogRowFromItemLike(p.catalogRow);
  const rowId = row ? String(row.id ?? row.itemId ?? "").trim() : "";
  if (!rowId || !String(p.userId ?? "").trim()) {
    return { blocked: false };
  }
  const hydrated = await getUserFacingAvailabilityForItem(
    rowId,
    String(row.name ?? "").trim(),
    String(p.hydrationSource ?? "booking_hydration_gate").trim() || "booking_hydration_gate"
  );
  if (hydrated.isAvailable !== false) {
    return { blocked: false, hydrated };
  }
  const earlySnap = p.earlyAvailabilitySnapshot;
  const earlyAvailable = earlySnap?.isAvailable !== false;
  if (earlyAvailable) {
    console.log("[availability_path_mismatch_detected]", {
      traceId: p.traceId != null ? String(p.traceId).trim() || null : null,
      itemId: rowId,
      earlyBookingAvailable: true,
      hydratedAvailable: false,
      earlyBlockingStatusesSeen: Array.isArray(earlySnap?.blockingStatusesSeen)
        ? earlySnap.blockingStatusesSeen
        : [],
      hydratedBlockingStatusesSeen: Array.isArray(hydrated.blockingStatusesSeen)
        ? hydrated.blockingStatusesSeen
        : [],
      earlyReason: earlySnap?.isAvailable === false ? "ALREADY_BOOKED" : "NO_CONFLICT",
      hydratedReason: "ALREADY_BOOKED",
      requestedStart: null,
      requestedEnd: null,
    });
  }
  const reply = await resolveStructuredUnavailableCustomerReply({
    userId: p.userId,
    catalogRow: row,
    availabilitySnapshot: {
      blockingStatusesSeen: Array.isArray(hydrated.blockingStatusesSeen)
        ? hydrated.blockingStatusesSeen
        : [],
    },
    normalizedCatalogForTurn: p.normalizedCatalogForTurn,
    styleKey: p.styleKey,
    conversationStyle: p.conversationStyle,
    traceId: p.traceId,
    logKind: p.logKind ?? "booking_blocked",
    memory: p.memory,
  });
  return { blocked: true, reply, hydrated };
}

function buildAskContactReply({ duration, style }) {
  const d = Number.isFinite(Number(duration)) ? Math.max(1, Math.floor(Number(duration))) : null;
  if (style === "casual_local") {
    const ack = d != null ? `${d} din ke liye noted` : "";
    const ask = "Apna naam aur contact number share kar dein.";
    return [ack, ask].filter(Boolean).join(". ");
  }
  const ack = d != null ? `${d} days noted.` : "";
  const ask = "Please share your name and contact number.";
  return [ack, ask].filter(Boolean).join(" ");
}

function isPrivateDetailPromptText(text = "") {
  const t = String(text ?? "");
  if (!t.trim()) return false;
  const diagnostics = groupPrivateDetailBlockDiagnostics(t);
  return (
    diagnostics.containsPhonePattern ||
    diagnostics.containsContactConfirmation ||
    /\b(phone\s*number|contact\s*number|contact\s+share|number\s+share|contact\s+share\s+kar)\b/i.test(t) ||
    /\b(naam|name)\b/i.test(t) && /\b(share|bhej|bata|send|contact)\b/i.test(t) ||
    /\b(apna\s+naam|your\s+name)\b/i.test(t) ||
    /\b(delivery\s+address|address\s+share|location\s*\/?\s*address\s+share|location\s+share|address\s+bhej|location\s+bhej|address\s+thoda\s+clear)\b/i.test(t) ||
    /\b(delivery\s+ka\s+time|delivery\s+time|kis\s+time\s+(?:bhej|lena)|time\s+kya\s+rakhna|pickup\s+details?)\b/i.test(t) ||
    /\b(delivery\s+kahan|exact\s+kis\s+area|pickup\s+noted|delivery\s+noted)\b/i.test(t) ||
    /\b(city\s+ke\s+andar|inside\s*\/?\s*outside|outside\s+city|city\s+ke\s+bahar|pickup\s+karna|delivery\s+chahiye|pickup\s+rakh|pickup\s+karna\s+chah)\b/i.test(t)
  );
}

function formatCustomerDuration({
  durationDays = null,
  durationHours = null,
  billingUnit = null,
  local = true,
} = {}) {
  const hours = Number(durationHours);
  if (Number.isFinite(hours) && hours > 0) {
    const safeHours = Math.max(1, Math.floor(hours));
    if (String(billingUnit ?? "").trim().toLowerCase() === "half_day" || safeHours < 24) {
      return local ? `${safeHours} ghantay` : `${safeHours} hours`;
    }
  }
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days <= 0) return "";
  const safeDays = Math.max(1, Math.floor(days));
  if (safeDays % 30 === 0) {
    const months = safeDays / 30;
    return `${months} month${months === 1 ? "" : "s"}`;
  }
  if (safeDays % 7 === 0) {
    const weeks = safeDays / 7;
    return `${weeks} week${weeks === 1 ? "" : "s"}`;
  }
  return `${safeDays} din`;
}

function groupPrivateDetailBlockDiagnostics(text = "") {
  const t = String(text ?? "");
  return {
    containsPhonePattern:
      /(?:\[\s*)?(?:\+?92|0092|0)?3[\d\s().-]{8,}\d(?:\s*\])?/i.test(t) ||
      /(?:\[\s*)?\+\d[\d\s().-]{8,}\d(?:\s*\])?/i.test(t),
    containsContactConfirmation:
      /\b(?:aapka|apka|your)?\s*(?:contact|phone)\s*number\s+(?:hai|is)\b/i.test(t) ||
      /\b(?:contact|phone)\s*number\s+(?:hai|is)\b/i.test(t) ||
      (/\bkya\s+yeh\s+sahi\s+hai\b/i.test(t) &&
        /\b(contact|phone|number)\b/i.test(t)),
  };
}

function groupSafeRequestReceivedReply({
  itemAndDurationKnown = false,
  itemName = "",
  durationDays = null,
  durationHours = null,
  billingUnit = null,
} = {}) {
  const itemLabel = String(itemName ?? "").trim();
  const durationLabel = formatCustomerDuration({
    durationDays,
    durationHours,
    billingUnit,
    local: true,
  });
  if (itemLabel && durationLabel) {
    return `Perfect 👍 ${itemLabel} ${durationLabel} ke liye note kar liya. Main confirm kar ke bata deta hun.`;
  }
  return itemAndDurationKnown
    ? "Perfect 👍 request receive ho gayi hai. Main confirm kar ke bata deta hun."
    : "Request receive ho gayi hai. Main confirm kar ke bata deta hun.";
}

function buildGroupSafetyReplacementReply({ inboundMessage = "", result = {}, businessProfile = null } = {}) {
  const parsed = parseUserDuration(inboundMessage);
  const selection = shortBookingSelectionFromParsedDuration(parsed, businessProfile);
  if (selection?.type === "below_minimum") {
    const item =
      result?.messageMeta?.itemContext ||
      result?.messageMeta?.item ||
      result?.messageMeta?.matchedItem ||
      null;
    return buildBelowMinimumShortBookingReply({
      item,
      selection,
      includePrice: hasPriceDisplayIntent(inboundMessage),
    }).reply;
  }
  const itemAndDurationKnown = Boolean(
    result?.messageMeta?.bookingCreated ||
      result?.messageMeta?.durationDays ||
      result?.messageMeta?.durationHours ||
      result?.messageMeta?.bookingId
  );
  const booking =
    result?.messageMeta?.bookingCreated && typeof result.messageMeta.bookingCreated === "object"
      ? result.messageMeta.bookingCreated
      : {};
  return groupSafeRequestReceivedReply({
    itemAndDurationKnown,
    itemName:
      result?.messageMeta?.itemName ??
      booking?.itemName ??
      result?.meta?.itemName ??
      "",
    durationDays:
      result?.messageMeta?.durationDays ??
      booking?.durationDays ??
      result?.meta?.durationDays ??
      null,
    durationHours:
      result?.messageMeta?.durationHours ??
      booking?.durationHours ??
      result?.meta?.durationHours ??
      null,
    billingUnit:
      result?.messageMeta?.billingUnit ??
      booking?.billingUnit ??
      result?.meta?.billingUnit ??
      null,
  });
}

const DEFAULT_SHORT_BOOKING_POLICY = {
  shortBookingMinimumHours: 12,
  shortBookingRatePercentOfDaily: 80,
  shortBookingLabel: "half_day",
};

function resolveShortBookingPolicy(businessProfile = null) {
  const policy =
    businessProfile?.bookingPolicy && typeof businessProfile.bookingPolicy === "object"
      ? businessProfile.bookingPolicy
      : {};
  const minHours = Number(policy.shortBookingMinimumHours);
  const ratePct = Number(policy.shortBookingRatePercentOfDaily);
  const label = String(policy.shortBookingLabel ?? "").trim();
  return {
    shortBookingMinimumHours:
      Number.isFinite(minHours) && minHours > 0
        ? Math.max(1, Math.floor(minHours))
        : DEFAULT_SHORT_BOOKING_POLICY.shortBookingMinimumHours,
    shortBookingRatePercentOfDaily:
      Number.isFinite(ratePct) && ratePct > 0
        ? Math.max(1, Math.min(100, Math.floor(ratePct)))
        : DEFAULT_SHORT_BOOKING_POLICY.shortBookingRatePercentOfDaily,
    shortBookingLabel: label || DEFAULT_SHORT_BOOKING_POLICY.shortBookingLabel,
  };
}

function shortBookingSelectionFromParsedDuration(parsed, businessProfile = null) {
  if (!parsed || typeof parsed !== "object") return null;
  const hours = Number(parsed.normalizedHours ?? (String(parsed.unit).toLowerCase() === "hours" ? parsed.value : NaN));
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const policy = resolveShortBookingPolicy(businessProfile);
  const selectedHours = Math.max(1, Math.floor(hours));
  if (selectedHours < policy.shortBookingMinimumHours) {
    return {
      type: "below_minimum",
      requestedHours: selectedHours,
      minimumHours: policy.shortBookingMinimumHours,
      billingUnit: policy.shortBookingLabel,
      billingRatePercentOfDaily: policy.shortBookingRatePercentOfDaily,
    };
  }
  if (selectedHours === policy.shortBookingMinimumHours) {
    return {
      type: "accepted",
      durationHours: policy.shortBookingMinimumHours,
      billingUnit: policy.shortBookingLabel,
      billingRatePercentOfDaily: policy.shortBookingRatePercentOfDaily,
    };
  }
  return null;
}

function parseDailyRateNumber(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/\b(\d{2,})(?:\.\d+)?\b/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function numericDailyRateFromItem(item = null) {
  if (!item || typeof item !== "object") return null;
  const candidates = [
    item.pricing?.daily,
    item.pricing?.perDay,
    item.pricing?.day,
    item.dailyRate,
    item.pricePerDay,
    item.rentPerDay,
    item.ratePerDay,
    item.perDay,
    item.price,
    item.rent,
    item.rate,
    item.pricing?.dailyRate,
    item.pricing?.pricePerDay,
    item.attributes?.pricing?.daily,
    item.attributes?.pricePerDay,
    item.attributes?.dailyRate,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = parseDailyRateNumber(candidate);
    if (parsed != null) return parsed;
    const num = Number(String(candidate).replace(/[^\d.]/g, ""));
    if (Number.isFinite(num) && num > 0) return num;
  }
  return null;
}

function computeBelowMinimumCalculatedPrice(item, selection) {
  const dailyRate = numericDailyRateFromItem(item);
  if (dailyRate == null) return { dailyRate: null, calculatedPrice: null };
  const calculatedPrice = Math.round(
    dailyRate * (Number(selection?.billingRatePercentOfDaily ?? 80) / 100)
  );
  console.log("[booking_half_day_price_calculated]", {
    dailyRate,
    billingRatePercentOfDaily: selection?.billingRatePercentOfDaily ?? null,
    calculatedPrice,
  });
  return { dailyRate, calculatedPrice };
}

function classifyBelowMinimumTurnKind(message, turnIntentShape = null) {
  if (hasStrongBookingCommitPhrase(message)) return "booking";
  const primary = String(turnIntentShape?.primaryIntent ?? "").trim();
  const policy = String(turnIntentShape?.responsePolicy ?? "").trim();
  if (primary === "booking_request" || policy === "start_or_continue_booking") {
    return "booking";
  }
  if (
    isExplicitPricingOrDetailsQuestion(message) ||
    primary === "pricing_question" ||
    isAnswerRequestedFieldPolicy(turnIntentShape)
  ) {
    return "informational";
  }
  if (/\b(kitna|kitni|kitne|price|pricing|rate|rent|charges?|cost)\b/i.test(String(message ?? ""))) {
    return "informational";
  }
  if (
    /\b(chahiye|chahye|chaiye|book|booking|reserve|lena|lye|ly|karwana|chahye)\b/i.test(
      String(message ?? "")
    )
  ) {
    return "booking";
  }
  return "informational";
}

function buildBelowMinimumDurationReply({
  item = null,
  selection,
  mode = "informational",
  includePrice = true,
  isAvailable = true,
  itemLabel = "",
  hasAlternativeOptions = false,
}) {
  const minimumHours = Number(selection?.minimumHours ?? 12);
  const safeMinimumHours =
    Number.isFinite(minimumHours) && minimumHours > 0 ? Math.floor(minimumHours) : 12;
  const requestedHours = Number(selection?.requestedHours ?? 0);
  const safeRequestedHours =
    Number.isFinite(requestedHours) && requestedHours > 0
      ? Math.floor(requestedHours)
      : safeMinimumHours;
  const { calculatedPrice } = computeBelowMinimumCalculatedPrice(item, selection);
  const currency = currencyFromItem(item);
  const label =
    String(itemLabel ?? "").trim() ||
    buildDisplayLabel(item) ||
    String(item?.displayLabel ?? item?.name ?? "").trim() ||
    "Yeh option";
  const parts = [
    `${safeRequestedHours} ghantay ke liye gari rent par nahi milti. Minimum ${safeMinimumHours} ghantay ka slot hai.`,
  ];
  if (includePrice && calculatedPrice != null && !(mode === "booking" && !isAvailable)) {
    const priceLine = `${safeMinimumHours} ghantay ka rent ${calculatedPrice} ${currency} hoga`;
    if (!isAvailable && mode === "informational") {
      parts.push(`${priceLine}, lekin ${label} abhi available nahi hai.`);
    } else {
      parts.push(`${priceLine}.`);
    }
  } else if (!isAvailable) {
    if (hasAlternativeOptions) {
      parts.push(`Lekin ${label} abhi available nahi hai.`);
    } else {
      parts.push(
        `Lekin ${label} abhi available nahi hai, aur filhaal koi aur option bhi available nahi hai.`
      );
    }
  }
  const offerCheckKarun = mode === "booking" && isAvailable;
  if (offerCheckKarun) {
    parts.push(`${safeMinimumHours} ghantay ke liye check karun?`);
  }
  return {
    reply: parts.join(" "),
    calculatedPrice,
    offerCheckKarun,
  };
}

function planBelowMinimumHoursTurn({
  message,
  selection,
  item,
  turnIntentShape = null,
  isGroupInbound = false,
  isAvailable = true,
  itemLabel = "",
  alternativeItems = [],
  modeOverride = null,
}) {
  const kind =
    modeOverride ??
    classifyBelowMinimumTurnKind(message, turnIntentShape);
  const explicitPriceIntent = hasPriceDisplayIntent(message);
  const includePrice =
    kind === "informational" || !isGroupInbound || explicitPriceIntent;
  const hasAlternativeOptions =
    Array.isArray(alternativeItems) && alternativeItems.length > 0;
  const built = buildBelowMinimumDurationReply({
    item,
    selection,
    mode: kind === "booking" ? "booking" : "informational",
    includePrice,
    isAvailable,
    itemLabel,
    hasAlternativeOptions,
  });
  const itemId = normalizeId(item?.itemId ?? item?.id);
  const shouldStorePending =
    kind === "booking" && isAvailable && built.offerCheckKarun && Boolean(itemId);
  return {
    kind,
    explicitPriceIntent,
    shouldStorePending,
    ...built,
  };
}

function currencyFromItem(item = null) {
  if (!item || typeof item !== "object") return "PKR";
  const raw =
    item.currency ??
    item.priceCurrency ??
    item.currencyCode ??
    item.pricing?.currency ??
    item.pricing?.priceCurrency ??
    item.pricing?.currencyCode ??
    "PKR";
  const currency = String(raw ?? "").trim().toUpperCase();
  return currency || "PKR";
}

function buildBelowMinimumShortBookingReply({
  item = null,
  selection,
  includePrice = true,
  mode = "booking",
  isAvailable = true,
  itemLabel = "",
  alternativeItems = [],
}) {
  return buildBelowMinimumDurationReply({
    item,
    selection,
    mode,
    includePrice,
    isAvailable,
    itemLabel,
    hasAlternativeOptions: Array.isArray(alternativeItems) && alternativeItems.length > 0,
  });
}

function shortBookingCreateFields(selection = null, item = null) {
  if (!selection || selection.type !== "accepted") return {};
  const dailyRate = numericDailyRateFromItem(item);
  const calculatedPrice =
    dailyRate != null
      ? Math.round(dailyRate * (Number(selection.billingRatePercentOfDaily ?? 80) / 100))
      : null;
  if (calculatedPrice != null) {
    console.log("[booking_half_day_price_calculated]", {
      dailyRate,
      billingRatePercentOfDaily: selection.billingRatePercentOfDaily,
      calculatedPrice,
    });
  }
  return {
    durationHours: selection.durationHours,
    billingUnit: selection.billingUnit,
    billingRatePercentOfDaily: selection.billingRatePercentOfDaily,
    ...(calculatedPrice != null ? { calculatedPrice } : {}),
  };
}

const PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
const LAST_VERIFIED_CATALOG_ANSWER_TTL_MS = PENDING_ACTION_TTL_MS;
const VERIFIED_CATALOG_PRICING_ANSWER_TYPE = "pricing";
const TRUSTED_VERIFIED_CATALOG_ANSWER_SOURCES = new Set(["verified_catalog"]);
const VERIFIED_CATALOG_PRICING_REQUESTED_FIELDS = new Set([
  "price",
  "price_daily",
  "price_monthly",
  "price_with_duration",
]);
const PENDING_ACTION_STATUS_AWAITING = "awaiting_user";
const PENDING_ACTION_TYPES = Object.freeze({
  ACCEPT_SHORT_BOOKING_OFFER: "accept_short_booking_offer",
  COLLECT_DURATION: "collect_duration",
  CONFIRM_FUZZY_CATALOG: "confirm_fuzzy_catalog",
  SHOW_ALTERNATIVE_OPTIONS: "show_alternative_options",
  SEND_ITEM_PHOTOS: "send_item_photos",
  SELECT_ITEM_OPTION: "select_item_option",
  CONFIRM_BOOKING_REQUEST: "confirm_booking_request",
  COLLECT_DELIVERY_METHOD: "collect_delivery_method",
});

const FUZZY_PENDING_INFERRED_INTENTS = new Set([
  "availability_check",
  "pricing_question",
  "general_item_question",
]);

function pendingActionNowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function pendingActionExpiryIso(nowMs = Date.now(), ttlMs = PENDING_ACTION_TTL_MS) {
  return new Date(nowMs + ttlMs).toISOString();
}

function hasPriceDisplayIntent(message) {
  const lower = String(message ?? "").toLowerCase();
  return /\b(price|pricing|rate|rates|rent|rental|cost|charges?|amount|quote|quotation|kitna|kitni|kitne|how much|per\s*day|daily|rs\.?|pkr)\b/i.test(
    lower
  );
}

function normalizeReplyIntentText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyAffirmationToken(text) {
  const compact = normalizeReplyIntentText(text).replace(/\s+/g, "");
  if (!compact) return false;
  if (/^(?:yes|yep|yeah|han|haan|ok|okay|theek|thik|sure|done)$/i.test(compact)) {
    return true;
  }
  if (/^j+i*$/i.test(compact) || /^j+e+$/i.test(compact)) return true;
  if (compact === "g") return true;
  return false;
}

function normalizeAffirmationReplyToken(text) {
  const base = normalizeReplyIntentText(text);
  if (!base) return "";
  return isLikelyAffirmationToken(base) ? "ji" : base;
}

function inferPendingActionReplyIntent(message, { pendingAction = null } = {}) {
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  const text = normalizeReplyIntentText(raw);
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  const wordCount = words.length;
  const duration = parseUserDuration(raw);
  const pendingExpectsDuration =
    pendingAction?.type === PENDING_ACTION_TYPES.COLLECT_DURATION ||
    pendingAction?.expectedReplyType === "duration";

  if (!text) {
    return { type: "unknown", confidence: "low", explicitNewIntent: false };
  }

  if (pendingExpectsDuration && duration) {
    return { type: "duration", confidence: "high", explicitNewIntent: false, duration };
  }

  const hasExplicitNewRequest =
    /\b(available|availability|maujood|mil(?:e|a|egi|ega)?|book|booking|reserve|rent|rental|chahiye|chahye|chaiye|need|want|show|dikhao|photo|photos|picture|pictures|image|images|option|options|koi\s+aur|another|different|instead|change|replace)\b/i.test(
      text
    ) &&
    !/^(?:ji|jee|han|haan|yes|ok|okay|theek|thik|sure|done|please|pls)(?:\s+(?:please|pls))?$/i.test(
      text
    );

  if (hasExplicitNewRequest) {
    return { type: "new_request", confidence: "high", explicitNewIntent: true };
  }

  if (/^(?:no|nope|nah|nahi|nahe|nai|mat|cancel|stop|rehne\s+den|rehne\s+dein|not\s+now)$/i.test(text)) {
    return { type: "rejection", confidence: "high", explicitNewIntent: false };
  }

  if (duration) {
    return { type: "duration", confidence: "high", explicitNewIntent: false, duration };
  }

  const affirmationText = normalizeAffirmationReplyToken(text);
  const isAffirmation =
    wordCount <= 4 &&
    (/^(?:yes|yep|yeah|han|haan|ji|jee|ok|okay|theek|thik|sure|done|please|pls)(?:\s+(?:please|pls|ji|jee))?$/i.test(
      affirmationText
    ) ||
      isLikelyAffirmationToken(text) ||
      /^(?:kar|kr)\s*(?:do|dein|den|dain)$/i.test(affirmationText) ||
      /^check\s*(?:karen|karain|karna|kar\s+den|kar\s+dein)$/i.test(affirmationText));

  if (isAffirmation) {
    return { type: "affirmation", confidence: "high", explicitNewIntent: false };
  }

  const delivery = interpretDeliveryMethodMessage(raw);
  if (delivery?.method === "delivery" || delivery?.method === "pickup") {
    return {
      type: "delivery_method",
      confidence: delivery.confidence === "high" ? "high" : "medium",
      explicitNewIntent: false,
      deliveryMethod: delivery.method,
    };
  }

  return {
    type: pendingAction?.expectedReplyType === "affirmation" && wordCount <= 3 ? "unknown" : "unknown",
    confidence: "low",
    explicitNewIntent: false,
  };
}

function pendingActionIsExpired(pendingAction, nowMs = Date.now()) {
  const expiresMs = Date.parse(String(pendingAction?.expiresAt ?? ""));
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}

function clearPendingAction(memory, reason = "UNKNOWN") {
  if (!memory || typeof memory !== "object" || !memory.pendingAction) return false;
  const pending = memory.pendingAction;
  delete memory.pendingAction;
  console.log("[pending_action_cleared]", {
    reason,
    type: String(pending?.type ?? "").trim() || null,
    pendingActionId: String(pending?.id ?? "").trim() || null,
  });
  return true;
}

function buildPendingAction({
  type,
  expectedReplyType,
  participantKey,
  groupChatKey,
  sessionKey,
  itemId,
  itemDisplayLabel,
  payload = {},
  sourceMessageId = null,
  sourcePromptText = "",
  nowMs = Date.now(),
} = {}) {
  return {
    id: randomUUID(),
    type,
    status: PENDING_ACTION_STATUS_AWAITING,
    expectedReplyType,
    participantKey: String(participantKey ?? "").trim() || null,
    groupChatKey: String(groupChatKey ?? "").trim() || null,
    sessionKey: String(sessionKey ?? "").trim() || null,
    itemId: String(itemId ?? "").trim() || null,
    itemDisplayLabel: String(itemDisplayLabel ?? "").trim() || null,
    payload,
    createdAt: pendingActionNowIso(nowMs),
    expiresAt: pendingActionExpiryIso(nowMs),
    sourceMessageId: String(sourceMessageId ?? "").trim() || null,
    sourcePromptText: String(sourcePromptText ?? "").trim() || null,
  };
}

function storePendingAction(memory, pendingAction) {
  if (!memory || typeof memory !== "object" || !pendingAction) return null;
  memory.pendingAction = pendingAction;
  console.log("[pending_action_stored]", {
    pendingActionId: String(pendingAction.id ?? "").trim() || null,
    type: pendingAction.type,
    expectedReplyType: pendingAction.expectedReplyType,
    itemId: pendingAction.itemId,
    participantKey: pendingAction.participantKey || null,
    groupChatKey: pendingAction.groupChatKey || null,
    expiresAt: pendingAction.expiresAt || null,
  });
  return pendingAction;
}

function validateAcceptShortBookingOfferPayload(payload = {}) {
  const itemId = String(payload?.itemId ?? "").trim();
  const minimumHours = Number(payload?.minimumHours);
  const billingUnit = String(payload?.billingUnit ?? "").trim();
  const billingRatePercentOfDaily = Number(payload?.billingRatePercentOfDaily);
  if (!itemId) return { ok: false, reason: "MISSING_ITEM_ID" };
  if (!Number.isFinite(minimumHours) || minimumHours <= 0) {
    return { ok: false, reason: "MISSING_MINIMUM_HOURS" };
  }
  if (!billingUnit) return { ok: false, reason: "MISSING_BILLING_UNIT" };
  if (
    !Number.isFinite(billingRatePercentOfDaily) ||
    billingRatePercentOfDaily <= 0
  ) {
    return { ok: false, reason: "MISSING_BILLING_RATE" };
  }
  return { ok: true };
}

function validateCollectDurationPayload(pendingAction = {}) {
  const itemId = String(pendingAction?.itemId ?? pendingAction?.payload?.itemId ?? "").trim();
  const itemDisplayLabel = String(
    pendingAction?.itemDisplayLabel ?? pendingAction?.payload?.itemDisplayLabel ?? ""
  ).trim();
  const source = String(pendingAction?.payload?.source ?? "").trim();
  if (!itemId) return { ok: false, reason: "MISSING_ITEM_ID" };
  if (!itemDisplayLabel) return { ok: false, reason: "MISSING_ITEM_LABEL" };
  if (source !== "verified_item_selection") {
    return { ok: false, reason: "INVALID_COLLECT_DURATION_SOURCE" };
  }
  return { ok: true };
}

function validateConfirmFuzzyCatalogPayload(pendingAction = {}) {
  const itemId = String(pendingAction?.itemId ?? pendingAction?.payload?.itemId ?? "").trim();
  const itemDisplayLabel = String(
    pendingAction?.itemDisplayLabel ?? pendingAction?.payload?.itemDisplayLabel ?? ""
  ).trim();
  const inferredIntent = String(pendingAction?.payload?.inferredIntent ?? "").trim();
  if (!itemId) return { ok: false, reason: "MISSING_ITEM_ID" };
  if (!itemDisplayLabel) return { ok: false, reason: "MISSING_ITEM_LABEL" };
  if (!FUZZY_PENDING_INFERRED_INTENTS.has(inferredIntent)) {
    return { ok: false, reason: "INVALID_INFERRED_INTENT" };
  }
  return { ok: true };
}

/**
 * @param {import("./fuzzyTurnNormalizer.js").FuzzyTurnResult} fuzzyTurnNormalization
 */
function mapFuzzyPendingInferredIntent(fuzzyTurnNormalization) {
  const intent = inferCatalogQuestionIntent(fuzzyTurnNormalization);
  if (intent === "availability") return "availability_check";
  if (
    intent === "price" ||
    intent === "price_daily" ||
    intent === "price_monthly"
  ) {
    return "pricing_question";
  }
  return "general_item_question";
}

function isPureAckMessage(message) {
  const raw = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 28) return false;
  if (/^👍[\u{1f3fb}-\u{1f3ff}]?$/u.test(raw)) return true;
  const text = normalizeReplyIntentText(raw);
  if (!text) return false;
  const stripped = text
    .replace(/^[^\p{L}\d]+/u, "")
    .replace(/[!?.…]+$/gu, "")
    .trim();
  const normalized = normalizeAffirmationReplyToken(stripped);
  return /^(?:yes|yep|yeah|han|haan|ji|jee|ok|okay|theek|thik|sure|done)$/iu.test(normalized);
}

function buildPureAckNoOpReply(conversationStyle) {
  return conversationStyle === "casual_local" ? "Theek hai 👍" : "Ok 👍";
}

const ASSISTANT_OUTBOUND_KIND = Object.freeze({
  TERMINAL_INFO: "terminal_info",
  ACTIONABLE_PROMPT: "actionable_prompt",
  QUESTION: "question",
  UNKNOWN: "unknown",
});

/**
 * @param {boolean} hasUsefulBusinessData
 * @param {Record<string, unknown> | null | undefined} outboundTrace
 */
function messageMetaWithOutboundTrace(hasUsefulBusinessData, outboundTrace) {
  const base = messageMetaForKnowledge(hasUsefulBusinessData);
  if (!outboundTrace || typeof outboundTrace !== "object") return base;
  return { ...base, outboundTrace };
}

/**
 * Structured metadata for intentional no-outbound handling (e.g. pure ack after terminal info).
 * @param {boolean} hasUsefulBusinessData
 */
function buildIntentionalSilentNoopMessageMeta(hasUsefulBusinessData) {
  return {
    ...messageMetaWithOutboundTrace(hasUsefulBusinessData, {
      finalReplySource: "PURE_ACK_SILENT",
      kind: "silent_noop",
    }),
    handledWithoutOutbound: true,
  };
}

function buildOutboundTrace({
  kind = ASSISTANT_OUTBOUND_KIND.UNKNOWN,
  finalReplySource = null,
  routeType = null,
  responsePolicy = null,
  askedField = null,
  pendingActionTypeStored = null,
  collectDurationPrompt = false,
  composedAnswerSource = null,
  bookingBlocked = false,
} = {}) {
  const trace = {
    kind: String(kind ?? ASSISTANT_OUTBOUND_KIND.UNKNOWN).trim() || ASSISTANT_OUTBOUND_KIND.UNKNOWN,
    finalReplySource: finalReplySource != null ? String(finalReplySource).trim() || null : null,
    routeType: routeType != null ? String(routeType).trim() || null : null,
    responsePolicy: responsePolicy != null ? String(responsePolicy).trim() || null : null,
    askedField: askedField != null ? String(askedField).trim() || null : null,
    pendingActionTypeStored:
      pendingActionTypeStored != null ? String(pendingActionTypeStored).trim() || null : null,
    collectDurationPrompt: collectDurationPrompt === true,
    composedAnswerSource:
      composedAnswerSource != null ? String(composedAnswerSource).trim() || null : null,
    bookingBlocked: bookingBlocked === true,
    createdAtMs: Date.now(),
  };
  trace.kind = classifyAssistantOutboundKind(trace);
  return trace;
}

function classifyAssistantOutboundKind(trace = {}) {
  const finalReplySource = String(trace.finalReplySource ?? "").trim();
  if (trace.collectDurationPrompt === true) {
    return ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT;
  }
  if (trace.pendingActionTypeStored) {
    return ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT;
  }
  if (trace.bookingBlocked === true) {
    return ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
  }
  const composedSource = String(trace.composedAnswerSource ?? "").trim();
  if (composedSource === "verified_catalog" || composedSource === "llm_draft_grounded") {
    return ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
  }
  const terminalSources = new Set([
    "FUZZY_CATALOG_CONFIRMED_PRICING",
    "FUZZY_CATALOG_CONFIRMED_AVAILABILITY",
    "FUZZY_CATALOG_CONFIRMED_GENERAL",
    "VERIFIED_CATALOG",
    "INFORMATIONAL_COMPOSER",
    "AVAILABILITY_TIMING_UNKNOWN",
    "BOOKING_BLOCKED_AVAILABILITY_CHECK",
    "UNAVAILABLE_REPLY",
  ]);
  if (terminalSources.has(finalReplySource)) {
    return ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
  }
  const actionableSources = new Set([
    "COLLECT_DURATION_REASK",
    "COLLECT_DURATION_PROMPT",
    "ASK_CONTACT",
    "AVAILABILITY_AVAILABLE_ASK_DURATION",
    "BELOW_MINIMUM_BOOKING_OFFER",
    "FUZZY_CATALOG_CONFIRMATION",
    "CONFIRM_FUZZY_CATALOG",
  ]);
  if (actionableSources.has(finalReplySource)) {
    return ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT;
  }
  if (String(trace.responsePolicy ?? "").trim() === "answer_requested_field") {
    return ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
  }
  if (finalReplySource === "PHRASE_ENGINE") {
    return trace.askedField === "duration" || trace.collectDurationPrompt
      ? ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT
      : ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
  }
  if (
    finalReplySource === "AI_CONVERSATION_ROUTER" ||
    finalReplySource === "AI_GENERAL"
  ) {
    if (String(trace.routeType ?? "").trim() === "INFORMATIONAL_QUESTION") {
      return ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO;
    }
    return ASSISTANT_OUTBOUND_KIND.UNKNOWN;
  }
  return ASSISTANT_OUTBOUND_KIND.UNKNOWN;
}

function recordLastAssistantOutbound(memory, outboundTrace) {
  if (!memory || typeof memory !== "object" || !outboundTrace) return;
  memory.lastAssistantOutbound = outboundTrace;
}

function wasPreviousAssistantTurnTerminalInfo(memory) {
  const prior = memory?.lastAssistantOutbound;
  return (
    prior &&
    typeof prior === "object" &&
    String(prior.kind ?? "").trim() === ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO
  );
}

function buildCollectDurationReaskReply(pendingAction, conversationStyle = "casual_local") {
  const fromPrompt = String(pendingAction?.sourcePromptText ?? "").trim();
  if (fromPrompt) return fromPrompt;
  const label = String(pendingAction?.itemDisplayLabel ?? "").trim();
  if (conversationStyle === "casual_local") {
    return label
      ? `${label} ke liye kitne din chahiye?`
      : "Kitne din ke liye chahiye?";
  }
  return label
    ? `For how many days would you like the ${label}?`
    : "For how many days would you like it?";
}

function resolvePureAckNoOutbound({ memory, conversationStyle = "casual_local" }) {
  if (wasPreviousAssistantTurnTerminalInfo(memory)) {
    return { type: "silent" };
  }
  return {
    type: "verbal",
    reply: buildPureAckNoOpReply(conversationStyle),
  };
}

function canResolvePureAckWithoutConsumablePending(memory, message, bindingCtx) {
  if (!memory?.pendingAction) return true;
  const replyIntent = inferPendingActionReplyIntent(message, { pendingAction: memory.pendingAction });
  const validation = validatePendingActionBinding({
    pendingAction: memory.pendingAction,
    replyIntent,
    ...bindingCtx,
  });
  if (validation.ok) return false;
  if (validation.clear) return true;
  const nonBlocking = new Set([
    "PARTICIPANT_MISMATCH",
    "GROUP_CHAT_MISMATCH",
    "SESSION_MISMATCH",
  ]);
  if (nonBlocking.has(String(validation.reason ?? "").trim())) return true;
  return false;
}

function deriveOutboundTraceFromMessageMeta(messageMeta, finalReplySource = null) {
  if (messageMeta?.outboundTrace && typeof messageMeta.outboundTrace === "object") {
    return messageMeta.outboundTrace;
  }
  return buildOutboundTrace({
    finalReplySource,
    routeType: messageMeta?.routeType ?? null,
    responsePolicy: messageMeta?.responsePolicy ?? null,
    askedField: messageMeta?.askedField ?? null,
    pendingActionTypeStored: messageMeta?.pendingActionType ?? null,
    collectDurationPrompt:
      String(messageMeta?.pendingActionType ?? "").trim() ===
      PENDING_ACTION_TYPES.COLLECT_DURATION,
    composedAnswerSource: messageMeta?.composedAnswerSource ?? null,
    bookingBlocked: messageMeta?.bookingBlocked === true,
  });
}

function isSpecificInformationalItemSelectionQuestion(message) {
  const lower = String(message ?? "").toLowerCase();
  if (!lower.trim()) return false;
  return /\b(price|pricing|rate|rates|rent|rental|charges?|cost|amount|quote|quotation|kitna|kitni|kitne|colou?r|condition|halat|haalat|photo|photos|pic|pics|picture|pictures|image|images|details?|detail|model|variant|version|info|information|mileage|milage|feature|features|spec|specs)\b/i.test(
    lower
  );
}

function collectDurationSelectionGuardDecision({
  message = "",
  item = null,
  route = "",
  isAlternativeContext = false,
  hasParticipantSession = false,
  hasDurationSignal = false,
  isContactMessage = false,
  isAvailabilityQuestion = false,
} = {}) {
  const itemId = normalizeId(item?.itemId ?? item?.id);
  const itemDisplayLabel =
    String(item?.name ?? "").trim() ||
    String(item?.displayLabel ?? "").trim() ||
    buildDisplayLabel(item && typeof item === "object" ? item : {});
  const availabilityStatus =
    item && typeof item === "object" && item.isAvailable === false
      ? "unavailable"
      : item && typeof item === "object" && item.isAvailable === true
        ? "available"
        : "unknown";
  const latestUserSegmentForCollectDurationGuard =
    getLatestUserSegmentForGuard(message);
  const isInformationalQuestion =
    isExplicitPricingOrDetailsQuestion(message) ||
    detectShowImagesRequest(message) ||
    isInformationalItemQuestion(latestUserSegmentForCollectDurationGuard) ||
    isSpecificInformationalItemSelectionQuestion(
      latestUserSegmentForCollectDurationGuard
    );
  const base = {
    itemId: itemId || null,
    itemDisplayLabel: itemDisplayLabel || null,
    route: String(route ?? "").trim() || null,
    hasStableItemId: Boolean(itemId),
    hasAvailability: availabilityStatus !== "unknown",
    availabilityStatus,
    isAlternativeContext: Boolean(isAlternativeContext),
    isInformationalQuestion: Boolean(isInformationalQuestion),
    hasParticipantSession: Boolean(hasParticipantSession),
  };
  if (!item || typeof item !== "object") {
    return { ok: false, reason: "NO_VERIFIED_CURRENT_TURN_ITEM", ...base };
  }
  if (!itemId) return { ok: false, reason: "MISSING_ITEM_ID", ...base };
  if (!itemDisplayLabel) return { ok: false, reason: "MISSING_ITEM_LABEL", ...base };
  if (!isAlternativeContext) {
    return { ok: false, reason: "NO_ALTERNATIVE_CONTEXT", ...base };
  }
  if (!hasParticipantSession) {
    return { ok: false, reason: "MISSING_PARTICIPANT_SESSION", ...base };
  }
  if (isInformationalQuestion) {
    return { ok: false, reason: "INFORMATIONAL_QUESTION", ...base };
  }
  if (hasDurationSignal) {
    return { ok: false, reason: "MESSAGE_ALREADY_HAS_DURATION", ...base };
  }
  if (isContactMessage) {
    return { ok: false, reason: "CONTACT_MESSAGE", ...base };
  }
  if (isAvailabilityQuestion) {
    return { ok: false, reason: "AVAILABILITY_QUESTION", ...base };
  }
  if (availabilityStatus === "unavailable") {
    return { ok: false, reason: "ITEM_UNAVAILABLE", ...base };
  }
  if (availabilityStatus !== "available") {
    return { ok: false, reason: "AVAILABILITY_UNKNOWN", ...base };
  }
  return { ok: true, reason: "OK", ...base };
}

const pendingActionHandlers = Object.freeze({
  [PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER]: {
    expectedReplyType: "affirmation",
    validate: (pendingAction) =>
      validateAcceptShortBookingOfferPayload({
        ...(pendingAction?.payload && typeof pendingAction.payload === "object"
          ? pendingAction.payload
          : {}),
        itemId: pendingAction?.itemId,
      }),
  },
  [PENDING_ACTION_TYPES.COLLECT_DURATION]: {
    expectedReplyType: "duration",
    validate: validateCollectDurationPayload,
  },
  [PENDING_ACTION_TYPES.CONFIRM_FUZZY_CATALOG]: {
    expectedReplyType: "affirmation",
    validate: validateConfirmFuzzyCatalogPayload,
  },
  [PENDING_ACTION_TYPES.SHOW_ALTERNATIVE_OPTIONS]: {
    expectedReplyType: "affirmation",
    validate: () => ({ ok: false, reason: "ACTION_NOT_WIRED" }),
  },
  [PENDING_ACTION_TYPES.SEND_ITEM_PHOTOS]: {
    expectedReplyType: "affirmation",
    validate: () => ({ ok: false, reason: "ACTION_NOT_WIRED" }),
  },
  [PENDING_ACTION_TYPES.SELECT_ITEM_OPTION]: {
    expectedReplyType: "item_selection",
    validate: () => ({ ok: false, reason: "ACTION_NOT_WIRED" }),
  },
  [PENDING_ACTION_TYPES.CONFIRM_BOOKING_REQUEST]: {
    expectedReplyType: "affirmation",
    validate: () => ({ ok: false, reason: "ACTION_NOT_WIRED" }),
  },
  [PENDING_ACTION_TYPES.COLLECT_DELIVERY_METHOD]: {
    expectedReplyType: "delivery_method",
    validate: () => ({ ok: false, reason: "ACTION_NOT_WIRED" }),
  },
});

function validatePendingActionBinding({
  pendingAction,
  replyIntent,
  participantKey,
  groupChatKey,
  sessionKey,
  nowMs = Date.now(),
} = {}) {
  if (!pendingAction || typeof pendingAction !== "object") {
    return { ok: false, reason: "NO_PENDING_ACTION" };
  }
  if (String(pendingAction.status ?? "") !== PENDING_ACTION_STATUS_AWAITING) {
    return { ok: false, reason: "PENDING_ACTION_NOT_AWAITING" };
  }
  if (pendingActionIsExpired(pendingAction, nowMs)) {
    return { ok: false, reason: "PENDING_ACTION_EXPIRED", clear: true };
  }
  const currentParticipantKey = String(participantKey ?? "").trim();
  const pendingParticipantKey = String(pendingAction.participantKey ?? "").trim();
  if (pendingParticipantKey && currentParticipantKey !== pendingParticipantKey) {
    return { ok: false, reason: "PARTICIPANT_MISMATCH" };
  }
  const currentGroupChatKey = String(groupChatKey ?? "").trim();
  const pendingGroupChatKey = String(pendingAction.groupChatKey ?? "").trim();
  if (pendingGroupChatKey && currentGroupChatKey !== pendingGroupChatKey) {
    return { ok: false, reason: "GROUP_CHAT_MISMATCH" };
  }
  const currentSessionKey = String(sessionKey ?? "").trim();
  const pendingSessionKey = String(pendingAction.sessionKey ?? "").trim();
  if (pendingSessionKey && currentSessionKey !== pendingSessionKey) {
    return { ok: false, reason: "SESSION_MISMATCH" };
  }
  if (replyIntent?.explicitNewIntent === true || replyIntent?.type === "new_request") {
    return { ok: false, reason: "EXPLICIT_NEW_INTENT", clear: true };
  }
  if (replyIntent?.type === "rejection") {
    return { ok: false, reason: "REJECTION", clear: true, rejected: true };
  }
  const handler = pendingActionHandlers[pendingAction.type];
  if (!handler) return { ok: false, reason: "UNKNOWN_ACTION_TYPE", clear: true };
  const expectedReplyType =
    String(pendingAction.expectedReplyType ?? "").trim() ||
    String(handler.expectedReplyType ?? "").trim();
  if (replyIntent?.type !== expectedReplyType) {
    return { ok: false, reason: "REPLY_INTENT_MISMATCH" };
  }
  const payloadValidation = handler.validate(pendingAction);
  if (!payloadValidation.ok) {
    return { ok: false, reason: payloadValidation.reason || "INVALID_PAYLOAD", clear: true };
  }
  return { ok: true, handler };
}

function isValidContactValue(contact) {
  return (
    typeof contact === "string" &&
    /^[0-9+\-\s]{8,15}$/.test(contact.trim())
  );
}

function extractBookingContactParts(rawText) {
  const text = String(rawText || "").trim();
  const phoneMatch = text.match(/(?:\+92|0092|92|0)?3[\d\s-]{9,14}/);

  if (!phoneMatch) {
    return {
      rawText: text,
      phone: null,
      normalizedPhone: null,
      name: null,
      isValid: false,
    };
  }

  const rawPhone = phoneMatch[0];
  let normalizedPhone = rawPhone.replace(/[^\d+]/g, "");

  if (normalizedPhone.startsWith("0092")) {
    normalizedPhone = `+92${normalizedPhone.slice(4)}`;
  }

  if (normalizedPhone.startsWith("92")) {
    normalizedPhone = `+92${normalizedPhone.slice(2)}`;
  }

  const digitCount = normalizedPhone.replace(/\D/g, "").length;
  const isValid = digitCount >= 10 && digitCount <= 13;

  const name = text
    .replace(rawPhone, "")
    .replace(/[-–—:|,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    rawText: text,
    phone: rawPhone,
    normalizedPhone,
    name: name || null,
    isValid,
  };
}

function logContactParse(parts) {
  const normalized = String(parts?.normalizedPhone ?? "");
  const digits = normalized.replace(/\D/g, "");
  console.log("[contact_parse]", {
    rawTextPreview: String(parts?.rawText ?? "").slice(0, 40),
    extractedPhone: Boolean(parts?.phone),
    extractedName: Boolean(parts?.name),
    normalizedPhoneLast4: digits ? digits.slice(-4) : null,
    isValid: Boolean(parts?.isValid),
  });
}

function bookingErrorCode(result) {
  return String(result?.code ?? result?.error ?? "").trim();
}

function extractYearFromName(name) {
  const match = String(name ?? "").match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

/**
 * Hybrid Playwright group vs Cloud API DM routing on the outbound result.
 * @param {{ reply: unknown, type?: string, messageMeta?: Record<string, unknown> }} result
 * @param {{ isGroupInbound: boolean, message: string, participantPhoneForDm?: string | null, playwrightWebInbound?: boolean }} routingCtx
 * @param {"GROUP" | "DM" | null | undefined} [aiStructuredMode] - from generateReply when model emits \`__ROUTE__:\`
 */
function applyHybridOutboundResult(result, routingCtx, aiStructuredMode) {
  const flowId = String(routingCtx?.flowId ?? "").trim() || null;
  const rawReply = String(result?.reply ?? "");

  const scrubGroupReply = (text) => {
    const t = String(text ?? "");
    if (!t.trim()) return t;
    const blocked = isPrivateDetailPromptText(t);
    if (!blocked) return t;
    const diagnostics = groupPrivateDetailBlockDiagnostics(t);
    const replacement = buildGroupSafetyReplacementReply({
      inboundMessage: routingCtx?.message,
      result,
      businessProfile: routingCtx?.businessProfile,
    });
    console.warn("[group_reply_safety_scrubbed]", {
      ...(flowId ? { flowId } : {}),
      messagePreview: String(routingCtx?.message ?? "").slice(0, 160) || null,
      originalReplyPreview: t.slice(0, 160),
    });
    console.warn("[group_private_detail_prompt_blocked]", {
      ...(flowId ? { traceId: flowId } : {}),
      bookingId: result?.messageMeta?.bookingId ?? null,
      groupName: routingCtx?.groupName ?? null,
      chatKey: routingCtx?.chatKey ?? null,
      stage: result?.messageMeta?.stage ?? result?.messageMeta?.approvalStage ?? null,
      route: result?.type ?? null,
      originalReplyPreview: t.slice(0, 160),
      replacementReplyPreview: replacement,
      reason: "PRIVATE_DETAIL_PROMPT_IN_GROUP",
      isGroupInbound: routingCtx?.isGroupInbound === true,
      isGroupMessage: routingCtx?.isGroupMessage === true || routingCtx?.isGroupInbound === true,
    });
    console.warn("[group_private_detail_prompt_blocked_final]", {
      originalFinalTextPreview: t.slice(0, 160),
      replacementTextPreview: replacement.slice(0, 160),
      containsPhonePattern: diagnostics.containsPhonePattern,
      containsContactConfirmation: diagnostics.containsContactConfirmation,
      isGroupMessage: routingCtx?.isGroupMessage === true || routingCtx?.isGroupInbound === true,
      isGroupInbound: routingCtx?.isGroupInbound === true,
      replyMode: plan?.replyMode ?? null,
      sendVia: plan?.sendVia ?? null,
    });
    console.warn("[GROUP_SAFETY]", {
      ...(flowId ? { flowId } : {}),
      action: "scrubbed",
      reason: "BLOCKED_GROUP_PRIVATE_DETAIL_PROMPT",
    });
    return replacement;
  };

  const plan = planGroupHybridDelivery({
    isGroupInbound: routingCtx.isGroupInbound,
    replyText: result.reply,
    messageMeta: result.messageMeta,
    inboundMessage: routingCtx.message,
    participantPhoneForDm:
      routingCtx.participantPhoneForDm != null &&
      String(routingCtx.participantPhoneForDm).trim() !== ""
        ? String(routingCtx.participantPhoneForDm).trim()
        : null,
    aiStructuredMode,
  });
  const replyMerged =
    plan.fallbackReply != null && String(plan.fallbackReply).trim() !== ""
      ? String(plan.fallbackReply).trim()
      : result.reply;
  const hasGroupContext = Boolean(
    routingCtx?.isGroupInbound === true ||
      routingCtx?.isGroupMessage === true ||
      String(routingCtx?.whatsappRecipientType ?? "").toLowerCase() === "group" ||
      String(routingCtx?.groupName ?? "").trim() ||
      String(routingCtx?.chatKey ?? routingCtx?.playwrightChatKey ?? "").trim()
  );
  const isGroupOutbound = Boolean(
    hasGroupContext &&
      (plan.replyMode === "GROUP" ||
        String(routingCtx?.whatsappRecipientType ?? "").toLowerCase() === "group" ||
        (plan.sendVia === "PLAYWRIGHT" && routingCtx?.isGroupInbound === true))
  );
  const replyFinal =
    isGroupOutbound ? scrubGroupReply(replyMerged) : replyMerged;
  const sessionKeyForOutbound = String(routingCtx?.emilySessionKey ?? "").trim();
  const finalReplySourceForTrace = String(
    result?.messageMeta?.outboundTrace?.finalReplySource ??
      routingCtx?.outboundFinalReplySource ??
      ""
  ).trim();

  if (
    plan.sendVia === "NONE" ||
    String(result?.sendVia ?? "").trim().toUpperCase() === "NONE"
  ) {
    console.log("[OUTBOUND_SEND]", {
      ...(flowId ? { flowId } : {}),
      sendVia: "NONE",
      replyChars: 0,
      replyMode: plan.replyMode ?? null,
    });
    return {
      ...result,
      reply: "",
      sendVia: "NONE",
      dmRecipientPhone: undefined,
      replyMode: plan.replyMode ?? undefined,
    };
  }
  if (sessionKeyForOutbound && String(replyFinal ?? "").trim()) {
    const outboundTrace = deriveOutboundTraceFromMessageMeta(
      result?.messageMeta,
      finalReplySourceForTrace || null
    );
    recordLastAssistantOutbound(getEmilySessionState(sessionKeyForOutbound), outboundTrace);
    console.log("[assistant_outbound_context_recorded]", {
      sessionKey: sessionKeyForOutbound,
      kind: outboundTrace.kind,
      finalReplySource: outboundTrace.finalReplySource,
      routeType: outboundTrace.routeType,
    });
  }
  console.log("[OUTBOUND_SEND]", {
    ...(flowId ? { flowId } : {}),
    sendVia: plan.sendVia,
    replyChars: String(replyFinal ?? "").length,
    dmRecipientPhoneLast4:
      plan.dmRecipientPhone != null ? String(plan.dmRecipientPhone).replace(/\D/g, "").slice(-4) : null,
    replyMode: plan.replyMode ?? null,
  });
  return {
    ...result,
    reply: replyFinal,
    sendVia: plan.sendVia,
    dmRecipientPhone: plan.dmRecipientPhone ?? undefined,
    replyMode: plan.replyMode ?? undefined,
  };
}

/** Playwright group lines: `[senderName] body` */
function splitPlaywrightInbound(combinedMessage) {
  const raw = String(combinedMessage ?? "").trim();
  const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(raw);
  if (!m) return { senderName: null, body: raw };
  return { senderName: m[1].trim(), body: m[2].trim() };
}

/**
 * From merged inbound (e.g. WhatsApp buffer `a | b` or group lines), keep up to the last two
 * non-self segments for the model (preserves short follow-ups like price → duration).
 * @param {string | undefined | null} rawMessage
 * @returns {string | null}
 */
function selectLatestInboundForAi(rawMessage) {
  const raw = String(rawMessage ?? "").trim();
  if (!raw) return null;

  const segments = raw.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const cleanMessages = segments.filter((text) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    if (lower.startsWith("[me]")) return false;
    if (/added|joined|left|created group/i.test(text)) return false;
    return true;
  });

  const parsed = cleanMessages.map((text, index) => {
    const { senderName } = splitPlaywrightInbound(text);
    const sender = String(senderName ?? "").trim().toLowerCase();
    return { text, sender, timestamp: index };
  });

  const validSegments = parsed.filter((m) => m.sender !== "me");
  if (validSegments.length === 0) return null;

  // Keep minimal short-term context in chronological order.
  const lastTwo = validSegments.slice(-2);
  return lastTwo
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((m) => m.text.replace(/^\[.*?\]\s*/, ""))
    .join(" | ");
}

/**
 * Last non-empty segment from buffer-style merged inbound (`a | b`), else full text.
 * Used only for collect_duration availability guard so a prior "…available…" segment
 * does not false-positive on the latest bare item token (e.g. "stonic?").
 * @param {unknown} message
 */
function getLatestUserSegmentForGuard(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return "";
  const segments = raw.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : raw;
}

/** Strip `[Sender] body` prefix used in Playwright group lines (collect_duration path only). */
function stripPlaywrightBracketSenderPrefix(text) {
  return String(text ?? "").replace(/^\[[^\]]+\]\s*/, "").trim();
}

/**
 * Bare catalog token for collect_duration resolver only: trim, collapse spaces, strip trailing
 * punctuation (ASCII + Arabic/comma/fullwidth marks). No business-specific tokens.
 * @param {unknown} segment
 */
function normalizeBareCatalogSelectionQuery(segment) {
  let s = stripPlaywrightBracketSenderPrefix(String(segment ?? "").replace(/\s+/g, " ").trim());
  if (!s) return "";
  const trailingPunct = /[\s\u00a0\u200c\u200d\uFEFF]*(?:[!?.…,;:،؛'"()[\]{}]|؟|｡|。|，|．|・|？|！)+$/gu;
  let guard = 0;
  let prev;
  do {
    prev = s;
    s = s.replace(trailingPunct, "").trim();
    guard += 1;
  } while (s !== prev && guard < 24);
  return s;
}

/**
 * Resolver input for collect_duration verified selection: latest `|`-segment, bracket prefix,
 * then bare-token punctuation normalization (not the merged multi-segment string).
 * @param {unknown} message
 */
function computeCollectDurationCatalogQuery(message) {
  const latest = getLatestUserSegmentForGuard(message);
  return normalizeBareCatalogSelectionQuery(latest);
}

/**
 * Availability-as-question for collect_duration guard only (latest segment + detectIntent).
 * Intentionally does not reuse global classifier/intent merged across buffer segments.
 * @param {unknown} message
 */
function isAvailabilityQuestionForCollectDurationGuard(message) {
  const latest = getLatestUserSegmentForGuard(message);
  if (!latest) return false;
  return (
    detectIntent(latest) === "availability" ||
    /\b(avail|available|availability)\b/i.test(latest)
  );
}

/**
 * Bare catalog token turn (no price/color/photo/detail question) — used to avoid model-template
 * composer fallback after an options / specific-option assistant prompt.
 */
function isBareCatalogSelectionMessageShapeForComposer(message) {
  const latest = getLatestUserSegmentForGuard(message);
  if (!String(latest ?? "").trim()) return false;
  const q = computeCollectDurationCatalogQuery(message);
  if (q.length < 2 || q.length > 48) return false;
  if (isExplicitPricingOrDetailsQuestion(message)) return false;
  if (isExplicitPricingOrDetailsQuestion(latest)) return false;
  if (detectShowImagesRequest(message)) return false;
  if (isInformationalItemQuestion(latest)) return false;
  if (isAvailabilityQuestionForCollectDurationGuard(message)) return false;
  if (isSpecificInformationalItemSelectionQuestion(latest)) return false;
  return true;
}

/**
 * Booking FSM customer replies: tone guard + polish, then force single line for WA Web compose
 * (embedded newlines can send as separate bubbles).
 * @param {unknown} text
 */
function finalizeBookingFsmCustomerReply(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const guarded = applyToneGuard(raw);
  const polished = polishWhatsAppBusinessTone(String(guarded ?? ""));
  return String(polished ?? guarded ?? raw)
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Max User/Assistant lines embedded into the model user payload (small window). */
const MAX_AI_CONVERSATION_TAIL_LINES = 4;

/**
 * Last `User:` / `Assistant:` lines from a Firestore- or memory-style transcript block.
 * Drops a trailing `User:` line that duplicates the current inbound text (avoids duplicate with `User: …` below).
 *
 * @param {string} block
 * @param {string} currentUserMessage
 * @returns {string[]}
 */
function extractTailConversationLinesForAi(block, currentUserMessage) {
  const cur = String(currentUserMessage ?? "").trim();
  const lines = String(block ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /^User:\s*/i.test(l) || /^Assistant:\s*/i.test(l));
  let tail = lines.slice(-MAX_AI_CONVERSATION_TAIL_LINES);
  if (cur && tail.length > 0) {
    const last = tail[tail.length - 1];
    const um = /^User:\s*(.*)$/i.exec(last);
    if (um && um[1].trim() === cur) {
      tail = tail.slice(0, -1);
    }
  }
  return tail;
}

/**
 * Structured user payload: short recent thread + optional item line + current user + decision context.
 * @param {{
 *   historyText: string,
 *   currentMessage: string,
 *   lastItemMentioned: unknown,
 *   contextLabel: string,
 *   lastFocusedItemStr: string,
 *   durationForEnriched: string,
 *   detectedIntent: string,
 *   missingContext: string,
 * }} p
 * @returns {{ payload: string, tailEmbedded: boolean }}
 */
function buildStructuredAiUserPayload(p) {
  const cur = String(p.currentMessage ?? "").trim();
  const tail = extractTailConversationLinesForAi(p.historyText, cur);

  const conv =
    tail.length > 0
      ? `Conversation so far:\n${tail
          .map((l) => {
            const u = /^User:\s*(.*)$/i.exec(l);
            if (u) return `user: ${u[1].trim()}`;
            const a = /^Assistant:\s*(.*)$/i.exec(l);
            if (a) return `assistant: ${a[1].trim()}`;
            return l;
          })
          .join("\n")}\n\n`
      : "";

  const lastRaw =
    p.lastItemMentioned != null ? String(p.lastItemMentioned).trim() : "";
  const itemLine =
    lastRaw.length > 0
      ? `Current item being discussed: ${lastRaw}\n\n`
      : "";

  const ctx = `Context:
- Current ${p.contextLabel}: ${p.lastFocusedItemStr || "unknown"}
- Duration: ${p.durationForEnriched}
- Intent: ${p.detectedIntent}
- Missing: ${p.missingContext}`;

  const payload = `${conv}${itemLine}User: ${cur}

${ctx}

Respond naturally and helpfully based on the conversation.`.trim();

  return { payload, tailEmbedded: tail.length > 0 };
}

/**
 * User turns for lightweight guards: `User:` lines from history + current inbound.
 * @param {string} historyStr
 * @param {string} combinedMessage
 * @returns {{ text: string, senderName: string | null }[]}
 */
function buildGuardMessages(historyStr, combinedMessage) {
  const snippets = [];
  for (const line of String(historyStr ?? "").split("\n")) {
    const trimmed = line.trim();
    const um = /^User:\s*(.*)$/i.exec(trimmed);
    if (um) {
      const t = um[1].trim();
      if (t) {
        const { senderName } = splitPlaywrightInbound(t);
        snippets.push({ text: t, senderName });
      }
    }
  }
  const cur = String(combinedMessage ?? "").trim();
  if (cur) {
    const { senderName } = splitPlaywrightInbound(cur);
    snippets.push({ text: cur, senderName });
  }
  return snippets;
}

/**
 * Pricing, availability, or duration — treat as a real customer query (do not skip AI).
 * @param {string | null | undefined} raw
 */
function hasPricingAvailabilityDurationIntent(raw) {
  const t = String(raw ?? "").toLowerCase();
  if (t.trim().length < 2) return false;

  if (
    /\b(charge|charges|charging|priced|pricing|price|prices|cost|costs|fee|fees|rate|rates|quote|quotation|kitna)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(available|availability|book|booking|booked|reserve|reservation)\b/.test(t)
  ) {
    return true;
  }
  if (
    /\b(\d+\s*(hour|hours|hr|hrs|day|days|minute|minutes|min|week|weeks))\b/.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(duration|per\s+hour|per\s+day|half\s+day|how\s+long)\b/.test(t)) {
    return true;
  }
  if (/\b(item|items|option|options|service|services|product|products)\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * Pull image URLs from AI raw text (markdown or plain URL).
 * @param {string | null | undefined} raw
 * @returns {string[]}
 */
function extractImageUrlsFromAiReply(raw) {
  const text = String(raw ?? "");
  if (!text) return [];

  const urls = [];
  const mdRegex = /!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/gi;
  const plainRegex = /https?:\/\/[^\s)]+/gi;

  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    const u = String(match[1] ?? "").trim();
    if (u) urls.push(u);
  }
  while ((match = plainRegex.exec(text)) !== null) {
    const u = String(match[0] ?? "").trim();
    if (u) urls.push(u);
  }

  return Array.from(
    new Set(
      urls
        .map((u) => u.replace(/[)>.,!?]+$/g, "").trim())
        .filter((u) => /^https?:\/\//i.test(u))
    )
  ).slice(0, 5);
}

/**
 * @param {{ text?: string }[] | null | undefined} messages
 */
function isRelevantConversation(messages) {
  if (!messages || messages.length === 0) return false;

  const recent = messages.slice(-5).map((m) => (m.text || "").toLowerCase());

  const meaningful = recent.filter((t) => t.length > 3);

  if (meaningful.length === 0) return false;

  if (meaningful.some((t) => hasPricingAvailabilityDurationIntent(t))) {
    return true;
  }

  return meaningful.some(
    (t) =>
      t.includes("?") ||
      t.includes("rent") ||
      t.includes("available") ||
      t.includes("price") ||
      t.includes("charge") ||
      t.includes("kitna") ||
      t.includes("chahiye")
  );
}

/**
 * @param {string | undefined | null} combinedMessage
 * @param {{ text?: string, senderName?: string | null }[]} messages
 */
function shouldReply(combinedMessage, messages) {
  if (!combinedMessage) return false;

  const { body, senderName } = splitPlaywrightInbound(combinedMessage);
  const text = body.toLowerCase().trim();

  if (hasPricingAvailabilityDurationIntent(body)) return true;

  if (text.length < 5) return false;

  const ignoreList = ["ok", "hmm", "yes", "no", "👍", "done"];
  if (ignoreList.includes(text)) return false;

  const last = messages[messages.length - 1];
  if (String(last?.senderName ?? "").toLowerCase() === "me") return false;

  if (text.includes("?")) return true;

  if (
    text.includes("rent") ||
    text.includes("available") ||
    text.includes("price") ||
    text.includes("charge") ||
    text.includes("kitna") ||
    text.includes("chahiye")
  ) {
    return true;
  }

  return false;
}

/**
 * Short system caption for WhatsApp image delivery (no URLs, no model).
 * @param {string} displayLabel
 * @param {string} userLanguageStyle
 */
function buildShowImagesCaption(displayLabel, userLanguageStyle) {
  const L = String(displayLabel ?? "").trim() || "is";
  switch (userLanguageStyle) {
    case "en":
      return `Here are the photos of ${L} 👇`;
    case "ur-script":
      return `Yeh rahi ${L} ki images 👇`;
    default:
      return `Yeh rahi ${L} ki images 👇`;
  }
}

/**
 * Resolve most recently mentioned catalog item from conversation history.
 * Uses dynamic catalog rows (no hardcoded item names).
 * @param {{ history?: string | null | undefined, items?: unknown[] }} opts
 * @returns {{ name?: string, color?: string, displayLabel?: string } | null}
 */
function resolveRecentCatalogItemFromHistory({ history, items }) {
  const hist = normalizeText(String(history ?? ""));
  if (!hist) return null;
  const itemRows = Array.isArray(items) ? items : [];
  let best = null;
  let bestIndex = -1;
  for (const row of itemRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const vo = /** @type {Record<string, unknown>} */ (row);
    const name = String(vo.name ?? "").trim();
    if (!name) continue;
    const color = String(vo.color ?? "").trim();
    const displayLabel = color ? `${name} (${color})` : name;
    const aliases = [name, displayLabel]
      .map((s) => normalizeText(s))
      .filter(Boolean);
    let rowIdx = -1;
    for (const alias of aliases) {
      const idx = hist.lastIndexOf(alias);
      if (idx > rowIdx) rowIdx = idx;
    }
    if (rowIdx > bestIndex) {
      bestIndex = rowIdx;
      best = {
        name,
        ...(color ? { color } : {}),
        displayLabel,
      };
    }
  }
  return bestIndex >= 0 ? best : null;
}

/** @param {Record<string, unknown> | null | undefined} profile */
function resolveBusinessTone(profile) {
  const raw =
    profile?.profileData != null &&
    typeof profile.profileData === "object" &&
    typeof profile.profileData.tone === "string"
      ? profile.profileData.tone.trim().toLowerCase()
      : "";
  if (raw === "professional" || raw === "salesy" || raw === "friendly") {
    return raw;
  }
  return "friendly";
}

/** Only when there is no Firestore profile and no prior turns — generic, tone-aware. */
function minimalNoProfileFallbackReply(tone) {
  const messages = {
    friendly: "Hi! I'm here to help. What are you looking for?",
    professional: "Hello. I'm here to help — what are you looking for today?",
    salesy: "Hi! What can we help you find today?",
  };
  return messages[tone] ?? messages.friendly;
}

/**
 * Lightweight intent detector for better AI input shaping.
 * @param {string} message
 * @returns {"duration" | "pricing" | "availability" | "browse_options" | "list" | "exclude" | "general"}
 */
function detectIntent(message) {
  const raw = String(message ?? "").trim();
  const lower = raw.toLowerCase();
  if (isBrowseOptionsIntent(raw)) return "browse_options";
  if (/^\d+$/.test(raw)) return "duration";
  if (/\b(price|rate|cost|charges?|kitna|kitni|kitne)\b/i.test(lower)) return "pricing";
  if (/\b(available|hai\?)\b/i.test(lower)) return "availability";
  if (/\b(kon|which|items|options|products|services)\b/i.test(lower)) return "list";
  if (/\b(ilawa|other than)\b/i.test(lower)) return "exclude";
  return "general";
}

/**
 * Browse/list intent that must not promote a catalog row into booking focus.
 * @param {unknown} message
 */
function isBrowseOptionsIntent(message) {
  const text = String(message ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return false;
  return (
    /\b(?:or|aur)\s+(?:kon|kaun|kya)\s+(?:c\s+)?options?\b/i.test(text) ||
    /\b(?:kya\s+kya|kon\s+kon|kaun\s+kaun)\s+available\b/i.test(text) ||
    /\bshow\s+(?:me\s+)?(?:options|items|products|services)\b/i.test(text) ||
    /\bother\s+options?\b/i.test(text) ||
    /\b(?:aur|or)\s+dikhao\b/i.test(text) ||
    /\b(?:what\s+else|anything\s+else|any\s+other)\b/i.test(text) ||
    /\b(?:aur|or|koi\s+aur)\s+(?:kya|kon|kaun)\b/i.test(text) ||
    /\b(?:aur|or)\s+(?:kya)\s+available\b/i.test(text) ||
    /\b(?:koi\s+aur|dusra|doosra|another)\s+(?:option|options|item|items|product|products|service|services)\b/i.test(text)
  );
}

/**
 * @param {unknown} message
 */
function isBareDurationMessage(message) {
  const raw = String(message ?? "").trim();
  return /^(\d+)(?:\s*(?:day|days|din|dino|hour|hours|hr|hrs|ghanta|ghantay|ghanty|ghante|ghantey|ghnty|ghntay|ghnte|gnty|gntay|gnte|gantay|gante|gantey)(?:\s+\S+){0,3})?$/i.test(raw);
}

/**
 * Bare multi-day rent quote field (e.g. "3 day rent?", "3 din ka rent?").
 * @param {unknown} message
 * @returns {"price_with_duration" | null}
 */
function resolveItemlessPriceDurationAskedField(message) {
  const field = detectAskedField(message);
  if (field === "price_with_duration") return "price_with_duration";
  const dur = parseUserDuration(message);
  const hasDuration =
    dur != null && Number.isFinite(Number(dur.normalizedDays));
  if (
    hasDuration &&
    isBareDurationMessage(message) &&
    field === "price_daily" &&
    /\b(rent|rate|kiraya|kiraye|kitna|kitni|kitne|price)\b/i.test(String(message ?? ""))
  ) {
    return "price_with_duration";
  }
  return null;
}

function buildItemlessPriceDurationClarificationReply() {
  return ITEMLESS_PRICE_CLARIFICATION_REPLY;
}

/**
 * Itemless duration + rent/price quote — delegated to turn-level authority contract.
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 */
function isItemlessPriceDurationFollowup(message, catalogItems) {
  return isItemlessPriceDurationFollowupShape(message, catalogItems);
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 */
function memoryStageBlocksPriceDurationFollowup(memory) {
  const stage = String(memory?.stage ?? "").trim().toLowerCase();
  if (stage === "confirmed") return true;
  if (/^(?:browsing|browse|options?|select_item|item_selection)$/i.test(stage)) return true;
  return false;
}

/**
 * @param {string[]} recentAssistantReplies
 * @param {Record<string, unknown> | null | undefined} item
 */
function verifiedCatalogAnswerExpiryIso(nowMs = Date.now()) {
  return new Date(nowMs + LAST_VERIFIED_CATALOG_ANSWER_TTL_MS).toISOString();
}

/**
 * @param {unknown} field
 */
function normalizeVerifiedCatalogPricingRequestedField(field) {
  const f = String(field ?? "").trim().toLowerCase();
  if (f === "price_daily" || f === "price_monthly") return f;
  if (f === "price_with_duration") return "price_with_duration";
  if (f === "price" || /\bprice\b/.test(f)) return "price";
  return f || "price";
}

/**
 * @param {{
 *   composedAnswer: Record<string, unknown> | null | undefined,
 *   composerItem: Record<string, unknown> | null | undefined,
 *   conversationRoute?: { routeType?: string } | null,
 * }} p
 */
function shouldStoreLastVerifiedCatalogAnswer(p) {
  const composedAnswer = p.composedAnswer;
  const composerItem = p.composerItem;
  if (!composedAnswer || composedAnswer.finalAuthority !== true) return false;
  if (composedAnswer.answerKnown !== true) return false;
  const source = String(composedAnswer.source ?? "").trim();
  if (!TRUSTED_VERIFIED_CATALOG_ANSWER_SOURCES.has(source)) return false;
  const field = String(composedAnswer.field ?? "").trim().toLowerCase();
  if (!VERIFIED_CATALOG_PRICING_REQUESTED_FIELDS.has(field)) return false;
  if (composedAnswer.unknownHumanized === true) return false;
  if (composedAnswer.fieldMismatchBlocked === true) return false;
  const itemId = normalizeId(composerItem?.itemId ?? composerItem?.id);
  if (!itemId) return false;
  if (p.conversationRoute && !isInformationalRoute(p.conversationRoute)) return false;
  const reply = String(composedAnswer.reply ?? "").trim();
  if (!reply) return false;
  if (assistantReplySignalsCatalogSelectionPrompt(reply)) return false;
  if (/\b(kis option|which option|kaunsa option|kaun si option)\b/i.test(reply)) {
    return false;
  }
  if (/\brate confirm kar\b/i.test(reply)) return false;
  return true;
}

/**
 * @param {{
 *   memory: Record<string, unknown>,
 *   item: Record<string, unknown>,
 *   composedAnswer: Record<string, unknown>,
 *   requestedField?: string | null,
 *   participantKey?: string | null,
 *   chatContextKey?: string | null,
 *   sessionKey?: string | null,
 *   traceId?: string | null,
 *   nowMs?: number,
 * }} p
 */
function storeLastVerifiedCatalogAnswer(p) {
  const memory = p.memory;
  if (!memory || typeof memory !== "object") return null;
  const itemId = normalizeId(p.item?.itemId ?? p.item?.id);
  if (!itemId) return null;
  const itemDisplayLabel =
    buildDisplayLabel(p.item) ||
    String(p.item?.displayLabel ?? p.item?.name ?? "").trim() ||
    null;
  const nowMs = Number.isFinite(p.nowMs) ? Number(p.nowMs) : Date.now();
  const requestedField = normalizeVerifiedCatalogPricingRequestedField(
    p.requestedField ?? p.composedAnswer?.field
  );
  const ctx = {
    itemId,
    itemDisplayLabel,
    answerType: VERIFIED_CATALOG_PRICING_ANSWER_TYPE,
    requestedField,
    source: "verified_catalog",
    participantKey: String(p.participantKey ?? "").trim() || null,
    chatContextKey: String(p.chatContextKey ?? "").trim() || null,
    sessionKey: String(p.sessionKey ?? "").trim() || null,
    createdAt: pendingActionNowIso(nowMs),
    expiresAt: verifiedCatalogAnswerExpiryIso(nowMs),
  };
  memory.lastVerifiedCatalogAnswer = ctx;
  console.log("[verified_catalog_answer_context_stored]", {
    traceId: String(p.traceId ?? "").trim() || null,
    itemId,
    itemDisplayLabel,
    answerType: ctx.answerType,
    requestedField: ctx.requestedField,
    source: ctx.source,
    participantKey: ctx.participantKey,
    chatContextKey: ctx.chatContextKey,
    sessionKey: ctx.sessionKey,
    expiresAt: ctx.expiresAt,
  });
  return ctx;
}

/**
 * @param {{
 *   memory?: Record<string, unknown> | null,
 *   message: unknown,
 *   catalogItems: unknown[],
 *   participantKey?: string | null,
 *   chatContextKey?: string | null,
 *   sessionKey?: string | null,
 *   traceId?: string | null,
 *   nowMs?: number,
 * }} p
 */
function resolveLastVerifiedCatalogAnswerForPriceFollowup(p) {
  const memory = p.memory && typeof p.memory === "object" ? p.memory : null;
  const ctx =
    memory?.lastVerifiedCatalogAnswer &&
    typeof memory.lastVerifiedCatalogAnswer === "object"
      ? memory.lastVerifiedCatalogAnswer
      : null;
  const logReject = (reason, extra = {}) => {
    console.log("[price_duration_followup_context_rejected]", {
      traceId: String(p.traceId ?? "").trim() || null,
      reason,
      ...extra,
    });
    return { ok: false, reason, itemId: null, item: null };
  };
  if (!resolveItemlessPriceDurationAskedField(p.message)) {
    return logReject("NOT_PRICE_DURATION_FOLLOWUP");
  }
  if (!ctx) {
    return logReject("NO_LAST_VERIFIED_CATALOG_ANSWER");
  }
  const nowMs = Number.isFinite(p.nowMs) ? Number(p.nowMs) : Date.now();
  const expiresMs = Date.parse(String(ctx.expiresAt ?? ""));
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    return logReject("LAST_VERIFIED_CATALOG_ANSWER_EXPIRED", {
      expiresAt: ctx.expiresAt ?? null,
    });
  }
  const source = String(ctx.source ?? "").trim();
  if (!TRUSTED_VERIFIED_CATALOG_ANSWER_SOURCES.has(source)) {
    return logReject("UNTRUSTED_SOURCE", { source });
  }
  if (String(ctx.answerType ?? "").trim() !== VERIFIED_CATALOG_PRICING_ANSWER_TYPE) {
    return logReject("AMBIGUOUS_CONTEXT", { answerType: ctx.answerType ?? null });
  }
  const storedField = String(ctx.requestedField ?? "").trim().toLowerCase();
  if (!VERIFIED_CATALOG_PRICING_REQUESTED_FIELDS.has(storedField)) {
    return logReject("AMBIGUOUS_CONTEXT", { requestedField: storedField || null });
  }
  const currentParticipantKey = String(p.participantKey ?? "").trim();
  const storedParticipantKey = String(ctx.participantKey ?? "").trim();
  if (p.isGroupInbound === true) {
    if (!currentParticipantKey) {
      return logReject("MISSING_STABLE_PARTICIPANT_SESSION");
    }
    if (!storedParticipantKey || storedParticipantKey !== currentParticipantKey) {
      return logReject(
        storedParticipantKey ? "PARTICIPANT_MISMATCH" : "UNTRUSTED_STORED_PARTICIPANT",
        {
          participantKey: currentParticipantKey,
          storedParticipantKey: storedParticipantKey || null,
        }
      );
    }
  } else if (
    storedParticipantKey &&
    currentParticipantKey &&
    storedParticipantKey !== currentParticipantKey
  ) {
    return logReject("PARTICIPANT_MISMATCH", {
      participantKey: currentParticipantKey,
      storedParticipantKey,
    });
  }
  const currentSessionKey = String(p.sessionKey ?? "").trim();
  const storedSessionKey = String(ctx.sessionKey ?? "").trim();
  if (storedSessionKey && currentSessionKey && storedSessionKey !== currentSessionKey) {
    return logReject("SESSION_MISMATCH", {
      sessionKey: currentSessionKey,
      storedSessionKey,
    });
  }
  const currentChatContextKey = String(p.chatContextKey ?? "").trim();
  const storedChatContextKey = String(ctx.chatContextKey ?? "").trim();
  if (
    storedChatContextKey &&
    currentChatContextKey &&
    storedChatContextKey !== currentChatContextKey
  ) {
    return logReject("SESSION_MISMATCH", {
      chatContextKey: currentChatContextKey,
      storedChatContextKey,
    });
  }
  const itemId = normalizeId(ctx.itemId);
  if (!itemId) {
    return logReject("NO_LAST_VERIFIED_CATALOG_ANSWER");
  }
  const explicitNew = hasExplicitNewItemMention(p.message, p.catalogItems, itemId);
  if (explicitNew.found) {
    return logReject("EXPLICIT_NEW_ITEM_PRESENT", {
      itemId: explicitNew.itemId,
      itemLabel: explicitNew.itemLabel,
    });
  }
  const catalogItems = Array.isArray(p.catalogItems) ? p.catalogItems : [];
  const catalogRow = catalogItems.find(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      normalizeId(/** @type {Record<string, unknown>} */ (row).id) === itemId
  );
  if (!catalogRow || typeof catalogRow !== "object" || Array.isArray(catalogRow)) {
    return logReject("ITEM_NOT_IN_CATALOG", { itemId });
  }
  const row = /** @type {Record<string, unknown>} */ (catalogRow);
  const item = {
    ...row,
    id: itemId,
    itemId,
    displayLabel:
      String(ctx.itemDisplayLabel ?? "").trim() ||
      buildDisplayLabel(row) ||
      String(row.name ?? "").trim() ||
      null,
    name: String(row.name ?? ctx.itemDisplayLabel ?? "").trim() || null,
  };
  return { ok: true, reason: "LAST_VERIFIED_CATALOG_ANSWER", itemId, item, ctx };
}

function recentAssistantVerifiedPriceAnswerForItem(recentAssistantReplies, item) {
  const itemTokens = new Set();
  for (const part of [item?.displayLabel, item?.name]) {
    const norm = normalizeForContextMatch(part);
    for (const token of norm.split(/\s+/)) {
      if (token.length >= 4) itemTokens.add(token);
    }
  }
  const priceCue =
    /\b(per\s*day|per\s*month|pkr|\/day|daily|monthly|rent|rate|kiraya)\b/i;
  const replies = Array.isArray(recentAssistantReplies)
    ? recentAssistantReplies.slice(0, 4)
    : [];
  return replies.some((reply) => {
    const text = String(reply ?? "");
    if (!priceCue.test(text)) return false;
    if (itemTokens.size === 0) return true;
    const norm = normalizeForContextMatch(text);
    return [...itemTokens].some((token) => norm.includes(token));
  });
}

/**
 * @param {{
 *   memory?: Record<string, unknown> | null,
 *   recentAssistantReplies?: string[],
 *   message?: unknown,
 *   catalogItems?: unknown[],
 *   participantKey?: string | null,
 *   chatContextKey?: string | null,
 *   sessionKey?: string | null,
 *   traceId?: string | null,
 *   isGroupInbound?: boolean,
 * }} p
 */
function hasSafePreviousCatalogItemForPriceFollowup(p) {
  const memory = p.memory && typeof p.memory === "object" ? p.memory : null;
  if (memoryStageBlocksPriceDurationFollowup(memory)) {
    return {
      ok: false,
      reason: "STAGE_BLOCKED",
      itemId: normalizeId(memory?.lastItem?.id) || null,
      item: null,
      proofSource: null,
    };
  }
  if (memory?.pendingAction) {
    return {
      ok: false,
      reason: "PENDING_ACTION_ACTIVE",
      itemId: normalizeId(memory?.lastItem?.id) || null,
      item: null,
      proofSource: null,
    };
  }
  const structured = resolveLastVerifiedCatalogAnswerForPriceFollowup({
    memory,
    message: p.message,
    catalogItems: p.catalogItems ?? [],
    participantKey: p.participantKey,
    chatContextKey: p.chatContextKey,
    sessionKey: p.sessionKey,
    traceId: p.traceId,
    isGroupInbound: p.isGroupInbound === true,
  });
  if (structured.ok) {
    return {
      ok: true,
      reason: "LAST_VERIFIED_CATALOG_ANSWER",
      itemId: structured.itemId,
      item: structured.item,
      proofSource: "LAST_VERIFIED_CATALOG_ANSWER",
    };
  }
  const structuredRejectReason = structured.reason;
  if (
    structuredRejectReason &&
    structuredRejectReason !== "NO_LAST_VERIFIED_CATALOG_ANSWER"
  ) {
    return {
      ok: false,
      reason: structuredRejectReason,
      itemId: null,
      item: null,
      proofSource: null,
    };
  }
  const participantKey = String(p.participantKey ?? "").trim();
  if (p.isGroupInbound === true && !participantKey) {
    return {
      ok: false,
      reason: "MISSING_STABLE_PARTICIPANT_SESSION",
      itemId: null,
      item: null,
      proofSource: null,
    };
  }
  const itemId =
    normalizeId(memory?.lastItem?.id) || normalizeId(memory?.lastResolvedItemId);
  if (!itemId) {
    return { ok: false, reason: "NO_ITEM_ID", itemId: null, item: null, proofSource: null };
  }
  const item =
    memory?.lastItem && typeof memory.lastItem === "object"
      ? memory.lastItem
      : { id: itemId };
  return {
    ok: true,
    reason: "SAME_PARTICIPANT_SESSION_MEMORY",
    itemId,
    item,
    proofSource: "PARTICIPANT_SESSION_MEMORY",
  };
}

/**
 * @param {{
 *   message: unknown,
 *   bareDurationMessage: boolean,
 *   previousAssistantAskedDuration: boolean,
 *   durationMemoryCandidate: Record<string, unknown> | null,
 *   catalogItems: unknown[],
 *   memory: Record<string, unknown> | null | undefined,
 *   recentAssistantReplies: string[],
 *   participantKey?: string | null,
 *   chatContextKey?: string | null,
 *   sessionKey?: string | null,
 *   traceId?: string | null,
 *   isGroupInbound?: boolean,
 * }} p
 */
function resolveDurationContextPolicy(p) {
  const bareDurationMessage = p.bareDurationMessage === true;
  const memoryItemId = normalizeId(p.durationMemoryCandidate?.id);
  const itemlessPriceDurationFollowup = isItemlessPriceDurationFollowup(
    p.message,
    p.catalogItems
  );
  const safePrevious = itemlessPriceDurationFollowup
    ? hasSafePreviousCatalogItemForPriceFollowup({
        memory: p.memory,
        message: p.message,
        catalogItems: p.catalogItems,
        participantKey: p.participantKey,
        chatContextKey: p.chatContextKey,
        sessionKey: p.sessionKey,
        traceId: p.traceId,
        isGroupInbound: p.isGroupInbound === true,
      })
    : { ok: false, reason: null, proofSource: null, item: null, itemId: null };
  const priceDurationFollowupWithSafeItem =
    itemlessPriceDurationFollowup && safePrevious.ok === true;
  const durationContextAllowed =
    !bareDurationMessage ||
    (p.previousAssistantAskedDuration && memoryItemId != null) ||
    priceDurationFollowupWithSafeItem;
  let durationContextReason = "OK";
  if (!durationContextAllowed) {
    durationContextReason = !p.previousAssistantAskedDuration
      ? "PREVIOUS_ASSISTANT_DID_NOT_ASK_DURATION"
      : "ACTIVE_ITEM_MISSING";
  } else if (priceDurationFollowupWithSafeItem) {
    durationContextReason = "PRICE_DURATION_FOLLOWUP_WITH_SAFE_ITEM";
  }
  return {
    durationContextAllowed,
    durationContextReason,
    priceDurationFollowupWithSafeItem,
    itemlessPriceDurationFollowup,
    safePreviousReason: safePrevious.reason ?? null,
    safePreviousProofSource: safePrevious.proofSource ?? null,
    priceFollowupCatalogItem:
      priceDurationFollowupWithSafeItem && safePrevious.item
        ? safePrevious.item
        : null,
  };
}

/**
 * @param {unknown} value
 */
function normalizeForContextMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} historyText
 * @param {string[]} recentAssistantReplies
 * @param {Record<string, unknown> | null | undefined} item
 */
function previousAssistantAskedDurationForItem(
  historyText,
  recentAssistantReplies,
  item
) {
  if (!item || typeof item !== "object") return false;
  const itemLabel =
    normalizeForContextMatch(item.displayLabel) ||
    normalizeForContextMatch(item.name);
  const itemName = normalizeForContextMatch(item.name);
  if (!itemLabel && !itemName) return false;

  const assistantFromHistory = extractRecentAssistantTextsFromPromptBlock(
    historyText,
    3
  );
  const candidates = mergeAssistantReplyListsForNorm(
    assistantFromHistory,
    recentAssistantReplies,
    6
  );
  const durationAsk =
    /\b(for how long|how many days|kitne time|kitne din|kitni duration|duration)\b/i;
  return candidates.some((reply) => {
    const normalized = normalizeForContextMatch(reply);
    const mentionsItem =
      (itemLabel && normalized.includes(itemLabel)) ||
      (itemName && normalized.includes(itemName));
    return mentionsItem && durationAsk.test(String(reply ?? ""));
  });
}

/**
 * @param {Record<string, unknown>} item
 */
function formatCatalogOptionLine(item) {
  const label = buildDisplayLabel(item) || String(item.name ?? "").trim() || "Option";
  const priceRaw =
    item.price ??
    item.pricePerDay ??
    item.dailyRate ??
    item.rent ??
    item.rate ??
    null;
  const price = priceRaw != null && String(priceRaw).trim() !== ""
    ? String(priceRaw).trim()
    : "";
  return price ? `- ${label} - ${price}` : `- ${label}`;
}

function buildBrowseOptionsReply(items, style, options = {}) {
  const actuallyAvailable = options?.actuallyAvailable !== false;
  if (!Array.isArray(items) || items.length === 0) {
    return style === "casual_local"
      ? "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?"
      : "I don't see another available option right now. Would you like to ask about a specific option?";
  }
  const heading = actuallyAvailable
    ? "Available options:"
    : style === "casual_local"
      ? "Hamari list mein ye options hain:"
      : "Listed options:";
  const ask =
    style === "casual_local"
      ? "Konsa option dekhna chahenge?"
      : "Which option would you like to check?";
  return `${heading}\n${items.map(formatCatalogOptionLine).join("\n")}\n\n${ask}`;
}

function buildNotListedReply({ itemLabel, style, catalogItems = [] }) {
  const label = String(itemLabel ?? "").trim() || "yeh option";
  const available = (Array.isArray(catalogItems) ? catalogItems : []).filter(
    (row) => row && typeof row === "object"
  );
  if (style === "casual_local") {
    const head = `Sorry, ${label} hamari list mein nahi hai.`;
    if (available.length > 0) {
      return `${head}\n${buildBrowseOptionsReply(available, style, { actuallyAvailable: false })}`;
    }
    return `${head} Kya aap koi aur available option dekhna chahenge?`;
  }
  const head = `Sorry, ${label} is not listed in our available options.`;
  if (available.length > 0) {
    return `${head}\n${buildBrowseOptionsReply(available, style, { actuallyAvailable: false })}`;
  }
  return `${head} Would you like to see what we currently have?`;
}

function formatServiceOptionLine(service) {
  const s = service && typeof service === "object" ? service : {};
  const label = String(
    s.label ?? s.name ?? s.title ?? s.service ?? ""
  ).trim();
  if (!label) return "";
  const priceRaw = s.price ?? s.rate ?? s.cost ?? null;
  const price = priceRaw != null && String(priceRaw).trim() !== ""
    ? String(priceRaw).trim()
    : "";
  return price ? `- ${label} - ${price}` : `- ${label}`;
}

function buildBrowseOfferingsReply({ items, services, style }) {
  const lines = [];
  for (const it of Array.isArray(items) ? items : []) {
    const line = formatCatalogOptionLine(it);
    if (line) lines.push(line);
    if (lines.length >= 5) break;
  }
  for (const svc of Array.isArray(services) ? services : []) {
    if (lines.length >= 5) break;
    const line = formatServiceOptionLine(svc);
    if (line) lines.push(line);
  }
  if (lines.length === 0) {
    return style === "casual_local"
      ? "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?"
      : "I don't see another available option right now. Would you like to ask about a specific option?";
  }
  const heading = "Available options:";
  const ask =
    style === "casual_local"
      ? "Konsa option dekhna chahenge?"
      : "Which option would you like to check?";
  return `${heading}\n${lines.join("\n")}\n\n${ask}`;
}

function isRoutableDmTarget(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "unknown") return false;
  if (/^grp[0-9a-f]{8,}$/i.test(raw) || /^anon::/i.test(raw)) return false;
  if (raw.includes("@")) {
    return /@(c\.us|s\.whatsapp\.net)$/i.test(raw);
  }
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

/**
 * Generic “when will something be available again?” without naming a catalog row in the message.
 * Used to block stale {@link nextChatContext.lastFocusedItem} scoped-follow-up binding.
 * @param {unknown} message
 */
function messageLooksLikeGenericAvailabilityTimingFollowup(message) {
  const text = String(message ?? "").trim().toLowerCase();
  if (!text) return false;
  const timing =
    /\b(kb\s+tk|kab\s+tak|kab|when|how\s+long|kitne\s+din)\b/i.test(text);
  const availabilityCue =
    /\b(available|avail)\b/i.test(text) ||
    /\b(mil\s+jaye|mil\s+jayegi|ho\s+jaye|ho\s+jayegi|ho\s+jye(?:gi|ge)?|hogi|hoga)\b/i.test(text);
  return Boolean(timing && availabilityCue);
}

const STRUCTURED_NO_OTHER_OPTIONS_UR_RE =
  /\bfilhaal\s+koi\s+aur\s+option\s+bhi\s+available\s+nahi\s+hai\b/i;
const STRUCTURED_NO_OTHER_OPTIONS_EN_RE =
  /\b(i\s+)?don'?t\s+see\s+any\s+other\s+available\s+options\b/i;

/**
 * Recent assistant line matched structured “no other verified options” copy (Urdu/English).
 * @param {string | null | undefined} conversationHistory
 * @param {string} userId
 * @param {string} sessionKey
 */
function recentAssistantStructuredNoOtherOptionsReply(
  conversationHistory,
  userId,
  sessionKey
) {
  const fromBlock = extractRecentAssistantTextsFromPromptBlock(conversationHistory, 5);
  const fromMem = getRecentAssistantReplies(userId, 5, sessionKey);
  const merged = mergeAssistantReplyListsForNorm(fromBlock, fromMem, 10);
  return merged.some((t) => {
    const s = String(t ?? "");
    return (
      STRUCTURED_NO_OTHER_OPTIONS_UR_RE.test(s) || STRUCTURED_NO_OTHER_OPTIONS_EN_RE.test(s)
    );
  });
}

function markAvailabilityFreshNoOtherOptionsStructured(memory) {
  if (!memory || typeof memory !== "object") return;
  memory.availabilityFreshNoOtherOptionsAt = Date.now();
}

function clearAvailabilityFreshNoOtherOptionsStructured(memory) {
  if (!memory || typeof memory !== "object") return;
  delete memory.availabilityFreshNoOtherOptionsAt;
}

const AVAILABILITY_NO_OPTIONS_FLAG_TTL_MS = 48 * 60 * 60 * 1000;

function isAvailabilityFreshNoOtherOptionsActive(memory) {
  const mem = memory && typeof memory === "object" ? memory : null;
  return (
    mem != null &&
    Number.isFinite(Number(mem.availabilityFreshNoOtherOptionsAt)) &&
    Date.now() - Number(mem.availabilityFreshNoOtherOptionsAt) < AVAILABILITY_NO_OPTIONS_FLAG_TTL_MS
  );
}

/**
 * “Global no other options” wording for timing-unknown templates (no explicit catalog label in turn).
 * @param {{
 *   memory: unknown,
 *   explicitItemLabel?: string | null,
 *   conversationHistory: string | null | undefined,
 *   userId: string,
 *   sessionKey: string,
 * }} p
 */
function computeAvailabilityTimingGlobalNoOptions(p) {
  if (String(p.explicitItemLabel ?? "").trim()) return false;
  const mem = p.memory && typeof p.memory === "object" ? p.memory : null;
  if (Boolean(mem?.browseAllUnavailableFresh)) return true;
  if (isAvailabilityFreshNoOtherOptionsActive(mem)) return true;
  return recentAssistantStructuredNoOtherOptionsReply(
    p.conversationHistory,
    String(p.userId ?? "").trim(),
    String(p.sessionKey ?? "").trim()
  );
}

/**
 * After verified “no other options” structured reply, timing follow-ups should not
 * re-open alternative suggestions via stock-check templates or general AI.
 * @param {{
 *   message: unknown,
 *   memory: unknown,
 *   prioritizedIntent: unknown,
 *   llmIntentClassification: unknown,
 *   conversationHistory: string | null | undefined,
 *   userId: string,
 *   sessionKey: string,
 * }} p
 */
function shouldRouteAvailabilityTimingUnknownAfterNoOptionsContext(p) {
  const timing =
    messageLooksLikeGenericAvailabilityTimingFollowup(p.message) ||
    intentReasonSuggestsAvailabilityTimeframe(
      /** @type {{ reason?: string }} */ (p.prioritizedIntent)?.reason
    ) ||
    intentReasonSuggestsAvailabilityTimeframe(
      /** @type {{ reason?: string }} */ (p.llmIntentClassification)?.reason
    );
  if (!timing) return false;
  const mem = p.memory && typeof p.memory === "object" ? p.memory : null;
  if (Boolean(mem?.browseAllUnavailableFresh)) return true;
  if (isAvailabilityFreshNoOtherOptionsActive(mem)) return true;
  return recentAssistantStructuredNoOtherOptionsReply(
    p.conversationHistory,
    String(p.userId ?? "").trim(),
    String(p.sessionKey ?? "").trim()
  );
}

/**
 * Clears participant-scoped lastFocusedItem after a verified global zero-availability reply.
 * @param {{
 *   chatContextKey: string,
 *   nextChatContext: { lastFocusedItem?: unknown },
 *   source: string,
 *   availableCount: number,
 *   summaryStatus: string,
 *   reason: string,
 * }} p
 */
function clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptions({
  chatContextKey,
  nextChatContext,
  source,
  availableCount,
  summaryStatus,
  reason,
} = {}) {
  if (!chatContextKey || !nextChatContext || typeof nextChatContext !== "object") return;
  if (String(summaryStatus ?? "").trim().toLowerCase() !== "fresh") return;
  if (!Number.isFinite(Number(availableCount)) || Number(availableCount) !== 0) return;
  const prev = String(nextChatContext.lastFocusedItem ?? "").trim();
  if (!prev) return;
  nextChatContext.lastFocusedItem = null;
  if (globalThis.__chatContext && typeof globalThis.__chatContext === "object") {
    globalThis.__chatContext[chatContextKey] = nextChatContext;
  }
  console.log("[no_options_focus_cleared]", {
    previousLastFocusedItem: prev,
    source,
    availableCount,
    summaryStatus,
    reason,
  });
}

/**
 * LLM intent `reason` (English) often distinguishes timeframe vs stock check.
 * @param {unknown} reasonRaw
 */
function intentReasonSuggestsAvailabilityTimeframe(reasonRaw) {
  const r = String(reasonRaw ?? "").toLowerCase();
  if (!r) return false;
  if (/\btimeframe\b/.test(r) || /\btiming\b/.test(r)) return true;
  if (
    r.includes("availability") &&
    (/\bwhen\b/.test(r) || /\bhow long\b/.test(r) || /\btime\b/.test(r))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {{ itemContext: unknown, resolvedItem: unknown, memory: unknown, safeItem: unknown }} p
 * @returns {"none"|"memory_fallback"|"current_turn_resolved"|"current_turn_verified"|"unknown"}
 */
function resolveSafeItemSource({ itemContext, resolvedItem, memory, safeItem } = {}) {
  if (!safeItem || typeof safeItem !== "object") return "none";
  const sid = normalizeId(safeItem.itemId ?? safeItem.id);
  if (!sid) return "unknown";
  if (itemContext != null && typeof itemContext === "object") {
    const ic = normalizeId(itemContext.itemId ?? itemContext.id);
    if (ic && ic === sid) return "current_turn_verified";
  }
  if (resolvedItem != null && typeof resolvedItem === "object") {
    const rid = normalizeId(resolvedItem.itemId ?? resolvedItem.id);
    if (rid && rid === sid) return "current_turn_resolved";
  }
  const mem = memory?.lastItem && typeof memory.lastItem === "object" ? memory.lastItem : null;
  if (mem) {
    const mid = normalizeId(mem.itemId ?? mem.id);
    if (mid && mid === sid) return "memory_fallback";
  }
  return "unknown";
}

/**
 * @param {{ style: string, explicitItemLabel?: string | null }} p
 */
function buildAvailabilityTimingUnknownReply({
  style,
  explicitItemLabel,
  globalNoOptions = false,
} = {}) {
  const isUr = style === "casual_local";
  const label = String(explicitItemLabel ?? "").trim();
  if (label) {
    return isUr
      ? `${label} ki exact availability abhi confirm nahi hai. Jaise hi available hogi, main update kar dunga.`
      : `We can’t confirm exact availability for ${label} right now. I’ll update you as soon as it’s available.`;
  }
  if (globalNoOptions) {
    return isUr
      ? "Exact time abhi confirm nahi hai. Jaise hi koi option available hogi, main update kar dunga."
      : "We can’t confirm an exact time right now. I’ll update you as soon as any option is available.";
  }
  return isUr
    ? "Exact time abhi confirm nahi hai. Jaise hi available hogi, main update kar dunga."
    : "We can’t confirm an exact time right now. I’ll update you as soon as it’s available.";
}

/**
 * Timing follow-up after verified no-options context (route-order safe; not gated on AI route).
 * @param {{
 *   message: unknown,
 *   memory: unknown,
 *   prioritizedIntent: unknown,
 *   llmIntentClassification: unknown,
 *   conversationHistory: string | null | undefined,
 *   userId: string,
 *   sessionKey: string,
 *   normalizedCatalogForTurn: unknown[],
 *   emilyTurn: unknown,
 *   conversationStyle: string,
 *   safeItemSource: string,
 *   routeLogSource: string,
 * }} p
 * @returns {{ reply: string, replyType: string } | null}
 */
function availabilityTimingUnknownTurnIfRouted(p) {
  if (
    !shouldRouteAvailabilityTimingUnknownAfterNoOptionsContext({
      message: p.message,
      memory: p.memory,
      prioritizedIntent: p.prioritizedIntent,
      llmIntentClassification: p.llmIntentClassification,
      conversationHistory: p.conversationHistory,
      userId: p.userId,
      sessionKey: p.sessionKey,
    })
  ) {
    return null;
  }
  const explicitHit = hasExplicitNewItemMention(
    p.message,
    p.normalizedCatalogForTurn,
    null
  );
  const explicitLabel =
    (explicitHit.found && explicitHit.itemLabel) ||
    String(
      labelFromMatchedItem(
        /** @type {{ match?: { matchedItem?: unknown } }} */ (p.emilyTurn)?.match
          ?.matchedItem
      ) ?? ""
    ).trim() ||
    "";
  const globalNoOptions = computeAvailabilityTimingGlobalNoOptions({
    memory: p.memory,
    explicitItemLabel: explicitLabel,
    conversationHistory: p.conversationHistory,
    userId: p.userId,
    sessionKey: p.sessionKey,
  });
  const timingReply = buildAvailabilityTimingUnknownReply({
    style: p.conversationStyle,
    explicitItemLabel: explicitLabel || null,
    globalNoOptions,
  });
  const replyType = explicitLabel ? "EXPLICIT_ITEM_TIMING_UNKNOWN" : "GENERIC_TIMING_UNKNOWN";
  console.log("[availability_timing_followup_routed]", {
    rawTextPreview: String(p.message ?? "").trim().slice(0, 160) || null,
    classifierReason:
      String(
        /** @type {{ reason?: string }} */ (p.llmIntentClassification)?.reason ?? ""
      ).slice(0, 200) || null,
    askedField:
      /** @type {{ askedField?: string }} */ (p.prioritizedIntent)?.askedField ?? null,
    selectedItemSource: p.safeItemSource,
    hasExplicitCatalogItem: Boolean(
      String(
        labelFromMatchedItem(
          /** @type {{ match?: { matchedItem?: unknown } }} */ (p.emilyTurn)?.match
            ?.matchedItem
        ) ?? ""
      ).trim() || explicitHit.found
    ),
    replyType,
    source: p.routeLogSource,
  });
  return { reply: timingReply, replyType };
}

/**
 * @param {object} p
 */
function computeAskDurationPhraseEligibility({
  stage,
  itemContext,
  safeItemSource,
  message,
  normalizedCatalogForTurn,
  emilyTurn,
  priorityIntentSnapshot,
  llmIntentClassification,
} = {}) {
  if (stage !== "availability") {
    return { eligible: false, reason: "NOT_AVAILABILITY_STAGE" };
  }
  if (!itemContext || typeof itemContext !== "object") {
    return { eligible: false, reason: "MISSING_ITEM_CONTEXT" };
  }
  if (itemContext.isAvailable !== true) {
    return { eligible: false, reason: "ITEM_NOT_AVAILABLE" };
  }
  if (safeItemSource === "memory_fallback") {
    return { eligible: false, reason: "MEMORY_FALLBACK_UNVERIFIED" };
  }
  const classifierTime =
    intentReasonSuggestsAvailabilityTimeframe(priorityIntentSnapshot?.reason) ||
    intentReasonSuggestsAvailabilityTimeframe(llmIntentClassification?.reason);
  const genericTimingShape = messageLooksLikeGenericAvailabilityTimingFollowup(message);
  if (classifierTime || genericTimingShape) {
    return { eligible: false, reason: "AVAILABILITY_TIMING_OR_TIMEFRAME" };
  }
  const explicitCatalogThisTurn =
    Boolean(String(labelFromMatchedItem(emilyTurn?.match?.matchedItem) ?? "").trim()) ||
    hasExplicitNewItemMention(message, normalizedCatalogForTurn, null).found;
  if (
    !explicitCatalogThisTurn &&
    safeItemSource !== "current_turn_verified" &&
    safeItemSource !== "current_turn_resolved"
  ) {
    return { eligible: false, reason: "NO_EXPLICIT_ITEM_AND_NO_RESOLVED_SOURCE" };
  }
  return { eligible: true, reason: "OK" };
}

function latestMessageMentionsEntity(message, entityName) {
  const msg = normalizeCatalogMatchText(message);
  const entity = normalizeCatalogMatchText(entityName);
  if (!msg || !entity) return false;
  if (msg.includes(entity)) return true;
  const msgTokens = new Set(tokenizeCatalogMatch(message));
  return tokenizeCatalogMatch(entityName).some(
    (token) => token.length >= 3 && msgTokens.has(token)
  );
}

function isDetailFollowupWithoutExplicitEntity(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  const extracted = extractEntity(text);
  const hasAcceptedEntity =
    extracted.name != null &&
    extracted.confidence > 0.8 &&
    extracted.confidence >= getEntityConfidenceThreshold(extracted.name);
  if (hasAcceptedEntity) return false;
  return /\b(?:kis|konsa|kaunsa|which|what|kitna|kitni|kitne|color|colour|model|mileage|condition|halat|rent|rate|price|chali|chli|driven)\b/i.test(
    text
  );
}

function detailFieldForEntityGuard(message) {
  const text = String(message ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/\b(colou?r)\b/.test(text)) return "color";
  if (/\b(model|variant|version)\b/.test(text)) return "model";
  if (/\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text)) {
    return "price";
  }
  if (/\b(mileage|miles|km|kilometer|kilometre|used|usage|chali|chli|driven)\b/.test(text)) {
    return "mileage";
  }
  if (/\b(condition|halat)\b/.test(text)) return "condition";
  if (/\b(transmission|automatic|manual)\b/.test(text)) return "transmission";
  return null;
}

export function shouldSkipEntityExtractionForDetailQuestion(message, catalogItems) {
  const field = detailFieldForEntityGuard(message);
  if (!field) return { skip: false, field: null };
  const explicitCatalogItem = hasExplicitNewItemMention(
    message,
    Array.isArray(catalogItems) ? catalogItems : [],
    null
  );
  return {
    skip: !explicitCatalogItem.found,
    field,
  };
}

export function shouldBlockPinnedEntityForFollowup({
  message,
  pinnedEntityName,
  currentItem,
} = {}) {
  const pinned = String(pinnedEntityName ?? "").trim();
  if (!pinned) return false;
  const currentLabel =
    buildDisplayLabel(currentItem && typeof currentItem === "object" ? currentItem : {}) ||
    String(currentItem?.name ?? currentItem?.displayLabel ?? "").trim();
  if (!currentLabel) return false;
  if (!isDetailFollowupWithoutExplicitEntity(message)) return false;
  return !latestMessageMentionsEntity(message, pinned);
}

function normalizeAuthorityItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const id = normalizeId(item.id ?? item.itemId);
  const name = String(item.name ?? item.itemLabel ?? item.displayLabel ?? "").trim();
  const displayLabel = buildDisplayLabel(item) || String(item.displayLabel ?? name).trim();
  if (!id && !name && !displayLabel) return null;
  return {
    ...item,
    ...(id ? { id, itemId: id } : {}),
    name: name || displayLabel,
    displayLabel: displayLabel || name,
  };
}

function mergeComposerCatalogItem(item, catalogItems = []) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const itemId = normalizeId(item.itemId ?? item.id);
  if (!itemId) return item;
  const catalogItem = Array.isArray(catalogItems)
    ? catalogItems.find(
        (row) =>
          row &&
          typeof row === "object" &&
          normalizeId(row.itemId ?? row.id) === itemId
      )
    : null;
  if (!catalogItem) return item;
  const attrs =
    catalogItem.attributes && typeof catalogItem.attributes === "object"
      ? { ...catalogItem.attributes }
      : {};
  if (item.attributes && typeof item.attributes === "object") {
    Object.assign(attrs, item.attributes);
  }
  const pricing =
    catalogItem.pricing && typeof catalogItem.pricing === "object"
      ? { ...catalogItem.pricing }
      : {};
  if (item.pricing && typeof item.pricing === "object") {
    Object.assign(pricing, item.pricing);
  }
  return {
    ...catalogItem,
    ...item,
    id: itemId,
    itemId,
    color: item.color ?? item.colour ?? catalogItem.color ?? catalogItem.colour,
    colour: item.colour ?? item.color ?? catalogItem.colour ?? catalogItem.color,
    pricing: Object.keys(pricing).length ? pricing : item.pricing ?? catalogItem.pricing,
    images: item.images ?? catalogItem.images,
    imageUrls: item.imageUrls ?? catalogItem.imageUrls,
    attributes: Object.keys(attrs).length ? attrs : item.attributes ?? catalogItem.attributes,
    displayLabel:
      item.displayLabel ?? catalogItem.displayLabel ?? catalogItem.name ?? item.name,
  };
}

function itemHasPricingData(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const pricing = item.pricing;
  if (pricing && typeof pricing === "object" && !Array.isArray(pricing)) {
    if (Object.values(pricing).some((value) => String(value ?? "").trim() !== "")) {
      return true;
    }
  }
  const attrs = item.attributes && typeof item.attributes === "object" ? item.attributes : {};
  const state = item.state && typeof item.state === "object" ? item.state : {};
  return [
    item.price,
    item.pricePerDay,
    item.dailyRate,
    item.monthlyRate,
    item.rent,
    item.rate,
    item.perDay,
    item.perMonth,
    attrs.price,
    attrs.rate,
    attrs.pricePerDay,
    attrs.dailyRate,
    state.price,
    state.pricePerDay,
  ].some((value) => String(value ?? "").trim() !== "");
}

function normalizedCatalogEntries(catalogItems = []) {
  return (Array.isArray(catalogItems) ? catalogItems : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const item = normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row));
      const id = normalizeId(item.id ?? item.itemId);
      if (!id) return null;
      const labels = Array.from(
        new Set(
          [
            item.name,
            item.displayLabel,
            buildDisplayLabel(item),
          ]
            .map((value) => String(value ?? "").trim())
            .filter(Boolean)
        )
      );
      return {
        id,
        item: { ...item, id, itemId: id },
        labels,
        normalizedLabels: labels.map((label) => normalizeCatalogMatchText(label)).filter(Boolean),
        tokens: Array.from(new Set(labels.flatMap((label) => tokenizeCatalogMatch(label)))),
      };
    })
    .filter(Boolean);
}

function itemFactValue(item, field) {
  return String(item?.[field] ?? "").trim();
}

function itemConditionFacts(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const condition = itemFactValue(item, "condition");
  const conditionNote = itemFactValue(item, "conditionNote");
  if (!condition && !conditionNote) return null;
  return {
    ...(condition ? { condition } : {}),
    ...(conditionNote ? { conditionNote } : {}),
  };
}

function profileItemLabels(item) {
  return Array.from(
    new Set(
      [
        item?.name,
        item?.displayLabel,
        item?.normalizedLabel,
        buildDisplayLabel(item || {}),
      ]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );
}

function findCatalogEntryForProfileItem(entries, profileItem) {
  const idCandidates = Array.from(
    new Set(
      [normalizeId(profileItem?.id), normalizeId(profileItem?.itemId), normalizeId(profileItem?._id)]
        .filter(Boolean)
    )
  );
  const idMatches = idCandidates.flatMap((id) => entries.filter((entry) => entry.id === id));
  if (idMatches.length === 1) {
    return { status: "matched", entry: idMatches[0], reason: "exact_id" };
  }
  if (idMatches.length > 1) {
    return { status: "ambiguous", matches: idMatches.map((entry) => entry.item), reason: "ambiguous_id" };
  }

  const labels = profileItemLabels(profileItem);
  const exactMatches = findExactLabelMatches(entries, labels);
  if (exactMatches.length === 1) {
    return { status: "matched", entry: exactMatches[0], reason: "exact_normalized_label" };
  }
  if (exactMatches.length > 1) {
    return {
      status: "ambiguous",
      matches: exactMatches.map((entry) => entry.item),
      reason: "ambiguous_exact_normalized_label",
    };
  }

  const normalizedLabels = labels.map((label) => normalizeCatalogMatchText(label)).filter(Boolean);
  const fuzzyMatches = entries.filter((entry) =>
    entry.normalizedLabels.some((catalogLabel) =>
      normalizedLabels.some((profileLabel) => {
        if (catalogLabel.length < 3 || profileLabel.length < 3) return false;
        return catalogLabel.includes(profileLabel) || profileLabel.includes(catalogLabel);
      })
    )
  );
  if (fuzzyMatches.length === 1) {
    return { status: "matched", entry: fuzzyMatches[0], reason: "unambiguous_normalized_label" };
  }
  if (fuzzyMatches.length > 1) {
    return {
      status: "ambiguous",
      matches: fuzzyMatches.map((entry) => entry.item),
      reason: "ambiguous_normalized_label",
    };
  }
  return { status: "no_match", reason: "no_profile_item_match" };
}

export function mergeBusinessProfileItemFactsIntoCatalog(catalogItems = [], businessProfile = null) {
  const rawProfileItems =
    businessProfile?.rawBusinessProfile &&
    typeof businessProfile.rawBusinessProfile === "object" &&
    !Array.isArray(businessProfile.rawBusinessProfile) &&
    Array.isArray(businessProfile.rawBusinessProfile.items)
      ? businessProfile.rawBusinessProfile.items
      : businessProfile?.profileData &&
          typeof businessProfile.profileData === "object" &&
          !Array.isArray(businessProfile.profileData) &&
          Array.isArray(businessProfile.profileData.items)
        ? businessProfile.profileData.items
        : [];
  if (!Array.isArray(rawProfileItems) || rawProfileItems.length === 0) {
    return catalogItems;
  }
  const profileItems = rawProfileItems.filter(
    (item) => item && typeof item === "object" && !Array.isArray(item) && itemConditionFacts(item)
  );
  if (profileItems.length === 0) return catalogItems;

  const entries = normalizedCatalogEntries(catalogItems);
  const patchesById = new Map();
  for (const profileItem of profileItems) {
    const facts = itemConditionFacts(profileItem);
    if (!facts) continue;
    const match = findCatalogEntryForProfileItem(entries, profileItem);
    if (match.status === "matched") {
      const id = normalizeId(match.entry.item?.id ?? match.entry.item?.itemId);
      if (!id) continue;
      patchesById.set(id, { ...(patchesById.get(id) || {}), ...facts });
      console.log("[catalog_condition_facts_merged]", {
        itemId: id,
        itemName: match.entry.item?.name ?? match.entry.item?.displayLabel ?? null,
        matchReason: match.reason,
        hasCondition: Boolean(facts.condition),
        hasConditionNote: Boolean(facts.conditionNote),
      });
      continue;
    }
    if (match.status === "ambiguous") {
      console.log("[catalog_condition_facts_merge_ambiguous]", {
        profileItemName: profileItem?.name ?? profileItem?.displayLabel ?? null,
        reason: match.reason,
        candidateCount: match.matches?.length ?? 0,
        candidateNames: (match.matches || [])
          .slice(0, 5)
          .map((item) => item?.name ?? item?.displayLabel ?? null)
          .filter(Boolean),
      });
    }
  }
  if (patchesById.size === 0) return catalogItems;
  return catalogItems.map((item) => {
    const id = normalizeId(item?.id ?? item?.itemId);
    const patch = id ? patchesById.get(id) : null;
    return patch ? { ...item, ...patch } : item;
  });
}

function mergeCatalogUpgradeItem(catalogItem, partialItem = null) {
  const itemId = normalizeId(catalogItem?.id ?? catalogItem?.itemId);
  const partial =
    partialItem && typeof partialItem === "object" && !Array.isArray(partialItem)
      ? partialItem
      : {};
  const catalogPricing =
    catalogItem?.pricing && typeof catalogItem.pricing === "object"
      ? catalogItem.pricing
      : undefined;
  const partialPricing =
    partial?.pricing && typeof partial.pricing === "object" ? partial.pricing : undefined;
  const partialPricingHasValues =
    partialPricing &&
    Object.values(partialPricing).some((value) => String(value ?? "").trim() !== "");
  return {
    ...(catalogItem || {}),
    ...partial,
    id: itemId || normalizeId(partial?.id ?? partial?.itemId) || "",
    itemId: itemId || normalizeId(partial?.id ?? partial?.itemId) || "",
    name:
      String(catalogItem?.name ?? "").trim() ||
      String(partial?.name ?? "").trim() ||
      String(partial?.displayLabel ?? "").trim(),
    displayLabel:
      String(partial?.displayLabel ?? "").trim() ||
      String(catalogItem?.displayLabel ?? "").trim() ||
      buildDisplayLabel(catalogItem || {}) ||
      String(catalogItem?.name ?? partial?.name ?? "").trim(),
    color: partial?.color ?? partial?.colour ?? catalogItem?.color ?? catalogItem?.colour,
    colour: partial?.colour ?? partial?.color ?? catalogItem?.colour ?? catalogItem?.color,
    pricing: partialPricingHasValues ? partialPricing : catalogPricing,
    attributes:
      partial?.attributes && typeof partial.attributes === "object"
        ? { ...(catalogItem?.attributes || {}), ...partial.attributes }
        : catalogItem?.attributes,
  };
}

function findUniqueById(entries, idRaw) {
  const id = normalizeId(idRaw);
  if (!id) return null;
  return entries.find((entry) => entry.id === id) || null;
}

function findExactLabelMatches(entries, labels = []) {
  const wanted = new Set(
    labels
      .map((label) => normalizeCatalogMatchText(label))
      .filter((label) => label.length >= 2)
  );
  if (wanted.size === 0) return [];
  return entries.filter((entry) =>
    entry.normalizedLabels.some((label) => wanted.has(label))
  );
}

function scoreCatalogEntryAgainstText(entry, text, { allowTypo = false } = {}) {
  const msgTokens = tokenizeCatalogMatch(text).filter((token) => token.length >= 3);
  if (msgTokens.length === 0) return 0;
  let score = 0;
  for (const itemToken of entry.tokens) {
    if (itemToken.length < 3) continue;
    if (msgTokens.includes(itemToken)) {
      score += 2;
      continue;
    }
    if (
      allowTypo &&
      msgTokens.some((msgToken) => catalogTokensLikelySameWord(msgToken, itemToken))
    ) {
      score += 1;
    }
  }
  return score;
}

function findUnambiguousTextMatch(entries, text, { allowTypo = false } = {}) {
  const scored = entries
    .map((entry) => ({
      entry,
      score: scoreCatalogEntryAgainstText(entry, text, { allowTypo }),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) {
    return { status: "no_match", reason: allowTypo ? "no_fuzzy_match" : "no_token_match" };
  }
  const topScore = scored[0].score;
  const top = scored.filter((row) => row.score === topScore);
  if (top.length !== 1) {
    return {
      status: "ambiguous",
      reason: allowTypo ? "ambiguous_fuzzy_match" : "ambiguous_token_match",
      matches: top.map((row) => row.entry.item),
    };
  }
  return {
    status: "matched",
    matchReason: allowTypo ? "unambiguous_fuzzy_match" : "unambiguous_token_match",
    item: top[0].entry.item,
  };
}

function currentMessageHasAnyCatalogSignal(userMessage, entries, ignoredItemId = null) {
  const ignored = normalizeId(ignoredItemId);
  const msg = normalizeCatalogMatchText(userMessage);
  if (!msg) return false;
  return entries.some((entry) => {
    if (ignored && entry.id === ignored) return false;
    return scoreCatalogEntryAgainstText(entry, msg, { allowTypo: true }) > 0;
  });
}

export function maybeUpgradePartialItemFromCatalog({
  partialItem = null,
  catalogItems = [],
  userMessage = "",
  memoryContext = null,
} = {}) {
  const entries = normalizedCatalogEntries(catalogItems);
  if (entries.length === 0) {
    return { status: "no_match", reason: "catalog_empty" };
  }

  const partial =
    partialItem && typeof partialItem === "object" && !Array.isArray(partialItem)
      ? partialItem
      : null;
  const partialId = normalizeId(partial?.itemId ?? partial?.id);
  const memoryItem =
    memoryContext?.lastItem &&
    typeof memoryContext.lastItem === "object" &&
    !Array.isArray(memoryContext.lastItem)
      ? memoryContext.lastItem
      : null;
  const memoryId = normalizeId(memoryItem?.itemId ?? memoryItem?.id);
  const currentMessageSignalsAnotherItem = currentMessageHasAnyCatalogSignal(
    userMessage,
    entries,
    memoryId
  );
  const partialLooksLikeMemory =
    memoryId && partialId && partialId === memoryId;

  const byPartialId =
    currentMessageSignalsAnotherItem && partialLooksLikeMemory
      ? null
      : findUniqueById(entries, partialId);
  if (byPartialId) {
    return {
      status: "matched",
      matchReason: "exact_item_id",
      item: mergeCatalogUpgradeItem(byPartialId.item, partial),
    };
  }

  const partialLabels = [
    partial?.name,
    partial?.displayLabel,
    buildDisplayLabel(partial || {}),
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const exactLabelMatches =
    currentMessageSignalsAnotherItem && partialLooksLikeMemory
      ? []
      : findExactLabelMatches(entries, partialLabels);
  if (exactLabelMatches.length === 1) {
    return {
      status: "matched",
      matchReason: "exact_label",
      item: mergeCatalogUpgradeItem(exactLabelMatches[0].item, partial),
    };
  }
  if (exactLabelMatches.length > 1) {
    return {
      status: "ambiguous",
      reason: "ambiguous_exact_label",
      matches: exactLabelMatches.map((entry) => entry.item),
    };
  }

  const byMemoryId = !currentMessageSignalsAnotherItem
    ? findUniqueById(entries, memoryId)
    : null;
  if (byMemoryId) {
    return {
      status: "matched",
      matchReason: "memory_item_id",
      item: mergeCatalogUpgradeItem(byMemoryId.item, partial || memoryItem),
    };
  }

  const queryParts = [
    userMessage,
    ...(currentMessageSignalsAnotherItem && partialLooksLikeMemory
      ? []
      : partialLabels),
    ...(currentMessageSignalsAnotherItem
      ? []
      : [memoryItem?.name, memoryItem?.displayLabel]),
  ]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 2);
  const query = queryParts.join(" ");

  const tokenMatch = findUnambiguousTextMatch(entries, query, { allowTypo: false });
  if (tokenMatch.status === "matched") {
    return {
      status: "matched",
      matchReason: tokenMatch.matchReason,
      item: mergeCatalogUpgradeItem(tokenMatch.item, partial),
    };
  }
  if (tokenMatch.status === "ambiguous") return tokenMatch;

  const fuzzyMatch = findUnambiguousTextMatch(entries, query, { allowTypo: true });
  if (fuzzyMatch.status === "matched") {
    return {
      status: "matched",
      matchReason: fuzzyMatch.matchReason,
      item: mergeCatalogUpgradeItem(fuzzyMatch.item, partial),
    };
  }
  return fuzzyMatch;
}

export function resolveAuthoritativeItemForTurn({
  userText,
  explicitResolvedItem,
  turnLockedItem,
  memoryItem,
  isFollowup,
  catalogItems = [],
  itemlessPriceDurationFollowup = false,
} = {}) {
  const explicitItem = normalizeAuthorityItem(explicitResolvedItem);
  const lockedItem = normalizeAuthorityItem(turnLockedItem);
  const focusedMemoryItem = normalizeAuthorityItem(memoryItem);
  const extracted = extractEntity(userText);
  const hasExplicitEntity =
    extracted.name != null &&
    extracted.confidence > 0.8 &&
    extracted.confidence >= getEntityConfidenceThreshold(extracted.name);
  const explicitCatalogMention = hasExplicitNewItemMention(
    userText,
    Array.isArray(catalogItems) ? catalogItems : [],
    null
  );
  const explicitCatalogItem = explicitCatalogMention.found
    ? normalizeAuthorityItem(
        catalogItems.find(
          (row) => normalizeId(row?.id) === normalizeId(explicitCatalogMention.itemId)
        )
      )
    : null;
  const fuzzyCatalogMention = itemlessPriceDurationFollowup
    ? { found: false, ambiguous: false, itemId: null, itemLabel: null, candidates: [] }
    : findConservativeFuzzyCatalogMention(
        userText,
        catalogItems
      );
  const explicitMention =
    Boolean(explicitItem) &&
    (hasExplicitEntity ||
      explicitCatalogMention.found ||
      (fuzzyCatalogMention.found && !fuzzyCatalogMention.ambiguous) ||
      latestMessageMentionsEntity(
        userText,
        explicitItem?.displayLabel ?? explicitItem?.name
      ));

  let selected = null;
  let source = "none";
  if (explicitCatalogItem) {
    selected = explicitCatalogItem;
    source = "explicit_catalog";
  } else if (explicitMention && explicitItem) {
    selected = explicitItem;
    source = "explicit";
    const previousId = normalizeId(lockedItem?.id ?? focusedMemoryItem?.id);
    const newId = normalizeId(explicitItem.id ?? explicitItem.itemId);
    if (previousId && newId && previousId !== newId) {
      console.log("[item_authority_switch]", {
        previousItemId: previousId,
        newItemId: newId,
        reason: "EXPLICIT_CURRENT_USER_ITEM",
      });
    }
  } else if (lockedItem) {
    selected = lockedItem;
    source = "turn_lock";
  } else if (isFollowup && focusedMemoryItem) {
    const memoryId = normalizeId(focusedMemoryItem.id ?? focusedMemoryItem.itemId);
    const catalogExplicit = hasExplicitNewItemMention(userText, catalogItems, null);
    const vehicleConflict =
      (catalogExplicit.found &&
        normalizeId(catalogExplicit.itemId) &&
        normalizeId(catalogExplicit.itemId) !== memoryId) ||
      (fuzzyCatalogMention.found &&
        !fuzzyCatalogMention.ambiguous &&
        normalizeId(fuzzyCatalogMention.itemId) &&
        normalizeId(fuzzyCatalogMention.itemId) !== memoryId);
    if (vehicleConflict) {
      if (
        fuzzyCatalogMention.found &&
        !fuzzyCatalogMention.ambiguous &&
        fuzzyCatalogMention.itemId
      ) {
        const row = catalogItems.find(
          (r) => normalizeId(r?.id) === normalizeId(fuzzyCatalogMention.itemId)
        );
        if (row && typeof row === "object") {
          selected = normalizeAuthorityItem(row);
          source = "explicit_fuzzy";
        }
      } else if (catalogExplicit.found && catalogExplicit.itemId) {
        const row = catalogItems.find(
          (r) => normalizeId(r?.id) === normalizeId(catalogExplicit.itemId)
        );
        if (row && typeof row === "object") {
          selected = normalizeAuthorityItem(row);
          source = "explicit_catalog_mention";
        }
      }
      if (!selected) {
        console.log("[item_authority_memory_blocked_vehicle_conflict]", {
          memoryItemId: memoryId,
          catalogExplicit: catalogExplicit.found ? catalogExplicit.itemId : null,
          fuzzyItemId: fuzzyCatalogMention.itemId ?? null,
        });
      }
    } else {
      selected = focusedMemoryItem;
      source = "memory_followup";
    }
  }

  console.log("[item_authority_decision]", {
    source,
    selectedItemId: normalizeId(selected?.id ?? selected?.itemId) || null,
    selectedItemLabel: selected?.displayLabel ?? selected?.name ?? null,
    hasExplicitEntity,
    explicitMention,
    isFollowup: Boolean(isFollowup),
    hasTurnLock: Boolean(lockedItem),
    hasMemoryItem: Boolean(focusedMemoryItem),
  });
  return selected;
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
function isCommitMessage(text) {
  return /\b(yes|yess|confirm|book|ok|kar do|done)\b/i.test(String(text ?? ""));
}

/**
 * @param {string} message
 * @returns {number | null}
 */
function extractDurationFromMessage(message) {
  const r = parseUserDuration(message);
  return r?.normalizedDays ?? null;
}

/**
 * When there is no catalog match this turn, map `memory.lastItemMentioned` onto a profile
 * row so `collectCatalogItemImageUrls` can resolve `name`/`color` like a real match.
 * Read-only; does not mutate Emily state or matchers.
 *
 * @param {Record<string, unknown> | null | undefined} rawProfile
 * @param {unknown} lastItemMentioned
 * @returns {{ name: string, displayLabel: string, color?: string } | null}
 */
/**
 * User message still refers to Emily's `lastItemMentioned` (substring / token overlap, typo-tolerant).
 * Avoids using stale profile rows when the user pivots to a different item.
 * @param {string | undefined} message
 * @param {unknown} lastItemMentioned
 */
function messageLikelySameFocusAsMemory(message, lastItemMentioned) {
  if (lastItemMentioned == null) return false;
  const memRaw = String(lastItemMentioned).trim();
  if (memRaw.length < 2) return false;
  const msgNorm = normalizeCatalogMatchText(message);
  const memNorm = normalizeCatalogMatchText(memRaw);
  if (!msgNorm || !memNorm) return false;
  if (msgNorm.includes(memNorm) || memNorm.includes(msgNorm)) return true;

  const memTokens = Array.from(
    new Set(tokenizeCatalogMatch(memRaw))
  );
  const msgTokens = tokenizeCatalogMatch(String(message ?? ""));
  for (const t of msgTokens) {
    if (t.length < 3) continue;
    for (const m of memTokens) {
      if (m.length < 3) continue;
      if (catalogTokensLikelySameWord(t, m)) return true;
    }
  }
  return false;
}

function resolveCatalogItemFromMemoryLabel({ items, lastItemMentioned }) {
  const memRaw = String(lastItemMentioned ?? "").trim();
  if (!memRaw) return null;
  const mem = memRaw.toLowerCase();
  const itemRows = Array.isArray(items) ? items : [];
  for (const it of itemRows) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const vo = /** @type {Record<string, unknown>} */ (it);
    const n = String(vo.name ?? "").trim();
    if (!n) continue;
    const nl = n.toLowerCase();
    if (nl.includes(mem) || mem.includes(nl)) {
      const out = {
        name: n,
        displayLabel: n,
      };
      if (typeof vo.color === "string" && vo.color.trim() !== "") {
        return { ...out, color: String(vo.color).trim() };
      }
      return out;
    }
  }
  return null;
}

/**
 * Single display string for catalog rows (inventory + memory backfills).
 * @param {{ name?: unknown, color?: unknown, displayLabel?: unknown }} row
 */
function buildDisplayLabel(row) {
  const raw =
    row?.displayLabel != null && String(row.displayLabel).trim() !== ""
      ? String(row.displayLabel).trim()
      : "";
  if (raw) return raw;
  const name = String(row?.name ?? "").trim();
  const color =
    row?.color != null && String(row.color).trim() !== ""
      ? String(row.color).trim()
      : "";
  if (!name) return "";
  return color ? `${name} (${color})` : name;
}

/** Normalization for catalog ↔ user string matching only (not chat routing keys). */
function normalizeCatalogMatchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic resolver normalization shared by input and catalog labels.
 * @param {string | null | undefined} str
 */
function normalizeLabel(str) {
  return String(str ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * @param {unknown} raw
 * @returns {string | null} non-empty trimmed string id, or null if unusable
 */
function normalizeId(raw) {
  if (raw != null && typeof raw === "object") return null;
  const id = String(raw ?? "").trim();
  return id.length ? id : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} conversationMemory
 * @param {unknown} itemIdRaw
 */
function setLastResolvedItemId(conversationMemory, itemIdRaw) {
  if (!conversationMemory || typeof conversationMemory !== "object") return;
  const itemId = normalizeId(itemIdRaw);
  if (!itemId) return;
  conversationMemory.lastResolvedItemId = itemId;
}

/**
 * Single-token match is only safe if exactly one catalog label contains that token.
 * @param {string} token
 * @param {Array<{ normalizedLabel: string }>} items
 */
function isUnambiguousSingleToken(token, items) {
  let count = 0;
  for (const item of items) {
    const tokens = item.normalizedLabel.split(" ").filter(Boolean);
    if (tokens.includes(token)) {
      count += 1;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

function tokenizeCatalogMatch(value) {
  return normalizeCatalogMatchText(value).split(" ").filter(Boolean);
}

/**
 * True when a user message token is likely the same word as a catalog token (typos: Corola↔Corolla).
 * @param {string} a
 * @param {string} b
 */
function catalogTokensLikelySameWord(a, b) {
  if (a === b) return true;
  if (a.length < 3 || b.length < 3) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length / longer.length < 0.65) return false;
  if (longer.includes(shorter)) return true;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (shorter.length === longer.length) {
        i += 1;
        j += 1;
      } else if (shorter.length < longer.length) {
        j += 1;
      } else {
        i += 1;
      }
    }
  }
  edits += shorter.length - i + (longer.length - j);
  return edits <= 1;
}

/**
 * Pick best inventory row for arbitrary user text (catalog data only).
 * @param {string} userId
 * @param {string | null | undefined} rawInput
 * @param {{ catalogItems: unknown[], catalogSource?: string, conversationMemory?: Record<string, unknown> } | null} [opts]
 * @returns {Promise<{ ok: true, itemId: string, item: Record<string, unknown> } | { ok: false, reason: "no_items_or_input" | "input_invalid" | "no_match" | "error" }>}
 */
async function resolveItemFromCatalog(userId, rawInput, opts = null) {
  try {
    const rawList =
      opts && typeof opts === "object" && Array.isArray(opts.catalogItems)
        ? opts.catalogItems
        : [];
    const normalizedItems = rawList
      .filter((row) => row && typeof row === "object" && !Array.isArray(row))
      .map((row) =>
        normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row))
      );

    const catalogSourceTag =
      opts && typeof opts === "object" && typeof opts.catalogSource === "string"
        ? opts.catalogSource
        : "unknown";

    console.log("📦 Resolver source:", {
      source: catalogSourceTag,
      count: normalizedItems.length,
    });

    const input = String(rawInput ?? "").trim();
    console.log("🔎 Resolver input:", input);
    const candidateCount = normalizedItems.length;

    if (!Array.isArray(normalizedItems) || normalizedItems.length === 0) {
      console.warn("❌ EMPTY CATALOG — resolver cannot match anything");
      const out = { ok: false, reason: "no_items_or_input" };
      console.log("🔎 Resolver result:", {
        input,
        ok: out.ok,
        reason: out.reason,
        candidateCount,
      });
      return out;
    }

    if (!input || typeof input !== "string") {
      const out = { ok: false, reason: "input_invalid" };
      console.log("🔎 Resolver result:", {
        input,
        ok: out.ok,
        reason: out.reason,
        candidateCount,
      });
      return out;
    }
    const normalizedInput = normalizeLabel(input);
    if (!normalizedInput) {
      const out = { ok: false, reason: "input_invalid" };
      console.log("🔎 Resolver result:", {
        input,
        ok: out.ok,
        reason: out.reason,
        candidateCount,
      });
      return out;
    }

    const resolverItems = normalizedItems
      .filter((row) => row && typeof row === "object" && !Array.isArray(row))
      .map((row) => {
        const r = /** @type {Record<string, unknown>} */ (row);
        const id = normalizeId(r.id);
        if (!id) {
          console.error("❌ INVALID ITEM ID IN CATALOG:", r);
          return null;
        }
        const itemWithIdentity = normalizeCatalogItem({ ...r, id });
        const itemLabel = String(
          itemWithIdentity.normalizedLabel ?? buildDisplayLabel(itemWithIdentity)
        ).trim();
        const normalizedLabel = normalizeLabel(itemLabel);
        if (!normalizedLabel) return null;
        return { id, item: itemWithIdentity, normalizedLabel };
      })
      .filter((x) => x != null);

    const itemMap = new Map(
      resolverItems.map((entry) => [entry.normalizedLabel, entry])
    );
    const exact = itemMap.get(normalizedInput);
    if (exact) {
      const out = { ok: true, itemId: exact.id, item: exact.item };
      console.log("🔎 Resolver result:", {
        input,
        ok: out.ok,
        reason: null,
        candidateCount,
        itemId: out.itemId,
        path: "exact_normalized_label",
      });
      return out;
    }

    const inputTokens = normalizedInput.split(" ").filter(Boolean);
    let bestMatch = null;
    let bestScore = 0;

    for (const entry of resolverItems) {
      const itemTokens = entry.normalizedLabel.split(" ").filter(Boolean);
      const matchCount = inputTokens.filter((t) => itemTokens.includes(t)).length;
      if (matchCount > bestScore) {
        bestScore = matchCount;
        bestMatch = entry;
      }
    }

    const isSingleToken = inputTokens.length === 1;
    if (
      bestMatch &&
      (bestScore >= 2 ||
        (isSingleToken &&
          bestScore >= 1 &&
          isUnambiguousSingleToken(inputTokens[0], resolverItems)))
    ) {
      const out = { ok: true, itemId: bestMatch.id, item: bestMatch.item };
      console.log("🔎 Resolver result:", {
        input,
        ok: out.ok,
        reason: null,
        candidateCount,
        itemId: out.itemId,
        score: bestScore,
        path: "token_overlap",
      });
      return out;
    }

    const out = { ok: false, reason: "no_match" };
    console.log("🔎 Resolver result:", {
      input,
      ok: out.ok,
      reason: out.reason,
      candidateCount,
    });
    return out;
  } catch (err) {
    console.warn("⚠️ resolveItemFromCatalog failed:", err?.message || err);
    const result = { ok: false, reason: "error" };
    console.log("🔎 Resolver result:", {
      input: String(rawInput ?? "").trim(),
      ok: result.ok,
      reason: result.reason,
      candidateCount: 0,
    });
    return result;
  }
}

/**
 * Test-only wrapper: runs the same catalog resolver used by the extracted-entity fallback.
 * Intentionally avoids touching Firestore by accepting a catalog array.
 * @param {{
 *   message: string,
 *   extractedEntity: string | null,
 *   entityType?: string | null,
 *   previousCandidate?: string | null,
 *   catalogItems: unknown[],
 * }} p
 * @returns {Promise<{
 *   promoted: boolean,
 *   resolvedItemId: string | null,
 *   resolvedItemName: string | null,
 *   resolutionSource: "resolveItemFromCatalog",
 *   intent: string,
 *   usedAvailabilityBridge: boolean,
 * }>}
 */
export async function __promoteExtractedEntityToInventoryCandidateForTests(p) {
  const message = String(p?.message ?? "");
  const extractedEntity = String(p?.extractedEntity ?? "").trim();
  const entityType = String(p?.entityType ?? "item");
  const previousCandidate = String(p?.previousCandidate ?? "").trim();
  const catalogItems = Array.isArray(p?.catalogItems) ? p.catalogItems : [];
  const intent = detectIntent(message);
  const usedAvailabilityBridge = intent === "availability";

  if (previousCandidate) {
    return {
      promoted: false,
      resolvedItemId: null,
      resolvedItemName: null,
      resolutionSource: "resolveItemFromCatalog",
      intent,
      usedAvailabilityBridge: false,
    };
  }
  if (!extractedEntity || entityType === "category") {
    return {
      promoted: false,
      resolvedItemId: null,
      resolvedItemName: null,
      resolutionSource: "resolveItemFromCatalog",
      intent,
      usedAvailabilityBridge: false,
    };
  }

  const result = await resolveItemFromCatalog("test", extractedEntity, {
    catalogItems,
    catalogSource: "test",
  });
  if (!result?.ok || !normalizeId(result.itemId)) {
    return {
      promoted: false,
      resolvedItemId: null,
      resolvedItemName: null,
      resolutionSource: "resolveItemFromCatalog",
      intent,
      usedAvailabilityBridge: false,
    };
  }
  const resolvedName = String(result.item?.name ?? "").trim() || extractedEntity;
  return {
    promoted: true,
    resolvedItemId: normalizeId(result.itemId),
    resolvedItemName: resolvedName,
    resolutionSource: "resolveItemFromCatalog",
    intent,
    usedAvailabilityBridge,
  };
}

/**
 * Isolated callers (tests) without a per-turn profile list: load catalog from cache/DB once.
 * @param {string} userId
 * @param {string} mention
 * @param {{ conversationMemory?: Record<string, unknown> } | undefined} [opts]
 */
async function defaultCatalogResolveForTryResolve(userId, mention, opts) {
  const items = await getItemsForBusiness(userId);
  const normalized = items
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) =>
      normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row))
    );
  const result = await resolveItemFromCatalog(userId, mention, {
    catalogItems: normalized,
    catalogSource: "cache",
    conversationMemory: opts?.conversationMemory,
  });
  return result.ok ? result.item : null;
}

/**
 * Strong-commit path: resolve `lastItemMentioned` / name-only `lastItem` into `lastItem.id` via catalog.
 *
 * **Never replaces a stable item:** if `lastItem.id` is a **non-empty string** (type + trim), this is a
 * no-op (even when `lastItemMentioned` points at another SKU). Non-strings / empty string are not locked.
 *
 * @param {string} userId
 * @param {Record<string, unknown>} conversationMemory
 * @param {(uid: string, mention: string, opts?: { conversationMemory?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>} [resolveFn]
 * @param {(string | null | undefined)[] | null | undefined} [extraAliases] — extra labels to try if primary mention does not resolve (e.g. `lastFocusedItem`, matched reply label).
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function tryResolveLastItemFromMentionedPreCommit(
  userId,
  conversationMemory,
  resolveFn = defaultCatalogResolveForTryResolve,
  extraAliases = null
) {
  if (normalizeId(conversationMemory?.lastItem?.id)) {
    return { ok: false, reason: "already_has_item" };
  }

  const mention = String(conversationMemory?.lastItemMentioned ?? "").trim();

  if (mention.length < 3) {
    return { ok: false, reason: "mention_too_short" };
  }

  const resolvedCommit = await resolveFn(userId, mention, {
    conversationMemory,
  });
  console.log("🔎 Pre-commit → catalog try:", {
    input: mention,
    resolvedId: normalizeId(resolvedCommit?.id) || null,
    candidateIndex: 0,
  });
  if (!normalizeId(resolvedCommit?.id)) {
    return { ok: false, reason: "no_catalog_match" };
  }

  if (normalizeId(conversationMemory?.lastItem?.id)) {
    console.log(
      "⏭️ Pre-commit: skip applying resolved item — lastItem.id appeared during resolve (no override)"
    );
    return { ok: false, reason: "already_has_item" };
  }

  const rowId = /** @type {string} */ (normalizeId(resolvedCommit.id));
  const rowName = String(resolvedCommit.name ?? "").trim() || mention;
  conversationMemory.lastItem = {
    id: rowId,
    name: rowName,
    displayLabel: buildDisplayLabel(
      /** @type {Record<string, unknown>} */ (resolvedCommit)
    ),
  };
  console.log(
    "🧠 lastItem resolved from memory label (pre-commit):",
    conversationMemory.lastItem
  );
  return { ok: true, reason: "resolved" };
}

/**
 * When extraction/catalog paths left `itemContext` null but Emily matched a catalog item,
 * create `itemContext` (catalog id on match, else `resolveItemFromCatalog` by name/label).
 * @param {string} userId
 * @param {Record<string, unknown> | null} existing
 * @param {unknown} matchedItemForReply
 * @param {(input: string, memHint: Record<string, unknown> | null | undefined) => Promise<Record<string, unknown> | null>} resolveCatalog
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function ensureItemContextFromMatchedItemReply(
  userId,
  existing,
  matchedItemForReply,
  resolveCatalog
) {
  if (existing != null && typeof existing === "object") return existing;
  if (!matchedItemForReply || typeof matchedItemForReply !== "object") {
    return existing;
  }
  /** @type {Record<string, unknown>} */
  const mi = /** @type {Record<string, unknown>} */ (matchedItemForReply);

  const name =
    String(mi.name ?? "").trim() ||
    (typeof mi.displayLabel === "string" ? mi.displayLabel.trim() : "");
  if (name.length < 2) return existing;

  const resolved = await resolveCatalog(name, null);
  console.log("🔎 MatchedItem → Resolver (pre-context):", {
    input: name,
    resolvedId: resolved?.id ?? null,
  });
  if (!resolved?.id) return existing;

  const rowName = String(resolved.name ?? "").trim() || name;
  /** @type {Record<string, unknown>} */
  const ctx = {
    itemId: String(resolved.id).trim(),
    name: rowName,
    displayLabel:
      typeof mi.displayLabel === "string" && mi.displayLabel.trim() !== ""
        ? mi.displayLabel.trim()
        : buildDisplayLabel(resolved),
    availability:
      typeof resolved.availability === "boolean" ? resolved.availability : null,
  };
  console.log("🧠 itemContext CREATED from matchedItem:", ctx);
  return ctx;
}

/**
 * If `itemContext` has a name/label but no `itemId`, resolve id from catalog (deterministic).
 * @param {string} userId
 * @param {Record<string, unknown> | null} itemContext
 * @param {(input: string, memHint: Record<string, unknown> | null | undefined) => Promise<Record<string, unknown> | null>} resolveCatalog
 */
async function ensureItemContextItemId(userId, itemContext, resolveCatalog) {
  if (
    !itemContext ||
    typeof itemContext !== "object" ||
    String(itemContext.itemId ?? "").trim() !== ""
  ) {
    return;
  }
  const input =
    itemContext.name != null && String(itemContext.name).trim() !== ""
      ? String(itemContext.name).trim()
      : typeof itemContext.displayLabel === "string" &&
          itemContext.displayLabel.trim() !== ""
        ? itemContext.displayLabel.trim()
        : "";
  if (input.length < 2) return;

  const resolved = await resolveCatalog(input, null);
  console.log("🔎 ItemContext → Resolver:", {
    input,
    resolvedId: resolved?.id ?? null,
  });
  if (resolved?.id) {
    itemContext.itemId = String(resolved.id).trim();
    console.log("🧠 itemContext fixed with ID:", itemContext);
  }
}

/**
 * Persist stable item id into Emily session memory when `itemContext` has it but memory does not.
 * @param {Record<string, unknown> | null | undefined} conversationMemory
 * @param {Record<string, unknown> | null} itemContext
 */
function syncLastItemFromItemContextIfMissing(conversationMemory, itemContext) {
  if (
    !conversationMemory ||
    typeof conversationMemory !== "object" ||
    !itemContext ||
    typeof itemContext !== "object"
  ) {
    return;
  }
  const id = String(itemContext.itemId ?? "").trim();
  if (!id) return;
  if (String(conversationMemory.lastItem?.id ?? "").trim() !== "") return;

  const nameStr = String(itemContext.name ?? "").trim();
  const labelRaw =
    typeof itemContext.displayLabel === "string"
      ? itemContext.displayLabel.trim()
      : "";
  conversationMemory.lastItem = {
    id,
    name: nameStr,
    displayLabel: labelRaw || nameStr,
  };
  console.log("🧠 Memory synced from itemContext:", conversationMemory.lastItem);
}

/**
 * Emily catalog match + scoped follow-up label → `matchedItemForReply` + raw scoped label for classifier hints.
 * @param {{
 *   catalogMatch: { matchedItem?: unknown },
 *   pinnedEntityName: string | null | undefined,
 *   entityResult: { name?: unknown } | null | undefined,
 *   message: string,
 *   detectedIntent: string,
 *   shouldResetTopicContext: boolean,
 *   nextChatContext: { lastFocusedItem?: unknown },
 *   catalogRowsForStaleFocusGuard?: unknown[],
 * }} p
 * @returns {{ matchedItemForReply: unknown, fallbackScopedLabel: string }}
 */
function matchedItemForReplyFromCatalogState({
  catalogMatch,
  pinnedEntityName,
  entityResult,
  message,
  detectedIntent,
  shouldResetTopicContext,
  nextChatContext,
  catalogRowsForStaleFocusGuard = [],
}) {
  const matchedItemLabelFromTurn = labelFromMatchedItem(catalogMatch.matchedItem);
  const hasRawEntityCandidate =
    entityResult?.name != null && String(entityResult.name).trim() !== "";
  const wantsImages = detectShowImagesRequest(message);
  const messageWordCount = String(message ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const canUseScopedFollowup =
    !shouldResetTopicContext &&
    detectedIntent !== "list" &&
    detectedIntent !== "exclude" &&
    (!hasRawEntityCandidate || wantsImages) &&
    messageWordCount <= 6;
  const rows = Array.isArray(catalogRowsForStaleFocusGuard)
    ? catalogRowsForStaleFocusGuard
    : [];
  let useScopedLastFocused =
    !matchedItemLabelFromTurn &&
    !pinnedEntityName &&
    String(nextChatContext.lastFocusedItem ?? "").trim() !== "" &&
    canUseScopedFollowup;
  if (useScopedLastFocused) {
    const explicit =
      rows.length > 0
        ? hasExplicitNewItemMention(message, rows, null)
        : { found: false };
    if (explicit.found) {
      useScopedLastFocused = false;
    } else if (messageLooksLikeGenericAvailabilityTimingFollowup(message)) {
      console.log("[stale_focus_blocked_for_availability_timing]", {
        rawTextPreview: String(message ?? "").trim().slice(0, 160) || null,
        latestUserSegment: getLatestUserSegmentForGuard(message) || null,
        previousLastFocusedItem:
          String(nextChatContext.lastFocusedItem ?? "").trim() || null,
        reason: "GENERIC_AVAILABILITY_TIMING_NO_CATALOG_TOKEN",
        hasExplicitCatalogItem: explicit.found,
      });
      useScopedLastFocused = false;
    }
  }
  const fallbackScopedLabel = useScopedLastFocused
    ? String(nextChatContext.lastFocusedItem).trim()
    : "";
  const matchedItemForReply = fallbackScopedLabel
    ? {
        name: fallbackScopedLabel,
        displayLabel: fallbackScopedLabel,
      }
    : catalogMatch.matchedItem;
  return { matchedItemForReply, fallbackScopedLabel };
}

/**
 * Structured availability reply: composer by default; optional narrow AI when
 * `AVAILABILITY_AI_REPLY_ENABLED=true` and {@link isAvailabilityAiEligible} passes (Phase 2 cases only).
 * @param {{ availabilityCtx: Record<string, unknown>, userMessage: string, styleKey: "casual_local" | "neutral_english", __availabilityAiCompletionForTests?: (args: unknown) => Promise<unknown> }} p
 */
async function resolveAvailabilityCustomerReply({
  availabilityCtx,
  userMessage,
  styleKey,
  __availabilityAiCompletionForTests = null,
}) {
  const sum = availabilityCtx?.inventorySummary;
  const elig = isAvailabilityAiEligible(availabilityCtx);
  console.log("[availability_ai_eligibility_checked]", {
    caseId: elig.caseId,
    eligible: elig.eligible,
    reason: elig.reason,
    intent: availabilityCtx?.intent ?? null,
    summaryStatus: sum?.status ?? null,
    availableCount: sum?.availableCount ?? null,
    topItemCount: Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems.length : 0,
    alternativeSummarySkipped: availabilityCtx?.alternativeSummarySkipped === true,
  });

  const enabled = /^true$/i.test(String(process.env.AVAILABILITY_AI_REPLY_ENABLED ?? "").trim());
  if (!enabled || !elig.eligible) {
    const composed = composeStructuredAvailabilityCustomerReply(availabilityCtx, styleKey);
    return enforceAvailabilityTruthOnReply(composed, availabilityCtx, styleKey);
  }

  console.log("[availability_context_passed_to_ai]", {
    caseId: elig.caseId,
    intent: availabilityCtx?.intent ?? null,
    requestedItemId: availabilityCtx?.requestedItem?.itemId ?? null,
    summaryStatus: sum?.status ?? null,
    availableCount: sum?.availableCount ?? null,
    topItemCount: Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems.length : 0,
  });

  const t0 = Date.now();
  const aiRaw = await generateAvailabilityReplyFromFacts({
    availabilityContext: availabilityCtx,
    userMessage,
    styleKey,
    __chatCompletionsCreateForTests: __availabilityAiCompletionForTests,
  });
  const latencyMs = Date.now() - t0;
  console.log("[availability_ai_reply_generated]", {
    caseId: elig.caseId,
    chars: String(aiRaw ?? "").length,
    latencyMs,
  });

  const guarded = guardAvailabilityAiReply(aiRaw, availabilityCtx, styleKey);
  if (!guarded.ok) {
    console.log("[availability_ai_reply_guard_replaced]", {
      caseId: elig.caseId,
      reason: guarded.reason,
      violationSnippet: String(aiRaw ?? "").trim().slice(0, 120) || null,
      summaryStatus: sum?.status ?? null,
      availableCount: sum?.availableCount ?? null,
      topItemCount: Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems.length : 0,
    });
    console.log("[availability_structured_fallback_used]", {
      caseId: elig.caseId,
      reason: guarded.reason,
    });
  } else {
    console.log("[availability_ai_reply_guard_passed]", {
      caseId: elig.caseId,
      mentionedLabelCount: guarded.mentionedTopCount ?? 0,
    });
  }

  return enforceAvailabilityTruthOnReply(guarded.reply, availabilityCtx, styleKey);
}

/**
 * Emily Brain entry point (channel-agnostic).
 * Uses OpenAI gpt-4o-mini via generateReply() in openai.js (business knowledge + history), not a raw single-line completion.
 * Static fallback only when there is no business profile AND no conversation history; otherwise always OpenAI.
 *
 * @param {object} opts
 * @param {string} opts.userId - Business owner Firebase uid (knowledge / inventory)
 * @param {string} opts.message
 * @param {string} [opts.sessionKey] - Chat thread id for memory (e.g. owner::customer WA id)
 * @param {string} [opts.conversationHistory] - Pre-built history text (e.g. from Firestore); overrides memory for prompt
 * @param {number} [opts.fragmentCount] - WhatsApp fragments merged into this user turn (default 1)
 * @param {boolean} [opts.hasMultipleFragments] - fragmentCount > 1
 * @param {boolean} [opts.isGreetingFirst] - first fragment looked like a greeting opener
 * @param {"whatsapp"|"other"} [opts.replyChannel] - WhatsApp replies get professional tone polish (default whatsapp)
 * @param {boolean} [opts.isGroupInbound] - Playwright group thread (unknown user phone); enables hybrid Playwright/Cloud routing
 * @param {boolean} [opts.playwrightWebInbound] - Playwright Web tab inbound from pipeline bridge (group or individual)
 * @param {string} [opts.participantPhoneForDm] - E.164 digits when known (Cloud API DM from group)
 * @param {string[]} [opts.contextMessages] - recent inbound user lines before latest
 * @param {string | null} [opts.inboundIntent] - classifier intent (Playwright bridge)
 * @param {string | null} [opts.inboundEntity] - classifier entity pin (Playwright bridge)
 * @param {boolean} [opts.resetTopicContext] - clear sticky thread focus (topic switch)
 * @param {string | null} [opts.playwrightChatKey] - normalized WA chat key (Playwright); clears listener anchor on reset
 * @param {string | null} [opts.groupName] - optional WhatsApp group/chat label for booking metadata
 * @param {string | null} [opts.participantName] - visible group participant name when available
 * @param {string | null} [opts.participantKey] - stable participant-scoped key for group memory/routing
 * @param {string | null} [opts.senderScope] - hashed per-group participant scope when available
 * @param {string | null} [opts.sourceRowKey] - Playwright DOM row key for the triggering inbound message
 * @param {number | null} [opts.sourceMessageIndex] - Playwright DOM message index for the triggering inbound message
 * @param {Function | null} [opts.__genericSlotProposalForTests] - deterministic slot proposal hook for tests
 * @param {Function | null} [opts.__availabilityAiCompletionForTests] - mock OpenAI chat.completions.create for narrow availability AI tests
 * @param {string} [opts.traceId] - booking-flow trace id (from executeWhatsAppAiPipeline)
 */
// Deprecated live brain. Do not add new decision logic.
// V2 live path must not call this when EMILY_BRAIN_V2_LIVE is enabled.
export async function processMessage({
  traceId: traceIdIn,
  userId,
  message: inboundRaw,
  messageId,
  source = "cloud",
  timestamp = Date.now(),
  sessionKey,
  bookingHint = null,
  conversationHistory,
  fragmentCount = 1,
  hasMultipleFragments = false,
  isGreetingFirst = false,
  replyChannel = "whatsapp",
  isGroupInbound = false,
  isGroupMessage = false,
  whatsappRecipientType = null,
  playwrightWebInbound = false,
  participantPhoneForDm,
  contextMessages = [],
  inboundIntent = null,
  inboundEntity = null,
  resetTopicContext = false,
  playwrightChatKey = null,
  groupName = null,
  participantName = null,
  participantKey = null,
  senderScope = null,
  sourceRowKey = null,
  sourceMessageIndex = null,
  inboundSourceOrigin = INBOUND_SOURCE_REAL_CUSTOMER,
  __genericSlotProposalForTests = null,
  __availabilityAiCompletionForTests = null,
}) {
  const traceId =
    traceIdIn != null && String(traceIdIn).trim() !== ""
      ? String(traceIdIn).trim()
      : randomUUID();
  let routeTypeForProcessMessageLog = null;
  try {
    const flowId = traceId;
    const DEBUG_EXTRACT =
      process.env.DEBUG_EXTRACT === "true" || process.env.DEBUG_EXTRACT === "1";

    const emit = (tag, data = {}, level = "log") => {
      const payload =
        data && typeof data === "object" && !Array.isArray(data) ? data : { value: data };
      const out = { flowId, ...payload };
      if (level === "warn") console.warn(`[${tag}]`, out);
      else if (level === "error") console.error(`[${tag}]`, out);
      else console.log(`[${tag}]`, out);
    };

    const processStartedAt = Date.now();
    const logTiming = (stage, startedAt, extra = {}) => {
      console.log("[latency]", {
        traceId,
        stage,
        durationMs: Date.now() - startedAt,
        totalMs: Date.now() - processStartedAt,
        ...extra,
      });
    };
    const timeAsync = async (stage, fn, extra = {}) => {
      const startedAt = Date.now();
      try {
        return await fn();
      } finally {
        logTiming(stage, startedAt, extra);
      }
    };
    if (!messageId) {
      throw new Error("Invariant violation: messageId missing after normalization");
    }

  const selectedForAi = selectLatestInboundForAi(inboundRaw);
  if (!selectedForAi) {
    if (
      String(source ?? "").trim() === "PLAYWRIGHT_DM" ||
      (playwrightWebInbound === true && isGroupInbound === false && bookingHint)
    ) {
      console.log("[booking_dm_generic_fallback_suppressed]", {
        bookingId: String(bookingHint?.bookingId ?? "").trim() || null,
        dmChatKey: String(sessionKey ?? "").split("dm::").pop()?.trim() || null,
        reason: "EMPTY_MESSAGE_TEXT",
        messageId: String(messageId ?? "").trim() || null,
        lastProcessedMessageId: null,
        approvalStage: null,
        logisticsComplete: false,
      });
    }
    emit("FLOW_END", { reason: "NO_VALID_USER_MESSAGE" });
    return applyHybridOutboundResult(
      {
        reply: "",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(false),
      },
      {
        isGroupInbound: Boolean(isGroupInbound),
        message: String(inboundRaw ?? "").trim(),
        participantPhoneForDm,
        playwrightWebInbound: Boolean(playwrightWebInbound),
      }
    );
  }

  const rawInboundMessage = selectedForAi;
  let message = rawInboundMessage;
  if (String(inboundSourceOrigin ?? INBOUND_SOURCE_REAL_CUSTOMER) !== INBOUND_SOURCE_REAL_CUSTOMER) {
    emit("INBOUND_ORIGIN_BLOCKED", {
      inboundSourceOrigin: String(inboundSourceOrigin ?? ""),
      messagePreview: String(message ?? "").slice(0, 120),
    });
    return applyHybridOutboundResult(
      {
        reply: "",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(false),
      },
      {
        isGroupInbound: Boolean(isGroupInbound),
        message: String(inboundRaw ?? "").trim(),
        participantPhoneForDm,
        playwrightWebInbound: Boolean(playwrightWebInbound),
      }
    );
  }
  emit("NEW_MESSAGE", {
    messageId: String(messageId),
    source,
    timestamp,
    isGroupInbound: Boolean(isGroupInbound),
    playwrightWebInbound: Boolean(playwrightWebInbound),
    playwrightChatKey: String(playwrightChatKey ?? "").trim() || null,
    groupName: String(groupName ?? "").trim() || null,
    participantKey: String(participantKey ?? "").trim() || null,
  });

  /** @type {string | null} */
  let forcedIntent = null;
  {
    const lower = message.toLowerCase();
    if (/available|price|cost|rate/i.test(lower)) {
      forcedIntent = "inquiry";
    }
  }

  const normalizedWhatsappRecipientType =
    String(whatsappRecipientType ?? "").trim().toLowerCase() === "group"
      ? "group"
      : String(whatsappRecipientType ?? "").trim() || null;
  const effectiveIsGroupMessage = Boolean(
    isGroupMessage ||
      isGroupInbound ||
      normalizedWhatsappRecipientType === "group"
  );
  const routingCtx = {
    isGroupInbound: Boolean(isGroupInbound),
    isGroupMessage: effectiveIsGroupMessage,
    message,
    participantPhoneForDm,
    playwrightWebInbound: Boolean(playwrightWebInbound),
    groupName: String(groupName ?? "").trim() || null,
    chatKey: String(playwrightChatKey ?? groupName ?? sessionKey ?? "").trim() || null,
    playwrightChatKey: String(playwrightChatKey ?? "").trim() || null,
    whatsappRecipientType: normalizedWhatsappRecipientType,
    flowId,
  };
  const bookingInboundGuard = {
    inboundSourceOrigin,
    inboundMessage: message,
    playwrightChatKey,
    groupName,
  };

  const logisticsCompletionPolicy = resolveLogisticsCompletionPolicy();

  /**
   * @param {{ bookingId: string, booking: Record<string, unknown>, isComplete: boolean, source: "FSM" | "parser" }} args
   */
  const logLogisticsCompletionEvaluated = ({
    bookingId,
    booking,
    isComplete,
    source,
  }) => {
    const method = String(booking?.deliveryMethod ?? "").trim() || null;
    const address = String(booking?.deliveryAddress ?? "").trim() || null;
    const time = String(booking?.deliveryTime ?? "").trim() || null;
    const contact =
      String(booking?.customerPhone ?? booking?.contactPhone ?? "").trim() ||
      null;
    console.log("[logistics_completion_evaluated]", {
      bookingId,
      method,
      address,
      time,
      contact,
      isComplete,
      source,
    });
  };

  const buildLogisticsCompletionPatch = ({
    bookingId,
    booking,
    patch,
    sourcePath,
  }) => {
    const merged = { ...(booking || {}), ...(patch || {}) };
    const completionPatch = buildBookingLogisticsCompletionPatch(
      booking,
      patch,
      logisticsCompletionPolicy
    );
    const completion = completionPatch.completion;
    if (completion.complete) {
      Object.assign(patch, completionPatch.patch);
      console.log("[booking_dm_logistics_completed]", {
        bookingId,
        approvalStageBefore:
          String(booking?.approvalStage ?? "").trim() || null,
        approvalStageAfter: "delivery_details_collected",
        deliveryMethod: String(merged?.deliveryMethod ?? "").trim() || null,
        hasDeliveryAddress: String(merged?.deliveryAddress ?? "").trim() !== "",
        hasDeliveryTime: String(merged?.deliveryTime ?? "").trim() !== "",
        requireContactForCompletion: completion.requireContact === true,
        completionReason: completion.reason,
        sourcePath,
      });
    }
    return { completion, merged };
  };

  const noOutboundResult = ({
    reason,
    bookingId = null,
    dmChatKey = null,
    messageIdForLog = null,
    lastProcessedMessageId = null,
    approvalStage = null,
    logisticsComplete = false,
  } = {}) => {
    console.log("[booking_dm_generic_fallback_suppressed]", {
      bookingId: bookingId || null,
      dmChatKey: dmChatKey || null,
      reason,
      messageId: messageIdForLog || null,
      lastProcessedMessageId: lastProcessedMessageId || null,
      approvalStage: approvalStage || null,
      logisticsComplete: logisticsComplete === true,
    });
    return {
      handled: true,
      suppressOutbound: true,
      replyText: "",
      bookingId: bookingId || null,
    };
  };

  async function handleBookingConversationState(ctx = {}) {
    const finalizeBookingStateReply = (text) => finalizeBookingFsmCustomerReply(text);

    const isPotentialContinuation =
      String(ctx?.source ?? "").trim() === "PLAYWRIGHT_DM" ||
      (ctx?.playwrightWebInbound === true && ctx?.isGroupInbound === false);
    if (!isPotentialContinuation) return { handled: false };

    const hint =
      ctx?.bookingHint && typeof ctx.bookingHint === "object" ? ctx.bookingHint : null;
    const bookingId = hint ? String(hint.bookingId ?? "").trim() : "";
    if (!bookingId) {
      console.log("[booking_state_missing_booking_hint]", {
        source: String(ctx?.source ?? "").trim() || null,
        playwrightWebInbound: ctx?.playwrightWebInbound === true,
        isGroupInbound: ctx?.isGroupInbound === true,
        dmPlaywrightChatKey: String(ctx?.dmPlaywrightChatKey ?? "").trim() || null,
        dmChatTitle: String(ctx?.dmChatTitle ?? "").trim() || null,
        rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
      });
      return { handled: false };
    }

    let booking = null;
    try {
      const snap = await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .get();
      booking = snap?.exists ? snap.data() || {} : null;
    } catch {
      booking = null;
    }
    if (!booking) return { handled: false };

    const status = String(booking?.status ?? "").trim();
    const approvalStage = String(booking?.approvalStage ?? "").trim();
    const stageKey = approvalStage.toLowerCase();

    const deliveryMethod = String(booking?.deliveryMethod ?? "").trim().toLowerCase();
    const deliveryAddress = String(booking?.deliveryAddress ?? "").trim();
    const deliveryTime = String(booking?.deliveryTime ?? "").trim();
    const hasDeliveryDetailsCollectedAt = Boolean(booking?.deliveryDetailsCollectedAt);
    const hasContact =
      String(booking?.customerPhone ?? "").trim() !== "" ||
      String(booking?.contactPhone ?? "").trim() !== "";
    const logisticsState = getBookingLogisticsCompletionState(
      booking,
      logisticsCompletionPolicy
    );

    /** @type {string} */
    let canonicalState = "inactive";
    if (status !== "approved") {
      canonicalState = "inactive";
    } else if (hasDeliveryDetailsCollectedAt || logisticsState.complete) {
      canonicalState = "delivery_details_collected";
    } else if (!deliveryMethod) {
      canonicalState = "awaiting_delivery_method";
    } else if (deliveryMethod === "delivery" && !deliveryAddress) {
      canonicalState = "awaiting_delivery_location";
    } else if (
      deliveryMethod === "delivery" &&
      Boolean(deliveryAddress) &&
      !deliveryTime
    ) {
      canonicalState = "awaiting_delivery_time";
    } else if (deliveryMethod === "pickup" && !deliveryTime) {
      // Pickup uses the same `deliveryTime` field today (no separate pickupTime in schema).
      canonicalState = "awaiting_delivery_time";
    } else if (deliveryTime && !hasContact) {
      canonicalState = "awaiting_contact";
    } else {
      canonicalState = "ready_to_finalize";
    }

    console.log("[booking_state_resolution_debug]", {
      bookingId,
      deliveryMethod: deliveryMethod || null,
      deliveryAddress: deliveryAddress || null,
      deliveryTime: deliveryTime || null,
      resolvedState: canonicalState,
    });

    console.log("[booking_state_detected]", {
      bookingId,
      status: status || null,
      approvalStage: approvalStage || null,
      canonicalState,
      source: String(ctx?.source ?? "").trim() || null,
      playwrightWebInbound: ctx?.playwrightWebInbound === true,
      isGroupInbound: ctx?.isGroupInbound === true,
      sessionKey: String(ctx?.sessionKey ?? "").trim() || null,
      rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
    });

    // Step 2-4: handle delivery-detail states for Playwright DM continuation only.
    const allowHandleDeliveryDetailStates = Boolean(
      ctx?.playwrightWebInbound === true &&
        ctx?.isGroupInbound === false &&
        status === "approved"
    );
    if (allowHandleDeliveryDetailStates) {
      const logistics = await loadBusinessLogisticsForUser(ctx?.userId);
      const logisticsQuestion = buildLogisticsQuestionReplyFromProfile(
        String(ctx?.message ?? ""),
        logistics
      );
      if (logisticsQuestion.handled) {
        const replyText =
          canonicalState === "awaiting_delivery_method"
            ? appendDeliveryMethodChoicePrompt(logisticsQuestion.reply)
            : logisticsQuestion.reply;
        console.log("[booking_logistics_question_answered]", {
          bookingId,
          kind: logisticsQuestion.kind,
          hasPickupLocation: Boolean(logistics.defaultPickupLocation),
          deliveryCoverageCount: Array.isArray(logistics.deliveryCoverageAreas)
            ? logistics.deliveryCoverageAreas.length
            : 0,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply(replyText),
          updatedBookingFields: {},
          nextState: canonicalState,
          bookingId,
        };
      }
      if (isInformationalItemQuestion(String(ctx?.message ?? ""))) {
        const replyText = buildBookingInformationalFallbackReply(
          String(ctx?.message ?? ""),
          booking
        );
        console.log("[booking_informational_question_answered_before_logistics]", {
          bookingId,
          canonicalState,
          rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply(replyText),
          updatedBookingFields: {},
          nextState: canonicalState,
          bookingId,
        };
      }
    }
    if (
      allowHandleDeliveryDetailStates &&
      canonicalState === "delivery_details_collected"
    ) {
      return noOutboundResult({
        reason: logisticsState.complete
          ? "BOOKING_LOGISTICS_ALREADY_COMPLETE"
          : "BOOKING_DETAILS_ALREADY_COLLECTED",
        bookingId,
        dmChatKey: String(
          ctx?.dmPlaywrightChatKey ?? ctx?.dmChatTitle ?? ""
        ).trim() || null,
        messageIdForLog: String(ctx?.messageId ?? "").trim() || null,
        approvalStage,
        logisticsComplete: logisticsState.complete,
      });
    }
    if (
      allowHandleDeliveryDetailStates &&
      canonicalState === "awaiting_delivery_method"
    ) {
      console.log("[booking_state_handler_invoked]", {
        bookingId,
        state: "awaiting_delivery_method",
        handler: "handleAwaitingDeliveryMethod",
      });

      let llmAccepted = {};
      try {
        console.log("[booking_slot_llm_extraction_started]", {
          bookingId,
          state: "awaiting_delivery_method",
        });
        const llmOut = await applyBookingSlotLlmExtraction({
          state: "awaiting_delivery_method",
          messageText: String(ctx?.message ?? ""),
          booking,
          participantPhoneForDm: ctx?.participantPhoneForDm,
          sessionKey: ctx?.sessionKey,
        });
        llmAccepted = llmOut.accepted || {};
        console.log("[booking_slot_llm_extraction_result]", {
          bookingId,
          state: "awaiting_delivery_method",
          acceptedKeys: Object.keys(llmAccepted),
          reason: String(llmOut?.llm?.reason ?? "") || null,
        });
      } catch (err) {
        console.log("[booking_slot_llm_extraction_failed]", {
          bookingId,
          state: "awaiting_delivery_method",
          reason: String(err?.message ?? err ?? "LLM_FAILED"),
        });
      }

      const interpreted = interpretDeliveryMethodMessage(String(ctx?.message ?? ""));
      const validated = validateBookingSlotForState({
        state: "awaiting_delivery_method",
        messageText: String(ctx?.message ?? ""),
        llmSlots: {
          deliveryMethod: llmAccepted.deliveryMethod || interpreted.method || null,
          deliveryAddress: llmAccepted.deliveryAddress || interpreted.location || null,
        },
        booking,
      });
      if (validated?.nextReplyOverride) {
        if (validated.accepted?.deliveryLocationHint) {
          const now = new Date();
          const update = {
            deliveryConversationStarted: true,
            deliveryArea: validated.accepted.deliveryArea || validated.accepted.deliveryLocationHint,
            deliveryLocationHint: validated.accepted.deliveryLocationHint,
            ...(validated.accepted.deliveryMethod ? { deliveryMethod: validated.accepted.deliveryMethod } : {}),
            updatedAt: now,
            ...(booking?.dmStartedAt ? {} : { dmStartedAt: now }),
          };
          await db
            .collection("businesses")
            .doc(String(ctx.userId))
            .collection("bookings")
            .doc(bookingId)
            .update(update);
          console.log("[booking_delivery_area_hint_detected]", {
            bookingId,
            rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
            normalizedArea: validated.accepted.deliveryLocationHint,
            canonicalState,
            savedAsCompleteAddress: false,
            nextPrompt: validated.nextReplyOverride,
          });
          console.log("[booking_delivery_address_incomplete_area_only]", {
            bookingId,
            rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
            normalizedArea: validated.accepted.deliveryLocationHint,
            canonicalState,
            savedAsCompleteAddress: false,
            nextPrompt: validated.nextReplyOverride,
          });
          return {
            handled: true,
            replyText: finalizeBookingStateReply(validated.nextReplyOverride),
            updatedBookingFields: update,
            nextState: validated.accepted.deliveryMethod === "delivery" ? "awaiting_delivery_location" : "awaiting_delivery_method",
            bookingId,
          };
        }
        return {
          handled: true,
          replyText: finalizeBookingStateReply(validated.nextReplyOverride),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_method",
          bookingId,
        };
      }
      interpreted.method = validated.accepted.deliveryMethod || interpreted.method;
      const acceptedAddr = validated.accepted.deliveryAddress;
      interpreted.location =
        acceptedAddr != null && String(acceptedAddr).trim() !== ""
          ? String(acceptedAddr).trim()
          : null;
      console.log("[booking_state_message_interpreted]", {
        bookingId,
        state: "awaiting_delivery_method",
        rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
        method: interpreted.method,
        location: interpreted.location,
        confidence: interpreted.confidence,
      });

      if (!interpreted.method) {
        const ackOnly = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(
          String(ctx?.message ?? "").trim().toLowerCase()
        );
        return {
          handled: true,
          replyText: finalizeBookingStateReply(
            buildDeliveryMethodChoicePrompt({ acknowledgement: ackOnly })
          ),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_method",
          bookingId,
        };
      }

      const now = new Date();
      const update = {
        deliveryMethod: interpreted.method,
        deliveryConversationStarted: true,
        updatedAt: now,
        ...(booking?.dmStartedAt ? {} : { dmStartedAt: now }),
      };
      if (interpreted.method === "delivery" && interpreted.location) {
        update.deliveryAddress = interpreted.location;
      }
      const { completion: methodCompletion } = buildLogisticsCompletionPatch({
        bookingId,
        booking,
        patch: update,
        sourcePath: "booking_state.awaiting_delivery_method",
      });
      logLogisticsCompletionEvaluated({
        bookingId,
        booking: { ...booking, ...update },
        isComplete: methodCompletion.complete,
        source: "FSM",
      });

      // Persist update before replying.
      await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .update(update);

      const updatedFields = Object.keys(update);
      const fromState = "awaiting_delivery_method";
      let nextState = "awaiting_delivery_method";
      let replyText = "";
      if (methodCompletion.complete) {
        nextState = "delivery_details_collected";
        replyText = "Details complete hain. Booking set hai.";
      } else if (interpreted.method === "pickup") {
        nextState = "awaiting_delivery_time";
        replyText = "Pickup noted. Kis time lena chahenge?";
      } else {
        if (interpreted.location) {
          nextState = "awaiting_delivery_time";
          replyText = `${interpreted.location} noted 👍 Delivery ka time kya rakhna hai?`;
        } else {
          nextState = "awaiting_delivery_location";
          replyText = validated.ambiguous?.includes("invalid_delivery_address")
            ? "Delivery karni hai, address/area thora clear bata dein?"
            : "Delivery noted. Location/address share kar dein.";
        }
      }

      console.log("[booking_state_transition]", {
        bookingId,
        fromState,
        toState: nextState,
        updatedFields,
      });

      return {
        handled: true,
        replyText: finalizeBookingStateReply(replyText),
        updatedBookingFields: update,
        nextState,
        bookingId,
      };
    }

    if (
      allowHandleDeliveryDetailStates &&
      canonicalState === "awaiting_delivery_location"
    ) {
      console.log("[booking_state_handler_invoked]", {
        bookingId,
        state: "awaiting_delivery_location",
        handler: "handleAwaitingDeliveryLocation",
      });

      const rawText = String(ctx?.message ?? "");
      let llmAccepted = {};
      try {
        console.log("[booking_slot_llm_extraction_started]", {
          bookingId,
          state: "awaiting_delivery_location",
        });
        const llmOut = await applyBookingSlotLlmExtraction({
          state: "awaiting_delivery_location",
          messageText: rawText,
          booking,
          participantPhoneForDm: ctx?.participantPhoneForDm,
          sessionKey: ctx?.sessionKey,
        });
        llmAccepted = llmOut.accepted || {};
        console.log("[booking_slot_llm_extraction_result]", {
          bookingId,
          state: "awaiting_delivery_location",
          acceptedKeys: Object.keys(llmAccepted),
          reason: String(llmOut?.llm?.reason ?? "") || null,
        });
      } catch (err) {
        console.log("[booking_slot_llm_extraction_failed]", {
          bookingId,
          state: "awaiting_delivery_location",
          reason: String(err?.message ?? err ?? "LLM_FAILED"),
        });
      }
      const candidateAddress =
        String(llmAccepted.deliveryAddress ?? "").trim() ||
        extractLocationSlotFromDeliveryText(rawText) ||
        null;
      const validated = validateBookingSlotForState({
        state: "awaiting_delivery_location",
        messageText: rawText,
        llmSlots: { deliveryAddress: candidateAddress },
        booking,
      });
      if (validated?.nextReplyOverride) {
        if (validated.accepted?.deliveryLocationHint) {
          const now = new Date();
          const update = {
            deliveryArea: validated.accepted.deliveryArea || validated.accepted.deliveryLocationHint,
            deliveryLocationHint: validated.accepted.deliveryLocationHint,
            deliveryConversationStarted: true,
            updatedAt: now,
            ...(booking?.dmStartedAt ? {} : { dmStartedAt: now }),
          };
          await db
            .collection("businesses")
            .doc(String(ctx.userId))
            .collection("bookings")
            .doc(bookingId)
            .update(update);
          console.log("[booking_delivery_area_hint_detected]", {
            bookingId,
            rawTextPreview: String(rawText).trim().slice(0, 160) || null,
            normalizedArea: validated.accepted.deliveryLocationHint,
            canonicalState,
            savedAsCompleteAddress: false,
            nextPrompt: validated.nextReplyOverride,
          });
          console.log("[booking_delivery_address_incomplete_area_only]", {
            bookingId,
            rawTextPreview: String(rawText).trim().slice(0, 160) || null,
            normalizedArea: validated.accepted.deliveryLocationHint,
            canonicalState,
            savedAsCompleteAddress: false,
            nextPrompt: validated.nextReplyOverride,
          });
          return {
            handled: true,
            replyText: finalizeBookingStateReply(validated.nextReplyOverride),
            updatedBookingFields: update,
            nextState: "awaiting_delivery_location",
            bookingId,
          };
        }
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_delivery_location",
          toState: "awaiting_delivery_location",
          extracted: { location: null },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply(validated.nextReplyOverride),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_location",
          bookingId,
        };
      }
      const location = String(validated?.accepted?.deliveryAddress ?? "").trim();
      console.log("[booking_state_message_interpreted]", {
        bookingId,
        state: "awaiting_delivery_location",
        rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        location: location || null,
      });

      if (!location) {
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_delivery_location",
          toState: "awaiting_delivery_location",
          extracted: { location: null },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });
        const clarify = validated.ambiguous?.includes("invalid_delivery_address")
          ? "Delivery karni hai, address/area thora clear bata dein?"
          : "Location/address thoda clear bata dein.";
        return {
          handled: true,
          replyText: finalizeBookingStateReply(clarify),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_location",
          bookingId,
        };
      }

      const now = new Date();
      const update = {
        deliveryAddress: location,
        deliveryConversationStarted: true,
        updatedAt: now,
        ...(booking?.dmStartedAt ? {} : { dmStartedAt: now }),
      };
      const { completion: locationCompletion } = buildLogisticsCompletionPatch({
        bookingId,
        booking,
        patch: update,
        sourcePath: "booking_state.awaiting_delivery_location",
      });
      logLogisticsCompletionEvaluated({
        bookingId,
        booking: { ...booking, ...update },
        isComplete: locationCompletion.complete,
        source: "FSM",
      });

      await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .update(update);

      const fromState = "awaiting_delivery_location";
      const nextState = locationCompletion.complete
        ? "delivery_details_collected"
        : "awaiting_delivery_time";
      const replyText = locationCompletion.complete
        ? "Details complete hain. Booking set hai."
        : `${location} noted 👍 Delivery ka time kya rakhna hai?`;

      console.log("[booking_state_transition]", {
        bookingId,
        fromState,
        toState: nextState,
        extracted: { deliveryAddress: location },
        rawTextPreview: String(rawText).trim().slice(0, 160) || null,
      });

      return {
        handled: true,
        replyText: finalizeBookingStateReply(replyText),
        updatedBookingFields: update,
        nextState,
        bookingId,
      };
    }

    if (
      allowHandleDeliveryDetailStates &&
      canonicalState === "awaiting_delivery_time"
    ) {
      console.log("[booking_state_handler_invoked]", {
        bookingId,
        state: "awaiting_delivery_time",
        handler: "handleAwaitingDeliveryTime",
      });

      const rawText = String(ctx?.message ?? "");
      let llmAccepted = {};
      try {
        console.log("[booking_slot_llm_extraction_started]", {
          bookingId,
          state: "awaiting_delivery_time",
        });
        const llmOut = await applyBookingSlotLlmExtraction({
          state: "awaiting_delivery_time",
          messageText: rawText,
          booking,
          participantPhoneForDm: ctx?.participantPhoneForDm,
          sessionKey: ctx?.sessionKey,
        });
        llmAccepted = llmOut.accepted || {};
        console.log("[booking_slot_llm_extraction_result]", {
          bookingId,
          state: "awaiting_delivery_time",
          acceptedKeys: Object.keys(llmAccepted),
          reason: String(llmOut?.llm?.reason ?? "") || null,
        });
      } catch (err) {
        console.log("[booking_slot_llm_extraction_failed]", {
          bookingId,
          state: "awaiting_delivery_time",
          reason: String(err?.message ?? err ?? "LLM_FAILED"),
        });
      }

      const interpreted = extractDeliveryTime(rawText);
      const candidateTime =
        String(llmAccepted.deliveryTime ?? "").trim() ||
        String(interpreted.timeText ?? "").trim() ||
        null;
      const validated = validateBookingSlotForState({
        state: "awaiting_delivery_time",
        messageText: rawText,
        llmSlots: { deliveryTime: candidateTime },
        booking,
      });
      if (validated?.nextReplyOverride) {
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_delivery_time",
          toState: "awaiting_delivery_time",
          extracted: { deliveryTime: null },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply(validated.nextReplyOverride),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_time",
          bookingId,
        };
      }
      if (!interpreted.timeText && String(validated?.accepted?.deliveryTime ?? "").trim()) {
        interpreted.timeText = String(validated.accepted.deliveryTime).trim();
        interpreted.confidence = "medium";
      }
      console.log("[booking_state_message_interpreted]", {
        bookingId,
        state: "awaiting_delivery_time",
        rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        timeText: interpreted.timeText,
        confidence: interpreted.confidence,
      });

      if (!interpreted.timeText || interpreted.confidence === "low") {
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_delivery_time",
          toState: "awaiting_delivery_time",
          extracted: { deliveryTime: null },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply("Delivery ka time kya rakhna hai? (e.g. kal 5 baje)"),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_time",
          bookingId,
        };
      }

      const now = new Date();
      const update = {
        deliveryTime: String(interpreted.timeText).trim(),
        updatedAt: now,
      };
      const { completion: timeCompletion } = buildLogisticsCompletionPatch({
        bookingId,
        booking,
        patch: update,
        sourcePath: "booking_state.awaiting_delivery_time",
      });
      logLogisticsCompletionEvaluated({
        bookingId,
        booking: { ...booking, ...update },
        isComplete: timeCompletion.complete,
        source: "FSM",
      });

      await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .update(update);

      const fromState = "awaiting_delivery_time";
      const nextState = timeCompletion.complete
        ? "delivery_details_collected"
        : "awaiting_contact";
      const replyText = timeCompletion.complete
        ? "Details complete hain. Booking set hai."
        : "Time note kar liya. Contact number share kar dein.";

      console.log("[booking_state_transition]", {
        bookingId,
        fromState,
        toState: nextState,
        extracted: { deliveryTime: update.deliveryTime },
        rawTextPreview: String(rawText).trim().slice(0, 160) || null,
      });

      return {
        handled: true,
        replyText: finalizeBookingStateReply(replyText),
        updatedBookingFields: update,
        nextState,
        bookingId,
      };
    }

    if (allowHandleDeliveryDetailStates && canonicalState === "awaiting_contact") {
      console.log("[booking_state_handler_invoked]", {
        bookingId,
        state: "awaiting_contact",
        handler: "handleAwaitingContact",
      });

      const rawText = String(ctx?.message ?? "");
      const resolved = resolveBookingContactPhone({
        booking,
        participantPhoneForDm: ctx?.participantPhoneForDm,
        sessionKey: ctx?.sessionKey,
      });
      console.log("[booking_state_contact_resolved]", {
        bookingId,
        resolved: Boolean(resolved?.phone),
        source: String(resolved?.source ?? "none"),
      });

      let finalPhone = resolved.phone;
      let finalSource = resolved.source;

      if (!finalPhone) {
        let llmAccepted = {};
        try {
          console.log("[booking_slot_llm_extraction_started]", {
            bookingId,
            state: "awaiting_contact",
          });
          const llmOut = await applyBookingSlotLlmExtraction({
            state: "awaiting_contact",
            messageText: rawText,
            booking,
            participantPhoneForDm: ctx?.participantPhoneForDm,
            sessionKey: ctx?.sessionKey,
          });
          llmAccepted = llmOut.accepted || {};
          console.log("[booking_slot_llm_extraction_result]", {
            bookingId,
            state: "awaiting_contact",
            acceptedKeys: Object.keys(llmAccepted),
            reason: String(llmOut?.llm?.reason ?? "") || null,
          });
        } catch (err) {
          console.log("[booking_slot_llm_extraction_failed]", {
            bookingId,
            state: "awaiting_contact",
            reason: String(err?.message ?? err ?? "LLM_FAILED"),
          });
        }

        const llmPhone = String(llmAccepted.contactPhone ?? "").trim();
        // Try extracting from the current user message (rule-based).
        const parsed = parseDeliveryDetails(rawText);
        const fromParser = normalizePhoneDigits(parsed?.contactPhone);
        const fromRegex = extractContactPhoneFromText(rawText);
        const validated = validateBookingSlotForState({
          state: "awaiting_contact",
          messageText: rawText,
          llmSlots: { contactPhone: fromParser || fromRegex || llmPhone || null },
          booking,
        });
        const validatedPhone = String(validated?.accepted?.contactPhone ?? "").trim();
        finalPhone = validatedPhone || null;
        finalSource =
          fromParser || fromRegex
            ? "message.phone"
            : validatedPhone
              ? "validated.contactPhone"
              : "none";
        console.log("[booking_state_contact_resolved]", {
          bookingId,
          resolved: Boolean(finalPhone),
          source: finalSource,
        });
      }

      if (!finalPhone) {
        // No phone after validation; ask again.
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_contact",
          toState: "awaiting_contact",
          extracted: { customerPhone: null },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });
        return {
          handled: true,
          replyText: finalizeBookingStateReply("Contact number share kar dein."),
          updatedBookingFields: {},
          nextState: "awaiting_contact",
          bookingId,
        };
      }

      // Finalize as before (approvalStage only when unified logistics rule passes).
      if (finalPhone) {
        const mergedForComplete = {
          ...booking,
          customerPhone: finalPhone,
          ...(String(booking?.contactPhone ?? "").trim()
            ? {}
            : { contactPhone: finalPhone }),
        };
        const isComplete = isLogisticsComplete(
          mergedForComplete,
          logisticsCompletionPolicy
        );
        logLogisticsCompletionEvaluated({
          bookingId,
          booking: mergedForComplete,
          isComplete,
          source: "FSM",
        });

        const now = new Date();
        const patch = {
          customerPhone: finalPhone,
          ...(String(booking?.contactPhone ?? "").trim() ? {} : { contactPhone: finalPhone }),
          updatedAt: now,
        };
        buildLogisticsCompletionPatch({
          bookingId,
          booking,
          patch,
          sourcePath: "booking_state.awaiting_contact",
        });
        await db
          .collection("businesses")
          .doc(String(ctx.userId))
          .collection("bookings")
          .doc(bookingId)
          .update(patch);

        const toState = isComplete
          ? "delivery_details_collected"
          : "awaiting_contact";
        console.log("[booking_state_transition]", {
          bookingId,
          fromState: "awaiting_contact",
          toState,
          extracted: { customerPhone: finalPhone, source: finalSource },
          rawTextPreview: String(rawText).trim().slice(0, 160) || null,
        });

        return {
          handled: true,
          replyText: finalizeBookingStateReply(
            isComplete
              ? "Details complete hain. Booking set hai."
              : "Contact number note kar liya 👍"
          ),
          updatedBookingFields: patch,
          nextState: toState,
          bookingId,
        };
      }

      // (Unreachable) fallback
      return {
        handled: true,
        replyText: finalizeBookingStateReply("Contact number share kar dein."),
        updatedBookingFields: {},
        nextState: "awaiting_contact",
        bookingId,
      };
    }

    return { handled: false };
  }

  // Step 1 (detection only): run early, no behavior change.
  const bookingStateResult = await handleBookingConversationState({
    userId,
    source,
    playwrightWebInbound: Boolean(playwrightWebInbound),
    isGroupInbound: Boolean(isGroupInbound),
    sessionKey,
    bookingHint,
    messageId,
    dmPlaywrightChatKey: null,
    dmChatTitle: null,
    message,
  }).catch(() => ({ handled: false }));
  if (bookingStateResult?.handled === true) {
    if (bookingStateResult?.suppressOutbound === true) {
      return {
        reply: "",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(true),
        sendVia: "NONE",
      };
    }
    return applyHybridOutboundResult(
      {
        reply: String(bookingStateResult.replyText ?? ""),
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(true),
      },
      routingCtx
    );
  }

  const dmTargetPhone = isRoutableDmTarget(participantPhoneForDm)
    ? String(participantPhoneForDm).trim()
    : "";
  const dmTargetSource = dmTargetPhone ? "participantPhoneForDm" : "";
  const canDmCustomer = Boolean(dmTargetPhone);
  const ownerApprovalFirst = bookingOwnerApprovalFirstEnabled();
  const participantIdentity = resolveParticipantIdentity({
    participantPhone: participantPhoneForDm,
    participantName,
    senderName: participantName,
    senderAnchor: senderScope,
    groupChatKey: playwrightChatKey || groupName,
  });
  const explicitParticipantKey = String(participantKey ?? "").trim();
  const preserveUnresolvedPlaywrightGroupIdentity =
    Boolean(playwrightWebInbound) &&
    Boolean(isGroupInbound) &&
    !explicitParticipantKey &&
    !String(senderScope ?? "").trim();
  const sourceParticipantKey = preserveUnresolvedPlaywrightGroupIdentity
    ? null
    : explicitParticipantKey || participantIdentity.participantKey || null;
  if (isGroupInbound && !sourceParticipantKey) {
    console.warn("[participant_identity_missing_group_state_blocked]", {
      groupChatKey: String(playwrightChatKey ?? groupName ?? "").trim() || null,
      participantName: String(participantName ?? "").trim() || null,
      reason: "MISSING_PARTICIPANT_KEY",
    });
  }
  const bookingSourceMessageMetadata = {
    sourceGroupName: String(groupName ?? "").trim() || null,
    sourcePlaywrightChatKey: String(playwrightChatKey ?? "").trim() || null,
    sourceMessageId: String(messageId ?? "").trim() || null,
    sourceText: String(message ?? "").trim() || null,
    originalUserMessageText: String(message ?? "").trim() || null,
    sourceTimestamp:
      timestamp != null && Number.isFinite(Number(timestamp)) ? Number(timestamp) : null,
    sourceSenderScope: String(senderScope ?? "").trim() || null,
    sourceParticipantName:
      String(participantIdentity.participantName ?? participantName ?? "").trim() || null,
    sourceParticipantPhone:
      String(participantIdentity.participantPhone ?? participantPhoneForDm ?? "").trim() || null,
    sourceParticipantKey,
    sourceRowKey: String(sourceRowKey ?? "").trim() || null,
    sourceMessageIndex:
      sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex))
        ? Number(sourceMessageIndex)
        : null,
  };
  console.log("[dm_capability]", {
    canDmCustomer,
    dmTargetSource: dmTargetSource || null,
    hasDmTarget: Boolean(dmTargetPhone),
    isGroupInbound: Boolean(isGroupInbound),
  });
  console.log("[booking_flow_flag]", {
    BOOKING_OWNER_APPROVAL_FIRST: ownerApprovalFirst,
    isGroupInbound: Boolean(isGroupInbound),
  });
  const bookingAttachIntent = detectIntent(message);
  const bookingAttachAvailabilityQuery = isBookingAttachAvailabilityQuery({
    message,
    intent: bookingAttachIntent,
  });
  let bookingAttachAuthorityBlockedReason = null;

  const maybeHandleDeliveryDetails = async () => {
    const customerPhoneForResume =
      String(participantPhoneForDm ?? "").trim() ||
      String(sessionKey ?? "").split("::").pop() ||
      "";
    if (!isGroupInbound) {
      const deliverySlots = parseDeliveryDetails(message);
      const resume = await findApprovedBookingForDm({
        db,
        userId,
        message,
        customerPhone: customerPhoneForResume,
        sessionKey,
        isAvailabilityQuery: bookingAttachAvailabilityQuery,
        authorityContext: {
          currentParticipantKey: customerPhoneForResume,
          currentIntent: bookingAttachIntent,
          extractedSlots: deliverySlots,
          messageRole: "dm",
        },
      });
      if (!resume.match) {
        // DM booking continuation mode: when we have a single waiting approved booking but the
        // authority layer blocks due to weak/short user reply (e.g. "Faisal town"), treat short
        // replies as answers to the missing field in the booking flow.
        const candidates = Array.isArray(resume?.candidates) ? resume.candidates : [];
        const shortReplyWordCount = String(message ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
        const isShortReply = shortReplyWordCount >= 1 && shortReplyWordCount <= 5;
        const isPlaywrightDmContinuation =
          Boolean(playwrightWebInbound) && !isGroupInbound;
        const singleWaitingCandidate =
          isPlaywrightDmContinuation &&
          resume?.reason === "authority_blocked" &&
          candidates.length === 1 &&
          isShortReply;
        if (singleWaitingCandidate) {
          const booking = candidates[0] || {};
          const stage = String(booking?.approvalStage ?? "").trim();
          const stageKey = stage.toLowerCase();
          const waitingStages = new Set([
            "owner_approved_waiting_customer_details",
            "waiting_customer_details",
          ]);
          if (waitingStages.has(stageKey)) {
            const details = parseDeliveryDetails(message);
            let detectedField = "";
            /** @type {{ address?: string, deliveryTime?: string, contactPhone?: string }} */
            const patched = { ...details };
            const raw = String(message ?? "").trim();
            const isOnlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(
              raw.toLowerCase()
            );
            if (!patched.address && !isOnlyAck && !String(booking?.deliveryAddress ?? "").trim()) {
              patched.address = raw;
              detectedField = "delivery_location";
            }
            if (!detectedField && patched.deliveryTime && !String(booking?.deliveryTime ?? "").trim()) {
              detectedField = "delivery_time";
            }
            if (!detectedField && patched.contactPhone && !String(booking?.customerPhone ?? "").trim()) {
              detectedField = "contact_phone";
            }

            console.log("[dm_booking_continuation_mode]", {
              bookingId: String(booking?.id ?? booking?.bookingId ?? "").trim() || null,
              stage: stage || null,
              detectedField: detectedField || null,
              userMessage: String(message ?? "").slice(0, 160),
            });

            const update = {
              deliveryConversationStarted: true,
              dmStartedAt: new Date(),
              customerPhone: String(customerPhoneForResume ?? "").trim() || undefined,
              updatedAt: new Date(),
            };
            if (patched.address) update.deliveryAddress = patched.address;
            if (patched.deliveryTime) update.deliveryTime = patched.deliveryTime;
            if (patched.contactPhone && !booking.customerPhone) {
              update.customerPhone = patched.contactPhone;
            }
            Object.keys(update).forEach((key) => {
              if (update[key] === undefined) delete update[key];
            });
            const { completion: fallbackCompletion } =
              buildLogisticsCompletionPatch({
                bookingId: String(booking.id),
                booking,
                patch: update,
                sourcePath: "booking_attach.single_waiting_candidate",
              });
            logLogisticsCompletionEvaluated({
              bookingId: String(booking.id),
              booking: { ...booking, ...update },
              isComplete: fallbackCompletion.complete,
              source: "parser",
            });
            await db
              .collection("businesses")
              .doc(String(userId))
              .collection("bookings")
              .doc(String(booking.id))
              .update(update);

            // Acknowledge + next step (booking continuation tone).
            let reply = "";
            if (fallbackCompletion.complete) {
              reply = "Details complete hain. Booking set hai.";
            } else if (detectedField === "delivery_location") {
              reply = `${raw} noted 👍 Delivery ka time kya rakhna hai?`;
            } else {
              reply = buildDeliveryDetailReply({ booking, updated: patched });
            }
            return applyHybridOutboundResult(
              {
                reply,
                type: "AI_MESSAGE",
                messageMeta: messageMetaForKnowledge(true),
              },
              routingCtx
            );
          }
        }

        if (resume.reason === "authority_blocked") {
          bookingAttachAuthorityBlockedReason = resume.authorityReason || resume.reason;
        }
        if (resume.reason === "multiple_candidates") {
          console.log("[dm_resume_no_safe_match]", {
            reason: resume.reason,
            candidateCount: resume.candidates.length,
          });
          return applyHybridOutboundResult(
            {
              reply: buildBookingDetailsClarificationReply(resume.candidates),
              type: "AI_MESSAGE",
              messageMeta: messageMetaForKnowledge(true),
            },
            routingCtx
          );
        }
        console.log("[dm_resume_no_safe_match]", { reason: resume.reason });
        if (isPlaywrightDmContinuation) {
          return noOutboundResult({
            reason: `BOOKING_ATTACH_FAILED:${resume.reason || "NO_SAFE_MATCH"}`,
            bookingId: String(bookingHint?.bookingId ?? "").trim() || null,
            dmChatKey:
              String(sessionKey ?? "").split("dm::").pop()?.trim() || null,
            messageIdForLog: String(messageId ?? "").trim() || null,
            approvalStage: null,
            logisticsComplete: false,
          });
        }
        return null;
      }

      const booking = resume.match;
      const details = parseDeliveryDetails(message);
      const update = {
        deliveryConversationStarted: true,
        dmStartedAt: new Date(),
        customerPhone: String(customerPhoneForResume ?? "").trim() || undefined,
        updatedAt: new Date(),
      };
      if (details.address) update.deliveryAddress = details.address;
      if (details.deliveryTime) update.deliveryTime = details.deliveryTime;
      if (details.contactPhone && !booking.customerPhone) {
        update.customerPhone = details.contactPhone;
      }
      Object.keys(update).forEach((key) => {
        if (update[key] === undefined) delete update[key];
      });
      const mergedAfterUpdate = { ...booking, ...update };
      const completion = getBookingLogisticsCompletionState(
        mergedAfterUpdate,
        logisticsCompletionPolicy
      );
      if (completion.complete) {
        buildLogisticsCompletionPatch({
          bookingId: String(booking.id),
          booking,
          patch: update,
          sourcePath: "booking_attach.dm_resume",
        });
      }
      await db
        .collection("businesses")
        .doc(String(userId))
        .collection("bookings")
        .doc(String(booking.id))
        .update(update);
      console.log("[booking_details_attached]", {
        bookingId: booking.id,
        source: "dm",
        matchReason: resume.reason,
        hasAddress: Boolean(details.address),
        hasDeliveryTime: Boolean(details.deliveryTime),
        hasContactPhone: Boolean(details.contactPhone),
      });
      console.log("[dm_approved_booking_resume]", {
        bookingId: booking.id,
        matchReason: resume.reason,
        hasAddress: Boolean(details.address || booking.deliveryAddress),
        hasDeliveryTime: Boolean(details.deliveryTime || booking.deliveryTime),
      });
      logLogisticsCompletionEvaluated({
        bookingId: String(booking.id),
        booking: mergedAfterUpdate,
        isComplete: completion.complete,
        source: "parser",
      });
      if (completion.complete) {
        console.log("[delivery_details_collected]", { bookingId: booking.id });
        console.log("[booking_delivery_confirmed]", { bookingId: booking.id });
      }
      const reply = buildDeliveryDetailReply({ booking, updated: details });
      return applyHybridOutboundResult(
        {
          reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(true),
        },
        routingCtx
      );
    }

    const groupBooking = await findApprovedBookingForGroupDetails({
      db,
      userId,
      sessionKey,
      groupName,
      message,
      isAvailabilityQuery: bookingAttachAvailabilityQuery,
      authorityContext: {
        currentParticipantKey: sourceParticipantKey,
        currentIntent: bookingAttachIntent,
        extractedSlots: parseDeliveryDetails(message),
        messageRole: "group",
        groupChatKey: String(playwrightChatKey ?? groupName ?? "").trim(),
      },
    });
    if (!groupBooking.match) {
      if (groupBooking.reason === "authority_blocked") {
        bookingAttachAuthorityBlockedReason =
          groupBooking.authorityReason || groupBooking.reason;
      }
      if (groupBooking.reason === "multiple_candidates") {
        return applyHybridOutboundResult(
          {
            reply: buildBookingDetailsClarificationReply(groupBooking.candidates),
            type: "AI_MESSAGE",
            messageMeta: messageMetaForKnowledge(true),
          },
          routingCtx
        );
      }
      return null;
    }
    const groupBookingMatch = groupBooking.match;
    const details = parseDeliveryDetails(message);
    if (!details.address && !details.deliveryTime && !details.contactPhone) {
      if (isWeekdayOrDateOnlyMessage(message)) {
        console.log("[booking_date_message_safe_handled]", {
          bookingId: groupBookingMatch.id,
          messagePreview: String(message ?? "").trim().slice(0, 160) || null,
          groupName: groupName || null,
          chatKey: playwrightChatKey || null,
          reason: "GROUP_DATE_MESSAGE_NO_PRIVATE_MUTATION",
        });
        return applyHybridOutboundResult(
          {
            reply: "Noted, main confirm kar ke bata deta hun.",
            type: "AI_MESSAGE",
            messageMeta: {
              ...messageMetaForKnowledge(true),
              bookingId: groupBookingMatch.id,
              stage: groupBookingMatch.approvalStage ?? null,
            },
          },
          routingCtx
        );
      }
      return null;
    }
    console.log("[group_logistics_mutation_blocked]", {
      bookingId: groupBookingMatch.id,
      attemptedFields: [
        ...(details.address ? ["deliveryAddress"] : []),
        ...(details.deliveryTime ? ["deliveryTime"] : []),
        ...(details.contactPhone ? ["contactPhone"] : []),
      ],
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      groupName: groupName || null,
      chatKey: playwrightChatKey || null,
      reason: "GROUP_BOOKING_DETAILS_FALLBACK_BLOCKED",
    });
    return applyHybridOutboundResult(
      {
        reply: groupSafeRequestReceivedReply({ itemAndDurationKnown: true }),
        type: "AI_MESSAGE",
        messageMeta: {
          ...messageMetaForKnowledge(true),
          bookingId: groupBookingMatch.id,
          stage: groupBookingMatch.approvalStage ?? null,
        },
      },
      routingCtx
    );
  };

  const deliveryDetailsResult = await maybeHandleDeliveryDetails();
  if (deliveryDetailsResult) {
    return deliveryDetailsResult;
  }

  let conversationStyle = detectConversationStyle([
    ...contextMessages.slice(-3),
    ...extractRecentAssistantTextsFromPromptBlock(conversationHistory, 1),
    message,
  ]);
  function buildBookingFinalOutbound({
    bookingId,
    itemId,
    itemName,
    durationDays,
    durationHours = null,
    billingUnit = null,
    billingRatePercentOfDaily = null,
    calculatedPrice = null,
    currency = null,
    ownerApprovalFirstRequest = false,
    memory = null,
  }) {
    const safeBookingId = String(bookingId ?? "").trim();
    if (!safeBookingId) {
      console.warn("[BOOKING FINAL BLOCKED] Missing booking id");
      console.log("[final_reply_source]", { source: "FALLBACK" });
      return applyHybridOutboundResult(
        {
          reply: "I have your request details, but I couldn't create the booking right now. Please try again shortly.",
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(false),
        },
        routingCtx
      );
    }
    const safeItemName = String(itemName ?? "").trim() || "your item";
    const safeDurationDays = Math.max(1, Number(durationDays) || 1);
    let finalText;
    if (ownerApprovalFirstRequest) {
      finalText = groupSafeRequestReceivedReply({
        itemAndDurationKnown: true,
        itemName: safeItemName === "your item" ? "" : safeItemName,
        durationDays: safeDurationDays,
        durationHours,
        billingUnit,
      });
      console.log("[booking_waiting_response_generated]", {
        bookingId: safeBookingId,
        eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
        responsePreview: String(finalText).slice(0, 160),
        durationDays: safeDurationDays,
        publicLogisticsPromptSuppressed: true,
      });
      if (memory && typeof memory === "object") {
        delete memory.pendingEngagementState;
      }
    } else {
      finalText = conversationStyle === "casual_local"
        ? `Great, ${safeItemName} ki booking request ${safeDurationDays} days ke liye create ho gayi hai. Hum shortly confirm kar denge.`
        : `Great! Your booking for ${safeItemName} for ${safeDurationDays} days has been created. We’ll confirm it shortly.`;
    }

    console.log("[final_reply_source]", { source: "BOOKING_CREATED" });
    console.log("[BOOKING FINAL RESPONSE SENT]", {
      bookingId: safeBookingId,
      itemName: safeItemName,
      durationDays: safeDurationDays,
    });

    const result = applyHybridOutboundResult(
      {
        reply: finalText,
        text: finalText,
        type: "AI_MESSAGE",
        meta: {
          bookingCreated: true,
          bookingId: safeBookingId,
          itemName: safeItemName,
          durationDays: safeDurationDays,
          ...(durationHours != null && Number.isFinite(Number(durationHours))
            ? { durationHours: Math.max(1, Math.floor(Number(durationHours))) }
            : {}),
          ...(billingUnit != null && String(billingUnit).trim() !== ""
            ? { billingUnit: String(billingUnit).trim() }
            : {}),
          ...(billingRatePercentOfDaily != null &&
          Number.isFinite(Number(billingRatePercentOfDaily))
            ? {
                billingRatePercentOfDaily: Math.max(
                  1,
                  Math.min(100, Math.floor(Number(billingRatePercentOfDaily)))
                ),
              }
            : {}),
          ...(calculatedPrice != null && Number.isFinite(Number(calculatedPrice))
            ? { calculatedPrice: Math.round(Number(calculatedPrice)) }
            : {}),
          ...(currency != null && String(currency).trim() !== ""
            ? { currency: String(currency).trim().toUpperCase() }
            : {}),
        },
        messageMeta: {
          bookingCreated: {
            id: safeBookingId,
            itemId: String(itemId ?? "").trim() || null,
            itemName: safeItemName,
            durationDays: safeDurationDays,
            ...(durationHours != null && Number.isFinite(Number(durationHours))
              ? { durationHours: Math.max(1, Math.floor(Number(durationHours))) }
              : {}),
            ...(billingUnit != null && String(billingUnit).trim() !== ""
              ? { billingUnit: String(billingUnit).trim() }
              : {}),
            ...(billingRatePercentOfDaily != null &&
            Number.isFinite(Number(billingRatePercentOfDaily))
              ? {
                  billingRatePercentOfDaily: Math.max(
                    1,
                    Math.min(100, Math.floor(Number(billingRatePercentOfDaily)))
                  ),
                }
              : {}),
            ...(calculatedPrice != null && Number.isFinite(Number(calculatedPrice))
              ? { calculatedPrice: Math.round(Number(calculatedPrice)) }
              : {}),
            ...(currency != null && String(currency).trim() !== ""
              ? { currency: String(currency).trim().toUpperCase() }
              : {}),
            status: "pending_approval",
            ...(ownerApprovalFirstRequest
              ? { approvalStage: "pending_owner_approval" }
              : {}),
          },
        },
      },
      routingCtx
    );

    if (String(result?.reply ?? "").trim()) {
      appendConversationTurn(
        userId,
        message,
        String(result.reply),
        sessionKey
      );
    }

    return result;
  }
  function resetBookingMemoryAfterBlock(memory) {
    if (!memory || typeof memory !== "object") return;
    memory.hasBookingIntent = false;
    memory.stage = null;
    memory.lastItem = null;
    memory.lastDuration = null;
    memory.durationPreference = null;
    memory.askedContact = false;
    memory.bookingBlockedReason = "ITEM_ALREADY_BOOKED";
  }
  function clearBookingAttachmentContext(target) {
    if (!target || typeof target !== "object") return [];
    const cleared = [];
    for (const field of [
      "activeBookingId",
      "pendingBookingCandidates",
      "bookingDetails",
    ]) {
      if (Object.prototype.hasOwnProperty.call(target, field)) {
        delete target[field];
        cleared.push(field);
      }
    }
    return cleared;
  }
  function buildBookingBlockedResponse({
    itemName,
    memory,
    itemId = null,
    message: blockedMessage = message,
    extractedDurationDays = null,
    contactValid = null,
    events: blockedEvents = null,
  } = {}) {
    const blockedItemId =
      normalizeId(itemId) ||
      normalizeId(memory?.bookingState?.itemId) ||
      normalizeId(memory?.lastItem?.id);
    const blockedContact =
      contactValid === null
        ? extractBookingContactParts(blockedMessage).isValid
        : contactValid;
    const blockedDurationDays =
      extractedDurationDays ??
      (Number.isFinite(Number(extractDuration(blockedMessage)?.durationDays))
        ? Number(extractDuration(blockedMessage).durationDays)
        : null);
    const continuation = isSameSessionBookingContinuation({
      memory,
      emilySessionKey,
      itemId: blockedItemId,
      message: blockedMessage,
      extractedDurationDays: blockedDurationDays,
      contactValid: blockedContact,
      events: blockedEvents ?? detectBookingEvent(blockedMessage),
    });
    if (continuation) {
      const itemLabel = String(itemName ?? "").trim();
      const text = buildSameSessionBookingContinuationReply({
        memory,
        itemName: itemLabel,
        style: conversationStyle,
      });
      console.log("[final_reply_source]", {
        source: "BOOKING_CONTINUATION_ALREADY_NOTED",
      });
      return applyHybridOutboundResult(
        {
          reply: text,
          text,
          type: "AI_MESSAGE",
          meta: {
            bookingContinuation: true,
            bookingId: String(memory?.bookingState?.bookingId ?? "").trim() || null,
          },
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }
    resetBookingMemoryAfterBlock(memory);
    const itemLabel = String(itemName ?? "").trim();
    const text = buildUnavailableReply({
      itemLabel,
      style: conversationStyle,
    });
    console.log("[final_reply_source]", {
      source: "BOOKING_BLOCKED_ITEM_ALREADY_BOOKED",
    });
    console.log("[FINAL RESPONSE: BOOKING BLOCKED]");
    return applyHybridOutboundResult(
      {
        reply: text,
        text,
        type: "AI_MESSAGE",
        meta: {
          bookingBlocked: true,
          reason: "ITEM_ALREADY_BOOKED",
        },
        messageMeta: {
          bookingBlocked: true,
          reason: "ITEM_ALREADY_BOOKED",
        },
      },
      routingCtx
    );
  }
  function buildBookingBlockedOutbound(memory, itemName) {
    console.log("[BOOKING BLOCKED] ITEM_ALREADY_BOOKED");
    return buildBookingBlockedResponse({ itemName, memory });
  }
  globalThis.__chatContext = globalThis.__chatContext || {};
  const normalizedPlaywrightChatKey = normalizeText(
    String(playwrightChatKey ?? "")
  );
  const normalizedSessionKey = normalizeText(String(sessionKey ?? ""));
  const chatContextKey = resolveGroupParticipantContextKey({
    isGroupInbound,
    sessionKey,
    playwrightChatKey,
    participantKey: sourceParticipantKey || "",
    businessId: userId,
    userId,
  });
  const groupParticipantContextKey =
    Boolean(isGroupInbound) && sourceParticipantKey ? chatContextKey : "";
  if (isGroupInbound) {
    console.log("[group_context_participant_key]", {
      groupChatKey: normalizedPlaywrightChatKey || null,
      participantKey: sourceParticipantKey || null,
      chatContextKey,
    });
    console.log("[participant_session_key_resolved]", {
      groupChatKey: normalizedPlaywrightChatKey || null,
      participantKey: sourceParticipantKey || null,
      sessionKey: chatContextKey,
    });
    if (groupParticipantContextKey) {
      console.log("[group_context_reused_for_same_participant]", {
        groupChatKey: normalizedPlaywrightChatKey || null,
        participantKey: sourceParticipantKey || null,
        chatContextKey,
      });
    } else {
      console.log("[group_context_reset_due_to_participant_change]", {
        reason: "MISSING_PARTICIPANT_SCOPED_SESSION",
        groupChatKey: normalizedPlaywrightChatKey || null,
      });
    }
  }
  /**
   * Emily / booking memory bucket for this thread (must match applyEmilyTurn).
   * For group inboxes, callers should pass a per-customer thread id (e.g. participant
   * phone or DM route) so User A / User B do not share one session state.
   */
  const emilySessionKey = chatSessionKey(userId, chatContextKey);
  routingCtx.emilySessionKey = emilySessionKey;
  const pendingTopicReset = Boolean(resetTopicContext);
  /** @type {import("./turnContextAuthority.js").ReturnType<typeof resolveTurnContext> | null} */
  let turnContext = null;
  const pendingEngagementMemory = getEmilySessionState(emilySessionKey);
  const pendingEngagementResult = await maybeHandlePendingEngagementQualifier({
    userId,
    message,
    memory: pendingEngagementMemory,
    routingCtx,
    knowledgeMeta: messageMetaForKnowledge(true),
  });
  if (pendingEngagementResult) {
    return pendingEngagementResult;
  }
  const pendingCommitQualifierResult =
    await maybeHandlePendingEngagementCommitWithoutQualifier({
      message,
      memory: pendingEngagementMemory,
      routingCtx,
      applyOutbound: applyHybridOutboundResult,
      knowledgeMeta: messageMetaForKnowledge(true),
    });
  if (pendingCommitQualifierResult) {
    return pendingCommitQualifierResult;
  }
  const slotCaptureResult = await maybeHandleGroupBookingSlotCapture({
    userId,
    message,
    memory: pendingEngagementMemory,
    routingCtx,
    isGroupInbound: Boolean(isGroupInbound),
    applyOutbound: applyHybridOutboundResult,
  });
  if (slotCaptureResult) {
    return slotCaptureResult;
  }

  globalThis.__topicEntityBySession =
    globalThis.__topicEntityBySession || Object.create(null);

  const rawCtx = globalThis.__chatContext[chatContextKey];
  console.log("[participant_context_loaded]", {
    chatContextKey,
    participantKey: sourceParticipantKey || null,
    hasContext: Boolean(rawCtx && typeof rawCtx === "object"),
  });
  const existingChatContext =
    rawCtx && typeof rawCtx === "object"
      ? {
          lastFocusedItem:
            rawCtx.lastFocusedItem != null &&
            String(rawCtx.lastFocusedItem).trim() !== ""
              ? String(rawCtx.lastFocusedItem).trim()
              : rawCtx.lastCar != null && String(rawCtx.lastCar).trim() !== ""
                ? String(rawCtx.lastCar).trim()
                : null,
          lastIntent: rawCtx.lastIntent ?? null,
          lastDuration: rawCtx.lastDuration ?? null,
        }
      : {
          lastFocusedItem: null,
          lastIntent: null,
          lastDuration: null,
        };
  if (bookingAttachAvailabilityQuery || bookingAttachAuthorityBlockedReason) {
    const clearedFields = new Set([
      ...clearBookingAttachmentContext(pendingEngagementMemory),
      ...clearBookingAttachmentContext(rawCtx),
      ...clearBookingAttachmentContext(existingChatContext),
    ]);
    console.log("[booking_context_cleared_on_new_query]", {
      reason: bookingAttachAuthorityBlockedReason || "AVAILABILITY_QUERY",
      clearedFields: Array.from(clearedFields).sort(),
      chatContextKey,
    });
  }

  if (DEBUG_EXTRACT) {
    console.log("[DEBUG] isGreetingFirst:", isGreetingFirst);
    console.log("[DEBUG] messageText:", message);
  }

  let knowledge = "";

  try {
    await maybePersistKnowledgeFromMessage(userId, message);
  } catch (e) {
    console.error("[processor] knowledge extract/save:", e);
  }

  if (DEBUG_EXTRACT) {
    console.log("[messageProcessor] Fetching profile for user:", userId);
  }

  let businessProfile = null;
  try {
    const [knowledgeResult, profileResult] = await Promise.all([
      timeAsync("getBusinessKnowledge", () => getBusinessKnowledge(userId)),
      timeAsync("getBusinessProfile", () => getBusinessProfile(userId), {
        userId,
      }),
    ]);
    knowledge = typeof knowledgeResult === "string" ? knowledgeResult : "";
    businessProfile = profileResult;
    routingCtx.businessProfile = businessProfile?.rawBusinessProfile ?? businessProfile?.profileData ?? businessProfile;
  } catch (e) {
    console.error("[processor] knowledge / profile error:", e);
    knowledge = "";
  }

  if (businessProfile == null) {
    console.error(
      "❌ No business profile found for user:",
      userId,
      "| Firestore path: businesses/",
      userId,
      "| Mobile app saves to: businesses/{firebaseAuth.uid} — uid here must match that document id."
    );
  } else {
    console.log(
      "[messageProcessor] Fetched profile:",
      "hasNestedBusinessProfile=",
      Boolean(businessProfile.rawBusinessProfile)
    );
  }

  const docBusinessKnowledge =
    typeof businessProfile?.businessKnowledge === "string"
      ? businessProfile.businessKnowledge.trim()
      : "";
  knowledge =
    docBusinessKnowledge ||
    (typeof knowledge === "string" ? knowledge.trim() : "");

  const safeKnowledge =
    typeof knowledge === "string" ? knowledge.trim() : "";

  console.log(
    "BUSINESS PROFILE:",
    JSON.stringify(businessProfile, jsonReplacerForFirestore, 2)
  );
  console.log("KNOWLEDGE TEXT:", safeKnowledge);

  const mergedKnowledge = mergeKnowledgeWithRawProfile(
    safeKnowledge,
    businessProfile?.rawBusinessProfile ?? null
  );
  console.log("KNOWLEDGE MERGED FOR MODEL:", mergedKnowledge);

  let history =
    typeof conversationHistory === "string" && conversationHistory.trim() !== ""
      ? conversationHistory.trim()
      : getRecentChatHistoryForPrompt(userId, 10, sessionKey);
  const hasConversationContext = history.trim().length > 0;
  conversationStyle = detectConversationStyle([
    ...contextMessages.slice(-3),
    ...extractRecentAssistantTextsFromPromptBlock(history, 1),
    message,
  ]);


  const businessName = String(
    businessProfile?.profileData?.businessName ?? ""
  ).trim();
  const businessType = String(
    businessProfile?.profileData?.businessType ?? ""
  ).trim();

  const hasTextKnowledge = mergedKnowledge.length > 0;
  const hasProfileKnowledge = profileContributesToKnowledge(businessProfile);
  /** Services, items, pricing, name/type, instructions, legacy text, or structured profile */
  const hasUsefulBusinessData =
    hasTextKnowledge ||
    hasProfileKnowledge ||
    Boolean(businessName || businessType);

  console.log(
    "[AI] hasUsefulBusinessData:",
    hasUsefulBusinessData,
    "mergedKnowledgeChars:",
    mergedKnowledge.length
  );

  const businessContext = businessProfile
    ? businessProfileForContext(businessProfile)
    : null;
  if (
    businessContext &&
    typeof businessContext === "object" &&
    (Array.isArray(businessContext.items) || Array.isArray(businessContext.vehicles))
  ) {
    console.error("❌ Legacy catalog access detected");
  }
  const uidCat = String(userId ?? "").trim();
  const catalogRowsThisTurn = await timeAsync(
    "catalog_load",
    () => getItemsForBusiness(uidCat),
    { userId: uidCat }
  );
  const catalogSourceForTurn = "db";
  const normalizedCatalogRowsForTurn = catalogRowsThisTurn
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) =>
      normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row))
    );
  const normalizedCatalogForTurn = mergeBusinessProfileItemFactsIntoCatalog(
    normalizedCatalogRowsForTurn,
    businessProfile
  );
  if (normalizedCatalogForTurn.length === 0) {
    console.error("❌ No catalog items found in DB");
  }

  const inboundMessageRawForFuzzy = String(rawInboundMessage ?? "").trim();
  if (inboundMessageRawForFuzzy && normalizedCatalogForTurn.length > 0) {
    turnContext = resolveTurnContext({
      message: inboundMessageRawForFuzzy,
      catalogItems: normalizedCatalogForTurn,
      participantKey: sourceParticipantKey,
      isGroupInbound,
      memory: getEmilySessionState(emilySessionKey),
      traceId,
      resolveTrustedSessionItem: (p) =>
        hasSafePreviousCatalogItemForPriceFollowup({
          memory: p.memory,
          message: p.message,
          catalogItems: p.catalogItems,
          participantKey: p.participantKey,
          chatContextKey,
          sessionKey: emilySessionKey,
          traceId,
          isGroupInbound,
        }),
    });
    if (turnContext.shouldClarifyItem && turnContext.clarificationReply) {
      console.warn("[turn_context_clarification_outbound]", {
        traceId,
        reason: turnContext.clarificationReason,
        turnShape: turnContext.turnShape,
        participantIdentity: turnContext.participantIdentity,
      });
      return applyHybridOutboundResult(
        {
          reply: turnContext.clarificationReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(false),
        },
        routingCtx
      );
    }
  }
  /** @type {import("./fuzzyTurnNormalizer.js").FuzzyTurnResult | null} */
  let fuzzyTurnNormalization = null;
  if (inboundMessageRawForFuzzy && normalizedCatalogForTurn.length > 0) {
    fuzzyTurnNormalization = normalizeFuzzyTurn({
      rawText: inboundMessageRawForFuzzy,
      catalogItems: normalizedCatalogForTurn,
      traceId,
    });
    const topCorrectionConfidence =
      fuzzyTurnNormalization.corrections.length > 0
        ? Math.max(...fuzzyTurnNormalization.corrections.map((c) => c.confidence))
        : null;
    console.log("[fuzzy_turn_normalized]", {
      traceId: traceId || null,
      rawTextPreview: inboundMessageRawForFuzzy.slice(0, 160) || null,
      normalizedTextPreview:
        String(fuzzyTurnNormalization.normalizedText ?? "").slice(0, 160) || null,
      corrections: fuzzyTurnNormalization.corrections,
      ambiguity: fuzzyTurnNormalization.ambiguity,
      catalogConfidence: fuzzyTurnNormalization.catalogConfidence ?? null,
      catalogRankedCandidates: (
        fuzzyTurnNormalization.catalogRankedCandidates ?? []
      ).slice(0, 5),
      needsCatalogConfirmation: Boolean(
        fuzzyTurnNormalization.needsCatalogConfirmation
      ),
      selectedCatalogItemId:
        normalizeId(
          fuzzyTurnNormalization.catalogCandidate?.id ??
            fuzzyTurnNormalization.catalogCandidate?.itemId
        ) || null,
      requestedFieldCandidate: fuzzyTurnNormalization.requestedFieldCandidate,
      confidence: topCorrectionConfidence,
    });
    if (
      fuzzyTurnNormalization.normalizedText &&
      fuzzyTurnNormalization.normalizedText !== inboundMessageRawForFuzzy
    ) {
      message = fuzzyTurnNormalization.normalizedText;
    }
  }
  const businessContextForRuntime =
    businessContext != null && typeof businessContext === "object"
      ? {
          ...businessContext,
          items: normalizedCatalogForTurn,
        }
      : null;

  const resolveCatalogMemo = new Map();
  const availabilityByItemId = new Map();
  /**
   * One canonical catalog per turn; memoize by trimmed lowercased input to avoid repeat work.
   * @param {string | null | undefined} rawIn
   * @param {Record<string, unknown> | null | undefined} memHint
   */
  async function resolveCatalogThisTurn(rawIn, memHint) {
    const input = String(rawIn ?? "").trim();
    if (memHint && typeof memHint === "object") {
      console.log("🧠 Memory vs Catalog:", {
        memoryItem: memHint?.lastItem?.name ?? null,
        mentioned: memHint?.lastItemMentioned ?? null,
      });
    }
    const key = input.toLowerCase();
    if (key.length < 2) return null;
    if (!resolveCatalogMemo.has(key)) {
      resolveCatalogMemo.set(
        key,
        timeAsync(
          "item_resolution",
          () =>
            resolveItemFromCatalog(userId, input, {
              catalogItems: normalizedCatalogForTurn,
              catalogSource: catalogSourceForTurn,
            }),
          { inputPreview: input.slice(0, 80), path: "resolveCatalogThisTurn" }
        )
      );
    }
    const result = await resolveCatalogMemo.get(key);
    const resolvedItem = result && result.ok ? result.item : null;
    if (resolvedItem?.id) {
      setLastResolvedItemId(memHint, resolvedItem.id);
      setLastResolvedItemId(getEmilySessionState(emilySessionKey), resolvedItem.id);
    }
    return resolvedItem;
  }

  async function getUserFacingAvailabilityForItem(
    itemId,
    itemName,
    sourceLabel = "fallback"
  ) {
    const startedAt = Date.now();
    const normalizedItemId = String(itemId ?? "").trim();
    if (!normalizedItemId) return { isAvailable: true };
    let availability = availabilityByItemId.get(normalizedItemId);
    const cacheHit = Boolean(availability);
    if (!availability) {
      const bookings = await getBookingsForItem(
        userId,
        normalizedItemId,
        String(itemName ?? "").trim() || null
      );
      availability = computeUserFacingAvailability(bookings, normalizedItemId);
      availabilityByItemId.set(normalizedItemId, availability);
    }
    logTiming("availability_hydration", startedAt, {
      itemId: normalizedItemId,
      source: sourceLabel,
      cacheHit,
    });
    return availability;
  }

  /**
   * Keep every `itemContext` entry path on the same booking-aware availability state.
   * @param {Record<string, unknown> | null} itemCtx
   * @param {"initial" | "duration" | "memory" | "fallback"} sourceLabel
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function hydrateItemWithAvailability(itemCtx, sourceLabel = "fallback") {
    if (!itemCtx || typeof itemCtx !== "object") return itemCtx;
    const itemId = String(itemCtx.itemId ?? itemCtx.id ?? "").trim();
    if (!itemId) return itemCtx;

    const itemName =
      String(itemCtx.name ?? "").trim() ||
      String(itemCtx.displayLabel ?? "").trim() ||
      null;
    try {
      const startedAt = Date.now();
      const cacheHitBefore = availabilityByItemId.has(itemId);
      const availability = await getUserFacingAvailabilityForItem(
        itemId,
        itemName,
        sourceLabel
      );
      const hydrated = {
        ...itemCtx,
        itemId,
        isAvailable: availability.isAvailable,
        availabilityReason: availability.isAvailable
          ? "NO_CONFLICT"
          : "ALREADY_BOOKED",
        blockingStatusesSeen: Array.isArray(availability.blockingStatusesSeen)
          ? availability.blockingStatusesSeen
          : [],
        ...(availability.nextAvailableAt != null && {
          nextAvailableAt: new Date(availability.nextAvailableAt).toISOString(),
        }),
      };
      console.log("[availability_hydration]", {
        itemId,
        isAvailable: hydrated.isAvailable,
        source: sourceLabel,
        cacheHit: cacheHitBefore,
      });
      logTiming("availability_hydrate_item_context", startedAt, {
        itemId,
        source: sourceLabel,
        cacheHit: cacheHitBefore,
      });
      return hydrated;
    } catch (err) {
      console.warn("⚠️ Availability hydration failed:", err?.message || err);
      console.log("[availability_hydration]", {
        itemId,
        isAvailable:
          typeof itemCtx.isAvailable === "boolean" ? itemCtx.isAvailable : null,
        source: sourceLabel,
      });
      return itemCtx;
    }
  }

  async function hydrateCatalogItemForPendingAction(candidate) {
    const candidateObj =
      candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate
        : null;
    const itemId = normalizeId(candidateObj?.itemId ?? candidateObj?.id);
    if (itemId) {
      try {
        const row = await findItemById(userId, itemId);
        if (row) {
          return {
            ...row,
            itemId: String(row.id ?? itemId).trim(),
            id: String(row.id ?? itemId).trim(),
            displayLabel: buildDisplayLabel(row) || String(row.name ?? "").trim(),
          };
        }
      } catch (err) {
        console.warn("[pending_action_item_hydration_failed]", {
          itemId,
          reason: String(err?.message ?? err ?? "UNKNOWN"),
        });
      }
    }
    return candidateObj;
  }

  async function executeAcceptShortBookingOffer(pendingAction, memoryForAction) {
    const payload =
      pendingAction?.payload && typeof pendingAction.payload === "object"
        ? pendingAction.payload
        : {};
    const itemId = String(pendingAction?.itemId ?? payload.itemId ?? "").trim();
    const itemName =
      String(pendingAction?.itemDisplayLabel ?? "").trim() ||
      String(payload.itemDisplayLabel ?? "").trim() ||
      String(payload.itemName ?? "").trim() ||
      "your item";
    const minimumHours = Math.max(1, Math.floor(Number(payload.minimumHours)));
    const billingUnit = String(payload.billingUnit ?? "half_day").trim() || "half_day";
    const billingRatePercentOfDaily = Math.max(
      1,
      Math.min(100, Math.floor(Number(payload.billingRatePercentOfDaily ?? 80)))
    );
    const calculatedPrice =
      payload.calculatedPrice != null && Number.isFinite(Number(payload.calculatedPrice))
        ? Math.round(Number(payload.calculatedPrice))
        : null;
    const currency = String(payload.currency ?? "PKR").trim().toUpperCase() || "PKR";

    const av = await getUserFacingAvailabilityForItem(itemId, itemName, "pending_action");
    if (av?.isAvailable === false) {
      clearPendingAction(memoryForAction, "ITEM_UNAVAILABLE");
      return applyHybridOutboundResult(
        {
          reply: buildUnavailableReply({
            itemLabel: itemName,
            style: conversationStyle,
          }),
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx
      );
    }

    const durationDaysForBooking = 1;
    const duplicate = isDuplicateActiveBookingState(memoryForAction, {
      itemId,
      durationDays: durationDaysForBooking,
      sessionKey: emilySessionKey,
      channel: isGroupInbound ? "group" : "dm",
    });
    if (duplicate) {
      clearPendingAction(memoryForAction, "DUPLICATE_ACTIVE_BOOKING");
      return applyHybridOutboundResult(
        {
          reply: "Your booking has already been received. We’ll confirm it shortly.",
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
          },
        },
        routingCtx
      );
    }

    const bookingResult = await createBookingFromValidatedIntent({
      callerTag: "pending_action_accept_short_booking_offer",
      isGroupInbound,
      itemId,
      itemName,
      durationDays: durationDaysForBooking,
      hasParticipantIdentity: Boolean(sourceParticipantKey),
      ownerApprovalFirstRequest: true,
      traceId,
      userId,
      ...bookingInboundGuard,
      createBookingArgs: {
        itemId,
        itemName,
        durationDays: durationDaysForBooking,
        durationHours: minimumHours,
        billingUnit,
        billingRatePercentOfDaily,
        ...(calculatedPrice != null ? { calculatedPrice } : {}),
        currency,
        source,
        groupName,
        sessionKey,
        messageId,
        participantName,
        senderScope,
        playwrightChatKey,
        dmTargetPhone: dmTargetPhone || undefined,
        dmTargetSource: dmTargetSource || undefined,
        canDmCustomer,
        approvalStage: "pending_owner_approval",
        ...bookingSourceMessageMetadata,
      },
    });

    if (!bookingResult?.ok && bookingErrorCode(bookingResult) === "ITEM_ALREADY_BOOKED") {
      clearPendingAction(memoryForAction, "ITEM_ALREADY_BOOKED");
      return buildBookingBlockedResponse({
        itemName,
        memory: memoryForAction,
      });
    }

    if (
      bookingResult?.ok &&
      typeof bookingResult.id === "string" &&
      bookingResult.id.trim() !== ""
    ) {
      clearPendingAction(memoryForAction, "EXECUTED");
      memoryForAction.askedContact = false;
      memoryForAction.stage = "pending_owner_approval";
      const bookingCreated = {
        id: bookingResult.id.trim(),
        itemId,
        itemName,
        durationDays: durationDaysForBooking,
        durationHours: minimumHours,
        billingUnit,
        billingRatePercentOfDaily,
        ...(calculatedPrice != null ? { calculatedPrice } : {}),
        currency,
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
      };
      setStructuredBookingState(memoryForAction, {
        ...bookingCreated,
        sessionKey: emilySessionKey,
        channel: isGroupInbound ? "group" : "dm",
      });
      console.log("[pending_action_executed]", {
        type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
        bookingId: bookingCreated.id,
        itemId,
        durationHours: minimumHours,
      });
      return buildBookingFinalOutbound({
        bookingId: bookingCreated.id,
        itemId,
        itemName,
        durationDays: durationDaysForBooking,
        durationHours: minimumHours,
        billingUnit,
        billingRatePercentOfDaily,
        ...(calculatedPrice != null ? { calculatedPrice } : {}),
        currency,
        ownerApprovalFirstRequest: true,
        memory: memoryForAction,
      });
    }

    clearPendingAction(memoryForAction, "BOOKING_CREATE_FAILED");
    return applyHybridOutboundResult(
      {
        reply: "I have your request details, but I couldn't create the booking right now. Please try again shortly.",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx
    );
  }

  async function executeCollectDuration(pendingAction, memoryForAction, replyIntent) {
    const parsedDuration =
      replyIntent?.duration && typeof replyIntent.duration === "object"
        ? replyIntent.duration
        : parseUserDuration(message);
    if (!parsedDuration) return null;

    const itemId = String(pendingAction?.itemId ?? pendingAction?.payload?.itemId ?? "").trim();
    const itemName =
      String(pendingAction?.itemDisplayLabel ?? "").trim() ||
      String(pendingAction?.payload?.itemDisplayLabel ?? "").trim() ||
      String(pendingAction?.payload?.itemName ?? "").trim() ||
      "your item";
    if (!itemId) {
      clearPendingAction(memoryForAction, "COLLECT_DURATION_MISSING_ITEM_ID");
      return null;
    }

    const selectedItem = await hydrateCatalogItemForPendingAction({
      itemId,
      id: itemId,
      name: itemName,
      displayLabel: itemName,
    });
    const hydratedItem = await hydrateItemWithAvailability(
      {
        ...(selectedItem && typeof selectedItem === "object" ? selectedItem : {}),
        itemId,
        id: itemId,
        name: String(selectedItem?.name ?? itemName).trim() || itemName,
        displayLabel:
          String(selectedItem?.displayLabel ?? "").trim() ||
          buildDisplayLabel(selectedItem) ||
          itemName,
      },
      "pending_action_collect_duration"
    );
    const displayLabel =
      buildDisplayLabel(hydratedItem) ||
      String(hydratedItem?.displayLabel ?? "").trim() ||
      itemName;

    if (hydratedItem?.isAvailable === false) {
      clearPendingAction(memoryForAction, "ITEM_UNAVAILABLE");
      return applyHybridOutboundResult(
        {
          reply: buildUnavailableReply({
            itemLabel: displayLabel,
            style: conversationStyle,
          }),
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx
      );
    }

    const shortBookingSelection = shortBookingSelectionFromParsedDuration(
      parsedDuration,
      businessProfile?.rawBusinessProfile ?? businessProfile?.profileData ?? businessProfile
    );

    if (shortBookingSelection?.type === "below_minimum") {
      const planned = planBelowMinimumHoursTurn({
        message,
        selection: shortBookingSelection,
        item: hydratedItem,
        turnIntentShape: {
          primaryIntent: "booking_request",
          responsePolicy: "start_or_continue_booking",
        },
        isGroupInbound,
        isAvailable: hydratedItem?.isAvailable !== false,
        itemLabel: displayLabel,
        alternativeItems: hydratedItem?.alternativeItems ?? [],
        modeOverride: "booking",
      });
      if (planned.shouldStorePending) {
        const pendingActionNext = buildPendingAction({
          type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
          expectedReplyType: "affirmation",
          participantKey: sourceParticipantKey || "",
          groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
          sessionKey: emilySessionKey,
          itemId,
          itemDisplayLabel: displayLabel,
          payload: {
            itemId,
            itemDisplayLabel: displayLabel,
            originalRequestedHours: shortBookingSelection.requestedHours,
            minimumHours: shortBookingSelection.minimumHours,
            billingUnit: shortBookingSelection.billingUnit,
            billingRatePercentOfDaily: shortBookingSelection.billingRatePercentOfDaily,
            calculatedPrice: planned.calculatedPrice,
            currency: currencyFromItem(hydratedItem),
            explicitPriceIntent: planned.explicitPriceIntent,
          },
          sourceMessageId: messageId,
          sourcePromptText: planned.reply,
        });
        storePendingAction(memoryForAction, pendingActionNext);
      } else if (planned.offerCheckKarun) {
        console.log("[pending_action_not_stored]", {
          type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
          reason: "BELOW_MINIMUM_UNAVAILABLE_OR_UNBOUND",
        });
      }
      console.log("[pending_action_collect_duration_below_minimum]", {
        itemId,
        requestedHours: shortBookingSelection.requestedHours,
        minimumHours: shortBookingSelection.minimumHours,
        kind: planned.kind,
        storedPending: planned.shouldStorePending,
      });
      return applyHybridOutboundResult(
        {
          reply: planned.reply,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "SHORT_BOOKING_BELOW_MINIMUM",
            durationHoursRequested: shortBookingSelection.requestedHours,
            durationHoursMinimum: shortBookingSelection.minimumHours,
          },
        },
        routingCtx
      );
    }

    const durationDaysForBooking = Number.isFinite(Number(parsedDuration.normalizedDays))
      ? Math.max(1, Math.floor(Number(parsedDuration.normalizedDays)))
      : Number.isFinite(Number(parsedDuration.value))
        ? Math.max(1, Math.floor(Number(parsedDuration.value)))
        : null;
    if (durationDaysForBooking == null) return null;

    const duplicate = isDuplicateActiveBookingState(memoryForAction, {
      itemId,
      durationDays: durationDaysForBooking,
      sessionKey: emilySessionKey,
      channel: isGroupInbound ? "group" : "dm",
    });
    if (duplicate) {
      clearPendingAction(memoryForAction, "DUPLICATE_ACTIVE_BOOKING");
      return applyHybridOutboundResult(
        {
          reply: "Your booking has already been received. We’ll confirm it shortly.",
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }

    const shortBookingFields = shortBookingCreateFields(shortBookingSelection, hydratedItem);
    const bookingResult = await createBookingFromValidatedIntent({
      callerTag: "pending_action_collect_duration",
      isGroupInbound,
      itemId,
      itemName: displayLabel,
      durationDays: durationDaysForBooking,
      hasParticipantIdentity: Boolean(sourceParticipantKey),
      ownerApprovalFirstRequest: isGroupInbound,
      traceId,
      userId,
      ...bookingInboundGuard,
      createBookingArgs: {
        itemId,
        itemName: displayLabel,
        durationDays: durationDaysForBooking,
        ...shortBookingFields,
        source,
        groupName,
        sessionKey,
        messageId,
        participantName,
        senderScope,
        playwrightChatKey,
        dmTargetPhone: dmTargetPhone || undefined,
        dmTargetSource: dmTargetSource || undefined,
        canDmCustomer,
        ...(isGroupInbound ? { approvalStage: "pending_owner_approval" } : {}),
        ...bookingSourceMessageMetadata,
      },
    });

    if (!bookingResult?.ok && bookingErrorCode(bookingResult) === "ITEM_ALREADY_BOOKED") {
      clearPendingAction(memoryForAction, "ITEM_ALREADY_BOOKED");
      return buildBookingBlockedResponse({
        itemName: displayLabel,
        memory: memoryForAction,
      });
    }

    if (
      bookingResult?.ok &&
      typeof bookingResult.id === "string" &&
      bookingResult.id.trim() !== ""
    ) {
      clearPendingAction(memoryForAction, "EXECUTED");
      memoryForAction.askedContact = false;
      if (isGroupInbound) memoryForAction.stage = "pending_owner_approval";
      const bookingCreated = {
        id: bookingResult.id.trim(),
        itemId,
        itemName: displayLabel,
        durationDays: durationDaysForBooking,
        ...shortBookingFields,
        status: isGroupInbound ? "pending_approval" : "created",
        ...(isGroupInbound ? { approvalStage: "pending_owner_approval" } : {}),
      };
      setStructuredBookingState(memoryForAction, {
        ...bookingCreated,
        sessionKey: emilySessionKey,
        channel: isGroupInbound ? "group" : "dm",
      });
      console.log("[pending_action_executed]", {
        type: PENDING_ACTION_TYPES.COLLECT_DURATION,
        bookingId: bookingCreated.id,
        itemId,
        durationDays: durationDaysForBooking,
        durationHours: shortBookingFields.durationHours ?? null,
      });
      return buildBookingFinalOutbound({
        bookingId: bookingCreated.id,
        itemId,
        itemName: displayLabel,
        durationDays: durationDaysForBooking,
        ...shortBookingFields,
        ownerApprovalFirstRequest: isGroupInbound,
        memory: memoryForAction,
      });
    }

    clearPendingAction(memoryForAction, "BOOKING_CREATE_FAILED");
    return applyHybridOutboundResult(
      {
        reply: "I have the item and duration, but I couldn't create the booking right now. Please try again shortly.",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx
    );
  }

  async function executeConfirmFuzzyCatalog(pendingAction, memoryForAction) {
    const payload =
      pendingAction?.payload && typeof pendingAction.payload === "object"
        ? pendingAction.payload
        : {};
    const itemId = normalizeId(pendingAction?.itemId ?? payload.itemId);
    const itemDisplayLabel =
      String(pendingAction?.itemDisplayLabel ?? payload.itemDisplayLabel ?? "").trim() ||
      String(payload.itemDisplayLabel ?? "").trim();
    const inferredIntent = String(payload.inferredIntent ?? "").trim();
    const requestedField = String(payload.requestedField ?? "unknown").trim();

    clearPendingAction(memoryForAction, "FUZZY_CATALOG_CONFIRMED");

    if (!itemId) {
      return applyHybridOutboundResult(
        {
          reply: buildPureAckNoOpReply(conversationStyle),
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }

    const catalogRow = normalizedCatalogForTurn.find(
      (row) => normalizeId(row?.id ?? row?.itemId) === itemId
    );
    const hydratedBase = catalogRow
      ? {
          ...normalizeCatalogItem(/** @type {Record<string, unknown>} */ (catalogRow)),
          itemId,
          id: itemId,
          displayLabel: buildDisplayLabel(catalogRow) || itemDisplayLabel,
          name: String(catalogRow.name ?? itemDisplayLabel).trim() || itemDisplayLabel,
        }
      : await hydrateCatalogItemForPendingAction({
          itemId,
          id: itemId,
          name: itemDisplayLabel,
          displayLabel: itemDisplayLabel,
        });

    if (!hydratedBase || typeof hydratedBase !== "object") {
      return applyHybridOutboundResult(
        {
          reply: buildPureAckNoOpReply(conversationStyle),
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }

    const displayLabel =
      buildDisplayLabel(hydratedBase) ||
      String(hydratedBase.displayLabel ?? hydratedBase.name ?? "").trim() ||
      itemDisplayLabel;

    memoryForAction.lastItem = {
      id: itemId,
      itemId,
      name: displayLabel,
      displayLabel,
    };
    memoryForAction.lastItemMentioned = displayLabel;
    setLastResolvedItemId(memoryForAction, itemId);
    memoryForAction.hasBookingIntent = false;

    const hydratedItem = await hydrateItemWithAvailability(
      {
        ...hydratedBase,
        itemId,
        id: itemId,
        name: displayLabel,
        displayLabel,
      },
      "initial"
    );

    const styleKey =
      conversationStyle === "casual_local" ? "casual_local" : "neutral_english";

    if (inferredIntent === "availability_check") {
      const blockingStatusesSeen = Array.isArray(hydratedItem?.blockingStatusesSeen)
        ? hydratedItem.blockingStatusesSeen
        : [];

      if (hydratedItem?.isAvailable === false) {
        /** @type {Array<{ id: string, name: string }>} */
        let alternativeItems = [];
        let alternativeSummarySkipped = false;
        const MAX_CATALOG_FOR_ALT_SNAPSHOT = 400;
        if (normalizedCatalogForTurn.length > MAX_CATALOG_FOR_ALT_SNAPSHOT) {
          alternativeSummarySkipped = true;
        } else if (normalizedCatalogForTurn.length > 0) {
          const raw = await pickAlternativeAvailableItemsFromCatalogRows(
            userId,
            itemId,
            displayLabel,
            normalizedCatalogForTurn,
            { limit: 5, maxRankedCandidates: 150 }
          );
          alternativeItems = raw.map((x) => ({
            id: String(x.id ?? x.itemId ?? "").trim(),
            name: String(x.name ?? "").trim(),
          }));
        } else {
          const raw = await getAlternativeAvailableItems(userId, itemId, displayLabel, 5);
          alternativeItems = raw.map(({ id, name }) => ({
            id: String(id ?? "").trim(),
            name: String(name ?? "").trim(),
          }));
        }

        const composed = composeBookingUnavailableItemAvailabilityContextReply({
          itemLabel: displayLabel,
          reqId: itemId,
          blockingStatusesSeen,
          alternativeItems,
          alternativeSummarySkipped,
          catalogLength: normalizedCatalogForTurn.length,
          styleKey,
          normalizedCatalogForTurn,
        });
        console.log("[fuzzy_catalog_confirmed_availability]", {
          itemId,
          result: "unavailable",
          inferredIntent,
        });
        console.log("[final_reply_source]", { source: "FUZZY_CATALOG_CONFIRMED_AVAILABILITY" });
        return applyHybridOutboundResult(
          {
            reply: composed.reply,
            type: "AI_MESSAGE",
            messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
          },
          routingCtx
        );
      }

      const availabilityCtx = buildAvailabilityContextSkeleton({
        intent: "item_availability",
        requestedItem: {
          itemId,
          displayLabel,
          availabilityStatus: "available",
          blockingReason: null,
        },
        inventorySummary: {
          status: "fresh",
          totalItems: normalizedCatalogForTurn.length,
          availableCount: 1,
          unavailableCount: 0,
          topAvailableItems: [],
          maxItemsShown: 5,
        },
        policy: {},
      });
      const reply = await resolveAvailabilityCustomerReply({
        availabilityCtx,
        userMessage: message || "available",
        styleKey,
        __availabilityAiCompletionForTests,
      });
      console.log("[fuzzy_catalog_confirmed_availability]", {
        itemId,
        result: "available",
        inferredIntent,
      });
      console.log("[final_reply_source]", { source: "FUZZY_CATALOG_CONFIRMED_AVAILABILITY" });
      return applyHybridOutboundResult(
        {
          reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaWithOutboundTrace(
            hasUsefulBusinessData,
            buildOutboundTrace({
              finalReplySource: "FUZZY_CATALOG_CONFIRMED_AVAILABILITY",
              composedAnswerSource: "structured_availability",
            })
          ),
        },
        routingCtx
      );
    }

    if (inferredIntent === "pricing_question") {
      const composerItem = mergeComposerCatalogItem(hydratedItem, normalizedCatalogForTurn);
      let askedField = requestedField;
      if (!askedField || askedField === "unknown") {
        askedField = "price";
      }
      const answer = composeInformationalAnswer({
        message: `${displayLabel} price`,
        draftReply: "",
        item: composerItem,
        askedField,
      });
      console.log("[fuzzy_catalog_confirmed_pricing]", {
        itemId,
        field: answer.field,
        source: answer.source,
      });
      if (
        shouldStoreLastVerifiedCatalogAnswer({
          composedAnswer: answer,
          composerItem,
        })
      ) {
        storeLastVerifiedCatalogAnswer({
          memory: memoryForAction,
          item: composerItem,
          composedAnswer: answer,
          requestedField: askedField,
          participantKey: sourceParticipantKey || "",
          chatContextKey,
          sessionKey: emilySessionKey,
          traceId,
        });
      }
      console.log("[final_reply_source]", { source: "FUZZY_CATALOG_CONFIRMED_PRICING" });
      return applyHybridOutboundResult(
        {
          reply: answer.reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaWithOutboundTrace(
            hasUsefulBusinessData,
            buildOutboundTrace({
              finalReplySource: "FUZZY_CATALOG_CONFIRMED_PRICING",
              composedAnswerSource: answer.source ?? "verified_catalog",
              askedField: answer.field ?? null,
            })
          ),
        },
        routingCtx
      );
    }

    const generalAnswer = composeInformationalAnswer({
      message: displayLabel,
      draftReply: "",
      item: mergeComposerCatalogItem(hydratedItem, normalizedCatalogForTurn),
      askedField: requestedField !== "unknown" ? requestedField : "details",
    });
    console.log("[fuzzy_catalog_confirmed_general]", { itemId, inferredIntent });
    console.log("[final_reply_source]", { source: "FUZZY_CATALOG_CONFIRMED_GENERAL" });
    return applyHybridOutboundResult(
      {
        reply: generalAnswer.reply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaWithOutboundTrace(
          hasUsefulBusinessData,
          buildOutboundTrace({
            finalReplySource: "FUZZY_CATALOG_CONFIRMED_GENERAL",
            composedAnswerSource: generalAnswer.source ?? null,
            askedField: generalAnswer.field ?? null,
          })
        ),
      },
      routingCtx
    );
  }

  async function maybeConsumePendingAction() {
    const memoryForAction = getEmilySessionState(emilySessionKey);
    const pendingAction = memoryForAction?.pendingAction;
    if (!pendingAction) return null;

    const replyIntent = inferPendingActionReplyIntent(message, { pendingAction });
    if (
      pendingAction.type === PENDING_ACTION_TYPES.COLLECT_DURATION ||
      pendingAction.type === PENDING_ACTION_TYPES.CONFIRM_FUZZY_CATALOG
    ) {
      const explicitOtherItem = hasExplicitNewItemMention(
        message,
        normalizedCatalogForTurn,
        pendingAction.itemId
      );
      if (explicitOtherItem.found) {
        clearPendingAction(
          memoryForAction,
          pendingAction.type === PENDING_ACTION_TYPES.CONFIRM_FUZZY_CATALOG
            ? "EXPLICIT_NEW_ITEM"
            : "EXPLICIT_NEW_ITEM"
        );
        console.log("[pending_action_overridden_by_explicit_item]", {
          type: String(pendingAction.type ?? "").trim() || null,
          previousItemId: String(pendingAction.itemId ?? "").trim() || null,
          newItemId: explicitOtherItem.itemId,
          newItemLabel: explicitOtherItem.itemLabel,
        });
        return null;
      }
    }
    if (
      pendingAction.type === PENDING_ACTION_TYPES.COLLECT_DURATION &&
      isPureAckMessage(message)
    ) {
      const reask = buildCollectDurationReaskReply(pendingAction, conversationStyle);
      console.log("[collect_duration_pure_ack_reask]", {
        pendingActionId: String(pendingAction?.id ?? "").trim() || null,
        itemId: String(pendingAction?.itemId ?? "").trim() || null,
      });
      console.log("[final_reply_source]", { source: "COLLECT_DURATION_REASK" });
      return applyHybridOutboundResult(
        {
          reply: reask,
          type: "AI_MESSAGE",
          messageMeta: messageMetaWithOutboundTrace(
            hasUsefulBusinessData,
            buildOutboundTrace({
              kind: ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT,
              finalReplySource: "COLLECT_DURATION_REASK",
              pendingActionTypeStored: PENDING_ACTION_TYPES.COLLECT_DURATION,
              collectDurationPrompt: true,
            })
          ),
        },
        routingCtx
      );
    }

    const validation = validatePendingActionBinding({
      pendingAction,
      replyIntent,
      participantKey: sourceParticipantKey || "",
      groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
      sessionKey: emilySessionKey,
    });
    console.log("[pending_action_binding_decision]", {
      pendingActionId: String(pendingAction?.id ?? "").trim() || null,
      type: String(pendingAction?.type ?? "").trim() || null,
      replyIntent: replyIntent.type,
      confidence: replyIntent.confidence,
      ok: validation.ok,
      reason: validation.reason || "OK",
    });

    if (!validation.ok) {
      if (validation.rejected) {
        clearPendingAction(memoryForAction, "REJECTED_BY_USER");
        return applyHybridOutboundResult(
          {
            reply: "Theek hai 👍",
            type: "AI_MESSAGE",
            messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
          },
          routingCtx
        );
      }
      if (validation.clear) {
        clearPendingAction(memoryForAction, validation.reason || "BINDING_FAILED");
      }
      return null;
    }

    if (pendingAction.type === PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER) {
      return executeAcceptShortBookingOffer(pendingAction, memoryForAction);
    }
    if (pendingAction.type === PENDING_ACTION_TYPES.COLLECT_DURATION) {
      return executeCollectDuration(pendingAction, memoryForAction, replyIntent);
    }
    if (pendingAction.type === PENDING_ACTION_TYPES.CONFIRM_FUZZY_CATALOG) {
      return executeConfirmFuzzyCatalog(pendingAction, memoryForAction);
    }
    clearPendingAction(memoryForAction, "ACTION_NOT_WIRED");
    return null;
  }

  const pendingActionResult = await maybeConsumePendingAction();
  if (pendingActionResult) {
    return pendingActionResult;
  }

  if (isPureAckMessage(message)) {
    const memoryAfterPending = getEmilySessionState(emilySessionKey);
    const pureAckBindingCtx = {
      participantKey: sourceParticipantKey || "",
      groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
      sessionKey: emilySessionKey,
    };
    if (canResolvePureAckWithoutConsumablePending(memoryAfterPending, message, pureAckBindingCtx)) {
      const ackOutcome = resolvePureAckNoOutbound({
        memory: memoryAfterPending,
        conversationStyle,
      });
      if (ackOutcome.type === "silent") {
        console.log("[pure_ack_silent_guard]", {
          traceId: traceId || null,
          messagePreview: String(message ?? "").trim().slice(0, 40) || null,
          priorKind: memoryAfterPending?.lastAssistantOutbound?.kind ?? null,
          priorFinalReplySource:
            memoryAfterPending?.lastAssistantOutbound?.finalReplySource ?? null,
        });
        console.log("[final_reply_source]", { source: "PURE_ACK_SILENT" });
        return applyHybridOutboundResult(
          {
            reply: "",
            type: "AI_MESSAGE",
            messageMeta: buildIntentionalSilentNoopMessageMeta(hasUsefulBusinessData),
            sendVia: "NONE",
          },
          routingCtx
        );
      }
      const ackReply = ackOutcome.reply;
      console.log("[pure_ack_noop_guard]", {
        traceId: traceId || null,
        messagePreview: String(message ?? "").trim().slice(0, 40) || null,
        replyPreview: ackReply,
      });
      console.log("[final_reply_source]", { source: "PURE_ACK_NOOP" });
      return applyHybridOutboundResult(
        {
          reply: ackReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaWithOutboundTrace(hasUsefulBusinessData, {
            finalReplySource: "PURE_ACK_NOOP",
            kind: "ack_noop",
          }),
        },
        routingCtx
      );
    }
  }

  if (DEBUG_EXTRACT) {
    const servicesList = businessContext?.servicesList;
    console.log("[DEBUG] Business data:", {
      userId,
      businessName,
      businessType,
      profileDocMissing: businessProfile == null,
      businessKnowledgeChars: safeKnowledge.length,
      mergedKnowledgeChars: mergedKnowledge.length,
      hasUsefulBusinessData,
      businessContextKeys:
        businessContext != null && typeof businessContext === "object"
          ? Object.keys(businessContext)
          : [],
      servicesListCount: Array.isArray(servicesList) ? servicesList.length : 0,
      catalogItemsCount: normalizedCatalogForTurn.length,
      catalogSourceForTurn,
    });
  }

  const extractionStartedAt = Date.now();
  const memForCatalogInput = getEmilySessionState(emilySessionKey);

  // Intent classification is needed for safe routing decisions. We cache it so
  // we can compute it early (before any early-booking returns) and reuse later
  // without changing the underlying LLM / priority implementation.
  /** @type {any | null} */
  let llmIntentClassificationCached = null;
  /** @type {any | null} */
  let prioritizedIntentCached = null;

  function isInformationalPriorityIntent(priorityIntent) {
    const p = String(priorityIntent ?? "").trim().toLowerCase();
    // NOTE: applyIntentPriority currently emits "price" (not "pricing").
    return p === "price" || p === "pricing" || p === "details" || p === "information";
  }

  async function computeIntentPriorityIfNeeded({ selectedItem } = {}) {
    if (llmIntentClassificationCached && prioritizedIntentCached) {
      return { llmIntentClassificationCached, prioritizedIntentCached };
    }

    const previousAssistantForIntent =
      getRecentAssistantReplies(userId, 1, sessionKey)[0] ?? "";
    llmIntentClassificationCached = await classifyConversationIntentWithLLM({
      messageText: message,
      selectedItem: selectedItem ?? null,
      memory: memForCatalogInput,
      previousAssistantMessage: previousAssistantForIntent,
      businessContext,
    });
    prioritizedIntentCached = applyIntentPriority(llmIntentClassificationCached, {
      messageText: message,
      hasDuration: durationDays != null,
      hasContact: hasContactForBookingEarly,
    });
    return { llmIntentClassificationCached, prioritizedIntentCached };
  }
  const currentFocusedItemForPinnedGuard =
    memForCatalogInput?.lastItem && typeof memForCatalogInput.lastItem === "object"
      ? memForCatalogInput.lastItem
      : existingChatContext.lastFocusedItem
        ? { name: existingChatContext.lastFocusedItem }
        : null;
  const rawPinnedEntityName =
    inboundEntity != null && String(inboundEntity).trim() !== ""
      ? String(inboundEntity).trim()
      : null;
  const blockPinnedEntity = shouldBlockPinnedEntityForFollowup({
    message,
    pinnedEntityName: rawPinnedEntityName,
    currentItem: currentFocusedItemForPinnedGuard,
  });
  if (blockPinnedEntity) {
    console.log("[stale_pinned_entity_blocked]", {
      pinnedEntity: rawPinnedEntityName,
      currentItem:
        buildDisplayLabel(
          currentFocusedItemForPinnedGuard &&
            typeof currentFocusedItemForPinnedGuard === "object"
            ? currentFocusedItemForPinnedGuard
            : {}
        ) || String(currentFocusedItemForPinnedGuard?.name ?? "").trim() || null,
      reason: "FOLLOWUP_NO_EXPLICIT_ENTITY",
    });
  }
  const pinnedEntityName = blockPinnedEntity ? null : rawPinnedEntityName;
  const detailEntityGuard = shouldSkipEntityExtractionForDetailQuestion(
    message,
    normalizedCatalogForTurn
  );
  if (detailEntityGuard.skip) {
    console.log("[entity_extraction_skipped_for_detail]", {
      field: detailEntityGuard.field,
      message,
      reason: "DETAIL_FIELD_WITHOUT_ITEM",
    });
  }
  const entityResult = detailEntityGuard.skip
    ? {
        name: null,
        confidence: 0,
        entityType: "item",
        source: "detail_field_guard",
      }
    : pinnedEntityName
    ? {
        name: pinnedEntityName,
        confidence: 1,
        entityType: "item",
        source: "pinned_inbound",
      }
    : { ...extractEntity(message), source: "user_message" };
  const confThreshold = getEntityConfidenceThreshold(entityResult.name);
  const extractedEntity =
    entityResult.name != null &&
    entityResult.confidence > 0.8 &&
    entityResult.confidence >= confThreshold
      ? entityResult.name
      : null;
  console.log("[entity_extraction]", {
    extractedEntity: entityResult.name ?? null,
    acceptedEntity: extractedEntity ?? null,
    confidence: Number(entityResult.confidence ?? 0),
    source: entityResult.source ?? "user_message",
  });
  if (!extractedEntity) {
    console.log("[entity_override_blocked]", {
      reason:
        entityResult.name != null && String(entityResult.name).trim() !== ""
          ? "LOW_CONFIDENCE"
          : "NO_ENTITY_IN_MESSAGE",
    });
  }
  const entityType = extractedEntity
    ? entityResult.entityType ?? "item"
    : "item";

  if (blockPinnedEntity && currentFocusedItemForPinnedGuard) {
    console.log("[followup_context_lock_applied]", {
      currentItem:
        buildDisplayLabel(
          currentFocusedItemForPinnedGuard &&
            typeof currentFocusedItemForPinnedGuard === "object"
            ? currentFocusedItemForPinnedGuard
            : {}
        ) || String(currentFocusedItemForPinnedGuard?.name ?? "").trim() || null,
    });
  }
  let parsedDurationPreference = parseUserDuration(message);
  const extracted = extractDuration(message);
  let durationDays = extracted.durationDays ?? null;
  const bareDurationMessage = isBareDurationMessage(message);
  let durationMemoryCandidate =
    memForCatalogInput?.lastItem && typeof memForCatalogInput.lastItem === "object"
      ? memForCatalogInput.lastItem
      : null;
  let turnLockedItem = null;
  const recentAssistantRepliesForDuration = getRecentAssistantReplies(
    userId,
    3,
    sessionKey
  );
  const previousAssistantAskedDuration = bareDurationMessage
    ? previousAssistantAskedDurationForItem(
        history,
        recentAssistantRepliesForDuration,
        durationMemoryCandidate
      )
    : true;
  const durationContextPolicy = resolveDurationContextPolicy({
    message,
    bareDurationMessage,
    previousAssistantAskedDuration,
    durationMemoryCandidate,
    catalogItems: normalizedCatalogForTurn,
    memory: memForCatalogInput,
    recentAssistantReplies: recentAssistantRepliesForDuration,
    participantKey: sourceParticipantKey || "",
    chatContextKey,
    sessionKey: emilySessionKey,
    traceId,
    isGroupInbound,
  });
  let durationContextAllowed = durationContextPolicy.durationContextAllowed;
  let durationContextReason = durationContextPolicy.durationContextReason;
  const priceDurationFollowupWithSafeItem =
    durationContextPolicy.priceDurationFollowupWithSafeItem === true;
  if (
    durationContextPolicy.itemlessPriceDurationFollowup &&
    !priceDurationFollowupWithSafeItem
  ) {
    console.warn("[price_duration_followup_clarification_required]", {
      traceId,
      participantKey: sourceParticipantKey || null,
      chatContextKey,
      sessionKey: emilySessionKey,
      reason: durationContextPolicy.safePreviousReason || "NO_SAFE_ITEM",
    });
    return applyHybridOutboundResult(
      {
        reply: buildItemlessPriceDurationClarificationReply(),
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(false),
      },
      routingCtx
    );
  }
  if (
    priceDurationFollowupWithSafeItem &&
    durationContextPolicy.priceFollowupCatalogItem &&
    typeof durationContextPolicy.priceFollowupCatalogItem === "object"
  ) {
    const followupItem = durationContextPolicy.priceFollowupCatalogItem;
    const followupItemId = normalizeId(followupItem.id ?? followupItem.itemId);
    if (followupItemId) {
      durationMemoryCandidate = {
        ...(durationMemoryCandidate && typeof durationMemoryCandidate === "object"
          ? durationMemoryCandidate
          : {}),
        ...followupItem,
        id: followupItemId,
        itemId: followupItemId,
      };
      if (memForCatalogInput) {
        memForCatalogInput.lastItem = durationMemoryCandidate;
        setLastResolvedItemId(memForCatalogInput, followupItemId);
      }
    }
  }
  const activeDurationItemId = normalizeId(durationMemoryCandidate?.id);
  if (priceDurationFollowupWithSafeItem) {
    const parsedFollowupDuration = parseUserDuration(message);
    console.log("[price_duration_followup_allowed]", {
      traceId,
      itemId: activeDurationItemId || null,
      itemDisplayLabel:
        buildDisplayLabel(
          durationMemoryCandidate && typeof durationMemoryCandidate === "object"
            ? durationMemoryCandidate
            : {}
        ) || null,
      reason:
        durationContextPolicy.safePreviousProofSource || "LAST_VERIFIED_CATALOG_ANSWER",
      duration: parsedFollowupDuration?.normalizedDays ?? null,
      requestedField: resolveItemlessPriceDurationAskedField(message),
      participantKey: sourceParticipantKey || null,
      chatContextKey,
    });
  }
  const activeDurationItemLabel =
    buildDisplayLabel(
      durationMemoryCandidate && typeof durationMemoryCandidate === "object"
        ? durationMemoryCandidate
        : {}
    ) ||
    String(durationMemoryCandidate?.name ?? "").trim() ||
    null;
  if (isGroupInbound) {
    console.log("[group_duration_context_check]", {
      bareDurationMessage,
      previousAssistantAskedDuration,
      hasDurationMemoryItem: Boolean(normalizeId(durationMemoryCandidate?.id)),
      sourceParticipantKey: sourceParticipantKey || null,
      emilySessionKey,
    });
  }
  if (
    bareDurationMessage &&
    durationContextAllowed &&
    activeDurationItemId &&
    !priceDurationFollowupWithSafeItem
  ) {
    const activeAvailability = await getUserFacingAvailabilityForItem(
      activeDurationItemId,
      activeDurationItemLabel,
      "duration"
    );
    if (activeAvailability?.isAvailable === false) {
      durationContextAllowed = false;
      durationContextReason = "ACTIVE_ITEM_UNAVAILABLE";
    } else {
      turnLockedItem = {
        itemId: activeDurationItemId,
        itemLabel: activeDurationItemLabel,
        name: String(durationMemoryCandidate?.name ?? "").trim() || activeDurationItemLabel,
        displayLabel: activeDurationItemLabel,
        reason: "BARE_DURATION_AFTER_ASK_DURATION",
      };
      console.log("[item_context_lock]", {
        reason: turnLockedItem.reason,
        lockedItemId: turnLockedItem.itemId,
        lockedItemLabel: turnLockedItem.itemLabel,
      });
    }
  }
  console.log("[duration_context_guard]", {
    rawText: String(message ?? ""),
    parsedDuration: extracted.durationDays ?? null,
    previousAssistantAskedDuration,
    activeItemForBooking: activeDurationItemId,
    allowed: durationContextAllowed,
    reason: durationContextReason,
  });
  if (bareDurationMessage && durationContextReason === "ACTIVE_ITEM_UNAVAILABLE") {
    return applyHybridOutboundResult(
      {
        reply: buildUnavailableReply({
          itemLabel: activeDurationItemLabel,
          style: conversationStyle,
        }),
        type: "AI_MESSAGE",
        messageMeta: {
          ...messageMetaForKnowledge(hasUsefulBusinessData),
          bookingBlocked: true,
          reason: "ALREADY_BOOKED",
        },
      },
      routingCtx
    );
  }
  const contactPartsEarly = extractBookingContactParts(message);
  logContactParse(contactPartsEarly);
  const extractedContactEarly = contactPartsEarly.isValid
    ? String(contactPartsEarly.normalizedPhone || contactPartsEarly.phone || "").trim()
    : null;
  if (isValidContactValue(extractedContactEarly) && !isGroupInbound) {
    memForCatalogInput.contact = extractedContactEarly;
    if (contactPartsEarly.name) {
      memForCatalogInput.customerName = contactPartsEarly.name;
    }
  } else if (isValidContactValue(extractedContactEarly) && isGroupInbound) {
    console.log("[group_logistics_mutation_blocked]", {
      attemptedFields: ["contactPhone", ...(contactPartsEarly.name ? ["customerName"] : [])],
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      groupName: groupName || null,
      chatKey: playwrightChatKey || null,
      reason: "GROUP_PRIVATE_DETAIL_MUTATION_BLOCKED",
    });
  }
  const hasContactForBookingEarly = !isGroupInbound && isValidContactValue(extractedContactEarly)
    ? true
    : !isGroupInbound && isValidContactValue(memForCatalogInput?.contact)
      ? true
      : false;
  const deterministicDurationAlreadySucceeded = parsedDurationPreference != null;
  if (!deterministicDurationAlreadySucceeded) {
    let shouldRunGenericSlotProposal = typeof __genericSlotProposalForTests === "function";
    let slotIntent = null;
    if (!shouldRunGenericSlotProposal) {
      const { prioritizedIntentCached: slotPriority } = await computeIntentPriorityIfNeeded({
        selectedItem: currentFocusedItemForPinnedGuard,
      });
      slotIntent = slotPriority;
      shouldRunGenericSlotProposal =
        slotPriority?.confidence === "high" ||
        ["booking", "price", "details", "availability", "delivery"].includes(
          String(slotPriority?.priorityIntent ?? slotPriority?.primaryIntent ?? "").trim().toLowerCase()
        );
    }
    if (shouldRunGenericSlotProposal) {
      const requestedSlots = [
        "duration",
        "itemReference",
        "requestedField",
        "deliveryLocationHint",
        "deliveryMethod",
        "dateOrTime",
      ];
      console.log("[slot_proposal_started]", {
        requestedSlots,
        messagePreview: String(message ?? "").trim().slice(0, 160) || null,
        isGroupInbound,
        deterministicParserAlreadySucceeded: false,
        intent: String(slotIntent?.priorityIntent ?? slotIntent?.primaryIntent ?? inboundIntent ?? "").trim() || null,
      });
      try {
        const proposal =
          typeof __genericSlotProposalForTests === "function"
            ? await __genericSlotProposalForTests({
                messageText: message,
                requestedSlots,
                context: {
                  intent: slotIntent?.priorityIntent ?? slotIntent?.primaryIntent ?? inboundIntent ?? null,
                  askedField: slotIntent?.askedField ?? null,
                  hasCurrentItem: Boolean(normalizeId(durationMemoryCandidate?.id)),
                  isGroupInbound,
                },
              })
            : await extractGenericSlotsWithLLM({
                messageText: message,
                requestedSlots,
                context: {
                  intent: slotIntent?.priorityIntent ?? slotIntent?.primaryIntent ?? null,
                  askedField: slotIntent?.askedField ?? null,
                  hasCurrentItem: Boolean(normalizeId(durationMemoryCandidate?.id)),
                  isGroupInbound,
                },
              });
        console.log("[slot_proposal_result]", {
          proposedSlots: Object.entries(proposal?.slots || {})
            .filter(([, value]) => value != null)
            .map(([key]) => key),
          rejectedForbiddenFields: proposal?.rejectedForbiddenFields || [],
          rejectedUnknownSlotKeys: proposal?.rejectedUnknownSlotKeys || [],
          reason: String(proposal?.reason ?? "").slice(0, 160) || null,
          isGroupInbound,
          deterministicParserAlreadySucceeded: false,
        });
        const validation = await validateGenericSlotProposalForTurn({
          proposal,
          messageText: message,
          deterministicSlots: { duration: parsedDurationPreference },
          currentItem: durationMemoryCandidate,
          hasExplicitEntity: Boolean(extractedEntity),
          isGroupInbound,
          resolveCatalogItem: (raw) => resolveCatalogThisTurn(raw, memForCatalogInput),
        });
        if (validation.accepted.duration) {
          parsedDurationPreference = validation.accepted.duration;
          extracted.durationDays = validation.accepted.duration.normalizedDays;
          durationDays = extracted.durationDays ?? null;
          console.log("[duration_slot_proposal_applied]", {
            value: validation.accepted.duration.value,
            unit: validation.accepted.duration.unit,
            normalizedDays: validation.accepted.duration.normalizedDays,
            normalizedHours: validation.accepted.duration.normalizedHours ?? null,
            isGroupInbound,
          });
        }
      } catch (err) {
        console.log("[slot_proposal_rejected]", {
          slotType: "generic",
          rawText: String(message ?? "").trim().slice(0, 160) || null,
          proposedValue: null,
          proposedUnit: null,
          confidence: null,
          validatorResult: "rejected",
          rejectionReason: String(err?.message ?? err ?? "slot_proposal_failed").slice(0, 160),
          isGroupInbound,
          deterministicParserAlreadySucceeded: false,
        });
      }
    }
  }
  const shortBookingSelection = shortBookingSelectionFromParsedDuration(
    parsedDurationPreference,
    businessProfile?.rawBusinessProfile ?? businessProfile?.profileData ?? businessProfile
  );
  if (
    extracted.durationDays != null &&
    durationContextAllowed &&
    !priceDurationFollowupWithSafeItem &&
    shortBookingSelection?.type !== "below_minimum"
  ) {
    memForCatalogInput.lastDuration = extracted.durationDays;
  } else if (shortBookingSelection?.type === "below_minimum") {
    durationDays = null;
    memForCatalogInput.lastDuration = null;
    memForCatalogInput.durationPreference = null;
  } else if (extracted.durationDays != null && !durationContextAllowed) {
    durationDays = null;
    memForCatalogInput.lastDuration = null;
    memForCatalogInput.durationPreference = null;
  }
  if (
    !turnLockedItem &&
    isValidContactValue(extractedContactEarly) &&
    (memForCatalogInput?.askedContact === true ||
      String(memForCatalogInput?.stage ?? "").toLowerCase() === "askcontact")
  ) {
    const contactItemId = normalizeId(memForCatalogInput?.lastItem?.id);
    const contactItemLabel =
      buildDisplayLabel(
        memForCatalogInput?.lastItem && typeof memForCatalogInput.lastItem === "object"
          ? memForCatalogInput.lastItem
          : {}
      ) ||
      String(memForCatalogInput?.lastItem?.name ?? "").trim() ||
      null;
    if (contactItemId) {
      const contactAvailability = await getUserFacingAvailabilityForItem(
        contactItemId,
        contactItemLabel,
        "memory"
      );
      turnLockedItem = {
        itemId: contactItemId,
        itemLabel: contactItemLabel,
        name: String(memForCatalogInput?.lastItem?.name ?? "").trim() || contactItemLabel,
        displayLabel: contactItemLabel,
        reason:
          contactAvailability?.isAvailable === false
            ? "CONTACT_AFTER_ASK_CONTACT_UNAVAILABLE"
            : "CONTACT_AFTER_ASK_CONTACT",
        isAvailable: contactAvailability?.isAvailable !== false,
      };
      console.log("[item_context_lock]", {
        reason: turnLockedItem.reason,
        lockedItemId: turnLockedItem.itemId,
        lockedItemLabel: turnLockedItem.itemLabel,
      });
    }
  }
  let hasDuration = durationDays != null;
  logTiming("extraction", extractionStartedAt, {
    extractedEntity: extractedEntity ?? null,
    entityType,
    hasDuration,
    hasContact: hasContactForBookingEarly,
  });

  let resolvedItemEntityName = null;
  let validatedPinnedEntityName = null;

  /** @type {{ itemId: string, name: string, isAvailable: boolean, nextAvailableAt?: string, alternativeItems?: Array<{ id: string, name: string }> } | null} */
  let itemContext = null;

  const lockedItemAsContext = () =>
    turnLockedItem
      ? {
          itemId: turnLockedItem.itemId,
          id: turnLockedItem.itemId,
          name: turnLockedItem.name || turnLockedItem.itemLabel,
          displayLabel: turnLockedItem.itemLabel || turnLockedItem.name,
        }
      : null;
  const blockItemOverwriteIfLocked = (attemptedItemId, sourceLabel) => {
    const attempted = normalizeId(attemptedItemId);
    const locked = normalizeId(turnLockedItem?.itemId);
    if (locked && attempted && attempted !== locked) {
      console.log("[item_context_overwrite_blocked]", {
        attemptedItemId: attempted,
        lockedItemId: locked,
        source: sourceLabel,
      });
      return true;
    }
    return false;
  };
  const applyTurnLockedItemContext = async (sourceLabel) => {
    const lockedCtx = lockedItemAsContext();
    if (!lockedCtx) return;
    itemContext = await hydrateItemWithAvailability(lockedCtx, sourceLabel);
    if (memForCatalogInput && typeof memForCatalogInput === "object") {
      memForCatalogInput.lastItem = {
        id: turnLockedItem.itemId,
        name: turnLockedItem.name || turnLockedItem.itemLabel,
        displayLabel: turnLockedItem.itemLabel || turnLockedItem.name,
      };
      setLastResolvedItemId(memForCatalogInput, turnLockedItem.itemId);
    }
  };

  if (turnLockedItem) {
    await applyTurnLockedItemContext("duration");
    if (
      turnLockedItem.isAvailable === false ||
      (itemContext && typeof itemContext === "object" && itemContext.isAvailable === false)
    ) {
      return applyHybridOutboundResult(
        {
          reply: buildUnavailableReply({
            itemLabel: turnLockedItem.itemLabel,
            style: conversationStyle,
          }),
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx
      );
    }
  }

  if (shortBookingSelection?.type === "accepted") {
    console.log("[booking_duration_half_day_selected]", {
      durationHours: shortBookingSelection.durationHours,
      billingUnit: shortBookingSelection.billingUnit,
      billingRatePercentOfDaily: shortBookingSelection.billingRatePercentOfDaily,
      isGroupInbound,
    });
  }

  if (extractedEntity && entityType !== "category") {
    let row = await timeAsync(
      "item_resolution",
      () => findItemByName(userId, extractedEntity),
      { inputPreview: String(extractedEntity).slice(0, 80), path: "findItemByName" }
    );
    if (!row && extractedEntity) {
      try {
        const items = normalizedCatalogForTurn;
        const scored = getBestTokenMatchWithScore(extractedEntity, items);
        const fallback = scored.match ?? getBestTokenMatch(extractedEntity, items);
        if (fallback) {
          console.log("🔁 Token fallback match:", {
            query: extractedEntity,
            matched: fallback.name,
            score: scored.score,
          });
          row = fallback;
        }
      } catch (err) {
        console.warn("⚠️ Token fallback error:", err?.message || err);
      }
    }
    if (row) {
      if (blockItemOverwriteIfLocked(row.id, "extracted_entity_resolution")) {
        row = null;
      }
    }
    if (row) {
      resolvedItemEntityName = String(row.name ?? "").trim() || extractedEntity;
      const availabilityItemId = String(row?.id ?? "").trim();
      if (!availabilityItemId) {
        console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
          resolvedItem: row ?? null,
        });
      }
      const av = availabilityItemId
        ? await getUserFacingAvailabilityForItem(
            availabilityItemId,
            row.name,
            "initial"
          )
        : { isAvailable: true };
      /** @type {Array<{ id: string, name: string }>} */
      let alternativeItems = [];
      let alternativeSummarySkipped = false;
      const MAX_CATALOG_FOR_ALT_SNAPSHOT = 400;
      if (av.isAvailable === false) {
        if (normalizedCatalogForTurn.length > MAX_CATALOG_FOR_ALT_SNAPSHOT) {
          alternativeSummarySkipped = true;
        } else if (normalizedCatalogForTurn.length > 0) {
          const raw = await pickAlternativeAvailableItemsFromCatalogRows(
            userId,
            String(row.id).trim(),
            String(row.name ?? "").trim(),
            normalizedCatalogForTurn,
            { limit: 5, maxRankedCandidates: 150 }
          );
          alternativeItems = raw.map((x) => ({
            id: String(x.id ?? x.itemId ?? "").trim(),
            name: String(x.name ?? "").trim(),
          }));
        } else {
          const raw = await getAlternativeAvailableItems(
            userId,
            row.id,
            row.name,
            5
          );
          alternativeItems = raw.map(({ id, name }) => ({ id, name }));
        }
      }
      itemContext = {
        itemId: row.id,
        name: row.name,
        displayLabel: buildDisplayLabel(row),
        ...(row.color != null && String(row.color).trim() !== ""
          ? { color: String(row.color).trim() }
          : {}),
        availability:
          typeof row.availability === "boolean" ? row.availability : null,
        isAvailable: av.isAvailable,
        blockingStatusesSeen: Array.isArray(av.blockingStatusesSeen)
          ? av.blockingStatusesSeen
          : [],
        ...(av.nextAvailableAt != null && {
          nextAvailableAt: new Date(av.nextAvailableAt).toISOString(),
        }),
        ...(alternativeSummarySkipped ? { alternativeSummarySkipped: true } : {}),
        ...(alternativeItems.length > 0 && { alternativeItems }),
      };
    }
  }
  if (
    pinnedEntityName != null &&
    String(pinnedEntityName).trim() !== "" &&
    entityType !== "category"
  ) {
    const pinnedRow = await findItemByName(userId, String(pinnedEntityName).trim());
    if (pinnedRow) {
      validatedPinnedEntityName =
        String(pinnedRow.name ?? "").trim() || String(pinnedEntityName).trim();
    }
  }

  // --- Inventory-backed fallback: promote accepted extracted entity into item-flow candidate ---
  // Only runs after existing candidate sources fail (resolved item, pinned entity, confirmation fallback).
  const previousCandidateForExtractedFallback = resolvedItemEntityName || validatedPinnedEntityName;
  const extractedFallbackEntity =
    extractedEntity != null && String(extractedEntity).trim() !== ""
      ? String(extractedEntity).trim()
      : "";
  const detectedIntentForExtractedFallback = detectIntent(message);
  if (
    !previousCandidateForExtractedFallback &&
    extractedFallbackEntity &&
    entityType !== "category" &&
    typeof resolveCatalogThisTurn === "function"
  ) {
    console.log("[extracted_item_entity_resolution_started]", {
      extractedEntity: extractedFallbackEntity,
      entityType: String(entityType ?? "item"),
      previousCandidate: null,
      resolvedItemId: null,
      resolvedItemName: null,
      resolutionSource: "resolveCatalogThisTurn",
      reason: "candidate_missing",
    });
    try {
      const resolved = await resolveCatalogThisTurn(extractedFallbackEntity, memForCatalogInput);
      const resolvedItemId = normalizeId(resolved?.id);
      const resolvedItemName = String(resolved?.name ?? "").trim();
      if (resolved && resolvedItemId) {
        if (!blockItemOverwriteIfLocked(resolvedItemId, "extracted_entity_inventory_fallback")) {
          resolvedItemEntityName = resolvedItemName || extractedFallbackEntity;
          // Promote to itemContext if not already present (keeps current order / behavior).
          if (!itemContext) {
            itemContext = await hydrateItemWithAvailability(
              {
                ...resolved,
                itemId: resolvedItemId,
                id: resolvedItemId,
              },
              "extracted_entity_inventory_fallback"
            );
          }
          if (
            detectedIntentForExtractedFallback === "availability" &&
            resolvedItemEntityName
          ) {
            console.log("[item_availability_flow_bridge_used]", {
              extractedEntity: extractedFallbackEntity,
              entityType: String(entityType ?? "item"),
              previousCandidate: null,
              resolvedItemId,
              resolvedItemName: resolvedItemEntityName,
              resolutionSource: "resolveCatalogThisTurn",
              reason: "availability_intent_with_resolved_item",
            });
          }
          console.log("[extracted_item_entity_resolution_success]", {
            extractedEntity: extractedFallbackEntity,
            entityType: String(entityType ?? "item"),
            previousCandidate: null,
            resolvedItemId,
            resolvedItemName: resolvedItemEntityName,
            resolutionSource: "resolveCatalogThisTurn",
            reason: "resolved",
          });
        } else {
          console.log("[extracted_item_entity_resolution_failed]", {
            extractedEntity: extractedFallbackEntity,
            entityType: String(entityType ?? "item"),
            previousCandidate: null,
            resolvedItemId,
            resolvedItemName: resolvedItemName || null,
            resolutionSource: "resolveCatalogThisTurn",
            reason: "locked_item_context",
          });
        }
      } else {
        console.log("[extracted_item_entity_resolution_failed]", {
          extractedEntity: extractedFallbackEntity,
          entityType: String(entityType ?? "item"),
          previousCandidate: null,
          resolvedItemId: resolvedItemId || null,
          resolvedItemName: resolvedItemName || null,
          resolutionSource: "resolveCatalogThisTurn",
          reason: "ITEM_NOT_RESOLVED",
        });
      }
    } catch (err) {
      console.log("[extracted_item_entity_resolution_failed]", {
        extractedEntity: extractedFallbackEntity,
        entityType: String(entityType ?? "item"),
        previousCandidate: null,
        resolvedItemId: null,
        resolvedItemName: null,
        resolutionSource: "resolveCatalogThisTurn",
        reason: String(err?.message ?? err ?? "error").slice(0, 160),
      });
    }
  }

  const effectiveEntityForItemFlow =
    resolvedItemEntityName ||
    validatedPinnedEntityName;

  if (effectiveEntityForItemFlow) {
    setLastEntityName(userId, effectiveEntityForItemFlow, chatContextKey);
  }

  const contextSanitizerResult = sanitizeContextForResolvedItemChange({
    businessId: userId,
    chatId:
      String(playwrightChatKey ?? "").trim() ||
      String(groupName ?? "").trim() ||
      String(sessionKey ?? "").trim(),
    participantKey: sourceParticipantKey,
    conversationMemory: memForCatalogInput,
    memory: memForCatalogInput,
    existingChatContext,
    resolvedItem: itemContext,
    extractedEntity,
    extractedSlots: {
      durationDays: extracted.durationDays ?? null,
      contact: extractedContactEarly,
      contactName: contactPartsEarly.name || null,
      contactPhone: extractedContactEarly,
    },
    message,
    chatContextKey,
    sessionKey: emilySessionKey,
    isGroupInbound,
    explicitCurrentMessageItem: Boolean(extractedEntity),
    explicitItemSource: "extracted_entity",
  });
  if (contextSanitizerResult.itemChanged && extracted.durationDays == null) {
    durationDays = null;
    hasDuration = false;
    console.log("[duration_reuse_blocked_item_changed]", {
      previousItemKey: contextSanitizerResult.previousItemKey || null,
      newItemKey: contextSanitizerResult.newItemKey || null,
      reason: "CURRENT_MESSAGE_DURATION_MISSING",
    });
  } else if (durationDays == null) {
    durationDays =
      memForCatalogInput?.lastDuration ??
      existingChatContext.lastDuration ??
      null;
    hasDuration = durationDays != null;
  }
  if (isGroupInbound && contextSanitizerResult.itemChanged) {
    console.log("[participant_scoped_context_sanitized]", {
      chatContextKey,
      participantKey: sourceParticipantKey || null,
      previousItemKey: contextSanitizerResult.previousItemKey || null,
      newItemKey: contextSanitizerResult.newItemKey || null,
    });
  }
  const runLateContextSanitizer = ({
    source,
    explicitCurrentMessageItem,
    conversationMemory,
  }) => {
    const lateResult = sanitizeContextForResolvedItemChange({
      businessId: userId,
      chatId:
        String(playwrightChatKey ?? "").trim() ||
        String(groupName ?? "").trim() ||
        String(sessionKey ?? "").trim(),
      participantKey: sourceParticipantKey,
      conversationMemory,
      memory: memForCatalogInput,
      existingChatContext,
      resolvedItem: itemContext,
      extractedEntity,
      extractedSlots: {
        durationDays: extracted.durationDays ?? null,
        contact: extractedContactEarly,
        contactName: contactPartsEarly.name || null,
        contactPhone: extractedContactEarly,
      },
      message,
      chatContextKey,
      sessionKey: emilySessionKey,
      isGroupInbound,
      explicitCurrentMessageItem,
      explicitItemSource: source,
    });
    if (lateResult.itemChanged && extracted.durationDays == null) {
      durationDays = null;
      hasDuration = false;
      nextChatContext.lastDuration = null;
      globalThis.__chatContext[chatContextKey] = nextChatContext;
      console.log("[participant_context_saved]", {
        chatContextKey,
        participantKey: sourceParticipantKey || null,
      });
      console.log("[duration_reuse_blocked_item_changed]", {
        previousItemKey: lateResult.previousItemKey || null,
        newItemKey: lateResult.newItemKey || null,
        reason: "CURRENT_MESSAGE_DURATION_MISSING",
        source,
      });
    } else if (lateResult.itemChanged && extracted.durationDays != null) {
      durationDays = extracted.durationDays;
      hasDuration = true;
      nextChatContext.lastDuration = extracted.durationDays;
      globalThis.__chatContext[chatContextKey] = nextChatContext;
      console.log("[participant_context_saved]", {
        chatContextKey,
        participantKey: sourceParticipantKey || null,
      });
    }
    return lateResult;
  };

  let events = detectBookingEvent(message);
  if (
    isPricingOrDetailsFieldQuestion(message, {
      hasDuration: durationDays != null,
      hasContact: contactPartsEarly.isValid,
      itemMentioned: Boolean(extractedEntity),
    })
  ) {
    events = {
      ...events,
      bookingIntent: false,
      transactionalIntent: Boolean(events.orderIntent || events.confirmationIntent),
    };
    console.log("[intent_shape_early_pricing_field_override]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
    });
  }
  if (
    events.confirmationIntent === true &&
    memForCatalogInput?.lastItem &&
    (memForCatalogInput?.lastDuration ?? durationDays) != null
  ) {
    events = {
      ...events,
      bookingIntent: true,
      transactionalIntent: true,
    };
  }
  const continuationEligibleForMemoryBookingIntent =
    isBookingContinuationShapedCurrentTurn(
      message,
      extracted.durationDays ?? null,
      contactPartsEarly.isValid,
      events
    );
  if (
    durationDays != null &&
    continuationEligibleForMemoryBookingIntent &&
    (memForCatalogInput?.hasBookingIntent === true || memForCatalogInput?.lastItem?.id)
  ) {
    events = {
      ...events,
      bookingIntent: true,
      transactionalIntent: true,
    };

    console.log(
      "[INTENT OVERRIDE] Duration detected with active item \u2192 forcing booking intent",
      {
        duration: durationDays,
        item: memForCatalogInput?.lastItem?.name ?? null,
      }
    );
  }
  if (
    isExplicitPricingOrDetailsQuestion(message) &&
    !isBookingContinuationShapedCurrentTurn(
      message,
      extracted.durationDays ?? null,
      contactPartsEarly.isValid,
      events
    )
  ) {
    events = {
      ...events,
      bookingIntent: false,
      transactionalIntent: Boolean(events.orderIntent || events.confirmationIntent),
    };
  }
  const nameForBooking =
    (effectiveEntityForItemFlow && entityType !== "category"
      ? effectiveEntityForItemFlow
      : null) ??
    (events.confirmationIntent ? getLastEntityName(userId, chatContextKey) : null);
  const memoryLastItemIdEarly = normalizeId(memForCatalogInput?.lastItem?.id);
  const memoryLastItemNameEarly =
    String(memForCatalogInput?.lastItem?.name ?? "").trim() ||
    String(memForCatalogInput?.lastItem?.displayLabel ?? "").trim() ||
    String(memForCatalogInput?.lastItemMentioned ?? "").trim() ||
    null;
  let effectiveBookingName = nameForBooking;
  if (!effectiveBookingName && memoryLastItemIdEarly) {
    effectiveBookingName = memoryLastItemNameEarly;
    console.log("[BOOKING FALLBACK] using memory.lastItem", {
      id: memoryLastItemIdEarly,
      name: memoryLastItemNameEarly,
    });
  }
  if (!nameForBooking && memoryLastItemIdEarly && hasDuration && effectiveBookingName) {
    console.log("[FORCED BOOKING FROM MEMORY]", {
      item: memoryLastItemNameEarly,
      duration: durationDays,
    });
  }

  /** @type {Record<string, unknown> | null} */
  let resolvedItemFromCatalog = null;
  const lastMemIdEarly = String(memForCatalogInput?.lastItem?.id ?? "").trim();
  const memoryHadItemId = Boolean(lastMemIdEarly);
  const lastItemMentionedEarly =
    memForCatalogInput?.lastItemMentioned != null &&
    String(memForCatalogInput.lastItemMentioned).trim() !== ""
      ? String(memForCatalogInput.lastItemMentioned).trim()
      : null;

  /**
   * Resolver input: current-turn entity / booking name, else Emily thread
   * `lastItemMentioned` (prior turn) when we still lack an item id — not bare
   * `lastItem.name` alone (weak for ambiguous SKUs).
   */
  const catalogMatchInput =
    extractedEntity != null && String(extractedEntity).trim() !== ""
      ? String(extractedEntity).trim()
      : nameForBooking != null && String(nameForBooking).trim() !== ""
        ? String(nameForBooking).trim()
        : !memoryHadItemId &&
            lastItemMentionedEarly != null &&
            lastItemMentionedEarly.length >= 3
          ? lastItemMentionedEarly
          : null;

  if (catalogMatchInput && !itemContext && !memoryHadItemId) {
    resolvedItemFromCatalog = await resolveCatalogThisTurn(
      catalogMatchInput,
      memForCatalogInput
    );
    console.log("🔎 Catalog resolution:", {
      input: catalogMatchInput,
      resolvedId: resolvedItemFromCatalog?.id ?? null,
      resolvedName: resolvedItemFromCatalog?.name ?? null,
    });
  }

  logBookingEvent({
    traceId,
    step: "extraction",
    status: "success",
    data: {
      extractedEntity: extractedEntity ?? null,
      nameForBooking: nameForBooking ?? null,
      durationDays: durationDays ?? null,
      hasDuration,
    },
  });

  logBookingEvent({
    traceId,
    step: "intent_detection",
    status: "success",
    data: {
      transactionalIntent: events.transactionalIntent,
      bookingIntent: events.bookingIntent,
      orderIntent: events.orderIntent,
      confirmationIntent: events.confirmationIntent,
    },
  });

  const willAttemptBooking = Boolean(
    effectiveBookingName && events.transactionalIntent
  );
  const earlyBookingGateReason = !effectiveBookingName
    ? extractedEntity != null && String(extractedEntity).trim() !== "" && entityType !== "category"
      ? "ITEM_NOT_RESOLVED"
      : "NO_ENTITY_FOUND"
    : !events.transactionalIntent
      ? "INTENT_FALSE"
      : "EARLY_PATH_ENTERED";

  logBookingEvent({
    traceId,
    step: "early_booking_decision",
    status: willAttemptBooking ? "start" : "fail",
    data: {
      willAttemptBooking,
      reason: earlyBookingGateReason,
    },
  });

  /** @type {{ itemId: string, itemName?: string, durationDays: number } | null} */
  let bookingCreated = null;

  let requiresDuration = false;

  if (effectiveBookingName && events.transactionalIntent) {
    let lookupMethod = /** @type {"resolver" | "last_resolved" | "failed"} */ ("resolver");
    let row = null;
    const resolverRow = await resolveCatalogThisTurn(
      effectiveBookingName,
      memForCatalogInput
    );
    let resolvedItemId = normalizeId(resolverRow?.id);
    if (resolvedItemId) {
      setLastResolvedItemId(memForCatalogInput, resolvedItemId);
    } else {
      resolvedItemId =
        normalizeId(memForCatalogInput?.lastItem?.id) ||
        normalizeId(memForCatalogInput?.lastResolvedItemId);
      if (resolvedItemId) lookupMethod = "last_resolved";
    }
    if (resolvedItemId) {
      row = await findItemById(userId, resolvedItemId);
    }
    if (!row) {
      lookupMethod = "failed";
      console.warn("⚠️ Early booking: no inventory row for resolver itemId", {
        itemId: resolvedItemId,
      });
      logBookingEvent({
        traceId,
        step: "item_resolution",
        status: "fail",
        data: {
          lookupMethod,
          reason: "NO_MATCH_IN_DB",
          query: String(effectiveBookingName).slice(0, 120),
          itemId: resolvedItemId,
        },
      });
    } else {
      setLastResolvedItemId(memForCatalogInput, row.id);
      logBookingEvent({
        traceId,
        step: "item_resolution",
        status: "success",
        data: {
          lookupMethod,
          reason: "MATCHED",
          itemId: String(row.id),
          itemName: String(row.name ?? "").slice(0, 120),
          query: String(effectiveBookingName).slice(0, 120),
        },
      });

      // Guard: same-participant continuation should not re-run availability against their own active booking.
      // Conservative: only trigger when we have an active structured booking for this session + same item,
      // and the current message does not look like a new item/availability/price/details request.
      const structured = memForCatalogInput?.bookingState && typeof memForCatalogInput.bookingState === "object"
        ? memForCatalogInput.bookingState
        : null;
      const structuredStatus = String(structured?.status ?? "").trim().toLowerCase();
      const structuredBookingId = String(structured?.bookingId ?? "").trim();
      const structuredItemId = normalizeId(structured?.itemId);
      const currentItemId = normalizeId(row?.id);
      const sameItem = Boolean(structuredItemId && currentItemId && structuredItemId === currentItemId);
      const sameParticipantSession =
        Boolean(structured?.sessionKey) && String(structured.sessionKey).trim() === String(emilySessionKey ?? "").trim();
      const activeStatus = structuredStatus === "pending_approval" || structuredStatus === "approved";

      const msgLower = String(message ?? "").trim().toLowerCase();
      const explicitNewItemMention = Boolean(extractedEntity) || Boolean(pinnedEntityName) || Boolean(inboundEntity);
      const explicitAvailabilityOrInfoQuestion = Boolean(
        // NOTE: prioritizedIntent is declared later (after LLM intent classification).
        // Do NOT reference it here (TDZ ReferenceError even with optional chaining).
        /\b(avail|available|availability|price|rate|cost|charges?|kitna|kitni|kitne|model|color|colour|mileage|condition|photo|picture|pics|images)\b/i.test(
          msgLower
        )
      );
      console.log("[early_booking_guard_intent_signals]", {
        explicitAvailabilityOrInfoQuestion,
        usedSignals: ["keyword_regex"],
      });
      const explicitRestartOrNewBooking =
        /\b(new|another|koi\s+aur|different)\b/i.test(msgLower) ||
        /\b(book|booking|reserve|confirm|mujhe\s+chahiye|need|want)\b/i.test(msgLower);
      const likelyFollowupAnswer =
        !explicitNewItemMention &&
        !explicitAvailabilityOrInfoQuestion &&
        !explicitRestartOrNewBooking &&
        String(message ?? "").trim().length <= 80;

      const sameUserContinuation =
        Boolean(structuredBookingId) &&
        sameParticipantSession &&
        activeStatus &&
        sameItem &&
        likelyFollowupAnswer;

      if (sameUserContinuation) {
        console.log("[booking_continuation_same_user_detected]", {
          bookingId: structuredBookingId || null,
          participantKey: String(sourceParticipantKey ?? "").trim() || null,
          itemId: structuredItemId || null,
          status: structuredStatus || null,
          messagePreview: String(message ?? "").trim().slice(0, 160) || null,
          reason: "SAME_SESSION_ACTIVE_BOOKING_SAME_ITEM_FOLLOWUP",
        });
        console.log("[early_booking_skipped_due_to_same_user_continuation]", {
          bookingId: structuredBookingId || null,
          participantKey: String(sourceParticipantKey ?? "").trim() || null,
          itemId: structuredItemId || null,
        });
      }

      const bookings = await getBookingsForItem(userId, row.id, row.name);
      const availabilityItemId = String(row?.id ?? "").trim();
      if (!availabilityItemId) {
        console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
          resolvedItem: row ?? null,
        });
      }
      const av = availabilityItemId
        ? computeAvailabilityFromBookings(bookings, availabilityItemId)
        : { isAvailable: true };
      logBookingEvent({
        traceId,
        step: "availability_check",
        status: av.isAvailable ? "success" : "fail",
        data: {
          itemId: String(row.id),
          isAvailable: av.isAvailable,
          reason: av.isAvailable ? "NO_CONFLICT" : "ALREADY_BOOKED",
          path: "early_booking",
          ...(av.nextAvailableAt != null && {
            nextAvailableAt: new Date(av.nextAvailableAt).toISOString(),
          }),
        },
      });
      // Ensure intent routing is available BEFORE any early-booking return.
      const { prioritizedIntentCached: earlyPrioritizedIntent } =
        await computeIntentPriorityIfNeeded({
          selectedItem:
            itemContext ??
            resolvedItemFromCatalog ??
            memForCatalogInput?.lastItem ??
            null,
        });
      const earlyTurnIntentShape = resolveTurnIntentShape({
        message,
        prioritizedIntent: earlyPrioritizedIntent,
        llmIntentClassification: llmIntentClassificationCached,
        hasDuration: durationDays != null,
        hasContact: hasContactForBookingEarly,
        itemMentioned: Boolean(row?.id ?? row?.itemId),
      });
      const isInformationalIntent =
        isInformationalPriorityIntent(earlyPrioritizedIntent?.priorityIntent) ||
        isAnswerRequestedFieldPolicy(earlyTurnIntentShape);

      if (!sameUserContinuation && !av.isAvailable && !isInformationalIntent) {
        const itemLabel = buildDisplayLabel(row) || String(row.name ?? "").trim();
        const styleKey =
          conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
        let structuredReply = null;
        try {
          structuredReply = await buildBookingDurationUnavailableStructuredCustomerReply({
            userId,
            catalogRow: row,
            availabilitySnapshot: av,
            normalizedCatalogForTurn,
            styleKey,
            traceId,
            memory: memForCatalogInput,
          });
        } catch (err) {
          console.warn("[booking_unavailable_availability_context_failed]", {
            traceId: traceId || null,
            error: String(err?.message ?? err),
          });
        }
        const replyText =
          String(structuredReply ?? "").trim() ||
          buildUnavailableReply({
            itemLabel,
            style: conversationStyle,
          });
        if (!String(structuredReply ?? "").trim()) {
          console.log("[booking_unavailable_availability_context_missing]", {
            traceId: traceId || null,
            requestedItemId: String(row?.id ?? row?.itemId ?? "").trim() || null,
            reason: "STRUCTURED_REPLY_EMPTY_OR_HELPER_NULL",
            catalogCount: Array.isArray(normalizedCatalogForTurn)
              ? normalizedCatalogForTurn.length
              : 0,
            summaryStatus: null,
          });
        }
        console.log("[final_reply_source]", {
          source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
        });
        return applyHybridOutboundResult(
          {
            reply: replyText,
            text: replyText,
            type: "AI_MESSAGE",
            messageMeta: {
              ...messageMetaForKnowledge(hasUsefulBusinessData),
              bookingBlocked: true,
              reason: "ALREADY_BOOKED",
            },
          },
          routingCtx
        );
      }
      const shouldPersist =
        events.bookingIntent ||
        events.orderIntent ||
        events.confirmationIntent;

      if (!durationDays) {
        durationDays =
          memForCatalogInput?.lastDuration ??
          existingChatContext.lastDuration ??
          null;
        hasDuration = durationDays != null;
      }

      if (!(shouldPersist && av.isAvailable && hasDuration && hasContactForBookingEarly)) {
        /** @type {string} */
        let skipReason = "UNKNOWN";
        if (!shouldPersist) skipReason = "NO_BOOKING_PERSIST_INTENT";
        else if (!av.isAvailable) skipReason = "ALREADY_BOOKED";
        else if (!hasDuration) skipReason = "MISSING_DURATION";
        else if (!hasContactForBookingEarly) skipReason = "MISSING_CONTACT";
        logBookingEvent({
          traceId,
          step: "skip_book_creation",
          status: "fail",
          data: {
            reason: skipReason,
            itemId: String(row.id),
            shouldPersist,
            hasDuration,
            hasContact: hasContactForBookingEarly,
            isAvailable: av.isAvailable,
          },
        });
      }

      if (shouldPersist && av.isAvailable && !hasDuration) {
        requiresDuration = true;
      }

      if (
        !isInformationalIntent &&
        shouldPersist &&
        av.isAvailable &&
        hasDuration &&
        hasContactForBookingEarly
      ) {
        const styleKeyEarly =
          conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
        const hydrationBlock = await blockCustomerBookingIfHydratedUnavailable({
          userId,
          catalogRow: row,
          earlyAvailabilitySnapshot: av,
          normalizedCatalogForTurn,
          styleKey: styleKeyEarly,
          conversationStyle,
          traceId,
          logKind: "booking_unavailable",
          memory: memForCatalogInput,
          hydrationSource: "early_booking_create",
        });
        if (hydrationBlock.blocked) {
          console.log("[final_reply_source]", {
            source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
          });
          return applyHybridOutboundResult(
            {
              reply: hydrationBlock.reply,
              text: hydrationBlock.reply,
              type: "AI_MESSAGE",
              messageMeta: {
                ...messageMetaForKnowledge(hasUsefulBusinessData),
                bookingBlocked: true,
                reason: "ALREADY_BOOKED",
              },
            },
            routingCtx
          );
        }
        const duplicateEarly = isDuplicateActiveBookingState(memForCatalogInput, {
          itemId: row.id,
          durationDays,
          sessionKey: emilySessionKey,
          channel: isGroupInbound ? "group" : "dm",
        });
        const explicitPricingOrDetailsQuestionEarly =
          isExplicitPricingOrDetailsQuestion(message);
        const suppressDupEarly = shouldSuppressDuplicateAlreadyReceivedReply(
          message,
          extracted.durationDays ?? null,
          contactPartsEarly.isValid,
          events
        );
        const willReturnAlreadyReceivedEarly =
          duplicateEarly && !suppressDupEarly;
        console.log("[duplicate_booking_guard_decision]", {
          messagePreview: String(message ?? "").trim().slice(0, 160) || null,
          itemId: row.id,
          durationDays,
          sessionKey: emilySessionKey,
          duplicate: duplicateEarly,
          duplicateReason: duplicateEarly
            ? "active_booking_match"
            : "no_match",
          currentIntent: "early_booking_create",
          priorityIntent: earlyPrioritizedIntent?.priorityIntent ?? null,
          explicitPricingOrDetailsQuestion: explicitPricingOrDetailsQuestionEarly,
          willReturnAlreadyReceived: willReturnAlreadyReceivedEarly,
        });
        if (willReturnAlreadyReceivedEarly) {
          return applyHybridOutboundResult(
            {
              reply: "Your booking has already been received. We’ll confirm it shortly.",
              type: "AI_MESSAGE",
              messageMeta: {
                ...messageMetaForKnowledge(hasUsefulBusinessData),
              },
            },
            routingCtx
          );
        }
        const r = await createBookingFromValidatedIntent({
          callerTag: "early_booking_create",
          isGroupInbound,
          itemId: row.id,
          itemName: row.name,
          durationDays,
          hasParticipantIdentity: Boolean(sourceParticipantKey),
          ownerApprovalFirstRequest: false,
          traceId,
          userId,
          ...bookingInboundGuard,
          createBookingArgs: {
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
            ...shortBookingCreateFields(shortBookingSelection, row),
            customerName:
              contactPartsEarly.name || String(memForCatalogInput?.customerName ?? "").trim() || undefined,
            customerPhone:
              extractedContactEarly || String(memForCatalogInput?.contact ?? "").trim() || undefined,
            source,
            groupName,
            sessionKey,
            messageId,
            participantName,
            senderScope,
            playwrightChatKey,
            dmTargetPhone: dmTargetPhone || undefined,
            dmTargetSource: dmTargetSource || undefined,
            canDmCustomer,
            ...bookingSourceMessageMetadata,
          },
        });
        if (!r?.ok && bookingErrorCode(r) === "ITEM_ALREADY_BOOKED") {
          console.log("[BOOKING BLOCKED - EARLY]", row.name);
          return buildBookingBlockedResponse({
            itemName: row.name,
            memory: memForCatalogInput,
          });
        }
        if (!r.ok) {
          console.warn("⚠️ Early booking: createBooking returned not ok", {
            itemId: row.id,
            itemName: String(row.name ?? "").slice(0, 80),
          });
        }
        if (r.ok && typeof r.id === "string" && r.id.trim() !== "") {
          bookingCreated = {
            id: r.id.trim(),
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
            status: "pending_approval",
          };
          setStructuredBookingState(memForCatalogInput, {
            ...bookingCreated,
            sessionKey: emilySessionKey,
            channel: isGroupInbound ? "group" : "dm",
          });
          const bookingResult = buildBookingFinalOutbound({
            bookingId: bookingCreated.id,
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
          });
          if (bookingResult?.meta?.bookingCreated === true) {
            memForCatalogInput.askedContact = false;
            console.log("[PIPELINE GUARD] Booking completed \u2192 skipping AI + fallback");
            return bookingResult;
          }
          if (effectiveEntityForItemFlow && entityType !== "category") {
            availabilityByItemId.delete(String(row.id ?? "").trim());
            const availabilityItemId = String(row?.id ?? "").trim();
            if (!availabilityItemId) {
              console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
                resolvedItem: row ?? null,
              });
            }
            const av2 = availabilityItemId
              ? await getUserFacingAvailabilityForItem(
                  availabilityItemId,
                  row.name,
                  "fallback"
                )
              : { isAvailable: true };
            let alternativeItems = [];
            let alternativeSummarySkipped = false;
            const MAX_CATALOG_FOR_ALT_SNAPSHOT = 400;
            if (av2.isAvailable === false) {
              if (normalizedCatalogForTurn.length > MAX_CATALOG_FOR_ALT_SNAPSHOT) {
                alternativeSummarySkipped = true;
              } else if (normalizedCatalogForTurn.length > 0) {
                const raw = await pickAlternativeAvailableItemsFromCatalogRows(
                  userId,
                  String(row.id).trim(),
                  String(row.name ?? "").trim(),
                  normalizedCatalogForTurn,
                  { limit: 5, maxRankedCandidates: 150 }
                );
                alternativeItems = raw.map((x) => ({
                  id: String(x.id ?? x.itemId ?? "").trim(),
                  name: String(x.name ?? "").trim(),
                }));
              } else {
                const raw = await getAlternativeAvailableItems(
                  userId,
                  row.id,
                  row.name,
                  5
                );
                alternativeItems = raw.map(({ id, name }) => ({ id, name }));
              }
            }
            itemContext = {
              itemId: row.id,
              name: row.name,
              availability:
                typeof row.availability === "boolean" ? row.availability : null,
              isAvailable: av2.isAvailable,
              blockingStatusesSeen: Array.isArray(av2.blockingStatusesSeen)
                ? av2.blockingStatusesSeen
                : [],
              ...(av2.nextAvailableAt != null && {
                nextAvailableAt: new Date(av2.nextAvailableAt).toISOString(),
              }),
              ...(alternativeSummarySkipped ? { alternativeSummarySkipped: true } : {}),
              ...(alternativeItems.length > 0 && { alternativeItems }),
            };
          }
        }
      }
    }
  }

  if (!itemContext && resolvedItemFromCatalog?.id) {
    const row = resolvedItemFromCatalog;
    const rowId = String(row.id ?? "").trim();
    const rowName = String(row.name ?? "").trim();
    const displayLabel = buildDisplayLabel(row);

    try {
      const availabilityItemId = String(rowId ?? "").trim();
      if (!availabilityItemId) {
        console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
          resolvedItem: row ?? null,
        });
      }
      const av = availabilityItemId
        ? await getUserFacingAvailabilityForItem(
            availabilityItemId,
            rowName,
            "fallback"
          )
        : { isAvailable: true };

      itemContext = {
        itemId: rowId,
        name: rowName,
        displayLabel,
        ...(row.color != null && String(row.color).trim() !== ""
          ? { color: String(row.color).trim() }
          : {}),
        availability:
          typeof row.availability === "boolean" ? row.availability : null,
        isAvailable: av.isAvailable,
        blockingStatusesSeen: Array.isArray(av.blockingStatusesSeen)
          ? av.blockingStatusesSeen
          : [],
        ...(av.nextAvailableAt != null && {
          nextAvailableAt: new Date(av.nextAvailableAt).toISOString(),
        }),
      };
    } catch (err) {
      console.warn(
        "⚠️ Catalog itemContext enrichment failed:",
        err?.message || err
      );
      itemContext = {
        itemId: rowId,
        name: rowName,
        displayLabel,
        availability:
          typeof row.availability === "boolean" ? row.availability : null,
      };
    }

    console.log("🧠 ItemContext backfilled from catalog:", itemContext);
  }

  await ensureItemContextItemId(userId, itemContext, resolveCatalogThisTurn);

  const entityMeta =
    effectiveEntityForItemFlow != null
      ? { name: effectiveEntityForItemFlow, type: entityType }
      : null;

  /** Maps classifier labels to detectIntent() union (+ confirmation_followup) */
  const classifierToDetectedIntent = {
    availability: "availability",
    pricing: "pricing",
    booking: "booking",
    browse_options: "browse_options",
    list: "list",
    comparison: "general",
    greeting: "general",
    general: "general",
    other: "general",
    confirmation_followup: "confirmation_followup",
  };
  const { llmIntentClassificationCached: llmIntentClassification } =
    await computeIntentPriorityIfNeeded({
      selectedItem:
        itemContext ??
        resolvedItemFromCatalog ??
        memForCatalogInput?.lastItem ??
        null,
    });
  const prioritizedIntent = prioritizedIntentCached;
  console.log("[intent_priority_applied]", {
    primaryIntent: llmIntentClassification.primaryIntent,
    priorityIntent: prioritizedIntent.priorityIntent,
    askedField: prioritizedIntent.askedField,
    reason: prioritizedIntent.reason,
  });

  const turnIntentShape = resolveTurnIntentShape({
    message,
    prioritizedIntent,
    llmIntentClassification,
    hasDuration:
      durationDays != null ||
      (fuzzyTurnNormalization?.durationCandidate?.normalizedDays != null &&
        Number.isFinite(Number(fuzzyTurnNormalization.durationCandidate.normalizedDays))),
    hasContact: hasContactForBookingEarly,
    itemMentioned: Boolean(
      extractedEntity ||
        fuzzyTurnNormalization?.catalogCandidate ||
        memForCatalogInput?.lastItem?.id ||
        itemContext?.itemId
    ),
    requestedFieldCandidate: fuzzyTurnNormalization?.requestedFieldCandidate ?? null,
  });
  console.log("[turn_intent_shape_resolved]", {
    primaryIntent: turnIntentShape.primaryIntent,
    requestedField: turnIntentShape.requestedField,
    responsePolicy: turnIntentShape.responsePolicy,
    confidence: turnIntentShape.confidence,
    priceAsk: turnIntentShape.signals.priceAsk,
    bookingCommitment: turnIntentShape.signals.bookingCommitment,
    durationMentioned: turnIntentShape.signals.durationMentioned,
  });

  if (isAnswerRequestedFieldPolicy(turnIntentShape)) {
    events = {
      ...events,
      bookingIntent: false,
      transactionalIntent: Boolean(events.orderIntent || events.confirmationIntent),
    };
    console.log("[intent_shape_pricing_field_override]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      primaryIntent: turnIntentShape.primaryIntent,
    });
  }

  let detectedIntent = detectIntent(message);
  if (prioritizedIntent.priorityIntent === "availability") {
    detectedIntent = "availability";
  } else if (
    prioritizedIntent.priorityIntent === "price" ||
    turnIntentShape.primaryIntent === "pricing_question" ||
    turnIntentShape.primaryIntent === "details_question" ||
    turnIntentShape.primaryIntent === "photo_question"
  ) {
    detectedIntent = "pricing";
  } else if (prioritizedIntent.priorityIntent === "booking") {
    detectedIntent = "booking";
  } else if (prioritizedIntent.priorityIntent === "delivery") {
    detectedIntent = "general";
  } else if (prioritizedIntent.priorityIntent === "browse_options") {
    detectedIntent = "browse_options";
  }
  const classifierIntentKey =
    inboundIntent != null && String(inboundIntent).trim() !== ""
      ? String(inboundIntent).trim().toLowerCase()
      : "";
  if (
    prioritizedIntent.priorityIntent === "unclear" &&
    classifierIntentKey &&
    Object.prototype.hasOwnProperty.call(
      classifierToDetectedIntent,
      classifierIntentKey
    )
  ) {
    detectedIntent = classifierToDetectedIntent[classifierIntentKey];
  }
  if (isBrowseOptionsIntent(message)) {
    detectedIntent = "browse_options";
  }
  if (llmIntentClassification?.primaryIntent === "browse_options") {
    detectedIntent = "browse_options";
  }
  const shortConfirm = String(message ?? "").trim().toLowerCase();
  if (shortConfirm === "yes" || shortConfirm === "ok") {
    detectedIntent = "confirmation_followup";
  }
  if (
    events.bookingIntent === true &&
    prioritizedIntent.priorityIntent !== "availability"
  ) {
    detectedIntent = "booking";
  }
  if (turnLockedItem) {
    const explicitNewItem = hasExplicitNewItemMention(
      message,
      normalizedCatalogForTurn,
      turnLockedItem.itemId
    );
    if (explicitNewItem.found) {
      console.log("[item_context_lock_released]", {
        reason: "EXPLICIT_NEW_ITEM_MENTION",
        previousLockedItemId: turnLockedItem.itemId,
        newItemId: explicitNewItem.itemId,
      });
      turnLockedItem = null;
      itemContext = null;
    }
  }
  const messageForGreetingGuard = String(message ?? "").trim();
  const priorityIntentForGuard = String(
    prioritizedIntent?.priorityIntent ?? ""
  ).trim();
  const hasRealIntentBypass =
    priorityIntentForGuard === "availability" ||
    priorityIntentForGuard === "price" ||
    priorityIntentForGuard === "booking" ||
    /\b(avail|available|availability)\b/i.test(messageForGreetingGuard) ||
    isExplicitPricingOrDetailsQuestion(message) ||
    events?.bookingIntent === true ||
    detectedIntent === "availability" ||
    detectedIntent === "pricing" ||
    detectedIntent === "booking" ||
    classifierIntentKey === "availability" ||
    classifierIntentKey === "pricing" ||
    classifierIntentKey === "booking";
  if (hasRealIntentBypass) {
    console.log("[GREETING_GUARD_BYPASSED_FOR_REAL_INTENT]", {
      message: messageForGreetingGuard.slice(0, 200),
      detectedIntent,
      priorityIntent: priorityIntentForGuard || null,
    });
  }
  const isGreetingIntent =
    !hasRealIntentBypass &&
    (detectedIntent === "greeting" ||
      classifierIntentKey === "greeting" ||
      isEnglishOnlyGreetingMessage(message) ||
      /^(hi|hello|hey|assalam|aoa)\b/i.test(messageForGreetingGuard));
  if (isGreetingIntent) {
    history = "";
    console.log("[GREETING GUARD] Conversation history hard reset");
  }
  const skipItemResolutionForGreeting = isGreetingIntent === true;
  if (skipItemResolutionForGreeting) {
    itemContext = null;
    resolvedItemFromCatalog = null;
    if (memForCatalogInput && typeof memForCatalogInput === "object") {
      memForCatalogInput.lastItem = null;
    }
    console.log("[GREETING GUARD] Skipping item resolution and clearing lastItem memory");
  }
  if (!skipItemResolutionForGreeting && fuzzyTurnNormalization) {
    const fuzzyOutbound =
      turnContext?.suppressFuzzyCatalog === true
        ? { shouldIntercept: false, reply: null, source: null }
        : resolveFuzzyCatalogOutbound(fuzzyTurnNormalization, {
            rawText: inboundMessageRawForFuzzy,
            catalogItems: normalizedCatalogForTurn,
          });
    const blockFuzzyOutboundForBooking =
      turnIntentShape.primaryIntent === "booking_request" ||
      turnIntentShape.primaryIntent === "browse_options" ||
      events.bookingIntent === true;
    if (fuzzyOutbound.shouldIntercept && fuzzyOutbound.reply && !blockFuzzyOutboundForBooking) {
      console.log("[fuzzy_catalog_outbound]", {
        traceId: traceId || null,
        source: fuzzyOutbound.source,
        catalogConfidence: fuzzyTurnNormalization.catalogConfidence,
        needsCatalogConfirmation: Boolean(
          fuzzyTurnNormalization.needsCatalogConfirmation
        ),
        requestedField: fuzzyTurnNormalization.requestedFieldCandidate,
        candidateCount: (fuzzyTurnNormalization.catalogRankedCandidates ?? []).length,
        topCandidates: (fuzzyTurnNormalization.catalogRankedCandidates ?? []).slice(0, 4),
        replyPreview: String(fuzzyOutbound.reply).slice(0, 160),
      });
      console.log("[final_reply_source]", { source: fuzzyOutbound.source });
      if (fuzzyOutbound.source === "FUZZY_CATALOG_CONFIRMATION") {
        const topCandidate = (fuzzyTurnNormalization.catalogRankedCandidates ?? [])[0];
        const pendingItemId = normalizeId(topCandidate?.itemId);
        const pendingItemLabel = String(topCandidate?.displayLabel ?? "").trim();
        if (pendingItemId && pendingItemLabel) {
          const memoryForFuzzyPending = getEmilySessionState(emilySessionKey);
          const fuzzyPendingAction = buildPendingAction({
            type: PENDING_ACTION_TYPES.CONFIRM_FUZZY_CATALOG,
            expectedReplyType: "affirmation",
            participantKey: sourceParticipantKey || "",
            groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
            sessionKey: emilySessionKey,
            itemId: pendingItemId,
            itemDisplayLabel: pendingItemLabel,
            payload: {
              itemId: pendingItemId,
              itemDisplayLabel: pendingItemLabel,
              inferredIntent: mapFuzzyPendingInferredIntent(fuzzyTurnNormalization),
              requestedField: String(
                fuzzyTurnNormalization.requestedFieldCandidate ?? "unknown"
              ).trim(),
            },
            sourceMessageId: messageId,
            sourcePromptText: String(fuzzyOutbound.reply ?? ""),
          });
          storePendingAction(memoryForFuzzyPending, fuzzyPendingAction);
          console.log("[fuzzy_catalog_pending_action_stored]", {
            traceId: traceId || null,
            itemId: pendingItemId,
            itemDisplayLabel: pendingItemLabel,
            inferredIntent: fuzzyPendingAction.payload.inferredIntent,
            requestedField: fuzzyPendingAction.payload.requestedField,
            expiresAt: fuzzyPendingAction.expiresAt,
          });
        }
      }
      return applyHybridOutboundResult(
        {
          reply: fuzzyOutbound.reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }
  }
  const durationValue = extractDurationFromMessage(message);
  const existingFocusKey = normalizeText(
    String(existingChatContext.lastFocusedItem ?? "")
  );
  const incomingFocusKey = normalizeText(String(effectiveEntityForItemFlow ?? ""));
  const shouldResetTopicContext =
    pendingTopicReset &&
    Boolean(incomingFocusKey) &&
    Boolean(existingFocusKey) &&
    incomingFocusKey !== existingFocusKey;
  if (shouldResetTopicContext) {
    if (globalThis.__chatContext[chatContextKey]) {
      delete globalThis.__chatContext[chatContextKey];
    }
    delete globalThis.__topicEntityBySession[chatContextKey];
    const pwKey = String(playwrightChatKey ?? "").trim();
    if (pwKey && globalThis.__lastProcessedUserMsg) {
      delete globalThis.__lastProcessedUserMsg[pwKey];
    }
  }
  const nextChatContext = {
    lastFocusedItem:
      effectiveEntityForItemFlow != null && entityType !== "category"
        ? String(effectiveEntityForItemFlow).trim()
        : shouldResetTopicContext
          ? null
          : existingChatContext.lastFocusedItem ?? null,
    lastIntent: detectedIntent,
    lastDuration:
      detectedIntent === "duration" && durationValue != null
        ? durationValue
        : shouldResetTopicContext
          ? null
          : existingChatContext.lastDuration ?? null,
  };
  globalThis.__chatContext[chatContextKey] = nextChatContext;
  console.log("[participant_context_saved]", {
    chatContextKey,
    participantKey: sourceParticipantKey || null,
  });

  const earlyCatalogMatch = skipItemResolutionForGreeting
    ? null
    : matchCatalogAgainstMessage({
        message,
        items: normalizedCatalogForTurn,
        services:
          businessProfile?.rawBusinessProfile &&
          typeof businessProfile.rawBusinessProfile === "object" &&
          Array.isArray(businessProfile.rawBusinessProfile.services)
            ? businessProfile.rawBusinessProfile.services
            : [],
      });
  const memoryPreEmily = getEmilySessionState(emilySessionKey);
  const matchedItemForReplyEarly = skipItemResolutionForGreeting
    ? null
    : matchedItemForReplyFromCatalogState({
        catalogMatch: earlyCatalogMatch,
        pinnedEntityName,
        entityResult,
        message,
        detectedIntent,
        shouldResetTopicContext,
        nextChatContext,
        catalogRowsForStaleFocusGuard: normalizedCatalogForTurn,
      }).matchedItemForReply;
  if (!skipItemResolutionForGreeting) {
    itemContext = await ensureItemContextFromMatchedItemReply(
      userId,
      itemContext,
      matchedItemForReplyEarly,
      resolveCatalogThisTurn
    );
    await ensureItemContextItemId(userId, itemContext, resolveCatalogThisTurn);
    if (earlyCatalogMatch?.matchedItem) {
      runLateContextSanitizer({
        source: "catalog_match",
        explicitCurrentMessageItem: true,
        conversationMemory: memoryPreEmily,
      });
    }
    syncLastItemFromItemContextIfMissing(memoryPreEmily, itemContext);
    if (turnLockedItem) {
      await applyTurnLockedItemContext("duration");
    }
  }

  const emilyTurn = applyEmilyTurn({
    sessionKey: emilySessionKey,
    message,
    rawBusinessProfile: businessProfile?.rawBusinessProfile ?? null,
    catalogItems: normalizedCatalogForTurn,
    entityMeta,
    itemContext,
  });
  const conversationMemory = getEmilySessionState(emilySessionKey);

  // Group privacy: after owner approval, logistics collection should happen in private chat.
  if (isGroupInbound) {
    const stageKey = String(conversationMemory?.approvalStage ?? conversationMemory?.stage ?? "")
      .trim()
      .toLowerCase();
    const waitingStages = new Set([
      "owner_approved_waiting_customer_details",
      "waiting_customer_details",
    ]);
    if (waitingStages.has(stageKey)) {
      console.warn("[group_privacy_action_blocked]", {
        reason: "LOGISTICS_IN_GROUP_BLOCKED",
        approvalStage: stageKey || null,
        messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      });
      console.log("[group_privacy_safe_handoff_sent]", {
        approvalStage: stageKey || null,
      });
      return applyHybridOutboundResult(
        {
          reply: "Main details private chat mein le leta hun.",
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(true),
        },
        routingCtx
      );
    }
  }
  const wantsImages = detectShowImagesRequest(message);
  if (
    emilyTurn.userLanguageStyle === "ur-roman" ||
    emilyTurn.userLanguageStyle === "ur-script" ||
    emilyTurn.userLanguageStyle === "mixed"
  ) {
    conversationStyle = "casual_local";
  }
  let intent = intentForContextLayer(emilyTurn.emilyIntent);
  if (forcedIntent) {
    intent = forcedIntent;
  }
  let resolvedEmilyIntent = emilyTurn.emilyIntent;
  if (
    conversationMemory?.lastItemMentioned &&
    conversationMemory?.durationPreference &&
    intent === "inquiry"
  ) {
    resolvedEmilyIntent = "booking";
    intent = "order";
  }
  if (events.bookingIntent === true) {
    resolvedEmilyIntent = "booking";
  }
  if (!durationContextAllowed) {
    conversationMemory.lastDuration = null;
    conversationMemory.durationPreference = null;
    conversationMemory.hasBookingIntent = false;
  }
  if (detectedIntent === "browse_options") {
    intent = "browse_options";
    resolvedEmilyIntent = "inquiry";
  }

  if (detectedIntent === "browse_options") {
    conversationMemory.browseAllUnavailableFresh = false;
    clearAvailabilityFreshNoOtherOptionsStructured(conversationMemory);
    console.log("[browse_options_intent_detected]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      classifierPrimary: llmIntentClassification?.primaryIntent ?? null,
      priorityIntent: prioritizedIntent?.priorityIntent ?? null,
    });
    const memoryLastItemBefore =
      conversationMemory?.lastItem && typeof conversationMemory.lastItem === "object"
        ? {
            id: normalizeId(conversationMemory.lastItem.id),
            name: String(conversationMemory.lastItem.name ?? "").trim() || null,
          }
        : null;
    const previousItemId = normalizeId(conversationMemory?.lastItem?.id);
    const previousItemName = String(conversationMemory?.lastItem?.name ?? "").trim();
    if (previousItemId) {
      const previousAvailability = await getUserFacingAvailabilityForItem(
        previousItemId,
        previousItemName,
        "memory"
      );
      if (previousAvailability?.isAvailable === false) {
        conversationMemory.lastItem = null;
        conversationMemory.lastResolvedItemId = null;
        conversationMemory.askedContact = false;
      }
    }

    const wantsOther =
      /\b(?:other|aur|or)\b/i.test(String(message ?? ""));
    const wantsServices =
      /\b(service|services)\b/i.test(String(message ?? "")) ||
      /\b(khidmat|khidmaat|service)\b/i.test(String(message ?? ""));
    const services =
      businessProfile?.rawBusinessProfile &&
      typeof businessProfile.rawBusinessProfile === "object" &&
      Array.isArray(businessProfile.rawBusinessProfile.services)
        ? businessProfile.rawBusinessProfile.services
        : [];

    let catalogSliceForBrowse = normalizedCatalogForTurn;
    if (wantsOther && previousItemId) {
      catalogSliceForBrowse = normalizedCatalogForTurn.filter(
        (row) => normalizeId(row.id) !== previousItemId
      );
    }

    const browseSummary = await summarizeBrowseAvailabilityFromCatalogRows(
      userId,
      catalogSliceForBrowse,
      { maxScan: 300, maxList: 5 }
    );

    let reply = "";
    if (
      browseSummary.availableCount === 0 &&
      wantsServices &&
      Array.isArray(services) &&
      services.length > 0
    ) {
      reply = buildBrowseOfferingsReply({
        items: [],
        services,
        style: conversationStyle,
      });
    } else {
      const topItems = browseSummary.topAvailableRows.map((r) =>
        catalogRowToTopAvailabilityItem(
          /** @type {Record<string, unknown>} */ (r),
          buildDisplayLabel
        )
      );
      const styleKey =
        conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
      const availabilityCtx = buildAvailabilityContextSkeleton({
        intent: "browse_available_options",
        inventorySummary: {
          status: browseSummary.summaryStatus,
          totalItems: catalogSliceForBrowse.length,
          availableCount: browseSummary.availableCount,
          unavailableCount: null,
          topAvailableItems: topItems,
          maxItemsShown: 5,
        },
        policy: {},
        servicesOnlyBrowse: false,
      });
      reply = await resolveAvailabilityCustomerReply({
        availabilityCtx,
        userMessage: message,
        styleKey,
        __availabilityAiCompletionForTests,
      });
      console.log("[availability_context_built]", {
        intent: availabilityCtx.intent,
        summaryStatus: availabilityCtx.inventorySummary.status,
        availableCount: availabilityCtx.inventorySummary.availableCount,
        topItemCount: availabilityCtx.inventorySummary.topAvailableItems.length,
      });
    }

    conversationMemory.stage = "BROWSING";
    conversationMemory.hasBookingIntent = false;
    conversationMemory.askedContact = false;
    conversationMemory.lastDuration = null;
    conversationMemory.durationPreference = null;
    itemContext = null;
    resolvedItemFromCatalog = null;

    const memoryLastItemAfter =
      conversationMemory?.lastItem && typeof conversationMemory.lastItem === "object"
        ? {
            id: normalizeId(conversationMemory.lastItem.id),
            name: String(conversationMemory.lastItem.name ?? "").trim() || null,
          }
        : null;
    console.log("[intent_routing]", {
      detectedIntent,
      route: "browse_options",
      itemId: null,
      memoryLastItemBefore,
      memoryLastItemAfter,
    });
    console.log("[browse_options_reply_built]", {
      optionCount: browseSummary.availableCount,
      serviceCount: Array.isArray(services) ? services.length : 0,
      replyPreview: String(reply ?? "").slice(0, 180) || null,
    });
    if (browseSummary.summaryStatus === "fresh" && browseSummary.availableCount === 0) {
      clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptions({
        chatContextKey,
        nextChatContext,
        source: "browse_options",
        availableCount: 0,
        summaryStatus: "fresh",
        reason: "BROWSE_GLOBAL_ZERO_FRESH",
      });
      conversationMemory.browseAllUnavailableFresh = true;
    }
    console.log("[final_reply_source]", { source: "PHRASE_ENGINE" });
    return applyHybridOutboundResult(
      {
        reply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx
    );
  }

  const tryPersistLastItemFromResolved = (
    /** @type {string} */ label,
    /** @type {unknown} */ idRaw,
    /** @type {unknown} */ nameRaw,
    /** @type {Record<string, unknown> | null | undefined} */ rowLike
  ) => {
    const id = String(idRaw ?? "").trim();
    if (!id) return;
    const lockedId = normalizeId(turnLockedItem?.itemId);
    if (lockedId) {
      const allowed = id === lockedId;
      console.log("[memory_sync_guard]", {
        lockedItemId: lockedId,
        attemptedMemoryItemId: id,
        allowed,
      });
      if (!allowed) {
        console.log("[item_context_overwrite_blocked]", {
          attemptedItemId: id,
          lockedItemId: lockedId,
          source: label,
        });
        return;
      }
    }
    const cur = conversationMemory.lastItem;
    if (
      cur != null &&
      typeof cur === "object" &&
      String(cur.id ?? "").trim() !== ""
    ) {
      return;
    }
    const nameStr = String(nameRaw ?? "").trim();
    conversationMemory.lastItem = {
      id,
      name: nameStr,
      displayLabel: buildDisplayLabel(
        rowLike && typeof rowLike === "object" ? rowLike : { name: nameStr }
      ),
      ...(rowLike && typeof rowLike === "object" && rowLike.color != null
        ? { color: String(rowLike.color).trim() }
        : {}),
    };
    conversationMemory.askedContact = false;
    console.log("🧠 Stored item in memory:", {
      source: label,
      ...conversationMemory.lastItem,
    });
  };

  if (itemContext?.itemId != null && String(itemContext.itemId).trim() !== "") {
    tryPersistLastItemFromResolved(
      "itemContext",
      itemContext.itemId,
      itemContext.name,
      itemContext
    );
  }
  if (resolvedItemFromCatalog?.id) {
    tryPersistLastItemFromResolved(
      "resolvedItemFromCatalog",
      resolvedItemFromCatalog.id,
      resolvedItemFromCatalog.name,
      resolvedItemFromCatalog
    );
  }

  {
    const catalogLabel = labelFromMatchedItem(emilyTurn.match.matchedItem);
    if (String(catalogLabel ?? "").trim() !== "") {
      nextChatContext.lastFocusedItem = String(catalogLabel).trim();
      globalThis.__chatContext[chatContextKey] = nextChatContext;
      console.log("[participant_context_saved]", {
        chatContextKey,
        participantKey: sourceParticipantKey || null,
      });
    }
  }
  const matchedForReplyState = skipItemResolutionForGreeting
    ? { matchedItemForReply: null, fallbackScopedLabel: "" }
    : matchedItemForReplyFromCatalogState({
        catalogMatch: emilyTurn.match,
        pinnedEntityName,
        entityResult,
        message,
        detectedIntent,
        shouldResetTopicContext,
        nextChatContext,
        catalogRowsForStaleFocusGuard: normalizedCatalogForTurn,
      });
  let { matchedItemForReply, fallbackScopedLabel } = matchedForReplyState;
  if (turnLockedItem) {
    const attemptedId =
      matchedItemForReply && typeof matchedItemForReply === "object"
        ? normalizeId(matchedItemForReply.id)
        : null;
    if (attemptedId && attemptedId !== turnLockedItem.itemId) {
      console.log("[item_context_overwrite_blocked]", {
        attemptedItemId: attemptedId,
        lockedItemId: turnLockedItem.itemId,
        source: "matched_item_for_reply",
      });
    }
    matchedItemForReply = lockedItemAsContext();
    fallbackScopedLabel = "";
  }

  if (!skipItemResolutionForGreeting) {
    itemContext = await ensureItemContextFromMatchedItemReply(
      userId,
      itemContext,
      matchedItemForReply,
      resolveCatalogThisTurn
    );
    if (emilyTurn.match?.matchedItem) {
      runLateContextSanitizer({
        source: "matched_item_reply",
        explicitCurrentMessageItem: true,
        conversationMemory,
      });
    }
    syncLastItemFromItemContextIfMissing(conversationMemory, itemContext);
    if (turnLockedItem) {
      await applyTurnLockedItemContext("duration");
    }
  } else {
    itemContext = null;
  }

  if (
    !skipItemResolutionForGreeting &&
    matchedItemForReply &&
    typeof matchedItemForReply === "object" &&
    !String(conversationMemory?.lastItem?.id ?? "").trim() &&
    !String(matchedItemForReply.id ?? "").trim()
  ) {
    const input =
      (typeof matchedItemForReply.displayLabel === "string" &&
        matchedItemForReply.displayLabel.trim() !== "" &&
        matchedItemForReply.displayLabel.trim()) ||
      (typeof matchedItemForReply.name === "string" &&
        matchedItemForReply.name.trim() !== "" &&
        matchedItemForReply.name.trim()) ||
      "";
    if (input.length >= 2) {
      const resolved = await resolveCatalogThisTurn(input, conversationMemory);
      console.log("🔎 MatchedItem → Resolver:", {
        input,
        resolvedId: resolved?.id ?? null,
      });
      if (resolved?.id) {
        const rowId = String(resolved.id).trim();
        const rowName = String(resolved.name ?? "").trim() || input;
        const displayFromMatch =
          typeof matchedItemForReply.displayLabel === "string" &&
          matchedItemForReply.displayLabel.trim() !== ""
            ? matchedItemForReply.displayLabel.trim()
            : buildDisplayLabel(resolved);

        if (!itemContext) {
          const displayLabel = buildDisplayLabel(resolved);
          try {
            const availabilityItemId = String(rowId ?? "").trim();
            if (!availabilityItemId) {
              console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
                resolvedItem: resolved ?? null,
              });
            }
            const av = availabilityItemId
              ? await getUserFacingAvailabilityForItem(
                  availabilityItemId,
                  rowName,
                  "fallback"
                )
              : { isAvailable: true };
            itemContext = {
              itemId: rowId,
              name: rowName,
              displayLabel,
              availability:
                typeof resolved.availability === "boolean"
                  ? resolved.availability
                  : null,
              isAvailable: av.isAvailable,
              blockingStatusesSeen: Array.isArray(av.blockingStatusesSeen)
                ? av.blockingStatusesSeen
                : [],
              ...(av.nextAvailableAt != null && {
                nextAvailableAt: new Date(av.nextAvailableAt).toISOString(),
              }),
            };
          } catch (err) {
            console.warn(
              "⚠️ MatchedItem itemContext enrichment failed:",
              err?.message || err
            );
            itemContext = {
              itemId: rowId,
              name: rowName,
              displayLabel,
              availability:
                typeof resolved.availability === "boolean"
                  ? resolved.availability
                  : null,
            };
          }
        }

        const lockedId = normalizeId(turnLockedItem?.itemId);
        const allowMemorySync = !lockedId || rowId === lockedId;
        console.log("[memory_sync_guard]", {
          lockedItemId: lockedId,
          attemptedMemoryItemId: rowId,
          allowed: allowMemorySync,
        });
        if (allowMemorySync) {
          conversationMemory.lastItem = {
            id: rowId,
            name: rowName,
            displayLabel: displayFromMatch,
          };
          conversationMemory.askedContact = false;
          console.log(
            "🧠 Stored item from matchedItem:",
            conversationMemory.lastItem
          );
        } else {
          console.log("[item_context_overwrite_blocked]", {
            attemptedItemId: rowId,
            lockedItemId: lockedId,
            source: "matched_item_memory_store",
          });
        }
      }
    }
  }

  await ensureItemContextItemId(userId, itemContext, resolveCatalogThisTurn);
  if (!skipItemResolutionForGreeting) {
    itemContext = await hydrateItemWithAvailability(
      itemContext,
      detectedIntent === "availability" ||
        classifierIntentKey === "availability" ||
        intent === "availability"
        ? "initial"
        : hasDuration
          ? "duration"
          : normalizeId(conversationMemory?.lastItem?.id)
            ? "memory"
            : "fallback"
      );
  }
  if (turnLockedItem) {
    await applyTurnLockedItemContext("duration");
  }
  if (shortBookingSelection?.type === "below_minimum") {
    const belowMinCatalogItem = await hydrateCatalogItemForPendingAction(
      itemContext || durationMemoryCandidate || memForCatalogInput?.lastItem || null
    );
    const belowMinHydratedItem = belowMinCatalogItem
      ? await hydrateItemWithAvailability(belowMinCatalogItem, "duration")
      : null;
    const belowMinAvailabilityKnown =
      typeof belowMinHydratedItem?.isAvailable === "boolean" ||
      typeof itemContext?.isAvailable === "boolean";
    const belowMinIsAvailable =
      belowMinHydratedItem?.isAvailable === false || itemContext?.isAvailable === false
        ? false
        : belowMinAvailabilityKnown;
    const belowMinAlternatives =
      itemContext?.alternativeItems ?? belowMinHydratedItem?.alternativeItems ?? [];
    const belowMinTurnShape = resolveTurnIntentShape({
      message,
      itemMentioned: Boolean(
        extractedEntity ||
          itemContext ||
          durationMemoryCandidate ||
          memForCatalogInput?.lastItem
      ),
      hasDuration: true,
    });
    const belowMinItemLabel =
      buildDisplayLabel(belowMinHydratedItem) ||
      String(belowMinHydratedItem?.displayLabel ?? "").trim() ||
      String(belowMinHydratedItem?.name ?? "").trim() ||
      buildDisplayLabel(itemContext) ||
      String(itemContext?.displayLabel ?? itemContext?.name ?? "").trim();
    const belowMinPlanned = planBelowMinimumHoursTurn({
      message,
      selection: shortBookingSelection,
      item: belowMinHydratedItem || belowMinCatalogItem,
      turnIntentShape: belowMinTurnShape,
      isGroupInbound,
      isAvailable: belowMinIsAvailable,
      itemLabel: belowMinItemLabel,
      alternativeItems: belowMinAlternatives,
    });
    let belowMinPendingStored = false;
    const belowMinPendingItemId = normalizeId(
      belowMinHydratedItem?.itemId ??
        belowMinHydratedItem?.id ??
        belowMinCatalogItem?.itemId ??
        belowMinCatalogItem?.id ??
        itemContext?.itemId ??
        itemContext?.id
    );
    if (belowMinPlanned.shouldStorePending && belowMinPendingItemId) {
      const belowMinPendingAction = buildPendingAction({
        type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
        expectedReplyType: "affirmation",
        participantKey: sourceParticipantKey || "",
        groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
        sessionKey: emilySessionKey,
        itemId: belowMinPendingItemId,
        itemDisplayLabel: belowMinItemLabel,
        payload: {
          itemId: belowMinPendingItemId,
          itemDisplayLabel: belowMinItemLabel,
          originalRequestedHours: shortBookingSelection.requestedHours,
          minimumHours: shortBookingSelection.minimumHours,
          billingUnit: shortBookingSelection.billingUnit,
          billingRatePercentOfDaily: shortBookingSelection.billingRatePercentOfDaily,
          calculatedPrice: belowMinPlanned.calculatedPrice,
          currency: currencyFromItem(belowMinHydratedItem || belowMinCatalogItem),
          explicitPriceIntent: belowMinPlanned.explicitPriceIntent,
        },
        sourceMessageId: messageId,
        sourcePromptText: belowMinPlanned.reply,
      });
      storePendingAction(memForCatalogInput, belowMinPendingAction);
      belowMinPendingStored = true;
    } else if (belowMinPlanned.offerCheckKarun) {
      console.log("[pending_action_not_stored]", {
        type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
        reason: belowMinPendingItemId ? "BELOW_MINIMUM_UNAVAILABLE_OR_UNBOUND" : "MISSING_ITEM_ID",
      });
    }
    console.log("[below_minimum_duration_handled]", {
      kind: belowMinPlanned.kind,
      requestedHours: shortBookingSelection.requestedHours,
      minimumHours: shortBookingSelection.minimumHours,
      calculatedPrice: belowMinPlanned.calculatedPrice,
      isAvailable: belowMinIsAvailable,
      availabilityKnown: belowMinAvailabilityKnown,
      storedPending: belowMinPendingStored,
      itemId: belowMinPendingItemId || null,
    });
    return applyHybridOutboundResult(
      {
        reply: belowMinPlanned.reply,
        type: "AI_MESSAGE",
        messageMeta: {
          ...messageMetaWithOutboundTrace(
            hasUsefulBusinessData,
            buildOutboundTrace({
              kind:
                belowMinPlanned.kind === "informational"
                  ? ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO
                  : belowMinPendingStored
                    ? ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT
                    : ASSISTANT_OUTBOUND_KIND.TERMINAL_INFO,
              finalReplySource: belowMinPendingStored
                ? "BELOW_MINIMUM_BOOKING_OFFER"
                : "BELOW_MINIMUM_INFORMATIONAL",
              pendingActionTypeStored: belowMinPendingStored
                ? PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER
                : null,
            })
          ),
          bookingBlocked: true,
          reason: "SHORT_BOOKING_BELOW_MINIMUM",
          durationHoursRequested: shortBookingSelection.requestedHours,
          durationHoursMinimum: shortBookingSelection.minimumHours,
        },
      },
      routingCtx
    );
  }
  console.log("🧪 ITEM CONTEXT FULL:", itemContext);
  const currentTurnMatchedItemId =
    emilyTurn.match?.matchedItem && typeof emilyTurn.match.matchedItem === "object"
      ? normalizeId(emilyTurn.match.matchedItem.id ?? emilyTurn.match.matchedItem.itemId)
      : "";
  const currentTurnItemContextId = normalizeId(itemContext?.itemId ?? itemContext?.id);
  const currentTurnVerifiedCatalogItemForSelection =
    currentTurnItemContextId &&
    currentTurnMatchedItemId &&
    currentTurnItemContextId === currentTurnMatchedItemId &&
    itemContext &&
    typeof itemContext === "object"
      ? { ...itemContext, itemId: currentTurnItemContextId, id: currentTurnItemContextId }
      : null;

  if (
    fuzzyTurnNormalization?.catalogCandidate &&
    fuzzyTurnNormalization.catalogConfidence === "high" &&
    !fuzzyTurnNormalization.ambiguity &&
    !skipItemResolutionForGreeting
  ) {
    const fuzzyRow = fuzzyTurnNormalization.catalogCandidate;
    const fuzzyId = normalizeId(fuzzyRow.id ?? fuzzyRow.itemId);
    if (fuzzyId) {
      const fuzzyName = String(fuzzyRow.name ?? "").trim();
      const fuzzyLabel =
        String(fuzzyRow.displayLabel ?? "").trim() || buildDisplayLabel(fuzzyRow) || fuzzyName;
      if (!resolvedItemFromCatalog) {
        resolvedItemFromCatalog = { ...fuzzyRow, id: fuzzyId, itemId: fuzzyId };
      }
      if (!itemContext) {
        itemContext = {
          ...fuzzyRow,
          itemId: fuzzyId,
          id: fuzzyId,
          name: fuzzyName,
          displayLabel: fuzzyLabel,
        };
      }
      if (!matchedItemForReply) {
        matchedItemForReply = {
          name: fuzzyName,
          displayLabel: fuzzyLabel,
          id: fuzzyId,
          itemId: fuzzyId,
        };
      }
      console.log("[fuzzy_catalog_seeded_for_authority]", {
        itemId: fuzzyId,
        itemLabel: fuzzyLabel || null,
      });
    }
  }

  const explicitResolvedItemForAuthority = extractedEntity
    ? itemContext ?? resolvedItemFromCatalog ?? matchedItemForReply ?? null
    : fuzzyTurnNormalization?.catalogCandidate &&
        fuzzyTurnNormalization.catalogConfidence === "high" &&
        !fuzzyTurnNormalization.ambiguity
      ? itemContext ?? resolvedItemFromCatalog ?? matchedItemForReply ?? null
      : null;
  const isItemFollowupForAuthority =
    isDetailFollowupWithoutExplicitEntity(message) ||
    (!extractedEntity && detectedIntent === "availability") ||
    (wantsImages && !extractedEntity);
  let authoritativeItemForTurn = resolveAuthoritativeItemForTurn({
    userText: message,
    explicitResolvedItem: explicitResolvedItemForAuthority,
    turnLockedItem: lockedItemAsContext(),
    memoryItem: conversationMemory?.lastItem ?? memForCatalogInput?.lastItem ?? null,
    isFollowup: isItemFollowupForAuthority,
    catalogItems: normalizedCatalogForTurn,
    itemlessPriceDurationFollowup:
      turnContext?.itemlessPriceDurationFollowup === true ||
      durationContextPolicy.itemlessPriceDurationFollowup === true,
  });
  const fuzzyHighCatalogOverride =
    turnContext?.suppressFuzzyCatalog !== true &&
    !durationContextPolicy.itemlessPriceDurationFollowup &&
    fuzzyTurnNormalization?.catalogConfidence === "high" &&
    fuzzyTurnNormalization.catalogCandidate &&
    !fuzzyTurnNormalization.ambiguity &&
    fuzzyTurnNormalization.corrections.some((c) => c.type === "catalog_item");
  if (fuzzyHighCatalogOverride) {
    const fuzzyRow = fuzzyTurnNormalization.catalogCandidate;
    const fuzzyId = normalizeId(fuzzyRow.id ?? fuzzyRow.itemId);
    const memoryId = normalizeId(
      conversationMemory?.lastItem?.id ?? conversationMemory?.lastItem?.itemId
    );
    const authorityId = normalizeId(
      authoritativeItemForTurn?.id ?? authoritativeItemForTurn?.itemId
    );
    if (fuzzyId && memoryId && authorityId && fuzzyId !== authorityId) {
      console.log("[fuzzy_catalog_overrides_memory]", {
        fuzzyItemId: fuzzyId,
        memoryItemId: memoryId,
        authorityItemId: authorityId,
        reason: "HIGH_CONFIDENCE_TYPO_CATALOG_MATCH",
      });
    }
    if (fuzzyId && (!authorityId || authorityId !== fuzzyId)) {
      authoritativeItemForTurn = {
        ...fuzzyRow,
        id: fuzzyId,
        itemId: fuzzyId,
        name: String(fuzzyRow.name ?? "").trim(),
        displayLabel:
          String(fuzzyRow.displayLabel ?? "").trim() || buildDisplayLabel(fuzzyRow),
      };
    }
  }
  if (authoritativeItemForTurn) {
    const authorityId = normalizeId(
      authoritativeItemForTurn.id ?? authoritativeItemForTurn.itemId
    );
    const attemptedId = normalizeId(
      matchedItemForReply && typeof matchedItemForReply === "object"
        ? matchedItemForReply.id ?? matchedItemForReply.itemId
        : null
    );
    if (attemptedId && authorityId && attemptedId !== authorityId) {
      console.log("[item_authority_overwrite_blocked]", {
        attemptedItemId: attemptedId,
        authoritativeItemId: authorityId,
        source: "matchedItemForReply",
      });
    }
    matchedItemForReply = authoritativeItemForTurn;
    const authorityContext = {
      ...authoritativeItemForTurn,
      itemId: authorityId,
      id: authorityId,
      name:
        String(authoritativeItemForTurn.name ?? "").trim() ||
        String(authoritativeItemForTurn.displayLabel ?? "").trim(),
      displayLabel:
        buildDisplayLabel(authoritativeItemForTurn) ||
        String(authoritativeItemForTurn.displayLabel ?? authoritativeItemForTurn.name ?? "").trim(),
    };
    itemContext = await hydrateItemWithAvailability(
      authorityContext,
      extractedEntity
        ? "initial"
        : turnLockedItem
          ? "duration"
          : "memory"
    );
  } else {
    if (matchedItemForReply || itemContext) {
      console.log("[item_authority_overwrite_blocked]", {
        attemptedItemId:
          normalizeId(
            itemContext?.itemId ??
              itemContext?.id ??
              (matchedItemForReply && typeof matchedItemForReply === "object"
                ? matchedItemForReply.id ?? matchedItemForReply.itemId
                : null)
          ) || null,
        authoritativeItemId: null,
        source: "no_authoritative_item",
      });
    }
    matchedItemForReply = null;
    itemContext = null;
  }

  const resolvedName =
    matchedItemForReply && typeof matchedItemForReply.name === "string"
      ? matchedItemForReply.name.trim()
      : "";
  const resolvedDisplayLabel =
    matchedItemForReply && typeof matchedItemForReply.displayLabel === "string"
      ? matchedItemForReply.displayLabel.trim()
      : resolvedName;
  const resolvedItemId =
    itemContext?.itemId != null && String(itemContext.itemId).trim() !== ""
      ? String(itemContext.itemId).trim()
      : matchedItemForReply != null &&
          typeof matchedItemForReply === "object" &&
          typeof matchedItemForReply.id === "string" &&
          matchedItemForReply.id.trim() !== ""
        ? matchedItemForReply.id.trim()
        : "";

  if (
    matchedItemForReply &&
    typeof matchedItemForReply === "object" &&
    String(matchedItemForReply.id ?? "").trim() !== ""
  ) {
    tryPersistLastItemFromResolved(
      "matchedItemForReply",
      matchedItemForReply.id,
      matchedItemForReply.name ?? matchedItemForReply.displayLabel,
      matchedItemForReply
    );
  }

  const currentMemory =
    conversationMemory?.lastItemMentioned != null
      ? String(conversationMemory.lastItemMentioned).trim()
      : "";

  // Rule 1: Only proceed if we have a valid resolved item
  const hasResolvedItem = resolvedName.length > 0;

  // Rule 2: Memory is empty
  const memoryEmpty = currentMemory.length === 0;

  // Rule 3: User switched catalog item — new stable ID must replace the old one.
  const prevId = String(conversationMemory?.lastItem?.id ?? "").trim();
  const idChanged =
    Boolean(resolvedItemId) && resolvedItemId !== prevId;

  /** Emily can set `lastItemMentioned` before `lastItem` exists — still need to persist id/name. */
  const lacksStableLastItemId = !normalizeId(conversationMemory?.lastItem?.id);

  if (hasResolvedItem && !resolvedItemId) {
    console.log("⚠️ Resolved item without ID — preserving previous item:", {
      previousId: prevId,
      incomingName: resolvedName,
    });
  }

  // FINAL DECISION:
  if (
    hasResolvedItem &&
    (memoryEmpty || idChanged || lacksStableLastItemId)
  ) {
    const newId = resolvedItemId || null;
    const newName = resolvedName;
    const newLabel = resolvedDisplayLabel || newName;

    // CRITICAL: never overwrite a previously stored ID with null.
    if (newId) {
      const lockedId = normalizeId(turnLockedItem?.itemId);
      const allowed = !lockedId || newId === lockedId;
      console.log("[memory_sync_guard]", {
        lockedItemId: lockedId,
        attemptedMemoryItemId: newId,
        allowed,
      });
      if (allowed) {
        if (idChanged) {
          clearStructuredBookingState(conversationMemory, "EXPLICIT_NEW_ITEM");
        }
        conversationMemory.lastItem = {
          id: newId,
          name: newName,
          displayLabel: newLabel,
        };
        conversationMemory.askedContact = false;
        console.log("🧠 Stored item:", {
          id: conversationMemory.lastItem?.id,
          name: conversationMemory.lastItem?.name,
        });
      } else {
        console.log("[item_context_overwrite_blocked]", {
          attemptedItemId: newId,
          lockedItemId: lockedId,
          source: "final_resolved_memory_sync",
        });
      }
    } else {
      const prevItem =
        conversationMemory.lastItem != null &&
        typeof conversationMemory.lastItem === "object"
          ? conversationMemory.lastItem
          : {};
      conversationMemory.lastItem = {
        ...prevItem,
        name: newName || prevItem.name,
        displayLabel: newLabel || prevItem.displayLabel,
      };
      console.log("⚠️ Skipping memory update — no ID in resolved item");
    }
    conversationMemory.lastItemMentioned = resolvedName;

    console.log("🧠 Memory Sync Applied (final resolved):", {
      stored: resolvedName,
      storedId: resolvedItemId || null,
      previous: currentMemory || null,
      reason: memoryEmpty
        ? "empty"
        : idChanged
          ? "id_changed"
          : "backfill_no_stable_last_item_id",
    });
  }

  {
    const ctxItemId =
      itemContext?.itemId != null && String(itemContext.itemId).trim() !== ""
        ? String(itemContext.itemId).trim()
        : "";
    const ctxItemName =
      itemContext?.name != null && String(itemContext.name).trim() !== ""
        ? String(itemContext.name).trim()
        : "";
    if (ctxItemId) {
      const prevLast = conversationMemory.lastItem;
      const prevLastId =
        prevLast != null &&
        typeof prevLast === "object" &&
        String(prevLast.id ?? "").trim() !== ""
          ? String(prevLast.id).trim()
          : "";
      if (!prevLastId) {
        const lockedId = normalizeId(turnLockedItem?.itemId);
        const allowed = !lockedId || ctxItemId === lockedId;
        console.log("[memory_sync_guard]", {
          lockedItemId: lockedId,
          attemptedMemoryItemId: ctxItemId,
          allowed,
        });
        if (!allowed) {
          console.log("[item_context_overwrite_blocked]", {
            attemptedItemId: ctxItemId,
            lockedItemId: lockedId,
            source: "item_context_backfill",
          });
        } else {
          const base =
            prevLast != null && typeof prevLast === "object" ? { ...prevLast } : {};
          conversationMemory.lastItem = {
            ...base,
            id: ctxItemId,
            name: ctxItemName || base.name || "",
            displayLabel: buildDisplayLabel({
              name: ctxItemName || base.name,
              color: base.color,
              displayLabel: base.displayLabel,
            }),
          };
          conversationMemory.askedContact = false;
          console.log("🧠 Stored item:", {
            id: conversationMemory.lastItem?.id,
            name: conversationMemory.lastItem?.name,
            source: "item_context_backfill",
          });
        }
      }
    }
  }

  console.log({
    matchedItem: emilyTurn.match.matchedItem,
    intent: emilyTurn.emilyIntent,
    memory: conversationMemory,
  });

  const hasNewEntitySignal =
    typeof message === "string" &&
    message
      .toLowerCase()
      .split(/\s+/)
      .some((token) => token.length >= 4);
  const memoryResolvedItem = resolveCatalogItemFromMemoryLabel({
    items: normalizedCatalogForTurn,
    lastItemMentioned: conversationMemory?.lastItemMentioned,
  });
  let resolvedItem = matchedItemForReply ?? null;
  if (!resolvedItem) {
    if (
      hasNewEntitySignal &&
      !messageLikelySameFocusAsMemory(
        message,
        conversationMemory?.lastItemMentioned
      )
    ) {
      // Long message that does not align with remembered item — avoid stale substitution.
      resolvedItem = null;
    } else {
      resolvedItem = memoryResolvedItem;
    }
  }
  if (turnLockedItem) {
    const attemptedId =
      resolvedItem && typeof resolvedItem === "object"
        ? normalizeId(resolvedItem.id ?? resolvedItem.itemId)
        : null;
    if (attemptedId && attemptedId !== turnLockedItem.itemId) {
      console.log("[item_context_overwrite_blocked]", {
        attemptedItemId: attemptedId,
        lockedItemId: turnLockedItem.itemId,
        source: "resolved_item_selection",
      });
    }
    resolvedItem = lockedItemAsContext();
  }
  console.log("🧠 Resolution Decision:", {
    message,
    matchedItem: matchedItemForReply,
    memoryItem: conversationMemory?.lastItemMentioned ?? null,
    hasNewEntitySignal,
    resolvedItem:
      resolvedItem != null
        ? labelFromMatchedItem(resolvedItem) ||
          (typeof resolvedItem.name === "string" ? resolvedItem.name : null)
        : null,
  });

  console.log("🧠 Context Resolution:", {
    matchedItem:
      matchedItemForReply != null
        ? labelFromMatchedItem(matchedItemForReply) ||
          (typeof matchedItemForReply.name === "string"
            ? matchedItemForReply.name
            : null)
        : null,
    memoryItem: conversationMemory?.lastItemMentioned ?? null,
    resolvedItem:
      resolvedItem != null
        ? labelFromMatchedItem(resolvedItem) ||
          (typeof resolvedItem.name === "string" ? resolvedItem.name : null)
        : null,
  });

  const isDelayedCommitment = emilyTurn.emilyIntent === "delayed_commitment";

  /** @type {Array<{ name?: string, displayLabel?: string }>} */
  const imageTargetCandidates = [];
  if (resolvedItem) {
    imageTargetCandidates.push(resolvedItem);
  }
  const candidateLabels = [
    nextChatContext.lastFocusedItem,
    conversationMemory?.lastItemMentioned ?? null,
    getLastEntityName(userId, chatContextKey),
  ];
  for (const rawLabel of candidateLabels) {
    const label = String(rawLabel ?? "").trim();
    if (!label) continue;
    imageTargetCandidates.push({
      name: label,
      displayLabel: label,
    });
  }
  const seenImageTargets = new Set();
  const uniqueImageTargetCandidates = imageTargetCandidates.filter((candidate) => {
    const key = normalizeText(
      String(candidate?.displayLabel ?? candidate?.name ?? "")
    );
    if (!key || seenImageTargets.has(key)) return false;
    seenImageTargets.add(key);
    return true;
  });
  if (
    wantsImages &&
    uniqueImageTargetCandidates.length === 0 &&
    hasUsefulBusinessData
  ) {
    const fromHistory = resolveRecentCatalogItemFromHistory({
      history: conversationHistory,
      items: normalizedCatalogForTurn,
    });
    if (fromHistory) {
      uniqueImageTargetCandidates.push(fromHistory);
    }
  }

  /** @type {{ name?: string, displayLabel?: string } | null} */
  let resolvedImageTarget = null;
  /** @type {string[]} */
  let catalogImageUrlsForShow = [];
  if (!isDelayedCommitment && wantsImages && hasUsefulBusinessData) {
    for (const candidate of uniqueImageTargetCandidates) {
      const urls = collectCatalogItemImageUrls({
        items: normalizedCatalogForTurn,
        matchedItem: candidate,
      });
      if (urls.length > 0) {
        resolvedImageTarget = candidate;
        catalogImageUrlsForShow = urls;
        break;
      }
    }
  }
  if (!isDelayedCommitment && wantsImages && uniqueImageTargetCandidates.length > 0 && catalogImageUrlsForShow.length === 0) {
    console.warn("[messageProcessor] show_images requested but no catalog images found", {
      matchedItem: uniqueImageTargetCandidates[0],
      triedTargets: uniqueImageTargetCandidates.map((c) =>
        String(c?.displayLabel ?? c?.name ?? "")
      ),
    });
  }

  if (
    !isDelayedCommitment &&
    catalogImageUrlsForShow.length > 0
  ) {
    const label =
      resolvedImageTarget?.displayLabel ??
      resolvedImageTarget?.name ??
      "";
    const finalReply = buildShowImagesCaption(
      label,
      emilyTurn.userLanguageStyle
    );
    const baseImages = {
      reply: finalReply,
      type: "AI_MESSAGE",
      messageMeta: {
        ...messageMetaForKnowledge(hasUsefulBusinessData),
        ...(bookingCreated ? { bookingCreated } : {}),
        deliveryIntent: "show_images",
        whatsappImageUrls: catalogImageUrlsForShow,
      },
    };
    const outImages = applyHybridOutboundResult(baseImages, routingCtx);
    if (String(outImages.reply ?? "").trim()) {
      appendConversationTurn(
        userId,
        message,
        String(outImages.reply),
        sessionKey
      );
    }
    return outImages;
  }

  if (!isDelayedCommitment && wantsImages) {
    if (!resolvedImageTarget) {
      const clarifyReply = isEnglishOnlyGreetingMessage(message)
        ? "Sure — which specific option images do you need?"
        : "Ji bilkul — kis specific option ki images chahiye?";
      const outClarify = applyHybridOutboundResult(
        {
          reply: clarifyReply,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            ...(bookingCreated ? { bookingCreated } : {}),
          },
        },
        routingCtx
      );
      if (String(outClarify.reply ?? "").trim()) {
        appendConversationTurn(
          userId,
          message,
          String(outClarify.reply),
          sessionKey
        );
      }
      return outClarify;
    }
    if (resolvedImageTarget && catalogImageUrlsForShow.length === 0) {
      const noImageReply = isEnglishOnlyGreetingMessage(message)
        ? "I can share details for this option, but images are not available right now."
        : "Is option ki details share kar sakta hoon, lekin images abhi available nahi hain.";
      const outNoImage = applyHybridOutboundResult(
        {
          reply: noImageReply,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            ...(bookingCreated ? { bookingCreated } : {}),
          },
        },
        routingCtx
      );
      if (String(outNoImage.reply ?? "").trim()) {
        appendConversationTurn(
          userId,
          message,
          String(outNoImage.reply),
          sessionKey
        );
      }
      return outNoImage;
    }
  }

  itemContext = await ensureItemContextFromMatchedItemReply(
    userId,
    itemContext,
    matchedItemForReply,
    resolveCatalogThisTurn
  );
  syncLastItemFromItemContextIfMissing(conversationMemory, itemContext);
  await ensureItemContextItemId(userId, itemContext, resolveCatalogThisTurn);
  itemContext = await hydrateItemWithAvailability(
    itemContext,
    normalizeId(conversationMemory?.lastItem?.id) ? "memory" : "fallback"
  );
  if (turnLockedItem) {
    await applyTurnLockedItemContext(
      turnLockedItem.reason === "CONTACT_AFTER_ASK_CONTACT" ? "memory" : "duration"
    );
    resolvedItem = lockedItemAsContext();
  }

  // Overlap async context build with sync catalog formatting (single-threaded overlap while context awaits I/O).
  const contextDataPromise = buildContextData({
    message,
    intent,
    hasKnowledge: hasUsefulBusinessData,
    item: itemContext,
    bookingCreated,
    entity: entityMeta,
    requiresDuration,
    business: businessContext,
  });
  const matchedCatalogLine = formatMatchedCatalogForPrompt(
    emilyTurn.match,
    emilyTurn.pricingHint
  );
  const contextData = await contextDataPromise;
  const selectedItemForAi = (() => {
    const src =
      resolvedItem && typeof resolvedItem === "object"
        ? resolvedItem
        : itemContext && typeof itemContext === "object"
          ? itemContext
          : null;
    if (!src) return null;
    const id =
      src.id != null && String(src.id).trim() !== ""
        ? String(src.id).trim()
        : src.itemId != null && String(src.itemId).trim() !== ""
          ? String(src.itemId).trim()
          : "";
    const name = String(src.name ?? "").trim();
    const displayLabel = buildDisplayLabel(
      /** @type {{ name?: unknown; color?: unknown; displayLabel?: unknown }} */ (src)
    );
    const priceRaw =
      src.price ??
      src.pricePerDay ??
      src.dailyRate ??
      src.rent ??
      src.rate ??
      null;
    const price =
      priceRaw != null && String(priceRaw).trim() !== ""
        ? String(priceRaw).trim()
        : null;
    if (!id || !name) return null;
    return {
      id,
      name,
      displayLabel: displayLabel || name,
      ...(price != null ? { price } : {}),
    };
  })();
  if (selectedItemForAi) {
    contextData.selectedItem = selectedItemForAi;
  }
  const shouldAvoidDurationQuestion =
    Boolean(conversationMemory?.durationPreference) &&
    resolvedEmilyIntent === "booking";
  contextData.avoidAskingDuration = shouldAvoidDurationQuestion;
  if (pinnedEntityName) {
    contextData.classifierPinnedEntity = pinnedEntityName;
  } else if (fallbackScopedLabel) {
    contextData.classifierPinnedEntity = fallbackScopedLabel;
    console.log("[messageProcessor] Scoped follow-up pinned to last focused item", {
      item: fallbackScopedLabel,
    });
  }
  const fc =
    typeof fragmentCount === "number" && Number.isFinite(fragmentCount) && fragmentCount >= 1
      ? Math.min(99, Math.floor(fragmentCount))
      : 1;
  contextData.whatsappFragmentCount = fc;
  contextData.whatsappMultipleFragments = Boolean(hasMultipleFragments) || fc > 1;
  contextData.whatsappGreetingFirst = Boolean(isGreetingFirst);

  const normalizedUserMsg = normalizeText(String(message ?? ""));
  if (isGreeting(normalizedUserMsg)) {
    contextData.isGreeting = true;
  }

  const matchedItemLabel = labelFromMatchedItem(emilyTurn.match.matchedItem);
  const skipReferentialContinuity =
    Boolean(shouldResetTopicContext) ||
    Boolean(pinnedEntityName);
  if (
    matchedItemLabel &&
    !skipReferentialContinuity &&
    isEntityEstablishedInRecentThread(history, matchedItemLabel)
  ) {
    contextData.entityEstablishedInRecentThread = true;
    contextData.entityCanonicalLabel = matchedItemLabel;
  }

  const tone = resolveBusinessTone(businessProfile);

  const hasKnowledgeForModel =
    businessProfile != null || hasUsefulBusinessData;

  if (DEBUG_EXTRACT) {
    console.log("[DEBUG] Final AI input:", {
      message,
      intent,
      emilyIntent: emilyTurn.emilyIntent,
      contextKeys: Object.keys(contextData),
      contextHasBusiness: contextData.business != null,
      mergedKnowledgeChars: mergedKnowledge.length,
      hasKnowledgeForModel,
      businessName,
      isGreetingFirst,
      isDelayedCommitment,
    });
  }

  const memoryDurationValue = getNormalizedDaysFromDurationPreference(
    conversationMemory?.durationPreference
  );
  const memoryBookingItemId =
    normalizeId(conversationMemory?.lastItem?.id) ||
    normalizeId(conversationMemory?.lastResolvedItemId);
  const memoryBookingItemName = String(conversationMemory?.lastItem?.name ?? "").trim();
  const contactParts = extractBookingContactParts(message);
  const isContactMessage = contactParts.isValid;
  const memory = conversationMemory;
  const extractedContact = isContactMessage
    ? String(contactParts.normalizedPhone || contactParts.phone || "").trim()
    : null;
  if (isValidContactValue(extractedContact) && !isGroupInbound) {
    memory.contact = extractedContact;
    if (contactParts.name) {
      memory.customerName = contactParts.name;
    }
  } else if (isValidContactValue(extractedContact) && isGroupInbound) {
    console.log("[group_logistics_mutation_blocked]", {
      attemptedFields: ["contactPhone", ...(contactParts.name ? ["customerName"] : [])],
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      groupName: groupName || null,
      chatKey: playwrightChatKey || null,
      reason: "GROUP_PRIVATE_DETAIL_MUTATION_BLOCKED",
    });
  }
  const bookingDurationDays =
    Number.isFinite(durationDays)
      ? Number(durationDays)
      : memoryDurationValue != null
        ? memoryDurationValue
        : memory?.lastDuration != null &&
            memory.lastDuration !== "" &&
            Number.isFinite(Number(memory.lastDuration))
          ? Math.max(1, Math.floor(Number(memory.lastDuration)))
          : null;
  const wasAwaitingContact =
    memory?.askedContact === true ||
    String(memory?.stage ?? "").toLowerCase() === "askcontact";
  const hasItem = Boolean(memory?.lastItem?.id);
  const hasDurationSignal =
    Number.isFinite(durationDays) ||
    Number.isFinite(bookingDurationDays) ||
    (memory?.lastDuration != null &&
      memory.lastDuration !== "" &&
      Number.isFinite(Number(memory.lastDuration)));
  const hasContact = isValidContactValue(extractedContact)
    ? true
    : isValidContactValue(memory?.contact)
      ? true
      : false;
  const userMessage = String(message ?? "");
  const isRelevantMessage =
    Boolean(extractedEntity) ||
    Number.isFinite(durationDays) ||
    /(available|book|reserve|order)/i.test(userMessage);
  if (
    Boolean(isGroupInbound) &&
    Boolean(extractedEntity) &&
    /available|available\?|avail|mil|hai|milega/i.test(userMessage) &&
    !Number.isFinite(durationDays) &&
    !Number.isFinite(bookingDurationDays)
  ) {
    console.log("[group_booking_context_not_reused_cross_participant]", {
      groupChatKey: normalizedPlaywrightChatKey || null,
      participantKey: sourceParticipantKey || null,
      item: extractedEntity,
    });
    console.log("[availability_only_booking_prevented]", {
      groupChatKey: normalizedPlaywrightChatKey || null,
      participantKey: sourceParticipantKey || null,
      item: extractedEntity,
      reason: "MISSING_DURATION_FOR_THIS_PARTICIPANT",
    });
  }
  let stage = null;

  if (hasItem && !hasDurationSignal && isRelevantMessage) {
    stage = "availability";
  } else if (hasItem && hasDurationSignal && !hasContact) {
    stage = "askContact";
  }
  if (stage === "askContact" && isGroupInbound) {
    console.warn("[group_ask_contact_stage_blocked]", {
      groupName: groupName || null,
      chatKey: playwrightChatKey || null,
      itemId: memoryBookingItemId || String(itemContext?.itemId ?? "").trim() || null,
      hasDuration: hasDurationSignal,
      reason: "PRIVATE_CONTACT_PROMPT_IN_GROUP_BLOCKED",
    });
    stage = null;
  }
  console.log("[intent_debug]", {
    intent,
    hasDuration: hasDurationSignal,
    hasContact,
    itemId:
      String(itemContext?.itemId ?? "").trim() ||
      memoryBookingItemId ||
      null,
  });
  if (bareDurationMessage && !durationContextAllowed) {
    console.log("[intent_routing]", {
      detectedIntent,
      route: "duration_context_clarify",
      itemId: null,
      memoryLastItemBefore: memoryBookingItemId || null,
      memoryLastItemAfter: normalizeId(conversationMemory?.lastItem?.id),
    });
    console.log("[final_reply_source]", { source: "PHRASE_ENGINE" });
    return applyHybridOutboundResult(
      {
        reply:
          conversationStyle === "casual_local"
            ? "Kis option ke liye chahiye?"
            : "Which option would you like this for?",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx
    );
  }

  const alreadyAskedContact = memory?.askedContact === true;
  if (stage === "askContact" && alreadyAskedContact) {
    stage = null;
  }

  const validStages = ["availability", "askContact"];

  if (!validStages.includes(stage)) {
    stage = null;
  }

  if (isContactMessage && conversationMemory?.bookingBlockedReason === "ITEM_ALREADY_BOOKED") {
    console.log("[CONTACT STEP BLOCKED]");
    return buildBookingBlockedResponse({
      itemName: memoryBookingItemName,
      memory: conversationMemory,
    });
  }
  if (
    !bookingCreated &&
    isContactMessage &&
    memoryBookingItemId &&
    bookingDurationDays != null &&
    (wasAwaitingContact || memory?.hasBookingIntent === true || resolvedEmilyIntent === "booking")
  ) {
    const duplicateContact = isDuplicateActiveBookingState(memory, {
      itemId: memoryBookingItemId,
      durationDays: bookingDurationDays,
      sessionKey: emilySessionKey,
      channel: isGroupInbound ? "group" : "dm",
    });
    const explicitPricingContact = isExplicitPricingOrDetailsQuestion(message);
    const suppressDupContact = shouldSuppressDuplicateAlreadyReceivedReply(
      message,
      extracted.durationDays ?? null,
      contactParts.isValid,
      events
    );
    const willReturnAlreadyReceivedContact =
      duplicateContact && !suppressDupContact;
    console.log("[duplicate_booking_guard_decision]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      itemId: memoryBookingItemId,
      durationDays: bookingDurationDays,
      sessionKey: emilySessionKey,
      duplicate: duplicateContact,
      duplicateReason: duplicateContact ? "active_booking_match" : "no_match",
      currentIntent: "contact_step_booking",
      priorityIntent: prioritizedIntent?.priorityIntent ?? null,
      explicitPricingOrDetailsQuestion: explicitPricingContact,
      willReturnAlreadyReceived: willReturnAlreadyReceivedContact,
    });
    if (willReturnAlreadyReceivedContact) {
      console.log("[BOOKING SKIPPED - ALREADY CREATED]");
      return applyHybridOutboundResult(
        {
          reply: "Your booking has already been received. We’ll confirm it shortly.",
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
          },
        },
        routingCtx
      );
    }
    console.log("[BOOKING CONTACT STEP DETECTED]", {
      messageText: message,
      item: memoryBookingItemName || null,
    });
    const bookingResult = await createBookingFromValidatedIntent({
      callerTag: "contact_step_booking",
      isGroupInbound,
      itemId: memoryBookingItemId,
      itemName: memoryBookingItemName || undefined,
      durationDays: bookingDurationDays,
      hasParticipantIdentity: Boolean(sourceParticipantKey),
      ownerApprovalFirstRequest: false,
      traceId,
      userId,
      ...bookingInboundGuard,
      createBookingArgs: {
        itemId: memoryBookingItemId,
        itemName: memoryBookingItemName || undefined,
        durationDays: bookingDurationDays,
        ...shortBookingCreateFields(shortBookingSelection, itemContext || memForCatalogInput?.lastItem),
        customerName:
          contactParts.name || String(memory?.customerName ?? "").trim() || undefined,
        customerPhone:
          extractedContact || String(memory?.contact ?? "").trim() || undefined,
        source,
        groupName,
        sessionKey,
        messageId,
        participantName,
        senderScope,
        playwrightChatKey,
        dmTargetPhone: dmTargetPhone || undefined,
        dmTargetSource: dmTargetSource || undefined,
        canDmCustomer,
        ...bookingSourceMessageMetadata,
      },
    });
    if (!bookingResult?.ok && bookingErrorCode(bookingResult) === "ITEM_ALREADY_BOOKED") {
      console.log("[BOOKING BLOCKED - CONTACT STEP]", memoryBookingItemName);
      return buildBookingBlockedResponse({
        itemName: memoryBookingItemName,
        memory: conversationMemory,
      });
    }
    if (bookingResult?.ok && typeof bookingResult.id === "string" && bookingResult.id.trim() !== "") {
      bookingCreated = {
        id: bookingResult.id.trim(),
        itemId: memoryBookingItemId,
        itemName: memoryBookingItemName || undefined,
        durationDays: bookingDurationDays,
        status: "pending_approval",
      };
      setStructuredBookingState(memory, {
        ...bookingCreated,
        sessionKey: emilySessionKey,
        channel: isGroupInbound ? "group" : "dm",
      });
      const bookingFinal = buildBookingFinalOutbound({
        bookingId: bookingCreated.id,
        itemId: memoryBookingItemId,
        itemName: memoryBookingItemName || undefined,
        durationDays: bookingDurationDays,
      });
      if (bookingFinal?.meta?.bookingCreated === true) {
        conversationMemory.askedContact = false;
        console.log("[PIPELINE GUARD] Booking completed \u2192 skipping AI + fallback");
        return bookingFinal;
      }
    } else if (!bookingResult?.ok) {
      console.log("[final_reply_source]", { source: "FALLBACK" });
      return applyHybridOutboundResult(
        {
          reply: "I have your contact details, but I couldn't create the booking request right now. Please try again shortly.",
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx
      );
    }
  }
  const blockAiForBooking =
    resolvedEmilyIntent === "booking" &&
    Boolean(matchedItemForReply || memoryBookingItemId) &&
    !isAnswerRequestedFieldPolicy(turnIntentShape);
  if (blockAiForBooking) {
    console.log("[BLOCKING AI → booking flow]");
  }
  console.log("[BOOKING DECISION FINAL]", {
    matchedItem:
      matchedItemForReply && typeof matchedItemForReply === "object"
        ? String(matchedItemForReply.name ?? "").trim() || null
        : null,
    memoryItem: memoryBookingItemName || null,
    finalIntent: resolvedEmilyIntent,
    willAttemptBooking:
      willAttemptBooking ||
      Boolean(
        events.transactionalIntent &&
          (memoryBookingItemId || matchedItemForReply) &&
          (hasDuration || memoryDurationValue != null)
      ),
  });

  let aiReply = "";
  let aiRawReply = "";
  /** @type {"GROUP" | "DM" | undefined} */
  let aiRouteModeFromModel;
  const businessConfig =
    businessProfile && typeof businessProfile === "object"
      ? {
          ...(businessProfile.rawBusinessProfile &&
          typeof businessProfile.rawBusinessProfile === "object"
            ? businessProfile.rawBusinessProfile
            : {}),
          ...(businessProfile.profileData &&
          typeof businessProfile.profileData === "object"
            ? businessProfile.profileData
            : {}),
          ...(businessProfile.phrases != null
            ? { phrases: businessProfile.phrases }
            : {}),
        }
      : null;
  const safeDuration =
    Number.isFinite(durationDays)
      ? durationDays
      : memory?.lastDuration != null &&
          memory.lastDuration !== "" &&
          Number.isFinite(Number(memory.lastDuration))
        ? Number(memory.lastDuration)
        : null;
  let safeItem = null;
  let phraseReply = null;
  const aiPhraseDecisionStartedAt = Date.now();

  const isAvailabilityQuestion =
    detectedIntent === "availability" ||
    classifierIntentKey === "availability" ||
    intent === "availability" ||
    /\b(avail|available|availability)\b/i.test(String(message ?? ""));
  if (!skipItemResolutionForGreeting) {
    itemContext = await hydrateItemWithAvailability(
      itemContext,
      isAvailabilityQuestion
        ? "initial"
        : hasDurationSignal
          ? "duration"
          : memoryBookingItemId
            ? "memory"
            : "fallback"
    );
  }
  if (!skipItemResolutionForGreeting) {
    const reconciledBeforeAvailability =
      await reconcileItemContextWithExplicitMessage({
        message,
        itemContext,
        catalogItems: normalizedCatalogForTurn,
        resolveCatalog: resolveCatalogThisTurn,
        hydrateFn: hydrateItemWithAvailability,
      });
    if (reconciledBeforeAvailability) {
      itemContext = reconciledBeforeAvailability;
      syncLastItemFromItemContextIfMissing(conversationMemory, itemContext);
    }
  }
  if (turnLockedItem) {
    await applyTurnLockedItemContext(
      turnLockedItem.reason === "CONTACT_AFTER_ASK_CONTACT" ? "memory" : "duration"
    );
    resolvedItem = lockedItemAsContext();
  }
  const currentTurnVerifiedItem = itemContext ?? resolvedItem ?? null;
  const safeItemCandidate = currentTurnVerifiedItem ?? memory?.lastItem ?? null;
  if (
    safeItemCandidate === memory?.lastItem &&
    isDetailFollowupWithoutExplicitEntity(message)
  ) {
    console.log("[resolved_item_from_memory_followup]", {
      itemId: normalizeId(memory?.lastItem?.id),
      itemName: String(memory?.lastItem?.name ?? "").trim() || null,
    });
  }
  safeItem =
    safeItemCandidate && typeof safeItemCandidate === "object"
      ? {
          ...safeItemCandidate,
          year:
            safeItemCandidate.year ??
            extractYearFromName(safeItemCandidate.name),
        }
      : null;
  const explicitUnlistedCheck = !skipItemResolutionForGreeting
    ? await resolveExplicitUnlistedMention({
        message,
        rawMessage: inboundMessageRawForFuzzy,
        itemContext,
        catalogItems: normalizedCatalogForTurn,
        resolveCatalog: resolveCatalogThisTurn,
        extractedEntity: extractedEntity ?? null,
      })
    : null;
  if (explicitUnlistedCheck?.notInCatalog) {
    if (isAwaitingBookingContactCapture(conversationMemory)) {
      console.log("[explicit_unlisted_skipped_slot_collection]", {
        label: explicitUnlistedCheck.label,
        reason: "AWAITING_BOOKING_CONTACT",
      });
    } else {
      console.log("[explicit_unlisted_overrides_stale_memory]", explicitUnlistedCheck);
      console.log("[final_reply_source]", {
        source: "EXPLICIT_UNLISTED_NOT_STALE_MEMORY",
      });
      logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
        source: "EXPLICIT_UNLISTED_NOT_STALE_MEMORY",
      });
      return applyHybridOutboundResult(
        {
          reply: buildNotListedReply({
            itemLabel: explicitUnlistedCheck.label,
            style: conversationStyle,
            catalogItems: normalizedCatalogForTurn,
          }),
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
  }
  const safeItemSource = resolveSafeItemSource({
    itemContext,
    resolvedItem,
    memory,
    safeItem,
  });
  const previousAssistantOfferedAlternative = (() => {
    const assistantReplies = mergeAssistantReplyListsForNorm(
      extractRecentAssistantTextsFromPromptBlock(history, 4),
      getRecentAssistantReplies(userId, 4, sessionKey),
      6
    );
    return assistantReplies.some((reply) =>
      assistantReplySignalsCatalogSelectionPrompt(String(reply ?? ""))
    );
  })();
  const collectDurationSelectionContext =
    previousAssistantOfferedAlternative ||
    /^(?:browsing|browse|options?|select_item|item_selection)$/i.test(
      String(memory?.stage ?? "")
    ) ||
    /^(?:browsing|browse|options?|select_item|item_selection)$/i.test(
      String(memoryPreEmily?.stage ?? "")
    ) ||
    String(memoryPreEmily?.bookingBlockedReason ?? "") === "ITEM_ALREADY_BOOKED" ||
    String(memory?.bookingBlockedReason ?? "") === "ITEM_ALREADY_BOOKED";
  async function resolveCollectDurationCurrentTurnItem() {
    if (currentTurnVerifiedCatalogItemForSelection) {
      return currentTurnVerifiedCatalogItemForSelection;
    }
    const latestSeg = getLatestUserSegmentForGuard(message);
    const normalizedQuery = computeCollectDurationCatalogQuery(message);
    const legacyWholeMessageStrip = String(message ?? "")
      .replace(/[?؟!.,]+$/g, "")
      .trim();
    console.log("[collect_duration_resolver_input]", {
      rawMessagePreview: String(message ?? "").trim().slice(0, 220) || null,
      latestUserSegment: latestSeg || null,
      normalizedSelectionQuery: normalizedQuery || null,
      legacyWholeMessageStripPreview: legacyWholeMessageStrip.slice(0, 220) || null,
    });
    if (normalizedQuery.length < 2) return null;
    const resolved = await resolveCatalogThisTurn(normalizedQuery, null);
    if (!resolved?.id) return null;
    const itemId = normalizeId(resolved.id);
    if (!itemId) return null;
    return hydrateItemWithAvailability(
      {
        ...resolved,
        id: itemId,
        itemId,
        name: String(resolved.name ?? "").trim(),
        displayLabel:
          String(resolved.displayLabel ?? "").trim() ||
          buildDisplayLabel(resolved) ||
          String(resolved.name ?? "").trim(),
      },
      "verified_item_selection"
    );
  }

  function ambiguousCollectDurationCandidateLabels() {
    const query = computeCollectDurationCatalogQuery(message);
    const inputTokens = tokenizeCatalogMatch(query).filter((token) => token.length >= 3);
    if (inputTokens.length === 0) return [];
    const matches = [];
    for (const row of normalizedCatalogForTurn) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const label = buildDisplayLabel(row) || String(row.name ?? "").trim();
      if (!label) continue;
      const labelTokens = tokenizeCatalogMatch(label);
      const allInputTokensMatch = inputTokens.every((inputToken) =>
        labelTokens.some((labelToken) => catalogTokensLikelySameWord(inputToken, labelToken))
      );
      if (allInputTokensMatch) matches.push(label);
    }
    return Array.from(new Set(matches)).slice(0, 5);
  }

  async function maybeStoreCollectDurationFromVerifiedSelection(route) {
    const routeName = String(route ?? "").trim() || "unknown";
    const resolvedSelectionItem = await resolveCollectDurationCurrentTurnItem();
    const hasParticipantSession = Boolean(
      sourceParticipantKey &&
        (normalizedPlaywrightChatKey || normalizedSessionKey) &&
        emilySessionKey
    );
    const collectDurationAvailabilityQuestion =
      isAvailabilityQuestionForCollectDurationGuard(message);
    const decision = collectDurationSelectionGuardDecision({
      message,
      item: resolvedSelectionItem,
      route: routeName,
      isAlternativeContext: collectDurationSelectionContext,
      hasParticipantSession,
      hasDurationSignal,
      isContactMessage,
      isAvailabilityQuestion: collectDurationAvailabilityQuestion,
    });
    console.log("[collect_duration_candidate_detected]", {
      itemId: decision.itemId,
      itemDisplayLabel: decision.itemDisplayLabel,
      route: decision.route,
      isAlternativeContext: decision.isAlternativeContext,
      isInformationalQuestion: decision.isInformationalQuestion,
      hasParticipantSession: decision.hasParticipantSession,
      availabilityStatus: decision.availabilityStatus,
    });
    if (
      !resolvedSelectionItem &&
      decision.reason === "NO_VERIFIED_CURRENT_TURN_ITEM" &&
      decision.isAlternativeContext &&
      decision.hasParticipantSession &&
      !decision.isInformationalQuestion &&
      !hasDurationSignal &&
      !isContactMessage &&
      !collectDurationAvailabilityQuestion
    ) {
      const ambiguousLabels = ambiguousCollectDurationCandidateLabels();
      if (ambiguousLabels.length > 1) {
        const inputLabel = computeCollectDurationCatalogQuery(message);
        console.log("[collect_duration_candidate_skipped]", {
          reason: "AMBIGUOUS_ITEM_SELECTION",
          itemId: null,
          itemDisplayLabel: null,
          route: decision.route,
          hasStableItemId: false,
          hasAvailability: false,
          isAlternativeContext: decision.isAlternativeContext,
          isInformationalQuestion: decision.isInformationalQuestion,
          hasParticipantSession: decision.hasParticipantSession,
          candidateLabels: ambiguousLabels,
        });
        return applyHybridOutboundResult(
          {
            reply: inputLabel
              ? `Kaunsi ${inputLabel} chahiye?`
              : "Kaunsa option chahiye?",
            type: "AI_MESSAGE",
            messageMeta: {
              ...messageMetaForKnowledge(hasUsefulBusinessData),
              pendingActionType: null,
              itemSelectionAmbiguous: true,
            },
          },
          routingCtx,
          aiRouteModeFromModel
        );
      }
    }
    if (
      !decision.ok &&
      decision.reason === "ITEM_UNAVAILABLE" &&
      collectDurationSelectionContext &&
      resolvedSelectionItem &&
      typeof resolvedSelectionItem === "object" &&
      normalizeId(resolvedSelectionItem.id ?? resolvedSelectionItem.itemId) &&
      !decision.isInformationalQuestion &&
      !collectDurationAvailabilityQuestion
    ) {
      const itemLabel =
        decision.itemDisplayLabel ||
        buildDisplayLabel(resolvedSelectionItem) ||
        String(resolvedSelectionItem.name ?? "").trim() ||
        "yeh option";
      const styleKey =
        conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
      console.log("[collect_duration_option_selection_unavailable]", {
        itemId: normalizeId(resolvedSelectionItem.id ?? resolvedSelectionItem.itemId) || null,
        itemDisplayLabel: itemLabel,
        route: decision.route,
      });
      const replyText = await resolveStructuredUnavailableCustomerReply({
        userId,
        catalogRow: resolvedSelectionItem,
        availabilitySnapshot: {
          blockingStatusesSeen: Array.isArray(resolvedSelectionItem.blockingStatusesSeen)
            ? resolvedSelectionItem.blockingStatusesSeen
            : [],
        },
        normalizedCatalogForTurn,
        styleKey,
        conversationStyle,
        traceId,
        logKind: "booking_blocked",
        memory,
      });
      return applyHybridOutboundResult(
        {
          reply: replyText,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            pendingActionType: null,
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
    if (
      !decision.ok &&
      decision.reason === "AVAILABILITY_UNKNOWN" &&
      collectDurationSelectionContext &&
      resolvedSelectionItem &&
      typeof resolvedSelectionItem === "object" &&
      normalizeId(resolvedSelectionItem.id ?? resolvedSelectionItem.itemId) &&
      !decision.isInformationalQuestion &&
      !collectDurationAvailabilityQuestion
    ) {
      const itemLabel =
        decision.itemDisplayLabel ||
        buildDisplayLabel(resolvedSelectionItem) ||
        String(resolvedSelectionItem.name ?? "").trim() ||
        "";
      console.log("[collect_duration_option_selection_availability_unknown]", {
        itemId: normalizeId(resolvedSelectionItem.id ?? resolvedSelectionItem.itemId) || null,
        itemDisplayLabel: itemLabel || null,
        route: decision.route,
      });
      return applyHybridOutboundResult(
        {
          reply: buildCollectDurationAvailabilityUnknownReply({
            itemLabel,
            style: conversationStyle,
          }),
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            pendingActionType: null,
          },
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
    if (!decision.ok) {
      console.log("[collect_duration_candidate_skipped]", {
        reason: decision.reason,
        itemId: decision.itemId,
        itemDisplayLabel: decision.itemDisplayLabel,
        route: decision.route,
        hasStableItemId: decision.hasStableItemId,
        hasAvailability: decision.hasAvailability,
        isAlternativeContext: decision.isAlternativeContext,
        isInformationalQuestion: decision.isInformationalQuestion,
        hasParticipantSession: decision.hasParticipantSession,
      });
      return null;
    }

    const itemId = decision.itemId;
    const itemDisplayLabel = decision.itemDisplayLabel;
    const memoryItem = {
      ...(resolvedSelectionItem && typeof resolvedSelectionItem === "object"
        ? resolvedSelectionItem
        : {}),
      id: itemId,
      itemId,
      name: itemDisplayLabel,
      displayLabel: itemDisplayLabel,
    };
    memory.lastItem = memoryItem;
    memory.lastItemMentioned = itemDisplayLabel;
    setLastResolvedItemId(memory, itemId);
    memory.stage = "awaiting_duration";
    memory.hasBookingIntent = true;
    memory.askedContact = false;

    const reply = `${itemDisplayLabel} available hai. Kitne time ke liye chahiye?`;
    const pendingAction = buildPendingAction({
      type: PENDING_ACTION_TYPES.COLLECT_DURATION,
      expectedReplyType: "duration",
      participantKey: sourceParticipantKey || "",
      groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || "",
      sessionKey: emilySessionKey,
      itemId,
      itemDisplayLabel,
      payload: {
        source: "verified_item_selection",
        availabilityStatus: decision.availabilityStatus,
        explicitPriceIntent: false,
      },
      sourceMessageId: messageId,
      sourcePromptText: reply,
    });
    const stored = storePendingAction(memory, pendingAction);
    console.log("[collect_duration_pending_action_stored]", {
      itemId,
      itemDisplayLabel,
      participantKey: sourceParticipantKey || null,
      groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey || null,
      sessionKey: emilySessionKey,
      expiresAt: stored?.expiresAt ?? null,
    });
    return applyHybridOutboundResult(
      {
        reply,
        type: "AI_MESSAGE",
        messageMeta: {
          ...messageMetaWithOutboundTrace(
            hasUsefulBusinessData,
            buildOutboundTrace({
              kind: ASSISTANT_OUTBOUND_KIND.ACTIONABLE_PROMPT,
              finalReplySource: "COLLECT_DURATION_PROMPT",
              pendingActionTypeStored: PENDING_ACTION_TYPES.COLLECT_DURATION,
              collectDurationPrompt: true,
            })
          ),
          pendingActionType: PENDING_ACTION_TYPES.COLLECT_DURATION,
          itemContext: {
            itemId,
            itemName: itemDisplayLabel,
          },
        },
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }
  if (
    isAvailabilityQuestion &&
    itemContext != null &&
    typeof itemContext === "object" &&
    itemContext.isAvailable === false &&
    !isAnswerRequestedFieldPolicy(turnIntentShape)
  ) {
    const earlyTimingTurn = availabilityTimingUnknownTurnIfRouted({
      message,
      memory,
      prioritizedIntent,
      llmIntentClassification,
      conversationHistory,
      userId,
      sessionKey: emilySessionKey,
      normalizedCatalogForTurn,
      emilyTurn,
      conversationStyle,
      safeItemSource,
      routeLogSource: "pre_early_stock_availability",
    });
    if (earlyTimingTurn) {
      console.log("[final_reply_source]", { source: "AVAILABILITY_TIMING_UNKNOWN" });
      logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
        source: "AVAILABILITY_TIMING_UNKNOWN",
      });
      return applyHybridOutboundResult(
        {
          reply: earlyTimingTurn.reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext.name ?? "").trim() ||
      memoryBookingItemName;
    const blockingStatusesSeen = Array.isArray(itemContext.blockingStatusesSeen)
      ? itemContext.blockingStatusesSeen
      : [];
    const reqId = String(itemContext.itemId ?? "").trim() || null;
    const altRows = Array.isArray(itemContext.alternativeItems)
      ? itemContext.alternativeItems
      : [];
    const topItems = altRows
      .map((a) => {
        const id = String(a.id ?? "").trim();
        const match = normalizedCatalogForTurn.find(
          (r) => String(r.id ?? r.itemId ?? "").trim() === id
        );
        return match
          ? catalogRowToTopAvailabilityItem(
              /** @type {Record<string, unknown>} */ (match),
              buildDisplayLabel
            )
          : {
              itemId: id,
              displayLabel: String(a.name ?? "").trim(),
              priceDaily: null,
              category: null,
              tags: [],
            };
      })
      .slice(0, 5);
    const summarySkipped = itemContext.alternativeSummarySkipped === true;
    const summaryStatus = summarySkipped ? "missing" : "fresh";
    const otherAvailableCount = summarySkipped ? 0 : altRows.length;
    const styleKey =
      conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
    const availabilityCtx = buildAvailabilityContextSkeleton({
      intent: "item_availability",
      requestedItem: {
        itemId: reqId,
        displayLabel: itemLabel,
        availabilityStatus: "unavailable",
        blockingReason:
          blockingStatusesSeen.length > 0
            ? String(blockingStatusesSeen[0])
            : "ALREADY_BOOKED",
      },
      inventorySummary: {
        status: summaryStatus,
        totalItems: normalizedCatalogForTurn.length,
        availableCount: otherAvailableCount,
        unavailableCount: null,
        topAvailableItems: topItems,
        maxItemsShown: 5,
      },
      policy: {},
      alternativeSummarySkipped: summarySkipped,
    });
    const reply = await resolveAvailabilityCustomerReply({
      availabilityCtx,
      userMessage: message,
      styleKey,
      __availabilityAiCompletionForTests,
    });
    console.log("[availability_context_built]", {
      intent: availabilityCtx.intent,
      summaryStatus: availabilityCtx.inventorySummary.status,
      availableCount: availabilityCtx.inventorySummary.availableCount,
      topItemCount: availabilityCtx.inventorySummary.topAvailableItems.length,
      requestedItemId: availabilityCtx.requestedItem?.itemId ?? null,
    });
    console.log("[availability_check_initial]", {
      itemId: String(itemContext.itemId ?? "").trim() || null,
      itemLabel: itemLabel || null,
      result: "unavailable",
      blockingStatusesSeen,
      path: "initial_availability_question",
    });
    console.log("[final_reply_source]", {
      source: "AVAILABILITY_BLOCKED_EARLY",
    });
    logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
      source: "AVAILABILITY_BLOCKED_EARLY",
    });
    if (!summarySkipped && summaryStatus === "fresh" && otherAvailableCount === 0) {
      clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptions({
        chatContextKey,
        nextChatContext,
        source: "item_availability_unavailable",
        availableCount: 0,
        summaryStatus: "fresh",
        reason: "ITEM_UNAVAILABLE_NO_ALTERNATIVES_FRESH",
      });
      markAvailabilityFreshNoOtherOptionsStructured(memory);
    }
    return applyHybridOutboundResult(
      {
        reply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }
  if (
    isAvailabilityQuestion &&
    itemContext != null &&
    typeof itemContext === "object" &&
    itemContext.isAvailable !== false
  ) {
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext.name ?? "").trim() ||
      memoryBookingItemName;
    console.log("[availability_check_initial]", {
      itemId: String(itemContext.itemId ?? "").trim() || null,
      itemLabel: itemLabel || null,
      result: "available",
      blockingStatusesSeen: Array.isArray(itemContext.blockingStatusesSeen)
        ? itemContext.blockingStatusesSeen
        : [],
      path: "initial_availability_question",
    });
  }

  let conversationRoute = decideConversationRoute({
    message,
    selectedItem: safeItem,
    memory,
    activeStage: stage,
    isDeliveryDetailsActive: false,
    isApprovalAction: false,
    intentClassification: prioritizedIntent,
  });
  if (isAnswerRequestedFieldPolicy(turnIntentShape)) {
    const detectedFieldForRoute =
      resolveItemlessPriceDurationAskedField(message) || detectAskedField(message);
    const shapeAskedField =
      turnIntentShape.requestedField === "photo"
        ? "media"
        : detectedFieldForRoute === "price_with_duration"
          ? "price_with_duration"
          : turnIntentShape.requestedField === "price"
            ? "price"
            : turnIntentShape.requestedField ?? "unknown";
    conversationRoute = {
      routeType: "INFORMATIONAL_QUESTION",
      selectedItem: safeItem,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "intent_shape_answer_requested_field",
      askedField: shapeAskedField,
    };
  }
  routeTypeForProcessMessageLog = String(conversationRoute?.routeType ?? "").trim() || null;
  console.log("[conversation_route_decided]", {
    routeType: conversationRoute.routeType,
    shouldBypassPhraseEngine: conversationRoute.shouldBypassPhraseEngine,
    shouldContinueFlow: conversationRoute.shouldContinueFlow,
    reason: conversationRoute.reason,
    selectedItem:
      String(safeItem?.itemId ?? safeItem?.id ?? "").trim() ||
      String(safeItem?.name ?? "").trim() ||
      null,
  });
  console.log("[route_after_intent_priority]", {
    priorityIntent: prioritizedIntent.priorityIntent,
    routeType: conversationRoute.routeType,
    askedField: conversationRoute.askedField ?? prioritizedIntent.askedField,
    reason: conversationRoute.reason,
  });

  emit("INTENT_DECISION", {
    detectedIntent,
    classifierIntentKey,
    priorityIntent: prioritizedIntent?.priorityIntent ?? null,
    routeType: conversationRoute.routeType,
    askedField: conversationRoute.askedField ?? prioritizedIntent?.askedField ?? null,
    explicitPricingOrDetailsQuestion: isExplicitPricingOrDetailsQuestion(message),
  });

  const globalTimingTurn = availabilityTimingUnknownTurnIfRouted({
    message,
    memory,
    prioritizedIntent,
    llmIntentClassification,
    conversationHistory,
    userId,
    sessionKey: emilySessionKey,
    normalizedCatalogForTurn,
    emilyTurn,
    conversationStyle,
    safeItemSource,
    routeLogSource: "global_route_order",
  });
  if (globalTimingTurn) {
    console.log("[final_reply_source]", { source: "AVAILABILITY_TIMING_UNKNOWN" });
    logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
      source: "AVAILABILITY_TIMING_UNKNOWN",
    });
    return applyHybridOutboundResult(
      {
        reply: globalTimingTurn.reply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }

  const explicitPricingOrDetailsQuestionRoute =
    isExplicitPricingOrDetailsQuestion(message);
  const strongBookingCommitForShortcut =
    hasStrongBookingCommitPhrase(message);
  const bookingContinuationShapedForShortcut =
    isBookingContinuationShapedCurrentTurn(
      message,
      extracted.durationDays ?? null,
      contactParts.isValid,
      events
    );
  const ownerApprovalBlockedByPricingIntent =
    explicitPricingOrDetailsQuestionRoute && !strongBookingCommitForShortcut;
  const shouldRunGroupOwnerApprovalAfterDuration =
    ownerApprovalFirst &&
    Boolean(isGroupInbound) &&
    !bookingCreated &&
    hasDurationSignal === true &&
    !hasContact &&
    bookingContinuationShapedForShortcut &&
    !ownerApprovalBlockedByPricingIntent;

  if (
    ownerApprovalBlockedByPricingIntent &&
    ownerApprovalFirst &&
    Boolean(isGroupInbound) &&
    !bookingCreated &&
    hasDurationSignal === true &&
    !hasContact
  ) {
    console.log("[group_owner_approval_skipped_pricing_intent]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      extractedDurationDays: Number.isFinite(Number(extracted?.durationDays))
        ? Number(extracted.durationDays)
        : null,
      explicitPricingOrDetailsQuestion: true,
    });
  }

  let ownerShortcutReason = "other";
  if (shouldRunGroupOwnerApprovalAfterDuration) {
    ownerShortcutReason = "armed_group_owner_approval_after_duration";
  } else if (!ownerApprovalFirst) {
    ownerShortcutReason = "owner_approval_not_first";
  } else if (!isGroupInbound) {
    ownerShortcutReason = "not_group_inbound";
  } else if (bookingCreated) {
    ownerShortcutReason = "booking_already_created_this_turn";
  } else if (!hasDurationSignal) {
    ownerShortcutReason = "missing_duration_signal";
  } else if (hasContact) {
    ownerShortcutReason = "has_contact";
  } else if (
    explicitPricingOrDetailsQuestionRoute &&
    !bookingContinuationShapedForShortcut
  ) {
    ownerShortcutReason = "pricing_or_details_without_booking_continuation";
  }

  console.log("[group_owner_approval_shortcut_decision]", {
    messagePreview: String(message ?? "").trim().slice(0, 160) || null,
    isGroupInbound: Boolean(isGroupInbound),
    hasDurationSignal,
    hasContact,
    bookingIntent: events.bookingIntent,
    transactionalIntent: events.transactionalIntent,
    priorityIntent: prioritizedIntent.priorityIntent,
    askedField: prioritizedIntent.askedField,
    explicitPricingOrDetailsQuestion: explicitPricingOrDetailsQuestionRoute,
    willArmShortcut: shouldRunGroupOwnerApprovalAfterDuration,
    reason: ownerShortcutReason,
  });

  if (
    isConversationAiRoute(conversationRoute) &&
    !shouldRunGroupOwnerApprovalAfterDuration
  ) {
    console.log("[phrase_engine_bypassed]", {
      routeType: conversationRoute.routeType,
      reason: conversationRoute.reason,
    });
    if (isInformationalRoute(conversationRoute)) {
      const collectDurationSelection = await maybeStoreCollectDurationFromVerifiedSelection(
        conversationRoute.routeType
      );
      if (collectDurationSelection) {
        return collectDurationSelection;
      }
    }
    const routerContextData = {
      ...contextData,
      requiresDuration: false,
      conversationRouterInstruction:
        "You are replying as the business on WhatsApp. Sound human, short, and natural. Answer the latest user question first. Use business catalog, selected item context, memory.lastItem, and previous assistant message. Do not mention AI, assistant, process, workflow, system, or owner approval. Do not repeat the previous question. If a booking flow is active, continue only if natural.",
    };
    const directReply = isInformationalRoute(conversationRoute)
      ? directInformationalReply(message, safeItem)
      : "";
    let routedReply = directReply;
    let routedMode;
    if (!routedReply) {
      const routedOut = await timeAsync(
        "AI/phrase decision",
        () =>
          generateReply({
            message,
            contextMessages,
            intent,
            emilyIntent: "inquiry",
            history,
            knowledge: mergedKnowledge,
            hasKnowledge: hasKnowledgeForModel,
            contextData: routerContextData,
            businessName,
            businessType,
            businessProfile: businessContext,
            catalogItems: normalizedCatalogForTurn,
            selectedItem: selectedItemForAi,
            conversationMemory,
            conversationMemorySummary: emilyTurn.memorySummary,
            matchedItem: matchedItemForReply,
            matchedService: emilyTurn.match.matchedService,
            matchedCatalogLine,
            proactivePricingHint: emilyTurn.pricingHint,
            conversationStage: conversationMemory.stage,
            userLanguageStyle: emilyTurn.userLanguageStyle,
            tone,
            fragmentCount: fc,
            hasMultipleFragments: Boolean(hasMultipleFragments) || fc > 1,
            isGreetingFirst: Boolean(isGreetingFirst),
            lastFocusedItem: nextChatContext.lastFocusedItem ?? null,
            lastDuration: nextChatContext.lastDuration ?? null,
            detectedIntent,
          }),
        { source: "AI_CONVERSATION_ROUTER" }
      );
      routedReply = routedOut.reply ?? "";
      console.log("[llm_draft_generated]", {
        routeType: conversationRoute.routeType,
        chars: String(routedReply ?? "").length,
      });
      routedMode =
        routedOut.mode === "GROUP" || routedOut.mode === "DM"
          ? routedOut.mode
          : undefined;
    } else {
      console.log("[llm_draft_generated]", {
        routeType: conversationRoute.routeType,
        source: "direct_field",
        chars: String(routedReply ?? "").length,
      });
    }
    const assistantFromHistoryForRoute = extractRecentAssistantTextsFromPromptBlock(
      conversationHistory,
      6
    );
    const recentAssistantForRoute = mergeAssistantReplyListsForNorm(
      assistantFromHistoryForRoute,
      getRecentAssistantReplies(userId, 3, sessionKey),
      8
    );
    let finalRoutedReply = normalizeEmilyResponse(routedReply, {
      matchedItem: matchedItemForReply,
      matchedService: emilyTurn.match.matchedService,
      intent: "inquiry",
      memory: conversationMemory,
      memoryDelta: emilyTurn.memoryDelta,
      userMessage: message,
      pricingHint: emilyTurn.pricingHint,
      userLanguageStyle: emilyTurn.userLanguageStyle,
      recentAssistantReplies: recentAssistantForRoute,
      sessionKey: emilySessionKey,
    });
    if (replyChannel === "whatsapp" && finalRoutedReply) {
      finalRoutedReply = polishWhatsAppBusinessTone(String(finalRoutedReply));
    }
    let composedAnswer = null;
    const replyBeforeComposer = finalRoutedReply;
    if (isInformationalRoute(conversationRoute)) {
      const initialComposerItem = mergeComposerCatalogItem(
        safeItem,
        normalizedCatalogForTurn
      );
      let composerItem = initialComposerItem;
      const upgradeResult = maybeUpgradePartialItemFromCatalog({
        partialItem: initialComposerItem ?? safeItem,
        catalogItems: normalizedCatalogForTurn,
        userMessage: message,
        memoryContext: memory,
      });
      if (upgradeResult.status === "matched") {
        composerItem = mergeComposerCatalogItem(
          upgradeResult.item,
          normalizedCatalogForTurn
        );
        console.log("[composer_item_upgraded_from_catalog]", {
          hadItemIdBefore:
            normalizeId(initialComposerItem?.itemId ?? initialComposerItem?.id) !== "",
          hasItemIdAfter:
            normalizeId(composerItem?.itemId ?? composerItem?.id) !== "",
          hadPricingBefore: itemHasPricingData(initialComposerItem),
          hasPricingAfter: itemHasPricingData(composerItem),
          matchReason: upgradeResult.matchReason,
          ambiguityCount: 0,
          itemName:
            String(composerItem?.displayLabel ?? composerItem?.name ?? "").trim() ||
            null,
          itemId: normalizeId(composerItem?.itemId ?? composerItem?.id) || null,
        });
      } else if (upgradeResult.status === "ambiguous") {
        const matches = Array.isArray(upgradeResult.matches)
          ? upgradeResult.matches
          : [];
        console.log("[composer_item_upgrade_ambiguous]", {
          queryPreview: String(message ?? "").slice(0, 120),
          candidateCount: matches.length,
          candidateNames: matches
            .map((candidate) =>
              String(candidate?.displayLabel ?? candidate?.name ?? "").trim()
            )
            .filter(Boolean)
            .slice(0, 8),
          reason: upgradeResult.reason,
        });
      }
      const askedFieldForComposer = String(
        conversationRoute.askedField ?? prioritizedIntent.askedField ?? ""
      )
        .trim()
        .toLowerCase();
      let composedViaOptionGate = false;
      if (
        collectDurationSelectionContext &&
        askedFieldForComposer === "model" &&
        isBareCatalogSelectionMessageShapeForComposer(message) &&
        composerItem &&
        normalizeId(composerItem.itemId ?? composerItem.id)
      ) {
        const hydratedForGate =
          typeof composerItem.isAvailable === "boolean"
            ? composerItem
            : await hydrateItemWithAvailability(composerItem, "fallback");
        if (hydratedForGate && hydratedForGate.isAvailable === false) {
          const itemLabel =
            buildDisplayLabel(hydratedForGate) ||
            String(hydratedForGate.displayLabel ?? hydratedForGate.name ?? "").trim() ||
            "yeh option";
          composedAnswer = {
            reply: buildUnavailableReply({
              itemLabel,
              style: conversationStyle,
            }),
            field: "availability",
            source: "option_selection_unavailable_gate",
            unknownHumanized: false,
            finalAuthority: true,
            answerKnown: true,
          };
          composedViaOptionGate = true;
          console.log("[answer_composer_option_selection_unavailable]", {
            itemId: normalizeId(hydratedForGate.itemId ?? hydratedForGate.id) || null,
            itemLabel,
          });
        }
      }
      if (!composedViaOptionGate) {
        composedAnswer = composeInformationalAnswer({
          message,
          draftReply: finalRoutedReply,
          item: composerItem,
          businessContext,
          askedField:
            priceDurationFollowupWithSafeItem
              ? resolveItemlessPriceDurationAskedField(message) || "price_with_duration"
              : conversationRoute.askedField ?? prioritizedIntent.askedField,
        });
      }
      finalRoutedReply = composedAnswer.reply;
      console.log("[answer_composer_applied]", {
        field: composedAnswer.field,
        source: composedAnswer.source,
      });
      if (
        composedAnswer.finalAuthority === true &&
        composedAnswer.source !== "llm_draft" &&
        String(replyBeforeComposer ?? "").trim() !== "" &&
        String(replyBeforeComposer ?? "").trim() !== String(finalRoutedReply ?? "").trim()
      ) {
        console.log("[llm_draft_discarded_for_verified_answer]", {
          field: composedAnswer.field,
          source: composedAnswer.source,
        });
      }
      if (composedAnswer.fieldMismatchBlocked) {
        console.log("[field_mismatch_blocked]", {
          field: composedAnswer.field,
        });
      }
      if (composedAnswer.unknownHumanized) {
        console.log("[unknown_answer_humanized]", {
          field: composedAnswer.field,
        });
      }
      if (
        shouldStoreLastVerifiedCatalogAnswer({
          composedAnswer,
          composerItem,
          conversationRoute,
        })
      ) {
        storeLastVerifiedCatalogAnswer({
          memory: conversationMemory,
          item: composerItem,
          composedAnswer,
          requestedField: normalizeVerifiedCatalogPricingRequestedField(
            conversationRoute.askedField ?? prioritizedIntent.askedField ?? composedAnswer.field
          ),
          participantKey: sourceParticipantKey || "",
          chatContextKey,
          sessionKey: emilySessionKey,
          traceId,
        });
      }
    }
    const guardedReply = applyToneGuard(finalRoutedReply);
    if (guardedReply !== finalRoutedReply) {
      console.log("[tone_guard_applied]", {
        changed: true,
        routeType: conversationRoute.routeType,
      });
    } else {
      console.log("[tone_guard_applied]", {
        changed: false,
        routeType: conversationRoute.routeType,
      });
    }
    finalRoutedReply = guardedReply;
    const lastAssistantForStrategy = recentAssistantForRoute[0] ?? "";
    const responseStrategy = decideResponseStrategy({
      userMessage: message,
      lastAssistantMessage: lastAssistantForStrategy,
      conversationState: {
        lastAskedQuestionType:
          /\b(kitne time|kitne din|for how long|how many days|duration)\b/i.test(
            String(lastAssistantForStrategy ?? "")
          )
            ? "duration"
            : null,
        lastAskedTimestamp: null,
      },
      routeType: conversationRoute.routeType,
      askedField: composedAnswer?.field ?? null,
      answerKnown: composedAnswer
        ? composedAnswer.answerKnown === true
        : Boolean(finalRoutedReply),
    });
    if (composedAnswer?.finalAuthority === true) {
      responseStrategy.strategy = "answer_only";
      responseStrategy.reason = "composer_final_authority";
    }
    console.log("[response_strategy_selected]", {
      routeType: conversationRoute.routeType,
      strategy: responseStrategy.strategy,
      reason: responseStrategy.reason,
      askedField: composedAnswer?.field ?? null,
    });
    const responseStrategyResult = applyResponseStrategy({
      reply: finalRoutedReply,
      strategyDecision: responseStrategy,
      userMessage: message,
      lastAssistantMessage: lastAssistantForStrategy,
      conversationState: {
        lastAskedQuestionType:
          /\b(kitne time|kitne din|for how long|how many days|duration)\b/i.test(
            String(lastAssistantForStrategy ?? "")
          )
            ? "duration"
            : null,
        lastAskedTimestamp: null,
      },
    });
    finalRoutedReply = responseStrategyResult.reply;
    for (const event of responseStrategyResult.events) {
      if (event.type === "variation_applied") {
        console.log("[variation_applied]", {
          poolName: event.poolName,
          index: event.index,
        });
      } else if (event.type === "followup_added") {
        console.log("[followup_added]", {
          questionType: event.questionType,
        });
      } else if (event.type === "followup_blocked_due_to_repetition") {
        console.log("[followup_blocked_due_to_repetition]", {
          questionType: event.questionType,
        });
      } else if (event.type === "no_followup_decision") {
        console.log("[no_followup_decision]", {
          strategy: event.strategy,
        });
      }
    }
    const repeatsDurationQuestion =
      isInformationalRoute(conversationRoute) &&
      responseStrategy.strategy !== "answer_then_guide" &&
      /\b(kitne time|kitne din|for how long|how many days|duration)\b/i.test(
        String(finalRoutedReply ?? "")
      );
    const repeatsPrior = recentAssistantForRoute.some(
      (prior) => assistantReplySimilarity(finalRoutedReply, prior) >= 0.82
    );
    if (repeatsDurationQuestion || repeatsPrior) {
      console.log("[anti_repetition_applied]", {
        routeType: conversationRoute.routeType,
        repeatsDurationQuestion,
        repeatsPrior,
      });
      if (composedAnswer?.finalAuthority === true) {
        console.log("[anti_repetition_skipped_verified_answer]", {
          routeType: conversationRoute.routeType,
          field: composedAnswer?.field ?? null,
          source: composedAnswer?.source ?? null,
          repeatsDurationQuestion,
          repeatsPrior,
        });
      } else {
        finalRoutedReply =
          directReply ||
          (conversationStyle === "casual_local"
            ? "Ji, iski detail share kar deta hun — aap kaunsa point confirm karna chah rahe hain?"
            : "Sure, I can share that detail — which point would you like me to confirm?");
        finalRoutedReply = applyToneGuard(finalRoutedReply);
      }
    }
    console.log("[ai_conversation_response_used]", {
      routeType: conversationRoute.routeType,
      directReplyUsed: Boolean(directReply),
    });
    console.log("[final_human_response]", {
      routeType: conversationRoute.routeType,
      chars: String(finalRoutedReply ?? "").length,
    });
    return applyHybridOutboundResult(
      {
        reply: finalRoutedReply,
        text: finalRoutedReply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaWithOutboundTrace(
          hasUsefulBusinessData,
          buildOutboundTrace({
            finalReplySource: "INFORMATIONAL_COMPOSER",
            routeType: conversationRoute.routeType,
            responsePolicy: turnIntentShape?.responsePolicy ?? null,
            askedField: composedAnswer?.field ?? conversationRoute.askedField ?? null,
            composedAnswerSource: composedAnswer?.source ?? null,
          })
        ),
      },
      routingCtx,
      routedMode
    );
  }

  if (
    shouldRunGroupOwnerApprovalAfterDuration
  ) {
    const approvalItemId =
      String(itemContext?.itemId ?? "").trim() || memoryBookingItemId || null;
    const approvalDurationDays = Number.isFinite(bookingDurationDays)
      ? Math.max(1, Math.floor(Number(bookingDurationDays)))
      : null;
    const approvalContinuation = isSameSessionBookingContinuation({
      memory: conversationMemory,
      emilySessionKey,
      itemId: approvalItemId,
      message,
      extractedDurationDays: extracted.durationDays ?? bookingDurationDays ?? null,
      contactValid: contactParts.isValid,
      events,
    });
    const approvalHydratedAvailable =
      itemContext != null &&
      typeof itemContext === "object" &&
      (itemContext.isAvailable === true || approvalContinuation);
    console.log("[group_contact_request_blocked]", {
      itemId: approvalItemId,
      hasDuration: approvalDurationDays != null,
      hasContact,
      isAvailable: approvalHydratedAvailable,
      approvalContinuation,
      reason: "OWNER_APPROVAL_FIRST",
    });

    if (
      approvalItemId &&
      approvalDurationDays != null &&
      approvalContinuation &&
      itemContext != null &&
      typeof itemContext === "object" &&
      itemContext.isAvailable === false
    ) {
      const approvalItemName =
        buildDisplayLabel(itemContext) ||
        String(itemContext?.name ?? "").trim() ||
        memoryBookingItemName ||
        "";
      const continuationReply = buildSameSessionBookingContinuationReply({
        memory: conversationMemory,
        itemName: approvalItemName,
        style: conversationStyle,
      });
      console.log("[final_reply_source]", {
        source: "BOOKING_CONTINUATION_ALREADY_NOTED",
      });
      return applyHybridOutboundResult(
        {
          reply: continuationReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }

    if (
      approvalItemId &&
      approvalDurationDays != null &&
      itemContext != null &&
      typeof itemContext === "object" &&
      itemContext.isAvailable === false &&
      !approvalContinuation
    ) {
      const styleKeyApproval =
        conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
      const approvalBlockReply = await resolveStructuredUnavailableCustomerReply({
        userId,
        catalogRow: itemContext,
        availabilitySnapshot: {
          blockingStatusesSeen: Array.isArray(itemContext.blockingStatusesSeen)
            ? itemContext.blockingStatusesSeen
            : [],
        },
        normalizedCatalogForTurn,
        styleKey: styleKeyApproval,
        conversationStyle,
        traceId,
        logKind: "booking_blocked",
        memory: conversationMemory,
      });
      console.log("[group_owner_approval_blocked_hydrated_unavailable]", {
        itemId: approvalItemId,
        durationDays: approvalDurationDays,
      });
      console.log("[final_reply_source]", {
        source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
      });
      return applyHybridOutboundResult(
        {
          reply: approvalBlockReply,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }

    if (approvalItemId && approvalDurationDays != null && approvalHydratedAvailable) {
      const duplicateApproval = isDuplicateActiveBookingState(memory, {
        itemId: approvalItemId,
        durationDays: approvalDurationDays,
        sessionKey: emilySessionKey,
        channel: isGroupInbound ? "group" : "dm",
      });
      const explicitPricingApproval =
        isExplicitPricingOrDetailsQuestion(message);
      const suppressDupApproval =
        shouldSuppressDuplicateAlreadyReceivedReply(
          message,
          extracted.durationDays ?? null,
          contactParts.isValid,
          events
        );
      const willReturnAlreadyReceivedApproval =
        duplicateApproval && !suppressDupApproval;
      console.log("[duplicate_booking_guard_decision]", {
        messagePreview: String(message ?? "").trim().slice(0, 160) || null,
        itemId: approvalItemId,
        durationDays: approvalDurationDays,
        sessionKey: emilySessionKey,
        duplicate: duplicateApproval,
        duplicateReason: duplicateApproval ? "active_booking_match" : "no_match",
        currentIntent: "group_owner_approval_flow",
        priorityIntent: prioritizedIntent?.priorityIntent ?? null,
        explicitPricingOrDetailsQuestion: explicitPricingApproval,
        willReturnAlreadyReceived: willReturnAlreadyReceivedApproval,
      });
      if (willReturnAlreadyReceivedApproval) {
        return applyHybridOutboundResult(
          {
            reply: "Your booking has already been received. We’ll confirm it shortly.",
            type: "AI_MESSAGE",
            messageMeta: {
              ...messageMetaForKnowledge(hasUsefulBusinessData),
            },
          },
          routingCtx
        );
      }
      const approvalItemName =
        buildDisplayLabel(itemContext) ||
        String(itemContext?.name ?? "").trim() ||
        memoryBookingItemName ||
        undefined;
      const approvalShortBookingFields = shortBookingCreateFields(
        shortBookingSelection,
        itemContext || memForCatalogInput?.lastItem
      );
      const approvalResult = await createBookingFromValidatedIntent({
        callerTag: "group_owner_approval_flow",
        isGroupInbound,
        itemId: approvalItemId,
        itemName: approvalItemName,
        durationDays: approvalDurationDays,
        hasParticipantIdentity: Boolean(sourceParticipantKey),
        ownerApprovalFirstRequest: true,
        traceId,
        userId,
        ...bookingInboundGuard,
        createBookingArgs: {
          itemId: approvalItemId,
          itemName: approvalItemName,
          durationDays: approvalDurationDays,
          ...approvalShortBookingFields,
          source,
          groupName,
          sessionKey,
          messageId,
          participantName,
          senderScope,
          playwrightChatKey,
          dmTargetPhone: dmTargetPhone || undefined,
          dmTargetSource: dmTargetSource || undefined,
          canDmCustomer,
          approvalStage: "pending_owner_approval",
          ...bookingSourceMessageMetadata,
        },
      });

      if (!approvalResult?.ok && bookingErrorCode(approvalResult) === "ITEM_ALREADY_BOOKED") {
        console.log("[BOOKING BLOCKED - OWNER APPROVAL FIRST]", approvalItemName);
        return buildBookingBlockedResponse({
          itemName: approvalItemName,
          memory: conversationMemory,
        });
      }

      if (
        approvalResult?.ok &&
        typeof approvalResult.id === "string" &&
        approvalResult.id.trim() !== ""
      ) {
        memory.askedContact = false;
        memory.stage = "pending_owner_approval";
        bookingCreated = {
          id: approvalResult.id.trim(),
          itemId: approvalItemId,
          itemName: approvalItemName,
          durationDays: approvalDurationDays,
          ...approvalShortBookingFields,
          status: "pending_approval",
          approvalStage: "pending_owner_approval",
        };
        setStructuredBookingState(memory, {
          ...bookingCreated,
          sessionKey: emilySessionKey,
          channel: isGroupInbound ? "group" : "dm",
        });
        console.log("[approval_request_created]", {
          bookingId: bookingCreated.id,
          itemId: approvalItemId,
          durationDays: approvalDurationDays,
          hasCustomerPhone: false,
        });
        console.log("[owner_approval_requested]", {
          bookingId: bookingCreated.id,
          itemId: approvalItemId,
        });
        console.log("[group_owner_approval_booking_created_after_duration]", {
          bookingId: bookingCreated.id,
          itemId: approvalItemId,
          durationDays: approvalDurationDays,
          groupChatKey: normalizedPlaywrightChatKey || null,
          participantKey: sourceParticipantKey || null,
        });
        const bookingFinal = buildBookingFinalOutbound({
          bookingId: bookingCreated.id,
          itemId: approvalItemId,
          itemName: approvalItemName,
          durationDays: approvalDurationDays,
          ...approvalShortBookingFields,
          ownerApprovalFirstRequest: true,
          memory: conversationMemory,
        });
        if (bookingFinal?.meta?.bookingCreated === true) {
          console.log("[PIPELINE GUARD] Approval request created \u2192 skipping contact ask");
          return bookingFinal;
        }
      }

      console.warn("[approval_request_created]", {
        ok: false,
        itemId: approvalItemId,
        durationDays: approvalDurationDays,
        error: bookingErrorCode(approvalResult) || "UNKNOWN",
      });
      console.log("[final_reply_source]", { source: "FALLBACK" });
      return applyHybridOutboundResult(
        {
          reply:
            conversationStyle === "casual_local"
              ? "Request owner ko bhejne mein masla aa gaya. Please thori dair baad try kar dein."
              : "I couldn't send this request for owner approval right now. Please try again shortly.",
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
  }

  if (stage === "askContact") {
    const guardItemId =
      String(itemContext?.itemId ?? "").trim() || memoryBookingItemId || null;
    const guardIsAvailable =
      itemContext != null &&
      typeof itemContext === "object" &&
      typeof itemContext.isAvailable === "boolean"
        ? itemContext.isAvailable
        : true;
    const availabilityReason =
      guardIsAvailable === false ? "ALREADY_BOOKED" : "NO_CONFLICT";
    const allowedToAskContact =
      Boolean(guardItemId) &&
      hasDurationSignal &&
      !hasContact &&
      guardIsAvailable !== false;
    console.log("[ask_contact_guard]", {
      itemId: guardItemId,
      hasDuration: hasDurationSignal,
      hasContact,
      isAvailable: guardIsAvailable,
      availabilityReason,
      allowedToAskContact,
    });
    if (!allowedToAskContact) {
      if (guardIsAvailable === false) {
        const itemLabel =
          buildDisplayLabel(itemContext) ||
          String(itemContext?.name ?? "").trim() ||
          memoryBookingItemName;
        const styleKey =
          conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
        const ic = itemContext && typeof itemContext === "object" ? itemContext : null;
        const catalogRow =
          ic &&
          normalizeId(ic.itemId ?? ic.id)
            ? {
                ...ic,
                id: String(ic.itemId ?? ic.id ?? "").trim(),
                itemId: String(ic.itemId ?? ic.id ?? "").trim(),
                name: String(ic.name ?? "").trim() || String(itemLabel ?? "").trim(),
              }
            : null;
        if (
          /^true$/i.test(String(process.env.AVAILABILITY_PATH_MISMATCH_LOG ?? "").trim())
        ) {
          console.log("[availability_path_mismatch_detected]", {
            traceId: traceId || null,
            itemId: guardItemId,
            earlyBookingAvailable: null,
            hydratedAvailable: false,
            earlyBlockingStatusesSeen: null,
            hydratedBlockingStatusesSeen: Array.isArray(ic?.blockingStatusesSeen)
              ? ic.blockingStatusesSeen
              : [],
            earlyReason: null,
            hydratedReason: ic?.availabilityReason ?? null,
            requestedStart: null,
            requestedEnd: null,
            note: "ask_contact_guard_hydrated_unavailable_no_early_snapshot",
          });
        }
        let structuredReply = null;
        if (catalogRow) {
          try {
            structuredReply = await buildBookingDurationUnavailableStructuredCustomerReply({
              userId,
              catalogRow,
              availabilitySnapshot: {
                blockingStatusesSeen: Array.isArray(ic?.blockingStatusesSeen)
                  ? ic.blockingStatusesSeen
                  : [],
              },
              normalizedCatalogForTurn,
              styleKey,
              traceId,
              logKind: "booking_blocked",
              memory,
            });
          } catch (err) {
            console.warn("[booking_blocked_availability_context_failed]", {
              traceId: traceId || null,
              error: String(err?.message ?? err),
            });
          }
        }
        const replyText =
          String(structuredReply ?? "").trim() ||
          buildUnavailableReply({
            itemLabel,
            style: conversationStyle,
          });
        if (!String(structuredReply ?? "").trim()) {
          console.log("[booking_blocked_availability_context_missing]", {
            traceId: traceId || null,
            requestedItemId: guardItemId,
            reason: catalogRow ? "STRUCTURED_REPLY_EMPTY_OR_HELPER_NULL" : "MISSING_CATALOG_ROW",
            catalogCount: Array.isArray(normalizedCatalogForTurn)
              ? normalizedCatalogForTurn.length
              : 0,
            summaryStatus: null,
          });
        }
        console.log("[final_reply_source]", {
          source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
        });
        return applyHybridOutboundResult(
          {
            reply: replyText,
            type: "AI_MESSAGE",
            messageMeta: {
              ...messageMetaForKnowledge(hasUsefulBusinessData),
              bookingBlocked: true,
              reason: availabilityReason,
            },
          },
          routingCtx,
          aiRouteModeFromModel
        );
      }
      stage = null;
    }
  }

  if (
    !skipItemResolutionForGreeting &&
    (isAvailabilityQuestion || hasDurationSignal || events.transactionalIntent)
  ) {
    const reconciledLate = await reconcileItemContextWithExplicitMessage({
      message,
      itemContext,
      catalogItems: normalizedCatalogForTurn,
      resolveCatalog: resolveCatalogThisTurn,
      hydrateFn: hydrateItemWithAvailability,
    });
    if (reconciledLate) {
      itemContext = reconciledLate;
      syncLastItemFromItemContextIfMissing(conversationMemory, itemContext);
    }
  }

  if (
    itemContext != null &&
    typeof itemContext === "object" &&
    itemContext.isAvailable === false &&
    (isAvailabilityQuestion || hasDurationSignal || events.transactionalIntent)
  ) {
    const lateContinuation = isSameSessionBookingContinuation({
      memory: conversationMemory,
      emilySessionKey,
      itemId: itemContext?.itemId ?? memoryBookingItemId,
      message,
      extractedDurationDays: extracted.durationDays ?? bookingDurationDays ?? null,
      contactValid: contactParts.isValid,
      events,
    });
    if (lateContinuation) {
      const itemLabel =
        buildDisplayLabel(itemContext) ||
        String(itemContext?.name ?? "").trim() ||
        memoryBookingItemName;
      const reply = buildSameSessionBookingContinuationReply({
        memory: conversationMemory,
        itemName: itemLabel,
        style: conversationStyle,
      });
      console.log("[final_reply_source]", {
        source: "BOOKING_CONTINUATION_ALREADY_NOTED",
      });
      return applyHybridOutboundResult(
        {
          reply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext?.name ?? "").trim() ||
      memoryBookingItemName;
    if (isAvailabilityQuestion) {
      const timingShape =
        messageLooksLikeGenericAvailabilityTimingFollowup(message) ||
        intentReasonSuggestsAvailabilityTimeframe(prioritizedIntent?.reason) ||
        intentReasonSuggestsAvailabilityTimeframe(llmIntentClassification?.reason);
      if (timingShape) {
        const explicitHit = hasExplicitNewItemMention(message, normalizedCatalogForTurn, null);
        const explicitLabel =
          (explicitHit.found && explicitHit.itemLabel) ||
          String(labelFromMatchedItem(emilyTurn?.match?.matchedItem) ?? "").trim() ||
          "";
        const globalNoOptions = computeAvailabilityTimingGlobalNoOptions({
          memory,
          explicitItemLabel: explicitLabel,
          conversationHistory,
          userId,
          sessionKey: emilySessionKey,
        });
        const timingReply = buildAvailabilityTimingUnknownReply({
          style: conversationStyle,
          explicitItemLabel: explicitLabel || null,
          globalNoOptions,
        });
        console.log("[availability_timing_followup_routed]", {
          rawTextPreview: String(message ?? "").trim().slice(0, 160) || null,
          classifierReason: String(llmIntentClassification?.reason ?? "").slice(0, 200) || null,
          askedField: prioritizedIntent?.askedField ?? null,
          selectedItemSource: safeItemSource,
          hasExplicitCatalogItem: Boolean(
            String(labelFromMatchedItem(emilyTurn?.match?.matchedItem) ?? "").trim() ||
              explicitHit.found
          ),
          replyType: explicitLabel ? "EXPLICIT_ITEM_TIMING_UNKNOWN" : "GENERIC_TIMING_UNKNOWN",
          source: "unavailable_item_availability_question",
        });
        console.log("[final_reply_source]", { source: "AVAILABILITY_TIMING_UNKNOWN" });
        logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
          source: "AVAILABILITY_TIMING_UNKNOWN",
        });
        return applyHybridOutboundResult(
          {
            reply: timingReply,
            type: "AI_MESSAGE",
            messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
          },
          routingCtx,
          aiRouteModeFromModel
        );
      }
      const styleKeyAvailQ =
        conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
      const availQReply = await resolveStructuredUnavailableCustomerReply({
        userId,
        catalogRow: itemContext,
        availabilitySnapshot: {
          blockingStatusesSeen: Array.isArray(itemContext.blockingStatusesSeen)
            ? itemContext.blockingStatusesSeen
            : [],
        },
        normalizedCatalogForTurn,
        styleKey: styleKeyAvailQ,
        conversationStyle,
        traceId,
        logKind: "booking_blocked",
        memory,
      });
      console.log("[final_reply_source]", {
        source: "AVAILABILITY_BLOCKED_EARLY",
      });
      logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
        source: "AVAILABILITY_BLOCKED_EARLY",
      });
      return applyHybridOutboundResult(
        {
          reply: availQReply,
          type: "AI_MESSAGE",
          messageMeta: {
            ...messageMetaForKnowledge(hasUsefulBusinessData),
            bookingBlocked: true,
            reason: "ALREADY_BOOKED",
          },
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
    const styleKey =
      conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
    const ic = itemContext;
    const catalogRow =
      ic && normalizeId(ic.itemId ?? ic.id)
        ? {
            ...ic,
            id: String(ic.itemId ?? ic.id ?? "").trim(),
            itemId: String(ic.itemId ?? ic.id ?? "").trim(),
            name: String(ic.name ?? "").trim() || String(itemLabel ?? "").trim(),
          }
        : null;
    let structuredReply = null;
    if (catalogRow) {
      try {
        structuredReply = await buildBookingDurationUnavailableStructuredCustomerReply({
          userId,
          catalogRow,
          availabilitySnapshot: {
            blockingStatusesSeen: Array.isArray(ic?.blockingStatusesSeen)
              ? ic.blockingStatusesSeen
              : [],
          },
          normalizedCatalogForTurn,
          styleKey,
          traceId,
          logKind: "booking_blocked",
          memory,
        });
      } catch (err) {
        console.warn("[booking_blocked_availability_context_failed]", {
          traceId: traceId || null,
          error: String(err?.message ?? err),
        });
      }
    }
    const replyText =
      String(structuredReply ?? "").trim() ||
      buildUnavailableReply({
        itemLabel,
        style: conversationStyle,
      });
    if (!String(structuredReply ?? "").trim()) {
      console.log("[booking_blocked_availability_context_missing]", {
        traceId: traceId || null,
        requestedItemId: String(ic?.itemId ?? ic?.id ?? "").trim() || null,
        reason: catalogRow ? "STRUCTURED_REPLY_EMPTY_OR_HELPER_NULL" : "MISSING_CATALOG_ROW",
        catalogCount: Array.isArray(normalizedCatalogForTurn)
          ? normalizedCatalogForTurn.length
          : 0,
        summaryStatus: null,
      });
    }
    console.log("[final_reply_source]", {
      source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
    });
    logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
      source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
    });
    return applyHybridOutboundResult(
      {
        reply: replyText,
        type: "AI_MESSAGE",
        messageMeta: {
          ...messageMetaForKnowledge(hasUsefulBusinessData),
          bookingBlocked: true,
          reason: "ALREADY_BOOKED",
        },
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }

  if (stage === "availability") {
    const phraseElig = computeAskDurationPhraseEligibility({
      stage,
      itemContext,
      safeItemSource,
      message,
      normalizedCatalogForTurn,
      emilyTurn,
      priorityIntentSnapshot: prioritizedIntent,
      llmIntentClassification,
    });
    if (!phraseElig.eligible) {
      const explicitHit = hasExplicitNewItemMention(
        message,
        normalizedCatalogForTurn,
        null
      );
      const explicitLabel =
        (explicitHit.found && explicitHit.itemLabel) ||
        String(labelFromMatchedItem(emilyTurn?.match?.matchedItem) ?? "").trim() ||
        "";
      console.log("[availability_phrase_engine_blocked_unverified]", {
        rawTextPreview: String(message ?? "").trim().slice(0, 160) || null,
        selectedItemId: normalizeId(safeItem?.itemId ?? safeItem?.id) || null,
        selectedItemSource: safeItemSource,
        hasItemContext: Boolean(itemContext && typeof itemContext === "object"),
        itemContextAvailable:
          itemContext && typeof itemContext === "object"
            ? itemContext.isAvailable === true
            : null,
        reason: phraseElig.reason,
      });
      const timingReply = buildAvailabilityTimingUnknownReply({
        style: conversationStyle,
        explicitItemLabel: explicitLabel || null,
        globalNoOptions: computeAvailabilityTimingGlobalNoOptions({
          memory,
          explicitItemLabel: explicitLabel,
          conversationHistory,
          userId,
          sessionKey: emilySessionKey,
        }),
      });
      console.log("[availability_timing_followup_routed]", {
        rawTextPreview: String(message ?? "").trim().slice(0, 160) || null,
        classifierReason: String(llmIntentClassification?.reason ?? "").slice(0, 200) || null,
        askedField: prioritizedIntent?.askedField ?? null,
        selectedItemSource: safeItemSource,
        hasExplicitCatalogItem: Boolean(
          String(labelFromMatchedItem(emilyTurn?.match?.matchedItem) ?? "").trim() ||
            explicitHit.found
        ),
        replyType: explicitLabel ? "EXPLICIT_ITEM_TIMING_UNKNOWN" : "GENERIC_TIMING_UNKNOWN",
      });
      console.log("[final_reply_source]", { source: "AVAILABILITY_TIMING_UNKNOWN" });
      logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
        source: "AVAILABILITY_TIMING_UNKNOWN",
      });
      return applyHybridOutboundResult(
        {
          reply: timingReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
  }

  if (stage && !bookingCreated) {
    console.log("[transactional_route_used]", {
      routeType: conversationRoute.routeType,
      stage,
    });
    phraseReply = buildPhraseReply({
      stage,
      item: safeItem,
      duration: safeDuration,
      businessConfig,
      style: conversationStyle,
    });

    if (phraseReply) {
      console.log("[PHRASE ENGINE]", {
        stage,
        hasItem,
        hasDuration: hasDurationSignal,
        hasContact,
        duration: safeDuration,
      });
      console.log("[final_reply_source]", {
        source:
          stage === "askContact"
            ? "ASK_CONTACT"
            : "AVAILABILITY_AVAILABLE_ASK_DURATION",
      });
      logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
        source:
          stage === "askContact"
            ? "ASK_CONTACT"
            : "AVAILABILITY_AVAILABLE_ASK_DURATION",
      });
      if (stage === "askContact") {
        memory.askedContact = true;
      }

      return applyHybridOutboundResult(
        {
          reply: phraseReply,
          text: phraseReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
        },
        routingCtx,
        aiRouteModeFromModel
      );
    }
  }

  if (isDelayedCommitment || blockAiForBooking) {
    if (bookingCreated) {
      aiReply = "Your booking request has been created and shared for approval.";
    } else if (
      events.transactionalIntent &&
      (hasItem || memoryBookingItemId || matchedItemForReply) &&
      !hasDurationSignal
    ) {
      aiReply = "Sure, for how many days would you like to book it?";
    } else if (
      events.transactionalIntent &&
      (memoryBookingItemId || matchedItemForReply) &&
      (hasDurationSignal || memoryDurationValue != null) &&
      !hasContact
    ) {
      aiReply = isGroupInbound
        ? groupSafeRequestReceivedReply({
            itemAndDurationKnown: Boolean(memoryBookingItemName && bookingDurationDays),
            itemName: memoryBookingItemName,
            durationDays: bookingDurationDays,
          })
        : "Great, please share your contact number so I can complete the booking request.";
    } else {
      aiReply = "";
    }
    logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
      source: blockAiForBooking ? "BOOKING_FLOW_NO_AI" : "DELAYED_COMMITMENT",
    });
  } else {
    const durationFromExtraction = Number.isFinite(durationDays);
    const durationFromMemory =
      memory?.lastDuration != null &&
      memory.lastDuration !== "" &&
      Number.isFinite(Number(memory.lastDuration));
    const hasDurationForContext = durationFromExtraction || durationFromMemory;
    const contactCaptured = hasContact;
    const missingFields = [];

    if (!hasDurationForContext) {
      missingFields.push("duration");
    }

    if (!contactCaptured) {
      missingFields.push("contact");
    }

    const missingString =
      missingFields.length > 0 ? missingFields.join(", ") : "none";
    const missingContext = missingString;
    const contextLabel = resolveEmilyContextLabel();
    const memDur = conversationMemory?.durationPreference;
    const durationForEnriched =
      memDur != null &&
      typeof memDur === "object" &&
      typeof memDur.value === "number" &&
      memDur.unit != null
        ? `${memDur.value} ${memDur.unit}`
        : typeof memDur === "string" && String(memDur).trim() !== ""
          ? String(memDur).trim()
          : nextChatContext.lastDuration != null
            ? String(nextChatContext.lastDuration)
            : "unknown";
    const historyForTail =
      String(history ?? "").trim() ||
      getRecentChatHistoryForPrompt(userId, 10, emilySessionKey).trim();
    const { payload: aiInput, tailEmbedded } = buildStructuredAiUserPayload({
      historyText: historyForTail,
      currentMessage: message,
      lastItemMentioned: conversationMemory?.lastItemMentioned,
      contextLabel,
      lastFocusedItemStr: String(nextChatContext.lastFocusedItem ?? "").trim(),
      durationForEnriched,
      detectedIntent,
      missingContext,
    });
    console.log("🧠 Intent:", detectedIntent);
    console.log("🧠 Context:", nextChatContext);
    console.log("🧠 AI Context Input:", aiInput);
    const out = await timeAsync(
      "AI/phrase decision",
      () =>
        generateReply({
          message: aiInput,
          contextMessages,
          intent,
          emilyIntent: resolvedEmilyIntent,
          history: tailEmbedded ? "" : history,
          knowledge: mergedKnowledge,
          hasKnowledge: hasKnowledgeForModel,
          contextData,
          businessName,
          businessType,
          businessProfile: businessContext,
          catalogItems: normalizedCatalogForTurn,
          selectedItem: selectedItemForAi,
          conversationMemory: conversationMemory,
          conversationMemorySummary: emilyTurn.memorySummary,
          matchedItem: matchedItemForReply,
          matchedService: emilyTurn.match.matchedService,
          matchedCatalogLine,
          proactivePricingHint: emilyTurn.pricingHint,
          conversationStage: conversationMemory.stage,
          userLanguageStyle: emilyTurn.userLanguageStyle,
          tone,
          fragmentCount: fc,
          hasMultipleFragments: Boolean(hasMultipleFragments) || fc > 1,
          isGreetingFirst: Boolean(isGreetingFirst),
          lastFocusedItem: nextChatContext.lastFocusedItem ?? null,
          lastDuration: nextChatContext.lastDuration ?? null,
          detectedIntent,
        }),
      { source: "AI_GENERAL" }
    );
    aiReply = out.reply ?? "";
    aiRawReply = out.raw ?? out.reply ?? "";
    aiRouteModeFromModel =
      out.mode === "GROUP" || out.mode === "DM" ? out.mode : undefined;
  }

  const assistantFromHistory = extractRecentAssistantTextsFromPromptBlock(
    conversationHistory,
    6
  );
  const recentAssistantReplies = mergeAssistantReplyListsForNorm(
    assistantFromHistory,
    getRecentAssistantReplies(userId, 3, sessionKey),
    8
  );

  let finalReply = normalizeEmilyResponse(aiReply, {
    matchedItem: matchedItemForReply,
    matchedService: emilyTurn.match.matchedService,
    intent: resolvedEmilyIntent,
    memory: conversationMemory,
    memoryDelta: emilyTurn.memoryDelta,
    userMessage: message,
    pricingHint: emilyTurn.pricingHint,
    userLanguageStyle: emilyTurn.userLanguageStyle,
    recentAssistantReplies,
    sessionKey: emilySessionKey,
  });

  if (replyChannel === "whatsapp" && finalReply != null) {
    const polished = polishWhatsAppBusinessTone(String(finalReply));
    finalReply = polished !== "" ? polished : finalReply;
    finalReply = dedupeAgainstPriorAssistantReplies(
      String(finalReply),
      extractRecentAssistantTextsFromPromptBlock(conversationHistory, 6)
    );
  }
  const msg = String(message ?? "").toLowerCase();
  const isAvailabilityQuery =
    intent === "availability" ||
    /\b(avail|available|availability)\b/.test(msg);
  const hasAvailabilityField = resolvedItem?.availability !== undefined;
  const isAvailable = hasAvailabilityField
    ? resolvedItem.availability === true
    : true;
  if (
    itemContext != null &&
    typeof itemContext === "object" &&
    typeof itemContext.isAvailable !== "boolean" &&
    String(itemContext.itemId ?? "").trim() === ""
  ) {
    itemContext.isAvailable = isAvailable;
  }
  const runtimeAvailability =
    itemContext != null && typeof itemContext.isAvailable === "boolean"
      ? itemContext.isAvailable
      : resolvedItem != null &&
          typeof resolvedItem === "object" &&
          !Array.isArray(resolvedItem) &&
          typeof resolvedItem.isAvailable === "boolean"
        ? resolvedItem.isAvailable
        : null;
  const effectiveAvailability =
    runtimeAvailability === false ? false : true;
  const hasStructuredItemForAvailability =
    (resolvedItem != null && typeof resolvedItem === "object") ||
    (itemContext != null &&
      typeof itemContext === "object" &&
      String(itemContext.itemId ?? "").trim() !== "");

  console.log("📦 Availability Check:", {
    item:
      resolvedItem != null
        ? labelFromMatchedItem(resolvedItem) ||
          (typeof resolvedItem.name === "string" ? resolvedItem.name : null)
        : null,
    availability: effectiveAvailability === false ? "unavailable" : "available",
    effectiveAvailability,
  });
  if (
    isAvailabilityQuery &&
    itemContext?.isAvailable === false &&
    hasStructuredItemForAvailability
  ) {
    console.warn("⚠️ Item unavailable — overriding AI response");
    const styleKeyPostAi =
      conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
    finalReply = await resolveStructuredUnavailableCustomerReply({
      userId,
      catalogRow: itemContext,
      availabilitySnapshot: {
        blockingStatusesSeen: Array.isArray(itemContext.blockingStatusesSeen)
          ? itemContext.blockingStatusesSeen
          : [],
      },
      normalizedCatalogForTurn,
      styleKey: styleKeyPostAi,
      conversationStyle,
      traceId,
      logKind: "booking_blocked",
      memory: conversationMemory,
    });
    console.log("[final_reply_source]", {
      source: "AVAILABILITY_BLOCKED_EARLY",
    });
  }

  const memoryDurationRaw = conversationMemory?.durationPreference;
  const memoryDurationDays =
    memoryDurationRaw != null && typeof memoryDurationRaw === "object"
      ? getNormalizedDaysFromDurationPreference(memoryDurationRaw)
      : typeof memoryDurationRaw === "string"
        ? extractDurationFromMessage(memoryDurationRaw)
        : null;
  // Persist booking intent only when explicitly expressed by the user.
  if (isCommitMessage(message)) {
    conversationMemory.hasBookingIntent = true;
  }
  const hasIntent = conversationMemory?.hasBookingIntent === true;
  const hasRequiredData = memoryDurationDays != null && hasContact;
  const isStrongCommit =
    hasIntent &&
    hasRequiredData &&
    conversationMemory?.stage !== "CONFIRMED";

  if (
    !bookingCreated &&
    conversationMemory?.stage !== "CONFIRMED" &&
    isStrongCommit &&
    hasRequiredData
  ) {
    /** @type {{ ok: boolean, reason: string }} */
    let preCommitResolution = { ok: false, reason: "already_has_item" };
    if (!normalizeId(conversationMemory?.lastResolvedItemId)) {
      preCommitResolution = await tryResolveLastItemFromMentionedPreCommit(
        userId,
        conversationMemory,
        (uid, mention, _memOpts) =>
          resolveCatalogThisTurn(mention, conversationMemory),
        null
      );
    }
    if (
      !normalizeId(conversationMemory?.lastResolvedItemId) &&
      normalizeId(conversationMemory?.lastItem?.id)
    ) {
      setLastResolvedItemId(conversationMemory, conversationMemory.lastItem.id);
    }
    console.log("🧪 Pre-commit resolution:", preCommitResolution);
    console.log("🧠 PRE-COMMIT CHECK:", {
      hasItemId: !!normalizeId(conversationMemory?.lastResolvedItemId),
      itemId: conversationMemory?.lastResolvedItemId ?? null,
    });
    console.log("🧠 MEMORY BEFORE COMMIT:", conversationMemory);
    if (!normalizeId(conversationMemory?.lastResolvedItemId)) {
      console.error("❌ BLOCKED: Commit without item ID", {
        memory: conversationMemory,
      });
      finalReply =
        "Sorry, we don't have that available right now.";
    } else {
      const commitItemId = normalizeId(conversationMemory?.lastResolvedItemId);
      if (!commitItemId) {
        throw new Error("Invariant violation: commit without itemId");
      }
      // Mark state BEFORE async calls (idempotency guard) — only when ID is present
      conversationMemory.stage = "CONFIRMED";
      console.log("🔎 Commit lookup using:", {
        id: commitItemId,
      });
      let commitRow = null;

      // 1) Try ID (preferred, Firestore doc id)
      commitRow = await findItemById(
        userId,
        commitItemId
      );

      if (!commitRow) {
        console.error("❌ CRITICAL: Commit detected but item not found", {
          itemId: commitItemId,
          userId,
        });
        finalReply =
          "Sorry, I couldn't confirm this option. Let me check and get back to you.";
      } else {
        const duplicateCommit = isDuplicateActiveBookingState(conversationMemory, {
          itemId: commitRow.id,
          durationDays: memoryDurationDays,
          sessionKey: emilySessionKey,
          channel: isGroupInbound ? "group" : "dm",
        });
        const explicitPricingCommit =
          isExplicitPricingOrDetailsQuestion(message);
        const suppressDupCommit = shouldSuppressDuplicateAlreadyReceivedReply(
          message,
          extracted.durationDays ?? null,
          contactParts.isValid,
          events
        );
        const willReturnAlreadyReceivedCommit =
          duplicateCommit && !suppressDupCommit;
        console.log("[duplicate_booking_guard_decision]", {
          messagePreview: String(message ?? "").trim().slice(0, 160) || null,
          itemId: commitRow.id,
          durationDays: memoryDurationDays,
          sessionKey: emilySessionKey,
          duplicate: duplicateCommit,
          duplicateReason: duplicateCommit ? "active_booking_match" : "no_match",
          currentIntent: "pre_commit_strong",
          priorityIntent: prioritizedIntent?.priorityIntent ?? null,
          explicitPricingOrDetailsQuestion: explicitPricingCommit,
          willReturnAlreadyReceived: willReturnAlreadyReceivedCommit,
        });
        if (willReturnAlreadyReceivedCommit) {
          return applyHybridOutboundResult(
            {
              reply: "Your booking has already been received. We’ll confirm it shortly.",
              type: "AI_MESSAGE",
              messageMeta: {
                ...messageMetaForKnowledge(hasUsefulBusinessData),
              },
            },
            routingCtx
          );
        }
        const commitBookings = await getBookingsForItem(
          userId,
          commitRow.id,
          commitRow.name
        );
        const availabilityItemId = String(commitRow?.id ?? "").trim();
        if (!availabilityItemId) {
          console.warn("[AVAILABILITY FALLBACK] Missing itemId", {
            resolvedItem: commitRow ?? null,
          });
        }
        const commitAv = availabilityItemId
          ? computeAvailabilityFromBookings(commitBookings, availabilityItemId)
          : { isAvailable: true };
        logBookingEvent({
          traceId,
          step: "availability_check",
          status: commitAv.isAvailable ? "success" : "fail",
          data: {
            itemId: String(commitRow.id),
            isAvailable: commitAv.isAvailable,
            reason: commitAv.isAvailable ? "NO_CONFLICT" : "ALREADY_BOOKED",
            path: "commit",
            ...(commitAv.nextAvailableAt != null && {
              nextAvailableAt: new Date(commitAv.nextAvailableAt).toISOString(),
            }),
          },
        });
        const styleKeyCommit =
          conversationStyle === "casual_local" ? "casual_local" : "neutral_english";
        const commitHydrationBlock = await blockCustomerBookingIfHydratedUnavailable({
          userId,
          catalogRow: commitRow,
          earlyAvailabilitySnapshot: commitAv,
          normalizedCatalogForTurn,
          styleKey: styleKeyCommit,
          conversationStyle,
          traceId,
          logKind: "booking_blocked",
          memory: conversationMemory,
          hydrationSource: "commit_trigger_booking",
        });
        if (commitHydrationBlock.blocked) {
          finalReply = commitHydrationBlock.reply;
          console.log("[final_reply_source]", {
            source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
          });
          return applyHybridOutboundResult(
            {
              reply: finalReply,
              type: "AI_MESSAGE",
              messageMeta: {
                ...messageMetaForKnowledge(hasUsefulBusinessData),
                bookingBlocked: true,
                reason: "ALREADY_BOOKED",
              },
            },
            routingCtx
          );
        }
        const commitBooking = await createBookingFromValidatedIntent({
          callerTag: "commit_trigger_booking",
          isGroupInbound,
          itemId: commitRow.id,
          itemName: commitRow.name,
          durationDays: memoryDurationDays,
          hasParticipantIdentity: Boolean(sourceParticipantKey),
          ownerApprovalFirstRequest: false,
          traceId,
          userId,
          ...bookingInboundGuard,
          createBookingArgs: {
            itemId: commitRow.id,
            itemName: commitRow.name,
            durationDays: memoryDurationDays,
            ...shortBookingCreateFields(shortBookingSelection, commitRow),
            customerName: String(conversationMemory?.customerName ?? "").trim() || undefined,
            customerPhone: String(conversationMemory?.contact ?? "").trim() || undefined,
            source,
            groupName,
            sessionKey,
            messageId,
            participantName,
            senderScope,
            playwrightChatKey,
            dmTargetPhone: dmTargetPhone || undefined,
            dmTargetSource: dmTargetSource || undefined,
            canDmCustomer,
            ...bookingSourceMessageMetadata,
          },
        });
        if (!commitBooking?.ok && bookingErrorCode(commitBooking) === "ITEM_ALREADY_BOOKED") {
          console.log("[BOOKING RETRY BLOCKED]");
          return buildBookingBlockedOutbound(conversationMemory);
        }
        if (commitBooking?.ok && typeof commitBooking.id === "string" && commitBooking.id.trim()) {
          bookingCreated = {
            id: commitBooking.id.trim(),
            itemId: commitRow.id,
            itemName: commitRow.name,
            durationDays: memoryDurationDays,
            status: "pending_approval",
          };
          setStructuredBookingState(conversationMemory, {
            ...bookingCreated,
            sessionKey: emilySessionKey,
            channel: isGroupInbound ? "group" : "dm",
          });

          console.log("📦 Booking created via commit trigger:", {
            bookingId: bookingCreated.id,
            item: commitRow.name,
            durationDays: memoryDurationDays,
          });
          const bookingFinal = buildBookingFinalOutbound({
            bookingId: bookingCreated.id,
            itemId: commitRow.id,
            itemName: commitRow.name,
            durationDays: memoryDurationDays,
          });
          if (bookingFinal?.meta?.bookingCreated === true) {
            conversationMemory.askedContact = false;
            console.log("[PIPELINE GUARD] Booking completed \u2192 skipping AI + fallback");
            return bookingFinal;
          }
        } else {
          console.warn("⚠️ Booking creation failed:", commitBooking);
        }
      }
    }
  }
  const replyItemId = normalizeId(conversationMemory?.lastResolvedItemId);
  const soundsLikeAvailabilityOrConfirmation =
    /\b(let me check availability|check availability|booking (?:is|has been )?(?:received|confirmed)|i(?:'| a)m (?:booking|booked)|confirmed|booked)\b/i.test(
      String(finalReply ?? "")
    );
  if (!replyItemId && soundsLikeAvailabilityOrConfirmation) {
    finalReply = "Sorry, we don't have that available right now.";
  }
  if (
    !bookingCreated &&
    /\b(received|confirmed|booked|booking (?:is|has been) (?:received|confirmed)|i(?:'| a)m (?:booking|booked))/i.test(
      String(finalReply ?? "")
    )
  ) {
    finalReply =
      "I have your request details. Let me verify the booking and confirm shortly.";
  }
  if (bookingCreated) {
    const bookingFinal = buildBookingFinalOutbound({
      bookingId: bookingCreated.id,
      itemId: bookingCreated.itemId,
      itemName: bookingCreated.itemName,
      durationDays: bookingCreated.durationDays,
      durationHours: bookingCreated.durationHours,
      billingUnit: bookingCreated.billingUnit,
      billingRatePercentOfDaily: bookingCreated.billingRatePercentOfDaily,
      calculatedPrice: bookingCreated.calculatedPrice,
      currency: bookingCreated.currency,
    });
    if (bookingFinal?.meta?.bookingCreated === true) {
      conversationMemory.askedContact = false;
      console.log("[PIPELINE GUARD] Booking completed \u2192 skipping AI + fallback");
      return bookingFinal;
    }
  }

  const aiReplyImageUrls = Array.from(
    new Set([
      ...extractImageUrlsFromAiReply(aiReply),
      ...extractImageUrlsFromAiReply(aiRawReply),
    ])
  ).slice(0, 5);

  const fallbackCatalogImagesForAiImageIntent =
    aiReplyImageUrls.length === 0 &&
    hasUsefulBusinessData &&
    resolvedItem &&
    (wantsImages || detectShowImagesRequest(aiReply))
      ? collectCatalogItemImageUrls({
          items: normalizedCatalogForTurn,
          matchedItem: resolvedItem,
        })
      : [];

  const resolvedAiImageUrls =
    aiReplyImageUrls.length > 0
      ? aiReplyImageUrls
      : fallbackCatalogImagesForAiImageIntent;
  const hasAiReplyImages = resolvedAiImageUrls.length > 0;
  if (hasAiReplyImages) {
    console.log("[messageProcessor] resolved image URLs for outbound:", {
      count: resolvedAiImageUrls.length,
      source:
        aiReplyImageUrls.length > 0 ? "ai_reply_urls" : "catalog_image_fallback",
    });
  }

  if (!finalReply || !String(finalReply).trim()) {
    console.warn("[FALLBACK FIX] No response generated \u2192 sending safe fallback");
    console.log("[final_reply_source]", { source: "FALLBACK" });
    return applyHybridOutboundResult(
      {
        reply: bookingCreated
          ? "Your booking has been received. We’ll confirm it shortly."
          : "Could you please clarify what you're looking for?",
        text: bookingCreated
          ? "Your booking has been received. We’ll confirm it shortly."
          : "Could you please clarify what you're looking for?",
        type: "AI_MESSAGE",
        meta: bookingCreated ? { fallback: true, bookingCreated: true } : { fallback: true },
        messageMeta: {
          ...messageMetaForKnowledge(hasUsefulBusinessData),
          ...(bookingCreated ? { bookingCreated } : {}),
        },
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }

  const baseFinal = {
    reply: finalReply,
    type: "AI_MESSAGE",
    messageMeta: {
      ...messageMetaForKnowledge(hasUsefulBusinessData),
      ...(bookingCreated ? { bookingCreated } : {}),
      ...(hasAiReplyImages
        ? {
            deliveryIntent: "show_images",
            whatsappImageUrls: resolvedAiImageUrls,
          }
        : {}),
    },
  };
  const outFinal = applyHybridOutboundResult(
    baseFinal,
    routingCtx,
    aiRouteModeFromModel
  );
  if (!outFinal || !String(outFinal.reply ?? "").trim()) {
    console.warn("[FALLBACK FIX] No response generated \u2192 sending safe fallback");
    console.log("[final_reply_source]", { source: "FALLBACK" });
    return applyHybridOutboundResult(
      {
        reply: bookingCreated
          ? "Your booking has been received. We’ll confirm it shortly."
          : "Could you please clarify what you're looking for?",
        text: bookingCreated
          ? "Your booking has been received. We’ll confirm it shortly."
          : "Could you please clarify what you're looking for?",
        type: "AI_MESSAGE",
        meta: bookingCreated ? { fallback: true, bookingCreated: true } : { fallback: true },
        messageMeta: {
          ...messageMetaForKnowledge(hasUsefulBusinessData),
          ...(bookingCreated ? { bookingCreated } : {}),
        },
      },
      routingCtx,
      aiRouteModeFromModel
    );
  }
  if (
    outFinal.sendVia !== "NONE" &&
    outFinal.reply != null &&
    String(outFinal.reply).trim() !== ""
  ) {
    console.log("[final_reply_source]", { source: "AI_GENERAL" });
    emit("FLOW_END", {
      sendVia: outFinal.sendVia,
      replyChars: String(outFinal.reply ?? "").length,
      reason: "SUCCESS",
    });
    appendConversationTurn(
      userId,
      message,
      String(outFinal.reply),
      sessionKey
    );
  }

  return outFinal;
  } catch (err) {
    const rawPreview = String(inboundRaw ?? "").trim().slice(0, 220) || null;
    const selectedAi = selectLatestInboundForAi(inboundRaw);
    const latestSeg =
      selectedAi != null && String(selectedAi).trim() !== ""
        ? getLatestUserSegmentForGuard(selectedAi)
        : getLatestUserSegmentForGuard(String(inboundRaw ?? ""));
    const stackSnippet = String(err?.stack ?? "")
      .split("\n")
      .slice(0, 5)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" | ");
    console.error("❌ processMessage crash:", err);
    console.error("[process_message_crash_caught]", {
      traceId,
      rawMessagePreview: rawPreview,
      latestUserSegment: latestSeg || null,
      routeType: routeTypeForProcessMessageLog,
      participantKey: String(participantKey ?? "").trim() || null,
      sessionKey: String(sessionKey ?? "").trim() || null,
      errName: err?.name ?? null,
      errMessage: String(err?.message ?? err ?? "").slice(0, 500) || null,
      stackSnippet: stackSnippet || null,
    });
    return applyHybridOutboundResult(
      {
        reply: "Sorry, I didn’t catch that properly. Could you please try again?",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(false),
      },
      {
        isGroupInbound: Boolean(isGroupInbound),
        message: String(inboundRaw ?? "").trim(),
        participantPhoneForDm,
        playwrightWebInbound: Boolean(playwrightWebInbound),
      }
    );
  }
}

// Test-only export: allows unit tests to validate intent gating without calling LLMs.
export function __isInformationalPriorityIntentForTests(priorityIntent) {
  const p = String(priorityIntent ?? "").trim().toLowerCase();
  return p === "price" || p === "pricing" || p === "details" || p === "information";
}

export function __isBookingContinuationShapedForTests(
  message,
  extractedDurationDays,
  contactValidCurrent,
  events
) {
  return isBookingContinuationShapedCurrentTurn(
    message,
    extractedDurationDays,
    contactValidCurrent,
    events
  );
}

export function __shouldSuppressDuplicateAlreadyReceivedForTests(
  message,
  extractedDurationDays,
  contactValid,
  events
) {
  return shouldSuppressDuplicateAlreadyReceivedReply(
    message,
    extractedDurationDays,
    contactValid,
    events
  );
}

export function __buildGroupWaitingEngagementForTests({
  message,
  itemName = "Civic",
  conversationStyle = "casual_local",
} = {}) {
  void message;
  void itemName;
  void conversationStyle;
  return groupSafeRequestReceivedReply({ itemAndDurationKnown: true });
}

export function __formatCustomerDurationForTests(args = {}) {
  return formatCustomerDuration(args);
}

export function __groupSafeRequestReceivedReplyForTests(args = {}) {
  return groupSafeRequestReceivedReply(args);
}

export function __groupPrivatePromptGuardForTests(reply, meta = {}) {
  const blocked = isPrivateDetailPromptText(reply);
  return {
    blocked,
    ...groupPrivateDetailBlockDiagnostics(reply),
    reply: blocked
      ? groupSafeRequestReceivedReply({
          itemAndDurationKnown: Boolean(meta.bookingCreated || meta.durationDays || meta.durationHours),
        })
      : String(reply ?? ""),
  };
}

export function __applyHybridOutboundResultForTests(result = {}, routingCtx = {}, aiStructuredMode) {
  return applyHybridOutboundResult(result, routingCtx, aiStructuredMode);
}

export function __numericDailyRateFromItemForTests(item = {}) {
  return numericDailyRateFromItem(item);
}

export function __classifyBelowMinimumTurnKindForTests(message, turnIntentShape = null) {
  return classifyBelowMinimumTurnKind(message, turnIntentShape);
}

export function __planBelowMinimumHoursTurnForTests(args = {}) {
  return planBelowMinimumHoursTurn(args);
}

export function __shortBookingPolicyForTests(
  message,
  item = {},
  businessProfile = null,
  options = {}
) {
  const parsed = parseUserDuration(message);
  const selection = shortBookingSelectionFromParsedDuration(parsed, businessProfile);
  if (!selection) return { parsed, selection: null, reply: null };
  if (selection.type === "below_minimum") {
    const turnIntentShape =
      options.turnIntentShape ??
      resolveTurnIntentShape({
        message,
        itemMentioned: true,
        hasDuration: true,
      });
    return {
      parsed,
      selection,
      ...planBelowMinimumHoursTurn({
        message,
        selection,
        item,
        turnIntentShape,
        isGroupInbound: options.isGroupInbound ?? false,
        isAvailable: options.isAvailable ?? true,
        itemLabel:
          options.itemLabel ??
          (buildDisplayLabel(item) || String(item?.name ?? "").trim()),
        alternativeItems: options.alternativeItems ?? [],
        modeOverride: options.mode ?? null,
      }),
    };
  }
  return {
    parsed,
    selection,
    createFields: shortBookingCreateFields(selection, item),
  };
}

export function __shortBookingPolicyForParsedDurationForTests(
  parsed,
  item = {},
  businessProfile = null,
  options = {}
) {
  const selection = shortBookingSelectionFromParsedDuration(parsed, businessProfile);
  if (!selection) return { parsed, selection: null, reply: null };
  if (selection.type === "below_minimum") {
    const message = options.message ?? `${parsed?.value ?? ""} ${parsed?.unit ?? "hours"}`;
    const turnIntentShape =
      options.turnIntentShape ??
      resolveTurnIntentShape({
        message,
        itemMentioned: true,
        hasDuration: true,
      });
    return {
      parsed,
      selection,
      ...planBelowMinimumHoursTurn({
        message,
        selection,
        item,
        turnIntentShape,
        isGroupInbound: options.isGroupInbound ?? false,
        isAvailable: options.isAvailable ?? true,
        itemLabel:
          options.itemLabel ??
          (buildDisplayLabel(item) || String(item?.name ?? "").trim()),
        alternativeItems: options.alternativeItems ?? [],
        modeOverride: options.mode ?? null,
      }),
    };
  }
  return {
    parsed,
    selection,
    createFields: shortBookingCreateFields(selection, item),
  };
}

export function __antiRepetitionMayOverrideForTests({
  finalRoutedReply,
  recentAssistantForRoute = [],
  composedAnswer = null,
} = {}) {
  const repeatsPrior = Array.isArray(recentAssistantForRoute) &&
    recentAssistantForRoute.some(
      (prior) => assistantReplySimilarity(finalRoutedReply, prior) >= 0.82
    );
  const wouldOverride = repeatsPrior && !(composedAnswer?.finalAuthority === true);
  return { repeatsPrior, wouldOverride };
}

// Test-only export: semantic browse intent + reply builder.
export function __isBrowseOptionsIntentForTests(message) {
  return isBrowseOptionsIntent(message);
}

export function __buildBrowseOfferingsReplyForTests({ items = [], services = [], style = "neutral_english" } = {}) {
  return buildBrowseOfferingsReply({ items, services, style });
}

export function __pendingActionReplyIntentForTests(message, pendingAction = null) {
  return inferPendingActionReplyIntent(message, { pendingAction });
}

export function __isPureAckMessageForTests(message) {
  return isPureAckMessage(message);
}

export function __buildPureAckNoOpReplyForTests(conversationStyle = "casual_local") {
  return buildPureAckNoOpReply(conversationStyle);
}

export function __classifyAssistantOutboundKindForTests(trace = {}) {
  return classifyAssistantOutboundKind(trace);
}

export function __buildOutboundTraceForTests(args = {}) {
  return buildOutboundTrace(args);
}

export function __buildIntentionalSilentNoopMessageMetaForTests(
  hasUsefulBusinessData = false
) {
  return buildIntentionalSilentNoopMessageMeta(hasUsefulBusinessData);
}

export function __recordLastAssistantOutboundForTests(memory, trace) {
  recordLastAssistantOutbound(memory, trace);
}

export function __resolvePureAckNoOutboundForTests(args = {}) {
  return resolvePureAckNoOutbound(args);
}

export function __wasPreviousAssistantTurnTerminalInfoForTests(memory) {
  return wasPreviousAssistantTurnTerminalInfo(memory);
}

export function __canResolvePureAckWithoutConsumablePendingForTests(
  memory,
  message,
  bindingCtx
) {
  return canResolvePureAckWithoutConsumablePending(memory, message, bindingCtx);
}

export function __buildCollectDurationReaskReplyForTests(pendingAction, conversationStyle) {
  return buildCollectDurationReaskReply(pendingAction, conversationStyle);
}

export function __mapFuzzyPendingInferredIntentForTests(fuzzyTurnNormalization) {
  return mapFuzzyPendingInferredIntent(fuzzyTurnNormalization);
}

export function __validateConfirmFuzzyCatalogPayloadForTests(pendingAction = {}) {
  return validateConfirmFuzzyCatalogPayload(pendingAction);
}

export function __buildPendingActionForTests(args = {}) {
  return buildPendingAction(args);
}

export function __validatePendingActionBindingForTests(args = {}) {
  return validatePendingActionBinding(args);
}

export function __collectDurationSelectionGuardForTests(args = {}) {
  return collectDurationSelectionGuardDecision(args);
}

export function __buildCollectDurationAvailabilityUnknownReplyForTests(args = {}) {
  return buildCollectDurationAvailabilityUnknownReply(args);
}

export async function __blockCustomerBookingIfHydratedUnavailableForTests(args = {}) {
  return blockCustomerBookingIfHydratedUnavailable(args);
}

export async function __resolveStructuredUnavailableCustomerReplyForTests(args = {}) {
  return resolveStructuredUnavailableCustomerReply(args);
}

export function __getLatestUserSegmentForGuardForTests(message) {
  return getLatestUserSegmentForGuard(message);
}

export function __normalizeBareCatalogSelectionQueryForTests(segment) {
  return normalizeBareCatalogSelectionQuery(segment);
}

export function __computeCollectDurationCatalogQueryForTests(message) {
  return computeCollectDurationCatalogQuery(message);
}

export async function __resolveItemFromCatalogForTests(userId, rawInput, catalogItems) {
  return resolveItemFromCatalog(userId, String(rawInput ?? "").trim(), {
    catalogItems: Array.isArray(catalogItems) ? catalogItems : [],
    catalogSource: "test",
  });
}

export function __isAvailabilityQuestionForCollectDurationGuardForTests(message) {
  return isAvailabilityQuestionForCollectDurationGuard(message);
}

export function __isItemlessPriceDurationFollowupForTests(message, catalogItems = []) {
  return isItemlessPriceDurationFollowup(message, catalogItems);
}

export function __resolveItemlessPriceDurationAskedFieldForTests(message) {
  return resolveItemlessPriceDurationAskedField(message);
}

export function __buildItemlessPriceDurationClarificationReplyForTests() {
  return buildItemlessPriceDurationClarificationReply();
}

export function __hasSafePreviousCatalogItemForPriceFollowupForTests(args = {}) {
  return hasSafePreviousCatalogItemForPriceFollowup(args);
}

export function __resolveDurationContextPolicyForTests(args = {}) {
  return resolveDurationContextPolicy(args);
}

export function __shouldStoreLastVerifiedCatalogAnswerForTests(args = {}) {
  return shouldStoreLastVerifiedCatalogAnswer(args);
}

export function __storeLastVerifiedCatalogAnswerForTests(args = {}) {
  return storeLastVerifiedCatalogAnswer(args);
}

export function __resolveLastVerifiedCatalogAnswerForPriceFollowupForTests(args = {}) {
  return resolveLastVerifiedCatalogAnswerForPriceFollowup(args);
}

export function __assistantReplySignalsCatalogSelectionPromptForTests(text) {
  return assistantReplySignalsCatalogSelectionPrompt(text);
}

export function __isBareCatalogSelectionMessageShapeForComposerForTests(message) {
  return isBareCatalogSelectionMessageShapeForComposer(message);
}

export function __finalizeBookingFsmCustomerReplyForTests(text) {
  return finalizeBookingFsmCustomerReply(text);
}

export function __pendingActionPolicyForTests({
  message = "",
  item = {},
  businessProfile = null,
  isGroupInbound = false,
  isAvailable = true,
  mode = null,
} = {}) {
  const parsed = parseUserDuration(message);
  const selection = shortBookingSelectionFromParsedDuration(parsed, businessProfile);
  if (selection?.type !== "below_minimum") {
    return { parsed, selection, pendingAction: null, reply: null };
  }
  const turnIntentShape = resolveTurnIntentShape({
    message,
    itemMentioned: true,
    hasDuration: true,
  });
  const planned = planBelowMinimumHoursTurn({
    message,
    selection,
    item,
    turnIntentShape,
    isGroupInbound,
    isAvailable,
    itemLabel: buildDisplayLabel(item) || String(item?.name ?? "Test Item").trim(),
    alternativeItems: item?.alternativeItems ?? [],
    modeOverride: mode,
  });
  const itemId = String(item?.itemId ?? item?.id ?? "").trim() || "test-item";
  const itemDisplayLabel =
    buildDisplayLabel(item) ||
    String(item?.displayLabel ?? item?.name ?? "Test Item").trim();
  const pendingAction = planned.shouldStorePending
    ? buildPendingAction({
        type: PENDING_ACTION_TYPES.ACCEPT_SHORT_BOOKING_OFFER,
        expectedReplyType: "affirmation",
        participantKey: "participant-test",
        groupChatKey: "group-test",
        sessionKey: "session-test",
        itemId,
        itemDisplayLabel,
        payload: {
          itemId,
          itemDisplayLabel,
          originalRequestedHours: selection.requestedHours,
          minimumHours: selection.minimumHours,
          billingUnit: selection.billingUnit,
          billingRatePercentOfDaily: selection.billingRatePercentOfDaily,
          calculatedPrice: planned.calculatedPrice,
          currency: currencyFromItem(item),
          explicitPriceIntent: planned.explicitPriceIntent,
        },
        sourcePromptText: planned.reply,
      })
    : null;
  return {
    parsed,
    selection,
    pendingAction,
    reply: planned.reply,
    kind: planned.kind,
    shouldStorePending: planned.shouldStorePending,
  };
}

export function __shouldSuppressBookingDmGenericFallbackForTests({
  messageText = "",
  weakMessageAuthority = false,
  oldMessage = false,
  logisticsComplete = false,
  attachmentFailed = false,
  hasActiveBookingContext = true,
} = {}) {
  if (!String(messageText ?? "").trim()) return true;
  if (weakMessageAuthority) return true;
  if (oldMessage) return true;
  if (logisticsComplete) return true;
  if (attachmentFailed) return true;
  if (!hasActiveBookingContext) return true;
  return false;
}

export function __messageLooksLikeGenericAvailabilityTimingFollowupForTests(message) {
  return messageLooksLikeGenericAvailabilityTimingFollowup(message);
}

export function __intentReasonSuggestsAvailabilityTimeframeForTests(reasonRaw) {
  return intentReasonSuggestsAvailabilityTimeframe(reasonRaw);
}

export function __resolveSafeItemSourceForTests(p) {
  return resolveSafeItemSource(p);
}

export function __buildAvailabilityTimingUnknownReplyForTests(p) {
  return buildAvailabilityTimingUnknownReply(p);
}

export function __computeAskDurationPhraseEligibilityForTests(p) {
  return computeAskDurationPhraseEligibility(p);
}

export function __computeAvailabilityTimingGlobalNoOptionsForTests(p) {
  return computeAvailabilityTimingGlobalNoOptions(p);
}

export function __shouldRouteAvailabilityTimingUnknownAfterNoOptionsContextForTests(p) {
  return shouldRouteAvailabilityTimingUnknownAfterNoOptionsContext(p);
}

export function __availabilityTimingUnknownTurnIfRoutedForTests(p) {
  return availabilityTimingUnknownTurnIfRouted(p);
}

export function __matchedItemForReplyFromCatalogStateForTests(opts) {
  return matchedItemForReplyFromCatalogState(opts);
}

export function __composeBookingUnavailableItemAvailabilityContextReplyForTests(p) {
  return composeBookingUnavailableItemAvailabilityContextReply(p);
}

export async function __buildBookingDurationUnavailableStructuredCustomerReplyForTests(p) {
  return buildBookingDurationUnavailableStructuredCustomerReply(p);
}

export function __clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptionsForTests(p) {
  return clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptions(p);
}

export {
  isCommitActionEntityLabel,
  isBookingCommitOnlyMessage,
  matchedCommitPhrasePreview,
} from "./bookingCommitPhrase.js";

export {
  resolveCurrentTurnAuthority,
  stripParticipantPrefixForItemResolution,
  applyTurnAuthorityMask,
  gateUnavailableReplyAuthority,
  buildUnavailableReplyWithAuthorityGate,
  findConservativeFuzzyCatalogMention,
} from "./currentTurnAuthority.js";

export {
  isSameSessionBookingContinuation,
  maybeHandlePendingEngagementCommitWithoutQualifier,
  reconcileItemContextWithExplicitMessage,
  resolveExplicitUnlistedMention,
  extractCustomerNameFromMessage,
  isAwaitingBookingContactCapture,
  maybeHandleGroupBookingSlotCapture,
  buildSameSessionBookingContinuationReply,
} from "./bookingStabilityHelpers.js";

export function __buildBrowseOptionsReplyForTests(items, style, options = {}) {
  return buildBrowseOptionsReply(items, style, options);
}

export function __buildNotListedReplyForTests(opts = {}) {
  return buildNotListedReply(opts);
}
