import db from "../config/firebase.js";
import { isPlaywrightContactInfoPhoneExtractionEnabled } from "../brain/config/liveFeatureFlags.js";
import { AVAILABILITY_DM_PROMPT_TYPES } from "../brain/availabilityConfirmation/index.js";
import { findItemById, findItemByName } from "./inventoryService.js";
import {
  extractDmContactPhoneFromOpenChat,
  replyPrivatelyToLatestUserMessage,
} from "./playwrightReplyPrivatelyBridge.js";
import { getPlaywrightOutboundPage, refocusChatRowForTitle } from "./playwrightOutboundBridge.js";
import {
  classifyAvailabilityCustomerLanguage,
  planAvailabilityCustomerTemplateSend,
  resolveAvailabilityCustomerSourceTextPreview,
  shouldUseAvailabilityCustomerTemplateNotify,
} from "./availabilityCustomerTemplateNotify.js";
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from "./whatsappCloud.js";
import {
  buildApprovedAvailabilityCustomerMessage,
  buildApprovedAvailabilityCustomerMessageWithoutPrice,
  buildRejectedAvailabilityNoOptionsMessage,
  buildRejectedAvailabilityWithAlternativesMessage,
  resolveAvailabilityApprovedPriceQuote,
} from "./availabilityMessageBuilder.js";
import { findVerifiedAvailabilityAlternatives } from "./availabilityRejectionAlternatives.js";
import {
  buildConfirmExpiresAt,
  getAvailabilityRequest,
  markAvailabilityRequestCustomerNotificationFailed,
  markAvailabilityRequestCustomerNotificationPending,
  markAvailabilityRequestCustomerNotificationSent,
  markAvailabilityRequestCustomerNotificationSkipped,
  recordAvailabilityCustomerDmOutbound,
  resolveAvailabilityParticipantDisplayName,
  supersedeOtherWaitingConfirmAvailabilityRequestsForCustomer,
  updateAvailabilityRequestFields,
} from "./availabilityRequestService.js";
import { detectAvailabilityRequestBookingConflict } from "./availabilityBookingConflictGuard.js";
import {
  maskCustomerPhone,
  normalizeCustomerPhoneDigits,
} from "./availabilityCustomerPhone.js";
import { appendConversationMessage } from "./conversationStore.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

async function persistCloudCustomerNotificationConversation({
  db,
  businessId,
  customerPhone,
  requestId,
  request,
  text,
  providerMessageId,
}) {
  const sourceMessageId =
    clean(request?.sourceMessageId, 320) ||
    `availability_request:${clean(requestId, 160)}:customer_notification`;
  await appendConversationMessage(db, {
    ownerUserId: businessId,
    customerNumber: customerPhone,
    role: "assistant",
    text,
    sourceMessageId,
    providerMessageId: clean(providerMessageId, 320) || null,
  }).catch(() => null);
}

/**
 * After a successful Cloud booking_confirmation_prompt, supersede other waiting_confirm AVRs.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   customerPhone: string,
 * }} p
 */
async function supersedeSiblingWaitingConfirmAfterCloudPrompt(p) {
  const phone = clean(p.customerPhone);
  const requestId = clean(p.requestId);
  const businessId = clean(p.businessId);
  if (!phone || !requestId || !businessId) return;
  try {
    const result = await supersedeOtherWaitingConfirmAvailabilityRequestsForCustomer({
      db: p.db,
      businessId,
      customerPhone: phone,
      keepRequestId: requestId,
    });
    if (result?.supersededCount > 0) {
      console.log("[availability_waiting_confirm_superseded_siblings]", {
        requestId,
        businessId,
        supersededCount: result.supersededCount,
      });
    }
  } catch (error) {
    console.warn("[availability_waiting_confirm_supersede_failed]", {
      requestId,
      businessId,
      error: error?.message || String(error),
    });
  }
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
}

/**
 * Phase 4 phone-extraction managed requests (vs legacy docs without these fields).
 * @param {Record<string, unknown>} request
 */
export function isPhase4CustomerPhoneManaged(request) {
  const transport = clean(request?.customerDmTransport);
  if (transport === "cloud_api" || transport === "none") return true;
  const status = clean(request?.phoneExtractionStatus);
  return (
    status === "not_started" ||
    status === "pending" ||
    status === "resolving" ||
    status === "resolved" ||
    status === "failed" ||
    status === "ambiguous"
  );
}

/**
 * Cloud API send gate for Phase 4.
 * @param {Record<string, unknown>} request
 */
export function canSendAvailabilityCustomerCloudApi(request) {
  const requestStatus = clean(request?.status).toLowerCase();
  if (requestStatus !== "approved" && requestStatus !== "rejected") return false;
  if (clean(request?.phoneExtractionStatus) !== "resolved") return false;
  if (clean(request?.customerDmTransport) !== "cloud_api") return false;
  const phone =
    normalizeCustomerPhoneDigits(request?.customerPhone) ||
    normalizeCustomerPhoneDigits(request?.customerDmTarget);
  return Boolean(phone);
}

function maskPhoneForLog(value) {
  return maskCustomerPhone(value) || null;
}

