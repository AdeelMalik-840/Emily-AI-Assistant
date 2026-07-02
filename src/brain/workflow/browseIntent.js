/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */

/**
 * @param {string} message
 * @returns {string}
 */
function normalizeMessageText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Generic list/browse asks without a catalog-resolved item focus.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isGenericBrowseListAsk(text) {
  const norm = normalizeMessageText(text);
  if (!norm) return false;

  return (
    /\bwhat\s+else\b/i.test(norm) ||
    /\bor\s+kon\b/i.test(norm) ||
    /\bkoi\s+aur\b.*\boptions?\b/i.test(norm) ||
    /\bavailable\s+options?\b/i.test(norm) ||
    /\boptions?\s+kya\s+h(?:ai|ain)\b/i.test(norm) ||
    /\bkya\s+options?\s+h(?:ai|ain)\b/i.test(norm) ||
    /\bkonsi\b.*\b(?:cars?|gaari|gaadi|options?|items?)\b.*\bavailable\b/i.test(norm) ||
    /\bkya\s+kya\b.*\bavailable\b/i.test(norm) ||
    /\blist\s+dikha\b/i.test(norm) ||
    /\blist\s+bata\b/i.test(norm) ||
    /\bavailable\s+options?\s+bata\b/i.test(norm)
  );
}

/**
 * Item-specific availability phrasing when an explicit catalog item is already resolved.
 *
 * @param {TurnUnderstanding} understanding
 * @param {string} message
 * @returns {boolean}
 */
export function isExplicitItemAvailabilityPhrasing(understanding, message) {
  if (understanding.itemSource !== "explicit" || !understanding.resolvedItemId) {
    return false;
  }
  if (understanding.signals?.priceAsk || understanding.signals?.bookingCommitment) {
    return false;
  }
  if (understanding.durationDays != null) return false;

  const text = normalizeMessageText(message);
  if (!text) return false;
  if (isGenericBrowseListAsk(text)) return false;

  if (/\b(?:options?|list)\s+mein\s+hai\b/i.test(text)) return true;

  if (/\bhai\s*\??$/i.test(text)) {
    if (/\b(kitna|kitni|kitne|rent|kiraya|price|rate|din|day|days|book)\b/i.test(text)) {
      return false;
    }
    if (/\bkya\s+kya\b/i.test(text)) return false;
    return true;
  }

  return false;
}

/**
 * Browse vs item-specific availability — reuses understanding signals first,
 * then safe generic list patterns when no explicit catalog item is resolved.
 *
 * @param {TurnUnderstanding} understanding
 * @param {string} message
 * @returns {boolean}
 */
export function isBrowseWorkflowIntent(understanding, message) {
  if (understanding.signals?.browseAsk) return true;
  if (understanding.intentsRanked?.[0] === "browse_options") return true;

  if (understanding.itemSource === "explicit" && understanding.resolvedItemId) {
    return false;
  }

  const text = normalizeMessageText(message);
  if (!text) return false;

  return isGenericBrowseListAsk(text);
}

/**
 * @param {TurnUnderstanding} understanding
 * @param {string} message
 * @returns {boolean}
 */
export function isAvailabilityInquiryIntent(understanding, message) {
  if (isBrowseWorkflowIntent(understanding, message)) return false;
  if (!understanding.resolvedItemId) return false;

  if (
    Boolean(understanding.signals?.availabilityAsk) ||
    understanding.askedField === "availability" ||
    understanding.intentsRanked?.[0] === "availability_check"
  ) {
    return true;
  }

  return isExplicitItemAvailabilityPhrasing(understanding, message);
}

/**
 * @param {TurnUnderstanding} understanding
 * @param {string} message
 * @returns {boolean}
 */
export function isUnlistedAvailabilityIntent(understanding, message) {
  if (isBrowseWorkflowIntent(understanding, message)) return false;
  if (understanding.resolvedItemId) return false;

  const clearBusinessIntentSignal =
    Boolean(understanding.signals?.availabilityAsk) ||
    Boolean(understanding.signals?.priceAsk) ||
    Boolean(understanding.signals?.bookingCommitment) ||
    Boolean(understanding.signals?.photoAsk) ||
    understanding.askedField === "availability" ||
    String(understanding.askedField ?? "").startsWith("price") ||
    understanding.askedField === "media" ||
    understanding.intentsRanked?.[0] === "availability_check";

  if (!clearBusinessIntentSignal) return false;
  return Boolean(String(understanding.unlistedMentionLabel ?? "").trim());
}
