/**
 * Business PA missing-info Phase 2: owner answer → customer follow-up.
 * Cloud DM only. No Playwright. No booking/AVR mutation. No knowledge persist.
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import {
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} from "../brain/config/liveFeatureFlags.js";
import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { resolvePaMissingInfoOwnerTarget } from "./paMissingInfoOwnerNotifyService.js";
import {
  applyPaMissingInfoOwnerAnswer,
  getPaMissingInfoRequest,
  listOpenForAnswerPaMissingInfoRequests,
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

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
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
 * Extract pamiss_* token and owner answer text from owner WhatsApp body.
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
    // Optional leading type label only when token was present.
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
 *   db?: unknown,
 *   businessId: string,
 *   senderPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
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
 * }} p
 */
export async function handlePaMissingInfoOwnerAnswerInbound({
  db: connection,
  businessId,
  senderPhone,
  messageText,
  messageId = null,
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
  let request = null;
  let matchReason = null;

  if (parsed.requestId) {
    request = await getPaMissingInfoRequest({
      db: connection,
      businessId: uid,
      requestId: parsed.requestId,
    });
    if (!request) {
      return {
        handled: true,
        reason: "TOKEN_NOT_FOUND",
        action: "owner_answer_unmatched",
        requestId: parsed.requestId,
        customerFollowupSent: false,
      };
    }
    matchReason = "TOKEN";
  } else {
    const openRows = await listOpenForAnswerPaMissingInfoRequests({
      db: connection,
      businessId: uid,
    });
    if (openRows.length !== 1) {
      return {
        handled: true,
        reason:
          openRows.length === 0 ? "NO_OPEN_REQUEST" : "AMBIGUOUS_OPEN_REQUESTS",
        action: "owner_answer_unmatched",
        openCount: openRows.length,
        customerFollowupSent: false,
      };
    }
    request = openRows[0];
    matchReason = "SINGLE_OPEN";
  }

  const requestId =
    clean(request.requestId || request.id, 120) || parsed.requestId;
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
      status,
    };
  }

  const ownerAnswer =
    parsed.ownerAnswer ||
    (matchReason === "SINGLE_OPEN" ? clean(text, 800) : "");
  if (!ownerAnswer) {
    return {
      handled: true,
      reason: "EMPTY_OWNER_ANSWER",
      action: "owner_answer_unmatched",
      requestId,
      customerFollowupSent: false,
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
      customerFollowupSent: false,
    };
  }

  if (applied.applied === false) {
    return {
      handled: true,
      reason: applied.reason || "IDEMPOTENT_SKIP",
      action: "owner_answer_skipped",
      requestId,
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
    const providerMessageId = clean(
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
