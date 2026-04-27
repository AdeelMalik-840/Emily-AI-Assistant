import { markItemUnavailableOnApproval } from "./inventoryService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import { sendPlaywrightGroupText } from "./playwrightOutboundBridge.js";

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
}) {
  try {
    const uid = String(userId ?? "").trim();
    const bid = String(bookingId ?? "").trim();
    if (!db || !uid || !bid) return { ok: false };
    if (action !== "approve" && action !== "reject") return { ok: false };

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
    let ownerPhone =
      data?.ownerNotificationPhone ??
      data?.businessProfile?.ownerNotificationPhone ??
      null;

    if (!ownerPhone) {
      try {
        const businessSnap = await db.collection("businesses").doc(uid).get();
        const businessData = businessSnap.exists ? businessSnap.data() || {} : {};
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
      return { ok: false };
    }

    const newStatus = action === "approve" ? "approved" : "rejected";
    const ownerApprovalFirst =
      bookingOwnerApprovalFirstEnabled() ||
      String(data?.approvalStage ?? "") === "pending_owner_approval";
    await bookingRef.update({
      status: newStatus,
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

    if (newStatus === "approved") {
      await markItemUnavailableOnApproval({
        db,
        userId: uid,
        bookingId: bid,
        itemId: String(data.itemId ?? "").trim(),
      });
    }

    let customerRouteNote = "";
    if (newStatus === "approved") {
      const dmTarget = String(data?.dmTargetPhone ?? data?.customerPhone ?? "").trim();
      const canDmCustomer =
        data?.canDmCustomer === true && isRoutableDmTarget(dmTarget);
      console.log("[approval_dm_route]", {
        bookingId: bid,
        canDmCustomer,
        dmTargetSource: String(data?.dmTargetSource ?? "").trim() || null,
        hasDmTarget: Boolean(dmTarget),
      });

      if (canDmCustomer) {
        const customerPrompt =
          "Request approve ho gayi hai. Booking details private DM mein continue karte hain. Please apna full name aur pickup location ya delivery preference share kar dein.";
        try {
          await sendWhatsAppMessage(dmTarget, customerPrompt, sendCredentials ?? undefined, {
            recipientType: "individual",
          });
          customerRouteNote = " Customer DM sent for private details.";
        } catch (customerDmErr) {
          console.warn(
            "⚠️ Approval customer DM failed:",
            customerDmErr?.message || customerDmErr
          );
          customerRouteNote = " Customer DM failed; please ask customer to DM privately.";
        }
      } else {
        const fallback =
          "Request approve ho gayi hai. Privacy ke liye booking details DM mein continue karte hain — please humein DM kar dein.";
        const groupName = String(data?.groupName ?? "").trim();
        console.log("[privacy_safe_fallback]", {
          bookingId: bid,
          groupName: groupName || null,
          reason: "CUSTOMER_DM_TARGET_MISSING",
          message: fallback,
        });
        if (groupName) {
          try {
            const groupSent = await sendPlaywrightGroupText(fallback, {
              expectedChat: groupName,
            });
            console.log("[privacy_safe_fallback]", {
              bookingId: bid,
              groupName,
              sent: Boolean(groupSent),
            });
            customerRouteNote = groupSent
              ? " Group fallback sent for private continuation."
              : ` ${fallback}`;
          } catch (fallbackErr) {
            console.warn(
              "⚠️ Privacy-safe group fallback failed:",
              fallbackErr?.message || fallbackErr
            );
            customerRouteNote = ` ${fallback}`;
          }
        } else {
          customerRouteNote = ` ${fallback}`;
        }
      }
    } else if (newStatus === "rejected" && ownerApprovalFirst) {
      const rejectText =
        "Sorry, yeh option confirm nahi ho saki. Kya aap koi aur option dekhna chahenge?";
      const dmTarget = String(data?.dmTargetPhone ?? data?.customerPhone ?? "").trim();
      const canDmCustomer =
        data?.canDmCustomer === true && isRoutableDmTarget(dmTarget);
      console.log("[approval_dm_route]", {
        bookingId: bid,
        canDmCustomer,
        dmTargetSource: String(data?.dmTargetSource ?? "").trim() || null,
        hasDmTarget: Boolean(dmTarget),
        action: "reject",
      });
      if (canDmCustomer) {
        try {
          await sendWhatsAppMessage(dmTarget, rejectText, sendCredentials ?? undefined, {
            recipientType: "individual",
          });
          customerRouteNote = " Customer DM sent with rejection update.";
        } catch (rejectDmErr) {
          console.warn(
            "⚠️ Rejection customer DM failed:",
            rejectDmErr?.message || rejectDmErr
          );
          customerRouteNote = " Customer rejection DM failed.";
        }
      } else {
        const groupName = String(data?.groupName ?? "").trim();
        console.log("[privacy_safe_fallback]", {
          bookingId: bid,
          groupName: groupName || null,
          reason: "CUSTOMER_DM_TARGET_MISSING_REJECTED",
          message: rejectText,
        });
        if (groupName) {
          try {
            const groupSent = await sendPlaywrightGroupText(rejectText, {
              expectedChat: groupName,
            });
            customerRouteNote = groupSent
              ? " Group fallback sent with rejection update."
              : ` ${rejectText}`;
          } catch (rejectFallbackErr) {
            console.warn(
              "⚠️ Rejection group fallback failed:",
              rejectFallbackErr?.message || rejectFallbackErr
            );
            customerRouteNote = ` ${rejectText}`;
          }
        } else {
          customerRouteNote = ` ${rejectText}`;
        }
      }
    }

    const feedbackMessage =
      newStatus === "approved"
        ? `Booking ${bid} approved successfully ✅${customerRouteNote}`
        : `Booking ${bid} rejected ❌${customerRouteNote}`;
    const feedbackTo = normalizePhone(senderPhone);
    if (feedbackTo) {
      try {
        await sendWhatsAppMessage(feedbackTo, feedbackMessage, sendCredentials ?? undefined, {
          recipientType: "individual",
        });
      } catch (feedbackErr) {
        console.warn(
          "⚠️ Booking approval feedback send failed:",
          feedbackErr?.message || feedbackErr
        );
      }
    }

    console.log("✅ Booking status updated:", { bookingId: bid, newStatus });
    return { ok: true, status: newStatus };
  } catch (err) {
    console.error("❌ Booking approval failed:", err?.message || err);
    return { ok: false };
  }
}
