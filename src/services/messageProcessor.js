import { generateReply } from "./openai.js";
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
import { detectBookingEvent } from "./eventDetection.js";
import {
  findItemByName,
  getBookingsForItem,
  computeAvailabilityFromBookings,
  createBooking,
  getAlternativeAvailableItems,
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
  intentForContextLayer,
} from "./conversationIntelligence.js";
import {
  resolveEmilyContextLabel,
  resolvePricingFallbackReply,
} from "../config/aiRuntime.js";
import { extractRecentAssistantTextsFromPromptBlock } from "./conversationStore.js";
import { normalizeEmilyResponse } from "./normalizeEmilyResponse.js";
import {
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
import {
  SOURCE_LIMITED_CONTEXT,
  SOURCE_NO_PROFILE_FALLBACK,
  SOURCE_STRUCTURED_PROFILE,
} from "./messageFeedback.js";
import { planGroupHybridDelivery } from "./replyRouting.js";

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
 * Hybrid Playwright group vs Cloud API DM routing on the outbound result.
 * @param {{ reply: unknown, type?: string, messageMeta?: Record<string, unknown> }} result
 * @param {{ isGroupInbound: boolean, message: string, participantPhoneForDm?: string | null, playwrightWebInbound?: boolean }} routingCtx
 * @param {"GROUP" | "DM" | null | undefined} [aiStructuredMode] - from generateReply when model emits \`__ROUTE__:\`
 */
function applyHybridOutboundResult(result, routingCtx, aiStructuredMode) {
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

  if (plan.sendVia === "NONE") {
    return {
      ...result,
      reply: "",
      sendVia: "NONE",
      dmRecipientPhone: undefined,
      replyMode: plan.replyMode ?? undefined,
    };
  }
  return {
    ...result,
    reply: replyMerged,
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
  if (/\b(rent|rental|hire|vehicle|car)\b/.test(t)) {
    return true;
  }
  return false;
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
 * @returns {"duration" | "pricing" | "availability" | "list" | "exclude" | "general"}
 */
function detectIntent(message) {
  const raw = String(message ?? "").trim();
  const lower = raw.toLowerCase();
  if (/^\d+$/.test(raw)) return "duration";
  if (/\b(rent|price|kitna)\b/i.test(lower)) return "pricing";
  if (/\b(available|hai\?)\b/i.test(lower)) return "availability";
  if (/\b(kon|which|cars)\b/i.test(lower)) return "list";
  if (/\b(ilawa|other than)\b/i.test(lower)) return "exclude";
  return "general";
}

/**
 * @param {string} message
 * @returns {number | null}
 */
function extractDurationFromMessage(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return null;
  const onlyNumber = /^(\d+)$/.exec(raw);
  if (onlyNumber) {
    return Number.parseInt(onlyNumber[1], 10);
  }
  const withUnit = /(\d+)\s*(day|days|din|dino|hour|hours|hr|hrs)\b/i.exec(raw);
  if (withUnit) {
    return Number.parseInt(withUnit[1], 10);
  }
  return null;
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
 */
export async function processMessage({
  userId,
  message: inboundRaw,
  sessionKey,
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
}) {
  const selectedForAi = selectLatestInboundForAi(inboundRaw);
  if (!selectedForAi) {
    console.log("⏭ No valid user message");
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

  /** @type {string | null} */
  let forcedIntent = null;
  {
    const lower = message.toLowerCase();
    if (/available|rent|price|\bkia\b|\bkitna\b|\bhai\b/i.test(lower)) {
      forcedIntent = "inquiry";
    }
  }

  const routingCtx = {
    isGroupInbound: Boolean(isGroupInbound),
    message,
    participantPhoneForDm,
    playwrightWebInbound: Boolean(playwrightWebInbound),
  };
  globalThis.__chatContext = globalThis.__chatContext || {};
  const chatContextKey =
    String(sessionKey ?? "").trim() ||
    String(userId ?? "").trim();
  if (resetTopicContext) {
    if (globalThis.__chatContext[chatContextKey]) {
      delete globalThis.__chatContext[chatContextKey];
    }
    const pwKey = String(playwrightChatKey ?? "").trim();
    if (pwKey && globalThis.__lastProcessedUserMsg) {
      delete globalThis.__lastProcessedUserMsg[pwKey];
    }
  }

  globalThis.__topicEntityBySession =
    globalThis.__topicEntityBySession || Object.create(null);
  if (!resetTopicContext) {
    const prevTopicEntity =
      globalThis.__topicEntityBySession[chatContextKey] ?? null;
    const entityProbe = extractEntity(message);
    const confTh = getEntityConfidenceThreshold(entityProbe.name);
    const newTopicEntity =
      entityProbe.name != null && entityProbe.confidence >= confTh
        ? String(entityProbe.name).trim()
        : null;
    if (newTopicEntity && newTopicEntity !== prevTopicEntity) {
      if (globalThis.__chatContext[chatContextKey]) {
        delete globalThis.__chatContext[chatContextKey];
      }
      globalThis.__topicEntityBySession[chatContextKey] = newTopicEntity;
    }
  }

  const rawCtx = globalThis.__chatContext[chatContextKey];
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

  console.log("[DEBUG] isGreetingFirst:", isGreetingFirst);
  console.log("[DEBUG] messageText:", message);

  let knowledge = "";

  try {
    await maybePersistKnowledgeFromMessage(userId, message);
  } catch (e) {
    console.error("[processor] knowledge extract/save:", e);
  }

  console.log("[messageProcessor] Fetching profile for user:", userId);

  let businessProfile = null;
  try {
    const [knowledgeResult, profileResult] = await Promise.all([
      getBusinessKnowledge(userId),
      getBusinessProfile(userId),
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

  const history =
    typeof conversationHistory === "string" && conversationHistory.trim() !== ""
      ? conversationHistory.trim()
      : getRecentChatHistoryForPrompt(userId, 10, sessionKey);
  const hasConversationContext = history.trim().length > 0;


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

  {
    const servicesList = businessContext?.servicesList;
    const itemRows =
      Array.isArray(businessContext?.items) && businessContext.items.length > 0
        ? businessContext.items
        : Array.isArray(businessContext?.vehicles)
          ? businessContext.vehicles
          : [];
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
      itemsOrVehiclesCount: Array.isArray(itemRows) ? itemRows.length : 0,
    });
  }

  const pinnedEntityName =
    inboundEntity != null && String(inboundEntity).trim() !== ""
      ? String(inboundEntity).trim()
      : null;
  const entityResult = pinnedEntityName
    ? {
        name: pinnedEntityName,
        confidence: 1,
        entityType: "item",
      }
    : extractEntity(message);
  const confThreshold = getEntityConfidenceThreshold(entityResult.name);
  const extractedEntity =
    entityResult.name != null && entityResult.confidence >= confThreshold
      ? entityResult.name
      : null;
  const entityType = extractedEntity
    ? entityResult.entityType ?? "item"
    : "item";

  const { durationDays } = extractDuration(message);
  const hasDuration = durationDays != null;

  if (extractedEntity) {
    setLastEntityName(userId, extractedEntity, sessionKey);
  }

  const events = detectBookingEvent(message);
  const nameForBooking =
    (extractedEntity && entityType !== "category" ? extractedEntity : null) ??
    (events.confirmationIntent ? getLastEntityName(userId, sessionKey) : null);

  /** @type {{ itemId: string, name: string, isAvailable: boolean, nextAvailableAt?: string, alternativeItems?: Array<{ id: string, name: string }> } | null} */
  let itemContext = null;

  if (extractedEntity && entityType !== "category") {
    const row = await findItemByName(userId, extractedEntity);
    if (row) {
      const bookings = await getBookingsForItem(userId, row.id, row.name);
      const av = computeAvailabilityFromBookings(bookings);
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
        isAvailable: av.isAvailable,
        ...(av.nextAvailableAt != null && {
          nextAvailableAt: new Date(av.nextAvailableAt).toISOString(),
        }),
        ...(alternativeItems.length > 0 && { alternativeItems }),
      };
    }
  }

  /** @type {{ itemId: string, itemName?: string, durationDays: number } | null} */
  let bookingCreated = null;

  let requiresDuration = false;

  if (nameForBooking && events.transactionalIntent) {
    const row = await findItemByName(userId, nameForBooking);
    if (row) {
      const bookings = await getBookingsForItem(userId, row.id, row.name);
      const av = computeAvailabilityFromBookings(bookings);
      const shouldPersist =
        events.bookingIntent ||
        events.orderIntent ||
        events.confirmationIntent;

      if (shouldPersist && av.isAvailable && !hasDuration) {
        requiresDuration = true;
      }

      if (shouldPersist && av.isAvailable && hasDuration) {
        const r = await createBooking(userId, {
          itemId: row.id,
          itemName: row.name,
          durationDays: durationDays,
        });
        if (r.ok) {
          bookingCreated = {
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
          };
          if (extractedEntity && entityType !== "category") {
            const after = await getBookingsForItem(userId, row.id, row.name);
            const av2 = computeAvailabilityFromBookings(after);
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
              isAvailable: av2.isAvailable,
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

  const entityMeta =
    extractedEntity != null
      ? { name: extractedEntity, type: entityType }
      : null;

  /** Maps classifier labels to detectIntent() union (+ confirmation_followup) */
  const classifierToDetectedIntent = {
    availability: "availability",
    pricing: "pricing",
    booking: "general",
    list: "list",
    comparison: "general",
    greeting: "general",
    general: "general",
    other: "general",
    confirmation_followup: "confirmation_followup",
  };
  let detectedIntent = detectIntent(message);
  const classifierIntentKey =
    inboundIntent != null && String(inboundIntent).trim() !== ""
      ? String(inboundIntent).trim().toLowerCase()
      : "";
  if (
    classifierIntentKey &&
    Object.prototype.hasOwnProperty.call(
      classifierToDetectedIntent,
      classifierIntentKey
    )
  ) {
    detectedIntent = classifierToDetectedIntent[classifierIntentKey];
  }
  const shortConfirm = String(message ?? "").trim().toLowerCase();
  if (shortConfirm === "yes" || shortConfirm === "ok") {
    detectedIntent = "confirmation_followup";
  }
  const durationValue = extractDurationFromMessage(message);
  const nextChatContext = {
    lastFocusedItem:
      extractedEntity != null && entityType !== "category"
        ? String(extractedEntity).trim()
        : existingChatContext.lastFocusedItem ?? null,
    lastIntent: detectedIntent,
    lastDuration:
      detectedIntent === "duration" && durationValue != null
        ? durationValue
        : existingChatContext.lastDuration ?? null,
  };
  globalThis.__chatContext[chatContextKey] = nextChatContext;

  const sid = chatSessionKey(userId, sessionKey);
  const emilyTurn = applyEmilyTurn({
    sessionKey: sid,
    message,
    rawBusinessProfile: businessProfile?.rawBusinessProfile ?? null,
    entityMeta,
    itemContext,
  });
  {
    const catalogLabel = labelFromMatchedItem(emilyTurn.match.matchedItem);
    if (String(catalogLabel ?? "").trim() !== "") {
      nextChatContext.lastFocusedItem = String(catalogLabel).trim();
      globalThis.__chatContext[chatContextKey] = nextChatContext;
    }
  }
  let intent = intentForContextLayer(emilyTurn.emilyIntent);
  if (forcedIntent) {
    intent = forcedIntent;
  }

  console.log({
    matchedItem: emilyTurn.match.matchedItem,
    intent: emilyTurn.emilyIntent,
    memory: emilyTurn.memory,
  });

  const isDelayedCommitment = emilyTurn.emilyIntent === "delayed_commitment";


  const catalogImageUrlsForShow =
    !isDelayedCommitment &&
    detectShowImagesRequest(message) &&
    emilyTurn.match.matchedItem &&
    hasUsefulBusinessData
      ? collectCatalogItemImageUrls(
          businessProfile?.rawBusinessProfile ?? null,
          emilyTurn.match.matchedItem
        )
      : [];

  if (
    !isDelayedCommitment &&
    catalogImageUrlsForShow.length > 0
  ) {
    const label =
      emilyTurn.match.matchedItem?.displayLabel ??
      emilyTurn.match.matchedItem?.name ??
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
  if (pinnedEntityName) {
    contextData.classifierPinnedEntity = pinnedEntityName;
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
    Boolean(resetTopicContext) ||
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

  let aiReply = "";
  /** @type {"GROUP" | "DM" | undefined} */
  let aiRouteModeFromModel;
  if (isDelayedCommitment) {
    aiReply = "";
  } else {
    const isNumericOnlyInput = /^\d+$/.test(String(message ?? "").trim());
    const missingHint =
      String(businessType ?? "").trim() || "item";
    const missingContext =
      detectedIntent === "duration" && !nextChatContext.lastFocusedItem
        ? missingHint
        : "none";
    const contextLabel = resolveEmilyContextLabel();
    const enrichedInputBase = `
User message: "${message}"

Context:
- Current ${contextLabel}: ${nextChatContext.lastFocusedItem || "unknown"}
- Duration: ${nextChatContext.lastDuration != null ? String(nextChatContext.lastDuration) : "unknown"}
- Intent: ${detectedIntent}
- Missing: ${missingContext}
`.trim();
    const enrichedInput =
      isNumericOnlyInput && nextChatContext.lastFocusedItem
        ? enrichedInputBase
        : enrichedInputBase;
    console.log("🧠 Intent:", detectedIntent);
    console.log("🧠 Context:", nextChatContext);
    console.log("🧠 Final AI Input:", enrichedInput);
    const out = await generateReply({
      message: enrichedInput,
      contextMessages,
      intent,
      emilyIntent: emilyTurn.emilyIntent,
      history,
      knowledge: mergedKnowledge,
      hasKnowledge: hasKnowledgeForModel,
      contextData,
      businessName,
      businessType,
      businessProfile: businessContext,
      conversationMemory: emilyTurn.memory,
      conversationMemorySummary: emilyTurn.memorySummary,
      matchedItem: emilyTurn.match.matchedItem,
      matchedService: emilyTurn.match.matchedService,
      matchedCatalogLine,
      proactivePricingHint: emilyTurn.pricingHint,
      conversationStage: emilyTurn.memory.stage,
      userLanguageStyle: emilyTurn.userLanguageStyle,
      tone,
      fragmentCount: fc,
      hasMultipleFragments: Boolean(hasMultipleFragments) || fc > 1,
      isGreetingFirst: Boolean(isGreetingFirst),
      lastFocusedItem: nextChatContext.lastFocusedItem ?? null,
      lastDuration: nextChatContext.lastDuration ?? null,
      detectedIntent,
    });
    aiReply = out.reply ?? "";
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
    matchedItem: emilyTurn.match.matchedItem,
    matchedService: emilyTurn.match.matchedService,
    intent: emilyTurn.emilyIntent,
    memory: emilyTurn.memory,
    memoryDelta: emilyTurn.memoryDelta,
    userMessage: message,
    pricingHint: emilyTurn.pricingHint,
    userLanguageStyle: emilyTurn.userLanguageStyle,
    recentAssistantReplies,
    sessionKey: sid,
  });

  if (replyChannel === "whatsapp" && finalReply != null) {
    const polished = polishWhatsAppBusinessTone(String(finalReply));
    finalReply = polished !== "" ? polished : finalReply;
    finalReply = dedupeAgainstPriorAssistantReplies(
      String(finalReply),
      extractRecentAssistantTextsFromPromptBlock(conversationHistory, 6)
    );
  }

  if (!finalReply || !String(finalReply).trim()) {
    console.log("⚠️ No final AI reply after retry path — skipping outbound");
    const outNone = applyHybridOutboundResult(
      {
        reply: "Could you please clarify what you're looking for?",
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
      },
      routingCtx,
      aiRouteModeFromModel
    );
    return outNone;
  }

  const baseFinal = {
    reply: finalReply,
    type: "AI_MESSAGE",
    messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
  };
  const outFinal = applyHybridOutboundResult(
    baseFinal,
    routingCtx,
    aiRouteModeFromModel
  );
  if (
    outFinal.sendVia !== "NONE" &&
    outFinal.reply != null &&
    String(outFinal.reply).trim() !== ""
  ) {
    appendConversationTurn(
      userId,
      message,
      String(outFinal.reply),
      sessionKey
    );
  }

  return outFinal;
}
