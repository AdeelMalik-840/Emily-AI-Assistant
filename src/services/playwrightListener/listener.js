/**
 * Optional WhatsApp Web (Playwright) group listener — does not touch Meta webhook or buffer implementation.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { chromium } from "playwright";

import db from "../../config/firebase.js";
import {
  resolvePlaywrightAllowedChatTitles,
  resolvePlaywrightBusinessKeywords,
} from "../../config/aiRuntime.js";
import {
  forwardPlaywrightDmToPipeline,
  forwardPlaywrightGroupToPipeline,
} from "./pipelineBridge.js";
import {
  clearPlaywrightOutboundPage,
  ensureChatView,
  readOpenConversationHeaderTitle,
  registerPlaywrightOutboundPage,
} from "../playwrightOutboundBridge.js";
import { normalizeTitle } from "../playwrightTitleNormalize.js";
import {
  recordPlaywrightInboundScheduled,
  notifyPlaywrightGuaranteeReleased,
} from "../playwrightGuaranteeBridge.js";
import { isRegisteredPlaywrightOutboundEcho } from "../playwrightOutboundRegistry.js";
import {
  isEmilyAssistantPricingStatement,
  isEmilyBookingEngagementStatement,
  resolveInboundSourceOrigin,
  INBOUND_SOURCE_REAL_CUSTOMER,
} from "../inboundOriginGuard.js";
import {
  clearOldStates,
  getMessageState,
  setMessageState,
} from "../messageState.js";
import {
  hydrateInboundTurnLedgerIntoMessageState,
  isInboundTurnLedgerEnabled,
  markInboundTurnLedgerBaselineAbsorbed,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
} from "../inboundTurnLedger.js";
import { scheduleOutboundLockedRecovery } from "../outboundLockedRecovery.js";
import { clearWhatsAppInboundMessageCaches } from "../whatsappInboundBuffer.js";
import { pollLocalApprovalContinuations } from "../localApprovalContinuationPoller.js";
import { pollLocalAvailabilityContinuations } from "../localAvailabilityContinuationPoller.js";
import { isReplyPrivateLockActive } from "../replyPrivateUiController.js";
import {
  buildParticipantCursorKey,
  isGroupMessageStale,
  resolveParticipantIdentity,
} from "../participantIdentity.js";
import { loadPlaywrightInboundCursor } from "../playwrightInboundCursorStore.js";
import {
  candidateRowsAfterNormalizedCursor,
  decideParticipantForwardTurn,
} from "./forwardDecision.js";
import {
  canMergeBurstRowPair,
  isBurstMergeContinuationText as isBurstMergeContinuationTextPolicy,
  resolveBurstMergeCatalogItems,
  shouldBurstSupersedeOlderRow,
} from "./burstMergePolicy.js";
import {
  getBookingLogisticsCompletionState,
  resolveLogisticsCompletionPolicy,
} from "../bookingDmFlow.js";

/** Open chat identity: sidebar `span[title]` for the target row (not header text). */
globalThis.__currentOpenChatTitle =
  globalThis.__currentOpenChatTitle !== undefined
    ? globalThis.__currentOpenChatTitle
    : null;
/** Last time {@link globalThis.__currentOpenChatTitle} was set (ms); used for send fallback freshness. */
globalThis.__currentOpenChatTitleTS =
  typeof globalThis.__currentOpenChatTitleTS === "number"
    ? globalThis.__currentOpenChatTitleTS
    : 0;

/**
 * @param {unknown} targetChatName
 */
function setCurrentOpenChatTitleFromSidebar(targetChatName) {
  const t = String(targetChatName ?? "").trim();
  globalThis.__currentOpenChatTitle = t || null;
  globalThis.__currentOpenChatTitleTS = t ? Date.now() : 0;
  console.log("🧭 SIDEBAR IDENTITY:", globalThis.__currentOpenChatTitle);
}

/**
 * Bootstrap: read title from the first sidebar row (matches ensureInitialChatOpen click target).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function captureOpenChatContext(page) {
  try {
    const title = await page
      .locator('#pane-side div[role="row"]')
      .first()
      .locator("span[title]")
      .first()
      .getAttribute("title");
    const t = String(title ?? "").trim();
      setCurrentOpenChatTitleFromSidebar(t);
      return t || null;
  } catch {
    globalThis.__currentOpenChatTitle = null;
    globalThis.__currentOpenChatTitleTS = 0;
    return null;
  }
}

/**
 * Main panel header title from `#main header span[title]` (explicit DOM check).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function readMainHeaderSpanTitle(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#main header span[title]");
    return el ? el.innerText.trim() : null;
  });
}

/**
 * Recover from WhatsApp Web "no chat" / marketing pane (e.g. "Download WhatsApp for Mac").
 * Validates via header DOM, not click success. Run before rotation and extraction.
 * @param {import("playwright").Page} page
 * @returns {Promise<boolean>} true when a conversation header is visible
 */
async function ensureWhatsAppConversationOpen(page) {
  let headerTitle = await readMainHeaderSpanTitle(page);
  if (headerTitle) return true;

  const rowLocator = page.locator('#pane-side div[role="row"]');
  const rowCount = await rowLocator.count();
  if (rowCount === 0) {
    console.error("🚫 Chat still not open — no sidebar rows");
    return false;
  }

  const visibleChats = await getTopChats(page, 30);
  const recoveryPlan = resolveConversationRecoveryTargetsForVisibleChats({
    visibleChats,
    trustedTargets: [
      activeChatLockKey(),
      globalThis.__ACTIVE_PROCESSING_CHAT,
      globalThis.__forceNextChat,
      ...(globalThis.__pendingChats instanceof Set
        ? Array.from(globalThis.__pendingChats)
        : []),
      globalThis.__activeChatInFocus,
      globalThis.__activeChatTitle,
      globalThis.__currentOpenChatTitle,
    ],
    configuredGroupTargets: resolveTargetGroups(),
    allowedTitles: resolvePlaywrightAllowedChatTitles(),
  });
  const recoveryTargets = recoveryPlan.targets;

  if (recoveryTargets.length === 0) {
    console.error("🚫 Empty pane recovery failed — no trusted recovery target found");
    console.warn("[playwright_recovery_skipped_no_trusted_target]", {
      allowlistConfigured: recoveryPlan.allowlistConfigured,
      visibleChatCount: visibleChats.length,
    });
    return false;
  }

  const isEmptyState = await page.evaluate(() =>
    document.body.innerText.includes("Download WhatsApp for Mac")
  );
  console.warn(
    isEmptyState
      ? "⚠️ Empty state detected — recovering target chat"
      : "⚠️ No conversation header — recovering target chat"
  );

  for (const targetName of recoveryTargets) {
    const target = String(targetName ?? "").trim();
    if (!target) continue;
    console.log("🧭 Recovery target:", target);
    const reopened = await openChatAndConfirm(page, target);
    if (!reopened) {
      continue;
    }
    headerTitle = await readMainHeaderSpanTitle(page);
    if (headerTitle) {
      setCurrentOpenChatTitleFromSidebar(target);
      return true;
    }
  }

  console.error("🚫 Chat still not open — all recovery targets failed");
  return false;
}

/**
 * Resolve trusted recovery targets for an open WhatsApp conversation pane.
 * @internal Tests
 */
export function __resolveConversationRecoveryTargetsForTests({
  visibleChats = [],
  trustedTargets = [],
  configuredGroupTargets = [],
  allowedTitles = [],
} = {}) {
  return resolveConversationRecoveryTargetsForVisibleChats({
    visibleChats,
    trustedTargets,
    configuredGroupTargets,
    allowedTitles,
  });
}

function resolveConversationRecoveryTargetsForVisibleChats({
  visibleChats = [],
  trustedTargets = [],
  configuredGroupTargets = [],
  allowedTitles = [],
} = {}) {
  const normalizedVisibleChats = Array.isArray(visibleChats) ? visibleChats : [];
  const normalizedTrustedTargets = Array.isArray(trustedTargets) ? trustedTargets : [];
  const normalizedConfiguredGroupTargets = Array.isArray(configuredGroupTargets)
    ? configuredGroupTargets
    : [];
  const normalizedAllowedTitles = Array.isArray(allowedTitles) ? allowedTitles : [];
  const allowlistConfigured = normalizedAllowedTitles.length > 0;
  const allowedSet = new Set(
    normalizedAllowedTitles.map((title) => normalizeTitle(String(title ?? "").trim())).filter(Boolean)
  );
  const configuredGroupSet = new Set(
    normalizedConfiguredGroupTargets
      .map((title) => normalizeTitle(String(title ?? "").trim()))
      .filter(Boolean)
  );
  const trustedKeys = [];
  for (const value of normalizedTrustedTargets) {
    const key = normalizeTitle(String(value ?? "").trim());
    if (!key || trustedKeys.includes(key)) continue;
    trustedKeys.push(key);
  }

  if (configuredGroupSet.size === 0 && !allowlistConfigured) {
    return {
      targets: [],
      allowlistConfigured,
      source: "none",
    };
  }

  const configuredVisibleChats = normalizedVisibleChats.filter((name) => {
    const key = normalizeTitle(name);
    return (
      isValidBusinessChat(name) &&
      (configuredGroupSet.has(key) || allowedSet.has(key))
    );
  });

  const trustedMatches = trustedKeys
    .map((key) => configuredVisibleChats.find((name) => normalizeTitle(name) === key))
    .filter((name) => isValidBusinessChat(name));

  if (trustedMatches.length > 0) {
    return {
      targets: trustedMatches,
      allowlistConfigured,
      source: "trusted",
    };
  }

  const configuredGroupMatches = configuredVisibleChats.filter((name) =>
    configuredGroupSet.has(normalizeTitle(name))
  );
  if (configuredGroupMatches.length > 0) {
    return {
      targets: configuredGroupMatches,
      allowlistConfigured,
      source: "configured_group",
    };
  }

  const allowedVisibleChats = configuredVisibleChats.filter((name) =>
    allowedSet.has(normalizeTitle(name))
  );

  return {
    targets: allowedVisibleChats,
    allowlistConfigured,
    source: allowedVisibleChats.length > 0 ? "allowlist" : "allowlist_empty",
  };
}

/** Set PLAYWRIGHT_DEBUG=1 (or true) for verbose poll / dedupe logs. */
const DEBUG =
  process.env.PLAYWRIGHT_DEBUG === "1" ||
  /^true$/i.test(String(process.env.PLAYWRIGHT_DEBUG ?? ""));

/** Set DEBUG=1 or PLAYWRIGHT_DEBUG for sensitive tracing (e.g. tracking keys). */
const TRACE_DEBUG =
  DEBUG ||
  process.env.DEBUG === "1" ||
  /^true$/i.test(String(process.env.DEBUG ?? ""));

const MAX_ACTIVE_JOB_MS = 10_000;

