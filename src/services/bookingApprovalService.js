import { markItemUnavailableOnApproval } from "./inventoryService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { sendPlaywrightGroupText } from "./playwrightOutboundBridge.js";
import {
  getBusinessWhatsAppLink,
  getGroupDmHandoffText,
  getGroupNoDmFallbackText,
} from "./bookingDmFlow.js";
import {
  getEmilySessionState,
  patchEmilySessionState,
} from "./conversationIntelligence.js";
import { chatSessionKey } from "./memory.js";

/**
 * @param {string | null | undefined} p
 * @returns {string}
 */
function normalizePhone(p) {
  if (!p) return "";
  const cleaned = String(p).replace(/[^\d+]/g, "").replace(/^\++/, "+");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("92")) return `+${cleaned}`;
  return `+92${cleaned.replace(/^0+/, "")}`;
}

function isRoutableDmTarget(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "unknown") return false;
  if (/^grp[0-9a-f]{8,}$/i.test(raw) || /^anon::/i.test(raw)) return false;
  if (raw.includes("@")) {
    return /@(c\.us|s\.whatsapp\.net)$/i.test(raw);
  }
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function bookingOwnerApprovalFirstEnabled() {
  return /^true$/i.test(String(process.env.BOOKING_OWNER_APPROVAL_FIRST ?? "").trim());
}

function updateSessionBookingStateFromApproval({ userId, bookingId, booking, status, approvalStage }) {
  const contextKey = String(booking?.playwrightChatKey ?? booking?.sessionKey ?? "").trim();
  const uid = String(userId ?? "").trim();
  const bid = String(bookingId ?? "").trim();
  if (!uid || !contextKey || !bid) return;
  const sessionKey = chatSessionKey(uid, contextKey);
  const current = getEmilySessionState(sessionKey);
  const itemId =
    booking?.itemId != null && String(booking.itemId).trim() !== ""
      ? String(booking.itemId).trim()
      : null;
  const currentBookingId = String(current?.bookingState?.bookingId ?? "").trim();
  const currentItemBookingId =
    itemId &&
    current?.bookingStatesByItemId &&
    typeof current.bookingStatesByItemId === "object"
      ? String(current.bookingStatesByItemId[itemId]?.bookingId ?? "").trim()
      : "";
  if (currentBookingId && currentBookingId !== bid && currentItemBookingId !== bid) return;
  const bookingState = {
    bookingId: bid,
    itemId,
    status,
    approvalStage: approvalStage || null,
    durationDays:
      booking?.durationDays != null && Number.isFinite(Number(booking.durationDays))
        ? Math.max(1, Math.floor(Number(booking.durationDays)))
        : null,
    sessionKey,
    channel: String(booking?.groupName ?? "").trim() ? "group" : "dm",
    updatedAt: new Date().toISOString(),
  };
  const previousByItem =
    current?.bookingStatesByItemId &&
    typeof current.bookingStatesByItemId === "object" &&
    !Array.isArray(current.bookingStatesByItemId)
      ? current.bookingStatesByItemId
      : {};
  patchEmilySessionState(sessionKey, {
    bookingState,
    ...(itemId
      ? { bookingStatesByItemId: { ...previousByItem, [itemId]: bookingState } }
      : {}),
  });
  console.log("[booking_state_set]", {
    bookingId: bid,
    itemId: String(booking?.itemId ?? "").trim() || null,
    status,
    approvalStage: approvalStage || null,
    source: "owner_approval",
  });
}

