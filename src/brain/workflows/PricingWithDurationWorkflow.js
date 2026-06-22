import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
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
 * @returns {string}
 */
function formatMoneyAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "");
  return n.toLocaleString("en-PK");
}

/**
 * @param {Record<string, unknown> | null | undefined} priceQuote
 * @returns {boolean}
 */
function hasCanonicalPriceQuoteFacts(priceQuote) {
  return (
    priceQuote != null &&
    typeof priceQuote === "object" &&
    !Array.isArray(priceQuote) &&
    "status" in priceQuote
  );
}

/**
 * @param {string} itemLabel
 * @param {Record<string, unknown>} priceQuote
 * @param {string} message
 * @returns {string}
 */
export function buildPriceQuoteReplyFromCanonical(itemLabel, priceQuote, message = "") {
  const label = String(itemLabel ?? "").trim();
  const durationDays = Number(priceQuote.durationDays);
  const total = Number(priceQuote.total);
  const dailyRate = Number(priceQuote.dailyRate);
  const currency = String(priceQuote.currency ?? "PKR").trim() || "PKR";

  if (
    !Number.isFinite(durationDays) ||
    durationDays < 1 ||
    !Number.isFinite(total) ||
    !Number.isFinite(dailyRate)
  ) {
    return MISSING_PRICE_REPLY;
  }

  const totalStr = `${formatMoneyAmount(total)} ${currency}`;
  const dailyStr = `${formatMoneyAmount(dailyRate)} ${currency}`;
  const asksTotal =
    /\b(total|overall)\b/i.test(String(message ?? "")) ||
    /\b(kitna\s+banega|kitna\s+banta|overall\s+kitna)\b/i.test(String(message ?? ""));

  if (asksTotal) {
    return `${durationDays} din ka total rent ${totalStr} hoga.`;
  }

  const prefix = label ? `${label} ki ` : "";
  return `${prefix}${durationDays} din ki rent ${totalStr} hogi (${dailyStr} per din).`;
}

/**
 * @param {{
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   priceQuote: Record<string, unknown>,
 * }} p
 */
export function logCanonicalPriceQuoteUsed(p) {
  console.log("[canonical_price_quote_used]", {
    workflowType: "pricing_with_duration",
    itemId: String(p.itemId ?? "").trim() || null,
    itemLabel: String(p.itemLabel ?? "").trim() || null,
    pricingType: "duration_quote",
    durationDays: p.priceQuote?.durationDays ?? null,
    currency: p.priceQuote?.currency ?? null,
    source: p.priceQuote?.source ?? null,
    hasPrice: p.priceQuote?.dailyRate != null,
    hasTotal: p.priceQuote?.total != null,
  });
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

  const canonicalPriceQuote =
    businessContext?.resolvedBusinessTurnContext?.verified?.priceQuote ?? null;

  let replyDraft = "";
  let source = "verified_catalog";

  if (hasCanonicalPriceQuoteFacts(canonicalPriceQuote)) {
    const priceQuote = /** @type {Record<string, unknown>} */ (canonicalPriceQuote);
    if (
      priceQuote.status === "resolved" &&
      priceQuote.total != null &&
      priceQuote.durationDays != null
    ) {
      logCanonicalPriceQuoteUsed({ itemId, itemLabel, priceQuote });
      replyDraft = buildPriceQuoteReplyFromCanonical(itemLabel, priceQuote, message);
      source = "canonical_verified_price_quote";
    } else if (priceQuote.status === "missing") {
      logCanonicalPriceQuoteUsed({ itemId, itemLabel, priceQuote });
      replyDraft = MISSING_PRICE_REPLY;
      source = "canonical_verified_price_quote_missing";
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
        askedField: "price_with_duration",
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
      askedField: "price_with_duration",
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
          field: "price_with_duration",
          itemId,
          durationDays: understanding.durationDays ?? null,
          source,
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
