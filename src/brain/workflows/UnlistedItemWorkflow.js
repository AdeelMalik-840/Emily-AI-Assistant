import { randomUUID } from "node:crypto";
import { stampCanonicalGroupResponseAct } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";

/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {string} label
 * @returns {string}
 */
function buildUnlistedItemReplyDraft(label) {
  const itemLabel = String(label ?? "").trim();
  return sameActFallbackReply("item_not_in_catalog", {
    itemLabel,
    requestedReferent: itemLabel,
    verifiedAvailableAlternatives: [],
  });
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

  const replyDraft = buildUnlistedItemReplyDraft(label);

  return Object.freeze({
    planId: randomUUID(),
    workflowType: "item_not_in_catalog",
    replyDraft,
    customerResponseComposition: stampCanonicalGroupResponseAct({
      lane: "catalog_fact",
      kind: "item_not_in_catalog",
      requestedReferent: label,
    }),
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
