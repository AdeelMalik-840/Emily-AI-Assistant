/**
 * Resume an outbound_locked inbound turn without re-running Brain or actions.
 *
 * Uses the existing inbound-turn ledger (persisted finalReplyText) and the
 * Playwright outbound registry (echo evidence). No parallel dedupe store.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  classifyOutboundLockedRecovery,
  claimOutboundLockedRecovery,
  getInboundTurnLedgerEntry,
  markOutboundLockedRecoverySent,
  markOutboundSendInFlight,
  markOutboundUncertainManualReview,
  parseGuaranteeKeyParts,
  releaseOutboundLockedRecoveryClaim,
} from "./inboundTurnLedger.js";
import { isRegisteredPlaywrightOutboundEcho } from "./playwrightOutboundRegistry.js";
import { sendViaPlaywright } from "./adapters/playwrightAdapter.js";
import { setMessageState } from "./messageState.js";

/** @type {Map<string, Promise<unknown>>} */
const inFlightByKey = new Map();

function hashReply(text, salt) {
  return createHash("sha256")
    .update(String(text ?? ""), "utf8")
    .update("\u0000", "utf8")
    .update(String(salt ?? ""), "utf8")
    .digest("hex");
}

/**
 * @param {{
 *   chatKey?: string,
 *   stableId?: string,
 *   guaranteeKey?: string,
 *   claimOwner?: string,
 *   __testSendPlaywrightGroupText?: Function,
 *   lastPlaywrightTextSends?: Map<string, { hash: string, timestamp: number }>,
 * }} p
 * @returns {Promise<{
 *   recovered: boolean,
 *   action: string,
 *   reason: string,
 *   sent: boolean,
 *   replyText?: string,
 * }>}
 */
export async function tryRecoverOutboundLockedInboundTurn(p = {}) {
  const guaranteeKey = String(p.guaranteeKey ?? "").trim();
  let chatKey = String(p.chatKey ?? "").trim();
  let stableId = String(p.stableId ?? "").trim();
  if ((!chatKey || !stableId) && guaranteeKey) {
    const parts = parseGuaranteeKeyParts(guaranteeKey);
    chatKey = parts.chatKey;
    stableId = parts.stableId;
  }
  if (!chatKey || !stableId) {
    return {
      recovered: false,
      action: "noop",
      reason: "missing_chat_or_stable_id",
      sent: false,
    };
  }

  const mapKey = `${chatKey}::${stableId}`;
  if (inFlightByKey.has(mapKey)) {
    // Do not await the in-flight promise — callers need an immediate noop so a
    // second worker cannot deadlock waiting on a send still in progress.
    return {
      recovered: false,
      action: "noop",
      reason: "recovery_already_in_flight",
      sent: false,
    };
  }

  const run = doRecoverOutboundLockedInboundTurn({
    chatKey,
    stableId,
    guaranteeKey,
    claimOwner: String(p.claimOwner ?? "").trim() || `recovery:${randomUUID()}`,
    __testSendPlaywrightGroupText: p.__testSendPlaywrightGroupText,
    lastPlaywrightTextSends: p.lastPlaywrightTextSends,
  });
  inFlightByKey.set(mapKey, run);
  try {
    return await run;
  } finally {
    inFlightByKey.delete(mapKey);
  }
}

/**
 * @param {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string,
 *   claimOwner: string,
 *   __testSendPlaywrightGroupText?: Function,
 *   lastPlaywrightTextSends?: Map<string, { hash: string, timestamp: number }>,
 * }} p
 */
