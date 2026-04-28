import { markItemUnavailableOnApproval } from "./inventoryService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { sendPlaywrightGroupText } from "./playwrightOutboundBridge.js";
import { replyPrivatelyToLatestUserMessage } from "./playwrightReplyPrivatelyBridge.js";
import {
  getBusinessWhatsAppLink,
  getGroupDmHandoffText,
  getGroupNoDmFallbackText,
} from "./bookingDmFlow.js";
import {
  getEmilySessionState,
  patchEmilySessionState,
} from "./conversationIntelligence.js";
import { buildCustomerApprovalContinuation } from "./customerApprovalContinuation.js";
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

function playwrightReplyPrivatelyEnabled() {
  return /^true$/i.test(
    String(process.env.PLAYWRIGHT_REPLY_PRIVATELY_ENABLED ?? "").trim()
  );
}

function resolveApprovalResponseStyle(booking) {
  return (
    String(
      booking?.conversationStyle ??
        booking?.userLanguageStyle ??
        booking?.languageStyle ??
        ""
    ).trim() || "casual_local"
  );
}

function buildOwnerApprovedBookingCustomerEvent({ booking, canDmCustomer }) {
  return {
    eventType: "OWNER_APPROVED_BOOKING",
    itemName: String(booking?.itemName ?? "").trim() || null,
    durationDays:
      booking?.durationDays != null && Number.isFinite(Number(booking.durationDays))
        ? Math.max(1, Math.floor(Number(booking.durationDays)))
        : null,
    approvalStage: "owner_approved_waiting_customer_details",
    canDmCustomer: Boolean(canDmCustomer),
    privacyMode: canDmCustomer ? "dm" : "group_safe",
    requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
  };
}

function resolveOriginalCustomerPhone(booking) {
  const candidates = [
    booking?.originalCustomerPhone,
    booking?.dmTargetPhone,
    booking?.customerPhone,
  ];
  for (const candidate of candidates) {
    const raw = String(candidate ?? "").trim();
    if (isRoutableDmTarget(raw)) return raw;
  }
  return "";
}

function isPlaywrightGroupBooking(booking) {
  return (
    String(booking?.bookingSource ?? "").trim() === "PLAYWRIGHT_GROUP" ||
    (String(booking?.source ?? "").trim().toLowerCase() === "playwright" &&
      Boolean(
        String(booking?.sourceGroupName ?? booking?.groupName ?? "").trim() ||
          String(booking?.sourcePlaywrightChatKey ?? booking?.playwrightChatKey ?? "").trim()
      ))
  );
}

