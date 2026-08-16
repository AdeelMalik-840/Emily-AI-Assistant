/**
 * Waiting-confirm Cloud DM lane — TurnContext packer + Brain meaning.
 * Mutations stay in existing confirm/decline executors. No pamiss/owner notify.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { resolveAvailabilityApprovedPriceQuote } from "../../services/availabilityMessageBuilder.js";
import { isWaitingConfirmLifecycleActive } from "../../services/availabilityRequestService.js";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  CUSTOMER_CLAIMS,
  buildWaitingConfirmVerifiedQuotationContract,
  normalizeReplySemantics,
  stripInternalReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";

export const WAITING_CONFIRM_DM_LANE = "waiting_confirm_dm";

/** Minimum confidence required to execute confirm_booking via Brain. */
export const WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN = 0.7;

export const WAITING_CONFIRM_DM_CONFIRM_EXECUTOR = "confirm_booking_executor";

const ACTIONS = new Set([
  "reply",
  "silence",
  "clarify",
  "confirm_booking",
  "decline_request",
  "change_request",
  "none",
]);

/** Allowed waiting-confirm Brain actions (lane contract). */
export const WAITING_CONFIRM_DM_ALLOWED_ACTIONS = ACTIONS;

const TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai. Book karna ho to bata dein.";

/** Technical-only fallback when a sendable reply is required but wording is empty. */
export const WAITING_CONFIRM_DM_TECHNICAL_FALLBACK = TECHNICAL_FALLBACK;

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Structured booking-confirmation prompt context (Emily-side), not customer text.
 * Uses the latest *stored* outbound prompt type only — no Emily-preview regex fallback.
 * @param {Record<string, unknown> | null | undefined} turnContext
 */
export function isWaitingConfirmDmBookingPromptActive(turnContext) {
  const ctx = turnContext && typeof turnContext === "object" ? turnContext : {};
  const facts = ctx.facts && typeof ctx.facts === "object" ? ctx.facts : {};
  if (facts.bookingPromptActive === true) return true;
  const promptType =
    clean(ctx.lastCustomerDmPromptType, 80) ||
    clean(facts.lastCustomerDmPromptType, 80);
  return promptType === "booking_confirmation_prompt";
}

/** Active transaction state is independent from the latest conversational prompt. */
export function isWaitingConfirmDmTransactionActive(turnContext) {
  const ctx = turnContext && typeof turnContext === "object" ? turnContext : {};
  const facts = ctx.facts && typeof ctx.facts === "object" ? ctx.facts : {};
  const avr =
    ctx.activeAvailabilityRequest &&
    typeof ctx.activeAvailabilityRequest === "object"
      ? ctx.activeAvailabilityRequest
      : facts.availabilityRequest && typeof facts.availabilityRequest === "object"
        ? facts.availabilityRequest
        : {};
  return (
    facts.waitingConfirmTransactionActive === true &&
    isWaitingConfirmLifecycleActive(avr)
  );
}

/**
 * Resolve outbound prompt type to record after a Brain waiting-confirm reply.
 * Booking-confirmation is opt-in via structured decision fields only.
 * @param {Record<string, unknown> | null | undefined} decision
 * @param {string} [fallback]
 */
export function resolveWaitingConfirmDmOutboundPromptType(
  decision,
  fallback = "general_info"
) {
  const d = decision && typeof decision === "object" ? decision : {};
  if (d.asksForBookingConfirmation === true) {
    return "booking_confirmation_prompt";
  }
  const explicit = clean(d.outboundPromptType, 80).toLowerCase();
  if (
    explicit === "booking_confirmation_prompt" ||
    explicit === "price_info" ||
    explicit === "general_info"
  ) {
    return explicit;
  }
  return fallback === "booking_confirmation_prompt" ||
    fallback === "price_info" ||
    fallback === "general_info"
    ? fallback
    : "general_info";
}

