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
      itemName:
        String(payload?.itemName ?? payload?.itemLabel ?? executionContext?.itemName ?? "").trim() ||
        undefined,
      durationDays: Math.max(1, Math.floor(Number(durationDays))),
      approvalStage: String(payload?.approvalStage ?? "pending_owner_approval").trim(),
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
      originalUserMessageText:
        String(payload?.sourceMessage ?? executionContext?.message ?? "").trim() ||
        undefined,
      canDmCustomer: executionContext?.canDmCustomer === true || payload?.canDmCustomer === true,
      dmTargetPhone:
        String(payload?.dmTargetPhone ?? executionContext?.participantPhoneForDm ?? "").trim() ||
        undefined,
      dmTargetSource:
        String(payload?.dmTargetSource ?? executionContext?.dmTargetSource ?? "").trim() ||
        undefined,
      dbOverride: executionContext?.dbOverride ?? executionContext?.db,
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
