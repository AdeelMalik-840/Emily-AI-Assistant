/**
 * Debounced merge of rapid consecutive WhatsApp text messages per customer thread,
 * then a single Brain V2 turn + outbound send (human-like handling of fragments).
 */

import { createHash } from "node:crypto";
import { resolveTrustedPreviousItemContinuation } from "../brain/context/previousItemContinuationResolver.js";
import {
  brainV2TimeoutMs,
  runBrainV2WithinBoundary,
} from "../brain/live/brainV2ExecutionBoundary.js";
import { validateBrainV2PipelineResult } from "../brain/live/brainV2ResultContract.js";
import { assertExecutionOwnership } from "./executors/executionOwnershipGuard.js";
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
  handleAvailabilityRequestApproval,
  parseAvailabilityApprovalMessage,
} from "./availabilityApprovalService.js";
import { evaluateAvailabilityWaitingConfirmOwnershipGuard } from "./availabilityRequestService.js";
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
  claimCloudInboundTurn,
  claimOutboundLockedRecovery,
  markCloudInboundTurnOwnershipQueued,
  markCloudInboundTurnNormalRouting,
  markCloudInboundTurnPostConfirmOwned,
  markCloudInboundTurnOutboundLocked,
  markCloudInboundTurnRetryableFailure,
  markCloudInboundTurnTerminalTechnicalFailure,
  markCloudInboundTurnDone,
  markInboundTurnLedgerDoneForGuarantee,
  markInboundTurnLedgerFailedForGuarantee,
  markInboundTurnLedgerOutboundLockedForGuarantee,
  markOutboundLockedRecoverySent,
  releaseOutboundLockedRecoveryClaim,
  resolveInboundTurnAdmissionBlock,
} from "./inboundTurnLedger.js";
import { tryRecoverOutboundLockedInboundTurn } from "./outboundLockedRecovery.js";
import { tryRecoverCloudOutboundLockedTurn } from "./cloudInboundRecovery.js";
import { setMessageState } from "./messageState.js";
import {
  normalizePlaywrightOutboundTrace,
  savePlaywrightInboundCursor,
} from "./playwrightInboundCursorStore.js";
import {
  getEmilySessionState,
  peekEmilySessionState,
} from "./conversationIntelligence.js";
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
import {
  evaluateBrainRouteGate,
  buildBrainRouteGateLogPayload,
  isLegacyProcessMessageAllowed,
  shouldLogBrainV2ExpectedButNotSelected,
  buildHardBlockedPipelineResult,
  BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY,
} from "../brain/live/brainRouteGate.js";

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

