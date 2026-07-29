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
import { decideCustomerTurn } from "../decisions/decideCustomerTurn.js";
import { GROUP_POST_EXECUTE_LANE } from "../decisions/groupPostExecuteLane.js";
import { resolveBusinessTurnContext } from "../facts/resolveBusinessTurnContext.js";
import {
  ONBOARDING_CLARIFICATION_REPLY,
  isOnboardingStyleClarificationReply,
  shouldSuppressPostConfirmOnboardingClarification,
} from "./shouldSuppressPostConfirmOnboardingClarification.js";
import { readFreshLastAvailabilityAssist } from "../availability/availabilityAssistContext.js";

const SAFE_APOLOGY =
  "Sorry, main abhi reply nahi bhej pa rahi. Thori der baad dobara try karein please.";
/** @deprecated Prefer ONBOARDING_CLARIFICATION_REPLY — kept as alias for local call sites. */
const SAFE_CLARIFICATION = ONBOARDING_CLARIFICATION_REPLY;

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
      const suppressedEarly = await maybeSilentInsteadOfOnboardingClarify({
        params,
        channel,
        chatType,
        reply: turnContextInput.clarificationReply,
        reason: "AUTHORITY_CLARIFY_SUPPRESSED",
      });
      if (suppressedEarly) return suppressedEarly;
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
        channel,
        chatType,
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
        channel,
        chatType,
        reason: "UNSUPPORTED_WORKFLOW",
        reply: SAFE_CLARIFICATION,
        workflowType,
      });
    }

    if (!result.actionPlan?.replyDraft && !result.actionPlan?.actions?.length) {
      const freshAssist = readFreshLastAvailabilityAssist(
        resolvedBusinessTurnContext?.lastAvailabilityAssist ??
          brainTurnContext?.memorySnapshot?.lastAvailabilityAssist ??
          params.memorySnapshot?.lastAvailabilityAssist
      );
      // Active availability-assist context: never map empty plan → onboarding clarify.
      if (freshAssist) {
        const emilySessionKey = String(
          turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
        ).trim();
        applyInfoLiveSessionMemoryPatch({
          sessionKey: emilySessionKey,
          actionPlan: {
            persistenceIntent: {
              clearLastAvailabilityAssist: true,
              execute: false,
            },
          },
          authoritativeItem: turnContextInput.authoritativeItem,
        });
        return buildSilentPipelineResult({
          traceId,
          reason: "ASSIST_CONTEXT_NO_REPLY",
        });
      }
      return buildClarificationResult({
        params,
        turnContextInput,
        channel,
        chatType,
        reason: "EMPTY_ACTION_PLAN",
        reply: SAFE_CLARIFICATION,
        workflowType,
      });
    }

    // Explicit assist no-reply (NO_OP) — handled silence, never outbound / clarify.
    if (isAvailabilityAssistContextNoReplyPlan(result.actionPlan)) {
      const emilySessionKey = String(
        turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
      ).trim();
      applyInfoLiveSessionMemoryPatch({
        sessionKey: emilySessionKey,
        actionPlan: result.actionPlan,
        authoritativeItem: turnContextInput.authoritativeItem,
      });
      return buildSilentPipelineResult({
        traceId,
        reason: "ASSIST_CONTEXT_NO_REPLY",
      });
    }

    // ClarificationWorkflow / unknown_clarification action plans with onboarding canned text.
    const plannedClarifyReply = String(
      result.actionPlan?.replyDraft ??
        result.actionPlan?.actions?.[0]?.payload?.text ??
        ""
    ).trim();
    if (
      (workflowType === "clarification" ||
        workflowType === "unknown_clarification" ||
        workflowType === "noop") &&
      isOnboardingStyleClarificationReply(plannedClarifyReply)
    ) {
      const suppressedPlan = await maybeSilentInsteadOfOnboardingClarify({
        params,
        channel,
        chatType,
        reply: plannedClarifyReply,
        reason: "ONBOARDING_CLARIFY_PLAN_SUPPRESSED",
      });
      if (suppressedPlan) return suppressedPlan;
    }

    const { sideEffectResults, bookingCreated, customerReplySuppressed, ...routed } =
      await routeAndExecuteLiveActionPlan(result.actionPlan, flags, {
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
      });

    // ── Post-execute Brain reply (PR1B) ────────────────────────────────────
    // When actionRouter signals awaitsPostExecuteBrainReply, call the existing
    // Emily Brain with lane=group_post_execute. Reply only — actionsAllowed: false.
    let finalReply = routed.reply;
    let finalReplySource = "BRAIN_V2_LIVE";
    let postExecuteBrainDecision = null;

    if (routed.awaitsPostExecuteBrainReply === true) {
      const postExecResult =
        sideEffectResults?.OWNER_CHECK_POST_EXECUTE_RESULT &&
        typeof sideEffectResults.OWNER_CHECK_POST_EXECUTE_RESULT === "object"
          ? /** @type {Record<string, unknown>} */ (sideEffectResults.OWNER_CHECK_POST_EXECUTE_RESULT)
          : null;

      const brainResult = await decideCustomerTurn({
        lane: GROUP_POST_EXECUTE_LANE,
        chatType,
        channel,
        businessId,
        messageText: message,
        recentDialogue: params.conversationHistory ?? null,
        facts: {
          ...resolvedBusinessTurnContext,
          catalogItems,
        },
        activeAvailabilityRequest:
          postExecResult?.facts?.requestId
            ? {
                requestId: postExecResult.facts.requestId,
                status: postExecResult.facts.lifecycleKind ?? null,
                ownerNotificationStatus: postExecResult.facts.ownerNotificationStatus ?? null,
                customerDmNotificationStatus:
                  postExecResult.facts.customerDmNotificationStatus ?? null,
              }
            : null,
        conversationStageHint: "post_owner_check_group",
        postExecuteResult: postExecResult,
        responseDisposition: postExecResult?.responseDisposition ?? null,
        actionsAllowed: false,
        allowedExecutors: [],
        styleKey: "casual_local",
        timeoutMs: 8000,
        __chatCompletionsCreateForTests:
          params.executionContext?.__groupPostExecuteChatCreate ?? null,
      });

      postExecuteBrainDecision = brainResult;

      const brainReply = String(brainResult?.decision?.customerReply ?? "").trim();
      const brainOk = brainResult?.ok === true && brainReply.length > 0;

      console.log("[brain_v2_group_post_execute]", {
        traceId,
        businessId,
        ok: brainOk,
        source: brainResult?.source,
        responseDisposition: postExecResult?.responseDisposition,
        replyPreview: brainReply.slice(0, 80),
      });

      if (brainOk) {
        finalReply = brainReply;
        finalReplySource = "BRAIN_V2_GROUP_POST_EXECUTE";
      } else {
        // Fail closed — Brain call failed or returned empty. Suppress, no canned fallback.
        const emilySessionKeyFc = String(
          turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
        ).trim();
        applyInfoLiveSessionMemoryPatch({
          sessionKey: emilySessionKeyFc,
          actionPlan: result.actionPlan,
          authoritativeItem: turnContextInput.authoritativeItem,
        });
        return buildSilentPipelineResult({
          traceId,
          reason: `GROUP_POST_EXECUTE_BRAIN_EMPTY:${brainResult?.reason ?? "no_reply"}`,
        });
      }
    }
    // ── End post-execute Brain reply ────────────────────────────────────────

    if (customerReplySuppressed === true) {
      const emilySessionKeySilent = String(
        turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
      ).trim();
      applyInfoLiveSessionMemoryPatch({
        sessionKey: emilySessionKeySilent,
        actionPlan: result.actionPlan,
        authoritativeItem: turnContextInput.authoritativeItem,
      });
      const disposition = String(
        sideEffectResults?.OWNER_CHECK_POST_EXECUTE_RESULT?.responseDisposition ??
          sideEffectResults?.AVAILABILITY_OWNER_CHECK_REQUIRED?.replyDisposition ??
          sideEffectResults?.AVAILABILITY_OWNER_CHECK_REQUIRED?.lifecycleKind ??
          "OWNER_CHECK_REPLY_SUPPRESSED"
      ).trim();
      return buildSilentPipelineResult({
        traceId,
        reason: disposition || "OWNER_CHECK_REPLY_SUPPRESSED",
      });
    }

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
      replyPreview: finalReply.slice(0, 120),
    });

    return finalizeLivePipelineResult({
      params,
      turnContextInput,
      workflowType,
      reply: finalReply,
      finalReplySource,
      actionPlan: result.actionPlan,
      flags,
      routed: {
        ...routed,
        sideEffectResults,
        ...(postExecuteBrainDecision ? { postExecuteBrainDecision } : {}),
      },
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
 * Step 3: silence instead of onboarding canned clarify for post-confirm Cloud DM.
 * @param {{
 *   params: Record<string, unknown>,
 *   channel: string,
 *   chatType: string,
 *   reply: string,
 *   reason: string,
 * }} p
 */
async function maybeSilentInsteadOfOnboardingClarify(p) {
  const params = p.params && typeof p.params === "object" ? p.params : {};
  const decision = await shouldSuppressPostConfirmOnboardingClarification({
    channel: p.channel ?? params.channel,
    chatType: p.chatType ?? params.chatType,
    isGroupInbound: params.isGroupInbound === true,
    isGroupMessage: params.isGroupMessage === true,
    playwrightWebInbound: params.playwrightWebInbound === true,
    businessId: params.businessId,
    customerPhone: params.participantPhoneForDm,
    participantPhoneForDm: params.participantPhoneForDm,
    db: params.executionContext?.db ?? params.db ?? null,
    replyText: p.reply,
    __resolveActiveCustomerBookingFactsFn:
      params.__resolveActiveCustomerBookingFactsFn ?? null,
  });
  if (!decision.suppress) return null;
  console.log("[brain_v2_post_confirm_onboarding_clarify_suppressed]", {
    traceId: String(params.traceId ?? "").trim() || null,
    businessId: String(params.businessId ?? "").trim() || null,
    reason: decision.reason,
    suppressReason: p.reason,
  });
  return buildSilentPipelineResult({
    traceId: String(params.traceId ?? "").trim(),
    reason: p.reason || "POST_CONFIRM_ONBOARDING_CLARIFY_SUPPRESSED",
  });
}

/**
 * @param {Record<string, unknown>} p
 */
async function buildClarificationResult(p) {
  const reply = p.reply ?? SAFE_CLARIFICATION;
  const suppressed = await maybeSilentInsteadOfOnboardingClarify({
    params: p.params,
    channel: p.channel,
    chatType: p.chatType,
    reply,
    reason: "POST_CONFIRM_ONBOARDING_CLARIFY_SUPPRESSED",
  });
  if (suppressed) return suppressed;

  return finalizeLivePipelineResult({
    params: p.params,
    turnContextInput: p.turnContextInput,
    workflowType: p.workflowType ?? "unknown_clarification",
    reply,
    finalReplySource: "BRAIN_V2_LIVE_CLARIFY",
    actionPlan: null,
    flags: getEmilyBrainV2LiveFlagSnapshot(),
    routed: null,
    bookingCreated: null,
    reason: p.reason,
  });
}

/**
 * @param {import("../contracts/action.js").ActionPlan | null | undefined} actionPlan
 */
function isAvailabilityAssistContextNoReplyPlan(actionPlan) {
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  if (!plan) return false;
  const reply = String(plan.replyDraft ?? "").trim();
  if (reply) return false;
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  if (actions.some((a) => String(a?.type ?? "") === "REPLY" && String(a?.payload?.text ?? "").trim())) {
    return false;
  }
  return actions.some(
    (a) =>
      String(a?.type ?? "") === "NO_OP" &&
      a?.payload?.intentionallySilent === true &&
      String(a?.payload?.source ?? "") === "availability_assist_context_no_reply"
  );
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
