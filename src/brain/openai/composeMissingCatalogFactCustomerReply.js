/**
 * Wording-only response for a MATCHED catalog item whose requested catalog
 * fact (currently: price) is genuinely absent from trusted facts. Distinct
 * from composeUnknownItemCustomerReply.js (the item itself is unknown) and
 * from the real PA missing-business-fact owner escalation (policy-type facts
 * like driver/delivery/documents/payment/advance that legitimately need a
 * live owner answer). A missing catalog field like price/rate is data the
 * owner configures once in the catalog, not a question an owner can usefully
 * answer live over chat and have it durably become the trusted fact for
 * future customers — so no owner-check/escalation is started here; this
 * composer only tells the customer, honestly and without a fake promise,
 * that the fact is not currently set.
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

const SUPPORTED_INTENTS = new Set(["pricing_inquiry", "pricing_with_duration"]);

function clean(value, max = 300) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {{
 *   semanticIntent: string,
 *   itemLabel: string,
 *   customerMessage?: string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 */
export async function composeMissingCatalogFactCustomerReply(p = {}) {
  const semanticIntent = clean(p.semanticIntent, 80);
  const itemLabel = clean(p.itemLabel, 160);
  if (!SUPPORTED_INTENTS.has(semanticIntent) || !itemLabel) {
    return { ok: false, reply: "", source: "missing_catalog_fact_compose_fail_closed", reason: "INVALID_TRUSTED_FACTS" };
  }
  const replyContract = buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Communicate that this item's price is not currently set/available, so you cannot share a rate right now — the item itself is real and offered, only the price is missing. Never invent an amount. Never ask the customer to supply, confirm, or repeat the price themselves. Never promise a follow-up check or confirmation — none is happening.",
    verifiedCustomerFacts: {
      requestedReferent: itemLabel,
      catalogMatchStatus: "matched",
      requestedFactStatus: "missing",
      semanticIntent,
    },
    allowedClaims: [],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    customerMessageText: clean(p.customerMessage, 300) || null,
  });
  let mentionedReferents = [];
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "missing_catalog_fact_customer_reply",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        mentionedReferents: { type: "array", items: { type: "string" }, maxItems: 1 },
        customerInputRequested: {
          type: "boolean",
          description:
            "True only if customerReply asks the customer a new question to get information FROM them. This composer's only job is telling the customer the price is not currently set — it must never ask the customer to supply, confirm, or repeat the price, and must never promise a follow-up check. Must be false.",
        },
        promisesFollowUp: {
          type: "boolean",
          description:
            "True if customerReply says or implies you will check/confirm/get back to them with the price later. No such process exists here. Must be false.",
        },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: ["customerReply", "mentionedReferents", "customerInputRequested", "promisesFollowUp", "replySemantics"],
    }
  );
  const composed = await composeGuardedCustomerReply({
    system: `${buildCustomerCommunicationPolicy({ channel: "dm" })}

WORDING-ONLY MISSING-CATALOG-FACT COMPOSER:
- Use only TRUSTED_FACTS_JSON. Do not reinterpret semanticIntent.
- catalogMatchStatus="matched" means this exact item is real and offered by this business — only its price is not currently set. Do not say or imply the item itself is unavailable, unlisted, or not carried.
- Do not invent, estimate, or quote any price/amount/currency.
- Naturally tell the customer the price isn't set/confirmed right now, as a real person would say it. Never say "catalog", "verify"/"verified", "trusted", "match", "canonical", "database", or any other internal/system word.
- The customer already asked you for the price. Your reply communicates that you don't currently have it — it must NEVER turn the customer's own question back on them (e.g. do not ask "what is the price?"). Set customerInputRequested=false; it must always be false for this composer.
- Do not promise to check, confirm, or get back to the customer with the price — no such process is happening. Set promisesFollowUp=false; it must always be false for this composer.
- mentionedReferents must exhaustively list every item/service label named in customerReply and may contain only the exact requestedReferent.
- Return strict JSON only.`,
    userBase: `TRUSTED_FACTS_JSON: ${JSON.stringify({ semanticIntent, requestedReferent: itemLabel, catalogMatchStatus: "matched", requestedFactStatus: "missing" })}`,
    firstAttemptReminder: "Address only the requested referent and requested intent; do not invent a price or promise a follow-up.",
    responseFormatName: "missing_catalog_fact_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (_reply, parsed) => {
      // Same discipline as composeUnknownItemCustomerReply.js: the model
      // self-reports whether it asked the customer a question or promised a
      // follow-up, and either one is deterministically rejected -- this
      // composer's only job is to state the fact is missing.
      if (parsed?.customerInputRequested === true) {
        return "MISSING_CATALOG_FACT_REPLY_MUST_NOT_ASK_CUSTOMER_FOR_INFO";
      }
      if (parsed?.promisesFollowUp === true) {
        return "MISSING_CATALOG_FACT_REPLY_MUST_NOT_PROMISE_FOLLOW_UP";
      }
      const labels = Array.isArray(parsed?.mentionedReferents)
        ? parsed.mentionedReferents.map((value) => clean(value, 160)).filter(Boolean)
        : [];
      if (labels.length !== 1 || labels[0] !== itemLabel) return "MISSING_CATALOG_FACT_REFERENT_COVERAGE_INVALID";
      mentionedReferents = labels;
      return null;
    },
    fallbackReply: "",
    timeoutMs: p.timeoutMs ?? 8000,
    timeoutErrorMessage: "MISSING_CATALOG_FACT_COMPOSE_TIMEOUT",
    temperature: 0.3,
    maxTokens: 180,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
  });
  return {
    ...composed,
    reply: composed.ok ? clean(composed.reply, 500) : "",
    source: composed.ok ? "openai_missing_catalog_fact_compose" : "missing_catalog_fact_compose_fail_closed",
    mentionedReferents,
  };
}
