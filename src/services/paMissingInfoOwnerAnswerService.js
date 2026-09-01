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
import {
  applyPaMissingInfoOwnerAnswer,
  applyPaMissingInfoOwnerClarification,
  applyPaMissingInfoCustomerClarificationAnswer,
  findPaMissingInfoRequestByOwnerNotifyProviderMessageId,
  getPaMissingInfoRequest,
  isCatalogLaunchMissingInfoScope,
  isPaMissingInfoRequestExpired,
  isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback,
  listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests,
  listAwaitingCustomerClarificationRequestsForCustomer,
  markPaMissingInfoAwaitingCustomerClarification,
  markPaMissingInfoCustomerFollowupFailed,
  markPaMissingInfoCustomerFollowupSent,
  markPaMissingInfoOwnerClarificationDeliveryFailed,
  markPaMissingInfoOwnerClarificationRelayFailed,
  markPaMissingInfoOwnerClarificationRelaySent,
  PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES,
  PA_MISSING_INFO_POST_ANSWER_STATUSES,
  PA_MISSING_INFO_TYPES,
} from "./paMissingInfoRequestService.js";
import {
  resolvePaMissingInfoOwnerTarget,
  sendPaMissingInfoOwnerClarificationRelay,
} from "./paMissingInfoOwnerNotifyService.js";
import {
  CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
  classifyPaMissingInfoOwnerResponseKind,
  generatePaMissingInfoCustomerClarificationStatusReply,
  generatePaMissingInfoCustomerFollowupFromOwnerAnswer,
  generatePaMissingInfoOwnerClarificationCustomerRelay,
} from "./customerBusinessPaAiReply.js";

const PAMISS_TOKEN_RE = /\b(pamiss_[a-f0-9]{12,32})\b/i;

/** Owner-facing nudge when reply is not a WhatsApp quote of the notification. */
export const PA_MISSING_INFO_OWNER_QUOTE_NUDGE =
  "Please reply directly to the customer question notification (swipe/reply on that message) so Emily can match your answer.";

/** Owner-facing nudge when multiple eligible owner_notified requests exist. */
export const PA_MISSING_INFO_OWNER_AMBIGUOUS_NUDGE =
  "Multiple customer questions are waiting for your answer. Please reply directly to the correct customer question notification (swipe/reply on that message) so Emily can match your answer.";

/** Owner-facing nudge when the quoted notification is past expiry. */
export const PA_MISSING_INFO_OWNER_EXPIRED_NUDGE =
  "That customer question is no longer current. Please reply to a newer notification if you still need to answer.";

/**
 * Owner-facing instruction when classifier cannot safely choose final vs clarification.
 * Not customer-facing. No regex routing — meaning classify already failed/unsure.
 */
