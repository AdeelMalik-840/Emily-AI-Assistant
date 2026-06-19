import admin from "firebase-admin";
import { createHash } from "node:crypto";

import db from "../config/firebase.js";
import { buildCustomerApprovalContinuation } from "./customerApprovalContinuation.js";
import { replyPrivatelyToLatestUserMessage } from "./playwrightReplyPrivatelyBridge.js";
import {
  releaseReplyPrivateLock,
  tryAcquireReplyPrivateLock,
} from "./replyPrivateUiController.js";

const FieldValue = admin.firestore.FieldValue;
const REPLY_PRIVATE_NOTIFICATION_PURPOSE = "owner_approved_customer_handoff";
const OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT =
  "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT";

let pollRunning = false;
const replyPrivateQueue = [];
const queuedBookingIds = new Set();
let queueRunning = false;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function notificationKeyForBooking(bookingId) {
  const id = clean(bookingId);
  return id ? `${id}::${REPLY_PRIVATE_NOTIFICATION_PURPOSE}` : "";
}

function hashMessage(value) {
  const text = clean(value);
  if (!text) return "";
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

function sourceDiagnosticsPatch({ sourceMessage = {}, message = "" } = {}) {
  return {
    replyPrivateNotificationPurpose: REPLY_PRIVATE_NOTIFICATION_PURPOSE,
    ...(clean(sourceMessage?.sourceRowKey)
      ? { replyPrivateSourceRowKey: clean(sourceMessage.sourceRowKey) }
      : {}),
    ...(clean(sourceMessage?.sourceMessageId)
      ? { replyPrivateSourceMessageId: clean(sourceMessage.sourceMessageId) }
      : {}),
    ...(clean(message) ? { replyPrivateMessageHash: hashMessage(message) } : {}),
  };
}

function logReplyPrivateState(event, data = {}) {
  console.log(event, {
    bookingId: clean(data.bookingId) || null,
    notificationPurpose:
      clean(data.notificationPurpose) || REPLY_PRIVATE_NOTIFICATION_PURPOSE,
    notificationKey: clean(data.notificationKey) || null,
    approvalCustomerNotificationStatus:
      clean(data.approvalCustomerNotificationStatus) || null,
    dmSendAttempted: data.dmSendAttempted === true,
    verificationPassed: data.verificationPassed === true,
    retryable: data.retryable === true,
    reason: clean(data.reason) || null,
  });
}

function buildCustomerNotificationPatchFromReplyPrivateResult(result, base = {}) {
  const r = result && typeof result === "object" ? result : {};
  const ok = r.ok === true && r.verificationPassed === true;
  const dmOpened = r.dmOpened === true;
  const dmMessageSentRaw = r.dmMessageSent === true;
  const sendActionAttempted = r.sendActionAttempted === true;
  const unverifiedAfterAttempt = sendActionAttempted && !ok;
  const retryable = unverifiedAfterAttempt ? false : r.retryable !== false;
  const errorCode = unverifiedAfterAttempt
    ? OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT
    : clean(r.errorCode ?? r.failureStage ?? r.reason ?? "") || "REPLY_PRIVATE_FAILED";

  /** Invariant: never persist failed + dmMessageSent true. */
  const dmMessageSent = ok ? true : false;
  if (!ok && dmMessageSentRaw) {
    console.warn("[illegal_customer_notification_state_prevented]", {
      reason: "FAILED_WITH_DM_MESSAGE_SENT_TRUE",
      errorCode,
      dmOpened,
      dmMessageSentRaw,
    });
  }

  const patch = {
    ...base,
    approvalCustomerNotificationMethod: "reply_privately",
    dmAttempted: true,
    dmOpened,
    dmMessageSent,
    dmSendAttempted: sendActionAttempted,
    dmSendVerificationPassed: ok,
    approvalCustomerNotificationError: ok ? null : errorCode,
    approvalCustomerNotificationRetryable: ok ? false : retryable,
    approvalCustomerNotificationTerminalFailure: ok ? false : !retryable,
    ...(clean(r.dmChatTitle) ? { dmChatTitle: clean(r.dmChatTitle) } : {}),
    ...(clean(r.dmPlaywrightChatKey) ? { dmPlaywrightChatKey: clean(r.dmPlaywrightChatKey) } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (ok) {
    patch.approvalCustomerNotificationStatus = "sent";
    patch.approvalCustomerNotificationSentAt = FieldValue.serverTimestamp();
  } else {
    patch.approvalCustomerNotificationStatus = "failed";
    patch.approvalCustomerNotificationFailedAt = FieldValue.serverTimestamp();
    patch.approvalCustomerNotificationFailedAtMs = Date.now();
    if (unverifiedAfterAttempt) {
      patch.requiresManualReview = true;
      patch.approvalCustomerNotificationNextRetryAtMs = null;
      Object.assign(
        patch,
        terminalFailurePatch({
          errorCode: OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT,
        })
      );
    }
  }

  console.log("[customer_notification_patch_built]", {
    ok,
    verificationPassed: r.verificationPassed === true,
    dmOpened,
    dmMessageSent,
    dmSendAttempted: sendActionAttempted,
    errorCode: ok ? null : errorCode,
    retryable: ok ? false : retryable,
  });
  console.log("[CUSTOMER_NOTIFICATION_STATE]", {
    bookingId: clean(base?.bookingId) || null,
    approvalCustomerNotificationStatus: patch.approvalCustomerNotificationStatus,
    dmOpened: patch.dmOpened === true,
    dmMessageSent: patch.dmMessageSent === true,
    dmSendAttempted: patch.dmSendAttempted === true,
    verificationPassed: r.verificationPassed === true,
    errorCode: patch.approvalCustomerNotificationError || null,
    retryable: patch.approvalCustomerNotificationRetryable !== false,
    terminalFailure: patch.approvalCustomerNotificationTerminalFailure === true,
  });
  return patch;
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
    durationHours:
      booking?.durationHours != null && Number.isFinite(Number(booking.durationHours))
        ? Math.max(1, Math.floor(Number(booking.durationHours)))
        : null,
    billingUnit:
      booking?.billingUnit != null && String(booking.billingUnit).trim() !== ""
        ? String(booking.billingUnit).trim()
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

function isRetryableReplyPrivateErrorCode(errorCode) {
  const code = clean(errorCode);
  // Minimal, fail-closed: identity/anchor/target issues are permanent.
  // Everything else we treat as retryable (NO_ACTIVE_PAGE, UI timing issues, locks, etc).
  return ![
    "MISSING_SOURCE_IDENTITY",
    "SOURCE_PARTICIPANT_MISSING",
    "SOURCE_MESSAGE_ANCHOR_MISSING",
    "INVALID_DM_TARGET",
    "REPLY_PRIVATE_DM_TARGET_MISMATCH",
    "REPLY_PRIVATE_WRONG_HEADER",
    "REPLY_PRIVATE_NOT_ELIGIBLE",
    "NOT_PLAYWRIGHT_GROUP",
    OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT,
  ].includes(code);
}

function terminalFailurePatch({ errorCode, exhausted } = {}) {
  const nowMs = Date.now();
  const patch = {
    approvalCustomerNotificationTerminalFailure: true,
    approvalCustomerNotificationNextRetryAtMs: null,
  };
  if (clean(errorCode)) {
    patch.approvalCustomerNotificationError = clean(errorCode);
  }
  if (exhausted) {
    patch.approvalCustomerNotificationRetryExhaustedAt = FieldValue.serverTimestamp();
    patch.approvalCustomerNotificationRetryExhaustedAtMs = nowMs;
  } else {
    patch.approvalCustomerNotificationTerminalFailureAt = FieldValue.serverTimestamp();
    patch.approvalCustomerNotificationTerminalFailureAtMs = nowMs;
  }
  return patch;
}

function resolveRetryCount(data) {
  const n = Number(data?.approvalCustomerNotificationRetryCount ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function retryBackoffMs(attemptNumber) {
  const n = Number(attemptNumber ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n === 1) return 5 * 1000;
  if (n === 2) return 30 * 1000;
  if (n === 3) return 2 * 60 * 1000;
  return null;
}

function resolveNextRetryAtMs(data) {
  const explicit = Number(data?.approvalCustomerNotificationNextRetryAtMs ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const failedAtMs = Number(data?.approvalCustomerNotificationFailedAtMs ?? NaN);
  if (!Number.isFinite(failedAtMs) || failedAtMs <= 0) return null;
  const retryCount = resolveRetryCount(data);
  const nextAttempt = retryCount + 1;
  const backoffMs = retryBackoffMs(nextAttempt);
  if (!backoffMs) return null;
  return failedAtMs + backoffMs;
}

function failedRetryDecision(data) {
  if (!data) return { ok: false, reason: "BOOKING_MISSING" };
  if (clean(data.status) !== "approved") return { ok: false, reason: "BOOKING_NOT_APPROVED" };
  if (data?.playwrightReplyPrivateEligible !== true) return { ok: false, reason: "REPLY_PRIVATE_NOT_ELIGIBLE" };
  if (data?.approvalCustomerNotificationTerminalFailure === true) {
    return { ok: false, reason: "TERMINAL_FAILURE" };
  }
  if (data?.approvalCustomerNotificationRetryable === false) {
    return { ok: false, reason: "TERMINAL_FAILURE" };
  }
  // If the failure reason is a permanent one, do not retry.
  const lastErrorCode = clean(data?.approvalCustomerNotificationError);
  if (lastErrorCode && !isRetryableReplyPrivateErrorCode(lastErrorCode)) {
    return { ok: false, reason: "TERMINAL_FAILURE" };
  }
  const retryCount = resolveRetryCount(data);
  if (retryCount >= 3) return { ok: false, reason: "RETRY_EXHAUSTED" };

  const nextRetryAtMs = resolveNextRetryAtMs(data);
  if (nextRetryAtMs != null && Number.isFinite(nextRetryAtMs) && Date.now() < nextRetryAtMs) {
    console.log("[reply_private_retry_decision]", {
      decision: "retry_later",
      reason: "FAILED_BACKOFF_NOT_ELAPSED",
      nextRetryAtMs,
      retryCount,
      dmOpened: data?.dmOpened === true,
      dmMessageSent: data?.dmMessageSent === true,
      approvalCustomerNotificationStatus: clean(data?.approvalCustomerNotificationStatus) || null,
      approvalCustomerNotificationError: clean(data?.approvalCustomerNotificationError) || null,
    });
    return { ok: false, reason: "FAILED_BACKOFF_NOT_ELAPSED", nextRetryAtMs };
  }
  console.log("[reply_private_retry_decision]", {
    decision: "retry_now",
    reason: "FAILED_READY",
    nextRetryAtMs,
    retryCount,
    dmOpened: data?.dmOpened === true,
    dmMessageSent: data?.dmMessageSent === true,
    approvalCustomerNotificationStatus: clean(data?.approvalCustomerNotificationStatus) || null,
    approvalCustomerNotificationError: clean(data?.approvalCustomerNotificationError) || null,
  });
  return { ok: true, retryCount };
}

function extractFirestoreIndexUrl(error) {
  const text = String(error?.message || error?.details || error || "");
  const match = text.match(/https:\/\/console\.firebase\.google\.com\/[^\s)]+/);
  return match ? match[0] : null;
}

function replyPrivatePollerFilters(statusFilter) {
  return {
    status: "approved",
    approvalCustomerNotificationStatus: statusFilter,
    bookingSource: "PLAYWRIGHT_GROUP",
    playwrightReplyPrivateEligible: true,
  };
}

async function runReplyPrivatePollerQuery(collection, statusFilter, limit) {
  const filters = replyPrivatePollerFilters(statusFilter);
  console.log("[reply_private_poller_query_started]", {
    statusFilter,
    filters,
  });
  try {
    const snap = await collection
      .where("status", "==", filters.status)
      .where(
        "approvalCustomerNotificationStatus",
        "==",
        filters.approvalCustomerNotificationStatus
      )
      .where("bookingSource", "==", filters.bookingSource)
      .where("playwrightReplyPrivateEligible", "==", filters.playwrightReplyPrivateEligible)
      .limit(limit)
      .get();
    const docs = snap?.docs ?? [];
    console.log("[reply_private_poller_query_result]", {
      statusFilter,
      count: docs.length,
      bookingIds: docs.map((doc) => doc.id),
    });
    return snap;
  } catch (error) {
    console.warn("[reply_private_poller_query_failed]", {
      statusFilter,
      code: error?.code || null,
      message: error?.message || String(error),
      details: error?.details || null,
      indexUrlIfPresent: extractFirestoreIndexUrl(error),
    });
    return { docs: [] };
  }
}

async function fetchPendingPlaywrightApprovals(dbInstance, ownerUserId, limit = 5) {
  const collection = dbInstance
    .collection("businesses")
    .doc(ownerUserId)
    .collection("bookings");
  const pendingSnap = await runReplyPrivatePollerQuery(collection, "pending", limit);
  const processingSnap = await runReplyPrivatePollerQuery(collection, "processing", limit);
  const failedSnap = await runReplyPrivatePollerQuery(collection, "failed", limit);

  const seen = new Set();
  const pendingDocs = pendingSnap.docs ?? [];
  const processingDocs = processingSnap.docs ?? [];
  const failedDocs = failedSnap.docs ?? [];
  const eligible = [...pendingDocs, ...processingDocs].map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  })).filter((booking) => {
    if (seen.has(booking.id)) return false;
    const status = clean(booking.data?.approvalCustomerNotificationStatus);
    if (status === "pending") {
      seen.add(booking.id);
      return true;
    }
    if (status !== "processing") return false;
    const startedMs = Number(
      booking.data?.approvalCustomerNotificationProcessingStartedAtMs ?? 0
    );
    const stale = Number.isFinite(startedMs) && Date.now() - startedMs > 2 * 60 * 1000;
    if (stale) seen.add(booking.id);
    return stale;
  });

  const processingEligibleCount = eligible.filter(
    (booking) => clean(booking.data?.approvalCustomerNotificationStatus) === "processing"
  ).length;
  const failedEligible = [...failedDocs].map((doc) => ({
    id: doc.id,
    ref: doc.ref,
    data: doc.data() || {},
  })).filter((booking) => {
    if (seen.has(booking.id)) return false;
    seen.add(booking.id);
    const d = booking.data || {};
    const decision = failedRetryDecision(d);
    if (!decision.ok) {
      if (decision.reason === "FAILED_BACKOFF_NOT_ELAPSED") {
        console.log("[reply_private_failed_retry_skipped_backoff]", {
          bookingId: booking.id,
          nextRetryAtMs: decision.nextRetryAtMs ?? null,
          retryCount: resolveRetryCount(d),
        });
      } else if (decision.reason === "RETRY_EXHAUSTED") {
        console.log("[reply_private_failed_retry_exhausted]", {
          bookingId: booking.id,
          retryCount: resolveRetryCount(d),
        });
      }
      return false;
    }
    console.log("[reply_private_failed_retry_candidate]", {
      bookingId: booking.id,
      retryCount: resolveRetryCount(d),
      nextRetryAtMs: resolveNextRetryAtMs(d),
    });
    return true;
  });

  // If a failed booking has exhausted retries, mark it terminal so we don't
  // keep scanning it forever.
  try {
    const exhausted = [...failedDocs].map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data() || {},
    })).filter((booking) => {
      const d = booking.data || {};
      const retryCount = resolveRetryCount(d);
      const lastErrorCode = clean(d?.approvalCustomerNotificationError);
      const nonRetryable = lastErrorCode && !isRetryableReplyPrivateErrorCode(lastErrorCode);
      return (
        clean(d?.approvalCustomerNotificationStatus) === "failed" &&
        (retryCount >= 3 || nonRetryable) &&
        d?.approvalCustomerNotificationTerminalFailure !== true
      );
    });
    if (exhausted.length > 0) {
      await Promise.all(
        exhausted.map((b) =>
          b.ref
            .update({
              ...terminalFailurePatch({
                errorCode: clean(b?.data?.approvalCustomerNotificationError) || null,
                exhausted: true,
              }),
            })
            .catch(() => undefined)
        )
      );
    }
  } catch (err) {
    console.warn("[reply_private_failed_retry_exhausted]", {
      bookingId: null,
      retryCount: null,
      reason: clean(err?.message ?? err) || "EXHAUSTED_MARK_FAILED",
    });
  }

  const combined = [...eligible, ...failedEligible].slice(0, limit);
  console.log("[reply_private_poller_combined_count]", {
    pendingCount: pendingDocs.length,
    processingRawCount: processingDocs.length,
    processingEligibleCount,
    failedRawCount: failedDocs.length,
    failedEligibleCount: failedEligible.length,
    combinedCount: combined.length,
  });

  // Diagnostic-only: if poller query returns 0, log why recent approved bookings are excluded.
  // Does NOT enqueue; does NOT modify any booking fields.
  if (combined.length === 0) {
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
            // Failed is retryable with backoff + max retries.
            if (approvalCustomerNotificationStatus !== "failed") {
              exclusionReasons.push("APPROVAL_CUSTOMER_NOTIFICATION_NOT_PENDING");
            } else {
              const decision = failedRetryDecision(data);
              if (!decision.ok) exclusionReasons.push(`FAILED_NOT_RETRYABLE:${decision.reason}`);
            }
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
        if (exclusionReasons.length === 0) {
          console.log("[reply_private_poller_query_missed_eligible_candidate]", {
            bookingId: doc.id,
            status: clean(data?.status) || null,
            approvalCustomerNotificationStatus: approvalCustomerNotificationStatus || null,
            bookingSource: bookingSource || null,
            playwrightReplyPrivateEligible,
            hasSourceIdentity: Boolean(identity),
            hasSourceRowKey: Boolean(sourceRowKey),
            hasSourceMessageId: Boolean(sourceMessageId),
            hasSourceMessageIndex:
              sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex)),
            likelyCause: "query_or_index_mismatch",
          });
        }
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

  return combined;
}

