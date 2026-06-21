import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @returns {ActionPlan}
 */
export function buildGreetingActionPlan() {
  const replyDraft =
    "Assalam o Alaikum! Main Emily hun — availability, price, ya booking mein help kar sakti hun. Batayein kis gaari ke liye dekh rahe hain?";
  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          execute: false,
        }),
      }),
    ]),
  });
}
