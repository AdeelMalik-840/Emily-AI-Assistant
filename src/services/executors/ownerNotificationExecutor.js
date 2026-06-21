/**
 * Owner notification executor — executes v2-approved NOTIFY_OWNER actions only.
 */

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   booking: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, sent?: boolean }>}
 */
export async function executeOwnerNotification({ payload, booking, executionContext = {} }) {
  const bookingId = String(booking?.id ?? "").trim();
  if (!bookingId) {
    return { ok: false, blocked: true, reason: "MISSING_BOOKING_ID", sent: false };
  }

  const userId = String(executionContext?.businessId ?? executionContext?.userId ?? "").trim();
  const traceId = String(executionContext?.traceId ?? "").trim() || "unknown-trace";
  const db = executionContext?.db;
  if (!userId || !db) {
    return { ok: false, blocked: true, reason: "MISSING_EXECUTION_CONTEXT", sent: false };
  }

  const bufferMod = await import("../whatsappInboundBuffer.js");
  const notifyFn = /** @type {Function | undefined} */ (bufferMod.__triggerBusinessBookingNotificationForTests);
  if (typeof notifyFn !== "function") {
    return { ok: false, blocked: true, reason: "OWNER_NOTIFICATION_NOT_WIRED", sent: false };
  }

  await notifyFn({
    traceId,
    db,
    userId,
    booking,
    customerPhone: String(
      payload?.customerPhone ??
        executionContext?.participantPhoneForDm ??
        booking?.customerPhone ??
        ""
    ).trim(),
    sendCredentials: executionContext?.sendCredentials ?? null,
  });

  return { ok: true, sent: true };
}
