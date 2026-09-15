/**
 * Emily Brain v2 informational live adapter.
 * Runs orchestrator for safe informational workflows only when explicitly flagged.
 */
import {
  isEmilyBrainV2InfoLiveEnabledForBusiness,
  getEmilyBrainV2InfoLiveFlagSnapshot,
} from "../config/infoLiveFeatureFlags.js";
import { buildTurnContextInput } from "./buildTurnContextInput.js";
import {
  assertInfoLiveActionPlanIsSafe,
  applyInfoLiveSessionMemoryPatch,
  isInfoLiveWorkflowType,
} from "./actionRouter.js";
import { buildShadowTurnContext, buildShadowAdmittedTurn } from "../shadow/brainShadowHook.js";
import { runConversationTurn } from "../orchestrator/ConversationOrchestrator.js";

/**
 * @typedef {Object} BrainV2InfoLiveResult
 * @property {boolean} handled
 * @property {string} [reply]
 * @property {Record<string, unknown>} [messageMeta]
 * @property {string} [sendVia]
 * @property {string} [reason]
 * @property {string} [workflowType]
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
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   isDmContinuation?: boolean,
 *   hasBookingHint?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   conversationHistory?: string,
 *   catalogItems?: unknown[],
 *   sourceRowKey?: string | null,
 *   guaranteeKey?: string | null,
 *   resolveTrustedSessionItem?: (p: Record<string, unknown>) => { ok: boolean, item?: Record<string, unknown> | null, reason?: string | null },
 *   __testOrchestratorFn?: (args: Record<string, unknown>) => unknown,
 * }} params
 * @returns {Promise<BrainV2InfoLiveResult>}
 */
export async function tryBrainV2InfoLiveTurn(params) {
  const businessId = String(params.businessId ?? "").trim();
  if (!isEmilyBrainV2InfoLiveEnabledForBusiness(businessId)) {
    return { handled: false, reason: "INFO_LIVE_DISABLED" };
  }
  if (params.isDmContinuation === true || params.chatType === "dm") {
    return { handled: false, reason: "DM_LEGACY_ONLY" };
  }
  if (params.hasBookingHint === true) {
    return { handled: false, reason: "BOOKING_HINT_LEGACY" };
  }

  const flags = getEmilyBrainV2InfoLiveFlagSnapshot();
  const traceId = String(params.traceId ?? "").trim();
  const message = String(params.message ?? "").trim();
  const channel = params.channel === "whatsapp_cloud" ? "whatsapp_cloud" : "whatsapp_web";
  const chatType = params.isGroupInbound === true || params.chatType === "group" ? "group" : "dm";

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
    participantWaId: params.participantWaId,
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
    console.log("[emily_brain_v2_info_live_clarify]", {
      traceId,
      businessId,
      turnShape: turnContextInput.turnShape,
      reason: turnContextInput._authority?.clarificationReason ?? null,
    });
    return {
      handled: true,
      reply: turnContextInput.clarificationReply,
      workflowType: "clarification",
      messageMeta: buildInfoLiveMessageMeta({
        traceId,
        workflowType: "clarification",
        finalReplySource: "BRAIN_V2_INFO_CLARIFY",
        turnContextInput,
      }),
      sendVia: chatType === "group" ? "GROUP" : "WHATSAPP",
      reason: "AUTHORITY_CLARIFY",
    };
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
    return { handled: false, reason: admission.skipReason ?? "ADMISSION_SKIPPED" };
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

  const orchestratorInput = {
    traceId: `${traceId}::info_live`,
    admittedTurn: admission.admittedTurn,
    turnContext: brainTurnContext,
    businessContext: {
      catalogItems,
      conversationStyle: "casual_local",
    },
  };

  /** @type {import("../orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} */
  const result =
    process.env.NODE_ENV === "test" && typeof params.__testOrchestratorFn === "function"
      ? /** @type {any} */ (params.__testOrchestratorFn(orchestratorInput))
      : runConversationTurn(orchestratorInput);

  const workflowType = String(result.workflowDecision?.workflowType ?? "").trim();

  if (workflowType === "booking_request") {
    return { handled: false, reason: "BOOKING_LEGACY", workflowType };
  }

  if (!isInfoLiveWorkflowType(workflowType)) {
    return { handled: false, reason: "UNSUPPORTED_WORKFLOW", workflowType };
  }

  if (!result.actionPlan?.replyDraft && !result.actionPlan?.actions?.length) {
    return { handled: false, reason: "EMPTY_ACTION_PLAN", workflowType };
  }

  const routed = assertInfoLiveActionPlanIsSafe(result.actionPlan, flags);
  if (!routed.reply) {
    return { handled: false, reason: "EMPTY_REPLY", workflowType };
  }

  const emilySessionKey = String(turnContextInput._emilySessionKey ?? params.sessionKey ?? "").trim();
  applyInfoLiveSessionMemoryPatch({
    sessionKey: emilySessionKey,
    actionPlan: result.actionPlan,
    authoritativeItem: turnContextInput.authoritativeItem,
    sourceTurnId: `assistant:${String(params.messageId ?? traceId).trim()}`,
  });

  console.log("[emily_brain_v2_info_live_handled]", {
    traceId,
    businessId,
    workflowType,
    turnShape: turnContextInput.turnShape,
    participantIdentity: turnContextInput.participantIdentity,
    authoritativeItemId: turnContextInput.authoritativeItem?.id ?? null,
    blockedSideEffects: routed.blockedSideEffects,
    replyPreview: routed.reply.slice(0, 120),
  });

  return {
    handled: true,
    reply: routed.reply,
    workflowType,
    messageMeta: buildInfoLiveMessageMeta({
      traceId,
      workflowType,
      finalReplySource: "BRAIN_V2_INFO_LIVE",
      turnContextInput,
      actionRouter: routed,
    }),
    sendVia: chatType === "group" ? "GROUP" : "WHATSAPP",
    reason: "INFO_LIVE_OK",
  };
}

/**
 * @param {{
 *   traceId: string,
 *   workflowType: string,
 *   finalReplySource: string,
 *   turnContextInput: import("./buildTurnContextInput.js").buildTurnContextInput extends (...args: any[]) => infer R ? R : never,
 *   actionRouter?: ReturnType<typeof assertInfoLiveActionPlanIsSafe>,
 * }} p
 */
function buildInfoLiveMessageMeta(p) {
  return {
    routeType: "INFORMATIONAL_QUESTION",
    outboundTrace: {
      finalReplySource: p.finalReplySource,
      brainV2WorkflowType: p.workflowType,
      participantIdentity: p.turnContextInput.participantIdentity,
      turnShape: p.turnContextInput.turnShape,
      authoritativeItemId: p.turnContextInput.authoritativeItem?.id ?? null,
    },
    brainV2InfoLive: true,
    actionRouter: p.actionRouter
      ? {
          blockedSideEffects: p.actionRouter.blockedSideEffects,
          actions: p.actionRouter.actions,
        }
      : undefined,
    traceId: p.traceId,
  };
}

/** @internal Tests */
export { buildShadowAdmittedTurn };
