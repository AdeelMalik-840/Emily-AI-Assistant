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
import { POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK } from "../decisions/decidePostConfirmCustomerDm.js";
import { buildContinuationContext } from "../continuation/buildContinuationContext.js";
import {
  ONBOARDING_CLARIFICATION_REPLY,
  isOnboardingStyleClarificationReply,
  shouldSuppressPostConfirmOnboardingClarification,
} from "./shouldSuppressPostConfirmOnboardingClarification.js";
import { readFreshLastAvailabilityAssist } from "../availability/availabilityAssistContext.js";
import { composeBrowseOptionsCustomerReply } from "../openai/composeBrowseOptionsCustomerReply.js";
import { composeUnknownItemCustomerReply } from "../openai/composeUnknownItemCustomerReply.js";
import { composeMissingCatalogFactCustomerReply } from "../openai/composeMissingCatalogFactCustomerReply.js";
import { composeCloudCanonicalCustomerReply } from "../openai/composeCloudCanonicalCustomerReply.js";
import {
  VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  validateGroupCanonicalSemanticDecision,
} from "../decisions/resolveGroupCanonicalSemanticDecision.js";
import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";
import {
  CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
  isCloudMissingBusinessFactIntent,
} from "../contracts/cloudCanonicalSemantic.js";
import {
  executeCloudMissingBusinessFactOwnerCheck,
  isCloudMissingFactHoldingAuthorized,
} from "../../services/customerBusinessPaAgentService.js";
import { missingInfoTypeForCloudCanonicalAsk } from "../../services/paMissingInfoRequestService.js";
import { stampRememberPresentedItemFocusForSingleVerifiedItem } from "../../services/executors/sessionMemoryExecutor.js";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import {
  isTrustedVerifiedFactResolution,
  resolvePostConfirmRequestedFact,
} from "../facts/resolvePostConfirmRequestedFact.js";

const SAFE_APOLOGY =
  "Sorry, main abhi reply nahi bhej pa rahi. Thori der baad dobara try karein please.";
/** @deprecated Prefer ONBOARDING_CLARIFICATION_REPLY — kept as alias for local call sites. */
const SAFE_CLARIFICATION = ONBOARDING_CLARIFICATION_REPLY;

const CANONICAL_RELEASED_SCOPES = new Set([
  "NEW_TRANSACTION",
  "SOCIAL_GENERAL",
  "UNCLEAR",
]);
const CANONICAL_MUTATION_ACTION_TYPES = new Set([
  "CREATE_BOOKING",
  "AVAILABILITY_OWNER_CHECK_REQUIRED",
  "NOTIFY_OWNER",
]);

function resolveFrozenCanonicalDecision(params) {
  if (params?.isGroupInbound === true || params?.chatType === "group") {
    return null;
  }
  const decision =
    params?.canonicalSemanticDecision &&
    typeof params.canonicalSemanticDecision === "object"
      ? params.canonicalSemanticDecision
      : null;
  if (!decision) return null;
  const status = String(decision.semanticDecisionStatus ?? "").trim();
  if (status !== "released" && status !== "accepted") return null;
  const turnScope = String(decision.turnScope ?? "").trim();
  if (!CANONICAL_RELEASED_SCOPES.has(turnScope)) {
    return { ...decision, turnScope, _ownershipBlockedForBrainV2: true };
  }
  return decision;
}

function resolveValidatedGroupCanonicalDecision(params) {
  if (params?.isGroupInbound !== true && params?.chatType !== "group") {
    return null;
  }
  const decision =
    params?.validatedGroupCanonicalSemanticDecision &&
    typeof params.validatedGroupCanonicalSemanticDecision === "object"
      ? params.validatedGroupCanonicalSemanticDecision
      : null;
  if (!decision) return null;
  if (
    decision.semanticDecisionProvenance !==
    VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE
  ) {
    return null;
  }
  const validation = validateGroupCanonicalSemanticDecision(decision, {
    customerMessage: params?.message,
  });
  if (!validation.ok || decision.semanticDecisionStatus !== "released") {
    return {
      ...decision,
      _validatedGroupSemanticRejected: true,
      _validatedGroupSemanticRejectReason:
        validation.reason || "GROUP_SEMANTIC_DECISION_NOT_RELEASED",
    };
  }
  return decision;
}

