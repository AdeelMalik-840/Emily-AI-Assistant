/**
 * Workflow arbitration — first rule: pricing_with_duration beats open collect_duration
 * unless there is an explicit booking commitment.
 */
import { isGreeting, normalizeText } from "../../services/preAiRouting.js";
import { extractContactPhoneFromText } from "../../utils/extractContactPhoneFromText.js";
import {
  isAvailabilityInquiryIntent,
  isBrowseWorkflowIntent,
  isUnlistedAvailabilityIntent,
} from "./browseIntent.js";
import { isWeakNeedOwnerAvailabilityInquiry } from "../facts/resolveBusinessTurnContext.js";
import { readFreshLastAvailabilityAssist } from "../availability/availabilityAssistContext.js";
import {
  isAvailabilityDurationPendingAction,
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
} from "../availability/availabilityPendingActions.js";
import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  readEmilyPendingFromMemory,
} from "../availability/emilyPendingContext.js";
import { readBookingContactState } from "../continuation/buildContinuationContext.js";

/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/workflow.js").WorkflowDecision} WorkflowDecision */

export const PENDING_ACTION_COLLECT_DURATION = "collect_duration";
export {
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
  isAvailabilityDurationPendingAction,
};

/**
 * @param {TurnContext} turnContext
 * @returns {Record<string, unknown> | null}
 */
function readMemoryPendingAction(turnContext) {
  const memory =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : null;
  const pending =
    memory?.pendingAction && typeof memory.pendingAction === "object"
      ? /** @type {Record<string, unknown>} */ (memory.pendingAction)
      : null;
  return pending;
}

/**
 * @param {TurnContext} turnContext
 * @returns {boolean}
 */
export function hasOpenCollectDurationPending(turnContext) {
  if (turnContext?.activeWorkflowType === PENDING_ACTION_COLLECT_DURATION) return true;
  const pending = readMemoryPendingAction(turnContext);
  return String(pending?.type ?? "").trim() === PENDING_ACTION_COLLECT_DURATION;
}

/**
 * @param {TurnContext} turnContext
 * @param {Record<string, unknown> | null | undefined} [resolvedBusinessTurnContext]
 * @returns {boolean}
 */
