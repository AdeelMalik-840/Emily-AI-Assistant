/**
 * Booking executor — executes v2-approved CREATE_BOOKING actions only.
 * Does not make brain/routing decisions.
 */
import {
  classifyOptionalExpiryTimestamp,
  getAvailabilityRequest,
} from "../availabilityRequestService.js";
import { createBooking } from "../inventoryService.js";
import { assertExecutionOwnership } from "./executionOwnershipGuard.js";

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePhone(value) {
  return clean(value).replace(/[^\d+]/g, "");
}

async function validateAvailabilityConfirmGate({
  availabilityRequestId,
  businessId,
  itemId,
  durationDays,
  customerPhone,
  db,
}) {
  const requestId = clean(availabilityRequestId);
  const uid = clean(businessId);
  if (!requestId) return { ok: true };
  const request = await getAvailabilityRequest({
    db,
    businessId: uid,
    requestId,
  });
  if (!request) return { ok: false, reason: "AVAILABILITY_REQUEST_NOT_FOUND" };
  if (clean(request.status) !== "approved") {
    return { ok: false, reason: "AVAILABILITY_REQUEST_NOT_APPROVED" };
  }
  if (clean(request.approvalCustomerNotificationStatus) !== "sent") {
    return { ok: false, reason: "AVAILABILITY_CUSTOMER_NOT_NOTIFIED" };
  }
  if (clean(request.customerConfirmationStatus) !== "waiting_confirm") {
    return { ok: false, reason: "AVAILABILITY_NOT_WAITING_CONFIRM" };
  }
  if (clean(request.linkedBookingId)) {
    return { ok: false, reason: "AVAILABILITY_BOOKING_ALREADY_LINKED" };
  }
  if (clean(request.itemId) !== clean(itemId)) {
    return { ok: false, reason: "AVAILABILITY_ITEM_MISMATCH" };
  }
  const reqDuration = Number(request.requestedDuration);
  if (!Number.isFinite(reqDuration) || Math.floor(reqDuration) !== Math.floor(Number(durationDays))) {
    return { ok: false, reason: "AVAILABILITY_DURATION_MISMATCH" };
  }
  const phone = normalizePhone(customerPhone);
  const requestPhone = normalizePhone(request.customerPhone ?? request.customerDmTarget);
  if (phone && requestPhone && phone !== requestPhone) {
    return { ok: false, reason: "AVAILABILITY_CUSTOMER_MISMATCH" };
  }
  const expiry = classifyOptionalExpiryTimestamp(request.confirmExpiresAt);
  if (expiry.state === "invalid") {
    return { ok: false, reason: "AVAILABILITY_REQUEST_EXPIRY_INVALID" };
  }
  if (expiry.state === "expired") {
    return { ok: false, reason: "AVAILABILITY_REQUEST_EXPIRED" };
  }
  return { ok: true, request };
}

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, error?: string, code?: string, booking?: Record<string, unknown> | null, itemName?: string }>}
 */
