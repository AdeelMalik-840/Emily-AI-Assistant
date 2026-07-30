import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { compactBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);
const { executePostConfirmPaLaneDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

function grounded(overrides = {}) {
  return {
    itemId: null,
    durationDays: null,
    bookingStatus: null,
    bookingReference: null,
    totalAmount: null,
    dailyRate: null,
    advanceAmount: null,
    startDate: null,
    endDate: null,
    pickupTime: null,
    deliveryTime: null,
    policyClaims: [],
    ...overrides,
  };
}

function modelDecision(overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    shouldReply: true,
    customerReply:
      "Kia Stonic 4 din ke liye book hai. Total 22000 PKR hai aur pickup 10am hai.",
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    candidateGroundings: [],
    pendingAvailabilitySelectionIndex: null,
    groundedFacts: grounded({
      itemId: "item-stonic",
      durationDays: 4,
      bookingStatus: "approved",
      totalAmount: 22000,
      dailyRate: 5500,
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      pickupTime: "10am",
      deliveryTime: "6pm",
    }),
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    ...overrides,
  });
}

test("trusted AVR-filled canonical booking facts are identical for prompt and final guard", async () => {
  const rawBooking = {
    id: "booking-stonic",
    customerSafeReference: "STONIC-4",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    availabilityRequestId: "avr-stonic",
  };
  const trustedAvailabilityRequest = {
    id: "avr-stonic",
    itemId: "item-stonic",
    itemLabel: "Kia Stonic",
    requestedDuration: 4,
    priceQuote: { total: 22000, dailyRate: 5500 },
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    pickupTime: "10am",
    deliveryTime: "6pm",
    status: "approved",
  };
  const canonical = {
    ...compactBookingFacts(rawBooking, trustedAvailabilityRequest),
    selectionIndex: 1,
  };
  const facts = {
    businessId: "business-1",
    customerPhoneDigits: "923001234567",
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: canonical,
    bookingCandidates: [canonical],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: canonical.id,
    },
    activeBookings: [],
    availabilityRequest: trustedAvailabilityRequest,
    known: {
      totalAmount: canonical.totalAmount,
      dailyRate: canonical.dailyRate,
      durationDays: canonical.durationDays,
      itemLabel: canonical.itemLabel,
    },
    pendingAvailabilityRequests: [],
    mutationExecution: {
      requested: false,
      status: "not_executed",
      intent: "none",
    },
    replyGuardFacts: {
      bookingExecutionVerified: true,
      itemId: canonical.itemId,
      itemLabel: canonical.itemLabel,
      durationDays: canonical.durationDays,
      bookingStatus: canonical.status,
      bookingReference: canonical.customerSafeReference,
      totalAmount: canonical.totalAmount,
      dailyRate: canonical.dailyRate,
      startDate: canonical.startDate,
      endDate: canonical.endDate,
      pickupTime: canonical.pickupTime,
      deliveryTime: canonical.deliveryTime,
      knownPolicies: {},
      activeBookings: [],
      catalogItems: [
        { id: "item-stonic", name: "Kia Stonic", aliases: ["Stonic"] },
      ],
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: false,
    },
  };

  const calls = [];
  const responses = [
    modelDecision({
      shouldReply: false,
      customerReply: "",
      action: "silence",
      bookingSelectionMode: "none",
      selectedBookingIndex: null,
      groundedFacts: grounded(),
    }),
    modelDecision(),
  ];
  let responseIndex = 0;

  const result = await executePostConfirmPaLaneDecision({
    facts,
    userMessage: "Booking ki complete details bata den",
    timeoutMs: 1000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      const content = responses[responseIndex];
      responseIndex += 1;
      return { choices: [{ message: { content } }] };
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(result.decision.selectedBookingId, "booking-stonic");
  assert.equal(result.decision.customerReply.includes("22000 PKR"), true);
  assert.equal(result.decision.customerReply.includes("4 din"), true);
  assert.equal(result.decision.customerReply.includes("10am"), true);

  const firstPrompt = String(calls[0]?.messages?.[1]?.content || "");
  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  for (const prompt of [firstPrompt, correctionPrompt]) {
    assert.match(prompt, /CURRENT_BOOKING_IN_SCOPE/);
    assert.match(prompt, /item-stonic/);
    assert.match(prompt, /22000/);
    assert.match(prompt, /5500/);
    assert.match(prompt, /2026-08-01/);
    assert.match(prompt, /10am/);
  }
});
