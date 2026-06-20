/**
 * Detect likely unlisted catalog mentions for availability questions.
 */
import {
  extractEntity,
  getEntityConfidenceThreshold,
} from "../../services/entityExtraction.js";
import { hasExplicitNewItemMention } from "../../services/currentTurnAuthority.js";

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

  for (const row of items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const hay = `${String(row.name ?? "")} ${String(row.displayLabel ?? "")}`.toLowerCase();
    if (hay.includes(token)) return null;
    if (
      token.length >= 4 &&
      hay
        .split(/\s+/)
        .filter(Boolean)
        .some((word) => word.startsWith(token.slice(0, 4)))
    ) {
      return null;
    }
  }

  return cleaned.split(/\s+/).filter(Boolean)[0] ?? cleaned;
}