const normalize = (s) => String(s || "").trim().toLowerCase();

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function groupSenderScopeFromAnchor(groupKey, senderAnchor) {
  const g = String(groupKey ?? "").trim().toLowerCase();
  const a = String(senderAnchor ?? "").trim().toLowerCase();
  if (!g || !a) return "";
  return createHash("sha256")
    .update(`${g}::${a}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Group reply-after guard: match participant rows with stable keys when present.
 * @param {{ participantKey?: string | null, sender?: string }} a
 * @param {{ participantKey?: string | null, sender?: string }} b
 */
function isSameParticipant(a, b) {
  if (a.participantKey && b.participantKey) {
    return a.participantKey === b.participantKey;
  }
  if (!a.participantKey && !b.participantKey) {
    return Boolean(a.sender && b.sender && a.sender === b.sender);
  }
  return false;
}

/**
 * Same participant resolution as {@link userMessages} enrichment, for raw `sorted` rows.
 * @param {object} m
 * @param {string} normalizedGroupChatKey
 */
function participantComparableFromSortedRow(m, normalizedGroupChatKey) {
  const senderScope =
    groupSenderScopeFromAnchor(normalizedGroupChatKey, m.senderAnchor) || "";
  const identity = resolveParticipantIdentity({
    participantPhone: m.participantPhone,
    participantName: m.participantName,
    senderAnchor: m.senderAnchor,
    groupChatKey: normalizedGroupChatKey,
    senderScope,
  });
  return {
    participantKey: identity.participantKey || null,
    sender: String(m?.sender ?? "").trim() || "user",
  };
}

function resolveOwnerUid() {
  return clean(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  );
}

const OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT =
  "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT";

const WRONG_DM_RECOVERY_ERROR_CODES = new Set([
  "DM_CHAT_CHANGED",
  "REPLY_PRIVATE_DM_TARGET_MISMATCH",
  "REPLY_PRIVATE_WRONG_HEADER",
  "INVALID_DM_TARGET",
  "WRONG_CHAT",
  "TARGET_PARTICIPANT_MISMATCH",
  "PHONE_MISMATCH",
  "ROW_KEY_NAME_MISMATCH",
  "NAME_MISMATCH",
  "BASE_KEY_TITLE_MISMATCH",
]);

function sourceIdentityForDmWatch(data = {}) {
  return data?.sourceIdentity && typeof data.sourceIdentity === "object"
    ? data.sourceIdentity
    : null;
}

function participantIdentityForDmWatch(data = {}) {
  const identity = sourceIdentityForDmWatch(data) || {};
  const participantName =
    clean(
      identity.participantDisplayName ??
        identity.participantName ??
        data?.sourceParticipantName ??
        data?.originalCustomerDisplayName ??
        data?.participantName
    ) || "";
  const participantKey =
    clean(
      identity.participantKey ??
        data?.sourceParticipantKey ??
        identity.participantPhone ??
        data?.sourceParticipantPhone ??
        data?.originalCustomerPhone ??
        data?.senderScope
    ) || "";
  const participantPhone =
    clean(
      identity.participantPhone ??
        data?.sourceParticipantPhone ??
        data?.originalCustomerPhone
    ) || "";
  return { participantName, participantKey, participantPhone };
}

function dmTargetMatchesParticipantIdentity({ data = {}, dmKey = "", dmTitle = "" } = {}) {
  const { participantName, participantKey, participantPhone } =
    participantIdentityForDmWatch(data);
  const dmKeys = [
    normalizeTitle(dmKey),
    normalizeTitle(dmTitle),
    normalizeTitle(clean(data?.dmPlaywrightChatKey || "")),
    normalizeTitle(clean(data?.dmChatTitle || "")),
  ].filter(Boolean);
  const identityKeys = [
    participantName,
    participantKey,
    participantPhone,
    data?.sourceIdentity?.participantDisplayName,
    data?.sourceIdentity?.participantName,
    data?.sourceIdentity?.participantPhone,
    data?.sourceParticipantName,
    data?.sourceParticipantKey,
    data?.sourceParticipantPhone,
    data?.originalCustomerDisplayName,
    data?.originalCustomerPhone,
  ]
    .map((value) => normalizeTitle(clean(value)))
    .filter(Boolean);

  if (dmKeys.some((key) => identityKeys.includes(key))) return true;

  const phoneDigits = String(participantPhone ?? "").replace(/\D/g, "");
  if (phoneDigits.length >= 7) {
    return dmKeys.some((key) => key.replace(/\D/g, "").includes(phoneDigits));
  }
  return false;
}

function dmWatchRecoveryDecision({
  docId = "",
  data = {},
  dmKey = "",
  approvalStage = "",
  logisticsState = {},
  dmKeyActiveCounts = new Map(),
} = {}) {
  const approvalCustomerNotificationError = clean(data?.approvalCustomerNotificationError);
  const sourceIdentity = sourceIdentityForDmWatch(data);
  const { participantName, participantKey, participantPhone } =
    participantIdentityForDmWatch(data);
  const hasParticipantIdentity = Boolean(participantName || participantKey || participantPhone);
  const hasDmKey = Boolean(dmKey || clean(data?.dmChatTitle));
  const wrongDmMismatch = WRONG_DM_RECOVERY_ERROR_CODES.has(
    approvalCustomerNotificationError
  );
  const ambiguousDmKey = Boolean(dmKey && Number(dmKeyActiveCounts.get(dmKey) ?? 0) > 1);
  const baseLog = {
    bookingId: docId || null,
    status: clean(data?.status) || null,
    approvalCustomerNotificationError: approvalCustomerNotificationError || null,
    hasDmKey,
    hasSourceIdentity: Boolean(sourceIdentity),
    logisticsComplete: logisticsState?.complete === true,
    ambiguousDmKey,
    wrongDmMismatch,
  };

  const fail = (reason) => {
    console.log("[dm_watch_recovery_excluded]", {
      ...baseLog,
      reason,
    });
    return { ok: false, reason };
  };

  if (clean(data?.status) !== "approved") return fail("STATUS_NOT_APPROVED");
  if (clean(data?.bookingSource) !== "PLAYWRIGHT_GROUP") {
    return fail("BOOKING_SOURCE_NOT_PLAYWRIGHT_GROUP");
  }
  if (approvalCustomerNotificationError !== OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT) {
    return fail("ERROR_NOT_UNVERIFIED_AFTER_ATTEMPT");
  }
  if (wrongDmMismatch) return fail("WRONG_DM_MISMATCH");
  if (data?.dmOpened !== true) return fail("DM_NOT_OPENED");
  if (data?.dmSendAttempted !== true) return fail("DM_SEND_NOT_ATTEMPTED");
  if (!hasDmKey) return fail("DM_KEY_MISSING");
  if (!sourceIdentity) return fail("MISSING_SOURCE_IDENTITY");
  if (!hasParticipantIdentity) return fail("PARTICIPANT_IDENTITY_MISSING");
  if (!dmTargetMatchesParticipantIdentity({ data, dmKey, dmTitle: data?.dmChatTitle })) {
    return fail("DM_TARGET_PARTICIPANT_MISMATCH");
  }
  if (logisticsState?.complete === true || data?.deliveryDetailsCollectedAt) {
    return fail("LOGISTICS_COMPLETE");
  }
  if (
    approvalStage === "delivery_details_collected" ||
    approvalStage === "completed" ||
    approvalStage === "rejected" ||
    approvalStage === "cancelled"
  ) {
    return fail("BOOKING_STAGE_NOT_ACTIVE");
  }
  if (ambiguousDmKey) return fail("AMBIGUOUS_DM_KEY");
  return {
    ok: true,
    watchOnlyRecovery: true,
    recoveryReason: OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT,
  };
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (typeof value?.toMillis === "function") {
    const ms = Number(value.toMillis());
    return Number.isFinite(ms) ? ms : 0;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return numeric;
    if (numeric > 1_000_000_000) return numeric * 1000;
  }
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function __isDmWatchMessageOlderThanBookingMarkersForTests({
  messageTimestamp,
  booking,
  toleranceMs = 30_000,
} = {}) {
  const messageMs = timestampToMillis(messageTimestamp);
  if (!messageMs) return false;
  const markerMs = Math.max(
    timestampToMillis(booking?.dmStartedAt),
    timestampToMillis(booking?.approvalCustomerNotificationSentAt),
    timestampToMillis(booking?.deliveryDetailsCollectedAt),
    timestampToMillis(booking?.updatedAt)
  );
  return Boolean(markerMs && messageMs + Number(toleranceMs || 0) < markerMs);
}

function envTruthy(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Default off — set PLAYWRIGHT_DM_CONTINUATION_ENABLED=true to enable DM watch/continuation. */
export function isPlaywrightDmContinuationEnabled() {
  return envTruthy(process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED);
}

/**
 * Load DM watch targets from active approved bookings that already completed Reply Privately DM send.
 * Additive only: does NOT change group scanning; only enables scanning for specific DM chats.
 */
export async function loadActiveDmWatchTargets({
  dbInstance = db,
  ownerUserId = resolveOwnerUid(),
  limit = 25,
} = {}) {
  if (!isPlaywrightDmContinuationEnabled()) {
    return { keys: new Set(), byKey: new Map(), count: 0 };
  }
  const uid = clean(ownerUserId);
  if (!dbInstance || !uid) return { keys: new Set(), byKey: new Map(), count: 0 };
  try {
    const snap = await dbInstance
      .collection("businesses")
      .doc(uid)
      .collection("bookings")
      .where("status", "==", "approved")
      .limit(limit)
      .get();
    const docs = snap?.docs ?? [];
    const keys = new Set();
    const byKey = new Map();
    const logisticsCompletionPolicy = resolveLogisticsCompletionPolicy();
    const waitingStages = new Set([
      "owner_approved_waiting_customer_details",
      "waiting_customer_details",
    ]);
    const dmKeyActiveCounts = new Map();
    for (const doc of docs) {
      const data = doc.data() || {};
      const approvalStage = clean(data?.approvalStage).toLowerCase();
      const dmKey = normalizeTitle(clean(data?.dmPlaywrightChatKey || "")) ||
        normalizeTitle(clean(data?.dmChatTitle || ""));
      if (!dmKey) continue;
      if (clean(data?.status) !== "approved") continue;
      if (
        approvalStage === "delivery_details_collected" ||
        approvalStage === "completed" ||
        approvalStage === "rejected" ||
        approvalStage === "cancelled" ||
        data?.deliveryDetailsCollectedAt
      ) {
        continue;
      }
      const logisticsState = getBookingLogisticsCompletionState(
        data,
        logisticsCompletionPolicy
      );
      if (logisticsState.complete) continue;
      if (approvalStage && !waitingStages.has(approvalStage)) continue;
      dmKeyActiveCounts.set(dmKey, Number(dmKeyActiveCounts.get(dmKey) ?? 0) + 1);
    }
    for (const doc of docs) {
      const data = doc.data() || {};
      const approvalCustomerNotificationStatus = clean(
        data?.approvalCustomerNotificationStatus
      );
      const approvalCustomerNotificationError = clean(
        data?.approvalCustomerNotificationError
      );
      const isDmActuallySent =
        approvalCustomerNotificationStatus === "sent" ||
        data?.dmMessageSent === true ||
        data?.dmOpened === true;
      if (!isDmActuallySent) {
        continue;
      }
      const approvalStage = clean(data?.approvalStage).toLowerCase();
      const dmKey = normalizeTitle(clean(data?.dmPlaywrightChatKey || "")) ||
        normalizeTitle(clean(data?.dmChatTitle || ""));
      const logisticsState = getBookingLogisticsCompletionState(
        data,
        logisticsCompletionPolicy
      );
      let watchOnlyRecovery = false;
      let recoveryReason = null;
      if (
        data?.approvalCustomerNotificationTerminalFailure === true &&
        data?.dmSendAttempted === true &&
        data?.requiresManualReview === true
      ) {
        const recovery = dmWatchRecoveryDecision({
          docId: doc.id,
          data,
          dmKey,
          approvalStage,
          logisticsState,
          dmKeyActiveCounts,
        });
        if (!recovery.ok) {
          console.log("[playwright_dm_watch_target_skipped_terminal_manual_review]", {
            bookingId: doc.id,
            approvalCustomerNotificationStatus: approvalCustomerNotificationStatus || null,
            dmMessageSent: data?.dmMessageSent === true,
            dmOpened: data?.dmOpened === true,
            requiresManualReview: data?.requiresManualReview === true,
          });
          continue;
        }
        watchOnlyRecovery = true;
        recoveryReason = recovery.recoveryReason;
        const { participantName, participantKey } = participantIdentityForDmWatch(data);
        console.log("[dm_watch_target_included_via_unverified_send_recovery]", {
          bookingId: doc.id,
          dmChatTitle: clean(data?.dmChatTitle) || null,
          hasDmPlaywrightChatKey: clean(data?.dmPlaywrightChatKey) !== "",
          participantName: participantName || null,
          participantKey: participantKey || null,
          approvalCustomerNotificationStatus: approvalCustomerNotificationStatus || null,
          approvalCustomerNotificationError: approvalCustomerNotificationError || null,
          dmOpened: data?.dmOpened === true,
          dmSendAttempted: data?.dmSendAttempted === true,
          dmMessageSent: data?.dmMessageSent === true,
          requiresManualReview: data?.requiresManualReview === true,
          watchOnlyRecovery: true,
        });
      }
      if (
        approvalCustomerNotificationStatus !== "sent" &&
        (data?.dmMessageSent === true || data?.dmOpened === true)
      ) {
        console.log("[playwright_dm_watch_target_included_via_fallback]", {
          bookingId: doc.id,
          approvalCustomerNotificationStatus: approvalCustomerNotificationStatus || null,
          dmMessageSent: data?.dmMessageSent === true,
          dmOpened: data?.dmOpened === true,
        });
      }
      if (
        approvalStage === "delivery_details_collected" ||
        data?.deliveryDetailsCollectedAt
      ) {
        console.log("[playwright_dm_watch_target_excluded_completed]", {
          bookingId: doc.id,
          approvalStage: approvalStage || null,
          hasDeliveryDetailsCollectedAt: Boolean(data?.deliveryDetailsCollectedAt),
          deliveryConversationStarted: data?.deliveryConversationStarted === true,
        });
        continue;
      }
      if (logisticsState.complete) {
        console.log("[playwright_dm_watch_target_skipped_logistics_complete]", {
          bookingId: doc.id,
          dmChatKey: dmKey || null,
          approvalStage: approvalStage || null,
          deliveryMethod: clean(data?.deliveryMethod) || null,
          hasDeliveryAddress: clean(data?.deliveryAddress) !== "",
          hasDeliveryTime: clean(data?.deliveryTime) !== "",
          deliveryDetailsCollectedAtPresent: Boolean(data?.deliveryDetailsCollectedAt),
          completionReason: logisticsState.reason,
        });
        continue;
      }
      if (approvalStage && !waitingStages.has(approvalStage)) {
        continue;
      }
      if (!dmKey) continue;
      keys.add(dmKey);
      const identity = sourceIdentityForDmWatch(data);
      const updatedAtMs = timestampToMillis(data?.updatedAtMs ?? data?.updatedAt);
      const dmWatchSortMs = Math.max(
        timestampToMillis(data?.approvalCustomerNotificationSentAt),
        timestampToMillis(data?.dmStartedAt),
        updatedAtMs
      );
      const entry = {
        bookingId: doc.id,
        updatedAtMs,
        dmWatchSortMs,
        approvalStage: approvalStage || null,
        deliveryMethod: clean(data?.deliveryMethod) || null,
        hasDeliveryAddress: clean(data?.deliveryAddress) !== "",
        hasDeliveryTime: clean(data?.deliveryTime) !== "",
        dmStartedAt: data?.dmStartedAt ?? null,
        updatedAt: data?.updatedAt ?? data?.updatedAtMs ?? null,
        approvalCustomerNotificationSentAt:
          data?.approvalCustomerNotificationSentAt ?? null,
        deliveryDetailsCollectedAt: data?.deliveryDetailsCollectedAt ?? null,
        dmChatTitle: clean(data?.dmChatTitle) || null,
        dmPlaywrightChatKey: clean(data?.dmPlaywrightChatKey) || null,
        sourceIdentity: identity,
        participantKey:
          clean(
            data?.sourceIdentity?.participantKey ??
              data?.sourceParticipantKey ??
              data?.sourceIdentity?.participantPhone ??
              data?.sourceParticipantPhone ??
              data?.originalCustomerPhone ??
              ""
          ) || null,
        participantName:
          clean(
            data?.sourceIdentity?.participantDisplayName ??
              data?.sourceIdentity?.participantName ??
              data?.sourceParticipantName ??
              data?.originalCustomerDisplayName ??
              ""
          ) || null,
        participantPhoneForDm:
          clean(
            data?.sourceIdentity?.participantPhone ??
              data?.sourceParticipantPhone ??
              data?.originalCustomerPhone ??
              ""
          ) || null,
        originalGroupName: clean(data?.sourceGroupName ?? data?.groupName) || null,
        originalGroupChatKey:
          clean(data?.sourcePlaywrightChatKey ?? data?.playwrightChatKey ?? data?.chatKey) ||
          null,
        ...(watchOnlyRecovery
          ? {
              watchOnlyRecovery: true,
              recoveryReason,
            }
          : {}),
      };
      const arr = byKey.get(dmKey) ?? [];
      arr.push(entry);
      byKey.set(dmKey, arr);
    }
    return { keys, byKey, count: keys.size };
  } catch (err) {
    return { keys: new Set(), byKey: new Map(), count: 0, error: clean(err?.message ?? err) };
  }
}

function normalizedTargetGroupKeys(targetGroups) {
  const groups = Array.isArray(targetGroups) ? targetGroups : null;
  if (groups === null) return null;
  const out = new Set();
  for (const g of groups) {
    const key = normalizeTitle(String(g ?? "").trim());
    if (key) out.add(key);
  }
  return out;
}

function buildWatchedDmAllowlist({ dmWatchTargets, targetGroups } = {}) {
  const keys = new Set();
  const byKey =
    dmWatchTargets && dmWatchTargets.byKey instanceof Map
      ? dmWatchTargets.byKey
      : new Map();
  const groupKeyAllow = normalizedTargetGroupKeys(targetGroups);
  let added = 0;

  for (const [dmChatKey, list] of byKey.entries()) {
    const items = Array.isArray(list) ? list : [];
    if (items.length === 0) continue;
    const first = items[0] || {};
    const bookingId = clean(first.bookingId) || null;
    const dmKey = normalizeTitle(dmChatKey);
    const sourceGroupKey = clean(first.originalGroupChatKey || "") || null;
    const sourceGroupName = clean(first.originalGroupName || "") || null;

    const groupAllowedByName = sourceGroupName
      ? chatRowMatchesTargets(sourceGroupName, targetGroups)
      : false;
    const groupAllowedByKey =
      groupKeyAllow === null
        ? true
        : Boolean(sourceGroupKey && groupKeyAllow.has(normalizeTitle(sourceGroupKey)));
    const allowed = groupAllowedByName || groupAllowedByKey;
    if (!allowed) {
      console.log("[playwright_dm_watch_allowlist_excluded]", {
        bookingId,
        reason: "SOURCE_GROUP_NOT_ALLOWED",
      });
      continue;
    }

    if (!dmKey) {
      console.log("[playwright_dm_watch_allowlist_excluded]", {
        bookingId,
        reason: "DM_KEY_MISSING",
      });
      continue;
    }

    keys.add(dmKey);
    added += 1;
    console.log("[playwright_dm_watch_allowlist_added]", {
      bookingId,
      dmChatKey: dmKey,
      sourceGroupKey: normalizeTitle(sourceGroupKey || sourceGroupName || "") || null,
    });
  }

  console.log("[playwright_dm_watch_allowlist_built]", { count: keys.size });
  return keys;
}

function pickDmBookingHint(dmChatKey, bookingsByKey) {
  const list = bookingsByKey?.get(dmChatKey) ?? [];
  if (list.length === 0) return { ok: false, reason: "NO_BOOKING_MATCH", hint: null };
  if (list.length === 1) return { ok: true, hint: list[0], ambiguous: false };
  const sorted = [...list].sort(
    (a, b) => Number(b.dmWatchSortMs || b.updatedAtMs || 0) - Number(a.dmWatchSortMs || a.updatedAtMs || 0)
  );
  const newestMs = Number(sorted[0]?.dmWatchSortMs || sorted[0]?.updatedAtMs || 0);
  const secondMs = Number(sorted[1]?.dmWatchSortMs || sorted[1]?.updatedAtMs || 0);
  if (Number.isFinite(newestMs) && newestMs > 0 && newestMs > secondMs) {
    console.log("[playwright_dm_continuation_latest_target_selected]", {
      dmChatKey,
      bookingId: sorted[0]?.bookingId || null,
      displacedBookingIds: sorted.slice(1).map((b) => b.bookingId).filter(Boolean),
    });
    return { ok: true, hint: sorted[0], ambiguous: false, resolvedBy: "LATEST_DM_HANDOFF" };
  }
  // If multiple active bookings still match this DM key without a unique newest handoff, treat as ambiguous.
  return { ok: false, reason: "AMBIGUOUS_MATCH", bookingIds: sorted.map((b) => b.bookingId), hint: null };
}

export function __shouldProcessChatForTests({ chatTitle, targetGroups, activeDmChatKeys }) {
  const title = String(chatTitle ?? "").trim();
  if (!title) return false;
  if (chatRowMatchesTargets(title, targetGroups)) return true;
  const key = normalizeTitle(title);
  return Boolean(key && activeDmChatKeys instanceof Set && activeDmChatKeys.has(key));
}

export function __selectWatchedDmPriorityCandidateForTests(args = {}) {
  return selectWatchedDmPriorityCandidateFromRows(args);
}

export function __resolveDmContinuationMessageDecisionForTests(args = {}) {
  return resolveDmContinuationMessageDecision(args);
}

export function __buildDmContinuationDedupeKeyForTests(row) {
  return buildDmContinuationDedupeKey(row);
}

export function __planDmContinuationHandlingForTests(args = {}) {
  return planDmContinuationHandling(args);
}

export function __pickDmBookingHintForTests(dmChatKey, bookingsByKey) {
  return pickDmBookingHint(dmChatKey, bookingsByKey);
}

export function __resolveBoundedDmProbeRestoreTargetForTests(args = {}) {
  return resolveBoundedDmProbeRestoreTarget(args);
}

const DM_WATCH_PROBE_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.PLAYWRIGHT_DM_WATCH_PROBE_INTERVAL_MS ?? 20_000) || 20_000
);
const DM_WATCH_SIDEBAR_SCAN_LIMIT = Math.max(
  1,
  Math.min(
    30,
    Number.parseInt(String(process.env.PLAYWRIGHT_DM_WATCH_SIDEBAR_SCAN_LIMIT ?? "30"), 10) ||
      30
  )
);

function dmWatchProbeState() {
  if (!(globalThis.__dmWatchLastProbeAtByKey instanceof Map)) {
    globalThis.__dmWatchLastProbeAtByKey = new Map();
  }
  return globalThis.__dmWatchLastProbeAtByKey;
}

function selectWatchedDmPriorityCandidateFromRows({
  rowSignals,
  activeDmChatKeys,
  activeDmTargetsByKey,
  targetGroups,
  currentActiveTitle,
  lastMessageSnapshot = lastMessageMap,
  allowProbe = true,
  now = Date.now(),
  probeIntervalMs = DM_WATCH_PROBE_INTERVAL_MS,
  probeState = dmWatchProbeState(),
} = {}) {
  const keys = activeDmChatKeys instanceof Set ? activeDmChatKeys : new Set();
  if (!keys.size) {
    console.log("[dm_probe_no_watch_targets]");
    return null;
  }
  const curKey = normalizeTitle(String(currentActiveTitle ?? "").trim());
  const rows = Array.isArray(rowSignals) ? rowSignals : [];
  let watchedRowsSeen = 0;
  const targetGroupSignal = resolveTargetGroupSidebarSignal({
    rowSignals: rows,
    activeDmChatKeys: keys,
    targetGroups,
    lastMessageSnapshot,
  });

  for (const r of rows) {
    const chatTitle = String(r?.title ?? "").trim();
    if (!chatTitle) continue;
    const chatKey = normalizeTitle(chatTitle);
    const isWatched = Boolean(chatKey && keys.has(chatKey));
    const isAlreadyActive = Boolean(curKey && chatKey && chatKey === curKey);
    const hasUnread = Boolean(r?.hasUnread);
    const hasBold = Boolean(r?.hasBold || r?.boldPoints);
    const preview = String(r?.previewSnippet ?? "");
    const norm = normalizePreview(preview);
    const lastProcessedPreview = String(lastMessageSnapshot?.[chatTitle] ?? "");
    const previewLooksOutgoing = sidebarPreviewLooksOutgoing(preview);
    const previewDelta = Boolean(
      lastProcessedPreview &&
        norm &&
        norm !== lastProcessedPreview &&
        !previewLooksOutgoing
    );

    if (!isWatched) {
      if (TRACE_DEBUG) {
        console.log("[playwright_dm_watch_priority_skipped_not_watched]", {
          chatTitle,
          chatKey: chatKey || null,
        });
      }
      continue;
    }
    watchedRowsSeen += 1;

    console.log("[playwright_dm_watch_priority_candidate]", { chatTitle, chatKey });

    let selected = false;
    let selectReason = "";
    let skipReason = "";
    const lastProbeAt = Number(probeState?.get?.(chatKey) ?? 0);
    const probeDue = Boolean(
      allowProbe &&
        chatKey &&
        !isAlreadyActive &&
        !hasUnread &&
        !previewDelta &&
        (!Number.isFinite(lastProbeAt) || now - lastProbeAt >= probeIntervalMs)
    );

    if (isAlreadyActive) {
      skipReason = "ALREADY_ACTIVE";
    } else if (hasUnread) {
      selected = true;
      selectReason = "UNREAD";
    } else if (previewDelta) {
      selected = true;
      selectReason = "PREVIEW_DELTA";
    } else if (probeDue) {
      if (targetGroupSignal) {
        skipReason = "TARGET_GROUP_SIGNAL_PRESENT";
        console.log("[dm_probe_skipped_group_signal]", {
          chatTitle,
          chatKey,
          groupTitle: targetGroupSignal.title,
          groupReason: targetGroupSignal.reason,
        });
      } else {
        selected = true;
        selectReason = "BOUNDED_WATCH_PROBE";
      }
    } else {
      skipReason = "NO_UNREAD_PREVIEW_DELTA_OR_PROBE_DUE";
    }

    if (skipReason === "NO_UNREAD_PREVIEW_DELTA_OR_PROBE_DUE") {
      const waitMs =
        Number.isFinite(lastProbeAt) && lastProbeAt > 0
          ? Math.max(0, probeIntervalMs - (now - lastProbeAt))
          : null;
      console.log("[dm_probe_throttled]", {
        chatTitle,
        chatKey,
        lastProbeAt: lastProbeAt || null,
        waitMs,
      });
    }

    console.log("[playwright_dm_watch_priority_decision]", {
      chatTitle,
      chatKey,
      isWatched,
      isAlreadyActive,
      hasUnread,
      hasBold,
      preview: preview || null,
      lastProcessedPreview: lastProcessedPreview || null,
      previewLooksOutgoing,
      previewDelta,
      selected,
      selectReason: selectReason || null,
      skipReason: skipReason || null,
    });

    if (!selected) continue;
    console.log("[dm_probe_candidate_found]", {
      chatTitle,
      chatKey,
      selectReason,
    });
    if (selectReason === "BOUNDED_WATCH_PROBE" && probeState?.set) {
      probeState.set(chatKey, now);
    }

    return { chatTitle, chatKey, selectReason };
  }
  if (rows.length > 0 && watchedRowsSeen === 0) {
    console.log("[dm_probe_no_sidebar_match]", {
      watchCount: keys.size,
      sidebarRowsSeen: rows.length,
      watchedKeys: Array.from(keys).slice(0, 5),
    });
  }

  const byKey = activeDmTargetsByKey instanceof Map ? activeDmTargetsByKey : new Map();
  if (targetGroupSignal) {
    console.log("[dm_probe_skipped_group_signal]", {
      chatTitle: null,
      chatKey: null,
      groupTitle: targetGroupSignal.title,
      groupReason: targetGroupSignal.reason,
      selectReason: "BOUNDED_WATCH_SEARCH_PROBE",
    });
    return null;
  }
  for (const chatKey of keys) {
    if (!chatKey || (curKey && chatKey === curKey)) continue;
    const lastProbeAt = Number(probeState?.get?.(chatKey) ?? 0);
    const probeDue = Boolean(
      allowProbe &&
        (!Number.isFinite(lastProbeAt) || now - lastProbeAt >= probeIntervalMs)
    );
    if (!probeDue) {
      const waitMs =
        Number.isFinite(lastProbeAt) && lastProbeAt > 0
          ? Math.max(0, probeIntervalMs - (now - lastProbeAt))
          : null;
      console.log("[dm_probe_throttled]", {
        chatTitle: null,
        chatKey,
        lastProbeAt: lastProbeAt || null,
        waitMs,
      });
      continue;
    }
    const list = byKey.get(chatKey) ?? [];
    const first = Array.isArray(list) ? list[0] : null;
    const chatTitle = clean(first?.dmChatTitle || first?.participantName || "");
    if (!chatTitle) {
      console.log("[dm_probe_no_sidebar_match]", {
        watchCount: keys.size,
        sidebarRowsSeen: rows.length,
        watchedKeys: [chatKey],
        reason: "WATCH_TARGET_TITLE_MISSING",
      });
      continue;
    }
    if (probeState?.set) {
      probeState.set(chatKey, now);
    }
    console.log("[dm_probe_candidate_found]", {
      chatTitle,
      chatKey,
      selectReason: "BOUNDED_WATCH_SEARCH_PROBE",
    });
    return { chatTitle, chatKey, selectReason: "BOUNDED_WATCH_SEARCH_PROBE" };
  }
  return null;
}

function resolveTargetGroupSidebarSignal({
  rowSignals,
  activeDmChatKeys,
  targetGroups,
  lastMessageSnapshot = lastMessageMap,
} = {}) {
  const groups = Array.isArray(targetGroups) ? targetGroups : null;
  if (groups === null || groups.length === 0) return null;
  const dmKeys = activeDmChatKeys instanceof Set ? activeDmChatKeys : new Set();
  const rows = Array.isArray(rowSignals) ? rowSignals : [];
  for (const r of rows) {
    const title = String(r?.title ?? "").trim();
    if (!title || !chatRowMatchesTargets(title, groups)) continue;
    const key = normalizeTitle(title);
    if (key && dmKeys.has(key)) continue;
    const preview = String(r?.previewSnippet ?? "");
    const norm = normalizePreview(preview);
    const prev = String(lastMessageSnapshot?.[title] ?? "");
    const previewDelta = Boolean(
      prev &&
        norm &&
        norm !== prev &&
        !sidebarPreviewLooksOutgoing(preview)
    );
    if (r?.hasUnread) {
      return { title, reason: "UNREAD" };
    }
    if (r?.hasBold || r?.boldPoints) {
      return { title, reason: "BOLD" };
    }
    if (previewDelta) {
      return { title, reason: "PREVIEW_DELTA" };
    }
  }
  return null;
}

function resolveBoundedDmProbeRestoreTarget({
  selectReason,
  previousActiveTitle,
  targetGroups,
} = {}) {
  const reason = String(selectReason ?? "").trim();
  if (reason !== "BOUNDED_WATCH_PROBE" && reason !== "BOUNDED_WATCH_SEARCH_PROBE") {
    return null;
  }
  const target = String(previousActiveTitle ?? "").trim();
  if (!target) return null;
  if (!chatRowMatchesTargets(target, targetGroups)) return null;
  if (!isValidBusinessChat(target) || !isAllowedChat(target)) return null;
  return target;
}

async function restorePreviousGroupAfterBoundedDmProbe(page, targetGroupTitle) {
  const target = String(targetGroupTitle ?? "").trim();
  if (!target) return false;
  if (isReplyPrivateLockActive() || globalThis.__UI_SEND_LOCK) {
    console.log("[dm_probe_restore_skipped]", {
      targetGroupTitle: target,
      reason: isReplyPrivateLockActive() ? "REPLY_PRIVATE_LOCK_ACTIVE" : "UI_SEND_LOCK_ACTIVE",
    });
    return false;
  }
  let current = "";
  try {
    current = String((await getActiveChatName(page)) ?? "").trim();
  } catch {
    current = "";
  }
  if (current && normalizeTitle(current) === normalizeTitle(target)) {
    console.log("[dm_probe_restore_skipped]", {
      targetGroupTitle: target,
      reason: "ALREADY_ON_TARGET_GROUP",
    });
    return true;
  }
  console.log("[dm_probe_restore_attempt]", { targetGroupTitle: target });
  const opened = await openChatAndConfirm(page, target).catch((err) => {
    console.warn("[dm_probe_restore_failed]", {
      targetGroupTitle: target,
      reason: clean(err?.message ?? err) || "OPEN_FAILED",
    });
    return false;
  });
  if (!opened) {
    console.warn("[dm_probe_restore_failed]", {
      targetGroupTitle: target,
      reason: "OPEN_RETURNED_FALSE",
    });
    return false;
  }
  const headerMatches = await ensureHeaderMatches(page, target).catch(() => false);
  if (!headerMatches) {
    console.warn("[dm_probe_restore_failed]", {
      targetGroupTitle: target,
      reason: "HEADER_MISMATCH",
    });
    return false;
  }
  setCurrentOpenChatTitleFromSidebar(target);
  globalThis.__activeChatTitle = target;
  globalThis.__activeChatInFocus = target;
  console.log("[dm_probe_restore_success]", { targetGroupTitle: target });
  return true;
}

function buildDmContinuationDedupeKey(row) {
  const dataId = getExtractedWhatsAppDataId(row);
  if (dataId) {
    return {
      dedupeKey: `dataId::${dataId}`,
      dedupeKeySource: "data_id",
      dataId,
    };
  }
  const sourceIndex =
    Number.isFinite(Number(row?.sourceMessageIndex))
      ? Number(row.sourceMessageIndex)
      : -1;
  const idxForId = sourceIndex >= 0 ? String(sourceIndex) : "unknown";
  const prePlainText = String(row?.prePlainText ?? "").trim();
  const sender = String(row?.sender ?? "user").trim() || "user";
  const rawText = String(row?.text ?? "").replace(/\s+/g, " ").trim();
  const textKey = rawText.toLowerCase();
  const tsCandidate =
    row?.timestamp != null && String(row.timestamp).trim() !== ""
      ? String(row.timestamp).trim()
      : row?.__ts != null && String(row.__ts).trim() !== ""
        ? String(row.__ts).trim()
        : "";
  const tsNum = Number(tsCandidate);
  const tsLooksPlausible =
    (Number.isFinite(tsNum) && tsNum > 1_000_000_000_000) ||
    String(tsCandidate).length >= 10;
  const dedupeKey = prePlainText
    ? `${prePlainText}::${idxForId}`
    : tsCandidate && tsLooksPlausible
      ? `${sender}::${tsCandidate}`
      : `${sender}::${textKey}::${idxForId}`;
  return {
    dedupeKey,
    dedupeKeySource: "composite_fallback",
    dataId: null,
  };
}

function isEligibleDmCustomerRowForContinuation(row, booking) {
  const rawText = String(row?.text ?? "").replace(/\s+/g, " ").trim();
  if (!rawText) return false;
  const likelyAssistantDmOutbound =
    isLikelyAssistantOutboundCopy(rawText) ||
    /\bbooking confirm ho gayi hai\b/i.test(rawText) ||
    /\bbook\s*(?:kr|kar)\s*d[ou]\b/i.test(rawText);
  if (likelyAssistantDmOutbound) return false;
  const rowTimestampMs = getRowTimestampMs(row);
  if (
    __isDmWatchMessageOlderThanBookingMarkersForTests({
      messageTimestamp: rowTimestampMs || row?.timestamp,
      booking,
    })
  ) {
    return false;
  }
  return true;
}

function findLatestEligibleDmCustomerRow(sorted, booking) {
  const rows = Array.isArray(sorted) ? sorted : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.sender !== "user") continue;
    if (!isEligibleDmCustomerRowForContinuation(row, booking)) continue;
    return row;
  }
  return null;
}

function resolveDmContinuationMessageDecision({
  row,
  booking,
  lastProcessedMessageId = "",
  processedDataIds = null,
} = {}) {
  const sourceIndex =
    Number.isFinite(Number(row?.sourceMessageIndex))
      ? Number(row.sourceMessageIndex)
      : -1;
  const prePlainText = String(row?.prePlainText ?? "").trim();
  const sender = String(row?.sender ?? "user").trim() || "user";
  const rawText = String(row?.text ?? "").replace(/\s+/g, " ").trim();
  if (!rawText) {
    return {
      decision: "skip",
      reason: "EMPTY_TEXT",
      messageId: null,
      dedupeKey: null,
      dedupeKeySource: null,
      dataId: null,
      sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : null,
      rawText,
    };
  }
  const likelyAssistantDmOutbound =
    isLikelyAssistantOutboundCopy(rawText) ||
    /\bbooking confirm ho gayi hai\b/i.test(rawText) ||
    /\bbook\s*(?:kr|kar)\s*d[ou]\b/i.test(rawText);
  if (likelyAssistantDmOutbound) {
    return {
      decision: "skip",
      reason: "LIKELY_ASSISTANT_OUTBOUND_COPY",
      messageId: null,
      dedupeKey: null,
      dedupeKeySource: null,
      dataId: null,
      sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : null,
      rawText,
    };
  }
  const rowTimestampMs = getRowTimestampMs(row);
  if (
    __isDmWatchMessageOlderThanBookingMarkersForTests({
      messageTimestamp: rowTimestampMs || row?.timestamp,
      booking,
    })
  ) {
    return {
      decision: "skip",
      reason: "OLDER_THAN_REPLY_PRIVATE_MARKER",
      messageId: null,
      dedupeKey: null,
      dedupeKeySource: null,
      dataId: null,
      sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : null,
      rawText,
      rowTimestampMs: rowTimestampMs || null,
    };
  }
  const { dedupeKey, dedupeKeySource, dataId } = buildDmContinuationDedupeKey(row);
  const lastId = String(lastProcessedMessageId ?? "").trim();
  const seenDataIds =
    processedDataIds instanceof Set ? processedDataIds : null;
  if (dataId && seenDataIds?.has(dataId)) {
    return {
      decision: "skip",
      reason: "DUPLICATE_DM_DATA_ID",
      messageId: dedupeKey || null,
      dedupeKey: dedupeKey || null,
      dedupeKeySource,
      dataId,
      sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : null,
      rawText,
      rowTimestampMs: rowTimestampMs || null,
    };
  }
  const isDuplicate = Boolean(dedupeKey && dedupeKey === lastId);
  return {
    decision: dedupeKey && !isDuplicate ? "process" : "skip",
    reason: dedupeKey && !isDuplicate ? "NEW_DM_MESSAGE" : "DUPLICATE_DM_MESSAGE",
    messageId: dedupeKey || null,
    dedupeKey: dedupeKey || null,
    dedupeKeySource,
    dataId: dataId || null,
    sourceMessageIndex: sourceIndex >= 0 ? sourceIndex : null,
    rawText,
    rowTimestampMs: rowTimestampMs || null,
  };
}

function planDmContinuationHandling({
  sorted,
  booking,
  lastProcessedMessageId = "",
  baselineEstablished = false,
  processedDataIds = null,
} = {}) {
  const row = findLatestEligibleDmCustomerRow(sorted, booking);
  if (!row) {
    return {
      action: baselineEstablished ? "skip" : "baseline",
      reason: baselineEstablished ? "NO_ELIGIBLE_CUSTOMER_ROW" : "DM_FIRST_OPEN_NO_ELIGIBLE_ROW",
      row: null,
      decision: null,
    };
  }
  const dmDecision = resolveDmContinuationMessageDecision({
    row,
    booking,
    lastProcessedMessageId,
    processedDataIds,
  });
  if (!baselineEstablished) {
    return {
      action: "baseline",
      reason: "DM_FIRST_OPEN_BASELINE",
      row,
      decision: dmDecision,
    };
  }
  if (dmDecision.decision === "skip") {
    return {
      action: "skip",
      reason: dmDecision.reason || "SKIP",
      row,
      decision: dmDecision,
    };
  }
  return {
    action: "forward",
    reason: dmDecision.reason || "NEW_DM_MESSAGE",
    row,
    decision: dmDecision,
  };
}

function dmContinuationCursorState() {
  globalThis.__lastProcessedDmMsg =
    globalThis.__lastProcessedDmMsg || Object.create(null);
  globalThis.__lastProcessedDmMsgId =
    globalThis.__lastProcessedDmMsgId || Object.create(null);
  globalThis.__dmFirstOpenBaselineEstablished =
    globalThis.__dmFirstOpenBaselineEstablished || Object.create(null);
  globalThis.__processedDmDataIdsByKey =
    globalThis.__processedDmDataIdsByKey || Object.create(null);
  return {
    lastProcessedDmMsg: globalThis.__lastProcessedDmMsg,
    lastProcessedDmMsgId: globalThis.__lastProcessedDmMsgId,
    firstOpenBaselineEstablished: globalThis.__dmFirstOpenBaselineEstablished,
    processedDmDataIdsByKey: globalThis.__processedDmDataIdsByKey,
  };
}

function getOrCreateProcessedDmDataIdsSet(dmCursorKey) {
  const state = dmContinuationCursorState();
  if (!(state.processedDmDataIdsByKey[dmCursorKey] instanceof Set)) {
    state.processedDmDataIdsByKey[dmCursorKey] = new Set();
  }
  return state.processedDmDataIdsByKey[dmCursorKey];
}

function persistDmContinuationProcessedMarker(dmCursorKey, decision) {
  if (!decision) return;
  const state = dmContinuationCursorState();
  const dedupeKey = String(decision.dedupeKey ?? decision.messageId ?? "").trim();
  if (dedupeKey) {
    state.lastProcessedDmMsgId[dmCursorKey] = dedupeKey;
  }
  const dataId = String(decision.dataId ?? "").trim();
  if (dataId) {
    getOrCreateProcessedDmDataIdsSet(dmCursorKey).add(dataId);
  }
}

async function findWatchedDmPriorityCandidate(page, activeDmChatKeys, currentActiveTitle, targetGroups) {
  if (!isPlaywrightDmContinuationEnabled()) {
    return null;
  }
  const keys = activeDmChatKeys instanceof Set ? activeDmChatKeys : new Set();
  if (!keys.size) {
    console.log("[dm_probe_no_watch_targets]");
    return null;
  }
  const rowSignals = await page
    .evaluate((maxR) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const rows = Array.from(document.querySelectorAll('#pane-side div[role="row"]')).slice(0, maxR);
      return rows
        .map((row) => {
          const titleEl = row.querySelector('span[title]');
          const title = clean(titleEl?.getAttribute("title") || "");
          if (!title) return null;
          const spans = Array.from(row.querySelectorAll("span[dir='auto']"));
          const parts = spans.map((s) => clean(s.textContent || "")).filter(Boolean);
          const previewSnippet = parts.length ? parts[parts.length - 1] : "";
          const hasUnread = Boolean(
            row.querySelector("[data-testid='unread-count'], [data-testid*='unread']") ||
              row.querySelector('[data-icon=\"unread\"], [data-icon=\"status-unread\"], span[aria-label*=\"unread\" i]') ||
              /unread/i.test(row.getAttribute("aria-label") || "")
          );
          let hasBold = false;
          row.querySelectorAll("span[dir='auto']").forEach((el) => {
            try {
              const w = window.getComputedStyle(el).fontWeight;
              const n = parseInt(w, 10);
              if (n >= 600 || w === "bold" || w === "bolder") {
                hasBold = true;
              }
            } catch {
              /* ignore */
            }
          });
          return { title, previewSnippet, hasUnread, hasBold };
        })
        .filter(Boolean);
    }, DM_WATCH_SIDEBAR_SCAN_LIMIT)
    .catch(() => []);

  console.log("[dm_probe_sidebar_scanned]", {
    watchCount: keys.size,
    rowCount: rowSignals.length,
    scanLimit: DM_WATCH_SIDEBAR_SCAN_LIMIT,
    currentActiveTitle: String(currentActiveTitle ?? "").trim() || null,
  });

  return selectWatchedDmPriorityCandidateFromRows({
    rowSignals,
    activeDmChatKeys,
    activeDmTargetsByKey:
      globalThis.__activeDmWatchTargets?.byKey instanceof Map
        ? globalThis.__activeDmWatchTargets.byKey
        : new Map(),
    targetGroups,
    currentActiveTitle,
  });
}

/**
 * Stable per-row id for snapshot + delta (sender + text + timestamp + index; robust to DOM reuse).
 * @param {{ __rowKey?: string, sender?: string, text?: string, __ts?: number }} msg
 * @param {number} index
 */
function getMessageId(msg, index) {
  // CRITICAL: avoid relying on message text for uniqueness (repeated short replies like "5 din").
  const prePlainText = String(msg?.prePlainText ?? "").trim();
  const sourceIndexRaw = msg?.sourceMessageIndex ?? index;
  const sourceIndex = Number.isFinite(Number(sourceIndexRaw))
    ? Number(sourceIndexRaw)
    : index;
  if (prePlainText) {
    return `${prePlainText}::${sourceIndex}`;
  }

  const sender = String(msg?.sender ?? "unknown").trim() || "unknown";
  const ts =
    msg?.timestamp != null && String(msg.timestamp).trim() !== ""
      ? String(msg.timestamp).trim()
      : msg?.__ts != null && String(msg.__ts).trim() !== ""
        ? String(msg.__ts).trim()
        : "";
  if (ts) {
    return `${sender}::${ts}`;
  }

  const text = String(msg?.text || "").trim().toLowerCase();
  const tsNum = Number(msg?.__ts || 0);
  return `${sender}::${text}::${tsNum}::${index}`;
}

/**
 * Unified stable identity for selection, guarantee, suppression, cursor, and buffer payload.
 * Priority: WhatsApp data-id → rowKey → timestamp+text → prePlainText+text → text+participant hash.
 * Never uses DOM index alone (positions shift after replies).
 * @param {{ sender?: string, text?: string, __ts?: number, __rowKey?: string, prePlainText?: string, sourceMessageIndex?: unknown, timestamp?: string | number, participantKey?: string, id?: unknown, _data?: { id?: { _serialized?: unknown, id?: unknown } } }} msg
 * @param {Array<{ sender?: string, text?: string, __ts?: number }>} [extractedList]
 */
export function buildStableMessageKey(msg, extractedList = []) {
  const sender = String(msg?.sender ?? "unknown").trim() || "unknown";
  const participantScope =
    String(msg?.participantKey ?? "").trim() || sender;
  const rowKeyTrim = String(msg?.__rowKey ?? "").trim();
  const prePlainText = String(msg?.prePlainText ?? "").trim();
  const sourceIndexRaw = msg?.sourceMessageIndex;
  const sourceIndexFinite = Number.isFinite(Number(sourceIndexRaw));
  const sourceIndex = sourceIndexFinite ? Number(sourceIndexRaw) : null;

  const textNorm = String(msg?.text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const hasText = textNorm.length >= 1;

  const tsCandidate =
    msg?.timestamp != null && String(msg.timestamp).trim() !== ""
      ? String(msg.timestamp).trim()
      : msg?.__ts != null && String(msg.__ts).trim() !== ""
        ? String(msg.__ts).trim()
        : "";

  /**
   * @param {string} strategy
   * @param {string} id
   */
  function finish(strategy, id) {
    console.log("[id_strategy_selected]", {
      strategy,
      hasRowKey: Boolean(rowKeyTrim),
      hasPrePlainText: Boolean(prePlainText),
      hasIndex: sourceIndexFinite,
    });
    return { strategy, id };
  }

  const realId =
    msg?.id?._serialized ||
    msg?._data?.id?._serialized ||
    msg?.id?.id ||
    msg?._data?.id?.id;
  if (realId != null && String(realId).trim() !== "") {
    return finish("WHATSAPP_DATA_ID", `wa::${String(realId).trim()}`);
  }

  if (rowKeyTrim) {
    return finish("ROW_KEY", `${sender}::row::${rowKeyTrim}`);
  }

  if (tsCandidate && hasText) {
    return finish(
      "TIMESTAMP_TEXT_HASH",
      `${sender}::ts::${tsCandidate}::${hash(textNorm)}`
    );
  }

  if (prePlainText && hasText) {
    return finish(
      "PRE_PLAIN_TEXT_TEXT_HASH",
      `${sender}::ppt::${hash(prePlainText)}::${hash(textNorm)}`
    );
  }

  if (tsCandidate) {
    const tsNum = Number(tsCandidate);
    const plausibleEpoch = Number.isFinite(tsNum) && tsNum > 1_000_000_000_000;
    const plausibleLength = String(tsCandidate).length >= 10;
    if (plausibleEpoch || plausibleLength) {
      return finish("TIMESTAMP", `${sender}::${tsCandidate}`);
    }
  }

  if (hasText) {
    const windowPart =
      tsCandidate ||
      (msg?.__ts != null && String(msg.__ts).trim() !== ""
        ? String(msg.__ts).trim()
        : "0");
    return finish(
      "FALLBACK_HASH",
      `${participantScope}::txt::${hash(textNorm)}::${hash(String(windowPart))}`
    );
  }

  if (sourceIndexFinite) {
    return finish("SOURCE_INDEX", `${sender}::idx::${sourceIndex}`);
  }

  return finish("EMPTY", `${sender}::empty`);
}

/** @deprecated Alias — use {@link buildStableMessageKey}. */
export function buildExtractedMessageId(msg, extractedList) {
  return buildStableMessageKey(msg, extractedList);
}

function getMessageIdFromExtracted(msg, extractedList) {
  const built = buildStableMessageKey(msg, extractedList);
  return String(built?.id ?? "").trim();
}

function parsePrePlainTextTimestampMs(prePlainText) {
  const raw = String(prePlainText ?? "").trim();
  const m = /^\[([^\]]+)]/.exec(raw);
  if (!m) return 0;
  const inner = m[1].trim();
  let parsed = Date.parse(inner);
  if (Number.isFinite(parsed)) return parsed;
  const wa = /^(\d{1,2}:\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(inner);
  if (wa) {
    const [, hm, day, month, year] = wa;
    const [hours, minutes] = hm.split(":").map(Number);
    parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      hours,
      minutes
    ).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function getRowTimestampMs(row) {
  const rawTs = Number(row?.timestamp ?? 0);
  if (Number.isFinite(rawTs) && rawTs > 0) {
    return rawTs < 1_000_000_000_000 ? rawTs * 1000 : rawTs;
  }
  return parsePrePlainTextTimestampMs(row?.prePlainText);
}

function rowFreshEnoughForStartup(row, now = Date.now()) {
  const freshnessMs = Number(
    process.env.PLAYWRIGHT_STARTUP_CATCHUP_FRESH_MS ?? 10 * 60 * 1000
  );
  if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) return false;
  const tsMs = getRowTimestampMs(row);
  return Number.isFinite(tsMs) && tsMs > 0 && now - tsMs <= freshnessMs;
}

function candidateRowsAfterCursor({
  participantMessages,
  extractedMessages,
  persistedCursor,
  sidebarHasSignal = false,
  chatKey = "",
  now = Date.now(),
} = {}) {
  return candidateRowsAfterNormalizedCursor({
    participantMessages,
    extractedMessages,
    persistedCursor,
    sidebarHasSignal,
    chatKey,
    now,
    buildExtractedMessageId,
  }).rows;
}

function stableIdAllowedForCurrentMerge(stableId, currentFreshAdmittedStableIds) {
  const sid = String(stableId ?? "").trim();
  if (!sid) return false;
  if (!(currentFreshAdmittedStableIds instanceof Set)) return false;
  return currentFreshAdmittedStableIds.has(sid);
}

function isFreshMergeSourceAllowed({
  row,
  stableId,
  chatKey,
  currentFreshAdmittedStableIds,
  baselineSeenStableIds,
}) {
  const sid = String(stableId ?? "").trim();
  if (!sid) return false;
  if (row?.sender !== "user") return false;
  if (isListenerInboundNoise(row?.text)) return false;
  if (!stableIdAllowedForCurrentMerge(sid, currentFreshAdmittedStableIds)) {
    return false;
  }
  if (baselineSeenStableIds instanceof Set && baselineSeenStableIds.has(sid)) {
    return false;
  }
  const guaranteeKey = playwrightGuaranteeKeyForStableId(chatKey, sid);
  const st = guaranteeKey ? getMessageState(guaranteeKey) : null;
  if (st?.state === "done" || st?.state === "processing") return false;
  const ledgerBlock = resolveInboundTurnAdmissionBlock({
    chatKey,
    stableId: sid,
    textPreview: String(row?.text ?? "").slice(0, 120),
  });
  if (ledgerBlock.blocked === true && ledgerBlock.reason === "outbound_locked") {
    scheduleOutboundLockedRecovery({
      chatKey,
      stableId: sid,
      guaranteeKey:
        ledgerBlock.guaranteeKey || playwrightGuaranteeKeyForStableId(chatKey, sid),
    });
  }
  return ledgerBlock.blocked !== true;
}

function collapseRowsForForward(rows, opts = {}) {
  const currentFreshAdmittedStableIds =
    opts?.currentFreshAdmittedStableIds instanceof Set
      ? opts.currentFreshAdmittedStableIds
      : null;
  const chatKey = String(opts?.chatKey ?? "").trim();
  const baselineSeenStableIds =
    opts?.baselineSeenStableIds instanceof Set ? opts.baselineSeenStableIds : null;
  const cleanRows = Array.isArray(rows)
    ? rows.filter((row) => {
        if (row?.sender !== "user" || !String(row?.text ?? "").trim()) return false;
        if (!currentFreshAdmittedStableIds) return false;
        const stableId = buildExtractedMessageId(row, rows).id;
        return isFreshMergeSourceAllowed({
          row,
          stableId,
          chatKey,
          currentFreshAdmittedStableIds,
          baselineSeenStableIds,
        });
      })
    : [];
  if (!currentFreshAdmittedStableIds && Array.isArray(rows)) {
    const latest = [...rows]
      .filter((row) => row?.sender === "user" && String(row?.text ?? "").trim())
      .pop();
    return latest ? [latest] : [];
  }
  if (cleanRows.length <= 1) return cleanRows;
  const latest = cleanRows[cleanRows.length - 1];
  const mergedText = cleanRows
    .slice(-2)
    .map((row) => String(row?.text ?? "").trim())
    .filter(Boolean)
    .join(" | ");
  return [
    {
      ...latest,
      text: mergedText || String(latest?.text ?? "").trim(),
      __catchupMergedRowCount: cleanRows.length,
      __catchupMergedRowIds: cleanRows.map((row) =>
        buildExtractedMessageId(row, cleanRows).id
      ),
    },
  ];
}

/** @internal Tests — row timestamp from DOM or prePlainText. */
export function __getRowTimestampMsForTests(row) {
  return getRowTimestampMs(row);
}

/** @internal Tests — cursor filter after persisted inbound position. */
export function __candidateRowsAfterCursorForTests(args) {
  return candidateRowsAfterCursor(args);
}

/** @internal Tests — merge last two catch-up user rows for one forward. */
export function __collapseRowsForForwardForTests(rows, opts = {}) {
  return collapseRowsForForward(rows, opts);
}

/**
 * @internal Tests — startup catch-up selection (cursor, collapse, reply-after, suppress flags).
 */
export function __planPlaywrightStartupForwardForTests({
  participantMessages,
  extractedMessages,
  sorted = [],
  persistedCursor = null,
  lastProcessedUserMsgId = "",
  sidebarHasSignal = false,
  groupChatKey = "leads",
  now = Date.now(),
  applyStaleGate = false,
} = {}) {
  const normalizedGroupChatKeyForCompare = String(groupChatKey ?? "").trim() || "leads";
  const candidateRows = candidateRowsAfterCursor({
    participantMessages,
    extractedMessages,
    persistedCursor,
    sidebarHasSignal,
    now,
  });
  const rowsForForward = collapseRowsForForward(candidateRows);
  const selected = [];
  for (const candidate of rowsForForward) {
    const extractedIdBuilt =
      candidate && candidate.sender === "user"
        ? buildExtractedMessageId(candidate, extractedMessages)
        : { id: "", strategy: "NONE" };
    const lastUserMsgId = String(extractedIdBuilt?.id ?? "").trim();
    if (!lastUserMsgId || lastUserMsgId === lastProcessedUserMsgId) {
      continue;
    }
    if (
      applyStaleGate &&
      !persistedCursor &&
      isGroupMessageStale(getRowTimestampMs(candidate), now)
    ) {
      selected.push({
        skipped: true,
        reason: "stale",
        lastUserMsgId,
      });
      continue;
    }
    const pos = candidate.__position;
    let hasReplyAfter = false;
    let hasNewerSameParticipantUserAfter = false;
    if (typeof pos === "number" && pos >= 0) {
      const tail = sorted.slice(pos + 1);
      hasReplyAfter = tail.some((m) => m.sender === "me");
      const lastCmp = {
        participantKey: candidate.participantKey || null,
        sender: String(candidate.sender ?? "").trim() || "user",
      };
      hasNewerSameParticipantUserAfter = tail.some((m) => {
        if (m.sender !== "user") return false;
        const other = participantComparableFromSortedRow(
          m,
          normalizedGroupChatKeyForCompare
        );
        return isSameParticipant(lastCmp, other);
      });
    }
    const allowCursorCatchupDespiteReplyAfter = Boolean(persistedCursor);
    const skipDueToReplyAfter =
      hasReplyAfter &&
      !hasNewerSameParticipantUserAfter &&
      !allowCursorCatchupDespiteReplyAfter;
    if (skipDueToReplyAfter) {
      selected.push({
        skipped: true,
        reason: "reply_after",
        lastUserMsgId,
        hasReplyAfter,
        hasNewerSameParticipantUserAfter,
      });
      continue;
    }
    selected.push({
      skipped: false,
      lastUserMsgId,
      text: String(candidate.text ?? ""),
      __suppressAckNoopOutbound:
        candidateRows.length > 1 && candidate === rowsForForward[0],
      __catchupMergedRowCount: candidate.__catchupMergedRowCount || 1,
      hasReplyAfter,
      hasNewerSameParticipantUserAfter,
      persistedCursorPresent: Boolean(persistedCursor),
    });
  }
  return { candidateRows, rowsForForward, selected };
}

/**
 * Short follow-ups that should not receive long reply-after suppression.
 * @param {unknown} text
 */
export function isGroupContinuationMessage(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (/^[?؟!.]+$/u.test(raw)) return true;
  if (/^\?{1,6}$/u.test(raw)) return true;
  if (/\b\d+\s*(?:din|day|days|dino|roz|hafta|week|weeks)\b/i.test(raw)) {
    return true;
  }
  if (
    /\b(chahiye|chahye|chaiye|available|book|booking|corolla|civic|toyota)\b/i.test(
      raw
    )
  ) {
    return true;
  }
  return raw.split(/\s+/).filter(Boolean).length <= 2;
}

/**
 * @param {string} chatKey
 * @param {string} stableId
 */
function playwrightGuaranteeKeyForStableId(chatKey, stableId) {
  const ck = String(chatKey ?? "").trim();
  const sid = String(stableId ?? "").trim();
  if (!ck || !sid) return "";
  return `${ck}::${sid}`;
}

/**
 * @param {string} chatKey
 * @param {{ __burstStableIds?: string[] }} msg
 * @param {Array<unknown>} extractedList
 */
function isParticipantMessageInflightOrDone(chatKey, msg, extractedList) {
  const burstIds = Array.isArray(msg?.__burstStableIds)
    ? msg.__burstStableIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const ids =
    burstIds.length > 0
      ? burstIds
      : [getMessageIdFromExtracted(msg, extractedList)].filter(Boolean);
  return ids.some((stableId) => {
    const gk = playwrightGuaranteeKeyForStableId(chatKey, stableId);
    const st = getMessageState(gk);
    return st?.state === "processing" || st?.state === "done";
  });
}

/**
 * @param {Array<object>} pending
 * @param {Array<unknown>} extractedList
 */
export function mergeParticipantBurstMessages(pending, extractedList) {
  if (!Array.isArray(pending) || pending.length === 0) return null;
  if (pending.length === 1) return pending[0];
  const texts = pending
    .map((m) => String(m?.text ?? "").trim())
    .filter(Boolean);
  const combinedText = texts.join(" ");
  const last = pending[pending.length - 1];
  const burstStableIds = pending
    .map((m) => getMessageIdFromExtracted(m, extractedList))
    .filter(Boolean);
  return {
    ...last,
    text: combinedText,
    __burstMerged: true,
    __burstMergedCount: pending.length,
    __burstStableIds: burstStableIds,
  };
}

/**
 * @param {string} chatKey
 * @param {Array<object>} sorted
 * @param {object} participantCmp
 * @param {string} normalizedGroupChatKeyForCompare
 * @param {Array<object>} extractedMessages
 */
function getParticipantGuaranteeCursorPosition(
  chatKey,
  sorted,
  participantCmp,
  normalizedGroupChatKeyForCompare,
  extractedMessages
) {
  let maxPos = -1;
  for (const row of sorted || []) {
    if (row?.sender !== "user") continue;
    const rowCmp = participantComparableForGuard(row, normalizedGroupChatKeyForCompare);
    if (!isSameParticipant(participantCmp, rowCmp)) continue;
    const stableId = getMessageIdFromExtracted(row, extractedMessages);
    if (!stableId) continue;
    const gk = playwrightGuaranteeKeyForStableId(chatKey, stableId);
    const st = getMessageState(gk);
    if (st?.state !== "done" && st?.state !== "processing") continue;
    const pos = Number(row?.__position);
    if (Number.isFinite(pos) && pos > maxPos) maxPos = pos;
  }
  return maxPos;
}

/**
 * Phase C — proof log for guarantee-only participant selection.
 * @param {string} chatKey
 * @param {object} candidate
 * @param {Array<object>} extractedMessages
 */
export function logGuaranteeFirstSelection(chatKey, candidate, extractedMessages) {
  const ck = String(chatKey ?? "").trim();
  const stableId = String(
    getMessageIdFromExtracted(candidate, extractedMessages) ?? ""
  ).trim();
  const guaranteeKey = stableId ? playwrightGuaranteeKeyForStableId(ck, stableId) : "";
  const st = guaranteeKey ? getMessageState(guaranteeKey) : null;
  console.log("[guarantee_first_candidate]", {
    chatKey: ck || null,
    participantKey: String(candidate?.participantKey ?? "").trim() || null,
    candidateStableId: stableId || null,
    guaranteeState: st?.state || "idle",
    guaranteeKey: guaranteeKey || null,
    textPreview: String(candidate?.text ?? "").slice(0, 120) || null,
  });
}

/**
 * @param {object} anchorMsg
 * @param {Array<object>} allParticipantUserRows
 * @param {Array<object>} sorted
 * @param {number} burstMs
 * @param {Map<string, number>} tickFirstSeenByStableId
 * @param {Array<object>} extractedMessages
 * @param {string} chatKey
 */
export function attachBurstMergeContinuations(
  anchorMsg,
  allParticipantUserRows,
  sorted,
  burstMs,
  tickFirstSeenByStableId,
  extractedMessages,
  chatKey,
  catalogItems,
  opts = {}
) {
  if (!anchorMsg) return null;
  const catalog = resolveBurstMergeCatalogItems(catalogItems);
  const anchorPos = Number(anchorMsg?.__position);
  if (!Number.isFinite(anchorPos)) return anchorMsg;
  const currentFreshAdmittedStableIds =
    opts?.currentFreshAdmittedStableIds instanceof Set
      ? opts.currentFreshAdmittedStableIds
      : null;
  const baselineSeenStableIds =
    opts?.baselineSeenStableIds instanceof Set ? opts.baselineSeenStableIds : null;
  const anchorStableId = getMessageIdFromExtracted(anchorMsg, extractedMessages);
  if (!currentFreshAdmittedStableIds) {
    return anchorMsg;
  }
  if (
    !isFreshMergeSourceAllowed({
      row: anchorMsg,
      stableId: anchorStableId,
      chatKey,
      currentFreshAdmittedStableIds,
      baselineSeenStableIds,
    })
  ) {
    return anchorMsg;
  }
  const anchorParticipantKey = String(anchorMsg?.participantKey ?? "").trim();
  const allowMultiRowMerge = Boolean(anchorParticipantKey);
  const byPos = new Map(
    (allParticipantUserRows || [])
      .filter((row) => {
        if (row?.sender !== "user") return false;
        if (!String(row?.text ?? "").trim()) return false;
        if (!allowMultiRowMerge) return row === anchorMsg;
        const participantKey = String(row?.participantKey ?? "").trim();
        if (participantKey !== anchorParticipantKey) return false;
        const stableId = getMessageIdFromExtracted(row, extractedMessages);
        return isFreshMergeSourceAllowed({
          row,
          stableId,
          chatKey,
          currentFreshAdmittedStableIds,
          baselineSeenStableIds,
        });
      })
      .map((row) => [Number(row?.__position), row])
  );
  const run = [anchorMsg];
  let lastPos = anchorPos;
  while (true) {
    let nextRow = null;
    let nextPos = Number.POSITIVE_INFINITY;
    for (const row of sorted || []) {
      const pos = Number(row?.__position);
      if (!Number.isFinite(pos) || pos <= lastPos) continue;
      if (!byPos.has(pos)) continue;
      if (pos < nextPos) {
        nextPos = pos;
        nextRow = byPos.get(pos);
      }
    }
    if (!nextRow) break;
    if (!arePositionsBurstAdjacent(sorted, lastPos, nextPos)) break;
    const gapMs = burstPairGapMs(
      run[run.length - 1],
      nextRow,
      tickFirstSeenByStableId,
      extractedMessages
    );
    if (gapMs != null && gapMs > burstMs) {
      console.log("[burst_merge_rejected_old_timestamp]", {
        chatKey,
        gapMs,
        burstMs,
        textPreviewA: String(run[run.length - 1]?.text ?? "").slice(0, 60),
        textPreviewB: String(nextRow?.text ?? "").slice(0, 60),
      });
      break;
    }
    if (isListenerInboundNoise(nextRow?.text)) {
      if (isBurstMergeContinuationText(nextRow?.text)) {
        run.push(nextRow);
        lastPos = nextPos;
        continue;
      }
      break;
    }
    if (!canMergeBurstRowPair(run[run.length - 1], nextRow, catalog)) {
      console.log("[burst_merge_rejected_different_items]", {
        chatKey,
        textPreviewA: String(run[run.length - 1]?.text ?? "").slice(0, 60),
        textPreviewB: String(nextRow?.text ?? "").slice(0, 60),
      });
      break;
    }
    run.push(nextRow);
    lastPos = nextPos;
    continue;
  }
  return mergeParticipantBurstMessages(run, extractedMessages);
}

/**
 * @param {object} p
 */
export function buildParticipantForwardCandidate(p) {
  const {
  participantMessages,
    allParticipantUserRows,
    lastProcessedUserMsgId,
    chatKey,
  extractedMessages,
    sorted,
    normalizedGroupChatKeyForCompare,
    anchorIndex = -1,
    burstMs = PLAYWRIGHT_FRESH_DELTA_BURST_MS,
    tickFirstSeenByStableId,
    catalogItems,
    currentFreshAdmittedStableIds,
    baselineSeenStableIds,
  } = p;
  const ordered = [...(participantMessages || [])].sort(
    (a, b) => (Number(a?.__position) || 0) - (Number(b?.__position) || 0)
  );
  if (ordered.length === 0) return null;

  const participantCmp = participantComparableForGuard(
    ordered[0],
    normalizedGroupChatKeyForCompare
  );

  const guaranteeFirst = isPlaywrightGuaranteeFirstAdmissionEnabled();
  let cursorPos = -1;
  if (guaranteeFirst) {
    cursorPos = getParticipantGuaranteeCursorPosition(
      chatKey,
      sorted || [],
      participantCmp,
      normalizedGroupChatKeyForCompare,
      extractedMessages
    );
  } else {
    const lastProc = String(lastProcessedUserMsgId ?? "").trim();
    if (lastProc && Array.isArray(sorted)) {
      for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i];
        if (row?.sender !== "user") continue;
        const rowId = getMessageIdFromExtracted(row, extractedMessages);
        if (rowId !== lastProc) continue;
        const rowCmp = participantComparableForGuard(row, normalizedGroupChatKeyForCompare);
        if (isSameParticipant(participantCmp, rowCmp)) {
          cursorPos = Number(row?.__position);
          if (!Number.isFinite(cursorPos)) cursorPos = i;
        }
      }
    }
  }

  const pending = ordered.filter((m) => {
    const pos = Number(m?.__position);
    if (!Number.isFinite(pos) || pos <= cursorPos) return false;
    if (
      !guaranteeFirst &&
      isPlaywrightGroupFreshDeltaOnlyEnabled() &&
      anchorIndex >= 0 &&
      pos < anchorIndex
    ) {
      return false;
    }
    const text = String(m?.text ?? "").trim();
    if (!text) return false;
    if (guaranteeFirst && isListenerInboundNoise(text)) return false;
    const stableId = getMessageIdFromExtracted(m, extractedMessages);
    if (!stableId) return false;
    if (
      currentFreshAdmittedStableIds instanceof Set &&
      !currentFreshAdmittedStableIds.has(stableId)
    ) {
      return false;
    }
    const gk = playwrightGuaranteeKeyForStableId(chatKey, stableId);
    const st = getMessageState(gk);
            if (st?.state === "done" || st?.state === "processing") return false;
            if (
              st?.state === "failed" &&
              isPlaywrightGroupFreshDeltaOnlyEnabled() &&
              !guaranteeFirst &&
              typeof globalThis.__playwrightFreshDeltaState === "object"
            ) {
              const chatFresh = globalThis.__playwrightFreshDeltaState[String(chatKey ?? "").trim()];
              const admitted =
                chatFresh?.admittedFreshStableIds instanceof Set
                  ? chatFresh.admittedFreshStableIds.has(stableId)
                  : false;
              if (!admitted) return false;
            }
    return true;
  });

  if (pending.length === 0) return null;
  if (!(currentFreshAdmittedStableIds instanceof Set)) {
    return null;
  }

  const tickMap =
    tickFirstSeenByStableId instanceof Map
      ? tickFirstSeenByStableId
      : globalThis.__playwrightFreshDeltaState?.[String(chatKey ?? "").trim()]
          ?.tickFirstSeenByStableId;

  const burstCatalog = resolveBurstMergeCatalogItems(catalogItems);

  if (guaranteeFirst) {
    const admittedIds =
      currentFreshAdmittedStableIds instanceof Set
        ? currentFreshAdmittedStableIds
        : null;
    const burstSource =
      Array.isArray(allParticipantUserRows) && allParticipantUserRows.length > 0
        ? allParticipantUserRows
        : ordered;
    const sortedList = sorted || [];
    for (const pendingRow of pending) {
      const withBurst = attachBurstMergeContinuations(
        pendingRow,
        burstSource,
        sortedList,
        burstMs,
        tickMap instanceof Map ? tickMap : new Map(),
        extractedMessages,
        String(chatKey ?? "").trim(),
        burstCatalog,
        {
          currentFreshAdmittedStableIds: admittedIds,
          baselineSeenStableIds:
            baselineSeenStableIds instanceof Set ? baselineSeenStableIds : null,
        }
      );
      const guard = evaluateReplyAfterGuard(
        withBurst,
        sortedList,
        normalizedGroupChatKeyForCompare
      );
      if (guard.skip && guard.reason === "superseded_by_newer_same_participant") {
        const pos = Number(withBurst?.__position);
        let newerSameParticipantRow = null;
        if (Number.isFinite(pos)) {
          const lastCmp = participantComparableForGuard(
            withBurst,
            normalizedGroupChatKeyForCompare
          );
          for (let j = pos + 1; j < sortedList.length; j++) {
            if (sortedList[j]?.sender !== "user") continue;
            const other = participantComparableForGuard(
              sortedList[j],
              normalizedGroupChatKeyForCompare
            );
            if (isSameParticipant(lastCmp, other)) {
              newerSameParticipantRow = sortedList[j];
              break;
            }
          }
        }
        if (
          newerSameParticipantRow &&
          !shouldBurstSupersedeOlderRow(
            withBurst,
            newerSameParticipantRow,
            burstCatalog
          )
        ) {
          logGuaranteeFirstSelection(
            String(chatKey ?? "").trim(),
            withBurst,
            extractedMessages
          );
          return withBurst;
        }
        continue;
      }
      logGuaranteeFirstSelection(
        String(chatKey ?? "").trim(),
        withBurst,
        extractedMessages
      );
      return withBurst;
    }
    return null;
  }

  if (isPlaywrightGroupFreshDeltaOnlyEnabled() && anchorIndex >= 0) {
    const runs = splitBurstMergeRuns(
      pending,
      sorted || [],
      burstMs,
      tickMap instanceof Map ? tickMap : new Map(),
      extractedMessages,
      String(chatKey ?? "").trim(),
      burstCatalog
    );
    const lastRun = runs.length > 0 ? runs[runs.length - 1] : pending;
    return mergeParticipantBurstMessages(lastRun, extractedMessages);
  }

  const runs = splitBurstMergeRuns(
    pending,
    sorted || [],
    burstMs,
    tickMap instanceof Map ? tickMap : new Map(),
    extractedMessages,
    String(chatKey ?? "").trim(),
    burstCatalog
  );
  const lastRun = runs.length > 0 ? runs[runs.length - 1] : pending;
  return mergeParticipantBurstMessages(lastRun, extractedMessages);
}

/**
 * Prefer enriched {@link msg.participantKey} when present (group userMessages rows).
 * @param {object} m
 * @param {string} normalizedGroupChatKey
 */
function participantComparableForGuard(m, normalizedGroupChatKey) {
  const directKey = String(m?.participantKey ?? "").trim();
  if (directKey) {
  return {
      participantKey: directKey,
      sender: String(m?.sender ?? "user").trim() || "user",
    };
  }
  return participantComparableFromSortedRow(m, normalizedGroupChatKey);
}

/**
 * Narrow reply-after: only assistant bubbles between this row and the next same-participant user row.
 * @param {object} msg
 * @param {Array<object>} sorted
 * @param {string} normalizedGroupChatKey
 */
export function evaluateReplyAfterGuard(msg, sorted, normalizedGroupChatKey) {
  const pos = msg?.__position;
  if (typeof pos !== "number" || pos < 0 || !Array.isArray(sorted)) {
    return {
      skip: false,
      reason: null,
      hasReplyAfter: false,
      hasNewerSameParticipantUserAfter: false,
    };
  }
  const lastCmp = participantComparableForGuard(msg, normalizedGroupChatKey);
  let endIdx = sorted.length;
  for (let j = pos + 1; j < sorted.length; j++) {
    if (sorted[j]?.sender !== "user") continue;
    const other = participantComparableForGuard(sorted[j], normalizedGroupChatKey);
    if (isSameParticipant(lastCmp, other)) {
      endIdx = j;
      break;
    }
  }
  const segment = sorted.slice(pos + 1, endIdx);
  const hasReplyAfter = segment.some((m) => m?.sender === "me");
  const hasNewerSameParticipantUserAfter =
    endIdx < sorted.length &&
    sorted[endIdx]?.sender === "user" &&
    isSameParticipant(
      lastCmp,
      participantComparableForGuard(sorted[endIdx], normalizedGroupChatKey)
    );

  if (hasNewerSameParticipantUserAfter) {
    return {
      skip: true,
      reason: "superseded_by_newer_same_participant",
        hasReplyAfter,
        hasNewerSameParticipantUserAfter,
    };
  }

  const skipDueToReplyAfter = hasReplyAfter && !hasNewerSameParticipantUserAfter;
  return {
    skip: skipDueToReplyAfter,
    reason: skipDueToReplyAfter ? "reply_after" : null,
      hasReplyAfter,
      hasNewerSameParticipantUserAfter,
  };
}

/**
 * @param {string} cursorKey
 * @param {string} stableId
 * @param {unknown} text
 * @param {string} reason
 */
function maybeSuppressGroupMessageSelection(cursorKey, stableId, text, reason) {
  if (
    reason === "reply_after" &&
    (isGroupContinuationMessage(text) || String(text ?? "").includes(" "))
  ) {
    return;
  }
  suppressGroupMessageSelection(cursorKey, stableId, reason);
}

function participantCursorKeyForMessage(chatKey, msg) {
  const participantKey = String(msg?.participantKey ?? "").trim();
  return buildParticipantCursorKey(chatKey, participantKey);
}

/**
 * Snapshot of visible user-thread rows using stable composite ids.
 * @param {Array<{ __rowKey?: string, sender?: string, text?: string }>} messages
 */
function computeSnapshotHash(messages) {
  return messages.map((m, i) => getMessageId(m, i)).join("|");
}

/**
 * Open-chat title filter: from env / defaults file, or no restriction (see {@link resolvePlaywrightAllowedChatTitles}).
 * @param {string | null | undefined} title
 */
function isAllowedChat(title) {
  if (!title) return false;
  const list = resolvePlaywrightAllowedChatTitles();
  if (!list || list.length === 0) return true;
  return list.includes(normalize(title));
}

/**
 * Group selection signal for an open allowlisted chat (tests + logging).
 */
export function __buildActiveGroupSelectionSignalForTests({
  openTitle = "",
  refreshedOpenTitle = "",
  sidebarHasSignal = false,
  activeNowForStickiness = "",
} = {}) {
  const verifiedOpenTitle = String(refreshedOpenTitle || openTitle || "").trim();
  const isAllowedOpenTitle = isAllowedChat(verifiedOpenTitle);
  const activeAllowlistedOpen = isAllowedOpenTitle;
  const sidebarHasSignalForSelection =
    Boolean(sidebarHasSignal) || activeAllowlistedOpen;
  return {
    openTitle: String(openTitle ?? "").trim(),
    refreshedOpenTitle: String(refreshedOpenTitle ?? "").trim(),
    activeNowForStickiness: String(activeNowForStickiness ?? "").trim(),
    verifiedOpenTitle,
    isAllowedOpenTitle,
    activeAllowlistedOpen,
    sidebarSignal: Boolean(sidebarHasSignal),
    sidebarHasSignalForSelection,
  };
}

/**
 * @param {string | null | undefined} text
 */
function isBusinessMessage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const kws = resolvePlaywrightBusinessKeywords();
  if (kws.length === 0) return false;
  return kws.some((keyword) => lower.includes(keyword));
}

/**
 * Normalize sidebar preview and extracted tails for stable comparison (prefix/format/truncation).
 * @param {string | null | undefined} text
 * @returns {string}
 */
function normalizePreview(text) {
  if (!text) return "";

  return String(text)
    .replace(/^[^:]+:\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Sidebar preview often prefixes your own last line with "You:" — not new inbound activity.
 * @param {string | null | undefined} raw
 */
function sidebarPreviewLooksOutgoing(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  return /^(you|tú|ty)\s*:/i.test(s);
}

/**
 * Deterministic local hash for fallback identity.
 * @param {string | null | undefined} str
 */
function hash(str) {
  let h = 0;
  let i;
  let chr;
  const s = String(str ?? "");
  if (!s) return "0";
  for (i = 0; i < s.length; i++) {
    chr = s.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return Math.abs(h).toString();
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

/** Prevents overlapping chat-switch iterations (setInterval guard). */
let chatLoopRunning = false;
let lastMessageMap = {};
/** Last seen sidebar time/preview hint per chat title (timestamp column / activity). */
let lastSidebarTimeMap = {};
/**
 * When not locked, only one top chat is visited per loop tick (rotates).
 * Prevents opening all 6 sidebar rows every interval, which caused visible thrashing.
 */
let priorityScanIndex = 0;
/** Consecutive idle ticks on fallback rotation before advancing {@link priorityScanIndex}. */
const ROTATION_IDLE_THRESHOLD = 1;
/**
 * Consecutive loop ticks (fallback rotation path) with no *new* lines to forward — but see
 * {@link totalUserMessages} vs {@link newMessages} (guarantee may clear newMessages while thread still has activity).
 */
let rotationIdleCount = 0;
/** True when this tick picked {@link chatName} from {@link allowedForRotation} (not lock / interrupt / focus). */
let usedFallbackRotationForThisLoop = false;
/** Last chat title we applied rotation-idle logic for — reset idle when this changes. */
let lastActiveChat = null;

function advanceRotationOnIdle() {
  rotationIdleCount++;
  const n = Math.max(1, Number(globalThis.__lastAllowedRotationN) || 1);
  if (rotationIdleCount >= ROTATION_IDLE_THRESHOLD) {
    priorityScanIndex = (priorityScanIndex + 1) % n;
    rotationIdleCount = 0;
    console.log(
      "🔁 Rotation advanced (idle threshold)",
      priorityScanIndex,
      `of ${n}`
    );
  }
}

/** @type {import("playwright").Browser | null} */
let browser = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let interruptPollTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let localApprovalContinuationTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let localAvailabilityContinuationTimer = null;
let listenerStarted = false;
let isStopping = false;
let playwrightRelaunchPending = false;

/**
 * @param {unknown} err
 */
function isPlaywrightSessionDeadError(err) {
  const msg = String(err instanceof Error ? err.message : err ?? "");
  return /has been closed|Target page, context or browser/i.test(msg);
}

async function requestPlaywrightRelaunch(reason) {
  if (playwrightRelaunchPending || isStopping) return;
  playwrightRelaunchPending = true;
  console.error(`[Playwright] ${reason} — relaunching WhatsApp browser session`);
  try {
    await stopPlaywrightListener();
  } catch (e) {
    console.warn("[Playwright] relaunch stop error:", e?.message || e);
  }
  playwrightRelaunchPending = false;
  if (String(process.env.PLAYWRIGHT_ENABLED ?? "").toLowerCase() !== "true") {
    return;
  }
  setTimeout(() => {
    void startPlaywrightListener().catch((err) => {
      console.error("[Playwright] relaunch failed:", err?.message || err);
    });
  }, 1500);
}
const PLAYWRIGHT_CHAT_RESPONSE_COOLDOWN_MS = Math.max(
  2000,
  Math.min(
    3000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_RESPONSE_COOLDOWN_MS ?? "2500"),
      10
    ) || 2500
  )
);
globalThis.__OUTBOUND_BUSY__ = globalThis.__OUTBOUND_BUSY__ || false;
globalThis.__WA_MEDIA_SEND__ = globalThis.__WA_MEDIA_SEND__ === true;
globalThis.__loopRunning = globalThis.__loopRunning || false;
globalThis.__visitedChatsThisCycle =
  globalThis.__visitedChatsThisCycle || new Set();
globalThis.__pendingChats = globalThis.__pendingChats || new Set();
globalThis.__forceNextChat = globalThis.__forceNextChat || null;
globalThis.__activeChatTitle = globalThis.__activeChatTitle || null;
globalThis.__lastProcessedRowKeyByChat =
  globalThis.__lastProcessedRowKeyByChat || {};
globalThis.__lastProcessedUserMsg =
  globalThis.__lastProcessedUserMsg || Object.create(null);
/** @type {Record<string, Map<string, { at: number, reason: string }>>} */
globalThis.__suppressedMessageIds =
  globalThis.__suppressedMessageIds || Object.create(null);

/** Default 90s — long TTLs silenced valid group follow-ups after reply-after skips. */
const GROUP_MESSAGE_SUPPRESSION_TTL_MS = Math.max(
  30_000,
  Math.min(
    900_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_GROUP_SUPPRESSION_TTL_MS ?? "90000"),
      10
    ) || 90_000
  )
);

const GROUP_MESSAGE_SUPPRESSION_MAX_IDS_PER_CURSOR = Math.max(
  10,
  Math.min(
    500,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_GROUP_SUPPRESSION_MAX_IDS ?? "200"),
      10
    ) || 200
  )
);

function evictExpiredGroupSuppressions(cursorKey) {
  const raw = globalThis.__suppressedMessageIds?.[cursorKey];
  if (!raw || !(raw instanceof Map)) return;
  const now = Date.now();
  for (const [id, meta] of raw.entries()) {
    if (now - (meta?.at ?? 0) > GROUP_MESSAGE_SUPPRESSION_TTL_MS) {
      raw.delete(id);
    }
  }
}

function trimGroupSuppressionMap(cursorKey) {
  const raw = globalThis.__suppressedMessageIds?.[cursorKey];
  if (!raw || !(raw instanceof Map)) return;
  if (raw.size <= GROUP_MESSAGE_SUPPRESSION_MAX_IDS_PER_CURSOR) return;
  const entries = [...raw.entries()].sort(
    (x, y) => (x[1]?.at ?? 0) - (y[1]?.at ?? 0)
  );
  while (entries.length > GROUP_MESSAGE_SUPPRESSION_MAX_IDS_PER_CURSOR) {
    const drop = entries.shift();
    if (drop) raw.delete(drop[0]);
  }
}

function getGroupSuppressionMap(cursorKey) {
  globalThis.__suppressedMessageIds =
    globalThis.__suppressedMessageIds || Object.create(null);
  if (!globalThis.__suppressedMessageIds[cursorKey]) {
    globalThis.__suppressedMessageIds[cursorKey] = new Map();
  }
  return globalThis.__suppressedMessageIds[cursorKey];
}

function isGroupMessageSuppressed(cursorKey, messageId) {
  if (!messageId) return false;
  evictExpiredGroupSuppressions(cursorKey);
  const m = globalThis.__suppressedMessageIds?.[cursorKey];
  return m instanceof Map && m.has(messageId);
}

function suppressGroupMessageSelection(cursorKey, messageId, reason) {
  if (!cursorKey || !messageId) return;
  const map = getGroupSuppressionMap(cursorKey);
  evictExpiredGroupSuppressions(cursorKey);
  map.set(messageId, { at: Date.now(), reason });
  trimGroupSuppressionMap(cursorKey);
  console.log("[MESSAGE_SELECTION_SUPPRESSED]", {
    reason,
    messageId,
    cursorKey,
  });
}

globalThis.__chatResponding =
  globalThis.__chatResponding || Object.create(null);
globalThis.__chatRespondingCooldownUntil =
  globalThis.__chatRespondingCooldownUntil || Object.create(null);
globalThis.__playwrightListenerMsgIdByGuarantee =
  globalThis.__playwrightListenerMsgIdByGuarantee || new Map();
globalThis.__INTERRUPT_PENDING__ =
  globalThis.__INTERRUPT_PENDING__ || false;
/** Unified message lifecycle state map (new | processing | done | failed). */
globalThis.__messageStateMap =
  globalThis.__messageStateMap || new Map();
globalThis.__processingChats =
  globalThis.__processingChats || new Map();
/** Last time this chat began a forward (debounces rapid chat-loop ticks). */
globalThis.__playwrightChatLastProcessedAt =
  globalThis.__playwrightChatLastProcessedAt || Object.create(null);
globalThis.__playwrightFailedRetryCount =
  globalThis.__playwrightFailedRetryCount || new Map();
const PLAYWRIGHT_FAILED_RETRY_MAX = Math.max(
  0,
  Math.min(
    5,
    Number.parseInt(String(process.env.PLAYWRIGHT_FAILED_RETRY_MAX ?? "1"), 10) || 1
  )
);
/** Normalized chat key currently running the forward pipeline (blocks rotation / interrupt picks). */
globalThis.__ACTIVE_PROCESSING_CHAT ??= null;

/**
 * Hard chat isolation lock: while in progress, the listener must not switch chats away from `chatKey`.
 * Shape is mandated by production hardening requirements.
 * @type {{ chatKey: string | null, inProgress: boolean, startedAtMs?: number } | null}
 */
globalThis.__activeChatLock =
  globalThis.__activeChatLock &&
  typeof globalThis.__activeChatLock === "object" &&
  "inProgress" in globalThis.__activeChatLock
    ? globalThis.__activeChatLock
    : { chatKey: null, inProgress: false, startedAtMs: 0 };

function activeChatLockKey() {
  const lock = globalThis.__activeChatLock;
  if (!lock || typeof lock !== "object") return "";
  if (lock.inProgress !== true) return "";
  return String(lock.chatKey ?? "").trim();
}

function activeChatLockAgeMs() {
  const lock = globalThis.__activeChatLock;
  if (!lock || typeof lock !== "object") return 0;
  if (lock.inProgress !== true) return 0;
  const startedAtMs = Number(lock.startedAtMs ?? 0);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return 0;
  return Date.now() - startedAtMs;
}

function releaseChatLock({ stale = false } = {}) {
  const lock = globalThis.__activeChatLock;
  const prevKey =
    lock && typeof lock === "object" ? String(lock.chatKey ?? "").trim() : "";
  const ageMs = activeChatLockAgeMs();
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  if (stale) {
    console.warn("[chat_lock_stale_released]", {
      chatKey: prevKey || null,
      ageMs: ageMs || null,
    });
  } else {
    console.log("[chat_lock_released]", { chatKey: prevKey || null });
  }
}

function maybeReleaseStaleChatLock() {
  const ageMs = activeChatLockAgeMs();
  if (!ageMs) return false;
  if (ageMs <= 120_000) return false;
  releaseChatLock({ stale: true });
  return true;
}

function isChatSwitchBlockedByLock(targetChatKey) {
  const lockedKey = activeChatLockKey();
  const attempted = String(targetChatKey ?? "").trim();
  return Boolean(lockedKey && attempted && lockedKey !== attempted);
}

function logChatSwitchBlocked(targetChatKey) {
  console.log("[chat_switch_blocked_due_to_lock]", {
    activeChat: activeChatLockKey() || null,
    attempted: String(targetChatKey ?? "").trim() || null,
  });
}
/**
 * Per-chat deterministic listener state: snapshot hash, seen row keys, last check time.
 * @type {Record<string, { snapshot: string, seenRowKeys: Set<string>, lastUpdatedAt: number }>}
 */
globalThis.__chatState = globalThis.__chatState || Object.create(null);

/**
 * Fresh-delta admission layer for Playwright group chats.
 * Invariant: only fresh verified user rows can enter participant buckets / burst merge.
 * Feature-flagged behind PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY=true.
 */
globalThis.__playwrightFreshDeltaState =
  globalThis.__playwrightFreshDeltaState || Object.create(null);

const PLAYWRIGHT_FRESH_DELTA_CATCHUP_MS = Math.max(
  250,
  Math.min(
    5000,
    Number.parseInt(String(process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_CATCHUP_MS ?? "1500"), 10) ||
      1500
  )
);

const PLAYWRIGHT_FRESH_DELTA_BURST_MS = Math.max(
  5_000,
  Math.min(
    600_000,
    Number.parseInt(String(process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_BURST_MS ?? "120000"), 10) ||
      120_000
  )
);

/**
 * @param {unknown} text
 */
function buildTextFingerprint(text) {
  const norm = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!norm) return "";
  return hash(norm);
}

/**
 * @param {{ text?: string, timestamp?: string | number, __ts?: number }} row
 * @returns {number | null}
 */
function parseRowTimestampMs(row) {
  const raw = row?.timestamp != null ? row.timestamp : row?.__ts;
  const ts = Number(raw);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (ts > 1_000_000_000_000) return ts;
  if (ts > 1_000_000_000) return ts * 1000;
  return null;
}

/**
 * Bottom-most visible row anchor (any sender).
 * @param {Array<object>} sorted
 * @param {string} chatKey
 * @param {Array<object>} extractedList
 */
export function buildTailAnchorFromRow(row, sortedIndex, chatKey, extractedList) {
  const { id: stableId } = buildStableMessageKey(row, extractedList);
  const rowKey = String(row?.__rowKey ?? buildRowKey(row)).trim();
  return {
    stableId: String(stableId ?? "").trim(),
    rowKey,
    sourceMessageIndex:
      row?.sourceMessageIndex != null && Number.isFinite(Number(row.sourceMessageIndex))
        ? Number(row.sourceMessageIndex)
        : sortedIndex,
    __position: sortedIndex,
    textFingerprint: buildTextFingerprint(row?.text),
    timestamp:
      row?.timestamp != null && String(row.timestamp).trim() !== ""
        ? String(row.timestamp).trim()
        : null,
    sender: String(row?.sender ?? "").trim() || "unknown",
    establishedAtMs: Date.now(),
  };
}

/**
 * @param {Array<object>} sorted
 * @param {string} chatKey
 * @param {Array<object>} extractedList
 */
export function establishTailAnchor(sorted, chatKey, extractedList) {
  if (!Array.isArray(sorted) || sorted.length === 0) {
    return null;
  }
  const idx = sorted.length - 1;
  return buildTailAnchorFromRow(sorted[idx], idx, chatKey, extractedList);
}

/**
 * @param {Array<object>} sorted
 * @param {object | null | undefined} anchor
 */
export function findTailAnchorIndex(sorted, anchor) {
  if (!anchor || !Array.isArray(sorted) || sorted.length === 0) return -1;
  const aStable = String(anchor.stableId ?? "").trim();
  const aRowKey = String(anchor.rowKey ?? "").trim();
  const aFp = String(anchor.textFingerprint ?? "").trim();
  const aPos = Number(anchor.__position);

  if (aStable) {
    for (let i = 0; i < sorted.length; i++) {
      const sid = getMessageIdFromExtracted(sorted[i], sorted);
      if (sid === aStable) return i;
    }
  }
  if (aRowKey) {
    for (let i = 0; i < sorted.length; i++) {
      const rk = String(sorted[i]?.__rowKey ?? buildRowKey(sorted[i])).trim();
      if (rk === aRowKey) return i;
    }
  }
  if (aFp) {
    let lastMatch = -1;
    for (let i = 0; i < sorted.length; i++) {
      const fp = buildTextFingerprint(sorted[i]?.text);
      if (fp === aFp && (aPos < 0 || i <= aPos)) lastMatch = i;
    }
    if (lastMatch >= 0) return lastMatch;
  }
  return -1;
}

/**
 * @param {Array<object>} sorted
 * @param {number} posA
 * @param {number} posB
 */
function arePositionsBurstAdjacent(sorted, posA, posB) {
  if (!Number.isFinite(posA) || !Number.isFinite(posB) || posB <= posA) return false;
  if (posB === posA + 1) return true;
  for (let i = posA + 1; i < posB; i++) {
    if (sorted[i]?.sender === "user") return false;
  }
  return true;
}

/**
 * @param {object} a
 * @param {object} b
 * @param {Map<string, number>} tickFirstSeenByStableId
 * @param {Array<object>} extractedList
 * @returns {number | null}
 */
function burstPairGapMs(a, b, tickFirstSeenByStableId, extractedList) {
  const ta = parseRowTimestampMs(a);
  const tb = parseRowTimestampMs(b);
  if (ta != null && tb != null) return Math.abs(tb - ta);
  const sidA = getMessageIdFromExtracted(a, extractedList);
  const sidB = getMessageIdFromExtracted(b, extractedList);
  const fa = sidA ? tickFirstSeenByStableId.get(sidA) : undefined;
  const fb = sidB ? tickFirstSeenByStableId.get(sidB) : undefined;
  if (fa != null && fb != null) return Math.abs(fb - fa);
  return null;
}

/**
 * @param {object} row
 * @param {number} sortedIndex
 * @param {string} chatKey
 * @param {Array<object>} extractedList
 */
function buildSessionVisibilityRecord(row, sortedIndex, chatKey, extractedList) {
  const stableId = getMessageIdFromExtracted(row, extractedList);
  return {
    stableId: String(stableId ?? "").trim(),
    rowKey: String(row?.__rowKey ?? buildRowKey(row)).trim(),
    participantKey: String(row?.participantKey ?? "").trim(),
    textFingerprint: buildTextFingerprint(row?.text),
    timestamp:
      row?.timestamp != null && String(row.timestamp).trim() !== ""
        ? String(row.timestamp).trim()
        : null,
    positionAtSeen: sortedIndex,
  };
}

/**
 * @param {object} freshState
 * @param {Array<object>} sorted
 * @param {number} anchorIndex
 * @param {string} chatKey
 */
function recordSessionVisibilityLedger(freshState, sorted, anchorIndex, chatKey, extractedList) {
  if (!freshState || !Array.isArray(sorted) || anchorIndex < 0) return;
  if (!Array.isArray(freshState.sessionVisibilityLedger)) {
    freshState.sessionVisibilityLedger = [];
  }
  const ledger = freshState.sessionVisibilityLedger;
  const seenKeys = new Set(
    ledger.map((r) => `${r.textFingerprint}::${r.participantKey}::${r.positionAtSeen}`)
  );
  for (let i = 0; i <= anchorIndex && i < sorted.length; i++) {
    const row = sorted[i];
    if (row?.sender !== "user") continue;
    if (!isVerifiedFreshDeltaUserRow(row, chatKey)) continue;
    const rec = buildSessionVisibilityRecord(row, i, chatKey, extractedList);
    const dedupeKey = `${rec.textFingerprint}::${rec.participantKey}::${rec.positionAtSeen}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    ledger.push(rec);
  }
}

