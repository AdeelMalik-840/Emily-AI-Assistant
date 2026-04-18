/**
 * Forwards Playwright-captured group lines into scheduleBufferedWhatsAppInbound.
 * Identity is **groupName** (visible chat title) + `playwrightWebTitleIdentity`.
 */

import { createHash } from "node:crypto";

import db from "../../config/firebase.js";
import { getBusinessWhatsAppCredentials } from "../businessWhatsApp.js";
import {
  executeWhatsAppAiPipeline,
  scheduleBufferedWhatsAppInbound,
} from "../whatsappInboundBuffer.js";

/** Set PLAYWRIGHT_DISABLE_PIPELINE_FORWARD=true to no-op inbound forwarding (debug only; disables AI pipeline). */
const PIPELINE_FORWARD_DISABLED = /^true$/i.test(
  String(process.env.PLAYWRIGHT_DISABLE_PIPELINE_FORWARD ?? "")
);

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

/**
 * Build schedule payload; returns null if forwarding cannot run.
 * @param {{ text: string, sender?: string, senderName?: string, timestamp: string | null, groupName: string, messageId?: string | number, playwrightWebTitleIdentity?: boolean }} adapted
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

  const messageId = String(adapted?.messageId ?? "").trim();
  if (!messageId) {
    console.log("⛔ Missing messageId in bridge — skipping");
    return null;
  }

  const senderName = String(adapted?.sender ?? adapted?.senderName ?? "user").trim() || "user";

  const sessionKey =
    String(process.env.PLAYWRIGHT_SESSION_KEY ?? "").trim() ||
    sessionKeyForGroup(ownerUserId, groupName);

  const conversationCustomerNumber = `group::${groupName}`;
  const line = `[${senderName}] ${adapted.text}`.trim();

  return {
    payload: {
      db,
      ownerUserId,
      userPhone: "unknown",
      participantName: senderName,
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
      messageId,
      messageTimestamp: adapted?.timestamp ?? null,
      messageSender: "user",
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
 * @param {{ text: string, sender?: string, senderName?: string, timestamp: string | null, groupName: string, messageId?: string | number, playwrightWebTitleIdentity?: boolean }} adapted
 */
export async function forwardPlaywrightGroupToPipeline(adapted) {
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
