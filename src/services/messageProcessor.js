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
import { isEnglishOnlyGreetingMessage } from "./greetingLanguage.js";
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
  if (/\b(rent|rental|hire|vehicle|car)\b/.test(t)) {
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
 * @param {string | null | undefined} history
 * @param {Record<string, unknown> | null | undefined} rawBusinessProfile
 * @returns {{ name?: string, color?: string, displayLabel?: string } | null}
 */
function resolveRecentCatalogItemFromHistory(history, rawBusinessProfile) {
  const hist = normalizeText(String(history ?? ""));
  if (!hist) return null;
  if (!rawBusinessProfile || typeof rawBusinessProfile !== "object") return null;
  const itemRows =
    Array.isArray(rawBusinessProfile.items) && rawBusinessProfile.items.length > 0
      ? rawBusinessProfile.items
      : Array.isArray(rawBusinessProfile.vehicles)
        ? rawBusinessProfile.vehicles
        : [];
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
 * When there is no catalog match this turn, map `memory.lastItemMentioned` onto a profile
 * row so `collectCatalogItemImageUrls` can resolve `name`/`color` like a real match.
 * Read-only; does not mutate Emily state or matchers.
 *
 * @param {Record<string, unknown> | null | undefined} rawProfile
 * @param {unknown} lastItemMentioned
 * @returns {{ name: string, displayLabel: string, color?: string } | null}
 */
function resolveCatalogItemFromMemoryLabel(rawProfile, lastItemMentioned) {
  if (!rawProfile || typeof rawProfile !== "object") return null;
  const memRaw = String(lastItemMentioned ?? "").trim();
  if (!memRaw) return null;
  const mem = memRaw.toLowerCase();
  const itemRows =
    Array.isArray(rawProfile.items) && rawProfile.items.length > 0
      ? rawProfile.items
      : Array.isArray(rawProfile.vehicles)
        ? rawProfile.vehicles
        : [];
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
  const normalizedPlaywrightChatKey = normalizeText(
    String(playwrightChatKey ?? "")
  );
  const normalizedSessionKey = normalizeText(String(sessionKey ?? ""));
  const normalizedUserId = normalizeText(String(userId ?? ""));
  const chatContextKey =
    normalizedPlaywrightChatKey ||
    normalizedSessionKey ||
    normalizedUserId;
  const pendingTopicReset = Boolean(resetTopicContext);

  globalThis.__topicEntityBySession =
    globalThis.__topicEntityBySession || Object.create(null);

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

  let resolvedItemEntityName = null;
  let validatedPinnedEntityName = null;

  /** @type {{ itemId: string, name: string, isAvailable: boolean, nextAvailableAt?: string, alternativeItems?: Array<{ id: string, name: string }> } | null} */
  let itemContext = null;

  if (extractedEntity && entityType !== "category") {
    const row = await findItemByName(userId, extractedEntity);
    if (row) {
      resolvedItemEntityName = String(row.name ?? "").trim() || extractedEntity;
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

  const effectiveEntityForItemFlow =
    resolvedItemEntityName ||
    validatedPinnedEntityName;

  if (effectiveEntityForItemFlow) {
    setLastEntityName(userId, effectiveEntityForItemFlow, chatContextKey);
  }

  const events = detectBookingEvent(message);
  const nameForBooking =
    (effectiveEntityForItemFlow && entityType !== "category"
      ? effectiveEntityForItemFlow
      : null) ??
    (events.confirmationIntent ? getLastEntityName(userId, chatContextKey) : null);

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
          if (effectiveEntityForItemFlow && entityType !== "category") {
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
    effectiveEntityForItemFlow != null
      ? { name: effectiveEntityForItemFlow, type: entityType }
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

  const sid = chatSessionKey(userId, chatContextKey);
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
  const matchedItemLabelFromTurn = labelFromMatchedItem(emilyTurn.match.matchedItem);
  const hasRawEntityCandidate =
    entityResult?.name != null &&
    String(entityResult.name).trim() !== "";
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
    : emilyTurn.match.matchedItem;

  const resolvedName =
    matchedItemForReply && typeof matchedItemForReply.name === "string"
      ? matchedItemForReply.name.trim()
      : "";

  const currentMemory =
    emilyTurn.memory?.lastItemMentioned != null
      ? String(emilyTurn.memory.lastItemMentioned).trim()
      : "";

  // Rule 1: Only proceed if we have a valid resolved item
  const hasResolvedItem = resolvedName.length > 0;

  // Rule 2: Memory is empty
  const memoryEmpty = currentMemory.length === 0;

  // Rule 3: Allow safe upgrade (more specific value)
  const isUpgrade =
    currentMemory &&
    resolvedName &&
    resolvedName.length > currentMemory.length &&
    resolvedName.toLowerCase().includes(currentMemory.toLowerCase());

  // FINAL DECISION:
  if (hasResolvedItem && (memoryEmpty || isUpgrade)) {
    emilyTurn.memory.lastItemMentioned = resolvedName;

    console.log("🧠 Memory Sync Applied (final resolved):", {
      stored: resolvedName,
      previous: currentMemory || null,
      reason: memoryEmpty ? "empty" : "upgrade",
    });
  }

  let intent = intentForContextLayer(emilyTurn.emilyIntent);
  if (forcedIntent) {
    intent = forcedIntent;
  }
  let resolvedEmilyIntent = emilyTurn.emilyIntent;
  if (
    emilyTurn.memory?.lastItemMentioned &&
    emilyTurn.memory?.durationPreference &&
    intent === "inquiry"
  ) {
    resolvedEmilyIntent = "booking";
    intent = "order";
  }

  console.log({
    matchedItem: emilyTurn.match.matchedItem,
    intent: emilyTurn.emilyIntent,
    memory: emilyTurn.memory,
  });

  const resolvedItem =
    matchedItemForReply ??
    resolveCatalogItemFromMemoryLabel(
      businessProfile?.rawBusinessProfile ?? null,
      emilyTurn.memory?.lastItemMentioned
    );

  console.log("🧠 Context Resolution:", {
    matchedItem:
      matchedItemForReply != null
        ? labelFromMatchedItem(matchedItemForReply) ||
          (typeof matchedItemForReply.name === "string"
            ? matchedItemForReply.name
            : null)
        : null,
    memoryItem: emilyTurn.memory?.lastItemMentioned ?? null,
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
    emilyTurn.memory?.lastItemMentioned ?? null,
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
    const fromHistory = resolveRecentCatalogItemFromHistory(
      conversationHistory,
      businessProfile?.rawBusinessProfile ?? null
    );
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
      const urls = collectCatalogItemImageUrls(
        businessProfile?.rawBusinessProfile ?? null,
        candidate
      );
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
        ? "Sure — which specific car images do you need?"
        : "Ji bilkul — kis specific car ki images chahiye?";
      const outClarify = applyHybridOutboundResult(
        {
          reply: clarifyReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
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
        ? "I can share details for this car, but images are not available right now."
        : "Is car ki details share kar sakta hoon, lekin images abhi available nahi hain.";
      const outNoImage = applyHybridOutboundResult(
        {
          reply: noImageReply,
          type: "AI_MESSAGE",
          messageMeta: messageMetaForKnowledge(hasUsefulBusinessData),
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
  const shouldAvoidDurationQuestion =
    Boolean(emilyTurn.memory?.durationPreference) &&
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
  let aiRawReply = "";
  /** @type {"GROUP" | "DM" | undefined} */
  let aiRouteModeFromModel;
  if (isDelayedCommitment) {
    aiReply = "";
  } else {
    const missingHint =
      String(businessType ?? "").trim() || "item";
    const missingContext =
      detectedIntent === "duration" && !nextChatContext.lastFocusedItem
        ? missingHint
        : "none";
    const contextLabel = resolveEmilyContextLabel();
    const memDur = emilyTurn.memory?.durationPreference;
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
      getRecentChatHistoryForPrompt(userId, 10, sid).trim();
    const { payload: aiInput, tailEmbedded } = buildStructuredAiUserPayload({
      historyText: historyForTail,
      currentMessage: message,
      lastItemMentioned: emilyTurn.memory?.lastItemMentioned,
      contextLabel,
      lastFocusedItemStr: String(nextChatContext.lastFocusedItem ?? "").trim(),
      durationForEnriched,
      detectedIntent,
      missingContext,
    });
    console.log("🧠 Intent:", detectedIntent);
    console.log("🧠 Context:", nextChatContext);
    console.log("🧠 AI Context Input:", aiInput);
    const out = await generateReply({
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
      conversationMemory: emilyTurn.memory,
      conversationMemorySummary: emilyTurn.memorySummary,
      matchedItem: matchedItemForReply,
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
      ? collectCatalogItemImageUrls(
          businessProfile?.rawBusinessProfile ?? null,
          resolvedItem
        )
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
    messageMeta: {
      ...messageMetaForKnowledge(hasUsefulBusinessData),
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
