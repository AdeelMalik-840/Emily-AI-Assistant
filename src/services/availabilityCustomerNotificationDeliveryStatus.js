/**
 * Persist WhatsApp Cloud delivery status for availabilityRequest customer notifies.
 * Matches statuses[].id to approvalCustomerNotificationProviderMessageId only.
 * Owner wamids (ownerNotificationProviderMessageId) never mutate customerDelivery*.
 */

import { maskCustomerPhone } from "./availabilityCustomerPhone.js";
import { updateAvailabilityRequestFields } from "./availabilityRequestService.js";

function safeString(value, max = 400) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function maskRecipient(value) {
  return maskCustomerPhone(value) || null;
}

/**
 * Preserve Meta delivery states (do not collapse sent→delivered).
 * @param {unknown} status
 * @returns {"sent" | "delivered" | "read" | "failed" | ""}
 */
export function normalizeAvailabilityCustomerDeliveryStatus(status) {
  const s = safeString(status, 80).toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read" || s === "failed") {
    return s;
  }
  return "";
}

/**
 * @param {Record<string, unknown> | null | undefined} statusEntry
 */
export function extractAvailabilityDeliveryErrorFields(statusEntry) {
  const errors = Array.isArray(statusEntry?.errors) ? statusEntry.errors : [];
  const first =
    errors[0] && typeof errors[0] === "object"
      ? /** @type {Record<string, unknown>} */ (errors[0])
      : null;
  if (!first) {
    return {
      customerDeliveryErrorCode: null,
      customerDeliveryErrorTitle: null,
      customerDeliveryErrorMessage: null,
      customerDeliveryErrorDetails: null,
    };
  }
  const errorData =
    first.error_data && typeof first.error_data === "object"
      ? /** @type {Record<string, unknown>} */ (first.error_data)
      : {};
  return {
    customerDeliveryErrorCode:
      first.code != null && String(first.code).trim() !== ""
        ? safeString(first.code, 80)
        : null,
    customerDeliveryErrorTitle: safeString(first.title, 200) || null,
    customerDeliveryErrorMessage: safeString(first.message, 400) || null,
    customerDeliveryErrorDetails: safeString(errorData.details, 400) || null,
  };
}

/**
 * Safe stringify for webhook status logging (expands nested errors).
 * @param {unknown} statuses
 */
export function stringifyWhatsAppStatusesForLog(statuses) {
  try {
    return JSON.stringify(statuses);
  } catch {
    return "[unserializable_statuses]";
  }
}

/**
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   providerMessageId: string,
 *   field: string,
 *   limit?: number,
 * }} params
 */
async function queryAvailabilityRequestsByProviderField({
  db,
  businessId,
  providerMessageId,
  field,
  limit = 5,
}) {
  const uid = safeString(businessId);
  const wamid = safeString(providerMessageId, 160);
  if (!db || !uid || !wamid || !field) return [];
  try {
    const snap = await db
      .collection("businesses")
      .doc(uid)
      .collection("availabilityRequests")
      .where(field, "==", wamid)
      .limit(limit)
      .get();
    if (!snap || snap.empty) return [];
    return Array.isArray(snap.docs) ? snap.docs : [];
  } catch (err) {
    console.warn("[availability_customer_delivery_status_query_failed]", {
      businessId: uid,
      field,
      error: err?.message || String(err),
    });
    return [];
  }
}

/**
 * Apply one webhook status entry to matching availabilityRequests (customer wamid only).
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   statuses?: unknown[],
 * }} params
 * @returns {Promise<{ handled: number, ownerMatched: number, unknown: number }>}
 */
