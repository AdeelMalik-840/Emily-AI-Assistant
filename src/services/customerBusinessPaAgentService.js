/**
 * Emily Business PA — post-confirm context owner + safe executor.
 * Brain facts → deterministic action block → Brain decision → execute only.
 * Never creates/updates/cancels bookings. No canned topic reply engine.
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { appendConversationMessage } from "./conversationStore.js";
import {
  isEmilyBusinessPaAgentEnabled,
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} from "../brain/config/liveFeatureFlags.js";
import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import {
  applyPostConfirmAntiEchoAndSilence,
  canEscalatePostConfirmMissingInfo,
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
 * Bare social/ending declines — NOT protected booking actions in post-confirm PA.
 * These must reach the Brain decision helper (not ClarificationWorkflow).
 */
function isBareSocialDecline(message) {
  const t = clean(message).toLowerCase();
  return /^(no|nah|nahi|nahin|nope|na)\.?$/i.test(t);
}

/**
 * Explicit booking/cancel/change protection (post-confirm PA).
 * Bare "no"/"nahi" alone is NOT an action — social closing goes to Brain.
 * @param {string} message
 * @param {Record<string, unknown> | null} [facts]
 */
export function classifyCustomerBusinessPaActionIntent(message, facts = null) {
  const text = clean(message);
  if (!text) return { isAction: false, kind: "empty" };

  // Social/ending decline → Brain decide (not AVR-confirm decline fallthrough).
  if (isBareSocialDecline(text)) {
    return { isAction: false, kind: "social_decline" };
  }

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
    /\b(reschedule|postpone)\b/i.test(text) ||
    /\b(booking\s*change|change\s*booking)\b/i.test(text)
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
  // Post-confirm: do NOT treat bare decline as ACTION_INTENT (causes Clarification leak).
  // Keep confirm / change_* from the shared classifier when they are real action phrases.
  if (
    intent === "confirm" ||
    intent === "change_duration" ||
    intent === "change_car"
  ) {
    return { isAction: true, kind: intent };
  }

  if (
    /\b(cancel\s*booking|booking\s*cancel|cancel\s*kar\s*do|cancel\s*kr\s*do|update\s*booking)\b/i.test(
      text
    ) ||
    /\b(nahi\s*chahiye|not\s*interested|rehne\s*do|rehne\s*dein)\b/i.test(text)
  ) {
    return { isAction: true, kind: "cancel_or_update" };
  }

  if (
    /\b(new\s*booking|create\s*booking|reserve\s*(kar|kr)?\s*(do|dein)?)\b/i.test(
      text
    )
  ) {
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
 *   __decideCustomerTurnFn?: typeof decideCustomerTurn,
 *   __createOrGetOpenPaMissingInfoRequestFn?: typeof createOrGetOpenPaMissingInfoRequest,
 *   __sendPaMissingInfoOwnerNotificationFn?: typeof sendPaMissingInfoOwnerNotification,
 *   __chatCompletionsCreateForTests?: Function,
 *   __appendConversationMessageFn?: typeof appendConversationMessage,
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
  __decideCustomerTurnFn = decideCustomerTurn,
  __createOrGetOpenPaMissingInfoRequestFn = createOrGetOpenPaMissingInfoRequest,
  __sendPaMissingInfoOwnerNotificationFn = sendPaMissingInfoOwnerNotification,
  __chatCompletionsCreateForTests = null,
  __appendConversationMessageFn = appendConversationMessage,
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

  // Brain shared entrypoint — PA packs context + executes; does not own meaning.
  const decided = await __decideCustomerTurnFn({
    lane: "post_confirm_pa",
    channel: "whatsapp",
    chatType: "dm",
    businessId: uid,
    customerPhone: phone,
    messageText: text,
    messageId,
    recentDialogue: conversationHistory,
    ownershipLane: "post_confirm_pa",
    activeBooking: facts.booking ?? null,
    activeAvailabilityRequest: facts.availabilityRequest ?? null,
    knownPolicies: facts.known ?? null,
    openMissingInfoRequests: facts.openMissingInfoRequests ?? null,
    latestClosedMissingInfoAnswers:
      facts.latestClosedMissingInfoAnswers ?? null,
    safetyPolicy: facts.policy ?? null,
    allowedExecutors: ["whatsapp_cloud_dm", "pa_missing_info_escalate"],
    facts,
    styleKey: "casual_local",
    missingInfoLoopFullyEnabled: loopFullyEnabled,
    __chatCompletionsCreateForTests,
  });

  let decision = decided?.decision || {
    conversationAct: "unknown",
    customerIntent: "unclear",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    action: "reply",
    shouldReply: true,
    situation: "unclear",
  };
  decision = applyPostConfirmAntiEchoAndSilence(decision, text);

  const shouldSend =
    decision.action !== "silence" &&
    decision.shouldReply !== false &&
    Boolean(clean(decision.customerReply));
  const reply = shouldSend
    ? clean(decision.customerReply, 500)
    : "";
  const openaiUsed = decided?.source === "openai" && decided?.ok === true;
  const reason = shouldSend
    ? openaiUsed
      ? "HANDLED"
      : "HANDLED_FALLBACK"
    : "HANDLED_SILENCE";

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

  if (shouldSend) {
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);

    // Memory only — do not change WhatsApp send behavior / do not double-send.
    if (connection && typeof __appendConversationMessageFn === "function") {
      await __appendConversationMessageFn(connection, {
        ownerUserId: uid,
        customerNumber: phone,
        role: "assistant",
        text: reply,
      }).catch(() => null);
    }
  }

  console.log("[customer_business_pa_result]", {
    businessId: uid,
    bookingId,
    openaiUsed,
    conversationAct: decision.conversationAct,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation,
    decisionAction: decision.action,
    shouldReply: decision.shouldReply !== false,
    sentReply: shouldSend,
    missingInfoEscalated,
    missingInfoRequestId,
    missingInfoType,
    ownerNotifyStatus,
  });

  return {
    handled: true,
    action: shouldSend ? "business_pa_reply" : "business_pa_silence",
    reply: shouldSend ? reply : "",
    sentReply: shouldSend,
    bookingId,
    availabilityRequestId,
    reason,
    openaiUsed,
    openaiSource: decided?.source ?? "technical_fallback",
    conversationAct: decision.conversationAct,
    customerIntent: decision.customerIntent ?? "unclear",
    situation: decision.situation ?? "unclear",
    decisionAction: decision.action,
    shouldReply: decision.shouldReply !== false,
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