/**
 * Business safety guard before Brain-authorized confirm executor.
 * Uses structured decision + prompt context only — no customer phrase rules.
 *
 * @param {{
 *   decision?: Record<string, unknown> | null,
 *   turnContext?: Record<string, unknown> | null,
 * }} p
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function evaluateWaitingConfirmDmBrainConfirmGuard({
  decision = null,
  turnContext = null,
} = {}) {
  const d = decision && typeof decision === "object" ? decision : {};
  /** @type {string[]} */
  const reasons = [];
  const action = clean(d.action, 40).toLowerCase();
  if (action !== "confirm_booking") reasons.push("ACTION_NOT_CONFIRM");
  // Independent model flag — must not be inferred solely from action.
  if (d.customerIsConfirmingBooking !== true) {
    reasons.push("CONFIRMING_FLAG_FALSE");
  }
  if (d.customerIsAskingQuestion === true) {
    reasons.push("ASKING_QUESTION");
  }
  if (clean(d.requiredExecutor, 80) !== WAITING_CONFIRM_DM_CONFIRM_EXECUTOR) {
    reasons.push("REQUIRED_EXECUTOR_MISMATCH");
  }
  const confidence =
    d.confidence != null && Number.isFinite(Number(d.confidence))
      ? Number(d.confidence)
      : null;
  if (confidence == null || confidence < WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN) {
    reasons.push("CONFIDENCE_TOO_LOW");
  }
  if (!isWaitingConfirmDmTransactionActive(turnContext)) {
    reasons.push("WAITING_CONFIRM_TRANSACTION_NOT_ACTIVE");
  }
  return { ok: reasons.length === 0, reasons };
}

