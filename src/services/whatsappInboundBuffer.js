/**
 * Debounced merge of rapid consecutive WhatsApp text messages per customer thread,
 * then a single processMessage + outbound send (human-like handling of fragments).
 */

import { createHash } from "node:crypto";
import { processMessage } from "./messageProcessor.js";
import {
  appendConversationMessage,
  getRecentConversationForPrompt,
} from "./conversationStore.js";
import {
  sendWhatsAppInteractiveButtons,
  sendWhatsAppMessage,
} from "./whatsappCloud.js";
import { sendOutboundMessage } from "./messagingService.js";
import {
  handleBookingApproval,
  parseApprovalMessage,
} from "./bookingApprovalService.js";
import {
  identityContextFromPreview,
  normalizeTitle,
} from "./playwrightTitleNormalize.js";
import { evaluateWhatsAppGroupInboundGate } from "./whatsappGroupInboundGate.js";
import {
  INBOUND_SOURCE_REAL_CUSTOMER,
  resolveInboundSourceOrigin,
  validateOutboundReplyBinding,
  logOutboundReplyBoundToTurn,
} from "./inboundOriginGuard.js";
import {
  buildPlaywrightGuaranteeKey,
  markPlaywrightGroupGateBlockedProcessed,
  notifyPlaywrightGuaranteeDelivered,
  notifyPlaywrightGuaranteeReleased,
} from "./playwrightGuaranteeBridge.js";
import {
  markInboundTurnLedgerDoneForGuarantee,
  markInboundTurnLedgerFailedForGuarantee,
} from "./inboundTurnLedger.js";
import { setMessageState } from "./messageState.js";
import {
  normalizePlaywrightOutboundTrace,
  savePlaywrightInboundCursor,
} from "./playwrightInboundCursorStore.js";
import { getEmilySessionState } from "./conversationIntelligence.js";
import { randomUUID } from "node:crypto";
import { logBookingEvent } from "../utils/bookingLogger.js";
import {
  buildOutboundLifecycleBase,
  logOutboundLifecycle,
} from "./outboundLifecycleLog.js";
import { normalizeInboundMessage } from "./inboundNormalizer.js";
import {
  markBookingNotificationFailed,
  markBookingNotificationProviderAccepted,
  markBookingNotificationQueued,
  markBookingNotificationSending,
} from "./bookingNotificationState.js";

/** Pauses Playwright chat loop during group text + image outbound (see listener `runChatLoop`). */
globalThis.__OUTBOUND_BUSY__ = false;
import {
  buildMessagesOptionalFields,
  detectSimpleFeedbackIntent,
  normalizeWhatsAppInboundContext,
  updateLastMessageFeedback,
} from "./messageFeedback.js";

const DEBOUNCE_MS = Math.max(
  200,
  Math.min(
    5000,
    Number.parseInt(String(process.env.WHATSAPP_INBOUND_DEBOUNCE_MS ?? "650"), 10) ||
      650
  )
);

/** Flush immediately when buffered part count exceeds this (avoids long debounce stacks). */
const FRAGMENT_COUNT_IMMEDIATE_FLUSH = Math.max(
  2,
  Math.min(
    20,
    Number.parseInt(
      String(process.env.WHATSAPP_INBOUND_FRAGMENT_FLUSH_AFTER ?? "3"),
      10
    ) || 3
  )
);

/** Immediate flush only if the latest fragment arrived within this many ms of the previous (burst typing). */
const FRAGMENT_BURST_WINDOW_MS = Math.max(
  200,
  Math.min(
    10_000,
    Number.parseInt(
      String(process.env.WHATSAPP_INBOUND_FRAGMENT_BURST_MS ?? "1500"),
      10
    ) || 1500
  )
);

/** Same inbound + session must not trigger a second WhatsApp send within this window (retries / races). */
const WHATSAPP_DEBUG_GROUP =
  process.env.WHATSAPP_DEBUG_GROUP === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_DEBUG_GROUP ?? ""));

const WHATSAPP_GROUP_GATE_DISABLED =
  process.env.WHATSAPP_GROUP_GATE_DISABLED === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_GROUP_GATE_DISABLED ?? ""));

/** Same as server: bypass keyword/intent group gate while debugging. */
const WHATSAPP_GROUP_DEBUG =
  process.env.WHATSAPP_GROUP_DEBUG === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_GROUP_DEBUG ?? ""));

const REPLY_DEDUPE_WINDOW_MS = Math.max(
  5000,
  Math.min(
    10000,
    Number.parseInt(
      String(process.env.WHATSAPP_REPLY_DEDUPE_WINDOW_MS ?? "8000"),
      10
    ) || 8000
  )
);

/** @type {Map<string, BufferEntry>} */
const messageBuffer = new Map();

/** @type {Map<string, { hash: string, timestamp: number }>} */
const lastSentReplies = new Map();

/** @type {Map<string, { hash: string, timestamp: number }>} */
const lastPlaywrightTextSends = new Map();

/** Cross-source inbound dedupe window for identical text from same owner. */
const CROSS_SOURCE_DEDUPE_WINDOW_MS = 5000;
/** @type {Map<string, number>} */
const recentInboundByOwnerAndText = new Map();

/**
 * Playwright Web tab: a second flush can call `executeWhatsAppAiPipeline` while the first is still
 * in `processMessage` — the early active-job guard used to drop that work entirely (e.g. KIA Stonic
 * batch lost while "Jee krwani hai" batch ran). Queue and run FIFO after each job completes.
 * @type {Map<string, object[]>}
 */
const pendingPlaywrightPipelineBySession = new Map();
/** @type {Array<object>} */
globalThis.__messageQueue = Array.isArray(globalThis.__messageQueue)
  ? globalThis.__messageQueue
  : [];

const MAX_PENDING_PIPELINES_PER_SESSION = 12;
const BOOKING_NOTIFICATION_COLLECTION = "bookingNotificationState";

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} userId
 * @param {string} bookingId
 */
