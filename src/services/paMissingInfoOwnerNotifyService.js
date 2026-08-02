/**
 * Business PA missing-info owner notify (Phase 1).
 * Cloud API only. No Playwright. Does not mutate bookings/AVRs.
 */

import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { patchPaMissingInfoRequest } from "./paMissingInfoRequestService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizePhone(value) {
  return clean(value, 32).replace(/[^\d+]/g, "");
}

function phoneDigitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function safePlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Resolve owner/admin WhatsApp target from business profile / overrides.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   executionContext?: Record<string, unknown>,
 * }} p
 */
export async function resolvePaMissingInfoOwnerTarget({
  db: connection,
  businessId,
  executionContext = {},
}) {
  const explicit =
    normalizePhone(executionContext.ownerTarget) ||
    normalizePhone(executionContext.ownerNotificationPhone);
  if (explicit) return phoneDigitsOnly(explicit) || explicit;

  const uid = clean(businessId, 120);
  if (!connection || typeof connection.collection !== "function" || !uid) {
    return "";
  }

  try {
    const businessSnap = await connection.collection("businesses").doc(uid).get();
    const business = businessSnap.exists
      ? safePlainObject(businessSnap.data()) ?? {}
      : {};
    const businessProfile =
      business.businessProfile &&
      typeof business.businessProfile === "object" &&
      !Array.isArray(business.businessProfile)
        ? /** @type {Record<string, unknown>} */ (business.businessProfile)
        : {};
    const raw =
      normalizePhone(businessProfile?.ownerNotificationPhone) ||
      normalizePhone(business?.ownerNotificationPhone) ||
      "";
    return phoneDigitsOnly(raw) || raw;
  } catch (err) {
    console.warn("[pa_missing_info_owner_resolution_failed]", {
      businessId: uid,
      error: err?.message || String(err),
    });
    return "";
  }
}

/**
 * Deterministic owner-facing message (not customer-facing).
 * @param {Record<string, unknown>} request
 * @param {{ itemLabel?: string | null }} [extra]
 */
export function buildPaMissingInfoOwnerNotificationMessage(request, extra = {}) {
  const requestId = clean(request?.requestId, 80) || "unknown";
  const bookingId = clean(request?.bookingId, 80) || "unknown";
  const customerPhone = clean(request?.customerPhone, 32) || "unknown";
  const missingInfoType = clean(request?.missingInfoType, 40) || "other";
  const question = clean(request?.customerQuestion, 280) || "(no question)";
  const itemLabel = clean(extra.itemLabel || request?.itemLabel, 120);
  const itemBit = itemLabel ? ` Item: ${itemLabel}.` : "";
  return (
    `Emily PA missing info (${missingInfoType}). ` +
    `Customer ${customerPhone}. Booking ${bookingId}.${itemBit} ` +
    `Q: ${question} ` +
    `Reply with answer for token ${requestId}.`
  );
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   request: Record<string, unknown>,
 *   itemLabel?: string | null,
 *   sendCredentials?: unknown,
 *   executionContext?: Record<string, unknown>,
 *   sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 * }} p
 */
export async function sendPaMissingInfoOwnerNotification({
  db: connection,
  businessId,
  request,
  itemLabel = null,
  sendCredentials = null,
  executionContext = {},
  sendWhatsAppMessageFn = sendWhatsAppMessage,
}) {
  const uid = clean(businessId, 120);
  const requestId = clean(request?.requestId, 120);
  if (!connection || !uid || !requestId) {
    return {
      ok: false,
      reason: "MISSING_CONTEXT",
      ownerNotifyStatus: "failed",
      ownerTarget: null,
    };
  }

  const currentStatus = clean(request?.ownerNotifyStatus, 40) || "not_started";
  if (["queued", "sending", "sent"].includes(currentStatus)) {
    return {
      ok: true,
      skipped: true,
      reason: "IDEMPOTENT_SKIP",
      ownerNotifyStatus: currentStatus,
      ownerTarget: normalizePhone(request?.ownerTarget) || null,
      requestId,
    };
  }

  const ownerTarget = await resolvePaMissingInfoOwnerTarget({
    db: connection,
    businessId: uid,
    executionContext,
  });
  if (!ownerTarget) {
    await patchPaMissingInfoRequest({
      db: connection,
      businessId: uid,
      requestId,
      patch: {
        status: "failed",
        ownerNotifyStatus: "failed",
        ownerNotifyAt: new Date(),
        ownerNotifyError: "OWNER_PHONE_MISSING",
      },
    });
    return {
      ok: false,
      reason: "OWNER_PHONE_MISSING",
      ownerNotifyStatus: "failed",
      ownerTarget: null,
      requestId,
    };
  }

  await patchPaMissingInfoRequest({
    db: connection,
    businessId: uid,
    requestId,
    patch: {
      ownerNotifyStatus: "sending",
      ownerNotifyAt: new Date(),
      ownerNotifyError: null,
    },
  });

  const message = buildPaMissingInfoOwnerNotificationMessage(request, {
    itemLabel,
  });

  try {
    const sendResult = await sendWhatsAppMessageFn(
      ownerTarget,
      message,
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

    await patchPaMissingInfoRequest({
      db: connection,
      businessId: uid,
      requestId,
      patch: {
        status: "owner_notified",
        ownerNotifyStatus: "sent",
        ownerNotifyAt: new Date(),
        ownerNotifyError: null,
        ownerNotifyProviderMessageId: providerMessageId || null,
      },
    });

    return {
      ok: true,
      sent: true,
      reason: "SENT",
      ownerNotifyStatus: "sent",
      ownerTarget,
      requestId,
      providerMessageId: providerMessageId || null,
    };
  } catch (err) {
    const error = clean(err?.message || String(err), 400) || "WHATSAPP_API_FAILED";
    await patchPaMissingInfoRequest({
      db: connection,
      businessId: uid,
      requestId,
      patch: {
        // Keep request open so the gate can REUSE_AND_NOTIFY on a later ask.
        // Do not terminal-fail the row on a transient WhatsApp send error.
        ownerNotifyStatus: "failed",
        ownerNotifyAt: new Date(),
        ownerNotifyError: error,
      },
    });
    return {
      ok: false,
      reason: "WHATSAPP_API_FAILED",
      ownerNotifyStatus: "failed",
      ownerTarget,
      requestId,
      error,
    };
  }
}