function envTruthyFlag(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Fast gate for log-only v2 shadow — avoids importing src/brain when disabled.
 * @param {string | null | undefined} businessId
 */
export function isEmilyBrainV2ShadowQuickGate(businessId) {
  if (!envTruthyFlag("EMILY_BRAIN_V2_SHADOW")) return false;
  if (
    !envTruthyFlag("EMILY_BRAIN_V2_SHADOW_ALLOW_PRODUCTION") &&
    String(process.env.NODE_ENV ?? "").trim() === "production"
  ) {
    return false;
  }
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = String(process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowlist.length) return false;
  return allowlist.includes(uid);
}

/**
 * Fast gate for v2 informational live — avoids importing src/brain when disabled.
 * @param {string | null | undefined} businessId
 */
export function isEmilyBrainV2InfoLiveQuickGate(businessId) {
  if (!envTruthyFlag("EMILY_BRAIN_V2_INFO_LIVE")) return false;
  if (
    !envTruthyFlag("EMILY_BRAIN_V2_PRODUCTION_ALLOW") &&
    String(process.env.NODE_ENV ?? "").trim() === "production"
  ) {
    return false;
  }
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = String(process.env.EMILY_BRAIN_V2_INFO_BUSINESSES ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowlist.length) return false;
  return allowlist.includes(uid);
}

/**
 * Fast gate for v2 full live brain — avoids importing src/brain when disabled.
 * @param {string | null | undefined} businessId
 */
export function isEmilyBrainV2LiveQuickGate(businessId) {
  const gate = evaluateBrainRouteGate({ businessId });
  return gate.selected === "v2_live";
}

/**
 * @param {{
 *   businessId: string,
 *   isPlaywrightDmWithIdentity?: boolean,
 *   bookingHint?: unknown,
 * }} p
 * @returns {"v2_live" | "blocked"}
 */
export function evaluateInboundBrainRoute(p) {
  const gate = evaluateBrainRouteGate({ businessId: p.businessId });
  if (gate.selected === "v2_live") return "v2_live";
  return "blocked";
}

function cleanBookingValue(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeBookingItemFromHint(hint) {
  if (!hint || typeof hint !== "object" || Array.isArray(hint)) return null;
  const itemId = cleanBookingValue(hint?.itemId ?? hint?.inventoryItemId);
  const itemName = cleanBookingValue(hint?.itemName ?? hint?.itemLabel ?? hint?.name);
  if (!itemId) return null;
  return {
    id: itemId,
    itemId,
    name: itemName || null,
    displayLabel: itemName || null,
  };
}

function normalizeBookingItemFromRecord(booking) {
  if (!booking || typeof booking !== "object" || Array.isArray(booking)) return null;
  const itemId = cleanBookingValue(
    booking?.itemId ?? booking?.inventoryItemId ?? booking?.item?.id
  );
  if (!itemId) return null;
  const itemName = cleanBookingValue(
    booking?.itemName ??
      booking?.itemLabel ??
      booking?.itemDisplayLabel ??
      booking?.name ??
      booking?.item?.name
  );
  const displayLabel = cleanBookingValue(
    booking?.itemDisplayLabel ??
      booking?.itemLabel ??
      booking?.displayLabel ??
      itemName
  );
  return {
    id: itemId,
    itemId,
    name: itemName || displayLabel || null,
    displayLabel: displayLabel || itemName || null,
  };
}

async function loadDmHandoffBookingItem({ db, businessId, bookingHint, traceId }) {
  const hint = bookingHint && typeof bookingHint === "object" ? bookingHint : null;
  if (!hint) return null;
  const fromHint = normalizeBookingItemFromHint(hint);
  if (fromHint) {
    console.log("[brain_v2_dm_handoff_item_hint]", {
      traceId: traceId || null,
      bookingId: cleanBookingValue(hint?.bookingId) || null,
      itemId: fromHint.itemId,
    });
    return fromHint;
  }
  const bookingId = cleanBookingValue(hint?.bookingId);
  if (!bookingId || !db) return null;
  try {
    const snap = await db
      .collection("businesses")
      .doc(String(businessId ?? "").trim())
      .collection("bookings")
      .doc(bookingId)
      .get();
    if (!snap?.exists) {
      console.log("[brain_v2_dm_handoff_booking_missing]", {
        traceId: traceId || null,
        bookingId,
      });
      return null;
    }
    const booking = snap.data() || {};
    const normalized = normalizeBookingItemFromRecord(booking);
    if (!normalized) {
      console.log("[brain_v2_dm_handoff_item_missing]", {
        traceId: traceId || null,
        bookingId,
      });
      return null;
    }
    console.log("[brain_v2_dm_handoff_item_loaded]", {
      traceId: traceId || null,
      bookingId,
      itemId: normalized.itemId,
    });
    return normalized;
  } catch (err) {
    console.warn("[brain_v2_dm_handoff_booking_failed]", {
      traceId: traceId || null,
      bookingId,
      reason: String(err?.message ?? err ?? "UNKNOWN").slice(0, 160),
    });
    return null;
  }
}

function applyDmHandoffItemToMemorySnapshot({
  snapshot,
  bookingItem,
  bookingHint,
  traceId,
}) {
  if (!bookingItem || !bookingItem.itemId) return snapshot;
  const next =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : {};
  const bookingId = cleanBookingValue(bookingHint?.bookingId) || null;
  next.lastItem = {
    id: bookingItem.itemId,
    itemId: bookingItem.itemId,
    name: bookingItem.name ?? bookingItem.displayLabel ?? null,
    displayLabel: bookingItem.displayLabel ?? bookingItem.name ?? null,
  };
  next.lastResolvedItemId = bookingItem.itemId;
  console.log("[brain_v2_dm_handoff_memory_applied]", {
    traceId: traceId || null,
    bookingId,
    itemId: bookingItem.itemId,
  });
  return next;
}

/**
 * Attempt the sole Brain V2 semantic route. Failures return the controlled V2 policy.
 * @param {Record<string, unknown>} params
 */
export async function tryBrainV2LiveBeforeLegacy(params) {
  try {
    const liveModule = await import("../brain/live/brainV2LivePipeline.js");
    const runLive = /** @type {typeof import("../brain/live/brainV2LivePipeline.js").runBrainV2LivePipeline} */ (
      liveModule.runBrainV2LivePipeline
    );
    const resolveTrustedSessionItem =
      typeof params.resolveTrustedSessionItem === "function"
        ? params.resolveTrustedSessionItem
        : resolveTrustedPreviousItemContinuation;
    return await runLive({
      ...params,
      resolveTrustedSessionItem:
        typeof resolveTrustedSessionItem === "function"
          ? (trustedArgs) => resolveTrustedSessionItem(trustedArgs)
          : undefined,
    });
  } catch (err) {
    console.warn("[brain_v2_live_failed]", {
      traceId: params?.traceId,
      businessId: params?.businessId,
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
    return {
      handled: true,
      reply:
        "Sorry, main abhi reply nahi bhej pa rahi. Thori der baad dobara try karein please.",
      sendVia: params?.isGroupInbound ? "GROUP" : "CLOUD_API",
      messageMeta: {
        brainV2Live: true,
        outboundTrace: { finalReplySource: "BRAIN_V2_LIVE_ERROR" },
      },
      reason: "V2_LIVE_ERROR",
      legacyBypassed: true,
    };
  }
}

/**
 * Compatibility adapter for the retired informational-only V2 route.
 * @param {Record<string, unknown>} params
 */
export async function tryBrainV2InfoLiveBeforeLegacy(params) {
  try {
    const liveModule = await import("../brain/live/brainV2InfoLiveAdapter.js");
    const tryLive = /** @type {typeof import("../brain/live/brainV2InfoLiveAdapter.js").tryBrainV2InfoLiveTurn} */ (
      liveModule.tryBrainV2InfoLiveTurn
    );
    const resolveTrustedSessionItem =
      typeof params.resolveTrustedSessionItem === "function"
        ? params.resolveTrustedSessionItem
        : resolveTrustedPreviousItemContinuation;
    return await tryLive({
      ...params,
      resolveTrustedSessionItem:
        typeof resolveTrustedSessionItem === "function"
          ? (trustedArgs) => resolveTrustedSessionItem(trustedArgs)
          : undefined,
    });
  } catch (err) {
    console.warn("[emily_brain_v2_info_live_failed]", {
      traceId: params?.traceId,
      businessId: params?.businessId,
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
    return { handled: false, reason: "INFO_LIVE_ERROR" };
  }
}

/**
 * Capture pre-legacy state without initializing the Emily session store.
 * Dependencies are injectable so wiring safety can be tested without module mocks.
 *
 * @param {{
 *   shadowEligible: boolean,
 *   businessId: string,
 *   ownerUserId?: string,
 *   sessionKey?: string,
 *   participantKey?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   resolveSessionKey?: (p: Record<string, unknown>) => string,
 *   peekSessionState?: (sessionKey: string) => Record<string, unknown> | null,
 *   loadShadowModule?: () => Promise<Record<string, unknown>>,
 *   traceId?: string,
 * }} p
 */
/**
 * Load Emily session memory for v2 live/shadow paths (no shadow flag required).
 * @param {{
 *   businessId: string,
 *   ownerUserId?: string,
 *   sessionKey?: string,
 *   participantKey?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   resolveSessionKey?: (p: Record<string, unknown>) => string,
 *   peekSessionState?: (sessionKey: string) => Record<string, unknown> | null,
 *   loadShadowModule?: () => Promise<Record<string, unknown>>,
 *   traceId?: string,
 * }} p
 */
export async function loadBrainV2SessionMemorySnapshot(p) {
  try {
    let resolveSessionKey = p.resolveSessionKey;
    if (typeof resolveSessionKey !== "function") {
      const shadowModule = await (p.loadShadowModule ?? (() =>
        import("../brain/shadow/brainShadowHook.js")))();
      resolveSessionKey = /** @type {(p: Record<string, unknown>) => string} */ (
        shadowModule.resolveShadowEmilySessionKey
      );
    }
    const emilySessionKey = resolveSessionKey({
      businessId: p.businessId,
      ownerUserId: p.ownerUserId,
      sessionKey: p.sessionKey,
      participantKey: p.participantKey,
      playwrightChatKey: p.playwrightChatKey,
      isGroupInbound: p.isGroupInbound,
    });
    const existingState = (p.peekSessionState ?? peekEmilySessionState)(
      emilySessionKey
    );
    return existingState == null ? null : structuredClone(existingState);
  } catch (err) {
    console.log("[brain_v2_memory_prep_failed]", {
      traceId: p.traceId,
      businessId: p.businessId,
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
    return null;
  }
}

/** @param {Parameters<typeof loadBrainV2SessionMemorySnapshot>[0]} p */
export async function prepareBrainV2LiveMemorySnapshot(p) {
  return loadBrainV2SessionMemorySnapshot(p);
}

export async function prepareEmilyBrainV2ShadowMemorySnapshot(p) {
  if (!p.shadowEligible) return null;
  return loadBrainV2SessionMemorySnapshot(p);
}

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
 * in semantic processing — the early active-job guard used to drop that work entirely (e.g. KIA Stonic
 * batch lost while "Jee krwani hai" batch ran). Queue and run FIFO after each job completes.
 * @type {Map<string, object[]>}
 */
const pendingPlaywrightPipelineBySession = new Map();
const pendingCloudRetryTimersByGuarantee = new Map();

/**
 * Temporary development gate for post-confirm model-contract auto-replay storms.
 * Durable failure marking remains; timers/recovery auto-replay are paused unless
 * CLOUD_POST_CONFIRM_AUTO_RETRY=1|true|on.
 * Re-enable after the structured-output contract fix is validated in production.
 */
export function isCloudPostConfirmAutoRetryEnabled() {
  const raw = String(process.env.CLOUD_POST_CONFIRM_AUTO_RETRY ?? "0")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** @param {unknown} lastError */
export function isPostConfirmModelContractFailureError(lastError) {
  const err = String(lastError ?? "");
  return (
    /EMPTY_OR_INVALID_OPENAI_REPLY/i.test(err) ||
    /OPENAI_POST_CONFIRM_FAILED/i.test(err) ||
    /OPENAI_POST_CONFIRM_MODEL_CONTRACT/i.test(err) ||
    /OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE/i.test(err) ||
    /INFORMATIONAL_COMPOSE_EMPTY_REPLY/i.test(err) ||
    /customer_reply_required_but_empty/i.test(err) ||
    // Exhausted in-decision claim-guard mismatches must not auto-replay storms.
    /verified_item_mismatch/i.test(err) ||
    /verified_duration_mismatch/i.test(err) ||
    /verified_booking_status_mismatch/i.test(err) ||
    /verified_booking_reference_mismatch/i.test(err) ||
    /verified_price_mismatch/i.test(err) ||
    /verified_booking_date_mismatch/i.test(err) ||
    /verified_booking_time_mismatch/i.test(err) ||
    /verified_policy_mismatch/i.test(err)
  );
}

/**
 * @param {unknown} lastError
 * @returns {boolean} true when this failure should not auto-replay right now
 */
export function shouldPauseCloudPostConfirmModelContractAutoRetry(lastError) {
  return (
    !isCloudPostConfirmAutoRetryEnabled() &&
    isPostConfirmModelContractFailureError(lastError)
  );
}

function scheduleCloudPostConfirmRetry(
  p,
  identity,
  retryCount,
  claimOwner = null,
  lastError = null
) {
  const guaranteeKey = String(identity?.guaranteeKey ?? "").trim();
  if (!guaranteeKey || retryCount > 5) return;
  if (shouldPauseCloudPostConfirmModelContractAutoRetry(lastError)) {
    console.warn("[cloud_post_confirm_auto_retry_paused]", {
      guaranteeKey,
      retryCount,
      lastError: String(lastError ?? "").slice(0, 120) || null,
    });
    return;
  }
  if (pendingCloudRetryTimersByGuarantee.has(guaranteeKey)) return;
  const delayMs = Math.min(30_000, 500 * 2 ** Math.max(0, retryCount - 1));
  const timer = setTimeout(() => {
    pendingCloudRetryTimersByGuarantee.delete(guaranteeKey);
    void executeWhatsAppAiPipeline({
      ...p,
      __cloudResumeProcessing: true,
      // The queued token is single-use: only queued -> resuming may consume it.
      __cloudQueuedOwnershipResume: false,
      __cloudClaimOwner:
        String(claimOwner ?? p.__cloudClaimOwner ?? "").trim() || null,
      traceId: randomUUID(),
    }).catch((err) => {
      console.warn("[cloud_post_confirm_retry_failed]", {
        guaranteeKey,
        error: String(err?.message ?? err ?? "").slice(0, 160),
      });
    });
  }, delayMs);
  timer.unref?.();
  pendingCloudRetryTimersByGuarantee.set(guaranteeKey, timer);
}
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
 *   executionContext?: Record<string, unknown>,
 * }} p
 */
async function triggerBusinessBookingNotification({
  traceId,
  db,
  userId,
  booking,
  customerPhone,
  sendCredentials,
  executionContext = {},
}) {
  assertExecutionOwnership(executionContext);
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
    assertExecutionOwnership(executionContext);
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
  assertExecutionOwnership(executionContext);
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
  assertExecutionOwnership(executionContext);
  await markBookingNotificationSending(db, userId, bookingId);
  assertExecutionOwnership(executionContext);
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
      sendCredentials ?? undefined,
      { signal: executionContext?.abortSignal }
    );
    assertExecutionOwnership(executionContext);
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
        { recipientType: "individual", signal: executionContext?.abortSignal }
      );
      assertExecutionOwnership(executionContext);
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
    if (executionContext?.abortSignal?.aborted) throw err;
    sendFailureDetail = String(err?.message ?? err ?? "unknown");
    console.warn("❌ WhatsApp send threw error:", sendFailureDetail);
  }

  if (!sendSucceeded) {
    assertExecutionOwnership(executionContext);
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

  assertExecutionOwnership(executionContext);
  await markBookingNotificationSent(db, userId, bookingId);
  await markBookingNotificationProviderAccepted({
    db,
    userId,
    bookingId,
    providerMessageId,
  });
  assertExecutionOwnership(executionContext);

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

export function shouldOutboundLockPlaywrightGroupSend({
  isTabInbound,
  isGroupMessage,
  unknownPhone,
  playwrightNoSend,
} = {}) {
  return Boolean(
    isTabInbound === true &&
      isGroupMessage === true &&
      unknownPhone === true &&
      playwrightNoSend !== true
  );
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
  if (String(meta.routeType ?? "").trim() === "BRAIN_V2_LIVE_SILENT") return true;
  if (String(meta.reason ?? "").trim() === "ASSIST_CONTEXT_NO_REPLY") return true;
  const trace =
    meta.outboundTrace && typeof meta.outboundTrace === "object"
      ? meta.outboundTrace
      : null;
  if (!trace) return false;
  if (String(trace.kind ?? "").trim() === "silent_noop") return true;
  if (String(trace.finalReplySource ?? "").trim() === "PURE_ACK_SILENT") return true;
  if (String(trace.finalReplySource ?? "").trim() === "BRAIN_V2_LIVE_SILENT") {
    return true;
  }
  if (String(trace.reason ?? "").trim() === "ASSIST_CONTEXT_NO_REPLY") return true;
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
 * Admit-turn ledger completion: done (reply or intentional silent) or failed.
 * Never leave Playwright inbound stuck in processing for empty/no-send.
 *
 * @param {{
 *   guaranteeKey: string,
 *   isPlaywrightWebTab: boolean,
 *   processingSuccess: boolean,
 *   outboundReplyDelivered: boolean,
 *   intentionalSilent: boolean,
 *   burstStableIds?: string[],
 *   textPreview?: string,
 *   lastError?: string | null,
 * }} p
 * @returns {"done" | "failed" | "noop"}
 */
function finalizeAdmittedInboundTurnLedger(p) {
  const guaranteeKey = String(p?.guaranteeKey ?? "").trim();
  if (!guaranteeKey) return "noop";
  const outboundReplyDelivered = Boolean(p.outboundReplyDelivered);
  const intentionalSilent = Boolean(p.intentionalSilent);
  const processingSuccess = Boolean(p.processingSuccess);
  const isPlaywrightWebTab = Boolean(p.isPlaywrightWebTab);
  const turnComplete = playwrightInboundTurnComplete(
    outboundReplyDelivered,
    intentionalSilent
  );
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  const burstStableIds = p.burstStableIds;
  if (processingSuccess && (!isPlaywrightWebTab || turnComplete)) {
    setMessageState(guaranteeKey, "done");
    markInboundTurnLedgerDoneForGuarantee({
      guaranteeKey,
      burstStableIds,
      replySent: outboundReplyDelivered,
      textPreview,
    });
    return "done";
  }
  if (isPlaywrightWebTab && !turnComplete) {
    console.log("⚠️ No reply sent — marking inbound ledger failed", {
      guaranteeKey,
      lastError: p.lastError ?? "no_outbound_incomplete",
    });
    setMessageState(guaranteeKey, "failed");
    markInboundTurnLedgerFailedForGuarantee({
      guaranteeKey,
      burstStableIds,
      textPreview,
      lastError: p.lastError ?? "no_outbound_incomplete",
    });
    return "failed";
  }
  return "noop";
}

/**
 * Pipeline hard-timeout: release UI locks and fail the admitted ledger turn.
 * @param {{
 *   guaranteeKey: string,
 *   burstStableIds?: string[],
 *   textPreview?: string,
 * }} p
 */
function markAdmittedInboundTurnTimedOut(p) {
  console.log("⚠️ Pipeline timeout — force release");
  globalThis.__ACTIVE_PIPELINE__ = false;
  globalThis.__UI_HARD_LOCK = false;
  releasePlaywrightListenerProcessingLocks();
  const guaranteeKey = String(p?.guaranteeKey ?? "").trim();
  if (!guaranteeKey) return;
  setMessageState(guaranteeKey, "failed");
  markInboundTurnLedgerFailedForGuarantee({
    guaranteeKey,
    burstStableIds: p.burstStableIds,
    textPreview: String(p.textPreview ?? "").slice(0, 120),
    lastError: "pipeline_timeout",
  });
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
    participantDisplayName: participantDisplayNameRaw,
    participantKey: participantKeyRaw,
    sourceParticipantKey: sourceParticipantKeyRaw,
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
    contextMessageId: contextMessageIdRaw = null,
    playwrightWebInbound: playwrightWebInboundRaw = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityRaw = false,
    groupName: groupNameRaw,
    chatName: chatNameRaw,
    inboundIntent: inboundIntentRaw = null,
    inboundEntity: inboundEntityRaw = null,
    resetTopicContext: resetTopicContextRaw = false,
    playwrightChatKey: playwrightChatKeyRaw = null,
    playwrightForwardedAt: playwrightForwardedAtRaw = null,
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
    console.log("[whatsappInboundBuffer_dm_inbound_accepted]", {
      dmChatTitle: dmChatTitle || null,
      dmPlaywrightChatKey: dmPlaywrightChatKey || null,
      hasBookingHint: Boolean(p?.bookingHint),
      textPreview: String(latestMessageRaw ?? combinedMessage ?? "").slice(0, 120) || null,
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
    p.__cloudResumeProcessing !== true &&
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

  let processingSuccess = false;
  /** Hoisted for guarantee bridge (Playwright deliver vs release). */
  let outboundReplyDelivered = false;
  /** Intentional handled-without-outbound (e.g. PURE_ACK_SILENT). */
  let intentionalSilent = false;
  let cloudLifecycleIdentity = null;
  let cloudLifecycleClaimed = false;
  let cloudNormalRoutingClaimed = false;
  let cloudLifecycleClaimOwner = null;
  /** Hoisted for finally-block guarantee completion (declared inside try is TDZ in finally). */
  let messageMeta = null;
  const isGroupInbound =
    isGroupMessage === true && String(userPhone ?? "").trim() === "unknown";
  const persistCloudDmConversationIdentity =
    !isGroupInbound && !playwrightWebInbound;
  const latestMessage = String(latestMessageRaw ?? combinedMessage ?? "").trim();
  const cloudConfirmPhone =
    String(conversationCustomerNumber ?? "").trim() ||
    String(userPhone ?? "").trim() ||
    String(participantPhoneForDmRaw ?? "").trim();
  const parsedAvailabilityApproval =
    parseAvailabilityApprovalMessage(combinedMessage);
  const parsedApproval = parseApprovalMessage(combinedMessage);
  let preResolvedPostConfirmBookingFacts = null;
  let preResolvedFreshWaitingConfirmRequest = null;
  let preResolvedConfirmedBookingReplyRecovery = null;
  let resolvedPostConfirm = null;
  const inboundReceivedAtMs =
    Number.isFinite(tsNum) && tsNum > 0
      ? tsNum < 1e12
        ? tsNum * 1000
        : tsNum
      : null;
  const canResolvePostConfirmOwnership =
    !parsedAvailabilityApproval &&
    !parsedApproval &&
    !isGroupInbound &&
    !playwrightWebInbound &&
    Boolean(String(ownerUserId ?? "").trim()) &&
    Boolean(cloudConfirmPhone) &&
    cloudConfirmPhone !== "unknown";
  if (canResolvePostConfirmOwnership) {
    const cloudClaim = claimCloudInboundTurn({
      businessId: ownerUserId,
      customerPhone: cloudConfirmPhone,
      messageId,
      resumeProcessing: p.__cloudResumeProcessing === true,
      resumeQueuedOwnership: p.__cloudQueuedOwnershipResume === true,
      provisionalOwnership: true,
      claimOwner:
        String(p.__cloudClaimOwner ?? "").trim() ||
        null,
      recoveryContext: {
        businessId: ownerUserId,
        customerPhone: cloudConfirmPhone,
        messageText: latestMessage,
        messageId,
        userPhone,
        sessionKey,
        whatsappReplyTo,
        conversationCustomerNumber,
        phoneNumberId:
          phoneNumberId ?? sendCredentials?.phoneNumberId ?? null,
        messageTimestamp: inboundReceivedAtMs,
      },
    });
    cloudLifecycleIdentity = cloudClaim.identity ?? null;
    if (cloudClaim.claimed === true) {
      cloudLifecycleClaimOwner =
        String(cloudClaim.claimOwner ?? "").trim() || null;
    }
    if (cloudClaim.action === "done") {
      console.log("[cloud_post_confirm_duplicate_done]", {
        guaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
        messageId,
      });
      return;
    }
    if (cloudClaim.action === "processing") {
      console.log("[cloud_post_confirm_duplicate_processing]", {
        guaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
        messageId,
      });
      return;
    }
    if (cloudClaim.action === "terminal") {
      console.log("[cloud_post_confirm_terminal_blocked]", {
        guaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
        messageId,
        reason: cloudClaim.reason,
      });
      return;
    }
    if (cloudClaim.action === "outbound_locked") {
      const recovery = await tryRecoverCloudOutboundLockedTurn({
        db,
        entry: cloudClaim.entry,
        sendCredentials,
        __sendOutboundMessageFn:
          typeof p.__sendOutboundMessageFn === "function"
            ? p.__sendOutboundMessageFn
            : undefined,
      });
      console.log("[cloud_post_confirm_outbound_locked_recovery]", {
        guaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
        action: recovery.action,
        reason: recovery.reason,
        sent: recovery.sent === true,
      });
      if (
        recovery.action === "send_failed" &&
        Number(recovery.retryCount ?? 0) <= 5
      ) {
        scheduleCloudPostConfirmRetry(
          p,
          cloudLifecycleIdentity,
          Number(recovery.retryCount ?? 1),
          cloudLifecycleClaimOwner
        );
      }
      return;
    }
    if (!cloudClaim.claimed) {
      throw new Error(cloudClaim.reason || "CLOUD_LEDGER_CLAIM_FAILED");
    }

    if (p.__cloudResumeProcessing === true) {
      try {
        const findConfirmedReplyRecoveryFn = (
          await import("./availabilityCustomerConfirmService.js")
        ).findConfirmedBookingReplyRecoveryCandidate;
        preResolvedConfirmedBookingReplyRecovery =
          await findConfirmedReplyRecoveryFn({
            db,
            businessId: ownerUserId,
            customerPhone: cloudConfirmPhone,
            messageId,
          });
      } catch (err) {
        const failed = markCloudInboundTurnRetryableFailure({
          identity: cloudLifecycleIdentity,
          lastError: String(
            err?.message ??
              err ??
              "CONFIRMED_BOOKING_REPLY_RECOVERY_LOOKUP_FAILED"
          ),
          retryDelayMs: 1000,
        });
        scheduleCloudPostConfirmRetry(
          p,
          cloudLifecycleIdentity,
          Number(failed?.retryCount ?? 1),
          cloudLifecycleClaimOwner
        );
        return;
      }
    }

    const resolveFreshWaitingConfirmFn =
      typeof p.__resolveFreshWaitingConfirmCloudOwnershipCandidateFn === "function"
        ? p.__resolveFreshWaitingConfirmCloudOwnershipCandidateFn
        : (
            await import("./availabilityRequestService.js")
          ).findFreshTrustedWaitingConfirmCloudOwnershipCandidate;
    try {
      preResolvedFreshWaitingConfirmRequest =
        await resolveFreshWaitingConfirmFn({
          db,
          businessId: ownerUserId,
          customerPhone: cloudConfirmPhone,
          inboundReceivedAtMs,
        });
    } catch (err) {
      const failed = markCloudInboundTurnRetryableFailure({
        identity: cloudLifecycleIdentity,
        lastError: String(
          err?.message ?? err ?? "WAITING_CONFIRM_OWNERSHIP_LOOKUP_FAILED"
        ),
        retryDelayMs: 1000,
      });
      scheduleCloudPostConfirmRetry(
        p,
        cloudLifecycleIdentity,
        Number(failed?.retryCount ?? 1),
        cloudLifecycleClaimOwner
      );
      return;
    }

    const resolvePostConfirmFactsFn =
      typeof p.__resolveActiveCustomerBookingFactsFn === "function"
        ? p.__resolveActiveCustomerBookingFactsFn
        : (
            await import("../brain/facts/resolveActiveCustomerBookingFacts.js")
          ).resolveActiveCustomerBookingFacts;
    try {
      resolvedPostConfirm = await resolvePostConfirmFactsFn({
        db,
        businessId: ownerUserId,
        customerPhone: cloudConfirmPhone,
        inboundReceivedAtMs,
      });
    } catch (err) {
      const failed = markCloudInboundTurnRetryableFailure({
        identity: cloudLifecycleIdentity,
        lastError: String(err?.message ?? err ?? "BOOKING_LOOKUP_FAILED"),
        retryDelayMs: 1000,
      });
      scheduleCloudPostConfirmRetry(
        p,
        cloudLifecycleIdentity,
        Number(failed?.retryCount ?? 1),
        cloudLifecycleClaimOwner
      );
      return;
    }
    if (resolvedPostConfirm?.retryable === true) {
      const failed = markCloudInboundTurnRetryableFailure({
        identity: cloudLifecycleIdentity,
        lastError: String(
          resolvedPostConfirm.reason ?? "BOOKING_LOOKUP_FAILED"
        ),
        retryDelayMs: 1000,
      });
      scheduleCloudPostConfirmRetry(
        p,
        cloudLifecycleIdentity,
        Number(failed?.retryCount ?? 1),
        cloudLifecycleClaimOwner
      );
      return;
    }
    if (resolvedPostConfirm?.ok === true && resolvedPostConfirm.facts) {
      preResolvedPostConfirmBookingFacts = resolvedPostConfirm;
    }
    console.log("[cloud_post_confirm_booking_resolution]", {
      traceId,
      messageId,
      guaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
      stage:
        p.__cloudOwnershipQueuedAtMs != null
          ? "post_active_job_resume"
          : "initial",
      ok: resolvedPostConfirm?.ok === true,
      reason: String(resolvedPostConfirm?.reason ?? "").trim() || null,
    });
  }
  const hasConfirmedBookingReplyRecovery =
    Boolean(preResolvedConfirmedBookingReplyRecovery);
  const hasActivePostConfirmOwnership =
    preResolvedPostConfirmBookingFacts?.ok === true;
  if (hasConfirmedBookingReplyRecovery) {
    cloudLifecycleClaimed = true;
  } else if (hasActivePostConfirmOwnership) {
    markCloudInboundTurnPostConfirmOwned({ identity: cloudLifecycleIdentity });
    cloudLifecycleClaimed = true;
  }

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
        cloudGuaranteeKey: cloudLifecycleIdentity?.guaranteeKey ?? null,
        cloudProviderMessageId: messageId || null,
        cloudOwnershipResolution:
          String(resolvedPostConfirm?.reason ?? "").trim() || null,
      });
      const preserveCloudLifecycle =
        Boolean(cloudLifecycleIdentity?.guaranteeKey) &&
        Boolean(cloudLifecycleClaimOwner);
      const queuedCloudEntry = preserveCloudLifecycle
        ? markCloudInboundTurnOwnershipQueued({
            identity: cloudLifecycleIdentity,
            claimOwner: cloudLifecycleClaimOwner,
            businessId: ownerUserId,
            customerPhone: cloudConfirmPhone,
            messageId,
            messageText: latestMessage,
            latestBookingResolutionReason:
              String(resolvedPostConfirm?.reason ?? "").trim() || null,
          })
        : null;
      if (preserveCloudLifecycle && !queuedCloudEntry) {
        const failed = markCloudInboundTurnRetryableFailure({
          identity: cloudLifecycleIdentity,
          lastError: "CLOUD_OWNERSHIP_QUEUE_MARKER_PERSIST_FAILED",
          retryDelayMs: 1000,
        });
        scheduleCloudPostConfirmRetry(
          {
            ...p,
            __cloudResumeProcessing: true,
            __cloudClaimOwner: cloudLifecycleClaimOwner,
            __cloudQueuedOwnershipResume: false,
          },
          cloudLifecycleIdentity,
          Number(failed?.retryCount ?? 1)
        );
        return;
      }
      globalThis.__messageQueue.push(
        preserveCloudLifecycle
          ? {
              ...p,
              __cloudResumeProcessing: true,
              __cloudQueuedOwnershipResume: true,
              __cloudClaimOwner: cloudLifecycleClaimOwner,
              __cloudOwnershipQueuedAtMs:
                Number(
                  queuedCloudEntry?.cloudOwnershipQueue?.queuedAt ?? 0
                ) || Date.now(),
              __cloudOwnershipInitialResolution:
                String(resolvedPostConfirm?.reason ?? "").trim() || null,
            }
          : p
      );
    }
    return;
  }
  globalThis.__forceProcessing = false;

  if (
    !hasActivePostConfirmOwnership &&
    !hasConfirmedBookingReplyRecovery &&
    cloudLifecycleIdentity?.guaranteeKey
  ) {
    console.log("[cloud_post_confirm_ownership_probe_released]", {
      traceId,
      messageId,
      guaranteeKey: cloudLifecycleIdentity.guaranteeKey,
      stage:
        p.__cloudOwnershipQueuedAtMs != null
          ? "post_active_job_resume"
          : "initial",
      initialResolution:
        String(p.__cloudOwnershipInitialResolution ?? "").trim() || null,
      finalResolution:
        String(resolvedPostConfirm?.reason ?? "").trim() || null,
    });
    markCloudInboundTurnNormalRouting({
      identity: cloudLifecycleIdentity,
      bookingResolutionReason:
        String(resolvedPostConfirm?.reason ?? "").trim() || null,
    });
    cloudLifecycleClaimed = true;
    cloudNormalRoutingClaimed = true;
  }

  const groupLogFields =
    isGroupMessage === true
      ? { is_group: true, is_auto_triggered: true }
      : {};

  const messageHash = hashCombinedInbound(combinedMessage, sessionKey);
  const nowMs = Date.now();
  const prevSent = lastSentReplies.get(sessionKey);
  if (
    p.__cloudResumeProcessing !== true &&
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

  const guaranteeKey = isPlaywrightWebTabInbound(p)
    ? String(buildPlaywrightGuaranteeKey(groupNameResolved, messageId) ?? "").trim()
    : "";

  if (isPlaywrightWebTabInbound(p) && guaranteeKey) {
    const ledgerBlock = resolveInboundTurnAdmissionBlock({
      chatKey: groupNameResolved,
      stableId: messageId,
      textPreview: String(combinedMessage ?? "").trim().slice(0, 120),
      currentForwardedAtMs: Number(playwrightForwardedAtRaw),
    });
    if (ledgerBlock.blocked && ledgerBlock.reason === "outbound_locked") {
      // Resume persisted final reply only — never re-run Brain/actions.
      const recovery = await tryRecoverOutboundLockedInboundTurn({
        chatKey: groupNameResolved,
        stableId: messageId,
        guaranteeKey,
        __testSendPlaywrightGroupText:
          typeof p.__testSendPlaywrightGroupText === "function"
            ? p.__testSendPlaywrightGroupText
            : undefined,
        lastPlaywrightTextSends,
      });
      logOutboundLifecycle("outbound_locked_recovery", {
        traceId,
        guaranteeKey,
        stableId: messageId,
        recovered: recovery.recovered === true,
        action: recovery.action,
        reason: recovery.reason,
        sent: recovery.sent === true,
        outboundReplyDelivered: recovery.sent === true,
      });
      const blockedChatKey = normalizeTitle(String(groupNameResolved ?? "").trim());
      if (blockedChatKey) {
        globalThis.__chatResponding =
          globalThis.__chatResponding || Object.create(null);
        globalThis.__chatResponding[blockedChatKey] = false;
        if (globalThis.__processingChats instanceof Map) {
          globalThis.__processingChats.delete(blockedChatKey);
        }
      }
      return;
    }
    if (ledgerBlock.blocked && ledgerBlock.reason === "recent_processing_duplicate") {
      logOutboundLifecycle("inbound_turn_ledger_processing_existing_blocked", {
        traceId,
        guaranteeKey,
        stableId: messageId,
        existingState: ledgerBlock.existingState ?? null,
        ageMs: ledgerBlock.ageMs ?? null,
        reason: "recent_processing_duplicate",
        outboundReplyDelivered: false,
      });
      const blockedChatKey = normalizeTitle(String(groupNameResolved ?? "").trim());
      if (blockedChatKey) {
        globalThis.__chatResponding =
          globalThis.__chatResponding || Object.create(null);
        globalThis.__chatResponding[blockedChatKey] = false;
        if (globalThis.__processingChats instanceof Map) {
          globalThis.__processingChats.delete(blockedChatKey);
        }
      }
      return;
    }
  }

  if (isPlaywrightWebTabInbound(p)) {
    /** Text + model + image download + WA Web attach/preview often exceeds 15s; releasing locks mid-send breaks uploads. */
    pipelineTimeoutId = setTimeout(() => {
      const pendingTimeout =
        guaranteeKey && globalThis.__playwrightPendingByGuarantee instanceof Map
          ? globalThis.__playwrightPendingByGuarantee.get(guaranteeKey)
          : null;
      markAdmittedInboundTurnTimedOut({
        guaranteeKey,
        burstStableIds: pendingTimeout?.burstStableIds,
        textPreview: String(combinedMessage ?? "").slice(0, 120),
      });
    }, 120_000);
  }

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
    console.log("🧠 Parsed approval:", parsedApproval);
    if (parsedAvailabilityApproval) {
      console.log("🛠 Availability approval command detected:", parsedAvailabilityApproval);
      await handleAvailabilityRequestApproval({
        db,
        userId: ownerUserId,
        businessId: ownerUserId,
        senderPhone: conversationCustomerNumber,
        messageText: combinedMessage,
      });
      processingSuccess = true;
      return;
    }
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
        ...(persistCloudDmConversationIdentity
          ? {
              sourceMessageId: messageId || null,
              providerMessageId: messageId || null,
            }
          : {}),
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
  console.log("[DEBUG] Brain V2 business owner:", ownerUserId);

  const shadowEligible = isEmilyBrainV2ShadowQuickGate(ownerUserId);
  const v2LiveMemoryNeeded = isEmilyBrainV2LiveQuickGate(ownerUserId);
  const memorySnapshotParams = {
    traceId,
    businessId: ownerUserId,
    ownerUserId,
    sessionKey,
    participantKey: participantKeyRaw,
    playwrightChatKey: playwrightChatKeyRaw,
    isGroupInbound,
  };
  let shadowPreTurnMemorySnapshot =
    v2LiveMemoryNeeded || shadowEligible
      ? await loadBrainV2SessionMemorySnapshot(memorySnapshotParams)
      : null;
  const dmHandoffBookingItem =
    !isGroupInbound && p?.bookingHint
      ? await loadDmHandoffBookingItem({
          db,
          businessId: ownerUserId,
          bookingHint: p.bookingHint,
          traceId,
        })
      : null;
  if (dmHandoffBookingItem) {
    shadowPreTurnMemorySnapshot = applyDmHandoffItemToMemorySnapshot({
      snapshot: shadowPreTurnMemorySnapshot,
      bookingItem: dmHandoffBookingItem,
      bookingHint: p.bookingHint,
      traceId,
    });
  }

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
  let handledByBrainV2Live = false;
  let handledByBrainV2InfoLive = false;
  let handledByBrainV2HardBlock = false;

  const pipelineChatId =
    String(playwrightChatKeyRaw ?? "").trim() ||
    String(groupNameResolved ?? "").trim() ||
    String(sessionKey ?? "").trim() ||
    null;
  const normalizedParticipantName =
    participantNameRaw != null && String(participantNameRaw).trim() !== ""
      ? String(participantNameRaw).trim()
      : null;
  const normalizedParticipantDisplayName =
    participantDisplayNameRaw != null && String(participantDisplayNameRaw).trim() !== ""
      ? String(participantDisplayNameRaw).trim()
      : normalizedParticipantName;
  const normalizedParticipantKey =
    participantKeyRaw != null && String(participantKeyRaw).trim() !== ""
      ? String(participantKeyRaw).trim()
      : null;
  const normalizedSourceParticipantKey =
    sourceParticipantKeyRaw != null && String(sourceParticipantKeyRaw).trim() !== ""
      ? String(sourceParticipantKeyRaw).trim()
      : normalizedParticipantKey;
  const normalizedSenderScope =
    senderScopeRaw != null && String(senderScopeRaw).trim() !== ""
      ? String(senderScopeRaw).trim()
      : null;
  const normalizedSourceMessageIndex =
    sourceMessageIndexRaw != null && Number.isFinite(Number(sourceMessageIndexRaw))
      ? Number(sourceMessageIndexRaw)
      : null;

  let skipGeneralBrainForWaitingConfirmOwnership = false;
  let postConfirmPaOwnershipHandled = false;
  const hasFreshWaitingConfirmOwnership =
    Boolean(preResolvedFreshWaitingConfirmRequest);
  const canTryCloudConfirmOwnership =
    (hasConfirmedBookingReplyRecovery ||
      !hasActivePostConfirmOwnership ||
      hasFreshWaitingConfirmOwnership) &&
    !isGroupInbound &&
    !playwrightWebInbound &&
    Boolean(String(ownerUserId ?? "").trim()) &&
    Boolean(cloudConfirmPhone) &&
    cloudConfirmPhone !== "unknown" &&
    Boolean(String(latestMessage ?? "").trim());

  if (canTryCloudConfirmOwnership) {
    const handleCloudConfirmFn =
      typeof p.__tryHandleAvailabilityCustomerCloudInboundFn === "function"
          ? p.__tryHandleAvailabilityCustomerCloudInboundFn
          : (
              await import("./availabilityCustomerConfirmService.js")
            ).handleAvailabilityCustomerCloudInbound;
    const cloudConfirmResult = await handleCloudConfirmFn({
      db,
      businessId: ownerUserId,
      customerPhone: cloudConfirmPhone,
      messageText: latestMessage,
      messageId,
      conversationHistory,
      sendCredentials,
      preselectedWaitingConfirmRequest:
        preResolvedFreshWaitingConfirmRequest,
      historicalBookingContext:
        preResolvedPostConfirmBookingFacts?.facts ?? null,
      inboundReceivedAtMs,
    });
    if (cloudConfirmResult?.handled === true) {
      skipGeneralBrainForWaitingConfirmOwnership = true;
      console.log("[availability_cloud_confirm_ownership_handled]", {
        traceId,
        businessId: ownerUserId,
        requestId: cloudConfirmResult.requestId ?? null,
        action: cloudConfirmResult.action ?? null,
        actionType:
          cloudConfirmResult.actionType ??
          cloudConfirmResult.decision?.actionType ??
          null,
        duplicate: cloudConfirmResult.duplicate === true,
        failureReason:
          cloudConfirmResult.failureReason ??
          cloudConfirmResult.result?.reason ??
          null,
        failureStage:
          cloudConfirmResult.failureStage ??
          cloudConfirmResult.result?.failureStage ??
          null,
        isGroupInbound,
        messagePreview: String(latestMessage ?? "").slice(0, 120),
      });
      reply = "";
      sendVia = "NONE";
      messageMeta = {
        handledWithoutOutbound: true,
        availabilityCloudConfirmHandled: true,
        availabilityRequestId: cloudConfirmResult.requestId ?? null,
        availabilityCloudConfirmAction: cloudConfirmResult.action ?? null,
        outboundTrace: {
          kind:
            cloudConfirmResult.duplicate === true
              ? "confirm_service_duplicate"
              : "confirm_service_outbound",
          finalReplySource: "AVAILABILITY_CUSTOMER_CLOUD_CONFIRM",
        },
      };
    } else if (
      hasFreshWaitingConfirmOwnership ||
      hasConfirmedBookingReplyRecovery
    ) {
      const noMatchReason = String(cloudConfirmResult?.reason ?? "").trim();
      if (
        hasConfirmedBookingReplyRecovery ||
        !["NO_MATCH", "NO_WAITING_REQUEST"].includes(noMatchReason)
      ) {
        throw new Error(
          noMatchReason || "WAITING_CONFIRM_OWNERSHIP_UNRESOLVED"
        );
      }
    }
  }

  if (
    !hasActivePostConfirmOwnership &&
    !skipGeneralBrainForWaitingConfirmOwnership
  ) {
  const ownershipGuard = await evaluateAvailabilityWaitingConfirmOwnershipGuard({
    db,
    businessId: ownerUserId,
    messageText: latestMessage,
    messageTimestampMs: Number.isFinite(tsNum) && tsNum > 0 ? tsNum : null,
    participantPhone:
      String(participantPhoneForDmRaw ?? conversationCustomerNumber ?? "").trim() || null,
    participantKey: normalizedParticipantKey,
    participantName: normalizedParticipantDisplayName,
    playwrightChatKey:
      String(playwrightChatKeyRaw ?? dmPlaywrightChatKey ?? "").trim() || null,
    dmChatTitle: dmChatTitle || null,
    isGroupInbound,
  });
  if (ownershipGuard.block) {
    skipGeneralBrainForWaitingConfirmOwnership = true;
    console.log("[availability_waiting_confirm_ownership_guard]", {
      traceId,
      businessId: ownerUserId,
      requestId: ownershipGuard.requestId,
      reason: ownershipGuard.reason,
      isGroupInbound,
      messagePreview: String(latestMessage ?? "").slice(0, 120),
    });
    reply = "";
    sendVia = "NONE";
    messageMeta = {
      handledWithoutOutbound: true,
      availabilityWaitingConfirmOwnership: true,
      availabilityRequestId: ownershipGuard.requestId,
      outboundTrace: {
        kind: "silent_noop",
        finalReplySource: "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP",
      },
    };
    intentionalSilent = true;
  }
  }

  // Business PA missing-info Phase 2: owner answer → customer follow-up.
  // After confirm + waiting-confirm ownership; before Business PA / Brain.
  if (
    !hasActivePostConfirmOwnership &&
    !skipGeneralBrainForWaitingConfirmOwnership
  ) {
    const canTryOwnerAnswer =
      !isGroupInbound &&
      !playwrightWebInbound &&
      Boolean(String(ownerUserId ?? "").trim()) &&
      Boolean(cloudConfirmPhone) &&
      cloudConfirmPhone !== "unknown" &&
      Boolean(String(latestMessage ?? "").trim());
    if (canTryOwnerAnswer) {
      const tryOwnerAnswerFn =
        typeof p.__tryHandlePaMissingInfoOwnerAnswerFn === "function"
          ? p.__tryHandlePaMissingInfoOwnerAnswerFn
          : (
              await import("./paMissingInfoOwnerAnswerService.js")
            ).tryHandlePaMissingInfoOwnerAnswer;
      const ownerAnswerResult = await tryOwnerAnswerFn({
        db,
        businessId: ownerUserId,
        senderPhone: cloudConfirmPhone,
        messageText: latestMessage,
        messageId,
        contextMessageId:
          contextMessageIdRaw != null &&
          String(contextMessageIdRaw).trim() !== ""
            ? String(contextMessageIdRaw).trim()
            : null,
        isGroupInbound,
        playwrightWebInbound,
        sendCredentials,
      });
      if (ownerAnswerResult) {
        skipGeneralBrainForWaitingConfirmOwnership = true;
        console.log("[pa_missing_info_owner_answer_handled]", {
          traceId,
          businessId: ownerUserId,
          requestId: ownerAnswerResult.requestId ?? null,
          reason: ownerAnswerResult.reason ?? null,
          action: ownerAnswerResult.action ?? null,
          customerFollowupSent: ownerAnswerResult.customerFollowupSent === true,
          matchReason: ownerAnswerResult.matchReason ?? null,
          isGroupInbound,
          messagePreview: String(latestMessage ?? "").trim().slice(0, 120),
        });
        reply = "";
        sendVia = "NONE";
        messageMeta = {
          handledWithoutOutbound: true,
          paMissingInfoOwnerAnswerHandled: true,
          missingInfoRequestId: ownerAnswerResult.requestId ?? null,
          outboundTrace: {
            kind: "pa_missing_info_owner_answer",
            finalReplySource: "PA_MISSING_INFO_OWNER_ANSWER",
          },
        };
      }
    }
  }

  // Business PA: after Cloud confirm + waiting-confirm ownership guard, before Brain.
  if (!skipGeneralBrainForWaitingConfirmOwnership) {
    const canTryBusinessPa =
      !isGroupInbound &&
      !playwrightWebInbound &&
      Boolean(String(ownerUserId ?? "").trim()) &&
      Boolean(cloudConfirmPhone) &&
      cloudConfirmPhone !== "unknown" &&
      Boolean(String(latestMessage ?? "").trim());
    if (canTryBusinessPa) {
      const tryBusinessPaFn =
        typeof p.__tryHandleCustomerBusinessPaInboundFn === "function"
          ? p.__tryHandleCustomerBusinessPaInboundFn
          : (
              await import("./customerBusinessPaAgentService.js")
            ).tryHandleCustomerBusinessPaInbound;
      const businessPaResult = await tryBusinessPaFn({
        db,
        businessId: ownerUserId,
        customerPhone: cloudConfirmPhone,
        messageText: latestMessage,
        messageId,
        inboundReceivedAtMs,
        conversationHistory,
        sendCredentials,
        preResolvedBookingFacts: preResolvedPostConfirmBookingFacts,
      });
      if (businessPaResult?.ownershipReleased === true) {
        console.log("[customer_business_pa_release_continued]", {
          traceId,
          businessId: ownerUserId,
          bookingId: businessPaResult.bookingId ?? null,
          releaseReason:
            businessPaResult.releaseReason ?? businessPaResult.reason ?? null,
          semanticDecisionCount:
            Number(businessPaResult.semanticDecisionCount ?? 0) || 0,
          composeCalls: Number(businessPaResult.composeCalls ?? 0) || 0,
          mutationExecutionRequested:
            businessPaResult.mutationExecutionRequested === true,
          messagePreview: String(latestMessage ?? "").trim().slice(0, 120),
        });
      } else if (businessPaResult) {
        if (businessPaResult.retryable === true) {
          throw new Error(
            String(
              businessPaResult.failureReason ??
                businessPaResult.reason ??
                "OPENAI_POST_CONFIRM_FAILED"
            )
          );
        }
        skipGeneralBrainForWaitingConfirmOwnership = true;
        postConfirmPaOwnershipHandled = true;
        console.log("[customer_business_pa_ownership_handled]", {
          traceId,
          businessId: ownerUserId,
          bookingId: businessPaResult.bookingId ?? null,
          availabilityRequestId: businessPaResult.availabilityRequestId ?? null,
          openaiUsed: businessPaResult.openaiUsed === true,
          openaiSource: businessPaResult.openaiSource ?? null,
          missingInfoEscalated: businessPaResult.missingInfoEscalated === true,
          missingInfoRequestId: businessPaResult.missingInfoRequestId ?? null,
          missingInfoType: businessPaResult.missingInfoType ?? null,
          ownerNotifyStatus: businessPaResult.ownerNotifyStatus ?? null,
          terminalFailure: businessPaResult.terminalFailure === true,
          isGroupInbound,
          messagePreview: String(latestMessage ?? "").trim().slice(0, 120),
        });
        // Model-contract / technical failure must never become intentional silent.
        // Use durable retryable failure path (same as retryable === true).
        if (businessPaResult.terminalFailure === true) {
          throw new Error(
            String(
              businessPaResult.failureReason ??
                businessPaResult.reason ??
                "OPENAI_POST_CONFIRM_MODEL_CONTRACT_TERMINAL"
            )
          );
        }
        reply = String(businessPaResult.reply ?? "").trim();
        const hasBusinessPaReply = reply.length > 0;
        sendVia = hasBusinessPaReply ? "CLOUD_API" : "NONE";
        const paFinalReplySource =
          String(businessPaResult.finalReplySource ?? "").trim() ||
          "openai_post_confirm_pa";
        messageMeta = {
          ...(hasBusinessPaReply ? {} : { handledWithoutOutbound: true }),
          customerBusinessPaHandled: true,
          bookingId: businessPaResult.bookingId ?? null,
          availabilityRequestId: businessPaResult.availabilityRequestId ?? null,
          missingInfoEscalated: businessPaResult.missingInfoEscalated === true,
          missingInfoRequestId: businessPaResult.missingInfoRequestId ?? null,
          missingInfoType: businessPaResult.missingInfoType ?? null,
          finalReplySource: paFinalReplySource,
          outboundTrace: {
            kind: "business_pa_outbound",
            finalReplySource: paFinalReplySource,
          },
        };
      }
    }
  }

  let routeGate = {
    selected: "legacy",
    route: "ownership_skipped",
    rejectReason:
      hasActivePostConfirmOwnership || postConfirmPaOwnershipHandled
        ? "POST_CONFIRM_PA_OWNERSHIP_HANDLED"
        : "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP",
    businessAllowlisted: false,
    hasV2LivePipeline: false,
    allowlistConfigError: false,
    allowlistRaw: null,
  };
  if (!skipGeneralBrainForWaitingConfirmOwnership) {
  routeGate = evaluateBrainRouteGate({
    businessId: ownerUserId,
    chatId: pipelineChatId,
  });

  console.log(
    "[brain_route_gate_evaluated]",
    buildBrainRouteGateLogPayload(routeGate, {
      traceId,
      ownerUserId: String(ownerUserId ?? "").trim() || null,
    })
  );
  if (routeGate.allowlistConfigError) {
    console.warn("[brain_route_gate_config_error]", {
      traceId,
      businessId: ownerUserId,
      rejectReason: routeGate.rejectReason,
      allowlistRaw: routeGate.allowlistRaw,
    });
  }

  const sharedBrainParams = {
    traceId,
    businessId: ownerUserId,
    message: normalizedInbound.message,
    messageId: normalizedInbound.messageId,
    channel: playwrightWebInbound ? "whatsapp_web" : "whatsapp_cloud",
    chatType: isGroupInbound ? "group" : "dm",
    chatId:
      String(playwrightChatKeyRaw ?? "").trim() ||
      String(groupNameResolved ?? "").trim() ||
      sessionKey,
    sessionKey: normalizedInbound.sessionKey,
    participantKey: normalizedParticipantKey,
    sourceParticipantKey: normalizedSourceParticipantKey,
    participantName: normalizedParticipantName,
    participantDisplayName: normalizedParticipantDisplayName,
    sourceParticipantName: normalizedParticipantName,
    sourceParticipantDisplayName: normalizedParticipantDisplayName,
    senderScope: normalizedSenderScope,
    sourceSenderScope: normalizedSenderScope,
    participantPhoneForDm:
      String(participantPhoneForDmRaw ?? "").trim() || null,
    playwrightChatKey: playwrightChatKeyRaw,
    isGroupInbound,
    isGroupMessage,
    playwrightWebInbound,
    isDmContinuation: isPlaywrightDmWithIdentity,
    hasBookingHint: Boolean(p?.bookingHint),
    memorySnapshot: shadowPreTurnMemorySnapshot,
    conversationHistory,
    sourceRowKey: sourceRowKeyRaw,
    sourceMessageIndex: normalizedSourceMessageIndex,
    guaranteeKey: buildPlaywrightGuaranteeKey(groupNameResolved, messageIdRaw),
    groupName: groupNameResolved || null,
    whatsappRecipientType,
    executionContext: {
      traceId,
      businessId: ownerUserId,
      userId: ownerUserId,
      db,
      sessionKey: normalizedInbound.sessionKey,
      participantKey: normalizedParticipantKey,
      sourceParticipantKey: normalizedSourceParticipantKey,
      participantName: normalizedParticipantName,
      participantDisplayName: normalizedParticipantDisplayName,
      sourceParticipantName: normalizedParticipantName,
      sourceParticipantDisplayName: normalizedParticipantDisplayName,
      senderScope: normalizedSenderScope,
      sourceSenderScope: normalizedSenderScope,
      participantPhoneForDm:
        String(participantPhoneForDmRaw ?? "").trim() || null,
      sourceMessageIndex: normalizedSourceMessageIndex,
      sourceRowKey: sourceRowKeyRaw,
      messageId: normalizedInbound.messageId,
      sendCredentials,
    },
  };

  // Single semantic authority: every unowned customer turn runs full Brain V2.
  const v2LiveEligible = true;
  const infoLiveEligible = false;

  if (v2LiveEligible) {
    console.log("[brain_v2_live_selected]", {
      traceId,
      businessId: ownerUserId,
      messagePreview: String(normalizedInbound.message ?? "").slice(0, 120),
    });
    const v2LiveStartedAt = Date.now();
    const tryBrainV2LiveFn =
      typeof p.__tryBrainV2LiveBeforeLegacyFn === "function"
        ? p.__tryBrainV2LiveBeforeLegacyFn
        : tryBrainV2LiveBeforeLegacy;
    const v2LiveResult = await runBrainV2WithinBoundary({
      timeoutMs:
        Number.isFinite(Number(p.__brainV2TimeoutMsForTests))
          ? Number(p.__brainV2TimeoutMsForTests)
          : brainV2TimeoutMs(),
      setTimer: p.__brainV2SetTimerForTests ?? setTimeout,
      clearTimer: p.__brainV2ClearTimerForTests ?? clearTimeout,
      runner: ({ signal, executionGuard }) =>
        tryBrainV2LiveFn({
          ...sharedBrainParams,
          abortSignal: signal,
          executionGuard,
        }),
    });
    logLatency("brainV2Live", v2LiveStartedAt, {
      handled: v2LiveResult?.handled === true,
      reason: v2LiveResult?.reason ?? null,
      workflowType: v2LiveResult?.workflowType ?? null,
      legacyBypassed: v2LiveResult?.legacyBypassed === true,
    });
    const validatedV2Result = validateBrainV2PipelineResult(v2LiveResult);
    if (validatedV2Result.ok) {
      handledByBrainV2Live = true;
      console.log("[legacy_brain_bypassed]", {
        traceId,
        businessId: ownerUserId,
        workflowType: v2LiveResult?.workflowType ?? null,
        reason: v2LiveResult?.reason ?? null,
      });
      reply = String(validatedV2Result.result.reply).trim();
      messageMeta =
        validatedV2Result.result.messageMeta;
      sendVia = validatedV2Result.result.sendVia;
      dmRecipientPhone = validatedV2Result.result.dmRecipientPhone ?? undefined;
    } else {
      handledByBrainV2HardBlock = true;
      const blocked = buildHardBlockedPipelineResult(true);
      console.warn("[brain_v2_expected_but_not_selected]", {
        traceId,
        businessId: ownerUserId,
        rejectReason: "V2_SINGLE_SOURCE_DID_NOT_HANDLE",
        v2ResultReason: validatedV2Result.reason ?? v2LiveResult?.reason ?? null,
        legacyBypassed: v2LiveResult?.legacyBypassed ?? null,
        route: routeGate.route,
      });
      reply = blocked.reply;
      messageMeta = blocked.messageMeta;
      sendVia = isGroupInbound ? "GROUP" : "CLOUD_API";
      dmRecipientPhone = null;
    }
  }

  if (!handledByBrainV2Live && infoLiveEligible) {
    const infoLiveStartedAt = Date.now();
    const infoLiveResult = await tryBrainV2InfoLiveBeforeLegacy({
      ...sharedBrainParams,
      participantKeyForTrusted:
        participantKeyRaw != null && String(participantKeyRaw).trim() !== ""
          ? String(participantKeyRaw).trim()
          : null,
      chatContextKey: String(playwrightChatKeyRaw ?? groupNameResolved ?? "").trim(),
      traceIdForTrusted: traceId,
    });
    logLatency("brainV2InfoLive", infoLiveStartedAt, {
      handled: infoLiveResult?.handled === true,
      reason: infoLiveResult?.reason ?? null,
      workflowType: infoLiveResult?.workflowType ?? null,
    });
    if (infoLiveResult?.handled === true) {
      handledByBrainV2InfoLive = true;
      reply = String(infoLiveResult.reply ?? "").trim();
      messageMeta =
        infoLiveResult.messageMeta && typeof infoLiveResult.messageMeta === "object"
          ? infoLiveResult.messageMeta
          : {};
      sendVia = infoLiveResult.sendVia ?? (isGroupInbound ? "GROUP" : "WHATSAPP");
      dmRecipientPhone = undefined;
    }
  }

  }
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
  if (typeof p.__capturePipelineOutcomeForTests === "function") {
    p.__capturePipelineOutcomeForTests({
      reply: String(reply ?? ""),
      sendVia: sendVia ?? null,
      messageMeta:
        messageMeta && typeof messageMeta === "object" ? { ...messageMeta } : {},
      intentionalSilent,
    });
  }
  logLatency("brainV2SemanticPipeline", processStartedAt, {
    sendVia,
    hasReply: String(reply ?? "").trim() !== "",
    intentionalSilent,
    skippedForBrainV2Live: handledByBrainV2Live,
    skippedForBrainV2InfoLive: handledByBrainV2InfoLive,
    skippedForBrainV2HardBlock: handledByBrainV2HardBlock,
    brainRouteSelected: routeGate.selected,
    brainRouteRejectReason: routeGate.rejectReason,
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
    finalReplySourceFromMeta !== "openai_post_confirm_pa" &&
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
    let providerOutboundMessageIdForHistory = null;
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
      let groupSendFailed = false;
      let outboundStartedAt = 0;
      let cloudOutboundClaimOwner = "";
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
        const realPlaywrightGroupTabSend = shouldOutboundLockPlaywrightGroupSend({
          isTabInbound,
          isGroupMessage: isGroupMessage === true,
          unknownPhone,
          playwrightNoSend: /^(true|1|yes|on)$/i.test(
            String(process.env.PLAYWRIGHT_NO_SEND ?? "").trim()
          ),
        });
        if (realPlaywrightGroupTabSend && guaranteeKey) {
          const pendingLock =
            globalThis.__playwrightPendingByGuarantee?.get(guaranteeKey);
          markInboundTurnLedgerOutboundLockedForGuarantee({
            guaranteeKey,
            burstStableIds: pendingLock?.burstStableIds,
            textPreview: String(combinedMessage ?? "").slice(0, 120),
            replyPreview: replyText.slice(0, 160),
            finalReplyText: replyText,
            finalReplySource: finalReplySourceForLifecycle || null,
            outboundLockStage: "buffer_send_start",
            sendVia: "PLAYWRIGHT",
            dryRun: false,
            traceId,
            groupChatKey:
              (playwrightChatKeyRaw != null && String(playwrightChatKeyRaw).trim() !== ""
                ? String(playwrightChatKeyRaw).trim()
                : null) ||
              (groupNameResolved ? normalizeTitle(groupNameResolved) : null),
            messageHash,
            replyHash: hashCombinedInbound(replyText, guaranteeKey || sessionKey),
            sourceMessageIndex:
              sourceMessageIndexRaw != null && Number.isFinite(Number(sourceMessageIndexRaw))
                ? Number(sourceMessageIndexRaw)
                : null,
          });
        }
        const cloudLifecycleSend =
          cloudLifecycleClaimed &&
          cloudLifecycleIdentity?.guaranteeKey &&
          sendVia === "CLOUD_API";
        if (cloudLifecycleSend) {
          markCloudInboundTurnOutboundLocked({
            identity: cloudLifecycleIdentity,
            finalReplyText: replyText,
            finalReplySource:
              finalReplySourceForLifecycle ||
              (cloudNormalRoutingClaimed
                ? "cloud_normal_routing"
                : "openai_post_confirm_pa"),
            traceId,
          });
          cloudOutboundClaimOwner = `cloud-send:${traceId}`;
          const outboundClaim = claimOutboundLockedRecovery({
            force: true,
            chatKey: cloudLifecycleIdentity.chatKey,
            stableId: cloudLifecycleIdentity.stableId,
            claimOwner: cloudOutboundClaimOwner,
          });
          if (!outboundClaim.claimed) {
            throw new Error(
              `CLOUD_OUTBOUND_LOCK_CLAIM_FAILED:${outboundClaim.reason}`
            );
          }
        }
        console.log("📤 Sending reply");
        logOutboundLifecycle("buffer_send_start", {
          ...outboundLifecycleBase,
          sendVia: String(sendVia ?? "").trim() || null,
          finalReplySource: finalReplySourceForLifecycle || null,
        });
        outboundStartedAt = Date.now();
        if (cloudLifecycleSend) {
          const { markOutboundSendInFlight } = await import(
            "./inboundTurnLedger.js"
          );
          markOutboundSendInFlight({
            force: true,
            chatKey: cloudLifecycleIdentity.chatKey,
            stableId: cloudLifecycleIdentity.stableId,
            claimOwner: cloudOutboundClaimOwner,
            outboundLockStage: "cloud_buffer_send_in_flight",
          });
        }
        const sendOutboundMessageFn =
          typeof p.__sendOutboundMessageFn === "function"
            ? p.__sendOutboundMessageFn
            : sendOutboundMessage;
        const sendResult = await sendOutboundMessageFn({
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
          providerOutboundMessageIdForHistory =
            sendResult?.providerMessageId ??
            sendResult?.messages?.[0]?.id ??
            null;
          if (cloudLifecycleSend) {
            markOutboundLockedRecoverySent({
              force: true,
              chatKey: cloudLifecycleIdentity.chatKey,
              stableId: cloudLifecycleIdentity.stableId,
              guaranteeKey: cloudLifecycleIdentity.guaranteeKey,
              textPreview: String(combinedMessage ?? "").slice(0, 120),
              providerOutboundMessageId:
                sendResult?.providerMessageId ??
                sendResult?.messages?.[0]?.id ??
                null,
            });
          }
        } else {
          if (cloudLifecycleSend && cloudOutboundClaimOwner) {
            releaseOutboundLockedRecoveryClaim({
              force: true,
              chatKey: cloudLifecycleIdentity.chatKey,
              stableId: cloudLifecycleIdentity.stableId,
              claimOwner: cloudOutboundClaimOwner,
              resetToPending: true,
            });
          }
          console.warn("⚠️ Outbound message failed:", {
            sendVia,
            ownerUserId,
            conversationCustomerNumber,
          });
        }
        if (outboundReplyDelivered) {
          lastSentReplies.set(sessionKey, {
            hash: messageHash,
            timestamp: Date.now(),
          });
        }
        console.log(
          "[whatsappInboundBuffer] deliverWhatsAppOutbound finished for",
          userPhone
        );
      } catch (sendErr) {
        if (
          cloudOutboundClaimOwner &&
          cloudLifecycleIdentity?.chatKey &&
          cloudLifecycleIdentity?.stableId
        ) {
          releaseOutboundLockedRecoveryClaim({
            force: true,
            chatKey: cloudLifecycleIdentity.chatKey,
            stableId: cloudLifecycleIdentity.stableId,
            claimOwner: cloudOutboundClaimOwner,
            resetToPending: false,
          });
        }
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

      if (outboundReplyDelivered) {
        try {
          await appendConversationMessage(db, {
            ownerUserId,
            customerNumber: conversationCustomerNumber,
            role: "assistant",
            text: replyText,
            ...(persistCloudDmConversationIdentity
              ? {
                  sourceMessageId: messageId || null,
                  providerMessageId: providerOutboundMessageIdForHistory,
                }
              : {}),
          });
        } catch (e) {
          console.error("[whatsappInboundBuffer] save assistant message:", e);
        }
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
    if (messageMeta?.availabilityCloudConfirmHandled === true) {
      console.log("[availability_cloud_confirm_buffer_skipped_outbound]", {
        source:
          String(messageMeta?.outboundTrace?.finalReplySource ?? "").trim() ||
          "AVAILABILITY_CUSTOMER_CLOUD_CONFIRM",
        action: messageMeta?.availabilityCloudConfirmAction ?? null,
        requestId: messageMeta?.availabilityRequestId ?? null,
        messageId: String(messageId ?? "").trim() || null,
        bufferKey: String(sessionKey ?? "").trim() || null,
      });
    } else {
      console.log("[silent_noop_marked_processed]", {
        source:
          String(messageMeta?.outboundTrace?.finalReplySource ?? "").trim() ||
          "PURE_ACK_SILENT",
        messageId: String(messageId ?? "").trim() || null,
        bufferKey: String(sessionKey ?? "").trim() || null,
        guaranteeKey: guaranteeKey || null,
      });
    }
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
  if (
    cloudNormalRoutingClaimed &&
    replyText === "" &&
    !intentionalSilent
  ) {
    throw new Error("cloud_normal_routing_empty_unhandled");
  }
  processingSuccess = true;
  if (
    cloudLifecycleClaimed &&
    intentionalSilent &&
    cloudLifecycleIdentity?.guaranteeKey
  ) {
    if (messageMeta?.postConfirmTerminalFailure === true) {
      markCloudInboundTurnTerminalTechnicalFailure({
        identity: cloudLifecycleIdentity,
        lastError:
          String(messageMeta?.failureReason ?? "").trim() ||
          "POST_CONFIRM_MODEL_CONTRACT_TERMINAL",
        deliveryStatus: "post_confirm_model_contract_terminal",
        terminalReason: "POST_CONFIRM_MODEL_CONTRACT_TERMINAL",
      });
    } else {
      markCloudInboundTurnDone({
        identity: cloudLifecycleIdentity,
        replySent: false,
        terminalOutcome: cloudNormalRoutingClaimed
          ? "intentional_silent"
          : "post_confirm_intentional_silent",
      });
    }
  }
  } catch (err) {
    console.error("❌ Processing error:", err);
    if (cloudLifecycleClaimed && cloudLifecycleIdentity?.guaranteeKey) {
      const lastError = String(err?.message ?? err ?? "processing_error");
      const pauseContractAutoRetry =
        shouldPauseCloudPostConfirmModelContractAutoRetry(lastError);
      const failed = markCloudInboundTurnRetryableFailure({
        identity: cloudLifecycleIdentity,
        lastError,
        retryDelayMs: 1000,
        ...(pauseContractAutoRetry ? { autoRetryAllowed: false } : {}),
      });
      scheduleCloudPostConfirmRetry(
        p,
        cloudLifecycleIdentity,
        Number(failed?.retryCount ?? 1),
        cloudLifecycleClaimOwner,
        lastError
      );
    }
    if (guaranteeKey) {
      setMessageState(guaranteeKey, "failed");
      const pendingFail =
        globalThis.__playwrightPendingByGuarantee?.get(guaranteeKey);
      markInboundTurnLedgerFailedForGuarantee({
        guaranteeKey,
        burstStableIds: pendingFail?.burstStableIds,
        textPreview: String(combinedMessage ?? "").slice(0, 120),
        lastError: "processing_error",
      });
    }
  } finally {
    const playwrightTurnCompleteFinally = playwrightInboundTurnComplete(
      outboundReplyDelivered,
      intentionalSilent
    );
    if (guaranteeKey) {
      const pendingDone =
        globalThis.__playwrightPendingByGuarantee?.get(guaranteeKey);
      finalizeAdmittedInboundTurnLedger({
        guaranteeKey,
        isPlaywrightWebTab: isPlaywrightWebTabInbound(p),
        processingSuccess,
        outboundReplyDelivered,
        intentionalSilent,
        burstStableIds: pendingDone?.burstStableIds,
        textPreview: String(combinedMessage ?? "").slice(0, 120),
        // Preserve catch lastError when already failed; only set for empty no-send.
        ...(processingSuccess ? { lastError: "no_outbound_incomplete" } : {}),
      });
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
    contextMessageId: contextMessageIdPayload,
    messageSender: messageSenderPayload,
    playwrightWebInbound: playwrightWebInboundPayload = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityPayload = false,
    groupName: groupNamePayload,
    chatName: chatNamePayload,
    inboundIntent: inboundIntentPayload = null,
    inboundEntity: inboundEntityPayload = null,
    resetTopicContext: resetTopicContextPayload = false,
    playwrightChatKey: playwrightChatKeyPayload = null,
    playwrightForwardedAt: playwrightForwardedAtPayload = null,
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
    contextMessageId:
      contextMessageIdPayload != null &&
      String(contextMessageIdPayload).trim() !== ""
        ? String(contextMessageIdPayload).trim()
        : entry.context?.contextMessageId != null &&
            String(entry.context.contextMessageId).trim() !== ""
          ? String(entry.context.contextMessageId).trim()
          : null,
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
    playwrightForwardedAt:
      playwrightForwardedAtPayload != null &&
      Number.isFinite(Number(playwrightForwardedAtPayload))
        ? Number(playwrightForwardedAtPayload)
        : entry.context?.playwrightForwardedAt != null &&
            Number.isFinite(Number(entry.context.playwrightForwardedAt))
          ? Number(entry.context.playwrightForwardedAt)
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

/** @param {Parameters<typeof finalizeAdmittedInboundTurnLedger>[0]} p */
export function __finalizeAdmittedInboundTurnLedgerForTests(p) {
  return finalizeAdmittedInboundTurnLedger(p);
}

/** @param {Parameters<typeof markAdmittedInboundTurnTimedOut>[0]} p */
export function __markAdmittedInboundTurnTimedOutForTests(p) {
  return markAdmittedInboundTurnTimedOut(p);
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

/** @internal Tests — owner notification executor hook. */
export { triggerBusinessBookingNotification as __triggerBusinessBookingNotificationForTests };

export {
  evaluateBrainRouteGate,
  isLegacyProcessMessageAllowed,
  isHardV2LiveMode,
  BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY,
} from "../brain/live/brainRouteGate.js";