async function hasBookingNotificationBeenSent(db, userId, bookingId) {
  try {
    const snap = await db
      .collection("businesses")
      .doc(String(userId ?? "").trim())
      .collection(BOOKING_NOTIFICATION_COLLECTION)
      .doc(String(bookingId ?? "").trim())
      .get();
    return snap.exists === true;
  } catch (err) {
    console.warn(
      "[whatsappInboundBuffer] hasBookingNotificationBeenSent failed:",
      err?.message || err
    );
    // Fail-safe: allow one send attempt instead of silently dropping all notifications.
    return false;
  }
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {string} userId
 * @param {string} bookingId
 */
async function markBookingNotificationSent(db, userId, bookingId) {
  try {
    await db
      .collection("businesses")
      .doc(String(userId ?? "").trim())
      .collection(BOOKING_NOTIFICATION_COLLECTION)
      .doc(String(bookingId ?? "").trim())
      .set({
        bookingId: String(bookingId ?? "").trim(),
        notificationSent: true,
        sentAt: new Date(),
      });
  } catch (err) {
    console.warn(
      "[whatsappInboundBuffer] markBookingNotificationSent failed:",
      err?.message || err
    );
  }
}

async function markBookingNotificationQueuedForBooking(db, userId, bookingId) {
  await markBookingNotificationQueued(db, userId, bookingId);
}

/**
 * Non-blocking business notification for new booking requests (idempotent by booking id).
 * @param {{
 *   traceId: string,
 *   db: import("firebase-admin/firestore").Firestore,
 *   userId: string,
 *   booking: Record<string, unknown>,
 *   customerPhone: string,
 *   sendCredentials: { accessToken?: string, phoneNumberId?: string } | null | undefined,
 * }} p
 */
async function triggerBusinessBookingNotification({
  traceId,
  db,
  userId,
  booking,
  customerPhone,
  sendCredentials,
}) {
  const tid = String(traceId ?? "").trim() || "unknown-trace";
  const bookingId =
    booking?.id != null && String(booking.id).trim() !== ""
      ? String(booking.id).trim()
      : "";
  if (!bookingId) {
    console.warn(
      "⚠️ Missing booking.id — skipping notification to avoid untrackable state"
    );
    logBookingEvent({
      traceId: tid,
      step: "notification_result",
      status: "fail",
      data: { sent: false, reason: "BOOKING_ID_MISSING" },
    });
    return;
  }

  let ownerPhone = "";
  try {
    const businessSnap = await db.collection("businesses").doc(String(userId ?? "").trim()).get();
    const business = businessSnap.exists ? businessSnap.data() || {} : {};
    const businessProfile =
      business.businessProfile &&
      typeof business.businessProfile === "object" &&
      !Array.isArray(business.businessProfile)
        ? business.businessProfile
        : {};
    ownerPhone =
      String(
        businessProfile?.ownerNotificationPhone ?? business?.ownerNotificationPhone ?? ""
      ).trim();
  } catch (err) {
    console.warn("⚠️ Failed to resolve ownerNotificationPhone:", err?.message || err);
  }
  if (!ownerPhone) {
    console.warn("⚠️ Missing ownerNotificationPhone");
    logBookingEvent({
      traceId: tid,
      step: "notification_result",
      status: "fail",
      data: { sent: false, reason: "OWNER_PHONE_MISSING", bookingId },
    });
    await markBookingNotificationFailed({
      db,
      userId,
      bookingId,
      notificationError: "OWNER_PHONE_MISSING",
    });
    return;
  }

  const alreadyNotified = await hasBookingNotificationBeenSent(db, userId, bookingId);
  if (alreadyNotified) {
    console.log("⏭ Notification already sent for", bookingId);
    logBookingEvent({
      traceId: tid,
      step: "notification_result",
      status: "success",
      data: { sent: false, reason: "IDEMPOTENCY_BLOCK", bookingId },
    });
    return;
  }
  await markBookingNotificationSending(db, userId, bookingId);
  logBookingEvent({
    traceId: tid,
    step: "notification_trigger",
    status: "success",
    data: {
      notificationAttempted: true,
      bookingId,
    },
  });

  const itemName =
    booking?.itemName != null && String(booking.itemName).trim() !== ""
      ? String(booking.itemName).trim()
      : "Unknown item";
  const durationDays =
    booking?.durationDays != null && String(booking.durationDays).trim() !== ""
      ? String(booking.durationDays).trim()
      : "?";
  const customer = String(customerPhone ?? "").trim() || "unknown";

  const message = `
New booking request:

Item: ${itemName}
Duration: ${durationDays} days
Booking ID: ${bookingId}

Reply:
APPROVE ${bookingId}
or
REJECT ${bookingId}
`.trim();

  let sendSucceeded = false;
  /** @type {string | null} */
  let sendFailureDetail = null;
  let providerMessageId = "";
  try {
    const buttonResult = await sendWhatsAppInteractiveButtons(
      ownerPhone,
      message,
      [
        { id: `approve:${bookingId}`, title: "Approve" },
        { id: `reject:${bookingId}`, title: "Reject" },
      ],
      sendCredentials ?? undefined
    );
    if (buttonResult?.ok === true) {
      sendSucceeded = true;
      providerMessageId = String(buttonResult?.providerMessageId ?? "").trim();
      console.log("[owner_approval_buttons_sent]", {
        bookingId,
        ownerPhoneLast4: ownerPhone.replace(/\D/g, "").slice(-4) || null,
      });
    }

    if (!sendSucceeded) {
      const result = await sendWhatsAppMessage(
        ownerPhone,
        message,
        sendCredentials ?? undefined,
        { recipientType: "individual" }
      );
      if (result === true || result?.ok === true || result?.success === true) {
        sendSucceeded = true;
        providerMessageId = String(result?.providerMessageId ?? "").trim();
      } else if (result === undefined) {
        console.warn(
          "⚠️ sendWhatsAppMessage returned undefined — assuming success (compat mode)"
        );
        sendSucceeded = true;
      } else {
        sendFailureDetail = `non_success_response:${String(
          typeof result === "object" ? JSON.stringify(result).slice(0, 200) : result
        )}`;
      }
    }
  } catch (err) {
    sendFailureDetail = String(err?.message ?? err ?? "unknown");
    console.warn("❌ WhatsApp send threw error:", sendFailureDetail);
  }

  if (!sendSucceeded) {
    console.warn("❌ WhatsApp send failed — NOT marking notification as sent", {
      bookingId,
    });
    logBookingEvent({
      traceId: tid,
      step: "notification_result",
      status: "fail",
      data: {
        sent: false,
        reason: "WHATSAPP_API_FAILED",
        bookingId,
        ...(sendFailureDetail
          ? { error: sendFailureDetail.slice(0, 400) }
          : {}),
      },
    });
    await markBookingNotificationFailed({
      db,
      userId,
      bookingId,
      notificationError: sendFailureDetail || "WHATSAPP_API_FAILED",
    });
    return;
  }

  await markBookingNotificationSent(db, userId, bookingId);
  await markBookingNotificationProviderAccepted({
    db,
    userId,
    bookingId,
    providerMessageId,
  });

  console.log("📤 Booking notification sent:", {
    bookingId,
    booking,
  });
  logBookingEvent({
    traceId: tid,
    step: "notification_result",
    status: "success",
    data: {
      sent: false,
      providerAccepted: true,
      reason: "SENT_TO_PROVIDER",
      bookingId,
    },
  });
}

function queuePendingPlaywrightPipeline(p) {
  if (!isPlaywrightWebTabInbound(p)) return;
  const sk = String(p.sessionKey ?? "").trim();
  if (!sk) return;
  let q = pendingPlaywrightPipelineBySession.get(sk);
  if (!q) {
    q = [];
    pendingPlaywrightPipelineBySession.set(sk, q);
  }
  if (q.length >= MAX_PENDING_PIPELINES_PER_SESSION) {
    console.warn(
      "[whatsappInboundBuffer] pending pipeline queue full — dropping oldest (session)",
      sk
    );
    q.shift();
  }
  q.push(p);
  console.log("[whatsappInboundBuffer] queued pipeline until active job free", {
    sessionKey: sk,
    queueDepth: q.length,
  });
}

function scheduleDrainPendingPlaywrightPipelines(sessionKeyRaw) {
  const sk = String(sessionKeyRaw ?? "").trim();
  if (!sk) return;
  setImmediate(() => {
    void drainPendingPlaywrightPipelines(sk).catch((e) =>
      console.error("[whatsappInboundBuffer] drain pending pipeline:", e)
    );
  });
}

async function drainPendingPlaywrightPipelines(sessionKeyRaw) {
  const sk = String(sessionKeyRaw ?? "").trim();
  if (!sk) return;
  if (globalThis.__activeJob) {
    setTimeout(() => {
      void drainPendingPlaywrightPipelines(sk).catch((e) =>
        console.error("[whatsappInboundBuffer] drain pending (retry):", e)
      );
    }, 120);
    return;
  }
  const q = pendingPlaywrightPipelineBySession.get(sk);
  if (!q?.length) return;
  const next = q.shift();
  if (!q.length) pendingPlaywrightPipelineBySession.delete(sk);
  else pendingPlaywrightPipelineBySession.set(sk, q);
  await executeWhatsAppAiPipeline(next);
}

globalThis.__activeJob = globalThis.__activeJob || null;
globalThis.__activeJobStart =
  typeof globalThis.__activeJobStart === "number"
    ? globalThis.__activeJobStart
    : 0;
globalThis.__forceProcessing = globalThis.__forceProcessing === true;

const MAX_ACTIVE_JOB_MS = 10_000;

function releaseStaleActiveJobIfNeeded() {
  if (
    globalThis.__activeJob &&
    typeof globalThis.__activeJobStart === "number" &&
    globalThis.__activeJobStart > 0 &&
    Date.now() - globalThis.__activeJobStart > MAX_ACTIVE_JOB_MS
  ) {
    console.warn("⚠️ Force releasing stuck job (safe reset)");
    globalThis.__activeJob = null;
    globalThis.__activeJobStart = 0;
    globalThis.__forceProcessing = true;
  }
}

/**
 * @param {string} combinedMessage
 * @param {string} sessionKey
 */
function hashCombinedInbound(combinedMessage, sessionKey) {
  return createHash("sha256")
    .update(String(combinedMessage ?? ""), "utf8")
    .update("\u0000", "utf8")
    .update(String(sessionKey ?? ""), "utf8")
    .digest("hex");
}

/**
 * @typedef {{
 *   db: import("firebase-admin/firestore").Firestore,
 *   ownerUserId: string,
 *   userPhone: string,
 *   sessionKey: string,
 *   sendCredentials: { accessToken: string, phoneNumberId: string },
 *   phoneNumberId: string | null,
 *   isGroupMessage?: boolean,
 *   whatsappReplyTo?: string,
 *   whatsappRecipientType?: "individual"|"group",
 *   conversationCustomerNumber?: string,
 *   participantPhoneForDm?: string,
 *   sourceMessageIndex?: number,
 *   messageId?: string | number,
 *   messageTimestamp?: string | number | null,
 *   messageSender?: string,
 *   playwrightWebInbound?: boolean,
 *   trackingKey?: string,
 *   chatName?: string,
 *   groupName?: string,
 * }} FlushContext
 */

/**
 * @typedef {{
 *   messageParts: string[],
 *   timer: ReturnType<typeof setTimeout> | null,
 *   context: FlushContext | null,
 *   scheduleGen: number,
 *   lastUpdatedAt?: number,
 *   retryCount?: number,
 * }} BufferEntry
 */

/**
 * @param {string[]} parts
 */
export function isFirstFragmentGreeting(parts) {
  const first = parts[0];
  if (first == null || String(first).trim() === "") return false;
  return /^(hi|hello|hey|aoa|assalam|salam)\b/i.test(String(first).trim());
}

/**
 * Join fragments with " | " for internal structure, then flatten for the model.
 * Collapses adjacent duplicate tokens on the flattened line.
 * @param {string[]} parts
 * @returns {{ combined: string, structured: string }}
 */
export function normalizeBufferedMessages(parts) {
  const cleaned = parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return { combined: "", structured: "" };

  const structured = cleaned.join(" | ");
  let merged = structured
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = merged.split(/\s+/);
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev != null && prev.toLowerCase() === w.toLowerCase()) continue;
    out.push(w);
  }
  const combined = out.join(" ").trim();
  return { combined, structured };
}

/**
 * @param {string} latestTrimmed
 * @param {number} partCount
 * @param {number} baseDelay
 * @param {boolean} thinHistory
 */
function computeDebounceDelayMs(latestTrimmed, partCount, baseDelay, thinHistory) {
  const short = latestTrimmed.length < 10;
  let d = short ? Math.min(baseDelay * 1.5, 1000) : baseDelay;
  if (partCount === 1 && short) d += 150;
  if (partCount === 1 && short && thinHistory) d += 150;
  return Math.min(Math.max(d, 200), 1000);
}

/**
 * Playwright Web tab inbound (unknown customer phone): group or bridge thread from the pipeline.
 */
function isPlaywrightWebTabInbound(p) {
  return (
    String(p.userPhone ?? "").trim() === "unknown" &&
    (p.isGroupMessage === true || p.playwrightWebInbound === true)
  );
}

function releasePlaywrightListenerProcessingLocks() {
  // Intentionally no-op: active job lock is the single processing lock.
}

/** Clears listener chat focus when the pipeline produced no outbound message (avoids stuck priority on one chat). */
function releasePlaywrightChatFocusNoReply() {
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = 0;
}

/**
 * Structured intentional silent no-op (no WhatsApp outbound, inbound still handled).
 * @param {{ sendVia?: string | null, messageMeta?: Record<string, unknown> | null }} p
 * @returns {boolean}
 */
export function isIntentionalSilentInboundResult(p) {
  if (String(p?.sendVia ?? "").trim().toUpperCase() !== "NONE") return false;
  const meta =
    p?.messageMeta && typeof p.messageMeta === "object" ? p.messageMeta : null;
  if (!meta) return false;
  if (meta.handledWithoutOutbound === true) return true;
  const trace =
    meta.outboundTrace && typeof meta.outboundTrace === "object"
      ? meta.outboundTrace
      : null;
  if (!trace) return false;
  if (String(trace.kind ?? "").trim() === "silent_noop") return true;
  if (String(trace.finalReplySource ?? "").trim() === "PURE_ACK_SILENT") return true;
  return false;
}

/**
 * Playwright tab inbound is complete when outbound delivered or intentional silent noop.
 * @param {boolean} outboundReplyDelivered
 * @param {boolean} intentionalSilent
 * @returns {boolean}
 */
function playwrightInboundTurnComplete(outboundReplyDelivered, intentionalSilent) {
  return Boolean(outboundReplyDelivered || intentionalSilent);
}

/**
 * @param {string} gk
 * @param {{ db?: unknown, ownerUserId?: string, messageMeta?: Record<string, unknown> | null }} [opts]
 */
