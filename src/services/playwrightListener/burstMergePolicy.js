import {
  findConservativeFuzzyCatalogMention,
  hasExplicitNewItemMention,
} from "../currentTurnAuthority.js";

const AVAILABILITY_QUESTION_RE = /\b(avail|available)\b/i;
const BURST_ITEM_STOPWORDS = new Set([
  "available",
  "avail",
  "hai",
  "rent",
  "for",
  "kya",
  "kitna",
  "kitne",
  "days",
  "din",
  "day",
  "the",
  "and",
  "with",
  "this",
  "that",
  "what",
  "when",
  "where",
  "please",
  "booking",
  "book",
]);

function normalizeBurstMatchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPunctuationOnlyBurstText(text) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^[\s\W]+$/.test(raw);
}

/**
 * Short punctuation that may burst-merge after a meaningful line (never forwarded alone).
 * @param {unknown} text
 */
export function isBurstMergeContinuationText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return false;
  if (/^[?]+$/.test(trimmed)) return true;
  return isPunctuationOnlyBurstText(trimmed);
}

function primaryDistinctTokens(message) {
  return normalizeBurstMatchText(message)
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !BURST_ITEM_STOPWORDS.has(token));
}

function looksLikeItemAvailabilityQuestion(message) {
  const trimmed = String(message ?? "").trim();
  if (!trimmed || isBurstMergeContinuationText(trimmed)) return false;
  return AVAILABILITY_QUESTION_RE.test(trimmed) || /\?\s*$/.test(trimmed);
}

/**
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 * @returns {string | null}
 */
function resolveMessageCatalogItemId(message, catalogItems) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  if (!items.length) return null;
  const explicit = hasExplicitNewItemMention(message, items, null);
  if (explicit.found && explicit.itemId) return explicit.itemId;
  const fuzzy = findConservativeFuzzyCatalogMention(message, items);
  if (fuzzy.found && !fuzzy.ambiguous && fuzzy.itemId) return fuzzy.itemId;
  return null;
}

function tokensOverlap(tokensA, tokensB) {
  for (const tokenA of tokensA) {
    for (const tokenB of tokensB) {
      if (tokenA === tokenB) return true;
      if (tokenA.length >= 4 && tokenB.length >= 4) {
        if (tokenA.includes(tokenB) || tokenB.includes(tokenA)) return true;
      }
    }
  }
  return false;
}

/**
 * Durable WhatsApp Web data-id from an extracted row (not synthetic fallbacks).
 * @param {object | null | undefined} row
 * @returns {string}
 */
export function resolveDurableWhatsAppDataId(row) {
  const fromId =
    row?.id?._serialized ||
    row?._data?.id?._serialized ||
    row?.id?.id ||
    row?._data?.id?.id;
  if (fromId != null && String(fromId).trim() !== "") {
    return String(fromId).trim();
  }
  const direct = String(row?.dataId ?? "").trim();
  return direct || "";
}

/**
 * Two rows with different real WhatsApp data-ids are independent turns.
 * @param {object | null | undefined} rowA
 * @param {object | null | undefined} rowB
 */
export function hasDistinctDurableWhatsAppIds(rowA, rowB) {
  const a = resolveDurableWhatsAppDataId(rowA);
  const b = resolveDurableWhatsAppDataId(rowB);
  return Boolean(a && b && a !== b);
}

/**
 * Whether two adjacent participant rows may be burst-merged.
 * @param {object | null | undefined} rowA
 * @param {object | null | undefined} rowB
 * @param {unknown[]} [catalogItems]
 */
export function canMergeBurstRowPair(rowA, rowB, catalogItems = []) {
  const textA = String(rowA?.text ?? "").trim();
  const textB = String(rowB?.text ?? "").trim();
  if (!textA || !textB) return false;

  if (isBurstMergeContinuationText(textB) || isPunctuationOnlyBurstText(textB)) {
    return true;
  }

  // Distinct real WhatsApp IDs are independent admitted turns — never merge
  // meaningful bodies together (punctuation continuations handled above).
  if (hasDistinctDurableWhatsAppIds(rowA, rowB)) {
    return false;
  }

  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const idA = resolveMessageCatalogItemId(textA, items);
  const idB = resolveMessageCatalogItemId(textB, items);

  if (idA && idB && idA !== idB) return false;

  if (idA && items.length) {
    const newInB = hasExplicitNewItemMention(textB, items, idA);
    if (newInB.found && newInB.itemId && newInB.itemId !== idA) return false;
  }

  if (
    looksLikeItemAvailabilityQuestion(textA) &&
    looksLikeItemAvailabilityQuestion(textB)
  ) {
    if (idA && idB && idA !== idB) return false;
    const tokensA = primaryDistinctTokens(textA);
    const tokensB = primaryDistinctTokens(textB);
    if (tokensA.length && tokensB.length && !tokensOverlap(tokensA, tokensB)) {
      return false;
    }
    return false;
  }

  return true;
}

/**
 * Whether guarantee-first walk-forward should skip an older row for a newer same-participant row.
 * @param {object | null | undefined} olderRow
 * @param {object | null | undefined} newerRow
 * @param {unknown[]} [catalogItems]
 */
export function shouldBurstSupersedeOlderRow(olderRow, newerRow, catalogItems = []) {
  // Never drop an older durable WhatsApp ID in favor of a newer distinct one.
  if (hasDistinctDurableWhatsAppIds(olderRow, newerRow)) {
    return false;
  }

  if (canMergeBurstRowPair(olderRow, newerRow, catalogItems)) return true;

  const textA = String(olderRow?.text ?? "").trim();
  const textB = String(newerRow?.text ?? "").trim();
  if (
    !looksLikeItemAvailabilityQuestion(textA) ||
    !looksLikeItemAvailabilityQuestion(textB)
  ) {
    return false;
  }

  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const idA = resolveMessageCatalogItemId(textA, items);
  const idB = resolveMessageCatalogItemId(textB, items);
  if (idA && idB && idA !== idB) return false;

  const tokensA = primaryDistinctTokens(textA);
  const tokensB = primaryDistinctTokens(textB);
  if (tokensA.length && tokensB.length && !tokensOverlap(tokensA, tokensB)) {
    return false;
  }

  return true;
}

/**
 * @param {unknown} catalogItems
 * @returns {unknown[]}
 */
export function resolveBurstMergeCatalogItems(catalogItems) {
  if (Array.isArray(catalogItems)) return catalogItems;
  const globalCatalog = globalThis.__playwrightBurstMergeCatalogItems;
  return Array.isArray(globalCatalog) ? globalCatalog : [];
}