function scheduleGroupNoDmFallback({ db, bookingRef, bookingId, groupName }) {
  const safeGroupName = String(groupName ?? "").trim();
  if (!db || !bookingRef || !bookingId || !safeGroupName) {
    console.log("[group_no_dm_fallback_skipped]", {
      bookingId,
      reason: "MISSING_GROUP_CONTEXT",
    });
    return;
  }
  const delayMs = 3 * 60 * 1000;
  setTimeout(() => {
    void (async () => {
      const snap = await bookingRef.get();
      if (!snap.exists) {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "BOOKING_MISSING",
        });
        return;
      }
      const data = snap.data() || {};
      if (data.dmFallbackSent === true) {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "ALREADY_SENT",
        });
        return;
      }
      if (data.deliveryConversationStarted === true) {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "DM_STARTED",
        });
        return;
      }
      if (data.status === "cancelled" || data.status === "rejected") {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "BOOKING_NOT_ACTIVE",
          status: data.status,
        });
        return;
      }
      if (
        String(data.approvalStage ?? "") !==
        "owner_approved_waiting_customer_details"
      ) {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "STAGE_CHANGED",
          approvalStage: data.approvalStage || null,
        });
        return;
      }
      const text = getGroupNoDmFallbackText();
      const sent = await sendPlaywrightGroupText(text, { expectedChat: safeGroupName });
      if (sent) {
        await bookingRef.update({
          dmFallbackSent: true,
          dmFallbackTimestamp: new Date(),
          updatedAt: new Date(),
        });
        console.log("[group_no_dm_fallback_sent]", { bookingId, groupName: safeGroupName });
      } else {
        console.log("[group_no_dm_fallback_skipped]", {
          bookingId,
          reason: "SEND_FAILED",
        });
      }
    })().catch((err) => {
      console.warn("[group_no_dm_fallback_skipped]", {
        bookingId,
        reason: "ERROR",
        error: String(err?.message ?? err ?? ""),
      });
    });
  }, delayMs);
}

/**
 * @param {string | null | undefined} text
 * @returns {{ action: "approve" | "reject", bookingId: string } | null}
 */
export function parseApprovalMessage(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const approveMatch = raw.match(/^approve\s+(\S+)/i);
  if (approveMatch) {
    return { action: "approve", bookingId: String(approveMatch[1] ?? "").trim() };
  }

  const rejectMatch = raw.match(/^reject\s+(\S+)/i);
  if (rejectMatch) {
    return { action: "reject", bookingId: String(rejectMatch[1] ?? "").trim() };
  }

  return null;
}

/**
 * @param {string | null | undefined} buttonId
 * @returns {{ action: "approve" | "reject", bookingId: string } | null}
 */
export function parseApprovalButtonId(buttonId) {
  const raw = String(buttonId ?? "").trim();
  if (!raw) return null;

  const match = raw.match(/^(approve|reject):(.+)$/i);
  if (!match) return null;

  const action = String(match[1] ?? "").toLowerCase();
  const bookingId = String(match[2] ?? "").trim();
  if (!bookingId) return null;

  return {
    action: action === "approve" ? "approve" : "reject",
    bookingId,
  };
}

/**
 * @param {{
 *   db: import("firebase-admin/firestore").Firestore,
 *   userId: string,
 *   bookingId: string,
 *   action: "approve" | "reject",
 *   senderPhone?: string,
 *   sendCredentials?: { accessToken?: string, phoneNumberId?: string } | null,
 *   sendGroupText?: typeof sendPlaywrightGroupText,
 *   sendMessage?: typeof sendWhatsAppMessage,
 *   markUnavailable?: typeof markItemUnavailableOnApproval,
 * }} p
 * @returns {Promise<{ ok: boolean, status?: "approved" | "rejected" }>}
 */