/** @param {Record<string, unknown>} p */
export function packWaitingConfirmDmTurnContext({
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  conversationHistory = null,
  request,
  catalogRow = null,
  historicalBookingContext = null,
} = {}) {
  const req = request && typeof request === "object" ? request : {};
  const quote =
    resolveAvailabilityApprovedPriceQuote(req, catalogRow).priceQuote || null;
  const lastEmilyMessage =
    clean(req.lastCustomerDmOutboundPreview, 500) ||
    clean(req.lastCustomerNotifyMessage, 500) ||
    null;
  // Freshness: only the latest *stored* outbound prompt type counts (no regex fallback).
  const lastCustomerDmPromptType =
    clean(req.lastCustomerDmPromptType, 80) || null;
  const bookingPromptActive =
    lastCustomerDmPromptType === "booking_confirmation_prompt";
  const durationDays =
    req.requestedDuration != null && Number.isFinite(Number(req.requestedDuration))
      ? Math.max(1, Math.floor(Number(req.requestedDuration)))
      : null;
  const row = catalogRow && typeof catalogRow === "object" ? catalogRow : {};
  const historical =
    historicalBookingContext && typeof historicalBookingContext === "object"
      ? {
          booking:
            historicalBookingContext.booking &&
            typeof historicalBookingContext.booking === "object"
              ? historicalBookingContext.booking
              : null,
          bookingCandidates: Array.isArray(
            historicalBookingContext.bookingCandidates
          )
            ? historicalBookingContext.bookingCandidates.slice(0, 8)
            : [],
          bookingFocus:
            historicalBookingContext.bookingFocus &&
            typeof historicalBookingContext.bookingFocus === "object"
              ? historicalBookingContext.bookingFocus
              : null,
          known:
            historicalBookingContext.known &&
            typeof historicalBookingContext.known === "object"
              ? historicalBookingContext.known
              : null,
        }
      : null;
  const profile =
    row.businessProfile && typeof row.businessProfile === "object"
      ? row.businessProfile
      : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = clean(row[k] ?? profile[k]);
      if (v) return v;
    }
    return null;
  };

  const availabilityRequest = {
    id: clean(req.requestId ?? req.id) || null,
    status: clean(req.status) || null,
    customerConfirmationStatus: clean(req.customerConfirmationStatus) || null,
    approvalCustomerNotificationStatus:
      clean(req.approvalCustomerNotificationStatus) || null,
    itemId: clean(req.itemId) || null,
    itemLabel: clean(req.itemLabel) || null,
    requestedDuration: durationDays,
    linkedBookingId: clean(req.linkedBookingId) || null,
    supersededByAvailabilityRequestId:
      clean(req.supersededByAvailabilityRequestId) || null,
    confirmExpiresAt: req.confirmExpiresAt ?? null,
    customerConfirmationChannel: clean(req.customerConfirmationChannel) || null,
  };
  const knownPolicies = {
    advanceAmount: null,
    advancePolicy: pick("advancePolicy"),
    driverPolicy: pick("driverPolicy"),
    documentsPolicy: pick("documentsPolicy"),
    deliveryPolicy: pick("deliveryPolicy"),
    paymentPolicy: pick("paymentPolicy"),
  };
  const facts = {
    businessId: clean(businessId) || null,
    customerPhoneDigits: String(customerPhone ?? "").replace(/\D/g, "") || null,
    referentOptions: [
      {
        targetContext: "pending_availability",
        targetId: availabilityRequest.id,
        lifecycleRole: "current_pending_transaction",
        itemId: availabilityRequest.itemId,
        itemLabel: availabilityRequest.itemLabel,
        durationDays: availabilityRequest.requestedDuration,
        dailyRate: quote?.dailyRate ?? null,
        totalAmount: quote?.total ?? null,
      },
      ...(historical?.booking
        ? [
            {
              targetContext: "confirmed_booking",
              targetId: clean(historical.booking.id) || null,
              lifecycleRole: "older_confirmed_booking",
              itemId: clean(historical.booking.itemId) || null,
              itemLabel:
                clean(
                  historical.booking.itemLabel ?? historical.booking.itemName
                ) || null,
              durationDays:
                historical.booking.durationDays != null &&
                Number.isFinite(Number(historical.booking.durationDays))
                  ? Math.floor(Number(historical.booking.durationDays))
                  : null,
              dailyRate:
                historical.booking.dailyRate != null &&
                Number.isFinite(Number(historical.booking.dailyRate))
                  ? Number(historical.booking.dailyRate)
                  : null,
              totalAmount:
                historical.booking.totalAmount != null &&
                Number.isFinite(Number(historical.booking.totalAmount))
                  ? Number(historical.booking.totalAmount)
                  : null,
            },
          ]
        : []),
    ],
    lastEmilyMessage,
    lastCustomerDmPromptType,
    bookingPromptActive,
    waitingConfirmTransactionActive:
      clean(req.status) === "approved" &&
      clean(req.approvalCustomerNotificationStatus) === "sent" &&
      clean(req.customerConfirmationStatus) === "waiting_confirm" &&
      !clean(req.linkedBookingId) &&
      !clean(req.supersededByAvailabilityRequestId),
    availabilityRequest,
    pendingAvailabilityRequest: availabilityRequest,
    historicalBookingContext: historical,
    activeConfirmedBooking:
      historical?.booking && typeof historical.booking === "object"
        ? historical.booking
        : null,
    confirmedBookingCandidates: historical?.bookingCandidates ?? [],
    activeBookings: historical?.bookingCandidates ?? [],
    quotedPrice: quote
      ? {
          total: quote.total ?? null,
          dailyRate: quote.dailyRate ?? null,
          currency: clean(quote.currency) || "PKR",
        }
      : null,
    catalog: {
      pickupLocation: pick("pickupLocation"),
      dropoffLocation: pick("dropoffLocation"),
      deliveryAvailable: pick("deliveryAvailable"),
      driverAvailable: pick("driverAvailable"),
      deposit: pick("deposit"),
      color: clean(row.color ?? row.colour) || null,
    },
    knownPolicies,
  };

  return {
    lane: WAITING_CONFIRM_DM_LANE,
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: clean(businessId) || null,
    customerPhone: clean(customerPhone, 40) || null,
    messageText: clean(messageText, 800) || null,
    messageId: clean(messageId, 160) || null,
    recentDialogue:
      conversationHistory != null ? String(conversationHistory) : null,
    lastEmilyMessage,
    lastCustomerDmPromptType,
    ownershipLane: WAITING_CONFIRM_DM_LANE,
    activeAvailabilityRequest: availabilityRequest,
    knownPolicies,
    facts,
    verifiedFactsJson: JSON.stringify(facts),
    safetyPolicy: {
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBookingOrAvrDirectly: true,
      noPamissInStep4: true,
      noOwnerNotificationInStep4: true,
      confirmDeclineChangeOnlyViaExecutors: true,
    },
    allowedExecutors: [
      "whatsapp_cloud_dm",
      "none",
      "confirm_booking_executor",
      "decline_request_executor",
      "protected_change_reply_executor",
    ],
  };
}

