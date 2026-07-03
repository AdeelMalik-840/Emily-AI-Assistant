/**
 * Emily Brain v2 full live pipeline — sole decision-maker when flagged on.
 * Never falls back to legacy messageProcessor guessing.
 */
import {
  getEmilyBrainV2LiveFlagSnapshot,
  isEmilyBrainV2LegacyFallbackEnabled,
} from "../config/liveFeatureFlags.js";
import { buildTurnContextInput } from "./buildTurnContextInput.js";
import {
  routeAndExecuteLiveActionPlan,
  applyInfoLiveSessionMemoryPatch,
  isLiveWorkflowType,
} from "./actionRouter.js";
import { buildShadowTurnContext } from "../shadow/brainShadowHook.js";
import { runConversationTurn } from "../orchestrator/ConversationOrchestrator.js";
import { executeOutboundReply } from "../../services/executors/outboundReplyExecutor.js";
import { resolveBusinessTurnContext } from "../facts/resolveBusinessTurnContext.js";

const SAFE_APOLOGY =
  "Sorry, main abhi reply nahi bhej pa rahi. Thori der baad dobara try karein please.";
const SAFE_CLARIFICATION =
  "Main samajh nahi paaya — kya aap availability, price, ya booking ke baare mein pooch rahe hain? Kis item ke liye dekh rahe hain?";

/**
 * @typedef {Object} BrainV2LivePipelineResult
 * @property {boolean} handled
 * @property {string} [reply]
 * @property {Record<string, unknown>} [messageMeta]
 * @property {string} [sendVia]
 * @property {string | null} [dmRecipientPhone]
 * @property {string} [reason]
 * @property {string} [workflowType]
 * @property {boolean} [legacyBypassed]
 */

/**
 * @param {{
 *   traceId: string,
 *   businessId: string,
 *   message: string,
 *   messageId?: string | null,
 *   channel?: "whatsapp_web" | "whatsapp_cloud",
 *   chatType?: "group" | "dm",
 *   chatId?: string | null,
 *   sessionKey?: string | null,
 *   participantKey?: string | null,
 *   participantName?: string | null,
 *   participantDisplayName?: string | null,
 *   sourceParticipantKey?: string | null,
 *   sourceParticipantName?: string | null,
 *   sourceParticipantDisplayName?: string | null,
 *   senderScope?: string | null,
 *   sourceSenderScope?: string | null,
 *   participantPhoneForDm?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   isGroupMessage?: boolean,
 *   playwrightWebInbound?: boolean,
 *   hasBookingHint?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   conversationHistory?: string,
 *   catalogItems?: unknown[],
 *   sourceRowKey?: string | null,
 *   sourceMessageIndex?: number | null,
 *   guaranteeKey?: string | null,
 *   groupName?: string | null,
 *   whatsappRecipientType?: string | null,
 *   executionContext?: Record<string, unknown>,
 *   resolveTrustedSessionItem?: (p: Record<string, unknown>) => { ok: boolean, item?: Record<string, unknown> | null, reason?: string | null },
 *   __testOrchestratorFn?: (args: Record<string, unknown>) => unknown,
 *   getBookingsForItemFn?: (businessId: string, itemId: string, itemName?: string | null) => Promise<unknown[]>,
 *   getBusinessProfileFn?: (uid: string) => Promise<unknown>,
 * }} params
 * @returns {Promise<BrainV2LivePipelineResult>}
 */
