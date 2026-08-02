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
 * Readable phone for owner scan when digits are unambiguous enough.
 * @param {unknown} value
 */
function formatCustomerPhoneForOwnerDisplay(value) {
  const raw = clean(value, 32);
  const digits = phoneDigitsOnly(raw);
  if (!digits) return raw || "unknown";
  // Common TR / PK mobile shapes: CC + 10 national digits.
  if (/^90\d{10}$/.test(digits)) {
    const n = digits.slice(2);
    return `+90 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  if (/^92\d{10}$/.test(digits)) {
    const n = digits.slice(2);
    return `+92 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  if (raw.startsWith("+") && digits.length >= 10) {
    return `+${digits}`;
  }
  if (digits.length >= 10) return `+${digits}`;
  return raw;
}

/**
 * Prefer a human item/vehicle label; "Name (variant)" → "Name — variant".
 * @param {unknown} value
 */
function formatItemLabelForOwnerDisplay(value) {
  const label = clean(value, 120);
  if (!label) return "";
  const m = label.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) return `${m[1].trim()} — ${m[2].trim()}`;
  return label;
}

/**
 * Customer-safe booking reference only — never raw Firestore booking IDs.
 * @param {Record<string, unknown>} request
 * @param {{ itemLabel?: string | null, customerSafeReference?: string | null }} [extra]
 */
function resolveCustomerSafeBookingReference(request, extra = {}) {
  return (
    clean(extra.customerSafeReference, 80) ||
    clean(request?.customerSafeReference, 80) ||
    clean(request?.bookingReference, 80) ||
    ""
  );
}

/**
 * Deterministic owner-facing operational message (not customer conversation).
 * Token must stay visible for parsePaMissingInfoOwnerAnswerMessage.
 * Internal missingInfoType and raw booking Firestore IDs stay in the request
 * record only — not in visible text.
 * @param {Record<string, unknown>} request
 * @param {{ itemLabel?: string | null, customerSafeReference?: string | null }} [extra]
 */
export function buildPaMissingInfoOwnerNotificationMessage(request, extra = {}) {
  const requestId = clean(request?.requestId, 80) || "unknown";
  const customerPhone = formatCustomerPhoneForOwnerDisplay(request?.customerPhone);
  const question = clean(request?.customerQuestion, 280) || "(no question)";
  const itemLabel = formatItemLabelForOwnerDisplay(
    extra.itemLabel || request?.itemLabel
  );
  const safeRef = resolveCustomerSafeBookingReference(request, extra);

  const lines = ["❓ Customer question", ""];
  if (itemLabel) {
    lines.push("Item:", itemLabel, "");
  }
  if (safeRef) {
    lines.push("Booking ref:", safeRef, "");
  }
  lines.push(
    "Customer:",
    customerPhone,
    "",
    "Question:",
    `“${question}”`,
    "",
    "Reply to this message with the answer. Emily will send it to the customer.",
    "",
    "Reference:",
    requestId
  );
  return lines.join("\n");
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