/**
 * @param {object} row
 * @param {Array<object>} ledger
 * @param {number} anchorIndex
 * @param {number} sortedIndex
 */
function isRowHistoricalInSessionLedger(row, ledger, anchorIndex, sortedIndex) {
  if (!Array.isArray(ledger) || ledger.length === 0) return false;
  const stableId = String(getMessageIdFromExtracted(row, []) ?? "").trim();
  const rowKey = String(row?.__rowKey ?? buildRowKey(row)).trim();
  const participantKey = String(row?.participantKey ?? "").trim();
  const textFingerprint = buildTextFingerprint(row?.text);
  const timestamp =
    row?.timestamp != null && String(row.timestamp).trim() !== ""
      ? String(row.timestamp).trim()
      : null;
  const strictlyPostAnchor =
    Number.isFinite(sortedIndex) &&
    Number.isFinite(anchorIndex) &&
    sortedIndex > anchorIndex;

  for (const rec of ledger) {
    if (Number(rec.positionAtSeen) > anchorIndex) continue;
    if (stableId && rec.stableId === stableId) return true;
    if (rowKey && rec.rowKey === rowKey) return true;
    // Post-anchor rows have new DOM positions/keys; do not semantic-dedupe repeats.
    if (strictlyPostAnchor) continue;
    if (
      textFingerprint &&
      rec.textFingerprint === textFingerprint &&
      (!participantKey || !rec.participantKey || participantKey === rec.participantKey)
    ) {
      return true;
    }
    if (
      timestamp &&
      rec.timestamp === timestamp &&
      textFingerprint &&
      rec.textFingerprint === textFingerprint
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Hold-eligible same-index tail rows may match session ledger by textFingerprint only
 * (new stableId/rowKey). Bypass ledger backlog drop when hold admission is otherwise valid.
 * @param {object} p
 */
function shouldBypassSessionLedgerForHoldEligibleRow(p) {
  const {
    msg,
    sortedIndex,
    admissionIndex,
    listTailIndex,
    admissionTailIndex,
    holdEligible,
    freshState,
    chatKey,
    extractedList,
  } = p;
  if (!holdEligible) return false;
  if (!Number.isFinite(sortedIndex) || sortedIndex !== admissionIndex) return false;
  const effectiveTail =
    admissionTailIndex != null && Number.isFinite(Number(admissionTailIndex))
      ? Number(admissionTailIndex)
      : Number(listTailIndex);
  if (!Number.isFinite(effectiveTail) || sortedIndex !== effectiveTail) return false;
  if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) return false;
  if (freshDeltaAssistantLikeDetail(msg, chatKey).assistantLike) return false;

  const stableId = String(getMessageIdFromExtracted(msg, extractedList) ?? "").trim();
  if (!stableId) return false;
  if (
    freshState?.baselineSeenStableIds instanceof Set &&
    freshState.baselineSeenStableIds.has(stableId)
  ) {
    return false;
  }

  const guaranteeKey = playwrightGuaranteeKeyForStableId(chatKey, stableId);
  const st = getMessageState(guaranteeKey);
  if (st?.state === "done" || st?.state === "processing") return false;

  return true;
}

/**
 * Resolve admission gate vs DOM anchor location (diagnostics only for relocation).
 * @param {Array<object>} sorted
 * @param {object | null | undefined} freshState
 * @param {string} chatKey
 */
export function resolveFreshDeltaAdmissionGate(sorted, freshState, chatKey) {
  const resolvedAnchorIndex = findTailAnchorIndex(sorted, freshState?.currentTailAnchor);
  const listLength = Array.isArray(sorted) ? sorted.length : 0;
  let acknowledgedAnchorIndex = Number(freshState?.acknowledgedAnchorIndex);
  const staleAck = acknowledgedAnchorIndex;
  const needsRepair =
    !Number.isFinite(acknowledgedAnchorIndex) ||
    acknowledgedAnchorIndex < 0 ||
    (listLength > 0 && acknowledgedAnchorIndex >= listLength);

  if (needsRepair) {
    if (resolvedAnchorIndex >= 0) {
      // Restore only from trusted last-admitted identity currently in the DOM.
      // Never repair to max visible index — that row may never have been admitted.
      acknowledgedAnchorIndex = resolvedAnchorIndex;
      if (freshState && Number.isFinite(acknowledgedAnchorIndex)) {
        freshState.acknowledgedAnchorIndex = acknowledgedAnchorIndex;
      }
      console.log("[fresh_delta_acknowledged_anchor_repaired]", {
        chatKey,
        staleAcknowledgedAnchorIndex: Number.isFinite(staleAck) ? staleAck : null,
        repairedAcknowledgedAnchorIndex: acknowledgedAnchorIndex,
        resolvedAnchorIndex,
        currentListLength: listLength,
        reason:
          !Number.isFinite(staleAck) || staleAck < 0 ? "invalid_negative" : "out_of_range",
        repairSource: "trusted_last_admitted_identity",
      });
      return {
        resolvedAnchorIndex,
        acknowledgedAnchorIndex,
        waitForRescan: false,
      };
    }
    // Missing trusted identity: wait/rescan. Do not reanchor to the visible tail.
    console.log("[fresh_delta_acknowledged_anchor_wait_rescan]", {
      chatKey,
      staleAcknowledgedAnchorIndex: Number.isFinite(staleAck) ? staleAck : null,
      resolvedAnchorIndex,
      currentListLength: listLength,
      reason:
        !Number.isFinite(staleAck) || staleAck < 0 ? "invalid_negative" : "out_of_range",
      note: "no_repair_to_visible_tail",
    });
    return {
      resolvedAnchorIndex,
      acknowledgedAnchorIndex: Number.isFinite(staleAck) ? staleAck : -1,
      waitForRescan: true,
    };
  }
  if (
    resolvedAnchorIndex >= 0 &&
    Number.isFinite(acknowledgedAnchorIndex) &&
    resolvedAnchorIndex > acknowledgedAnchorIndex
  ) {
    console.log("[fresh_delta_anchor_index_relocated]", {
      chatKey,
      acknowledgedAnchorIndex,
      resolvedAnchorIndex,
      stableId: freshState?.currentTailAnchor?.stableId ?? null,
      currentListLength: listLength,
    });
  }
  return { resolvedAnchorIndex, acknowledgedAnchorIndex, waitForRescan: false };
}

/**
 * Restore currentTailAnchor + ack from trusted last-admitted stableId when present in DOM.
 * @param {Array<object>} sorted
 * @param {object} freshState
 * @param {string} chatKey
 * @returns {number} restored index or -1
 */
function tryRestoreAnchorFromLastAdmitted(sorted, freshState, chatKey) {
  if (!freshState || !Array.isArray(sorted) || sorted.length === 0) return -1;
  const trustedId = String(
    freshState.lastAdmittedStableId || freshState.currentTailAnchor?.stableId || ""
  ).trim();
  if (!trustedId) return -1;
  const restoredIndex = findTailAnchorIndex(sorted, {
    stableId: trustedId,
    rowKey: "",
    textFingerprint: "",
    __position: -1,
  });
  if (restoredIndex < 0) return -1;
  const restoredAnchor = buildTailAnchorFromRow(
    sorted[restoredIndex],
    restoredIndex,
    chatKey,
    sorted
  );
  freshState.currentTailAnchor = restoredAnchor;
  freshState.acknowledgedAnchorIndex = restoredIndex;
  console.log("[fresh_delta_anchor_restored_from_last_admitted]", {
    chatKey,
    restoredIndex,
    stableId: trustedId,
    currentListLength: sorted.length,
  });
  return restoredIndex;
}

/**
 * Test helper: mirror production missing-anchor path (wait/rescan; no reanchor to tail).
 * @param {Array<object>} sorted
 * @param {object} freshState
 * @param {string} chatKey
 */
export function __freshDeltaAnchorMissingForTests(sorted, freshState, chatKey) {
  let resolvedAnchorIndex = findTailAnchorIndex(sorted, freshState?.currentTailAnchor);
  if (resolvedAnchorIndex < 0) {
    resolvedAnchorIndex = tryRestoreAnchorFromLastAdmitted(sorted, freshState, chatKey);
  }
  if (resolvedAnchorIndex >= 0) {
    const gate = resolveFreshDeltaAdmissionGate(sorted, freshState, chatKey);
    return {
      forwardAllowed: !gate.waitForRescan,
      reanchored: false,
      waitForRescan: Boolean(gate.waitForRescan),
      restoredFromLastAdmitted: Boolean(freshState?.lastAdmittedStableId),
      resolvedAnchorIndex: gate.resolvedAnchorIndex,
      acknowledgedAnchorIndex: gate.acknowledgedAnchorIndex,
    };
  }
  console.log("[fresh_delta_anchor_missing_wait_rescan]", {
    chatKey,
    acknowledgedAnchorIndex: freshState?.acknowledgedAnchorIndex ?? null,
    lastAdmittedStableId: freshState?.lastAdmittedStableId ?? null,
    currentListLength: Array.isArray(sorted) ? sorted.length : 0,
    note: "wait_rescan_no_reanchor_to_tail",
  });
  return {
    forwardAllowed: false,
    reanchored: false,
    waitForRescan: true,
    restoredFromLastAdmitted: false,
    resolvedAnchorIndex: -1,
    acknowledgedAnchorIndex: Number(freshState?.acknowledgedAnchorIndex),
  };
}

/**
 * Text-only assistant/echo classification shared by fresh-delta admission and brain v2 contract tests.
 * @param {unknown} text
 * @param {string} [chatKey]
 */
export function evaluateAssistantLikeUserText(text, chatKey = "") {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { assistantLike: true, reason: "empty_text" };
  }
  if (isEmilyAssistantPricingStatement(raw)) {
    return { assistantLike: true, reason: "assistant_pricing_statement" };
  }
  if (isEmilyBookingEngagementStatement(raw)) {
    return { assistantLike: true, reason: "assistant_booking_engagement" };
  }
  if (isLikelyAssistantOutboundCopy(raw)) {
    return { assistantLike: true, reason: "assistant_copy_template" };
  }
  if (looksLikeAssistantTemplateSubstring(raw)) {
    return { assistantLike: true, reason: "assistant_template_substring" };
  }
  const ck = String(chatKey ?? "").trim();
  if (ck && isRegisteredPlaywrightOutboundEcho(ck, raw)) {
    return { assistantLike: true, reason: "outbound_echo_registry" };
  }
  return { assistantLike: false, reason: null };
}

/**
 * TEMPORARY DIAGNOSTIC — row-level admission tracing (no behavior change).
 * @param {object} m
 * @param {string} chatKey
 */
function freshDeltaAssistantLikeDetail(m, chatKey) {
  if (!m || typeof m !== "object") {
    return { assistantLike: true, reason: "invalid_row" };
  }
  const sender = String(m.sender ?? "").trim() || "unknown";
  if (sender !== "user") {
    return { assistantLike: true, reason: "non_user_sender" };
  }
  const text = String(m.text ?? "").trim();
  const assistantLike = evaluateAssistantLikeUserText(text, chatKey);
  if (assistantLike.assistantLike && assistantLike.reason === "outbound_echo_registry") {
    console.log("[outbound_echo_blocked]", {
      chatKey,
      stableId: null,
      rowKey: String(m?.__rowKey ?? "").trim() || null,
      textPreview: text.slice(0, 120),
      reason: "outbound_echo_registry",
      matchedOutboundPreview: text.slice(0, 120),
    });
  }
  return assistantLike;
}

/**
 * Meaningful-user-tail admission (V1.5). Default off — opt in via env.
 */
export function isPlaywrightMeaningfulUserTailEnabled() {
  return (
    String(process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

/**
 * Guarantee-first admission: stableId + guarantee state is the only forward gate.
 * Default on when fresh-delta is enabled (set PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION=false to revert).
 */
export function isPlaywrightGuaranteeFirstAdmissionEnabled() {
  if (!isPlaywrightGroupFreshDeltaOnlyEnabled()) return false;
  const raw = String(process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION ?? "")
    .trim()
    .toLowerCase();
  if (raw === "false") return false;
  if (raw === "true") return true;
  return process.env.NODE_ENV !== "test";
}

/**
 * Punctuation / symbol-only inbound (aligned with whatsappGroupInboundGate.shouldBlockMessage).
 * @param {unknown} text
 */
export function isListenerInboundNoise(text) {
  const raw = String(text ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^[\s\W]+$/.test(raw);
}

/**
 * Short punctuation that may burst-merge after a meaningful line (never forwarded alone).
 * @param {unknown} text
 */
export function isBurstMergeContinuationText(text) {
  return isBurstMergeContinuationTextPolicy(text);
}

/**
 * @param {object} row
 * @param {{ chatKey: string, freshState?: object, ledger?: object[], admissionIndex?: number, extractedList?: object[] }} context
 */
export function isMeaningfulVerifiedInboundUserRow(row, context) {
  const chatKey = String(context?.chatKey ?? "").trim();
  if (!isVerifiedFreshDeltaUserRow(row, chatKey)) return false;
  if (isListenerInboundNoise(row?.text)) return false;
  return true;
}

/**
 * Max DOM index of meaningful verified inbound user rows (excludes assistant/noise).
 * @param {Array<object>} extractedList
 * @param {{ chatKey: string, freshState?: object, ledger?: object[], admissionIndex?: number, extractedList?: object[] }} context
 */
export function computeMeaningfulUserTailIndex(extractedList, context) {
  let meaningfulUserTailIndex = -1;
  let meaningfulTailRow = null;
  for (const row of extractedList || []) {
    const pos = Number(row?.__position);
    if (!Number.isFinite(pos)) continue;
    if (!isMeaningfulVerifiedInboundUserRow(row, context)) continue;
    if (pos > meaningfulUserTailIndex) {
      meaningfulUserTailIndex = pos;
      meaningfulTailRow = row;
    }
  }
  return { meaningfulUserTailIndex, meaningfulTailRow };
}

/**
 * Admission tail for same-index / hold bypass — not anchor identity.
 * @param {{ rawListTailIndex: number, meaningfulUserTailIndex: number, featureEnabled?: boolean }} p
 */
export function getAdmissionTailIndex(p) {
  const rawListTailIndex = Number(p?.rawListTailIndex);
  const meaningfulUserTailIndex = Number(p?.meaningfulUserTailIndex);
  const featureEnabled =
    p?.featureEnabled != null
      ? Boolean(p.featureEnabled)
      : isPlaywrightMeaningfulUserTailEnabled();
  if (
    featureEnabled &&
    Number.isFinite(meaningfulUserTailIndex) &&
    meaningfulUserTailIndex >= 0
  ) {
    return meaningfulUserTailIndex;
  }
  if (Number.isFinite(rawListTailIndex) && rawListTailIndex >= 0) {
    return rawListTailIndex;
  }
  return -1;
}

/**
 * @param {object} p
 */
function logFreshDeltaAdmissionTailCompare(p) {
  const {
    chatKey,
    msg,
    sortedIndex,
    admissionIndex,
    rawListTailIndex,
    meaningfulUserTailIndex,
    rawTailRow,
    meaningfulTailRow,
    oldTailDecision,
    newTailDecision,
    featureEnabled,
    extractedList,
  } = p;
  const stableId = String(getMessageIdFromExtracted(msg, extractedList) ?? "").trim() || null;
  console.log("[fresh_delta_admission_tail_compare]", {
    chatKey,
    stableId,
    textPreview: String(msg?.text ?? "").slice(0, 120),
    sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
    admissionIndex: Number.isFinite(admissionIndex) ? admissionIndex : null,
    rawListTailIndex: Number.isFinite(rawListTailIndex) ? rawListTailIndex : null,
    rawTailSender: rawTailRow ? String(rawTailRow.sender ?? "").trim() || null : null,
    rawTailTextPreview: rawTailRow
      ? String(rawTailRow.text ?? "").slice(0, 60)
      : null,
    meaningfulUserTailIndex: Number.isFinite(meaningfulUserTailIndex)
      ? meaningfulUserTailIndex
      : null,
    meaningfulTailTextPreview: meaningfulTailRow
      ? String(meaningfulTailRow.text ?? "").slice(0, 60)
      : null,
    oldTailDecision,
    newTailDecision,
    featureEnabled: Boolean(featureEnabled),
  });
}

/**
 * @param {object} p
 */
function shouldFreshDeltaRowDecisionTrace(p) {
  if (process.env.PLAYWRIGHT_FRESH_DELTA_ROW_DECISION_TRACE === "false") {
    return false;
  }
  if (process.env.PLAYWRIGHT_FRESH_DELTA_ROW_DECISION_TRACE === "true") {
    return true;
  }
  const text = String(p?.msg?.text ?? "").toLowerCase();
  const sortedIndex = Number(p?.sortedIndex);
  const listTailIndex = Number(p?.listTailIndex);
  if (/\b3\s*months?\b/.test(text)) return true;
  if (
    Number.isFinite(sortedIndex) &&
    Number.isFinite(listTailIndex) &&
    sortedIndex === listTailIndex
  ) {
    return true;
  }
  return true;
}

/**
 * TEMPORARY DIAGNOSTIC — logs one admission decision per user row.
 * @param {object} p
 */
function logFreshDeltaRowDecisionTrace(p) {
  if (!shouldFreshDeltaRowDecisionTrace(p)) return;
  const {
    chatKey,
    msg,
    sortedIndex,
    admissionIndex,
    listTailIndex,
    resolvedAnchorIndex,
    holdEligible = false,
    sameIndexDecision = null,
    finalDecision,
    dropReason,
    baselineSeen = false,
    sessionLedgerSeen = false,
    doneOrProcessing = false,
    assistantLike = false,
    extractedList,
  } = p;
  const stableId =
    String(p?.stableId ?? "").trim() ||
    String(getMessageIdFromExtracted(msg, extractedList) ?? "").trim() ||
    null;
  const isSameIndex =
    Number.isFinite(sortedIndex) &&
    Number.isFinite(admissionIndex) &&
    sortedIndex === admissionIndex;
  const isTail =
    Number.isFinite(sortedIndex) &&
    Number.isFinite(listTailIndex) &&
    sortedIndex === listTailIndex;
  const isStrictlyPostAnchor =
    Number.isFinite(sortedIndex) && Number.isFinite(admissionIndex)
      ? sortedIndex > admissionIndex
      : false;
  console.log("[fresh_delta_row_decision_trace]", {
    chatKey,
    textPreview: String(msg?.text ?? "").slice(0, 120),
    stableId,
    sourceMessageIndex:
      msg?.sourceMessageIndex != null && Number.isFinite(Number(msg.sourceMessageIndex))
        ? Number(msg.sourceMessageIndex)
        : null,
    sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
    admissionIndex: Number.isFinite(admissionIndex) ? admissionIndex : null,
    listTailIndex: Number.isFinite(listTailIndex) ? listTailIndex : null,
    acknowledgedAnchorIndex: Number.isFinite(admissionIndex) ? admissionIndex : null,
    resolvedAnchorIndex: Number.isFinite(resolvedAnchorIndex)
      ? resolvedAnchorIndex
      : null,
    isStrictlyPostAnchor,
    isSameIndex,
    isTail,
    sender: String(msg?.sender ?? "").trim() || null,
    participantKey: String(msg?.participantKey ?? "").trim() || null,
    baselineSeen: Boolean(baselineSeen),
    sessionLedgerSeen: Boolean(sessionLedgerSeen),
    doneOrProcessing: Boolean(doneOrProcessing),
    assistantLike: Boolean(assistantLike),
    holdEligible: Boolean(holdEligible),
    sameIndexDecision,
    finalDecision,
    dropReason: dropReason || null,
  });
}

/**
 * Phase B — guarantee + startup baseline are the only admission authorities.
 * No ack index, anchor-hold, session-ledger, or meaningful-tail admission gates.
 * @param {object} p
 */
export function filterGuaranteeFirstEligibleUserRows(p) {
  const resolvedAnchorIndex = Number(p?.resolvedAnchorIndex);
  const acknowledgedAnchorIndex = Number(p?.acknowledgedAnchorIndex);
  if (Number.isFinite(resolvedAnchorIndex) || Number.isFinite(acknowledgedAnchorIndex)) {
    return resolveFreshAdmittedTurns(p);
  }
  const {
    userMessages,
    freshState,
    chatKey,
    extractedList,
    tickMs = Date.now(),
  } = p;
  const droppedAssistant = [];
  const droppedNoise = [];
  const droppedDone = [];
  const droppedBaseline = [];
  /** @type {any[]} */
  const survivors = [];

  if (!freshState.tickFirstSeenByStableId) {
    freshState.tickFirstSeenByStableId = new Map();
  }
  const tickFirstSeen = freshState.tickFirstSeenByStableId;

  for (const msg of userMessages) {
    const sortedIndex = Number(msg?.__position);
    if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) {
      const assistantDetail = freshDeltaAssistantLikeDetail(msg, chatKey);
      if (droppedAssistant.length < 3) {
        droppedAssistant.push(String(msg?.text ?? "").slice(0, 120));
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: getMessageIdFromExtracted(msg, extractedList) || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: assistantDetail.reason || "assistant_or_unverified_user_row",
        guaranteeState: null,
      });
      continue;
    }
    if (isListenerInboundNoise(msg?.text)) {
      if (droppedNoise.length < 3) {
        droppedNoise.push(String(msg?.text ?? "").slice(0, 80));
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: getMessageIdFromExtracted(msg, extractedList) || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 80),
        finalDecision: "drop",
        dropReason: "inbound_noise_row",
        guaranteeState: null,
      });
      continue;
    }

    const { stableId, guaranteeKey } = resolvePlaywrightForwardIdentity(
      chatKey,
      msg,
      0,
      extractedList
    );
    if (!stableId) {
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: "missing_stable_id",
        guaranteeState: null,
      });
      continue;
    }

    if (isInboundTurnLedgerEnabled()) {
      const ledgerBlock = resolveInboundTurnAdmissionBlock({
        chatKey,
        stableId,
        textPreview: String(msg?.text ?? "").slice(0, 120),
      });
      if (ledgerBlock.blocked) {
        if (ledgerBlock.reason === "outbound_locked") {
          scheduleOutboundLockedRecovery({
            chatKey,
            stableId,
            guaranteeKey:
              ledgerBlock.guaranteeKey ||
              playwrightGuaranteeKeyForStableId(chatKey, stableId),
          });
        }
        if (droppedDone.length < 3) droppedDone.push(stableId);
        console.log("[guarantee_first_row_decision]", {
          chatKey,
          stableId,
          sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
          textPreview: String(msg?.text ?? "").slice(0, 120),
          finalDecision: "drop",
          dropReason: ledgerBlock.reason || "inbound_turn_ledger_blocked",
          guaranteeState: ledgerBlock.logEvent || "ledger",
        });
        continue;
      }
    }

    const st = getMessageState(guaranteeKey);
    if (st?.state === "done" || st?.state === "processing") {
      if (droppedDone.length < 3) droppedDone.push(stableId);
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: `guarantee_${st?.state || "inflight"}`,
        guaranteeState: st.state,
      });
      continue;
    }

    const seenBaseline =
      freshState?.baselineSeenStableIds instanceof Set &&
      freshState.baselineSeenStableIds.has(stableId);
    if (seenBaseline) {
      if (droppedBaseline.length < 3) {
        droppedBaseline.push({
          stableId,
          textPreview: String(msg?.text ?? "").slice(0, 80),
        });
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: "baseline_seen_stable_id",
        guaranteeState: st?.state || "idle",
      });
      continue;
    }

    if (!tickFirstSeen.has(stableId)) {
      tickFirstSeen.set(stableId, tickMs);
    }

    survivors.push(msg);
    if (freshState.admittedFreshStableIds instanceof Set) {
      freshState.admittedFreshStableIds.add(stableId);
    }
    if (matchesBaselineDeferredTailUser(msg, freshState, extractedList)) {
      console.log("[baseline_tail_user_admitted]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
      });
    }
    console.log("[guarantee_first_row_decision]", {
      chatKey,
      stableId,
      sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
      textPreview: String(msg?.text ?? "").slice(0, 120),
      finalDecision: "survivor",
      dropReason: null,
      guaranteeState: st?.state || "idle",
    });
  }

  console.log("[guarantee_first_tick_summary]", {
    chatKey,
    inputCount: Array.isArray(userMessages) ? userMessages.length : 0,
    survivorCount: survivors.length,
    droppedAssistant: droppedAssistant.length,
    droppedNoise: droppedNoise.length,
    droppedDone: droppedDone.length,
    droppedBaseline: droppedBaseline.length,
    droppedPreAnchor: 0,
    admissionMode: "guarantee_and_baseline_only",
  });

  return {
    survivors,
    droppedAssistant,
    droppedBaseline,
    droppedDone,
    droppedPreAnchor: [],
    droppedNoise,
  };
}

