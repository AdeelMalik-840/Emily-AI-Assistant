import admin from "firebase-admin";

import db from "../config/firebase.js";
import { buildCustomerApprovalContinuation } from "./customerApprovalContinuation.js";
import { replyPrivatelyToLatestUserMessage } from "./playwrightReplyPrivatelyBridge.js";
import {
  releaseReplyPrivateLock,
  tryAcquireReplyPrivateLock,
} from "./replyPrivateUiController.js";

const FieldValue = admin.firestore.FieldValue;

let pollRunning = false;
const replyPrivateQueue = [];
const queuedBookingIds = new Set();
let queueRunning = false;

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
  const identity =
    booking?.sourceIdentity && typeof booking.sourceIdentity === "object"
      ? booking.sourceIdentity
      : {};
  return {
    sourceRowKey:
      clean(identity.sourceRowKey ?? booking?.originalMessageRowKey ?? booking?.sourceRowKey) || null,
    sourceMessageId: clean(identity.sourceMessageId ?? booking?.sourceMessageId) || null,
    sourceText:
      clean(booking?.originalUserMessageText ?? booking?.sourceText ?? identity.sourceTextPreview) || null,
    sourceTextPreview:
      clean(identity.sourceTextPreview ?? booking?.originalUserMessageText ?? booking?.sourceText).slice(0, 160) ||
      null,
    sourceTimestamp:
      identity.sourceTimestamp != null &&
      Number.isFinite(Number(identity.sourceTimestamp))
        ? Number(identity.sourceTimestamp)
        : booking?.originalMessageTimestamp != null &&
            Number.isFinite(Number(booking.originalMessageTimestamp))
          ? Number(booking.originalMessageTimestamp)
          : booking?.sourceTimestamp != null && Number.isFinite(Number(booking.sourceTimestamp))
            ? Number(booking.sourceTimestamp)
            : null,
    sourceMessageIndex:
      identity.sourceMessageIndex != null &&
      Number.isFinite(Number(identity.sourceMessageIndex))
        ? Number(identity.sourceMessageIndex)
        : booking?.originalMessageIndex != null &&
            Number.isFinite(Number(booking.originalMessageIndex))
          ? Number(booking.originalMessageIndex)
          : booking?.sourceMessageIndex != null &&
              Number.isFinite(Number(booking.sourceMessageIndex))
            ? Number(booking.sourceMessageIndex)
            : null,
    sourceSenderScope:
      clean(booking?.sourceSenderScope ?? booking?.senderScope) || null,
    sourceParticipantName:
      clean(
        identity.participantDisplayName ??
          identity.participantName ??
          booking?.originalCustomerDisplayName ??
          booking?.sourceParticipantName ??
          booking?.participantName
      ) || null,
    sourceParticipantDisplayName:
      clean(
        identity.participantDisplayName ??
          booking?.originalCustomerDisplayName ??
          booking?.sourceParticipantName ??
          booking?.participantName
      ) || null,
    participantDisplayName:
      clean(
        identity.participantDisplayName ??
          booking?.originalCustomerDisplayName ??
          booking?.sourceParticipantName ??
          booking?.participantName
      ) || null,
    sourceParticipantPhone:
      clean(identity.participantPhone ?? booking?.sourceParticipantPhone ?? booking?.originalCustomerPhone) || null,
    sourceParticipantKey:
      clean(
        identity.participantKey ??
          booking?.sourceParticipantKey ??
          booking?.originalCustomerPhone ??
          booking?.sourceParticipantPhone ??
          booking?.sourceSenderScope ??
          booking?.senderScope
      ) || null,
  };
}

