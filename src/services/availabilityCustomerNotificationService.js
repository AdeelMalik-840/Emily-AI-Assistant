import db from "../config/firebase.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { replyPrivatelyToLatestUserMessage } from "./playwrightReplyPrivatelyBridge.js";
import {
  getAvailabilityRequest,
  markAvailabilityRequestCustomerNotificationFailed,
  markAvailabilityRequestCustomerNotificationSent,
  markAvailabilityRequestCustomerNotificationSkipped,
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

function formatDuration(request) {
  const durationDays = Number(request?.requestedDuration ?? request?.durationDays);
  if (Number.isFinite(durationDays) && durationDays > 0) {
    return `${Math.max(1, Math.floor(durationDays))} din`;
  }
  const dates = Array.isArray(request?.requestedDates) ? request.requestedDates : [];
  if (dates.length > 0) {
    return dates.join(", ");
  }
  return "requested period";
}

function resolveDecisionText(request) {
  const status = clean(request?.status).toLowerCase();
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const duration = formatDuration(request);
  if (status === "approved") {
    return `${itemLabel} ${duration} ke liye available hai. Booking continue kar dun?`;
  }
  return `Sorry, ${itemLabel} ${duration} ke liye available nahi hai. Koi aur car dekhni hai?`;
}

export function buildAvailabilityCustomerNotificationMessage(request) {
  return resolveDecisionText(request);
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
  const participantIdentity = clean(sourceIdentity.participantIdentity ?? request?.customerParticipantIdentity);

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
    sourceParticipantName: participantIdentity || participantKey || null,
    sourceParticipantDisplayName: participantIdentity || participantKey || null,
    sourceParticipantPhone:
      normalizePhone(request?.customerDmTarget) ||
      normalizePhone(sourceIdentity.participantPhone) ||
      null,
    sourceParticipantKey: participantKey || null,
    sourceChatId: sourceChatId || null,
    sourceChatType: sourceChatType || null,
  };
}

function resolveCustomerDmTarget(request) {
  return normalizePhone(request?.customerDmTarget) || "";
}

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

  return {
    ok: true,
    groupName,
    playwrightChatKey,
    sourceMessage,
  };
}

/**
 * Availability customer notification sender.
 * Poller claims the request; this service only executes the customer notification side effect.
 *
 * @param {{
 *   db?: unknown,
 *   businessId?: string,
 *   requestId?: string,
 *   request?: Record<string, unknown> | null,
 *   executionContext?: Record<string, unknown>,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   replyPrivatelyFn?: typeof replyPrivatelyToLatestUserMessage,
 * }} params
 * @returns {Promise<{ ok: boolean, sent?: boolean, skipped?: boolean, reason?: string, requestId?: string | null, method?: string | null }>}
 */
export async function sendAvailabilityCustomerNotification({
  db: connection,
  businessId,
  requestId,
  request = null,
  executionContext = {},
  sendWhatsAppMessageFn = sendWhatsAppMessage,
  replyPrivatelyFn = replyPrivatelyToLatestUserMessage,
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

  const customerDmTarget = resolveCustomerDmTarget(current);
  const wantsCloudDm = Boolean(customerDmTarget);
  const replyRoute = wantsCloudDm ? null : resolveAvailabilityReplyPrivatelyRoute(current);
  const message = buildAvailabilityCustomerNotificationMessage(current);

  if (!wantsCloudDm && !replyRoute.ok) {
    const skipReason = replyRoute.reason || "MISSING_CUSTOMER_DM_TARGET";
    await markAvailabilityRequestCustomerNotificationSkipped({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: skipReason,
      approvalCustomerNotificationMethod: null,
    });
    return {
      ok: false,
      skipped: true,
      reason: skipReason,
      requestId: rid,
      method: null,
    };
  }

  let result = null;
  let method = wantsCloudDm ? "cloud_dm" : "reply_privately";
  try {
    if (wantsCloudDm) {
      result = await sendWhatsAppMessageFn(customerDmTarget, message, executionContext?.sendCredentials ?? undefined, {
        recipientType: "individual",
      });
    } else {
      result = await replyPrivatelyFn({
        bookingId: rid,
        groupName: replyRoute.groupName,
        playwrightChatKey: replyRoute.playwrightChatKey,
        message,
        sourceMessage: replyRoute.sourceMessage,
        disallowedChatTitles: executionContext?.disallowedChatTitles,
        replyPrivateLockHeld: executionContext?.replyPrivateLockHeld === true,
      });
    }
  } catch (err) {
    const reason = String(err?.message ?? err ?? "UNKNOWN");
    await markAvailabilityRequestCustomerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: reason,
      approvalCustomerNotificationMethod: method,
    });
    return { ok: false, reason, requestId: rid, method };
  }

  const sendOk = wantsCloudDm
    ? result === undefined || result === true || result?.ok === true || result?.success === true
    : result?.ok === true && result?.verificationPassed === true;
  if (!sendOk) {
    const reason = clean(result?.reason ?? result?.errorCode ?? result?.failureStage ?? "DM_SEND_FAILED") || "DM_SEND_FAILED";
    if (!wantsCloudDm && replyRoute?.reason && replyRoute.reason !== "MISSING_REPLY_PRIVATE_ROUTE") {
      method = "reply_privately";
    }
    await markAvailabilityRequestCustomerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      approvalCustomerNotificationError: reason,
      approvalCustomerNotificationMethod: method,
    });
    return { ok: false, reason, requestId: rid, method };
  }

  await markAvailabilityRequestCustomerNotificationSent({
    db: firestore,
    businessId: uid,
    requestId: rid,
    approvalCustomerNotificationMethod: method,
  });

  return {
    ok: true,
    sent: true,
    requestId: rid,
    method,
  };
}
