import db from "../config/firebase.js";
import { isPlaywrightContactInfoPhoneExtractionEnabled } from "../brain/config/liveFeatureFlags.js";
import { findItemById, findItemByName } from "./inventoryService.js";
import {
  extractDmContactPhoneFromOpenChat,
  replyPrivatelyToLatestUserMessage,
} from "./playwrightReplyPrivatelyBridge.js";
import { getPlaywrightOutboundPage, refocusChatRowForTitle } from "./playwrightOutboundBridge.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
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
  markAvailabilityRequestCustomerNotificationSent,
  resolveAvailabilityParticipantDisplayName,
  updateAvailabilityRequestFields,
} from "./availabilityRequestService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
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
}) {
  const target = normalizePhone(phone);
  if (!target) return { ok: false, reason: "MISSING_CUSTOMER_PHONE" };
  const result = await sendWhatsAppMessageFn(target, message, sendCredentials ?? undefined, {
    recipientType: "individual",
  });
  const sendOk =
    result === undefined || result === true || result?.ok === true || result?.success === true;
  return sendOk ? { ok: true, method: "cloud_dm", phone: target } : { ok: false, reason: "CLOUD_DM_SEND_FAILED" };
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
  replyPrivatelyFn = replyPrivatelyToLatestUserMessage,
  extractDmContactPhoneFn = extractDmContactPhoneFromOpenChat,
  refocusGroupFn = refocusChatRowForTitle,
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

  const customerPhone = normalizePhone(current.customerDmTarget ?? current.customerPhone);

  if (!customerPhone) {
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
    phone: customerPhone,
    message: built.message,
    sendWhatsAppMessageFn,
    sendCredentials: executionContext?.sendCredentials ?? null,
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
    customerDmTarget: customerPhone,
    customerPhone,
    phoneExtractionStatus: "skipped",
    phoneExtractionError: null,
    customerDmChatTitle: clean(current.customerDmChatTitle) || null,
    customerDmPlaywrightChatKey: clean(current.customerDmPlaywrightChatKey) || null,
    priceQuote: built.priceQuote ?? current.priceQuote ?? null,
    customerConfirmProcessingStatus: "idle",
  };
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

  return {
    ok: true,
    sent: true,
    requestId: rid,
    method: "cloud_dm",
    customerPhone,
    message: built.message,
  };
}
