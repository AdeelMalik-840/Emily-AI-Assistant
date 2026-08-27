/**
 * Forwards Playwright-captured group lines into scheduleBufferedWhatsAppInbound.
 * Identity is **groupName** (visible chat title) + `playwrightWebTitleIdentity`.
 */

import { createHash } from "node:crypto";

import db from "../../config/firebase.js";
import { normalizeTitle } from "../playwrightTitleNormalize.js";
import { getBusinessWhatsAppCredentials } from "../businessWhatsApp.js";
// whatsappInboundBuffer is dynamically imported inside forwarders to avoid
// side-effectful imports during unit tests.
import { normalizeInboundMessage } from "../inboundNormalizer.js";
import {
  buildParticipantSessionKey,
  resolveParticipantIdentity,
} from "../participantIdentity.js";
import { chatSessionKey } from "../memory.js";
import { INBOUND_SOURCE_REAL_CUSTOMER } from "../inboundOriginGuard.js";

/** Set PLAYWRIGHT_DISABLE_PIPELINE_FORWARD=true to no-op inbound forwarding (debug only; disables AI pipeline). */
const PIPELINE_FORWARD_DISABLED = /^true$/i.test(
  String(process.env.PLAYWRIGHT_DISABLE_PIPELINE_FORWARD ?? "")
);
const WHATSAPP_MODE = String(process.env.WHATSAPP_MODE ?? "hybrid")
  .trim()
  .toLowerCase();

function resolveOwnerUid() {
  return String(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  ).trim();
}

