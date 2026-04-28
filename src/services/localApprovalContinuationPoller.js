import admin from "firebase-admin";

import db from "../config/firebase.js";
import { buildCustomerApprovalContinuation } from "./customerApprovalContinuation.js";
import { replyPrivatelyToLatestUserMessage } from "./playwrightReplyPrivatelyBridge.js";

const FieldValue = admin.firestore.FieldValue;

let pollRunning = false;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function resolveOwnerUid() {
  return clean(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  );
}

function resolveApprovalResponseStyle(booking) {
  return (
    clean(
      booking?.conversationStyle ??
        booking?.userLanguageStyle ??
        booking?.languageStyle ??
        ""
    ) || "casual_local"
  );
}

function buildOwnerApprovedBookingCustomerEvent(booking) {
  return {
    eventType: "OWNER_APPROVED_BOOKING",
    itemName: clean(booking?.itemName) || null,
    durationDays:
      booking?.durationDays != null && Number.isFinite(Number(booking.durationDays))
        ? Math.max(1, Math.floor(Number(booking.durationDays)))
        : null,
    approvalStage: "owner_approved_waiting_customer_details",
    canDmCustomer: true,
    privacyMode: "dm",
    requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
  };
}

function buildSourceMessageForReplyPrivately(booking) {
  return {
    sourceRowKey:
      clean(booking?.originalMessageRowKey ?? booking?.sourceRowKey) || null,
    sourceMessageId: clean(booking?.sourceMessageId) || null,
    sourceText:
      clean(booking?.originalUserMessageText ?? booking?.sourceText) || null,
    sourceTimestamp:
      booking?.originalMessageTimestamp != null &&
      Number.isFinite(Number(booking.originalMessageTimestamp))
        ? Number(booking.originalMessageTimestamp)
        : booking?.sourceTimestamp != null && Number.isFinite(Number(booking.sourceTimestamp))
          ? Number(booking.sourceTimestamp)
          : null,
    sourceSenderScope:
      clean(booking?.sourceSenderScope ?? booking?.senderScope) || null,
    sourceParticipantName:
      clean(
        booking?.originalCustomerDisplayName ??
          booking?.sourceParticipantName ??
          booking?.participantName
      ) || null,
  };
}

function ownerDisallowedChatTitles() {
  return [
    process.env.WHATSAPP_DISPLAY_PHONE_NUMBER,
    process.env.WHATSAPP_PHONE_NUMBER,
    process.env.BUSINESS_WHATSAPP_NUMBER,
    process.env.OWNER_WHATSAPP_NUMBER,
  ]
    .map(clean)
    .filter(Boolean);
}

async function fetchPendingPlaywrightApprovals(dbInstance, ownerUserId, limit = 5) {
  const snap = await dbInstance
    .collection("businesses")
    .doc(ownerUserId)
    .collection("bookings")
    .where("status", "==", "approved")
    .where("approvalCustomerNotificationStatus", "==", "pending")
    .where("bookingSource", "==", "PLAYWRIGHT_GROUP")
    .where("playwrightReplyPrivateEligible", "==", true)
    .limit(limit)
    .get();

  return snap.docs.map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  }));
}

async function processPendingApproval({
  bookingId,
  bookingRef,
  booking,
  replyPrivately = replyPrivatelyToLatestUserMessage,
}) {
  console.log("[local_approval_continuation_booking_found]", {
    bookingId,
    groupName: clean(booking?.groupName ?? booking?.sourceGroupName) || null,
    playwrightChatKey:
      clean(
        booking?.sourcePlaywrightChatKey ??
          booking?.playwrightChatKey ??
          booking?.chatKey
      ) || null,
  });

  const groupName = clean(booking?.sourceGroupName ?? booking?.groupName);
  const playwrightChatKey = clean(
    booking?.sourcePlaywrightChatKey ?? booking?.playwrightChatKey ?? booking?.chatKey
  );
  const message = buildCustomerApprovalContinuation(
    buildOwnerApprovedBookingCustomerEvent(booking),
    resolveApprovalResponseStyle(booking)
  );

  console.log("[local_approval_reply_private_started]", {
    bookingId,
    groupName: groupName || null,
    playwrightChatKey: playwrightChatKey || null,
  });

  globalThis.__UI_HARD_LOCK = true;
  globalThis.__OUTBOUND_BUSY__ = true;
  try {
    const result = await replyPrivately({
      bookingId,
      groupName: groupName || null,
      playwrightChatKey: playwrightChatKey || null,
      message,
      sourceMessage: buildSourceMessageForReplyPrivately(booking),
      disallowedChatTitles: [groupName, ...ownerDisallowedChatTitles()].filter(Boolean),
    });

    if (!result?.ok) {
      throw new Error(clean(result?.reason) || "REPLY_PRIVATELY_FAILED");
    }

    await bookingRef.update({
      approvalCustomerNotificationStatus: "sent",
      approvalCustomerNotificationMethod: "reply_privately",
      approvalCustomerNotificationSentAt: FieldValue.serverTimestamp(),
      dmAttempted: true,
      dmOpened: true,
      dmMessageSent: true,
      dmOpenMethod: "reply_privately",
      dmChatTitle: clean(result?.dmChatTitle) || null,
      dmPlaywrightChatKey: clean(result?.dmPlaywrightChatKey) || null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.log("[local_approval_reply_private_sent]", { bookingId });
  } catch (err) {
    const reason = clean(err?.message ?? err) || "UNKNOWN";
    await bookingRef.update({
      approvalCustomerNotificationStatus: "failed",
      approvalCustomerNotificationMethod: "reply_privately",
      approvalCustomerNotificationError: reason,
      dmAttempted: true,
      dmOpened: false,
      dmMessageSent: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.warn("[local_approval_reply_private_failed]", {
      bookingId,
      reason,
    });
  } finally {
    globalThis.__OUTBOUND_BUSY__ = false;
    globalThis.__UI_HARD_LOCK = false;
  }
}

export async function pollLocalApprovalContinuations({
  dbInstance = db,
  ownerUserId = resolveOwnerUid(),
  replyPrivately = replyPrivatelyToLatestUserMessage,
} = {}) {
  if (pollRunning) return;
  const resolvedOwnerUserId = clean(ownerUserId);
  if (!resolvedOwnerUserId) return;

  pollRunning = true;
  try {
    console.log("[local_approval_continuation_poll_started]", {
      ownerUserId: resolvedOwnerUserId,
    });
    const bookings = await fetchPendingPlaywrightApprovals(
      dbInstance,
      resolvedOwnerUserId
    );
    for (const booking of bookings) {
      await processPendingApproval({
        bookingId: booking.id,
        bookingRef: booking.ref,
        booking: booking.data,
        replyPrivately,
      });
    }
  } catch (err) {
    console.warn("[local_approval_reply_private_failed]", {
      bookingId: null,
      reason: clean(err?.message ?? err) || "POLL_FAILED",
    });
  } finally {
    pollRunning = false;
  }
}