/** @param {string} raw */
/**
 * Ensure shouldReply=true decisions always carry non-empty customer wording.
 * @param {Record<string, unknown>} decision
 */
function ensureSendableWaitingConfirmReply(decision) {
  const next = decision && typeof decision === "object" ? { ...decision } : {};
  const action = clean(next.action, 40);
  if (
    action === "confirm_booking" ||
    action === "decline_request" ||
    action === "change_request"
  ) {
    next.customerReply = "";
    next.shouldReply = true;
    return next;
  }
  if (next.shouldReply === true && !clean(next.customerReply)) {
    next.customerReply = TECHNICAL_FALLBACK;
  }
  return next;
}

export function parseWaitingConfirmDmDecision(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  let action = clean(parsed.action, 40).toLowerCase();
  // Legacy alias only — unknown actions must not coerce into reply.
  if (action === "escalate_missing_info") action = "reply";
  let customerReply = clean(parsed.customerReply ?? parsed.reply, 500);

  // Independent structured flags from the model (not derived from action).
  const customerIsConfirmingBooking = parsed.customerIsConfirmingBooking === true;
  const customerIsDeclining = parsed.customerIsDeclining === true;
  const customerWantsChange = parsed.customerWantsChange === true;
  const customerIsAskingQuestion = parsed.customerIsAskingQuestion === true;
  const asksForBookingConfirmation =
    parsed.asksForBookingConfirmation === true;
  let outboundPromptType = clean(parsed.outboundPromptType, 80).toLowerCase();
  if (
    outboundPromptType &&
    !["booking_confirmation_prompt", "price_info", "general_info"].includes(
      outboundPromptType
    )
  ) {
    outboundPromptType = "";
  }
  if (asksForBookingConfirmation) {
    outboundPromptType = "booking_confirmation_prompt";
  }

  // Flags may promote action; action alone must not invent confirming flag.
  // Structured replySemantics confirmation claims also mark a confirm turn.
  const preliminarySemantics = normalizeReplySemantics(parsed.replySemantics);
  const preliminaryClaims = Array.isArray(preliminarySemantics?.claims)
    ? preliminarySemantics.claims.map(String)
    : [];
  const confirmingFromClaims =
    preliminaryClaims.includes(CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED) ||
    preliminaryClaims.includes(CUSTOMER_CLAIMS.RESERVATION_REQUESTED);
  const isConfirmingBooking =
    customerIsConfirmingBooking === true || confirmingFromClaims;
  if (isConfirmingBooking) action = "confirm_booking";
  else if (customerIsDeclining) action = "decline_request";
  else if (customerWantsChange && action !== "reply") action = "change_request";

  // Fail closed: missing/unsupported action never becomes a normal reply.
  if (!action || !ACTIONS.has(action)) return null;

  let shouldReply =
    parsed.shouldReply === false
      ? false
      : parsed.shouldReply === true
        ? true
        : !["silence", "none", "confirm_booking", "decline_request"].includes(
            action
          );

  if (action === "confirm_booking" || action === "decline_request" || action === "change_request") {
    // Final customer wording is composed after deterministic execute.
    customerReply = "";
    shouldReply = true;
  } else if (action === "silence" || action === "none" || shouldReply === false) {
    action = "silence";
    shouldReply = false;
    customerReply = "";
  } else if (!customerReply && action === "reply") {
    return null;
  } else if (!customerReply) {
    customerReply = TECHNICAL_FALLBACK;
  }

  const confidence =
    parsed.confidence != null && Number.isFinite(Number(parsed.confidence))
      ? Number(parsed.confidence)
      : null;

  // Soft demote weak confirms at parse; execution guard is authoritative.
  // Structured confirmation claims already attest a confirm turn — do not demote those.
  if (
    action === "confirm_booking" &&
    !confirmingFromClaims &&
    (isConfirmingBooking !== true ||
      customerIsAskingQuestion === true ||
      confidence == null ||
      confidence < WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN)
  ) {
    action = "clarify";
    customerReply = customerReply || "Book confirm karna hai? Bata dein.";
    shouldReply = true;
  }

  // Action decisions keep empty customerReply for post-execution compose.
  if (
    shouldReply === true &&
    !clean(customerReply) &&
    action !== "confirm_booking" &&
    action !== "decline_request" &&
    action !== "change_request"
  ) {
    customerReply = TECHNICAL_FALLBACK;
  }

  return {
    conversationStage:
      clean(parsed.conversationStage ?? parsed.situation, 60) || "unclear",
    customerMood: clean(parsed.customerMood, 40) || null,
    customerIntent: clean(parsed.customerIntent, 40) || "unclear",
    situation: clean(parsed.situation, 60) || "unclear",
    conversationAct: clean(parsed.conversationAct, 40) || "unknown",
    customerIsConfirmingBooking: isConfirmingBooking,
    customerIsAskingQuestion,
    customerIsDeclining,
    customerWantsChange: action === "change_request" || customerWantsChange,
    asksForBookingConfirmation,
    outboundPromptType: outboundPromptType || null,
    requestedInfoType: clean(parsed.requestedInfoType, 40) || null,
    targetContext: [
      "pending_availability",
      "confirmed_booking",
      "general",
      "unclear",
    ].includes(clean(parsed.targetContext, 40))
      ? clean(parsed.targetContext, 40)
      : "unclear",
    targetId: clean(parsed.targetId, 160) || null,
    shouldReply,
    customerReply,
    action,
    confidence,
    safetyNotes: clean(parsed.safetyNotes, 200) || null,
    reason: clean(parsed.reason, 120) || null,
    replySemantics: preliminarySemantics,
  };
}

