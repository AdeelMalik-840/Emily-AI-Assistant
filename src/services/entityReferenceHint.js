/**
 * Hints for referential naturalness: avoid repeating full catalog labels when the
 * same item was already named in a recent **assistant** turn (not merely in session memory).
 */

/**
 * @param {unknown} matchedItem
 * @returns {string}
 */
export function labelFromMatchedItem(matchedItem) {
  if (matchedItem == null) return "";
  if (typeof matchedItem === "string") return matchedItem.trim();
  if (typeof matchedItem === "object" && !Array.isArray(matchedItem)) {
    const o = /** @type {Record<string, unknown>} */ (matchedItem);
    const d =
      typeof o.displayLabel === "string" && o.displayLabel.trim() !== ""
        ? o.displayLabel.trim()
        : "";
    if (d) return d;
    const n = typeof o.name === "string" ? o.name.trim() : "";
    const c = typeof o.color === "string" ? o.color.trim() : "";
    if (n && c) return `${n} (${c})`;
    return n || "";
  }
  return "";
}

const COLOR_WORDS = new Set([
  "white",
  "black",
  "gray",
  "grey",
  "red",
  "blue",
  "silver",
  "green",
  "brown",
  "petrol",
  "diesel",
  "automatic",
  "manual",
]);

/**
 * @param {string} labelLower
 * @returns {string[]}
 */
function significantTokens(labelLower) {
  return labelLower
    .split(/[\s()/,.-]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !COLOR_WORDS.has(w));
}

/**
 * Last N assistant message bodies from the plain-text history block.
 * @param {string} history
 * @param {number} maxMsgs
 * @returns {string}
 */
function extractLastAssistantMessages(history, maxMsgs) {
  const text = String(history ?? "").trim();
  if (!text) return "";
  const parts = text.split(/\n(?=User:|Assistant:)/i);
  /** @type {string[]} */
  const assistantContents = [];
  for (const p of parts) {
    const t = p.trim();
    if (/^assistant:/i.test(t)) {
      assistantContents.push(t.replace(/^assistant:\s*/i, "").trim());
    }
  }
  return assistantContents.slice(-maxMsgs).join("\n");
}

/**
 * True if a prior assistant turn already used the full label or enough of its
 * tokens that a follow-up can say "iska / ye / this" without sounding unclear.
 *
 * Uses **Conversation so far** only (last 1–2 assistant messages), not Thread
 * memory alone — memory can list "Item in focus" on the same turn as first mention.
 *
 * @param {string} history
 * @param {string} matchedLabel
 */
export function isEntityEstablishedInRecentThread(history, matchedLabel) {
  const label = String(matchedLabel ?? "").trim();
  if (!label) return false;

  const assistantBlob = extractLastAssistantMessages(history, 2).toLowerCase();
  if (!assistantBlob.trim()) return false;

  const labelL = label.toLowerCase();
  if (assistantBlob.includes(labelL)) return true;

  const tokens = significantTokens(labelL);
  if (tokens.length === 0) return false;

  const hits = tokens.filter((t) => assistantBlob.includes(t));
  if (tokens.length === 1) return hits.length === 1;
  return hits.length >= 2;
}
