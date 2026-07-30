import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  executePostConfirmPaLaneDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

const STONIC_ITEM_ID = "test-stonic-item";
const CIVIC_ITEM_ID = "test-civic-item";

function focusedFacts() {
  const stonic = {
    id: "test-booking-stonic",
    selectionIndex: 1,
    customerSafeReference: "STONIC-4",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: STONIC_ITEM_ID,
    itemLabel: "Kia Stonic",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    availabilityRequestId: "test-avr-stonic",
  };
  const civic = {
    id: "test-booking-civic",
    selectionIndex: 2,
    customerSafeReference: "CIVIC-5",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: CIVIC_ITEM_ID,
    itemLabel: "Honda Civic",
    durationDays: 5,
    totalAmount: 40000,
    dailyRate: 8000,
    availabilityRequestId: "test-avr-civic",
  };
  return {
    businessId: "test-business",
    customerPhoneDigits: "923001234567",
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: stonic,
    bookingCandidates: [stonic, civic],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: stonic.id,
    },
    activeBookings: [stonic, civic].map(
      ({ id: _id, itemId: _itemId, availabilityRequestId: _avr, ...safe }) =>
        safe
    ),
    availabilityRequest: {
      id: "test-avr-stonic",
      itemId: STONIC_ITEM_ID,
      itemLabel: "Kia Stonic",
      requestedDuration: 4,
      status: "approved",
      priceQuote: { total: 22000, dailyRate: 5500 },
    },
    known: {},
    pendingAvailabilityRequests: [],
    mutationExecution: {
      requested: false,
      status: "not_executed",
      intent: "none",
    },
    replyGuardFacts: {
      catalogItems: [
        { id: STONIC_ITEM_ID, name: "Kia Stonic", aliases: ["Stonic"] },
        { id: CIVIC_ITEM_ID, name: "Honda Civic", aliases: ["Civic"] },
      ],
      activeBookings: [stonic, civic],
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: false,
    },
  };
}

function groundedFacts(overrides = {}) {
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

function decision(overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    shouldReply: true,
    customerReply: "Kia Stonic 4 din ke liye book hai.",
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    candidateGroundings: [],
    pendingAvailabilitySelectionIndex: null,
    groundedFacts: groundedFacts({
      itemId: STONIC_ITEM_ID,
      durationDays: 4,
      bookingStatus: "approved",
      bookingReference: "STONIC-4",
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

function silenceInformationDecision() {
  return decision({
    shouldReply: false,
    customerReply: "",
    action: "silence",
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
}

async function runWithResponses(responses, options = {}) {
  const calls = [];
  let index = 0;
  const result = await executePostConfirmPaLaneDecision({
    facts: options.facts || focusedFacts(),
    userMessage: options.userMessage || "Kitny din k lye book ki h????",
    conversationHistory: options.conversationHistory || null,
    timeoutMs: 1000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      const content = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return { choices: [{ message: { content } }] };
    },
  });
  return { result, calls };
}

test("trusted focused information silence gets one same-Brain correction and natural answer", async () => {
  const { result, calls } = await runWithResponses([
    silenceInformationDecision(),
    decision(),
  ]);

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.shouldReply, true);
  assert.equal(result.decision.customerReply, "Kia Stonic 4 din ke liye book hai.");
  assert.equal(result.decision.bookingSelectionMode, "focused");
  assert.equal(result.decision.selectedBookingIndex, 1);
  assert.equal(result.decision.selectedBookingId, "test-booking-stonic");

  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correctionPrompt, /CORRECTIVE REGENERATION/);
  assert.match(correctionPrompt, /CURRENT_BOOKING_IN_SCOPE/);
  assert.match(correctionPrompt, /test-stonic-item/);
  assert.doesNotMatch(correctionPrompt, /return\s+"Kia Stonic 4 din/i);
});

test("two required focused silence decisions terminalize after exactly two attempts", async () => {
  const { result, calls } = await runWithResponses([
    silenceInformationDecision(),
    silenceInformationDecision(),
  ]);

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "customer_reply_required_but_empty");
  assert.equal(result.retryable, false);
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(result.decision.customerReply, "");
});

test("social silence remains a valid no-outbound result", async () => {
  const socialSilence = decision({
    situation: "conversation_closing",
    conversationAct: "thanks",
    customerIntent: "thanks",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: false,
    customerReply: "",
    action: "silence",
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
  const { result, calls } = await runWithResponses(
    [socialSilence, socialSilence],
    { userMessage: "Thanks" }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.action, "silence");
  assert.equal(result.decision.shouldReply, false);
  assert.equal(result.decision.customerReply, "");
});

test("trusted focus does not turn an ambiguous mutation into focused execution", async () => {
  const mutation = decision({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: true,
    customerReply: "Kaunsi booking cancel karni hai?",
    action: "request_booking_mutation",
    mutationIntent: "cancel_booking",
    mutationExecutionRequested: true,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
  const { result, calls } = await runWithResponses(
    [mutation, mutation],
    { userMessage: "Cancel kar do" }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_booking_mutation_requires_candidate");
  assert.equal(result.retryable, false);
  const secondPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.doesNotMatch(secondPrompt, /CORRECTIVE REGENERATION/);
});

test("invalid or malformed OpenAI output remains a separate terminal path", async () => {
  const { result, calls } = await runWithResponses(["", ""]);

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.retryable, false);
  assert.equal(result.silenceRecoveryAttempts, 0);
  assert.equal(result.contentSafetyAttempts, 2);
});
