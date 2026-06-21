import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {string} itemLabel
 * @param {number | undefined} durationDays
 * @returns {string}
 */
function buildGroupBookingAckDraft(itemLabel, durationDays) {
  const label = String(itemLabel ?? "item").trim() || "item";
  const days = Number.isFinite(Number(durationDays)) ? Math.max(1, Math.floor(Number(durationDays))) : null;
  const durationPart = days != null ? `${days} din ` : "";
  return `Perfect 👍 ${label} ${durationPart}ke liye note kar liya. Main confirm kar ke bata deta hun.`;
}

/**
 * Candidate action plan only — does not create booking or notify owner live.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   understanding: TurnUnderstanding,
 * }} params
 * @returns {ActionPlan}
 */
export function buildBookingRequestActionPlan({ admittedTurn, understanding }) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const itemLabel = String(understanding.resolvedItemLabel ?? "item").trim() || "item";
  const replyDraft = buildGroupBookingAckDraft(itemLabel, understanding.durationDays);

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          groupSafeBookingAck: true,
          execute: false,
        }),
      }),
      Object.freeze({
        type: "CREATE_BOOKING",
        payload: Object.freeze({
          itemId: understanding.resolvedItemId ?? null,
          itemLabel,
          durationDays: understanding.durationDays ?? null,
          sourceMessage: message,
          approvalStage: "pending_owner_approval",
          execute: false,
        }),
      }),
      Object.freeze({
        type: "NOTIFY_OWNER",
        payload: Object.freeze({
          reason: "booking_pending_owner_approval",
          itemId: understanding.resolvedItemId ?? null,
          execute: false,
        }),
      }),
      Object.freeze({
        type: "UPDATE_STATE",
        payload: Object.freeze({
          clearPendingAction: true,
          pendingActionType: "collect_duration",
          stage: "pending_owner_approval",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      bookingIntent: true,
      ownerApprovalRequired: true,
      execute: false,
    }),
  });
}