function constrainActionPlanToCanonicalScope(actionPlan, turnScope) {
  const plan = actionPlan && typeof actionPlan === "object" ? { ...actionPlan } : {};
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  if (turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR") {
    plan.actions = actions.filter(
      (action) =>
        !CANONICAL_MUTATION_ACTION_TYPES.has(String(action?.type ?? "").trim())
    );
  }
  return plan;
}

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
    assertBrainV2ExecutionActive(params);
    const existingCloudCanonicalReleased = resolveFrozenCanonicalDecision(params);
    const validatedGroupCanonicalReleased =
      resolveValidatedGroupCanonicalDecision(params);
    const canonicalReleased =
      existingCloudCanonicalReleased ?? validatedGroupCanonicalReleased;
    if (canonicalReleased?._validatedGroupSemanticRejected === true) {
      return buildClarificationResult({
        params,
        turnContextInput: null,
        channel,
        chatType,
        reason:
          canonicalReleased._validatedGroupSemanticRejectReason ||
          "GROUP_CANONICAL_SEMANTIC_INVALID",
        reply: SAFE_APOLOGY,
      });
    }
    if (canonicalReleased?._ownershipBlockedForBrainV2 === true) {
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: "CANONICAL_OWNERSHIP_NOT_BRAIN_V2",
      });
    }
    const authoritativeSemanticIntent = canonicalReleased
      ? cleanCustomerSemanticIntent(canonicalReleased.semanticIntent)
      : null;
    if (
      canonicalReleased?.turnScope === "NEW_TRANSACTION" &&
      !authoritativeSemanticIntent
    ) {
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: "CANONICAL_SEMANTIC_INTENT_INVALID",
      });
    }
    let catalogItems = Array.isArray(params.catalogItems) ? params.catalogItems : [];
    if (catalogItems.length === 0) {
      const catalogMod = await import("../../services/inventoryService.js");
      catalogItems = await catalogMod.getCachedItemsForUser(businessId);
      assertBrainV2ExecutionActive(params);
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
      authoritativeSemanticIntent,
      canonicalItemReferents: canonicalReleased?.itemReferents ?? null,
      authoritativeItemScope: canonicalReleased?.itemScope ?? null,
      validatedGroupCanonicalAuthority:
        validatedGroupCanonicalReleased != null,
      resolveTrustedSessionItem: params.resolveTrustedSessionItem,
    });

    let continuation = buildContinuationContext({
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound === true || chatType === "group",
      participantKey: params.participantKey,
      customerNumber: params.participantPhoneForDm ?? null,
      groupChatKey: params.playwrightChatKey ?? params.chatId ?? null,
      memorySnapshot: params.memorySnapshot,
      availabilityRequest: params.preResolvedWaitingConfirmRequest ?? null,
      waitingConfirmCandidates: params.waitingConfirmCandidates ?? null,
    });
    if (canonicalReleased) {
      continuation = {
        ...continuation,
        active: false,
        safeToOwn: false,
        bypassGenericRouting: false,
        canonicalTurnScope: canonicalReleased.turnScope,
      };
      console.log("[brain_v2_canonical_released_decision_bound]", {
        traceId,
        turnScope: canonicalReleased.turnScope,
        targetId: canonicalReleased.targetId ?? null,
        semanticDecisionStatus: canonicalReleased.semanticDecisionStatus,
      });
      if (validatedGroupCanonicalReleased) {
        console.log("[brain_v2_group_canonical_semantic_bound]", {
          traceId,
          canonicalTurnId: String(params.messageId ?? traceId).trim() || null,
          semanticDecisionSource:
            validatedGroupCanonicalReleased.semanticDecisionProvenance,
          semanticIntent: authoritativeSemanticIntent,
          itemScope: validatedGroupCanonicalReleased.itemScope ?? null,
          itemReferenceMode: turnContextInput.itemReferenceMode ?? null,
          resolvedItemState:
            turnContextInput.canonicalItemResolutions?.[0]?.status ??
            (turnContextInput.canonicalItemResolutions?.length > 1
              ? "MULTIPLE"
              : "NONE"),
          priorItemUsed:
            turnContextInput.itemReferenceMode === "CONTEXTUAL",
        });
      }
    }

    // Unsafe continuation: fail closed — no generic routing, no mutation.
    if (continuation.active && !continuation.safeToOwn) {
      console.log("[continuation_context_fail_closed]", {
        traceId,
        businessId,
        type: continuation.type,
        rejectReason: continuation.rejectReason,
        stale: continuation.stale,
      });
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: continuation.rejectReason || "CONTINUATION_UNSAFE",
      });
    }

    // Safe continuation: do not let itemless clarify / generic entity steal the turn.
    if (
      continuation.safeToOwn &&
      continuation.bypassGenericRouting &&
      turnContextInput.shouldClarifyItem
    ) {
      turnContextInput.shouldClarifyItem = false;
      turnContextInput.clarificationReply = null;
      if (continuation.itemId && !turnContextInput.authoritativeItem?.id) {
        turnContextInput.authoritativeItem = {
          id: continuation.itemId,
          label: continuation.itemLabel,
          source: "continuation_trusted",
        };
      }
    }

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

    brainTurnContext.continuation = continuation;
    if (canonicalReleased) {
      brainTurnContext.canonicalSemanticDecision = canonicalReleased;
    }
    if (authoritativeSemanticIntent) {
      brainTurnContext.authoritativeSemanticIntent = authoritativeSemanticIntent;
      brainTurnContext.canonicalItemReferents = Object.freeze([
        ...(canonicalReleased?.itemReferents ?? []),
      ]);
      brainTurnContext.canonicalItemResolutions = Object.freeze([
        ...(turnContextInput.canonicalItemResolutions ?? []),
      ]);
      if (turnContextInput.itemReferenceMode) {
        brainTurnContext.itemReferenceMode = turnContextInput.itemReferenceMode;
      }
    }

    if (turnContextInput.authoritativeItem?.id) {
      brainTurnContext.lastResolvedItemId = String(turnContextInput.authoritativeItem.id).trim();
    } else if (continuation.safeToOwn && continuation.itemId) {
      brainTurnContext.lastResolvedItemId = String(continuation.itemId).trim();
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
    assertBrainV2ExecutionActive(params);

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

    const missingFactOwnerCheck = await maybeCloudMissingFactOwnerCheckResult({
      params,
      turnContextInput,
      channel,
      chatType,
      workflowType,
      actionPlan: result.actionPlan,
      authoritativeSemanticIntent,
      catalogItems,
      resolvedBusinessTurnContext,
    });
    if (missingFactOwnerCheck) return missingFactOwnerCheck;

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
      if (freshAssist && !authoritativeSemanticIntent) {
        assertBrainV2ExecutionActive(params);
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
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
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
    if (
      isAvailabilityAssistContextNoReplyPlan(result.actionPlan) &&
      !authoritativeSemanticIntent
    ) {
      assertBrainV2ExecutionActive(params);
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
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
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
      canonicalReleased?.turnScope !== "SOCIAL_GENERAL" &&
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

    const constrainedPlan = canonicalReleased
      ? constrainActionPlanToCanonicalScope(
          result.actionPlan,
          canonicalReleased.turnScope
        )
      : result.actionPlan;
    if (
      canonicalReleased?.turnScope === "SOCIAL_GENERAL" &&
      ["booking_request", "availability_inquiry", "contact_collection", "contact_request"].includes(
        workflowType
      )
    ) {
      console.log("[brain_v2_canonical_scope_blocks_transactional_workflow]", {
        traceId,
        turnScope: canonicalReleased.turnScope,
        workflowType,
      });
      const socialActions = Array.isArray(constrainedPlan?.actions)
        ? constrainedPlan.actions.filter(
            (action) =>
              !CANONICAL_MUTATION_ACTION_TYPES.has(
                String(action?.type ?? "").trim()
              )
          )
        : [];
      if (socialActions.length === 0 && !String(constrainedPlan?.replyDraft ?? "").trim()) {
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: "CANONICAL_SOCIAL_GENERAL_SCOPE",
        });
      }
    }

    const { sideEffectResults, bookingCreated, customerReplySuppressed, ...routed } =
      await routeAndExecuteLiveActionPlan(constrainedPlan, flags, {
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
        abortSignal: params.abortSignal,
        executionGuard: params.executionGuard,
      });
    assertBrainV2ExecutionActive(params);

    // ── Post-execute Brain reply (PR1B) ────────────────────────────────────
    // When actionRouter signals awaitsPostExecuteBrainReply, call the existing
    // Emily Brain with lane=group_post_execute. Reply only — actionsAllowed: false.
    let finalReply = routed.reply;
    let finalActionPlan = constrainedPlan;
    let finalReplySource = "BRAIN_V2_LIVE";
    let postExecuteBrainDecision = null;

    const canonicalUnknownItem =
      canonicalReleased?.turnScope === "NEW_TRANSACTION" &&
      canonicalReleased?.itemScope === "specific" &&
      Array.isArray(canonicalReleased?.itemReferents) &&
      canonicalReleased.itemReferents.length === 1 &&
      resolvedBusinessTurnContext?.resolvedItem?.status === "not_matched";
    if (canonicalUnknownItem) {
      const itemLabel = String(
        resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
          canonicalReleased.itemReferents[0]?.surfaceText ??
          ""
      ).trim();
      const composedUnknown = await composeUnknownItemCustomerReply({
        semanticIntent: authoritativeSemanticIntent,
        itemLabel,
        customerMessage: message,
        timeoutMs: params.__unknownItemComposeTimeoutMs ?? 8000,
        __chatCompletionsCreateForTests:
          params.__unknownItemComposeChatCreate ?? null,
      });
      assertBrainV2ExecutionActive(params);
      if (!composedUnknown.ok || !String(composedUnknown.reply ?? "").trim()) {
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: `UNKNOWN_ITEM_COMPOSE_FAIL_CLOSED:${composedUnknown.reason ?? "no_reply"}`,
        });
      }
      finalReply = composedUnknown.reply;
      finalReplySource = "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE";
    }

    // Item is real and matched (never overlaps canonicalUnknownItem above,
    // which requires not_matched) but its price is a genuinely missing
    // catalog field -- no owner-check/escalation architecture exists for
    // catalog data, so the wording is AI-composed with the same
    // no-fabrication, no-echo, no-fake-promise discipline as the
    // unknown-item composer, rather than a static conversational reply.
    const canonicalKnownItemMissingPrice =
      !canonicalUnknownItem &&
      (workflowType === "pricing_inquiry" || workflowType === "pricing_with_duration") &&
      resolvedBusinessTurnContext?.resolvedItem?.status === "resolved" &&
      resolvedBusinessTurnContext?.verified?.pricing?.status === "missing";
    if (canonicalKnownItemMissingPrice) {
      const itemLabel = String(
        resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
          resolvedBusinessTurnContext?.resolvedItem?.name ??
          ""
      ).trim();
      const composedMissingPrice = await composeMissingCatalogFactCustomerReply({
        semanticIntent: authoritativeSemanticIntent,
        itemLabel,
        customerMessage: message,
        timeoutMs: params.__missingCatalogFactComposeTimeoutMs ?? 8000,
        __chatCompletionsCreateForTests:
          params.__missingCatalogFactComposeChatCreate ?? null,
      });
      assertBrainV2ExecutionActive(params);
      if (!composedMissingPrice.ok || !String(composedMissingPrice.reply ?? "").trim()) {
        return buildSilentPipelineResult({
          traceId,
          channel,
          chatType,
          isGroupInbound: params.isGroupInbound,
          reason: `MISSING_CATALOG_FACT_COMPOSE_FAIL_CLOSED:${composedMissingPrice.reason ?? "no_reply"}`,
        });
      }
      finalReply = composedMissingPrice.reply;
      finalReplySource = "BRAIN_V2_MISSING_CATALOG_FACT_OPENAI_COMPOSE";
    }

    if (workflowType === "browse_options") {
      const browseReplyAction = (Array.isArray(constrainedPlan?.actions)
        ? constrainedPlan.actions
        : []
      ).find(
        (action) =>
          String(action?.type ?? "").trim() === "REPLY" &&
          String(action?.payload?.field ?? "").trim() === "browse_options"
      );
      const trustedBrowseFacts = browseReplyAction?.payload?.trustedBrowseFacts;
      const composedBrowse = await composeBrowseOptionsCustomerReply({
        trustedBrowseFacts,
        customerMessage: message,
        channel: chatType,
        timeoutMs: params.__browseComposeTimeoutMs ?? 8000,
        __chatCompletionsCreateForTests:
          params.__browseComposeChatCreate ?? null,
      });
      assertBrainV2ExecutionActive(params);
      if (!composedBrowse.ok || !String(composedBrowse.reply ?? "").trim()) {
        const emilySessionKeyBrowse = String(
          turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
        ).trim();
        applyInfoLiveSessionMemoryPatch({
          sessionKey: emilySessionKeyBrowse,
          actionPlan: constrainedPlan,
          authoritativeItem: turnContextInput.authoritativeItem,
        });
    return buildSilentPipelineResult({
      traceId,
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: `BROWSE_COMPOSE_FAIL_CLOSED:${composedBrowse.reason ?? "no_reply"}`,
        });
      }
      finalReply = composedBrowse.reply;
      finalReplySource = "BRAIN_V2_BROWSE_OPENAI_COMPOSE";
      const presentedItemIds = Array.isArray(composedBrowse.mentionedAvailableItemIds)
        ? [...new Set(composedBrowse.mentionedAvailableItemIds.map((id) => String(id ?? "").trim()).filter(Boolean))]
        : [];
      const trustedAvailableItems = Array.isArray(trustedBrowseFacts?.availableItems)
        ? trustedBrowseFacts.availableItems
        : [];
      const verifiedPresentedItems = presentedItemIds
        .map((itemId) => trustedAvailableItems.find(
          (row) => String(row?.itemId ?? "").trim() === itemId && row?.isAvailable === true
        ))
        .filter(Boolean)
        .map((row) => ({
          itemId: String(row.itemId).trim(),
          itemLabel: String(row.displayLabel ?? "").trim() || null,
        }));
      const presentedOne =
        presentedItemIds.length === 1 && verifiedPresentedItems.length === 1;
      finalActionPlan = Object.freeze({
        ...constrainedPlan,
        actions: Object.freeze((Array.isArray(constrainedPlan?.actions)
          ? constrainedPlan.actions
          : []).map((action) =>
          action === browseReplyAction
            ? Object.freeze({
                ...action,
                payload: Object.freeze({
                  ...action.payload,
                  presentedItemIds: Object.freeze([...presentedItemIds]),
                  verifiedAlternatives: Object.freeze(
                    verifiedPresentedItems.map((row) => Object.freeze({ ...row }))
                  ),
                }),
              })
            : action
        )),
        persistenceIntent: Object.freeze({
          ...(constrainedPlan?.persistenceIntent ?? {}),
          clearItemFocus: !presentedOne,
          rememberPresentedItemFocus: presentedOne,
          presentedItemId: presentedOne ? verifiedPresentedItems[0].itemId : null,
          presentedItemLabel: presentedOne ? verifiedPresentedItems[0].itemLabel : null,
          clearPresentedItemFocus: !presentedOne,
          execute: false,
        }),
      });
    }

    if (routed.awaitsPostExecuteBrainReply === true) {
      if (isCloudDmChannel({ channel, chatType, params })) {
        return finalizeCloudOwnerCheckLaunchHolding({
          params,
          turnContextInput,
          channel,
          chatType,
          workflowType,
          constrainedPlan,
          canonicalReleased,
          authoritativeSemanticIntent,
          catalogItems,
          flags,
          routed,
          sideEffectResults,
          bookingCreated,
          decisionTrace: result.trace,
        });
      } else {
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
      assertBrainV2ExecutionActive(params);

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
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: `GROUP_POST_EXECUTE_BRAIN_EMPTY:${brainResult?.reason ?? "no_reply"}`,
        });
      }
      }
    }
    // ── End post-execute Brain reply ────────────────────────────────────────

    if (customerReplySuppressed === true) {
      if (isCloudDmChannel({ channel, chatType, params })) {
        return finalizeCloudOwnerCheckLaunchHolding({
          params,
          turnContextInput,
          channel,
          chatType,
          workflowType,
          constrainedPlan,
          canonicalReleased,
          authoritativeSemanticIntent,
          catalogItems,
          flags,
          routed,
          sideEffectResults,
          bookingCreated,
          decisionTrace: result.trace,
        });
      } else {
      assertBrainV2ExecutionActive(params);
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
      channel,
      chatType,
      isGroupInbound: params.isGroupInbound,
      reason: disposition || "OWNER_CHECK_REPLY_SUPPRESSED",
      });
      }
    }

    assertBrainV2ExecutionActive(params);
    if (
      isCloudDmChannel({ channel, chatType, params }) &&
      shouldComposeCloudCanonicalLaunchReply(params) &&
      finalReplySource !== "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE" &&
      finalReplySource !== "BRAIN_V2_BROWSE_OPENAI_COMPOSE" &&
      finalReplySource !== "BRAIN_V2_GROUP_POST_EXECUTE"
    ) {
      const composeKind = cloudCanonicalComposeKind({
        workflowType,
        actionPlan: finalActionPlan,
        semanticIntent: authoritativeSemanticIntent,
        turnScope: canonicalReleased?.turnScope,
      });
      if (composeKind) {
        const socialCompose = composeKind === "social";
        const composedLaunch = await composeCloudCanonicalCustomerReply({
          kind: composeKind,
          semanticIntent: authoritativeSemanticIntent,
          customerMessage: message,
          trustedFacts: trustedFactsForCloudCompose({
            composeKind,
            workflowType,
            actionPlan: finalActionPlan,
            semanticIntent: authoritativeSemanticIntent,
            turnScope: canonicalReleased?.turnScope,
            resolvedBusinessTurnContext,
            bookingCreated,
          }),
          fallbackReply: socialCompose ? "" : finalReply,
          timeoutMs: params.__cloudComposeTimeoutMs ?? 8000,
          __chatCompletionsCreateForTests: params.__cloudComposeChatCreate ?? null,
        });
        assertBrainV2ExecutionActive(params);
        console.log("[cloud_canonical_compose]", {
          traceId,
          composeKind,
          semanticIntent: authoritativeSemanticIntent ?? null,
          turnScope: canonicalReleased?.turnScope ?? null,
          composeOk: composedLaunch.ok === true,
          composeModel: resolveOpenAiChatModel(),
          composeSource: composedLaunch.source ?? null,
          composeReason: String(composedLaunch.reason ?? "").slice(0, 160) || null,
          composeAttemptCount:
            Number.isFinite(Number(composedLaunch.attemptCount))
              ? Number(composedLaunch.attemptCount)
              : null,
          trustedFreshItemFocusPresent: Boolean(
            params.memorySnapshot?.lastFreshItemFocus?.itemId
          ),
          trustedFreshItemFocusId:
            String(params.memorySnapshot?.lastFreshItemFocus?.itemId ?? "").trim() ||
            null,
        });
        // Active-now blocking-booking wording must come from OpenAI only —
        // never fall open to finalReply's deterministic draft (routed.reply)
        // on compose failure. Fail closed the same way unknown-item/browse
        // compose failures already do, scoped to this one action source only.
        const isActiveBlockingNowLaunch =
          Array.isArray(finalActionPlan?.actions) &&
          finalActionPlan.actions.some(
            (action) =>
              String(action?.payload?.source ?? "").trim() ===
              "canonical_owner_check_active_blocking_now"
          );
        if (
          isActiveBlockingNowLaunch &&
          composedLaunch.source !== "openai_cloud_canonical_compose"
        ) {
          // composedLaunch.ok/reply are not reliable failure signals here:
          // composeCloudCanonicalCustomerReply() falls back to fallbackReply
          // (which we set to finalReply — the deterministic draft — for
          // non-social kinds) and reports ok:true/reply:<fallback> whenever
          // that fallback is non-empty. Only source === the real-compose
          // marker proves OpenAI actually generated the wording.
          return buildSilentPipelineResult({
            traceId,
            channel,
            chatType,
            isGroupInbound: params.isGroupInbound,
            reason: `ACTIVE_BLOCKING_NOW_COMPOSE_FAIL_CLOSED:${composedLaunch.reason ?? "no_reply"}`,
          });
        }
        if (composedLaunch.ok && String(composedLaunch.reply ?? "").trim()) {
          finalReply = composedLaunch.reply;
          if (composedLaunch.source === "openai_cloud_canonical_compose") {
            finalReplySource = "CLOUD_CANONICAL_OPENAI_COMPOSE";
          }
        } else if (socialCompose) {
          // Social wording failure is not a missing-detail technical recovery.
          finalReply = "";
        }
      }
    }
    if (
      isCloudDmChannel({ channel, chatType, params }) &&
      shouldStampCloudPresentedItemFocus({
        turnScope: canonicalReleased?.turnScope,
        semanticIntent: authoritativeSemanticIntent,
        workflowType,
        finalReplySource,
      })
    ) {
      finalActionPlan = stampRememberPresentedItemFocusForSingleVerifiedItem(
        finalActionPlan,
        { catalogItems, allow: true }
      );
    }
    const emilySessionKey = String(turnContextInput._emilySessionKey ?? params.sessionKey ?? "").trim();
    applyInfoLiveSessionMemoryPatch({
      sessionKey: emilySessionKey,
      actionPlan: finalActionPlan,
      authoritativeItem: turnContextInput.authoritativeItem,
      sourceTurnId: `assistant:${String(params.messageId ?? traceId).trim()}`,
    });

    if (!String(finalReply ?? "").trim() && routed.intentionallySilent === true) {
      const silentReason = String(
        (Array.isArray(finalActionPlan?.actions) ? finalActionPlan.actions : []).find(
          (action) =>
            String(action?.type ?? "").trim() === "NO_OP" &&
            action?.payload?.intentionallySilent === true
        )?.payload?.reason ?? "INTENTIONAL_SILENT"
      ).trim();
      return buildSilentPipelineResult({
        traceId,
        channel,
        chatType,
        isGroupInbound: params.isGroupInbound,
        reason: silentReason || "INTENTIONAL_SILENT",
      });
    }

    console.log("[brain_v2_live_handled]", {
      traceId,
      businessId,
      workflowType,
      routingReason: result.workflowDecision?.reason ?? null,
      turnShape: turnContextInput.turnShape,
      participantIdentity: turnContextInput.participantIdentity,
      authoritativeItemId: turnContextInput.authoritativeItem?.id ?? null,
      ...(validatedGroupCanonicalReleased
        ? {
            canonicalTurnId: String(params.messageId ?? traceId).trim() || null,
            semanticDecisionSource:
              validatedGroupCanonicalReleased.semanticDecisionProvenance,
            semanticIntent: authoritativeSemanticIntent,
            itemScope: validatedGroupCanonicalReleased.itemScope ?? null,
            itemReferenceMode: turnContextInput.itemReferenceMode ?? null,
            resolvedItemState:
              resolvedBusinessTurnContext?.resolvedItem?.status ?? null,
            priorItemUsed:
              turnContextInput.itemReferenceMode === "CONTEXTUAL",
            priorItemReason:
              turnContextInput.itemReferenceMode === "CONTEXTUAL"
                ? "validated_contextual_referent"
                : "canonical_reference_not_contextual",
            finalReplySource,
          }
        : {}),
      blockedSideEffects: routed.blockedSideEffects,
      replyPreview: finalReply.slice(0, 120),
    });

    return finalizeLivePipelineResult({
      params,
      turnContextInput,
      workflowType,
      reply: finalReply,
      finalReplySource,
      actionPlan: finalActionPlan,
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
    if (params.abortSignal?.aborted) {
      throw params.abortSignal.reason ?? err;
    }
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
      ...(channel === "whatsapp_cloud" && chatType !== "group" && params.isGroupInbound !== true
        ? { customerTurnOutcome: "TECHNICAL_RECOVERY" }
        : {}),
    };
  }
}