/**
 * Single listener authority for WhatsApp rows that may enter Brain.
 * DOM rows, ledger state, baseline, anchors, and guarantee state are evidence;
 * only rows returned here as admitted turns are current-fresh input.
 * @param {object} p
 */
export function resolveFreshAdmittedTurns(p) {
  const {
    userMessages,
    freshState,
    chatKey,
    extractedList,
    acknowledgedAnchorIndex,
    resolvedAnchorIndex,
    tickMs = Date.now(),
  } = p;
  const droppedAssistant = [];
  const droppedNoise = [];
  const droppedDone = [];
  const droppedBaseline = [];
  const droppedPreAnchor = [];
  /** @type {any[]} */
  const survivors = [];
  const rejectedTurns = [];
  const admittedTurns = [];
  const currentFreshAdmittedStableIds = new Set();
  const currentFreshAdmittedStableIdsByParticipant = new Map();
  const resolvedIndex = Number(resolvedAnchorIndex);
  const acknowledgedIndex = Number(acknowledgedAnchorIndex);
  // Prefer acknowledged (last successfully advanced admitted turn) so a relocated
  // or wrongly-advanced currentTailAnchor cannot raise the gate past unadmitted rows.
  const effectiveAnchorIndex = Number.isFinite(acknowledgedIndex)
    ? acknowledgedIndex
    : Number.isFinite(resolvedIndex)
      ? resolvedIndex
      : null;
  const anchorProof = {
    effectiveAnchorIndex,
    source: Number.isFinite(acknowledgedIndex)
      ? "acknowledgedAnchorIndex"
      : Number.isFinite(resolvedIndex)
        ? "resolvedAnchorIndex"
        : "missing",
    resolvedAnchorIndex: Number.isFinite(resolvedIndex) ? resolvedIndex : null,
    acknowledgedAnchorIndex: Number.isFinite(acknowledgedIndex)
      ? acknowledgedIndex
      : null,
  };

  const recordRejected = ({
    msg,
    stableId = null,
    sortedIndex,
    dropReason,
    ledgerState = null,
  }) => {
    rejectedTurns.push({
      stableId: stableId || null,
      textPreview: String(msg?.text ?? "").slice(0, 120),
      sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
      dropReason,
      anchorProof,
      ledgerState,
    });
  };

  if (!freshState.tickFirstSeenByStableId) {
    freshState.tickFirstSeenByStableId = new Map();
  }
  const tickFirstSeen = freshState.tickFirstSeenByStableId;

  for (const msg of userMessages) {
    const sortedIndex = Number(msg?.__position);
    if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) {
      const assistantDetail = freshDeltaAssistantLikeDetail(msg, chatKey);
      if (droppedAssistant.length < 3) {
        droppedAssistant.push(String(msg?.text ?? "").slice(0, 120));
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: getMessageIdFromExtracted(msg, extractedList) || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: assistantDetail.reason || "assistant_or_unverified_user_row",
        guaranteeState: null,
      });
      recordRejected({
        msg,
        sortedIndex,
        dropReason: assistantDetail.reason || "assistant_or_unverified_user_row",
      });
      continue;
    }
    if (isListenerInboundNoise(msg?.text)) {
      if (droppedNoise.length < 3) {
        droppedNoise.push(String(msg?.text ?? "").slice(0, 80));
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: getMessageIdFromExtracted(msg, extractedList) || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 80),
        finalDecision: "drop",
        dropReason: "inbound_noise_row",
        guaranteeState: null,
      });
      recordRejected({ msg, sortedIndex, dropReason: "inbound_noise_row" });
      continue;
    }

    const { stableId, guaranteeKey, strategy } = resolvePlaywrightForwardIdentity(
      chatKey,
      msg,
      0,
      extractedList
    );
    if (!stableId || strategy !== "WHATSAPP_DATA_ID") {
      // Defer until a stable WhatsApp data-id appears. Do not ledger-block by text.
      const dropReason = !stableId ? "missing_stable_id" : "missing_whatsapp_data_id";
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId: stableId || null,
        strategy: strategy || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason,
        guaranteeState: null,
        note: "defer_rescan_no_ledger_mark",
      });
      recordRejected({ msg, stableId: stableId || null, sortedIndex, dropReason });
      continue;
    }

    if (isInboundTurnLedgerEnabled()) {
      const ledgerBlock = resolveInboundTurnAdmissionBlock({
        chatKey,
        stableId,
        textPreview: String(msg?.text ?? "").slice(0, 120),
      });
      if (ledgerBlock.blocked) {
        if (ledgerBlock.reason === "outbound_locked") {
          scheduleOutboundLockedRecovery({
            chatKey,
            stableId,
            guaranteeKey:
              ledgerBlock.guaranteeKey ||
              playwrightGuaranteeKeyForStableId(chatKey, stableId),
          });
        }
        if (droppedDone.length < 3) droppedDone.push(stableId);
        console.log("[guarantee_first_row_decision]", {
          chatKey,
          stableId,
          sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
          textPreview: String(msg?.text ?? "").slice(0, 120),
          finalDecision: "drop",
          dropReason: ledgerBlock.reason || "inbound_turn_ledger_blocked",
          guaranteeState: ledgerBlock.logEvent || "ledger",
        });
        recordRejected({
          msg,
          stableId,
          sortedIndex,
          dropReason: ledgerBlock.reason || "inbound_turn_ledger_blocked",
          ledgerState: ledgerBlock.reason || ledgerBlock.logEvent || "ledger",
        });
        continue;
      }
    }

    const st = getMessageState(guaranteeKey);
    if (st?.state === "done" || st?.state === "processing") {
      if (droppedDone.length < 3) droppedDone.push(stableId);
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: `guarantee_${st?.state || "inflight"}`,
        guaranteeState: st.state,
      });
      recordRejected({
        msg,
        stableId,
        sortedIndex,
        dropReason: `guarantee_${st?.state || "inflight"}`,
        ledgerState: st.state,
      });
      continue;
    }

    const seenBaseline =
      freshState?.baselineSeenStableIds instanceof Set &&
      freshState.baselineSeenStableIds.has(stableId);
    if (seenBaseline) {
      if (droppedBaseline.length < 3) {
        droppedBaseline.push({
          stableId,
          textPreview: String(msg?.text ?? "").slice(0, 80),
        });
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason: "baseline_seen_stable_id",
        guaranteeState: st?.state || "idle",
      });
      recordRejected({
        msg,
        stableId,
        sortedIndex,
        dropReason: "baseline_seen_stable_id",
        ledgerState: "baseline_seen",
      });
      continue;
    }

    const isStrictlyPostAnchor =
      Number.isFinite(sortedIndex) &&
      effectiveAnchorIndex != null &&
      sortedIndex > effectiveAnchorIndex;
    if (!isStrictlyPostAnchor) {
      if (droppedPreAnchor.length < 3) {
        droppedPreAnchor.push({
          stableId,
          textPreview: String(msg?.text ?? "").slice(0, 80),
          reason: "NOT_CURRENT_FRESH_POST_ANCHOR",
        });
      }
      console.log("[guarantee_first_row_decision]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        acknowledgedAnchorIndex: Number.isFinite(acknowledgedIndex)
          ? acknowledgedIndex
          : null,
        resolvedAnchorIndex: Number.isFinite(resolvedIndex) ? resolvedIndex : null,
        effectiveAnchorIndex,
        textPreview: String(msg?.text ?? "").slice(0, 120),
        finalDecision: "drop",
        dropReason:
          effectiveAnchorIndex == null
            ? "missing_current_anchor_proof"
            : "not_current_fresh_post_anchor",
        guaranteeState: st?.state || "idle",
      });
      recordRejected({
        msg,
        stableId,
        sortedIndex,
        dropReason:
          effectiveAnchorIndex == null
            ? "missing_current_anchor_proof"
            : "not_current_fresh_post_anchor",
        ledgerState: st?.state || "idle",
      });
      continue;
    }

    if (!tickFirstSeen.has(stableId)) {
      tickFirstSeen.set(stableId, tickMs);
    }

    survivors.push(msg);
    const participantKey = String(msg?.participantKey ?? "").trim() || "(missing)";
    currentFreshAdmittedStableIds.add(stableId);
    if (!currentFreshAdmittedStableIdsByParticipant.has(participantKey)) {
      currentFreshAdmittedStableIdsByParticipant.set(participantKey, new Set());
    }
    currentFreshAdmittedStableIdsByParticipant.get(participantKey).add(stableId);
    admittedTurns.push({
      stableId,
      text: String(msg?.text ?? ""),
      participantKey: msg?.participantKey || null,
      participantName: msg?.participantName || null,
      sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
      sourceMessageId: stableId,
      sourceRowKey: String(msg?.__rowKey ?? "").trim() || null,
      guaranteeKey,
      freshnessProof: {
        kind: "post_current_anchor",
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        effectiveAnchorIndex,
      },
      anchorProof,
      ledgerState: st?.state || "idle",
      originalRow: msg,
    });
    if (freshState.admittedFreshStableIds instanceof Set) {
      freshState.admittedFreshStableIds.add(stableId);
    }
    if (matchesBaselineDeferredTailUser(msg, freshState, extractedList)) {
      console.log("[baseline_tail_user_admitted]", {
        chatKey,
        stableId,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        textPreview: String(msg?.text ?? "").slice(0, 120),
      });
    }
    console.log("[guarantee_first_row_decision]", {
      chatKey,
      stableId,
      sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
      textPreview: String(msg?.text ?? "").slice(0, 120),
      finalDecision: "survivor",
      dropReason: null,
      guaranteeState: st?.state || "idle",
    });
  }

  console.log("[guarantee_first_tick_summary]", {
    chatKey,
    inputCount: userMessages.length,
    survivorCount: survivors.length,
    droppedAssistant: droppedAssistant.length,
    droppedNoise: droppedNoise.length,
    droppedDone: droppedDone.length,
    droppedBaseline: droppedBaseline.length,
    droppedPreAnchor: droppedPreAnchor.length,
    admissionMode: "guarantee_and_baseline_only",
  });

  return {
    survivors,
    admittedTurns,
    rejectedTurns,
    currentFreshAdmittedStableIds,
    currentFreshAdmittedStableIdsByParticipant,
    droppedAssistant,
    droppedBaseline,
    droppedDone,
    droppedPreAnchor,
    droppedNoise,
  };
}

/**
 * @param {object} p
 */
export function filterPostAnchorFreshUserRows(p) {
  if (isPlaywrightGuaranteeFirstAdmissionEnabled()) {
    return resolveFreshAdmittedTurns(p);
  }
  const {
    userMessages,
    acknowledgedAnchorIndex: acknowledgedAnchorIndexIn,
    resolvedAnchorIndex: resolvedAnchorIndexIn,
    /** @deprecated use acknowledgedAnchorIndex */
    anchorIndex: legacyAnchorIndex,
    freshState,
    chatKey,
    extractedList,
    tickMs = Date.now(),
  } = p;
  const admissionIndex = Number.isFinite(Number(acknowledgedAnchorIndexIn))
    ? Number(acknowledgedAnchorIndexIn)
    : Number.isFinite(Number(legacyAnchorIndex))
      ? Number(legacyAnchorIndex)
      : -1;
  const resolvedAnchorIndex = Number.isFinite(Number(resolvedAnchorIndexIn))
    ? Number(resolvedAnchorIndexIn)
    : admissionIndex;
  const droppedAssistant = [];
  const droppedBaseline = [];
  const droppedDone = [];
  const droppedPreAnchor = [];
  /** @type {any[]} */
  const survivors = [];

  let maxSortedIndex = -1;
  let rawTailRow = null;
  for (const row of extractedList || []) {
    const pos = Number(row?.__position);
    if (Number.isFinite(pos) && pos > maxSortedIndex) {
      maxSortedIndex = pos;
      rawTailRow = row;
    }
  }
  const listLength = maxSortedIndex >= 0 ? maxSortedIndex + 1 : 0;
  const meaningfulUserTailEnabled = isPlaywrightMeaningfulUserTailEnabled();
  const meaningfulTailContext = {
    chatKey,
    freshState,
    ledger: Array.isArray(freshState?.sessionVisibilityLedger)
      ? freshState.sessionVisibilityLedger
      : [],
    admissionIndex,
    extractedList,
  };
  const { meaningfulUserTailIndex, meaningfulTailRow } = computeMeaningfulUserTailIndex(
    extractedList,
    meaningfulTailContext
  );
  const admissionTailIndex = getAdmissionTailIndex({
    rawListTailIndex: maxSortedIndex,
    meaningfulUserTailIndex,
    featureEnabled: meaningfulUserTailEnabled,
  });
  if (meaningfulUserTailEnabled) {
    console.log("[fresh_delta_meaningful_tail_selected]", {
      chatKey,
      rawListTailIndex: Number.isFinite(maxSortedIndex) ? maxSortedIndex : null,
      meaningfulUserTailIndex: Number.isFinite(meaningfulUserTailIndex)
        ? meaningfulUserTailIndex
        : null,
      admissionTailIndex: Number.isFinite(admissionTailIndex) ? admissionTailIndex : null,
      rawTailSender: rawTailRow ? String(rawTailRow.sender ?? "").trim() || null : null,
      rawTailTextPreview: rawTailRow ? String(rawTailRow.text ?? "").slice(0, 60) : null,
      meaningfulTailTextPreview: meaningfulTailRow
        ? String(meaningfulTailRow.text ?? "").slice(0, 60)
        : null,
      featureEnabled: true,
    });
  }
  if (
    listLength > 0 &&
    (!Number.isFinite(admissionIndex) ||
      admissionIndex < 0 ||
      admissionIndex >= listLength)
  ) {
    console.log("[fresh_delta_admission_gate_invalid]", {
      chatKey,
      admissionIndex: Number.isFinite(admissionIndex) ? admissionIndex : null,
      listLength,
      maxSortedIndex,
      resolvedAnchorIndex,
      reason:
        Number.isFinite(admissionIndex) && admissionIndex >= listLength
          ? "above_max_index"
          : "invalid_gate",
    });
    return {
      survivors,
      droppedAssistant,
      droppedBaseline,
      droppedDone,
      droppedPreAnchor,
    };
  }

  const ledger = Array.isArray(freshState?.sessionVisibilityLedger)
    ? freshState.sessionVisibilityLedger
    : [];
  if (!freshState.tickFirstSeenByStableId) {
    freshState.tickFirstSeenByStableId = new Map();
  }
  const tickFirstSeen = freshState.tickFirstSeenByStableId;

  supersedeAnchorHoldIfNewerPostAnchorRow(
    freshState,
    userMessages,
    admissionIndex,
    chatKey,
    extractedList
  );

  for (const msg of userMessages) {
    const sortedIndex = Number(msg?.__position);
    const listTailIndex = maxSortedIndex;
    const traceBase = {
      chatKey,
      msg,
      sortedIndex,
      admissionIndex,
      listTailIndex,
      resolvedAnchorIndex,
      extractedList,
    };

    if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) {
      const assistantDetail = freshDeltaAssistantLikeDetail(msg, chatKey);
      if (droppedAssistant.length < 2) {
        droppedAssistant.push(String(msg?.text ?? "").slice(0, 120));
      }
      logFreshDeltaRowDecisionTrace({
        ...traceBase,
        assistantLike: assistantDetail.assistantLike,
        finalDecision: "drop",
        dropReason: assistantDetail.reason || "assistant_or_unverified_user_row",
      });
      continue;
    }
    if (isListenerInboundNoise(msg?.text)) {
      console.log("[fresh_delta_noise_row_dropped]", {
        chatKey,
        stableId: getMessageIdFromExtracted(msg, extractedList) || null,
        sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
        admissionIndex: Number.isFinite(admissionIndex) ? admissionIndex : null,
        rawListTailIndex: Number.isFinite(listTailIndex) ? listTailIndex : null,
        meaningfulUserTailIndex: Number.isFinite(meaningfulUserTailIndex)
          ? meaningfulUserTailIndex
          : null,
        sender: String(msg?.sender ?? "").trim() || null,
        textPreview: String(msg?.text ?? "").slice(0, 80),
        featureEnabled: meaningfulUserTailEnabled,
      });
      logFreshDeltaRowDecisionTrace({
        ...traceBase,
        finalDecision: "drop",
        dropReason: "inbound_noise_row",
      });
      continue;
    }
    const holdEligible = isAnchorHoldUserForwardEligible(
      msg,
      sortedIndex,
      resolvedAnchorIndex,
      freshState,
      extractedList
    );
    let sameIndexTailAdmit = false;
    let sameIndexDecision = null;
    const isStrictlyPostAnchor =
      Number.isFinite(sortedIndex) && sortedIndex > admissionIndex;

    if (Number.isFinite(sortedIndex)) {
      if (sortedIndex < admissionIndex) {
        if (droppedPreAnchor.length < 3) {
          droppedPreAnchor.push({
            stableId: getMessageIdFromExtracted(msg, extractedList),
            textPreview: String(msg?.text ?? "").slice(0, 80),
            reason: "AT_OR_BEFORE_TAIL_ANCHOR",
          });
        }
        logFreshDeltaRowDecisionTrace({
          ...traceBase,
          holdEligible,
          finalDecision: "drop",
          dropReason: "pre_anchor_before_acknowledged_index",
        });
        continue;
      }
      if (sortedIndex === admissionIndex && !holdEligible) {
        sameIndexDecision = classifySameIndexTailAdmission({
          msg,
          sortedIndex,
          admissionIndex,
          listTailIndex: maxSortedIndex,
          admissionTailIndex,
          meaningfulUserTailIndex,
          rawTailRow,
          meaningfulTailRow,
          freshState,
          ledger,
          extractedList,
          chatKey,
          holdEligible,
        });
        if (sameIndexDecision === "admit") {
          sameIndexTailAdmit = true;
          const admitLog = {
            chatKey,
            stableId: getMessageIdFromExtracted(msg, extractedList),
            sortedIndex,
            admissionIndex,
            listTailIndex: maxSortedIndex,
            meaningfulUserTailIndex,
            admissionTailIndex,
            textPreview: String(msg?.text ?? "").slice(0, 120),
            featureEnabled: meaningfulUserTailEnabled,
          };
          if (
            meaningfulUserTailEnabled &&
            Number.isFinite(maxSortedIndex) &&
            maxSortedIndex !== meaningfulUserTailIndex
          ) {
            console.log("[fresh_delta_same_index_meaningful_tail_admitted]", admitLog);
          } else {
            console.log("[fresh_delta_same_index_tail_admitted]", admitLog);
          }
        } else if (sameIndexDecision === "rejected_seen") {
          console.log("[fresh_delta_same_index_tail_rejected_seen]", {
            chatKey,
            stableId: getMessageIdFromExtracted(msg, extractedList),
            sortedIndex,
            textPreview: String(msg?.text ?? "").slice(0, 80),
          });
          if (droppedPreAnchor.length < 3) {
            droppedPreAnchor.push({
              stableId: getMessageIdFromExtracted(msg, extractedList),
              textPreview: String(msg?.text ?? "").slice(0, 80),
              reason: "AT_ACKNOWLEDGED_ANCHOR",
            });
          }
          logFreshDeltaRowDecisionTrace({
            ...traceBase,
            holdEligible,
            sameIndexDecision,
            sessionLedgerSeen: true,
            finalDecision: "drop",
            dropReason: "same_index_rejected_seen",
          });
          continue;
        } else if (sameIndexDecision === "rejected_anchor_match") {
          console.log("[fresh_delta_same_index_tail_rejected_anchor_match]", {
            chatKey,
            stableId: getMessageIdFromExtracted(msg, extractedList),
            sortedIndex,
            textPreview: String(msg?.text ?? "").slice(0, 80),
          });
          if (droppedPreAnchor.length < 3) {
            droppedPreAnchor.push({
              stableId: getMessageIdFromExtracted(msg, extractedList),
              textPreview: String(msg?.text ?? "").slice(0, 80),
              reason: "AT_ACKNOWLEDGED_ANCHOR",
            });
          }
          logFreshDeltaRowDecisionTrace({
            ...traceBase,
            holdEligible,
            sameIndexDecision,
            finalDecision: "drop",
            dropReason: "same_index_rejected_anchor_match",
          });
          continue;
        } else if (sameIndexDecision === "rejected_not_tail") {
          console.log("[fresh_delta_same_index_tail_rejected_not_tail]", {
            chatKey,
            stableId: getMessageIdFromExtracted(msg, extractedList),
            sortedIndex,
            admissionIndex,
            listTailIndex: maxSortedIndex,
            textPreview: String(msg?.text ?? "").slice(0, 80),
          });
          if (droppedPreAnchor.length < 3) {
            droppedPreAnchor.push({
              stableId: getMessageIdFromExtracted(msg, extractedList),
              textPreview: String(msg?.text ?? "").slice(0, 80),
              reason: "AT_ACKNOWLEDGED_ANCHOR",
            });
          }
          logFreshDeltaRowDecisionTrace({
            ...traceBase,
            holdEligible,
            sameIndexDecision,
            finalDecision: "drop",
            dropReason: "same_index_rejected_not_tail",
          });
          continue;
        } else {
          if (droppedPreAnchor.length < 3) {
            droppedPreAnchor.push({
              stableId: getMessageIdFromExtracted(msg, extractedList),
              textPreview: String(msg?.text ?? "").slice(0, 80),
              reason: "AT_ACKNOWLEDGED_ANCHOR",
            });
          }
          logFreshDeltaRowDecisionTrace({
            ...traceBase,
            holdEligible,
            sameIndexDecision,
            finalDecision: "drop",
            dropReason: "same_index_rejected_other",
          });
          continue;
        }
      }
      if (!isStrictlyPostAnchor && !holdEligible && !sameIndexTailAdmit) {
        logFreshDeltaRowDecisionTrace({
          ...traceBase,
          holdEligible,
          sameIndexDecision,
          finalDecision: "drop",
          dropReason: "not_post_anchor_and_not_hold_and_not_same_index_admit",
        });
        continue;
      }
      if (
        !sameIndexTailAdmit &&
        isRowHistoricalInSessionLedger(msg, ledger, admissionIndex, sortedIndex)
      ) {
        const bypassSessionLedgerForHold = shouldBypassSessionLedgerForHoldEligibleRow({
          msg,
          sortedIndex,
          admissionIndex,
          listTailIndex: maxSortedIndex,
          admissionTailIndex,
          holdEligible,
          freshState,
          chatKey,
          extractedList,
        });
        if (bypassSessionLedgerForHold) {
          console.log("[fresh_delta_hold_eligible_bypassed_session_ledger]", {
            chatKey,
            stableId: getMessageIdFromExtracted(msg, extractedList) || null,
            sortedIndex,
            admissionIndex,
            listTailIndex: maxSortedIndex,
            textPreview: String(msg?.text ?? "").slice(0, 120),
          });
        }
        if (!bypassSessionLedgerForHold) {
        if (droppedPreAnchor.length < 3) {
          droppedPreAnchor.push({
            stableId: getMessageIdFromExtracted(msg, extractedList),
            textPreview: String(msg?.text ?? "").slice(0, 80),
            reason: "HISTORICAL_BACKLOG",
          });
        }
        logFreshDeltaRowDecisionTrace({
          ...traceBase,
          holdEligible,
          sameIndexDecision,
          sessionLedgerSeen: true,
          finalDecision: "drop",
          dropReason: "session_ledger_historical_backlog",
        });
        continue;
        }
      }
    }

    const { stableId, guaranteeKey } = resolvePlaywrightForwardIdentity(
      chatKey,
      msg,
      0,
      extractedList
    );
    if (!stableId) {
      logFreshDeltaRowDecisionTrace({
        ...traceBase,
        holdEligible,
        sameIndexDecision,
        finalDecision: "drop",
        dropReason: "missing_stable_id",
      });
      continue;
    }

    const st = getMessageState(guaranteeKey);
    if (st?.state === "done" || st?.state === "processing") {
      if (droppedDone.length < 2) droppedDone.push(stableId);
      logFreshDeltaRowDecisionTrace({
        ...traceBase,
        stableId,
        holdEligible,
        sameIndexDecision,
        doneOrProcessing: true,
        finalDecision: "drop",
        dropReason: `guarantee_${st?.state || "inflight"}`,
      });
      continue;
    }

    const seenBaseline =
      freshState.baselineSeenStableIds instanceof Set &&
      freshState.baselineSeenStableIds.has(stableId);
    if (seenBaseline) {
      if (droppedBaseline.length < 2) droppedBaseline.push(stableId);
      logFreshDeltaRowDecisionTrace({
        ...traceBase,
        stableId,
        holdEligible,
        sameIndexDecision,
        baselineSeen: true,
        finalDecision: "drop",
        dropReason: "baseline_seen_stable_id",
      });
      continue;
    }

    if (!tickFirstSeen.has(stableId)) {
      tickFirstSeen.set(stableId, tickMs);
    }

    if (holdEligible && freshState.anchorHoldUserForward) {
      freshState.anchorHoldUserForward.consumed = true;
      console.log("[fresh_delta_anchor_hold_user_admitted]", {
        chatKey,
        stableId,
        sortedIndex,
        textPreview: String(msg.text ?? "").slice(0, 120),
      });
    }

    logFreshDeltaRowDecisionTrace({
      ...traceBase,
      stableId,
      holdEligible,
      sameIndexDecision,
      finalDecision: "survivor",
      dropReason: null,
    });
    survivors.push(msg);
    if (freshState.admittedFreshStableIds instanceof Set) {
      freshState.admittedFreshStableIds.add(stableId);
    }
    console.log("[fresh_delta_post_anchor_candidate]", {
      chatKey,
      stableId,
      sortedIndex: Number.isFinite(sortedIndex) ? sortedIndex : null,
      textPreview: String(msg.text ?? "").slice(0, 120),
    });
  }

  return {
    survivors,
    droppedAssistant,
    droppedBaseline,
    droppedDone,
    droppedPreAnchor,
  };
}

