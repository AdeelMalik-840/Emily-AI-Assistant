/**
 * Shared Brain conversational decision authority (seed).
 *
 * One Brain, many safe executors — this is the shared customer-turn entrypoint.
 * Lanes: `post_confirm_pa`, `waiting_confirm_dm`, `group_post_execute`.
 *
 * Not a second Brain. Not a PA Brain. No parallel decision system.
 */

import {
  executePostConfirmPaLaneDecision,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} from "./decidePostConfirmCustomerDm.js";
import {
  executeWaitingConfirmDmLaneDecision,
  WAITING_CONFIRM_DM_LANE,
} from "./waitingConfirmDmLane.js";
import {
  executeGroupPostExecuteLaneDecision,
  GROUP_POST_EXECUTE_LANE,
} from "./groupPostExecuteLane.js";

export const CUSTOMER_TURN_LANES = Object.freeze([
  "post_confirm_pa",
  WAITING_CONFIRM_DM_LANE,
  GROUP_POST_EXECUTE_LANE,
]);

/**
 * @typedef {object} TurnContext
 * @property {string | null} [lane]
 * @property {string | null} [channel]
 * @property {string | null} [chatType]
 * @property {string | null} [businessId]
 * @property {string | null} [customerPhone]
 * @property {string | null} [messageText]
 * @property {string | null} [messageId]
 * @property {string | null} [recentDialogue]
 * @property {string | null} [lastEmilyMessage]
 * @property {string | null} [lastCustomerDmPromptType]
 * @property {Record<string, unknown> | null} [activeBooking]
 * @property {Record<string, unknown> | null} [activeAvailabilityRequest]
 * @property {Record<string, unknown> | null} [knownPolicies]
 * @property {unknown[] | null} [openMissingInfoRequests]
 * @property {unknown[] | null} [latestClosedMissingInfoAnswers]
 * @property {unknown[] | null} [pendingPromises]
 * @property {string | null} [conversationStageHint]
 * @property {string | null} [ownershipLane]
 * @property {string | null} [verifiedFactsJson]
 * @property {Record<string, unknown> | null} [safetyPolicy]
 * @property {string[] | null} [allowedExecutors]
 * @property {Record<string, unknown> | null} [facts]
 * @property {"casual_local" | "neutral_english" | null} [styleKey]
 * @property {number | null} [timeoutMs]
 * @property {boolean | null} [missingInfoLoopFullyEnabled]
 * @property {Function | null} [__chatCompletionsCreateForTests]
 */

function cleanLane(value) {
  const lane = String(value ?? "")
    .trim()
    .toLowerCase();
  return lane || null;
}

/**
 * Compatibility-only normalization for older post-confirm fact shapes.
 * Canonical resolver output already includes bookingCandidates; when it does,
 * preserve it exactly. Legacy activeBookings are copied into candidate rows so
 * clarification can use customer-safe identities without selecting a booking.
 */
function normalizePostConfirmBookingCandidates(rawFacts) {
  const facts =
    rawFacts && typeof rawFacts === "object"
      ? /** @type {Record<string, unknown>} */ (rawFacts)
      : {};
  if (
    Array.isArray(facts.bookingCandidates) &&
    facts.bookingCandidates.length > 0
  ) {
    return facts;
  }
  if (!Array.isArray(facts.activeBookings) || facts.activeBookings.length === 0) {
    return facts;
  }
  return {
    ...facts,
    bookingCandidates: facts.activeBookings.map((row, index) => ({
      ...(row && typeof row === "object" ? row : {}),
      selectionIndex:
        Number.isInteger(Number(row?.selectionIndex)) &&
        Number(row.selectionIndex) >= 1
          ? Number(row.selectionIndex)
          : index + 1,
    })),
  };
}

/**
 * Normalize a shared TurnContext. Missing fields are safe nulls.
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {TurnContext}
 */
