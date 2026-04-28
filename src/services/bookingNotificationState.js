const BOOKING_NOTIFICATION_COLLECTION = "bookingNotificationState";

function safeString(value, max = 400) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function bookingRef(db, userId, bookingId) {
  const uid = safeString(userId);
  const bid = safeString(bookingId);
  if (!db || !uid || !bid) return null;
  return db.collection("businesses").doc(uid).collection("bookings").doc(bid);
}

function notificationStateRef(db, userId, bookingId) {
  const uid = safeString(userId);
  const bid = safeString(bookingId);
  if (!db || !uid || !bid) return null;
  return db
    .collection("businesses")
    .doc(uid)
    .collection(BOOKING_NOTIFICATION_COLLECTION)
    .doc(bid);
}

export async function updateBookingNotificationState({
  db,
  userId,
  bookingId,
  notificationStatus,
  notificationSent,
  providerMessageId,
  notificationError,
}) {
  const ref = bookingRef(db, userId, bookingId);
  const status = safeString(notificationStatus, 80);
  if (!ref || !status) return false;

  const update = {
    notificationStatus: status,
    notificationStatusUpdatedAt: new Date(),
  };
  if (typeof notificationSent === "boolean") {
    update.notificationSent = notificationSent;
  }
  const providerId = safeString(providerMessageId, 160);
  if (providerId) {
    update.providerMessageId = providerId;
  }
  if (notificationError != null) {
    update.notificationError = safeString(notificationError, 400);
  }

  try {
    await ref.update(update);
    console.log("[notification_state_updated]", {
      bookingId: safeString(bookingId),
      notificationStatus: status,
      notificationSent:
        typeof notificationSent === "boolean" ? notificationSent : undefined,
      hasProviderMessageId: Boolean(providerId),
      hasError: notificationError != null,
    });
    return true;
  } catch (err) {
    console.warn("[notification_state_update_failed]", {
      bookingId: safeString(bookingId),
      notificationStatus: status,
      error: err?.message || String(err),
    });
    return false;
  }
}

export async function markBookingNotificationQueued(db, userId, bookingId) {
  return updateBookingNotificationState({
    db,
    userId,
    bookingId,
    notificationStatus: "queued",
    notificationSent: false,
  });
}

export async function markBookingNotificationSending(db, userId, bookingId) {
  console.log("[notification_send_started]", {
    bookingId: safeString(bookingId),
  });
  return updateBookingNotificationState({
    db,
    userId,
    bookingId,
    notificationStatus: "sending",
    notificationSent: false,
  });
}

export async function markBookingNotificationProviderAccepted({
  db,
  userId,
  bookingId,
  providerMessageId,
}) {
  console.log("[notification_provider_accepted]", {
    bookingId: safeString(bookingId),
    hasProviderMessageId: Boolean(safeString(providerMessageId)),
  });
  await updateBookingNotificationState({
    db,
    userId,
    bookingId,
    notificationStatus: "sent_to_provider",
    notificationSent: false,
    providerMessageId,
  });
  const stateRef = notificationStateRef(db, userId, bookingId);
  if (!stateRef) return;
  try {
    await stateRef.set({
      bookingId: safeString(bookingId),
      notificationStatus: "sent_to_provider",
      notificationSent: false,
      providerMessageId: safeString(providerMessageId, 160) || null,
      sentToProviderAt: new Date(),
    });
  } catch (err) {
    console.warn("[notification_state_index_update_failed]", {
      bookingId: safeString(bookingId),
      error: err?.message || String(err),
    });
  }
}

export async function markBookingNotificationFailed({
  db,
  userId,
  bookingId,
  notificationError,
}) {
  console.log("[notification_delivery_failed]", {
    bookingId: safeString(bookingId),
    hasError: notificationError != null,
  });
  return updateBookingNotificationState({
    db,
    userId,
    bookingId,
    notificationStatus: "failed",
    notificationSent: false,
    notificationError,
  });
}

export async function markBookingNotificationDelivered({
  db,
  userId,
  bookingId,
}) {
  return updateBookingNotificationState({
    db,
    userId,
    bookingId,
    notificationStatus: "delivered",
    notificationSent: true,
  });
}

function normalizeWebhookStatus(status) {
  const s = safeString(status, 80).toLowerCase();
  if (s === "sent" || s === "delivered" || s === "read") return "delivered";
  if (s === "failed") return "failed";
  return "";
}

function extractWebhookError(statusEntry) {
  const errors = Array.isArray(statusEntry?.errors) ? statusEntry.errors : [];
  const first = errors[0];
  if (!first || typeof first !== "object") return "";
  return safeString(
    first.message ?? first.title ?? first.error_data?.details ?? first.code,
    400
  );
}

export async function handleWhatsAppNotificationStatuses({
  db,
  userId,
  statuses,
}) {
  const uid = safeString(userId);
  if (!db || !uid || !Array.isArray(statuses) || statuses.length === 0) {
    return { handled: 0 };
  }
  let handled = 0;
  for (const entry of statuses) {
    const providerMessageId = safeString(entry?.id, 160);
    const nextStatus = normalizeWebhookStatus(entry?.status);
    if (!providerMessageId || !nextStatus) continue;

    const snap = await db
      .collection("businesses")
      .doc(uid)
      .collection("bookings")
      .where("providerMessageId", "==", providerMessageId)
      .limit(5)
      .get();
    if (!snap || snap.empty) continue;

    for (const doc of snap.docs ?? []) {
      if (nextStatus === "failed") {
        await markBookingNotificationFailed({
          db,
          userId: uid,
          bookingId: doc.id,
          notificationError: extractWebhookError(entry) || "provider_status_failed",
        });
      } else {
        await markBookingNotificationDelivered({
          db,
          userId: uid,
          bookingId: doc.id,
        });
      }
      handled += 1;
    }
  }
  return { handled };
}
