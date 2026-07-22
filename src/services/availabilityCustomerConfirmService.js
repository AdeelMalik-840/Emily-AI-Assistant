import db from "../config/firebase.js";
import { isEmilyBrainV2AvailabilityConfirmExecuteEnabled } from "../brain/config/liveFeatureFlags.js";
import {
  AVAILABILITY_DM_PROMPT_TYPES,
  buildAvailabilityAskConfirmPrompt,
  buildAvailabilityGenericAckPromptReply,
  buildAvailabilityPriceAnswerWithConfirmPrompt,
  buildAvailabilityScopedQuestionReply,
  classifyAvailabilityConfirmationIntent,
  classifyAvailabilityCustomerQuestionTopic,
  isAvailabilityBookingConfirmationPromptActive,
  resolveAvailabilityConfirmationTurn,
  resolveAvailabilityCustomerDmPromptType,
} from "../brain/availabilityConfirmation/index.js";
import {
  buildApprovedAvailabilityPriceOnlyMessage,
  buildAvailabilityConfirmClarificationReply,
  buildAvailabilityConfirmDisambiguationReply,
  buildAvailabilityConfirmSuccessReply,
  buildRejectedAvailabilityNoOptionsMessage,
  buildRejectedAvailabilityWithAlternativesMessage,
  formatAvailabilityDurationPhrase,
  resolveAvailabilityApprovedPriceQuote,
} from "./availabilityMessageBuilder.js";
import { findVerifiedAvailabilityAlternatives } from "./availabilityRejectionAlternatives.js";
import { executeCreateBooking } from "./executors/createBookingExecutor.js";
import { findItemByName } from "./inventoryService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import {
  claimAvailabilityRequestCustomerConfirmProcessing,
  findAvailabilityRequestByCloudInboundMessageId,
  findLatestWaitingConfirmAvailabilityRequest,
  findWaitingConfirmCloudAvailabilityRequestsByPhone,
  getAvailabilityRequest,
  isDuplicateAvailabilityCustomerInboundDm,
  patchAvailabilityConfirmBookingMetadata,
  recordAvailabilityCustomerDmOutbound,
  recordAvailabilityCustomerInboundDm,
  resolveAvailabilityParticipantDisplayName,
  updateAvailabilityRequestCustomerConfirmationState,
  updateAvailabilityRequestFields,
} from "./availabilityRequestService.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";

export {
  classifyAvailabilityConfirmationIntent,
  classifyAvailabilityConfirmationIntent as classifyAvailabilityCustomerDmIntent,
  isAvailabilityBookingConfirmationPromptActive,
  resolveAvailabilityConfirmationTurn,
} from "../brain/availabilityConfirmation/index.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
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

async function resolvePriceQuoteForRequest(request) {
  const catalogRow = await loadCatalogRowForRequest(clean(request?.businessId), request);
  return resolveAvailabilityApprovedPriceQuote(request, catalogRow);
}

async function buildPriceReplyForRequest(request, { withConfirmPrompt = true } = {}) {
  const resolved = await resolvePriceQuoteForRequest(request);
  if (!resolved.ok || !resolved.priceQuote) {
    return withConfirmPrompt
      ? `${buildAvailabilityAskConfirmPrompt()}`
      : "Rate confirm kar ke bata deta hun.";
  }
  if (withConfirmPrompt) {
    return buildAvailabilityPriceAnswerWithConfirmPrompt(request, resolved.priceQuote);
  }
  const built = buildApprovedAvailabilityPriceOnlyMessage(request, resolved.priceQuote);
  return built.ok ? built.message : "Rate confirm kar ke bata deta hun.";
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

async function buildQuestionReplyForRequest(request, message) {
  const topic = classifyAvailabilityCustomerQuestionTopic(message) || "unknown";
  const catalogRow = await loadCatalogRowForRequest(clean(request?.businessId), request);
  const resolved = await resolvePriceQuoteForRequest(request);
  return buildAvailabilityScopedQuestionReply({
    request,
    topic,
    messageText: message,
    catalogRow,
    priceQuote: resolved.priceQuote,
  });
}

async function resolveReplyForBrainDecision(request, decision, messageText) {
  if (decision.reply) return decision.reply;
  if (decision.intent === "price") {
    return buildPriceReplyForRequest(request, { withConfirmPrompt: true });
  }
  if (decision.intent === "alternatives") {
    return buildAlternativesReplyForRequest(request);
  }
  if (decision.intent === "question") {
    return buildQuestionReplyForRequest(request, messageText);
  }
  return buildAvailabilityGenericAckPromptReply();
}

async function sendCustomerDmReply({
  phone,
  reply,
  sendWhatsAppMessageFn,
  sendCredentials,
  connection,
  businessId,
  requestId,
  promptType,
}) {
  await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
    recipientType: "individual",
  }).catch(() => null);
  if (requestId) {
    await recordAvailabilityCustomerDmOutbound({
      db: connection,
      businessId,
      requestId,
      reply,
      promptType,
    }).catch(() => null);
  }
  return reply;
}