export function hasOpenAvailabilityDurationPending(
  turnContext,
  resolvedBusinessTurnContext = null
) {
  if (turnContext?.activeWorkflowType === PENDING_ACTION_COLLECT_AVAILABILITY_DURATION) {
    return true;
  }
  const memory =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : null;
  const emilyPending = readEmilyPendingFromMemory(memory);
  if (emilyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION) {
    // Group canonical: a NEED_DURATION pending for item A must not force
    // availability continuation / block pricing when THIS turn already
    // resolved a different item B. Same-item pending is unchanged.
    if (resolvedBusinessTurnContext?.validatedGroupCanonicalAuthority === true) {
      const pendingId = String(emilyPending.itemId ?? "").trim();
      const resolvedId = String(
        resolvedBusinessTurnContext?.decision?.resolvedItemId ??
          resolvedBusinessTurnContext?.resolvedItem?.id ??
          ""
      ).trim();
      if (pendingId && resolvedId && pendingId !== resolvedId) {
        return false;
      }
    }
    return true;
  }
  return isAvailabilityDurationPendingAction(readMemoryPendingAction(turnContext));
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
 * Canonical transaction authority gate (Group only): a stochastic semantic
 * label (askedField/signals.priceAsk above) is only a proposal. When
 * resolvedBusinessTurnContext reports an active, trusted Group transaction
 * for this same item (groupTransactionIntentSwitch.activeTransaction), that
 * proposal may only be honored if the model also cited a real, grounded
 * current-turn span for it (groupTransactionIntentSwitch.accepted). Turns
 * with no active matching transaction to protect, and every non-Group /
 * legacy caller (no resolvedBusinessTurnContext.validatedGroupCanonicalAuthority),
 * are completely unaffected -- this never changes behavior for anything
 * that isn't the exact live-proven failure mode it targets.
 * @param {Record<string, unknown> | null | undefined} resolvedBusinessTurnContext
 * @returns {boolean}
 */
function isPricingWithDurationInterruptGroundedForActiveTransaction(resolvedBusinessTurnContext) {
  if (resolvedBusinessTurnContext?.validatedGroupCanonicalAuthority !== true) return true;
  const intentSwitch = resolvedBusinessTurnContext?.groupTransactionIntentSwitch;
  return intentSwitch?.accepted !== false;
}

/**
 * @param {TurnUnderstanding} understanding
 * @param {string} [message]
 * @returns {boolean}
 */
function isWeakNeedOwnerAvailabilityContinuation(understanding, message = "") {
  const normalized = String(message ?? "").trim().toLowerCase();
  return isWeakNeedOwnerAvailabilityInquiry(normalized, understanding.signals ?? {}, {
    durationDays: understanding.durationDays ?? null,
    hasResolvedItem: Boolean(understanding.resolvedItemId),
  });
}

/**
 * @param {TurnUnderstanding} understanding
 * @param {string} [message]
 * @returns {boolean}
 */
function isBookingRequestContinuation(understanding, message = "") {
  if (isWeakNeedOwnerAvailabilityContinuation(understanding, message)) return false;
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
  return Boolean(readBookingContactState(turnContext?.memorySnapshot ?? null));
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
 * Validated Group V2: resolveBusinessDecision.workflowType is final.
 * Never inspect understanding/message — regex pricing/availability/booking
 * arbitration must not run on this path.
 *
 * @param {Record<string, unknown> | null | undefined} resolvedBusinessTurnContext
 * @returns {WorkflowDecision | null}
 */
export function canonicalGroupWorkflowFromResolvedContext(
  resolvedBusinessTurnContext
) {
  if (resolvedBusinessTurnContext?.validatedGroupCanonicalAuthority !== true) {
    return null;
  }
  const workflowType = String(
    resolvedBusinessTurnContext?.decision?.workflowType ?? ""
  ).trim();
  return {
    workflowType: workflowType || "clarification",
    reason: workflowType
      ? "validated_group_canonical_turn_decision"
      : "validated_group_missing_workflow_type",
    priority: 100,
  };
}

/**
 * @param {{
 *   understanding: TurnUnderstanding,
 *   turnContext: TurnContext,
 *   message?: string,
 *   resolvedBusinessTurnContext?: Record<string, unknown> | null,
 * }} params
 * @returns {WorkflowDecision}
 */
export function selectWorkflow({ understanding, turnContext, message = "", resolvedBusinessTurnContext = null }) {
  const canonicalGroupWorkflow = canonicalGroupWorkflowFromResolvedContext(
    resolvedBusinessTurnContext
  );
  if (canonicalGroupWorkflow) return canonicalGroupWorkflow;
  const inboundText = String(message ?? "").trim();
  const normalized = normalizeText(inboundText);
  const decision =
    resolvedBusinessTurnContext?.decision &&
    typeof resolvedBusinessTurnContext.decision === "object" &&
    !Array.isArray(resolvedBusinessTurnContext.decision)
      ? /** @type {Record<string, unknown>} */ (resolvedBusinessTurnContext.decision)
      : null;
  const decisionWorkflowType = String(decision?.workflowType ?? "").trim();
  const authoritativeSemanticIntent = String(
    understanding?.authoritativeSemanticIntent ?? ""
  ).trim();
  const canonicalSemanticAuthorityActive = Boolean(
    authoritativeSemanticIntent &&
      decisionWorkflowType &&
      String(decision?.primaryIntent ?? "").trim() === authoritativeSemanticIntent
  );

  // PR1: trusted continuation / pending ownership before generic resolved decisions.
  // Contact and availability-duration must not be stolen by unlisted/browse/clarify.
  if (
    isAwaitingBookingContact(turnContext) &&
    (!canonicalSemanticAuthorityActive || decisionWorkflowType === "booking_request")
  ) {
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

  if (
    hasOpenAvailabilityDurationPending(turnContext, resolvedBusinessTurnContext) &&
    (!canonicalSemanticAuthorityActive || decisionWorkflowType === "availability_inquiry")
  ) {
    if (
      isPricingWithDurationInterrupt(understanding) &&
      isPricingWithDurationInterruptGroundedForActiveTransaction(resolvedBusinessTurnContext)
    ) {
      return {
        workflowType: "pricing_with_duration",
        reason: "explicit_rent_question_interrupts_availability_duration_pending",
        interruptsPendingWorkflow: true,
        priority: 100,
      };
    }
    return {
      workflowType: "availability_inquiry",
      reason:
        understanding.durationDays != null
          ? "availability_duration_pending_continuation"
          : "availability_duration_pending_follow_up",
      interruptsPendingWorkflow: false,
      priority: 88,
    };
  }

  if (decisionWorkflowType && decisionWorkflowType !== "unknown_clarification") {
    // Pending availability duration beats a booking decision from weak/signal shortcuts.
    const bookingBlockedByAvailabilityDuration =
      decisionWorkflowType === "booking_request" &&
      hasOpenAvailabilityDurationPending(turnContext, resolvedBusinessTurnContext);
    // Canonical transaction authority: this is the exact live-proven bypass --
    // a fresh model classification of pricing_with_duration was trusted here
    // unconditionally, silently overriding an active, trusted Group
    // NEED_DURATION transaction for the same item (e.g. a bare "9 din"
    // duration reply sampled as pricing_with_duration). It may now only win
    // when the model also cited a real, grounded current-turn span for the
    // switch (groupTransactionIntentSwitch.accepted, computed in
    // resolveBusinessTurnContext.js) -- every non-Group / legacy caller, and
    // every turn with no active matching transaction, is unaffected.
    const pricingBlockedByUngroundedActiveTransaction =
      decisionWorkflowType === "pricing_with_duration" &&
      hasOpenAvailabilityDurationPending(turnContext, resolvedBusinessTurnContext) &&
      !isPricingWithDurationInterruptGroundedForActiveTransaction(resolvedBusinessTurnContext);
    if (!bookingBlockedByAvailabilityDuration && !pricingBlockedByUngroundedActiveTransaction) {
      return {
        workflowType: decisionWorkflowType,
        reason: String(decision?.reason ?? "resolved_business_turn_context_decision"),
        priority: 100,
      };
    }
    if (pricingBlockedByUngroundedActiveTransaction) {
      return {
        workflowType: "availability_inquiry",
        reason: "canonical_transaction_retained_over_ungrounded_pricing_intent",
        interruptsPendingWorkflow: false,
        priority: 89,
      };
    }
  }

  // Frozen Cloud meaning must not be reinterpreted by greeting/browse/assist regexes.
  // Workflow family is preprojected onto understanding — this engine must not
  // import the projector or re-read customer text.
  if (authoritativeSemanticIntent) {
    const canonicalWorkflowType = String(
      understanding?.authoritativeWorkflowType ?? ""
    ).trim();
    return {
      workflowType: canonicalWorkflowType || "clarification",
      reason: "canonical_semantic_authority",
      priority: 100,
    };
  }

  if (isGreeting(normalized)) {
    return {
      workflowType: "greeting",
      reason: "deterministic_greeting",
      priority: 95,
    };
  }

  const memoryForAssist =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : null;
  const freshAssist = readFreshLastAvailabilityAssist(
    memoryForAssist?.lastAvailabilityAssist
  );
  // Context gate only: fresh assist → availability workflow so the central Brain
  // can decide meaning (alt select / price / question / book). Generic
  // bookingCommitment (e.g. "3 din k lye") must NOT bypass this stage — that
  // misroute sent BookingRequestWorkflow's false "checking" ack with no action.
  // Price questions still interrupt so pricing workflow can own the turn.
  if (freshAssist) {
    const signals = understanding.signals ?? {};
    if (!signals.priceAsk) {
      return {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
        priority: 78,
      };
    }
  }

  // Availability asked "kitne din?" — duration / follow-up stays on availability, never auto-book.
  // (Handled earlier before decisionWorkflowType so unlisted/browse cannot steal.)

  if (hasOpenCollectDurationPending(turnContext)) {
    if (isPricingWithDurationInterrupt(understanding)) {
      return {
        workflowType: "pricing_with_duration",
        reason: "explicit_rent_question_with_duration_interrupts_collect_duration",
        interruptsPendingWorkflow: true,
        priority: 100,
      };
    }

    if (isBookingRequestContinuation(understanding, inboundText)) {
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

  // W2: when canonical decision is present and unresolved, do not invent
  // booking_request from free-floating phrase/duration heuristics. Lifecycle
  // gates above (contact, avail-duration pending, assist, collect_duration)
  // already owned the turn when applicable.
  const canonicalDecisionUnresolved =
    decision != null && decisionWorkflowType === "unknown_clarification";
  if (canonicalDecisionUnresolved) {
    if (
      Boolean(understanding.signals?.availabilityAsk) &&
      understanding.resolvedItemId &&
      !understanding.signals?.priceAsk
    ) {
      return {
        workflowType: "availability_inquiry",
        reason: "availability_ask_blocks_booking_continuation",
        priority: 84,
      };
    }
    return {
      workflowType: "unknown_clarification",
      reason: "canonical_decision_unresolved_no_phrase_booking_invent",
      priority: 0,
    };
  }

  if (
    !canonicalSemanticAuthorityActive &&
    isExplicitBookingRequest(understanding, inboundText) &&
    understanding.resolvedItemId
  ) {
    return {
      workflowType: "booking_request",
      reason: understanding.signals?.bookingCommitment
        ? "explicit_booking_commitment"
        : "explicit_book_phrase_with_item",
      priority: 86,
    };
  }

  if (
    Boolean(understanding.signals?.availabilityAsk) &&
    understanding.resolvedItemId &&
    !understanding.signals?.priceAsk
  ) {
    return {
      workflowType: "availability_inquiry",
      reason: "availability_ask_blocks_booking_continuation",
      priority: 84,
    };
  }

  if (isBookingRequestContinuation(understanding, inboundText) && understanding.resolvedItemId) {
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
