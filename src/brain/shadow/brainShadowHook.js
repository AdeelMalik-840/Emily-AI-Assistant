/**
 * Log-only Emily Brain v2 shadow — evaluates v2 decisions without side effects.
 * Never sends, books, notifies owner, or mutates session/cursor/ledger state.
 */
import { chatSessionKey } from "../../services/memory.js";
import { resolveGroupParticipantContextKey } from "../../services/groupParticipantContext.js";
import {
  isEmilyBrainV2ShadowEnabledForBusiness,
  getEmilyBrainV2ShadowFlagSnapshot,
} from "../config/featureFlags.js";

const DEFAULT_SHADOW_TIMEOUT_MS = Math.max(
  250,
  Math.min(
    10_000,
    Number.parseInt(String(process.env.EMILY_BRAIN_V2_SHADOW_TIMEOUT_MS ?? "3000"), 10) ||
      3000
  )
);

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} messageMeta
 */
function summarizeLegacyOutcome(messageMeta) {
  const meta = asObject(messageMeta) ?? {};
  const outboundTrace = asObject(meta.outboundTrace) ?? {};
  const bookingCreated = asObject(meta.bookingCreated);
  return {
    finalReplySource:
      String(outboundTrace.finalReplySource ?? meta.finalReplySource ?? "").trim() || null,
    routeType: String(meta.routeType ?? outboundTrace.routeType ?? "").trim() || null,
    bookingCreated: Boolean(bookingCreated),
    bookingId: bookingCreated ? String(bookingCreated.id ?? "").trim() || null : null,
    replyPreview: String(meta.replyPreview ?? meta.reply ?? "").slice(0, 120) || null,
  };
}

/**
 * @param {string | null | undefined} legacyRouteType
 * @param {Record<string, unknown>} legacySummary
 * @param {string | null | undefined} v2WorkflowType
 */
function inferLegacyWorkflowComparable(legacyRouteType, legacySummary, v2WorkflowType) {
  if (legacySummary.bookingCreated || /booking/i.test(String(legacyRouteType ?? ""))) {
    return "booking_request";
  }
  const source = String(legacySummary.finalReplySource ?? "");
  if (/PRIC|price_with_duration|FUZZY_CATALOG_CONFIRMED_PRICING/i.test(source)) {
    return "pricing_with_duration";
  }
  if (/COLLECT_DURATION|AVAIL|INFORMATIONAL|FUZZY_CATALOG_CONFIRMED/i.test(source)) {
    if (v2WorkflowType === "availability_inquiry") return "availability_inquiry";
    if (v2WorkflowType === "browse_options") return "browse_options";
    return "informational_or_availability";
  }
  return String(legacyRouteType ?? "").trim() || null;
}

/**
 * @param {import("../contracts/action.js").ActionPlan | null | undefined} actionPlan
 */
function summarizeActionPlan(actionPlan) {
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  return {
    planId: plan?.planId ?? null,
    actionTypes: actions.map((a) => String(a?.type ?? "")).filter(Boolean),
    executeFlags: actions.map((a) => Boolean(asObject(a?.payload)?.execute)),
    replyPreview: String(plan?.replyDraft ?? "").slice(0, 120) || null,
  };
}

/**
 * @param {{
 *   businessId: string,
 *   ownerUserId?: string,
 *   sessionKey?: string,
 *   participantKey?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 * }} p
 */
export function resolveShadowEmilySessionKey(p) {
  const businessId = String(p.businessId ?? p.ownerUserId ?? "").trim();
  const chatContextKey = resolveGroupParticipantContextKey({
    isGroupInbound: Boolean(p.isGroupInbound),
    sessionKey: String(p.sessionKey ?? "").trim(),
    playwrightChatKey: String(p.playwrightChatKey ?? "").trim(),
    participantKey: String(p.participantKey ?? "").trim(),
    businessId,
    userId: businessId,
  });
  return chatSessionKey(businessId, chatContextKey);
}

/**
 * @param {{
 *   businessId: string,
 *   sessionKey?: string,
 *   participantKey?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   conversationHistory?: string,
 * }} p
 */
export function buildShadowTurnContext(p) {
  const businessId = String(p.businessId ?? "").trim();
  const emilySessionKey = resolveShadowEmilySessionKey(p);
  const mem = structuredClone(p.memorySnapshot ?? {});
  const pendingAction = asObject(mem.pendingAction);
  const lastResolvedItemId =
    String(mem.lastResolvedItemId ?? asObject(mem.lastItem)?.id ?? "").trim() || null;

  return {
    sessionId: emilySessionKey,
    businessId,
    chatKey:
      String(p.playwrightChatKey ?? p.sessionKey ?? "").trim() ||
      emilySessionKey,
    participantKey: String(p.participantKey ?? "").trim() || "unknown",
    schemaVersion: 1,
    activeWorkflowType:
      String(pendingAction?.type ?? "").trim() === "collect_duration"
        ? "collect_duration"
        : undefined,
    lastResolvedItemId,
    memorySnapshot: mem,
    conversationHistoryBlock: String(p.conversationHistory ?? "").slice(0, 4000) || undefined,
  };
}