async function sendPlaywrightCustomerDmReply({
  reply,
  sendReplyFn,
  sendReplyOpts = {},
  connection,
  businessId,
  requestId,
  promptType,
}) {
  if (typeof sendReplyFn !== "function") {
    return { ok: false, reason: "MISSING_SEND_REPLY_FN" };
  }
  await sendReplyFn(reply, sendReplyOpts).catch(() => null);
  if (requestId) {
    await recordAvailabilityCustomerDmOutbound({
      db: connection,
      businessId,
      requestId,
      reply,
      promptType,
    }).catch(() => null);
  }
  return reply;
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

  const decision = resolveAvailabilityConfirmationTurn({
    request,
    messageText,
  });
  if (!decision.ok || decision.actionType !== "confirm_booking") {
    return {
      ok: false,
      reason: decision.reason || "BRAIN_CONFIRM_ACTION_NOT_ALLOWED",
      decision,
    };
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
  const dmChatTitle = clean(request?.customerDmChatTitle);
  const dmPlaywrightChatKey =
    clean(request?.customerDmPlaywrightChatKey) || normalizeTitle(dmChatTitle);
  const originalGroupChatKey = clean(request?.sourceChatId ?? sourceIdentity.chatId);
  const originalSourceTurnKey = clean(request?.sourceTurnKey ?? sourceIdentity.sourceTurnKey);
  const dmMessageId = clean(messageId);
  const customerConfirmTurnKey = dmMessageId
    ? `${dmPlaywrightChatKey || dmChatTitle || "dm"}::wa::${dmMessageId}`
    : null;
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
      approvalStage: "owner_approved_waiting_customer_details",
      availabilityRequestId: requestId,
      sourceMessage: clean(messageText),
      sourceTurnKey: customerConfirmTurnKey || originalSourceTurnKey || null,
      sourceMessageId: dmMessageId || null,
      sourceRowKey: clean(sourceIdentity.sourceRowKey),
      participantKey: clean(sourceIdentity.participantKey ?? request.customerParticipantId),
      sourceParticipantKey: clean(sourceIdentity.participantKey ?? request.customerParticipantId),
      sourceParticipantPhone: normalizePhone(request.customerPhone ?? request.customerDmTarget),
      sourceParticipantName: resolveAvailabilityParticipantDisplayName(sourceIdentity, request),
      sourceGroupName: originalGroupChatKey || null,
      sourcePlaywrightChatKey: originalGroupChatKey || null,
      playwrightChatKey: dmPlaywrightChatKey || dmChatTitle || null,
      groupName: dmChatTitle || dmPlaywrightChatKey || null,
      canDmCustomer: true,
      dmTargetPhone: normalizePhone(request.customerPhone ?? request.customerDmTarget),
      dmTargetSource: "availability_confirm_dm",
      execute: true,
    },
    executionContext: {
      businessId: uid,
      userId: uid,
      traceId: `availability-confirm-${requestId}`,
      message: clean(messageText),
      messageId: dmMessageId || null,
      participantPhoneForDm: normalizePhone(request.customerPhone ?? request.customerDmTarget),
      availabilityRequestId: requestId,
      availabilityConfirmExecute: true,
      playwrightChatKey: dmPlaywrightChatKey || dmChatTitle || null,
      sourcePlaywrightChatKey: originalGroupChatKey || null,
      sourceGroupName: originalGroupChatKey || null,
      groupName: dmChatTitle || dmPlaywrightChatKey || null,
      canDmCustomer: true,
      dmTargetSource: "availability_confirm_dm",
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
      customerConfirmationMessageId: dmMessageId || null,
      customerConfirmationTextPreview: clean(messageText).slice(0, 160) || null,
      linkedBookingId: clean(bookingResult.booking.id),
      customerConfirmProcessingStatus: "done",
    },
  });

  await patchAvailabilityConfirmBookingMetadata({
    db: connection,
    businessId: uid,
    bookingId: clean(bookingResult.booking.id),
    patch: {
      availabilityRequestId: requestId,
      originalAvailabilityRequestSourceTurnKey: originalSourceTurnKey || null,
      customerConfirmationMessageId: dmMessageId || null,
      customerConfirmationTextPreview: clean(messageText).slice(0, 160) || null,
      customerDmChatTitle: dmChatTitle || null,
      customerDmPlaywrightChatKey: dmPlaywrightChatKey || null,
      sourceMessage: clean(messageText),
      sourceMessageId: dmMessageId || null,
    },
  }).catch(() => null);

  return {
    ok: true,
    bookingId: clean(bookingResult.booking.id),
    reply: buildAvailabilityConfirmSuccessReply(),
  };
}