export async function handleAvailabilityCustomerNotificationStatuses({
  db,
  businessId,
  statuses,
}) {
  const uid = safeString(businessId);
  if (!db || !uid || !Array.isArray(statuses) || statuses.length === 0) {
    return { handled: 0, ownerMatched: 0, unknown: 0 };
  }

  let handled = 0;
  let ownerMatched = 0;
  let unknown = 0;

  for (const entry of statuses) {
    if (!entry || typeof entry !== "object") continue;
    const statusEntry = /** @type {Record<string, unknown>} */ (entry);
    const providerMessageId = safeString(statusEntry.id, 160);
    const nextStatus = normalizeAvailabilityCustomerDeliveryStatus(
      statusEntry.status
    );
    if (!providerMessageId) continue;

    console.log("[availability_customer_delivery_status_received]", {
      businessId: uid,
      providerMessageId,
      status: safeString(statusEntry.status, 80) || null,
      recipientMasked: maskRecipient(statusEntry.recipient_id),
      errors: stringifyWhatsAppStatusesForLog(statusEntry.errors ?? null),
    });

    if (!nextStatus) {
      console.log("[availability_customer_delivery_status_ignored]", {
        businessId: uid,
        providerMessageId,
        reason: "UNSUPPORTED_STATUS",
        status: safeString(statusEntry.status, 80) || null,
      });
      continue;
    }

    const customerDocs = await queryAvailabilityRequestsByProviderField({
      db,
      businessId: uid,
      providerMessageId,
      field: "approvalCustomerNotificationProviderMessageId",
    });

    if (customerDocs.length > 0) {
      const errorFields =
        nextStatus === "failed"
          ? extractAvailabilityDeliveryErrorFields(statusEntry)
          : {
              customerDeliveryErrorCode: null,
              customerDeliveryErrorTitle: null,
              customerDeliveryErrorMessage: null,
              customerDeliveryErrorDetails: null,
            };

      const recipientId = safeString(statusEntry.recipient_id, 40) || null;
      const recipientUserId =
        statusEntry.recipient_user_id != null
          ? safeString(statusEntry.recipient_user_id, 80) || null
          : null;
      const tsRaw = statusEntry.timestamp;
      const tsNum = Number(tsRaw);
      const deliveryTimestamp =
        Number.isFinite(tsNum) && tsNum > 0
          ? new Date(tsNum * (tsNum < 1e12 ? 1000 : 1))
          : null;

      for (const doc of customerDocs) {
        const requestId = safeString(doc.id);
        const patch = {
          customerDeliveryStatus: nextStatus,
          customerDeliveryWebhookAt: new Date(),
          customerDeliveryTimestamp: deliveryTimestamp,
          customerDeliveryRecipientId: recipientId,
          customerDeliveryRecipientUserId: recipientUserId,
        };
        if (nextStatus === "failed") {
          Object.assign(patch, errorFields);
        } else {
          patch.customerDeliveryErrorCode = null;
          patch.customerDeliveryErrorTitle = null;
          patch.customerDeliveryErrorMessage = null;
          patch.customerDeliveryErrorDetails = null;
        }

        const updated = await updateAvailabilityRequestFields({
          db,
          businessId: uid,
          requestId,
          patch,
        });
        if (!updated) {
          console.warn("[availability_customer_delivery_status_update_failed]", {
            businessId: uid,
            requestId,
          });
          continue;
        }

        console.log("[availability_customer_delivery_status_updated]", {
          businessId: uid,
          requestId,
          providerMessageId,
          customerDeliveryStatus: nextStatus,
          recipientMasked: maskRecipient(recipientId),
          errorCode: patch.customerDeliveryErrorCode || null,
          errorTitle: patch.customerDeliveryErrorTitle || null,
          errorMessage: patch.customerDeliveryErrorMessage || null,
        });
        handled += 1;
      }
      continue;
    }

    const ownerDocs = await queryAvailabilityRequestsByProviderField({
      db,
      businessId: uid,
      providerMessageId,
      field: "ownerNotificationProviderMessageId",
    });

    if (ownerDocs.length > 0) {
      ownerMatched += ownerDocs.length;
      console.log("[availability_owner_delivery_status_matched]", {
        businessId: uid,
        providerMessageId,
        status: nextStatus,
        matchCount: ownerDocs.length,
        note: "customerDeliveryStatus not mutated",
      });
      continue;
    }

    unknown += 1;
    console.log("[availability_delivery_status_unknown_wamid]", {
      businessId: uid,
      providerMessageId,
      status: nextStatus,
      recipientMasked: maskRecipient(statusEntry.recipient_id),
    });
  }

  return { handled, ownerMatched, unknown };
}