export function normalizeTurnContext(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const facts =
    r.facts && typeof r.facts === "object"
      ? /** @type {Record<string, unknown>} */ (r.facts)
      : null;

  return {
    lane: cleanLane(r.lane) || cleanLane(r.ownershipLane),
    channel: r.channel != null ? String(r.channel) : null,
    chatType: r.chatType != null ? String(r.chatType) : null,
    businessId:
      r.businessId != null
        ? String(r.businessId)
        : facts?.businessId != null
          ? String(facts.businessId)
          : null,
    customerPhone:
      r.customerPhone != null
        ? String(r.customerPhone)
        : facts?.customerPhoneDigits != null
          ? String(facts.customerPhoneDigits)
          : null,
    messageText:
      r.messageText != null
        ? String(r.messageText)
        : r.userMessage != null
          ? String(r.userMessage)
          : null,
    messageId: r.messageId != null ? String(r.messageId) : null,
    recentDialogue:
      r.recentDialogue != null
        ? String(r.recentDialogue)
        : r.conversationHistory != null
          ? String(r.conversationHistory)
          : null,
    lastEmilyMessage:
      r.lastEmilyMessage != null ? String(r.lastEmilyMessage) : null,
    lastCustomerDmPromptType:
      r.lastCustomerDmPromptType != null
        ? String(r.lastCustomerDmPromptType)
        : null,
    activeBooking:
      r.activeBooking && typeof r.activeBooking === "object"
        ? /** @type {Record<string, unknown>} */ (r.activeBooking)
        : facts?.booking && typeof facts.booking === "object"
          ? /** @type {Record<string, unknown>} */ (facts.booking)
          : null,
    activeAvailabilityRequest:
      r.activeAvailabilityRequest &&
      typeof r.activeAvailabilityRequest === "object"
        ? /** @type {Record<string, unknown>} */ (r.activeAvailabilityRequest)
        : facts?.availabilityRequest &&
            typeof facts.availabilityRequest === "object"
          ? /** @type {Record<string, unknown>} */ (facts.availabilityRequest)
          : null,
    knownPolicies:
      r.knownPolicies && typeof r.knownPolicies === "object"
        ? /** @type {Record<string, unknown>} */ (r.knownPolicies)
        : facts?.known && typeof facts.known === "object"
          ? /** @type {Record<string, unknown>} */ (facts.known)
          : null,
    openMissingInfoRequests: Array.isArray(r.openMissingInfoRequests)
      ? r.openMissingInfoRequests
      : Array.isArray(facts?.openMissingInfoRequests)
        ? /** @type {unknown[]} */ (facts.openMissingInfoRequests)
        : null,
    latestClosedMissingInfoAnswers: Array.isArray(
      r.latestClosedMissingInfoAnswers
    )
      ? r.latestClosedMissingInfoAnswers
      : Array.isArray(facts?.latestClosedMissingInfoAnswers)
        ? /** @type {unknown[]} */ (facts.latestClosedMissingInfoAnswers)
        : null,
    pendingPromises: Array.isArray(r.pendingPromises)
      ? r.pendingPromises
      : null,
    conversationStageHint:
      r.conversationStageHint != null
        ? String(r.conversationStageHint)
        : null,
    ownershipLane:
      r.ownershipLane != null
        ? String(r.ownershipLane)
        : cleanLane(r.lane),
    verifiedFactsJson:
      r.verifiedFactsJson != null ? String(r.verifiedFactsJson) : null,
    safetyPolicy:
      r.safetyPolicy && typeof r.safetyPolicy === "object"
        ? /** @type {Record<string, unknown>} */ (r.safetyPolicy)
        : facts?.policy && typeof facts.policy === "object"
          ? /** @type {Record<string, unknown>} */ (facts.policy)
          : null,
    allowedExecutors: Array.isArray(r.allowedExecutors)
      ? r.allowedExecutors.map((x) => String(x))
      : null,
    facts,
    styleKey:
      r.styleKey === "neutral_english" || r.styleKey === "casual_local"
        ? r.styleKey
        : null,
    timeoutMs:
      r.timeoutMs != null && Number.isFinite(Number(r.timeoutMs))
        ? Number(r.timeoutMs)
        : null,
    missingInfoLoopFullyEnabled:
      r.missingInfoLoopFullyEnabled === true
        ? true
        : r.missingInfoLoopFullyEnabled === false
          ? false
          : null,
    __chatCompletionsCreateForTests:
      typeof r.__chatCompletionsCreateForTests === "function"
        ? r.__chatCompletionsCreateForTests
        : null,
    // group_post_execute lane extras
    postExecuteResult:
      r.postExecuteResult && typeof r.postExecuteResult === "object"
        ? /** @type {Record<string, unknown>} */ (r.postExecuteResult)
        : null,
    responseDisposition:
      r.responseDisposition != null ? String(r.responseDisposition) : null,
    actionsAllowed: r.actionsAllowed === false ? false : null,
  };
}

