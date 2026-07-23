/**
 * Emily Business PA — thin post-confirm customer DM ownership lane.
 * Brain-owned facts → action guard → OpenAI natural reply.
 * Never creates/updates/cancels bookings. Never notifies owner.
 * No canned topic reply engine.
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { isEmilyBusinessPaAgentEnabled } from "../brain/config/liveFeatureFlags.js";
import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import {
  CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
  generateCustomerBusinessPaReplyFromFacts,
} from "./customerBusinessPaAiReply.js";
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
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 *   __generateCustomerBusinessPaReplyFromFactsFn?: typeof generateCustomerBusinessPaReplyFromFacts,
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
  __resolveActiveCustomerBookingFactsFn = resolveActiveCustomerBookingFacts,
  __generateCustomerBusinessPaReplyFromFactsFn = generateCustomerBusinessPaReplyFromFacts,
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
  void messageId;

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
  const action = classifyCustomerBusinessPaActionIntent(text, facts);
  if (action.isAction) {
    return {
      handled: false,
      reason: "ACTION_INTENT",
      actionKind: action.kind,
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

  const ai = await __generateCustomerBusinessPaReplyFromFactsFn({
    facts,
    userMessage: text,
    conversationHistory,
    styleKey: "casual_local",
    __chatCompletionsCreateForTests,
  });

  const reply = clean(ai?.reply || CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK, 500);
  const openaiUsed = ai?.source === "openai" && ai?.ok === true;
  const reason = openaiUsed ? "HANDLED" : "HANDLED_FALLBACK";

  await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
    recipientType: "individual",
  }).catch(() => null);

  return {
    handled: true,
    action: "business_pa_reply",
    reply,
    bookingId: clean(facts.booking?.id) || null,
    availabilityRequestId: clean(facts.booking?.availabilityRequestId) || null,
    reason,
    openaiUsed,
    openaiSource: ai?.source ?? "technical_fallback",
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
