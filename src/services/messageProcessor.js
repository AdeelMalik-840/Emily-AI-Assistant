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
import { randomUUID } from "node:crypto";
import { logBookingEvent } from "../utils/bookingLogger.js";

function bookingOwnerApprovalFirstEnabled() {
  return /^true$/i.test(String(process.env.BOOKING_OWNER_APPROVAL_FIRST ?? "").trim());
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
  if (/\b(rent|price|kitna)\b/i.test(lower)) return "pricing";
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
    /\b(?:aur|or)\s+dikhao\b/i.test(text)
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
 * @param {string | null} [opts.senderScope] - hashed per-group participant scope when available
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
  senderScope = null,
}) {
  const traceId =
    traceIdIn != null && String(traceIdIn).trim() !== ""
      ? String(traceIdIn).trim()
      : randomUUID();
  try {
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
  console.log("[processMessage] inbound normalized identity", {
    messageId: String(messageId),
    source,
    timestamp,
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
  };
  const dmTargetPhone = isRoutableDmTarget(participantPhoneForDm)
    ? String(participantPhoneForDm).trim()
    : "";
  const dmTargetSource = dmTargetPhone ? "participantPhoneForDm" : "";
  const canDmCustomer = Boolean(dmTargetPhone);
  const ownerApprovalFirst = bookingOwnerApprovalFirstEnabled();
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
    const finalText = ownerApprovalFirstRequest
      ? "Great, request owner ko bhej di hai. Main confirmation milte hi update kar dungi."
      : conversationStyle === "casual_local"
        ? `Great, ${safeItemName} ki booking request ${safeDurationDays} days ke liye create ho gayi hai. Hum shortly confirm kar denge.`
        : `Great! Your booking for ${safeItemName} for ${safeDurationDays} days has been created. We’ll confirm it shortly.`;

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
  const normalizedUserId = normalizeText(String(userId ?? ""));
  const chatContextKey =
    normalizedPlaywrightChatKey ||
    normalizedSessionKey ||
    normalizedUserId;
  /**
   * Emily / booking memory bucket for this thread (must match applyEmilyTurn).
   * For group inboxes, callers should pass a per-customer thread id (e.g. participant
   * phone or DM route) so User A / User B do not share one session state.
   */
  const emilySessionKey = chatSessionKey(userId, chatContextKey);
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

  {
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

  const memForCatalogInput = getEmilySessionState(emilySessionKey);
  const extracted = extractDuration(message);
  let durationDays =
    extracted.durationDays ??
    memForCatalogInput?.lastDuration ??
    existingChatContext.lastDuration ??
    null;
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

  const effectiveEntityForItemFlow =
    resolvedItemEntityName ||
    validatedPinnedEntityName;

  if (effectiveEntityForItemFlow) {
    setLastEntityName(userId, effectiveEntityForItemFlow, chatContextKey);
  }

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
  if (
    durationDays != null &&
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
    ? "NO_ENTITY_FOUND"
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
      if (!av.isAvailable) {
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
        shouldPersist &&
        av.isAvailable &&
        hasDuration &&
        hasContactForBookingEarly
      ) {
        const r = await createBooking(traceId, userId, {
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
          memForCatalogInput.bookingCreated = true;
          bookingCreated = {
            id: r.id.trim(),
            itemId: row.id,
            itemName: row.name,
            durationDays: durationDays,
            status: "pending_approval",
          };
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
  if (isBrowseOptionsIntent(message)) {
    detectedIntent = "browse_options";
  }
  const shortConfirm = String(message ?? "").trim().toLowerCase();
  if (shortConfirm === "yes" || shortConfirm === "ok") {
    detectedIntent = "confirmation_followup";
  }
  if (events.bookingIntent === true) {
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
  const isGreetingIntent =
    detectedIntent === "greeting" ||
    classifierIntentKey === "greeting" ||
    isEnglishOnlyGreetingMessage(message) ||
    /^(hi|hello|hey|assalam|aoa)\b/i.test(String(message ?? "").trim());
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
    syncLastItemFromItemContextIfMissing(memoryPreEmily, itemContext);
    await ensureItemContextItemId(userId, itemContext, resolveCatalogThisTurn);
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
    console.log("[final_reply_source]", { source: "PHRASE_ENGINE" });
    return applyHybridOutboundResult(
      {
        reply: buildBrowseOptionsReply(availableOptions, conversationStyle),
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

  const memoryDurationValue =
    conversationMemory?.durationPreference != null &&
    typeof conversationMemory.durationPreference === "object" &&
    typeof conversationMemory.durationPreference.value === "number" &&
    Number.isFinite(conversationMemory.durationPreference.value)
      ? Math.max(1, Math.floor(conversationMemory.durationPreference.value))
      : null;
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
    if (memory?.bookingCreated) {
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
    const bookingResult = await createBooking(traceId, userId, {
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
    });
    if (!bookingResult?.ok && bookingErrorCode(bookingResult) === "ITEM_ALREADY_BOOKED") {
      console.log("[BOOKING BLOCKED - CONTACT STEP]", memoryBookingItemName);
      return buildBookingBlockedResponse({
        itemName: memoryBookingItemName,
        memory: conversationMemory,
      });
    }
    if (bookingResult?.ok && typeof bookingResult.id === "string" && bookingResult.id.trim() !== "") {
      memory.bookingCreated = true;
      bookingCreated = {
        id: bookingResult.id.trim(),
        itemId: memoryBookingItemId,
        itemName: memoryBookingItemName || undefined,
        durationDays: bookingDurationDays,
        status: "pending_approval",
      };
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

  if (
    ownerApprovalFirst &&
    Boolean(isGroupInbound) &&
    !bookingCreated &&
    hasDurationSignal === true &&
    !hasContact
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
      const approvalItemName =
        buildDisplayLabel(itemContext) ||
        String(itemContext?.name ?? "").trim() ||
        memoryBookingItemName ||
        undefined;
      const approvalResult = await createBooking(traceId, userId, {
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
        memory.bookingCreated = true;
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
        const bookingFinal = buildBookingFinalOutbound({
          bookingId: bookingCreated.id,
          itemId: approvalItemId,
          itemName: approvalItemName,
          durationDays: approvalDurationDays,
          ownerApprovalFirstRequest: true,
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
    memoryDurationRaw != null &&
    typeof memoryDurationRaw === "object" &&
    typeof memoryDurationRaw.value === "number"
      ? Number.isFinite(memoryDurationRaw.value)
        ? Math.max(1, Math.floor(memoryDurationRaw.value))
        : null
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
        const commitBooking = await createBooking(traceId, userId, {
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
        });
        if (!commitBooking?.ok && bookingErrorCode(commitBooking) === "ITEM_ALREADY_BOOKED") {
          console.log("[BOOKING RETRY BLOCKED]");
          return buildBookingBlockedOutbound(conversationMemory);
        }
        if (commitBooking?.ok && typeof commitBooking.id === "string" && commitBooking.id.trim()) {
          conversationMemory.bookingCreated = true;
          bookingCreated = {
            id: commitBooking.id.trim(),
            itemId: commitRow.id,
            itemName: commitRow.name,
            durationDays: memoryDurationDays,
            status: "pending_approval",
          };

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