function plannedActionReplyText(actionPlan) {
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  if (!plan) return "";
  const draft = String(plan.replyDraft ?? "").trim();
  if (draft) return draft;
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  for (const action of actions) {
    const text = String(action?.payload?.text ?? "").trim();
    if (text) return text;
  }
  return "";
}

/**
 * Owner-check was planned: customer gets holding only. Never fall through
 * into the launch availability composer or DB-isAvailable confirmation.
 */
async function finalizeCloudOwnerCheckLaunchHolding(p) {
  const {
    params,
    turnContextInput,
    workflowType,
    constrainedPlan,
    canonicalReleased,
    authoritativeSemanticIntent,
    catalogItems,
    flags,
    routed,
    sideEffectResults,
    bookingCreated,
    decisionTrace,
  } = p;
  let reply = CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY;
  if (shouldComposeCloudCanonicalLaunchReply(params)) {
    const composed = await composeCloudCanonicalCustomerReply({
      kind: "owner_check_holding",
      semanticIntent: authoritativeSemanticIntent,
      customerMessage: params.message,
      trustedFacts: {
        itemId: String(turnContextInput?.authoritativeItem?.id ?? "").trim() || null,
        itemLabel:
          String(
            turnContextInput?.authoritativeItem?.displayLabel ??
              turnContextInput?.authoritativeItem?.name ??
              ""
          ).trim() || null,
        answerKnown: false,
        ownerCheckPending: true,
      },
      fallbackReply: CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
      timeoutMs: params.__cloudComposeTimeoutMs ?? 8000,
      __chatCompletionsCreateForTests: params.__cloudComposeChatCreate ?? null,
    });
    if (composed.ok && String(composed.reply ?? "").trim()) {
      reply = composed.reply;
    }
  }
  let finalActionPlan = constrainedPlan;
  if (
    shouldStampCloudPresentedItemFocus({
      turnScope: canonicalReleased?.turnScope,
      semanticIntent: authoritativeSemanticIntent,
      workflowType,
      finalReplySource: "CLOUD_SEMANTIC_OWNER_CHECK",
    })
  ) {
    finalActionPlan = stampRememberPresentedItemFocusForSingleVerifiedItem(
      finalActionPlan,
      { catalogItems, allow: true }
    );
  }
  const emilySessionKey = String(
    turnContextInput._emilySessionKey ?? params.sessionKey ?? ""
  ).trim();
  applyInfoLiveSessionMemoryPatch({
    sessionKey: emilySessionKey,
    actionPlan: finalActionPlan,
    authoritativeItem: turnContextInput.authoritativeItem,
    sourceTurnId: `assistant:${String(params.messageId ?? params.traceId).trim()}`,
  });
  return finalizeLivePipelineResult({
    params,
    turnContextInput,
    workflowType,
    reply,
    finalReplySource: "CLOUD_SEMANTIC_OWNER_CHECK",
    actionPlan: finalActionPlan,
    flags,
    routed: {
      ...routed,
      sideEffectResults,
    },
    bookingCreated,
    decisionTrace,
  });
}