/**
 * @param {Array<object>} pending
 * @param {Array<object>} sorted
 * @param {number} burstMs
 * @param {Map<string, number>} tickFirstSeenByStableId
 * @param {Array<object>} extractedList
 * @param {string} chatKey
 */
export function splitBurstMergeRuns(
  pending,
  sorted,
  burstMs,
  tickFirstSeenByStableId,
  extractedList,
  chatKey,
  catalogItems
) {
  if (!Array.isArray(pending) || pending.length === 0) return [];
  const catalog = resolveBurstMergeCatalogItems(catalogItems);
  /** @type {Array<Array<object>>} */
  const runs = [];
  let currentRun = [pending[0]];

  for (let i = 1; i < pending.length; i++) {
    const prev = pending[i - 1];
    const next = pending[i];
    const posA = Number(prev?.__position);
    const posB = Number(next?.__position);
    if (!arePositionsBurstAdjacent(sorted, posA, posB)) {
      runs.push(currentRun);
      currentRun = [next];
      continue;
    }
    const gapMs = burstPairGapMs(prev, next, tickFirstSeenByStableId, extractedList);
    if (gapMs != null && gapMs > burstMs) {
      console.log("[burst_merge_rejected_old_timestamp]", {
        chatKey,
        gapMs,
        burstMs,
        textPreviewA: String(prev?.text ?? "").slice(0, 60),
        textPreviewB: String(next?.text ?? "").slice(0, 60),
      });
      runs.push(currentRun);
      currentRun = [next];
      continue;
    }
    if (!canMergeBurstRowPair(prev, next, catalog)) {
      console.log("[burst_merge_rejected_different_items]", {
        chatKey,
        textPreviewA: String(prev?.text ?? "").slice(0, 60),
        textPreviewB: String(next?.text ?? "").slice(0, 60),
      });
      runs.push(currentRun);
      currentRun = [next];
      continue;
    }
    currentRun.push(next);
  }
  runs.push(currentRun);
  return runs;
}

/**
 * @param {object} freshState
 * @param {object} deliveredMsg
 * @param {Array<object>} sorted
 * @param {string} chatKey
 * @param {Array<object>} extractedList
 */
export function advanceTailAnchor(freshState, deliveredMsg, sorted, chatKey, extractedList) {
  if (!freshState || !deliveredMsg) return;
  const fromAnchor = freshState.currentTailAnchor;
  const pos = Number(deliveredMsg?.__position);
  let anchorRow = deliveredMsg;
  let anchorIndex = Number.isFinite(pos) ? pos : sorted.length - 1;
  if (Number.isFinite(pos) && pos >= 0 && pos < sorted.length) {
    anchorRow = sorted[pos];
  } else if (sorted.length > 0) {
    anchorIndex = sorted.length - 1;
    anchorRow = sorted[anchorIndex];
  }
  if (sorted.length > 0) {
    anchorIndex = Math.min(Math.max(0, anchorIndex), sorted.length - 1);
    anchorRow = sorted[anchorIndex] ?? anchorRow;
  }
  const newAnchor = buildTailAnchorFromRow(anchorRow, anchorIndex, chatKey, extractedList);
  freshState.currentTailAnchor = newAnchor;
  freshState.acknowledgedAnchorIndex = anchorIndex;
  // Trusted evidence for missing-anchor restore — only set on successful admit/forward.
  if (newAnchor?.stableId) {
    freshState.lastAdmittedStableId = String(newAnchor.stableId);
  }
  if (freshState.anchorHoldUserForward) {
    freshState.anchorHoldUserForward.consumed = true;
  }
  if (freshState.baselineDeferredTailUser) {
    freshState.baselineDeferredTailUser.consumed = true;
  }
  if (!(freshState.baselineSeenStableIds instanceof Set)) {
    freshState.baselineSeenStableIds = new Set();
  }
  const burstIds = Array.isArray(deliveredMsg?.__burstStableIds)
    ? deliveredMsg.__burstStableIds
    : [];
  const idsToMark =
    burstIds.length > 0
      ? burstIds
      : [getMessageIdFromExtracted(deliveredMsg, extractedList)].filter(Boolean);
  for (const sid of idsToMark) {
    if (!isPlaywrightGuaranteeFirstAdmissionEnabled()) {
      freshState.baselineSeenStableIds.add(String(sid));
    }
  }
  console.log("[fresh_delta_tail_anchor_advanced]", {
    chatKey,
    fromStableId: fromAnchor?.stableId ?? null,
    toStableId: newAnchor.stableId,
    __position: newAnchor.__position,
    acknowledgedAnchorIndex: freshState.acknowledgedAnchorIndex,
    lastAdmittedStableId: freshState.lastAdmittedStableId ?? null,
    burstCount: deliveredMsg?.__burstMergedCount ?? 1,
    textPreview: String(anchorRow?.text ?? "").slice(0, 80),
  });
}

export function isPlaywrightGroupFreshDeltaOnlyEnabled() {
  return String(process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY ?? "").trim().toLowerCase() === "true";
}

/** Group chats must not use legacy burst-merge when fresh-delta flag is off. */
export function shouldBlockPlaywrightGroupLegacyProcessing() {
  return !isPlaywrightGroupFreshDeltaOnlyEnabled();
}

function logPlaywrightGroupFreshDeltaMode() {
  const enabled = isPlaywrightGroupFreshDeltaOnlyEnabled();
  console.log("[playwright_group_fresh_delta_mode]", { enabled });
  if (!enabled) {
    console.warn(
      "[fresh_delta_legacy_mode_blocked] PLAYWRIGHT_GROUP fresh-delta is disabled — group extraction will not forward until PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY=true"
    );
  }
}

/**
 * Burst-merged assistant blobs often break anchored template regexes.
 * This conservative substring guard prevents known assistant templates from being treated as user rows.
 * @param {unknown} text
 */
function looksLikeAssistantTemplateSubstring(text) {
  const norm = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  if (norm.includes("perfect")) return true;
  if (norm.includes("note kar liya")) return true;
  if (norm.includes("city ke andar use karna")) return true;
  if (/\bka\s+rent\b/.test(norm) && /\bke\s+liye\b/.test(norm) && /\bhoga\b/.test(norm)) {
    return true;
  }
  if (norm.includes("available options:")) return true;
  if (/\bji,\s+.+\s+available hai\.\s*kitne time ke liye chahiye\b/i.test(norm)) return true;
  if (/\b\d{3,7}\s+per\s+(day|month)\s+hai\b/i.test(norm)) return true;
  if (/\b\d{3,7}\s+hai\b/i.test(norm)) return true;
  return false;
}

/**
 * @param {object} msg
 * @param {object} hold
 * @param {Array<object>} extractedList
 */
function matchesAnchorHoldUserForward(msg, hold, extractedList) {
  if (!hold || !msg) return false;
  const stableId = String(getMessageIdFromExtracted(msg, extractedList) ?? "").trim();
  const rowKey = String(msg?.__rowKey ?? buildRowKey(msg)).trim();
  const textFingerprint = buildTextFingerprint(msg?.text);
  if (hold.stableId && stableId === hold.stableId) return true;
  if (hold.rowKey && rowKey === hold.rowKey) return true;
  if (hold.textFingerprint && textFingerprint === hold.textFingerprint) return true;
  return false;
}

/**
 * @param {object} msg
 * @param {object | null | undefined} freshState
 * @param {Array<object>} extractedList
 */
function matchesBaselineDeferredTailUser(msg, freshState, extractedList) {
  const defer = freshState?.baselineDeferredTailUser;
  if (!defer || defer.consumed) return false;
  return matchesAnchorHoldUserForward(msg, defer, extractedList);
}

/**
 * At first chat open: defer the live-signaled tail verified user row for post-baseline forward.
 * @param {{ anchorRow: object | null, anchorIndex: number, chatKey: string, sortedWithPos: object[], liveGroupSignal?: boolean }} p
 * @returns {{ stableId: string, hold: object } | null}
 */
export function resolveBaselineTailUserDeferral(p) {
  const { anchorRow, anchorIndex, chatKey, sortedWithPos, liveGroupSignal = false } = p;
  if (!liveGroupSignal) return null;
  if (!anchorRow) return null;
  if (!Array.isArray(sortedWithPos) || anchorIndex !== sortedWithPos.length - 1) {
    return null;
  }
  if (anchorIndex <= 0) return null;
  const anchorAssistant = freshDeltaAssistantLikeDetail(anchorRow, chatKey);
  if (!isVerifiedFreshDeltaUserRow(anchorRow, chatKey)) return null;
  if (anchorAssistant.assistantLike) return null;
  if (isListenerInboundNoise(anchorRow?.text)) return null;
  const { stableId: holdStableId } = resolvePlaywrightForwardIdentity(
    chatKey,
    anchorRow,
    0,
    sortedWithPos
  );
  const stableId = String(holdStableId ?? "").trim();
  if (!stableId) return null;
  if (!stableId.startsWith("wa::")) return null;
  if (isInboundTurnLedgerEnabled()) {
    const ledgerBlock = resolveInboundTurnAdmissionBlock({
      chatKey,
      stableId,
      textPreview: String(anchorRow?.text ?? "").slice(0, 120),
    });
    if (ledgerBlock.blocked) return null;
  }
  const guaranteeKey = playwrightGuaranteeKeyForStableId(chatKey, stableId);
  const st = guaranteeKey ? getMessageState(guaranteeKey) : null;
  if (st?.state === "done" || st?.state === "processing") return null;
  return {
    stableId,
    hold: {
      stableId,
      rowKey: String(anchorRow?.__rowKey ?? buildRowKey(anchorRow)).trim(),
      textFingerprint: buildTextFingerprint(anchorRow?.text),
      anchorIndexAtBaseline: anchorIndex,
      consumed: false,
    },
  };
}

/**
 * Establishes per-chat startup baseline without permanently absorbing one live-signaled tail row.
 * Older visible rows remain baseline-absorbed.
 * @param {{ freshState: object, sortedWithPos: object[], userMessages: object[], chatKey: string, liveGroupSignal?: boolean }} p
 * @returns {{ baselineSeen: Set<string>, tailAnchor: object | null, acknowledgedAnchorIndex: number, deferredTail: object | null }}
 */
export function establishFreshDeltaStartupBaseline(p) {
  const {
    freshState,
    sortedWithPos,
    userMessages,
    chatKey,
    liveGroupSignal = false,
  } = p;
  const anchorIndex = sortedWithPos.length - 1;
  const tailAnchor = establishTailAnchor(sortedWithPos, chatKey, sortedWithPos);
  const deferral = resolveBaselineTailUserDeferral({
    anchorRow: sortedWithPos[anchorIndex] || null,
    anchorIndex,
    chatKey,
    sortedWithPos,
    liveGroupSignal,
  });
  const deferredStableId = deferral?.stableId || "";
  const effectiveAnchorIndex =
    deferral && anchorIndex > 0 ? anchorIndex - 1 : anchorIndex;
  const effectiveTailAnchor =
    deferral && anchorIndex > 0
      ? buildTailAnchorFromRow(
          sortedWithPos[effectiveAnchorIndex],
          effectiveAnchorIndex,
          chatKey,
          sortedWithPos
        )
      : tailAnchor;
  const baselineSeen = new Set();

  for (const msg of sortedWithPos) {
    const sender = String(msg?.sender ?? "").trim() || "unknown";
    const textPreview = String(msg?.text ?? "").slice(0, 80);
    const assistantDetail = freshDeltaAssistantLikeDetail(msg, chatKey);
    const { stableId } = resolvePlaywrightForwardIdentity(
      chatKey,
      msg,
      0,
      sortedWithPos
    );
    const isDeferredTail = stableId && stableId === deferredStableId;
    if (stableId && !isDeferredTail) {
      baselineSeen.add(stableId);
      if (isInboundTurnLedgerEnabled()) {
        markInboundTurnLedgerBaselineAbsorbed({
          chatKey,
          stableId,
          textPreview,
          sender,
        });
      }
    }
    console.log("[startup_baseline_row_absorbed]", {
      chatKey,
      stableId: stableId ?? null,
      rowKey: String(msg?.__rowKey ?? "").trim() || null,
      textPreview,
      sender,
      assistantLike: assistantDetail.assistantLike,
      reason: isDeferredTail
        ? "live_tail_deferred_from_baseline"
        : assistantDetail.reason || "startup_visible_row",
    });
  }

  freshState.baselineSeenStableIds = baselineSeen;
  freshState.baselineSnapshotHash = String(computeSnapshotHash(userMessages) ?? "");
  freshState.baselineEstablishedAtMs = Date.now();
  freshState.acknowledgedAnchorIndex = effectiveAnchorIndex;
  freshState.anchorHoldUserForward = null;
  freshState.baselineDeferredTailUser = deferral?.hold || null;
  freshState.baselineTailAnchor = effectiveTailAnchor;
  freshState.currentTailAnchor = effectiveTailAnchor;

  recordSessionVisibilityLedger(
    freshState,
    sortedWithPos,
    effectiveAnchorIndex,
    chatKey,
    sortedWithPos
  );

  return {
    baselineSeen,
    tailAnchor: effectiveTailAnchor,
    acknowledgedAnchorIndex: effectiveAnchorIndex,
    deferredTail: deferral?.hold || null,
  };
}

/**
 * @param {object} freshState
 * @param {Array<object>} userMessages
 * @param {number} anchorIndex
 * @param {string} chatKey
 * @param {Array<object>} extractedList
 */
function supersedeAnchorHoldIfNewerPostAnchorRow(
  freshState,
  userMessages,
  anchorIndex,
  chatKey,
  extractedList
) {
  const hold = freshState?.anchorHoldUserForward;
  if (!hold || hold.consumed) return;
  for (const msg of userMessages) {
    const idx = Number(msg?.__position);
    if (!Number.isFinite(idx) || idx <= anchorIndex) continue;
    if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) continue;
    const sid = getMessageIdFromExtracted(msg, extractedList);
    if (hold.stableId && sid === hold.stableId) continue;
    hold.consumed = true;
    hold.supersededByNewer = true;
    console.log("[fresh_delta_anchor_hold_superseded]", {
      holdStableId: hold.stableId ?? null,
      newerStableId: sid ?? null,
      newerTextPreview: String(msg?.text ?? "").slice(0, 80),
    });
    return;
  }
}

/**
 * @param {object} msg
 * @param {number} sortedIndex
 * @param {number} anchorIndex
 * @param {object} freshState
 * @param {Array<object>} extractedList
 */
function isAnchorHoldUserForwardEligible(msg, sortedIndex, anchorIndex, freshState, extractedList) {
  const hold = freshState?.anchorHoldUserForward;
  if (!hold || hold.consumed) return false;
  if (!Number.isFinite(sortedIndex) || sortedIndex !== anchorIndex) return false;
  return matchesAnchorHoldUserForward(msg, hold, extractedList);
}

/**
 * @param {object} msg
 * @param {object | null | undefined} freshState
 * @param {Array<object>} extractedList
 */
function matchesCurrentTailAnchorIdentity(msg, freshState, extractedList) {
  const anchor = freshState?.currentTailAnchor;
  if (!anchor || !msg) return false;
  const stableId = String(getMessageIdFromExtracted(msg, extractedList) ?? "").trim();
  const rowKey = String(msg?.__rowKey ?? buildRowKey(msg)).trim();
  const textFingerprint = buildTextFingerprint(msg?.text);
  if (anchor.stableId && stableId && stableId === anchor.stableId) return true;
  if (anchor.rowKey && rowKey && rowKey === anchor.rowKey) return true;
  if (anchor.textFingerprint && textFingerprint && textFingerprint === anchor.textFingerprint) {
    return true;
  }
  return false;
}

/**
 * Same-index tail fresh admission (Option A).
 * When PLAYWRIGHT_MEANINGFUL_USER_TAIL=true, admission tail uses meaningful verified user rows only.
 * @returns {"admit"|"rejected_seen"|"rejected_anchor_match"|"rejected_not_tail"|null}
 */
export function classifySameIndexTailAdmission(p) {
  const {
    msg,
    sortedIndex,
    admissionIndex,
    listTailIndex,
    admissionTailIndex: admissionTailIndexIn,
    meaningfulUserTailIndex = -1,
    rawTailRow = null,
    meaningfulTailRow = null,
    freshState,
    ledger,
    extractedList,
    chatKey,
    holdEligible = false,
  } = p;
  if (holdEligible) return null;
  if (!Number.isFinite(sortedIndex) || sortedIndex !== admissionIndex) return null;

  const rawListTailIndex = Number(listTailIndex);
  const featureEnabled = isPlaywrightMeaningfulUserTailEnabled();
  const effectiveAdmissionTail =
    admissionTailIndexIn != null && Number.isFinite(Number(admissionTailIndexIn))
      ? Number(admissionTailIndexIn)
      : getAdmissionTailIndex({
          rawListTailIndex,
          meaningfulUserTailIndex,
          featureEnabled,
        });

  const oldTailMatches =
    Number.isFinite(rawListTailIndex) && sortedIndex === rawListTailIndex;
  const newTailMatches =
    Number.isFinite(effectiveAdmissionTail) && sortedIndex === effectiveAdmissionTail;

  const evaluateGuards = () => {
    if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) return null;
    if (isListenerInboundNoise(msg?.text)) return null;
    if (matchesCurrentTailAnchorIdentity(msg, freshState, extractedList)) {
      return "rejected_anchor_match";
    }
    const { stableId, guaranteeKey } = resolvePlaywrightForwardIdentity(
      chatKey,
      msg,
      0,
      extractedList
    );
    if (!stableId) return null;
    const textFingerprint = buildTextFingerprint(msg?.text);
    if (!textFingerprint) return null;
    const st = getMessageState(guaranteeKey);
    if (st?.state === "done" || st?.state === "processing") return null;
    if (
      freshState?.baselineSeenStableIds instanceof Set &&
      freshState.baselineSeenStableIds.has(stableId)
    ) {
      return "rejected_seen";
    }
    if (isRowHistoricalInSessionLedger(msg, ledger, admissionIndex, sortedIndex)) {
      return "rejected_seen";
    }
    return "admit";
  };

  const oldTailDecision = oldTailMatches ? evaluateGuards() : "rejected_not_tail";
  const newTailDecision = newTailMatches ? evaluateGuards() : "rejected_not_tail";

  if (featureEnabled || oldTailDecision !== newTailDecision) {
    logFreshDeltaAdmissionTailCompare({
      chatKey,
      msg,
      sortedIndex,
      admissionIndex,
      rawListTailIndex,
      meaningfulUserTailIndex,
      rawTailRow,
      meaningfulTailRow,
      oldTailDecision,
      newTailDecision,
      featureEnabled,
      extractedList,
    });
  }

  if (!newTailMatches) {
    return "rejected_not_tail";
  }

  return evaluateGuards();
}

/**
 * Verified user admission filter (pre-bucket).
 * @param {object} m
 * @param {string} chatKey
 */
function isVerifiedFreshDeltaUserRow(m, chatKey) {
  if (!m || typeof m !== "object") return false;
  const sender = String(m.sender ?? "").trim() || "unknown";
  if (sender !== "user") return false;
  const text = String(m.text ?? "").trim();
  if (!text) return false;
  // Existing exact-template guards (single-line) + registry.
  if (isRegisteredPlaywrightOutboundEcho(chatKey, text)) return false;
  if (isLikelyAssistantOutboundCopy(text)) return false;
  // Substring guard catches burst-merged assistant blobs that bypass anchored regexes.
  if (looksLikeAssistantTemplateSubstring(text)) return false;
  return true;
}

function getFreshDeltaChatState(chatKey) {
  const key = String(chatKey ?? "").trim();
  if (!key) return null;
  const st = globalThis.__playwrightFreshDeltaState[key];
  if (st && typeof st === "object") return st;
  const next = {
    baselineSeenStableIds: new Set(),
    baselineSnapshotHash: "",
    baselineEstablishedAtMs: 0,
    admittedFreshStableIds: new Set(),
    baselineTailAnchor: null,
    currentTailAnchor: null,
    acknowledgedAnchorIndex: -1,
    sessionVisibilityLedger: [],
    anchorHoldUserForward: null,
    /** Tail user row deferred at startup baseline for post-baseline forward (guarantee-first). */
    baselineDeferredTailUser: null,
    /** Phase A: reuse __rowKey across polls (identity pin → rowKey, stableId → rowKey). */
    pinnedRowKeyByIdentityPin: new Map(),
    pinnedRowKeyByStableId: new Map(),
  };
  globalThis.__playwrightFreshDeltaState[key] = next;
  return next;
}

/**
 * Per chat: last processed tail identity `${text}__${windowLength}` (length = recentMessages.length).
 * Key is stable chat `data-id` when present, else normalized display name.
 */
const lastMessagePerGroup = new Map();

/** @param {string} k */
function parseTailKey(k) {
  const m = /^([\s\S]*)__(\d+)$/.exec(k);
  if (!m) return { text: k, len: -1 };
  return { text: m[1], len: Number(m[2]) };
}

/**
 * Listener-only stable row key for selecting new messages.
 * @param {{ text?: string, timestamp?: string | number, id?: unknown, _data?: { id?: { _serialized?: unknown, id?: unknown } } }} message
 */
function buildRowKey(message) {
  const realId = getExtractedWhatsAppDataId(message);
  if (realId) {
    return `real:${realId}`;
  }
  const ts = String(message?.timestamp ?? "").trim();
  const txt = String(message?.text ?? "");
  return `row:${ts}:${hash(txt)}`;
}

/**
 * WhatsApp `data-id` from an extracted row (DOM Phase A).
 * @param {{ id?: unknown, _data?: unknown, dataId?: unknown }} msg
 */
export function getExtractedWhatsAppDataId(msg) {
  const fromId =
    msg?.id?._serialized ||
    msg?._data?.id?._serialized ||
    msg?.id?.id ||
    msg?._data?.id?.id;
  if (fromId != null && String(fromId).trim() !== "") {
    return String(fromId).trim();
  }
  const direct = String(msg?.dataId ?? "").trim();
  return direct || "";
}

/**
 * Stable participant JID from inbound WhatsApp Web `data-id` (`false_*` only).
 * Examples: `false_923001112233@c.us_ABC` → `923001112233@c.us`, `false_123@lid` → `123@lid`.
 * Outbound `true_*` rows never produce an anchor.
 * @param {unknown} dataId
 * @returns {string}
 */
export function participantAnchorFromWhatsAppDataId(dataId) {
  const raw = String(dataId ?? "").trim();
  if (!raw || !raw.toLowerCase().startsWith("false_")) return "";
  const rest = raw.slice("false_".length);
  if (!rest) return "";
  const match = rest.match(/^([^\s@]+@[^\s_]+)(?:_.+)?$/i);
  if (!match) return "";
  const jid = String(match[1] ?? "").trim().toLowerCase();
  if (!jid || !/@(?:c\.us|lid)$/i.test(jid)) return "";
  return jid;
}

/**
 * DOM sender anchor when present; otherwise inbound participant JID from `data-id`.
 * @param {object} m
 * @returns {string}
 */
function resolveExtractedSenderAnchor(m) {
  const domAnchor = String(m?.senderAnchor ?? "").trim();
  if (domAnchor) return domAnchor;
  return participantAnchorFromWhatsAppDataId(getExtractedWhatsAppDataId(m));
}

/**
 * @param {object | null | undefined} freshState
 */
function ensureFreshDeltaIdentityPins(freshState) {
  if (!freshState || typeof freshState !== "object") return;
  if (!(freshState.pinnedRowKeyByIdentityPin instanceof Map)) {
    freshState.pinnedRowKeyByIdentityPin = new Map();
  }
  if (!(freshState.pinnedRowKeyByStableId instanceof Map)) {
    freshState.pinnedRowKeyByStableId = new Map();
  }
}

/**
 * Stable pin key for reusing {@link buildRowKey} suffixes across DOM polls.
 * Priority: data-id → prePlainText+text → row base.
 * @param {object} msg
 */
export function buildExtractionIdentityPinKey(msg) {
  const dataId = getExtractedWhatsAppDataId(msg);
  if (dataId) return `wa-pin::${dataId}`;

  const prePlainText = String(msg?.prePlainText ?? "").trim();
  const textNorm = String(msg?.text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (prePlainText && textNorm) {
    return `ppt-pin::${hash(prePlainText)}::${hash(textNorm)}`;
  }

  return `row-pin::${buildRowKey(msg)}`;
}

/**
 * Assign or reuse pinned `__rowKey` for a verified user row (Phase A — no admission change).
 * @param {object} msg
 * @param {object | null | undefined} freshState
 * @param {Map<string, number>} duplicateRowKeyCounts
 * @param {Array<object>} [extractedList]
 */
export function assignPinnedRowKeyForUserRow(
  msg,
  freshState,
  duplicateRowKeyCounts,
  extractedList = []
) {
  const dataId = getExtractedWhatsAppDataId(msg);
  if (dataId) {
    return `real:${dataId}#1`;
  }

  ensureFreshDeltaIdentityPins(freshState);
  const identityPin = buildExtractionIdentityPinKey(msg);
  const pins = freshState?.pinnedRowKeyByIdentityPin;
  const existing = pins instanceof Map ? pins.get(identityPin) : undefined;
  if (existing) {
    return String(existing);
  }

  const baseRowKey = buildRowKey(msg);
  const seen = duplicateRowKeyCounts.get(baseRowKey) ?? 0;
  const nextSeen = seen + 1;
  duplicateRowKeyCounts.set(baseRowKey, nextSeen);
  const rowKey = `${baseRowKey}#${nextSeen}`;

  if (pins instanceof Map) {
    pins.set(identityPin, rowKey);
    const stableId = buildStableMessageKey({ ...msg, __rowKey: rowKey }, extractedList).id;
    if (stableId && freshState.pinnedRowKeyByStableId instanceof Map) {
      freshState.pinnedRowKeyByStableId.set(String(stableId), rowKey);
    }
  }

  return rowKey;
}

/**
 * Guarantee + pipeline identity — uses {@link buildStableMessageKey} only (no DOM index).
 * @param {string} chatKey
 * @param {{ __position?: number, __rowKey?: string, text?: string, timestamp?: string | number, id?: unknown, _data?: unknown, participantKey?: string, sender?: string }} msg
 * @param {number} [_index]
 * @param {Array<unknown>} [extractedList]
 * @returns {{ messageId: string, guaranteeKey: string, source: 'REAL' | 'FALLBACK_ROW' | 'FALLBACK_LEGACY', stableId: string, strategy: string }}
 */
function resolvePlaywrightForwardIdentity(
  chatKey,
  msg,
  _index = 0,
  extractedList = []
) {
  const { id: stableId, strategy } = buildStableMessageKey(msg, extractedList);
  const guaranteeKey = playwrightGuaranteeKeyForStableId(chatKey, stableId);
  let source = "FALLBACK_LEGACY";
  if (strategy === "WHATSAPP_DATA_ID") source = "REAL";
  else if (strategy === "ROW_KEY") source = "FALLBACK_ROW";
    console.log("🔐 GuaranteeKey:", guaranteeKey);
    return {
    messageId: stableId,
      guaranteeKey,
    source,
    stableId,
    strategy,
  };
}

/** @internal Tests */
export function __resolvePlaywrightForwardIdentityForTests(
  chatKey,
  msg,
  index = 0,
  extractedList = []
) {
  return resolvePlaywrightForwardIdentity(chatKey, msg, index, extractedList);
}

const SESSION_FILE = path.resolve("playwright-session.json");
const KNOWN_BUSINESS_CHATS_FILE = path.resolve("knownChats.json");

/** Learned chat keys (`data-id` or normalized name), persisted in `knownChats.json`. */
/** @type {Set<string>} */
let knownBusinessChats = new Set();

function loadKnownBusinessChats() {
  try {
    const raw = fs.readFileSync(KNOWN_BUSINESS_CHATS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      knownBusinessChats = new Set(data.map(String).filter(Boolean));
    }
  } catch {
    // missing or invalid — start empty
  }
}

function saveKnownBusinessChats() {
  try {
    fs.writeFileSync(
      KNOWN_BUSINESS_CHATS_FILE,
      JSON.stringify([...knownBusinessChats], null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn(
      "[Playwright] Failed to save known business chats:",
      e?.message || e
    );
  }
}

loadKnownBusinessChats();
const DUPLICATE_WINDOW_MS = 30_000;
/** Drop old emitted keys to limit Map growth (session-long dedupe uses stable ids). */
const PRUNE_EMITTED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_MESSAGES = 5000;

const QR_WAIT_MS = Math.max(
  60_000,
  Math.min(
    30 * 60_000,
    Number.parseInt(String(process.env.PLAYWRIGHT_QR_TIMEOUT_MS ?? "600000"), 10) ||
      600_000
  )
);

/** Per-step timeout after sidebar click (header, #main, panel). Default 5000 per spec. */
const CHAT_OPEN_DOM_TIMEOUT_MS = Math.max(
  3000,
  Math.min(
    60_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_OPEN_TIMEOUT_MS ?? "5000"),
      10
    ) || 5000
  )
);

/** Background poll interval — slightly relaxed default so polls run after WA finishes painting. */
const POLL_INTERVAL_MS = Math.max(
  2000,
  Math.min(
    60_000,
    Number.parseInt(String(process.env.PLAYWRIGHT_POLL_INTERVAL_MS ?? "4000"), 10) ||
      4000
  )
);

/** Sidebar rotation interval (priority chat loop). Default 7000ms; override with PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS. */
const LOOP_INTERVAL = 7000;
const PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS = Math.max(
  2000,
  Math.min(
    60_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS ?? String(LOOP_INTERVAL)),
      10
    ) || LOOP_INTERVAL
  )
);

/** Fast sidebar interrupt scan; when new inbound appears, trigger immediate loop run. */
const PLAYWRIGHT_INTERRUPT_POLL_MS = Math.max(
  500,
  Math.min(
    5000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_INTERRUPT_POLL_MS ?? "1000"),
      10
    ) || 1000
  )
);

/** Max chats considered per priority loop (after filters). */
const MAX_PRIORITY_CHATS_PER_LOOP = Math.max(
  1,
  Math.min(
    20,
    Number.parseInt(String(process.env.PLAYWRIGHT_MAX_PRIORITY_CHATS ?? "6"), 10) ||
      6
  )
);

/**
 * WhatsApp panel may use conversation-panel-body, conversation-panel, or main only.
 * @param {import("playwright").Page} page
 */
async function waitForChatPanel(page) {
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector('[data-testid="conversation-panel-body"]') ||
        document.querySelector('[data-testid="conversation-panel"]') ||
        document.querySelector("#main") ||
        document.querySelector("main")
      ),
    { timeout: 10_000 }
  );
}

/** Legacy bubble classes + WA Web `msg-container` rows (scoped to conversation panel). */
const PLAYWRIGHT_LEGACY_MESSAGE_ROW_SELECTOR = "div.message-in, div.message-out";
const PLAYWRIGHT_MSG_CONTAINER_ROW_SELECTOR = '[data-testid="msg-container"]';

/**
 * Browser-side extraction helpers (inlined in page.evaluate / waitForFunction).
 * @returns {string}
 */
function playwrightMessageRowBrowserHelpersSource() {
  return `
    function playwrightConversationPanelRoot() {
      return (
        document.querySelector('[data-testid="conversation-panel-body"]') ||
        document.querySelector('[data-testid="conversation-panel"]') ||
        document.querySelector("#main")
      );
    }
    function playwrightIsComposerNode(node) {
      return Boolean(
        node &&
          node.closest &&
          node.closest(
            'footer, [data-testid="conversation-compose-box-input"], [data-testid="compose-btn-send"]'
          )
      );
    }
    function playwrightQueryMessageRows(root) {
      if (!root) return [];
      const legacy = Array.from(
        root.querySelectorAll("div.message-in, div.message-out")
      ).filter((n) => !playwrightIsComposerNode(n));
      if (legacy.length > 0) return legacy;
      return Array.from(root.querySelectorAll('[data-testid="msg-container"]')).filter(
        (n) => !playwrightIsComposerNode(n)
      );
    }
    function playwrightMessageTextFromNode(n) {
        let text = "";
        const textNode =
        n.querySelector("span.selectable-text span") ||
        n.querySelector("span.selectable-text");
        if (textNode) {
          text = textNode.textContent?.trim() ?? "";
        }
        if (!text || text === "????") {
        const copyable = n.querySelector("div.copyable-text");
          if (copyable) {
            const lines = copyable.innerText
            .split("\\n")
              .map((l) => l.trim())
              .filter(Boolean);
            text = lines[lines.length - 1] || "";
          }
        }
        if (!text || text === "????") {
        text = (n.getAttribute("aria-label") || "").trim();
      }
      return text && text.length >= 1 && text !== "????" ? text : null;
    }
    function playwrightMessageRowHasReadableText(n) {
      return Boolean(playwrightMessageTextFromNode(n));
    }
    function playwrightDataIdFromNode(n) {
      let el = n;
      for (let depth = 0; depth < 5 && el; depth++) {
        const id = String(el.getAttribute?.("data-id") || "").trim();
        if (id) return id;
        el = el.parentElement;
      }
      return "";
    }
    function playwrightSenderFromDataId(dataId) {
      const id = String(dataId || "").trim();
      if (id.startsWith("true_")) return "me";
      if (id.startsWith("false_")) return "user";
      return null;
    }
    function playwrightMessageRowSender(n) {
      const fromDataId = playwrightSenderFromDataId(playwrightDataIdFromNode(n));
      if (fromDataId === "me") return "me";
      if (fromDataId === "user") return "user";
      if (n.classList.contains("message-out")) return "me";
      if (n.classList.contains("message-in")) return "user";
      const cls = String(n.className || "");
      if (/\\bmessage-out\\b/.test(cls)) return "me";
      if (/\\bmessage-in\\b/.test(cls)) return "user";
      if (n.querySelector(".message-out, [class*='message-out']")) return "me";
      if (n.querySelector(".message-in, [class*='message-in']")) return "user";
      if (fromDataId) return fromDataId;
      const copyable = n.querySelector("div.copyable-text");
      const plain = String(copyable?.getAttribute("data-pre-plain-text") || "");
      const plainMatch = plain.match(/^\\[([^\\]]+)\\]\\s*([^:]+):\\s*/);
      if (plainMatch) {
        const who = String(plainMatch[2] || "").trim().toLowerCase();
        if (who === "you") return "me";
        if (who) return "user";
      }
      if (/^\\s*you\\s*:/i.test(plain)) return "me";
      return "unknown";
    }
  `;
}

/**
 * @param {import("playwright").Page} page
 */