/**
 * @param {{
 *   traceId: string,
 *   businessId: string,
 *   message: string,
 *   messageId?: string | null,
 *   channelId?: string,
 *   chatKey?: string | null,
 *   participantKey?: string | null,
 *   admissionReason?: string,
 * }} p
 */
export function buildShadowAdmittedTurn(p) {
  const traceId = String(p.traceId ?? "").trim();
  const businessId = String(p.businessId ?? "").trim();
  const message = String(p.message ?? "").trim();
  const turnId = String(p.messageId ?? traceId).trim() || traceId;

  return {
    turn: {
      turnId,
      businessId,
      channelId: String(p.channelId ?? "whatsapp_web").trim() || "whatsapp_web",
      chatKey: String(p.chatKey ?? "").trim(),
      participantKey: String(p.participantKey ?? "").trim() || "unknown",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `${traceId}::shadow`,
    admissionReason: String(p.admissionReason ?? "shadow_real_customer_inbound").trim(),
  };
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} payload
 */
export function logEmilyBrainShadowTrace(stage, payload) {
  console.log("[emily_brain_shadow]", {
    stage,
    ...payload,
  });
}

/**
 * @param {import("../contracts/action.js").ActionPlan | null | undefined} actionPlan
 */
export function assertShadowActionPlanIsNonExecuting(actionPlan) {
  const summary = summarizeActionPlan(actionPlan);
  for (const execute of summary.executeFlags) {
    if (execute === true) {
      throw new Error("shadow_action_plan_execute_true");
    }
  }
  const persistence = asObject(actionPlan?.persistenceIntent);
  if (persistence?.execute === true) {
    throw new Error("shadow_persistence_execute_true");
  }
}

/**
 * @param {{
 *   traceId: string,
 *   businessId: string,
 *   message: string,
 *   messageId?: string | null,
 *   channelId?: string,
 *   chatKey?: string | null,
 *   participantKey?: string | null,
 *   sessionKey?: string,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   playwrightWebInbound?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   conversationHistory?: string,
 *   inboundSourceOrigin?: string,
 *   legacyOutcome?: { reply?: string, messageMeta?: Record<string, unknown> | null },
 *   timeoutMs?: number,
 *   catalogItems?: unknown[],
 *   __testOrchestratorFn?: (args: Record<string, unknown>) => unknown,
 * }} params
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function runEmilyBrainV2ShadowEvaluation(params) {
  const businessId = String(params.businessId ?? "").trim();
  if (!isEmilyBrainV2ShadowEnabledForBusiness(businessId)) {
    return null;
  }

  const traceId = String(params.traceId ?? "").trim() || "shadow-missing-trace";
  const message = String(params.message ?? "").trim();
  const timeoutMs = Number.isFinite(Number(params.timeoutMs))
    ? Math.max(100, Number(params.timeoutMs))
    : DEFAULT_SHADOW_TIMEOUT_MS;

  const flags = getEmilyBrainV2ShadowFlagSnapshot();
  const startedAt = Date.now();

  const run = async () => {
    const [{ evaluateInboundAdmissionContract }, catalogMod] = await Promise.all([
      import("../admission/admissionContract.js"),
      import("../../services/inventoryService.js"),
    ]);

    const chatKey =
      String(params.playwrightChatKey ?? params.chatKey ?? "").trim() ||
      String(params.sessionKey ?? "").trim();

    const admission = evaluateInboundAdmissionContract({
      text: message,
      chatKey,
      businessId,
      participantKey: String(params.participantKey ?? "").trim() || undefined,
      channelId: params.channelId,
      turnId: String(params.messageId ?? traceId).trim() || traceId,
    });

    if (!admission.admitted || !admission.admittedTurn) {
      logEmilyBrainShadowTrace("admission_skipped", {
        traceId,
        businessId,
        channel: params.channelId ?? (params.playwrightWebInbound ? "whatsapp_web" : "whatsapp"),
        chatKey,
        participantKey: String(params.participantKey ?? "").trim() || null,
        inboundPreview: message.slice(0, 120),
        shadowFlags: flags,
        admission: {
          admitted: false,
          skipReason: admission.skipReason,
          skipCategory: admission.skipCategory,
          sourceOrigin: admission.sourceOrigin,
          layer: admission.admissionLayer ?? null,
        },
        shadowInputSource: "live_pipeline_post_legacy_admission",
        durationMs: Date.now() - startedAt,
      });
      return { skipped: true, reason: admission.skipReason };
    }

    const turnContext = buildShadowTurnContext({
      businessId,
      sessionKey: params.sessionKey,
      participantKey: params.participantKey,
      playwrightChatKey: params.playwrightChatKey ?? params.chatKey,
      isGroupInbound: params.isGroupInbound,
      memorySnapshot: params.memorySnapshot,
      conversationHistory: params.conversationHistory,
    });

    const catalogItems = Array.isArray(params.catalogItems)
      ? params.catalogItems
      : await catalogMod.getCachedItemsForUser(businessId);

    const orchestratorInput = {
      traceId: `${traceId}::shadow`,
      admittedTurn: admission.admittedTurn,
      turnContext,
      businessContext: {
        catalogItems,
        // Deferred: load profile/category/instructions from Firestore per businessId.
        // casual_local is acceptable for first shadow canary only, not multi-business execution.
        conversationStyle: "casual_local",
      },
    };

    /** @type {import("../orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} */
    let result;
    if (
      process.env.NODE_ENV === "test" &&
      typeof params.__testOrchestratorFn === "function"
    ) {
      result = /** @type {any} */ (params.__testOrchestratorFn(orchestratorInput));
    } else {
      const { runConversationTurn } = await import(
        "../orchestrator/ConversationOrchestrator.js"
      );
      result = runConversationTurn(orchestratorInput);
    }

    assertShadowActionPlanIsNonExecuting(result.actionPlan);

    const legacySummary = summarizeLegacyOutcome(params.legacyOutcome?.messageMeta ?? null);
    const legacyComparable = inferLegacyWorkflowComparable(
      legacySummary.routeType,
      legacySummary,
      result.workflowDecision?.workflowType
    );
    const v2WorkflowType = result.workflowDecision?.workflowType ?? null;
    const differsFromLegacy =
      legacyComparable && v2WorkflowType
        ? legacyComparable !== v2WorkflowType
        : null;

    const shadowPayload = {
      traceId,
      businessId,
      channel: params.channelId ?? (params.playwrightWebInbound ? "whatsapp_web" : "whatsapp"),
      chatKey,
      participantKey: String(params.participantKey ?? "").trim() || null,
      inboundPreview: message.slice(0, 120),
      shadowFlags: flags,
      shadowInputSource: "live_pipeline_post_legacy_admission",
      inboundSourceOrigin: String(params.inboundSourceOrigin ?? "real_customer_inbound"),
      admission: {
        admitted: true,
        skipReason: null,
        skipCategory: null,
        sourceOrigin: admission.sourceOrigin,
        layer: admission.admissionLayer ?? "admitted",
      },
      understanding: {
        resolvedItemId: result.understanding?.resolvedItemId ?? null,
        resolvedItemLabel: result.understanding?.resolvedItemLabel ?? null,
        itemSource: result.understanding?.itemSource ?? null,
        durationDays: result.understanding?.durationDays ?? null,
        askedField: result.understanding?.askedField ?? null,
      },
      workflowDecision: {
        workflowType: v2WorkflowType,
        reason: result.workflowDecision?.reason ?? null,
      },
      actionPlan: summarizeActionPlan(result.actionPlan),
      legacy: {
        ...legacySummary,
        replyPreview:
          legacySummary.replyPreview ||
          String(params.legacyOutcome?.reply ?? "").slice(0, 120) ||
          null,
      },
      differsFromLegacy,
      durationMs: Date.now() - startedAt,
    };

    logEmilyBrainShadowTrace("complete", shadowPayload);
    return shadowPayload;
  };

  let timeoutId;
  try {
    const shadowResult = await Promise.race([
      run(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("shadow_timeout")), timeoutMs);
      }),
    ]);
    return /** @type {Record<string, unknown>} */ (shadowResult);
  } catch (err) {
    logEmilyBrainShadowTrace("error", {
      traceId,
      businessId,
      inboundPreview: message.slice(0, 120),
      shadowFlags: flags,
      error: String(err?.message ?? err ?? "shadow_failed").slice(0, 200),
      durationMs: Date.now() - startedAt,
    });
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Fire-and-forget shadow evaluation — must never throw to caller.
 *
 * @param {Parameters<typeof runEmilyBrainV2ShadowEvaluation>[0]} params
 */
export function scheduleEmilyBrainV2ShadowEvaluation(params) {
  void runEmilyBrainV2ShadowEvaluation(params).catch((err) => {
    logEmilyBrainShadowTrace("schedule_error", {
      traceId: String(params?.traceId ?? "").trim() || null,
      businessId: String(params?.businessId ?? "").trim() || null,
      error: String(err?.message ?? err ?? "shadow_schedule_failed").slice(0, 200),
    });
  });
}
