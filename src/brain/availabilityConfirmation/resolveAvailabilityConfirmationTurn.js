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
  buildAvailabilityDeclineAckReply,
  buildAvailabilityGenericAckPromptReply,
} from "./availabilityConfirmationReplies.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
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

  const intent = classifyAvailabilityConfirmationIntent(text, request);
  const actionType = mapIntentToActionType(intent);
  const outboundPromptType = mapIntentToOutboundPromptType(intent);
  const changeDuration = detectAvailabilityChangeDurationIntent(text, request);

  /** @type {string | null} */
  let reply = null;
  if (intent === "decline") {
    reply = buildAvailabilityDeclineAckReply();
  } else if (intent === "change_duration") {
    reply = buildAvailabilityChangeDurationReply(changeDuration?.requestedDays);
  } else if (intent === "change_car") {
    reply = buildAvailabilityChangeCarReply();
  } else if (intent === "acknowledge" || intent === "unclear") {
    reply = buildAvailabilityGenericAckPromptReply();
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
        ? classifyAvailabilityCustomerQuestionTopic(text)
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
