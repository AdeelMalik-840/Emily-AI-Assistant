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
  const replyContract = buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Communicate that the requested item is one you do not have, so the requested fact (price, availability, images, etc.) is not something you can share — never ask the customer to supply, confirm, or repeat that same fact themselves.",
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
        customerInputRequested: {
          type: "boolean",
          description:
            "True only if customerReply asks the customer a new question to get information FROM them. This composer's only job is telling the customer a requested fact is unavailable because the item is not one you have — it must never ask the customer to supply, confirm, or repeat that same fact. Must be false.",
        },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: ["customerReply", "mentionedReferents", "customerInputRequested", "replySemantics"],
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
- The customer already asked you for this fact (semanticIntent). Your reply communicates that you cannot answer it because you do not have the item — it must NEVER turn the customer's own question back on them (e.g. do not ask "what is the price?", "is it available?", or any rephrasing of the same ask as a question to the customer). Set customerInputRequested=false; it must always be false for this composer.
- mentionedReferents must exhaustively list every item/service label named in customerReply and may contain only the exact requestedReferent.
- Return strict JSON only.`,
    userBase: `TRUSTED_FACTS_JSON: ${JSON.stringify({ semanticIntent, requestedReferent: itemLabel, catalogMatchStatus: "not_matched", verifiedAlternatives: [] })}`,
    firstAttemptReminder: "Address only the requested referent and requested intent; do not add alternatives.",
    responseFormatName: "unknown_item_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (_reply, parsed) => {
      // This composer's only job is to communicate that a fact is unavailable
      // because the item is unknown -- it must never ask the customer a
      // question, especially not one that merely reflects their own ask
      // back at them (the proven live failure: "Swift ka rent kitna hai?"
      // answered with "Swift ka price kya hai?").
      if (parsed?.customerInputRequested === true) {
        return "UNKNOWN_ITEM_REPLY_MUST_NOT_ASK_CUSTOMER_FOR_INFO";
      }
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