export async function runBrainV2LivePipeline(params) {
  const flags = getEmilyBrainV2LiveFlagSnapshot();
  const traceId = String(params.traceId ?? "").trim();
  const businessId = String(params.businessId ?? "").trim();
  const message = String(params.message ?? "").trim();
  const channel = params.channel === "whatsapp_cloud" ? "whatsapp_cloud" : "whatsapp_web";
  const chatType =
    params.isGroupInbound === true || params.chatType === "group" ? "group" : "dm";

  if (!message) {
    return buildSilentPipelineResult({ traceId, reason: "EMPTY_MESSAGE" });
  }

  try {
    let catalogItems = Array.isArray(params.catalogItems) ? params.catalogItems : [];
    if (catalogItems.length === 0) {
      const catalogMod = await import("../../services/inventoryService.js");
      catalogItems = await catalogMod.getCachedItemsForUser(businessId);
    }

    const turnContextInput = buildTurnContextInput({
      channel,
      chatType,
      businessId,
      chatId: String(params.chatId ?? params.playwrightChatKey ?? "").trim(),
      messageText: message,
      participantKey: params.participantKey,
      sessionKey: params.sessionKey,
      playwrightChatKey: params.playwrightChatKey,
      isGroupInbound: params.isGroupInbound,
      memorySnapshot: params.memorySnapshot,
      catalogItems,
      sourceMessageId: params.messageId,
      sourceRowKey: params.sourceRowKey,
      guaranteeKey: params.guaranteeKey,
      traceId,
      resolveTrustedSessionItem: params.resolveTrustedSessionItem,
    });

    if (turnContextInput.shouldClarifyItem && turnContextInput.clarificationReply) {
      await resolveBusinessTurnContext({
        traceId,
        businessId,
        rawMessage: message,
        turnContextInput,
        catalogItems,
        flags,
        getBusinessProfileFn: params.getBusinessProfileFn,
        getBookingsForItemFn: params.getBookingsForItemFn,
      });
      return finalizeLivePipelineResult({
        params,
        turnContextInput,
        workflowType: "clarification",
        reply: turnContextInput.clarificationReply,
        finalReplySource: "BRAIN_V2_LIVE_CLARIFY",
        actionPlan: null,
        flags,
        routed: null,
        bookingCreated: null,
      });
    }

    const { evaluateInboundAdmissionContract } = await import("../admission/admissionContract.js");
    const chatKey =
      String(params.playwrightChatKey ?? params.chatId ?? "").trim() ||
      String(params.sessionKey ?? "").trim();

    const admission = evaluateInboundAdmissionContract({
      text: message,
      chatKey,
      businessId,
      participantKey: String(params.participantKey ?? "").trim() || undefined,
      channelId: channel,
      turnId: String(params.messageId ?? traceId).trim() || traceId,
    });

    if (!admission.admitted || !admission.admittedTurn) {
      return buildClarificationResult({
        params,
        turnContextInput,
        reason: admission.skipReason ?? "ADMISSION_SKIPPED",
        reply: SAFE_CLARIFICATION,
      });
    }

    const brainTurnContext = buildShadowTurnContext({
      businessId,
      sessionKey: params.sessionKey,
      participantKey: params.participantKey,
      playwrightChatKey: params.playwrightChatKey ?? params.chatId,
      isGroupInbound: params.isGroupInbound,
      memorySnapshot: params.memorySnapshot,
      conversationHistory: params.conversationHistory,
    });

    if (turnContextInput.authoritativeItem?.id) {
      brainTurnContext.lastResolvedItemId = String(turnContextInput.authoritativeItem.id).trim();
    }

    const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
      traceId,
      businessId,
      rawMessage: message,
      turnContextInput,
      turnContext: brainTurnContext,
      catalogItems,
      admittedTurn: admission.admittedTurn,
      flags,
      getBookingsForItemFn: params.getBookingsForItemFn,
      getBusinessProfileFn: params.getBusinessProfileFn,
    });

    const orchestratorInput = {
      traceId: `${traceId}::v2_live`,
      admittedTurn: admission.admittedTurn,
      turnContext: brainTurnContext,
      businessContext: {
        catalogItems,
        conversationStyle: "casual_local",
        resolvedBusinessTurnContext,
      },
      mode: "live",
    };

    /** @type {import("../orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} */
    const result =
      process.env.NODE_ENV === "test" && typeof params.__testOrchestratorFn === "function"
        ? /** @type {any} */ (params.__testOrchestratorFn(orchestratorInput))
        : runConversationTurn(orchestratorInput);

    const workflowType = String(result.workflowDecision?.workflowType ?? "").trim();

    if (!isLiveWorkflowType(workflowType)) {
      return buildClarificationResult({
        params,
        turnContextInput,
        reason: "UNSUPPORTED_WORKFLOW",
        reply: SAFE_CLARIFICATION,
        workflowType,
      });
    }

    if (!result.actionPlan?.replyDraft && !result.actionPlan?.actions?.length) {
      return buildClarificationResult({
        params,
        turnContextInput,
        reason: "EMPTY_ACTION_PLAN",
        reply: SAFE_CLARIFICATION,
        workflowType,
      });
    }

    const { sideEffectResults, bookingCreated, ...routed } = await routeAndExecuteLiveActionPlan(
      result.actionPlan,
      flags,
      {
        ...params.executionContext,
        businessId,
        userId: businessId,
        traceId,
        message,
        sessionKey: params.sessionKey,
        participantKey: params.participantKey,
        sourceParticipantKey: params.sourceParticipantKey ?? params.participantKey,
        participantName: params.participantName,
        participantDisplayName: params.participantDisplayName,
        sourceParticipantName: params.sourceParticipantName ?? params.participantName,
        sourceParticipantDisplayName:
          params.sourceParticipantDisplayName ??
          params.participantDisplayName ??
          params.participantName,
        senderScope: params.senderScope,
        sourceSenderScope: params.sourceSenderScope ?? params.senderScope,
        participantPhoneForDm: params.participantPhoneForDm,
        messageId: params.messageId,
        sourceRowKey: params.sourceRowKey,
        sourceMessageIndex: params.sourceMessageIndex,
        guaranteeKey: params.guaranteeKey,
        chatId: params.chatId,
        chatType,
        groupName: params.groupName ?? null,
        sourceGroupName: params.groupName ?? null,
        playwrightChatKey: params.playwrightChatKey ?? params.chatId ?? null,
        sourcePlaywrightChatKey: params.playwrightChatKey ?? params.chatId ?? null,
        source: params.playwrightWebInbound === true ? "playwright" : channel,
        isGroupInbound: params.isGroupInbound,
      }
    );

    const emilySessionKey = String(turnContextInput._emilySessionKey ?? params.sessionKey ?? "").trim();
    applyInfoLiveSessionMemoryPatch({
      sessionKey: emilySessionKey,
      actionPlan: result.actionPlan,
      authoritativeItem: turnContextInput.authoritativeItem,
    });

    console.log("[brain_v2_live_handled]", {
      traceId,
      businessId,
      workflowType,
      turnShape: turnContextInput.turnShape,
      participantIdentity: turnContextInput.participantIdentity,
      authoritativeItemId: turnContextInput.authoritativeItem?.id ?? null,
      blockedSideEffects: routed.blockedSideEffects,
      replyPreview: routed.reply.slice(0, 120),
    });

    return finalizeLivePipelineResult({
      params,
      turnContextInput,
      workflowType,
      reply: routed.reply,
      finalReplySource: "BRAIN_V2_LIVE",
      actionPlan: result.actionPlan,
      flags,
      routed: { ...routed, sideEffectResults },
      bookingCreated,
      decisionTrace: result.trace,
    });
  } catch (err) {
    console.warn("[brain_v2_live_error]", {
      traceId,
      businessId,
      error: String(err?.message ?? err ?? "").slice(0, 200),
      legacyFallbackEnabled: isEmilyBrainV2LegacyFallbackEnabled(),
    });

    if (isEmilyBrainV2LegacyFallbackEnabled()) {
      return {
        handled: false,
        reason: "LEGACY_FALLBACK_REQUESTED",
        legacyBypassed: false,
      };
    }

    return {
      handled: true,
      reply: SAFE_APOLOGY,
      workflowType: "error_apology",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE_ERROR",
        outboundTrace: {
          finalReplySource: "BRAIN_V2_LIVE_ERROR",
          error: String(err?.message ?? err ?? "").slice(0, 160),
        },
        brainV2Live: true,
        traceId,
      },
      sendVia: params.isGroupInbound ? "GROUP" : "CLOUD_API",
      dmRecipientPhone: null,
      reason: "TECHNICAL_ERROR",
      legacyBypassed: true,
    };
  }
}

