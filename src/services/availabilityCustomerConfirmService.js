import db from "../config/firebase.js";
import { isEmilyBrainV2AvailabilityConfirmExecuteEnabled } from "../brain/config/liveFeatureFlags.js";
import {
  buildApprovedAvailabilityCustomerMessage,
  buildAvailabilityConfirmClarificationReply,
  buildAvailabilityConfirmDisambiguationReply,
  buildAvailabilityConfirmSuccessReply,
  formatAvailabilityDurationPhrase,
  resolveAvailabilityApprovedPriceQuote,
} from "./availabilityMessageBuilder.js";
import { findVerifiedAvailabilityAlternatives } from "./availabilityRejectionAlternatives.js";
import {
  buildRejectedAvailabilityNoOptionsMessage,
  buildRejectedAvailabilityWithAlternativesMessage,
} from "./availabilityMessageBuilder.js";
import { executeCreateBooking } from "./executors/createBookingExecutor.js";
import { findItemByName } from "./inventoryService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import {
  claimAvailabilityRequestCustomerConfirmProcessing,
  findLatestWaitingConfirmAvailabilityRequest,
  findWaitingConfirmAvailabilityRequestsByPhone,
  getAvailabilityRequest,
  resolveAvailabilityParticipantDisplayName,
  updateAvailabilityRequestCustomerConfirmationState,
  updateAvailabilityRequestFields,
} from "./availabilityRequestService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
}

export function classifyAvailabilityCustomerDmIntent(message) {
  const raw = clean(message);
  const lower = raw.toLowerCase();
  if (!raw) return "unclear";
  if (
    /\b(nahi|no|cancel|rehne dein|not now|mat|nope)\b/i.test(lower) &&
    !/\b(book|confirm|haan|yes|ok)\b/i.test(lower)
  ) {
    return "decline";
  }
  if (
    /\b(haan\s+book|book kar do|confirm kar do|yes confirm|ok confirm|book kar do|confirm booking|haan confirm|ji confirm|ok book|yes book)\b/i.test(
      lower
    ) ||
    (/^(haan|haan jee|yes|ok|okay|confirm|ji)$/i.test(lower) &&
      raw.split(/\s+/).filter(Boolean).length <= 2)
  ) {
    return "confirm";
  }
  if (/\b(rent kitna|price\??|kitna hoga|kitna hai|rate kya|kiraya)\b/i.test(lower)) {
    return "price";
  }
  if (/\b(koi aur option|aur cars?|alternative|dusri car|corolla available|available hai\??)\b/i.test(lower)) {
    return "alternatives";
  }
  if (/\b(instead|ke liye kar do|chahiye instead|badle|change)\b/i.test(lower)) {
    return "change_request";
  }
  return "unclear";
}

/**
 * @param {Record<string, unknown>} request
 * @param {string} message
 */
export function scoreAvailabilityRequestMatch(request, message) {
  const text = clean(message).toLowerCase();
  const itemLabel = clean(request?.itemLabel).toLowerCase();
  if (!itemLabel || !text) return 0;
  const tokens = itemLabel.split(/\s+/).filter((token) => token.length >= 4);
  const anchors = tokens.length > 0 ? tokens : [itemLabel];
  for (const anchor of anchors) {
    const pattern = new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) return 2;
  }
  return 0;
}

/**
 * @param {Record<string, unknown>[]} requests
 * @param {string} message
 */
export function selectAvailabilityRequestForCustomerMessage(requests, message) {
  const pool = Array.isArray(requests) ? requests : [];
  if (pool.length === 0) return { request: null, reason: "NO_MATCH" };
  if (pool.length === 1) return { request: pool[0], reason: "SINGLE_MATCH" };
  const scored = pool
    .map((request) => ({
      request,
      score: scoreAvailabilityRequestMatch(request, message),
    }))
    .sort((a, b) => b.score - a.score);
  const top = scored.filter((entry) => entry.score > 0);
  if (top.length === 1) {
    return { request: top[0].request, reason: "ITEM_MENTION_DISAMBIGUATED" };
  }
  const options = pool.slice(0, 3).map((row) => {
    const label = clean(row.itemLabel) || "car";
    const duration = formatAvailabilityDurationPhrase(row);
    return `${label} ${duration}`.trim();
  });
  return {
    request: null,
    reason: "AMBIGUOUS",
    disambiguationReply: buildAvailabilityConfirmDisambiguationReply(options),
  };
}

async function loadCatalogRowForRequest(businessId, request) {
  const itemId = clean(request?.itemId);
  const itemLabel = clean(request?.itemLabel);
  if (itemId) {
    const byName = await findItemByName(businessId, itemLabel || itemId).catch(() => null);
    if (byName && clean(byName.id) === itemId) return byName;
  }
  return itemLabel ? findItemByName(businessId, itemLabel).catch(() => null) : null;
}