async function logExtractSkipDiagnostics(page) {
  try {
    const diag = await page.evaluate(() => {
      const main = document.querySelector("#main");
      const header = main?.querySelector("header");
      const headerTitle =
        header
          ?.querySelector('[role="button"] span[dir="auto"]')
          ?.innerText?.split("\n")[0]
          ?.trim() ||
        header?.innerText?.split("\n")[0]?.trim() ||
        null;
      const panel =
        document.querySelector('[data-testid="conversation-panel-body"]') ||
        document.querySelector('[data-testid="conversation-panel"]') ||
        main;
      return {
        messageInCount: panel
          ? panel.querySelectorAll("div.message-in").length
          : 0,
        messageOutCount: panel
          ? panel.querySelectorAll("div.message-out").length
          : 0,
        msgContainerCount: panel
          ? panel.querySelectorAll('[data-testid="msg-container"]').length
          : 0,
        dataIdCount: panel ? panel.querySelectorAll("[data-id]").length : 0,
        copyableTextInMainCount: main
          ? main.querySelectorAll(".copyable-text").length
          : 0,
        headerTitle: headerTitle || null,
        searchModalOpen: Boolean(
          document.querySelector('[data-testid="chat-list-search"]')
        ),
        sidePanelOpen: Boolean(document.querySelector("#side")),
      };
    });
    console.log("[Extract SKIP] diagnostics", diag);
  } catch (err) {
    console.log(
      "[Extract SKIP] diagnostics_failed",
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Waits until any bubble has extractable text (same layers as getMessageText: selectable, copyable, aria-label).
 * @param {import("playwright").Page} page
 */
async function waitForMessageBubblesWithText(page) {
  const helpers = playwrightMessageRowBrowserHelpersSource();
  await page.waitForFunction(
    (helpersSource) => {
      // Inject shared row helpers (legacy classes + msg-container fallback).
      // eslint-disable-next-line no-eval
      eval(helpersSource);
      const root = playwrightConversationPanelRoot();
      const rows = playwrightQueryMessageRows(root);
      return rows.some((row) => playwrightMessageRowHasReadableText(row));
    },
    helpers,
    { timeout: 10_000 }
  );
}

/**
 * Click visible row and confirm chat switch via state signals (not header text equality).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 */
async function isRowActive(rowLocator) {
  try {
    return await rowLocator.evaluate((row) => {
      const selfAria = String(row.getAttribute("aria-selected") || "").toLowerCase();
      if (selfAria === "true") return true;

      const nestedAria = row.querySelector('[aria-selected="true"]');
      if (nestedAria) return true;

      const selfCurrent = String(row.getAttribute("aria-current") || "").toLowerCase();
      if (selfCurrent === "true" || selfCurrent === "page") return true;

      const cls = String(row.className || "").toLowerCase();
      if (/\b(selected|active)\b/.test(cls)) return true;

      const selectedMarker = row.querySelector(
        '[data-testid*="selected"], [data-icon*="check"], [aria-current]'
      );
      return Boolean(selectedMarker);
    });
  } catch {
    return false;
  }
}

async function forceReturnToChat(page) {
  const isInInfoMode = await page.evaluate(() => {
    const header = document.querySelector("#main header");
    if (!header) return false;
    const blob = (header.innerText || "").toLowerCase();
    if (blob.includes("profile details") || blob.includes("contact info")) {
      return true;
    }
    return [...header.querySelectorAll("[title]")].some((el) => {
      const t = (el.getAttribute("title") || "").toLowerCase();
      return t.includes("profile details") || t.includes("contact info");
    });
  });

  if (!isInInfoMode) return;

  console.warn("⚠️ INFO MODE detected — forcing chat view");

  for (let e = 0; e < 3; e++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  const backSel =
    'button[aria-label="Back"], [aria-label="Back"], [data-testid="back"]';
  const back = await page.$(backSel);
  if (back) {
    await back.click().catch(() => {});
    await page.waitForTimeout(450);
  }

  await page
    .evaluate(() => {
      const panel =
        document.querySelector(
          '[data-testid="conversation-panel-body"]'
        ) ||
        document.querySelector(
          '[data-testid="conversation-panel-messages"]'
        ) ||
        document.querySelector("#main div[tabindex='-1']");
      if (panel) panel.click();
    })
    .catch(() => {});

  await page.waitForTimeout(350);
  console.log("🔧 Forced return to chat view");
}

/**
 * Find a real conversation title in #main header that matches the target chat (not profile/info overlay).
 * @param {import("playwright").Page} page
 * @param {string} targetChatName
 * @returns {Promise<string | null>}
 */
async function readHeaderTitleMatchingChat(page, targetChatName) {
  return page.evaluate((target) => {
    const tNorm = String(target || "")
      .trim()
      .toLowerCase();
    if (!tNorm) return null;

    const isJunkTitle = (raw) => {
      const t = String(raw || "").trim();
      const l = t.toLowerCase();
      if (!t) return true;
      if (l.includes("profile details")) return true;
      if (l.includes("click here")) return true;
      if (l.includes("group info")) return true;
      if (l.includes("contact info")) return true;
      if (l === "online") return true;
      if (t.includes(",") && (t.includes("You") || /\+\d{3,}/.test(t)))
        return true;
      return false;
    };

    const header = document.querySelector("#main header");
    if (!header) return null;

    /** @type {Set<string>} */
    const candidates = new Set();
    header.querySelectorAll("[title]").forEach((el) => {
      const v = (el.getAttribute("title") || "").trim();
      if (v) candidates.add(v);
    });
    header.querySelectorAll('[role="button"], span[dir="auto"]').forEach((el) => {
      const line = (el.innerText || "")
        .trim()
        .split(/\n/)[0]
        .trim();
      if (line && line.length < 220) candidates.add(line);
    });

    for (const title of candidates) {
      if (isJunkTitle(title)) continue;
      const l = title.toLowerCase();
      if (l.includes(tNorm) || tNorm.includes(l)) return title;
    }
    return null;
  }, targetChatName);
}

/**
 * Confirm #main header matches the opened chat; retry row open if not (sidebar is source of truth).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<boolean>}
 */
async function ensureHeaderMatches(page, chatName) {
  const target = String(chatName ?? "").trim();
  if (!target) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const h = await readHeaderTitleMatchingChat(page, target);
    if (h) return true;
    if (attempt < 2) {
      console.warn("⚠️ Header mismatch — retry open", attempt + 1, target);
      await openChatAndConfirm(page, target);
      await page.waitForTimeout(400);
    }
  }
  console.error("🚫 Header did not match chat after retries:", target);
  return false;
}

/**
 * Top N visible sidebar chat titles (order = WhatsApp priority).
 * @param {import("playwright").Page} page
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
async function getTopChats(page, limit = MAX_PRIORITY_CHATS_PER_LOOP) {
  const lim = Math.max(1, Math.min(30, Number(limit) || MAX_PRIORITY_CHATS_PER_LOOP));
  return page.evaluate((max) => {
    const rows = Array.from(
      document.querySelectorAll('#pane-side div[role="row"]')
    );
    return rows
      .slice(0, max)
      .map((row) => {
        const title = row.querySelector('span[title]');
        return title?.getAttribute("title") || null;
      })
      .filter(Boolean);
  }, lim);
}

/**
 * Sidebar scan: unread / bold / preview or time change vs last snapshot. Highest score wins.
 * @param {import("playwright").Page} page
 * @param {string[] | null} targetGroups
 * @returns {Promise<string | null>}
 */
async function findChatWithNewMessage(page, targetGroups) {
  const snap = { ...lastMessageMap };
  const timeSnap = { ...lastSidebarTimeMap };

  const rowSignals = await page.evaluate((maxR) => {
    const rows = Array.from(
      document.querySelectorAll('#pane-side div[role="row"]')
    ).slice(0, maxR);
    return rows
      .map((row) => {
        const titleEl = row.querySelector('span[title]');
        const title = (titleEl?.getAttribute("title") || "").trim();
        if (!title) return null;

        let unreadPoints = 0;
        if (
          row.querySelector("[data-testid='unread-count'], [data-testid*='unread']")
        ) {
          unreadPoints = 5;
        } else if (
          row.querySelector(
            '[data-icon="unread"], [data-icon="status-unread"], span[aria-label*="unread" i]'
          )
        ) {
          unreadPoints = 4;
        } else if (/unread/i.test(row.getAttribute("aria-label") || "")) {
          unreadPoints = 3;
        }

        let boldPoints = 0;
        row.querySelectorAll("span[dir='auto']").forEach((el) => {
          try {
            const w = window.getComputedStyle(el).fontWeight;
            const n = parseInt(w, 10);
            if (n >= 600 || w === "bold" || w === "bolder") {
              boldPoints = Math.max(boldPoints, 2);
            }
          } catch {
            /* ignore */
          }
        });

        const spans = Array.from(row.querySelectorAll("span[dir='auto']"));
        const parts = [];
        for (const s of spans) {
          const t = (s.textContent || "").trim();
          if (t) parts.push(t);
        }
        const previewSnippet = parts.length ? parts[parts.length - 1] : "";
        let timeHint = "";
        for (const p of parts) {
          if (/\d{1,2}:\d{2}/.test(p) || /^(yesterday|today|now)$/i.test(p.trim())) {
            timeHint = p.trim();
            break;
          }
        }

        return {
          title,
          unreadPoints,
          boldPoints,
          previewSnippet,
          timeHint,
        };
      })
      .filter(Boolean);
  }, MAX_PRIORITY_CHATS_PER_LOOP);

  let bestTitle = null;
  let bestScore = 0;
  let bestIdx = 999;

  const dmWatch = globalThis.__activeDmWatchTargets || null;
  const activeDmChatKeys =
    dmWatch && dmWatch.keys instanceof Set ? dmWatch.keys : new Set();
  for (let i = 0; i < rowSignals.length; i++) {
    const r = rowSignals[i];
    if (!isValidBusinessChat(r.title)) continue;
    if (!__shouldProcessChatForTests({ chatTitle: r.title, targetGroups, activeDmChatKeys })) {
      if (TRACE_DEBUG) {
        console.log("[playwright_chat_skipped_not_target]", {
          chatTitle: r.title,
          normalizedTitle: normalizeTitle(r.title) || null,
          targetGroups,
          activeDmWatchCount: activeDmChatKeys.size,
        });
      }
      continue;
    }
    if (!isAllowedChat(r.title)) continue;

    const norm = normalizePreview(r.previewSnippet);
    const prev = String(snap[r.title] ?? "");
    let deltaPoints = 0;
    if (
      prev &&
      norm &&
      norm !== prev &&
      !sidebarPreviewLooksOutgoing(r.previewSnippet)
    ) {
      deltaPoints = 4;
    }

    const tPrev = String(timeSnap[r.title] ?? "");
    let timeDelta = 0;
    if (tPrev && r.timeHint && r.timeHint !== tPrev) {
      timeDelta = 2;
    }

    const score =
      r.unreadPoints + r.boldPoints + deltaPoints + timeDelta + (10 - i) * 0.01;

    if (score > bestScore || (score === bestScore && i < bestIdx)) {
      bestScore = score;
      bestTitle = r.title;
      bestIdx = i;
    }
  }

  for (const r of rowSignals) {
    if (!r?.title) continue;
    const norm = normalizePreview(r.previewSnippet);
    if (norm) {
      lastMessageMap[r.title] = norm;
    }
    if (r.timeHint) {
      lastSidebarTimeMap[r.title] = r.timeHint;
    } else if (timeSnap[r.title]) {
      lastSidebarTimeMap[r.title] = timeSnap[r.title];
    }
  }

  if (bestScore >= 1 && bestTitle) {
    return bestTitle;
  }
  return null;
}

async function openChatAndConfirm(page, chatName) {
  if (globalThis.__UI_SEND_LOCK) return false;

  const targetChatName = String(chatName ?? "").trim();
  if (!targetChatName) {
    console.error("🚫 CHAT OPEN FAILED: empty name");
    return false;
  }

  let opened = false;

  // ===== STEP 1: TRY SIDEBAR CLICK =====
  for (let i = 0; i < 3; i++) {
    console.log("🖱️ Attempting to open chat:", targetChatName, "try:", i + 1);

    await forceReturnToChat(page);

    await page.evaluate((name) => {
      const row = [...document.querySelectorAll('#pane-side div[role="row"]')]
        .find((r) => r.querySelector(`span[title="${name}"]`));

      if (row) row.scrollIntoView({ block: "center" });
    }, targetChatName);

    await page.waitForTimeout(200);

    const chatRow = page
      .locator('#pane-side div[role="row"]')
      .filter({
        has: page.locator(`span[title="${targetChatName}"]`),
      })
      .first();

    // 🔥 Wait until it is actually visible
    if (await chatRow.isVisible()) {
      await chatRow.scrollIntoViewIfNeeded();
      await chatRow.click({ timeout: 2000 });
    } else {
      console.warn("❌ Row not visible, skipping click");
    }

    await page.waitForTimeout(500);

    const headerTitle = await readHeaderTitleMatchingChat(page, targetChatName);

    if (headerTitle) {
      opened = true;
      console.log("✅ Chat REALLY opened:", headerTitle);
      break;
    }

    console.warn("❌ Sidebar click failed, retrying...");
  }

  // ===== STEP 2: SEARCH FALLBACK (CRITICAL) =====
  if (!opened) {
    console.warn("⚠️ Falling back to search");

    await forceReturnToChat(page);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k"
    );

    await page.waitForTimeout(300);

    await page.keyboard.type(targetChatName);
    await page.waitForTimeout(500);

    const searchRow = page
      .locator('#pane-side div[role="row"]')
      .filter({
        has: page.locator(`span[title="${targetChatName}"]`),
      })
      .first();

    if (await searchRow.isVisible().catch(() => false)) {
      await searchRow.scrollIntoViewIfNeeded();
      await searchRow.click({ timeout: 2000 });
    } else {
      const result = page.locator(`span[title="${targetChatName}"]`).first();
      if (await result.count()) {
        await result.click({ force: true });
      }
    }

    await page.waitForTimeout(500);

    const headerTitleSearch = await readHeaderTitleMatchingChat(
      page,
      targetChatName
    );

    if (headerTitleSearch) {
      opened = true;
      console.log("✅ Chat REALLY opened:", headerTitleSearch);
    }
  }

  // ===== STEP 3: FINAL FAIL =====
  if (!opened) {
    console.error("🚫 CHAT OPEN FAILED:", targetChatName);
    return false;
  }

  // ===== STEP 4: SET IDENTITY =====
  globalThis.__currentOpenChatTitle = targetChatName;
  globalThis.__currentOpenChatTitleTS = Date.now();

  return true;
}

/**
 * WhatsApp may start in idle/home state; force one chat open before looping.
 * NOTE: Header visibility here is only a bootstrapping signal, not chat identity confirmation.
 * @param {import("playwright").Page} page
 */
async function ensureInitialChatOpen(page) {
  if (globalThis.__UI_SEND_LOCK) return;
  try {
    console.log("🔧 Ensuring initial chat is open...");

    const firstChat = page.locator('#pane-side div[role="row"]').first();

    await firstChat.waitFor({ timeout: 5000 });
    await firstChat.scrollIntoViewIfNeeded();

    await page.bringToFront();
    await page.focus("body");

    await firstChat.click({ delay: 50 });

    let opened = await page
      .waitForSelector('#main header span[title]', { timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      console.log("⚠️ Initial click failed, retrying...");
      await firstChat.click({ delay: 50 });

      opened = await page
        .waitForSelector('#main header span[title]', { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!opened) {
      console.log("❌ Failed to activate initial chat after retry");
      return;
    }

    await forceReturnToChat(page);

    await captureOpenChatContext(page);
    console.log("✅ Initial chat activated");
  } catch (err) {
    console.log("❌ Failed to activate initial chat:", err?.message || err);
  }
}

/**
 * Read currently opened chat title from the main header (same as outbound send guard).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function getActiveChatName(page) {
  try {
    return await readOpenConversationHeaderTitle(page);
  } catch {
    return null;
  }
}

/**
 * Before forwarding, ensure the page is still focused on the expected chat. Reopen and revalidate once on mismatch.
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @param {string} chatKey
 * @returns {Promise<boolean>}
 */
async function ensureExpectedChatBeforeForward(page, chatName, chatKey) {
  let viewingKey = "";
  try {
    const vn = await getActiveChatName(page);
    viewingKey = normalizeTitle(String(vn ?? "").trim());
  } catch {
    viewingKey = "";
  }

  if (viewingKey === chatKey) {
    return true;
  }

  console.warn("🔄 Active chat mismatch — reopening target", {
    expected: chatKey,
    viewing: viewingKey || "(empty)",
  });
  const reopened = await openChatAndConfirm(page, String(chatName));
  if (!reopened) {
    console.error("⛔ Reopen failed — skip forward");
    return false;
  }
  setCurrentOpenChatTitleFromSidebar(chatName);
  const headerOkRoute = await ensureHeaderMatches(page, chatName);
  if (!headerOkRoute) {
    console.error("⛔ Header mismatch after reopen — skip forward");
    return false;
  }
  try {
    const verifiedTitle = await getActiveChatName(page);
    const verifiedKey = normalizeTitle(String(verifiedTitle ?? "").trim());
    if (verifiedKey !== chatKey) {
      console.error("⛔ Active chat mismatch after verify — skip forward", {
        expected: chatKey,
        verified: verifiedKey || "(empty)",
      });
      return false;
    }
  } catch {
    console.error("⛔ Active chat verify failed after reopen — skip forward");
    return false;
  }
  return true;
}

/**
 * Last `message-in` bubble text (no extractIncomingMessages — avoids internal dedupe).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function peekLastInboundMessageText(page) {
  try {
    return await page.evaluate(() => {
      function getMessageText(n) {
        let t = "";
        const textNode =
          n.querySelector("span.selectable-text span") ||
          n.querySelector("span.selectable-text");
        if (textNode) {
          t = textNode.textContent?.trim() ?? "";
        }
        if (!t || t === "????") {
          const copyable = n.querySelector("div.copyable-text");
          if (copyable) {
            const lines = copyable.innerText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            t = lines[lines.length - 1] || "";
          }
        }
        if (!t || t === "????") {
          t = (n.getAttribute("aria-label") || "").trim();
        }
        return t && t.length >= 1 && t !== "????" ? t : null;
      }
      const bubbles = Array.from(
        document.querySelectorAll("div.message-in")
      );
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const text = getMessageText(bubbles[i]);
        if (text) return text;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Top visible chat titles only (strict first 6 rows).
 * @param {import("playwright").Page} page
 * @returns {Promise<string[]>}
 */
async function getTop6Chats(page) {
  return getTopChats(page, 6);
}

/**
 * Best-effort last visible line in the sidebar row (for "no new activity" hints).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<string | null>}
 */
async function getSidebarRowPreviewText(page, chatName) {
  try {
    const row = page
      .locator(`#pane-side div[role="row"]`, {
        has: page.locator(`span[title="${chatName}"]`),
      })
      .first();
    if ((await row.count()) === 0) return null;
    return await row.evaluate((rowEl) => {
      const spans = rowEl.querySelectorAll("span[dir='auto']");
      const parts = [];
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (t) parts.push(t);
      }
      return parts.length ? parts[parts.length - 1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Chat-specific sidebar activity signal. Used when DOM tail looks unchanged but sidebar still shows fresh inbound activity.
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<{ hasSignal: boolean, unreadPoints: number, boldPoints: number, previewChanged: boolean, timeChanged: boolean }>}
 */
async function getSidebarActivitySignalForChat(page, chatName) {
  try {
    const signal = await page.evaluate((name) => {
      const rows = Array.from(
        document.querySelectorAll('#pane-side div[role="row"]')
      );
      const row = rows.find((r) => r.querySelector(`span[title="${name}"]`));
      if (!row) {
        return {
          found: false,
          unreadPoints: 0,
          boldPoints: 0,
          previewSnippet: "",
          timeHint: "",
        };
      }

      let unreadPoints = 0;
      if (row.querySelector("[data-testid='unread-count'], [data-testid*='unread']")) {
        unreadPoints = 5;
      } else if (
        row.querySelector(
          '[data-icon="unread"], [data-icon="status-unread"], span[aria-label*="unread" i]'
        )
      ) {
        unreadPoints = 4;
      } else if (/unread/i.test(row.getAttribute("aria-label") || "")) {
        unreadPoints = 3;
      }

      let boldPoints = 0;
      row.querySelectorAll("span[dir='auto']").forEach((el) => {
        try {
          const w = window.getComputedStyle(el).fontWeight;
          const n = parseInt(w, 10);
          if (n >= 600 || w === "bold" || w === "bolder") {
            boldPoints = Math.max(boldPoints, 2);
          }
        } catch {
          /* ignore */
        }
      });

      const spans = Array.from(row.querySelectorAll("span[dir='auto']"));
      const parts = [];
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (t) parts.push(t);
      }
      const previewSnippet = parts.length ? parts[parts.length - 1] : "";
      let timeHint = "";
      for (const p of parts) {
        if (/\d{1,2}:\d{2}/.test(p) || /^(yesterday|today|now)$/i.test(p.trim())) {
          timeHint = p.trim();
          break;
        }
      }

      return {
        found: true,
        unreadPoints,
        boldPoints,
        previewSnippet,
        timeHint,
      };
    }, chatName);

    if (!signal?.found) {
      return {
        hasSignal: false,
        unreadPoints: 0,
        boldPoints: 0,
        previewChanged: false,
        timeChanged: false,
      };
    }

    const previewNorm = normalizePreview(signal.previewSnippet);
    const prevPreview = String(lastMessageMap[chatName] ?? "");
    const prevTime = String(lastSidebarTimeMap[chatName] ?? "");
    const previewChanged =
      Boolean(previewNorm) &&
      Boolean(prevPreview) &&
      previewNorm !== prevPreview &&
      !sidebarPreviewLooksOutgoing(signal.previewSnippet);
    const timeChanged =
      Boolean(signal.timeHint) &&
      Boolean(prevTime) &&
      signal.timeHint !== prevTime;

    return {
      hasSignal:
        signal.unreadPoints > 0 ||
        signal.boldPoints > 0 ||
        previewChanged ||
        timeChanged,
      unreadPoints: signal.unreadPoints,
      boldPoints: signal.boldPoints,
      previewChanged,
      timeChanged,
    };
  } catch {
    return {
      hasSignal: false,
      unreadPoints: 0,
      boldPoints: 0,
      previewChanged: false,
      timeChanged: false,
    };
  }
}

/**
 * Wait for conversation panel readiness. Never throws.
 * @param {import("playwright").Page} page
 * @returns {Promise<{ hasMessages: boolean }>}
 */
async function waitUntilChatReadyFocused(page) {
  let hasMessages = false;
  const stepMs = CHAT_OPEN_DOM_TIMEOUT_MS;

  try {
    try {
      await page.waitForSelector("#main", {
        state: "visible",
        timeout: stepMs,
      });

      try {
        await waitForChatPanel(page);
      } catch {
        console.log("[Loop] Chat ready fallback");
      }

      try {
        await page.waitForFunction(
          () => {
            function getMessageText(node) {
              let text = "";

              const textNode =
                node.querySelector("span.selectable-text span") ||
                node.querySelector("span.selectable-text");

              if (textNode) {
                text = textNode.textContent?.trim() ?? "";
              }

              if (!text || text === "????") {
                const copyable = node.querySelector("div.copyable-text");

                if (copyable) {
                  const lines = copyable.innerText
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);

                  text = lines[lines.length - 1] || "";
                }
              }

              if (!text || text === "????") {
                text = (node.getAttribute("aria-label") || "").trim();
              }

              return Boolean(text && text.length >= 1 && text !== "????");
            }

            const bubbles = document.querySelectorAll(
              "div.message-in, div.message-out"
            );

            return Array.from(bubbles).some(getMessageText);
          },
          { timeout: 10_000 }
        );
        hasMessages = true;
      } catch {
        console.log("[Loop] No messages yet (empty or slow load)");
        hasMessages = false;
      }

      await page.evaluate(() => {
        const panel =
          document.querySelector(
            '[data-testid="conversation-panel-body"]'
          ) || document.querySelector('[data-testid="conversation-panel"]');
        if (panel) {
          panel.scrollTop = panel.scrollHeight;
        } else {
          const m =
            document.querySelector("#main") || document.querySelector("main");
          if (m) {
            m.scrollTop = m.scrollHeight;
          }
        }
      });
      await wait(300);

      try {
        const msgCount = await page.evaluate(() => {
          function getMessageText(node) {
            let text = "";
            const textNode =
              node.querySelector("span.selectable-text span") ||
              node.querySelector("span.selectable-text");
            if (textNode) {
              text = textNode.textContent?.trim() ?? "";
            }
            if (!text || text === "????") {
              const copyable = node.querySelector("div.copyable-text");
              if (copyable) {
                const lines = copyable.innerText
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);
                text = lines[lines.length - 1] || "";
              }
            }
            if (!text || text === "????") {
              text = (node.getAttribute("aria-label") || "").trim();
            }
            return text && text.length >= 1 && text !== "????" ? text : null;
          }
          const bubbles = document.querySelectorAll(
            "div.message-in, div.message-out"
          );
          let count = 0;
          for (const node of bubbles) {
            if (getMessageText(node)) count++;
          }
          return count;
        });
        console.log("[Loop] Messages found:", msgCount);
      } catch {
        console.log("[Loop] Messages found:", 0);
      }
    } catch {
      console.log("[Loop] Chat ready fallback");
    }

    try {
      await page.click("#main");
    } catch {
      /* best-effort focus */
    }

    await wait(500);
  } catch {
    /* swallow anything unexpected — never break caller */
  }

  if (DEBUG) {
    console.log(
      "[Loop] Chat ready & focused",
      hasMessages ? "(messages present)" : "(no messages)"
    );
  }

  return { hasMessages };
}

/**
 * Scroll conversation to bottom before poll (post-switch).
 * @param {import("playwright").Page} page
 */
async function scrollConversationPanelToBottomAndSettle(page) {
  try {
    await page.evaluate(() => {
      const panel =
        document.querySelector(
          '[data-testid="conversation-panel-body"]'
        ) || document.querySelector('[data-testid="conversation-panel"]');
      if (panel) {
        panel.scrollTop = panel.scrollHeight;
      } else {
        const root =
          document.querySelector("#main") || document.querySelector("main");
        if (root) {
          root.scrollTop = root.scrollHeight;
        }
      }
    });
  } catch {
    /* ignore */
  }
  await wait(300);
}

/**
 * @param {{ id?: string | null, text: string, timeHint?: string, groupName?: string, senderName?: string }} raw
 * @param {{ text: string, senderName: string, timestamp: string | null, groupName: string }} adapted
 */
function buildMessageId(raw, adapted) {
  const g =
    String(adapted.groupName ?? "").trim() || "unknown-group";
  const ts = adapted.timestamp ?? raw?.timeHint ?? "";
  if (raw?.id) return `${g}::${String(raw.id)}`;
  if (!raw?.id && DEBUG) {
    console.log("[Playwright] Using fallback message ID");
  }
  return `${g}::${adapted.senderName}-${adapted.text}-${ts}`;
}

/**
 * @param {Map<string, { t: number, emitted: boolean }>} seenMessages
 */
function pruneStaleSeen(seenMessages) {
  const now = Date.now();
  for (const [k, rec] of seenMessages) {
    if (rec.emitted && now - rec.t > PRUNE_EMITTED_AFTER_MS) {
      seenMessages.delete(k);
    }
  }
}

/**
 * @param {Map<string, { t: number, emitted: boolean }>} seenMessages
 */
function trimSeenMapIfNeeded(seenMessages) {
  if (seenMessages.size > MAX_SEEN_MESSAGES) {
    const firstKey = seenMessages.keys().next().value;
    seenMessages.delete(firstKey);
  }
}

/**
 * WhatsApp Web often yields multiple DOM nodes (`div.message-in` / `div.message-out`) for the same visible bubble
 * (layout, focus rings, previews). Collapse **consecutive** rows with the same sender + normalized text here so
 * tail dedupe and logs are not flooded — fix at extraction source, not downstream.
 * @param {{ text: string; sender: string }[]} arr
 * @returns {Array<Record<string, unknown> & { text: string; sender: string }>}
 */
function dedupeConsecutiveMirrorRows(arr) {
  const out = [];
  const norm = (t) => String(t ?? "").trim().replace(/\s+/g, " ");
  let prevKey = "";
  for (const m of arr) {
    if (!m || m.text == null) continue;
    const t = String(m.text).trim();
    if (!t) continue;
    const key = `${m.sender}::${norm(t)}`;
    if (out.length > 0 && key === prevKey) {
      continue;
    }
    out.push({ ...m, text: t, sender: m.sender });
    prevKey = key;
  }
  return out;
}

/**
 * @param {import("playwright").Page} page
 * @param {{ bypassTailDedupe?: boolean }} [opts] If `bypassTailDedupe`, return the full recent thread for the chat loop (internal tail dedupe often hides new user lines when bubble count/tail collides).
 */
async function extractIncomingMessages(page, opts = {}) {
  const bypassTailDedupe = Boolean(opts?.bypassTailDedupe);
  try {
    await waitForMessageBubblesWithText(page);
  } catch {
    console.log("[Extract SKIP] no extractable message rows found");
    await logExtractSkipDiagnostics(page);
    return [];
  }

  const groupName = String(globalThis.__currentOpenChatTitle ?? "").trim();

  if (!groupName) {
    console.log("[Extract SKIP] No sidebar identity");
    return [];
  }

  console.log("📥 Extraction running for:", groupName);

  await page.evaluate(() => {
    const panel =
      document.querySelector('[data-testid="conversation-panel-body"]') ||
      document.querySelector('[data-testid="conversation-panel"]');
    if (panel) {
      panel.scrollTop = panel.scrollHeight;
    } else {
      const root =
        document.querySelector("#main") || document.querySelector("main");
      if (root) {
        root.scrollTop = root.scrollHeight;
      }
    }
  });
  await wait(1500);

  /** @type {Array<Record<string, unknown> & { text: string; sender: string }>} */
  let rawList = [];
  const helpers = playwrightMessageRowBrowserHelpersSource();
  try {
    rawList = await page.evaluate((helpersSource) => {
      // eslint-disable-next-line no-eval
      eval(helpersSource);
      const root = playwrightConversationPanelRoot();
      const nodes = playwrightQueryMessageRows(root);
      return nodes
          .map((node) => {
          const text = playwrightMessageTextFromNode(node);
          if (!text) return null;
          const copyable = node.querySelector("div.copyable-text");
              const plain = copyable?.getAttribute("data-pre-plain-text") || "";
              const match = plain.match(/^\[([^\]]+)\]\s*([^:]+):\s*/);
              const displayName = match ? match[2].trim() : "";
              const senderAnchor =
            node.getAttribute("data-sender") ||
            node.getAttribute("data-author") ||
            node.getAttribute("data-participant-id") ||
                copyable?.getAttribute("data-sender") ||
                copyable?.getAttribute("data-author") ||
                copyable?.getAttribute("data-participant-id") ||
                "";
          const haystack = `${displayName} ${plain} ${node.innerText || ""}`;
              const phoneMatch = haystack.match(
                /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/
              );
              const phone = phoneMatch
                ? phoneMatch[0].replace(/[^\d+]/g, "").replace(/^\++/, "+")
                : "";
          const timestamp =
            Number(
              node.getAttribute("data-t") || node.getAttribute("data-timestamp") || 0
            ) || null;
          const dataId = playwrightDataIdFromNode(node);
              return {
            text,
            sender: playwrightMessageRowSender(node),
            participantName: displayName,
                participantPhone: phone,
                senderAnchor,
                prePlainText: plain,
              dataId: dataId || null,
              timestamp,
              sourceMessageIndex: nodes.indexOf(node),
            };
          })
        .filter(Boolean);
    }, helpers);
  } catch (err) {
    console.log("[Extract ERROR]", err);
    return [];
  }

  const cleaned = dedupeConsecutiveMirrorRows(rawList);
  const trackingKey = normalizeTitle(groupName);
  const messages = cleaned.slice(-20).filter((m) => {
    const text = String(m?.text ?? "").trim();
    if (text && isRegisteredPlaywrightOutboundEcho(trackingKey, text)) {
      console.log("[extract_row_outbound_registry_skipped]", {
        sender: String(m?.sender ?? "").trim() || "unknown",
        textPreview: text.slice(0, 120),
        reason: "registered_outbound_echo",
      });
      return false;
    }
    if (text && isLikelyAssistantOutboundCopy(text)) {
      console.log("[extract_row_assistant_copy_skipped]", {
        sender: String(m?.sender ?? "").trim() || "unknown",
        textPreview: text.slice(0, 120),
        reason: "assistant_copy_template",
      });
      return false;
    }
    const sender = String(m?.sender ?? "").trim() || "unknown";
    if (sender === "user") return true;
    console.log("[extract_row_sender_skipped]", {
      sender,
      textPreview: text.slice(0, 100),
      reason: "non_user_sender",
    });
    return false;
  });
  if (cleaned.length !== rawList.length) {
    console.log(
      "[Extract] deduped consecutive mirror rows:",
      rawList.length,
      "→",
      cleaned.length
    );
  }
  console.log("[Extract CLEAN] Messages:", messages.length);
  console.log("📩 Extracted:", messages);

  const recentMessages = messages
    .slice(-20)
    .filter((m) => String(m.text).trim().length >= 1);

  if (recentMessages.length === 0) {
    return [];
  }

  if (TRACE_DEBUG) {
    console.log("Tracking chat key:", trackingKey);
  }

  const latest = recentMessages[recentMessages.length - 1].text;
  const latestKey = `${latest}__${recentMessages.length}`;

  const prevTailKey = lastMessagePerGroup.get(trackingKey);

  /** @type {{ text: string; sender: string }[]} */
  let newMessages;
  if (bypassTailDedupe) {
    newMessages = [...recentMessages];
  } else if (prevTailKey !== undefined && latestKey === prevTailKey) {
    return [];
  } else if (prevTailKey === undefined) {
    newMessages = [...recentMessages];
  } else {
    const prev = parseTailKey(prevTailKey);
    const texts = recentMessages.map((r) => r.text);
    if (recentMessages.length > prev.len) {
      newMessages = recentMessages.slice(prev.len);
    } else {
      const idx = texts.lastIndexOf(prev.text);
      if (idx === -1) {
        newMessages = [...recentMessages];
      } else {
        newMessages = recentMessages.slice(idx + 1);
      }
    }
  }

  if (newMessages.length === 0) {
    lastMessagePerGroup.set(trackingKey, latestKey);
    return [];
  }

  const latestMessage = newMessages[newMessages.length - 1]?.text;
  if (!String(latestMessage ?? "").trim()) {
    lastMessagePerGroup.set(trackingKey, latestKey);
    return [];
  }

  if (isBusinessMessage(latestMessage) && !knownBusinessChats.has(trackingKey)) {
    console.log("✅ New business chat detected:", trackingKey);
    knownBusinessChats.add(trackingKey);
    saveKnownBusinessChats();
  }

  lastMessagePerGroup.set(trackingKey, latestKey);

  if (process.env.PLAYWRIGHT_DEBUG === "1") {
    console.log("[Debug] Group:", groupName);
  }

  for (const m of newMessages) {
    const normalizedGroupChatKey = normalizeTitle(groupName) || groupName;
    const senderAnchor = resolveExtractedSenderAnchor(m);
    const senderScope =
      groupSenderScopeFromAnchor(normalizedGroupChatKey, senderAnchor) || "";
    const identity = resolveParticipantIdentity({
      participantPhone: m.participantPhone,
      participantName: m.participantName,
      senderAnchor,
      groupChatKey: normalizedGroupChatKey,
      senderScope,
    });
    m.participantKey = identity.participantKey || null;
    console.log("[Playwright] ✅ New message:", m.text, `(${m.sender})`);
    if (m.sender === "user" && identity.participantKey) {
      console.log("[playwright_message_sender_metadata_extracted]", {
        groupName,
        participantName: identity.participantName || m.participantName || null,
        hasParticipantPhone: Boolean(identity.participantPhone),
        participantKey: identity.participantKey,
        senderScope: senderScope || null,
        sourceMessageIndex:
          m.sourceMessageIndex != null && Number.isFinite(Number(m.sourceMessageIndex))
            ? Number(m.sourceMessageIndex)
            : null,
      });
    } else if (m.sender === "user") {
      console.warn("[playwright_message_sender_metadata_missing]", {
        groupName,
        textPreview: String(m.text ?? "").slice(0, 80),
      });
    }
  }

  return newMessages.map((m) => {
    const dataId = getExtractedWhatsAppDataId(m);
    const senderAnchor = resolveExtractedSenderAnchor(m);
    const prePlainText =
      m.prePlainText != null && String(m.prePlainText).trim() !== ""
        ? String(m.prePlainText).trim()
        : null;
    return {
      text: m.text,
      raw: m.text,
      sender: m.sender,
      participantName:
        m.participantName != null && String(m.participantName).trim() !== ""
          ? String(m.participantName).trim()
          : null,
      participantPhone:
        m.participantPhone != null && String(m.participantPhone).trim() !== ""
          ? String(m.participantPhone).trim()
          : null,
      participantKey:
        m.participantKey != null && String(m.participantKey).trim() !== ""
          ? String(m.participantKey).trim()
          : null,
      senderAnchor: senderAnchor || null,
      prePlainText,
      dataId: dataId || null,
      ...(dataId ? { id: { _serialized: dataId } } : {}),
      timestamp: m.timestamp ?? null,
      sourceMessageIndex:
        m.sourceMessageIndex != null && Number.isFinite(Number(m.sourceMessageIndex))
          ? Number(m.sourceMessageIndex)
          : null,
      groupName,
    };
  });
}

function resolveTargetGroups() {
  const singleGroup = String(process.env.PLAYWRIGHT_GROUP_NAME ?? "").trim();
  const multiGroupsEnv = String(process.env.PLAYWRIGHT_GROUPS ?? "").trim();

  /** @type {string[] | null} */
  let targetGroups = null;

  if (multiGroupsEnv) {
    targetGroups = multiGroupsEnv.split(",").map((g) => g.trim()).filter(Boolean);
    if (targetGroups.length === 0) {
      targetGroups = null;
    } else if (DEBUG) {
      console.log("[Playwright] Multi-group mode:", targetGroups);
    }
  } else if (singleGroup) {
    targetGroups = [singleGroup];
    if (DEBUG) {
      console.log("[Playwright] Single-group mode:", targetGroups);
    }
  } else {
    if (DEBUG) {
      console.log("[Playwright] No group specified — listening to ALL groups");
      console.log("[Playwright] Listening to ALL groups");
    }
    targetGroups = null;
  }

  return targetGroups;
}

/**
 * Drop numeric-only / system titles from priority scanning (not hardcoded business names).
 * @param {string | null | undefined} name
 */
function isValidBusinessChat(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (/^\+?\d[\d\s\-()]+$/.test(s.replace(/\s+/g, " ").trim())) return false;
  if (lower.includes("whatsapp")) return false;
  return true;
}

/**
 * Sidebar row matches configured allowlist (fuzzy: list title vs env name).
 * @param {string} name
 * @param {string[] | null} targetGroups
 */
function chatRowMatchesTargets(name, targetGroups) {
  if (targetGroups === null) return true;
  const n = String(name).trim().toLowerCase();
  return targetGroups.some((t) => {
    const g = String(t).trim().toLowerCase();
    return n.includes(g) || g.includes(n);
  });
}

function isPlaywrightChatLoopEnabled() {
  const v = String(process.env.PLAYWRIGHT_CHAT_LOOP ?? "true").toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Detect new inbound activity from sidebar preview deltas.
 * @param {import("playwright").Page} page
 * @param {string[]} topChats
 * @param {string[] | null} targetGroups
 */
async function pickInterruptChatFromSidebar(page, topChats, targetGroups) {
  const dmWatch = globalThis.__activeDmWatchTargets || null;
  const activeDmChatKeys =
    dmWatch && dmWatch.keys instanceof Set ? dmWatch.keys : new Set();
  for (const chatName of topChats) {
    if (!isValidBusinessChat(chatName)) continue;
    if (!__shouldProcessChatForTests({ chatTitle: chatName, targetGroups, activeDmChatKeys })) {
      if (TRACE_DEBUG) {
        console.log("[playwright_chat_skipped_not_target]", {
          chatTitle: chatName,
          normalizedTitle: normalizeTitle(chatName) || null,
          targetGroups,
          activeDmWatchCount: activeDmChatKeys.size,
        });
      }
      continue;
    }

    const rawPreview = await getSidebarRowPreviewText(page, chatName);
    const normalized = normalizePreview(rawPreview);
    if (!normalized) continue;

    const prev = String(lastMessageMap[chatName] ?? "");
    lastMessageMap[chatName] = normalized;

    // Bootstrap: first snapshot only seeds cache.
    if (!prev) continue;
    if (normalized === prev) continue;
    if (sidebarPreviewLooksOutgoing(rawPreview)) continue;

    return chatName;
  }
  return null;
}

/**
 * Drop Playwright DOM-extraction dedupe state and pending inbound merges so old bubbles are not skipped.
 * Call via `kill -USR2 <node-pid>` when Playwright is enabled, or POST `/internal/clear-extraction-state`.
 */
export function clearPlaywrightExtractedMessageState() {
  globalThis.__chatState = Object.create(null);
  globalThis.__lastProcessedUserMsg = Object.create(null);
  globalThis.__suppressedMessageIds = Object.create(null);
  globalThis.__lastProcessedRowKeyByChat = Object.create(null);
  globalThis.__playwrightChatLastProcessedAt = Object.create(null);
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  if (globalThis.__pendingChats instanceof Set) {
    globalThis.__pendingChats.clear();
  }
  if (globalThis.__visitedChatsThisCycle instanceof Set) {
    globalThis.__visitedChatsThisCycle.clear();
  }
  lastMessagePerGroup.clear();
  globalThis.__playwrightFreshDeltaState = Object.create(null);
  try {
    clearWhatsAppInboundMessageCaches();
  } catch (e) {
    console.warn(
      "[Playwright] clearWhatsAppInboundMessageCaches:",
      e?.message || e
    );
  }
  console.log(
    "[Playwright] Cleared extraction dedupe state + inbound debounce buffers (old messages can be re-read once)"
  );
}

async function runListenerBody() {
  const targetGroups = resolveTargetGroups();

  hydrateInboundTurnLedgerIntoMessageState();

  globalThis.__chatState = Object.create(null);
  globalThis.__lastProcessedUserMsg = Object.create(null);
  globalThis.__suppressedMessageIds = Object.create(null);
  globalThis.__chatResponding = Object.create(null);
  globalThis.__chatRespondingCooldownUntil = Object.create(null);
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  console.log("[Playwright] Listener state reset");

  if (!globalThis.__playwrightSigusr2Registered) {
    globalThis.__playwrightSigusr2Registered = true;
    try {
      process.on("SIGUSR2", () => {
        console.log("[Playwright] SIGUSR2 — clearing extraction / inbound caches");
        clearPlaywrightExtractedMessageState();
      });
    } catch (e) {
      console.warn("[Playwright] SIGUSR2 handler not registered:", e?.message || e);
    }
  }

  console.log("[Playwright] Starting listener...");
  const allowedTitles = resolvePlaywrightAllowedChatTitles();
  if (!allowedTitles || allowedTitles.length === 0) {
    console.log(
      "[Playwright] Chat title allowlist: off (any open chat may be processed; set PLAYWRIGHT_ALLOWED_CHAT_TITLES or defaults/playwrightAllowedChats.txt to restrict)"
    );
  } else {
    console.log("[Playwright] Chat title allowlist:", allowedTitles.join(", "));
  }
  browser = await chromium.launch({ headless: false });

  const contextOpts = {
    viewport: { width: 1280, height: 800 },
  };

  let context;
  try {
    context = fs.existsSync(SESSION_FILE)
      ? await browser.newContext({
          ...contextOpts,
          storageState: SESSION_FILE,
        })
      : await browser.newContext(contextOpts);
    if (fs.existsSync(SESSION_FILE)) {
      console.log("[Playwright] Session restored");
    }
  } catch (e) {
    console.warn(
      "[Playwright] Session file invalid or unreadable; starting fresh:",
      e?.message || e
    );
    context = await browser.newContext(contextOpts);
  }
  const page = await context.newPage();
  registerPlaywrightOutboundPage(page);

  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  console.log("[Playwright] Waiting for QR scan...");
  await page.waitForSelector("#pane-side", { timeout: QR_WAIT_MS });
  console.log("[Playwright] Connected");
  console.log("[Loop] Starting chat loop...");

  try {
    await context.storageState({ path: SESSION_FILE });
    console.log("[Playwright] Session saved");
  } catch (e) {
    console.warn("[Playwright] Session save failed:", e?.message || e);
  }

  console.log(
    "[Playwright] Open the group chat you want in WhatsApp Web (or switch chats anytime); polling uses the visible conversation header."
  );

  await page.waitForSelector("#app", { timeout: 60_000 });

  const hasChat = await page.$('div[data-testid="conversation-panel-body"]');
  if (!hasChat) {
    if (DEBUG) {
      console.log(
        "[Playwright] No chat open yet — waiting for user to open a chat..."
      );
    }
  }

  await new Promise((res) => setTimeout(res, 2000));
  if (DEBUG) {
    console.log("[Playwright] App ready — polling");
  }

  const runChatLoop = async () => {
    let restartAfterInterrupt = false;
    globalThis.__visitedChatsThisCycle = new Set();
    if (isReplyPrivateLockActive()) {
      console.log("⛔ Skip switching — reply private flow active");
      return;
    }
    if (globalThis.__WA_MEDIA_SEND__) {
      console.log(
        "⏸ Skip switching — WA media send in progress (action: switch_chat deferred)"
      );
      return;
    }
    const isBusy =
      globalThis.__UI_SEND_LOCK ||
      globalThis.__OUTBOUND_BUSY__ ||
      globalThis.__loopRunning;
    // Allow media send flow even when system is busy (batch sets __WA_MEDIA_SEND__).
    if (isBusy && !globalThis.__WA_MEDIA_SEND__) {
      console.log("⛔ Skip switching — system busy", {
        uiSendLock: globalThis.__UI_SEND_LOCK === true,
        outboundBusy: globalThis.__OUTBOUND_BUSY__ === true,
        loopRunning: globalThis.__loopRunning === true,
      });
      return;
    }
    if (globalThis.__UI_SEND_LOCK) {
      console.log("⛔ UI SEND LOCK ACTIVE — blocking chat switch");
      return;
    }
    if (globalThis.__UI_HARD_LOCK) {
      console.log("🔒 UI HARD LOCK — skipping rotation");
      return;
    }
    if (globalThis.__ACTIVE_PIPELINE__) {
      console.log("⏳ Active pipeline — skipping rotation");
      return;
    }
    if (globalThis.__OUTBOUND_BUSY__) {
      console.log("⛔ Outbound in progress — blocking chat switch");
      return;
    }
    if (
      globalThis.__activeJob &&
      typeof globalThis.__activeJobStart === "number" &&
      globalThis.__activeJobStart > 0 &&
      Date.now() - globalThis.__activeJobStart > MAX_ACTIVE_JOB_MS
    ) {
      if (globalThis.__WA_MEDIA_SEND__) {
        console.warn(
          "⚠️ Defer stuck-job force reset — WA media send (action: force_reset skipped)"
        );
      } else {
        console.warn("⚠️ Force releasing stuck job (safe reset)");
        globalThis.__activeJob = null;
        globalThis.__activeJobStart = 0;
        globalThis.__forceProcessing = true;
      }
    }
    if (globalThis.__activeJob) {
      console.log("⏳ Processing in progress — skip switching");
      return;
    }
    const lockedChatKey = activeChatLockKey();
    if (lockedChatKey) {
      // Stale-lock failsafe: if something went wrong mid-pipeline, release and recover.
      if (maybeReleaseStaleChatLock()) {
        return;
      }
      // Hard chat isolation: do not switch/open chats while a pipeline+send is in progress.
      console.log("[chat_switch_blocked_due_to_lock]", {
        activeChat: lockedChatKey,
        attempted: null,
      });
      return;
    }
    console.log("[Loop] Running chat loop");
    if (chatLoopRunning) return;
    chatLoopRunning = true;
    globalThis.__loopRunning = true;
    try {
      try {
        if (typeof page?.isClosed === "function" && page.isClosed()) {
          void requestPlaywrightRelaunch("Page closed before chat loop");
          return;
        }
        clearOldStates(10_000);
        usedFallbackRotationForThisLoop = false;
        if (globalThis.__INTERRUPT_PENDING__ && !restartAfterInterrupt) {
          console.log("⚡ INTERRUPT EXECUTION — breaking current flow");
          restartAfterInterrupt = true;
          return;
        }
        const sidebarReady =
          (await page.$('[data-testid="chat-list"]')) ||
          (await page.$("#pane-side"));
        if (!sidebarReady) {
          console.log("[Loop] Sidebar not ready (no chat-list / pane-side)");
          return;
        }

        // DM continuation watch targets (additive only). Refresh periodically.
        const lastLoaded = Number(globalThis.__dmWatchLoadedAtMs ?? 0);
        if (!isPlaywrightDmContinuationEnabled()) {
          globalThis.__activeDmWatchTargets = { keys: new Set(), byKey: new Map() };
          globalThis.__watchedDmAllowlist = new Set();
          globalThis.__dmWatchLoadedAtMs = Date.now();
          if (!globalThis.__playwrightDmContinuationDisabledLogged) {
            console.log("[playwright_dm_continuation_disabled]");
            globalThis.__playwrightDmContinuationDisabledLogged = true;
          }
        } else if (!Number.isFinite(lastLoaded) || Date.now() - lastLoaded > 7_500) {
          const loaded = await loadActiveDmWatchTargets().catch(() => null);
          const keys =
            loaded && loaded.keys instanceof Set ? loaded.keys : new Set();
          const byKey =
            loaded && loaded.byKey instanceof Map ? loaded.byKey : new Map();
          globalThis.__activeDmWatchTargets = { keys, byKey };
          globalThis.__dmWatchLoadedAtMs = Date.now();
          console.log("[playwright_dm_watch_targets_loaded]", {
            count: keys.size,
          });
          for (const chatKey of keys) {
            const first = byKey.get(chatKey)?.[0] || null;
            console.log("[playwright_dm_watch_target_detected]", {
              chatTitle: clean(first?.dmChatTitle) || null,
              chatKey,
            });
          }
          globalThis.__watchedDmAllowlist = buildWatchedDmAllowlist({
            dmWatchTargets: { keys, byKey },
            targetGroups,
          });
        }

        const conversationOpen = await ensureWhatsAppConversationOpen(page);
        if (!conversationOpen) {
          console.warn(
            "[Loop] WhatsApp main pane not open after recovery — skip tick"
          );
          return;
        }

        let activeNowForStickiness = null;
        try {
          activeNowForStickiness = await getActiveChatName(page);
        } catch {
          activeNowForStickiness = null;
        }
        if (
          globalThis.__activeChatFocusUntil != null &&
          Date.now() >= globalThis.__activeChatFocusUntil
        ) {
          globalThis.__activeChatInFocus = null;
          globalThis.__activeChatFocusUntil = null;
        }

        const lockedTitle = String(globalThis.__lockedChatTitle ?? "").trim();
        const lockedChatName = lockedTitle || null;

        let chatName = null;
        let skipRotation = false;
        let selectedChatReason = null;
        let dmProbeRestoreTarget = null;
        let selectedGroupLiveSignal = false;

        if (globalThis.__forceNextChat) {
          const forcedChatId = String(globalThis.__forceNextChat).trim();
          const topChatsForForce = await getTopChats(page, 30);
          const forcedChatName = topChatsForForce.find(
            (name) => normalizeTitle(name) === forcedChatId
          );
          if (forcedChatName) {
            chatName = forcedChatName;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            globalThis.__forceNextChat = null;
            skipRotation = true;
            console.log("🔁 Processing forced queued chat:", chatName);
          } else {
            console.log(
              "⏳ Forced chat not visible in sidebar yet — keeping priority:",
              forcedChatId
            );
          }
        }

        if (!chatName && globalThis.__pendingChats instanceof Set) {
          const pendingIds = Array.from(globalThis.__pendingChats);
          if (pendingIds.length > 0) {
            const topChatsForPending = await getTopChats(page, 30);
            for (const pendingId of pendingIds) {
              const pendingName = topChatsForPending.find(
                (name) => normalizeTitle(name) === pendingId
              );
              if (!pendingName) {
                continue;
              }
              chatName = pendingName;
              globalThis.__pendingChats.delete(pendingId);
              globalThis.__activeChatTitle = chatName;
              globalThis.__activeChatInFocus = chatName;
              skipRotation = true;
              console.log("🔁 Processing queued pending chat:", chatName);
              break;
            }
          }
        }

        // DM watch priority: before group-rotation/stickiness, open watched DM chats
        // when they have unread/preview-delta signals. Additive only; does not scan arbitrary DMs.
        if (!chatName && !lockedChatName && isPlaywrightDmContinuationEnabled()) {
          const dmWatch = globalThis.__activeDmWatchTargets || null;
          const activeDmChatKeys =
            dmWatch && dmWatch.keys instanceof Set ? dmWatch.keys : new Set();
          if (activeDmChatKeys.size > 0) {
            const dmCandidate = await findWatchedDmPriorityCandidate(
              page,
              activeDmChatKeys,
              activeNowForStickiness,
              targetGroups
            );
            if (dmCandidate?.chatTitle) {
              console.log("[dm_probe_open_attempt]", {
                chatTitle: dmCandidate.chatTitle,
                chatKey: dmCandidate.chatKey,
                selectReason: dmCandidate.selectReason || null,
              });
              console.log("[playwright_dm_watch_priority_opening]", {
                chatTitle: dmCandidate.chatTitle,
                chatKey: dmCandidate.chatKey,
              });
              const opened = await openChatAndConfirm(page, dmCandidate.chatTitle).catch(
                (err) => {
                  console.warn("[dm_probe_open_failed]", {
                    chatTitle: dmCandidate.chatTitle,
                    chatKey: dmCandidate.chatKey,
                    reason: clean(err?.message ?? err) || "OPEN_FAILED",
                  });
                  console.warn("[playwright_dm_watch_priority_open_failed]", {
                    chatTitle: dmCandidate.chatTitle,
                    chatKey: dmCandidate.chatKey,
                    reason: clean(err?.message ?? err) || "OPEN_FAILED",
                  });
                  return false;
                }
              );
              if (opened) {
                console.log("[dm_probe_open_success]", {
                  chatTitle: dmCandidate.chatTitle,
                  chatKey: dmCandidate.chatKey,
                  selectReason: dmCandidate.selectReason || null,
                });
                chatName = dmCandidate.chatTitle;
                selectedChatReason = dmCandidate.selectReason || null;
                dmProbeRestoreTarget = resolveBoundedDmProbeRestoreTarget({
                  selectReason: selectedChatReason,
                  previousActiveTitle: activeNowForStickiness,
                  targetGroups,
                });
                if (dmProbeRestoreTarget) {
                  console.log("[dm_probe_restore_planned]", {
                    targetGroupTitle: dmProbeRestoreTarget,
                    fromDmTitle: chatName,
                    selectReason: selectedChatReason,
                  });
                }
                globalThis.__activeChatTitle = chatName;
                globalThis.__activeChatInFocus = chatName;
                skipRotation = true;
              } else {
                console.warn("[dm_probe_open_failed]", {
                  chatTitle: dmCandidate.chatTitle,
                  chatKey: dmCandidate.chatKey,
                  reason: "OPEN_RETURNED_FALSE",
                });
              }
            }
          }
        }

        if (!chatName && lockedChatName) {
          chatName = lockedChatName;
          globalThis.__activeChatTitle = chatName;
          globalThis.__activeChatInFocus = chatName;
          console.log("🔒 Chat locked — forcing same chat:", chatName);
          skipRotation = true;
        } else {
          const hot = await findChatWithNewMessage(page, targetGroups);
          if (hot) {
            chatName = hot;
            skipRotation = true;
            selectedGroupLiveSignal = true;
            rotationIdleCount = 0;
            const cur = String(activeNowForStickiness ?? "").trim();
            if (cur && normalize(hot) !== normalize(cur)) {
              console.log("🚀 Switching to sidebar-active chat:", hot);
            } else {
              console.log("🚀 Sidebar priority (unread / activity):", hot);
            }
          }
        }

        /**
         * Fallback: interrupt (preview delta) → focus window → rotation. Sidebar scan above is primary.
         */

        if (!chatName && !lockedChatName) {
          const topChats = await getTop6Chats(page);
          if (!topChats.length) {
            console.log("⛔ SKIP: No top chats found");
            return;
          }
          console.log("🎯 TOP 6 CHATS:", topChats);

          const isActiveChatValid =
            Boolean(globalThis.__activeChatInFocus) &&
            globalThis.__activeChatFocusUntil != null &&
            Date.now() < globalThis.__activeChatFocusUntil;

          const interruptChat = await pickInterruptChatFromSidebar(
            page,
            topChats,
            targetGroups
          );

          const activeChatTitle = String(globalThis.__activeChatTitle ?? "").trim();
          const interruptIsSameActiveChat =
            Boolean(interruptChat) &&
            Boolean(activeChatTitle) &&
            String(interruptChat).trim() === activeChatTitle;

          const allowedForRotation = topChats.filter(
            (name) =>
              isValidBusinessChat(name) &&
              __shouldProcessChatForTests({
                chatTitle: name,
                targetGroups,
                activeDmChatKeys:
                  (globalThis.__activeDmWatchTargets?.keys instanceof Set
                    ? globalThis.__activeDmWatchTargets.keys
                    : new Set()),
              }) &&
              isAllowedChat(name)
          );
          let currentHeaderChat = "";
          try {
            currentHeaderChat = String((await getActiveChatName(page)) ?? "").trim();
          } catch {
            currentHeaderChat = "";
          }
          const sidebarIdentityChat = String(
            globalThis.__currentOpenChatTitle ?? ""
          ).trim();

          if (interruptChat && !interruptIsSameActiveChat) {
            chatName = interruptChat;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            globalThis.__activeChatFocusUntil = Date.now() + 15_000;
            selectedGroupLiveSignal = true;
            console.log("🚨 INTERRUPT: switching to new inbound chat", chatName);
          } else if (interruptChat && interruptIsSameActiveChat) {
            chatName =
              globalThis.__activeChatInFocus ||
              globalThis.__activeChatTitle ||
              interruptChat;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            selectedGroupLiveSignal = true;
            console.log("🧷 SAME CHAT: continuing active flow", chatName);
          } else if (isActiveChatValid) {
            chatName = globalThis.__activeChatInFocus;
            globalThis.__activeChatTitle = chatName;
            console.log("🎯 PRIORITY: active conversation (focus window)", chatName);
          } else if (
            String(activeNowForStickiness ?? "").trim() !== "" &&
            isValidBusinessChat(String(activeNowForStickiness).trim()) &&
            isAllowedChat(String(activeNowForStickiness).trim())
          ) {
            chatName = String(activeNowForStickiness).trim();
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current active chat", chatName);
          } else if (
            currentHeaderChat &&
            isValidBusinessChat(currentHeaderChat) &&
            isAllowedChat(currentHeaderChat)
          ) {
            chatName = currentHeaderChat;
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current header chat", chatName);
          } else if (
            sidebarIdentityChat &&
            isValidBusinessChat(sidebarIdentityChat) &&
            isAllowedChat(sidebarIdentityChat)
          ) {
            chatName = sidebarIdentityChat;
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current sidebar identity chat", chatName);
          } else if (allowedForRotation.length > 0) {
            const n = allowedForRotation.length;
            globalThis.__lastAllowedRotationN = n;
            usedFallbackRotationForThisLoop = true;
            let picked = null;
            for (let pass = 0; pass < 2 && !picked; pass++) {
              for (let i = 0; i < n; i++) {
                const idx = ((priorityScanIndex + i) % n + n) % n;
                const name = allowedForRotation[idx];
                const ck = normalizeTitle(name);
                const st = globalThis.__chatState?.[ck];
                if (
                  pass === 0 &&
                  st &&
                  Date.now() - st.lastUpdatedAt < 1500
                ) {
                  console.log(
                    "⏳ Recently checked — deprioritizing rotation pick:",
                    name
                  );
                  continue;
                }
                picked = name;
                break;
              }
            }
            if (!picked) {
              picked =
                allowedForRotation[((priorityScanIndex % n) + n) % n];
            }
            chatName = picked;
            globalThis.__activeChatTitle = chatName;
            /** Do not set __activeChatInFocus without __activeChatFocusUntil — that used to pin one chat forever. */
            console.log("🔁 PRIORITY: fallback rotation", chatName, `(allowed ${n} in sidebar)`);
            /** Advance {@link priorityScanIndex} only after idle threshold (see extraction block), not every tick. */
          } else {
            console.log(
              "⛔ SKIP: No sidebar chats match allowlist / targets — open an allowed group or widen PLAYWRIGHT_ALLOWED_CHAT_TITLES"
            );
            return;
          }
        }

        if (!chatName) {
          console.log("⛔ SKIP: No chat selected this tick");
          return;
        }

        const pickedChatKey = normalizeTitle(String(chatName ?? "").trim());
        if (
          pickedChatKey &&
          globalThis.__visitedChatsThisCycle.has(pickedChatKey)
        ) {
          console.log("⛔ Already visited this chat this cycle — skipping switch");
          return;
        }
        if (pickedChatKey) {
          globalThis.__visitedChatsThisCycle.add(pickedChatKey);
        }

        if (!usedFallbackRotationForThisLoop) {
          rotationIdleCount = 0;
        }

        if (isReplyPrivateLockActive()) {
          console.log("⛔ Skip switching — reply private flow active");
          return;
        }
        if (globalThis.__UI_SEND_LOCK) return;

        try {
          let viewing = null;
          try {
            viewing = await getActiveChatName(page);
          } catch {
            viewing = null;
          }

          let opened = false;
          if (viewing === chatName) {
            const activeRow = page
              .locator(`#pane-side div[role="row"]`, {
                has: page.locator(`span[title="${chatName}"]`),
              })
              .first();
            const rowAlready = await isRowActive(activeRow);
            if (rowAlready) {
              opened = true;
            } else {
              opened = await openChatAndConfirm(page, chatName);
            }
          } else {
            opened = await openChatAndConfirm(page, chatName);
          }

          if (!opened) {
            console.log("⛔ SKIP: Failed to open chat", chatName);
            return;
          }

          const headerMatches = await ensureHeaderMatches(page, chatName);
          if (!headerMatches) {
            console.log("⛔ SKIP: Header does not match target chat");
            return;
          }

          setCurrentOpenChatTitleFromSidebar(chatName);

          const activeChat = chatName;
          globalThis.__activeChatTitle = activeChat;
          await wait(300);

          const watchedDmAllowlist =
            globalThis.__watchedDmAllowlist instanceof Set
              ? globalThis.__watchedDmAllowlist
              : new Set();
          const currentTitle = String(globalThis.__currentOpenChatTitle || "").trim();
          const normalizedChatKey = normalizeTitle(currentTitle);
          const isGroupAllowed = isAllowedChat(currentTitle);
          const isWatchedDmAllowed =
            Boolean(normalizedChatKey) && watchedDmAllowlist.has(normalizedChatKey);

          if (!isGroupAllowed && isWatchedDmAllowed) {
            console.log("[playwright_dm_watch_allowlist_bypass]", {
              chatTitle: currentTitle || null,
              chatKey: normalizedChatKey || null,
            });
          }

          if (!isGroupAllowed && !isWatchedDmAllowed) {
            console.log(
              "⛔ Skipping chat (not in allowlist):",
              normalize(globalThis.__currentOpenChatTitle || "")
            );
            return;
          }

          let headerOk = false;
          try {
            const title = await ensureChatView(page);
            headerOk = !!title;
          } catch {
            console.warn("🚫 UI NOT READY — skipping loop");
            return;
          }

          if (!headerOk) {
            console.log("⛔ Skipping extraction — invalid UI");
            return;
          }

          console.log("🟢 UI READY — proceeding with extraction");

          const key = normalizeTitle(
            String(
              globalThis.__currentOpenChatTitle ?? chatName ?? activeChat ?? ""
            ).trim()
          );
          const hasVisibleMessages =
            (await page.$("#main .copyable-text")) != null;
          if (!hasVisibleMessages) {
            console.log("⚠️ Empty UI — forcing recover");
            if (key) {
              globalThis.__chatState =
                globalThis.__chatState || Object.create(null);
              globalThis.__chatState[key] = {
                snapshot: "",
                seenRowKeys: new Set(),
                lastUpdatedAt: Date.now(),
              };
            }
            return;
          }

          const rows = await extractIncomingMessages(page, {
            bypassTailDedupe: true,
          });
          if (!rows || rows.length === 0) {
            console.log("⚠️ No extraction — skipping idle count");
            return;
          }

          const sorted = [...rows]
            .map((m, idx) => ({ ...m, __ts: Number(m?.timestamp) || idx }))
            .sort((a, b) => a.__ts - b.__ts);
          const openTitle = String(globalThis.__currentOpenChatTitle ?? "").trim();
          if (!openTitle) {
            console.error("INVALID CHAT CONTEXT — DROPPING MESSAGE", {
              title: openTitle,
            });
            return;
          }

          const dmWatch = globalThis.__activeDmWatchTargets || null;
          const activeDmChatKeys =
            dmWatch && dmWatch.keys instanceof Set ? dmWatch.keys : new Set();
          const bookingsByDmKey =
            dmWatch && dmWatch.byKey instanceof Map ? dmWatch.byKey : new Map();
          const normalizedOpenChatKey = normalizeTitle(openTitle);
          const isDmContinuationChat =
            isPlaywrightDmContinuationEnabled() &&
            Boolean(normalizedOpenChatKey && activeDmChatKeys.has(normalizedOpenChatKey));
          console.log("[playwright_open_chat_classified]", {
            openTitle,
            normalizedOpenChatKey: normalizedOpenChatKey || null,
            isDmContinuationChat,
          });

          // DM continuation: no group participant bucketing; forward only user/customer replies.
          if (isDmContinuationChat) {
            try {
              console.log("[dm_extraction_started]", {
                dmChatTitle: openTitle,
                dmPlaywrightChatKey: normalizedOpenChatKey,
                rowCount: sorted.length,
              });
              const dmState = dmContinuationCursorState();
              const dmCursorKey = `dm-continuation::${normalizedOpenChatKey}`;
              const match = pickDmBookingHint(normalizedOpenChatKey, bookingsByDmKey);
              if (!match.ok) {
                if (match.reason === "AMBIGUOUS_MATCH") {
                  console.warn("[playwright_dm_continuation_ambiguous]", {
                    dmChatKey: normalizedOpenChatKey,
                    bookingIds: match.bookingIds || [],
                  });
                }
                return;
              }
              const hint = match.hint || {};
              const baselineEstablished = Boolean(
                dmState.firstOpenBaselineEstablished[dmCursorKey]
              );
              const lastProcessedMessageId = String(
                dmState.lastProcessedDmMsgId?.[dmCursorKey] ?? ""
              ).trim();
              const processedDataIds = getOrCreateProcessedDmDataIdsSet(dmCursorKey);
              const plan = planDmContinuationHandling({
                sorted,
                booking: hint,
                lastProcessedMessageId,
                baselineEstablished,
                processedDataIds,
              });
              if (!plan.row) {
                console.log("[dm_extraction_no_new_customer_rows]", {
                  dmChatTitle: openTitle,
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  rowCount: sorted.length,
                  baselineEstablished,
                  reason: plan.reason || null,
                });
                if (!baselineEstablished) {
                  dmState.firstOpenBaselineEstablished[dmCursorKey] = true;
                  console.log("[dm_first_open_baseline_established]", {
                    dmPlaywrightChatKey: normalizedOpenChatKey,
                    bookingId: hint.bookingId || null,
                    baselineMessageId: null,
                    dedupeKeySource: null,
                    dataId: null,
                    reason: plan.reason || "DM_FIRST_OPEN_NO_ELIGIBLE_ROW",
                  });
                }
                return;
              }
              const last = plan.row;
              const dmDecision = plan.decision;
              const rawText = dmDecision?.rawText || String(last.text ?? "").trim();
              console.log("[playwright_dm_row_extracted]", {
                dmChatTitle: openTitle,
                dmPlaywrightChatKey: normalizedOpenChatKey,
                bookingId: hint.bookingId || null,
                sourceMessageIndex: dmDecision?.sourceMessageIndex ?? null,
                textPreview: rawText.slice(0, 120) || null,
              });
              if (dmDecision?.dedupeKey) {
                console.log("[dm_dedupe_key_selected]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  dedupeKey: dmDecision.dedupeKey,
                  dedupeKeySource: dmDecision.dedupeKeySource || null,
                  dataId: dmDecision.dataId || null,
                  sourceMessageIndex: dmDecision.sourceMessageIndex ?? null,
                });
              }
              if (plan.action === "baseline") {
                persistDmContinuationProcessedMarker(dmCursorKey, dmDecision);
                dmState.firstOpenBaselineEstablished[dmCursorKey] = true;
                console.log("[dm_first_open_baseline_absorbed]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  bookingId: hint.bookingId || null,
                  messageId: dmDecision?.messageId || null,
                  dedupeKeySource: dmDecision?.dedupeKeySource || null,
                  dataId: dmDecision?.dataId || null,
                  sourceMessageIndex: dmDecision?.sourceMessageIndex ?? null,
                  textPreview: rawText.slice(0, 120) || null,
                });
                console.log("[dm_first_open_baseline_established]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  bookingId: hint.bookingId || null,
                  baselineMessageId: dmDecision?.messageId || null,
                  dedupeKeySource: dmDecision?.dedupeKeySource || null,
                  dataId: dmDecision?.dataId || null,
                });
                return;
              }
              if (dmDecision?.reason === "LIKELY_ASSISTANT_OUTBOUND_COPY") {
                console.log("[playwright_dm_message_skipped_outbound_echo]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  bookingId: hint.bookingId || null,
                  reason: dmDecision.reason,
                  textPreview: rawText.slice(0, 120),
                });
                return;
              }
              if (dmDecision?.reason === "OLDER_THAN_REPLY_PRIVATE_MARKER") {
                console.log("[playwright_dm_message_skipped_before_booking_marker]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  bookingId: hint.bookingId || null,
                  rowTimestampMs: dmDecision.rowTimestampMs || null,
                  reason: dmDecision.reason,
                });
                return;
              }
              console.log("[dm_message_processing_decision]", {
                messageId: dmDecision?.messageId || null,
                dedupeKeySource: dmDecision?.dedupeKeySource || null,
                dataId: dmDecision?.dataId || null,
                lastProcessedMessageId: lastProcessedMessageId || null,
                sourceMessageIndex: dmDecision?.sourceMessageIndex ?? null,
                decision: dmDecision?.decision || "skip",
                reason: dmDecision?.reason || null,
              });
              if (dmDecision?.reason === "DUPLICATE_DM_DATA_ID") {
                console.log("[dm_duplicate_data_id_blocked]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  dataId: dmDecision.dataId || null,
                  dedupeKey: dmDecision.dedupeKey || null,
                  sourceMessageIndex: dmDecision.sourceMessageIndex ?? null,
                });
              }
              if (plan.action === "skip" || dmDecision?.decision === "skip") {
                console.log("[playwright_dm_message_skipped_already_processed]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  reason: dmDecision?.reason || plan.reason || "SKIP",
                });
                return;
              }
              const forwarded = await forwardPlaywrightDmToPipeline({
                message: String(last.text ?? "").trim(),
                dmChatTitle: openTitle,
                dmPlaywrightChatKey: normalizedOpenChatKey,
                bookingHint: {
                  bookingId: hint.bookingId || null,
                  participantKey: hint.participantKey || null,
                  participantName: hint.participantName || null,
                  participantPhoneForDm: hint.participantPhoneForDm || null,
                  originalGroupName: hint.originalGroupName || null,
                  originalGroupChatKey: hint.originalGroupChatKey || null,
                },
                source: "PLAYWRIGHT_DM",
              }).catch(() => false);
              if (forwarded) {
                persistDmContinuationProcessedMarker(dmCursorKey, dmDecision);
                const dmMsgIdDebug = getMessageIdFromExtracted(last, sorted);
                dmState.lastProcessedDmMsg[dmCursorKey] =
                  dmMsgIdDebug || String(Date.now());
                console.log("[playwright_dm_message_forwarded]", {
                  dmChatTitle: openTitle,
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  bookingId: hint.bookingId || null,
                });
              } else {
                console.warn("[playwright_dm_continuation_forward_failed]", {
                  dmPlaywrightChatKey: normalizedOpenChatKey,
                  reason: "FORWARD_FAILED",
                });
              }
              return;
            } finally {
              await restorePreviousGroupAfterBoundedDmProbe(page, dmProbeRestoreTarget);
            }
          }

          const duplicateRowKeyCounts = new Map();
          /** Index in full `sorted` thread (needed for “reply after this bubble?” checks). */
          const userMessages = [];
          const chatKey = normalizeTitle(openTitle);
          const freshState = getFreshDeltaChatState(chatKey);
          const normalizedGroupChatKey =
            normalizeTitle(openTitle || chatName || activeChat || "") ||
            String(openTitle || chatName || activeChat || "").trim();
          for (let sortedIdx = 0; sortedIdx < sorted.length; sortedIdx++) {
            const m = sorted[sortedIdx];
            if (m.sender !== "user") continue;
            const senderScope =
              groupSenderScopeFromAnchor(normalizedGroupChatKey, m.senderAnchor) || "";
            const identity = resolveParticipantIdentity({
              participantPhone: m.participantPhone,
              participantName: m.participantName,
              senderAnchor: m.senderAnchor,
              groupChatKey: normalizedGroupChatKey,
              senderScope,
            });
            const rowKey = assignPinnedRowKeyForUserRow(
              m,
              freshState,
              duplicateRowKeyCounts,
              sorted
            );
            userMessages.push({
              ...m,
              participantKey: identity.participantKey || null,
              participantName: identity.participantName || m.participantName || null,
              participantPhone: identity.participantPhone || m.participantPhone || null,
              __position: sortedIdx,
              __rowKey: rowKey,
            });
          }
          const totalUserMessages = userMessages.length;
          console.log("📥 Total user messages:", totalUserMessages);
          const freshDeltaEnabled = isPlaywrightGroupFreshDeltaOnlyEnabled();
          if (!freshDeltaEnabled) {
            console.warn("[fresh_delta_legacy_mode_blocked]", {
              chatKey: normalizeTitle(openTitle),
              groupChatKey: normalizeTitle(openTitle),
              extractedUserRowCount: totalUserMessages,
              reason: "PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY_not_true",
            });
            return;
          }
          // --- Fresh delta filter (MUST run before participant buckets / burst merge) ---
          /** @type {any[]} */
          let freshVerifiedUserRows = userMessages;
          let freshAdmittedTurns = [];
          let freshAdmissionResult = null;
          let freshDeltaTailAnchorIndex = -1;
          let freshDeltaAcknowledgedAnchorIndex = -1;
          const sortedWithPos = sorted.map((m, idx) => ({ ...m, __position: idx }));
          if (freshState) {
            console.log("[fresh_delta_filter_input_count]", {
              chatKey,
              extractedUserRowCount: userMessages.length,
            });
            // Seed baseline on first open and return (no forward).
            if (!freshState.baselineEstablishedAtMs) {
              const baseline = establishFreshDeltaStartupBaseline({
                freshState,
                sortedWithPos,
                userMessages,
                chatKey,
                liveGroupSignal: selectedGroupLiveSignal,
              });
              console.log("[fresh_delta_tail_anchor_established]", {
                chatKey,
                stableId: baseline.tailAnchor?.stableId ?? null,
                __position:
                  baseline.tailAnchor?.__position ?? baseline.acknowledgedAnchorIndex,
                sender: baseline.tailAnchor?.sender ?? null,
                textPreview: String(
                  sortedWithPos[baseline.acknowledgedAnchorIndex]?.text ?? ""
                ).slice(0, 80),
                baselineSeenCount: baseline.baselineSeen.size,
                deferredTailStableId: baseline.deferredTail?.stableId ?? null,
              });
              console.log("[startup_baseline_established]", {
                chatKey,
                baselineSeenCount: baseline.baselineSeen.size,
                snapshotHash: freshState.baselineSnapshotHash || null,
                catchupMs: PLAYWRIGHT_FRESH_DELTA_CATCHUP_MS,
                liveGroupSignal: selectedGroupLiveSignal,
                deferredTail: Boolean(baseline.deferredTail),
              });
              return;
            }

            const nowMs = Date.now();
            const inCatchup =
              nowMs - Number(freshState.baselineEstablishedAtMs || 0) <=
              PLAYWRIGHT_FRESH_DELTA_CATCHUP_MS;

            let resolvedAnchorIndex = findTailAnchorIndex(
              sortedWithPos,
              freshState.currentTailAnchor
            );
            if (resolvedAnchorIndex < 0) {
              resolvedAnchorIndex = tryRestoreAnchorFromLastAdmitted(
                sortedWithPos,
                freshState,
                chatKey
              );
            }
            if (resolvedAnchorIndex < 0) {
              // Wait/rescan — never reanchor to max visible index (may be unadmitted).
              console.log("[fresh_delta_anchor_missing_wait_rescan]", {
                chatKey,
                acknowledgedAnchorIndex: freshState.acknowledgedAnchorIndex,
                lastAdmittedStableId: freshState.lastAdmittedStableId ?? null,
                currentListLength: sortedWithPos.length,
                note: "wait_rescan_no_reanchor_to_tail",
              });
              return;
            }

            const {
              acknowledgedAnchorIndex,
              waitForRescan: admissionGateWaitForRescan,
            } = resolveFreshDeltaAdmissionGate(sortedWithPos, freshState, chatKey);
            if (admissionGateWaitForRescan) {
              console.log("[fresh_delta_admission_gate_wait_rescan]", {
                chatKey,
                acknowledgedAnchorIndex,
                resolvedAnchorIndex,
                currentListLength: sortedWithPos.length,
                note: "no_repair_to_visible_tail",
              });
              return;
            }

            freshDeltaTailAnchorIndex = resolvedAnchorIndex;
            freshDeltaAcknowledgedAnchorIndex = acknowledgedAnchorIndex;
            console.log("[fresh_delta_tail_anchor_found]", {
              chatKey,
              found: true,
              resolvedAnchorIndex,
              acknowledgedAnchorIndex,
              stableId: freshState.currentTailAnchor?.stableId ?? null,
              currentListLength: sortedWithPos.length,
            });

            const filterResult = filterPostAnchorFreshUserRows({
              userMessages,
              acknowledgedAnchorIndex,
              resolvedAnchorIndex,
              freshState,
              chatKey,
              extractedList: sortedWithPos,
              tickMs: nowMs,
            });
            freshAdmissionResult = filterResult;

            if (filterResult.droppedAssistant.length) {
              console.log("[fresh_delta_assistant_row_dropped]", {
                chatKey,
                count: filterResult.droppedAssistant.length,
                samples: filterResult.droppedAssistant,
              });
            }
            if (filterResult.droppedBaseline.length) {
              console.log("[fresh_delta_old_row_dropped]", {
                chatKey,
                count: filterResult.droppedBaseline.length,
                samples: filterResult.droppedBaseline,
              });
            }
            if (filterResult.droppedDone.length) {
              console.log("[fresh_delta_done_row_dropped]", {
                chatKey,
                count: filterResult.droppedDone.length,
                samples: filterResult.droppedDone,
              });
            }
            if (filterResult.droppedPreAnchor.length) {
              console.log("[fresh_delta_pre_anchor_row_dropped]", {
                chatKey,
                count: filterResult.droppedPreAnchor.length,
                samples: filterResult.droppedPreAnchor,
              });
            }

            freshAdmittedTurns = Array.isArray(filterResult.admittedTurns)
              ? filterResult.admittedTurns
              : [];
            freshVerifiedUserRows = freshAdmittedTurns.map((turn) => turn.originalRow);

            if (inCatchup && filterResult.survivors.length > 0) {
              const catchupKeep = [];
              const catchupKeepStableIds = new Set();
              const catchupSuppress = [];
              for (const turn of freshAdmittedTurns) {
                const msg = turn.originalRow;
                if (matchesBaselineDeferredTailUser(msg, freshState, sortedWithPos)) {
                  catchupKeep.push(msg);
                  if (turn.stableId) catchupKeepStableIds.add(turn.stableId);
                } else {
                  catchupSuppress.push(msg);
                }
              }
              for (const msg of catchupSuppress) {
                const { stableId } = resolvePlaywrightForwardIdentity(
                  chatKey,
                  msg,
                  0,
                  sortedWithPos
                );
                if (stableId && freshState.baselineSeenStableIds instanceof Set) {
                  freshState.baselineSeenStableIds.add(stableId);
                }
                if (stableId && isInboundTurnLedgerEnabled()) {
                  markInboundTurnLedgerBaselineAbsorbed({
                    chatKey,
                    stableId,
                    textPreview: String(msg?.text ?? "").slice(0, 80),
                    sender: String(msg?.sender ?? "").trim() || "unknown",
                  });
                }
                console.log("[startup_baseline_row_absorbed]", {
                  chatKey,
                  stableId: stableId ?? null,
                  rowKey: String(msg?.__rowKey ?? "").trim() || null,
                  textPreview: String(msg?.text ?? "").slice(0, 80),
                  sender: String(msg?.sender ?? "").trim() || "unknown",
                  reason: "catchup_window_visible_row",
                });
              }
              freshVerifiedUserRows = catchupKeep;
              freshAdmittedTurns = freshAdmittedTurns.filter((turn) =>
                catchupKeepStableIds.has(turn.stableId)
              );
              if (catchupSuppress.length > 0 || catchupKeep.length > 0) {
                console.log("[baseline_catchup_forward_suppressed]", {
                  chatKey,
                  suppressedCount: catchupSuppress.length,
                  deferredForwardCount: catchupKeep.length,
                });
              }
            } else if (
              inCatchup &&
              filterResult.survivors.length > 0 &&
              String(computeSnapshotHash(userMessages) ?? "") !==
                freshState.baselineSnapshotHash
            ) {
              console.log("[baseline_catchup_delta_admitted]", {
                chatKey,
                count: filterResult.survivors.length,
                note: "post_anchor_only",
              });
            }

            recordSessionVisibilityLedger(
              freshState,
              sortedWithPos,
              acknowledgedAnchorIndex,
              chatKey,
              sortedWithPos
            );
          }

          const participantBuckets = new Map();
          const allParticipantBuckets = new Map();
          const currentFreshAdmittedStableIds =
            freshAdmissionResult?.currentFreshAdmittedStableIds instanceof Set
              ? new Set(freshAdmissionResult.currentFreshAdmittedStableIds)
              : new Set();
          const currentFreshAdmittedStableIdsByParticipant = new Map();
          if (
            freshAdmissionResult?.currentFreshAdmittedStableIdsByParticipant instanceof
            Map
          ) {
            for (const [key, set] of freshAdmissionResult.currentFreshAdmittedStableIdsByParticipant.entries()) {
              currentFreshAdmittedStableIdsByParticipant.set(key, new Set(set));
            }
          }
          if (freshAdmittedTurns.length > 0) {
            const allowedAfterCatchup = new Set(
              freshAdmittedTurns.map((turn) => turn.stableId).filter(Boolean)
            );
            for (const sid of [...currentFreshAdmittedStableIds]) {
              if (!allowedAfterCatchup.has(sid)) currentFreshAdmittedStableIds.delete(sid);
            }
            for (const [key, set] of currentFreshAdmittedStableIdsByParticipant.entries()) {
              for (const sid of [...set]) {
                if (!allowedAfterCatchup.has(sid)) set.delete(sid);
              }
              if (set.size === 0) currentFreshAdmittedStableIdsByParticipant.delete(key);
            }
          } else {
            currentFreshAdmittedStableIds.clear();
            currentFreshAdmittedStableIdsByParticipant.clear();
          }
          for (const turn of freshAdmittedTurns) {
            const msg = turn.originalRow;
            const key = String(turn.participantKey ?? msg?.participantKey ?? "").trim() || "(missing)";
            if (!participantBuckets.has(key)) participantBuckets.set(key, []);
            participantBuckets.get(key).push(msg);
          }
          if (isPlaywrightGuaranteeFirstAdmissionEnabled()) {
            for (const turn of freshAdmittedTurns) {
              const msg = turn.originalRow;
              if (!isVerifiedFreshDeltaUserRow(msg, chatKey)) continue;
              const key = String(turn.participantKey ?? msg?.participantKey ?? "").trim() || "(missing)";
              if (!allParticipantBuckets.has(key)) allParticipantBuckets.set(key, []);
              allParticipantBuckets.get(key).push(msg);
            }
          }
          console.log("[burst_merge_user_rows_only]", {
              chatKey,
              freshVerifiedUserRowCount: freshVerifiedUserRows.length,
              participantCount: participantBuckets.size,
              guaranteeFirstAdmission: isPlaywrightGuaranteeFirstAdmissionEnabled(),
            });
          const currentChat = String(openTitle || activeChat || "").trim();
          if (currentChat && currentChat !== lastActiveChat) {
            rotationIdleCount = 0;
            lastActiveChat = currentChat;
          }
          const chatId = chatKey;
          if (isChatSwitchBlockedByLock(chatId)) {
            console.log("⏳ Chat queued due to active lock:", chatId);
            globalThis.__pendingChats = globalThis.__pendingChats || new Set();
            globalThis.__pendingChats.add(chatId);
            return;
          }

          if (globalThis.__ACTIVE_PROCESSING_CHAT === chatKey) {
            console.log(
              "⏳ Active processing chat — skipping duplicate tick:",
              globalThis.__ACTIVE_PROCESSING_CHAT
            );
            return;
          }
          if (globalThis.__chatResponding?.[chatKey] === true) {
            console.log("⏳ Chat response in progress — skipping chat:", chatKey);
            return;
          }
          const cooldownUntil = Number(
            globalThis.__chatRespondingCooldownUntil?.[chatKey] ?? 0
          );
          if (cooldownUntil > Date.now()) {
            console.log("⏳ Chat cooldown active — skipping chat:", {
              chatKey,
              remainingMs: cooldownUntil - Date.now(),
            });
            return;
          }

          globalThis.__playwrightChatLastProcessedAt =
            globalThis.__playwrightChatLastProcessedAt || Object.create(null);
          const lastProcAt = Number(
            globalThis.__playwrightChatLastProcessedAt[chatKey] ?? 0
          );
          if (lastProcAt && Date.now() - lastProcAt < 1500) {
            console.log(
              "⏳ Chat recently processed — skipping rapid re-tick:",
              chatKey
            );
            return;
          }

          const extractedMessages = userMessages;
          const snapshotHash = computeSnapshotHash(extractedMessages);

          globalThis.__chatState =
            globalThis.__chatState || Object.create(null);

          let newUserMessages = [];

          const state = globalThis.__chatState?.[chatKey];

          const prevSeenBase =
            state?.seenRowKeys instanceof Set
              ? new Set(state.seenRowKeys)
              : new Set(
                  Array.isArray(state?.seenRowKeys) ? state.seenRowKeys : []
                );

          console.log("🧪 Snapshot:", snapshotHash);

          const userLines = extractedMessages.filter(
            (m) => m?.sender === "user"
          );

          const currentSeen = new Set(
            extractedMessages.map((m, i) => getMessageId(m, i))
          );

          if (!state) {
            if (userLines.length === 0) {
              globalThis.__chatState[chatKey] = {
                snapshot: snapshotHash,
                seenRowKeys: currentSeen,
                lastUpdatedAt: Date.now(),
              };

              console.log("🧊 Bootstrap (no user messages)");
              return;
            }

            console.log("🔥 Bootstrap with user messages — processing");
          }

          globalThis.__lastProcessedUserMsg =
            globalThis.__lastProcessedUserMsg || Object.create(null);
          globalThis.__playwrightPersistedCursorByParticipant =
            globalThis.__playwrightPersistedCursorByParticipant || Object.create(null);
          const ownerUserIdForCursor = resolveOwnerUid();
          const normalizedGroupChatKeyForCompare =
            normalizeTitle(openTitle || chatName || activeChat || "") ||
            String(openTitle || chatName || activeChat || "").trim();
          const verifiedOpenTitle = String(
            openTitle || chatName || activeChat || ""
          ).trim();
          const sidebarHasSignalForSelection = isAllowedChat(verifiedOpenTitle);
          const guaranteeFirst = isPlaywrightGuaranteeFirstAdmissionEnabled();
          for (const [participantKey, participantMessages] of participantBuckets.entries()) {
            const anchorMsg =
              participantMessages[participantMessages.length - 1] || null;
            const cursorKey = participantCursorKeyForMessage(chatKey, anchorMsg);
            if (!cursorKey) {
              console.warn("[participant_identity_missing_group_state_blocked]", {
                groupChatKey: chatKey,
                textPreview: String(anchorMsg?.text ?? "").slice(0, 80),
                reason: "MISSING_PARTICIPANT_CURSOR_KEY",
              });
              continue;
            }
            let persistedCursor =
              globalThis.__playwrightPersistedCursorByParticipant[cursorKey] ?? null;
            if (persistedCursor === null) {
              persistedCursor = await loadPlaywrightInboundCursor(db, {
                businessId: ownerUserIdForCursor,
                chatKey,
                groupChatKey: chatKey,
                participantKey: anchorMsg?.participantKey || "",
              });
              globalThis.__playwrightPersistedCursorByParticipant[cursorKey] =
                persistedCursor || false;
              if (persistedCursor?.lastProcessedInboundId) {
                globalThis.__lastProcessedUserMsg[cursorKey] = String(
                  persistedCursor.lastProcessedInboundId
                ).trim();
              }
              console.log("[playwright_cursor_loaded]", {
                chatKey,
                cursorKey,
                hasCursor: Boolean(persistedCursor),
                lastProcessedInboundId:
                  persistedCursor?.lastProcessedInboundId || null,
              });
            } else if (persistedCursor === false) {
              persistedCursor = null;
            }

            const lastProcessedUserMsgId = String(
              globalThis.__lastProcessedUserMsg?.[cursorKey] ?? ""
            ).trim();

            const forwardDecision = decideParticipantForwardTurn({
              chatKey,
              cursorKey,
              participantKey,
              participantMessages,
              allParticipantUserRows: guaranteeFirst
                ? allParticipantBuckets.get(participantKey) || participantMessages
                : undefined,
              extractedMessages,
              sorted: sortedWithPos,
              persistedCursor,
              lastProcessedUserMsgId,
              sidebarHasSignal: sidebarHasSignalForSelection,
              normalizedGroupChatKeyForCompare,
              guaranteeFirst,
              anchorIndex: freshDeltaAcknowledgedAnchorIndex,
              tickFirstSeenByStableId: freshState?.tickFirstSeenByStableId,
              currentFreshAdmittedStableIds:
                currentFreshAdmittedStableIdsByParticipant.get(participantKey) ||
                currentFreshAdmittedStableIds,
              baselineSeenStableIds:
                freshState?.baselineSeenStableIds instanceof Set
                  ? freshState.baselineSeenStableIds
                  : null,
              deps: {
                buildExtractedMessageId,
                buildStableMessageKey,
                buildParticipantForwardCandidate,
                evaluateReplyAfterGuard,
                collapseRowsForForward,
                isGroupMessageSuppressed,
                suppressGroupMessageSelection,
                maybeSuppressGroupMessageSelection,
                isParticipantMessageInflightOrDone,
                isRegisteredPlaywrightOutboundEcho,
              },
            });

            if (forwardDecision.action !== "forward" || !forwardDecision.candidate) {
              continue;
            }

            const candidate = forwardDecision.candidate;
            const lastUserMsgId = String(forwardDecision.stableId ?? "").trim();
            const idStrategy = forwardDecision.idStrategy || "UNKNOWN";

            newUserMessages.push(candidate);
            console.log("[participant_new_message_selected]", {
              chatKey,
              participantKey: candidate.participantKey || null,
              cursorKey,
              lastUserMsgId,
              idStrategy,
              forwardDecisionReason: forwardDecision.reason,
              burstMerged: Boolean(candidate.__burstMerged),
              burstCount: candidate.__burstMergedCount ?? 1,
              mergedRowCount: candidate.__catchupMergedRowCount || 1,
              persistedCursorPresent: Boolean(
                forwardDecision.normalizedCursor || persistedCursor
              ),
              indexDriftRecovered: Boolean(forwardDecision.indexDriftRecovered),
              textPreview: String(candidate.text ?? "").slice(0, 120),
            });
          }
          newUserMessages.sort(
            (a, b) => (Number(a?.__ts) || 0) - (Number(b?.__ts) || 0)
          );

          console.log("🆕 New user msgs:", newUserMessages.length);

          if (newUserMessages.length === 0) {
            const sidebarSignal = await getSidebarActivitySignalForChat(
              page,
              openTitle
            );
            globalThis.__chatState[chatKey] = {
              snapshot: snapshotHash,
              seenRowKeys: currentSeen,
              lastUpdatedAt: Date.now(),
            };
            if (sidebarSignal.hasSignal) {
              console.log("⏳ Sidebar shows fresh activity; waiting for DOM catch-up", {
                chatKey,
                unreadPoints: sidebarSignal.unreadPoints,
                boldPoints: sidebarSignal.boldPoints,
                previewChanged: sidebarSignal.previewChanged,
                timeChanged: sidebarSignal.timeChanged,
              });
              return;
            }
            if (usedFallbackRotationForThisLoop) {
              console.log("⏭ No new user message — moving to next chat");
              advanceRotationOnIdle();
            }

            return;
          }

          const processableMessages = [];
          let hasInFlight = false;

          for (const [index, msg] of newUserMessages.entries()) {
            const text = String(msg?.text ?? "").trim();
            if (!text) continue;

            const { guaranteeKey } = resolvePlaywrightForwardIdentity(
              chatKey,
              msg,
              index,
              extractedMessages
            );

            const stateEntry = getMessageState(guaranteeKey);
            const delivered = stateEntry?.state === "done";
            const inFlight = stateEntry?.state === "processing";

            if (inFlight) hasInFlight = true;

            if (!delivered && !inFlight) {
              processableMessages.push(msg);
            }
          }

          console.log("🧪 Pre-filter:", {
            total: newUserMessages.length,
            processable: processableMessages.length,
            inFlight: hasInFlight,
          });

          if (processableMessages.length === 0) {
            if (hasInFlight) {
              console.log(
                "⏳ Messages in-flight — waiting for pipeline completion"
              );
            } else {
              console.log(
                "⏭ All new messages already delivered — skipping pipeline"
              );
            }

            globalThis.__chatState[chatKey] = {
              snapshot: snapshotHash,
              seenRowKeys: currentSeen,
              lastUpdatedAt: Date.now(),
            };

            if (usedFallbackRotationForThisLoop) {
              const hasUnread = await page.evaluate(() => {
                const unread = document.querySelectorAll(
                  '#pane-side [aria-label*="unread"]'
                );
                return unread.length > 0;
              });
              if (!hasUnread) {
                console.log("🛑 Stay — no unread chats");
                return;
              }
              console.log("🔁 Safe switch — unread chat found");
            }

            return;
          }

          const messagesToForward = [...processableMessages].sort(
            (a, b) => (Number(a?.__ts) || 0) - (Number(b?.__ts) || 0)
          );
          const newMessages = messagesToForward;

          if (usedFallbackRotationForThisLoop) {
            const hasPendingWork = newMessages.length > 0;
            if (hasPendingWork) {
              console.log(
                "🛑 Stay — current chat still has work"
              );
              rotationIdleCount = 0;
            } else {
              const hasUnread = await page.evaluate(() => {
                const unread = document.querySelectorAll(
                  '#pane-side [aria-label*="unread"]'
                );
                return unread.length > 0;
              });
              if (!hasUnread) {
                console.log("🛑 Stay — no unread chats");
                return;
              }
              console.log("🔁 Safe switch — unread chat found");
              if (totalUserMessages > 0 && messagesToForward.length > 0) {
                console.log(
                  "⏭ User lines visible but all candidates already in guarantee — no pipeline work; idle tick for rotation"
                );
              }
              advanceRotationOnIdle();
            }
          }

          // Acquire hard chat lock for this chatKey before forwarding (prevents any chat switching).
          if (!activeChatLockKey()) {
            globalThis.__activeChatLock = { chatKey, inProgress: true, startedAtMs: Date.now() };
            console.log("[chat_lock_acquired]", { chatKey });
          }
          globalThis.__ACTIVE_PROCESSING_CHAT = chatKey;
          let anyForwarded = false;
          try {
            for (const [index, msg] of messagesToForward.entries()) {
            const lastUserText = String(msg?.text ?? "").trim();
            if (!lastUserText) {
              continue;
            }
            if (String(msg?.sender ?? "").trim() !== "user") {
              console.log("[forward_skipped_non_user_sender]", {
                sender: msg?.sender ?? null,
                textPreview: lastUserText.slice(0, 80),
              });
              continue;
            }
            if (isLikelyAssistantOutboundCopy(lastUserText)) {
              console.log("[forward_skipped_assistant_copy]", {
                textPreview: lastUserText.slice(0, 120),
                reason: "assistant_copy_template",
              });
              continue;
            }
            if (isRegisteredPlaywrightOutboundEcho(chatKey, lastUserText)) {
              console.log("[outbound_echo_blocked]", {
                chatKey,
                stableId: getMessageIdFromExtracted(msg, extractedMessages) || null,
                rowKey: String(msg?.__rowKey ?? "").trim() || null,
                textPreview: lastUserText.slice(0, 120),
                reason: "registered_outbound_echo",
                matchedOutboundPreview: lastUserText.slice(0, 120),
              });
              continue;
            }
            const inboundOrigin = resolveInboundSourceOrigin({
              text: lastUserText,
              chatKey,
              sender: msg.sender,
            });
            if (inboundOrigin.blocked || inboundOrigin.sourceOrigin !== INBOUND_SOURCE_REAL_CUSTOMER) {
              console.log("[outbound_echo_blocked]", {
                chatKey,
                stableId: getMessageIdFromExtracted(msg, extractedMessages) || null,
                rowKey: String(msg?.__rowKey ?? "").trim() || null,
                textPreview: lastUserText.slice(0, 120),
                reason: inboundOrigin.reason || inboundOrigin.sourceOrigin,
                matchedOutboundPreview: lastUserText.slice(0, 120),
              });
              continue;
            }
            /** Every `messagesToForward` entry is from the user-delta batch. */
            const isAfterAnchor = true;

            const { messageId, guaranteeKey, source: idSource } =
              resolvePlaywrightForwardIdentity(
                chatKey,
                msg,
                index,
                extractedMessages
              );

            const burstStableIds = Array.isArray(msg?.__burstStableIds)
              ? msg.__burstStableIds
                  .map((id) => String(id ?? "").trim())
                  .filter(Boolean)
              : [];
            const claimIds =
              burstStableIds.length > 0
                ? burstStableIds
                : [String(messageId ?? "").trim()].filter(Boolean);

            const stateEntry = getMessageState(guaranteeKey);
            const inFlight = stateEntry?.state === "processing";
            const done = stateEntry?.state === "done";
            const failed = stateEntry?.state === "failed";

            console.log("🧠 Decision:", {
              isAfterAnchor,
              inFlight,
              done,
              failed,
              willProcess: !inFlight && !done,
            });

            console.log("🧾 Message Identity:", {
              groupName: openTitle,
              messageId,
              source: idSource,
            });

            if (inFlight) {
              console.log("🔁 Already processing — skip");
              continue;
            }

            if (done) {
              console.log("⏭ Skipping message because already processed");
              continue;
            }
            if (failed) {
              const priorRetries =
                globalThis.__playwrightFailedRetryCount instanceof Map
                  ? Number(globalThis.__playwrightFailedRetryCount.get(guaranteeKey) ?? 0)
                  : 0;
              if (priorRetries >= PLAYWRIGHT_FAILED_RETRY_MAX) {
                console.log("[failed_retry_cap_reached]", {
                  guaranteeKey,
                  priorRetries,
                  max: PLAYWRIGHT_FAILED_RETRY_MAX,
                });
                continue;
              }
              console.log("♻️ Retrying failed message", {
                guaranteeKey,
                attempt: priorRetries + 1,
              });
            }
            const chatLocked =
              globalThis.__processingChats instanceof Map
                ? globalThis.__processingChats.get(chatKey) === true
                : false;
            if (chatLocked) {
              console.log("⏳ Chat processing lock active — skipping for retry:", {
                chatKey,
              });
              continue;
            }

            const activeChatOk = await ensureExpectedChatBeforeForward(
              page,
              String(chatName),
              chatKey
            );
            if (!activeChatOk) {
              continue;
            }

            console.log("🚀 Forwarding to pipeline");
            if (isPlaywrightGroupFreshDeltaOnlyEnabled()) {
              console.log("[fresh_delta_forwarded]", {
                chatKey,
                messageId,
                burstMerged: Boolean(msg?.__burstMerged),
                burstCount: msg?.__burstMergedCount ?? 1,
                textPreview: String(msg?.text ?? "").slice(0, 120) || null,
              });
            }
            globalThis.__chatResponding =
              globalThis.__chatResponding || Object.create(null);
            globalThis.__chatResponding[chatKey] = true;
            globalThis.__processingChats.set(chatKey, true);
            for (const stableId of claimIds) {
              const claimKey = playwrightGuaranteeKeyForStableId(chatKey, stableId);
              if (claimKey) setMessageState(claimKey, "processing");
              if (isInboundTurnLedgerEnabled()) {
                markInboundTurnLedgerProcessing({
                  chatKey,
                  stableId,
                  guaranteeKey: claimKey,
                  textPreview: String(msg?.text ?? "").slice(0, 120),
                });
              }
            }
            setMessageState(guaranteeKey, "processing");
            try {
              const listenerInboundId =
                String(msg?.__listenerInboundId ?? "").trim() ||
                getMessageIdFromExtracted(msg, extractedMessages);
              const forwarded = await forwardPlaywrightGroupToPipeline({
                messageId,
                text: msg.text,
                sender: msg.sender,
                senderName: msg.participantName || msg.sender,
                participantPhoneForDm: msg.participantPhone || undefined,
                participantKey: msg.participantKey || undefined,
                senderAnchor: msg.senderAnchor || undefined,
                timestamp: msg.timestamp,
                groupName: String(
                  globalThis.__currentOpenChatTitle ?? activeChat ?? ""
                ).trim(),
                playwrightWebTitleIdentity: true,
                playwrightChatKey: chatKey,
                sourceRowKey: String(msg.__rowKey ?? "").trim(),
                sourceMessageIndex:
                  msg.sourceMessageIndex != null &&
                  Number.isFinite(Number(msg.sourceMessageIndex))
                    ? Number(msg.sourceMessageIndex)
                    : msg.__position,
                inboundSourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
                startupCatchup: Boolean(msg.__startupCatchup),
                suppressAckNoopOutbound: Boolean(msg.__suppressAckNoopOutbound),
                cursorLastAssistantOutboundTrace:
                  msg.__persistedCursor?.lastAssistantOutboundTrace || null,
              });
              if (forwarded) {
                anyForwarded = true;
                globalThis.__playwrightChatLastProcessedAt =
                  globalThis.__playwrightChatLastProcessedAt ||
                  Object.create(null);
                globalThis.__playwrightChatLastProcessedAt[chatKey] =
                  Date.now();
                if (
                  globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map
                ) {
                  globalThis.__playwrightListenerMsgIdByGuarantee.set(
                    guaranteeKey,
                    listenerInboundId || getMessageIdFromExtracted(msg, extractedMessages)
                  );
                }
                recordPlaywrightInboundScheduled({
                  guaranteeKey,
                  chatKey,
                  rowKey: String(msg.__rowKey ?? "").trim(),
                  participantCursorKey: participantCursorKeyForMessage(chatKey, msg),
                  burstStableIds: claimIds,
                  ownerUserId: ownerUserIdForCursor,
                  groupChatKey: chatKey,
                  participantKey: String(msg.participantKey ?? "").trim(),
                  inboundId:
                    listenerInboundId || getMessageIdFromExtracted(msg, extractedMessages),
                  sourceMessageIndex:
                    msg.sourceMessageIndex != null &&
                    Number.isFinite(Number(msg.sourceMessageIndex))
                      ? Number(msg.sourceMessageIndex)
                      : msg.__position,
                });
                if (
                  freshState &&
                  matchesBaselineDeferredTailUser(msg, freshState, extractedMessages)
                ) {
                  if (freshState.baselineDeferredTailUser) {
                    freshState.baselineDeferredTailUser.consumed = true;
                  }
                  if (freshState.anchorHoldUserForward) {
                    freshState.anchorHoldUserForward.consumed = true;
                  }
                }
                if (freshState) {
                  // Advance runtime anchor only after a successfully admitted/forwarded turn.
                  advanceTailAnchor(
                    freshState,
                    msg,
                    sortedWithPos,
                    chatKey,
                    extractedMessages
                  );
                  recordSessionVisibilityLedger(
                    freshState,
                    sortedWithPos,
                    Number(msg?.__position) >= 0
                      ? Number(msg.__position)
                      : sortedWithPos.length - 1,
                    chatKey,
                    sortedWithPos
                  );
                }
              } else {
                globalThis.__chatResponding[chatKey] = false;
                globalThis.__processingChats.delete(chatKey);
                if (globalThis.__playwrightFailedRetryCount instanceof Map) {
                  globalThis.__playwrightFailedRetryCount.set(
                    guaranteeKey,
                    Number(globalThis.__playwrightFailedRetryCount.get(guaranteeKey) ?? 0) + 1
                  );
                }
                notifyPlaywrightGuaranteeReleased(guaranteeKey);
              }
            } catch (fwdErr) {
              globalThis.__chatResponding[chatKey] = false;
              globalThis.__processingChats.delete(chatKey);
              if (globalThis.__playwrightFailedRetryCount instanceof Map) {
                globalThis.__playwrightFailedRetryCount.set(
                  guaranteeKey,
                  Number(globalThis.__playwrightFailedRetryCount.get(guaranteeKey) ?? 0) + 1
                );
              }
              notifyPlaywrightGuaranteeReleased(guaranteeKey);
              console.error(
                "[Playwright] forwardPlaywrightGroupToPipeline error:",
                fwdErr instanceof Error ? fwdErr.message : fwdErr
              );
            }
            }
          } finally {
            globalThis.__ACTIVE_PROCESSING_CHAT = null;
            // Release lock if nothing was forwarded (pipeline errored before any send could happen).
            // If at least one forward succeeded, Playwright outbound releases after send completes.
            if (!anyForwarded && activeChatLockKey() === chatKey) {
              releaseChatLock();
            }
            if (globalThis.__pendingChats && globalThis.__pendingChats.size > 0) {
              const nextChat = globalThis.__pendingChats.values().next().value;
              globalThis.__pendingChats.delete(nextChat);
              console.log("🔁 Processing queued chat:", nextChat);
              globalThis.__forceNextChat = nextChat;
            }
          }

          const updatedSeen = new Set(prevSeenBase);
          for (const msg of messagesToForward) {
            updatedSeen.add(getMessageIdFromExtracted(msg, extractedMessages));
          }

          globalThis.__chatState[chatKey] = {
            snapshot: snapshotHash,
            seenRowKeys: updatedSeen,
            lastUpdatedAt: Date.now(),
          };

          globalThis.__activeChatInFocus = activeChat;
          globalThis.__activeChatFocusUntil = Date.now() + 15_000;
          globalThis.__activeChatInProgress = activeChat;
        } finally {
          if (!globalThis.__INTERRUPT_PENDING__) {
            globalThis.__activeChatInFocus = null;
            globalThis.__activeChatFocusUntil = 0;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log("[Loop] Safe error:", msg);
        if (
          (typeof page?.isClosed === "function" && page.isClosed()) ||
          isPlaywrightSessionDeadError(err)
        ) {
          void requestPlaywrightRelaunch("Browser session lost during chat loop");
        }
      }
    } finally {
      chatLoopRunning = false;
      globalThis.__loopRunning = false;
      if (restartAfterInterrupt && !isStopping) {
        console.log("🚀 Restarting loop after interrupt");
        globalThis.__INTERRUPT_PENDING__ = false;
        console.log("⚡ INTERRUPT CONSUMED");
        setTimeout(() => {
          if (!chatLoopRunning) {
            void runChatLoop().catch((err) => {
              if (!isStopping) {
                console.error("[Playwright] Chat loop error:", err?.message || err);
              }
              chatLoopRunning = false;
            });
          }
        }, 0);
      }
    }
  };

  heartbeatTimer = setInterval(() => {
    if (!isStopping) {
      console.log("[Playwright] 🫀 Alive");
    }
  }, 60_000);

  localApprovalContinuationTimer = setInterval(() => {
    if (isStopping) return;
    void pollLocalApprovalContinuations().catch((err) => {
      if (!isStopping) {
        console.warn(
          "[local_approval_reply_private_failed]",
          { bookingId: null, reason: err?.message || String(err) }
        );
      }
    });
  }, 5_000);

  localAvailabilityContinuationTimer = setInterval(() => {
    if (isStopping) return;
    void pollLocalAvailabilityContinuations().catch((err) => {
      if (!isStopping) {
        console.warn(
          "[local_availability_customer_notification_failed]",
          { bookingId: null, reason: err?.message || String(err) }
        );
      }
    });
  }, 5_000);

  if (isPlaywrightChatLoopEnabled()) {
    if (globalThis.chatLoopInterval != null) {
      clearInterval(globalThis.chatLoopInterval);
      globalThis.chatLoopInterval = null;
    }
    globalThis.lastOpenedChat = "";

    await ensureInitialChatOpen(page);

    const runChatLoopSafe = () => {
      void runChatLoop().catch((err) => {
        if (!isStopping) {
          console.error("[Playwright] Chat loop error:", err?.message || err);
        }
        chatLoopRunning = false;
      });
    };

    const pollInterruptSafe = () => {
      void (async () => {
        if (isStopping) return;
        if (isReplyPrivateLockActive()) {
          console.log("⛔ Skip switching — reply private flow active");
          return;
        }
        /** Defer interrupt queue (switch_chat) while outbound media UI is active. */
        if (globalThis.__WA_MEDIA_SEND__) return;
        if (chatLoopRunning || globalThis.__loopRunning) return;
        if (globalThis.__UI_SEND_LOCK) return;
        if (globalThis.__UI_HARD_LOCK) return;
        if (globalThis.__ACTIVE_PIPELINE__) return;
        if (activeChatLockKey()) {
          maybeReleaseStaleChatLock();
          return;
        }
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
        if (globalThis.__OUTBOUND_BUSY__ || globalThis.__activeJob) return;
        const topChats = await getTop6Chats(page);
        if (!topChats.length) return;
        const interruptChat = await pickInterruptChatFromSidebar(
          page,
          topChats,
          targetGroups
        );
        if (!interruptChat) return;
        const interruptKey = normalizeTitle(String(interruptChat).trim());
        if (isChatSwitchBlockedByLock(interruptKey)) {
          logChatSwitchBlocked(interruptKey);
          return;
        }
        const activeChatTitle = String(globalThis.__activeChatTitle ?? "").trim();
        if (activeChatTitle && String(interruptChat).trim() === activeChatTitle) {
          // Same chat inbound: keep current conversation continuity, no forced preemption.
          return;
        }
        globalThis.__forceNextChat = normalizeTitle(String(interruptChat).trim());
        globalThis.__activeChatInFocus = interruptChat;
        globalThis.__activeChatTitle = interruptChat;
        globalThis.__activeChatFocusUntil = Date.now() + 15_000;
        console.log("🚨 INTERRUPT: queued priority switch", interruptChat);
      })().catch((err) => {
        if (!isStopping) {
          const msg = err?.message || err;
          console.log("[Loop] Interrupt poll safe error:", msg);
          if (
            (typeof page?.isClosed === "function" && page.isClosed()) ||
            isPlaywrightSessionDeadError(err)
          ) {
            void requestPlaywrightRelaunch("Browser session lost during interrupt poll");
          }
        }
      });
    };

    globalThis.chatLoopInterval = setInterval(
      runChatLoopSafe,
      PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS
    );
    interruptPollTimer = setInterval(pollInterruptSafe, PLAYWRIGHT_INTERRUPT_POLL_MS);
    console.log(
      `[Loop] Interval set (${PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS}ms); interrupt poll ${PLAYWRIGHT_INTERRUPT_POLL_MS}ms; running first pass now`
    );
    runChatLoopSafe();
  } else {
    console.log("[Loop] Chat loop disabled (PLAYWRIGHT_CHAT_LOOP off)");
  }
}

