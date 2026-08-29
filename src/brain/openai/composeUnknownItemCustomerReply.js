/**
 * Wording-only response for a canonical bounded referent that did not match
 * the trusted catalog. Semantic intent and referent identity are inputs, not
 * inferred here. No catalog alternatives are supplied to the model.
 */
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  CUSTOMER_CLAIMS,
  buildCustomerReplyContract,
} from "../contracts/customerReplyContract.js";
import { composeGuardedCustomerReply } from "./composeGuardedCustomerReply.js";
import {
  buildStrictJsonSchemaResponseFormat,
  REPLY_SEMANTICS_SCHEMA,
} from "./strictJsonSchema.js";

const SUPPORTED_INTENTS = new Set([
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
  "details_inquiry",
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
  const replyContract = buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Naturally tell the customer, as an ordinary business fact, that this specific item/vehicle is not one you have — so its requested details (price, availability, etc.) are not something you can share right now. Never claim it is unavailable, out of stock, or invalid, and never describe this as an internal system, catalog, or verification concept.",
    verifiedCustomerFacts: {
      requestedReferent: itemLabel,
      catalogMatchStatus: "not_matched",
      semanticIntent,
      verifiedAlternatives: [],
      availabilityResolved: false,
    },
    allowedClaims: [],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    customerMessageText: clean(p.customerMessage, 300) || null,
  });
  let mentionedReferents = [];
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "unknown_item_customer_reply",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        mentionedReferents: { type: "array", items: { type: "string" }, maxItems: 1 },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: ["customerReply", "mentionedReferents", "replySemantics"],
    }
  );
  const composed = await composeGuardedCustomerReply({
    system: `${buildCustomerCommunicationPolicy({ channel: "dm" })}

WORDING-ONLY UNKNOWN-REFERENT COMPOSER:
- Use only TRUSTED_FACTS_JSON. Do not reinterpret semanticIntent.
- catalogMatchStatus="not_matched" means this business does not have that specific item — a plain business fact, not proof it is unavailable/out of stock.
- Do not invent or quote price, availability, booking state, catalog items, or alternatives.
- Do not offer or name any alternative item.
- Naturally tell the customer you don't have that specific item, so this question can't be answered — as a real person would say it. Never say "catalog", "verify"/"verified", "trusted", "match", "canonical", "database", or any other internal/system word.
- mentionedReferents must exhaustively list every item/service label named in customerReply and may contain only the exact requestedReferent.
- Return strict JSON only.`,
    userBase: `TRUSTED_FACTS_JSON: ${JSON.stringify({ semanticIntent, requestedReferent: itemLabel, catalogMatchStatus: "not_matched", verifiedAlternatives: [] })}`,
    firstAttemptReminder: "Address only the requested referent and requested intent; do not add alternatives.",
    responseFormatName: "unknown_item_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (_reply, parsed) => {
      const labels = Array.isArray(parsed?.mentionedReferents)
        ? parsed.mentionedReferents.map((value) => clean(value, 160)).filter(Boolean)
        : [];
      if (labels.length !== 1 || labels[0] !== itemLabel) return "UNKNOWN_ITEM_REFERENT_COVERAGE_INVALID";
      mentionedReferents = labels;
      return null;
    },
    fallbackReply: "",
    timeoutMs: p.timeoutMs ?? 8000,
    timeoutErrorMessage: "UNKNOWN_ITEM_COMPOSE_TIMEOUT",
    temperature: 0.3,
    maxTokens: 180,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
  });
  return {
    ...composed,
    reply: composed.ok ? clean(composed.reply, 500) : "",
    source: composed.ok ? "openai_unknown_item_compose" : "unknown_item_compose_fail_closed",
    mentionedReferents,
  };
}