/**
 * @param {Record<string, unknown>} p
 */
function finalizeLivePipelineResult(p) {
  const reply = String(p.reply ?? "").trim();
  const routingCtx = {
    isGroupInbound: Boolean(p.params.isGroupInbound),
    isGroupMessage: Boolean(p.params.isGroupMessage ?? p.params.isGroupInbound),
    message: String(p.params.message ?? ""),
    participantPhoneForDm: p.params.participantPhoneForDm ?? null,
    playwrightWebInbound: Boolean(p.params.playwrightWebInbound),
    groupName: p.params.groupName ?? null,
    chatKey: String(p.params.playwrightChatKey ?? p.params.chatId ?? "").trim() || null,
    playwrightChatKey: p.params.playwrightChatKey ?? null,
    whatsappRecipientType: p.params.whatsappRecipientType ?? null,
    flowId: p.params.traceId ?? null,
    emilySessionKey: p.turnContextInput?._emilySessionKey ?? p.params.sessionKey ?? null,
  };

  const messageMeta = buildLiveMessageMeta({
    traceId: String(p.params.traceId ?? ""),
    workflowType: String(p.workflowType ?? ""),
    finalReplySource: String(p.finalReplySource ?? "BRAIN_V2_LIVE"),
    turnContextInput: p.turnContextInput,
    actionPlan: p.actionPlan,
    routed: p.routed,
    bookingCreated: p.bookingCreated,
    decisionTrace: p.decisionTrace,
  });

  const outbound = executeOutboundReply({
    reply,
    messageMeta,
    routingCtx,
  });

  return {
    handled: true,
    reply: outbound.reply,
    sendVia: outbound.sendVia,
    dmRecipientPhone: outbound.dmRecipientPhone ?? null,
    messageMeta: outbound.messageMeta,
    workflowType: p.workflowType,
    reason: "V2_LIVE_OK",
    legacyBypassed: true,
  };
}