function replyPrivateEligibilityFailure(booking) {
  if (clean(booking?.bookingSource) !== "PLAYWRIGHT_GROUP") {
    return "NOT_PLAYWRIGHT_GROUP";
  }
  const identity =
    booking?.sourceIdentity && typeof booking.sourceIdentity === "object"
      ? booking.sourceIdentity
      : null;
  if (!identity) {
    console.warn("[reply_privately_missing_source_identity]", {
      bookingId: clean(booking?.id) || null,
      reason: "MISSING_SOURCE_IDENTITY",
    });
    return "MISSING_SOURCE_IDENTITY";
  }
  const participantName = clean(
    identity.participantDisplayName ??
      identity.participantName ??
      booking?.originalCustomerDisplayName ??
      booking?.sourceParticipantName ??
      booking?.participantName
  );
  const participantKey = clean(
    identity.participantKey ??
      booking?.sourceParticipantKey ??
      booking?.originalCustomerPhone ??
      booking?.sourceParticipantPhone ??
      booking?.sourceSenderScope ??
      booking?.senderScope
  );
  if (!participantName && !participantKey) {
    console.warn("[reply_private_participant_identity_required]", {
      bookingId: clean(booking?.id) || null,
      reason: "SOURCE_PARTICIPANT_MISSING",
    });
    return "SOURCE_PARTICIPANT_MISSING";
  }
  const rowKey = clean(identity.sourceRowKey ?? booking?.originalMessageRowKey ?? booking?.sourceRowKey);
  const messageId = clean(identity.sourceMessageId ?? booking?.sourceMessageId ?? booking?.messageId);
  const index = identity.sourceMessageIndex ?? booking?.sourceMessageIndex ?? booking?.originalMessageIndex;
  const text = clean(identity.sourceTextPreview ?? booking?.originalUserMessageText ?? booking?.sourceText);
  if (!rowKey && !messageId && index == null && !text) {
    return "SOURCE_MESSAGE_ANCHOR_MISSING";
  }
  if (booking?.playwrightReplyPrivateEligible !== true) {
    return "REPLY_PRIVATE_NOT_ELIGIBLE";
  }
  return null;
}

function enqueueReplyPrivateJob(job) {
  const bookingId = clean(job?.bookingId);
  if (!bookingId) return false;
  if (queuedBookingIds.has(bookingId)) {
    console.log("[reply_private_queue_deduped]", { bookingId });
    return false;
  }
  queuedBookingIds.add(bookingId);
  replyPrivateQueue.push({
    ...job,
    status: "pending",
    retryCount: Number(job?.retryCount ?? 0),
    lockKey: `reply_private:${bookingId}`,
    approvalTimestamp: Date.now(),
  });
  console.log("[reply_private_queue_enqueued]", {
    bookingId,
    queueDepth: replyPrivateQueue.length,
  });
  return true;
}

