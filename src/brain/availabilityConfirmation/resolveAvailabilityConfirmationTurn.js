import { AVAILABILITY_DM_PROMPT_TYPES } from "./constants.js";
import {
  classifyAvailabilityConfirmationIntent,
  classifyAvailabilityCustomerQuestionTopic,
  detectAvailabilityChangeDurationIntent,
  resolveAvailabilityCustomerDmPromptType,
} from "./classifyAvailabilityConfirmationIntent.js";
import {
  buildAvailabilityChangeCarReply,
  buildAvailabilityChangeDurationReply,
  buildAvailabilityContextClarificationReply,
  buildAvailabilityPriceAnswerSoftReply,
  buildAvailabilityDeclineAckReply,
  buildAvailabilityGenericAckPromptReply,
  detectAvailabilityRequestSummaryQuestion,
} from "./availabilityConfirmationReplies.js";
import { resolveAvailabilityApprovedPriceQuote } from "../../services/availabilityMessageBuilder.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function resolveRequestedDurationDays(request) {
  const n = Number(request?.requestedDuration ?? request?.durationDays);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null;
}

/**
 * @param {import("./constants.js").AvailabilityConfirmationIntent} intent
 * @returns {import("./constants.js").AvailabilityConfirmationActionType}
 */
function mapIntentToActionType(intent) {
  if (intent === "confirm") return "confirm_booking";
  if (intent === "decline") return "decline_request";
  return "reply";
}

/**
 * @param {import("./constants.js").AvailabilityConfirmationIntent} intent
 */
function mapIntentToOutboundPromptType(intent) {
  switch (intent) {
    case "price":
    case "question":
    case "acknowledge":
    case "unclear":
      return AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION;
    case "change_duration":
    case "change_car":
    case "alternatives":
    case "decline":
      return AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO;
    default:
      return null;
  }
}

/**
 * Brain-owned decision for availability confirmation while request is waiting_confirm.
 * Does not handle group turns, general DMs, or normal workflow routing.
 *
 * @param {{
 *   request: Record<string, unknown>,
 *   messageText: string,
 * }} params
 */
export function resolveAvailabilityConfirmationTurn({ request, messageText }) {
  const text = clean(messageText);
  if (!text) {
    return { ok: false, reason: "EMPTY_MESSAGE" };
  }
  if (clean(request?.customerConfirmationStatus) !== "waiting_confirm") {
    return { ok: false, reason: "NOT_WAITING_CONFIRM" };
  }
  if (clean(request?.status) !== "approved") {
    return { ok: false, reason: "REQUEST_NOT_APPROVED" };
  }
  if (clean(request?.approvalCustomerNotificationStatus) !== "sent") {
    return { ok: false, reason: "CUSTOMER_NOT_NOTIFIED" };
  }

  let intent = classifyAvailabilityConfirmationIntent(text, request);
  const actionType = mapIntentToActionType(intent);
  const outboundPromptType = mapIntentToOutboundPromptType(intent);
  const changeDuration = detectAvailabilityChangeDurationIntent(text, request);
  let questionTopic =
    intent === "question" ? classifyAvailabilityCustomerQuestionTopic(text) : null;

  if (intent === "unclear" && detectAvailabilityRequestSummaryQuestion(text)) {
    intent = "question";
    questionTopic = "request_summary";
  }

  /** @type {string | null} */
  let reply = null;
  if (intent === "decline") {
    reply = buildAvailabilityDeclineAckReply();
  } else if (intent === "change_duration") {
    const currentDays = resolveRequestedDurationDays(request);
    const nextDays =
      changeDuration?.requestedDays != null && Number.isFinite(Number(changeDuration.requestedDays))
        ? Math.max(1, Math.floor(Number(changeDuration.requestedDays)))
        : null;
    const base = nextDays
      ? `${nextDays} din ke liye availability dobara check karni hogi.`
      : buildAvailabilityChangeDurationReply(null);
    reply =
      currentDays && nextDays
        ? `${base} Abhi current request ${currentDays} din ke liye hai.`
        : base;
  } else if (intent === "change_car") {
    reply = buildAvailabilityChangeCarReply();
  } else if (intent === "price") {
    const quote = resolveAvailabilityApprovedPriceQuote(request, null).priceQuote;
    reply = buildAvailabilityPriceAnswerSoftReply(request, quote, text);
  } else if (intent === "acknowledge") {
    reply = buildAvailabilityGenericAckPromptReply();
  } else if (intent === "unclear") {
    reply = buildAvailabilityContextClarificationReply(request);
  }

  return {
    ok: true,
    intent,
    actionType,
    outboundPromptType,
    reply,
    needsAsyncReply: ["price", "alternatives", "question"].includes(intent),
    questionTopic:
      intent === "question"
        ? questionTopic
        : intent === "price"
          ? "price"
          : null,
    changeDurationDays: changeDuration?.requestedDays ?? null,
    bookingConfirmationPromptActive:
      resolveAvailabilityCustomerDmPromptType(request) ===
      AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
  };
}

export function isAvailabilityBookingConfirmationPromptActive(request) {
  return (
    resolveAvailabilityCustomerDmPromptType(request) ===
    AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION
  );
}
