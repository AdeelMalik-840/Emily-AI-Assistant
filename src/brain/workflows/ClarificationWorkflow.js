import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * Used only when the customer input is genuinely underspecified.
 * Must never send for a catalog NOT_MATCHED / off-catalog item — that is
 * INFORM_ITEM_NOT_IN_CATALOG via item_not_in_catalog.
 */
export function buildClarificationActionPlan(params = {}) {
  const reason = String(params.reason ?? "unknown").trim() || "unknown";
  const itemLabel = String(params.itemLabel ?? "").trim();
  let replyDraft = String(params.replyDraft ?? "").trim();
  if (!replyDraft) {
    if (reason === "grounded_known_item_ask_what" && itemLabel) {
      replyDraft = `${itemLabel} ke baare mein kya dekhna hai — availability, price, ya booking?`;
    } else if (reason === "grounded_item_disambiguation") {
      replyDraft =
        "Kaunsa item dekh rahe hain? Catalog mein ek se zyada match hain.";
    } else {
      replyDraft =
        "Main samajh nahi paaya — kya aap availability, price, ya booking ke baare mein pooch rahe hain? Kis item ke liye dekh rahe hain?";
    }
  }
  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          clarificationReason: reason,
          execute: false,
        }),
      }),
    ]),
  });
}