async function advancePlaywrightInboundCompletion(gk, opts = {}) {
  if (!gk) return;
  const pending = globalThis.__playwrightPendingByGuarantee?.get(gk);
  const listenerMsgId =
    globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map
      ? globalThis.__playwrightListenerMsgIdByGuarantee.get(gk)
      : "";
  if (pending?.chatKey && pending?.rowKey) {
    globalThis.__lastProcessedRowKeyByChat =
      globalThis.__lastProcessedRowKeyByChat || {};
    globalThis.__lastProcessedRowKeyByChat[pending.chatKey] = pending.rowKey;
    console.log("📍 Anchor advanced after delivery", {
      chatKey: pending.chatKey,
      rowKey: pending.rowKey,
    });
  }
  if (pending?.chatKey && String(listenerMsgId ?? "").trim()) {
    globalThis.__lastProcessedUserMsg =
      globalThis.__lastProcessedUserMsg || Object.create(null);
    const cursorKey =
      String(pending.participantCursorKey ?? "").trim() ||
      String(pending.chatKey).trim();
    globalThis.__lastProcessedUserMsg[cursorKey] = String(listenerMsgId).trim();
  }
  const ownerForCursor = String(
    opts.ownerUserId ?? pending?.ownerUserId ?? ""
  ).trim();
  const participantKeyForCursor = String(pending?.participantKey ?? "").trim();
  const inboundIdForCursor =
    String(pending?.inboundId ?? "").trim() ||
    String(listenerMsgId ?? "").trim();
  if (
    ownerForCursor &&
    pending?.chatKey &&
    participantKeyForCursor &&
    inboundIdForCursor
  ) {
    const saved = await savePlaywrightInboundCursor(opts.db, {
      businessId: ownerForCursor,
      chatKey: pending.chatKey,
      groupChatKey: pending.groupChatKey || pending.chatKey,
      participantKey: participantKeyForCursor,
      lastProcessedInboundId: inboundIdForCursor,
      lastProcessedRowKey: pending.rowKey || "",
      lastProcessedSourceMessageIndex: pending.sourceMessageIndex,
      lastProcessedAt: new Date(),
      lastAssistantOutboundTrace: normalizePlaywrightOutboundTrace(
        opts.messageMeta?.outboundTrace
      ),
    });
    if (saved?.cursorKey) {
      globalThis.__playwrightPersistedCursorByParticipant =
        globalThis.__playwrightPersistedCursorByParticipant || Object.create(null);
      const cursorKey =
        String(pending.participantCursorKey ?? "").trim() ||
        String(pending.chatKey).trim();
      globalThis.__playwrightPersistedCursorByParticipant[cursorKey] = saved;
      console.log("[playwright_cursor_persisted]", {
        cursorKey,
        storeKey: saved.cursorKey,
        inboundId: inboundIdForCursor,
        rowKey: pending.rowKey || null,
      });
    }
  }
  if (pending?.chatKey) {
    globalThis.__chatResponding =
      globalThis.__chatResponding || Object.create(null);
    globalThis.__chatRespondingCooldownUntil =
      globalThis.__chatRespondingCooldownUntil || Object.create(null);
    globalThis.__chatResponding[pending.chatKey] = false;
    globalThis.__chatRespondingCooldownUntil[pending.chatKey] = Date.now() + 2500;
  }
  notifyPlaywrightGuaranteeDelivered(gk);
  if (globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map) {
    globalThis.__playwrightListenerMsgIdByGuarantee.delete(gk);
  }
}

/**
 * @param {FlushContext & {
 *   combinedMessage: string,
 *   structuredSnapshot: string,
 *   fragmentCount: number,
 *   hasMultipleFragments: boolean,
 *   isGreetingFirst: boolean,
 *   latestMessage?: string,
 *   contextMessages?: string[],
 * }} p
 */
