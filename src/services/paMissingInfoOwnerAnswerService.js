/**
 * Business PA missing-info Phase 2: owner answer → customer follow-up.
 * Cloud DM only. No Playwright. No booking/AVR mutation. No knowledge persist.
 *
 * Phase 1 correlation: WhatsApp quoted reply (context.id) →
 * ownerNotifyProviderMessageId on the pamiss request. pamiss_* is not required
 * from the owner (may appear in logs/debug only).
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { appendConversationMessage } from "./conversationStore.js";
import {
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} from "../brain/config/liveFeatureFlags.js";
import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { resolvePaMissingInfoOwnerTarget } from "./paMissingInfoOwnerNotifyService.js";
import {
  applyPaMissingInfoOwnerAnswer,
  findPaMissingInfoRequestByOwnerNotifyProviderMessageId,
  getPaMissingInfoRequest,
  markPaMissingInfoCustomerFollowupFailed,
  markPaMissingInfoCustomerFollowupSent,
  PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES,
  PA_MISSING_INFO_POST_ANSWER_STATUSES,
  PA_MISSING_INFO_TYPES,
} from "./paMissingInfoRequestService.js";
import {
  CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
  generatePaMissingInfoCustomerFollowupFromOwnerAnswer,
} from "./customerBusinessPaAiReply.js";

const PAMISS_TOKEN_RE = /\b(pamiss_[a-f0-9]{12,32})\b/i;

/** Owner-facing nudge when reply is not a WhatsApp quote of the notification. */
export const PA_MISSING_INFO_OWNER_QUOTE_NUDGE =
  "Please reply directly to the customer question notification (swipe/reply on that message) so Emily can match your answer.";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Phase 1: reject empty / punctuation-only owner replies (e.g. "???").
 * Requires at least one letter or digit. Request stays open on reject.
 * @param {string | null | undefined} value
 */
export function isUsablePaMissingInfoOwnerAnswerText(value) {
  const text = clean(value, 800);
  if (!text) return false;
  return /[\p{L}\p{N}]/u.test(text);
}

function phoneDigitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function phonesMatch(a, b) {
  const left = phoneDigitsOnly(a);
  const right = phoneDigitsOnly(b);
  if (!left || !right) return false;
  return left === right || left.endsWith(right) || right.endsWith(left);
}

/**
 * Strip optional pamiss_* token from owner body for answer text / debug logs.
 * Token is NOT used for request correlation in Phase 1.
 * @param {string} messageText
 * @returns {{ requestId: string | null, ownerAnswer: string, ownerAnswerRaw: string }}
 */
export function parsePaMissingInfoOwnerAnswerMessage(messageText) {
  const raw = clean(messageText, 1000);
  const match = raw.match(PAMISS_TOKEN_RE);
  const requestId = match ? clean(match[1], 120).toLowerCase() : null;
  let remainder = raw;
  if (match) {
    remainder = `${raw.slice(0, match.index)}${raw.slice(match.index + match[0].length)}`;
    remainder = remainder.replace(/^[\s:.\-–—]+/, "").trim();
    const typeAlt = PA_MISSING_INFO_TYPES.join("|");
    const typePrefix = new RegExp(`^(?:${typeAlt})\\b[:\\s\\-–—]*`, "i");
    remainder = remainder.replace(typePrefix, "").trim();
  }
  return {
    requestId,
    ownerAnswer: clean(remainder, 800),
    ownerAnswerRaw: raw,
  };
}

/**
 * @param {{
 *   sendWhatsAppMessageFn: typeof sendWhatsAppMessage,
 *   ownerPhone: string,
 *   sendCredentials?: unknown,
 * }} p
 */
async function sendOwnerQuoteNudge({
  sendWhatsAppMessageFn,
  ownerPhone,
  sendCredentials = null,
}) {
  const to = phoneDigitsOnly(ownerPhone);
  if (!to) return { sent: false };
  try {
    await sendWhatsAppMessageFn(
      to,
      PA_MISSING_INFO_OWNER_QUOTE_NUDGE,
      sendCredentials ?? undefined,
      { recipientType: "individual" }
    );
    return { sent: true };
  } catch {
    return { sent: false };
  }
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   senderPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   contextMessageId?: string | null,
 *   isGroupInbound?: boolean,
 *   playwrightWebInbound?: boolean,
 *   sendCredentials?: unknown,
 *   missingInfoEnabled?: boolean,
 *   ownerAnswerEnabled?: boolean,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   __resolvePaMissingInfoOwnerTargetFn?: typeof resolvePaMissingInfoOwnerTarget,
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 *   __generateFollowupFn?: typeof generatePaMissingInfoCustomerFollowupFromOwnerAnswer,
 *   __chatCompletionsCreateForTests?: Function,
 *   __appendConversationMessageFn?: typeof appendConversationMessage,
 * }} p
 */