function claimDecision(data) {
  if (!data) return { ok: false, reason: "BOOKING_MISSING" };
  if (clean(data.status) !== "approved") {
    return { ok: false, reason: "BOOKING_NOT_APPROVED" };
  }
  const status = clean(data.approvalCustomerNotificationStatus);
  if (status === "sent") return { ok: false, reason: "ALREADY_SENT" };
  if (data?.dmMessageSent === true) {
    return { ok: false, reason: "ALREADY_DM_MESSAGE_SENT" };
  }
  if (
    data?.approvalCustomerNotificationTerminalFailure === true &&
    data?.dmSendAttempted === true
  ) {
    return { ok: false, reason: "ALREADY_SEND_ATTEMPTED_TERMINAL" };
  }
  if (
    clean(data?.replyPrivateCustomerNotificationKey) &&
    data?.dmSendAttempted === true &&
    data?.requiresManualReview === true
  ) {
    return { ok: false, reason: "ALREADY_SEND_ATTEMPTED_MANUAL_REVIEW" };
  }
  if (status === "failed") {
    const decision = failedRetryDecision(data);
    if (!decision.ok) return { ok: false, reason: decision.reason };
    return { ok: true, failedRetry: true, retryCount: decision.retryCount ?? resolveRetryCount(data) };
  }
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

function processingPatch({ failedRetry } = {}) {
  const patch = {
    approvalCustomerNotificationStatus: "processing",
    approvalCustomerNotificationProcessingStartedAt: FieldValue.serverTimestamp(),
    approvalCustomerNotificationProcessingStartedAtMs: Date.now(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (failedRetry) {
    patch.approvalCustomerNotificationRetryCount = FieldValue.increment(1);
    patch.approvalCustomerNotificationNextRetryAtMs = null;
    patch.approvalCustomerNotificationTerminalFailure = false;
  }
  return {
    ...patch,
  };
}

async function claimBookingForReplyPrivate(dbInstance, bookingRef, bookingId) {
  if (dbInstance && typeof dbInstance.runTransaction === "function") {
    return dbInstance.runTransaction(async (tx) => {
      const snap = await tx.get(bookingRef);
      const data = snap.exists ? snap.data() || {} : null;
      const decision = claimDecision(data);
      if (!decision.ok) return decision;
      tx.update(bookingRef, processingPatch({ failedRetry: decision.failedRetry === true }));
      if (decision.failedRetry === true) {
        console.log("[reply_private_failed_retry_claimed]", {
          bookingId,
          retryCount: resolveRetryCount(data) + 1,
        });
      }
      console.log("[local_approval_reply_private_claimed]", { bookingId });
      return { ok: true, booking: data };
    });
  }

  const snap = await bookingRef.get();
  const data = snap.exists ? snap.data() || {} : null;
  const decision = claimDecision(data);
  if (!decision.ok) return decision;
  await bookingRef.update(processingPatch({ failedRetry: decision.failedRetry === true }));
  if (decision.failedRetry === true) {
    console.log("[reply_private_failed_retry_claimed]", {
      bookingId,
      retryCount: resolveRetryCount(data) + 1,
    });
  }
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
  const notificationKey = notificationKeyForBooking(bookingId);

  console.log("[local_approval_reply_private_started]", {
    bookingId,
    groupName: groupName || null,
    playwrightChatKey: playwrightChatKey || null,
  });

  const eligibilityFailure = replyPrivateEligibilityFailure(booking);
  if (eligibilityFailure) {
    const retryable = isRetryableReplyPrivateErrorCode(eligibilityFailure);
    const patch = buildCustomerNotificationPatchFromReplyPrivateResult(
      {
        ok: false,
        dmOpened: false,
        dmMessageSent: false,
        verificationPassed: false,
        failureStage: "eligibility",
        errorCode: eligibilityFailure,
        retryable,
      },
      {
        bookingId,
        dmAttempted: false,
        ...(retryable ? {} : terminalFailurePatch({ errorCode: eligibilityFailure })),
      }
    );
    console.log("[reply_private_state_transition]", {
      bookingId,
      from: clean(booking?.approvalCustomerNotificationStatus) || null,
      to: patch.approvalCustomerNotificationStatus,
      errorCode: patch.approvalCustomerNotificationError || null,
    });
    await bookingRef.update(patch);
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
      const alreadySent =
        claim.reason === "ALREADY_SENT" || claim.reason === "ALREADY_DM_MESSAGE_SENT";
      const alreadyAttempted =
        claim.reason === "ALREADY_SEND_ATTEMPTED_TERMINAL" ||
        claim.reason === "ALREADY_SEND_ATTEMPTED_MANUAL_REVIEW";
      logReplyPrivateState(
        alreadySent
          ? "[reply_private_send_skipped_already_sent]"
          : alreadyAttempted
            ? "[reply_private_send_skipped_already_attempted]"
            : "[reply_private_idempotency_check]",
        {
          bookingId,
          notificationKey,
          approvalCustomerNotificationStatus:
            clean(booking?.approvalCustomerNotificationStatus) || null,
          dmSendAttempted: booking?.dmSendAttempted === true,
          verificationPassed: booking?.dmSendVerificationPassed === true,
          retryable: false,
          reason: claim.reason,
        }
      );
      console.log("[local_approval_reply_private_failed]", {
        bookingId,
        reason: claim.reason,
      });
      return;
    }
    const claimedBooking = claim.booking || booking;
    const sourceMessage = buildSourceMessageForReplyPrivately(claimedBooking);
    const idempotencyPatch = {
      replyPrivateCustomerNotificationKey: notificationKey,
      ...sourceDiagnosticsPatch({ sourceMessage, message }),
      updatedAt: FieldValue.serverTimestamp(),
    };
    console.log("[reply_private_idempotency_check]", {
      bookingId,
      notificationPurpose: REPLY_PRIVATE_NOTIFICATION_PURPOSE,
      notificationKey,
      approvalCustomerNotificationStatus:
        clean(claimedBooking?.approvalCustomerNotificationStatus) || null,
      dmSendAttempted: claimedBooking?.dmSendAttempted === true,
      verificationPassed: claimedBooking?.dmSendVerificationPassed === true,
      retryable: true,
      reason: "CLAIMED_BEFORE_SEND",
    });
    await bookingRef.update(idempotencyPatch);
    globalThis.__UI_HARD_LOCK = true;
    globalThis.__OUTBOUND_BUSY__ = true;
    const result = await replyPrivately({
      bookingId,
      groupName: groupName || null,
      playwrightChatKey: playwrightChatKey || null,
      message,
      sourceMessage,
      disallowedChatTitles: [groupName, ...ownerDisallowedChatTitles()].filter(Boolean),
      replyPrivateLockHeld: true,
    });

    if (!result?.ok) {
      const sendActionAttempted = result?.sendActionAttempted === true;
      const reason = sendActionAttempted
        ? OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT
        : clean(result?.errorCode ?? result?.failureStage ?? result?.reason) ||
          "REPLY_PRIVATELY_FAILED";
      const nowMs = Date.now();
      const retryCount = resolveRetryCount(booking) + 1;
      const retryable =
        result?.retryable === false ? false : isRetryableReplyPrivateErrorCode(reason);
      const nextRetryAtMs = (() => {
        const backoffMs = retryBackoffMs(retryCount + 1);
        return backoffMs ? nowMs + backoffMs : null;
      })();
      const patch = buildCustomerNotificationPatchFromReplyPrivateResult(result, {
        bookingId,
        replyPrivateCustomerNotificationKey: notificationKey,
        ...sourceDiagnosticsPatch({ sourceMessage, message }),
        approvalCustomerNotificationFailedAtMs: nowMs,
        approvalCustomerNotificationNextRetryAtMs: retryable ? nextRetryAtMs : null,
        ...(retryable ? {} : terminalFailurePatch({ errorCode: reason })),
      });
      patch.approvalCustomerNotificationError = reason;
      patch.approvalCustomerNotificationRetryable = retryable;
      patch.approvalCustomerNotificationTerminalFailure = !retryable;
      if (sendActionAttempted && result?.verificationPassed !== true) {
        patch.requiresManualReview = true;
        patch.dmSendAttempted = true;
        patch.dmSendVerificationPassed = false;
        patch.approvalCustomerNotificationNextRetryAtMs = null;
        logReplyPrivateState("[reply_private_unverified_terminal_failure]", {
          bookingId,
          notificationKey,
          approvalCustomerNotificationStatus: patch.approvalCustomerNotificationStatus,
          dmSendAttempted: true,
          verificationPassed: false,
          retryable: false,
          reason,
        });
      } else if (retryable) {
        logReplyPrivateState("[reply_private_retry_allowed_before_send_action]", {
          bookingId,
          notificationKey,
          approvalCustomerNotificationStatus: patch.approvalCustomerNotificationStatus,
          dmSendAttempted: false,
          verificationPassed: false,
          retryable: true,
          reason,
        });
      }
      console.log("[reply_private_state_transition]", {
        bookingId,
        from: clean(booking?.approvalCustomerNotificationStatus) || null,
        to: patch.approvalCustomerNotificationStatus,
        errorCode: patch.approvalCustomerNotificationError || null,
        retryable,
        nextRetryAtMs: patch.approvalCustomerNotificationNextRetryAtMs ?? null,
      });
      await bookingRef.update(patch);
      console.warn("[local_approval_reply_private_failed]", {
        bookingId,
        reason,
      });
      return;
    }

    const patch = buildCustomerNotificationPatchFromReplyPrivateResult(result, {
      bookingId,
      dmOpenMethod: "reply_privately",
      replyPrivateCustomerNotificationKey: notificationKey,
      ...sourceDiagnosticsPatch({ sourceMessage, message }),
    });
    logReplyPrivateState("[reply_private_sent_verified]", {
      bookingId,
      notificationKey,
      approvalCustomerNotificationStatus: patch.approvalCustomerNotificationStatus,
      dmSendAttempted: true,
      verificationPassed: true,
      retryable: false,
      reason: "VERIFICATION_PASSED",
    });
    console.log("[reply_private_state_transition]", {
      bookingId,
      from: clean(booking?.approvalCustomerNotificationStatus) || null,
      to: patch.approvalCustomerNotificationStatus,
      errorCode: null,
    });
    await bookingRef.update(patch);
    console.log("[local_approval_reply_private_sent]", { bookingId });
  } catch (err) {
    const reason = clean(err?.message ?? err) || "UNKNOWN";
    const nowMs = Date.now();
    const retryCount = resolveRetryCount(booking) + 1;
    const retryable = isRetryableReplyPrivateErrorCode(reason);
    const nextRetryAtMs = (() => {
      const backoffMs = retryBackoffMs(retryCount + 1);
      return backoffMs ? nowMs + backoffMs : null;
    })();
    const patch = buildCustomerNotificationPatchFromReplyPrivateResult(
      {
        ok: false,
        dmOpened: false,
        dmMessageSent: false,
        verificationPassed: false,
        failureStage: "exception",
        errorCode: reason,
        retryable,
      },
      {
        bookingId,
        approvalCustomerNotificationFailedAtMs: nowMs,
        approvalCustomerNotificationNextRetryAtMs: retryable ? nextRetryAtMs : null,
        ...(retryable ? {} : terminalFailurePatch({ errorCode: reason })),
      }
    );
    console.log("[reply_private_state_transition]", {
      bookingId,
      from: clean(booking?.approvalCustomerNotificationStatus) || null,
      to: patch.approvalCustomerNotificationStatus,
      errorCode: patch.approvalCustomerNotificationError || null,
      retryable,
      nextRetryAtMs: patch.approvalCustomerNotificationNextRetryAtMs ?? null,
    });
    await bookingRef.update(patch);
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