function isCloudDmChannel(p) {
  return (
    p.channel === "whatsapp_cloud" &&
    p.chatType !== "group" &&
    p.params?.isGroupInbound !== true
  );
}

function shouldStampCloudPresentedItemFocus(p) {
  const turnScope = String(p.turnScope ?? "").trim();
  const semanticIntent = String(p.semanticIntent ?? "").trim();
  const workflowType = String(p.workflowType ?? "").trim();
  const source = String(p.finalReplySource ?? "");
  if (turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR") return false;
  if (
    semanticIntent === "social" ||
    semanticIntent === "unclear" ||
    semanticIntent === "clarification" ||
    semanticIntent === "browse_options"
  ) {
    return false;
  }
  if (
    workflowType === "clarification" ||
    workflowType === "unknown_clarification" ||
    workflowType === "greeting" ||
    workflowType === "browse_options" ||
    workflowType === "unlisted_item"
  ) {
    return false;
  }
  if (source.includes("TECHNICAL")) return false;
  return true;
}

/**
 * Cloud details/business questions with a genuinely missing trusted fact
 * escalate to the existing missing-info owner-check. UNCLEAR/social/clarification
 * ownership never qualifies, and canned onboarding copy is not the qualifier.
 */
async function maybeCloudMissingFactOwnerCheckResult(p) {
  if (!isCloudDmChannel(p)) return null;
  if (isCloudUnclearOrSocialOwnership(p)) return null;

  const missingMedia = p.actionPlan?.missingTrustedMedia === true;
  const factualAsk = isCloudMissingBusinessFactIntent(p.authoritativeSemanticIntent);
  if (!missingMedia && !factualAsk) return null;

  if (!missingMedia && !canRepresentCloudMissingBusinessFact(p)) {
    return null;
  }

  if (!missingMedia) {
    const trustedFound = resolveCloudLaunchMissingFactResolution(p);
    if (isTrustedVerifiedFactResolution(trustedFound)) {
      return null;
    }
  }

  const params = p.params && typeof p.params === "object" ? p.params : {};
  const db = params.executionContext?.db ?? params.db ?? null;
  const customerPhone = String(params.participantPhoneForDm ?? "").trim() || null;
  const item = p.turnContextInput?.authoritativeItem;
  const itemId = String(item?.id ?? item?.itemId ?? "").trim() || null;
  const itemLabel =
    String(item?.displayLabel ?? item?.name ?? item?.label ?? "").trim() || null;
  const missingInfoType = missingInfoTypeForCloudCanonicalAsk({
    semanticIntent: p.authoritativeSemanticIntent,
    factKind: params.canonicalSemanticDecision?.factKind,
  });
  let execution = null;
  if (db && customerPhone && params.businessId) {
    execution = await executeCloudMissingBusinessFactOwnerCheck({
      db,
      businessId: params.businessId,
      customerPhone,
      messageText: params.message,
      messageId: params.messageId,
      sourceTurnId: params.messageId || params.guaranteeKey || null,
      itemId,
      itemLabel,
      missingInfoType,
      sendCredentials: params.executionContext?.sendCredentials ?? null,
      executionContext: params.executionContext ?? {},
      __createOrGetOpenPaMissingInfoRequestFn:
        params.__createOrGetOpenPaMissingInfoRequestFn,
      __sendPaMissingInfoOwnerNotificationFn:
        params.__sendPaMissingInfoOwnerNotificationFn,
      __sendWhatsAppMessageFn:
        params.executionContext?.sendWhatsAppMessageFn ??
        params.__sendWhatsAppMessageFn,
    });
  }

  const holdingAuthorized = isCloudMissingFactHoldingAuthorized(execution);
  const missingInfoRequest = execution
    ? {
        requestId: execution.missingInfoRequestId,
        missingInfoType: execution.missingInfoType,
        ownerNotifyStatus: execution.ownerNotifyStatus,
        itemId,
        itemLabel,
        reason: execution.reason,
      }
    : null;
  let actionPlan = {
    ...(p.actionPlan && typeof p.actionPlan === "object" ? p.actionPlan : {}),
    missingInfoRequestId: execution?.missingInfoRequestId ?? null,
    missingInfoType: execution?.missingInfoType ?? missingInfoType,
    ownerNotifyStatus: execution?.ownerNotifyStatus ?? null,
    itemId,
    itemLabel,
  };

  if (!holdingAuthorized) {
    return finalizeLivePipelineResult({
      params,
      turnContextInput: p.turnContextInput,
      workflowType: p.workflowType || "clarification",
      reply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
      finalReplySource: "CLOUD_SEMANTIC_TECHNICAL_RECOVERY",
      actionPlan,
      flags: getEmilyBrainV2LiveFlagSnapshot(),
      routed: null,
      bookingCreated: null,
      customerTurnOutcome: "TECHNICAL_RECOVERY",
      reason:
        execution?.reason ||
        (!db ? "DB_UNAVAILABLE" : "OWNER_CHECK_NOT_AUTHORIZED"),
      missingInfoRequest,
    });
  }

  let reply = CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY;
  if (shouldComposeCloudCanonicalLaunchReply(params)) {
    const composed = await composeCloudCanonicalCustomerReply({
      kind: "owner_check_holding",
      semanticIntent: p.authoritativeSemanticIntent,
      customerMessage: params.message,
      trustedFacts: {
        itemId,
        itemLabel,
        answerKnown: false,
        ownerCheckPending: true,
      },
      fallbackReply: CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
      timeoutMs: params.__cloudComposeTimeoutMs ?? 8000,
      __chatCompletionsCreateForTests: params.__cloudComposeChatCreate ?? null,
    });
    if (composed.ok && String(composed.reply ?? "").trim()) {
      reply = composed.reply;
    }
  }

  if (holdingAuthorized && itemId) {
    actionPlan = stampRememberPresentedItemFocusForSingleVerifiedItem(
      {
        ...actionPlan,
        actions:
          Array.isArray(actionPlan.actions) && actionPlan.actions.length
            ? actionPlan.actions
            : [
                {
                  type: "REPLY",
                  payload: {
                    text: reply,
                    itemId,
                    itemLabel,
                    presentedItemIds: [itemId],
                  },
                },
              ],
        persistenceIntent: {
          ...(actionPlan.persistenceIntent && typeof actionPlan.persistenceIntent === "object"
            ? actionPlan.persistenceIntent
            : {}),
          rememberResolvedItem: true,
          itemId,
          execute: false,
        },
      },
      { catalogItems: Array.isArray(p.catalogItems) ? p.catalogItems : [], allow: true }
    );
  }

  return finalizeLivePipelineResult({
    params,
    turnContextInput: p.turnContextInput,
    workflowType: p.workflowType || "clarification",
    reply,
    finalReplySource: "CLOUD_SEMANTIC_OWNER_CHECK",
    actionPlan,
    flags: getEmilyBrainV2LiveFlagSnapshot(),
    routed: null,
    bookingCreated: null,
    customerTurnOutcome: "OWNER_CHECK",
    missingInfoRequest,
  });
}

function isCloudUnclearOrSocialOwnership(p) {
  const intent = String(p.authoritativeSemanticIntent ?? "").trim();
  const turnScope = String(
    p.params?.canonicalSemanticDecision?.turnScope ?? p.turnScope ?? ""
  ).trim();
  return (
    intent === "unclear" ||
    intent === "social" ||
    intent === "clarification" ||
    turnScope === "UNCLEAR" ||
    turnScope === "SOCIAL_GENERAL"
  );
}

function canRepresentCloudMissingBusinessFact(p) {
  if (isCloudUnclearOrSocialOwnership(p)) return false;
  if (!isCloudMissingBusinessFactIntent(p.authoritativeSemanticIntent)) {
    return false;
  }
  const decision =
    p.params?.canonicalSemanticDecision &&
    typeof p.params.canonicalSemanticDecision === "object"
      ? p.params.canonicalSemanticDecision
      : {};
  const factKind = String(decision.factKind ?? "").trim();
  if (factKind === "vague" || factKind === "non_business") {
    return false;
  }
  const item = p.turnContextInput?.authoritativeItem;
  const itemId = String(item?.id ?? item?.itemId ?? "").trim();
  if (String(p.authoritativeSemanticIntent ?? "").trim() === "details_inquiry" && !itemId) {
    return false;
  }
  return true;
}

function resolveCloudLaunchMissingFactResolution(p) {
  const decision =
    p.params?.canonicalSemanticDecision &&
    typeof p.params.canonicalSemanticDecision === "object"
      ? p.params.canonicalSemanticDecision
      : {};
  const business =
    p.resolvedBusinessTurnContext?.business &&
    typeof p.resolvedBusinessTurnContext.business === "object"
      ? p.resolvedBusinessTurnContext.business
      : {};
  return resolvePostConfirmRequestedFact({
    capability: decision.capability,
    evidenceNeeds: decision.evidenceNeeds,
    facts: {
      business,
      known: business,
      catalogItems: Array.isArray(p.catalogItems) ? p.catalogItems : [],
    },
  });
}

function shouldComposeCloudCanonicalLaunchReply(params) {
  if (typeof params?.__cloudComposeChatCreate === "function") return true;
  return String(process.env.NODE_ENV ?? "").trim() !== "test";
}

function cloudCanonicalComposeKind(p) {
  const workflowType = String(p.workflowType ?? "").trim();
  const intent = String(p.semanticIntent ?? "").trim();
  const turnScope = String(p.turnScope ?? "").trim();
  if (intent === "social" || turnScope === "SOCIAL_GENERAL") {
    return "social";
  }
  if (workflowType === "image_catalog_request" || intent === "image_catalog_request") {
    return "image_intro";
  }
  if (workflowType === "pricing_with_duration" || intent === "pricing_with_duration") {
    return "pricing_with_duration";
  }
  if (workflowType === "pricing_inquiry" || intent === "pricing_inquiry") {
    return "pricing";
  }
  if (workflowType === "availability_inquiry" || intent === "availability_inquiry") {
    const actions = Array.isArray(p.actionPlan?.actions) ? p.actionPlan.actions : [];
    // A trusted date-bearing temporal claim exists but could not be resolved
    // (see AvailabilityInquiryWorkflow's temporal-unresolved safety gate).
    // This is its own narrow kind — it must not ask for duration again when
    // durationDays is already known, which duration_ask's contract does not
    // represent.
    const asksTemporalClarification = actions.some(
      (action) =>
        String(action?.payload?.source ?? "") === "canonical_owner_check_ask_temporal_clarification"
    );
    if (asksTemporalClarification) return "temporal_clarification";
    const asksDuration = actions.some(
      (action) =>
        String(action?.payload?.pendingStage ?? "").includes("duration") ||
        /kitne din/i.test(String(action?.payload?.text ?? p.actionPlan?.replyDraft ?? ""))
    );
    return asksDuration ? "duration_ask" : "availability";
  }
  if (workflowType === "booking_request" || intent === "booking_request") {
    return "booking_status";
  }
  if (
    workflowType === "clarification" ||
    workflowType === "unknown_clarification" ||
    intent === "clarification" ||
    intent === "unclear"
  ) {
    return "clarification";
  }
  return null;
}

export function trustedFactsForCloudCompose(p) {
  const composeKind =
    String(p.composeKind ?? "").trim() ||
    cloudCanonicalComposeKind(p) ||
    "";
  if (composeKind === "social") {
    return {};
  }
  const verified =
    p.resolvedBusinessTurnContext?.verified &&
    typeof p.resolvedBusinessTurnContext.verified === "object"
      ? p.resolvedBusinessTurnContext.verified
      : {};
  const item = p.resolvedBusinessTurnContext?.resolvedItem ?? null;
  const actions = Array.isArray(p.actionPlan?.actions) ? p.actionPlan.actions : [];
  const imageUrls = extractTrustedImageUrlsFromActionPlan(p.actionPlan);
  const pricing =
    verified.pricing && typeof verified.pricing === "object" ? verified.pricing : {};
  const quote =
    verified.priceQuote && typeof verified.priceQuote === "object"
      ? verified.priceQuote
      : {};
  const positiveNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    itemId: String(item?.id ?? "").trim() || null,
    itemLabel: String(item?.displayLabel ?? item?.name ?? "").trim() || null,
    dailyRate: positiveNumber(pricing.daily ?? quote.dailyRate),
    monthlyRate: positiveNumber(pricing.monthly ?? quote.monthlyRate),
    totalAmount: positiveNumber(quote.total ?? pricing.total),
    ...(composeKind === "pricing_with_duration"
      ? {
          durationDays:
            Number.isFinite(Number(quote.durationDays)) &&
            Number(quote.durationDays) >= 1
              ? Math.floor(Number(quote.durationDays))
              : null,
        }
      : {}),
    ...(composeKind === "temporal_clarification"
      ? {
          // Trusted rental duration if the customer already stated one — the
          // temporal_clarification prompt must preserve it, not re-ask for it.
          durationDays:
            Number.isFinite(Number(p.resolvedBusinessTurnContext?.turn?.durationDays)) &&
            Number(p.resolvedBusinessTurnContext?.turn?.durationDays) >= 1
              ? Math.floor(Number(p.resolvedBusinessTurnContext.turn.durationDays))
              : null,
          dateWindowConfidence: String(verified.availability?.dateWindowConfidence ?? "").trim() || null,
          // Explicit objective signal beyond dateWindowConfidence: the single
          // AI temporal owner flagged a start date it could not resolve —
          // the customer must be asked to clarify it, nothing else.
          clarifyStartDate: verified.availability?.dateWindowConfidence === "temporal_unresolved",
          // WHY it is unresolved — an invalid calendar date (31 February) is
          // a different customer situation from an ambiguous reference
          // ("next Friday"), and must not get identical wording. Deterministic
          // fact only; the composer still owns natural phrasing per reason.
          dateIssueReason:
            verified.availability?.dateWindowConfidence === "temporal_unresolved"
              ? (verified.availability?.temporalUnresolvedReason === "invalid_date"
                  ? "invalid_date"
                  : "ambiguous_date")
              : null,
        }
      : {}),
    currency: String(pricing.currency ?? quote.currency ?? "PKR").trim() || "PKR",
    availabilityStatus: String(verified.availability?.status ?? "").trim() || null,
    // Distinguishes "a blocking-status booking exists, no specific dates
    // requested yet" (booking may not have even started) from a per-window
    // confirmed check — without this, availabilityStatus=unavailable alone
    // cannot tell the composer whether the customer's actual requested period
    // was ever evaluated, or whether the booking is even active yet.
    availabilityWindowRequested: Boolean(verified.availability?.windowApplied),
    // Resolver-proven from real start/end dates (never inferred here): the
    // item has a blocking booking that has already started and not yet
    // ended, as of now. Only this fact licenses a present-moment ("abhi"/
    // "currently") occupancy claim — a merely-existing future or
    // unknown-start booking must not.
    hasActiveBlockingBookingNow: Boolean(verified.availability?.hasActiveBlockingBookingNow),
    // DB/catalog isAvailable is internal evidence only. Confirmed availability
    // is reserved for the approved-lifecycle composer, not this launch path.
    availabilityConfirmed: false,
    bookingCreated: Boolean(p.bookingCreated),
    bookingId: p.bookingCreated?.id ?? null,
    imageCount: imageUrls.length,
    hasTrustedImages: imageUrls.length > 0,
    ownerCheckPlanned: actions.some(
      (action) =>
        String(action?.type ?? "").trim() === "AVAILABILITY_OWNER_CHECK_REQUIRED"
    ),
  };
}

