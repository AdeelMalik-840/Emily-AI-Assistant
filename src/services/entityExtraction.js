/**
 * Generic entity / duration extraction — no business-specific vocabulary.
 */

import { parseUserDuration } from "../duration/parseDuration.js";

/** Minimum confidence (0–1) to accept an entity downstream. */
export const ENTITY_CONFIDENCE_MIN = 0.81;

/** Stricter minimum when the phrase contains generic tokens (item, product, etc.). */
export const ENTITY_CONFIDENCE_MIN_GENERIC = 0.82;

/**
 * Tokens that are too vague alone — require higher confidence to accept.
 * (Normalized lowercase.)
 */
const GENERIC_ENTITY_TOKENS = new Set(
  [
    "item",
    "items",
    "product",
    "products",
    "thing",
    "things",
    "something",
    "anything",
    "option",
    "options",
    "stuff",
    "service",
    "services",
    "package",
    "packages",
    "order",
    "booking",
    "reservation",
    "cheez",
    "chiz",
    "saman",
    "maal",
  ].map((w) => w.toLowerCase())
);

/** Names / messages that read as a class of things, not one SKU. */
const CATEGORY_MESSAGE_SIGNAL =
  /\b(category|categories|type|types|kind|kinds|options?|menu|list|sab|all|kya\s+kya|jo\s+jo|range)\b/i;

const CATEGORY_NAME_TOKENS = new Set(
  [
    "things",
    "stuff",
    "items",
    "products",
    "services",
    "options",
    "menu",
    "all",
    "everything",
  ].map((w) => w.toLowerCase())
);

const CONF = {
  QUOTED: 0.96,
  PATTERN: 0.88,
  STRONG_MENTION: 0.91,
  TAIL: 0.82,
  FALLBACK: 0.52,
};

const GENERIC_FOLLOWUP_ONLY =
  /^(?:kis|konsa|kaunsa|which|what|kitna|kitni|kitne|mileage|condition|color|colour|model|rent|price|rate|charges?)(?:\s+(?:color|colour|model|rent|price|rate|mileage|condition|mai|mein|main|me|hai|hain|kya|kyaa|ka|ki|ke|kaunsa|konsa|kitna|kitni|kitne))*\??$/i;

/** Filler / discourse tokens — stripped from edges of a candidate; never the sole entity. */
const WEAK_EDGE = new Set(
  [
    "bhai",
    "bhayi",
    "bhaiya",
    "bai",
    "yar",
    "yaar",
    "janab",
    "ji",
    "please",
    "pls",
    "kindly",
    "boss",
    "dear",
    "sir",
    "madam",
    "miss",
    "mr",
    "mrs",
    "ms",
    "dr",
    "han",
    "haan",
    "acha",
    "theek",
    "thik",
    "ok",
    "okay",
    "oye",
    "sun",
    "sunna",
    "suno",
    "bas",
    "yar",
    "dost",
    // Roman Urdu pronouns / spellings (not catalog tokens)
    "mujy",
    "muje",
    "mjhe",
    "mje",
    // Roman Urdu "for" / purpose — often glued to entity in short messages
    "lye",
    "liye",
    "lie",
    "keliye",
    // Roman Urdu "want" — often captured as tail of entity span
    "chahye",
    "chahiye",
    "chaiye",
    "chaahiye",
    "chaahie",
  ].map((w) => w.toLowerCase())
);

