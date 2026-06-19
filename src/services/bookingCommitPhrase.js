/**
 * Roman Urdu booking commit / action fragments must not be treated as catalog items.
 */

import { extractEntity, getEntityConfidenceThreshold } from "./entityExtraction.js";
import { hasStrongBookingCommitPhrase } from "./conversationRouter.js";
import { hasExplicitNewItemMention } from "./currentTurnAuthority.js";

const COMMIT_ACTION_LABELS = new Set(
  [
    "kr dn",
    "kr do",
    "kar do",
    "kar dein",
    "kar den",
    "kardo",
    "kr dein",
    "confirm",
    "done",
    "proceed",
    "ok done",
    "yes confirm",
    "booking kr do",
    "booking kar do",
    "book kar do",
    "confirm kar do",
    "confirm kr do",
    "ok booking kr dn",
    "ok booking kr do",
    "ok booking kar do",
  ].map((s) => s.toLowerCase())
);

const ACTION_TOKENS = new Set(
  [
    "kr",
    "kar",
    "do",
    "dn",
    "dein",
    "den",
    "kardo",
    "confirm",
    "done",
    "booking",
    "book",
    "ok",
    "yes",
    "proceed",
    "jee",
    "ji",
    "haan",
    "han",
  ].map((s) => s.toLowerCase())
);

const BARE_COMMIT_MESSAGES = new Set(
  ["kr dn", "kr do", "kar do", "kar dein", "kar den", "kardo", "kr dein"].map((s) =>
    s.toLowerCase()
  )
);

function normalizeCommitText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} label
 * @returns {boolean}
 */
export function isCommitActionEntityLabel(label) {
  const norm = normalizeCommitText(label);
  if (!norm) return false;
  if (COMMIT_ACTION_LABELS.has(norm)) return true;

  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;

  if (tokens.every((t) => ACTION_TOKENS.has(t))) return true;

  if (tokens.length >= 2 && ["booking", "book", "confirm"].includes(tokens[0])) {
    const tail = tokens.slice(1);
    if (tail.length > 0 && tail.every((t) => ACTION_TOKENS.has(t))) return true;
  }

  return false;
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
function isBareCommitActionMessage(message) {
  const norm = normalizeCommitText(message);
  return Boolean(norm && BARE_COMMIT_MESSAGES.has(norm));
}

/**
 * @param {unknown} message
 * @returns {boolean}
 */
function isBookingCommitShapedMessage(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  return hasStrongBookingCommitPhrase(raw) || isBareCommitActionMessage(raw);
}

/**
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 * @returns {boolean}
 */
export function isBookingCommitOnlyMessage(message, catalogItems = []) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;

  const explicitCatalog = hasExplicitNewItemMention(raw, catalogItems, null);
  if (explicitCatalog.found) return false;

  if (!isBookingCommitShapedMessage(raw)) return false;

  const extracted = extractEntity(raw);
  const threshold = getEntityConfidenceThreshold(extracted.name);
  const hasHighConfEntity =
    extracted.name != null &&
    extracted.confidence > 0.8 &&
    extracted.confidence >= threshold;

  if (hasHighConfEntity && !isCommitActionEntityLabel(extracted.name)) {
    return false;
  }

  if (hasHighConfEntity && isCommitActionEntityLabel(extracted.name)) {
    return true;
  }

  return true;
}

/**
 * @param {unknown} message
 * @returns {string | null}
 */
export function matchedCommitPhrasePreview(message) {
  const raw = String(message ?? "").trim();
  const norm = normalizeCommitText(raw);
  if (!norm) return null;
  const extracted = extractEntity(raw);
  if (extracted.name && isCommitActionEntityLabel(extracted.name)) {
    return String(extracted.name).trim();
  }
  if (COMMIT_ACTION_LABELS.has(norm)) return norm;
  if (BARE_COMMIT_MESSAGES.has(norm)) return norm;
  if (hasStrongBookingCommitPhrase(raw)) {
    const tokens = norm.split(/\s+/).filter(Boolean);
    return tokens.slice(0, 4).join(" ") || norm;
  }
  return norm.slice(0, 40) || null;
}
