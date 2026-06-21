import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {{ reason?: string, replyDraft?: string }} [params]
 * @returns {ActionPlan}
 */
export function buildClarificationActionPlan(params = {}) {
  const reason = String(params.reason ?? "unknown").trim() || "unknown";
  const replyDraft =
    String(params.replyDraft ?? "").trim() ||
    "Main samajh nahi paaya — kya aap availability, price, ya booking ke baare mein pooch rahe hain? Kis item ke liye dekh rahe hain?";
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