async function buildPriceReplyForRequest(request) {
  const catalogRow = await loadCatalogRowForRequest(clean(request?.businessId), request);
  const resolved = resolveAvailabilityApprovedPriceQuote(request, catalogRow);
  if (!resolved.ok || !resolved.priceQuote) {
    return "Rate confirm kar ke bata deta hun.";
  }
  const built = buildApprovedAvailabilityCustomerMessage(request, resolved.priceQuote);
  if (!built.ok) return "Rate confirm kar ke bata deta hun.";
  return built.message;
}

async function buildAlternativesReplyForRequest(request) {
  const alternatives = await findVerifiedAvailabilityAlternatives({
    businessId: clean(request?.businessId),
    excludeItemId: clean(request?.itemId),
    referenceItemLabel: clean(request?.itemLabel),
    limit: 2,
  });
  if (alternatives.length === 0) {
    return buildRejectedAvailabilityNoOptionsMessage();
  }
  return buildRejectedAvailabilityWithAlternativesMessage(
    request,
    alternatives.map((row) => row.itemLabel)
  );
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   request: Record<string, unknown>,
 *   messageText: string,
 *   messageId?: string | null,
 *   sendCredentials?: Record<string, unknown> | null,
 *   availabilityConfirmExecute?: boolean,
 * }} params
 */
export async function executeAvailabilityCustomerConfirmBooking({
  db: connection,
  businessId,
  request,
  messageText,
  messageId = null,
  sendCredentials = null,
  availabilityConfirmExecute = isEmilyBrainV2AvailabilityConfirmExecuteEnabled(),
}) {
  const uid = clean(businessId);
  const requestId = clean(request?.requestId ?? request?.id);
  if (!uid || !requestId) {
    return { ok: false, reason: "MISSING_REQUEST" };
  }
  if (availabilityConfirmExecute !== true) {
    return { ok: false, reason: "CONFIRM_EXECUTE_DISABLED", dryRun: true };
  }
  if (clean(request?.status) !== "approved") {
    return { ok: false, reason: "REQUEST_NOT_APPROVED" };
  }
  if (clean(request?.approvalCustomerNotificationStatus) !== "sent") {
    return { ok: false, reason: "CUSTOMER_NOT_NOTIFIED" };
  }
  if (clean(request?.customerConfirmationStatus) !== "waiting_confirm") {
    return { ok: false, reason: "NOT_WAITING_CONFIRM" };
  }

  const claim = await claimAvailabilityRequestCustomerConfirmProcessing({
    db: connection,
    businessId: uid,
    requestId,
  });
  if (!claim.ok) {
    return { ok: false, reason: claim.reason || "CLAIM_FAILED", request: claim.request ?? null };
  }

  const sourceIdentity =
    request?.sourceIdentity && typeof request.sourceIdentity === "object"
      ? request.sourceIdentity
      : {};
  const durationDays =
    request?.requestedDuration != null && Number.isFinite(Number(request.requestedDuration))
      ? Math.max(1, Math.floor(Number(request.requestedDuration)))
      : null;
  if (!durationDays || !clean(request?.itemId)) {
    await updateAvailabilityRequestFields({
      db: connection,
      businessId: uid,
      requestId,
      patch: { customerConfirmProcessingStatus: "idle" },
    });
    return { ok: false, reason: "MISSING_ITEM_OR_DURATION" };
  }

  const bookingResult = await executeCreateBooking({
    payload: {
      itemId: clean(request.itemId),
      itemLabel: clean(request.itemLabel),
      itemName: clean(request.itemLabel),
      durationDays,
      approvalStage: "pending_owner_approval",
      availabilityRequestId: requestId,
      sourceMessage: clean(messageText),
      sourceTurnKey: clean(request.sourceTurnKey ?? sourceIdentity.sourceTurnKey),
      sourceMessageId: clean(sourceIdentity.sourceMessageId),
      sourceRowKey: clean(sourceIdentity.sourceRowKey),
      participantKey: clean(sourceIdentity.participantKey ?? request.customerParticipantId),
      sourceParticipantKey: clean(sourceIdentity.participantKey ?? request.customerParticipantId),
      sourceParticipantPhone: normalizePhone(request.customerPhone ?? request.customerDmTarget),
      sourceParticipantName: resolveAvailabilityParticipantDisplayName(sourceIdentity, request),
      sourceGroupName: clean(request.sourceChatId ?? sourceIdentity.chatId),
      sourcePlaywrightChatKey: clean(request.sourceChatId ?? sourceIdentity.chatId),
      execute: true,
    },
    executionContext: {
      businessId: uid,
      userId: uid,
      traceId: `availability-confirm-${requestId}`,
      message: clean(messageText),
      messageId: clean(messageId) || null,
      participantPhoneForDm: normalizePhone(request.customerPhone ?? request.customerDmTarget),
      availabilityRequestId: requestId,
      availabilityConfirmExecute: true,
      db: connection ?? db,
    },
  });

  if (bookingResult?.ok !== true || !bookingResult?.booking?.id) {
    await updateAvailabilityRequestFields({
      db: connection,
      businessId: uid,
      requestId,
      patch: {
        customerConfirmProcessingStatus: "idle",
        customerConfirmationStatus: "waiting_confirm",
      },
    });
    return {
      ok: false,
      reason: bookingResult?.reason || bookingResult?.code || "CREATE_BOOKING_FAILED",
      bookingResult,
    };
  }

  await updateAvailabilityRequestCustomerConfirmationState({
    db: connection,
    businessId: uid,
    requestId,
    customerConfirmationStatus: "confirmed",
    extra: {
      customerConfirmationAt: new Date(),
      customerConfirmationMessageId: clean(messageId) || null,
      customerConfirmationTextPreview: clean(messageText).slice(0, 160) || null,
      linkedBookingId: clean(bookingResult.booking.id),
      customerConfirmProcessingStatus: "done",
    },
  });

  return {
    ok: true,
    bookingId: clean(bookingResult.booking.id),
    reply: buildAvailabilityConfirmSuccessReply(),
  };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   sendCredentials?: Record<string, unknown> | null,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   availabilityConfirmExecute?: boolean,
 * }} params
 */
export async function handleAvailabilityCustomerCloudInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  sendCredentials = null,
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  availabilityConfirmExecute = isEmilyBrainV2AvailabilityConfirmExecuteEnabled(),
}) {
  const uid = clean(businessId);
  const phone = normalizePhone(customerPhone);
  const text = clean(messageText);
  if (!uid || !phone || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  const waiting = await findWaitingConfirmAvailabilityRequestsByPhone({
    db: connection,
    businessId: uid,
    customerPhone: phone,
  });
  const intent = classifyAvailabilityCustomerDmIntent(text);
  const selection = selectAvailabilityRequestForCustomerMessage(waiting, text);
  const request = selection.request;

  if (!request && waiting.length === 0) {
    return { handled: false, reason: "NO_WAITING_REQUEST" };
  }

  if (!request && selection.reason === "AMBIGUOUS") {
    const reply = selection.disambiguationReply || buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "disambiguation", reply };
  }

  if (!request) {
    const reply = buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "clarification", reply };
  }

  if (intent === "decline") {
    await updateAvailabilityRequestCustomerConfirmationState({
      db: connection,
      businessId: uid,
      requestId: clean(request.requestId),
      customerConfirmationStatus: "declined",
      extra: {
        customerConfirmationAt: new Date(),
        customerConfirmationMessageId: clean(messageId) || null,
        customerConfirmationTextPreview: text.slice(0, 160),
      },
    });
    const reply = "Theek hai, booking hold par hai. Agar baad mein chahiye ho to batayein.";
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "declined", reply };
  }

  if (intent === "price") {
    const reply = await buildPriceReplyForRequest(request);
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "price", reply };
  }

  if (intent === "alternatives") {
    const reply = await buildAlternativesReplyForRequest(request);
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "alternatives", reply };
  }

  if (intent === "change_request") {
    const reply =
      "Theek hai, naya item ya duration ke liye main owner se availability check kar leta hun.";
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "change_request", reply };
  }

  if (intent === "confirm") {
    const result = await executeAvailabilityCustomerConfirmBooking({
      db: connection,
      businessId: uid,
      request,
      messageText: text,
      messageId,
      sendCredentials,
      availabilityConfirmExecute,
    });
    const reply =
      result.ok === true
        ? result.reply || buildAvailabilityConfirmSuccessReply()
        : buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return {
      handled: true,
      action: result.ok ? "confirmed_booking" : "confirm_failed",
      reply,
      result,
    };
  }

  const reply = "Samajh gaya. Agar book karna hai to 'haan book kar do' likh dein.";
  await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
    recipientType: "individual",
  }).catch(() => null);
  return { handled: true, action: "unclear", reply };
}

export async function tryHandleAvailabilityCustomerCloudInbound(params) {
  const result = await handleAvailabilityCustomerCloudInbound(params);
  return result?.handled === true ? result : null;
}

export async function getTrustedWaitingConfirmRequest(params) {
  return findLatestWaitingConfirmAvailabilityRequest(params);
}

export async function loadAvailabilityRequestById(params) {
  return getAvailabilityRequest(params);
}
