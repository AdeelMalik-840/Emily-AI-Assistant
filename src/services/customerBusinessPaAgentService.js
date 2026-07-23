/**
 * Emily Business PA — post-confirm context owner + safe executor.
 * Brain facts → deterministic action block → Brain decision → execute only.
 * Never creates/updates/cancels bookings. No canned topic reply engine.
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import {
  isEmilyBusinessPaAgentEnabled,
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} from "../brain/config/liveFeatureFlags.js";
import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import {
  canEscalatePostConfirmMissingInfo,
  decidePostConfirmCustomerDm,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} from "../brain/decisions/decidePostConfirmCustomerDm.js";
import {
  createOrGetOpenPaMissingInfoRequest,
  isPaMissingInfoFactMissing,
} from "./paMissingInfoRequestService.js";
import { sendPaMissingInfoOwnerNotification } from "./paMissingInfoOwnerNotifyService.js";
import {
  classifyAvailabilityConfirmationIntent,
  detectAvailabilityChangeCarIntent,
  detectAvailabilityChangeDurationIntent,
  isShortPositiveConfirmationReply,
} from "../brain/availabilityConfirmation/index.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function phoneDigitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @param {string} message
 * @param {Record<string, unknown> | null} [facts]
 */
export function classifyCustomerBusinessPaActionIntent(message, facts = null) {
  const text = clean(message);
  if (!text) return { isAction: false, kind: "empty" };

  const booking =
    facts?.booking && typeof facts.booking === "object" ? facts.booking : {};
  const avr =
    facts?.availabilityRequest && typeof facts.availabilityRequest === "object"
      ? facts.availabilityRequest
      : {};
  const requestShape = {
    itemLabel: clean(booking.itemLabel || booking.itemName || avr.itemLabel),
    requestedDuration: booking.durationDays ?? avr.requestedDuration ?? null,
    lastCustomerDmPromptType: null,
  };

  if (detectAvailabilityChangeDurationIntent(text, requestShape)) {
    return { isAction: true, kind: "change_duration" };
  }
  if (detectAvailabilityChangeCarIntent(text, requestShape)) {
    return { isAction: true, kind: "change_car" };
  }
  if (
    /\b(date\s*change|change\s*date|tarikh\s*badal|date\s*badal)\b/i.test(text) ||
    /\b(reschedule|postpone)\b/i.test(text)
  ) {
    return { isAction: true, kind: "change_date" };
  }

  if (
    /\b(book\s*kar\s*do|book\s*kr\s*do|booking\s*kar\s*do|booking\s*kr\s*do|confirm\s*kar\s*do|kar\s*do|kr\s*do|kar\s*dein|kr\s*dein)\b/i.test(
      text
    ) ||
    (isShortPositiveConfirmationReply(text) &&
      /\b(confirm|book|kar\s*do|kr\s*do|kar\s*dein|kr\s*dein|go\s*ahead|proceed)\b/i.test(
        text
      ))
  ) {
    return { isAction: true, kind: "confirm" };
  }

  const intent = classifyAvailabilityConfirmationIntent(text, requestShape);
  if (
    intent === "confirm" ||
    intent === "decline" ||
    intent === "change_duration" ||
    intent === "change_car"
  ) {
    return { isAction: true, kind: intent };
  }

  if (
    /\b(cancel\s*booking|booking\s*cancel|cancel\s*kar\s*do|cancel\s*kr\s*do|update\s*booking)\b/i.test(
      text
    )
  ) {
    return { isAction: true, kind: "cancel_or_update" };
  }

  if (/\b(new\s*booking|create\s*booking)\b/i.test(text)) {
    return { isAction: true, kind: "create_booking" };
  }

  if (
    /\b(approve|owner\s*approval|notify\s*owner)\b/i.test(text) &&
    /\b(booking|request|avr)\b/i.test(text)
  ) {
    return { isAction: true, kind: "owner_approval" };
  }

  if (
    /\b(ignore\s+previous\s+instructions|system\s+prompt|you\s+are\s+now|confirm\s+my\s+booking\s+now)\b/i.test(
      text
    ) &&
    /\b(confirm|book|cancel|update|approve)\b/i.test(text)
  ) {
    return { isAction: true, kind: "prompt_injection_action" };
  }

  return { isAction: false, kind: intent || "informational" };
}

function isLikelyDeliveryAddressOnly(message) {
  const text = clean(message);
  if (!text) return false;
  if (/[?]/.test(text)) return false;
  if (
    /\b(kitna|hoga|hai\s*na|milega|delivery|advance|driver|confirm|book|cancel)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return /\b(bahria|phase|sector|block|street|house|gali|dha|gulberg|model\s*town|i-?\d+|f-?\d+)\b/i.test(
    text
  );
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   conversationHistory?: string | null,
 *   sendCredentials?: unknown,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   businessPaEnabled?: boolean,
 *   missingInfoEscalationEnabled?: boolean,
 *   missingInfoOwnerAnswerEnabled?: boolean,
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 *   __decidePostConfirmCustomerDmFn?: typeof decidePostConfirmCustomerDm,
 *   __createOrGetOpenPaMissingInfoRequestFn?: typeof createOrGetOpenPaMissingInfoRequest,
 *   __sendPaMissingInfoOwnerNotificationFn?: typeof sendPaMissingInfoOwnerNotification,
 *   __chatCompletionsCreateForTests?: Function,
 * }} params
 */
export async function handleCustomerBusinessPaInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  conversationHistory = null,
  sendCredentials = null,
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  businessPaEnabled = isEmilyBusinessPaAgentEnabled(),
  missingInfoEscalationEnabled = isEmilyBusinessPaMissingInfoEnabled(),
  missingInfoOwnerAnswerEnabled = isEmilyBusinessPaMissingInfoOwnerAnswerEnabled(),
  __resolveActiveCustomerBookingFactsFn = resolveActiveCustomerBookingFacts,
  __decidePostConfirmCustomerDmFn = decidePostConfirmCustomerDm,
  __createOrGetOpenPaMissingInfoRequestFn = createOrGetOpenPaMissingInfoRequest,
  __sendPaMissingInfoOwnerNotificationFn = sendPaMissingInfoOwnerNotification,
  __chatCompletionsCreateForTests = null,
}) {
  if (!businessPaEnabled) {
    return { handled: false, reason: "FLAG_OFF" };
  }

  const uid = clean(businessId);
  const phone = phoneDigitsOnly(customerPhone);
  const text = clean(messageText);
  if (!uid || !phone || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  const resolved = await __resolveActiveCustomerBookingFactsFn({
    db: connection,
    businessId: uid,
    customerPhone: phone,
  });
  if (!resolved?.ok || !resolved.facts) {
    return {
      handled: false,
      reason: resolved?.reason || "NO_CONTEXT",
    };
  }

  const facts = resolved.facts;
  const actionIntent = classifyCustomerBusinessPaActionIntent(text, facts);
  if (actionIntent.isAction) {
    return {
      handled: false,
      reason: "ACTION_INTENT",
      actionKind: actionIntent.kind,
      bookingId: clean(facts.booking?.id) || null,
    };
  }

  if (isLikelyDeliveryAddressOnly(text)) {
    return {
      handled: false,
      reason: "DELIVERY_ADDRESS_FALLTHROUGH",
      bookingId: clean(facts.booking?.id) || null,
    };
  }

  const missingInfoEnabled = missingInfoEscalationEnabled === true;
  const ownerAnswerEnabled = missingInfoOwnerAnswerEnabled === true;
  const loopFullyEnabled = missingInfoEnabled && ownerAnswerEnabled;

  const decided = await __decidePostConfirmCustomerDmFn({
    facts,
    userMessage: text,
    conversationHistory,
    styleKey: "casual_local",
    missingInfoLoopFullyEnabled: loopFullyEnabled,
    __chatCompletionsCreateForTests,
  });

  const decision = decided?.decision || {
    conversationAct: "unknown",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    action: "reply",
    situation: "unclear",
  };

  const reply = clean(
    decision.customerReply || POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    500
  );
  const openaiUsed = decided?.source === "openai" && decided?.ok === true;
  const reason = openaiUsed ? "HANDLED" : "HANDLED_FALLBACK";

  let missingInfoEscalated = false;
  let missingInfoRequestId = null;
  let missingInfoType = null;
  let ownerNotifyStatus = null;

  const bookingId = clean(facts.booking?.id) || null;
  const availabilityRequestId =
    clean(facts.booking?.availabilityRequestId) || null;

  const mayEscalate = canEscalatePostConfirmMissingInfo({
    decision,
    facts,
    missingInfoEnabled,
    ownerAnswerEnabled,
    isFactMissingFn: isPaMissingInfoFactMissing,
  });

  if (mayEscalate) {
    const modelType = clean(decision.requestedInfoType, 40);
    try {
      const created = await __createOrGetOpenPaMissingInfoRequestFn({
        db: connection,
        businessId: uid,
        customerPhone: phone,
        bookingId,
        availabilityRequestId,
        missingInfoType: modelType,
        customerQuestion: text,
        customerMessageId: clean(messageId, 160) || null,
      });

      if (created?.ok && created.request) {
        missingInfoRequestId = clean(created.request.requestId, 120) || null;
        missingInfoType = modelType;

        if (created.created === true) {
          const notify = await __sendPaMissingInfoOwnerNotificationFn({
            db: connection,
            businessId: uid,
            request: created.request,
            itemLabel: clean(facts.booking?.itemLabel || facts.known?.itemLabel),
            sendCredentials,
            sendWhatsAppMessageFn,
          });
          ownerNotifyStatus = clean(notify?.ownerNotifyStatus, 40) || null;
          missingInfoEscalated = notify?.ok === true || notify?.skipped === true;
        } else {
          ownerNotifyStatus =
            clean(created.request.ownerNotifyStatus, 40) || "sent";
          missingInfoEscalated = false;
        }
      }
    } catch (err) {
      console.warn("[pa_missing_info_escalate_failed]", {
        businessId: uid,
        bookingId,
        missingInfoType: modelType,
        error: err?.message || String(err),
      });
    }
  }

  await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
    recipientType: "individual",
  }).catch(() => null);

  console.log("[customer_business_pa_result]", {
    businessId: uid,
    bookingId,
    openaiUsed,
    conversationAct: decision.conversationAct,
    situation: decision.situation,
    decisionAction: decision.action,
    missingInfoEscalated,
    missingInfoRequestId,
    missingInfoType,
    ownerNotifyStatus,
  });

  return {
    handled: true,
    action: "business_pa_reply",
    reply,
    bookingId,
    availabilityRequestId,
    reason,
    openaiUsed,
    openaiSource: decided?.source ?? "technical_fallback",
    conversationAct: decision.conversationAct,
    situation: decision.situation ?? "unclear",
    decisionAction: decision.action,
    missingInfoEscalated,
    missingInfoRequestId,
    missingInfoType,
    ownerNotifyStatus,
  };
}

/**
 * Buffer entry: returns result when handled, otherwise null.
 * @param {Parameters<typeof handleCustomerBusinessPaInbound>[0]} params
 */
export async function tryHandleCustomerBusinessPaInbound(params) {
  const result = await handleCustomerBusinessPaInbound(params);
  return result?.handled === true ? result : null;
}
