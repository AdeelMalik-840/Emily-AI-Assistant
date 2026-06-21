import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * Contact detected during booking flow — reply only; booking mutation blocked by default.
 *
 * @param {{ admittedTurn: AdmittedTurn, contactPhone: string }} params
 * @returns {ActionPlan}
 */
export function buildContactCollectionActionPlan({ admittedTurn, contactPhone }) {
  const phone = String(contactPhone ?? "").trim();
  const replyDraft = phone
    ? "Shukriya — contact note kar liya. Main confirm kar ke bata deti hun."
    : "Apna contact number share kar dein taake main booking confirm kar sakun.";
  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          contactPhone: phone || null,
          execute: false,
        }),
      }),
      Object.freeze({
        type: "UPDATE_STATE",
        payload: Object.freeze({
          stage: "contact_received",
          contactPhone: phone || null,
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberContactPhone: Boolean(phone),
      contactPhone: phone || null,
      execute: false,
    }),
  });
}

/**
 * @returns {ActionPlan}
 */
export function buildContactRequestActionPlan() {
  const replyDraft = "Booking confirm karne ke liye apna contact number share kar dein please.";
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
