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


/** Test-only: inject authoritative factKind so production never accepts Brain stores without it. */
function inferTestOnlyFactKind(d) {
  if (d?.factKind) return d.factKind;
  const action = d?.action;
  if (
    action === "request_booking_mutation" ||
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability"
  ) {
    return "action";
  }
  if (d?.mutationIntent && d.mutationIntent !== "none") return "action";
  const cap = d?.capability;
  const concept = Array.isArray(d?.evidenceNeeds) ? d.evidenceNeeds[0]?.concept : null;
  if (cap === "social") return "non_business";
  if (cap === "mutation_requested") return "action";
  if (cap === "clarification_needed") return "vague";
  if (cap === "answer_from_saved_owner_answer") return "freeform_business";
  if (cap === "answer_from_active_booking" || cap === "availability_request") {
    return "booking_fact";
  }
  if (cap === "answer_from_business_profile") {
    if (concept === "documents") return "documents_checklist";
    if (concept === "payment") return "payment_method";
    if (concept === "driver") return "driver_policy";
    if (concept === "delivery") return "delivery_policy";
    if (concept === "advance") return "advance";
    return "advance";
  }
  if (
    (d?.conversationAct === "chit_chat" ||
      d?.conversationAct === "acknowledgement" ||
      d?.conversationAct === "thanks") &&
    d?.customerIsAskingQuestion !== true &&
    d?.customerIntent !== "ask_fact"
  ) {
    return "non_business";
  }
  return null;
}

function modelDecision(overrides = {}) {
  const payload = {
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: "booking_price",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "price",
        attributes: ["total", "daily"],
      },
    ],
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
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "factKind")) {
    payload.factKind = inferTestOnlyFactKind(payload);
  }
  return JSON.stringify(payload);
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
  // Silence + factual Turn Plan must normalize to deferred resolve (no recovery round-trip).
  const responses = [
    modelDecision({
      shouldReply: false,
      customerReply: "",
      action: "silence",
      bookingSelectionMode: "none",
      selectedBookingIndex: null,
      groundedFacts: grounded(),
    }),
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

  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 0);
  assert.equal(result.contentSafetyAttempts, 1);
  assert.equal(result.decision.selectedBookingId, "booking-stonic");
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_active_booking");

  const firstPrompt = String(calls[0]?.messages?.[1]?.content || "");
  assert.match(firstPrompt, /POST_CONFIRM_DECIDE_CONTEXT_JSON|CURRENT_BOOKING_IN_SCOPE/);
  assert.match(firstPrompt, /item-stonic/);
  assert.match(firstPrompt, /Kia Stonic/);
  // Decide context must not expose answerable fact values (resolve+compose owns those).
  const contextBlock = firstPrompt.split("CUSTOMER_MESSAGE:")[0] || "";
  assert.doesNotMatch(contextBlock, /\b22000\b/);
  assert.doesNotMatch(contextBlock, /\b5500\b/);
  assert.doesNotMatch(contextBlock, /2026-08-01/);
  assert.doesNotMatch(contextBlock, /\b10am\b/i);
  // Final guard still receives full trusted booking facts via replyGuardFacts.
  assert.equal(facts.replyGuardFacts.totalAmount, 22000);
  assert.equal(facts.replyGuardFacts.dailyRate, 5500);
  assert.equal(facts.replyGuardFacts.pickupTime, "10am");
});