function extractTrustedImageUrlsFromActionPlan(actionPlan) {
  const actions = Array.isArray(actionPlan?.actions) ? actionPlan.actions : [];
  const urls = [];
  for (const action of actions) {
    const raw = action?.payload?.whatsappImageUrls;
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      const url = String(entry ?? "").trim();
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

/**
 * @param {Record<string, unknown>} p
 */
function deriveCloudCustomerTurnOutcome(p) {
  if (p.customerTurnOutcome) return p.customerTurnOutcome;
  const source = String(p.finalReplySource ?? "");
  if (source.includes("OWNER_CHECK")) return "OWNER_CHECK";
  if (source.includes("TECHNICAL") || p.workflowType === "error_apology") {
    return "TECHNICAL_RECOVERY";
  }
  const actions = Array.isArray(p.actionPlan?.actions) ? p.actionPlan.actions : [];
  const actionTypes = actions.map((action) => String(action?.type ?? "").trim());
  if (
    actionTypes.includes("NOTIFY_OWNER") ||
    actionTypes.includes("AVAILABILITY_OWNER_CHECK_REQUIRED")
  ) {
    return "OWNER_CHECK";
  }
  if (p.bookingCreated || actionTypes.includes("CREATE_BOOKING")) {
    return "SAFE_ACTION";
  }
  const frozen = p.params?.canonicalSemanticDecision;
  const scope = String(frozen?.turnScope ?? "").trim();
  const intent = String(
    p.turnContextInput?.authoritativeSemanticIntent ?? frozen?.semanticIntent ?? ""
  ).trim();
  if (scope === "SOCIAL_GENERAL" || intent === "social") {
    return "ANSWER";
  }
  if (
    scope === "UNCLEAR" ||
    intent === "unclear" ||
    intent === "clarification" ||
    p.workflowType === "clarification" ||
    p.workflowType === "unknown_clarification"
  ) {
    return "CUSTOMER_CLARIFICATION";
  }
  return "ANSWER";
}

/**
 * @param {Record<string, unknown>} p
 */
function finalizeLivePipelineResult(p) {
  assertBrainV2ExecutionActive(p.params);
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
    abortSignal: p.params.abortSignal,
    executionGuard: p.params.executionGuard,
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
    missingInfoRequest: p.missingInfoRequest ?? null,
  });

  const outbound = executeOutboundReply({
    reply,
    messageMeta,
    routingCtx,
  });

  const cloudDm =
    String(p.params?.channel ?? p.turnContextInput?.channel ?? "") === "whatsapp_cloud" &&
    String(p.params?.chatType ?? p.turnContextInput?.chatType ?? "") !== "group" &&
    p.params?.isGroupInbound !== true;
  const customerTurnOutcome = cloudDm ? deriveCloudCustomerTurnOutcome(p) : null;

  return {
    handled: true,
    reply: outbound.reply,
    sendVia: outbound.sendVia,
    dmRecipientPhone: outbound.dmRecipientPhone ?? null,
    messageMeta: outbound.messageMeta,
    workflowType: p.workflowType,
    reason: p.reason || "V2_LIVE_OK",
    legacyBypassed: true,
    ...(customerTurnOutcome ? { customerTurnOutcome } : {}),
  };
}