function defaultDecision(overrides = {}) {
  return {
    conversationStage: "unclear",
    customerMood: null,
    customerIntent: "unclear",
    situation: "unclear",
    conversationAct: "unknown",
    customerIsConfirmingBooking: false,
    customerIsAskingQuestion: false,
    customerIsDeclining: false,
    customerWantsChange: false,
    asksForBookingConfirmation: false,
    outboundPromptType: null,
    requestedInfoType: null,
    targetContext: "unclear",
    targetId: null,
    shouldReply: false,
    customerReply: "",
    action: "silence",
    confidence: null,
    safetyNotes: null,
    reason: null,
    ...overrides,
  };
}

const WAITING_CONFIRM_DM_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    conversationStage: { type: ["string", "null"] },
    customerMood: { type: ["string", "null"] },
    customerIntent: { type: ["string", "null"] },
    situation: { type: ["string", "null"] },
    customerIsConfirmingBooking: { type: "boolean" },
    customerIsAskingQuestion: { type: "boolean" },
    customerIsDeclining: { type: "boolean" },
    customerWantsChange: { type: "boolean" },
    requestedInfoType: { type: ["string", "null"] },
    targetContext: {
      type: "string",
      enum: [
        "pending_availability",
        "confirmed_booking",
        "general",
        "unclear",
      ],
    },
    targetId: { type: ["string", "null"] },
    shouldReply: { type: "boolean" },
    customerReply: { type: "string" },
    action: {
      type: "string",
      enum: [
        "reply",
        "silence",
        "clarify",
        "confirm_booking",
        "decline_request",
        "change_request",
        "none",
      ],
    },
    confidence: { type: ["number", "null"] },
    safetyNotes: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    asksForBookingConfirmation: { type: "boolean" },
    replySemantics: REPLY_SEMANTICS_SCHEMA,
  },
  required: [
    "conversationStage",
    "customerMood",
    "customerIntent",
    "situation",
    "customerIsConfirmingBooking",
    "customerIsAskingQuestion",
    "customerIsDeclining",
    "customerWantsChange",
    "requestedInfoType",
    "targetContext",
    "targetId",
    "shouldReply",
    "customerReply",
    "action",
    "confidence",
    "safetyNotes",
    "reason",
    "asksForBookingConfirmation",
    "replySemantics",
  ],
};