/**
 * Shared decision JSON — first contract is the post-confirm Phase A fields,
 * plus seed aliases for later lanes (conversationStage / actionType / …).
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function enrichSharedCustomerTurnDecision(decision) {
  const d =
    decision && typeof decision === "object"
      ? { ...decision }
      : {
          conversationAct: "unknown",
          customerIntent: "unclear",
          customerIsAskingQuestion: false,
          requestedInfoType: null,
          customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
          action: "reply",
          shouldReply: true,
          situation: "unclear",
        };

  const action = String(d.action ?? "reply");
  let requiredExecutor = d.requiredExecutor ?? null;
  if (requiredExecutor == null) {
    if (action === "silence" || action === "none") requiredExecutor = "none";
    else if (action === "confirm_booking") {
      requiredExecutor = "confirm_booking_executor";
    } else if (action === "decline_request") {
      requiredExecutor = "decline_request_executor";
    } else if (action === "change_request") {
      requiredExecutor = "protected_change_reply_executor";
    } else if (action === "escalate_missing_info") {
      requiredExecutor = "pa_missing_info_escalate";
    } else if (action === "fallthrough_action") {
      requiredExecutor = "brain_fallthrough";
    } else {
      requiredExecutor = "whatsapp_cloud_dm";
    }
  }

  return {
    // Preserve Phase A fields, then seed shared aliases.
    ...d,
    conversationStage: d.conversationStage ?? d.situation ?? null,
    customerMood: d.customerMood ?? null,
    customerIntent: d.customerIntent ?? "unclear",
    situation: d.situation ?? "unclear",
    conversationAct: d.conversationAct ?? "unknown",
    customerIsAskingQuestion: d.customerIsAskingQuestion === true,
    requestedInfoType: d.requestedInfoType ?? null,
    shouldReply: d.shouldReply !== false,
    customerReply: d.customerReply ?? "",
    action,
    actionType: d.actionType ?? action,
    requiredExecutor,
    confidence: d.confidence ?? null,
    safetyNotes: d.safetyNotes ?? null,
  };
}

/**
 * Shared Brain customer-turn decision entrypoint.
 *
 * @param {Record<string, unknown>} turnContextInput
 * @returns {Promise<{
 *   ok: boolean,
 *   decision: Record<string, unknown>,
 *   source: string,
 *   reason?: string,
 *   lane?: string | null,
 *   turnContext?: TurnContext,
 * }>}
 */
export async function decideCustomerTurn(turnContextInput = {}) {
  const turnContext = normalizeTurnContext(turnContextInput);
  const lane = turnContext.lane;

  if (lane === "post_confirm_pa") {
    const postConfirmFacts = normalizePostConfirmBookingCandidates(
      turnContext.facts || {}
    );
    const result = await executePostConfirmPaLaneDecision({
      facts: postConfirmFacts,
      userMessage: turnContext.messageText || "",
      conversationHistory: turnContext.recentDialogue,
      styleKey: turnContext.styleKey || "casual_local",
      timeoutMs:
        turnContext.timeoutMs != null ? turnContext.timeoutMs : 8000,
      missingInfoLoopFullyEnabled:
        turnContext.missingInfoLoopFullyEnabled === true,
      __chatCompletionsCreateForTests:
        turnContext.__chatCompletionsCreateForTests,
    });
    return {
      ...result,
      decision: enrichSharedCustomerTurnDecision(result?.decision),
      lane,
      turnContext,
    };
  }

  if (lane === WAITING_CONFIRM_DM_LANE || lane === "waiting_confirm_dm") {
    const result = await executeWaitingConfirmDmLaneDecision({
      turnContext,
      timeoutMs:
        turnContext.timeoutMs != null ? turnContext.timeoutMs : 8000,
      __chatCompletionsCreateForTests:
        turnContext.__chatCompletionsCreateForTests,
    });
    return {
      ...result,
      decision: enrichSharedCustomerTurnDecision(result?.decision),
      lane: WAITING_CONFIRM_DM_LANE,
      turnContext,
    };
  }

  if (lane === GROUP_POST_EXECUTE_LANE) {
    const result = await executeGroupPostExecuteLaneDecision({
      turnContext,
      timeoutMs:
        turnContext.timeoutMs != null ? turnContext.timeoutMs : 8000,
      __chatCompletionsCreateForTests:
        turnContext.__chatCompletionsCreateForTests,
    });
    // Enrich through shared contract but force action to reply/silence only
    const enriched = enrichSharedCustomerTurnDecision(result?.decision);
    // Safety: group_post_execute lane must never produce an executor that triggers actions
    const safeEnriched = {
      ...enriched,
      requiredExecutor:
        enriched.action === "reply" ? "group_reply" : "none",
      actionsAllowed: false,
    };
    return {
      ...result,
      decision: safeEnriched,
      lane: GROUP_POST_EXECUTE_LANE,
      turnContext,
    };
  }

  return {
    ok: false,
    decision: enrichSharedCustomerTurnDecision({
      customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
      action: "reply",
      shouldReply: true,
      situation: "unclear",
      conversationAct: "unknown",
      customerIntent: "unclear",
      safetyNotes: "unsupported_lane",
    }),
    source: "technical_fallback",
    reason: "UNSUPPORTED_LANE",
    lane,
    turnContext,
  };
}