function sessionKeyForGroup(ownerUserId, groupName) {
  const slug = createHash("sha256")
    .update(String(groupName ?? ""), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${ownerUserId}::playwright-${slug}`;
}

function normalizeSenderId(id) {
  return String(id ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^\++/, "+")
    .toLowerCase()
    .slice(0, 128);
}

function looksLikePhoneLabel(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const digits = raw.replace(/\D/g, "");
  return (
    /^(?:92)?3\d{9}$/.test(digits) ||
    /^03\d{9}$/.test(digits) ||
    (/^00923\d{9}$/.test(digits) && /^[+\d\s().-]+$/.test(raw))
  );
}

function groupParticipantScope(senderId) {
  return createHash("sha256")
    .update(normalizeSenderId(senderId) || "unknown-sender", "utf8")
    .digest("hex")
    .slice(0, 16);
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

function unresolvedParticipantTurnScope(groupKey, adapted) {
  const turnIdentity = [
    adapted?.messageId,
    adapted?.sourceRowKey,
    adapted?.sourceMessageIndex,
    adapted?.timestamp,
    adapted?.text,
  ]
    .map((value) => String(value ?? "").trim())
    .join("::");
  return createHash("sha256")
    .update(`${String(groupKey ?? "").trim().toLowerCase()}::${turnIdentity}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Build schedule payload; returns null if forwarding cannot run.
 * @param {{
 *   text: string,
 *   sender?: string,
 *   senderName?: string,
 *   timestamp: string | null,
 *   groupName: string,
 *   messageId?: string | number,
 *   playwrightWebTitleIdentity?: boolean,
 *   recentMessages?: string[],
 *   contextMessages?: string[],
 *   playwrightChatKey?: string,
 *   sourceRowKey?: string,
 *   sourceMessageIndex?: number,
 *   startupCatchup?: boolean,
 *   suppressAckNoopOutbound?: boolean,
 *   cursorLastAssistantOutboundTrace?: Record<string, unknown> | null,
 *   participantPhoneForDm?: string,
 *   participantKey?: string,
 *   messageSender?: string,
 *   userPhone?: string,
 *   conversationCustomerNumber?: string,
 * }} adapted
 * @returns {Promise<object | null>}
 */
async function buildPlaywrightSchedulePayload(adapted) {
  if (PIPELINE_FORWARD_DISABLED) {
    console.log(
      "[Playwright] forwardPlaywrightGroupToPipeline disabled (PLAYWRIGHT_DISABLE_PIPELINE_FORWARD)"
    );
    globalThis.__isProcessingAI = false;
    return null;
  }
  const ownerUserId = resolveOwnerUid();
  if (!ownerUserId) {
    console.error(
      "[Playwright] pipeline bridge: set PLAYWRIGHT_OWNER_USER_ID (or LEGACY_BUSINESS_FIREBASE_UID / WHATSAPP_GROUP_FALLBACK_OWNER_UID)"
    );
    return null;
  }

  const sendCredentials =
    adapted?.__sendCredentialsForTests && typeof adapted.__sendCredentialsForTests === "object"
      ? adapted.__sendCredentialsForTests
      : await getBusinessWhatsAppCredentials(db, ownerUserId);
  const hasCloudCreds = Boolean(
    sendCredentials?.accessToken && sendCredentials?.phoneNumberId
  );
  if (!hasCloudCreds) {
    console.warn(
      "[Playwright] pipeline bridge: Cloud API credentials not configured — continuing in WA Web (Playwright) only mode"
    );
  }

  if (!adapted?.playwrightWebTitleIdentity) {
    console.error(
      "[Playwright] pipeline bridge: playwrightWebTitleIdentity is required"
    );
    return null;
  }

  const groupName = String(adapted?.groupName ?? "").trim() || "unknown-group";
  if (groupName === "unknown-group") {
    console.error("INVALID — missing groupName (chat title)");
    return null;
  }

  const playwrightChatKey =
    String(adapted?.playwrightChatKey ?? "").trim() ||
    normalizeTitle(groupName);
  const normalizedGroupChatKey = playwrightChatKey || groupName;

  const senderName = String(adapted?.senderName ?? adapted?.sender ?? "user").trim() || "user";
  // Only a DOM sender anchor scoped to this group, or a verified participant
  // phone, is trusted for reusable participant memory. Display names,
  // first-seen keys and the group chat key are not participant identities.
  const senderScope =
    groupSenderScopeFromAnchor(normalizedGroupChatKey, adapted?.senderAnchor) ||
    (adapted?.participantPhoneForDm
      ? groupParticipantScope(adapted.participantPhoneForDm)
      : "");
  const participantIdentity = resolveParticipantIdentity({
    participantPhone: adapted?.participantPhoneForDm,
    participantKey: adapted?.participantKey,
    participantName: senderName,
    senderName,
    senderAnchor: adapted?.senderAnchor,
    messageSender: adapted?.messageSender,
    groupChatKey: normalizedGroupChatKey,
    senderScope: senderScope ? String(senderScope).trim() : "",
  });
  const participantPhoneForDm = participantIdentity.participantPhone || "";
  const identityParticipantKey = String(participantIdentity.participantKey ?? "").trim();
  // Reusable Group identity requires trusted sender evidence on this turn
  // (DOM/JID senderAnchor or verified phone → senderScope). Extracted
  // first-seen / display-name keys are not durable and must not be preserved.
  const participantKey = senderScope ? `scope::${senderScope}` : "";
  if (participantKey) {
    console.log("[participant_identity_stable_key_selected]", {
      groupChatKey: String(normalizedGroupChatKey ?? "").trim() || null,
      participantName: participantIdentity.participantName || senderName || null,
      participantKey: String(participantKey).slice(0, 64),
      participantPhonePresent: Boolean(participantPhoneForDm),
      keySource: senderScope ? "senderScope" : "participantIdentity",
    });
  }

  const groupSessionKey =
    String(process.env.PLAYWRIGHT_SESSION_KEY ?? "").trim() ||
    sessionKeyForGroup(ownerUserId, groupName);
  const participantSessionKey = buildParticipantSessionKey({
    businessId: ownerUserId,
    groupChatKey: playwrightChatKey || groupName || groupSessionKey,
    participantKey,
  });
  const unresolvedTurnScope = participantKey
    ? ""
    : unresolvedParticipantTurnScope(normalizedGroupChatKey, adapted);
  const sessionKey =
    participantSessionKey ||
    `${groupSessionKey}::participant::unresolved::${unresolvedTurnScope}`;
  if (!participantKey) {
    console.warn("[participant_identity_unresolved_fail_closed]", {
      groupChatKey: playwrightChatKey || null,
      participantName: senderName || null,
      messageId: adapted?.messageId ?? null,
      reason: "MISSING_STABLE_SENDER_ANCHOR_OR_PHONE",
    });
  } else if (!identityParticipantKey) {
    console.log("[participant_identity_fallback_key_used]", {
      groupChatKey: playwrightChatKey || null,
      participantName: senderName || null,
      participantKeyPreview: String(participantKey).slice(0, 32),
      fallback: "senderScope",
    });
  }
  const normalizedInbound = normalizeInboundMessage({
    source: "playwright",
    message: String(adapted?.text ?? "").trim(),
    messageId: adapted?.messageId,
    userId: ownerUserId,
    sessionKey,
    chatId: String(playwrightChatKey ?? "").trim() || groupName,
    timestamp: adapted?.timestamp,
  });

  const recentForClassifier = Array.isArray(adapted?.recentMessages)
    ? adapted.recentMessages
    : Array.isArray(adapted?.contextMessages)
      ? adapted.contextMessages
      : [];
  let inboundIntent = null;
  let inboundEntity = null;
  let resetTopicContext = false;
  try {
    const mod = await import("../intentEntityClassifier.js");
    const classifyIntentWithAI = mod?.classifyIntentWithAI;
    const applyPlaywrightClassifierToSession = mod?.applyPlaywrightClassifierToSession;
    if (typeof classifyIntentWithAI === "function" && typeof applyPlaywrightClassifierToSession === "function") {
      const classified = await classifyIntentWithAI({
        message: String(adapted?.text ?? "").trim(),
        context: recentForClassifier,
      });
      const classifierSessionKey = sessionKey || playwrightChatKey;
      const applied = applyPlaywrightClassifierToSession(classifierSessionKey, classified) || {};
      resetTopicContext = Boolean(applied.resetTopicContext);
      inboundEntity = applied.inboundEntity ?? null;
      inboundIntent = applied.inboundIntent ?? null;
    }
  } catch {
    // Classifier is optional; continue without it (preserves existing fallback behavior).
  }

  const conversationCustomerNumber = `grp${createHash("sha256")
    .update(`${groupName}::${senderScope || `unresolved::${unresolvedTurnScope}`}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  const hadPhoneLookingSenderName = looksLikePhoneLabel(senderName);
  const safeText = String(adapted?.text ?? "").trim();
  const line = safeText;
  if (hadPhoneLookingSenderName) {
    console.log("[group_sender_phone_label_stripped]", {
      groupChatKey: playwrightChatKey || null,
      hadPhoneLookingSenderName,
      participantPhonePresent: Boolean(participantPhoneForDm),
      textPreview: safeText.slice(0, 120) || null,
    });
  }
  console.log("🧠 Session isolation:", {
    chatId: groupName,
    senderScope,
    isGroupChat: true,
  });
  console.log("[group_context_participant_key]", {
    groupChatKey: playwrightChatKey,
    participantKey: participantKey || null,
    participantName: participantIdentity.participantName || senderName || null,
    hasParticipantPhone: Boolean(participantPhoneForDm),
    sessionKey,
    confidence: participantIdentity.confidence,
    source: participantIdentity.source,
  });
  console.log("[participant_session_key_resolved]", {
    groupChatKey: playwrightChatKey,
    participantKey: participantKey || null,
    sessionKey,
  });
  return {
    payload: {
      db,
      ownerUserId,
      userPhone: "unknown",
      participantName: participantIdentity.participantName || senderName,
      participantDisplayName: participantIdentity.participantName || senderName,
      participantKey,
      sourceParticipantKey: participantKey || undefined,
      senderScope,
      sourceSenderScope: senderScope || undefined,
      ...(participantPhoneForDm
        ? { participantPhoneForDm }
        : {}),
      sessionKey,
      sendCredentials: {
        accessToken: sendCredentials?.accessToken ?? "",
        phoneNumberId: sendCredentials?.phoneNumberId ?? "",
      },
      phoneNumberId: sendCredentials?.phoneNumberId || null,
      text: line,
      isGroupMessage: true,
      playwrightWebInbound: true,
      playwrightWebTitleIdentity: true,
      whatsappReplyTo: null,
      whatsappRecipientType: "group",
      conversationCustomerNumber,
      groupName,
      trackingKey: sessionKey,
      chatName: groupName,
      messageId: normalizedInbound.messageId,
      messageTimestamp: normalizedInbound.timestamp,
      messageSender: "user",
      inboundIntent,
      inboundEntity,
      resetTopicContext,
      playwrightChatKey,
      playwrightForwardedAt: Date.now(),
      sourceRowKey:
        adapted?.sourceRowKey != null && String(adapted.sourceRowKey).trim() !== ""
          ? String(adapted.sourceRowKey).trim()
          : null,
      sourceMessageIndex:
        adapted?.sourceMessageIndex != null &&
        Number.isFinite(Number(adapted.sourceMessageIndex))
          ? Number(adapted.sourceMessageIndex)
          : null,
      inboundSourceOrigin:
        adapted?.inboundSourceOrigin != null &&
        String(adapted.inboundSourceOrigin).trim() !== ""
          ? String(adapted.inboundSourceOrigin).trim()
          : INBOUND_SOURCE_REAL_CUSTOMER,
      startupCatchup: Boolean(adapted?.startupCatchup),
      suppressAckNoopOutbound: Boolean(adapted?.suppressAckNoopOutbound),
      cursorLastAssistantOutboundTrace:
        adapted?.cursorLastAssistantOutboundTrace &&
        typeof adapted.cursorLastAssistantOutboundTrace === "object"
          ? adapted.cursorLastAssistantOutboundTrace
          : null,
    },
    line,
    groupName,
    ownerUserId,
    sendCredentials,
    sessionKey,
    conversationCustomerNumber,
  };
}

/**
 * @param {{
 *   text: string,
 *   sender?: string,
 *   senderName?: string,
 *   timestamp: string | null,
 *   groupName: string,
 *   messageId?: string | number,
 *   playwrightWebTitleIdentity?: boolean,
 *   recentMessages?: string[],
 *   contextMessages?: string[],
 *   playwrightChatKey?: string,
 *   sourceRowKey?: string,
 * }} adapted
 */
export async function forwardPlaywrightGroupToPipeline(adapted) {
  if (WHATSAPP_MODE === "cloud") {
    console.log(
      "[Playwright] forward skipped (WHATSAPP_MODE=cloud) — Cloud API is source of truth"
    );
    return false;
  }
  const built = await buildPlaywrightSchedulePayload(adapted);
  if (!built) {
    return false;
  }

  try {
    const scheduleBufferedWhatsAppInbound =
      typeof adapted?.__scheduleForTests === "function"
        ? adapted.__scheduleForTests
        : (await import("../whatsappInboundBuffer.js"))?.scheduleBufferedWhatsAppInbound;
    if (typeof scheduleBufferedWhatsAppInbound !== "function") {
      throw new Error("scheduleBufferedWhatsAppInbound_missing");
    }
    scheduleBufferedWhatsAppInbound(built.payload);
    console.log("[Playwright] Forwarded to pipeline");
    return true;
  } catch (err) {
    console.error("[Playwright] pipeline bridge error:", err?.message || err);
    console.log("⚠️ Direct pipeline fallback");
    try {
      const mod = await import("../whatsappInboundBuffer.js");
      const executeWhatsAppAiPipeline = mod?.executeWhatsAppAiPipeline;
      if (typeof executeWhatsAppAiPipeline !== "function") {
        throw new Error("executeWhatsAppAiPipeline_missing");
      }
      await executeWhatsAppAiPipeline({
        db: built.payload.db,
        ownerUserId: built.payload.ownerUserId,
        userPhone: built.payload.userPhone,
        participantPhoneForDm: built.payload.participantPhoneForDm,
        participantName: built.payload.participantName,
        participantKey: built.payload.participantKey,
        senderScope: built.payload.senderScope,
        sessionKey: built.payload.sessionKey,
        combinedMessage: built.line,
        structuredSnapshot: "",
        sendCredentials: built.payload.sendCredentials,
        phoneNumberId: built.payload.phoneNumberId,
        fragmentCount: 1,
        hasMultipleFragments: false,
        isGreetingFirst: false,
        isGroupMessage: built.payload.isGroupMessage,
        playwrightWebInbound: built.payload.playwrightWebInbound,
        playwrightWebTitleIdentity: built.payload.playwrightWebTitleIdentity,
        messageId: built.payload.messageId,
        messageTimestamp: built.payload.messageTimestamp,
        whatsappReplyTo: null,
        whatsappRecipientType: built.payload.whatsappRecipientType,
        conversationCustomerNumber: built.conversationCustomerNumber,
        trackingKey: built.payload.trackingKey,
        chatName: built.payload.chatName,
        groupName: built.payload.groupName,
        inboundIntent: built.payload.inboundIntent,
        inboundEntity: built.payload.inboundEntity,
        resetTopicContext: built.payload.resetTopicContext,
        playwrightChatKey: built.payload.playwrightChatKey,
        playwrightForwardedAt: built.payload.playwrightForwardedAt,
        sourceRowKey: built.payload.sourceRowKey,
        sourceMessageIndex: built.payload.sourceMessageIndex,
      });
      console.log("[Playwright] Fallback executeWhatsAppAiPipeline completed");
      return true;
    } catch (fallbackErr) {
      console.error(
        "[Playwright] Fallback pipeline error:",
        fallbackErr?.message || fallbackErr
      );
      return false;
    }
  }
}

/**
 * Forward a Playwright-captured **private DM** message into scheduleBufferedWhatsAppInbound.
 * This is additive only and does NOT change the existing group payload shape.
 *
 * @param {{
 *   message: string,
 *   dmChatTitle?: string | null,
 *   dmPlaywrightChatKey?: string | null,
 *   bookingHint?: {
 *     bookingId?: string | null,
 *     participantKey?: string | null,
 *     participantName?: string | null,
 *     participantPhoneForDm?: string | null,
 *     originalGroupName?: string | null,
 *     originalGroupChatKey?: string | null,
 *   } | null,
 *   source?: string | null,
 * }} p
 */
export async function forwardPlaywrightDmToPipeline(p = {}) {
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  if (WHATSAPP_MODE === "cloud") {
    console.log(
      "[Playwright] DM forward skipped (WHATSAPP_MODE=cloud) — Cloud API is source of truth"
    );
    return false;
  }
  if (PIPELINE_FORWARD_DISABLED) {
    console.log(
      "[Playwright] DM forward disabled (PLAYWRIGHT_DISABLE_PIPELINE_FORWARD)"
    );
    globalThis.__isProcessingAI = false;
    return false;
  }

  const ownerUserId = resolveOwnerUid();
  if (!ownerUserId) return false;

  const dmChatTitle = clean(p?.dmChatTitle);
  const dmPlaywrightChatKey =
    clean(p?.dmPlaywrightChatKey) || normalizeTitle(dmChatTitle);
  if (!dmPlaywrightChatKey) return false;

  const message = clean(p?.message);
  if (!message) return false;

  const bookingHint =
    p?.bookingHint && typeof p.bookingHint === "object" ? p.bookingHint : null;
  const participantPhoneForDm = clean(bookingHint?.participantPhoneForDm);
  const participantName =
    clean(bookingHint?.participantName) || dmChatTitle || "customer";
  const participantKey =
    clean(bookingHint?.participantKey) || dmPlaywrightChatKey || "";

  const sessionKey = participantPhoneForDm
    ? chatSessionKey(ownerUserId, `dm::${participantPhoneForDm}`)
    : chatSessionKey(ownerUserId, `dm::${dmPlaywrightChatKey}`);

  try {
    const schedule =
      typeof p?.__scheduleForTests === "function"
        ? p.__scheduleForTests
        : (await import("../whatsappInboundBuffer.js"))?.scheduleBufferedWhatsAppInbound;
    if (typeof schedule !== "function") {
      throw new Error("scheduleBufferedWhatsAppInbound_missing");
    }
    schedule({
      db,
      ownerUserId,
      userPhone: "unknown",
      participantName,
      participantKey: participantKey || undefined,
      ...(participantPhoneForDm ? { participantPhoneForDm } : {}),
      senderScope: dmPlaywrightChatKey,
      sessionKey,
      sendCredentials: { accessToken: "", phoneNumberId: "" },
      phoneNumberId: null,
      text: message,
      isGroupMessage: false,
      // DM continuation originates from WhatsApp Web (Playwright) and must be eligible
      // for WA Web outbound delivery (strictly gated at send time).
      playwrightWebInbound: true,
      playwrightWebTitleIdentity: false,
      whatsappReplyTo: null,
      whatsappRecipientType: "individual",
      conversationCustomerNumber: participantPhoneForDm || dmPlaywrightChatKey,
      trackingKey: sessionKey,
      chatName: dmChatTitle || dmPlaywrightChatKey,
      messageId: `pw-dm::${dmPlaywrightChatKey}::${Date.now()}`,
      messageTimestamp: Date.now(),
      messageSender: "user",
      inboundIntent: null,
      inboundEntity: null,
      resetTopicContext: false,
      playwrightChatKey: null,
      dmChatTitle: dmChatTitle || null,
      dmPlaywrightChatKey: dmPlaywrightChatKey || null,
      source: clean(p?.source) || "PLAYWRIGHT_DM",
      bookingHint: bookingHint
        ? {
            bookingId: clean(bookingHint?.bookingId) || null,
            participantKey: clean(bookingHint?.participantKey) || null,
            participantName: clean(bookingHint?.participantName) || null,
            originalGroupName: clean(bookingHint?.originalGroupName) || null,
            originalGroupChatKey: clean(bookingHint?.originalGroupChatKey) || null,
          }
        : null,
    });
    return true;
  } catch (err) {
    console.warn("[playwright_dm_continuation_forward_failed]", {
      dmPlaywrightChatKey: dmPlaywrightChatKey || null,
      reason: clean(err?.message ?? err) || "SCHEDULE_FAILED",
    });
    return false;
  }
}
