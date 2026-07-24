/**
 * Waiting-confirm Cloud DM lane — TurnContext packer + Brain meaning.
 * Mutations stay in existing confirm/decline executors. No pamiss/owner notify.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { resolveAvailabilityApprovedPriceQuote } from "../../services/availabilityMessageBuilder.js";

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

const TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai. Book karna ho to bata dein.";

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
  if (!isWaitingConfirmDmBookingPromptActive(turnContext)) {
    reasons.push("BOOKING_PROMPT_NOT_ACTIVE");
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
    lastEmilyMessage,
    lastCustomerDmPromptType,
    bookingPromptActive,
    availabilityRequest,
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
  if (!ACTIONS.has(action)) action = "reply";
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
  if (customerIsConfirmingBooking) action = "confirm_booking";
  else if (customerIsDeclining) action = "decline_request";
  else if (customerWantsChange && action !== "reply") action = "change_request";

  let shouldReply =
    parsed.shouldReply === false
      ? false
      : parsed.shouldReply === true
        ? true
        : !["silence", "none", "confirm_booking", "decline_request"].includes(
            action
          );

  if (action === "confirm_booking" || action === "decline_request") {
    shouldReply = Boolean(customerReply);
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
  if (
    action === "confirm_booking" &&
    (customerIsConfirmingBooking !== true ||
      customerIsAskingQuestion === true ||
      confidence == null ||
      confidence < WAITING_CONFIRM_DM_CONFIRM_CONFIDENCE_MIN)
  ) {
    action = "clarify";
    customerReply = customerReply || "Book confirm karna hai? Bata dein.";
    shouldReply = true;
  }

  return {
    conversationStage:
      clean(parsed.conversationStage ?? parsed.situation, 60) || "unclear",
    customerMood: clean(parsed.customerMood, 40) || null,
    customerIntent: clean(parsed.customerIntent, 40) || "unclear",
    situation: clean(parsed.situation, 60) || "unclear",
    conversationAct: clean(parsed.conversationAct, 40) || "unknown",
    customerIsConfirmingBooking,
    customerIsAskingQuestion,
    customerIsDeclining,
    customerWantsChange: action === "change_request" || customerWantsChange,
    asksForBookingConfirmation,
    outboundPromptType: outboundPromptType || null,
    requestedInfoType: clean(parsed.requestedInfoType, 40) || null,
    shouldReply,
    customerReply,
    action,
    confidence,
    safetyNotes: clean(parsed.safetyNotes, 200) || null,
    reason: clean(parsed.reason, 120) || null,
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
    shouldReply: true,
    customerReply: TECHNICAL_FALLBACK,
    action: "reply",
    confidence: null,
    safetyNotes: null,
    reason: null,
    ...overrides,
  };
}

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

  const system = `Emily — Pakistani WhatsApp staff. AVR approved, waiting_confirm Cloud DM.
Decide meaning from latest message + last Emily + history + VERIFIED_FACTS_JSON (not keyword lists).
JSON only: {"conversationStage":"booking_offer","customerMood":null,"customerIntent":"confirm_booking","situation":"awaiting_confirm","customerIsConfirmingBooking":true,"customerIsAskingQuestion":false,"customerIsDeclining":false,"customerWantsChange":false,"requestedInfoType":null,"shouldReply":false,"customerReply":"","action":"confirm_booking","confidence":0.9,"safetyNotes":null,"reason":"natural_confirm"}
action: confirm_booking|decline_request|change_request|reply|silence|clarify|none
Natural confirm after book prompt → confirm_booking. After Q&A ambiguous ack ≠ confirm. Questions/negotiate → facts-only reply; never invent amounts/policies/discounts. Clear offer decline → decline_request. Social no/thanks after Q&A → silence/reply. Change car/duration → change_request (no mutation). No pamiss/owner follow-up. Short Roman Urdu.
If your reply intentionally asks the customer to confirm booking again, set asksForBookingConfirmation=true (structured). Do not set it for ordinary Q&A answers.`;

  let userPayload =
    `VERIFIED_FACTS_JSON:\n${factsJson}\n\nLAST_EMILY_MESSAGE:\n${lastEmily || "(none)"}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;
  if (historyLine) userPayload += `\n\nRECENT_CONVERSATION:\n${historyLine}`;

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

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.3,
        max_tokens: 320,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `${userPayload}\n\nJSON only; facts only; confirm only when context supports it.`,
          },
        ],
      })
    );
    const timed =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Promise.race([
            createPromise,
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("WAITING_CONFIRM_DM_OPENAI_TIMEOUT")),
                Math.floor(Number(timeoutMs))
              );
            }),
          ])
        : createPromise;
    const resp = await timed;
    const decision = parseWaitingConfirmDmDecision(
      resp?.choices?.[0]?.message?.content ?? ""
    );
    if (!decision) {
      return {
        ok: false,
        decision: defaultDecision({ reason: "PARSE_FAILED" }),
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }
    return { ok: true, decision, source: "openai" };
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
