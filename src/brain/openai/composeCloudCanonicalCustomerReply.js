/**
 * Wording-only Cloud launch composer. Frozen meaning + trusted facts in;
 * customer wording out. Does not decide intent, item identity, or actions.
 */
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  ALL_CUSTOMER_CLAIMS,
  CUSTOMER_CLAIMS,
  buildCustomerReplyContract,
} from "../contracts/customerReplyContract.js";
import { composeGuardedCustomerReply } from "./composeGuardedCustomerReply.js";
import {
  buildStrictJsonSchemaResponseFormat,
  REPLY_SEMANTICS_SCHEMA,
} from "./strictJsonSchema.js";
import { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } from "../contracts/cloudCanonicalSemantic.js";

const CLOUD_CANONICAL_REPLY_SEMANTICS_SCHEMA = {
  ...REPLY_SEMANTICS_SCHEMA,
  properties: {
    ...REPLY_SEMANTICS_SCHEMA.properties,
    claims: {
      type: "array",
      items: {
        type: "string",
        enum: [...ALL_CUSTOMER_CLAIMS],
      },
    },
  },
};

const KINDS = new Set([
  "pricing",
  "pricing_with_duration",
  "availability",
  "availability_approved",
  "duration_ask",
  "owner_check_holding",
  "booking_status",
  "clarification",
  "image_intro",
  "social",
]);

function clean(value, max = 400) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function factsObject(raw) {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

/**
 * @param {{
 *   kind: string,
 *   semanticIntent?: string | null,
 *   customerMessage?: string | null,
 *   trustedFacts?: Record<string, unknown> | null,
 *   fallbackReply?: string | null,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 */
export async function composeCloudCanonicalCustomerReply(p = {}) {
  const kind = clean(p.kind, 40);
  if (!KINDS.has(kind)) {
    return {
      ok: false,
      reply: clean(p.fallbackReply, 500),
      source: "cloud_canonical_compose_skip",
      reason: "UNSUPPORTED_KIND",
      attemptCount: 0,
    };
  }
  const facts = factsObject(p.trustedFacts);
  const fallback =
    clean(p.fallbackReply, 500) ||
    (kind === "owner_check_holding" ? CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY : "");
  const forbidden = [
    CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
  ];
  if (
    kind === "owner_check_holding" ||
    kind === "clarification" ||
    kind === "duration_ask" ||
    kind === "social"
  ) {
    forbidden.push(
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED
    );
  }
  if (kind === "image_intro") {
    forbidden.push(
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED
    );
  }
  const allowed = [];
  if (kind === "pricing" || kind === "pricing_with_duration") {
    allowed.push(CUSTOMER_CLAIMS.QUOTATION_VERIFIED);
  }
  if (
    (kind === "availability" || kind === "availability_approved") &&
    facts.availabilityConfirmed === true
  ) {
    allowed.push(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED);
  }
  if (kind === "availability_approved" && Number(facts.totalAmount) > 0) {
    allowed.push(CUSTOMER_CLAIMS.QUOTATION_VERIFIED);
  }
  if (kind === "booking_status" && facts.bookingCreated === true) {
    allowed.push(CUSTOMER_CLAIMS.RESERVATION_CREATED);
  }

  const replyContract = buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      kind === "owner_check_holding"
        ? "Write a short natural holding reply. Do not mention owner, staff, PA, internal process, or that anyone is being asked."
        : kind === "availability_approved"
          ? "Availability is already confirmed. Write a short natural reply from TRUSTED_FACTS_JSON only: state the trusted item, duration, and total when present, and invite the customer to book. Do not mention staff, PA, internal process, or that anyone was asked."
        : kind === "social"
          ? "Write a short natural greeting, thanks, or goodbye. Do not mention availability, booking, price, rent, or owner-check unless TRUSTED_FACTS_JSON actually contains those facts because the customer asked about that transaction."
          : kind === "clarification" || kind === "duration_ask"
          ? "Ask one short useful clarification from trusted facts only. Do not invent answers."
          : kind === "image_intro"
            ? "Write a short intro for sending trusted catalog pictures. Do not invent URLs or extra facts."
            : "Answer the frozen semantic intent using only TRUSTED_FACTS_JSON.",
    verifiedCustomerFacts: facts,
    allowedClaims: allowed,
    forbiddenClaims: forbidden,
    customerMessageText: clean(p.customerMessage, 300) || null,
    ...(kind === "social" ? { customerLanguageStyle: "mixed" } : {}),
  });
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "cloud_canonical_customer_reply",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        replySemantics: CLOUD_CANONICAL_REPLY_SEMANTICS_SCHEMA,
      },
      required: ["customerReply", "replySemantics"],
    }
  );
  const composed = await composeGuardedCustomerReply({
    system: `${buildCustomerCommunicationPolicy({ channel: "dm" })}

WORDING-ONLY CLOUD COMPOSER:
- Use only TRUSTED_FACTS_JSON and KIND. Do not reinterpret meaning.
- Do not mention owner, staff, PA, internal checking process, or that a person is being asked.
- Do not invent prices, availability, bookings, or image URLs.
- If KIND=social, greet or acknowledge naturally. Do not mention availability, booking, price, rent, or owner-check unless those facts are present because the customer asked about that transaction.
- If KIND=availability_approved, availability is already confirmed in TRUSTED_FACTS_JSON. Do not treat catalog/DB availability as confirmation.
- KIND=${kind}
- Return strict JSON only.`,
    userBase: `KIND: ${kind}
SEMANTIC_INTENT: ${clean(p.semanticIntent, 80) || "unknown"}
TRUSTED_FACTS_JSON: ${JSON.stringify(facts)}`,
    firstAttemptReminder: "One short customer reply from trusted facts only.",
    responseFormatName: "cloud_canonical_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (customerReply) => {
      if (/\b(owner|staff|pa\b|internal|backend)\b/i.test(customerReply)) {
        return "INTERNAL_PROCESS_DISCLOSED";
      }
      if (
        kind === "social" &&
        /\b(available|availability|booking|booked|rent|price|owner[- ]?check)\b/i.test(
          customerReply
        )
      ) {
        return "SOCIAL_TRANSACTIONAL_LEAK";
      }
      return null;
    },
    fallbackReply: fallback,
    timeoutMs: p.timeoutMs ?? 8000,
    timeoutErrorMessage: "CLOUD_CANONICAL_COMPOSE_TIMEOUT",
    temperature: 0.3,
    maxTokens: 180,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
  });
  const reply = composed.ok ? clean(composed.reply, 500) : fallback;
  return {
    ...composed,
    ok: Boolean(reply),
    reply,
    source: composed.ok ? "openai_cloud_canonical_compose" : composed.source,
  };
}