function extractCloudSendMeta(result) {
  const body =
    result && typeof result === "object"
      ? result.data && typeof result.data === "object"
        ? result.data
        : result
      : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const contacts = Array.isArray(body.contacts) ? body.contacts : [];
  const providerMessageId =
    clean(result?.providerMessageId) ||
    (messages[0] && typeof messages[0] === "object"
      ? clean(messages[0].id)
      : "") ||
    null;
  const customerWaId =
    clean(result?.customerWaId) ||
    clean(result?.waId) ||
    (contacts[0] && typeof contacts[0] === "object"
      ? clean(contacts[0].wa_id)
      : "") ||
    null;
  return { providerMessageId: providerMessageId || null, customerWaId: customerWaId || null };
}

function buildReplyPrivateSourceMessage(request) {
  const sourceIdentity = asPlainObject(request?.sourceIdentity) ?? {};
  const sourceChatId = clean(request?.sourceChatId ?? sourceIdentity.chatId);
  const sourceChatType = clean(request?.sourceChatType ?? sourceIdentity.chatType);
  const sourceMessageId = clean(sourceIdentity.sourceMessageId ?? request?.sourceMessageId);
  const sourceRowKey = clean(sourceIdentity.sourceRowKey ?? request?.sourceRowKey);
  const sourceTurnKey = clean(sourceIdentity.sourceTurnKey ?? request?.sourceTurnKey);
  const participantKey = clean(
    sourceIdentity.participantKey ?? request?.customerParticipantId ?? sourceTurnKey
  );
  const participantDisplayName = resolveAvailabilityParticipantDisplayName(sourceIdentity, request);

  return {
    sourceRowKey: sourceRowKey || null,
    sourceMessageId: sourceMessageId || null,
    sourceText:
      clean(sourceIdentity.sourceTextPreview ?? request?.sourceText ?? request?.itemLabel).slice(0, 220) ||
      null,
    sourceTextPreview:
      clean(sourceIdentity.sourceTextPreview ?? request?.sourceText ?? request?.itemLabel).slice(0, 160) ||
      null,
    sourceTimestamp:
      sourceIdentity.sourceTimestamp != null && Number.isFinite(Number(sourceIdentity.sourceTimestamp))
        ? Number(sourceIdentity.sourceTimestamp)
        : request?.sourceTimestamp != null && Number.isFinite(Number(request.sourceTimestamp))
          ? Number(request.sourceTimestamp)
          : null,
    sourceMessageIndex:
      sourceIdentity.sourceMessageIndex != null && Number.isFinite(Number(sourceIdentity.sourceMessageIndex))
        ? Number(sourceIdentity.sourceMessageIndex)
        : request?.sourceMessageIndex != null && Number.isFinite(Number(request.sourceMessageIndex))
          ? Number(request.sourceMessageIndex)
          : null,
    sourceSenderScope:
      clean(sourceIdentity.sourceSenderScope ?? sourceIdentity.chatId ?? request?.sourceChatId) || null,
    sourceParticipantName: participantDisplayName || null,
    sourceParticipantDisplayName: participantDisplayName || null,
    sourceParticipantPhone:
      normalizePhone(request?.customerDmTarget) ||
      normalizePhone(sourceIdentity.participantPhone) ||
      null,
    sourceParticipantKey: participantKey || null,
    sourceChatId: sourceChatId || null,
    sourceChatType: sourceChatType || null,
  };
}

export { buildReplyPrivateSourceMessage };

function resolveAvailabilityReplyPrivatelyRoute(request) {
  const sourceIdentity = asPlainObject(request?.sourceIdentity) ?? {};
  const sourceChatType = clean(request?.sourceChatType ?? sourceIdentity.chatType);
  const groupName = clean(request?.sourceChatId ?? sourceIdentity.chatId);
  const playwrightChatKey = clean(request?.sourceChatId ?? sourceIdentity.chatId);
  const hasSourceRowKey = Boolean(clean(sourceIdentity.sourceRowKey ?? request?.sourceRowKey));
  const hasSourceMessageId = Boolean(clean(sourceIdentity.sourceMessageId ?? request?.sourceMessageId));
  const hasSourceMessageIndex =
    (sourceIdentity.sourceMessageIndex != null && Number.isFinite(Number(sourceIdentity.sourceMessageIndex))) ||
    (request?.sourceMessageIndex != null && Number.isFinite(Number(request.sourceMessageIndex)));
  const sourceMessage = buildReplyPrivateSourceMessage(request);
  const hasAnchor = hasSourceRowKey || hasSourceMessageId || hasSourceMessageIndex;
  if (sourceChatType !== "group" || !groupName || !hasAnchor) {
    return { ok: false, reason: "MISSING_REPLY_PRIVATE_ROUTE", groupName, playwrightChatKey, sourceMessage };
  }
  return { ok: true, groupName, playwrightChatKey, sourceMessage };
}

async function loadCatalogRow(businessId, request) {
  const itemLabel = clean(request?.itemLabel);
  const itemId = clean(request?.itemId);
  if (!itemLabel && !itemId) return null;

  let row = null;
  if (itemId) {
    row = await findItemById(businessId, itemId).catch(() => null);
  }
  if (!row && itemLabel) {
    row = await findItemByName(businessId, itemLabel).catch(() => null);
  }
  if (row && itemId && clean(row.id) !== itemId) return null;
  return row;
}