async function drainReplyPrivateQueue(processor) {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (replyPrivateQueue.length > 0) {
      const job = replyPrivateQueue.shift();
      const bookingId = clean(job?.bookingId);
      queuedBookingIds.delete(bookingId);
      console.log("[reply_private_queue_started]", {
        bookingId,
        retryCount: job.retryCount,
        lockKey: job.lockKey,
      });
      try {
        await processor(job);
        console.log("[reply_private_queue_completed]", { bookingId });
      } catch (err) {
        console.warn("[reply_private_queue_failed]", {
          bookingId,
          reason: clean(err?.message ?? err) || "QUEUE_JOB_FAILED",
        });
      } finally {
        console.log("[reply_private_queue_lock_released]", { bookingId });
      }
    }
  } finally {
    queueRunning = false;
  }
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
  const collection = dbInstance
    .collection("businesses")
    .doc(ownerUserId)
    .collection("bookings");
  const pendingSnap = await collection
    .where("status", "==", "approved")
    .where("approvalCustomerNotificationStatus", "==", "pending")
    .where("bookingSource", "==", "PLAYWRIGHT_GROUP")
    .where("playwrightReplyPrivateEligible", "==", true)
    .limit(limit)
    .get();
  const processingSnap = await collection
    .where("status", "==", "approved")
    .where("approvalCustomerNotificationStatus", "==", "processing")
    .where("bookingSource", "==", "PLAYWRIGHT_GROUP")
    .where("playwrightReplyPrivateEligible", "==", true)
    .limit(limit)
    .get()
    .catch(() => ({ docs: [] }));

  const seen = new Set();
  const eligible = [...pendingSnap.docs, ...processingSnap.docs].map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  })).filter((booking) => {
    if (seen.has(booking.id)) return false;
    seen.add(booking.id);
    const status = clean(booking.data?.approvalCustomerNotificationStatus);
    if (status === "pending") return true;
    if (status !== "processing") return false;
    const startedMs = Number(
      booking.data?.approvalCustomerNotificationProcessingStartedAtMs ?? 0
    );
    return Number.isFinite(startedMs) && Date.now() - startedMs > 2 * 60 * 1000;
  }).slice(0, limit);

  // Diagnostic-only: if poller query returns 0, log why recent approved bookings are excluded.
  // Does NOT enqueue; does NOT modify any booking fields.
  if (eligible.length === 0) {
    try {
      const recentApprovedSnap = await collection
        .where("status", "==", "approved")
        .limit(10)
        .get()
        .catch(() => null);
      const recentDocs = recentApprovedSnap?.docs ?? [];
      for (const doc of recentDocs) {
        const data = doc.data() || {};
        const identity =
          data?.sourceIdentity && typeof data.sourceIdentity === "object"
            ? data.sourceIdentity
            : null;

        const approvalCustomerNotificationStatus = clean(
          data?.approvalCustomerNotificationStatus
        );
        const bookingSource = clean(data?.bookingSource);
        const playwrightReplyPrivateEligible = data?.playwrightReplyPrivateEligible === true;

        const participantName = clean(
          identity?.participantDisplayName ??
            identity?.participantName ??
            data?.originalCustomerDisplayName ??
            data?.sourceParticipantName ??
            data?.participantName
        );
        const participantKey = clean(
          identity?.participantKey ??
            data?.sourceParticipantKey ??
            data?.originalCustomerPhone ??
            data?.sourceParticipantPhone ??
            data?.sourceSenderScope ??
            data?.senderScope
        );

        const sourceRowKey = clean(
          identity?.sourceRowKey ?? data?.originalMessageRowKey ?? data?.sourceRowKey
        );
        const sourceMessageId = clean(
          identity?.sourceMessageId ?? data?.sourceMessageId ?? data?.messageId
        );
        const sourceMessageIndex =
          identity?.sourceMessageIndex ?? data?.sourceMessageIndex ?? data?.originalMessageIndex;

        const exclusionReasons = [];
        if (clean(data?.status) !== "approved") exclusionReasons.push("STATUS_NOT_APPROVED");

        // The poller only looks for pending, plus stale processing.
        if (approvalCustomerNotificationStatus !== "pending") {
          if (approvalCustomerNotificationStatus !== "processing") {
            exclusionReasons.push("APPROVAL_CUSTOMER_NOTIFICATION_NOT_PENDING");
          } else {
            const startedMs = Number(
              data?.approvalCustomerNotificationProcessingStartedAtMs ?? 0
            );
            if (!Number.isFinite(startedMs)) {
              exclusionReasons.push("PROCESSING_MISSING_STARTED_MS");
            } else if (Date.now() - startedMs <= 2 * 60 * 1000) {
              exclusionReasons.push("PROCESSING_NOT_STALE");
            }
          }
        }

        if (bookingSource !== "PLAYWRIGHT_GROUP") exclusionReasons.push("BOOKING_SOURCE_NOT_PLAYWRIGHT_GROUP");
        if (!playwrightReplyPrivateEligible) exclusionReasons.push("REPLY_PRIVATE_NOT_ELIGIBLE");

        if (!identity) exclusionReasons.push("MISSING_SOURCE_IDENTITY");
        if (!participantName && !participantKey) exclusionReasons.push("SOURCE_PARTICIPANT_MISSING");
        const hasAnyAnchor =
          Boolean(sourceRowKey) ||
          Boolean(sourceMessageId) ||
          (sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex)));
        if (!hasAnyAnchor) exclusionReasons.push("SOURCE_MESSAGE_ANCHOR_MISSING");

        console.log("[reply_private_poller_candidate_excluded]", {
          bookingId: doc.id,
          status: clean(data?.status) || null,
          approvalCustomerNotificationStatus: approvalCustomerNotificationStatus || null,
          bookingSource: bookingSource || null,
          playwrightReplyPrivateEligible,
          hasSourceIdentity: Boolean(identity),
          participantName: participantName || null,
          participantKey: participantKey || null,
          hasSourceRowKey: Boolean(sourceRowKey),
          hasSourceMessageId: Boolean(sourceMessageId),
          hasSourceMessageIndex:
            sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex)),
          exclusionReasons,
        });
      }
    } catch (err) {
      console.warn("[reply_private_poller_candidate_excluded]", {
        bookingId: null,
        status: null,
        approvalCustomerNotificationStatus: null,
        bookingSource: null,
        playwrightReplyPrivateEligible: null,
        hasSourceIdentity: null,
        participantName: null,
        participantKey: null,
        hasSourceRowKey: null,
        hasSourceMessageId: null,
        hasSourceMessageIndex: null,
        exclusionReasons: ["DEBUG_QUERY_FAILED", clean(err?.message ?? err).slice(0, 160)],
      });
    }
  }

  return eligible;
}

function claimDecision(data) {
  if (!data) return { ok: false, reason: "BOOKING_MISSING" };
  if (clean(data.status) !== "approved") {
    return { ok: false, reason: "BOOKING_NOT_APPROVED" };
  }
  const status = clean(data.approvalCustomerNotificationStatus);
  if (status === "sent") return { ok: false, reason: "ALREADY_SENT" };
  if (status === "processing") {
    const startedMs = Number(data.approvalCustomerNotificationProcessingStartedAtMs ?? 0);
    if (!Number.isFinite(startedMs) || Date.now() - startedMs <= 2 * 60 * 1000) {
      return { ok: false, reason: "PROCESSING_NOT_STALE" };
    }
  } else if (status !== "pending") {
    return { ok: false, reason: "NOT_PENDING" };
  }
  return { ok: true };
}

