import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  applyPostConfirmDerivedOwnershipMechanics,
  buildPostConfirmDecideFactsForPrompt,
  buildPostConfirmVerifiedItemMismatchCorrection,
  validatePostConfirmSemanticOwnership,
} = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const {
  handleCustomerBusinessPaInbound,
  shouldReleasePostConfirmForFreshAvailability,
} = await import("../src/services/customerBusinessPaAgentService.js");

const STONIC_BOOKING_ID = "booking-stonic-old";

function historicalStonicFacts() {
  const booking = {
    id: STONIC_BOOKING_ID,
    selectionIndex: 1,
    itemId: "kia-stonic",
    itemLabel: "Kia Stonic",
    status: "approved",
    durationDays: 4,
  };
  return {
    booking,
    bookingCandidates: [booking],
    activeBookings: [booking],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: STONIC_BOOKING_ID,
      bookingId: STONIC_BOOKING_ID,
      itemId: booking.itemId,
      itemLabel: booking.itemLabel,
    },
    // The expired Civic AVR was rejected by the lifecycle selector and is not
    // eligible semantic context.
    pendingAvailabilityRequests: [],
    known: {},
    policy: { readOnly: true },
  };
}

function decision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    targetContext: "NEW_TRANSACTION",
    targetId: null,
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    factKind: "booking_fact",
    capability: "availability_request",
    evidenceNeeds: [],
    action: "reply",
    shouldReply: true,
    customerReply: "",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    selectedBookingId: null,
    pendingAvailabilitySelectionIndex: null,
    ...overrides,
  };
}

test("exact reproduction: old Stonic stays context and fresh Civic releases before PA execution", async () => {
  const facts = historicalStonicFacts();
  let requestedFactCalls = 0;
  let composeCalls = 0;
  let mutationCalls = 0;
  let pendingCalls = 0;

  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "923001234567",
    messageText: "Honda Civic 3 din k liye chahiye",
    messageId: "wamid.fresh-civic",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts,
    }),
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: decision(),
    }),
    __resolvePostConfirmRequestedFactFn: () => {
      requestedFactCalls += 1;
      return { status: "found" };
    },
    __composePostConfirmInformationalCustomerReplyFn: async () => {
      composeCalls += 1;
      return { ok: true, reply: "wrong lane" };
    },
    __executePostConfirmBookingMutationFn: async () => {
      mutationCalls += 1;
      return { ok: false };
    },
    __executeAvailabilityCustomerConfirmBookingFn: async () => {
      pendingCalls += 1;
      return { ok: false };
    },
  });

  assert.equal(result.ownershipReleased, true);
  assert.equal(result.releaseReason, "SEMANTIC_SCOPE_NEW_TRANSACTION");
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
  assert.equal(result.bookingId, STONIC_BOOKING_ID);
  assert.equal(requestedFactCalls, 0);
  assert.equal(composeCalls, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(pendingCalls, 0);
});

test("semantic release ignores raw item text and catalog matching", () => {
  const fresh = decision();
  assert.equal(
    shouldReleasePostConfirmForFreshAvailability(fresh, {
      messageText: "Corolla ki jagah Civic?",
      facts: historicalStonicFacts(),
    }),
    true
  );
  assert.equal(
    shouldReleasePostConfirmForFreshAvailability(
      decision({
        turnScope: "OLD_BOOKING_REFERENCE",
        targetContext: "CONFIRMED_BOOKING",
        targetId: STONIC_BOOKING_ID,
      }),
      { messageText: "Honda Civic 3 din k liye chahiye", facts: {} }
    ),
    false
  );
});

test("leftover targetContext and booking selection cannot contradict turnScope", () => {
  const facts = historicalStonicFacts();
  const fresh = applyPostConfirmDerivedOwnershipMechanics(
    decision({
      turnScope: "NEW_TRANSACTION",
      targetContext: "NONE",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: STONIC_BOOKING_ID,
    }),
    facts
  );
  assert.equal(fresh.targetContext, "NEW_TRANSACTION");
  assert.equal(fresh.bookingSelectionMode, "none");
  assert.equal(fresh.selectedBookingId, null);
  assert.equal(validatePostConfirmSemanticOwnership(fresh, facts).ok, true);

  const social = applyPostConfirmDerivedOwnershipMechanics(
    decision({
      turnScope: "SOCIAL_GENERAL",
      targetContext: "CONFIRMED_BOOKING",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: STONIC_BOOKING_ID,
    }),
    facts
  );
  assert.equal(social.targetContext, "NONE");
  assert.equal(social.bookingSelectionMode, "none");
  assert.equal(social.selectedBookingId, null);
  assert.equal(validatePostConfirmSemanticOwnership(social, facts).ok, true);

  const staleTarget = applyPostConfirmDerivedOwnershipMechanics(
    decision({
      turnScope: "NEW_TRANSACTION",
      targetId: STONIC_BOOKING_ID,
    }),
    facts
  );
  assert.equal(
    validatePostConfirmSemanticOwnership(staleTarget, facts).reason,
    "NEW_TRANSACTION_CONTRADICTION"
  );
});

test("old-booking ownership requires exact trusted target and contradictions fail closed", () => {
  const facts = historicalStonicFacts();
  const valid = decision({
    turnScope: "OLD_BOOKING_REFERENCE",
    targetContext: "CONFIRMED_BOOKING",
    targetId: STONIC_BOOKING_ID,
    capability: "answer_from_active_booking",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    selectedBookingId: STONIC_BOOKING_ID,
  });
  assert.equal(validatePostConfirmSemanticOwnership(valid, facts).ok, true);
  assert.equal(
    validatePostConfirmSemanticOwnership(
      { ...valid, targetId: "booking-civic-expired" },
      facts
    ).reason,
    "OLD_BOOKING_TARGET_MISMATCH"
  );
  assert.equal(
    validatePostConfirmSemanticOwnership(
      decision({ mutationIntent: "cancel_booking" }),
      facts
    ).reason,
    "NEW_TRANSACTION_CONTRADICTION"
  );
});

test("decide context exposes exact candidate IDs without answerable booking facts", () => {
  const context = buildPostConfirmDecideFactsForPrompt(
    historicalStonicFacts()
  );
  assert.equal(context.bookingCandidates[0].bookingId, STONIC_BOOKING_ID);
  assert.equal(context.bookingCandidates[0].role, "historical_candidate");
  assert.equal(context.bookingFocus, null);
  assert.equal(context.booking, null);
  assert.equal(context.known, null);
  assert.equal(context.pendingAvailabilityRequests.length, 0);
});

test("item mismatch correction does not force OLD_BOOKING_REFERENCE from trusted focus", () => {
  const text = buildPostConfirmVerifiedItemMismatchCorrection(
    historicalStonicFacts(),
    "verified_item_mismatch"
  );
  assert.match(text, /NEW_TRANSACTION/);
  assert.match(text, /candidate facts only/i);
  assert.doesNotMatch(
    text,
    /Use turnScope=OLD_BOOKING_REFERENCE with this booking's exact bookingId as targetId for read-only factual answers/
  );
});