export function buildAvailabilityCustomerNotificationMessage(request, options = {}) {
  const status = clean(request?.status).toLowerCase();
  if (status === "approved") {
    let priceQuote = options.priceQuote ?? null;
    if (!priceQuote || !(Number(priceQuote.total) > 0)) {
      const resolved = resolveAvailabilityApprovedPriceQuote(request, options.catalogRow);
      if (resolved.ok) {
        priceQuote = resolved.priceQuote;
      }
    }
    const built = buildApprovedAvailabilityCustomerMessage(request, priceQuote);
    if (built.ok) {
      return { ok: true, message: built.message, priceQuote: built.priceQuote };
    }
    const fallback = buildApprovedAvailabilityCustomerMessageWithoutPrice(request);
    return {
      ok: true,
      message: fallback.message,
      priceQuote: null,
      usedNoPriceFallback: true,
    };
  }
  if (status === "rejected") {
    const alternatives = Array.isArray(options.alternativeLabels) ? options.alternativeLabels : [];
    if (alternatives.length > 0) {
      return {
        ok: true,
        message: buildRejectedAvailabilityWithAlternativesMessage(request, alternatives),
        customerConfirmationStatus: "unavailable_alternatives_offered",
      };
    }
    return {
      ok: true,
      message: buildRejectedAvailabilityNoOptionsMessage(),
      customerConfirmationStatus: "unavailable_no_options",
    };
  }
  return { ok: false, reason: "UNSUPPORTED_STATUS", message: "" };
}

async function sendCloudAvailabilityMessage({
  phone,
  message,
  sendWhatsAppMessageFn,
  sendCredentials,
  method = "cloud_api",
}) {
  const target =
    normalizeCustomerPhoneDigits(phone) || normalizePhone(phone).replace(/\D/g, "");
  if (!target) return { ok: false, reason: "MISSING_CUSTOMER_PHONE" };
  const result = await sendWhatsAppMessageFn(target, message, sendCredentials ?? undefined, {
    recipientType: "individual",
  });
  const sendOk =
    result === true || result?.ok === true || result?.success === true;
  if (!sendOk) {
    return { ok: false, reason: "CLOUD_DM_SEND_FAILED", method };
  }
  const meta = extractCloudSendMeta(result);
  return {
    ok: true,
    method,
    phone: target,
    maskedPhone: maskPhoneForLog(target),
    providerMessageId: meta.providerMessageId,
    customerWaId: meta.customerWaId,
  };
}

/**
 * Pull Meta Graph diagnostics from sendWhatsAppTemplateMessage failure shape.
 * Expected body: { error: { code, message, error_data, fbtrace_id } } plus httpStatus.
 * @param {unknown} result
 */
function extractWhatsAppCloudMetaDiagnostics(result) {
  const source = asPlainObject(result);
  if (!source) return {};

  const httpRaw = Number(source.httpStatus ?? source.status);
  const httpStatus = Number.isFinite(httpRaw) ? Math.trunc(httpRaw) : null;

  const payload = asPlainObject(source.error) || asPlainObject(source.data) || null;
  const err = asPlainObject(payload?.error) || null;

  const code = err?.code != null ? clean(String(err.code), 40) : "";
  const message = err?.message != null ? clean(String(err.message), 500) : "";
  const fbtraceId =
    err?.fbtrace_id != null ? clean(String(err.fbtrace_id), 120) : "";

  let details = "";
  const errorData = asPlainObject(err?.error_data);
  if (errorData) {
    if (errorData.details != null) {
      details = clean(String(errorData.details), 500);
    } else {
      try {
        details = clean(JSON.stringify(errorData), 500);
      } catch {
        details = "";
      }
    }
  }

  /** @type {Record<string, string | number>} */
  const out = {};
  if (httpStatus != null) out.approvalCustomerNotificationMetaHttpStatus = httpStatus;
  if (code) out.approvalCustomerNotificationMetaErrorCode = code;
  if (message) out.approvalCustomerNotificationMetaErrorMessage = message;
  if (details) out.approvalCustomerNotificationMetaErrorDetails = details;
  if (fbtraceId) out.approvalCustomerNotificationMetaFbtraceId = fbtraceId;
  return out;
}

async function sendCloudAvailabilityTemplateMessage({
  phone,
  templateName,
  languageCode,
  bodyParameters,
  sendWhatsAppTemplateMessageFn,
  sendCredentials,
}) {
  const target =
    normalizeCustomerPhoneDigits(phone) || normalizePhone(phone).replace(/\D/g, "");
  if (!target) return { ok: false, reason: "MISSING_CUSTOMER_PHONE" };
  const result = await sendWhatsAppTemplateMessageFn({
    to: target,
    templateName,
    languageCode,
    bodyParameters,
    credentials: sendCredentials ?? undefined,
    caller: "availabilityCustomerTemplateNotify",
  });
  const sendOk =
    result === true || result?.ok === true || result?.success === true;
  if (!sendOk) {
    return {
      ok: false,
      reason: "CLOUD_TEMPLATE_SEND_FAILED",
      method: "cloud_api_template",
      ...extractWhatsAppCloudMetaDiagnostics(result),
    };
  }
  const meta = extractCloudSendMeta(result);
  return {
    ok: true,
    method: "cloud_api_template",
    phone: target,
    maskedPhone: maskPhoneForLog(target),
    providerMessageId: meta.providerMessageId,
    customerWaId: meta.customerWaId,
  };
}

