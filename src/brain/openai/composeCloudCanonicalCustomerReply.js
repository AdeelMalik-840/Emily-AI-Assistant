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
  "temporal_clarification",
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
 * temporal_clarification's wording OBJECTIVE differs by why the date is
 * unresolved — deterministic fact in, natural wording still fully owned by
 * the model. An invalid calendar date (31 February) is not the same
 * customer situation as an ambiguous reference ("next Friday"): treating
 * both as "no date given" makes the reply look like it ignored what the
 * customer actually said.
 * @param {unknown} dateIssueReason
 * @returns {string}
 */
function temporalClarificationObjective(dateIssueReason) {
  if (dateIssueReason === "invalid_date") {
    return "The customer stated a specific start date, but it is not a real calendar date (the day does not exist in that month). Naturally acknowledge that the date they gave isn't valid/doesn't exist, then ask for a correct start date. If TRUSTED_FACTS_JSON.durationDays is present, treat the rental duration as already known — do not ask for duration again, only the corrected date. Do not invent, guess, or state any specific calendar date yourself. The availability check has not started: do not say or imply that availability is being checked, confirmed, or unavailable.";
  }
  return "The customer's reference to a start date could not be mapped to a specific date. Ask one short natural question for the customer to clarify or restate the exact start date for the trusted item. If TRUSTED_FACTS_JSON.durationDays is present, treat the rental duration as already known — do not ask for duration again, only the date. Do not invent, guess, or state any specific calendar date yourself. The availability check has not started: do not say or imply that availability is being checked, confirmed, or unavailable.";
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
    kind === "temporal_clarification" ||
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
        : kind === "duration_ask"
          ? "Ask one short natural question for the missing rental period (duration or dates) for the trusted item. The availability check has not started: do not say or imply that availability is being checked or will be checked yet."
          : kind === "temporal_clarification"
            ? temporalClarificationObjective(facts.dateIssueReason)
          : kind === "clarification"
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
        ...(kind === "duration_ask" || kind === "temporal_clarification"
          ? {
              customerInputRequested: { type: "boolean" },
              requestedInput: {
                type: "string",
                enum: ["rental_period", "start_date"],
              },
              availabilityCheckStarted: { type: "boolean" },
            }
          : {}),
      },
      required: [
        "customerReply",
        "replySemantics",
        ...(kind === "duration_ask" || kind === "temporal_clarification"
          ? ["customerInputRequested", "requestedInput", "availabilityCheckStarted"]
          : []),
      ],
    }
  );
  // Only the active kind's own instruction is ever shown to the model — a
  // sibling kind's concrete style example (e.g. duration_ask's "kitne din"
  // demonstration) must never sit in context as a competing anchor for a
  // different kind's reply.
  const kindSpecificInstruction =
    kind === "social"
      ? "- If KIND=social, greet or acknowledge naturally. Do not mention availability, booking, price, rent, or owner-check unless those facts are present because the customer asked about that transaction."
      : kind === "availability_approved"
        ? "- If KIND=availability_approved, availability is already confirmed in TRUSTED_FACTS_JSON. Do not treat catalog/DB availability as confirmation."
        : kind === "availability"
          ? "- If KIND=availability and TRUSTED_FACTS_JSON.availabilityStatus=unavailable while availabilityWindowRequested=false: say it is currently unavailable/booked right now ONLY if hasActiveBlockingBookingNow=true (this has been proven from real dates). If hasActiveBlockingBookingNow is not true, no specific rental period has been requested yet and the booking's own dates have not been checked against now: say only that the item already has an existing booking against it. Do not say or imply it is occupied at this exact moment in that case. Either way, do not say or imply it is unavailable for any other or future dates — that has not been checked."
          : kind === "duration_ask"
            ? '- If KIND=duration_ask, ask for the missing rental period before any availability check. This overrides the general unconfirmed-availability guidance: do not say a check will happen until the customer supplies the period. Set customerInputRequested=true, requestedInput=rental_period, and availabilityCheckStarted=false. Style demonstration only (NOT a fixed reply): natural Roman Urdu leads with the item then the duration question, e.g. "Corolla kitne din ke liye chahiye?" or "Civic kitne din ke liye chahiye aapko?" — avoid a stiff "[Item] ke liye kitne din chahiye aapko?" translated-English structure.'
            : kind === "temporal_clarification"
              ? (facts.dateIssueReason === "invalid_date"
                  ? '- If KIND=temporal_clarification and TRUSTED_FACTS_JSON.dateIssueReason=invalid_date: the customer stated a specific start date, but it is not a real calendar date (e.g. a day that does not exist in that month). Naturally acknowledge that the date is not valid, then ask for a correct start date — this is NOT a duration question and NOT "no date was given". If TRUSTED_FACTS_JSON.durationDays is already known, do not ask for duration again, do not repeat it back, and do not mention it as missing. Never invent, guess, or repair the customer\'s date yourself. Set customerInputRequested=true, requestedInput=start_date, and availabilityCheckStarted=false. Style demonstration only (NOT a fixed reply): natural Roman Urdu acknowledging the invalid date and asking again, e.g. "Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?" or "Ye date valid nahi hai, dobara sahi date confirm kar dein?" — do not phrase it as if no date was mentioned at all.'
                  : '- If KIND=temporal_clarification and TRUSTED_FACTS_JSON.dateIssueReason=ambiguous_date (or clarifyStartDate=true with no dateIssueReason), the customer referenced a start date the system could not map to a specific date. The exact start date is the missing input — this is NOT a duration question. If TRUSTED_FACTS_JSON.durationDays is already known, do not ask for duration again, do not repeat it back, and do not mention it as missing. Never invent, guess, or repair the customer\'s date yourself. Ask exactly one short natural question requesting the correct start date. Set customerInputRequested=true, requestedInput=start_date, and availabilityCheckStarted=false. Style demonstration only (NOT a fixed reply): natural Roman Urdu asking for the date, e.g. "Corolla kis date se chahiye?" or "Sahi start date confirm kar dein?" — do not ask about din/duration in this reply.')
              : "";
  const composed = await composeGuardedCustomerReply({
    system: [
      buildCustomerCommunicationPolicy({ channel: "dm" }),
      "",
      "WORDING-ONLY CLOUD COMPOSER:",
      "- Use only TRUSTED_FACTS_JSON and KIND. Do not reinterpret meaning.",
      "- Do not mention owner, staff, PA, internal checking process, or that a person is being asked.",
      "- Do not invent prices, availability, bookings, or image URLs.",
      ...(kindSpecificInstruction ? [kindSpecificInstruction] : []),
      `- KIND=${kind}`,
      "- Return strict JSON only.",
    ].join("\n"),
    userBase: `KIND: ${kind}
SEMANTIC_INTENT: ${clean(p.semanticIntent, 80) || "unknown"}
TRUSTED_FACTS_JSON: ${JSON.stringify(facts)}`,
    firstAttemptReminder: "One short customer reply from trusted facts only.",
    responseFormatName: "cloud_canonical_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (customerReply, parsed) => {
      const expectedRequestedInput =
        kind === "duration_ask"
          ? "rental_period"
          : kind === "temporal_clarification"
            ? "start_date"
            : null;
      if (
        expectedRequestedInput &&
        (parsed?.customerInputRequested !== true ||
          parsed?.requestedInput !== expectedRequestedInput ||
          parsed?.availabilityCheckStarted !== false)
      ) {
        return "DURATION_INPUT_CONTRACT_NOT_SATISFIED";
      }
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
