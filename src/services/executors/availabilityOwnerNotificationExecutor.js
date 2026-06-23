/**
 * Availability owner-notification executor — Phase 2C side effect.
 * Sends the owner notification for an existing availability request.
 */
import db from "../../config/firebase.js";
import { sendAvailabilityOwnerNotification } from "../availabilityOwnerNotificationService.js";

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, sent?: boolean, skipped?: boolean, reason?: string, requestId?: string | null, ownerTarget?: string | null }>}
 */
export async function executeAvailabilityOwnerNotification({ payload, executionContext = {} }) {
  const connection = executionContext?.db ?? db;
  const requestId =
    String(
      payload?.requestId ??
        executionContext?.requestId ??
        executionContext?.availabilityRequest?.requestId ??
        ""
    ).trim() || null;
  const businessId = String(
    payload?.businessId ??
      executionContext?.businessId ??
      executionContext?.userId ??
      executionContext?.availabilityRequest?.businessId ??
      ""
  ).trim();

  return sendAvailabilityOwnerNotification({
    db: connection,
    businessId,
    requestId: requestId ?? undefined,
    request: executionContext?.availabilityRequest ?? payload?.availabilityRequest ?? null,
    executionContext: {
      ...executionContext,
      payload,
      requestId,
    },
    sendWhatsAppMessageFn: executionContext?.sendWhatsAppMessageFn,
  });
}