export async function executeWhatsAppAiPipeline(p) {
  const pipelineStartedAt = Date.now();
  const traceId =
    p.traceId != null && String(p.traceId).trim() !== ""
      ? String(p.traceId).trim()
      : randomUUID();
  p.traceId = traceId;
  const logLatency = (stage, startedAt, extra = {}) => {
    console.log("[latency]", {
      traceId,
      stage,
      durationMs: Date.now() - startedAt,
      totalMs: Date.now() - pipelineStartedAt,
      ...extra,
    });
  };

  const {
    db,
    ownerUserId,
    userPhone,
    participantPhoneForDm: participantPhoneForDmRaw,
    participantName: participantNameRaw,
    participantKey: participantKeyRaw,
    senderScope: senderScopeRaw,
    sessionKey: sessionKeyRaw,
    source: sourceRaw,
    dmPlaywrightChatKey: dmPlaywrightChatKeyRaw,
    dmChatTitle: dmChatTitleRaw,
    combinedMessage,
    latestMessage: latestMessageRaw,
    contextMessages: contextMessagesRaw = [],
    structuredSnapshot,
    sendCredentials,
    phoneNumberId,
    fragmentCount = 1,
    hasMultipleFragments = false,
    isGreetingFirst = false,
    isGroupMessage = false,
    whatsappReplyTo: whatsappReplyToRaw,
    whatsappRecipientType: whatsappRecipientTypeRaw,
    conversationCustomerNumber: conversationCustomerNumberRaw,
    messageId: messageIdRaw,
    playwrightWebInbound: playwrightWebInboundRaw = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityRaw = false,
    groupName: groupNameRaw,
    chatName: chatNameRaw,
    inboundIntent: inboundIntentRaw = null,
    inboundEntity: inboundEntityRaw = null,
    resetTopicContext: resetTopicContextRaw = false,
    playwrightChatKey: playwrightChatKeyRaw = null,
    sourceRowKey: sourceRowKeyRaw = null,
    sourceMessageIndex: sourceMessageIndexRaw = null,
    startupCatchup: startupCatchupRaw = false,
    suppressAckNoopOutbound: suppressAckNoopOutboundRaw = false,
    cursorLastAssistantOutboundTrace: cursorLastAssistantOutboundTraceRaw = null,
    inboundSourceOrigin: inboundSourceOriginRaw = INBOUND_SOURCE_REAL_CUSTOMER,
  } = p;

  const dmPlaywrightChatKey = String(dmPlaywrightChatKeyRaw ?? "").trim();
  const dmChatTitle = String(dmChatTitleRaw ?? "").trim();
  const dmIdentityKey = normalizeTitle(dmPlaywrightChatKey || dmChatTitle);
  const isPlaywrightDm =
    String(sourceRaw ?? "").trim() === "PLAYWRIGHT_DM" ||
    (isGroupMessage !== true && Boolean(dmPlaywrightChatKey));
  const isPlaywrightDmWithIdentity = Boolean(isPlaywrightDm && dmIdentityKey);

  const playwrightWebInbound = Boolean(playwrightWebInboundRaw);
  const playwrightWebTitleIdentity = Boolean(playwrightWebTitleIdentityRaw);
  const groupNameResolved = String(groupNameRaw ?? chatNameRaw ?? "").trim();
  const inboundSourceOrigin =
    inboundSourceOriginRaw != null && String(inboundSourceOriginRaw).trim() !== ""
      ? String(inboundSourceOriginRaw).trim()
      : INBOUND_SOURCE_REAL_CUSTOMER;
  const latestMessageForOrigin = String(latestMessageRaw ?? combinedMessage ?? "").trim();
  const originCheck = resolveInboundSourceOrigin({
    text: latestMessageForOrigin,
    chatKey: String(playwrightChatKeyRaw ?? groupNameResolved ?? "").trim(),
    sender: "user",
    isStartupBaseline: inboundSourceOrigin === "startup_baseline",
  });
  const effectiveInboundSourceOrigin = originCheck.blocked
    ? originCheck.sourceOrigin
    : inboundSourceOrigin;
  if (effectiveInboundSourceOrigin !== INBOUND_SOURCE_REAL_CUSTOMER) {
    console.log("[inbound_pipeline_blocked_non_customer_origin]", {
      inboundSourceOrigin: effectiveInboundSourceOrigin,
      reason: originCheck.reason,
      messagePreview: latestMessageForOrigin.slice(0, 120),
      messageId: String(messageIdRaw ?? "").trim() || null,
    });
    if (isPlaywrightWebTabInbound(p)) {
      notifyPlaywrightGuaranteeReleased(
        buildPlaywrightGuaranteeKey(groupNameResolved, messageIdRaw)
      );
      releasePlaywrightListenerProcessingLocks();
    }
    return;
  }

  const conversationCustomerNumber =
    String(conversationCustomerNumberRaw ?? "").trim() ||
    String(userPhone ?? "").replace(/\D/g, "");
  let whatsappReplyTo = String(whatsappReplyToRaw ?? "").trim();
  if (!whatsappReplyTo) {
    whatsappReplyTo = String(userPhone ?? "").replace(/\D/g, "");
  }
  const whatsappRecipientType =
    whatsappRecipientTypeRaw === "group" ? "group" : "individual";

  const fallbackDmTo =
    String(participantPhoneForDmRaw ?? "").trim() || userPhone;

  let sessionKey =
    sessionKeyRaw != null && String(sessionKeyRaw).trim() !== ""
      ? String(sessionKeyRaw).trim()
      : "";
  if (isPlaywrightDmWithIdentity) {
    sessionKey = `${ownerUserId}::dm::${dmIdentityKey}`;
    console.log("[playwright_dm_pipeline_accepted]", {
      dmChatTitle: dmChatTitle || null,
      dmPlaywrightChatKey: dmPlaywrightChatKey || null,
      sessionKey,
    });
  }

  const tsRaw = p?.messageTimestamp ?? p?.timestamp ?? null;
  const tsNum = Number(tsRaw);
  const safeTimestamp =
    Number.isFinite(tsNum) && tsNum > 0 ? tsNum : Date.now();
  console.log("[timestamp_normalized]", {
    raw: tsRaw,
    final: safeTimestamp,
  });

  let normalizedInbound;
  const extractionStartedAt = Date.now();
  try {
    normalizedInbound = normalizeInboundMessage({
      source: isPlaywrightWebTabInbound(p) ? "playwright" : "cloud",
      message: String(latestMessageRaw ?? combinedMessage ?? "").trim(),
      messageId: messageIdRaw,
      userId: ownerUserId,
      sessionKey,
      chatId:
        (isPlaywrightDmWithIdentity ? dmIdentityKey : "") ||
        String(playwrightChatKeyRaw ?? "").trim() ||
        String(groupNameResolved ?? "").trim() ||
        String(sessionKey ?? "").trim(),
      timestamp: safeTimestamp,
    });
  } catch (err) {
    console.error("[normalizeInboundMessage] failed", err);
    return;
  }
  logLatency("extraction", extractionStartedAt, {
    source: normalizedInbound.source,
    messageId: normalizedInbound.messageId,
  });
  const messageId = normalizedInbound.messageId;
  const dedupeMessageKey = `${normalizedInbound.userId}_${normalizedInbound.message
    .trim()
    .toLowerCase()}`;
  const nowForCrossSourceDedupe = Date.now();
  const lastInboundAt = recentInboundByOwnerAndText.get(dedupeMessageKey);
  if (
    lastInboundAt != null &&
    nowForCrossSourceDedupe - lastInboundAt < CROSS_SOURCE_DEDUPE_WINDOW_MS
  ) {
    console.log("⛔ Duplicate message skipped", {
      source: normalizedInbound.source,
      messageId: normalizedInbound.messageId,
      ownerUserId: normalizedInbound.userId,
      ageMs: nowForCrossSourceDedupe - lastInboundAt,
    });
    return;
  }
  recentInboundByOwnerAndText.set(dedupeMessageKey, nowForCrossSourceDedupe);
  // Keep map bounded by evicting stale entries opportunistically.
  for (const [k, ts] of recentInboundByOwnerAndText) {
    if (nowForCrossSourceDedupe - ts > CROSS_SOURCE_DEDUPE_WINDOW_MS * 4) {
      recentInboundByOwnerAndText.delete(k);
    }
  }
  if (isPlaywrightWebTabInbound(p)) {
    // Playwright DM continuation: does NOT require group title identity. Must have DM identity key.
    if (!isPlaywrightDmWithIdentity && (!playwrightWebTitleIdentity || !groupNameResolved)) {
      logBookingEvent({
        traceId,
        step: "pipeline_start",
        status: "fail",
        data: {
          reason: "invalid_playwright_tab_identity",
          messageId,
          sessionKey: String(sessionKey ?? "").slice(0, 120),
        },
      });
      console.error("INVALID PLAYWRIGHT TAB — need groupName (title identity)", {
        groupNameResolved,
      });
      notifyPlaywrightGuaranteeReleased(
        buildPlaywrightGuaranteeKey(groupNameResolved, messageId)
      );
      return;
    }
  } else if (!String(whatsappReplyTo ?? "").trim()) {
    logBookingEvent({
      traceId,
      step: "pipeline_start",
      status: "fail",
      data: {
        reason: "missing_whatsapp_reply_target",
        messageId,
        sessionKey: String(sessionKey ?? "").slice(0, 120),
      },
    });
    console.log("⛔ Missing WhatsApp reply target — skipping");
    return;
  }
  const previewForChatKey = identityContextFromPreview(
    String(latestMessageRaw ?? combinedMessage ?? "").trim()
  );
  const safeChatKey =
    playwrightWebTitleIdentity && groupNameResolved
      ? `pw-title::${normalizeTitle(groupNameResolved)}::${previewForChatKey}`
      : String(whatsappReplyTo ?? "").trim().toLowerCase() ||
        String(p.sessionKey ?? "").trim().toLowerCase();
  const textPart = String(combinedMessage ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const now = Date.now();
  const fingerprint = `${safeChatKey}::${textPart}::${messageId}::${fragmentCount}::${now}`;
  console.log("🧾 NEW FINGERPRINT:", {
    safeChatKey,
    textPreview: textPart,
    messageId,
    fragmentCount,
    now,
  });
  console.log("🧾 Message Identity:", {
    safeChatKey,
    groupName: groupNameResolved || undefined,
    messageId,
    fingerprint,
  });

  releaseStaleActiveJobIfNeeded();
  if (globalThis.__activeJob && !globalThis.__forceProcessing) {
    if (isPlaywrightWebTabInbound(p)) {
      queuePendingPlaywrightPipeline(p);
    } else {
      logBookingEvent({
        traceId,
        step: "pipeline_start",
        status: "fail",
        data: {
          reason: "active_job_queued",
          messageId,
          sessionKey: String(sessionKey ?? "").slice(0, 120),
        },
      });
      console.log("⏳ Job active — queueing message", {
        activeJob: globalThis.__activeJob,
        incoming: fingerprint,
      });
      globalThis.__messageQueue.push(p);
    }
    return;
  }
  globalThis.__forceProcessing = false;

  let processingSuccess = false;
  /** Hoisted for guarantee bridge (Playwright deliver vs release). */
  let outboundReplyDelivered = false;
  /** Intentional handled-without-outbound (e.g. PURE_ACK_SILENT). */
  let intentionalSilent = false;
  /** Hoisted for finally-block guarantee completion (declared inside try is TDZ in finally). */
  let messageMeta = null;

  const groupLogFields =
    isGroupMessage === true
      ? { is_group: true, is_auto_triggered: true }
      : {};

  const messageHash = hashCombinedInbound(combinedMessage, sessionKey);
  const nowMs = Date.now();
  const prevSent = lastSentReplies.get(sessionKey);
  if (
    prevSent &&
    prevSent.hash === messageHash &&
    nowMs - prevSent.timestamp < REPLY_DEDUPE_WINDOW_MS
  ) {
    logBookingEvent({
      traceId,
      step: "pipeline_start",
      status: "fail",
      data: {
        reason: "duplicate_inbound_dedupe",
        messageId,
        sessionKey: String(sessionKey ?? "").slice(0, 120),
        ageMs: nowMs - prevSent.timestamp,
      },
    });
    console.log("[whatsappInboundBuffer] skip duplicate pipeline (recent same inbound)", {
      sessionKey,
      messageHashPreview: messageHash.slice(0, 16),
      ageMs: nowMs - prevSent.timestamp,
    });
    if (isPlaywrightWebTabInbound(p)) {
      notifyPlaywrightGuaranteeReleased(
        buildPlaywrightGuaranteeKey(groupNameResolved, messageId)
      );
      releasePlaywrightListenerProcessingLocks();
    }
    return;
  }

  globalThis.__activeJob = fingerprint;
  globalThis.__activeJobStart = Date.now();

  let pipelineTimeoutId = null;
  if (isPlaywrightWebTabInbound(p)) {
    /** Text + model + image download + WA Web attach/preview often exceeds 15s; releasing locks mid-send breaks uploads. */
    pipelineTimeoutId = setTimeout(() => {
      console.log("⚠️ Pipeline timeout — force release");
      globalThis.__ACTIVE_PIPELINE__ = false;
      globalThis.__UI_HARD_LOCK = false;
      releasePlaywrightListenerProcessingLocks();
    }, 120_000);
  }

  const guaranteeKey = isPlaywrightWebTabInbound(p)
    ? String(buildPlaywrightGuaranteeKey(groupNameResolved, messageId) ?? "").trim()
    : "";

  console.time("TOTAL_RESPONSE");
  try {
    if (isPlaywrightWebTabInbound(p)) {
      globalThis.__ACTIVE_PIPELINE__ = true;
      globalThis.__UI_HARD_LOCK = true;
      console.log("🔒 UI HARD LOCK + active pipeline (Playwright tab inbound)");
    }
    console.log("🚀 Pipeline started");
    const { customerId, channel } = normalizeWhatsAppInboundContext(userPhone);

    console.log("📩 Approval message received:", combinedMessage);
    const parsedApproval = parseApprovalMessage(combinedMessage);
    console.log("🧠 Parsed approval:", parsedApproval);
    if (parsedApproval) {
      console.log("🛠 Owner approval command detected:", parsedApproval);
      await handleBookingApproval({
        db,
        userId: ownerUserId,
        bookingId: parsedApproval.bookingId,
        action: parsedApproval.action,
        senderPhone: conversationCustomerNumber,
        sendCredentials,
      });
      processingSuccess = true;
      return;
    }

    const feedbackIntent = detectSimpleFeedbackIntent(combinedMessage);
    if (feedbackIntent) {
      void updateLastMessageFeedback(db, {
        ownerUserId,
        customerId,
        channel,
        isCorrect: feedbackIntent === "positive",
        note: "keyword_feedback",
      });
    }

    try {
      await appendConversationMessage(db, {
        ownerUserId,
        customerNumber: conversationCustomerNumber,
        role: "user",
        text: combinedMessage,
      });
    } catch (e) {
      console.error("[whatsappInboundBuffer] save user message:", e);
    }

  let conversationHistory = "";
  try {
    conversationHistory = await getRecentConversationForPrompt(
      db,
      ownerUserId,
      conversationCustomerNumber,
      20
    );
  } catch (e) {
    console.error("[whatsappInboundBuffer] load conversation:", e);
  }

  console.log("[DEBUG] isGreetingFirst:", isGreetingFirst);
  console.log("[DEBUG] messageText (combined):", combinedMessage);
  console.log("[DEBUG] processMessage userId (owner):", ownerUserId);

  const isGroupInbound =
    isGroupMessage === true && String(userPhone ?? "").trim() === "unknown";

  logBookingEvent({
    traceId,
    step: "pipeline_start",
    status: "start",
    data: {
      messageText: String(combinedMessage ?? "").slice(0, 500),
      sessionKey: String(sessionKey ?? "").slice(0, 160),
      messageId,
    },
  });

  console.log("🧠 Generating AI response");
  const latestMessage = String(latestMessageRaw ?? combinedMessage ?? "").trim();
  const contextMessages = Array.isArray(contextMessagesRaw)
    ? contextMessagesRaw
        .map((m) => String(m ?? "").trim())
        .filter(Boolean)
    : [];
  const startupCatchup = Boolean(startupCatchupRaw);
  const suppressAckNoopOutbound = Boolean(suppressAckNoopOutboundRaw);
  const cursorLastAssistantOutboundTrace = normalizePlaywrightOutboundTrace(
    cursorLastAssistantOutboundTraceRaw
  );
  if (startupCatchup && cursorLastAssistantOutboundTrace && sessionKey) {
    const memory = getEmilySessionState(sessionKey);
    memory.lastAssistantOutbound = cursorLastAssistantOutboundTrace;
    console.log("[playwright_cursor_outbound_trace_rehydrated]", {
      sessionKey,
      kind: cursorLastAssistantOutboundTrace.kind || null,
      finalReplySource: cursorLastAssistantOutboundTrace.finalReplySource || null,
    });
  }
  if (isGroupInbound) {
    console.log("[group_participant_key_passed_to_processor]", {
      groupChatKey: String(groupNameResolved ?? "").trim() || null,
      participantName: String(participantNameRaw ?? "").trim() || null,
      sourceParticipantKey:
        participantKeyRaw != null && String(participantKeyRaw).trim() !== ""
          ? String(participantKeyRaw).trim()
          : null,
      messagePreview: String(latestMessage ?? "").slice(0, 120) || null,
    });
  }
  const processStartedAt = Date.now();
  let reply;
  let sendVia;
  let dmRecipientPhone;
  ({
    reply,
    messageMeta,
    sendVia,
    dmRecipientPhone,
  } = await processMessage({
    traceId,
    userId: normalizedInbound.userId,
    message: normalizedInbound.message,
    messageId: normalizedInbound.messageId,
    source: normalizedInbound.source,
    timestamp: normalizedInbound.timestamp,
    contextMessages,
    sessionKey: normalizedInbound.sessionKey,
    conversationHistory,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
    isGroupInbound,
    isGroupMessage,
    whatsappRecipientType,
    playwrightWebInbound,
    bookingHint: p?.bookingHint ?? null,
    participantPhoneForDm:
      String(participantPhoneForDmRaw ?? "").trim() || undefined,
    participantKey:
      participantKeyRaw != null && String(participantKeyRaw).trim() !== ""
        ? String(participantKeyRaw).trim()
        : undefined,
    inboundIntent:
      inboundIntentRaw != null && String(inboundIntentRaw).trim() !== ""
        ? String(inboundIntentRaw).trim().toLowerCase()
        : null,
    inboundEntity:
      inboundEntityRaw != null && String(inboundEntityRaw).trim() !== ""
        ? String(inboundEntityRaw).trim()
        : null,
    resetTopicContext: Boolean(resetTopicContextRaw),
    playwrightChatKey:
      playwrightChatKeyRaw != null && String(playwrightChatKeyRaw).trim() !== ""
        ? String(playwrightChatKeyRaw).trim()
        : null,
    groupName: groupNameResolved || null,
    participantName:
      participantNameRaw != null && String(participantNameRaw).trim() !== ""
        ? String(participantNameRaw).trim()
        : null,
    senderScope:
      senderScopeRaw != null && String(senderScopeRaw).trim() !== ""
        ? String(senderScopeRaw).trim()
        : null,
    sourceRowKey:
      sourceRowKeyRaw != null && String(sourceRowKeyRaw).trim() !== ""
        ? String(sourceRowKeyRaw).trim()
        : null,
    sourceMessageIndex:
      sourceMessageIndexRaw != null && Number.isFinite(Number(sourceMessageIndexRaw))
        ? Number(sourceMessageIndexRaw)
        : null,
    inboundSourceOrigin: effectiveInboundSourceOrigin,
  }));
  const finalReplySourceFromMeta = String(
    messageMeta?.outboundTrace?.finalReplySource ?? ""
  ).trim();
  if (suppressAckNoopOutbound && finalReplySourceFromMeta === "PURE_ACK_NOOP") {
    console.log("[stale_ack_noop_outbound_suppressed]", {
      messageId: String(normalizedInbound.messageId ?? "").trim() || null,
      sourceRowKey:
        sourceRowKeyRaw != null && String(sourceRowKeyRaw).trim() !== ""
          ? String(sourceRowKeyRaw).trim()
          : null,
    });
    reply = "";
    sendVia = "NONE";
    messageMeta = {
      ...(messageMeta && typeof messageMeta === "object" ? messageMeta : {}),
      handledWithoutOutbound: true,
      outboundTrace: {
        ...(messageMeta?.outboundTrace && typeof messageMeta.outboundTrace === "object"
          ? messageMeta.outboundTrace
          : {}),
        finalReplySource: "PURE_ACK_NOOP",
        kind: "silent_noop",
      },
    };
  }
  intentionalSilent = isIntentionalSilentInboundResult({ sendVia, messageMeta });
  logLatency("processMessage", processStartedAt, {
    sendVia,
    hasReply: String(reply ?? "").trim() !== "",
    intentionalSilent,
  });
  const bookingIdMeta =
    messageMeta?.bookingCreated &&
    typeof messageMeta.bookingCreated === "object" &&
    messageMeta.bookingCreated.id != null
      ? String(messageMeta.bookingCreated.id).trim()
      : null;
  logBookingEvent({
    traceId,
    step: "booking_result",
    status: "success",
    data: {
      bookingCreated: Boolean(messageMeta?.bookingCreated),
      bookingId: bookingIdMeta || null,
    },
  });
  logBookingEvent({
    traceId,
    step: "notification_trigger",
    status: "success",
    data: {
      notificationAttempted: false,
      bookingId: bookingIdMeta || null,
    },
  });
  if (messageMeta?.bookingCreated && bookingIdMeta) {
    await markBookingNotificationQueuedForBooking(
      db,
      ownerUserId,
      bookingIdMeta
    );
    console.log("📦 BookingCreated detected", messageMeta.bookingCreated);
    void triggerBusinessBookingNotification({
      traceId,
      db,
      userId: ownerUserId,
      booking: messageMeta.bookingCreated,
      customerPhone: conversationCustomerNumber,
      sendCredentials,
    }).catch((err) => {
      console.warn("⚠️ Booking notification failed:", err?.message || err);
      void markBookingNotificationFailed({
        db,
        userId: ownerUserId,
        bookingId: bookingIdMeta,
        notificationError: err?.message || String(err),
      });
      logBookingEvent({
        traceId,
        step: "notification_result",
        status: "fail",
        data: {
          sent: false,
          reason: "NOTIFICATION_ASYNC_ERROR",
          bookingId: bookingIdMeta,
          error: String(err?.message ?? err ?? ""),
        },
      });
    });
  } else {
    console.log("[notification_skipped]", {
      notificationSkippedReason: messageMeta?.bookingCreated
        ? "BOOKING_ID_MISSING"
        : "BOOKING_NOT_CREATED",
      bookingId: bookingIdMeta || null,
    });
  }

  const optionalLogFields = buildMessagesOptionalFields({
    channel,
    customerId,
    is_flagged: Boolean(messageMeta?.isFlagged),
    is_correct: null,
    source_of_answer: messageMeta?.sourceOfAnswer,
  });

  const aiResponse = reply != null ? String(reply).trim() : "";
  const hasValidAI =
    typeof aiResponse === "string" && aiResponse.trim().length > 0;
  let finalText = aiResponse;
  const skipAIProcessing = messageMeta?.bookingBlocked === true;

  if (skipAIProcessing) {
    console.log("[OUTBOUND PRIORITY: BOOKING BLOCKED]");
    finalText = aiResponse;
  }

  if (messageMeta?.bookingCreated) {
    console.log("[BOOKING FINAL RESPONSE SENT]");
  }

  if (!skipAIProcessing && isGroupMessage === true) {
    if (hasValidAI) {
      finalText = aiResponse;
    }
  } else if (!skipAIProcessing && hasValidAI) {
    finalText = aiResponse;
  }

  const confirmationIntent = /^(yes|y|ok|okay|confirm|confirmed|sure|haan|han|jee|ji)$/i.test(
    String(combinedMessage ?? "").trim()
  );
  const isFalseProcessingResponse =
    !intentionalSilent &&
    confirmationIntent === true &&
    !messageMeta?.bookingCreated &&
    !messageMeta?.bookingBlocked;

  if (isFalseProcessingResponse) {
    console.warn("[BLOCKED FAKE PROCESSING RESPONSE]");
    finalText =
      "Got it — confirming your booking details. Please wait a moment.";
  }

  // --- PRODUCTION SAFETY: prevent fake booking confirmations ---
  const bookingMeta = messageMeta?.bookingCreated || null;
  const memory =
    messageMeta?.memory && typeof messageMeta.memory === "object"
      ? messageMeta.memory
      : null;

  const hasRealBooking = Boolean(
    bookingMeta &&
      bookingMeta.id &&
      bookingMeta.status === "pending_approval"
  );

  const durationFromBooking = Number.isFinite(
    messageMeta?.bookingCreated?.durationDays
  );
  const durationFromMemory =
    memory?.lastDuration !== "" &&
    Number.isFinite(Number(memory?.lastDuration));
  const hasDuration = durationFromBooking || durationFromMemory;
  const isIncompleteBooking = !messageMeta?.bookingCreated && !hasDuration;

  const looksLikeBookingConfirmation =
    typeof finalText === "string" &&
    /verify|confirm|processing|shortly|request details/i.test(finalText);

  if (!hasRealBooking && looksLikeBookingConfirmation && isIncompleteBooking) {
    console.log("[SAFEGUARD] Blocking fake booking confirmation → using AI response");

    if (aiResponse && aiResponse.trim()) {
      finalText = aiResponse;
    }
  }

  console.log("[FINAL TEXT DECISION]", {
    aiResponse,
    finalText,
    hasValidAI,
    isGroupMessage: messageMeta?.isGroupMessage === true || isGroupMessage === true,
  });

  const replyText = finalText;
  /** True only when a WhatsApp outbound path actually delivered (Playwright or Cloud). */
  outboundReplyDelivered = false;
  console.log(
    "[whatsappInboundBuffer] AI reply length=",
    replyText.length,
    "preview=",
    replyText.slice(0, 120),
    "| combinedInbound=",
    combinedMessage.slice(0, 80)
  );

  if (replyText !== "") {
    const outboundBinding = validateOutboundReplyBinding({
      replyToMessageId: messageId,
      sourceOrigin: effectiveInboundSourceOrigin,
      guaranteeKey,
      textPreview: replyText.slice(0, 120),
      activeMessageId: messageId,
    });
    if (!outboundBinding.ok) {
      console.log("[stale_outbound_reply_blocked]", {
        replyToMessageId: messageId,
        reason: outboundBinding.reason,
        activeMessageId: messageId,
        textPreview: replyText.slice(0, 120),
      });
      processingSuccess = true;
      return;
    }
    logOutboundReplyBoundToTurn({
      replyToMessageId: messageId,
      guaranteeKey,
      traceId,
      finalReplySource: messageMeta?.finalReplySource ?? null,
      textPreview: replyText.slice(0, 120),
    });
    const outboundLifecycleBase = buildOutboundLifecycleBase({
      traceId,
      guaranteeKey: guaranteeKey || null,
      sourceMessageIndex:
        sourceMessageIndexRaw != null && Number.isFinite(Number(sourceMessageIndexRaw))
          ? Number(sourceMessageIndexRaw)
          : null,
      chatKey: safeChatKey || sessionKey || null,
      groupChatKey:
        (playwrightChatKeyRaw != null && String(playwrightChatKeyRaw).trim() !== ""
          ? String(playwrightChatKeyRaw).trim()
          : null) ||
        (groupNameResolved ? normalizeTitle(groupNameResolved) : null),
      inboundId: messageId || null,
      messageHash,
    });
    const finalReplySourceForLifecycle = String(
      messageMeta?.outboundTrace?.finalReplySource ?? ""
    ).trim();
    logOutboundLifecycle("prepared", {
      ...outboundLifecycleBase,
      replyPreview: replyText.slice(0, 120),
      replyChars: replyText.length,
      sendVia: String(sendVia ?? "").trim() || null,
      finalReplySource: finalReplySourceForLifecycle || null,
    });

    const beforeSend = Date.now();
    const sentRecord = lastSentReplies.get(sessionKey);
    const duplicateWithinWindow =
      sentRecord &&
      sentRecord.hash === messageHash &&
      beforeSend - sentRecord.timestamp < REPLY_DEDUPE_WINDOW_MS;

    if (duplicateWithinWindow) {
      console.log("[whatsappInboundBuffer] skip duplicate WhatsApp send (same inbound)", {
        sessionKey,
        messageHashPreview: messageHash.slice(0, 16),
      });
      if (isPlaywrightWebTabInbound(p)) {
        outboundReplyDelivered = true;
      }
      logOutboundLifecycle("duplicate_send_skipped", {
        ...outboundLifecycleBase,
        reason: "same_inbound_hash_window",
        outboundReplyDelivered,
        sendVia: String(sendVia ?? "").trim() || null,
      });
      logOutboundLifecycle("buffer_mark_delivered", {
        ...outboundLifecycleBase,
        outboundReplyDelivered,
        sendVia: String(sendVia ?? "").trim() || null,
      });
    } else {
      console.log("📤 Sending reply");
      logOutboundLifecycle("buffer_send_start", {
        ...outboundLifecycleBase,
        sendVia: String(sendVia ?? "").trim() || null,
        finalReplySource: finalReplySourceForLifecycle || null,
      });
      let groupSendFailed = false;
      let outboundStartedAt = 0;
      try {
        const accessToken = String(sendCredentials?.accessToken ?? "").trim();
        const phoneNumberIdForSend = String(
          sendCredentials?.phoneNumberId ?? ""
        ).trim();
        const sendTarget = String(whatsappReplyTo ?? "").trim();
        const unknownPhone = String(userPhone ?? "").trim() === "unknown";
        const isPlaywrightGroup =
          isGroupMessage === true && unknownPhone;
        /** Tab inbound must use WA Web UI only — never Cloud API, regardless of sendVia. */
        const isTabInbound = isPlaywrightWebTabInbound(p);
        const usePlaywrightWebSend =
          isTabInbound ||
          (!isTabInbound &&
            sendVia === "PLAYWRIGHT" &&
            unknownPhone &&
            (isGroupMessage === true || playwrightWebInbound));
        outboundStartedAt = Date.now();
        const sendResult = await sendOutboundMessage({
          sendVia,
          reply: replyText,
          messageMeta,
          dmRecipientPhone,
          context: {
            isTabInbound,
            unknownPhone,
            isGroupMessage: isGroupMessage === true,
            playwrightWebInbound: Boolean(playwrightWebInbound),
            groupNameResolved,
            accessToken,
            phoneNumberIdForSend,
            sendTarget,
            whatsappReplyTo,
            channel,
            fallbackDmTo,
            whatsappRecipientType,
            userPhone: String(userPhone ?? ""),
            sessionKey,
            // Pass-through DM continuation markers from the pipeline input (not buffer entry).
            source: p?.source,
            dmPlaywrightChatKey: p?.dmPlaywrightChatKey,
            dmChatTitle: p?.dmChatTitle,
            messageHash,
            dedupeWindowMs: REPLY_DEDUPE_WINDOW_MS,
            lastPlaywrightTextSends,
            usePlaywrightWebSend,
            guaranteeKey: String(guaranteeKey ?? "").trim(),
            outboundLifecycle: outboundLifecycleBase,
          },
        });
        logLatency("outbound send", outboundStartedAt, {
          sendVia,
          usePlaywrightWebSend,
          ok: sendResult?.ok === true,
        });
        groupSendFailed = Boolean(sendResult?.groupSendFailed);
        if (sendResult?.ok === true) {
          outboundReplyDelivered = true;
        } else {
          console.warn("⚠️ Outbound message failed:", {
            sendVia,
            ownerUserId,
            conversationCustomerNumber,
          });
        }
        lastSentReplies.set(sessionKey, {
          hash: messageHash,
          timestamp: Date.now(),
        });
        console.log(
          "[whatsappInboundBuffer] deliverWhatsAppOutbound finished for",
          userPhone
        );
      } catch (sendErr) {
        if (outboundStartedAt) {
          logLatency("outbound send", outboundStartedAt, {
            sendVia,
            ok: false,
            error: String(sendErr?.message ?? sendErr ?? "").slice(0, 160),
          });
        }
        console.error("[whatsappInboundBuffer] WhatsApp send error:", sendErr);
      }

      if (outboundReplyDelivered) {
        console.log("✅ Reply sent");
      } else {
        console.log("⚠️ Reply not fully delivered");
      }
      logOutboundLifecycle("buffer_mark_delivered", {
        ...outboundLifecycleBase,
        outboundReplyDelivered,
        sendVia: String(sendVia ?? "").trim() || null,
      });

      try {
        await appendConversationMessage(db, {
          ownerUserId,
          customerNumber: conversationCustomerNumber,
          role: "assistant",
          text: replyText,
        });
      } catch (e) {
        console.error("[whatsappInboundBuffer] save assistant message:", e);
      }

      try {
        await db.collection("messages").add({
          from: userPhone,
          message: combinedMessage,
          reply: replyText,
          ownerUserId,
          phoneNumberId: phoneNumberId || null,
          fragmentCount,
          fragmentStructured: structuredSnapshot || null,
          hasMultipleFragments,
          isGreetingFirst,
          messageHash,
          createdAt: new Date(),
          ...(groupSendFailed ? { group_send_failed: true } : {}),
          ...groupLogFields,
          ...optionalLogFields,
        });
      } catch (err) {
        console.error("[whatsappInboundBuffer] Firestore messages log error:", err);
      }
    }
  } else {
    try {
      await db.collection("messages").add({
        from: userPhone,
        message: combinedMessage,
        reply: replyText,
        ownerUserId,
        phoneNumberId: phoneNumberId || null,
        fragmentCount,
        fragmentStructured: structuredSnapshot || null,
        hasMultipleFragments,
        isGreetingFirst,
        messageHash,
        createdAt: new Date(),
        ...groupLogFields,
        ...optionalLogFields,
      });
    } catch (err) {
      console.error("[whatsappInboundBuffer] Firestore messages log error:", err);
    }
  }

  if (intentionalSilent) {
    console.log("[silent_noop_marked_processed]", {
      source:
        String(messageMeta?.outboundTrace?.finalReplySource ?? "").trim() ||
        "PURE_ACK_SILENT",
      messageId: String(messageId ?? "").trim() || null,
      bufferKey: String(sessionKey ?? "").trim() || null,
      guaranteeKey: guaranteeKey || null,
    });
  }

  if (
    isPlaywrightWebTabInbound(p) &&
    !intentionalSilent &&
    (replyText === "" || !outboundReplyDelivered)
  ) {
    console.log("⚠️ No reply sent — releasing chat focus");
    releasePlaywrightChatFocusNoReply();
  }
  if (replyText !== "" && !outboundReplyDelivered) {
    throw new Error("outbound_not_delivered");
  }
  processingSuccess = true;
  } catch (err) {
    console.error("❌ Processing error:", err);
    if (guaranteeKey) {
      setMessageState(guaranteeKey, "failed");
      const pendingFail =
        globalThis.__playwrightPendingByGuarantee?.get(guaranteeKey);
      markInboundTurnLedgerFailedForGuarantee({
        guaranteeKey,
        burstStableIds: pendingFail?.burstStableIds,
        textPreview: String(combinedMessage ?? "").slice(0, 120),
      });
    }
  } finally {
    const playwrightTurnCompleteFinally = playwrightInboundTurnComplete(
      outboundReplyDelivered,
      intentionalSilent
    );
    if (
      guaranteeKey &&
      processingSuccess &&
      (!isPlaywrightWebTabInbound(p) || playwrightTurnCompleteFinally)
    ) {
      setMessageState(guaranteeKey, "done");
      const pendingDone =
        globalThis.__playwrightPendingByGuarantee?.get(guaranteeKey);
      markInboundTurnLedgerDoneForGuarantee({
        guaranteeKey,
        burstStableIds: pendingDone?.burstStableIds,
        replySent: outboundReplyDelivered,
        textPreview: String(combinedMessage ?? "").slice(0, 120),
      });
    } else if (guaranteeKey && !playwrightTurnCompleteFinally) {
      console.log("⚠️ Not marking processed — no reply sent");
    }
    if (isPlaywrightWebTabInbound(p) && messageId) {
      const gk = buildPlaywrightGuaranteeKey(groupNameResolved, messageId);
      if (gk) {
        if (processingSuccess && playwrightTurnCompleteFinally) {
          await advancePlaywrightInboundCompletion(gk, {
            db,
            ownerUserId,
            messageMeta,
          });
        } else {
          const pending = globalThis.__playwrightPendingByGuarantee?.get(gk);
          if (pending?.chatKey) {
            globalThis.__chatResponding =
              globalThis.__chatResponding || Object.create(null);
            globalThis.__chatResponding[pending.chatKey] = false;
          }
          notifyPlaywrightGuaranteeReleased(gk);
          if (globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map) {
            globalThis.__playwrightListenerMsgIdByGuarantee.delete(gk);
          }
        }
      }
    }
    if (pipelineTimeoutId != null) {
      clearTimeout(pipelineTimeoutId);
    }
    console.log("🔓 Releasing locks");
    console.timeEnd("TOTAL_RESPONSE");
    if (isPlaywrightWebTabInbound(p)) {
      globalThis.__ACTIVE_PIPELINE__ = false;
      globalThis.__UI_HARD_LOCK = false;
      console.log("🔓 UI HARD LOCK + active pipeline released (Playwright tab)");
      releasePlaywrightListenerProcessingLocks();
      const chatKey = normalizeTitle(String(groupNameResolved ?? "").trim());
      if (chatKey) {
        globalThis.__chatResponding =
          globalThis.__chatResponding || Object.create(null);
        if (globalThis.__chatResponding[chatKey] !== false) {
          globalThis.__chatResponding[chatKey] = false;
        }
      }
    }
    globalThis.__activeChatInFocus = null;
    globalThis.__activeChatFocusUntil = 0;
    globalThis.__activeJob = null;
    globalThis.__activeJobStart = 0;
    console.log("🔓 FULL LOCK RELEASE");
    if (globalThis.__messageQueue.length > 0) {
      const nextJob = globalThis.__messageQueue.shift();
      if (nextJob) {
        setImmediate(() => {
          void executeWhatsAppAiPipeline(nextJob).catch((e) =>
            console.error("[whatsappInboundBuffer] drain queued pipeline:", e)
          );
        });
      }
    }
    if (isPlaywrightWebTabInbound(p)) {
      scheduleDrainPendingPlaywrightPipelines(p.sessionKey);
    }
  }
}

/**
 * @param {string} promptBlock
 * @returns {Array<{ sender: "user" | "me", text: string }>}
 */
function parseConversationBlockToMessages(promptBlock) {
  const out = [];
  for (const line of String(promptBlock ?? "").split("\n")) {
    const t = line.trim();
    const u = /^User:\s*(.*)$/i.exec(t);
    if (u) {
      out.push({ sender: "user", text: String(u[1] ?? "") });
      continue;
    }
    const a = /^Assistant:\s*(.*)$/i.exec(t);
    if (a) {
      out.push({ sender: "me", text: String(a[1] ?? "") });
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isPoliteClosingMessage(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase().trim();
  const phrases = [
    "no thanks",
    "no thank you",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "thx",
    "ty",
  ];
  return phrases.includes(normalized);
}

/** Release listener chat lock when group gate blocks inbound (Playwright). */
function releasePlaywrightChatLockFromGate(ctx) {
  const title = String(ctx.groupName ?? ctx.chatName ?? "").trim();
  if (!title) return;
  const chatKey = normalizeTitle(title);
  globalThis.__chatResponding = globalThis.__chatResponding || Object.create(null);
  globalThis.__chatResponding[chatKey] = false;
}

/**
 * @param {string} bufferKey
 */
async function flushBufferedWhatsAppInbound(bufferKey) {
  const flushStartedAt = Date.now();
  const entry = messageBuffer.get(bufferKey);
  if (!entry) return;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  releaseStaleActiveJobIfNeeded();

  if (globalThis.__activeJob) {
    entry.retryCount = (entry.retryCount ?? 0) + 1;
    if (entry.retryCount > 20) {
      console.warn("⚠️ retry exceeded — forcing flush");
      console.warn("⚠️ Force releasing stuck job (safe reset)");
      globalThis.__activeJob = null;
      globalThis.__activeJobStart = 0;
      globalThis.__forceProcessing = true;
      entry.retryCount = 0;
    } else {
      console.log("[BUFFER] flush deferred", {
        bufferKey,
        activeJob: globalThis.__activeJob,
        retryCount: entry.retryCount,
        partCount: entry.messageParts?.length || 0,
        waitedMs: Date.now() - flushStartedAt,
      });
      const delay = 100 + Math.random() * 150;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void flushBufferedWhatsAppInbound(bufferKey).catch((e) =>
          console.error("[whatsappInboundBuffer] flush error:", e)
        );
      }, delay);
      return;
    }
  }

  entry.retryCount = 0;
  messageBuffer.delete(bufferKey);

  const parts = [...entry.messageParts];
  const ctx = entry.context;
  if (!ctx || parts.length === 0) return;

  const { combined, structured } = normalizeBufferedMessages(parts);
  if (!combined) return;
  const userMessages = parts
    .map((p) => String(p ?? "").replace(/^\[user\]\s*/i, "").trim())
    .filter(Boolean);
  const latestMessage =
    userMessages[userMessages.length - 1] || String(combined ?? "").trim();
  /** Prior lines in this merged turn (newest-first cap), not slice(-3,-1) which dropped the first fragment when 4+ parts. */
  const priorInTurn = userMessages.slice(0, -1);
  const contextMessages =
    priorInTurn.length > 6 ? priorInTurn.slice(-6) : priorInTurn;
  console.log("🧠 Final Message:", latestMessage);
  console.log("🧠 Context:", contextMessages);

  const fragmentCount = parts.length;
  const hasMultipleFragments = fragmentCount > 1;
  const isGreetingFirst = isFirstFragmentGreeting(parts);

  console.log({
    tag: "[whatsappInboundBuffer] flush",
    combinedMessage: combined,
    structuredSnapshot: structured,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
    isGroupMessage: Boolean(ctx.isGroupMessage),
    originalParts: parts,
  });
  console.log("[latency]", {
    stage: "buffer flush",
    durationMs: Date.now() - flushStartedAt,
    bufferKey,
    fragmentCount,
    hasMultipleFragments,
  });

  const { customerId, channel } = normalizeWhatsAppInboundContext(ctx.userPhone);
  const gateLogFields = buildMessagesOptionalFields({
    channel,
    customerId,
    is_flagged: false,
  });

  const replyTo = String(ctx.whatsappReplyTo ?? ctx.userPhone ?? "").trim();
  const recipientType =
    ctx.whatsappRecipientType === "group" ? "group" : "individual";

  if (ctx.isGroupMessage && WHATSAPP_DEBUG_GROUP) {
    console.log(
      "[whatsappInboundBuffer] WHATSAPP_DEBUG_GROUP: sending ping only (no AI)"
    );
    let dbgGroupSendFailed = false;
    try {
      const dbg = await sendWhatsAppMessage(
        replyTo,
        "Group message received ✅",
        ctx.sendCredentials,
        {
          recipientType,
          fallbackDmTo:
            String(ctx.participantPhoneForDm ?? "").trim() || ctx.userPhone,
          includeGroupDmNotice: true,
        }
      );
      dbgGroupSendFailed = Boolean(dbg?.groupSendFailed);
    } catch (e) {
      console.error("[whatsappInboundBuffer] debug group send error:", e);
    }
    try {
      await ctx.db.collection("messages").add({
        from: ctx.userPhone,
        message: combined,
        reply: "Group message received ✅",
        ownerUserId: ctx.ownerUserId,
        phoneNumberId: ctx.phoneNumberId || null,
        fragmentCount,
        fragmentStructured: structured || null,
        hasMultipleFragments,
        isGreetingFirst,
        debugWhatsappGroup: true,
        is_group: true,
        is_auto_triggered: true,
        createdAt: new Date(),
        ...(dbgGroupSendFailed ? { group_send_failed: true } : {}),
        ...gateLogFields,
      });
    } catch (err) {
      console.error("[whatsappInboundBuffer] debug group log error:", err);
    }
    return;
  }

  if (
    ctx.isGroupMessage &&
    !WHATSAPP_GROUP_GATE_DISABLED &&
    !WHATSAPP_GROUP_DEBUG
  ) {
    const gate = await evaluateWhatsAppGroupInboundGate({
      db: ctx.db,
      ownerUserId: ctx.ownerUserId,
      combinedMessage: combined,
      messageTimestamp: ctx.messageTimestamp ?? null,
      isGroupMessage: true,
    });
    if (!gate.allow) {
      const gk =
        ctx.playwrightWebInbound && ctx.messageId
          ? buildPlaywrightGuaranteeKey(
              String(ctx.groupName ?? ctx.chatName ?? ""),
              ctx.messageId
            )
          : "";
      console.log("🚫 Blocked garbage message", {
        reason: gate.reason ?? "unknown",
        preview: combined.slice(0, 96),
      });
      releasePlaywrightChatLockFromGate(ctx);
      if (gk) {
        markPlaywrightGroupGateBlockedProcessed(gk);
        const pendingGate = globalThis.__playwrightPendingByGuarantee?.get(gk);
        markInboundTurnLedgerFailedForGuarantee({
          guaranteeKey: gk,
          burstStableIds: pendingGate?.burstStableIds,
          textPreview: combined.slice(0, 120),
        });
      }
      try {
        await ctx.db.collection("messages").add({
          from: ctx.userPhone,
          message: combined,
          reply: null,
          ownerUserId: ctx.ownerUserId,
          phoneNumberId: ctx.phoneNumberId || null,
          fragmentCount,
          fragmentStructured: structured || null,
          hasMultipleFragments,
          isGreetingFirst,
          skippedReason: "group_gate",
          groupGate: {
            reason: gate.reason ?? "unknown",
            matchScore: gate.matchScore,
            phraseCount: gate.phraseCount,
            hasQuestionOrRequest: gate.hasQuestionOrRequest,
          },
          is_group: true,
          is_auto_triggered: true,
          createdAt: new Date(),
          ...gateLogFields,
        });
      } catch (err) {
        console.error("[whatsappInboundBuffer] group gate log error:", err);
      }
      return;
    }
    console.log("✅ Message allowed to pipeline");
  } else if (
    ctx.isGroupMessage &&
    (WHATSAPP_GROUP_GATE_DISABLED || WHATSAPP_GROUP_DEBUG)
  ) {
    console.log(
      "[whatsappInboundBuffer] group gate skipped:",
      WHATSAPP_GROUP_DEBUG
        ? "WHATSAPP_GROUP_DEBUG"
        : "WHATSAPP_GROUP_GATE_DISABLED"
    );
  }

  const traceId = randomUUID();
  const pipelineStartedAt = Date.now();
  await executeWhatsAppAiPipeline({
    ...ctx,
    traceId,
    combinedMessage: combined,
    latestMessage,
    contextMessages,
    structuredSnapshot: structured,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
  });
  console.log("[latency]", {
    traceId,
    stage: "buffer flush pipeline handoff",
    durationMs: Date.now() - pipelineStartedAt,
    totalMs: Date.now() - flushStartedAt,
    bufferKey,
  });
}

/**
 * @param {BufferEntry} entry
 * @param {string} latestTrimmed
 * @param {FlushContext} payload
 * @param {number} myGen
 */
async function armFlushTimer(bufferKey, entry, latestTrimmed, payload, myGen) {
  const baseDelay = DEBOUNCE_MS;
  const partCount = entry.messageParts.length;
  let thinHistory = false;
  if (partCount === 1 && latestTrimmed.length < 10 && payload.db) {
    try {
      const hist = await getRecentConversationForPrompt(
        payload.db,
        payload.ownerUserId,
        payload.userPhone,
        10
      );
      if (entry.scheduleGen !== myGen) return;
      thinHistory =
        !hist || String(hist).replace(/\s/g, "").length < 40;
    } catch {
      if (entry.scheduleGen !== myGen) return;
      thinHistory = true;
    }
  }

  if (entry.scheduleGen !== myGen) return;

  const delayMs = computeDebounceDelayMs(
    latestTrimmed,
    partCount,
    baseDelay,
    thinHistory
  );

  if (entry.scheduleGen !== myGen) return;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    flushBufferedWhatsAppInbound(bufferKey).catch((e) =>
      console.error("[whatsappInboundBuffer] flush error:", e)
    );
  }, delayMs);

  console.log({
    tag: "[whatsappInboundBuffer] queued",
    debounceMs: delayMs,
    fragmentCount: partCount,
    session: bufferKey,
    latestFragmentPreview: latestTrimmed.slice(0, 48),
  });
}