/**
 * Playwright Reply Privately DM continuation — known request, Playwright outbound only.
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   request: Record<string, unknown>,
 *   messageText: string,
 *   messageId?: string | null,
 *   sendReplyFn?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>,
 *   sendReplyOpts?: Record<string, unknown>,
 *   availabilityConfirmExecute?: boolean,
 * }} params
 */
export async function handleAvailabilityCustomerPlaywrightInbound({
  db: connection,
  businessId,
  request,
  messageText,
  messageId = null,
  sendReplyFn,
  sendReplyOpts = {},
  availabilityConfirmExecute = isEmilyBrainV2AvailabilityConfirmExecuteEnabled(),
}) {
  const uid = clean(businessId);
  const text = clean(messageText);
  const requestId = clean(request?.requestId ?? request?.id);
  if (!uid || !requestId || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }
  if (typeof sendReplyFn !== "function") {
    return { handled: false, reason: "MISSING_SEND_REPLY_FN" };
  }

  let fresh =
    (await getAvailabilityRequest({ db: connection, businessId: uid, requestId })) || request;

  const decision = resolveAvailabilityConfirmationTurn({ request: fresh, messageText: text });
  if (!decision.ok) {
    return { handled: false, reason: decision.reason || "BRAIN_DECISION_FAILED" };
  }

  if (decision.actionType === "decline_request") {
    await updateAvailabilityRequestCustomerConfirmationState({
      db: connection,
      businessId: uid,
      requestId,
      customerConfirmationStatus: "declined",
      extra: {
        customerConfirmationAt: new Date(),
        customerConfirmationMessageId: clean(messageId) || null,
        customerConfirmationTextPreview: text.slice(0, 160),
      },
    });
    const reply = await sendPlaywrightCustomerDmReply({
      reply: decision.reply,
      sendReplyFn,
      sendReplyOpts,
      connection,
      businessId: uid,
      requestId,
      promptType: decision.outboundPromptType,
    });
    return { handled: true, action: "declined", reply, decision };
  }

  if (decision.actionType === "confirm_booking") {
    const result = await executeAvailabilityCustomerConfirmBooking({
      db: connection,
      businessId: uid,
      request: fresh,
      messageText: text,
      messageId,
      availabilityConfirmExecute,
    });
    const reply =
      result.ok === true
        ? result.reply || buildAvailabilityConfirmSuccessReply()
        : buildAvailabilityConfirmClarificationReply();
    await sendReplyFn(reply, sendReplyOpts).catch(() => null);
    if (result.ok === true) {
      await recordAvailabilityCustomerDmOutbound({
        db: connection,
        businessId: uid,
        requestId,
        reply,
        promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
      }).catch(() => null);
    }
    return {
      handled: true,
      action: result.ok ? "confirmed_booking" : "confirm_failed",
      reply,
      result,
      decision,
    };
  }

  const reply = await resolveReplyForBrainDecision(fresh, decision, text);
  const replyAction =
    decision.intent === "acknowledge"
      ? "acknowledge"
      : decision.intent === "unclear"
        ? "unclear"
        : decision.intent;
  const sentReply = await sendPlaywrightCustomerDmReply({
    reply,
    sendReplyFn,
    sendReplyOpts,
    connection,
    businessId: uid,
    requestId,
    promptType: decision.outboundPromptType,
  });
  return { handled: true, action: replyAction, reply: sentReply, decision };
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
async function recordCloudInboundIdempotency({
  connection,
  businessId,
  requestId,
  messageId,
  messageText,
}) {
  const mid = clean(messageId);
  if (!requestId || !mid) return;
  await recordAvailabilityCustomerInboundDm({
    db: connection,
    businessId,
    requestId,
    message: {
      dataId: mid,
      text: messageText,
      atMs: Date.now(),
      chatKey: "cloud_dm",
    },
  }).catch(() => null);
}

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
  const inboundMessageId = clean(messageId);
  if (!uid || !phone || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  if (inboundMessageId) {
    const prior = await findAvailabilityRequestByCloudInboundMessageId({
      db: connection,
      businessId: uid,
      messageId: inboundMessageId,
    });
    if (prior) {
      return {
        handled: true,
        action: "duplicate_inbound",
        reply: null,
        requestId: clean(prior.requestId ?? prior.id) || null,
        duplicate: true,
      };
    }
  }

  const waiting = await findWaitingConfirmCloudAvailabilityRequestsByPhone({
    db: connection,
    businessId: uid,
    customerPhone: phone,
  });
  const selection = selectAvailabilityRequestForCustomerMessage(waiting, text);
  let request = selection.request;

  if (!request && waiting.length === 0) {
    return { handled: false, reason: "NO_WAITING_REQUEST" };
  }

  if (!request && selection.reason === "AMBIGUOUS") {
    const reply = selection.disambiguationReply || buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "disambiguation", reply, requestId: null };
  }

  if (!request) {
    const reply = buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return { handled: true, action: "clarification", reply, requestId: null };
  }

  const requestId = clean(request.requestId ?? request.id);
  const fresh =
    (await getAvailabilityRequest({ db: connection, businessId: uid, requestId })) || request;
  request = fresh;

  if (
    inboundMessageId &&
    (clean(request.customerConfirmationMessageId) === inboundMessageId ||
      isDuplicateAvailabilityCustomerInboundDm(request, {
        dataId: inboundMessageId,
        text,
        atMs: Date.now(),
      }))
  ) {
    return {
      handled: true,
      action: "duplicate_inbound",
      reply: null,
      requestId,
      duplicate: true,
    };
  }

  const decision = resolveAvailabilityConfirmationTurn({ request, messageText: text });
  if (!decision.ok) {
    return { handled: false, reason: decision.reason || "BRAIN_DECISION_FAILED", requestId };
  }

  if (decision.actionType === "decline_request") {
    await updateAvailabilityRequestCustomerConfirmationState({
      db: connection,
      businessId: uid,
      requestId,
      customerConfirmationStatus: "declined",
      extra: {
        customerConfirmationAt: new Date(),
        customerConfirmationMessageId: inboundMessageId || null,
        customerConfirmationTextPreview: text.slice(0, 160),
      },
    });
    const reply = await sendCustomerDmReply({
      phone,
      reply: decision.reply,
      sendWhatsAppMessageFn,
      sendCredentials,
      connection,
      businessId: uid,
      requestId,
      promptType: decision.outboundPromptType,
    });
    await recordCloudInboundIdempotency({
      connection,
      businessId: uid,
      requestId,
      messageId: inboundMessageId,
      messageText: text,
    });
    return { handled: true, action: "declined", reply, decision, requestId };
  }

  if (decision.actionType === "confirm_booking") {
    const result = await executeAvailabilityCustomerConfirmBooking({
      db: connection,
      businessId: uid,
      request,
      messageText: text,
      messageId: inboundMessageId,
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
    if (result.ok === true) {
      await recordAvailabilityCustomerDmOutbound({
        db: connection,
        businessId: uid,
        requestId,
        reply,
        promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
      }).catch(() => null);
    }
    await recordCloudInboundIdempotency({
      connection,
      businessId: uid,
      requestId,
      messageId: inboundMessageId,
      messageText: text,
    });
    return {
      handled: true,
      action: result.ok ? "confirmed_booking" : "confirm_failed",
      reply,
      result,
      decision,
      requestId,
    };
  }

  const reply = await resolveReplyForBrainDecision(request, decision, text);
  const replyAction =
    decision.intent === "acknowledge"
      ? "acknowledge"
      : decision.intent === "unclear"
        ? "unclear"
        : decision.intent;
  const sentReply = await sendCustomerDmReply({
    phone,
    reply,
    sendWhatsAppMessageFn,
    sendCredentials,
    connection,
    businessId: uid,
    requestId,
    promptType: decision.outboundPromptType,
  });
  await recordCloudInboundIdempotency({
    connection,
    businessId: uid,
    requestId,
    messageId: inboundMessageId,
    messageText: text,
  });
  return { handled: true, action: replyAction, reply: sentReply, decision, requestId };
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

/**
 * @param {{ request: Record<string, unknown> }} params
 */
export async function buildAvailabilityRecordedPriceInfoReply({ request }) {
  const reply = await buildPriceReplyForRequest(request, { withConfirmPrompt: false });
  return { reply, promptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO };
}

export { resolveAvailabilityCustomerDmPromptType };
