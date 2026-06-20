import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
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
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function normalizeItemForComposer(row) {
  const availability = row.availability;
  const isAvailable =
    typeof row.isAvailable === "boolean"
      ? row.isAvailable
      : availability !== false;
  return { ...row, isAvailable };
}

/**
 * @param {string} label
 * @param {string} reply
 * @returns {string}
 */
function ensureItemSpecificAvailabilityReply(label, reply) {
  const itemLabel = String(label ?? "").trim();
  const text = String(reply ?? "").trim();
  if (!itemLabel || !text) return text;
  const anchor = itemLabel.split(/\s+/).find((t) => t.length >= 4) ?? itemLabel;
  if (new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
    return text;
  }
  return `${itemLabel} ${text}`;
}

/**
 * Candidate action plan only — does not send, book, or notify owner.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   understanding: TurnUnderstanding,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildAvailabilityInquiryActionPlan({
  admittedTurn,
  understanding,
  catalogItems = [],
  businessContext = null,
}) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const rawItem = findCatalogItemById(catalogItems, understanding.resolvedItemId);
  const item = rawItem ? normalizeItemForComposer(rawItem) : null;
  const itemLabel =
    String(understanding.resolvedItemLabel ?? rawItem?.displayLabel ?? rawItem?.name ?? "").trim() ||
    "item";

  const composed = composeInformationalAnswer({
    message,
    draftReply: "",
    item,
    businessContext,
    askedField: "availability",
  });

  const replyDraft = ensureItemSpecificAvailabilityReply(
    itemLabel,
    String(composed?.reply ?? "").trim()
  );

  return Object.freeze({
    planId: randomUUID(),
    replyDraft: replyDraft || undefined,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId: understanding.resolvedItemId ?? null,
          itemLabel,
          source: composed?.source ?? "verified_catalog",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: understanding.resolvedItemId ?? null,
      execute: false,
    }),
  });
}