export async function executeCreateBooking({ payload, executionContext = {} }) {
  assertExecutionOwnership(executionContext);
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

  const availabilityRequestId = clean(
    payload?.availabilityRequestId ?? executionContext?.availabilityRequestId
  );
  const gate = await validateAvailabilityConfirmGate({
    availabilityRequestId,
    businessId: userId,
    itemId,
    durationDays: Math.max(1, Math.floor(Number(durationDays))),
    customerPhone:
      executionContext?.participantPhoneForDm ??
      payload?.customerPhone ??
      payload?.sourceParticipantPhone,
    db: executionContext?.dbOverride ?? executionContext?.db,
  });
  assertExecutionOwnership(executionContext);
  if (!gate.ok) {
    return { ok: false, blocked: true, reason: gate.reason || "AVAILABILITY_CONFIRM_GATE_FAILED", booking: null };
  }

  try {
    const requestedItemName =
      String(payload?.itemName ?? payload?.itemLabel ?? executionContext?.itemName ?? "").trim() ||
      undefined;
    const createBookingFn = executionContext?.__createBookingForTests ?? createBooking;
    assertExecutionOwnership(executionContext);
    const booking = await createBookingFn(traceId, userId, {
      itemId,
      itemName: requestedItemName,
      durationDays: Math.max(1, Math.floor(Number(durationDays))),
      approvalStage: String(payload?.approvalStage ?? "pending_owner_approval").trim(),
      availabilityRequestId:
        String(
          payload?.availabilityRequestId ?? executionContext?.availabilityRequestId ?? ""
        ).trim() || undefined,
      sourceText: String(payload?.sourceMessage ?? executionContext?.message ?? "").trim(),
      sourceTurnKey:
        String(payload?.sourceTurnKey ?? executionContext?.sourceTurnKey ?? "").trim() ||
        undefined,
      guaranteeKey:
        String(payload?.guaranteeKey ?? executionContext?.guaranteeKey ?? "").trim() ||
        undefined,
      sourceMessageId:
        String(payload?.sourceMessageId ?? executionContext?.messageId ?? "").trim() ||
        undefined,
      sourceRowKey:
        String(payload?.sourceRowKey ?? executionContext?.sourceRowKey ?? "").trim() ||
        undefined,
      sourceMessageIndex:
        payload?.sourceMessageIndex != null && Number.isFinite(Number(payload.sourceMessageIndex))
          ? Math.max(0, Math.floor(Number(payload.sourceMessageIndex)))
          : executionContext?.sourceMessageIndex != null &&
              Number.isFinite(Number(executionContext.sourceMessageIndex))
            ? Math.max(0, Math.floor(Number(executionContext.sourceMessageIndex)))
            : undefined,
      messageId: String(executionContext?.messageId ?? "").trim() || undefined,
      customerPhone: String(
        executionContext?.participantPhoneForDm ?? payload?.customerPhone ?? ""
      ).trim() || undefined,
      sessionKey: String(executionContext?.sessionKey ?? "").trim() || undefined,
      source:
        String(payload?.source ?? executionContext?.source ?? "").trim() ||
        (executionContext?.isGroupInbound === true || executionContext?.playwrightChatKey
          ? "playwright"
          : undefined),
      groupName:
        String(payload?.groupName ?? executionContext?.groupName ?? "").trim() ||
        undefined,
      sourceGroupName:
        String(payload?.sourceGroupName ?? executionContext?.sourceGroupName ?? executionContext?.groupName ?? "").trim() ||
        undefined,
      playwrightChatKey:
        String(payload?.playwrightChatKey ?? executionContext?.playwrightChatKey ?? executionContext?.chatId ?? "").trim() ||
        undefined,
      sourcePlaywrightChatKey:
        String(
          payload?.sourcePlaywrightChatKey ??
            executionContext?.sourcePlaywrightChatKey ??
            executionContext?.playwrightChatKey ??
            executionContext?.chatId ??
            ""
        ).trim() || undefined,
      participantName:
        String(payload?.participantName ?? executionContext?.participantName ?? "").trim() ||
        undefined,
      sourceParticipantName:
        String(
          payload?.sourceParticipantName ??
            executionContext?.sourceParticipantName ??
            executionContext?.participantName ??
            ""
        ).trim() || undefined,
      sourceParticipantDisplayName:
        String(
          payload?.sourceParticipantDisplayName ??
            executionContext?.sourceParticipantDisplayName ??
            executionContext?.participantName ??
            ""
        ).trim() || undefined,
      sourceParticipantKey:
        String(
          payload?.sourceParticipantKey ??
            payload?.participantKey ??
            executionContext?.sourceParticipantKey ??
            executionContext?.participantKey ??
            ""
        ).trim() || undefined,
      sourceParticipantPhone:
        String(
          payload?.sourceParticipantPhone ??
            executionContext?.sourceParticipantPhone ??
            executionContext?.participantPhoneForDm ??
            ""
        ).trim() || undefined,
      senderScope:
        String(payload?.senderScope ?? executionContext?.senderScope ?? "").trim() ||
        undefined,
      sourceSenderScope:
        String(
          payload?.sourceSenderScope ??
            executionContext?.sourceSenderScope ??
            executionContext?.senderScope ??
            ""
        ).trim() || undefined,
      originalUserMessageText: Object.hasOwn(payload ?? {}, "originalUserMessageText")
        ? String(payload.originalUserMessageText ?? "").trim()
        : String(payload?.sourceMessage ?? executionContext?.message ?? "").trim() ||
          undefined,
      // Trusted approved window from the same AVR the confirm gate above
      // already fetched — never re-derived from "now", never re-parsed from
      // customer text. Absent for legacy/no-AVR bookings, which keep the
      // existing duration-from-now fallback inside createBooking().
      requestedStartAt: gate.request?.requestedStartAt,
      requestedEndAt: gate.request?.requestedEndAt,
      canDmCustomer: executionContext?.canDmCustomer === true || payload?.canDmCustomer === true,
      dmTargetPhone:
        String(payload?.dmTargetPhone ?? executionContext?.participantPhoneForDm ?? "").trim() ||
        undefined,
      dmTargetSource:
        String(payload?.dmTargetSource ?? executionContext?.dmTargetSource ?? "").trim() ||
        undefined,
      dbOverride: executionContext?.dbOverride ?? executionContext?.db,
      abortSignal: executionContext?.abortSignal,
      executionGuard: executionContext?.executionGuard,
    });
    assertExecutionOwnership(executionContext);
    if (booking && typeof booking === "object" && booking.ok === false) {
      const code =
        String(booking.code ?? booking.error ?? "BOOKING_CREATE_FAILED").trim() ||
        "BOOKING_CREATE_FAILED";
      return {
        ok: false,
        code,
        error: String(booking.error ?? code).trim() || code,
        reason: String(booking.reason ?? booking.error ?? code).trim() || code,
        booking: null,
        ...(requestedItemName ? { itemName: requestedItemName } : {}),
      };
    }
    return { ok: true, booking: booking && typeof booking === "object" ? booking : null };
  } catch (err) {
    return {
      ok: false,
      reason: String(err?.message ?? err ?? "BOOKING_EXECUTOR_ERROR").slice(0, 160),
      booking: null,
    };
  }
}
