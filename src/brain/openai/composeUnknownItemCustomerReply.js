/**
 * Canonical wording for a specific current-turn referent that did not match
 * the trusted catalog. Delegates to the shared response-act composer.
 */
import { composeCloudCanonicalCustomerReply } from "./composeCloudCanonicalCustomerReply.js";
import { buildCanonicalGroupResponseContract } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";

const SUPPORTED_INTENTS = new Set([
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
  "details_inquiry",
  "general_business_question",
  "image_catalog_request",
]);

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

export async function composeUnknownItemCustomerReply(p = {}) {
  const semanticIntent = clean(p.semanticIntent, 80);
  const itemLabel = clean(p.itemLabel, 160);
  if (!SUPPORTED_INTENTS.has(semanticIntent) || !itemLabel) {
    return { ok: false, reply: "", source: "unknown_item_compose_fail_closed", reason: "INVALID_TRUSTED_FACTS" };
  }
  const verifiedAvailableAlternatives = Array.isArray(p.verifiedAvailableAlternatives)
    ? p.verifiedAvailableAlternatives
        .map((row) => ({
          itemId: clean(row?.itemId, 120),
          itemLabel: clean(row?.itemLabel ?? row?.displayLabel, 160),
        }))
        .filter((row) => row.itemId && row.itemLabel)
    : [];
  const facts = {
    itemLabel,
    requestedReferent: itemLabel,
    customerReference: itemLabel,
    catalogMatchStatus: "not_matched",
    verifiedAvailableAlternatives,
  };
  const channel = String(p.channel ?? "").trim() === "group" ? "group" : "dm";
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "item_not_in_catalog",
    channel,
    semanticIntent,
    customerMessage: p.customerMessage,
    trustedFacts: facts,
    responseContract: buildCanonicalGroupResponseContract({
      replyKind: "item_not_in_catalog",
      trustedCustomerFacts: facts,
      customerMessageText: p.customerMessage,
    }),
    fallbackReply: sameActFallbackReply("item_not_in_catalog", facts),
    timeoutMs: p.timeoutMs ?? 8000,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
    __languageQualityReviewChatCreateForTests:
      p.__languageQualityReviewChatCreateForTests ?? null,
  });
  return {
    ...composed,
    mentionedReferents: [itemLabel],
    source: composed.ok
      ? composed.source
      : composed.reply
        ? composed.source
        : "unknown_item_compose_fail_closed",
  };
}