/** @param {Record<string, unknown>} params */
function assertBrainV2ExecutionActive(params) {
  if (params?.abortSignal?.aborted) {
    throw params.abortSignal.reason ?? new Error("Brain V2 execution aborted");
  }
  params?.executionGuard?.assertActive?.();
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
  const turnScope = String(
    p.turnScope ?? params.canonicalSemanticDecision?.turnScope ?? ""
  ).trim();
  const intent = String(
    p.authoritativeSemanticIntent ??
      params.canonicalSemanticDecision?.semanticIntent ??
      ""
  ).trim();
  if (turnScope === "UNCLEAR" || intent === "unclear") {
    return null;
  }
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
    channel: p.channel ?? params.channel,
    chatType: p.chatType ?? params.chatType,
    isGroupInbound: params.isGroupInbound,
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
  const reason = String(p.reason ?? "");
  const cloudDm =
    p.channel === "whatsapp_cloud" &&
    p.chatType !== "group" &&
    p.isGroupInbound !== true;
  if (cloudDm && reason.includes("OWNER_CHECK")) {
    return {
      handled: true,
      reply: CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
      sendVia: "CLOUD_API",
      dmRecipientPhone: null,
      customerTurnOutcome: "OWNER_CHECK",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE",
        outboundTrace: {
          finalReplySource: "CLOUD_SEMANTIC_OWNER_CHECK",
          reason,
        },
        brainV2Live: true,
        traceId: p.traceId,
      },
      reason,
      legacyBypassed: true,
    };
  }
  if (
    cloudDm &&
    (reason === "CANONICAL_SEMANTIC_INTENT_INVALID" ||
      reason.includes("FAIL_CLOSED"))
  ) {
    return {
      handled: true,
      reply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
      sendVia: "CLOUD_API",
      dmRecipientPhone: null,
      customerTurnOutcome: "TECHNICAL_RECOVERY",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE",
        outboundTrace: {
          finalReplySource: "CLOUD_SEMANTIC_TECHNICAL_RECOVERY",
          reason,
        },
        brainV2Live: true,
        traceId: p.traceId,
      },
      reason,
      legacyBypassed: true,
    };
  }
  return {
    handled: true,
    reply: "",
    sendVia: "NONE",
    dmRecipientPhone: null,
    messageMeta: {
      routeType: "BRAIN_V2_LIVE_SILENT",
      outboundTrace: { finalReplySource: "BRAIN_V2_LIVE_SILENT", reason },
      brainV2Live: true,
      traceId: p.traceId,
    },
    reason,
    legacyBypassed: true,
  };
}

/**
 * @param {Record<string, unknown>} p
 */
function buildLiveMessageMeta(p) {
  const imageUrls = extractTrustedImageUrlsFromActionPlan(p.actionPlan);
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
    ...(imageUrls.length
      ? {
          whatsappImageUrls: imageUrls,
          deliveryIntent: "show_images",
        }
      : {}),
    ...(p.missingInfoRequest
      ? { missingInfoRequest: p.missingInfoRequest }
      : {}),
  };
}
