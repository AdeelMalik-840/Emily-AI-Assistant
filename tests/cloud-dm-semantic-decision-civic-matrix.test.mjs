import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { executePostConfirmBookingMutation } = await import(
  "../src/services/postConfirmBookingMutationExecutor.js"
);

const STONIC_ID = "MHFaQZBnBVgEeRoCIFQ3";
const CIVIC_OLD_ID = "E55qPBHJUW1NsUvNLAhH";

function historyFacts() {
  const stonic = {
    id: STONIC_ID,
    selectionIndex: 1,
    itemId: "kia-stonic",
    itemLabel: "Kia Stonic",
    status: "approved",
    durationDays: 4,
  };
  const civic = {
    id: CIVIC_OLD_ID,
    selectionIndex: 2,
    itemId: "honda-civic",
    itemLabel: "Honda Civic",
    status: "approved",
    durationDays: 5,
  };
  return {
    booking: civic,
    bookingCandidates: [stonic, civic],
    activeBookings: [stonic, civic],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 2,
      selectedBookingId: CIVIC_OLD_ID,
      bookingId: CIVIC_OLD_ID,
      itemId: civic.itemId,
      itemLabel: civic.itemLabel,
    },
    pendingAvailabilityRequests: [],
    known: {},
    policy: { readOnly: true },
  };
}

async function runPa({ message, decision, composeReply = "ok" }) {
  let mutationCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "905443829990",
    messageText: message,
    messageId: "wamid.civic-matrix",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: historyFacts(),
    }),
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision,
    }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: composeReply,
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      mutationCalls += 1;
      return executePostConfirmBookingMutation(args);
    },
  });
  return { result, mutationCalls };
}

test("fresh Civic with old Stonic/Civic history and expired AVR excluded is NEW_TRANSACTION", async () => {
  const { result, mutationCalls } = await runPa({
    message: "Honda Civic 3 din k liye chahiye",
    decision: {
      turnScope: "NEW_TRANSACTION",
      targetId: null,
      action: "reply",
      mutationIntent: "none",
      factKind: "booking_fact",
      capability: "availability_request",
    },
  });
  assert.equal(result.ownershipReleased, true);
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
  assert.equal(result.decision.targetId, null);
  assert.notEqual(result.decision.targetId, CIVIC_OLD_ID);
  assert.notEqual(result.decision.targetId, STONIC_ID);
  assert.equal(mutationCalls, 0);
});

test("old Stonic factual question binds exact historical target", async () => {
  const { result } = await runPa({
    message: "Meri Stonic booking ka total rent kitna hai?",
    composeReply: "Stonic ka total rent confirm facts se aayega.",
    decision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: STONIC_ID,
      action: "reply",
      mutationIntent: "none",
      factKind: "booking_fact",
      capability: "answer_from_active_booking",
      informationalReplyDeferred: true,
      shouldReply: true,
      customerReply: "",
      evidenceNeeds: [{ store: "active_booking", concept: "price" }],
    },
  });
  assert.notEqual(result.ownershipReleased, true);
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, STONIC_ID);
  assert.equal(result.decision.selectedBookingId, STONIC_ID);
});

test("old Stonic mutation keeps exact target and existing mutation gates", async () => {
  const { result, mutationCalls } = await runPa({
    message: "Meri Stonic booking cancel kar do",
    decision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: STONIC_ID,
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      factKind: "action",
      capability: "mutation_requested",
      shouldReply: true,
      customerReply: "",
    },
  });
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, STONIC_ID);
  assert.equal(mutationCalls, 1);
  assert.equal(result.mutationExecution?.status, "unsupported");
});

test("Hello is SOCIAL_GENERAL with no booking owner", async () => {
  const { result, mutationCalls } = await runPa({
    message: "Hello",
    decision: {
      turnScope: "SOCIAL_GENERAL",
      targetId: null,
      action: "reply",
      mutationIntent: "none",
      factKind: "non_business",
      capability: "social",
      customerReply: "Hello! Kya madad chahiye?",
    },
  });
  assert.equal(result.ownershipReleased, true);
  assert.equal(result.decision.turnScope, "SOCIAL_GENERAL");
  assert.equal(result.decision.targetId, null);
  assert.equal(mutationCalls, 0);
});

test("ambiguous same-item cannot mutate without exact old-booking scope", async () => {
  const { result, mutationCalls } = await runPa({
    message: "Civic 3 din",
    decision: {
      turnScope: "UNCLEAR",
      targetId: null,
      action: "reply",
      mutationIntent: "none",
      factKind: "vague",
      capability: "clarification_needed",
    },
  });
  assert.equal(result.ownershipReleased, true);
  assert.equal(result.decision.turnScope, "UNCLEAR");
  assert.equal(result.decision.mutationIntent, "none");
  assert.equal(mutationCalls, 0);
});
