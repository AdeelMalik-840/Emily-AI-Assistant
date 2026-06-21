import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {string} label
 * @param {string} [conversationStyle]
 * @returns {string}
 */
function buildUnlistedItemReplyDraft(label, conversationStyle = "casual_local") {
  const itemLabel = String(label ?? "yeh option").trim() || "yeh option";
  if (conversationStyle === "casual_local") {
    return `Sorry, ${itemLabel} hamari list mein nahi hai. Kya aap koi aur available option dekhna chahenge?`;
  }
  return `Sorry, ${itemLabel} is not listed in our available options. Would you like to see what we currently have?`;
}

/**
 * Candidate action plan only — does not book or notify owner.
 *
 * @param {{
 *   understanding: TurnUnderstanding,
 *   conversationStyle?: string,
 * }} params
 * @returns {ActionPlan}
 */
export function buildUnlistedItemActionPlan({ understanding, conversationStyle = "casual_local" }) {
  const label =
    String(understanding.unlistedMentionLabel ?? "").trim() ||
    String(understanding.ambiguities?.find((a) => a.startsWith("unlisted:")) ?? "")
      .replace(/^unlisted:/, "")
      .trim() ||
    "yeh option";

  const replyDraft = buildUnlistedItemReplyDraft(label, conversationStyle);

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