/**
 * @param {Record<string, unknown>} p
 */
function buildClarificationResult(p) {
  return finalizeLivePipelineResult({
    params: p.params,
    turnContextInput: p.turnContextInput,
    workflowType: p.workflowType ?? "unknown_clarification",
    reply: p.reply ?? SAFE_CLARIFICATION,
    finalReplySource: "BRAIN_V2_LIVE_CLARIFY",
    actionPlan: null,
    flags: getEmilyBrainV2LiveFlagSnapshot(),
    routed: null,
    bookingCreated: null,
    reason: p.reason,
  });
}

/**
 * @param {{ traceId: string, reason: string }} p
 */
function buildSilentPipelineResult(p) {
  return {
    handled: true,
    reply: "",
    sendVia: "NONE",
    dmRecipientPhone: null,
    messageMeta: {
      routeType: "BRAIN_V2_LIVE_SILENT",
      outboundTrace: { finalReplySource: "BRAIN_V2_LIVE_SILENT", reason: p.reason },
      brainV2Live: true,
      traceId: p.traceId,
    },
    reason: p.reason,
    legacyBypassed: true,
  };
}

/**
 * @param {Record<string, unknown>} p
 */
function buildLiveMessageMeta(p) {
  return {
    routeType: "BRAIN_V2_LIVE",
    outboundTrace: {
      finalReplySource: p.finalReplySource,
      brainV2WorkflowType: p.workflowType,
      participantIdentity: p.turnContextInput?.participantIdentity ?? null,
      turnShape: p.turnContextInput?.turnShape ?? null,
      authoritativeItemId: p.turnContextInput?.authoritativeItem?.id ?? null,
    },
    brainV2Live: true,
    actionRouter: p.routed
      ? {
          blockedSideEffects: p.routed.blockedSideEffects,
          actions: p.routed.actions,
          sideEffectResults: p.routed.sideEffectResults,
        }
      : undefined,
    actionPlan: p.actionPlan ?? undefined,
    bookingCreated: p.bookingCreated ?? undefined,
    decisionTrace: p.decisionTrace ?? undefined,
    traceId: p.traceId,
  };
}
