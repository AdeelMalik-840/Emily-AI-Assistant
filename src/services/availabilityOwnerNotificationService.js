import db from "../config/firebase.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { assertExecutionOwnership } from "./executors/executionOwnershipGuard.js";
import {
  findExistingAvailabilityRequestForTurn,
  getAvailabilityRequest,
  markAvailabilityRequestOwnerNotificationFailed,
  markAvailabilityRequestOwnerNotificationQueued,
  markAvailabilityRequestOwnerNotificationSending,
  markAvailabilityRequestOwnerNotificationSent,
} from "./availabilityRequestService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
}

function safePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function formatDuration(request) {
  const durationDays = Number(request?.requestedDuration ?? request?.durationDays);
  if (Number.isFinite(durationDays) && durationDays > 0) {
    return `${Math.floor(durationDays)} din ke liye`;
  }
  const dates = Array.isArray(request?.requestedDates) ? request.requestedDates : [];
  if (dates.length > 0) {
    return dates.join(", ");
  }
  return "requested period ke liye";
}

export function buildAvailabilityOwnerNotificationMessage(request) {
  const itemLabel = clean(request?.itemLabel) || "Unknown item";
  const durationText = formatDuration(request);
  const requestId = clean(request?.requestId) || "unknown_request";
  return `Availability check: ${itemLabel}, ${durationText}. Available hai? Reply APPROVE ${requestId} ya REJECT ${requestId}.`;
}

async function resolveOwnerTarget({ db: connection, businessId, request, executionContext = {} }) {
  const explicit =
    normalizePhone(request?.ownerTarget) ||
    normalizePhone(executionContext.ownerTarget) ||
    normalizePhone(executionContext.ownerNotificationPhone);
  if (explicit) return explicit;

  const firestore = connection ?? db;
  const uid = clean(businessId);
  if (!firestore || !uid || typeof firestore.collection !== "function") return "";

  try {
    const businessSnap = await firestore.collection("businesses").doc(uid).get();
    const business = businessSnap.exists ? safePlainObject(businessSnap.data()) ?? {} : {};
    const businessProfile =
      business.businessProfile && typeof business.businessProfile === "object" && !Array.isArray(business.businessProfile)
        ? /** @type {Record<string, unknown>} */ (business.businessProfile)
        : {};
    return (
      normalizePhone(businessProfile?.ownerNotificationPhone) ||
      normalizePhone(business?.ownerNotificationPhone) ||
      ""
    );
  } catch (err) {
    console.warn("[availability_owner_notification_owner_resolution_failed]", {
      businessId: uid,
      error: err?.message || String(err),
    });
    return "";
  }
}

async function resolveAvailabilityRequest({
  db: connection,
  businessId,
  requestId,
  request,
  executionContext = {},
}) {
  if (request && typeof request === "object") {
    return /** @type {Record<string, unknown>} */ (request);
  }
  if (!businessId || !requestId) return null;
  const existing = await getAvailabilityRequest({
    db: connection,
    businessId,
    requestId,
  });
  if (existing) return existing;
  const turnRequest = await findExistingAvailabilityRequestForTurn({
    db: connection,
    businessId,
    payload: executionContext.payload ?? {},
    executionContext,
  });
  return turnRequest ?? null;
}

/**
 * Availability-specific owner notification, decoupled from booking notifications.
 * @param {{
 *   db?: unknown,
 *   businessId?: string,
 *   requestId?: string,
 *   request?: Record<string, unknown> | null,
 *   executionContext?: Record<string, unknown>,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 * }} params
 * @returns {Promise<{ ok: boolean, sent?: boolean, skipped?: boolean, reason?: string, requestId?: string | null, ownerTarget?: string | null }>}
 */
