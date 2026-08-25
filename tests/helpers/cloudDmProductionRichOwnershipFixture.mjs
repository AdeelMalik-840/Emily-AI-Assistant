/**
 * Production-rich Cloud DM ownership fixture.
 * Mirrors the live Civic failure context (trace 94e46355…): two historical
 * owner-approved bookings, no fresh waiting-confirm AVR, trusted focus on the
 * newest linked AVR (Stonic), candidate identity order Civic then Stonic.
 *
 * Labels, durations, linked AVRs, prices, and statuses are not simplified.
 */

export const PROD_CIVIC_BOOKING_ID = "E55qPBHJUW1NsUvNLAhH";
export const PROD_STONIC_BOOKING_ID = "MHFaQZBnBVgEeRoCIFQ3";
export const PROD_CIVIC_AVR_ID = "avr_1f3e551032d8b2c3d6caeb6b";
export const PROD_STONIC_AVR_ID = "avr_e65123e69cdf36cd956a4189";
export const PROD_CIVIC_ITEM_ID = "honda_civic_2026_oriel_white_7e961e31";
export const PROD_STONIC_ITEM_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
export const PROD_CIVIC_SECOND_BOOKING_ID = "E99qSecondCivicSameItem0000001";
export const PROD_CIVIC_THIRD_BOOKING_ID = "F00qThirdCivicSameItem00000002";
export const PROD_CIVIC_SECOND_AVR_ID = "avr_second_civic_same_item";
export const PROD_CIVIC_THIRD_AVR_ID = "avr_third_civic_same_item";
export const PROD_CIVIC_SAME_ITEM_NEW_DURATION =
  "Honda Civic 3 din k liye chahiye";

export function productionCivicHistoricalCandidate() {
  return {
    id: PROD_CIVIC_BOOKING_ID,
    itemId: PROD_CIVIC_ITEM_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    itemName: "Honda Civic 2026 Oriel (White)",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    durationDays: 5,
    availabilityRequestId: PROD_CIVIC_AVR_ID,
    dailyRate: 8000,
    totalAmount: 40000,
    startAt: "2026-08-06T11:28:56.349Z",
    endAt: "2026-08-11T11:28:56.349Z",
  };
}

export function productionStonicHistoricalCandidate() {
  return {
    id: PROD_STONIC_BOOKING_ID,
    itemId: PROD_STONIC_ITEM_ID,
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    itemName: "Kia Stonic EX Plus 2021 (White Color)",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    durationDays: 5,
    availabilityRequestId: PROD_STONIC_AVR_ID,
    dailyRate: 5500,
    totalAmount: 27500,
    startAt: "2026-08-09T09:00:00.000Z",
    endAt: "2026-08-14T09:00:00.000Z",
  };
}

/**
 * Resolver-shaped facts as live Cloud DM saw them:
 * MATCHED_TRUSTED_FOCUS on Stonic (newer linked AVR), candidates present,
 * no fresh waiting-confirm AVR.
 */
export function productionRichCivicStonicFacts() {
  const civic = productionCivicHistoricalCandidate();
  const stonic = productionStonicHistoricalCandidate();
  return {
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: { ...stonic },
    bookingCandidates: [{ ...civic }, { ...stonic }],
    activeBookings: [{ ...civic }, { ...stonic }],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 2,
      selectedBookingId: PROD_STONIC_BOOKING_ID,
      bookingId: PROD_STONIC_BOOKING_ID,
      itemId: stonic.itemId,
      itemLabel: stonic.itemLabel,
    },
    pendingAvailabilityRequests: [],
    known: {
      durationDays: 5,
      itemLabel: stonic.itemLabel,
      dailyRate: 5500,
      totalAmount: 27500,
      availabilityRequestId: PROD_STONIC_AVR_ID,
    },
    replyGuardFacts: {
      itemLabel: stonic.itemLabel,
      durationDays: 5,
      dailyRate: 5500,
      totalAmount: 27500,
    },
    availabilityRequest: {
      requestId: PROD_STONIC_AVR_ID,
      itemLabel: stonic.itemLabel,
    },
    sourceEvidence: {
      active_booking: true,
      trusted_focus: true,
    },
    policy: { readOnly: true, doNotInventAmounts: true },
  };
}

export function productionPendingCivicAvr(overrides = {}) {
  return {
    requestId: "avr_pending_civic_waiting_confirm",
    itemId: PROD_CIVIC_ITEM_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    status: "waiting_customer_confirm",
    requestedDuration: 3,
    dailyRate: 8000,
    totalAmount: 24000,
    priceQuote: { dailyRate: 8000, total: 24000 },
    ...overrides,
  };
}

export function productionRichFactsWithPendingCivic(extraPending = []) {
  const facts = productionRichCivicStonicFacts();
  facts.pendingAvailabilityRequests = [
    productionPendingCivicAvr(),
    ...extraPending,
  ];
  return facts;
}

export function extraCivicHistoricalCandidate(id, availabilityRequestId) {
  return {
    ...productionCivicHistoricalCandidate(),
    id,
    availabilityRequestId,
  };
}

export function productionRichFactsWithMultipleCivics(extra = []) {
  const facts = productionRichCivicStonicFacts();
  facts.bookingCandidates = [
    ...facts.bookingCandidates,
    ...extra.map((row) => extraCivicHistoricalCandidate(row.id, row.availabilityRequestId)),
  ];
  return facts;
}

export function productionRichTwoCivicFacts() {
  return productionRichFactsWithMultipleCivics([
    {
      id: PROD_CIVIC_SECOND_BOOKING_ID,
      availabilityRequestId: PROD_CIVIC_SECOND_AVR_ID,
    },
  ]);
}

export function productionRichTwoCivicFactsReversed() {
  const facts = productionRichTwoCivicFacts();
  facts.bookingCandidates = [...facts.bookingCandidates].reverse();
  return facts;
}

export function productionRichThreeCivicFacts() {
  return productionRichFactsWithMultipleCivics([
    {
      id: PROD_CIVIC_SECOND_BOOKING_ID,
      availabilityRequestId: PROD_CIVIC_SECOND_AVR_ID,
    },
    {
      id: PROD_CIVIC_THIRD_BOOKING_ID,
      availabilityRequestId: PROD_CIVIC_THIRD_AVR_ID,
    },
  ]);
}

export function ownershipDecisionPayload(overrides = {}) {
  const semanticIntent = overrides.semanticIntent ?? null;
  const turnScope = overrides.turnScope ?? "NEW_TRANSACTION";
  const itemScope =
    overrides.itemScope ??
    (turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR"
      ? "none"
      : semanticIntent === "browse_options"
        ? "broad"
        : "specific");
  return {
    turnScope: "NEW_TRANSACTION",
    itemScope,
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

export function chatCompletionFromDecision(decision) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(ownershipDecisionPayload(decision)),
        },
      },
    ],
  };
}