async function markAvailabilityTemplateNotifyBlocked({
  db,
  businessId,
  requestId,
  reason,
  customerLanguage = null,
}) {
  await markAvailabilityRequestCustomerNotificationSkipped({
    db,
    businessId,
    requestId,
    approvalCustomerNotificationError: "manual_required",
    approvalCustomerNotificationMethod: "skipped_manual_required",
  });
  console.log("[availability_customer_template_notify_blocked]", {
    requestId,
    businessId,
    reason: clean(reason) || "TEMPLATE_BLOCKED",
    customerLanguage: clean(customerLanguage) || null,
  });
}

/**
 * Send the real customer message via Reply Privately, mark sent/waiting_confirm, then extract phone.
 * Does not send the same message through Cloud API.
 */
async function sendAvailabilityViaReplyPrivately({
  request,
  requestId,
  businessId,
  requestStatus,
  message,
  built,
  replyPrivatelyFn,
  extractDmContactPhoneFn,
  refocusGroupFn,
}) {
  const route = resolveAvailabilityReplyPrivatelyRoute(request);
  if (!route.ok) {
    return { ok: false, reason: route.reason || "MISSING_REPLY_PRIVATE_ROUTE" };
  }

  const opened = await replyPrivatelyFn({
    bookingId: requestId,
    groupName: route.groupName,
    playwrightChatKey: route.playwrightChatKey,
    message,
    sourceMessage: route.sourceMessage,
  });
  if (!opened?.ok || !opened?.verificationPassed) {
    return {
      ok: false,
      reason: opened?.errorCode || opened?.reason || "REPLY_PRIVATE_SEND_FAILED",
      replyPrivateResult: opened,
    };
  }

  const sentAt = new Date();
  const confirmPatch = {
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    approvalCustomerNotificationMethod: "reply_privately",
    customerConfirmationChannel: "reply_private_then_cloud_handoff",
    lastCustomerNotifyMessage: message,
    lastCustomerNotifyAt: sentAt,
    customerDmChatTitle: clean(opened.dmChatTitle) || null,
    customerDmPlaywrightChatKey: clean(opened.dmPlaywrightChatKey) || null,
    priceQuote: built?.priceQuote ?? request?.priceQuote ?? null,
    customerConfirmProcessingStatus: "idle",
    phoneExtractionStatus: "not_attempted",
    phoneExtractionError: null,
  };

  if (requestStatus === "approved") {
    confirmPatch.customerConfirmationStatus = "waiting_confirm";
    confirmPatch.confirmExpiresAt = buildConfirmExpiresAt(sentAt);
  } else {
    confirmPatch.customerConfirmationStatus =
      built?.customerConfirmationStatus ||
      (message === buildRejectedAvailabilityNoOptionsMessage()
        ? "unavailable_no_options"
        : "unavailable_alternatives_offered");
  }

  let phoneExtractionStatus = "not_attempted";
  let phoneExtractionError = null;
  let customerPhone = null;
  let customerContactInfo = null;

  if (isPlaywrightContactInfoPhoneExtractionEnabled()) {
    const extracted = await extractDmContactPhoneFn(getPlaywrightOutboundPage(), {
      businessId,
      requestId,
      expectedDmChatKey: opened.dmPlaywrightChatKey,
      expectedDmTitle: opened.dmChatTitle,
    }).catch(() => ({ ok: false, reason: "PHONE_EXTRACTION_FAILED" }));

    const page = getPlaywrightOutboundPage();
    if (page && route.groupName) {
      await refocusGroupFn(page, route.groupName).catch(() => null);
    }

    if (extracted?.ok && extracted?.phone) {
      customerPhone = normalizePhone(extracted.phone);
      customerContactInfo = extracted.contactInfo ?? null;
      phoneExtractionStatus = "extracted";
      confirmPatch.customerDmTarget = customerPhone;
      confirmPatch.customerPhone = customerPhone;
      confirmPatch.customerContactInfo = customerContactInfo;
    } else {
      phoneExtractionStatus = "failed";
      phoneExtractionError = extracted?.reason || "PHONE_EXTRACTION_FAILED";
    }
  } else {
    phoneExtractionStatus = "failed";
    phoneExtractionError = "PHONE_EXTRACTION_DISABLED";
  }

  confirmPatch.phoneExtractionStatus = phoneExtractionStatus;
  confirmPatch.phoneExtractionError = phoneExtractionError;

  return {
    ok: true,
    sent: true,
    method: "reply_privately",
    message,
    customerPhone,
    customerContactInfo,
    phoneExtractionStatus,
    phoneExtractionError,
    replyPrivateResult: opened,
    confirmPatch,
    sentAt,
  };
}

/**
 * Availability customer notification sender.
 * Missing phone: real message via Playwright Reply Privately, then Contact info extraction.
 * Existing phone: Cloud API only.
 *
 * @param {{
 *   db?: unknown,
 *   businessId?: string,
 *   requestId?: string,
 *   request?: Record<string, unknown> | null,
 *   executionContext?: Record<string, unknown>,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   sendWhatsAppTemplateMessageFn?: typeof sendWhatsAppTemplateMessage,
 *   replyPrivatelyFn?: typeof replyPrivatelyToLatestUserMessage,
 *   extractDmContactPhoneFn?: typeof extractDmContactPhoneFromOpenChat,
 *   refocusGroupFn?: typeof refocusChatRowForTitle,
 * }} params
 */