function processingPatch() {
  return {
    approvalCustomerNotificationStatus: "processing",
    approvalCustomerNotificationProcessingStartedAt: FieldValue.serverTimestamp(),
    approvalCustomerNotificationProcessingStartedAtMs: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function claimBookingForReplyPrivate(dbInstance, bookingRef, bookingId) {
  if (dbInstance && typeof dbInstance.runTransaction === "function") {
    return dbInstance.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      const data = snap.exists ? snap.data() || {} : null;
      const decision = claimDecision(data);
      if (!decision.ok) return decision;
      tx.update(bookingRef, processingPatch());
      console.log("[local_approval_reply_private_claimed]", { bookingId });
      return { ok: true, booking: data };
    });
  }

  const snap = await bookingRef.get();
  const data = snap.exists ? snap.data() || {} : null;
  const decision = claimDecision(data);
  if (!decision.ok) return decision;
  await bookingRef.update(processingPatch());
  console.log("[local_approval_reply_private_claimed]", { bookingId });
  return { ok: true, booking: data };
}

async function processPendingApproval({
  dbInstance,
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

  const eligibilityFailure = replyPrivateEligibilityFailure(booking);
  if (eligibilityFailure) {
    await bookingRef.update({
      approvalCustomerNotificationStatus: "failed",
      approvalCustomerNotificationMethod: "reply_privately",
      approvalCustomerNotificationError: eligibilityFailure,
      approvalCustomerNotificationFailedAt: FieldValue.serverTimestamp(),
      dmAttempted: false,
      dmOpened: false,
      dmMessageSent: false,
      updatedAt: FieldValue.serverTimestamp(),
    });
    console.warn("[local_approval_reply_private_failed]", {
      bookingId,
      reason: eligibilityFailure,
    });
    return;
  }

  const lockAcquired = tryAcquireReplyPrivateLock({ bookingId });
  if (!lockAcquired) return;
  try {
    const claim = await claimBookingForReplyPrivate(dbInstance, bookingRef, bookingId);
    if (!claim.ok) {
      console.log("[local_approval_reply_private_failed]", {
        bookingId,
        reason: claim.reason,
      });
      return;
    }
    const claimedBooking = claim.booking || booking;
    globalThis.__UI_HARD_LOCK = true;
    globalThis.__OUTBOUND_BUSY__ = true;
    const result = await replyPrivately({
      bookingId,
      groupName: groupName || null,
      playwrightChatKey: playwrightChatKey || null,
      message,
      sourceMessage: buildSourceMessageForReplyPrivately(claimedBooking),
      disallowedChatTitles: [groupName, ...ownerDisallowedChatTitles()].filter(Boolean),
      replyPrivateLockHeld: true,
    });

    if (!result?.ok) {
      const reason = clean(result?.reason) || "REPLY_PRIVATELY_FAILED";
      await bookingRef.update({
        approvalCustomerNotificationStatus: "failed",
        approvalCustomerNotificationMethod: "reply_privately",
        approvalCustomerNotificationError: reason,
        approvalCustomerNotificationFailedAt: FieldValue.serverTimestamp(),
        dmAttempted: true,
        dmOpened: result?.dmOpened === true,
        dmMessageSent: result?.dmMessageSent === true,
        ...(clean(result?.dmChatTitle)
          ? { dmChatTitle: clean(result.dmChatTitle) }
          : {}),
        ...(clean(result?.dmPlaywrightChatKey)
          ? { dmPlaywrightChatKey: clean(result.dmPlaywrightChatKey) }
          : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.warn("[local_approval_reply_private_failed]", {
        bookingId,
        reason,
      });
      return;
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
      approvalCustomerNotificationFailedAt: FieldValue.serverTimestamp(),
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
    console.log("[reply_private_job_finally_cleanup]", { bookingId });
    releaseReplyPrivateLock({ bookingId });
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
      enqueueReplyPrivateJob({
        dbInstance,
        bookingId: booking.id,
        bookingRef: booking.ref,
        booking: booking.data,
        replyPrivately,
      });
    }
    await drainReplyPrivateQueue((job) => processPendingApproval(job));
  } catch (err) {
    console.warn("[local_approval_reply_private_failed]", {
      bookingId: null,
      reason: clean(err?.message ?? err) || "POLL_FAILED",
    });
  } finally {
    pollRunning = false;
  }
}
