import {
  classifyConversationIntentWithLLM,
  extractBookingSlotsWithLLM,
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
  buildBookingDetailsClarificationReply,
  findApprovedBookingForDm,
  findApprovedBookingForGroupDetails,
  isBookingAttachAvailabilityQuery,
  isLogisticsComplete,
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
  applyToneGuard,
  composeInformationalAnswer,
} from "./answerComposer.js";
import {
  applyResponseStrategy,
  decideResponseStrategy,
} from "./responseStrategy.js";
import { buildBookingWaitingEngagement } from "./customerApprovalContinuation.js";
import { sanitizeContextForResolvedItemChange } from "./bookingContextSanitizer.js";
import { resolveParticipantIdentity } from "./participantIdentity.js";

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
} = {}) {
  const flowId = String(traceId ?? "").trim() || null;
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
  const isOnlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower);
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

function normalizePhoneDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
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

  const isDigitsOnly = /^\d{1,3}$/.test(lower);
  const hasDurationWord = /\b(din|days?)\b/i.test(raw);
  const hasTimeMarker =
    /\b(baje|bjay|am|pm|raat|shaam|evening|morning|afternoon|night|aaj|kal|today|tomorrow)\b/i.test(
      raw
    ) || /:\d{2}\b/.test(raw);

  if (s === "awaiting_delivery_method") {
    const method = String(slots.deliveryMethod ?? "").trim().toLowerCase();
    if (!String(b?.deliveryMethod ?? "").trim()) {
      if (method === "delivery" || method === "pickup") accepted.deliveryMethod = method;
      else if (method) rejected.push("deliveryMethod");
    }
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      const cleaned = cleanAddress(addrRaw);
      if (cleaned && !looksLikePhone(cleaned)) {
        if (isLowSignalSlotValue("deliveryAddress", cleaned)) {
          console.log("[delivery_address_rejected_low_signal]", {
            original: String(addrRaw ?? "").slice(0, 120) || null,
            cleaned: String(cleaned ?? "").slice(0, 120) || null,
          });
          rejected.push("deliveryAddress");
        } else {
          accepted.deliveryAddress = cleaned;
        }
      } else {
        rejected.push("deliveryAddress");
      }
    }
  } else if (s === "awaiting_delivery_location") {
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      const cleaned = cleanAddress(addrRaw);
      if (cleaned && !looksLikePhone(cleaned)) {
        if (isLowSignalSlotValue("deliveryAddress", cleaned)) {
          console.log("[delivery_address_rejected_low_signal]", {
            original: String(addrRaw ?? "").slice(0, 120) || null,
            cleaned: String(cleaned ?? "").slice(0, 120) || null,
          });
          rejected.push("deliveryAddress");
        } else {
          accepted.deliveryAddress = cleaned;
        }
      } else {
        rejected.push("deliveryAddress");
      }
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

function looksSyntheticPhoneSource(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return false;
  return /\b(grp|group|dm|participant|first[\s_-]*seen)\b/i.test(s);
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

/**
 * Best-effort contact phone extraction from raw user message (rule-based).
 * @param {string} text
 * @returns {string | null}
 */
export function extractContactPhoneFromText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (looksSyntheticPhoneSource(raw)) return null;
  const matches =
    raw.match(/(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g) || [];
  for (const m of matches) {
    const phone = normalizePhoneDigits(m);
    if (phone) return phone;
  }
  return null;
}

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
    /\b\d+\s*(?:din|deen|dino|day|days|hour|hours|week|weeks)\b/i.test(m) ||
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
  const isGroupOutbound = Boolean(
    routingCtx?.isGroupInbound === true &&
      planGroupHybridDelivery({
        isGroupInbound: true,
        replyText: rawReply,
        messageMeta: result?.messageMeta,
        inboundMessage: routingCtx?.message,
        participantPhoneForDm:
          routingCtx?.participantPhoneForDm != null &&
          String(routingCtx.participantPhoneForDm).trim() !== ""
            ? String(routingCtx.participantPhoneForDm).trim()
            : null,
        aiStructuredMode,
      })?.sendVia === "GROUP"
  );

  const scrubGroupReply = (text) => {
    const t = String(text ?? "");
    if (!t.trim()) return t;
    const lower = t.toLowerCase();
    const blocked =
      /\bconfirm\s+hai\b/i.test(t) ||
      /\bconfirmed\b/i.test(lower) ||
      /\bbooking\s+confirm\b/i.test(lower) ||
      /\b(kis\s+time|time\s+kya)\b/i.test(lower) ||
      /\bdelivery\s+address\b/i.test(lower) ||
      /\bpick\s*up\b/i.test(lower) ||
      /\bpickup\b/i.test(lower) ||
      /\b(phone\s+number|contact\s+number)\b/i.test(lower) ||
      /\b(location\s+bhej|address\s+bhej)\b/i.test(lower);
    if (!blocked) return t;
    console.warn("[group_reply_safety_scrubbed]", {
      ...(flowId ? { flowId } : {}),
      messagePreview: String(routingCtx?.message ?? "").slice(0, 160) || null,
      originalReplyPreview: t.slice(0, 160),
    });
    console.warn("[GROUP_SAFETY]", {
      ...(flowId ? { flowId } : {}),
      action: "scrubbed",
      reason: "BLOCKED_GROUP_LOGISTICS_OR_CONFIRMATION_COPY",
    });
    return "Request owner ko bhej di hai. Main details private chat mein le leta hun.";
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
  const replyFinal =
    isGroupOutbound ? scrubGroupReply(replyMerged) : replyMerged;

  if (plan.sendVia === "NONE") {
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
  return /^(\d+)(?:\s*(?:day|days|din|dino|hour|hours|hr|hrs)(?:\s+\S+){0,3})?$/i.test(raw);
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

function buildBrowseOptionsReply(items, style) {
  if (!Array.isArray(items) || items.length === 0) {
    return style === "casual_local"
      ? "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?"
      : "I don't see another available option right now. Would you like to ask about a specific option?";
  }
  const heading =
    style === "casual_local" ? "Available options:" : "Available options:";
  const ask =
    style === "casual_local"
      ? "Konsa option dekhna chahenge?"
      : "Which option would you like to check?";
  return `${heading}\n${items.map(formatCatalogOptionLine).join("\n")}\n\n${ask}`;
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
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 * @param {string | null | undefined} lockedItemId
 * @returns {{ found: boolean, itemId: string | null, itemLabel: string | null }}
 */
function hasExplicitNewItemMention(message, catalogItems, lockedItemId) {
  const msg = normalizeCatalogMatchText(message);
  const lockedId = normalizeId(lockedItemId);
  if (!msg || !Array.isArray(catalogItems)) {
    return { found: false, itemId: null, itemLabel: null };
  }
  for (const row of catalogItems) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const r = /** @type {Record<string, unknown>} */ (row);
    const id = normalizeId(r.id);
    if (!id || id === lockedId) continue;
    const label = buildDisplayLabel(r) || String(r.name ?? "").trim();
    const labelNorm = normalizeCatalogMatchText(label);
    const nameNorm = normalizeCatalogMatchText(r.name);
    const tokens = tokenizeCatalogMatch(label || r.name);
    const mentioned =
      (labelNorm && msg.includes(labelNorm)) ||
      (nameNorm && msg.includes(nameNorm)) ||
      tokens.some((t) => t.length >= 4 && msg.split(/\s+/).includes(t));
    if (mentioned) {
      return { found: true, itemId: id, itemLabel: label || null };
    }
  }
  return { found: false, itemId: null, itemLabel: null };
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

function shouldSkipEntityExtractionForDetailQuestion(message, catalogItems) {
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

export function resolveAuthoritativeItemForTurn({
  userText,
  explicitResolvedItem,
  turnLockedItem,
  memoryItem,
  isFollowup,
  catalogItems = [],
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
    normalizeId(lockedItem?.id ?? focusedMemoryItem?.id)
  );
  const explicitMention =
    Boolean(explicitItem) &&
    (hasExplicitEntity ||
      explicitCatalogMention.found ||
      latestMessageMentionsEntity(
        userText,
        explicitItem?.displayLabel ?? explicitItem?.name
      ));

  let selected = null;
  let source = "none";
  if (explicitMention && explicitItem) {
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
    selected = focusedMemoryItem;
    source = "memory_followup";
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
  const fallbackScopedLabel =
    !matchedItemLabelFromTurn &&
    !pinnedEntityName &&
    String(nextChatContext.lastFocusedItem ?? "").trim() !== "" &&
    canUseScopedFollowup
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
 * Emily Brain entry point (channel-agnostic).
 * Uses OpenAI gpt-4o-mini via generateReply() in openai.js (business knowledge + history), not a raw single-line completion.
 * Static fallback only when there is no business profile AND no conversation history; otherwise always OpenAI.
 */
/**
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
 * @param {string} [opts.traceId] - booking-flow trace id (from executeWhatsAppAiPipeline)
 */
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
}) {
  const traceId =
    traceIdIn != null && String(traceIdIn).trim() !== ""
      ? String(traceIdIn).trim()
      : randomUUID();
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

  const message = selectedForAi;
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

  const routingCtx = {
    isGroupInbound: Boolean(isGroupInbound),
    message,
    participantPhoneForDm,
    playwrightWebInbound: Boolean(playwrightWebInbound),
    flowId,
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

  async function handleBookingConversationState(ctx = {}) {
    const finalizeBookingStateReply = (text) => {
      const raw = String(text ?? "").trim();
      if (!raw) return "";
      // Booking-state replies are customer-facing; apply the same safety/tone normalization as AI replies.
      const guarded = applyToneGuard(raw);
      const polished = polishWhatsAppBusinessTone(String(guarded ?? ""));
      return String(polished ?? guarded ?? raw).trim();
    };

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

    /** @type {string} */
    let canonicalState = "inactive";
    if (status !== "approved") {
      canonicalState = "inactive";
    } else if (hasDeliveryDetailsCollectedAt) {
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
        return {
          handled: true,
          replyText: finalizeBookingStateReply(validated.nextReplyOverride),
          updatedBookingFields: {},
          nextState: "awaiting_delivery_method",
          bookingId,
        };
      }
      interpreted.method = validated.accepted.deliveryMethod || interpreted.method;
      interpreted.location = validated.accepted.deliveryAddress || interpreted.location;
      console.log("[booking_state_message_interpreted]", {
        bookingId,
        state: "awaiting_delivery_method",
        rawTextPreview: String(ctx?.message ?? "").trim().slice(0, 160) || null,
        method: interpreted.method,
        location: interpreted.location,
        confidence: interpreted.confidence,
      });

      if (!interpreted.method) {
        return {
          handled: true,
          replyText: finalizeBookingStateReply(
            "Delivery chahiye ya pickup? Reply kar dein: delivery ya pickup."
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
      if (interpreted.method === "pickup") {
        nextState = "awaiting_delivery_time";
        replyText = "Pickup noted. Kis time lena chahenge?";
      } else {
        if (interpreted.location) {
          nextState = "awaiting_delivery_time";
          replyText = `${interpreted.location} noted 👍 Delivery ka time kya rakhna hai?`;
        } else {
          nextState = "awaiting_delivery_location";
          replyText = "Delivery noted. Location/address share kar dein.";
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
        return {
          handled: true,
          replyText: finalizeBookingStateReply("Location/address thoda clear bata dein."),
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

      await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .update(update);

      const fromState = "awaiting_delivery_location";
      const nextState = "awaiting_delivery_time";
      const replyText = `${location} noted 👍 Delivery ka time kya rakhna hai?`;

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

      await db
        .collection("businesses")
        .doc(String(ctx.userId))
        .collection("bookings")
        .doc(bookingId)
        .update(update);

      const fromState = "awaiting_delivery_time";
      const nextState = "awaiting_contact";
      const replyText = "Time note kar liya. Contact number share kar dein.";

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
        if (isComplete) {
          patch.approvalStage = "delivery_details_collected";
          patch.deliveryDetailsCollectedAt = now;
        }
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
    dmPlaywrightChatKey: null,
    dmChatTitle: null,
    message,
  }).catch(() => ({ handled: false }));
  if (bookingStateResult?.handled === true) {
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
  const sourceParticipantKey =
    String(participantKey ?? "").trim() ||
    participantIdentity.participantKey ||
    null;
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
            await db
              .collection("businesses")
              .doc(String(userId))
              .collection("bookings")
              .doc(String(booking.id))
              .update(update);

            // Acknowledge + next step (booking continuation tone).
            let reply = "";
            if (detectedField === "delivery_location") {
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
      const mergedAfterUpdate = { ...booking, ...update };
      const confirmed = isLogisticsComplete(
        mergedAfterUpdate,
        logisticsCompletionPolicy
      );
      logLogisticsCompletionEvaluated({
        bookingId: String(booking.id),
        booking: mergedAfterUpdate,
        isComplete: confirmed,
        source: "parser",
      });
      if (confirmed) {
        await db
          .collection("businesses")
          .doc(String(userId))
          .collection("bookings")
          .doc(String(booking.id))
          .update({
            approvalStage: "delivery_details_collected",
            deliveryDetailsCollectedAt: new Date(),
            updatedAt: new Date(),
          });
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
    if (!details.address && !details.deliveryTime && !details.contactPhone) return null;
    const update = { updatedAt: new Date() };
    if (details.address) update.deliveryAddress = details.address;
    if (details.deliveryTime) update.deliveryTime = details.deliveryTime;
    if (details.contactPhone && !groupBookingMatch.customerPhone) {
      update.customerPhone = details.contactPhone;
    }
    await db
      .collection("businesses")
      .doc(String(userId))
      .collection("bookings")
      .doc(String(groupBookingMatch.id))
      .update(update);
    console.log("[booking_details_attached]", {
      bookingId: groupBookingMatch.id,
      source: "group_fallback",
      matchReason: groupBooking.reason,
      hasAddress: Boolean(details.address),
      hasDeliveryTime: Boolean(details.deliveryTime),
      hasContactPhone: Boolean(details.contactPhone),
    });
    console.log("[delivery_details_collected]", {
      bookingId: groupBookingMatch.id,
      source: "group_fallback",
      hasAddress: Boolean(details.address || groupBookingMatch.deliveryAddress),
      hasDeliveryTime: Boolean(details.deliveryTime || groupBookingMatch.deliveryTime),
    });
    const mergedAfterGroupUpdate = { ...groupBookingMatch, ...update };
    const confirmed = isLogisticsComplete(
      mergedAfterGroupUpdate,
      logisticsCompletionPolicy
    );
    logLogisticsCompletionEvaluated({
      bookingId: String(groupBookingMatch.id),
      booking: mergedAfterGroupUpdate,
      isComplete: confirmed,
      source: "parser",
    });
    if (confirmed) {
      await db
        .collection("businesses")
        .doc(String(userId))
        .collection("bookings")
        .doc(String(groupBookingMatch.id))
        .update({
          approvalStage: "delivery_details_collected",
          deliveryDetailsCollectedAt: new Date(),
          updatedAt: new Date(),
        });
      console.log("[booking_delivery_confirmed]", {
        bookingId: groupBookingMatch.id,
        source: "group_fallback",
      });
    }
    return applyHybridOutboundResult(
      {
        reply: buildDeliveryDetailReply({ booking: groupBookingMatch, updated: details }),
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(true),
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
      const parsed = parseUserDuration(message);
      const originalDurationText =
        parsed && typeof parsed === "object" && Number.isFinite(Number(parsed.value)) && parsed.unit
          ? `${Math.max(1, Math.floor(Number(parsed.value)))} ${String(parsed.unit).trim()}`
          : null;
      if (originalDurationText) {
        const subject = safeItemName ? `${safeItemName} ` : "";
        finalText =
          conversationStyle === "casual_local"
            ? `Perfect 👍 ${subject}${originalDurationText} ke liye note kar liya. City ke andar use karna hai ya outside city?`
            : `Perfect 👍 I’ve noted ${subject}for ${originalDurationText}. Will you use it within the city or outside the city?`;
        console.log("[booking_waiting_response_generated]", {
          bookingId: safeBookingId,
          eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
          responsePreview: String(finalText).slice(0, 160),
          durationDisplay: originalDurationText,
          durationDays: safeDurationDays,
        });
      } else {
        const waitingEvent = {
          eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
          itemName: safeItemName,
          durationDays: safeDurationDays,
          privacyMode: "group_safe",
          nextStep: "ask_qualifying_question_while_waiting",
        };
        console.log("[booking_waiting_event_built]", {
          bookingId: safeBookingId,
          event: waitingEvent,
        });
        finalText = buildBookingWaitingEngagement(waitingEvent, conversationStyle);
        console.log("[booking_waiting_response_generated]", {
          bookingId: safeBookingId,
          eventType: waitingEvent.eventType,
          responsePreview: finalText.slice(0, 160),
        });
      }
      if (memory && typeof memory === "object") {
        memory.pendingEngagementState = buildPendingQualifierState({
          bookingId: safeBookingId,
          qualifierKey: "usage_area",
          allowedValues: ["inside_city", "outside_city"],
        });
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
        },
        messageMeta: {
          bookingCreated: {
            id: safeBookingId,
            itemId: String(itemId ?? "").trim() || null,
            itemName: safeItemName,
            durationDays: safeDurationDays,
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
  function isStatefulShortGroupReply(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    const words = raw.split(/\s+/).filter(Boolean);
    return (
      words.length <= 4 ||
      /\b\d+\s*(din|day|days|roz|hafta|week|weeks)\b/i.test(raw) ||
      /^(yes|yeah|yep|han|haan|ji|jee|ok|okay|done|outside|inside|andar|bahar)$/i.test(raw)
    );
  }
  function buildBookingBlockedResponse({ itemName, memory }) {
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
  const pendingTopicReset = Boolean(resetTopicContext);
  if (isGroupInbound && !sourceParticipantKey && isStatefulShortGroupReply(message)) {
    console.warn("[participant_short_reply_without_context_blocked]", {
      groupChatKey: normalizedPlaywrightChatKey || null,
      messagePreview: String(message ?? "").slice(0, 80),
      reason: "MISSING_PARTICIPANT_IDENTITY",
    });
    return applyHybridOutboundResult(
      {
        reply: "Kis item ke liye keh rahe hain?",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(false),
      },
      routingCtx
    );
  }
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
  const normalizedCatalogForTurn = catalogRowsThisTurn
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) =>
      normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row))
    );
  if (normalizedCatalogForTurn.length === 0) {
    console.error("❌ No catalog items found in DB");
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
  const extracted = extractDuration(message);
  let durationDays = extracted.durationDays ?? null;
  const bareDurationMessage = isBareDurationMessage(message);
  const durationMemoryCandidate =
    memForCatalogInput?.lastItem && typeof memForCatalogInput.lastItem === "object"
      ? memForCatalogInput.lastItem
      : null;
  let turnLockedItem = null;
  const previousAssistantAskedDuration = bareDurationMessage
    ? previousAssistantAskedDurationForItem(
        history,
        getRecentAssistantReplies(userId, 3, sessionKey),
        durationMemoryCandidate
      )
    : true;
  let durationContextAllowed =
    !bareDurationMessage ||
    (previousAssistantAskedDuration &&
      normalizeId(durationMemoryCandidate?.id) != null);
  let durationContextReason = durationContextAllowed
    ? "OK"
    : !previousAssistantAskedDuration
      ? "PREVIOUS_ASSISTANT_DID_NOT_ASK_DURATION"
      : "ACTIVE_ITEM_MISSING";
  const activeDurationItemId = normalizeId(durationMemoryCandidate?.id);
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
  if (bareDurationMessage && durationContextAllowed && activeDurationItemId) {
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
  if (extracted.durationDays != null && durationContextAllowed) {
    memForCatalogInput.lastDuration = extracted.durationDays;
  } else if (extracted.durationDays != null && !durationContextAllowed) {
    durationDays = null;
    memForCatalogInput.lastDuration = null;
    memForCatalogInput.durationPreference = null;
  }
  const contactPartsEarly = extractBookingContactParts(message);
  logContactParse(contactPartsEarly);
  const extractedContactEarly = contactPartsEarly.isValid
    ? String(contactPartsEarly.normalizedPhone || contactPartsEarly.phone || "").trim()
    : null;
  if (isValidContactValue(extractedContactEarly)) {
    memForCatalogInput.contact = extractedContactEarly;
    if (contactPartsEarly.name) {
      memForCatalogInput.customerName = contactPartsEarly.name;
    }
  }
  const hasContactForBookingEarly = isValidContactValue(extractedContactEarly)
    ? true
    : isValidContactValue(memForCatalogInput?.contact)
      ? true
      : false;
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
      if (av.isAvailable === false) {
        const raw = await getAlternativeAvailableItems(
          userId,
          row.id,
          row.name,
          3
        );
        alternativeItems = raw.map(({ id, name }) => ({ id, name }));
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
      const isInformationalIntent = isInformationalPriorityIntent(
        earlyPrioritizedIntent?.priorityIntent
      );

      if (!sameUserContinuation && !av.isAvailable && !isInformationalIntent) {
        const itemLabel = buildDisplayLabel(row) || String(row.name ?? "").trim();
        console.log("[final_reply_source]", {
          source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
        });
        return applyHybridOutboundResult(
          {
            reply: buildUnavailableReply({
              itemLabel,
              style: conversationStyle,
            }),
            text: buildUnavailableReply({
              itemLabel,
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
          createBookingArgs: {
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
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
            if (av2.isAvailable === false) {
              const raw = await getAlternativeAvailableItems(
                userId,
                row.id,
                row.name,
                3
              );
              alternativeItems = raw.map(({ id, name }) => ({ id, name }));
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

  let detectedIntent = detectIntent(message);
  if (prioritizedIntent.priorityIntent === "availability") {
    detectedIntent = "availability";
  } else if (prioritizedIntent.priorityIntent === "price") {
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
    const availableOptions = [];
    for (const row of normalizedCatalogForTurn) {
      if (!row || typeof row !== "object") continue;
      const rowId = normalizeId(row.id);
      if (!rowId) continue;
      if (wantsOther && previousItemId && rowId === previousItemId) continue;
      const rowName = String(row.name ?? "").trim();
      const av = await getUserFacingAvailabilityForItem(
        rowId,
        rowName,
        "fallback"
      );
      if (av?.isAvailable === false) continue;
      availableOptions.push(row);
      if (availableOptions.length >= 5) break;
    }
    const services =
      businessProfile?.rawBusinessProfile &&
      typeof businessProfile.rawBusinessProfile === "object" &&
      Array.isArray(businessProfile.rawBusinessProfile.services)
        ? businessProfile.rawBusinessProfile.services
        : [];

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
    const reply = buildBrowseOfferingsReply({
      items: availableOptions,
      services: wantsServices || availableOptions.length === 0 ? services : [],
      style: conversationStyle,
    });
    console.log("[browse_options_reply_built]", {
      optionCount: availableOptions.length,
      serviceCount: Array.isArray(services) ? services.length : 0,
      replyPreview: String(reply ?? "").slice(0, 180) || null,
    });
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
  console.log("🧪 ITEM CONTEXT FULL:", itemContext);

  const explicitResolvedItemForAuthority = extractedEntity
    ? itemContext ?? resolvedItemFromCatalog ?? matchedItemForReply ?? null
    : null;
  const isItemFollowupForAuthority =
    isDetailFollowupWithoutExplicitEntity(message) ||
    (!extractedEntity && detectedIntent === "availability") ||
    (wantsImages && !extractedEntity);
  const authoritativeItemForTurn = resolveAuthoritativeItemForTurn({
    userText: message,
    explicitResolvedItem: explicitResolvedItemForAuthority,
    turnLockedItem: lockedItemAsContext(),
    memoryItem: conversationMemory?.lastItem ?? memForCatalogInput?.lastItem ?? null,
    isFollowup: isItemFollowupForAuthority,
    catalogItems: normalizedCatalogForTurn,
  });
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
  if (isValidContactValue(extractedContact)) {
    memory.contact = extractedContact;
    if (contactParts.name) {
      memory.customerName = contactParts.name;
    }
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
      createBookingArgs: {
        itemId: memoryBookingItemId,
        itemName: memoryBookingItemName || undefined,
        durationDays: bookingDurationDays,
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
    Boolean(matchedItemForReply || memoryBookingItemId);
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
  if (turnLockedItem) {
    await applyTurnLockedItemContext(
      turnLockedItem.reason === "CONTACT_AFTER_ASK_CONTACT" ? "memory" : "duration"
    );
    resolvedItem = lockedItemAsContext();
  }
  const safeItemCandidate = itemContext ?? resolvedItem ?? memory?.lastItem ?? null;
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
  if (
    isAvailabilityQuestion &&
    itemContext != null &&
    typeof itemContext === "object" &&
    itemContext.isAvailable === false
  ) {
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext.name ?? "").trim() ||
      memoryBookingItemName;
    const blockingStatusesSeen = Array.isArray(itemContext.blockingStatusesSeen)
      ? itemContext.blockingStatusesSeen
      : [];
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
    return applyHybridOutboundResult(
      {
        reply: buildUnavailableReply({
          itemLabel,
          style: conversationStyle,
        }),
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

  const conversationRoute = decideConversationRoute({
    message,
    selectedItem: safeItem,
    memory,
    activeStage: stage,
    isDeliveryDetailsActive: false,
    isApprovalAction: false,
    intentClassification: prioritizedIntent,
  });
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
      const composerItem = mergeComposerCatalogItem(safeItem, normalizedCatalogForTurn);
      composedAnswer = composeInformationalAnswer({
        message,
        draftReply: finalRoutedReply,
        item: composerItem,
        businessContext,
        askedField: conversationRoute.askedField ?? prioritizedIntent.askedField,
      });
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
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
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
    const approvalAvailable =
      itemContext != null &&
      typeof itemContext === "object" &&
      itemContext.isAvailable === false
        ? false
        : true;
    console.log("[group_contact_request_blocked]", {
      itemId: approvalItemId,
      hasDuration: approvalDurationDays != null,
      hasContact,
      isAvailable: approvalAvailable,
      reason: "OWNER_APPROVAL_FIRST",
    });

    if (approvalItemId && approvalDurationDays != null && approvalAvailable) {
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
        createBookingArgs: {
          itemId: approvalItemId,
          itemName: approvalItemName,
          durationDays: approvalDurationDays,
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
        console.log("[final_reply_source]", {
          source: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
        });
        return applyHybridOutboundResult(
          {
            reply: buildUnavailableReply({
              itemLabel,
              style: conversationStyle,
            }),
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
    itemContext != null &&
    typeof itemContext === "object" &&
    itemContext.isAvailable === false &&
    (isAvailabilityQuestion || hasDurationSignal || events.transactionalIntent)
  ) {
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext?.name ?? "").trim() ||
      memoryBookingItemName;
    console.log("[final_reply_source]", {
      source: isAvailabilityQuestion
        ? "AVAILABILITY_BLOCKED_EARLY"
        : "BOOKING_BLOCKED_AVAILABILITY_CHECK",
    });
    logTiming("AI/phrase decision", aiPhraseDecisionStartedAt, {
      source: isAvailabilityQuestion
        ? "AVAILABILITY_BLOCKED_EARLY"
        : "BOOKING_BLOCKED_AVAILABILITY_CHECK",
    });
    return applyHybridOutboundResult(
      {
        reply: buildUnavailableReply({
          itemLabel,
          style: conversationStyle,
        }),
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
      aiReply = "Great, please share your contact number so I can complete the booking request.";
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
    const itemLabel =
      buildDisplayLabel(itemContext) ||
      String(itemContext?.name ?? "").trim() ||
      memoryBookingItemName;
    finalReply = buildUnavailableReply({
      itemLabel,
      style: conversationStyle,
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
          createBookingArgs: {
            itemId: commitRow.id,
            itemName: commitRow.name,
            durationDays: memoryDurationDays,
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
    console.error("❌ processMessage crash:", err);
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
  const safeItemName = String(itemName ?? "").trim() || "your item";
  const parsed = parseUserDuration(message);
  const originalDurationText =
    parsed && typeof parsed === "object" && Number.isFinite(Number(parsed.value)) && parsed.unit
      ? `${Math.max(1, Math.floor(Number(parsed.value)))} ${String(parsed.unit).trim()}`
      : null;
  if (originalDurationText) {
    const subject = safeItemName ? `${safeItemName} ` : "";
    return conversationStyle === "casual_local"
      ? `Perfect 👍 ${subject}${originalDurationText} ke liye note kar liya. City ke andar use karna hai ya outside city?`
      : `Perfect 👍 I’ve noted ${subject}for ${originalDurationText}. Will you use it within the city or outside the city?`;
  }
  return buildBookingWaitingEngagement(
    {
      eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
      itemName: safeItemName,
      durationDays: 14,
      privacyMode: "group_safe",
      nextStep: "ask_qualifying_question_while_waiting",
    },
    conversationStyle
  );
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
