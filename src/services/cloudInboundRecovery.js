/**
 * Cloud post-confirm recovery using the existing inbound-turn ledger.
 * No reply generation lives here: failed processing re-enters the same pipeline,
 * while outbound_locked recovery is send-only.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  claimOutboundLockedRecovery,
  classifyOutboundLockedRecovery,
  listRecoverableCloudInboundTurns,
  markCloudInboundTurnRetryableFailure,
  markCloudInboundTurnTerminalTechnicalFailure,
  markOutboundLockedRecoverySent,
  markOutboundSendInFlight,
  markOutboundUncertainManualReview,
  releaseOutboundLockedRecoveryClaim,
} from "./inboundTurnLedger.js";
import { appendConversationMessage } from "./conversationStore.js";
import { sendOutboundMessage } from "./messagingService.js";

function hashReply(text, salt) {
  return createHash("sha256")
    .update(String(text ?? ""), "utf8")
    .update("\u0000", "utf8")
    .update(String(salt ?? ""), "utf8")
    .digest("hex");
}

export async function tryRecoverCloudOutboundLockedTurn({
  db,
  entry,
  sendCredentials,
  __sendOutboundMessageFn = sendOutboundMessage,
  __appendConversationMessageFn = appendConversationMessage,
} = {}) {
  const classified = classifyOutboundLockedRecovery(entry);
  const identity = {
    chatKey: entry?.chatKey,
    stableId: entry?.stableId,
    guaranteeKey: entry?.guaranteeKey,
  };

  if (classified.action === "complete_ledger") {
    markOutboundLockedRecoverySent({
      force: true,
      chatKey: entry.chatKey,
      stableId: entry.stableId,
      guaranteeKey: classified.guaranteeKey || entry.guaranteeKey,
      textPreview: entry.textPreview,
      providerOutboundMessageId: classified.providerOutboundMessageId,
    });
    return {
      recovered: true,
      sent: false,
      action: "complete_ledger",
      reason: classified.reason,
    };
  }

  if (classified.action === "uncertain_fail_closed") {
    // Meta request may have started without a durable provider receipt.
    // Do not resend. Keep outbound_locked + finalReplyText for manual review.
    markOutboundUncertainManualReview({
      chatKey: entry.chatKey,
      stableId: entry.stableId,
      reason: classified.reason || "send_in_flight_without_provider_receipt",
      deliveryStatus: "uncertain_delivery_manual_review",
    });
    return {
      recovered: false,
      sent: false,
      action: "uncertain_fail_closed",
      reason: classified.reason,
      residualLimitation:
        "at_most_once_after_send_in_flight_without_provider_receipt",
    };
  }

  if (classified.action === "corrupted_locked_reply") {
    markCloudInboundTurnTerminalTechnicalFailure({
      identity,
      lastError: "corrupted_outbound_locked_missing_reply",
      deliveryStatus: "corrupted_outbound_locked",
    });
    return {
      recovered: false,
      sent: false,
      action: "corrupted_locked_reply",
      reason: classified.reason,
    };
  }

  if (classified.action === "lease_held") {
    return {
      recovered: false,
      sent: false,
      action: "lease_held",
      reason: classified.reason,
    };
  }

  if (classified.action !== "resume_send") {
    return {
      recovered: false,
      sent: false,
      action: classified.action,
      reason: classified.reason,
    };
  }
  const context =
    entry?.cloudRecoveryContext &&
    typeof entry.cloudRecoveryContext === "object"
      ? entry.cloudRecoveryContext
      : {};
  const claimOwner = `cloud-recovery:${randomUUID()}`;
  const claim = claimOutboundLockedRecovery({
    force: true,
    chatKey: entry.chatKey,
    stableId: entry.stableId,
    claimOwner,
  });
  if (!claim.claimed) {
    return {
      recovered: false,
      sent: false,
      action: "noop",
      reason: claim.reason,
    };
  }

  try {
    const credentials =
      sendCredentials && typeof sendCredentials === "object"
        ? sendCredentials
        : {};
    const replyText = classified.finalReplyText;
    const guaranteeKey =
      String(classified.guaranteeKey ?? entry.guaranteeKey ?? "").trim();
    // Persist in-flight only when the network request is about to begin.
    markOutboundSendInFlight({
      force: true,
      chatKey: entry.chatKey,
      stableId: entry.stableId,
      claimOwner,
      outboundLockStage: "cloud_outbound_locked_recovery_send",
    });
    const sendResult = await __sendOutboundMessageFn({
      sendVia: "CLOUD_API",
      reply: replyText,
      messageMeta: {
        finalReplySource:
          String(entry.finalReplySource ?? "").trim() ||
          "openai_post_confirm_pa",
        outboundTrace: {
          kind: "cloud_outbound_locked_recovery",
          finalReplySource:
            String(entry.finalReplySource ?? "").trim() ||
            "openai_post_confirm_pa",
        },
      },
      dmRecipientPhone: null,
      context: {
        isTabInbound: false,
        unknownPhone: false,
        isGroupMessage: false,
        playwrightWebInbound: false,
        groupNameResolved: "",
        accessToken: String(credentials.accessToken ?? ""),
        phoneNumberIdForSend: String(credentials.phoneNumberId ?? ""),
        sendTarget: String(
          context.whatsappReplyTo ?? context.customerPhone ?? ""
        ).trim(),
        whatsappReplyTo: String(
          context.whatsappReplyTo ?? context.customerPhone ?? ""
        ).trim(),
        channel: "whatsapp",
        fallbackDmTo: String(context.customerPhone ?? "").trim(),
        whatsappRecipientType: "individual",
        userPhone: String(context.userPhone ?? context.customerPhone ?? "").trim(),
        sessionKey:
          String(context.sessionKey ?? "").trim() || guaranteeKey,
        messageHash: hashReply(replyText, guaranteeKey),
        dedupeWindowMs: 8000,
        lastPlaywrightTextSends: new Map(),
        guaranteeKey,
        outboundLifecycle: {
          stage: "cloud_outbound_locked_recovery",
          guaranteeKey,
          chatKey: entry.chatKey,
          stableId: entry.stableId,
        },
      },
    });
    if (sendResult?.ok === true) {
      markOutboundLockedRecoverySent({
        force: true,
        chatKey: entry.chatKey,
        stableId: entry.stableId,
        guaranteeKey,
        textPreview: entry.textPreview,
        providerOutboundMessageId:
          sendResult?.providerMessageId ??
          sendResult?.messages?.[0]?.id ??
          null,
      });
      if (
        db &&
        typeof __appendConversationMessageFn === "function" &&
        String(context.businessId ?? "").trim() &&
        String(
          context.conversationCustomerNumber ?? context.customerPhone ?? ""
        ).trim()
      ) {
        try {
          await __appendConversationMessageFn(db, {
            ownerUserId: String(context.businessId ?? "").trim(),
            customerNumber: String(
              context.conversationCustomerNumber ?? context.customerPhone ?? ""
            ).trim(),
            role: "assistant",
            text: replyText,
          });
        } catch (historyErr) {
          console.warn("[cloud_inbound_recovery_history_failed]", {
            error: String(
              historyErr?.message ?? historyErr ?? "history_write_failed"
            ).slice(0, 160),
          });
        }
      }
      return {
        recovered: true,
        sent: true,
        action: "resumed_send",
        reason: "pending_send_resumed",
        replyText,
      };
    }
    releaseOutboundLockedRecoveryClaim({
      force: true,
      chatKey: entry.chatKey,
      stableId: entry.stableId,
      claimOwner,
      resetToPending: true,
    });
    const failed = markCloudInboundTurnRetryableFailure({
      identity: {
        chatKey: entry.chatKey,
        stableId: entry.stableId,
        guaranteeKey,
      },
      lastError: "cloud_send_failed",
      retryDelayMs: 1000,
    });
    return {
      recovered: false,
      sent: false,
      action: "send_failed",
      reason: "cloud_send_failed",
      replyText,
      retryCount: Number(failed?.retryCount ?? 0),
      nextRetryAt: Number(failed?.nextRetryAt ?? 0) || null,
    };
  } catch (err) {
    // Network may have started after send_in_flight; do not blind-resend.
    markOutboundUncertainManualReview({
      chatKey: entry.chatKey,
      stableId: entry.stableId,
      reason: String(err?.message ?? err ?? "cloud_send_exception").slice(0, 160),
      deliveryStatus: "uncertain_delivery_manual_review",
    });
    return {
      recovered: false,
      sent: false,
      action: "uncertain_fail_closed",
      reason: String(err?.message ?? err ?? "cloud_send_exception").slice(
        0,
        160
      ),
      residualLimitation:
        "at_most_once_after_send_in_flight_without_provider_receipt",
    };
  }
}

function buildPipelinePayload(entry, db, sendCredentials) {
  const context =
    entry?.cloudRecoveryContext &&
    typeof entry.cloudRecoveryContext === "object"
      ? entry.cloudRecoveryContext
      : {};
  const messageText = String(context.messageText ?? "").trim();
  return {
    db,
    ownerUserId: String(context.businessId ?? "").trim(),
    userPhone: String(context.userPhone ?? context.customerPhone ?? "").trim(),
    sessionKey: String(context.sessionKey ?? "").trim(),
    sendCredentials,
    phoneNumberId:
      String(context.phoneNumberId ?? sendCredentials?.phoneNumberId ?? "").trim() ||
      null,
    combinedMessage: messageText,
    latestMessage: messageText,
    contextMessages: [],
    structuredSnapshot: messageText,
    isGroupMessage: false,
    whatsappReplyTo: String(
      context.whatsappReplyTo ?? context.customerPhone ?? ""
    ).trim(),
    whatsappRecipientType: "individual",
    conversationCustomerNumber: String(
      context.conversationCustomerNumber ?? context.customerPhone ?? ""
    ).trim(),
    messageId: String(context.messageId ?? "").trim(),
    fragmentCount: 1,
    hasMultipleFragments: false,
    isGreetingFirst: false,
    __cloudResumeProcessing: true,
    __cloudClaimOwner: String(entry.processingOwner ?? "").trim() || null,
  };
}

/**
 * One bounded startup sweep. Timers are only used for not-yet-due persisted
 * retries; each entry remains capped by its ledger retryCount.
 */
