/**
 * Canonical wording for a matched catalog item whose price is unset.
 * Delegates to the shared response-act composer.
 */
import { composeCloudCanonicalCustomerReply } from "./composeCloudCanonicalCustomerReply.js";
import { buildCanonicalGroupResponseContract } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";

const SUPPORTED_INTENTS = new Set(["pricing_inquiry", "pricing_with_duration"]);

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

export async function composeMissingCatalogFactCustomerReply(p = {}) {
  const semanticIntent = clean(p.semanticIntent, 80);
  const itemLabel = clean(p.itemLabel, 160);
  if (!SUPPORTED_INTENTS.has(semanticIntent) || !itemLabel) {
    return {
      ok: false,
      reply: "",
      source: "missing_catalog_fact_compose_fail_closed",
      reason: "INVALID_TRUSTED_FACTS",
    };
  }
  const facts = {
    itemLabel,
    customerReference: itemLabel,
    catalogMatchStatus: "matched",
    requestedFactStatus: "missing",
  };
  const channel = String(p.channel ?? "").trim() === "group" ? "group" : "dm";
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "missing_catalog_price",
    channel,
    semanticIntent,
    customerMessage: p.customerMessage,
    trustedFacts: facts,
    responseContract: buildCanonicalGroupResponseContract({
      replyKind: "missing_catalog_price",
      trustedCustomerFacts: facts,
      customerMessageText: p.customerMessage,
    }),
    fallbackReply: sameActFallbackReply("missing_catalog_price", facts),
    timeoutMs: p.timeoutMs ?? 8000,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
    __languageQualityReviewChatCreateForTests:
      p.__languageQualityReviewChatCreateForTests ?? null,
  });
  return {
    ...composed,
    source: composed.ok
      ? composed.source
      : composed.reply
        ? composed.source
        : "missing_catalog_fact_compose_fail_closed",
  };
}