const STOP_WORDS = new Set(
  [
    "a",
    "an",
    "the",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "must",
    "shall",
    "can",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "under",
    "again",
    "further",
    "then",
    "once",
    "here",
    "there",
    "when",
    "where",
    "why",
    "how",
    "all",
    "both",
    "each",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "nor",
    "not",
    "only",
    "own",
    "same",
    "so",
    "than",
    "too",
    "very",
    "just",
    "and",
    "but",
    "if",
    "or",
    "because",
    "until",
    "while",
    "about",
    "against",
    "up",
    "down",
    "out",
    "off",
    "over",
    "me",
    "him",
    "his",
    "her",
    "she",
    "it",
    "its",
    "we",
    "our",
    "you",
    "your",
    "they",
    "them",
    "their",
    "this",
    "that",
    "these",
    "those",
    "hello",
    "hi",
    "hey",
    "thanks",
    "thank",
    "please",
    "pls",
    "ok",
    "okay",
    "yes",
    "no",
    "hai",
    "hain",
    "ho",
    "ka",
    "ki",
    "ke",
    "ko",
    "se",
    "bhi",
    "nahi",
    "nahin",
    "na",
    "aur",
    "ya",
    "toh",
    "phir",
    "kya",
    "kis",
    "main",
    "mujhe",
    "hum",
    "aap",
    "apne",
    "kuch",
    "kyun",
    "kisi",
    "karna",
    "karte",
    "karunga",
    "jo",
    "bhi",
    "kitna",
    "kitne",
    "kitni",
    "batao",
    "bata",
    "btao",
    "how",
    "are",
    "you",
    "doing",
    "fine",
    "price",
    "rate",
    "cost",
    "stock",
    "product",
    "item",
    "menu",
    "delivery",
    "bhai",
    "bhayi",
    "bhaiya",
    "yar",
    "yaar",
    "janab",
    "ji",
    "kindly",
    "boss",
  ].map((w) => w.toLowerCase())
);

for (const w of WEAK_EDGE) {
  STOP_WORDS.add(w);
}

function normalizeToken(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF]/gi, "");
}

function trimEntityName(s) {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:]+|[\s,.;:]+$/g, "")
    .trim();
  return t.length > 0 ? t : "";
}

/**
 * Remove weak discourse tokens from the start/end of a candidate phrase.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeEntityEdges(name) {
  const parts = trimEntityName(name)
    .split(/\s+/)
    .filter(Boolean);
  while (parts.length > 0) {
    const w = normalizeToken(parts[0]);
    if (w && WEAK_EDGE.has(w)) parts.shift();
    else break;
  }
  while (parts.length > 0) {
    const w = normalizeToken(parts[parts.length - 1]);
    if (w && WEAK_EDGE.has(w)) parts.pop();
    else break;
  }
  return parts.join(" ").trim();
}

function isStopPhrase(name) {
  const parts = name.split(/\s+/).map(normalizeToken).filter(Boolean);
  return parts.length > 0 && parts.every((p) => STOP_WORDS.has(p));
}

/**
 * @param {string | null} name
 * @param {number} confidence
 * @returns {{ name: string | null, confidence: number }}
 */
function entityOutcome(name, confidence) {
  if (name == null || String(name).trim() === "") {
    return { name: null, confidence: 0 };
  }
  const cleaned = sanitizeEntityEdges(trimEntityName(name));
  if (!cleaned || isStopPhrase(cleaned)) {
    return { name: null, confidence: 0 };
  }
  return { name: cleaned, confidence };
}

/**
 * True if any word in the candidate is a generic filler (higher confidence bar applies).
 * @param {string} name
 */
export function isGenericEntityName(name) {
  const parts = String(name ?? "")
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  return parts.some((p) => GENERIC_ENTITY_TOKENS.has(p));
}

/**
 * Dynamic confidence floor: stricter for generic tokens.
 * @param {string | null} name
 * @returns {number}
 */
export function getEntityConfidenceThreshold(name) {
  if (name != null && isGenericEntityName(name)) {
    return ENTITY_CONFIDENCE_MIN_GENERIC;
  }
  return ENTITY_CONFIDENCE_MIN;
}

/**
 * @param {string} name
 * @param {string} message
 * @returns {"item" | "category"}
 */
function inferEntityType(name, message) {
  const m = String(message ?? "");
  if (CATEGORY_MESSAGE_SIGNAL.test(m)) {
    return "category";
  }
  const parts = String(name ?? "")
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  if (parts.length === 0) return "item";
  if (parts.length <= 2 && parts.every((p) => CATEGORY_NAME_TOKENS.has(p))) {
    return "category";
  }
  return "item";
}

/**
 * @param {{ name: string | null, confidence: number }} out
 * @param {string} message
 */
function finalizeEntityResult(out, message) {
  if (out.name == null) {
    return { name: null, confidence: 0, entityType: "item" };
  }
  return {
    name: out.name,
    confidence: out.confidence,
    entityType: inferEntityType(out.name, message),
  };
}

