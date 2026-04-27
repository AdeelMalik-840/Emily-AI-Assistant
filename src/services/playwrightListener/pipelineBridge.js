/**
 * Forwards Playwright-captured group lines into scheduleBufferedWhatsAppInbound.
 * Identity is **groupName** (visible chat title) + `playwrightWebTitleIdentity`.
 */

import { createHash } from "node:crypto";

import db from "../../config/firebase.js";
import { normalizeTitle } from "../playwrightTitleNormalize.js";
import { getBusinessWhatsAppCredentials } from "../businessWhatsApp.js";
import {
  applyPlaywrightClassifierToSession,
  classifyIntentWithAI,
} from "../intentEntityClassifier.js";
import {
  executeWhatsAppAiPipeline,
  scheduleBufferedWhatsAppInbound,
} from "../whatsappInboundBuffer.js";
import { normalizeInboundMessage } from "../inboundNormalizer.js";

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

function groupParticipantScope(senderId) {
  return createHash("sha256")
    .update(normalizeSenderId(senderId) || "unknown-sender", "utf8")
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
 *   participantPhoneForDm?: string,
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

  const sendCredentials = await getBusinessWhatsAppCredentials(db, ownerUserId);
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

  const senderName = String(adapted?.sender ?? adapted?.senderName ?? "user").trim() || "user";
  const uniqueSenderIdRaw =
    adapted?.participantPhoneForDm ||
    adapted?.messageSender ||
    adapted?.userPhone ||
    adapted?.conversationCustomerNumber ||
    adapted?.playwrightChatKey ||
    "";
  const anonBase = normalizeSenderId(adapted?.senderName || adapted?.sender || "unknown");
  const anonId = createHash("sha256")
    .update(`${anonBase}::${groupName}`, "utf8")
    .digest("hex")
    .slice(0, 6);
  const uniqueSenderId =
    normalizeSenderId(uniqueSenderIdRaw) ||
    `anon::${anonBase}::${anonId}`;
  const senderScope = groupParticipantScope(uniqueSenderId);
  const playwrightChatKey =
    String(adapted?.playwrightChatKey ?? "").trim() ||
    normalizeTitle(groupName);

  const groupSessionKey =
    String(process.env.PLAYWRIGHT_SESSION_KEY ?? "").trim() ||
    sessionKeyForGroup(ownerUserId, groupName);
  const sessionKey = `${groupSessionKey}::${senderScope}`;
  const normalizedInbound = normalizeInboundMessage({
    source: "playwright",
    message: String(adapted?.text ?? "").trim(),
    messageId: adapted?.messageId,
    userId: ownerUserId,
    sessionKey,
    chatId: String(adapted?.playwrightChatKey ?? "").trim() || groupName,
    timestamp: adapted?.timestamp,
  });

  const recentForClassifier = Array.isArray(adapted?.recentMessages)
    ? adapted.recentMessages
    : Array.isArray(adapted?.contextMessages)
      ? adapted.contextMessages
      : [];
  const classified = await classifyIntentWithAI({
    message: String(adapted?.text ?? "").trim(),
    context: recentForClassifier,
  });
  const classifierSessionKey = playwrightChatKey || sessionKey;
  const { resetTopicContext, inboundEntity, inboundIntent } =
    applyPlaywrightClassifierToSession(classifierSessionKey, classified);

  const conversationCustomerNumber = `grp${createHash("sha256")
    .update(`${groupName}::${senderScope}`, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
  const line = `[${senderName}] ${adapted.text}`.trim();
  console.log("🧠 Session isolation:", {
    chatId: groupName,
    senderScope,
    isGroupChat: true,
  });
  return {
    payload: {
      db,
      ownerUserId,
      userPhone: "unknown",
      participantName: senderName,
      senderScope,
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
    scheduleBufferedWhatsAppInbound(built.payload);
    console.log("[Playwright] Forwarded to pipeline");
    return true;
  } catch (err) {
    console.error("[Playwright] pipeline bridge error:", err?.message || err);
    console.log("⚠️ Direct pipeline fallback");
    try {
      await executeWhatsAppAiPipeline({
        db: built.payload.db,
        ownerUserId: built.payload.ownerUserId,
        userPhone: built.payload.userPhone,
        participantPhoneForDm: undefined,
        participantName: built.payload.participantName,
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
