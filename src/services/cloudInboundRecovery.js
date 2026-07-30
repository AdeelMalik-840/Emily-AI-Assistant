/**
 * Cloud post-confirm recovery using the existing inbound-turn ledger.
 * No reply generation lives here: failed processing re-enters the same pipeline,
 * while outbound_locked recovery is send-only.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  claimOutboundLockedRecovery,
  classifyOutboundLockedRecovery,
  getCloudInboundProcessingLeaseExpiresAt,
  getInboundTurnLedgerEntry,
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
            sourceMessageId: String(context.messageId ?? "").trim() || null,
            providerMessageId:
              sendResult?.providerMessageId ??
              sendResult?.messages?.[0]?.id ??
              null,
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
  const queuedOwnershipLifecycle =
    entry?.cloudOwnershipQueue &&
    typeof entry.cloudOwnershipQueue === "object" &&
    entry.cloudOwnershipQueue.mode === "cloud_post_confirm_ownership_queue" &&
    ["queued", "resuming", "retryable"].includes(
      entry.cloudOwnershipQueue.status
    )
      ? entry.cloudOwnershipQueue
      : null;
  const queuedOwnershipResume =
    queuedOwnershipLifecycle?.status === "queued";
  const messageText = String(
    queuedOwnershipLifecycle?.messageText ?? context.messageText ?? ""
  ).trim();
  const customerPhone = String(
    queuedOwnershipLifecycle?.customerPhone ?? context.customerPhone ?? ""
  ).trim();
  return {
    db,
    ownerUserId: String(
      queuedOwnershipLifecycle?.businessId ?? context.businessId ?? ""
    ).trim(),
    userPhone: String(context.userPhone ?? customerPhone).trim(),
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
      context.whatsappReplyTo ?? customerPhone
    ).trim(),
    whatsappRecipientType: "individual",
    conversationCustomerNumber: String(
      context.conversationCustomerNumber ?? customerPhone
    ).trim(),
    messageId: String(
      queuedOwnershipLifecycle?.providerMessageId ?? context.messageId ?? ""
    ).trim(),
    messageTimestamp:
      Number.isFinite(Number(context.messageTimestamp)) &&
      Number(context.messageTimestamp) > 0
        ? Number(context.messageTimestamp)
        : null,
    fragmentCount: 1,
    hasMultipleFragments: false,
    isGreetingFirst: false,
    __cloudResumeProcessing: true,
    __cloudQueuedOwnershipResume: queuedOwnershipResume,
    __cloudClaimOwner:
      String(
        queuedOwnershipLifecycle?.claimOwner ??
          entry.cloudOriginalClaimOwner ??
          entry.processingOwner ??
          ""
      ).trim() || null,
    __cloudOwnershipQueuedAtMs:
      Number(queuedOwnershipLifecycle?.queuedAt ?? 0) || null,
    __cloudOwnershipInitialResolution:
      String(
        queuedOwnershipLifecycle?.latestBookingResolutionReason ?? ""
      ).trim() || null,
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
    const scheduledQueueStatus =
      entry?.cloudOwnershipQueue?.mode ===
      "cloud_post_confirm_ownership_queue"
        ? String(entry.cloudOwnershipQueue.status ?? "").trim()
        : "";
    const run = async () => {
      const currentEntry = getInboundTurnLedgerEntry(
        entry?.chatKey,
        entry?.stableId,
        { force: true }
      );
      if (!currentEntry || currentEntry.state === "done") return;
      const currentQueueStatus =
        currentEntry?.cloudOwnershipQueue?.mode ===
        "cloud_post_confirm_ownership_queue"
          ? String(currentEntry.cloudOwnershipQueue.status ?? "").trim()
          : "";
      if (scheduledQueueStatus === "queued") {
        if (
          currentEntry.state !== "processing" ||
          currentQueueStatus !== "queued"
        ) {
          return;
        }
      } else if (scheduledQueueStatus === "resuming") {
        if (
          currentEntry.state !== "processing" ||
          currentQueueStatus !== "resuming"
        ) {
          return;
        }
        const leaseExpiresAt =
          getCloudInboundProcessingLeaseExpiresAt(currentEntry);
        if (
          Number.isFinite(leaseExpiresAt) &&
          leaseExpiresAt > Date.now()
        ) {
          scheduleEntry(currentEntry, leaseExpiresAt - Date.now());
          return;
        }
      } else if (scheduledQueueStatus === "retryable") {
        if (
          currentEntry.state !== "failed" ||
          currentQueueStatus !== "retryable" ||
          currentEntry.autoRetryAllowed === false
        ) {
          return;
        }
        const nextRetryAt = Number(currentEntry.nextRetryAt ?? 0);
        if (Number.isFinite(nextRetryAt) && nextRetryAt > Date.now()) {
          scheduleEntry(currentEntry, nextRetryAt - Date.now());
          return;
        }
      }
      const context =
        currentEntry.cloudRecoveryContext &&
        typeof currentEntry.cloudRecoveryContext === "object"
          ? currentEntry.cloudRecoveryContext
          : {};
      const credentials = await getCredentialsFn(
        db,
        String(context.businessId ?? "").trim()
      );
      if (!credentials?.accessToken || !credentials?.phoneNumberId) return;
      if (currentEntry.state === "outbound_locked") {
        const recovery = await tryRecoverCloudOutboundLockedTurn({
          db,
          entry: currentEntry,
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
          scheduleEntry(currentEntry, retryDelay);
        }
        return;
      }
      await executePipelineFn(
        buildPipelinePayload(currentEntry, db, credentials)
      );
    };
    const retryDelay =
      explicitDelay != null
        ? Math.max(0, Number(explicitDelay) || 0)
        : Math.max(
            0,
            Number(entry.nextRetryAt ?? 0) > Date.now()
              ? Number(entry.nextRetryAt) - Date.now()
              : 0
          );
    const leaseExpiresAt =
      scheduledQueueStatus === "resuming"
        ? getCloudInboundProcessingLeaseExpiresAt(entry)
        : null;
    const leaseDelay =
      Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()
        ? leaseExpiresAt - Date.now()
        : 0;
    const delay =
      scheduledQueueStatus === "resuming"
        ? Math.max(
            0,
            Math.min(31 * 60 * 1000, Math.max(leaseDelay, retryDelay))
          )
        : Math.max(0, Math.min(30_000, retryDelay));
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