/** @param {{ turnContext: Record<string, unknown>, timeoutMs?: number, __chatCompletionsCreateForTests?: Function | null }} p */
export async function executeWaitingConfirmDmLaneDecision({
  turnContext,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const ctx = turnContext && typeof turnContext === "object" ? turnContext : {};
  const userLine = clean(ctx.messageText, 800);
  const historyLine = clean(ctx.recentDialogue, 1200);
  const lastEmily = clean(ctx.lastEmilyMessage, 500);
  const factsJson =
    clean(ctx.verifiedFactsJson, 4000) ||
    JSON.stringify(ctx.facts && typeof ctx.facts === "object" ? ctx.facts : {});

  const styleKey =
    ctx.styleKey === "neutral_english" ? "neutral_english" : "casual_local";
  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
  });
  let factsObj =
    ctx.facts && typeof ctx.facts === "object" ? { ...ctx.facts } : {};
  if (
    (!factsObj.quotedPrice || typeof factsObj.quotedPrice !== "object") &&
    factsJson
  ) {
    try {
      const parsedFacts = JSON.parse(factsJson);
      if (parsedFacts && typeof parsedFacts === "object") {
        factsObj = { ...parsedFacts, ...factsObj };
      }
    } catch {
      // verifiedFactsJson may be non-JSON in some injectors; keep factsObj
    }
  }
  const replyContract = buildWaitingConfirmVerifiedQuotationContract({
    ...factsObj,
    customerMessageText: userLine,
    recentDialogue: historyLine || null,
    styleKey,
  });
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "waiting_confirm_dm_decision",
    WAITING_CONFIRM_DM_OUTPUT_SCHEMA
  );

  const system = `${shared}

LANE OBJECTIVE (waiting_confirm_dm):
AVR approved, waiting_confirm Cloud DM.
Decide meaning from latest message + last Emily + history + VERIFIED_FACTS_JSON (not keyword lists).
Return STRICT JSON only (schema enforced). Include replySemantics for validation.
Match customerLanguageStyle in replySemantics.languageStyle and in customerReply wording.
Example shape: {"conversationStage":"booking_offer","customerMood":null,"customerIntent":"ask_fact","situation":"awaiting_confirm","customerIsConfirmingBooking":false,"customerIsAskingQuestion":true,"customerIsDeclining":false,"customerWantsChange":false,"requestedInfoType":null,"targetContext":"pending_availability","targetId":"the trusted AVR id","shouldReply":true,"customerReply":"...","action":"reply","confidence":0.9,"safetyNotes":null,"reason":"price_question","asksForBookingConfirmation":false,"replySemantics":{"claims":["quotation_verified"],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}
action: confirm_booking|decline_request|change_request|reply|silence|clarify|none
The active pending availability transaction remains active through informational Q&A. Decide the referent and meaning semantically from the latest message, full dialogue, pendingAvailabilityRequest, and historicalBookingContext. Never substitute an older confirmed booking for the pending transaction before interpretation. A question is not confirmation; a clear semantic confirmation of the pending transaction uses action=confirm_booking. Questions/negotiate → facts-only reply; never invent amounts/policies/discounts. Clear offer decline → decline_request. Social turns → silence/reply. Change car/duration → change_request (no mutation). No pamiss/owner follow-up.
First choose the matching entry from referentOptions using the latest CUSTOMER_MESSAGE. Copy its targetContext and targetId exactly. Use general only for business/social facts and unclear when no referent can be resolved.
The latest CUSTOMER_MESSAGE has highest priority for referent selection. If it identifies an item or reference that differs from the pending item and exactly belongs to a historical confirmed booking, targetContext MUST be confirmed_booking with that booking id. Pending-transaction precedence MUST NOT erase an explicit historical referent. Select the referent before choosing the action.
If the customer proposes a duration, item, or date different from the pending transaction, action MUST be change_request and customerWantsChange=true, even when phrased as a statement. The proposed replacement value is not a verified current fact to echo in a read-only reply.
If your reply intentionally asks the customer to confirm booking again, set asksForBookingConfirmation=true (structured). Do not set it for ordinary Q&A answers.
When stating a price, use only the exact verified amount from the selected targetContext and claim quotation_verified.
When action=confirm_booking|decline_request|change_request: set customerReply to "" (final wording is composed AFTER deterministic validate/execute). Decide meaning/action only. Do NOT claim booking created, confirmed, declined-complete wording as final outbound, or use extension language ("aage barhati", extend, process karti). Do not paste the customer's message back.
When action=reply|clarify: customerReply is the final customer-facing answer from trusted facts (read-only; no booking executor).`;

  let userPayload =
    `VERIFIED_FACTS_JSON:\n${factsJson}\n\nLAST_EMILY_MESSAGE:\n${lastEmily || "(none)"}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;
  if (historyLine) userPayload += `\n\nRECENT_CONVERSATION:\n${historyLine}`;
  const languageDirective =
    replyContract.customerLanguageStyle === "english"
      ? "LANGUAGE LOCK: customerLanguageStyle=english. customerReply must be natural English; replySemantics.languageStyle=english."
      : replyContract.customerLanguageStyle === "roman_urdu"
        ? "LANGUAGE LOCK: customerLanguageStyle=roman_urdu. customerReply must be natural Roman Urdu; replySemantics.languageStyle=roman_urdu."
        : replyContract.customerLanguageStyle === "mixed"
          ? "LANGUAGE LOCK: customerLanguageStyle=mixed. Natural mixed reply is fine."
          : "LANGUAGE LOCK: customerLanguageStyle=unclear. Follow recent dialogue / business style.";
  userPayload += `\n\nCUSTOMER_REPLY_CONTRACT:\n${JSON.stringify({
    allowedClaims: replyContract.allowedClaims,
    forbiddenClaims: replyContract.forbiddenClaims,
    requiredMeaning: replyContract.requiredMeaning,
    customerLanguageStyle: replyContract.customerLanguageStyle,
    ...(factsObj?.quotedPrice?.total != null &&
    Number.isFinite(Number(factsObj.quotedPrice.total))
      ? {
          pendingAvailabilityQuotedTotal: Math.floor(
            Number(factsObj.quotedPrice.total)
          ),
          pendingAvailabilityQuotedCurrency:
            String(factsObj.quotedPrice.currency ?? "PKR").slice(0, 8) || "PKR",
        }
      : {}),
  })}\n\n${languageDirective}`;
  userPayload +=
    "\nFor any price/total answer, first select targetContext, then use only that target's verified digits.";

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : (() => {
          const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
          if (!apiKey) return null;
          const client = new OpenAI({ apiKey });
          return (args) => client.chat.completions.create(args);
        })();

  if (!completionFn) {
    return {
      ok: false,
      decision: defaultDecision({ reason: "MISSING_OPENAI" }),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  const ms =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Math.floor(Number(timeoutMs))
      : 8000;

  async function runOne(userContent) {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.3,
        max_tokens: 320,
        response_format: responseFormat,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      })
    );
    const timed = Promise.race([
      createPromise,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("WAITING_CONFIRM_DM_OPENAI_TIMEOUT")),
          ms
        );
      }),
    ]);
    const resp = await timed;
    return String(resp?.choices?.[0]?.message?.content ?? "").trim();
  }

  try {
    let lastReason = null;
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userPayload}\n\nStrict JSON only; facts only; confirm only when context supports it.`
          : `${userPayload}\n\n${buildCustomerReplyGuardCorrection(lastReason || "validation_failed")}`;

      const raw = await runOne(userContent);
      const decision = parseWaitingConfirmDmDecision(raw);
      if (!decision) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          decision: defaultDecision({ reason: "PARSE_FAILED" }),
          source: "content_safety_fail_closed",
          reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
          contentSafetyAttempts: attempt,
        };
      }

      // Action decisions: empty customerReply; wording composed after execute.
      if (
        decision.action === "confirm_booking" ||
        decision.action === "decline_request" ||
        decision.action === "change_request"
      ) {
        decision.customerReply = "";
        decision.shouldReply = true;
        return {
          ok: true,
          decision: stripInternalReplySemantics(decision),
          source: "openai",
          contentSafetyAttempts: attempt,
        };
      }

      // Guard customer wording only for read-only reply/clarify paths.
      const replyText = String(decision.customerReply ?? "").trim();
      if (replyText) {
        const normalizedReply = replyText.replace(/\s+/g, " ").trim().toLowerCase();
        const normalizedCustomer = String(userLine || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (normalizedCustomer && normalizedReply === normalizedCustomer) {
          if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) {
            lastReason = "customer_reply_echo";
            continue;
          }
          decision.customerReply = "";
          decision.shouldReply = false;
        } else {
          const asksForVerifiedTotal =
            decision.customerIsAskingQuestion === true &&
            ["total", "total_price", "total_amount"].includes(
              clean(decision.requestedInfoType, 40).toLowerCase()
            );
          const hasQuote =
            factsObj?.quotedPrice?.total != null &&
            Number.isFinite(Number(factsObj.quotedPrice.total));
          const activeContract = {
            ...replyContract,
            requiredMeaning:
              asksForVerifiedTotal &&
              hasQuote &&
              decision.targetContext === "pending_availability"
                ? "state_verified_quotation"
                : replyContract.requiredMeaning,
          };
          const guard = validateCustomerReplyAgainstContract(
            replyText,
            {
              ...activeContract,
              replyRequired:
                decision.action === "reply" || decision.shouldReply === true,
            },
            decision.replySemantics
          );
          if (!guard.ok) {
            lastReason = guard.reason || "customer_reply_guard_failed";
            if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
            return {
              ok: false,
              decision: defaultDecision({ reason: lastReason }),
              source: "content_safety_fail_closed",
              reason: lastReason,
              contentSafetyAttempts: attempt,
            };
          }
        }
      }

      return {
        ok: true,
        decision: stripInternalReplySemantics(
          ensureSendableWaitingConfirmReply(decision)
        ),
        source: attempt === 1 ? "openai" : "openai_content_safety_regenerated",
        contentSafetyAttempts: attempt,
      };
    }

    return {
      ok: false,
      decision: defaultDecision({ reason: lastReason || "CONTENT_SAFETY_FAIL_CLOSED" }),
      source: "content_safety_fail_closed",
      reason: lastReason || "CONTENT_SAFETY_FAIL_CLOSED",
      contentSafetyAttempts: MAX_CUSTOMER_REPLY_ATTEMPTS,
    };
  } catch (err) {
    return {
      ok: false,
      decision: defaultDecision({
        reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 120),
      }),
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}