export async function sendAvailabilityCustomerNotification({
  db: connection,
  businessId,
  requestId,
  request = null,
  executionContext = {},
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  sendWhatsAppTemplateMessageFn = sendWhatsAppTemplateMessage,
  replyPrivatelyFn = replyPrivatelyToLatestUserMessage,
  extractDmContactPhoneFn = extractDmContactPhoneFromOpenChat,
  refocusGroupFn = refocusChatRowForTitle,
  getBookingsForItemFn = null,
}) {
  const firestore = connection ?? db;
  const uid = clean(businessId ?? executionContext.businessId ?? executionContext.userId);
  const rid = clean(requestId ?? request?.requestId ?? executionContext.requestId);
  if (!firestore || !uid || !rid) {
    return { ok: false, reason: "MISSING_REQUEST_CONTEXT", requestId: rid || null, method: null };
  }

  const current =
    (request && typeof request === "object" ? request : null) ||
    (await getAvailabilityRequest({ db: firestore, businessId: uid, requestId: rid }));
  if (!current) {
    return { ok: false, reason: "REQUEST_NOT_FOUND", requestId: rid, method: null };
  }

  const requestStatus = clean(current.status);
  if (requestStatus !== "approved" && requestStatus !== "rejected") {
    return {
      ok: false,
      skipped: true,
      reason: "REQUEST_NOT_DECIDED",
      requestId: rid,
      method: null,
    };
  }

  const notificationStatus = clean(current.approvalCustomerNotificationStatus) || "not_started";
  if (notificationStatus === "sent") {
    return {
      ok: true,
      skipped: true,
      reason: "ALREADY_SENT",
      requestId: rid,
      method: clean(current.approvalCustomerNotificationMethod) || null,
    };
  }
  if (notificationStatus === "skipped") {
    return {
      ok: true,
      skipped: true,
      reason:
        clean(current.approvalCustomerNotificationError) || "ALREADY_SKIPPED",
      requestId: rid,
      method: clean(current.approvalCustomerNotificationMethod) || null,
    };
  }

  // Safety: owner approval must not tell the customer "available" when a
  // blocking booking now overlaps the requested window (exact timestamps).
  if (requestStatus === "approved") {
    const conflict = await detectAvailabilityRequestBookingConflict({
      businessId: uid,
      request: current,
      getBookingsForItemFn:
        getBookingsForItemFn ?? executionContext.getBookingsForItemFn,
    });
    if (conflict.conflict) {
      await markAvailabilityRequestCustomerNotificationSkipped({
        db: firestore,
        businessId: uid,
        requestId: rid,
        approvalCustomerNotificationError:
          conflict.reason || "booking_conflict_detected",
        approvalCustomerNotificationMethod: "skipped_booking_conflict",
      });
      return {
        ok: false,
        skipped: true,
        reason: conflict.reason || "booking_conflict_detected",
        requestId: rid,
        method: "skipped_booking_conflict",
        bookingConflict: true,
        conflictingBookingId: conflict.bookingId,
      };
    }
  }

  const catalogRow = await loadCatalogRow(uid, current);
  let built = null;
  if (requestStatus === "approved") {
    built = buildAvailabilityCustomerNotificationMessage(current, {
      catalogRow,
    });
  } else {
    const alternatives = await findVerifiedAvailabilityAlternatives({
      businessId: uid,
      excludeItemId: clean(current.itemId),
      referenceItemLabel: clean(current.itemLabel),
      limit: 2,
    });
    built = buildAvailabilityCustomerNotificationMessage(current, {
      alternativeLabels: alternatives.map((row) => row.itemLabel),
    });
  }

  if (!built?.ok || !built.message) {
    await markAvailabilityRequestCustomerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: built?.reason || "MESSAGE_BUILD_FAILED",
      approvalCustomerNotificationMethod: null,
    });
    return { ok: false, reason: built?.reason || "MESSAGE_BUILD_FAILED", requestId: rid, method: null };
  }

  const phase4Managed = isPhase4CustomerPhoneManaged(current);
  const phoneExtractionStatus = clean(current.phoneExtractionStatus);
  const customerDmTransport = clean(current.customerDmTransport);
  const phase4Phone =
    normalizeCustomerPhoneDigits(current.customerPhone) ||
    normalizeCustomerPhoneDigits(current.customerDmTarget);
  const legacyPhone = normalizePhone(current.customerDmTarget ?? current.customerPhone);

  // --- Phase 4 managed path ---
  if (phase4Managed) {
    if (phoneExtractionStatus === "pending" || phoneExtractionStatus === "resolving") {
      await markAvailabilityRequestCustomerNotificationPending({
        db: firestore,
        businessId: uid,
        requestId: rid,
      });
      console.log("[availability_customer_cloud_notify_waiting_for_phone]", {
        requestId: rid,
        businessId: uid,
        phoneExtractionStatus,
        customerDmTransport: customerDmTransport || "none",
        maskedPhone: null,
      });
      return {
        ok: true,
        skipped: true,
        waitingForPhone: true,
        reason: "WAITING_FOR_PHONE",
        requestId: rid,
        method: null,
        sent: false,
      };
    }

    if (phoneExtractionStatus === "failed" || phoneExtractionStatus === "ambiguous") {
      await markAvailabilityRequestCustomerNotificationSkipped({
        db: firestore,
        businessId: uid,
        requestId: rid,
        approvalCustomerNotificationError: "manual_required",
        approvalCustomerNotificationMethod: "skipped_manual_required",
      });
      console.log("[availability_customer_cloud_notify_manual_required]", {
        requestId: rid,
        businessId: uid,
        phoneExtractionStatus,
        phoneExtractionError: clean(current.phoneExtractionError) || null,
        customerDmTransport: customerDmTransport || "none",
      });
      return {
        ok: true,
        skipped: true,
        reason: "MANUAL_REQUIRED",
        requestId: rid,
        method: "skipped_manual_required",
        sent: false,
      };
    }

    if (
      phoneExtractionStatus === "resolved" &&
      customerDmTransport === "cloud_api" &&
      phase4Phone
    ) {
      const useTemplate = shouldUseAvailabilityCustomerTemplateNotify(
        current,
        requestStatus
      );

      if (useTemplate) {
        const templatePlan = planAvailabilityCustomerTemplateSend(current, catalogRow);
        if (!templatePlan.ok) {
          await markAvailabilityTemplateNotifyBlocked({
            db: firestore,
            businessId: uid,
            requestId: rid,
            reason: templatePlan.reason || "TEMPLATE_BLOCKED",
            customerLanguage: classifyAvailabilityCustomerLanguage(
              resolveAvailabilityCustomerSourceTextPreview(current)
            ),
          });
          return {
            ok: true,
            skipped: true,
            reason: "MANUAL_REQUIRED",
            requestId: rid,
            method: "skipped_manual_required",
            sent: false,
            templateBlockedReason: templatePlan.reason || null,
          };
        }

        const cloudSend = await sendCloudAvailabilityTemplateMessage({
          phone: phase4Phone,
          templateName: templatePlan.templateName,
          languageCode: templatePlan.languageCode,
          bodyParameters: templatePlan.bodyParameters,
          sendWhatsAppTemplateMessageFn,
          sendCredentials: executionContext?.sendCredentials ?? null,
        });
        if (!cloudSend.ok) {
          await markAvailabilityRequestCustomerNotificationFailed({
            db: firestore,
            businessId: uid,
            requestId: rid,
            approvalCustomerNotificationError:
              cloudSend.reason || "CLOUD_TEMPLATE_SEND_FAILED",
            approvalCustomerNotificationMethod: "cloud_api_template",
            approvalCustomerNotificationMetaHttpStatus:
              cloudSend.approvalCustomerNotificationMetaHttpStatus ?? null,
            approvalCustomerNotificationMetaErrorCode:
              cloudSend.approvalCustomerNotificationMetaErrorCode ?? null,
            approvalCustomerNotificationMetaErrorMessage:
              cloudSend.approvalCustomerNotificationMetaErrorMessage ?? null,
            approvalCustomerNotificationMetaErrorDetails:
              cloudSend.approvalCustomerNotificationMetaErrorDetails ?? null,
            approvalCustomerNotificationMetaFbtraceId:
              cloudSend.approvalCustomerNotificationMetaFbtraceId ?? null,
          });
          return {
            ok: false,
            reason: cloudSend.reason || "CLOUD_TEMPLATE_SEND_FAILED",
            requestId: rid,
            method: "cloud_api_template",
            sent: false,
          };
        }

        const sentAt = new Date();
        const confirmPatch = {
          approvalCustomerNotificationStatus: "sent",
          approvalCustomerNotificationAt: sentAt,
          approvalCustomerNotificationMethod: "cloud_api_template",
          customerConfirmationChannel: "waiting_confirm_cloud",
          lastCustomerNotifyMessage: templatePlan.renderedMessage,
          lastCustomerNotifyAt: sentAt,
          customerDmTarget: phase4Phone,
          customerConfirmProcessingStatus: "idle",
          priceQuote: templatePlan.priceQuote ?? current.priceQuote ?? null,
          customerDeliveryStatus: "pending",
          customerLanguage: templatePlan.customerLanguage,
          approvalCustomerNotificationTemplateName: templatePlan.templateName,
          approvalCustomerNotificationTemplateLanguage: templatePlan.languageCode,
        };
        if (cloudSend.providerMessageId) {
          confirmPatch.approvalCustomerNotificationProviderMessageId =
            cloudSend.providerMessageId;
        }
        if (cloudSend.customerWaId) {
          confirmPatch.customerWaId = cloudSend.customerWaId;
        }
        confirmPatch.customerConfirmationStatus = "waiting_confirm";
        confirmPatch.confirmExpiresAt = buildConfirmExpiresAt(sentAt);

        await updateAvailabilityRequestFields({
          db: firestore,
          businessId: uid,
          requestId: rid,
          patch: confirmPatch,
        });
        await markAvailabilityRequestCustomerNotificationSent({
          db: firestore,
          businessId: uid,
          requestId: rid,
          approvalCustomerNotificationMethod: "cloud_api_template",
        });
        await recordAvailabilityCustomerDmOutbound({
          db: firestore,
          businessId: uid,
          requestId: rid,
          reply: templatePlan.renderedMessage,
          promptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
        }).catch(() => null);
        await persistCloudCustomerNotificationConversation({
          db: firestore,
          businessId: uid,
          customerPhone: phase4Phone,
          requestId: rid,
          request: current,
          text: templatePlan.renderedMessage,
          providerMessageId: cloudSend.providerMessageId,
        });
        await supersedeSiblingWaitingConfirmAfterCloudPrompt({
          db: firestore,
          businessId: uid,
          requestId: rid,
          customerPhone: phase4Phone,
        });

        console.log("[availability_customer_template_notify_sent]", {
          requestId: rid,
          businessId: uid,
          templateName: templatePlan.templateName,
          languageCode: templatePlan.languageCode,
          customerLanguage: templatePlan.customerLanguage,
          maskedPhone: cloudSend.maskedPhone,
          providerMessageId: cloudSend.providerMessageId || null,
        });

        return {
          ok: true,
          sent: true,
          requestId: rid,
          method: "cloud_api_template",
          customerPhone: phase4Phone,
          maskedPhone: cloudSend.maskedPhone,
          message: templatePlan.renderedMessage,
          providerMessageId: cloudSend.providerMessageId || null,
          customerWaId: cloudSend.customerWaId || null,
          templateName: templatePlan.templateName,
          languageCode: templatePlan.languageCode,
          customerLanguage: templatePlan.customerLanguage,
        };
      }

      const cloudSend = await sendCloudAvailabilityMessage({
        phone: phase4Phone,
        message: built.message,
        sendWhatsAppMessageFn,
        sendCredentials: executionContext?.sendCredentials ?? null,
        method: "cloud_api",
      });
      if (!cloudSend.ok) {
        await markAvailabilityRequestCustomerNotificationFailed({
          db: firestore,
          businessId: uid,
          requestId: rid,
          approvalCustomerNotificationError: cloudSend.reason || "CLOUD_API_SEND_FAILED",
          approvalCustomerNotificationMethod: "cloud_api",
        });
        return {
          ok: false,
          reason: cloudSend.reason || "CLOUD_API_SEND_FAILED",
          requestId: rid,
          method: "cloud_api",
          sent: false,
        };
      }

      const sentAt = new Date();
      const confirmPatch = {
        approvalCustomerNotificationStatus: "sent",
        approvalCustomerNotificationAt: sentAt,
        approvalCustomerNotificationMethod: "cloud_api",
        customerConfirmationChannel: "waiting_confirm_cloud",
        lastCustomerNotifyMessage: built.message,
        lastCustomerNotifyAt: sentAt,
        customerDmTarget: phase4Phone,
        customerConfirmProcessingStatus: "idle",
        priceQuote: built.priceQuote ?? current.priceQuote ?? null,
        // Cloud API accepted; delivery truth comes from webhook statuses.
        customerDeliveryStatus: "pending",
        // Preserve Phase 4 phone extraction fields — do not overwrite.
      };
      if (cloudSend.providerMessageId) {
        confirmPatch.approvalCustomerNotificationProviderMessageId =
          cloudSend.providerMessageId;
      }
      if (cloudSend.customerWaId) {
        confirmPatch.customerWaId = cloudSend.customerWaId;
      }
      if (requestStatus === "approved") {
        confirmPatch.customerConfirmationStatus = "waiting_confirm";
        confirmPatch.confirmExpiresAt = buildConfirmExpiresAt(sentAt);
      } else {
        confirmPatch.customerConfirmationStatus =
          built.customerConfirmationStatus ||
          (built.message === buildRejectedAvailabilityNoOptionsMessage()
            ? "unavailable_no_options"
            : "unavailable_alternatives_offered");
      }

      await updateAvailabilityRequestFields({
        db: firestore,
        businessId: uid,
        requestId: rid,
        patch: confirmPatch,
      });
      await markAvailabilityRequestCustomerNotificationSent({
        db: firestore,
        businessId: uid,
        requestId: rid,
        approvalCustomerNotificationMethod: "cloud_api",
      });
      if (clean(confirmPatch.customerConfirmationStatus) === "waiting_confirm") {
        await recordAvailabilityCustomerDmOutbound({
          db: firestore,
          businessId: uid,
          requestId: rid,
          reply: built.message,
          promptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
        }).catch(() => null);
        await persistCloudCustomerNotificationConversation({
          db: firestore,
          businessId: uid,
          customerPhone: phase4Phone,
          requestId: rid,
          request: current,
          text: built.message,
          providerMessageId: cloudSend.providerMessageId,
        });
        await supersedeSiblingWaitingConfirmAfterCloudPrompt({
          db: firestore,
          businessId: uid,
          requestId: rid,
          customerPhone: phase4Phone,
        });
      }

      console.log("[availability_customer_cloud_notify_sent]", {
        requestId: rid,
        businessId: uid,
        method: "cloud_api",
        channel: "waiting_confirm_cloud",
        maskedPhone: cloudSend.maskedPhone,
        providerMessageId: cloudSend.providerMessageId || null,
      });

      return {
        ok: true,
        sent: true,
        requestId: rid,
        method: "cloud_api",
        customerPhone: phase4Phone,
        maskedPhone: cloudSend.maskedPhone,
        message: built.message,
        providerMessageId: cloudSend.providerMessageId || null,
        customerWaId: cloudSend.customerWaId || null,
      };
    }

    // Phase 4 managed but not Cloud-eligible (e.g. resolved without phone / wrong transport).
    await markAvailabilityRequestCustomerNotificationSkipped({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: "manual_required",
      approvalCustomerNotificationMethod: "skipped_manual_required",
    });
    console.log("[availability_customer_cloud_notify_manual_required]", {
      requestId: rid,
      businessId: uid,
      phoneExtractionStatus: phoneExtractionStatus || null,
      customerDmTransport: customerDmTransport || "none",
      reason: "PHASE4_NOT_CLOUD_ELIGIBLE",
    });
    return {
      ok: true,
      skipped: true,
      reason: "MANUAL_REQUIRED",
      requestId: rid,
      method: "skipped_manual_required",
      sent: false,
    };
  }

  // --- Legacy path (no Phase 4 phone fields) ---
  if (!legacyPhone) {
    const replyPrivate = await sendAvailabilityViaReplyPrivately({
      request: current,
      requestId: rid,
      businessId: uid,
      requestStatus,
      message: built.message,
      built,
      replyPrivatelyFn,
      extractDmContactPhoneFn,
      refocusGroupFn,
    });

    if (!replyPrivate.ok) {
      await markAvailabilityRequestCustomerNotificationFailed({
        db: firestore,
        businessId: uid,
        requestId: rid,
        approvalCustomerNotificationError: replyPrivate.reason || "REPLY_PRIVATE_SEND_FAILED",
        approvalCustomerNotificationMethod: "reply_privately",
      });
      await updateAvailabilityRequestFields({
        db: firestore,
        businessId: uid,
        requestId: rid,
        patch: {
          phoneExtractionStatus: replyPrivate.phoneExtractionStatus || "failed",
          phoneExtractionError: replyPrivate.phoneExtractionError || replyPrivate.reason || "REPLY_PRIVATE_SEND_FAILED",
          customerDmChatTitle: clean(replyPrivate.replyPrivateResult?.dmChatTitle) || null,
          customerDmPlaywrightChatKey: clean(replyPrivate.replyPrivateResult?.dmPlaywrightChatKey) || null,
        },
      });
      return {
        ok: false,
        reason: replyPrivate.reason || "REPLY_PRIVATE_SEND_FAILED",
        requestId: rid,
        method: "reply_privately",
        sent: false,
      };
    }

    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: rid,
      patch: replyPrivate.confirmPatch,
    });
    await markAvailabilityRequestCustomerNotificationSent({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationMethod: "reply_privately",
    });

    return {
      ok: true,
      sent: true,
      requestId: rid,
      method: "reply_privately",
      customerPhone: replyPrivate.customerPhone,
      phoneExtractionStatus: replyPrivate.phoneExtractionStatus,
      message: built.message,
    };
  }

  const cloudSend = await sendCloudAvailabilityMessage({
    phone: legacyPhone,
    message: built.message,
    sendWhatsAppMessageFn,
    sendCredentials: executionContext?.sendCredentials ?? null,
    method: "cloud_dm",
  });
  if (!cloudSend.ok) {
    await markAvailabilityRequestCustomerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: cloudSend.reason || "CLOUD_DM_SEND_FAILED",
      approvalCustomerNotificationMethod: "cloud_dm",
    });
    return {
      ok: false,
      reason: cloudSend.reason || "CLOUD_DM_SEND_FAILED",
      requestId: rid,
      method: "cloud_dm",
      sent: false,
    };
  }

  const sentAt = new Date();
  const confirmPatch = {
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    approvalCustomerNotificationMethod: "cloud_dm",
    customerConfirmationChannel: "cloud_dm",
    lastCustomerNotifyMessage: built.message,
    lastCustomerNotifyAt: sentAt,
    customerDmTarget: cloudSend.phone,
    customerPhone: cloudSend.phone,
    phoneExtractionStatus: "skipped",
    phoneExtractionError: null,
    customerDmChatTitle: clean(current.customerDmChatTitle) || null,
    customerDmPlaywrightChatKey: clean(current.customerDmPlaywrightChatKey) || null,
    priceQuote: built.priceQuote ?? current.priceQuote ?? null,
    customerConfirmProcessingStatus: "idle",
  };
  if (cloudSend.providerMessageId) {
    confirmPatch.approvalCustomerNotificationProviderMessageId =
      cloudSend.providerMessageId;
  }
  if (cloudSend.customerWaId) {
    confirmPatch.customerWaId = cloudSend.customerWaId;
  }
  if (requestStatus === "approved") {
    confirmPatch.customerConfirmationStatus = "waiting_confirm";
    confirmPatch.confirmExpiresAt = buildConfirmExpiresAt(sentAt);
  } else {
    confirmPatch.customerConfirmationStatus =
      built.customerConfirmationStatus ||
      (built.message === buildRejectedAvailabilityNoOptionsMessage()
        ? "unavailable_no_options"
        : "unavailable_alternatives_offered");
  }

  await updateAvailabilityRequestFields({
    db: firestore,
    businessId: uid,
    requestId: rid,
    patch: confirmPatch,
  });
  await markAvailabilityRequestCustomerNotificationSent({
    db: firestore,
    businessId: uid,
    requestId: rid,
    approvalCustomerNotificationMethod: "cloud_dm",
  });
  await persistCloudCustomerNotificationConversation({
    db: firestore,
    businessId: uid,
    customerPhone: cloudSend.phone,
    requestId: rid,
    request: current,
    text: built.message,
    providerMessageId: cloudSend.providerMessageId,
  });

  return {
    ok: true,
    sent: true,
    requestId: rid,
    method: "cloud_dm",
    customerPhone: cloudSend.phone,
    message: built.message,
  };
}