function buildSourceMessageForReplyPrivately(booking) {
  return {
    sourceRowKey:
      String(booking?.originalMessageRowKey ?? booking?.sourceRowKey ?? "").trim() ||
      null,
    sourceMessageId: String(booking?.sourceMessageId ?? "").trim() || null,
    sourceText:
      String(booking?.originalUserMessageText ?? booking?.sourceText ?? "").trim() ||
      null,
    sourceTimestamp:
      booking?.originalMessageTimestamp != null &&
      Number.isFinite(Number(booking.originalMessageTimestamp))
        ? Number(booking.originalMessageTimestamp)
        : booking?.sourceTimestamp != null && Number.isFinite(Number(booking.sourceTimestamp))
          ? Number(booking.sourceTimestamp)
          : null,
    sourceSenderScope:
      String(booking?.sourceSenderScope ?? booking?.senderScope ?? "").trim() || null,
    sourceParticipantName:
      String(
        booking?.originalCustomerDisplayName ??
          booking?.sourceParticipantName ??
          booking?.participantName ??
          ""
      ).trim() || null,
  };
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
 *   replyPrivately?: typeof replyPrivatelyToLatestUserMessage,
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
  replyPrivately = replyPrivatelyToLatestUserMessage,
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

        const customerPhone = resolveOriginalCustomerPhone(data);
        const canReplyPrivately =
          !customerPhone &&
          isPlaywrightGroupBooking(data) &&
          data?.playwrightReplyPrivateEligible === true &&
          playwrightReplyPrivatelyEnabled();
        const responseStyle = resolveApprovalResponseStyle(data);
        const customerContinuation = buildCustomerApprovalContinuation(
          buildOwnerApprovedBookingCustomerEvent({
            booking: data,
            canDmCustomer: Boolean(customerPhone || canReplyPrivately),
          }),
          responseStyle
        );

        if (customerPhone) {
          try {
            console.log("[approval_customer_notify_cloud_started]", {
              bookingId: bid,
              hasCustomerPhone: true,
            });
            const cloudResult = await sendMessage(customerPhone, customerContinuation, sendCredentials ?? undefined, {
              recipientType: "individual",
            });
            if (cloudResult?.ok === false) {
              throw new Error("CLOUD_DM_SEND_RETURNED_FALSE");
            }
            await bookingRef.update({
              approvalCustomerNotificationStatus: "sent",
              approvalCustomerNotificationSentAt: new Date(),
              approvalCustomerNotificationMethod: "cloud_dm",
              dmAttempted: true,
              dmOpened: true,
              dmMessageSent: true,
              updatedAt: new Date(),
            });
            console.log("[approval_customer_notify_cloud_sent]", { bookingId: bid });
          } catch (cloudErr) {
            await bookingRef.update({
              approvalCustomerNotificationStatus: "failed",
              approvalCustomerNotificationMethod: "cloud_dm",
              approvalCustomerNotificationError: String(cloudErr?.message ?? cloudErr ?? ""),
              updatedAt: new Date(),
            });
            console.warn("[approval_customer_notify_failed]", {
              bookingId: bid,
              method: "cloud_dm",
              reason: String(cloudErr?.message ?? cloudErr ?? ""),
            });
          }
        } else if (canReplyPrivately) {
          const groupName = String(data?.sourceGroupName ?? data?.groupName ?? "").trim();
          const playwrightChatKey = String(
            data?.sourcePlaywrightChatKey ?? data?.playwrightChatKey ?? data?.chatKey ?? ""
          ).trim();
          try {
            console.log("[approval_customer_notify_reply_private_started]", {
              bookingId: bid,
              groupName: groupName || null,
              playwrightChatKey: playwrightChatKey || null,
            });
            const privateResult = await replyPrivately({
              bookingId: bid,
              groupName: groupName || null,
              playwrightChatKey: playwrightChatKey || null,
              message: customerContinuation,
              sourceMessage: buildSourceMessageForReplyPrivately(data),
              disallowedChatTitles: [groupName, normalizePhone(ownerPhone)].filter(Boolean),
            });
            const patch = {
              dmAttempted: true,
              dmOpened: Boolean(privateResult?.dmOpened || privateResult?.ok),
              dmMessageSent: Boolean(
                privateResult?.ok && privateResult?.dmMessageSent !== false
              ),
              dmChatTitle: String(privateResult?.dmChatTitle ?? "").trim() || null,
              dmPlaywrightChatKey:
                String(privateResult?.dmPlaywrightChatKey ?? "").trim() || null,
              approvalCustomerNotificationMethod: "reply_privately",
              updatedAt: new Date(),
            };
            if (privateResult?.ok) {
              await bookingRef.update({
                ...patch,
                approvalCustomerNotificationStatus: "sent",
                approvalCustomerNotificationSentAt: new Date(),
                dmOpenMethod: "reply_privately",
              });
              console.log("[approval_customer_notify_reply_private_sent]", {
                bookingId: bid,
              });
            } else {
              await bookingRef.update({
                ...patch,
                approvalCustomerNotificationStatus: "failed",
                approvalCustomerNotificationError: String(
                  privateResult?.reason ?? "UNKNOWN"
                ),
              });
              console.warn("[approval_customer_notify_failed]", {
                bookingId: bid,
                method: "reply_privately",
                reason: String(privateResult?.reason ?? "UNKNOWN"),
              });
            }
          } catch (privateErr) {
            await bookingRef.update({
              approvalCustomerNotificationStatus: "failed",
              approvalCustomerNotificationMethod: "reply_privately",
              approvalCustomerNotificationError: String(
                privateErr?.message ?? privateErr ?? ""
              ),
              dmAttempted: true,
              dmOpened: false,
              dmMessageSent: false,
              updatedAt: new Date(),
            });
            console.warn("[approval_customer_notify_failed]", {
              bookingId: bid,
              method: "reply_privately",
              reason: String(privateErr?.message ?? privateErr ?? ""),
            });
          }
        } else {
          await bookingRef.update({
            approvalCustomerNotificationStatus: "skipped",
            approvalCustomerNotificationError: "MISSING_CUSTOMER_NOTIFICATION_TARGET",
            updatedAt: new Date(),
          });
          console.warn("[approval_customer_notify_missing_target]", {
            bookingId: bid,
            bookingSource: data?.bookingSource ?? null,
            hasOriginalCustomerPhone: false,
            playwrightReplyPrivateEligible:
              data?.playwrightReplyPrivateEligible === true,
            playwrightReplyPrivatelyEnabled: playwrightReplyPrivatelyEnabled(),
          });
        }
      }
    }

    console.log("✅ Booking status updated:", { bookingId: bid, newStatus });
    return { ok: true, status: newStatus };
  } catch (err) {
    console.error("❌ Booking approval failed:", err?.message || err);
    return { ok: false };
  }
}