export const PA_MISSING_INFO_OWNER_RESPONSE_KIND_CLARIFY =
  [
    "Emily could not tell whether your reply is the final answer for the customer or a follow-up question.",
    "",
    "Please reply again to the same notification and clearly choose one:",
    "A) Final answer — the information the customer should receive",
    "B) Follow-up question — what you need the customer to clarify first",
  ].join("\n");

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/** Extract an explicitly PKR-denominated positive amount from a trusted answer. */
export function extractTrustedOwnerAdvanceAmount(value) {
  const text = clean(value, 800);
  if (!text || !/\b(?:pkr|rs\.?|rupees?)\b/i.test(text)) return null;
  const afterCurrency = text.match(
    /\b(?:pkr|rs\.?|rupees?)\s*([0-9][0-9,]*(?:\.\d+)?)/i
  );
  const beforeCurrency = text.match(
    /([0-9][0-9,]*(?:\.\d+)?)\s*\b(?:pkr|rs\.?|rupees?)\b/i
  );
  const raw = afterCurrency?.[1] || beforeCurrency?.[1] || "";
  const amount = Number(raw.replace(/,/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
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
  text = PA_MISSING_INFO_OWNER_QUOTE_NUDGE,
}) {
  const to = phoneDigitsOnly(ownerPhone);
  if (!to) return { sent: false };
  try {
    await sendWhatsAppMessageFn(
      to,
      text,
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
 *   __classifyOwnerResponseKindFn?: typeof classifyPaMissingInfoOwnerResponseKind,
 *   __generateClarificationRelayFn?: typeof generatePaMissingInfoOwnerClarificationCustomerRelay,
 *   __chatCompletionsCreateForTests?: Function,
 *   __appendConversationMessageFn?: typeof appendConversationMessage,
 *   __listOwnerNotifiedEligibleForTokenlessFallbackFn?: typeof listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests,
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
  __classifyOwnerResponseKindFn = classifyPaMissingInfoOwnerResponseKind,
  __generateClarificationRelayFn =
    generatePaMissingInfoOwnerClarificationCustomerRelay,
  __chatCompletionsCreateForTests = null,
  __appendConversationMessageFn = appendConversationMessage,
  __listOwnerNotifiedEligibleForTokenlessFallbackFn =
    listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests,
} = {}) {
  const flagsOn = missingInfoEnabled && ownerAnswerEnabled;
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

  /** @type {Record<string, unknown> | null} */
  let request = null;
  /** @type {string | null} */
  let matchReason = null;

  if (quotedId) {
    request = await findPaMissingInfoRequestByOwnerNotifyProviderMessageId({
      db: connection,
      businessId: uid,
      ownerNotifyProviderMessageId: quotedId,
    });
    matchReason = request ? "CONTEXT_ID" : null;

    if (!request) {
      if (!flagsOn) {
        return { handled: false, reason: "FLAG_OFF" };
      }
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
    if (!flagsOn && !isCatalogLaunchMissingInfoScope(request)) {
      return { handled: false, reason: "FLAG_OFF" };
    }
  } else {
    const eligible =
      await __listOwnerNotifiedEligibleForTokenlessFallbackFn({
        db: connection,
        businessId: uid,
      });
    // Never prefer catalog over booking (or vice versa). Resolve only when
    // exactly one eligible notified request exists across all scopes.
    if (eligible.length === 0) {
      return {
        handled: false,
        reason: flagsOn ? "NO_ELIGIBLE_OWNER_NOTIFIED_REQUEST" : "FLAG_OFF",
        customerFollowupSent: false,
        matchReason: null,
        debugTokenPresent: Boolean(parsed.requestId),
      };
    }

    if (eligible.length > 1) {
      await sendOwnerQuoteNudge({
        sendWhatsAppMessageFn,
        ownerPhone: ownerTarget,
        sendCredentials,
        text: PA_MISSING_INFO_OWNER_AMBIGUOUS_NUDGE,
      });
      return {
        handled: true,
        reason: "AMBIGUOUS_ELIGIBLE_REQUESTS",
        action: "owner_answer_unmatched",
        customerFollowupSent: false,
        matchReason: null,
        eligibleCount: eligible.length,
        debugTokenPresent: Boolean(parsed.requestId),
      };
    }

    request = eligible[0];
    matchReason = "SINGLE_OWNER_NOTIFIED";
    if (!flagsOn && !isCatalogLaunchMissingInfoScope(request)) {
      return { handled: false, reason: "FLAG_OFF" };
    }
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

  if (
    matchReason === "SINGLE_OWNER_NOTIFIED" &&
    !isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback(request)
  ) {
    return {
      handled: false,
      reason: "NO_ELIGIBLE_OWNER_NOTIFIED_REQUEST",
      customerFollowupSent: false,
      matchReason: null,
      debugTokenPresent: Boolean(parsed.requestId),
    };
  }

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

  if (isPaMissingInfoRequestExpired(request)) {
    await sendOwnerQuoteNudge({
      sendWhatsAppMessageFn,
      ownerPhone: ownerTarget,
      sendCredentials,
      text: PA_MISSING_INFO_OWNER_EXPIRED_NUDGE,
    });
    return {
      handled: true,
      reason: "REQUEST_EXPIRED",
      action: "owner_answer_unmatched",
      requestId,
      customerFollowupSent: false,
      matchReason,
      status,
    };
  }

  // Already awaiting customer after this same clarification webhook.
  if (
    status === "awaiting_customer_clarification" &&
    messageId &&
    clean(request.ownerClarificationMessageId, 160) === clean(messageId, 160)
  ) {
    return {
      handled: true,
      reason: "IDEMPOTENT_SAME_MESSAGE",
      action: "owner_clarification_skipped",
      requestId,
      matchReason,
      customerFollowupSent: false,
      status,
      ownerResponseKind: "clarification_question",
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

  const kindResult = await __classifyOwnerResponseKindFn({
    customerQuestion: request.customerQuestion,
    missingInfoType: request.missingInfoType,
    ownerMessage: ownerAnswer,
    __chatCompletionsCreateForTests,
  });
  const rawKind = clean(kindResult?.kind, 40);
  const ownerResponseKind =
    kindResult?.ok === true && rawKind === "final_answer"
      ? "final_answer"
      : kindResult?.ok === true && rawKind === "clarification_question"
        ? "clarification_question"
        : "unclear";

  const missingInfoType = clean(request.missingInfoType, 40);
  const trustedOwnerAdvanceAmount =
    missingInfoType === "advance"
      ? extractTrustedOwnerAdvanceAmount(ownerAnswer)
      : null;

  if (
    trustedOwnerAdvanceAmount != null &&
    matchReason !== "CONTEXT_ID"
  ) {
    await sendOwnerQuoteNudge({
      sendWhatsAppMessageFn,
      ownerPhone: ownerTarget,
      sendCredentials,
    });
    return {
      handled: true,
      reason: "ADVANCE_AMOUNT_REQUIRES_EXACT_CONTEXT",
      action: "owner_answer_rejected",
      requestId,
      matchReason,
      customerFollowupSent: false,
      ownerResponseKind,
      status,
    };
  }

  // Unclear / classifier failure: do not apply final or start clarification loop.
  if (ownerResponseKind === "unclear") {
    await sendOwnerQuoteNudge({
      sendWhatsAppMessageFn,
      ownerPhone: ownerTarget,
      sendCredentials,
      text: PA_MISSING_INFO_OWNER_RESPONSE_KIND_CLARIFY,
    });
    console.log("[pa_missing_info_owner_answer_result]", {
      businessId: uid,
      requestId,
      matchReason,
      customerFollowupSent: false,
      ownerResponseKind: "unclear",
      classifyOk: kindResult?.ok === true,
      classifyReason: clean(kindResult?.reason, 160) || null,
    });
    return {
      handled: true,
      reason: "OWNER_RESPONSE_KIND_UNCLEAR",
      action: "owner_answer_kind_unclear",
      requestId,
      matchReason,
      customerFollowupSent: false,
      ownerResponseKind: "unclear",
      status,
      recoverable: true,
      classifyReason: clean(kindResult?.reason, 160) || null,
    };
  }

  // --- Clarification question: keep pamiss open ---
  if (ownerResponseKind === "clarification_question") {
    const appliedClarification = await applyPaMissingInfoOwnerClarification({
      db: connection,
      businessId: uid,
      requestId,
      ownerClarificationText: ownerAnswer,
      ownerClarificationMessageId: clean(messageId, 160) || null,
    });

    if (!appliedClarification?.ok) {
      return {
        handled: true,
        reason: appliedClarification?.reason || "APPLY_CLARIFICATION_FAILED",
        action: "owner_answer_unmatched",
        requestId,
        matchReason,
        customerFollowupSent: false,
      };
    }

    if (appliedClarification.applied === false) {
      return {
        handled: true,
        reason: appliedClarification.reason || "IDEMPOTENT_SKIP",
        action: "owner_clarification_skipped",
        requestId,
        matchReason,
        customerFollowupSent: false,
        status:
          clean(appliedClarification.request?.status, 40) || status,
        ownerResponseKind: "clarification_question",
      };
    }

    const customerPhone = phoneDigitsOnly(
      appliedClarification.request?.customerPhone || request.customerPhone
    );
    if (!customerPhone) {
      await markPaMissingInfoOwnerClarificationDeliveryFailed({
        db: connection,
        businessId: uid,
        requestId,
        error: "CUSTOMER_PHONE_MISSING",
      });
      return {
        handled: true,
        reason: "CUSTOMER_PHONE_MISSING",
        action: "owner_clarification_failed",
        requestId,
        matchReason,
        customerFollowupSent: false,
        ownerResponseKind: "clarification_question",
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

    const ai = await __generateClarificationRelayFn({
      facts,
      customerQuestion:
        appliedClarification.request?.customerQuestion ||
        request.customerQuestion,
      ownerClarification: ownerAnswer,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
    });

    const followupText = clean(
      ai?.reply || ownerAnswer || CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
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

      await markPaMissingInfoAwaitingCustomerClarification({
        db: connection,
        businessId: uid,
        requestId,
        customerClarificationPromptText: followupText,
        providerMessageId,
      });

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
        ownerResponseKind: "clarification_question",
        openaiUsed: ai?.source === "openai",
      });

      return {
        handled: true,
        reason: "CUSTOMER_CLARIFICATION_SENT",
        action: "owner_clarification_sent",
        requestId,
        matchReason,
        customerPhone,
        customerFollowupSent: true,
        customerFollowupText: followupText,
        openaiUsed: ai?.source === "openai",
        openaiSource: ai?.source ?? "technical_fallback",
        ownerResponseKind: "clarification_question",
        status: "awaiting_customer_clarification",
      };
    } catch (err) {
      const error =
        clean(err?.message || String(err), 400) || "WHATSAPP_API_FAILED";
      await markPaMissingInfoOwnerClarificationDeliveryFailed({
        db: connection,
        businessId: uid,
        requestId,
        error,
        customerClarificationPromptText: followupText,
      });
      return {
        handled: true,
        reason: "CUSTOMER_CLARIFICATION_FAILED",
        action: "owner_clarification_failed",
        requestId,
        matchReason,
        customerFollowupSent: false,
        error,
        ownerResponseKind: "clarification_question",
        status: "owner_notified",
      };
    }
  }

  // --- Final answer: existing path ---
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
    trustedOwnerAdvanceAmount,
    styleKey: "casual_local",
    __chatCompletionsCreateForTests,
  });

  const followupText = clean(ai?.ok === true ? ai.reply : "", 500);

  if (!followupText || ai?.source !== "openai") {
    const error = clean(ai?.reason, 400) || "OWNER_ANSWER_COMPOSITION_FAILED";
    await markPaMissingInfoCustomerFollowupFailed({
      db: connection,
      businessId: uid,
      requestId,
      error,
    });
    return {
      handled: true,
      reason: "CUSTOMER_FOLLOWUP_PREPARATION_FAILED",
      action: "owner_answer_followup_failed",
      requestId,
      matchReason,
      customerFollowupSent: false,
      error,
      ownerResponseKind: "final_answer",
      status: "customer_followup_failed",
    };
  }

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
      ownerResponseKind: "final_answer",
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
      ownerResponseKind: "final_answer",
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
  if (result.reason === "NO_ELIGIBLE_OWNER_NOTIFIED_REQUEST") return null;
  return result;
}

/**
 * Bind a customer DM to exactly one awaiting_customer_clarification pamiss.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   sendCredentials?: unknown,
 *   missingInfoEnabled?: boolean,
 *   ownerAnswerEnabled?: boolean,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   __listAwaitingFn?: Function,
 *   __sendOwnerClarificationRelayFn?: Function,
 *   __generateClarificationStatusReplyFn?: typeof generatePaMissingInfoCustomerClarificationStatusReply,
 *   __chatCompletionsCreateForTests?: Function,
 *   __appendConversationMessageFn?: typeof appendConversationMessage,
 * }} p
 */
export async function handlePaMissingInfoCustomerClarificationInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  sendCredentials = null,
  missingInfoEnabled = isEmilyBusinessPaMissingInfoEnabled(),
  ownerAnswerEnabled = isEmilyBusinessPaMissingInfoOwnerAnswerEnabled(),
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  __listAwaitingFn = null,
  __sendOwnerClarificationRelayFn = null,
  __generateClarificationStatusReplyFn = null,
  __chatCompletionsCreateForTests = null,
  __appendConversationMessageFn = appendConversationMessage,
} = {}) {
  if (!missingInfoEnabled || !ownerAnswerEnabled) {
    return { handled: false, reason: "FLAG_OFF" };
  }

  const uid = clean(businessId, 120);
  const phone = phoneDigitsOnly(customerPhone);
  const text = clean(messageText, 800);
  if (!connection || !uid || !phone || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  const listFn =
    typeof __listAwaitingFn === "function"
      ? __listAwaitingFn
      : listAwaitingCustomerClarificationRequestsForCustomer;
  const relayFn =
    typeof __sendOwnerClarificationRelayFn === "function"
      ? __sendOwnerClarificationRelayFn
      : sendPaMissingInfoOwnerClarificationRelay;
  const statusReplyFn =
    typeof __generateClarificationStatusReplyFn === "function"
      ? __generateClarificationStatusReplyFn
      : generatePaMissingInfoCustomerClarificationStatusReply;

  async function sendCustomerStatusReply(situation, trusted = {}) {
    const ai = await statusReplyFn({
      situation,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
      ...trusted,
    });
    const reply = clean(ai?.reply, 500);
    if (!reply) return { sent: false, reply: "", source: ai?.source ?? null };
    try {
      await sendWhatsAppMessageFn(
        phone,
        reply,
        sendCredentials ?? undefined,
        { recipientType: "individual" }
      );
      if (typeof __appendConversationMessageFn === "function") {
        await __appendConversationMessageFn(connection, {
          ownerUserId: uid,
          customerNumber: phone,
          role: "assistant",
          text: reply,
        }).catch(() => null);
      }
      return { sent: true, reply, source: ai?.source ?? null };
    } catch {
      return { sent: false, reply, source: ai?.source ?? null };
    }
  }

  const awaiting = await listFn({
    db: connection,
    businessId: uid,
    customerPhone: phone,
  });

  // Idempotent webhook after relay already completed (status no longer awaiting).
  if ((!Array.isArray(awaiting) || awaiting.length === 0) && messageId) {
    const col = connection
      ?.collection?.("businesses")
      ?.doc?.(uid)
      ?.collection?.("paMissingInfoRequests");
    if (col) {
      const snap = await col.limit(80).get().catch(() => null);
      for (const doc of snap?.docs ?? []) {
        const data = doc.data() || {};
        const rowPhone = phoneDigitsOnly(data.customerPhone);
        if (
          !rowPhone ||
          !(
            rowPhone === phone ||
            rowPhone.endsWith(phone) ||
            phone.endsWith(rowPhone)
          )
        ) {
          continue;
        }
        if (
          clean(data.customerClarificationMessageId, 160) ===
            clean(messageId, 160) &&
          clean(data.ownerClarificationRelayStatus, 40) === "sent"
        ) {
          return {
            handled: true,
            reason: "IDEMPOTENT_SAME_MESSAGE",
            action: "customer_clarification_skipped",
            requestId: clean(data.requestId || doc.id, 120),
            customerFollowupSent: false,
            status: clean(data.status, 40) || null,
          };
        }
      }
    }
  }

  if (!Array.isArray(awaiting) || awaiting.length === 0) {
    return { handled: false, reason: "NO_AWAITING_CLARIFICATION" };
  }

  if (awaiting.length > 1) {
    const statusSend = await sendCustomerStatusReply(
      "multiple_awaiting_clarification",
      {
        awaitingCount: awaiting.length,
        customerClarificationAnswer: text,
      }
    );
    return {
      handled: true,
      reason: "AMBIGUOUS_AWAITING_CLARIFICATION",
      action: "customer_clarification_ambiguous",
      awaitingCount: awaiting.length,
      customerFollowupSent: statusSend.sent,
      customerFollowupText: statusSend.reply || null,
    };
  }

  const request = awaiting[0];
  const requestId =
    clean(request.requestId || request.id, 120) || null;
  if (!requestId) {
    await sendCustomerStatusReply(
      "customer_clarification_could_not_be_safely_bound",
      {
        customerQuestion: request?.customerQuestion,
        ownerClarification: request?.ownerClarificationText,
        customerClarificationAnswer: text,
      }
    );
    return {
      handled: true,
      reason: "REQUEST_ID_MISSING",
      action: "customer_clarification_bind_unsafe",
      customerFollowupSent: false,
    };
  }

  const applied = await applyPaMissingInfoCustomerClarificationAnswer({
    db: connection,
    businessId: uid,
    requestId,
    customerClarificationAnswer: text,
    customerClarificationMessageId: clean(messageId, 160) || null,
  });

  if (!applied?.ok) {
    await sendCustomerStatusReply(
      "customer_clarification_could_not_be_safely_bound",
      {
        customerQuestion: request.customerQuestion,
        ownerClarification: request.ownerClarificationText,
        customerClarificationAnswer: text,
      }
    );
    return {
      handled: true,
      reason: applied?.reason || "APPLY_CUSTOMER_CLARIFICATION_FAILED",
      action: "customer_clarification_bind_unsafe",
      requestId,
      customerFollowupSent: false,
    };
  }

  if (applied.applied === false) {
    // Idempotent / already relayed — do not resend.
    return {
      handled: true,
      reason: applied.reason || "IDEMPOTENT_SKIP",
      action: "customer_clarification_skipped",
      requestId,
      customerFollowupSent: false,
      status: clean(applied.request?.status, 40) || null,
    };
  }

  const row = applied.request || request;
  const relay = await relayFn({
    db: connection,
    businessId: uid,
    request: { ...row, requestId },
    sendCredentials,
    sendWhatsAppMessageFn,
  });

  if (!relay?.ok || !relay.providerMessageId) {
    await markPaMissingInfoOwnerClarificationRelayFailed({
      db: connection,
      businessId: uid,
      requestId,
      error: relay?.error || relay?.reason || "OWNER_RELAY_FAILED",
    });
    return {
      handled: true,
      reason: "OWNER_CLARIFICATION_RELAY_FAILED",
      action: "customer_clarification_relay_failed",
      requestId,
      customerFollowupSent: false,
      status: "awaiting_customer_clarification",
      recoverable: true,
    };
  }

  await markPaMissingInfoOwnerClarificationRelaySent({
    db: connection,
    businessId: uid,
    requestId,
    ownerNotifyProviderMessageId: relay.providerMessageId,
  });

  // Customer status wording — OpenAI from trusted situation only (not a fact answer).
  const statusSend = await sendCustomerStatusReply(
    "customer_answer_forwarded_to_owner",
    {
      customerQuestion:
        row.customerQuestion || request.customerQuestion || null,
      ownerClarification:
        row.ownerClarificationText || request.ownerClarificationText || null,
      customerClarificationAnswer: text,
    }
  );

  console.log("[pa_missing_info_customer_clarification_result]", {
    businessId: uid,
    requestId,
    ownerNotifyProviderMessageId: relay.providerMessageId,
    customerStatusSent: statusSend.sent,
  });

  return {
    handled: true,
    reason: "OWNER_CLARIFICATION_RELAY_SENT",
    action: "customer_clarification_relayed",
    requestId,
    ownerNotifyProviderMessageId: relay.providerMessageId,
    customerFollowupSent: true,
    customerFollowupText: statusSend.reply || null,
    status: "owner_notified",
  };
}

/**
 * Buffer/agent entry for customer clarification bind.
 */
export async function tryHandlePaMissingInfoCustomerClarification(params) {
  const result = await handlePaMissingInfoCustomerClarificationInbound(params);
  if (!result || result.handled !== true) return null;
  return result;
}