export function scheduleCloudInboundRecoverySweep({
  db,
  getCredentialsFn,
  executePipelineFn,
  maxRetryCount = 5,
} = {}) {
  if (
    !db ||
    typeof getCredentialsFn !== "function" ||
    typeof executePipelineFn !== "function"
  ) {
    return [];
  }
  const timers = [];
  const scheduleEntry = (entry, explicitDelay = null) => {
    const run = async () => {
      const context =
        entry.cloudRecoveryContext &&
        typeof entry.cloudRecoveryContext === "object"
          ? entry.cloudRecoveryContext
          : {};
      const credentials = await getCredentialsFn(
        db,
        String(context.businessId ?? "").trim()
      );
      if (!credentials?.accessToken || !credentials?.phoneNumberId) return;
      if (entry.state === "outbound_locked") {
        const recovery = await tryRecoverCloudOutboundLockedTurn({
          db,
          entry,
          sendCredentials: credentials,
        });
        const retryCount = Number(recovery?.retryCount ?? 0);
        if (
          recovery?.action === "send_failed" &&
          retryCount > 0 &&
          retryCount < maxRetryCount
        ) {
          const retryDelay = Math.min(
            30_000,
            500 * 2 ** Math.max(0, retryCount - 1)
          );
          scheduleEntry(entry, retryDelay);
        }
        return;
      }
      await executePipelineFn(buildPipelinePayload(entry, db, credentials));
    };
    const delay =
      explicitDelay != null
        ? Math.max(0, Math.min(30_000, Number(explicitDelay) || 0))
        : Math.max(
            0,
            Math.min(
              30_000,
              Number(entry.nextRetryAt ?? 0) > Date.now()
                ? Number(entry.nextRetryAt) - Date.now()
                : 0
            )
          );
    const timer = setTimeout(() => {
      void run().catch((err) => {
        console.warn("[cloud_inbound_recovery_failed]", {
          error: String(err?.message ?? err ?? "").slice(0, 160),
        });
      });
    }, delay);
    timer.unref?.();
    timers.push(timer);
  };
  for (const entry of listRecoverableCloudInboundTurns({ maxRetryCount })) {
    scheduleEntry(entry);
  }
  return timers;
}
