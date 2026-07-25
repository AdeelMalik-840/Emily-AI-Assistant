import db from "../config/firebase.js";
import {
  isEmilyBrainV2AvailabilityConfirmExecuteEnabled,
  isEmilyWaitingConfirmDmBrainEnabled,
} from "../brain/config/liveFeatureFlags.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import {
  evaluateWaitingConfirmDmBrainConfirmGuard,
  packWaitingConfirmDmTurnContext,
  resolveWaitingConfirmDmOutboundPromptType,
} from "../brain/decisions/waitingConfirmDmLane.js";
import {
  AVAILABILITY_DM_PROMPT_TYPES,
  buildAvailabilityAskConfirmPrompt,
  buildAvailabilityChangeCarReply,
  buildAvailabilityDeclineAckReply,
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
  findSupersededCloudAvailabilityRequestsByPhone,
  findWaitingConfirmCloudAvailabilityRequestsByPhone,
  getAvailabilityRequest,
  isDuplicateAvailabilityCustomerInboundDm,
  isTrustedWaitingConfirmBookingPromptCandidate,
  patchAvailabilityConfirmBookingMetadata,
  pickLatestTrustedWaitingConfirmRequest,
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
 * Bind Cloud confirm inbound to one AVR: unique item mention, else latest trusted
 * booking_confirmation_prompt. Ambiguity only when no clear trusted latest / tied ranks.
 *
 * @param {Record<string, unknown>[]} requests
 * @param {string} message
 * @param {{
 *   nowMs?: number,
 *   inactiveOrSupersededRequests?: Record<string, unknown>[],
 * }} [opts]
 */
export function selectAvailabilityRequestForCustomerMessage(requests, message, opts = {}) {
  const pool = Array.isArray(requests) ? requests : [];
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const inactivePool = Array.isArray(opts.inactiveOrSupersededRequests)
    ? opts.inactiveOrSupersededRequests
    : [];

  if (pool.length === 0) {
    const namedInactive = inactivePool.filter(
      (request) => scoreAvailabilityRequestMatch(request, message) > 0
    );
    if (namedInactive.length > 0) {
      return {
        request: null,
        reason: "NAMED_INACTIVE",
        disambiguationReply: buildAvailabilityConfirmClarificationReply(),
      };
    }
    return { request: null, reason: "NO_MATCH" };
  }

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
  if (top.length > 1) {
    const options = top.slice(0, 3).map((entry) => {
      const label = clean(entry.request.itemLabel) || "car";
      const duration = formatAvailabilityDurationPhrase(entry.request);
      return `${label} ${duration}`.trim();
    });
    return {
      request: null,
      reason: "AMBIGUOUS",
      disambiguationReply: buildAvailabilityConfirmDisambiguationReply(options),
    };
  }

  const namedInactive = inactivePool.filter(
    (request) => scoreAvailabilityRequestMatch(request, message) > 0
  );
  if (namedInactive.length > 0) {
    return {
      request: null,
      reason: "NAMED_INACTIVE",
      disambiguationReply: buildAvailabilityConfirmClarificationReply(),
    };
  }

  if (pool.length === 1) {
    return { request: pool[0], reason: "SINGLE_MATCH" };
  }

  const trustedLatest = pickLatestTrustedWaitingConfirmRequest(pool, nowMs);
  if (trustedLatest) {
    return { request: trustedLatest, reason: "LATEST_TRUSTED_MATCH" };
  }

  const trusted = pool.filter((row) =>
    isTrustedWaitingConfirmBookingPromptCandidate(row, nowMs)
  );
  const optionsSource = trusted.length > 1 ? trusted : pool;
  const options = optionsSource.slice(0, 3).map((row) => {
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

const PRE_CLAIM_CONFIRM_FAILURE_REASONS = new Set([
  "CONFIRM_EXECUTE_DISABLED",
  "BRAIN_CONFIRM_ACTION_NOT_ALLOWED",
  "MISSING_REQUEST",
  "CUSTOMER_NOT_NOTIFIED",
  "NOT_WAITING_CONFIRM",
  "REQUEST_NOT_APPROVED",
  "EMPTY_MESSAGE",
]);

const CLAIM_CONFIRM_FAILURE_REASONS = new Set([
  "MISSING_REQUEST_REF",
  "REQUEST_NOT_FOUND",
  "BOOKING_ALREADY_LINKED",
  "ALREADY_PROCESSING",
  "REQUEST_EXPIRED",
  "CLAIM_FAILED",
]);

const CREATE_BOOKING_CONFIRM_FAILURE_REASONS = new Set([
  "MISSING_ITEM_OR_DURATION",
  "CREATE_BOOKING_FAILED",
  "MISSING_ITEM_ID",
  "MISSING_DURATION",
  "MISSING_BUSINESS_ID",
  "BOOKING_CREATE_FAILED",
  "BOOKING_EXECUTOR_ERROR",
  "INVALID_DURATION",
  "MISSING_USER_OR_ITEM",
]);

/**
 * @param {string} reason
 * @returns {"pre_claim" | "claim" | "create_booking" | "unknown"}
 */
export function resolveCustomerConfirmFailureStage(reason) {
  const code = clean(reason, 120);
  if (!code) return "unknown";
  if (PRE_CLAIM_CONFIRM_FAILURE_REASONS.has(code)) return "pre_claim";
  if (CLAIM_CONFIRM_FAILURE_REASONS.has(code)) return "claim";
  if (CREATE_BOOKING_CONFIRM_FAILURE_REASONS.has(code)) return "create_booking";
  if (code.startsWith("AVAILABILITY_")) return "create_booking";
  return "unknown";
}

/**
 * @param {Record<string, unknown> | null | undefined} extras
 */
function buildCustomerConfirmFailureDetails(extras = null) {
  const src = extras && typeof extras === "object" ? extras : {};
  /** @type {Record<string, unknown>} */
  const details = {};
  if (src.dryRun === true) details.dryRun = true;
  const bookingReason = clean(src.bookingReason ?? src.reason, 160);
  const bookingCode = clean(src.bookingCode ?? src.code, 120);
  if (bookingReason) details.bookingReason = bookingReason;
  if (bookingCode && bookingCode !== bookingReason) details.bookingCode = bookingCode;
  if (src.blocked === true) details.blocked = true;
  return Object.keys(details).length > 0 ? details : null;
}

/**
 * Diagnostic-only AVR failure markers. Does not change confirmation/booking status.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   reason?: string | null,
 *   details?: Record<string, unknown> | null,
 *   extraPatch?: Record<string, unknown>,
 * }} params
 */
async function persistCustomerConfirmBookingFailure({
  db: connection,
  businessId,
  requestId,
  reason = null,
  details = null,
  extraPatch = null,
}) {
  const uid = clean(businessId);
  const rid = clean(requestId);
  const failureReason = clean(reason, 160) || "UNKNOWN_CONFIRM_FAILURE";
  if (!uid || !rid) {
    return {
      reason: failureReason,
      failureStage: resolveCustomerConfirmFailureStage(failureReason),
      failureDetails: buildCustomerConfirmFailureDetails(details),
    };
  }
  const failureStage = resolveCustomerConfirmFailureStage(failureReason);
  const failureDetails = buildCustomerConfirmFailureDetails(details);
  const patch = {
    ...(extraPatch && typeof extraPatch === "object" ? extraPatch : {}),
    customerConfirmFailureReason: failureReason,
    customerConfirmFailureStage: failureStage,
    customerConfirmFailureDetails: failureDetails,
    customerConfirmFailureAt: new Date(),
    customerConfirmFailureAction: "confirm_booking",
  };
  await updateAvailabilityRequestFields({
    db: connection,
    businessId: uid,
    requestId: rid,
    patch,
  }).catch(() => null);
  return { reason: failureReason, failureStage, failureDetails };
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
 *   brainAuthorizedConfirm?: boolean,
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
  brainAuthorizedConfirm = false,
}) {
  const uid = clean(businessId);
  const requestId = clean(request?.requestId ?? request?.id);
  if (!uid || !requestId) {
    const failure = await persistCustomerConfirmBookingFailure({
      db: connection,
      businessId: uid,
      requestId,
      reason: "MISSING_REQUEST",
    });
    return {
      ok: false,
      reason: failure.reason,
      failureStage: failure.failureStage,
      failureDetails: failure.failureDetails,
    };
  }
  if (availabilityConfirmExecute !== true) {
    const failure = await persistCustomerConfirmBookingFailure({
      db: connection,
      businessId: uid,
      requestId,
      reason: "CONFIRM_EXECUTE_DISABLED",
      details: { dryRun: true },
    });
    return {
      ok: false,
      reason: failure.reason,
      dryRun: true,
      failureStage: failure.failureStage,
      failureDetails: failure.failureDetails,
    };
  }

  // Brain may authorize confirm meaning; executor still re-checks only when not Brain-authorized.
  if (brainAuthorizedConfirm !== true) {
    const decision = resolveAvailabilityConfirmationTurn({
      request,
      messageText,
    });
    if (!decision.ok || decision.actionType !== "confirm_booking") {
      const failure = await persistCustomerConfirmBookingFailure({
        db: connection,
        businessId: uid,
        requestId,
        reason: decision.reason || "BRAIN_CONFIRM_ACTION_NOT_ALLOWED",
      });
      return {
        ok: false,
        reason: failure.reason,
        decision,
        failureStage: failure.failureStage,
        failureDetails: failure.failureDetails,
      };
    }
  }

  const claim = await claimAvailabilityRequestCustomerConfirmProcessing({
    db: connection,
    businessId: uid,
    requestId,
  });
  if (!claim.ok) {
    const failure = await persistCustomerConfirmBookingFailure({
      db: connection,
      businessId: uid,
      requestId,
      reason: claim.reason || "CLAIM_FAILED",
    });
    return {
      ok: false,
      reason: failure.reason,
      request: claim.request ?? null,
      failureStage: failure.failureStage,
      failureDetails: failure.failureDetails,
    };
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
    const failure = await persistCustomerConfirmBookingFailure({
      db: connection,
      businessId: uid,
      requestId,
      reason: "MISSING_ITEM_OR_DURATION",
      extraPatch: { customerConfirmProcessingStatus: "idle" },
    });
    return {
      ok: false,
      reason: failure.reason,
      failureStage: failure.failureStage,
      failureDetails: failure.failureDetails,
    };
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
    const bookingReason =
      bookingResult?.reason || bookingResult?.code || "CREATE_BOOKING_FAILED";
    const failure = await persistCustomerConfirmBookingFailure({
      db: connection,
      businessId: uid,
      requestId,
      reason: bookingReason,
      details: {
        bookingReason: bookingResult?.reason ?? null,
        bookingCode: bookingResult?.code ?? null,
        blocked: bookingResult?.blocked === true,
      },
      extraPatch: {
        customerConfirmProcessingStatus: "idle",
        customerConfirmationStatus: "waiting_confirm",
      },
    });
    return {
      ok: false,
      reason: failure.reason,
      bookingResult,
      failureStage: failure.failureStage,
      failureDetails: failure.failureDetails,
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
      requestId,
      actionType: decision.actionType,
      failureReason: result.ok === true ? null : result.reason ?? null,
      failureStage: result.ok === true ? null : result.failureStage ?? null,
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

function waitingConfirmBrainMeta(extra = {}) {
  return { waitingConfirmDmBrain: true, pamissCreated: false, ownerNotified: false, ...extra };
}

/** Flag-ON: Brain meaning → existing confirm/decline/reply executors. No pamiss/owner notify. */
async function handleWaitingConfirmDmBrainCloudTurn({
  connection,
  businessId,
  phone,
  text,
  inboundMessageId,
  conversationHistory,
  request,
  requestId,
  sendCredentials,
  sendWhatsAppMessageFn,
  availabilityConfirmExecute,
  decideCustomerTurnFn,
}) {
  const catalogRow = await loadCatalogRowForRequest(businessId, request);
  const turnContext = packWaitingConfirmDmTurnContext({
    businessId,
    customerPhone: phone,
    messageText: text,
    messageId: inboundMessageId,
    conversationHistory,
    request,
    catalogRow,
  });
  const decision = (await decideCustomerTurnFn(turnContext))?.decision || {};
  const action = clean(decision.action, 40) || "reply";

  const finish = async (payload, replyText = null, promptType = null) => {
    let reply = replyText;
    if (reply != null) {
      const recordedPromptType =
        promptType ||
        resolveWaitingConfirmDmOutboundPromptType(
          decision,
          AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
        );
      reply = await sendCustomerDmReply({
        phone,
        reply,
        sendWhatsAppMessageFn,
        sendCredentials,
        connection,
        businessId,
        requestId,
        promptType: recordedPromptType,
      });
    }
    await recordCloudInboundIdempotency({
      connection,
      businessId,
      requestId,
      messageId: inboundMessageId,
      messageText: text,
    });
    return waitingConfirmBrainMeta({
      handled: true,
      decision,
      requestId,
      reply,
      turnContext,
      ...payload,
    });
  };

  if (action === "confirm_booking") {
    const confirmGuard = evaluateWaitingConfirmDmBrainConfirmGuard({
      decision,
      turnContext,
    });
    if (!confirmGuard.ok) {
      // Soft fail: no booking / decline / AVR mutate / pamiss / owner notify.
      // Do not re-activate booking prompt unless Brain explicitly asked to confirm.
      return finish(
        {
          action: "clarify",
          confirmGuardFailed: true,
          confirmGuardReasons: confirmGuard.reasons,
        },
        clean(decision.customerReply) ||
          "Book confirm karna hai? Bata dein.",
        resolveWaitingConfirmDmOutboundPromptType(
          decision,
          AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
        )
      );
    }

    const result = await executeAvailabilityCustomerConfirmBooking({
      db: connection,
      businessId,
      request,
      messageText: text,
      messageId: inboundMessageId,
      sendCredentials,
      availabilityConfirmExecute,
      brainAuthorizedConfirm: true,
    });
    const reply =
      result.ok === true
        ? result.reply || buildAvailabilityConfirmSuccessReply()
        : clean(decision.customerReply) ||
          buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    if (result.ok === true) {
      await recordAvailabilityCustomerDmOutbound({
        db: connection,
        businessId,
        requestId,
        reply,
        promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
      }).catch(() => null);
    }
    await recordCloudInboundIdempotency({
      connection,
      businessId,
      requestId,
      messageId: inboundMessageId,
      messageText: text,
    });
    return waitingConfirmBrainMeta({
      handled: true,
      action: result.ok ? "confirmed_booking" : "confirm_failed",
      reply,
      result,
      decision,
      requestId,
      actionType: "confirm_booking",
      failureReason: result.ok === true ? null : result.reason ?? null,
      failureStage: result.ok === true ? null : result.failureStage ?? null,
    });
  }

  if (action === "decline_request") {
    await updateAvailabilityRequestCustomerConfirmationState({
      db: connection,
      businessId,
      requestId,
      customerConfirmationStatus: "declined",
      extra: {
        customerConfirmationAt: new Date(),
        customerConfirmationMessageId: inboundMessageId || null,
        customerConfirmationTextPreview: text.slice(0, 160),
      },
    });
    return finish(
      { action: "declined" },
      clean(decision.customerReply) || buildAvailabilityDeclineAckReply(),
      AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
    );
  }

  if (action === "silence" || action === "none") {
    return finish({ action: "silence" });
  }

  return finish(
    {
      action:
        action === "change_request"
          ? "change_request"
          : action === "clarify"
            ? "clarify"
            : "reply",
    },
    clean(decision.customerReply) ||
      (action === "change_request"
        ? buildAvailabilityChangeCarReply()
        : buildAvailabilityGenericAckPromptReply()),
    resolveWaitingConfirmDmOutboundPromptType(
      decision,
      AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
    )
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
 *   sendCredentials?: Record<string, unknown> | null,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   availabilityConfirmExecute?: boolean,
 *   __waitingConfirmDmBrainEnabled?: boolean,
 *   __decideCustomerTurnForTests?: Function | null,
 * }} params
 */
export async function handleAvailabilityCustomerCloudInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  conversationHistory = null,
  sendCredentials = null,
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  availabilityConfirmExecute = isEmilyBrainV2AvailabilityConfirmExecuteEnabled(),
  __waitingConfirmDmBrainEnabled = null,
  __decideCustomerTurnForTests = null,
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
  const inactiveOrSuperseded = await findSupersededCloudAvailabilityRequestsByPhone({
    db: connection,
    businessId: uid,
    customerPhone: phone,
  }).catch(() => []);
  const selection = selectAvailabilityRequestForCustomerMessage(waiting, text, {
    inactiveOrSupersededRequests: inactiveOrSuperseded,
  });
  let request = selection.request;

  if (!request && waiting.length === 0 && selection.reason !== "NAMED_INACTIVE") {
    return { handled: false, reason: "NO_WAITING_REQUEST" };
  }

  if (!request && (selection.reason === "AMBIGUOUS" || selection.reason === "NAMED_INACTIVE")) {
    const reply =
      selection.disambiguationReply || buildAvailabilityConfirmClarificationReply();
    await sendWhatsAppMessageFn(phone, reply, sendCredentials ?? undefined, {
      recipientType: "individual",
    }).catch(() => null);
    return {
      handled: true,
      action: selection.reason === "NAMED_INACTIVE" ? "clarification" : "disambiguation",
      reply,
      requestId: null,
    };
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

  const waitingConfirmDmBrainOn =
    __waitingConfirmDmBrainEnabled === true ||
    (__waitingConfirmDmBrainEnabled !== false &&
      isEmilyWaitingConfirmDmBrainEnabled());

  if (waitingConfirmDmBrainOn) {
    const decideFn =
      typeof __decideCustomerTurnForTests === "function"
        ? __decideCustomerTurnForTests
        : decideCustomerTurn;
    return handleWaitingConfirmDmBrainCloudTurn({
      connection,
      businessId: uid,
      phone,
      text,
      inboundMessageId,
      conversationHistory,
      request,
      requestId,
      sendCredentials,
      sendWhatsAppMessageFn,
      availabilityConfirmExecute,
      decideCustomerTurnFn: decideFn,
    });
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
      actionType: decision.actionType,
      failureReason: result.ok === true ? null : result.reason ?? null,
      failureStage: result.ok === true ? null : result.failureStage ?? null,
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
