import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function formatCatalogOptionLine(row) {
  const label = String(row.displayLabel ?? row.name ?? "").trim();
  if (!label) return "";
  const daily = row?.pricing?.daily ?? row?.pricePerDay ?? row?.dailyRate;
  if (daily != null && String(daily).trim() !== "") {
    return `- ${label} - ${daily} PKR/day`;
  }
  return `- ${label}`;
}

/**
 * @param {unknown[]} catalogItems
 * @returns {Record<string, unknown>[]}
 */
function listAvailableCatalogRows(catalogItems) {
  if (!Array.isArray(catalogItems)) return [];
  return catalogItems.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    if (typeof row.isAvailable === "boolean") return row.isAvailable;
    return row.availability !== false;
  });
}

/**
 * Candidate browse reply — lists available catalog options only.
 *
 * @param {{
 *   catalogItems?: unknown[],
 *   conversationStyle?: string,
 * }} params
 * @returns {string}
 */
export function buildBrowseOptionsReplyDraft({ catalogItems = [], conversationStyle = "casual_local" } = {}) {
  const available = listAvailableCatalogRows(catalogItems).slice(0, 5);
  if (available.length === 0) {
    return conversationStyle === "casual_local"
      ? "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?"
      : "I don't see another available option right now. Would you like to ask about a specific option?";
  }

  const heading = "Available options:";
  const ask =
    conversationStyle === "casual_local"
      ? "Konsa option dekhna chahenge?"
      : "Which option would you like to check?";
  const lines = available.map((row) => formatCatalogOptionLine(/** @type {Record<string, unknown>} */ (row))).filter(Boolean);
  return `${heading}\n${lines.join("\n")}\n\n${ask}`;
}

/**
 * @param {{
 *   catalogItems?: unknown[],
 *   conversationStyle?: string,
 * }} params
 * @returns {ActionPlan}
 */
export function buildBrowseOptionsActionPlan({ catalogItems = [], conversationStyle = "casual_local" }) {
  const replyDraft = buildBrowseOptionsReplyDraft({ catalogItems, conversationStyle });

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "browse_options",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearItemFocus: true,
      execute: false,
    }),
  });
}