export async function sendAvailabilityOwnerNotification({
  db: connection,
  businessId,
  requestId,
  request = null,
  executionContext = {},
  sendWhatsAppMessageFn = sendWhatsAppMessage,
}) {
  assertExecutionOwnership(executionContext);
  const firestore = connection ?? db;
  const uid = clean(businessId ?? executionContext.businessId ?? executionContext.userId);
  const rid = clean(requestId ?? request?.requestId ?? executionContext.requestId);
  if (!firestore || !uid || !rid) {
    return { ok: false, reason: "MISSING_REQUEST_CONTEXT", requestId: rid || null, ownerTarget: null };
  }

  const current = await resolveAvailabilityRequest({
    db: firestore,
    businessId: uid,
    requestId: rid,
    request,
    executionContext,
  });
  assertExecutionOwnership(executionContext);
  if (!current) {
    return { ok: false, reason: "REQUEST_NOT_FOUND", requestId: rid, ownerTarget: null };
  }

  const currentStatus = clean(current.ownerNotificationStatus, 80) || "not_started";
  if (["queued", "sending", "sent"].includes(currentStatus)) {
    return {
      ok: true,
      skipped: true,
      reason: "IDEMPOTENT_SKIP",
      requestId: rid,
      ownerTarget: normalizePhone(current.ownerTarget) || null,
    };
  }

  const ownerTarget = await resolveOwnerTarget({
    db: firestore,
    businessId: uid,
    request: current,
    executionContext,
  });
  assertExecutionOwnership(executionContext);
  if (!ownerTarget) {
    await markAvailabilityRequestOwnerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      ownerTarget: null,
      ownerNotificationError: "OWNER_PHONE_MISSING",
    });
    return {
      ok: false,
      reason: "OWNER_PHONE_MISSING",
      requestId: rid,
      ownerTarget: null,
    };
  }

  assertExecutionOwnership(executionContext);
  await markAvailabilityRequestOwnerNotificationQueued({
    db: firestore,
    businessId: uid,
    requestId: rid,
    ownerTarget,
  });
  await markAvailabilityRequestOwnerNotificationSending({
    db: firestore,
    businessId: uid,
    requestId: rid,
    ownerTarget,
  });
  assertExecutionOwnership(executionContext);

  const liveRequest =
    (await getAvailabilityRequest({ db: firestore, businessId: uid, requestId: rid })) ||
    current;
  const message = buildAvailabilityOwnerNotificationMessage(liveRequest);
  const sendCredentials = executionContext?.sendCredentials ?? null;

  let sendSucceeded = false;
  let providerMessageId = "";
  let sendFailureDetail = null;

  try {
    const result = await sendWhatsAppMessageFn(
      ownerTarget,
      message,
      sendCredentials ?? undefined,
      { recipientType: "individual", signal: executionContext?.abortSignal }
    );
    assertExecutionOwnership(executionContext);

    if (result === undefined) {
      sendSucceeded = true;
    } else if (result === true || result?.ok === true || result?.success === true) {
      sendSucceeded = true;
      providerMessageId = clean(result?.providerMessageId ?? result?.messageId ?? result?.id, 160);
    } else {
      sendFailureDetail = `non_success_response:${String(
        typeof result === "object" ? JSON.stringify(result).slice(0, 200) : result
      )}`;
    }
  } catch (err) {
    if (executionContext?.abortSignal?.aborted) throw err;
    sendFailureDetail = String(err?.message ?? err ?? "unknown");
  }

  if (!sendSucceeded) {
    assertExecutionOwnership(executionContext);
    await markAvailabilityRequestOwnerNotificationFailed({
      db: firestore,
      businessId: uid,
      requestId: rid,
      ownerTarget,
      ownerNotificationError: sendFailureDetail || "WHATSAPP_API_FAILED",
    });
    return {
      ok: false,
      reason: sendFailureDetail || "WHATSAPP_API_FAILED",
      requestId: rid,
      ownerTarget,
    };
  }

  assertExecutionOwnership(executionContext);
  await markAvailabilityRequestOwnerNotificationSent({
    db: firestore,
    businessId: uid,
    requestId: rid,
    ownerNotificationAt: new Date(),
    ownerTarget,
    ownerNotificationProviderMessageId: providerMessageId || null,
  });
  assertExecutionOwnership(executionContext);

  return {
    ok: true,
    sent: true,
    requestId: rid,
    ownerTarget,
  };
}