/**
 * Starts Playwright when PLAYWRIGHT_ENABLED=true (also checked by server).
 */

/**
 * Strip trailing emoji/punctuation from a chat line for template matching.
 * @param {unknown} text
 */
function stripTrailingEmojiPunctuation(text) {
  return String(text ?? "")
    .trim()
    .replace(/[👍✅!.]+$/g, "")
    .trim();
}

/**
 * Verified composer price replies (not user negotiation).
 * @param {unknown} text
 */
export function isAssistantPriceReplyShape(text) {
  if (isEmilyAssistantPricingStatement(text)) return true;
  const norm = stripTrailingEmojiPunctuation(text)
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!norm) return false;
  if (/^\d{3,7}\s+per\s+(day|month)\s+hai$/i.test(norm)) return true;
  if (/^\d{3,7}\s+hai$/i.test(norm)) return true;
  return false;
}

/**
 * Secondary guard: known Emily outbound templates must not re-enter as customer input.
 * @param {unknown} text
 */
export function isLikelyAssistantOutboundCopy(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (isAssistantPriceReplyShape(raw)) return true;
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  if (norm === "noted 👍" || norm === "noted") return true;
  if (/^could you please clarify what you(?:'|’)re looking for\??$/i.test(raw)) {
    return true;
  }
  if (
    /^sorry,\s+.+\s+abhi available nahi hai\b/i.test(raw) ||
    /^sorry,\s+.+\s+is not available right now\b/i.test(raw) ||
    /^sorry,\s+.+\s+hamari list mein nahi hai\b/i.test(raw) ||
    /^sorry,\s+.+\s+is not listed in our available options\b/i.test(raw)
  ) {
    return true;
  }
  if (/^available options:/i.test(raw)) return true;
  if (/^konsa option dekhna chahenge\??$/i.test(norm)) return true;
  if (/^which option would you like to check\??$/i.test(norm)) return true;
  if (/^rate confirm kar ke bata deta hun\b/i.test(norm)) return true;
  if (/^perfect\s*👍?\s+/i.test(raw)) return true;
  if (/^ji,\s+.+\s+available hai\.\s*kitne time ke liye chahiye\??$/i.test(norm)) {
    return true;
  }
  if (/^your booking has already been received\b/i.test(norm)) return true;
  if (
    /^(?:\d+\s+)?din ke liye noted\b/i.test(norm) &&
    /\bnaam\b/i.test(norm) &&
    /\bcontact\b/i.test(norm)
  ) {
    return true;
  }
  if (/^apna naam aur contact number share kar dein\.?$/i.test(norm)) return true;
  if (/^- .+\(.+\)\s*$/i.test(raw)) return true;
  if (
    /^[a-z0-9][\w\s.-]{2,60}\([^()]+\)\s*$/i.test(raw) &&
    !/\b(kitna|kitni|rent|available|din|day|name|naam|contact)\b/i.test(norm)
  ) {
    return true;
  }
  return false;
}

/** @internal Tests — same mapping as extractIncomingMessages return rows. */
export function __mapExtractedIncomingMessageForTests(m, groupName = "Test Group") {
  const dataId = getExtractedWhatsAppDataId(m);
  const senderAnchor = resolveExtractedSenderAnchor(m);
  const prePlainText =
    m.prePlainText != null && String(m.prePlainText).trim() !== ""
      ? String(m.prePlainText).trim()
      : null;
  return {
    text: m.text,
    raw: m.text,
    sender: m.sender,
    participantName:
      m.participantName != null && String(m.participantName).trim() !== ""
        ? String(m.participantName).trim()
        : null,
    participantPhone:
      m.participantPhone != null && String(m.participantPhone).trim() !== ""
        ? String(m.participantPhone).trim()
        : null,
    participantKey:
      m.participantKey != null && String(m.participantKey).trim() !== ""
        ? String(m.participantKey).trim()
        : null,
    senderAnchor: senderAnchor || null,
    prePlainText,
    dataId: dataId || null,
    ...(dataId ? { id: { _serialized: dataId } } : {}),
    timestamp: m.timestamp ?? null,
    sourceMessageIndex:
      m.sourceMessageIndex != null && Number.isFinite(Number(m.sourceMessageIndex))
        ? Number(m.sourceMessageIndex)
        : null,
    groupName,
  };
}

/** @internal Tests — mirrors browser `playwrightMessageRowSender`. */
export function __resolvePlaywrightMessageRowSenderForTests(meta = {}) {
  const dataId = String(meta.dataId ?? "").trim();
  if (dataId.startsWith("true_")) return "me";
  if (dataId.startsWith("false_")) return "user";
  if (meta.hasMessageOutClass === true) return "me";
  if (meta.hasMessageInClass === true) return "user";
  const cls = String(meta.className ?? "");
  if (/\bmessage-out\b/.test(cls)) return "me";
  if (/\bmessage-in\b/.test(cls)) return "user";
  if (meta.hasOutgoingDescendant === true) return "me";
  if (meta.hasIncomingDescendant === true) return "user";
  if (meta.prePlainText) {
    const plain = String(meta.prePlainText);
    const plainMatch = plain.match(/^\[([^\]]+)\]\s*([^:]+):\s*/);
    if (plainMatch) {
      const who = String(plainMatch[2] ?? "").trim().toLowerCase();
      if (who === "you") return "me";
      if (who) return "user";
    }
    if (/^\s*you\s*:/i.test(plain)) return "me";
  }
  return "unknown";
}

