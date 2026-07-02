import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function catalogOptionName(row) {
  const name = String(row?.name ?? "").trim();
  if (name) return name;
  return String(row?.displayLabel ?? "").trim();
}

/**
 * @param {unknown[]} catalogItems
 * @returns {string[]}
 */
function catalogOptionNames(catalogItems) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(catalogItems) ? catalogItems : []) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const label = catalogOptionName(/** @type {Record<string, unknown>} */ (row));
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

/**
 * @param {string[]} labels
 * @returns {string}
 */
function formatOptionList(labels) {
  const clean = labels.map((label) => String(label ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} ya ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} ya ${clean[clean.length - 1]}`;
}

/**
 * @param {string} label
 * @param {unknown[]} catalogItems
 * @returns {string}
 */
function buildUnlistedItemReplyDraft(label, catalogItems = []) {
  const itemLabel = String(label ?? "").trim() || "Ye";
  const options = formatOptionList(catalogOptionNames(catalogItems));
  if (!options) {
    return "Ye filhal hamare paas available nahi hai. Koi aur item check kar dun?";
  }
  return `${itemLabel} filhal hamare paas nahi hai. ${options} mein se koi check kar dun?`;
}

/**
 * Candidate action plan only — does not book or notify owner.
 *
 * @param {{
 *   understanding: TurnUnderstanding,
 *   conversationStyle?: string,
 *   catalogItems?: unknown[],
 * }} params
 * @returns {ActionPlan}
 */
export function buildUnlistedItemActionPlan({
  understanding,
  conversationStyle = "casual_local",
  catalogItems = [],
}) {
  const label =
    String(understanding.unlistedMentionLabel ?? "").trim() ||
    String(understanding.ambiguities?.find((a) => a.startsWith("unlisted:")) ?? "")
      .replace(/^unlisted:/, "")
      .trim() ||
    "Ye";

  const replyDraft =
    conversationStyle === "casual_local"
      ? buildUnlistedItemReplyDraft(label, catalogItems)
      : buildUnlistedItemReplyDraft(label, catalogItems);

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "unlisted_item",
          unlistedLabel: label,
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearResolvedItem: true,
      reason: "unlisted_item_mention",
      execute: false,
    }),
  });
}