/**
 * Extract a likely item / entity phrase from free text (regex + token fallback).
 * @param {string} message
 * @returns {{ name: string | null, confidence: number, entityType: "item" | "category" }}
 */
export function extractEntity(message) {
  const raw = String(message ?? "").trim();
  if (!raw) {
    return { name: null, confidence: 0, entityType: "item" };
  }

  const normalizedRaw = raw
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (GENERIC_FOLLOWUP_ONLY.test(normalizedRaw)) {
    return { name: null, confidence: 0, entityType: "item" };
  }

  let text = raw.replace(
    /\d+\s*(?:din|deen|dino|day|days|dinos?)\b/gi,
    " "
  );
  text = text.replace(/\s+/g, " ").trim();

  const quoted = text.match(/["'`]([^"'`]+)["'`]/);
  if (quoted) {
    const name = trimEntityName(quoted[1]);
    if (name && !isStopPhrase(name)) {
      return finalizeEntityResult(entityOutcome(name, CONF.QUOTED), raw);
    }
  }

  const patterns = [
    /(?:^|\s)(?:book|booking|reserve|reservation|order|rent|rental|purchase|buy)\s+([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,4})/i,
    /(?:^|\s)(?:need|needs|want|wants|looking\s+for|searching\s+for)\s+([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,4})/i,
    /(?:^|\s)(?:for|about|regarding)\s+(?:the|a|an)?\s*([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,4})/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const name = trimEntityName(m[1]);
      if (name && !isStopPhrase(name)) {
        return finalizeEntityResult(entityOutcome(name, CONF.PATTERN), raw);
      }
    }
  }

  const strongMentions = [
    /^\s*([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,3}?)\s+(?:ka|ki|ke)\s+(?:kya\s+scene|scene|details?|detail|info|rate|price|rent|model|color|colour|mileage|condition)\b/i,
    /^\s*([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,3})\s+(?:available|avail|milega|milegi|hai|hain)\??\s*$/i,
  ];

  for (const p of strongMentions) {
    const m = text.match(p);
    if (m) {
      const name = trimEntityName(m[1]);
      if (name && !isStopPhrase(name)) {
        return finalizeEntityResult(entityOutcome(name, CONF.STRONG_MENTION), raw);
      }
    }
  }

  const tail = text.match(
    /^\s*([a-zA-Z0-9\u0600-\u06FF]+(?:\s+[a-zA-Z0-9\u0600-\u06FF]+){0,3})\s+(?:chahiye|chahti|chahte|hain|hai|milega|milegi|mile\s+ga|mil\s+jye|mil\s+jaye|mill\s+jaye|milta|milti|dedo|de\s+do|lagao|lagwa|book|order)\b/i
  );
  if (tail) {
    const name = trimEntityName(tail[1]);
    if (name && !isStopPhrase(name)) {
      return finalizeEntityResult(entityOutcome(name, CONF.TAIL), raw);
    }
  }

  const tokens = text.split(/\s+/).map(normalizeToken).filter(Boolean);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount > 10) {
    return { name: null, confidence: 0, entityType: "item" };
  }

  const meaningful = tokens.filter(
    (t) => !STOP_WORDS.has(t) && t.length > 1 && !/^\d+$/.test(t)
  );

  if (meaningful.length >= 2 && meaningful.length <= 8) {
    const chunk = [];
    for (let i = 0; i < meaningful.length && chunk.length < 3; i += 1) {
      chunk.push(meaningful[i]);
    }
    if (chunk.length > 0) {
      const joined = chunk.join(" ");
      if (!isStopPhrase(joined)) {
        return finalizeEntityResult(entityOutcome(joined, CONF.FALLBACK), raw);
      }
    }
  }

  return { name: null, confidence: 0, entityType: "item" };
}

/**
 * Extract duration in days (normalized) from user text.
 * @param {string} message
 * @returns {{ durationDays: number | null }}
 */
export function extractDuration(message) {
  const parsed = parseUserDuration(message);
  if (!parsed) return { durationDays: null };
  return { durationDays: parsed.normalizedDays };
}
