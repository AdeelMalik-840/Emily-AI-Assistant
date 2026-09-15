import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

const MISSING_PRICE_REPLY = "Rate confirm kar ke bata deta hun 👍";

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
 * @param {number | null | undefined} amount
 * @param {string} currency
 * @returns {string}
 */
function formatCanonicalAmount(amount, currency) {
  const n = Number(amount);
  const cur = String(currency ?? "PKR").trim() || "PKR";
  if (!Number.isFinite(n)) return "";
  return `${n.toLocaleString("en-PK")} ${cur}`;
}

/**
 * @param {Record<string, unknown> | null | undefined} pricing
 * @returns {boolean}
 */
function hasCanonicalPricingFacts(pricing) {
  return (
    pricing != null &&
    typeof pricing === "object" &&
    !Array.isArray(pricing) &&
    "status" in pricing
  );
}

/**
 * @param {Record<string, unknown>} pricing
 * @returns {"daily" | "monthly" | "summary" | "missing"}
 */
function resolveCanonicalPricingType(pricing) {
  const daily = pricing.daily;
  const monthly = pricing.monthly;
  if (daily != null && monthly != null) return "summary";
  if (daily != null) return "daily";
  if (monthly != null) return "monthly";
  return "missing";
}

/**
 * @param {string} itemLabel
 * @param {Record<string, unknown>} pricing
 * @returns {string}
 */
export function buildPricingReplyFromCanonical(itemLabel, pricing) {
  const label = String(itemLabel ?? "").trim();
  const currency = String(pricing.currency ?? "PKR").trim() || "PKR";
  const daily = pricing.daily;
  const monthly = pricing.monthly;
  const dailyAmt = formatCanonicalAmount(
    typeof daily === "number" ? daily : null,
    currency
  );
  const monthlyAmt = formatCanonicalAmount(
    typeof monthly === "number" ? monthly : null,
    currency
  );

  if (dailyAmt && monthlyAmt) {
    return label
      ? `${label} ka rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`
      : `Rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`;
  }
  if (dailyAmt) {
    return label ? `${label} ka rent ${dailyAmt} per day hai.` : `${dailyAmt} per day hai.`;
  }
  if (monthlyAmt) {
    return label
      ? `${label} ka monthly rent ${monthlyAmt} hai.`
      : `Monthly rent ${monthlyAmt} hai.`;
  }
  return MISSING_PRICE_REPLY;
}

/**
 * @param {{
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   pricing: Record<string, unknown>,
 * }} p
 */
export function logCanonicalPricingUsed(p) {
  const pricingType = resolveCanonicalPricingType(p.pricing);
  console.log("[canonical_pricing_used]", {
    workflowType: "pricing_inquiry",
    itemId: String(p.itemId ?? "").trim() || null,
    itemLabel: String(p.itemLabel ?? "").trim() || null,
    pricingType,
    currency: p.pricing?.currency ?? null,
    source: p.pricing?.source ?? null,
    hasPrice: p.pricing?.hasPricing === true,
  });
}

/**
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   understanding: TurnUnderstanding,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildPricingInquiryActionPlan({
  admittedTurn,
  understanding,
  catalogItems = [],
  businessContext = null,
}) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const rawItem = findCatalogItemById(catalogItems, understanding.resolvedItemId);
  const itemLabel =
    String(
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
        understanding.resolvedItemLabel ??
        rawItem?.displayLabel ??
        rawItem?.name ??
        ""
    ).trim() || "item";
  const itemId = String(
    understanding.resolvedItemId ??
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.id ??
      ""
  ).trim() || null;

  const canonicalPricing =
    businessContext?.resolvedBusinessTurnContext?.verified?.pricing ?? null;

  let replyDraft = "";
  let source = "verified_catalog";

  if (hasCanonicalPricingFacts(canonicalPricing)) {
    const pricing = /** @type {Record<string, unknown>} */ (canonicalPricing);
    if (pricing.status === "resolved" && pricing.hasPricing === true) {
      logCanonicalPricingUsed({ itemId, itemLabel, pricing });
      replyDraft = buildPricingReplyFromCanonical(itemLabel, pricing);
      source = "canonical_verified_pricing";
    } else if (pricing.status === "missing") {
      logCanonicalPricingUsed({ itemId, itemLabel, pricing });
      replyDraft = MISSING_PRICE_REPLY;
      source = "canonical_verified_pricing_missing";
    } else {
      const item = rawItem;
      const composed = composeInformationalAnswer({
        message,
        draftReply: "",
        item,
        businessContext:
          businessContext?.businessProfile != null
            ? businessContext.businessProfile
            : businessContext,
        askedField: "price",
      });
      replyDraft = String(composed?.reply ?? "").trim();
      source = composed?.source ?? "verified_catalog";
    }
  } else {
    const item = rawItem;
    const composed = composeInformationalAnswer({
      message,
      draftReply: "",
      item,
      businessContext:
        businessContext?.businessProfile != null
          ? businessContext.businessProfile
          : businessContext,
      askedField: "price",
    });
    replyDraft = String(composed?.reply ?? "").trim();
    source = composed?.source ?? "verified_catalog";
  }

  return Object.freeze({
    planId: randomUUID(),
    replyDraft: replyDraft || undefined,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "price",
          itemId,
          itemLabel,
          source,
          presentedItemIds: Object.freeze(itemId ? [itemId] : []),
          execute: false,
        }),
      }),
    ]),
    // A plain, single-item price answer names the item directly — a normal
    // itemless follow-up should validly bind back to it.
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      rememberPresentedItemFocus: Boolean(itemId),
      presentedItemId: itemId,
      presentedItemLabel: itemLabel,
      // Belts-and-suspenders with orchestrator merge: elliptical "or N din ka?"
      // after this answer must see lastTransactionalSemanticIntent=pricing_*.
      rememberTransactionalSemanticIntent: true,
      transactionalSemanticIntent: "pricing_inquiry",
      // A completed price answer ends any open availability NEED_DURATION
      // pending for this session participant (same or stale other item).
      clearEmilyPending: true,
      execute: false,
    }),
  });
}
