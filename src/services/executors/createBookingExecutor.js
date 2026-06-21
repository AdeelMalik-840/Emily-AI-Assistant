/**
 * Booking executor — executes v2-approved CREATE_BOOKING actions only.
 * Does not make brain/routing decisions.
 */
import { createBooking } from "../inventoryService.js";

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, booking?: Record<string, unknown> | null }>}
 */
export async function executeCreateBooking({ payload, executionContext = {} }) {
  const itemId = String(payload?.itemId ?? "").trim();
  if (!itemId) {
    return { ok: false, blocked: true, reason: "MISSING_ITEM_ID", booking: null };
  }
  const durationDays = payload?.durationDays;
  if (durationDays == null || !Number.isFinite(Number(durationDays))) {
    return { ok: false, blocked: true, reason: "MISSING_DURATION", booking: null };
  }

  const userId = String(executionContext?.businessId ?? executionContext?.userId ?? "").trim();
  const traceId = String(executionContext?.traceId ?? "v2-booking").trim();
  if (!userId) {
    return { ok: false, blocked: true, reason: "MISSING_BUSINESS_ID", booking: null };
  }

  try {
    const booking = await createBooking(traceId, userId, {
      itemId,
      durationDays: Math.max(1, Math.floor(Number(durationDays))),
      approvalStage: String(payload?.approvalStage ?? "pending_owner_approval").trim(),
      sourceText: String(payload?.sourceMessage ?? executionContext?.message ?? "").trim(),
      customerPhone: String(
        executionContext?.participantPhoneForDm ?? payload?.customerPhone ?? ""
      ).trim() || undefined,
      sessionKey: String(executionContext?.sessionKey ?? "").trim() || undefined,
    });
    return { ok: true, booking: booking && typeof booking === "object" ? booking : null };
  } catch (err) {
    return {
      ok: false,
      reason: String(err?.message ?? err ?? "BOOKING_EXECUTOR_ERROR").slice(0, 160),
      booking: null,
    };
  }
}