export async function handlePaMissingInfoOwnerAnswerInbound({
  db: connection,
  businessId,
  senderPhone,
  messageText,
  messageId = null,
  contextMessageId = null,
  isGroupInbound = false,
  playwrightWebInbound = false,
  sendCredentials = null,
  missingInfoEnabled = isEmilyBusinessPaMissingInfoEnabled(),
  ownerAnswerEnabled = isEmilyBusinessPaMissingInfoOwnerAnswerEnabled(),
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  __resolvePaMissingInfoOwnerTargetFn = resolvePaMissingInfoOwnerTarget,
  __resolveActiveCustomerBookingFactsFn = resolveActiveCustomerBookingFacts,
  __generateFollowupFn = generatePaMissingInfoCustomerFollowupFromOwnerAnswer,
  __chatCompletionsCreateForTests = null,
  __appendConversationMessageFn = appendConversationMessage,
} = {}) {
  if (!missingInfoEnabled || !ownerAnswerEnabled) {
    return { handled: false, reason: "FLAG_OFF" };
  }
  if (isGroupInbound || playwrightWebInbound) {
    return { handled: false, reason: "NOT_CLOUD_DM" };
  }

  const uid = clean(businessId, 120);
  const sender = phoneDigitsOnly(senderPhone);
  const text = clean(messageText, 1000);
  if (!connection || !uid || !sender || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  const ownerTarget = await __resolvePaMissingInfoOwnerTargetFn({
    db: connection,
    businessId: uid,
  });
  if (!ownerTarget || !phonesMatch(ownerTarget, sender)) {
    return { handled: false, reason: "NOT_OWNER" };
  }

  const parsed = parsePaMissingInfoOwnerAnswerMessage(text);
  const quotedId = clean(contextMessageId, 160) || null;

  // Phase 1: require WhatsApp quote of the owner notification. No SINGLE_OPEN.
  if (!quotedId) {
    await sendOwnerQuoteNudge({
      sendWhatsAppMessageFn,
      ownerPhone: ownerTarget,
      sendCredentials,
    });
    return {
      handled: true,
      reason: "QUOTE_REQUIRED",
      action: "owner_answer_unmatched",
      customerFollowupSent: false,
      matchReason: null,
      debugTokenPresent: Boolean(parsed.requestId),
    };
  }

  let request = await findPaMissingInfoRequestByOwnerNotifyProviderMessageId({
    db: connection,
    businessId: uid,
    ownerNotifyProviderMessageId: quotedId,
  });
  let matchReason = request ? "CONTEXT_ID" : null;

  if (!request) {
    await sendOwnerQuoteNudge({
      sendWhatsAppMessageFn,
      ownerPhone: ownerTarget,
      sendCredentials,
    });
    return {
      handled: true,
      reason: "CONTEXT_UNKNOWN",
      action: "owner_answer_unmatched",
      customerFollowupSent: false,
      matchReason: null,
      contextMessageId: quotedId,
      debugTokenPresent: Boolean(parsed.requestId),
    };
  }

  const requestId =
    clean(request.requestId || request.id, 120) || null;
  if (!requestId) {
    return {
      handled: true,
      reason: "REQUEST_ID_MISSING",
      action: "owner_answer_unmatched",
      customerFollowupSent: false,
    };
  }

  // Refresh full row (list may be projection-complete already).
  const fresh = await getPaMissingInfoRequest({
    db: connection,
    businessId: uid,
    requestId,
  });
  if (fresh) request = fresh;

  const status = clean(request.status, 40);

  if (PA_MISSING_INFO_POST_ANSWER_STATUSES.includes(status)) {
    const sameMessage =
      messageId &&
      clean(request.ownerAnswerMessageId, 160) === clean(messageId, 160);
    return {
      handled: true,
      reason: sameMessage ? "IDEMPOTENT_SAME_MESSAGE" : "ALREADY_ANSWERED",
      action: "owner_answer_skipped",
      requestId,
      customerFollowupSent: false,
      matchReason,
      status,
    };
  }

  if (!PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES.includes(status)) {
    return {
      handled: true,
      reason: "NOT_OPEN_FOR_ANSWER",
      action: "owner_answer_unmatched",
      requestId,
      customerFollowupSent: false,
      matchReason,
      status,
    };
  }

  const ownerAnswer = parsed.ownerAnswer || clean(text, 800);
  if (!ownerAnswer || !isUsablePaMissingInfoOwnerAnswerText(ownerAnswer)) {
    return {
      handled: true,
      reason: "UNUSABLE_OWNER_ANSWER",
      action: "owner_answer_rejected",
      requestId,
      matchReason,
      customerFollowupSent: false,
      status,
    };
  }

  const applied = await applyPaMissingInfoOwnerAnswer({
    db: connection,
    businessId: uid,
    requestId,
    ownerAnswer,
    ownerAnswerRaw: parsed.ownerAnswerRaw || text,
    ownerAnswerMessageId: clean(messageId, 160) || null,
  });

  if (!applied?.ok) {
    return {
      handled: true,
      reason: applied?.reason || "APPLY_FAILED",
      action: "owner_answer_unmatched",
      requestId,
      matchReason,
      customerFollowupSent: false,
    };
  }

  if (applied.applied === false) {
    return {
      handled: true,
      reason: applied.reason || "IDEMPOTENT_SKIP",
      action: "owner_answer_skipped",
      requestId,
      matchReason,
      customerFollowupSent: false,
      status: clean(applied.request?.status, 40) || status,
    };
  }

  const customerPhone = phoneDigitsOnly(
    applied.request?.customerPhone || request.customerPhone
  );
  if (!customerPhone) {
    await markPaMissingInfoCustomerFollowupFailed({
      db: connection,
      businessId: uid,
      requestId,
      error: "CUSTOMER_PHONE_MISSING",
    });
    return {
      handled: true,
      reason: "CUSTOMER_PHONE_MISSING",
      action: "owner_answer_followup_failed",
      requestId,
      matchReason,
      customerFollowupSent: false,
    };
  }

  let facts = null;
  try {
    const resolved = await __resolveActiveCustomerBookingFactsFn({
      db: connection,
      businessId: uid,
      customerPhone,
    });
    if (resolved?.ok && resolved.facts) facts = resolved.facts;
  } catch {
    facts = null;
  }

  const ai = await __generateFollowupFn({
    facts,
    customerQuestion:
      applied.request?.customerQuestion || request.customerQuestion,
    missingInfoType:
      applied.request?.missingInfoType || request.missingInfoType,
    ownerAnswer,
    styleKey: "casual_local",
    __chatCompletionsCreateForTests,
  });

  const followupText = clean(
    ai?.reply || CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
    500
  );

  try {
    const sendResult = await sendWhatsAppMessageFn(
      customerPhone,
      followupText,
      sendCredentials ?? undefined,
      { recipientType: "individual" }
    );
    if (sendResult && sendResult.ok === false) {
      throw new Error(
        clean(
          sendResult?.error?.message ||
            sendResult?.error ||
            sendResult?.reason,
          200
        ) || "WHATSAPP_SEND_FAILED"
      );
    }
    const providerMessageId = clean(
      sendResult?.providerMessageId ||
        sendResult?.messages?.[0]?.id ||
        sendResult?.messageId ||
        sendResult?.id ||
        "",
      160
    );

    await markPaMissingInfoCustomerFollowupSent({
      db: connection,
      businessId: uid,
      requestId,
      customerFollowupText: followupText,
      providerMessageId,
    });

    // Memory only — same conversation thread the customer uses next turn.
    if (typeof __appendConversationMessageFn === "function") {
      await __appendConversationMessageFn(connection, {
        ownerUserId: uid,
        customerNumber: customerPhone,
        role: "assistant",
        text: followupText,
      }).catch(() => null);
    }

    console.log("[pa_missing_info_owner_answer_result]", {
      businessId: uid,
      requestId,
      matchReason,
      customerFollowupSent: true,
      openaiUsed: ai?.source === "openai",
    });

    return {
      handled: true,
      reason: "CUSTOMER_FOLLOWUP_SENT",
      action: "owner_answer_followup_sent",
      requestId,
      matchReason,
      customerPhone,
      customerFollowupSent: true,
      customerFollowupText: followupText,
      openaiUsed: ai?.source === "openai",
      openaiSource: ai?.source ?? "technical_fallback",
      status: "closed",
    };
  } catch (err) {
    const error = clean(err?.message || String(err), 400) || "WHATSAPP_API_FAILED";
    await markPaMissingInfoCustomerFollowupFailed({
      db: connection,
      businessId: uid,
      requestId,
      error,
      customerFollowupText: followupText,
    });
    return {
      handled: true,
      reason: "CUSTOMER_FOLLOWUP_FAILED",
      action: "owner_answer_followup_failed",
      requestId,
      matchReason,
      customerFollowupSent: false,
      error,
      status: "customer_followup_failed",
    };
  }
}

/**
 * Buffer entry: returns result when handled (including unmatched owner), else null.
 * Non-owner → null so customer PA / Brain continue.
 */
export async function tryHandlePaMissingInfoOwnerAnswer(params) {
  const result = await handlePaMissingInfoOwnerAnswerInbound(params);
  if (!result || result.handled !== true) return null;
  if (result.reason === "NOT_OWNER" || result.reason === "FLAG_OFF") return null;
  if (result.reason === "NOT_CLOUD_DM" || result.reason === "MISSING_CONTEXT") {
    return null;
  }
  return result;
}
