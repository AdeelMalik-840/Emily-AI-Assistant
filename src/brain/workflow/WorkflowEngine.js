/**
 * Workflow arbitration — first rule: pricing_with_duration beats open collect_duration
 * unless there is an explicit booking commitment.
 */
import { isGreeting, normalizeText } from "../../services/preAiRouting.js";
import { extractContactPhoneFromText } from "../../services/messageProcessor.js";
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
 * @param {TurnContext} turnContext
 * @returns {boolean}
 */
function isAwaitingBookingContact(turnContext) {
  const memory =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : null;
  const stage = String(memory?.stage ?? "").trim();
  const pending =
    memory?.pendingAction && typeof memory.pendingAction === "object"
      ? /** @type {Record<string, unknown>} */ (memory.pendingAction)
      : null;
  const pendingType = String(pending?.type ?? "").trim();
  return stage === "AWAITING_BOOKING_CONTACT" || pendingType === "ASK_CONTACT";
}

/**
 * @param {TurnUnderstanding} understanding
 * @param {string} message
 * @returns {boolean}
 */
function isExplicitBookingRequest(understanding, message) {
  if (understanding.signals?.bookingCommitment) return true;
  const text = String(message ?? "").toLowerCase();
  if (/\bbook\b|\bbooking\b|\bconfirm\b|\bkr\s*do\b|\bkar\s*do\b/i.test(text)) {
    return Boolean(understanding.resolvedItemId);
  }
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
  const normalized = normalizeText(inboundText);

  if (isGreeting(normalized)) {
    return {
      workflowType: "greeting",
      reason: "deterministic_greeting",
      priority: 95,
    };
  }

  if (isAwaitingBookingContact(turnContext)) {
    const phone = extractContactPhoneFromText(inboundText);
    if (phone) {
      return {
        workflowType: "contact_collection",
        reason: "contact_phone_detected",
        priority: 90,
      };
    }
    return {
      workflowType: "contact_request",
      reason: "awaiting_booking_contact",
      priority: 88,
    };
  }

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

  if (isPricingWithDurationInterrupt(understanding) && understanding.resolvedItemId) {
    return {
      workflowType: "pricing_with_duration",
      reason:
        understanding.itemSource === "explicit"
          ? "explicit_item_price_with_duration"
          : "trusted_item_price_with_duration",
      priority: 85,
    };
  }

  if (
    understanding.signals?.priceAsk &&
    understanding.resolvedItemId &&
    understanding.durationDays == null
  ) {
    return {
      workflowType: "pricing_inquiry",
      reason:
        understanding.itemSource === "explicit"
          ? "explicit_item_price_inquiry"
          : "resolved_item_price_inquiry",
      priority: 82,
    };
  }

  if (isExplicitBookingRequest(understanding, inboundText) && understanding.resolvedItemId) {
    return {
      workflowType: "booking_request",
      reason: understanding.signals?.bookingCommitment
        ? "explicit_booking_commitment"
        : "explicit_book_phrase_with_item",
      priority: 86,
    };
  }

  if (isBookingRequestContinuation(understanding) && understanding.resolvedItemId) {
    return {
      workflowType: "booking_request",
      reason: "duration_booking_continuation",
      priority: 84,
    };
  }

  return {
    workflowType: "unknown_clarification",
    reason: "no_matching_workflow",
    priority: 0,
  };
}
