import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {unknown[]} catalogItems
 * @param {string | null | undefined} itemId
 * @returns {Record<string, unknown> | null}
 */
function findCatalogItemById(catalogItems, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id || !Array.isArray(catalogItems)) return null;
  const row = catalogItems.find((item) => String(item?.id ?? "").trim() === id);
  return row && typeof row === "object" && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/**
 * Candidate action plan only — does not send, book, or notify owner.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   understanding: TurnUnderstanding,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildPricingWithDurationActionPlan({
  admittedTurn,
  understanding,
  catalogItems = [],
  businessContext = null,
}) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const item = findCatalogItemById(catalogItems, understanding.resolvedItemId);
  const composed = composeInformationalAnswer({
    message,
    draftReply: "",
    item,
    businessContext,
    askedField: "price_with_duration",
  });

  const replyDraft = String(composed?.reply ?? "").trim();

  return Object.freeze({
    planId: randomUUID(),
    replyDraft: replyDraft || undefined,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "price_with_duration",
          itemId: understanding.resolvedItemId ?? null,
          durationDays: understanding.durationDays ?? null,
          source: composed?.source ?? "verified_catalog",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearPendingAction: true,
      pendingActionType: "collect_duration",
      reason: "pricing_with_duration_interrupt",
      execute: false,
    }),
  });
}
