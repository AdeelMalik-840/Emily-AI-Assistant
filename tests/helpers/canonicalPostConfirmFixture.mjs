/** Canonical Cloud ownership fields for post-confirm decide fixtures. */

export const CANONICAL_OWNERSHIP_TURN_ID = "user:direct";

export function noneTargetReference() {
  return {
    source: "none",
    sourceTurnId: null,
    targetType: "none",
    targetId: null,
  };
}

export function historicalBookingTargetReference(
  bookingId,
  sourceTurnId = CANONICAL_OWNERSHIP_TURN_ID
) {
  return {
    source: "current_turn",
    sourceTurnId,
    targetType: "historical_booking",
    targetId: bookingId,
  };
}

export function canonicalOldBookingOwnership({
  bookingId,
  sourceTurnId = CANONICAL_OWNERSHIP_TURN_ID,
} = {}) {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "none",
    itemReferents: [],
    targetContext: "CONFIRMED_BOOKING",
    targetId: bookingId,
    selectedBookingId: bookingId,
    targetReference: historicalBookingTargetReference(bookingId, sourceTurnId),
  };
}

export function canonicalSocialOwnership() {
  return {
    turnScope: "SOCIAL_GENERAL",
    semanticIntent: "social",
    itemScope: "none",
    itemReferents: [],
    targetContext: "NONE",
    targetId: null,
    selectedBookingId: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    targetReference: noneTargetReference(),
  };
}

export function canonicalUnclearOwnership() {
  return {
    turnScope: "UNCLEAR",
    semanticIntent: "unclear",
    itemScope: "none",
    itemReferents: [],
    targetContext: "NONE",
    targetId: null,
    selectedBookingId: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    targetReference: noneTargetReference(),
  };
}

export function canonicalPendingAvailabilityOwnership({
  requestId,
  sourceTurnId = CANONICAL_OWNERSHIP_TURN_ID,
} = {}) {
  return {
    turnScope: "PENDING_AVAILABILITY_REFERENCE",
    semanticIntent: null,
    itemScope: "none",
    itemReferents: [],
    targetContext: "PENDING_AVAILABILITY",
    targetId: requestId,
    selectedBookingId: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    targetReference: {
      source: "current_turn",
      sourceTurnId,
      targetType: "pending_availability",
      targetId: requestId,
    },
  };
}

export function canonicalNewTransactionOwnership({
  semanticIntent = "general_business_question",
  itemScope = "none",
  itemReferents = [],
} = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent,
    itemScope,
    itemReferents,
    targetContext: "NEW_TRANSACTION",
    targetId: null,
    selectedBookingId: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    targetReference: noneTargetReference(),
  };
}

export function withOwnershipTurnFacts(
  facts,
  sourceTurnId = CANONICAL_OWNERSHIP_TURN_ID
) {
  return {
    ...facts,
    currentOwnershipTurnId: facts?.currentOwnershipTurnId || sourceTurnId,
  };
}
