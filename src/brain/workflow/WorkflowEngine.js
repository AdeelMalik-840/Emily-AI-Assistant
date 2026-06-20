/**
 * Workflow arbitration — first rule: pricing_with_duration beats open collect_duration
 * unless there is an explicit booking commitment.
 */
import {
  isAvailabilityInquiryIntent,
  isBrowseWorkflowIntent,
  isUnlistedAvailabilityIntent,
} from "./browseIntent.js";

/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/workflow.js").WorkflowDecision} WorkflowDecision */

export const PENDING_ACTION_COLLECT_DURATION = "collect_duration";

/**
 * @param {TurnContext} turnContext
 * @returns {boolean}
 */
export function hasOpenCollectDurationPending(turnContext) {
  if (turnContext?.activeWorkflowType === PENDING_ACTION_COLLECT_DURATION) return true;
  const memory =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : null;
  const pending =
    memory?.pendingAction && typeof memory.pendingAction === "object"
      ? /** @type {Record<string, unknown>} */ (memory.pendingAction)
      : null;
  return String(pending?.type ?? "").trim() === PENDING_ACTION_COLLECT_DURATION;
}

/**
 * @param {TurnUnderstanding} understanding
 * @returns {boolean}
 */
function isPricingWithDurationInterrupt(understanding) {
  const signals = understanding.signals ?? {};
  if (signals.bookingCommitment) return false;
  if (understanding.askedField === "price_with_duration") return true;
  if (signals.priceAsk && understanding.durationDays != null) return true;
  return false;
}

/**
 * @param {TurnUnderstanding} understanding
 * @returns {boolean}
 */
function isBookingRequestContinuation(understanding) {
  const signals = understanding.signals ?? {};
  if (signals.bookingCommitment) return true;
  if (understanding.durationDays != null && !signals.priceAsk) return true;
  return false;
}

/**
 * @param {{
 *   understanding: TurnUnderstanding,
 *   turnContext: TurnContext,
 *   message?: string,
 * }} params
 * @returns {WorkflowDecision}
 */
export function selectWorkflow({ understanding, turnContext, message = "" }) {
  const inboundText = String(message ?? "").trim();

  if (hasOpenCollectDurationPending(turnContext)) {
    if (isPricingWithDurationInterrupt(understanding)) {
      return {
        workflowType: "pricing_with_duration",
        reason: "explicit_rent_question_with_duration_interrupts_collect_duration",
        interruptsPendingWorkflow: true,
        priority: 100,
      };
    }

    if (isBookingRequestContinuation(understanding)) {
      return {
        workflowType: "booking_request",
        reason: understanding.signals?.bookingCommitment
          ? "duration_with_booking_commitment_after_collect_duration"
          : "duration_only_after_collect_duration_prompt",
        interruptsPendingWorkflow: false,
        priority: 80,
      };
    }

    return {
      workflowType: "clarification",
      reason: "collect_duration_pending_unrecognized_reply",
      priority: 10,
    };
  }

  if (isBrowseWorkflowIntent(understanding, inboundText)) {
    return {
      workflowType: "browse_options",
      reason: "generic_browse_request_without_explicit_item_focus",
      priority: 70,
    };
  }

  if (isUnlistedAvailabilityIntent(understanding, inboundText)) {
    return {
      workflowType: "unlisted_item",
      reason: "availability_question_for_item_not_in_catalog",
      priority: 72,
    };
  }

  if (isAvailabilityInquiryIntent(understanding, inboundText)) {
    return {
      workflowType: "availability_inquiry",
      reason:
        understanding.itemSource === "explicit"
          ? "explicit_item_availability_question"
          : "resolved_item_availability_question",
      priority: 75,
    };
  }

  return {
    workflowType: "noop",
    reason: "no_matching_workflow",
    priority: 0,
  };
}
