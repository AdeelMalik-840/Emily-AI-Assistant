/**
 * Detect likely unlisted catalog mentions for availability questions.
 */
import {
  extractEntity,
  getEntityConfidenceThreshold,
} from "../../services/entityExtraction.js";
import { hasExplicitNewItemMention } from "../../services/currentTurnAuthority.js";

const BUSINESS_INTENT_BOUNDARY =
  /\b(?:\d+\s*(?:din|deen|dino|day|days|hours?|hrs?|ghantay?|ghante?)|ka|ki|ke|available|avail|availability|maujood|milega|milegi|milta|milti|rent|rate|price|pricing|kiraya|kiraye|picture|pictures|photo|photos|image|images|pic|tasveer|tasveerain|bhejo|bhej|share|dikha|dikhao|show|send|book|booking|confirm|reserve|final|finalize|proceed)\b/i;

const NON_ITEM_TOKENS = new Set(
  [
    "kar",
    "kr",
    "do",
    "dn",
    "dein",
    "book",
    "booking",
    "confirm",
    "reserve",
    "final",
    "finalize",
    "proceed",
    "available",
    "availability",
    "rent",
    "rate",
    "price",
    "pricing",
    "picture",
    "photo",
    "image",
    "pic",
    "tasveer",
    "share",
    "bhejo",
    "bhej",
    "dikha",
    "dikhao",
    "show",
    "send",
    "live",
    "test",
  ].map((w) => w.toLowerCase())
);

function stripParticipantPrefix(message) {
  return String(message ?? "")
    .trim()
    .replace(/^\[[^\]]+\]\s*/u, "")
    .trim();
}

function stripRuntimeTags(message) {
  return String(message ?? "")
    .replace(/\bLIVE[-_\s]?E2E[-_\s]?\d+\b/gi, " ")
    .replace(/\bE2E\d+\b/gi, " ")
    .replace(/\bLIVE[-_\s]?BRAIN[-_\s]?\d+\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCandidate(value) {
  const text = String(value ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (/^\d/.test(words[0] ?? "")) return null;
  while (words.length && NON_ITEM_TOKENS.has(words[words.length - 1].toLowerCase())) {
    words.pop();
  }
  while (words.length && NON_ITEM_TOKENS.has(words[0].toLowerCase())) {
    words.shift();
  }
  if (/^\d/.test(words[0] ?? "")) return null;
  if (!words.length) return null;
  if (words.every((w) => NON_ITEM_TOKENS.has(w.toLowerCase()))) return null;
  const candidate = words.join(" ").trim();
  if (candidate.length < 3) return null;
  return candidate;
}

function firstBusinessIntentBoundaryIndex(message) {
  const text = String(message ?? "");
  const match = text.match(BUSINESS_INTENT_BOUNDARY);
  return match?.index ?? -1;
}

function extractLeadingRequestedItem(message) {
  const cleaned = stripRuntimeTags(stripParticipantPrefix(message));
  if (!cleaned) return null;
  const boundaryIndex = firstBusinessIntentBoundaryIndex(cleaned);
  if (boundaryIndex <= 0) return null;
  const candidate = normalizeCandidate(cleaned.slice(0, boundaryIndex));
  return candidate;
}

function catalogContainsCandidate(candidate, items) {
  const token = String(candidate ?? "").trim().toLowerCase();
  if (!token) return false;
  for (const row of items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const hay = `${String(row.name ?? "")} ${String(row.displayLabel ?? "")}`.toLowerCase();
    if (hay.includes(token)) return true;
    if (
      token.length >= 4 &&
      hay
        .split(/\s+/)
        .filter(Boolean)
        .some((word) => word.startsWith(token.slice(0, 4)))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 * @param {string | null | undefined} resolvedItemId
 * @returns {string | null}
 */
export function detectUnlistedMentionLabel(message, catalogItems, resolvedItemId) {
  if (String(resolvedItemId ?? "").trim()) return null;

  const items = Array.isArray(catalogItems) ? catalogItems : [];
  if (hasExplicitNewItemMention(message, items, null).found) return null;

  const leading = extractLeadingRequestedItem(message);
  if (leading && !catalogContainsCandidate(leading, items)) return leading;

  const extracted = extractEntity(message);
  const rawName = String(extracted?.name ?? "").trim();
  if (!rawName) return null;

  const threshold = getEntityConfidenceThreshold(rawName);
  if (!(Number(extracted.confidence) >= threshold)) return null;

  const cleaned = rawName
    .replace(/\b(available|availability|maujood|hai|hain|milega|milegi)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const token = (cleaned.split(/\s+/).filter(Boolean)[0] ?? cleaned).toLowerCase();
  if (!token || token.length < 3) return null;
  if (NON_ITEM_TOKENS.has(token)) return null;

  if (catalogContainsCandidate(token, items)) return null;

  return cleaned.split(/\s+/).filter(Boolean)[0] ?? cleaned;
}
