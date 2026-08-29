import { randomUUID } from "node:crypto";
import { extractCatalogImageUrls } from "../facts/resolveMediaFacts.js";

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
 * Trusted catalog images only. Never invents URLs.
 *
 * @param {{
 *   admittedTurn?: AdmittedTurn,
 *   understanding?: TurnUnderstanding,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildImageCatalogActionPlan({
  understanding,
  catalogItems = [],
  businessContext = null,
} = {}) {
  const itemId = String(
    understanding?.resolvedItemId ??
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.id ??
      ""
  ).trim() || null;
  const rawItem = findCatalogItemById(catalogItems, itemId);
  const mediaFacts =
    businessContext?.resolvedBusinessTurnContext?.verified?.media &&
    typeof businessContext.resolvedBusinessTurnContext.verified.media === "object"
      ? businessContext.resolvedBusinessTurnContext.verified.media
      : null;
  const fromFacts = Array.isArray(mediaFacts?.imageUrls)
    ? mediaFacts.imageUrls.map((url) => String(url ?? "").trim()).filter(Boolean)
    : [];
  const fromRow = extractCatalogImageUrls(rawItem);
  const imageUrls = [...new Set([...fromFacts, ...fromRow])];
  const itemLabel =
    String(
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
        understanding?.resolvedItemLabel ??
        rawItem?.displayLabel ??
        rawItem?.name ??
        ""
    ).trim() || "item";

  if (imageUrls.length === 0) {
    return Object.freeze({
      planId: randomUUID(),
      workflowType: "image_catalog_request",
      replyDraft: "",
      actions: Object.freeze([]),
      persistenceIntent: Object.freeze({
        rememberResolvedItem: Boolean(itemId),
        itemId,
        execute: false,
      }),
      missingTrustedMedia: true,
      itemId,
      itemLabel,
    });
  }

  const replyDraft = `${itemLabel} ki pictures yeh hain.`;
  return Object.freeze({
    planId: randomUUID(),
    workflowType: "image_catalog_request",
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_cloud",
          text: replyDraft,
          field: "media",
          itemId,
          itemLabel,
          whatsappImageUrls: Object.freeze([...imageUrls]),
          deliveryIntent: "show_images",
          source: "trusted_catalog_images",
          presentedItemIds: Object.freeze(itemId ? [itemId] : []),
          execute: false,
        }),
      }),
    ]),
    // Catalog photos were just sent for this exact, unambiguous item — a
    // normal itemless follow-up ("iska rent kitna hai?") should bind to it.
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      rememberPresentedItemFocus: Boolean(itemId),
      presentedItemId: itemId,
      presentedItemLabel: itemLabel,
      execute: false,
    }),
  });
}
