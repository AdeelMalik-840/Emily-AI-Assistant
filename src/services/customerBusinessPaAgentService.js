/**
 * Emily Business PA — post-confirm context owner + safe executor.
 * Architecture (post_confirm_pa DM):
 *   Brain semantic decision → deterministic validate/execute → constrained reply compose.
 * Booking mutations run only through postConfirmBookingMutationExecutor (safe executors
 * only; unsupported intents never write Firestore). Pending AVR confirm/decline keep
 * their existing executor + second Brain reply path.
 */

import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { resolvePostConfirmRequestedFact } from "../brain/facts/resolvePostConfirmRequestedFact.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import { isDeferredPostConfirmInformationalDecision } from "../brain/decisions/decidePostConfirmCustomerDm.js";
import {
  executeAvailabilityCustomerConfirmBooking,
  executeAvailabilityCustomerDecline,
} from "./availabilityCustomerConfirmService.js";
import { executePostConfirmBookingMutation } from "./postConfirmBookingMutationExecutor.js";
import {
  composePostConfirmInformationalCustomerReply,
  composePostConfirmMutationCustomerReply,
} from "./customerBusinessPaAiReply.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanCustomerReply(value) {
  return String(value ?? "").trim();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function logPostConfirmTerminalDiagnostic(decided) {
  const diagnostic = {
    failureReason:
      clean(decided?.reason, 160) || "OPENAI_POST_CONFIRM_FAILED",
    silenceRecoveryAttempts: nonNegativeInteger(
      decided?.silenceRecoveryAttempts
    ),
    contentSafetyAttempts: nonNegativeInteger(decided?.contentSafetyAttempts),
    usabilityClassification:
      clean(decided?.usabilityClassification, 60) || null,
  };
  console.error("[post_confirm_model_terminal_diagnostic]", diagnostic);
  return diagnostic;
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   inboundReceivedAtMs?: number | null,
 *   conversationHistory?: string | null,
 *   preResolvedBookingFacts?: Record<string, unknown> | null,
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 *   __decideCustomerTurnFn?: typeof decideCustomerTurn,
 *   __executeAvailabilityCustomerConfirmBookingFn?: typeof executeAvailabilityCustomerConfirmBooking,
 *   __executeAvailabilityCustomerDeclineFn?: typeof executeAvailabilityCustomerDecline,
 *   __executePostConfirmBookingMutationFn?: typeof executePostConfirmBookingMutation,
 *   __composePostConfirmMutationCustomerReplyFn?: typeof composePostConfirmMutationCustomerReply,
 *   __resolvePostConfirmRequestedFactFn?: typeof resolvePostConfirmRequestedFact,
 *   __composePostConfirmInformationalCustomerReplyFn?: typeof composePostConfirmInformationalCustomerReply,
 *   __chatCompletionsCreateForTests?: Function,
 * }} params
 */
export async function handleCustomerBusinessPaInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  inboundReceivedAtMs = null,
  conversationHistory = null,
  preResolvedBookingFacts = null,
  __resolveActiveCustomerBookingFactsFn = resolveActiveCustomerBookingFacts,
  __decideCustomerTurnFn = decideCustomerTurn,
  __executeAvailabilityCustomerConfirmBookingFn =
    executeAvailabilityCustomerConfirmBooking,
  __executeAvailabilityCustomerDeclineFn =
    executeAvailabilityCustomerDecline,
  __executePostConfirmBookingMutationFn = executePostConfirmBookingMutation,
  __composePostConfirmMutationCustomerReplyFn =
    composePostConfirmMutationCustomerReply,
  // Shim accepts capability+evidenceNeeds (B) and legacy requestedInformation.
  __resolvePostConfirmRequestedFactFn = resolvePostConfirmRequestedFact,
  __composePostConfirmInformationalCustomerReplyFn =
    composePostConfirmInformationalCustomerReply,
  __chatCompletionsCreateForTests = null,
}) {
  const uid = clean(businessId);
  const phone = String(customerPhone ?? "").trim();
  const text = clean(messageText);
  if (!uid || !phone || !text) {
    return { handled: false, reason: "MISSING_CONTEXT" };
  }

  const resolved =
    preResolvedBookingFacts &&
    typeof preResolvedBookingFacts === "object" &&
    preResolvedBookingFacts.ok === true
      ? preResolvedBookingFacts
      : await __resolveActiveCustomerBookingFactsFn({
          db: connection,
          businessId: uid,
          customerPhone: phone,
          inboundReceivedAtMs,
        });
  if (!resolved?.ok || !resolved.facts) {
    return {
      handled: false,
      reason: resolved?.reason || "NO_CONTEXT",
    };
  }

  const facts = resolved.facts;

  // Brain shared entrypoint — one semantic decision for this customer turn.
  // Informational post-booking turns have no missing-info or owner-notification executor.
  const decided = await __decideCustomerTurnFn({
    lane: "post_confirm_pa",
    channel: "whatsapp",
    chatType: "dm",
    businessId: uid,
    customerPhone: phone,
    messageText: text,
    messageId,
    recentDialogue: conversationHistory,
    ownershipLane: "post_confirm_pa",
    activeBooking: facts.booking ?? null,
    activeAvailabilityRequest: facts.availabilityRequest ?? null,
    knownPolicies: facts.known ?? null,
    openMissingInfoRequests: facts.openMissingInfoRequests ?? null,
    latestClosedMissingInfoAnswers:
      facts.latestClosedMissingInfoAnswers ?? null,
    safetyPolicy: facts.policy ?? null,
    allowedExecutors: ["whatsapp_cloud_dm"],
    facts,
    styleKey: "casual_local",
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests,
  });

  if (decided?.ok !== true || decided?.source !== "openai") {
    const retryable = decided?.retryable === true;
    const terminalDiagnostic = retryable
      ? null
      : logPostConfirmTerminalDiagnostic(decided);
    return {
      handled: true,
      action: retryable
        ? "business_pa_retryable_failure"
        : "business_pa_terminal_model_failure",
      reply: "",
      sentReply: false,
      bookingId: clean(facts.booking?.id) || null,
      availabilityRequestId:
        clean(facts.booking?.availabilityRequestId) || null,
      reason: retryable
        ? "OPENAI_POST_CONFIRM_FAILED"
        : "OPENAI_POST_CONFIRM_MODEL_CONTRACT_TERMINAL",
      retryable,
      terminalFailure: !retryable,
      openaiUsed: false,
      openaiSource: decided?.source ?? "technical_fallback",
      finalReplySource: "openai_post_confirm_pa",
      failureReason: clean(decided?.reason, 160) || "OPENAI_POST_CONFIRM_FAILED",
      silenceRecoveryAttempts: Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
      contentSafetyAttempts:
        terminalDiagnostic?.contentSafetyAttempts ??
        nonNegativeInteger(decided?.contentSafetyAttempts),
    };
  }

  let decision = decided.decision;
  let pendingAvailabilityExecution = null;
  let mutationExecution = null;
  let semanticDecisionCount = 1;
  let composeCalls = 0;

  if (
    decision.action === "confirm_pending_availability" ||
    decision.action === "decline_pending_availability"
  ) {
    const selectionIndex = Number(decision.pendingAvailabilitySelectionIndex);
    const pendingRows = Array.isArray(facts.pendingAvailabilityRequests)
      ? facts.pendingAvailabilityRequests
      : [];
    const selected = pendingRows.find(
      (row) => Number(row?.selectionIndex) === selectionIndex
    );
    let executionResult = { ok: false, reason: "INVALID_PENDING_SELECTION" };
    if (selected) {
      if (decision.action === "confirm_pending_availability") {
        executionResult =
          await __executeAvailabilityCustomerConfirmBookingFn({
            db: connection,
            businessId: uid,
            request: selected.request ?? selected,
            messageText: text,
            messageId,
            brainAuthorizedConfirm: true,
          });
      } else {
        executionResult = await __executeAvailabilityCustomerDeclineFn({
          db: connection,
          businessId: uid,
          request: selected.request ?? selected,
          customerPhone: phone,
          messageText: text,
          messageId,
        });
      }
    }
    pendingAvailabilityExecution = {
      action: decision.action,
      status: executionResult?.ok === true ? "succeeded" : "failed",
      itemLabel: selected?.itemLabel ?? null,
      durationDays: selected?.requestedDuration ?? null,
      failureReason:
        executionResult?.ok === true
          ? null
          : clean(executionResult?.reason, 160) || "EXECUTION_FAILED",
    };
    const guardRows = Array.isArray(facts.replyGuardFacts?.activeBookings)
      ? facts.replyGuardFacts.activeBookings
      : [];
    const executedBookingCandidate =
      executionResult?.ok === true &&
      decision.action === "confirm_pending_availability"
        ? {
            id: clean(executionResult?.bookingId) || "verified-executed-booking",
            selectionIndex: 1,
            status: "approved",
            itemId: selected?.itemId ?? null,
            itemLabel: selected?.itemLabel ?? null,
            durationDays: selected?.requestedDuration ?? null,
            totalAmount: selected?.priceQuote?.total ?? null,
            dailyRate: selected?.priceQuote?.dailyRate ?? null,
            availabilityRequestId: selected?.requestId ?? null,
          }
        : null;
    const finalFacts = {
      ...facts,
      ...(executedBookingCandidate
        ? {
            booking: executedBookingCandidate,
            bookingCandidates: [executedBookingCandidate],
            bookingFocus: null,
            activeBookings: [],
          }
        : {}),
      pendingAvailabilityRequests: [],
      pendingAvailabilityExecution,
      replyGuardFacts: {
        ...(facts.replyGuardFacts || {}),
        activeBookings:
          executionResult?.ok === true &&
          decision.action === "confirm_pending_availability"
            ? [
                ...guardRows,
                {
                  itemId: selected?.itemId ?? null,
                  itemLabel: selected?.itemLabel ?? null,
                  durationDays: selected?.requestedDuration ?? null,
                  bookingStatus: "approved",
                  totalAmount: selected?.priceQuote?.total ?? null,
                  dailyRate: selected?.priceQuote?.dailyRate ?? null,
                },
              ]
            : guardRows,
      },
    };
    const finalDecision = await __decideCustomerTurnFn({
      lane: "post_confirm_pa",
      channel: "whatsapp",
      chatType: "dm",
      businessId: uid,
      customerPhone: phone,
      messageText: text,
      messageId,
      recentDialogue: conversationHistory,
      ownershipLane: "post_confirm_pa",
      activeBooking: finalFacts.booking ?? null,
      activeAvailabilityRequest: null,
      knownPolicies: finalFacts.known ?? null,
      openMissingInfoRequests: [],
      latestClosedMissingInfoAnswers:
        finalFacts.latestClosedMissingInfoAnswers ?? null,
      safetyPolicy: finalFacts.policy ?? null,
      allowedExecutors: ["whatsapp_cloud_dm"],
      facts: finalFacts,
      styleKey: "casual_local",
      missingInfoLoopFullyEnabled: false,
      __chatCompletionsCreateForTests,
    });
    semanticDecisionCount += 1;
    if (finalDecision?.ok !== true || finalDecision?.source !== "openai") {
      const retryable = finalDecision?.retryable === true;
      const terminalDiagnostic = retryable
        ? null
        : logPostConfirmTerminalDiagnostic(finalDecision);
      return {
        handled: true,
        action: retryable
          ? "business_pa_retryable_failure"
          : "business_pa_terminal_model_failure",
        reply: "",
        sentReply: false,
        bookingId: clean(facts.booking?.id) || null,
        availabilityRequestId: selected?.requestId ?? null,
        reason: retryable
          ? "OPENAI_POST_CONFIRM_AFTER_EXECUTION_FAILED"
          : "OPENAI_POST_CONFIRM_MODEL_CONTRACT_TERMINAL",
        retryable,
        terminalFailure: !retryable,
        openaiUsed: false,
        openaiSource: finalDecision?.source ?? "technical_fallback",
        finalReplySource: "openai_post_confirm_pa",
        failureReason:
          clean(finalDecision?.reason, 160) ||
          "OPENAI_POST_CONFIRM_AFTER_EXECUTION_FAILED",
        pendingAvailabilityExecution,
        silenceRecoveryAttempts:
          Number(finalDecision?.silenceRecoveryAttempts ?? 0) || 0,
        contentSafetyAttempts:
          terminalDiagnostic?.contentSafetyAttempts ??
          nonNegativeInteger(finalDecision?.contentSafetyAttempts),
        semanticDecisionCount,
        composeCalls,
      };
    }
    decision = finalDecision.decision;
  } else if (decision.action === "request_booking_mutation") {
    // Decide → validate/execute → compose. Informational turns never reach here.
    const frozenDecision = { ...decision };
    const selectedBookingId = clean(decision.selectedBookingId) || null;
    const selectedBooking =
      selectedBookingId && Array.isArray(facts.bookingCandidates)
        ? facts.bookingCandidates.find(
            (row) => clean(row?.id) === selectedBookingId
          ) ?? null
        : selectedBookingId &&
            clean(facts.booking?.id) === selectedBookingId
          ? facts.booking
          : null;

    mutationExecution = __executePostConfirmBookingMutationFn({
      businessId: uid,
      messageId,
      decision: frozenDecision,
      facts,
      selectedBooking,
    });

    const composed = await __composePostConfirmMutationCustomerReplyFn({
      facts: {
        ...facts,
        mutationExecution: {
          requested: true,
          status: mutationExecution?.status ?? "not_executed",
          intent:
            mutationExecution?.intent ??
            frozenDecision.mutationIntent ??
            "none",
        },
      },
      userMessage: text,
      frozenDecision,
      mutationExecution,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
    });
    composeCalls += 1;

    if (composed?.ok !== true || !cleanCustomerReply(composed?.reply)) {
      return {
        handled: true,
        action: "business_pa_terminal_model_failure",
        reply: "",
        sentReply: false,
        bookingId: selectedBookingId || clean(facts.booking?.id) || null,
        availabilityRequestId:
          clean(selectedBooking?.availabilityRequestId) ||
          clean(facts.booking?.availabilityRequestId) ||
          null,
        reason: "OPENAI_POST_CONFIRM_MUTATION_COMPOSE_FAILED",
        retryable: false,
        terminalFailure: true,
        openaiUsed: false,
        openaiSource: composed?.source ?? "technical_fallback",
        finalReplySource: "openai_post_confirm_pa_mutation_compose",
        failureReason:
          clean(composed?.reason, 160) ||
          "OPENAI_POST_CONFIRM_MUTATION_COMPOSE_FAILED",
        mutationIntent: frozenDecision.mutationIntent ?? "none",
        mutationExecutionRequested: true,
        mutationExecutionStatus:
          mutationExecution?.status ?? "not_executed",
        mutationExecution,
        bookingSelectionMode:
          clean(frozenDecision.bookingSelectionMode, 40) || "none",
        selectedBookingIndex: frozenDecision.selectedBookingIndex ?? null,
        silenceRecoveryAttempts:
          Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
        semanticDecisionCount,
        composeCalls,
      };
    }

    decision = {
      ...frozenDecision,
      customerReply: cleanCustomerReply(composed.reply),
      shouldReply: true,
      action: "request_booking_mutation",
      mutationExecutionRequested: true,
      mutationExecutionStatus: mutationExecution?.status ?? "not_executed",
    };
  } else if (
    decision.informationalReplyDeferred === true ||
    isDeferredPostConfirmInformationalDecision(decision)
  ) {
    // Decide → resolve trusted fact → compose. Owner missing-info stays unwired.
    const frozenDecision = { ...decision };
    const selectedBookingId = clean(decision.selectedBookingId) || null;
    const selectedBooking =
      selectedBookingId && Array.isArray(facts.bookingCandidates)
        ? facts.bookingCandidates.find(
            (row) => clean(row?.id) === selectedBookingId
          ) ?? null
        : selectedBookingId && clean(facts.booking?.id) === selectedBookingId
          ? facts.booking
          : facts.booking && typeof facts.booking === "object"
            ? facts.booking
            : null;

    const factResolution = __resolvePostConfirmRequestedFactFn({
      capability: frozenDecision.capability,
      evidenceNeeds: frozenDecision.evidenceNeeds,
      // legacy compat for injected test doubles
      requestedInformation: frozenDecision.requestedInformation,
      facts,
      selectedBooking,
    });

    const composed = await __composePostConfirmInformationalCustomerReplyFn({
      facts,
      userMessage: text,
      frozenDecision,
      factResolution,
      selectedBooking,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
    });
    composeCalls += 1;

    if (composed?.ok !== true || !cleanCustomerReply(composed?.reply)) {
      return {
        handled: true,
        action: "business_pa_terminal_model_failure",
        reply: "",
        sentReply: false,
        bookingId: selectedBookingId || clean(facts.booking?.id) || null,
        availabilityRequestId:
          clean(selectedBooking?.availabilityRequestId) ||
          clean(facts.booking?.availabilityRequestId) ||
          null,
        reason: "OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE_FAILED",
        retryable: false,
        terminalFailure: true,
        openaiUsed: false,
        openaiSource: composed?.source ?? "technical_fallback",
        finalReplySource: "openai_post_confirm_pa_informational_compose",
        failureReason:
          clean(composed?.reason, 160) ||
          "OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE_FAILED",
        requestedInformation: frozenDecision.requestedInformation ?? null,
        factResolution,
        bookingSelectionMode:
          clean(frozenDecision.bookingSelectionMode, 40) || "none",
        selectedBookingIndex: frozenDecision.selectedBookingIndex ?? null,
        silenceRecoveryAttempts:
          Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
        semanticDecisionCount,
        composeCalls,
        missingInfoEscalated: false,
        missingInfoRequestId: null,
        missingInfoType: null,
        ownerNotifyStatus: null,
      };
    }

    decision = {
      ...frozenDecision,
      customerReply: cleanCustomerReply(composed.reply),
      shouldReply: true,
      action: "reply",
      mutationIntent: "none",
      informationalReplyDeferred: true,
      factResolution,
    };
  }

  const shouldSend =
    decision.action !== "silence" &&
    decision.shouldReply !== false &&
    Boolean(cleanCustomerReply(decision.customerReply));
  const reply = shouldSend
    ? cleanCustomerReply(decision.customerReply)
    : "";
  const openaiUsed = true;
  const reason = shouldSend ? "HANDLED" : "HANDLED_SILENCE";

  const selectedBookingId = clean(decision.selectedBookingId) || null;
  const bookingSelectionMode =
    clean(decision.bookingSelectionMode, 40) || "none";
  const selectedBooking =
    selectedBookingId && Array.isArray(facts.bookingCandidates)
      ? facts.bookingCandidates.find(
          (row) => clean(row?.id) === selectedBookingId
        ) ?? null
      : null;
  const hasNoExactBookingSelection =
    bookingSelectionMode === "all_candidates" ||
    bookingSelectionMode === "clarification_required";
  const bookingId =
    hasNoExactBookingSelection
      ? null
      : selectedBookingId || clean(facts.booking?.id) || null;
  const availabilityRequestId =
    hasNoExactBookingSelection
      ? null
      : clean(selectedBooking?.availabilityRequestId) ||
        clean(facts.booking?.availabilityRequestId) ||
        null;

  console.log("[customer_business_pa_result]", {
    businessId: uid,
    bookingId,
    openaiUsed,
    conversationAct: decision.conversationAct,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation,
    decisionAction: decision.action,
    shouldReply: decision.shouldReply !== false,
    preparedReply: shouldSend,
    requestedInformation: decision.requestedInformation ?? null,
    factResolutionStatus: decision.factResolution?.status ?? null,
    capability: decision.capability ?? null,
    missingInfoEscalated: false,
    missingInfoRequestId: null,
    missingInfoType: null,
    ownerNotifyStatus: null,
  });

  return {
    handled: true,
    action: shouldSend ? "business_pa_reply" : "business_pa_silence",
    reply: shouldSend ? reply : "",
    sentReply: false,
    bookingId,
    availabilityRequestId,
    reason,
    openaiUsed,
    openaiSource: decided?.source ?? "technical_fallback",
    finalReplySource:
      mutationExecution != null
        ? "openai_post_confirm_pa_mutation_compose"
        : decision.informationalReplyDeferred === true
          ? "openai_post_confirm_pa_informational_compose"
          : "openai_post_confirm_pa",
    conversationAct: decision.conversationAct,
    customerIntent: decision.customerIntent ?? "unclear",
    requestedInformation: decision.requestedInformation ?? null,
    capability: decision.capability ?? null,
    evidenceNeeds: decision.evidenceNeeds ?? [],
    factResolution: decision.factResolution ?? null,
    mutationIntent: decision.mutationIntent ?? "none",
    mutationExecutionRequested:
      decision.mutationExecutionRequested === true ||
      mutationExecution != null,
    mutationExecutionStatus:
      mutationExecution?.status ??
      decision.mutationExecutionStatus ??
      "not_executed",
    mutationExecution,
    bookingSelectionMode,
    selectedBookingIndex: decision.selectedBookingIndex ?? null,
    pendingAvailabilityExecution,
    situation: decision.situation ?? "unclear",
    decisionAction: decision.action,
    shouldReply: decision.shouldReply !== false,
    missingInfoEscalated: false,
    missingInfoRequestId: null,
    missingInfoType: null,
    ownerNotifyStatus: null,
    silenceRecoveryAttempts: Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
    retryable: false,
    terminalFailure: false,
    semanticDecisionCount,
    composeCalls,
  };
}

/**
 * Buffer entry: returns result when handled, otherwise null.
 * @param {Parameters<typeof handleCustomerBusinessPaInbound>[0]} params
 */
export async function tryHandleCustomerBusinessPaInbound(params) {
  const result = await handleCustomerBusinessPaInbound(params);
  return result?.handled === true ? result : null;
}