export async function handleBookingApproval({
  db,
  userId,
  bookingId,
  action,
  senderPhone,
  sendCredentials = null,
  sendGroupText = sendPlaywrightGroupText,
  sendMessage = sendWhatsAppMessage,
  markUnavailable = markItemUnavailableOnApproval,
}) {
  try {
    const uid = String(userId ?? "").trim();
    const bid = String(bookingId ?? "").trim();
    if (!db || !uid || !bid) return { ok: false };
    if (action !== "approve" && action !== "reject") return { ok: false };

    console.log("[booking_approval_handler_started]", {
      bookingId: bid,
      action,
      userId: uid,
    });

    const bookingRef = db
      .collection("businesses")
      .doc(uid)
      .collection("bookings")
      .doc(bid);

    const snap = await bookingRef.get();
    if (!snap.exists) {
      console.warn("⚠️ Booking not found:", bid);
      return { ok: false };
    }

    const data = snap.data() || {};
    let businessData = null;
    let ownerPhone =
      data?.ownerNotificationPhone ??
      data?.businessProfile?.ownerNotificationPhone ??
      null;

    if (!ownerPhone) {
      try {
        const businessSnap = await db.collection("businesses").doc(uid).get();
        businessData = businessSnap.exists ? businessSnap.data() || {} : {};
        const businessProfile =
          businessData.businessProfile &&
          typeof businessData.businessProfile === "object" &&
          !Array.isArray(businessData.businessProfile)
            ? businessData.businessProfile
            : {};
        ownerPhone =
          businessData?.ownerNotificationPhone ??
          businessProfile?.ownerNotificationPhone ??
          null;
      } catch (err) {
        console.warn("⚠️ Could not resolve owner phone for auth check:", err?.message || err);
      }
    }
    if (!businessData) {
      try {
        const businessSnap = await db.collection("businesses").doc(uid).get();
        businessData = businessSnap.exists ? businessSnap.data() || {} : {};
      } catch {
        businessData = {};
      }
    }

    const owner = normalizePhone(ownerPhone);
    const sender = normalizePhone(senderPhone);
    if (!owner || !sender) return { ok: false };
    if (owner && sender && owner !== sender) {
      console.warn("⚠️ Unauthorized approval attempt:", {
        bookingId: bid,
        sender,
        owner,
      });
      return { ok: false };
    }
    console.log("🔐 Approval auth check passed:", { bookingId: bid });

    if (data.status !== "pending_approval") {
      console.log("ℹ️ Approval ignored — already processed", {
        bookingId: bid,
        status: data.status,
      });
      if (data?.approvalCustomerNotificationStatus === "sent") {
        console.log("[approval_customer_notify_skipped_duplicate]", {
          bookingId: bid,
          method: data?.approvalCustomerNotificationMethod ?? null,
        });
      }
      return { ok: false };
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const ownerApprovalFirst =
      bookingOwnerApprovalFirstEnabled() ||
      String(data?.approvalStage ?? "") === "pending_owner_approval";
    await bookingRef.update({
      status: newStatus,
      businessId: uid,
      ownerUserId: uid,
      ...(ownerApprovalFirst
        ? {
            approvalStage:
              newStatus === "approved"
                ? "owner_approved_waiting_customer_details"
                : "rejected",
          }
        : {}),
      updatedAt: new Date(),
      approvedBy: String(senderPhone ?? "").trim() || null,
    });
    console.log("[booking_approval_status_updated]", {
      bookingId: bid,
      status: newStatus,
      approvalStage: ownerApprovalFirst
        ? newStatus === "approved"
          ? "owner_approved_waiting_customer_details"
          : "rejected"
        : String(data?.approvalStage ?? "").trim() || null,
    });
    updateSessionBookingStateFromApproval({
      userId: uid,
      bookingId: bid,
      booking: data,
      status: newStatus,
      approvalStage: ownerApprovalFirst
        ? newStatus === "approved"
          ? "owner_approved_waiting_customer_details"
          : "rejected"
        : String(data?.approvalStage ?? "").trim() || null,
    });

    if (newStatus === "approved") {
      await markUnavailable({
        db,
        userId: uid,
        bookingId: bid,
        itemId: String(data.itemId ?? "").trim(),
      });
    }

    const feedbackMessage =
      newStatus === "approved" ? "Booking approved." : "Booking rejected.";
    const feedbackTo = normalizePhone(senderPhone);
    if (feedbackTo) {
      try {
        await sendMessage(feedbackTo, feedbackMessage, sendCredentials ?? undefined, {
          recipientType: "individual",
        });
        console.log("[approval_owner_ack_sent]", { bookingId: bid, status: newStatus });
      } catch (feedbackErr) {
        console.warn(
          "⚠️ Booking approval feedback send failed:",
          feedbackErr?.message || feedbackErr
        );
      }
    }

    if (newStatus === "approved") {
      const notificationStatus = String(
        data?.approvalCustomerNotificationStatus ?? ""
      ).trim();
      if (notificationStatus === "sent") {
        console.log("[approval_customer_notify_skipped_duplicate]", {
          bookingId: bid,
          method: data?.approvalCustomerNotificationMethod ?? null,
        });
      } else {
        console.log("[approval_customer_notify_started]", { bookingId: bid });
        await bookingRef.update({
          approvalCustomerNotificationStatus: "pending",
          updatedAt: new Date(),
        });
      }
    }

    console.log("✅ Booking status updated:", { bookingId: bid, newStatus });
    return { ok: true, status: newStatus };
  } catch (err) {
    console.error("❌ Booking approval failed:", err?.message || err);
    return { ok: false };
  }
}