async function doRecoverOutboundLockedInboundTurn(p) {
  const entry = getInboundTurnLedgerEntry(p.chatKey, p.stableId);
  const groupForEcho =
    String(entry?.groupChatKey ?? p.chatKey ?? "").trim() || p.chatKey;
  const replyForEcho = String(entry?.finalReplyText ?? "").trim();
  const hasOutboundEcho =
    Boolean(replyForEcho) &&
    isRegisteredPlaywrightOutboundEcho(groupForEcho, replyForEcho);

  const classified = classifyOutboundLockedRecovery(entry, { hasOutboundEcho });

  if (classified.action === "complete_ledger") {
    markOutboundLockedRecoverySent({
      chatKey: p.chatKey,
      stableId: p.stableId,
      guaranteeKey: classified.guaranteeKey || p.guaranteeKey,
      textPreview: entry?.textPreview,
    });
    const gk =
      String(classified.guaranteeKey || p.guaranteeKey || "").trim() ||
      `${p.chatKey}::${p.stableId}`;
    setMessageState(gk, "done");
    console.log("[outbound_locked_recovery_ledger_completed]", {
      chatKey: p.chatKey,
      stableId: p.stableId,
      reason: classified.reason,
      guaranteeKey: gk,
    });
    return {
      recovered: true,
      action: "complete_ledger",
      reason: classified.reason,
      sent: false,
      replyText: classified.finalReplyText || undefined,
    };
  }

  if (classified.action === "uncertain_fail_closed") {
    markOutboundUncertainManualReview({
      chatKey: p.chatKey,
      stableId: p.stableId,
      reason: classified.reason || "send_in_flight_without_provider_receipt",
      deliveryStatus: "uncertain_delivery_manual_review",
    });
    console.warn("[outbound_locked_recovery_uncertain_fail_closed]", {
      chatKey: p.chatKey,
      stableId: p.stableId,
      reason: classified.reason,
    });
    return {
      recovered: false,
      action: "uncertain_fail_closed",
      reason: classified.reason,
      sent: false,
      replyText: classified.finalReplyText || undefined,
    };
  }

  if (classified.action === "lease_held" || classified.action === "corrupted_locked_reply") {
    if (classified.action === "corrupted_locked_reply") {
      markOutboundUncertainManualReview({
        chatKey: p.chatKey,
        stableId: p.stableId,
        reason: classified.reason || "missing_final_reply_text",
        deliveryStatus: "corrupted_outbound_locked",
      });
    }
    return {
      recovered: false,
      action: classified.action,
      reason: classified.reason,
      sent: false,
      replyText: classified.finalReplyText || undefined,
    };
  }

  if (classified.action !== "resume_send") {
    return {
      recovered: false,
      action: "noop",
      reason: classified.reason,
      sent: false,
    };
  }

  const claim = claimOutboundLockedRecovery({
    chatKey: p.chatKey,
    stableId: p.stableId,
    claimOwner: p.claimOwner,
  });
  if (!claim.claimed) {
    return {
      recovered: false,
      action: "noop",
      reason: claim.reason,
      sent: false,
      replyText: classified.finalReplyText,
    };
  }

  const replyText = classified.finalReplyText;
  const destination =
    String(classified.groupChatKey ?? p.chatKey).trim() || p.chatKey;
  const guaranteeKey =
    String(classified.guaranteeKey || p.guaranteeKey || "").trim() ||
    `${p.chatKey}::${p.stableId}`;
  const replyHash =
    classified.replyHash || hashReply(replyText, guaranteeKey);
  const lastPlaywrightTextSends =
    p.lastPlaywrightTextSends instanceof Map
      ? p.lastPlaywrightTextSends
      : new Map();

  try {
    markOutboundSendInFlight({
      chatKey: p.chatKey,
      stableId: p.stableId,
      claimOwner: p.claimOwner,
      outboundLockStage: "outbound_locked_recovery_send",
    });
    const sendResult = await sendViaPlaywright({
      reply: replyText,
      messageMeta: {
        outboundTrace: {
          finalReplySource:
            String(entry?.finalReplySource ?? "").trim() ||
            "OUTBOUND_LOCKED_RECOVERY",
        },
      },
      context: {
        groupNameResolved: destination,
        sessionKey: guaranteeKey,
        messageHash: replyHash,
        dedupeWindowMs: 8000,
        lastPlaywrightTextSends,
        guaranteeKey,
        sourceInboundMessageId: p.stableId,
        outboundLifecycle: {
          stage: "outbound_locked_recovery",
          guaranteeKey,
          chatKey: p.chatKey,
          stableId: p.stableId,
        },
        ...(typeof p.__testSendPlaywrightGroupText === "function"
          ? { __testSendPlaywrightGroupText: p.__testSendPlaywrightGroupText }
          : {}),
      },
    });

    if (sendResult?.ok === true) {
      markOutboundLockedRecoverySent({
        chatKey: p.chatKey,
        stableId: p.stableId,
        guaranteeKey,
        textPreview: entry?.textPreview,
      });
      setMessageState(guaranteeKey, "done");
      console.log("[outbound_locked_recovery_send_ok]", {
        chatKey: p.chatKey,
        stableId: p.stableId,
        guaranteeKey,
        replyChars: replyText.length,
      });
      return {
        recovered: true,
        action: "resumed_send",
        reason: "pending_send_resumed",
        sent: true,
        replyText,
      };
    }

    // Clear failure (ok:false) — release claim and allow a later pending retry.
    releaseOutboundLockedRecoveryClaim({
      chatKey: p.chatKey,
      stableId: p.stableId,
      claimOwner: p.claimOwner,
      resetToPending: true,
    });
    console.warn("[outbound_locked_recovery_send_failed]", {
      chatKey: p.chatKey,
      stableId: p.stableId,
      guaranteeKey,
    });
    return {
      recovered: false,
      action: "send_failed",
      reason: "playwright_send_failed",
      sent: false,
      replyText,
    };
  } catch (err) {
    // Exception during send: treat as uncertain — keep send_attempted, do not reset.
    releaseOutboundLockedRecoveryClaim({
      chatKey: p.chatKey,
      stableId: p.stableId,
      claimOwner: p.claimOwner,
      resetToPending: false,
    });
    console.warn("[outbound_locked_recovery_send_exception]", {
      chatKey: p.chatKey,
      stableId: p.stableId,
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
    return {
      recovered: false,
      action: "uncertain_fail_closed",
      reason: "send_exception_uncertain",
      sent: false,
      replyText,
    };
  }
}

/**
 * Fire-and-forget recovery for listener drop paths (sync filter context).
 * Deduped by chatKey::stableId via tryRecoverOutboundLockedInboundTurn.
 * @param {{ chatKey: string, stableId: string, guaranteeKey?: string }} p
 */
export function scheduleOutboundLockedRecovery(p) {
  const chatKey = String(p?.chatKey ?? "").trim();
  const stableId = String(p?.stableId ?? "").trim();
  if (!chatKey || !stableId) return;
  void tryRecoverOutboundLockedInboundTurn({
    chatKey,
    stableId,
    guaranteeKey: p?.guaranteeKey,
  }).catch((err) => {
    console.warn("[outbound_locked_recovery_schedule_failed]", {
      chatKey,
      stableId,
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
  });
}