/** @internal Tests */
export function __playwrightMessageRowSelectorsForTests() {
  return {
    legacy: PLAYWRIGHT_LEGACY_MESSAGE_ROW_SELECTOR,
    msgContainer: PLAYWRIGHT_MSG_CONTAINER_ROW_SELECTOR,
  };
}

export async function startPlaywrightListener() {
  if (String(process.env.PLAYWRIGHT_ENABLED ?? "").toLowerCase() !== "true") {
    return;
  }
  logPlaywrightGroupFreshDeltaMode();
  if (listenerStarted && !isStopping) {
    console.log("[Playwright] Listener already running");
    return;
  }

  listenerStarted = true;
  isStopping = false;

  try {
    await runListenerBody();
  } catch (e) {
    console.error("[Playwright] listener failed:", e?.message || e);
    await stopPlaywrightListener();
  }
}

export async function stopPlaywrightListener() {
  isStopping = true;
  listenerStarted = false;
  lastMessagePerGroup.clear();
  clearPlaywrightOutboundPage();

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (interruptPollTimer) {
    clearInterval(interruptPollTimer);
    interruptPollTimer = null;
  }
  if (localApprovalContinuationTimer) {
    clearInterval(localApprovalContinuationTimer);
    localApprovalContinuationTimer = null;
  }
  if (localAvailabilityContinuationTimer) {
    clearInterval(localAvailabilityContinuationTimer);
    localAvailabilityContinuationTimer = null;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (globalThis.chatLoopInterval != null) {
    clearInterval(globalThis.chatLoopInterval);
    globalThis.chatLoopInterval = null;
  }
  globalThis.lastOpenedChat = "";
  globalThis.__activeChatTitle = null;
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = null;
  globalThis.__currentOpenChatTitle = null;
  globalThis.__currentOpenChatTitleTS = 0;
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  if (globalThis.__processingChats instanceof Map) {
    globalThis.__processingChats.clear();
  }
  chatLoopRunning = false;

  if (browser) {
    try {
      await browser.close();
    } catch (e) {
      console.error("[Playwright] browser close:", e?.message || e);
    }
    browser = null;
  }

  isStopping = false;
}