/**
 * Queue an inbound text line; after debounced quiet, merge and run one AI turn.
 * @param {FlushContext & { text: string }} payload
 */
export function scheduleBufferedWhatsAppInbound(payload) {
  const {
    db,
    ownerUserId,
    userPhone,
    sessionKey,
    sendCredentials,
    phoneNumberId,
    source,
    dmPlaywrightChatKey,
    dmChatTitle,
    bookingHint,
    text,
    isGroupMessage = false,
    whatsappReplyTo,
    whatsappRecipientType,
    conversationCustomerNumber,
    participantPhoneForDm: participantPhoneForDmPayload,
    participantName: participantNamePayload,
    participantKey: participantKeyPayload,
    messageId: messageIdPayload,
    messageTimestamp,
    messageSender: messageSenderPayload,
    playwrightWebInbound: playwrightWebInboundPayload = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityPayload = false,
    groupName: groupNamePayload,
    chatName: chatNamePayload,
    inboundIntent: inboundIntentPayload = null,
    inboundEntity: inboundEntityPayload = null,
    resetTopicContext: resetTopicContextPayload = false,
    playwrightChatKey: playwrightChatKeyPayload = null,
    sourceRowKey: sourceRowKeyPayload = null,
    sourceMessageIndex: sourceMessageIndexPayload = null,
  } = payload;

  const sessionKeyResolved =
    String(sessionKey ?? "").trim() || `${ownerUserId}::${userPhone}`;
  const isGroupChat =
    isGroupMessage === true ||
    whatsappRecipientType === "group" ||
    String(whatsappReplyTo ?? "").trim().endsWith("@g.us");
  const senderId =
    String(
      conversationCustomerNumber ??
        participantPhoneForDmPayload ??
        messageSenderPayload ??
        userPhone ??
        ""
    ).trim() || "";
  if (isGroupChat) {
    console.log("🧠 Session isolation:", {
      chatId: String(whatsappReplyTo ?? "").trim() || String(userPhone ?? "").trim(),
      senderId,
      sessionKey: sessionKeyResolved,
      isGroupChat: true,
    });
  }
  const isPlaywrightImmediate =
    String(userPhone ?? "").trim() === "unknown" &&
    (isGroupMessage === true || playwrightWebInboundPayload === true);
  const playwrightImmediateBufferKey =
    isPlaywrightImmediate && String(messageIdPayload ?? "").trim()
      ? `${sessionKeyResolved}::${String(messageIdPayload).trim()}`
      : sessionKeyResolved;
  const key = playwrightImmediateBufferKey;
  let entry = messageBuffer.get(key);
  if (!entry) {
    entry = {
      messageParts: [],
      timer: null,
      context: null,
      scheduleGen: 0,
    };
    messageBuffer.set(key, entry);
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.scheduleGen += 1;
  const myGen = entry.scheduleGen;

  const trimmed = String(text ?? "").trim();
  const nowForBurst = Date.now();
  const prevFragmentAt = entry.lastUpdatedAt ?? null;
  if (trimmed) {
    entry.messageParts.push(trimmed);
    entry.lastUpdatedAt = nowForBurst;
    console.log("📦 Added to buffer", {
      key,
      partCount: entry.messageParts.length,
    });
  }

  let replyToMerged =
    String(whatsappReplyTo ?? "").trim() ||
    String(entry.context?.whatsappReplyTo ?? "").trim() ||
    String(userPhone ?? "").replace(/\D/g, "");
  const convCustomerMerged =
    String(conversationCustomerNumber ?? "").trim() ||
    entry.context?.conversationCustomerNumber ||
    String(userPhone ?? "").replace(/\D/g, "");
  const recipientTypeMerged =
    whatsappRecipientType === "group" || entry.context?.whatsappRecipientType === "group"
      ? "group"
      : "individual";

  const participantPhoneDmMerged =
    String(participantPhoneForDmPayload ?? "").trim() ||
    String(entry.context?.participantPhoneForDm ?? "").trim();
  const participantKeyMerged =
    String(participantKeyPayload ?? "").trim() ||
    String(entry.context?.participantKey ?? "").trim();

  const normalizeParticipantName = (value) => {
    const raw = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    // Ignore sentinel / internal values; never derive names from participantKey.
    if (lower === "scope") return "";
    if (lower.startsWith("scope::")) return "";
    if (lower === "user") return "";
    if (lower === "me") return "";
    return raw;
  };
  const participantNameIncoming = normalizeParticipantName(participantNamePayload);
  const participantNameExisting = normalizeParticipantName(entry.context?.participantName);
  const participantNameMerged = participantNameIncoming || participantNameExisting;

  entry.context = {
    db,
    ownerUserId,
    userPhone,
    sessionKey: sessionKeyResolved,
    sendCredentials: {
      accessToken: String(sendCredentials.accessToken ?? ""),
      phoneNumberId: String(sendCredentials.phoneNumberId ?? ""),
    },
    phoneNumberId: phoneNumberId != null ? String(phoneNumberId) : null,
    ...(source !== undefined ? { source } : {}),
    ...(dmPlaywrightChatKey !== undefined ? { dmPlaywrightChatKey } : {}),
    ...(dmChatTitle !== undefined ? { dmChatTitle } : {}),
    ...(bookingHint !== undefined ? { bookingHint } : {}),
    isGroupMessage:
      Boolean(isGroupMessage) || Boolean(entry.context?.isGroupMessage),
    whatsappReplyTo: replyToMerged,
    whatsappRecipientType: recipientTypeMerged,
    conversationCustomerNumber: convCustomerMerged,
    ...(participantPhoneDmMerged
      ? { participantPhoneForDm: participantPhoneDmMerged }
      : {}),
    ...(participantKeyMerged ? { participantKey: participantKeyMerged } : {}),
    ...(participantNameMerged ? { participantName: participantNameMerged } : {}),
    messageId:
      messageIdPayload != null
        ? String(messageIdPayload)
        : String(entry.context?.messageId ?? ""),
    messageTimestamp: messageTimestamp ?? null,
    messageSender:
      String(messageSenderPayload ?? "").trim() ||
      String(entry.context?.messageSender ?? "").trim() ||
      "user",
    playwrightWebInbound:
      Boolean(playwrightWebInboundPayload) ||
      Boolean(entry.context?.playwrightWebInbound),
    playwrightWebTitleIdentity:
      Boolean(playwrightWebTitleIdentityPayload) ||
      Boolean(entry.context?.playwrightWebTitleIdentity),
    groupName:
      String(groupNamePayload ?? entry.context?.groupName ?? "").trim() ||
      undefined,
    chatName:
      String(chatNamePayload ?? entry.context?.chatName ?? "").trim() ||
      undefined,
    inboundIntent:
      inboundIntentPayload != null &&
      String(inboundIntentPayload).trim() !== ""
        ? String(inboundIntentPayload).trim().toLowerCase()
        : entry.context?.inboundIntent != null &&
            String(entry.context.inboundIntent).trim() !== ""
          ? String(entry.context.inboundIntent).trim().toLowerCase()
          : null,
    inboundEntity:
      inboundEntityPayload != null &&
      String(inboundEntityPayload).trim() !== ""
        ? String(inboundEntityPayload).trim()
        : entry.context?.inboundEntity != null &&
            String(entry.context.inboundEntity).trim() !== ""
          ? String(entry.context.inboundEntity).trim()
          : null,
    resetTopicContext:
      Boolean(resetTopicContextPayload) ||
      Boolean(entry.context?.resetTopicContext),
    playwrightChatKey:
      playwrightChatKeyPayload != null &&
      String(playwrightChatKeyPayload).trim() !== ""
        ? String(playwrightChatKeyPayload).trim()
        : entry.context?.playwrightChatKey != null &&
            String(entry.context.playwrightChatKey).trim() !== ""
          ? String(entry.context.playwrightChatKey).trim()
          : null,
    sourceRowKey:
      sourceRowKeyPayload != null && String(sourceRowKeyPayload).trim() !== ""
        ? String(sourceRowKeyPayload).trim()
        : entry.context?.sourceRowKey != null &&
            String(entry.context.sourceRowKey).trim() !== ""
          ? String(entry.context.sourceRowKey).trim()
          : null,
    sourceMessageIndex:
      sourceMessageIndexPayload != null &&
      Number.isFinite(Number(sourceMessageIndexPayload))
        ? Number(sourceMessageIndexPayload)
        : entry.context?.sourceMessageIndex != null &&
            Number.isFinite(Number(entry.context.sourceMessageIndex))
          ? Number(entry.context.sourceMessageIndex)
          : null,
  };

  if (participantNameIncoming && participantNameIncoming !== participantNameExisting) {
    console.log("[buffer_participant_name_preserved]", {
      participantName: participantNameIncoming,
      participantKey: participantKeyMerged || null,
      messagePreview: String(trimmed ?? "").slice(0, 80) || null,
    });
  }

  if (isPlaywrightImmediate) {
    entry.messageParts = trimmed ? [trimmed] : [];
    entry.lastUpdatedAt = nowForBurst;
    console.log("[whatsappInboundBuffer] Playwright immediate flush", {
      bufferKey: key,
      sessionKey: sessionKeyResolved,
      messageId: String(messageIdPayload ?? "").trim() || "(missing)",
    });
    void flushBufferedWhatsAppInbound(key).catch((e) =>
      console.error("[whatsappInboundBuffer] immediate playwright flush error:", e)
    );
    return;
  }

  const fragmentCount = entry.messageParts.length;
  const rapidBurst =
    prevFragmentAt != null &&
    nowForBurst - prevFragmentAt < FRAGMENT_BURST_WINDOW_MS;

  if (
    fragmentCount > FRAGMENT_COUNT_IMMEDIATE_FLUSH &&
    rapidBurst
  ) {
    console.log("⚡ Burst detected — flushing immediately", {
      fragmentCount,
      threshold: FRAGMENT_COUNT_IMMEDIATE_FLUSH,
      burstWindowMs: FRAGMENT_BURST_WINDOW_MS,
      session: key,
    });
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void flushBufferedWhatsAppInbound(key).catch((e) =>
      console.error("[whatsappInboundBuffer] immediate flush error:", e)
    );
    return;
  }

  const snapshot = { ...entry.context };

  void (async () => {
    await armFlushTimer(key, entry, trimmed, snapshot, myGen);
  })();
}

/** For tests / diagnostics */
export function __clearWhatsAppInboundBufferForTests() {
  for (const [, e] of messageBuffer) {
    if (e.timer) clearTimeout(e.timer);
  }
  messageBuffer.clear();
  pendingPlaywrightPipelineBySession.clear();
  lastSentReplies.clear();
  lastPlaywrightTextSends.clear();
}

/** For tests: peek current buffer context (readonly). */
export function __peekWhatsAppInboundBufferForTests(bufferKey) {
  const key = String(bufferKey ?? "").trim();
  const entry = key ? messageBuffer.get(key) : null;
  const ctx = entry?.context && typeof entry.context === "object" ? entry.context : null;
  return ctx ? { ...ctx } : null;
}

/** @param {Parameters<typeof isIntentionalSilentInboundResult>[0]} p */
export function __isIntentionalSilentInboundResultForTests(p) {
  return isIntentionalSilentInboundResult(p);
}

/** @param {boolean} outboundReplyDelivered @param {boolean} intentionalSilent */
export function __playwrightInboundTurnCompleteForTests(
  outboundReplyDelivered,
  intentionalSilent
) {
  return playwrightInboundTurnComplete(outboundReplyDelivered, intentionalSilent);
}

/**
 * @internal Tests — stale merged catch-up ack noop → intentional silent (no Theek hai).
 */
export function __applyStaleAckNoopSuppressionForTests({
  suppressAckNoopOutbound = false,
  reply = "Theek hai 👍",
  sendVia = "CLOUD_API",
  messageMeta = { outboundTrace: { finalReplySource: "PURE_ACK_NOOP" } },
} = {}) {
  let outReply = reply;
  let outSendVia = sendVia;
  let outMeta =
    messageMeta && typeof messageMeta === "object" ? { ...messageMeta } : {};
  const finalReplySourceFromMeta = String(
    outMeta?.outboundTrace?.finalReplySource ?? ""
  ).trim();
  if (suppressAckNoopOutbound && finalReplySourceFromMeta === "PURE_ACK_NOOP") {
    outReply = "";
    outSendVia = "NONE";
    outMeta = {
      ...outMeta,
      handledWithoutOutbound: true,
      outboundTrace: {
        ...(outMeta?.outboundTrace && typeof outMeta.outboundTrace === "object"
          ? outMeta.outboundTrace
          : {}),
        finalReplySource: "PURE_ACK_NOOP",
        kind: "silent_noop",
      },
    };
  }
  return { reply: outReply, sendVia: outSendVia, messageMeta: outMeta };
}

/** @internal Tests — persist cursor after successful Playwright turn. */
export async function __advancePlaywrightInboundCompletionForTests(gk, opts = {}) {
  return advancePlaywrightInboundCompletion(gk, opts);
}

/** Same as {@link __clearWhatsAppInboundBufferForTests} — public name for dev / HTTP / signals. */
export const clearWhatsAppInboundMessageCaches =
  __clearWhatsAppInboundBufferForTests;
