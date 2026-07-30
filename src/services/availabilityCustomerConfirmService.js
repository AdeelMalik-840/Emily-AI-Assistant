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
  WAITING_CONFIRM_DM_ALLOWED_ACTIONS,
  WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
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
  availabilityRequestMatchesCloudCustomerPhone,
  claimAvailabilityRequestCustomerConfirmProcessing,
  findAvailabilityRequestByCloudInboundMessageId,
  findLatestWaitingConfirmAvailabilityRequest,
  findSupersededCloudAvailabilityRequestsByPhone,
  findWaitingConfirmCloudAvailabilityRequestsByPhone,
  getAvailabilityRequest,
  isFreshTrustedWaitingConfirmCloudOwnershipCandidate,
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
import { normalizePhoneE164 } from "./connections.js";
import { appendConversationMessage } from "./conversationStore.js";

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

function timestampMs(value) {
  if (value == null) return null;
  if (typeof value?.toMillis === "function") {
    const ms = Number(value.toMillis());
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value?.seconds === "number") {
    const ms =
      Number(value.seconds) * 1000 +
      Math.floor(Number(value.nanoseconds ?? 0) / 1e6);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isConfirmedBookingReplyRecoveryCandidate({
  request,
  businessId,
  customerPhone,
  messageId,
} = {}) {
  const uid = clean(businessId);
  const phone = normalizePhone(customerPhone);
  if (
    !uid ||
    !phone ||
    clean(request?.businessId) !== uid ||
    !availabilityRequestMatchesCloudCustomerPhone(request, phone) ||
    clean(request?.customerConfirmationStatus) !== "confirmed" ||
    !clean(request?.linkedBookingId) ||
    !clean(messageId) ||
    clean(request?.customerConfirmationMessageId) !== clean(messageId)
  ) {
    return false;
  }
  const confirmedAt = timestampMs(request?.customerConfirmationAt);
  const outboundAt = timestampMs(request?.lastCustomerDmOutboundAt);
  return confirmedAt != null && (outboundAt == null || outboundAt < confirmedAt);
}

export async function findConfirmedBookingReplyRecoveryCandidate({
  db: connection,
  businessId,
  customerPhone,
  messageId,
} = {}) {
  const uid = clean(businessId);
  const phone = normalizePhone(customerPhone);
  const inboundMessageId = clean(messageId);
  if (!connection || !uid || !phone || !inboundMessageId) return null;
  const request = await findAvailabilityRequestByCloudInboundMessageId({
    db: connection,
    businessId: uid,
    messageId: inboundMessageId,
  });
  return isConfirmedBookingReplyRecoveryCandidate({
    request,
    businessId: uid,
    customerPhone: phone,
    messageId: inboundMessageId,
  })
    ? request
    : null;
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

/**
 * Legacy flag-OFF path only: invents customer wording from deterministic intent.
 * Brain-enabled waiting-confirm must never call this — lane owns customerReply.
 */
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

/**
 * Brain-enabled outbound wording: only the lane decision, else technical/silence.
 * Never maps intent → canned semantic reply.
 * @param {Record<string, unknown> | null | undefined} decision
 * @returns {string | null}
 */
function resolveBrainEnabledOutboundReply(decision) {
  const action = clean(decision?.action, 40);
  if (
    !WAITING_CONFIRM_DM_ALLOWED_ACTIONS.has(action) ||
    action === "silence" ||
    action === "none" ||
    decision?.shouldReply === false
  ) {
    return null;
  }
  const reply = clean(decision?.customerReply);
  if (reply) return reply;
  // shouldReply implied/true but empty body — technical only (never intent canned).
  return WAITING_CONFIRM_DM_TECHNICAL_FALLBACK;
}

/**
 * @param {Record<string, unknown> | null | undefined} turnResult
 */
function isUsableWaitingConfirmBrainTurn(turnResult) {
  if (!turnResult || typeof turnResult !== "object") return false;
  if (turnResult.ok === false) return false;
  const decision = turnResult.decision;
  if (!decision || typeof decision !== "object") return false;
  const action = clean(decision.action, 40);
  return WAITING_CONFIRM_DM_ALLOWED_ACTIONS.has(action);
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
  sourceMessageId = null,
  recordOutboundOnSuccess = true,
  includeDeliveryStatus = false,
}) {
  const sendResult = await sendWhatsAppMessageFn(
    phone,
    reply,
    sendCredentials ?? undefined,
    {
      recipientType: "individual",
    }
  ).catch(() => null);
  const providerAccepted =
    sendResult === true ||
    sendResult?.ok === true ||
    sendResult?.success === true;
  if (providerAccepted && recordOutboundOnSuccess && requestId) {
    await recordAvailabilityCustomerDmOutbound({
      db: connection,
      businessId,
      requestId,
      reply,
      promptType,
    }).catch(() => null);
  }
  if (providerAccepted) {
    await appendConversationMessage(connection, {
      ownerUserId: businessId,
      customerNumber: phone,
      role: "assistant",
      text: reply,
      sourceMessageId,
      providerMessageId:
        sendResult?.providerMessageId ?? sendResult?.messages?.[0]?.id ?? null,
    }).catch(() => null);
  }
  return includeDeliveryStatus
    ? {
        reply,
        providerAccepted,
        providerMessageId:
          sendResult?.providerMessageId ?? sendResult?.messages?.[0]?.id ?? null,
      }
    : reply;
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
 * Execute an OpenAI-authorized decline for one already trusted Cloud
 * waiting-confirm request. Produces no customer wording.
 */
export async function executeAvailabilityCustomerDecline({
  db: connection,
  businessId,
  request,
  customerPhone,
  messageId = null,
  messageText = "",
}) {
  const uid = clean(businessId);
  const requestId = clean(request?.requestId ?? request?.id);
  const expectedPhone = normalizePhoneE164(customerPhone);
  if (!uid || !requestId || !expectedPhone) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  const fresh = await getAvailabilityRequest({
    db: connection,
    businessId: uid,
    requestId,
  });
  if (!fresh) return { ok: false, reason: "REQUEST_NOT_FOUND" };
  const freshBusinessId = clean(fresh.businessId);
  if (freshBusinessId && freshBusinessId !== uid) {
    return { ok: false, reason: "BUSINESS_MISMATCH" };
  }
  const requestPhones = [
    fresh.customerDmTarget,
    fresh.customerPhone,
    fresh.customerPhoneNormalized,
    fresh.customerWaId,
  ]
    .map(normalizePhoneE164)
    .filter(Boolean);
  if (!requestPhones.includes(expectedPhone)) {
    return { ok: false, reason: "CUSTOMER_MISMATCH" };
  }
  if (clean(fresh.status) !== "approved") {
    return { ok: false, reason: "REQUEST_NOT_APPROVED" };
  }
  if (clean(fresh.customerConfirmationStatus) !== "waiting_confirm") {
    return { ok: false, reason: "REQUEST_NOT_WAITING_CONFIRM" };
  }
  if (clean(fresh.linkedBookingId)) {
    return { ok: false, reason: "BOOKING_ALREADY_LINKED" };
  }
  if (clean(fresh.supersededByAvailabilityRequestId)) {
    return { ok: false, reason: "REQUEST_SUPERSEDED" };
  }
  const expiresAt = fresh.confirmExpiresAt
    ? new Date(fresh.confirmExpiresAt)
    : null;
  if (
    expiresAt &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() <= Date.now()
  ) {
    return { ok: false, reason: "REQUEST_EXPIRED" };
  }
  const updated = await updateAvailabilityRequestCustomerConfirmationState({
    db: connection,
    businessId: uid,
    requestId,
    customerConfirmationStatus: "declined",
    extra: {
      customerConfirmationAt: new Date(),
      customerConfirmationMessageId: clean(messageId) || null,
      customerConfirmationTextPreview:
        clean(messageText).slice(0, 160) || null,
      customerConfirmProcessingStatus: "done",
    },
  });
  return updated
    ? { ok: true, requestId }
    : { ok: false, reason: "DECLINE_UPDATE_FAILED" };
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
  catalogRowOverride,
  chatCompletionsCreateForTests = null,
}) {
  const catalogRow =
    catalogRowOverride !== undefined
      ? catalogRowOverride
      : await loadCatalogRowForRequest(businessId, request);
  const turnContext = packWaitingConfirmDmTurnContext({
    businessId,
    customerPhone: phone,
    messageText: text,
    messageId: inboundMessageId,
    conversationHistory,
    request,
    catalogRow,
  });
  if (typeof chatCompletionsCreateForTests === "function") {
    turnContext.__chatCompletionsCreateForTests = chatCompletionsCreateForTests;
  }
  const turnResult = await decideCustomerTurnFn(turnContext);
  if (!isUsableWaitingConfirmBrainTurn(turnResult)) {
    // Fail closed: no booking / decline / fabricated semantic reply.
    await recordCloudInboundIdempotency({
      connection,
      businessId,
      requestId,
      messageId: inboundMessageId,
      messageText: text,
    });
    return waitingConfirmBrainMeta({
      handled: true,
      action: "silence",
      reply: null,
      decision: turnResult?.decision || null,
      requestId,
      turnContext,
      brainFailed: true,
      reason:
        clean(turnResult?.reason) ||
        (turnResult?.ok === false
          ? "BRAIN_TURN_NOT_OK"
          : !WAITING_CONFIRM_DM_ALLOWED_ACTIONS.has(
                clean(turnResult?.decision?.action, 40)
              )
            ? "BRAIN_ACTION_INVALID"
            : "BRAIN_DECISION_MISSING"),
    });
  }

  const decision = turnResult.decision;
  const action = clean(decision.action, 40);

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
        sourceMessageId: inboundMessageId || null,
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
      // Outbound wording stays Brain-owned (or silence / technical only).
      return finish(
        {
          action: "clarify",
          confirmGuardFailed: true,
          confirmGuardReasons: confirmGuard.reasons,
        },
        resolveBrainEnabledOutboundReply(decision),
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
    // Brain owns customer wording — never send executor-built reply text.
    const reply = resolveBrainEnabledOutboundReply(decision);
    if (reply == null) {
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
        reply: null,
        result,
        decision,
        requestId,
        actionType: "confirm_booking",
        failureReason: result.ok === true ? null : result.reason ?? null,
        failureStage: result.ok === true ? null : result.failureStage ?? null,
      });
    }
    const sendOutcome = await sendCustomerDmReply({
      phone,
      reply,
      sendWhatsAppMessageFn,
      sendCredentials,
      connection,
      businessId,
      requestId,
      promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
      sourceMessageId: inboundMessageId || null,
      recordOutboundOnSuccess: result.ok === true,
      includeDeliveryStatus: true,
    });
    if (sendOutcome?.providerAccepted !== true) {
      return waitingConfirmBrainMeta({
        handled: false,
        retryable: true,
        action: "confirm_reply_send_failed",
        reason: "CLOUD_CONFIRM_REPLY_NOT_DELIVERED",
        reply: "",
        result,
        decision,
        requestId,
        actionType: "confirm_booking",
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
      resolveBrainEnabledOutboundReply(decision),
      AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
    );
  }

  if (action === "silence" || action === "none") {
    return finish({ action: "silence" });
  }

  if (action === "change_request" || action === "clarify" || action === "reply") {
    return finish(
      { action },
      resolveBrainEnabledOutboundReply(decision),
      resolveWaitingConfirmDmOutboundPromptType(
        decision,
        AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO
      )
    );
  }

  // Defensive: allowed-set check above should already have failed closed.
  return finish({
    action: "silence",
    brainFailed: true,
    reason: "BRAIN_ACTION_INVALID",
  });
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
 *   preselectedWaitingConfirmRequest?: Record<string, unknown> | null,
 *   inboundReceivedAtMs?: number | null,
 *   __waitingConfirmDmBrainEnabled?: boolean,
 *   __decideCustomerTurnForTests?: Function | null,
 *   __catalogRowForTests?: Record<string, unknown> | null,
 *   __chatCompletionsCreateForTests?: Function | null,
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
  preselectedWaitingConfirmRequest = null,
  inboundReceivedAtMs = null,
  __waitingConfirmDmBrainEnabled = null,
  __decideCustomerTurnForTests = null,
  __catalogRowForTests = undefined,
  __chatCompletionsCreateForTests = null,
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
      const priorRequestId = clean(prior.requestId ?? prior.id) || null;
      if (
        priorRequestId &&
        isConfirmedBookingReplyRecoveryCandidate({
          request: prior,
          businessId: uid,
          customerPhone: phone,
          messageId: inboundMessageId,
        })
      ) {
        const recoveryReply = buildAvailabilityConfirmSuccessReply();
        const recoverySend = await sendCustomerDmReply({
          phone,
          reply: recoveryReply,
          sendWhatsAppMessageFn,
          sendCredentials,
          connection,
          businessId: uid,
          requestId: priorRequestId,
          promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
          sourceMessageId: inboundMessageId,
          recordOutboundOnSuccess: true,
          includeDeliveryStatus: true,
        });
        if (recoverySend?.providerAccepted === true) {
          return {
            handled: true,
            action: "confirmed_booking_reply_recovered",
            reply: recoveryReply,
            requestId: priorRequestId,
            duplicate: true,
            recoveredOutbound: true,
          };
        }
        return {
          handled: false,
          retryable: true,
          action: "confirm_reply_send_failed",
          reason: "CLOUD_CONFIRM_REPLY_NOT_DELIVERED",
          reply: "",
          requestId: priorRequestId,
          duplicate: true,
        };
      }
      return {
        handled: true,
        action: "duplicate_inbound",
        reply: null,
        requestId: priorRequestId,
        duplicate: true,
      };
    }
  }

  let waiting = [];
  const preselectedRequestId = clean(
    preselectedWaitingConfirmRequest?.requestId ??
      preselectedWaitingConfirmRequest?.id
  );
  if (preselectedRequestId) {
    const freshPreselected = await getAvailabilityRequest({
      db: connection,
      businessId: uid,
      requestId: preselectedRequestId,
    });
    if (
      freshPreselected &&
      availabilityRequestMatchesCloudCustomerPhone(freshPreselected, phone) &&
      isFreshTrustedWaitingConfirmCloudOwnershipCandidate(freshPreselected, {
        inboundReceivedAtMs,
      })
    ) {
      waiting = [{ requestId: preselectedRequestId, ...freshPreselected }];
    }
  } else {
    waiting = await findWaitingConfirmCloudAvailabilityRequestsByPhone({
      db: connection,
      businessId: uid,
      customerPhone: phone,
    });
  }
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
      catalogRowOverride: __catalogRowForTests,
      chatCompletionsCreateForTests: __chatCompletionsCreateForTests,
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
      sourceMessageId: inboundMessageId || null,
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
    const sendOutcome = await sendCustomerDmReply({
      phone,
      reply,
      sendWhatsAppMessageFn,
      sendCredentials,
      connection,
      businessId: uid,
      requestId,
      promptType: AVAILABILITY_DM_PROMPT_TYPES.GENERAL_INFO,
      sourceMessageId: inboundMessageId || null,
      recordOutboundOnSuccess: result.ok === true,
      includeDeliveryStatus: true,
    });
    if (sendOutcome?.providerAccepted !== true) {
      return {
        handled: false,
        retryable: true,
        action: "confirm_reply_send_failed",
        reason: "CLOUD_CONFIRM_REPLY_NOT_DELIVERED",
        reply: "",
        result,
        decision,
        requestId,
        actionType: decision.actionType,
        failureReason: "CLOUD_CONFIRM_REPLY_NOT_DELIVERED",
        failureStage: "customer_confirmation_reply_send",
      };
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
    sourceMessageId: inboundMessageId || null,
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
