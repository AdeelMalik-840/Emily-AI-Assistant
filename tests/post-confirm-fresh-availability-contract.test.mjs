import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const { executePostConfirmPaLaneDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

const COROLLA_BOOKING_ID = "booking-corolla";
const CURRENT_OWNERSHIP_TURN_ID = "user:fresh-avail-1";

function currentTurnReferent(message, surfaceText) {
  const start = String(message).indexOf(surfaceText);
  return {
    source: "current_turn",
    surfaceText,
    start,
    end: start + surfaceText.length,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function availabilitySurface(message) {
  const text = String(message);
  for (const surface of [
    "Kia stonic",
    "HONDA CIVIC",
    "Honda Civic",
    "Civic",
    "Corolla",
  ]) {
    if (text.includes(surface)) return surface;
  }
  return text.slice(0, Math.max(1, text.indexOf(" ") > 0 ? text.indexOf(" ") : text.length));
}

function focusedCorollaFacts() {
  const booking = {
    id: COROLLA_BOOKING_ID,
    selectionIndex: 1,
    itemId: "toyota-corolla-metallic-grey",
    itemLabel: "Toyota Corolla (Metallic Grey)",
    durationDays: 7,
    status: "approved",
    pickupLocation: "Main branch",
  };
  return {
    booking,
    bookingCandidates: [booking],
    activeBookings: [booking],
    bookingFocus: {
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: COROLLA_BOOKING_ID,
      itemId: booking.itemId,
      itemLabel: booking.itemLabel,
    },
    known: {},
    replyGuardFacts: { activeBookings: [booking] },
    policy: { readOnly: true },
    currentOwnershipTurnId: CURRENT_OWNERSHIP_TURN_ID,
  };
}

function rawDecision(overrides = {}) {
  return JSON.stringify({
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "none",
    itemReferents: [],
    targetContext: "CONFIRMED_BOOKING",
    targetId: COROLLA_BOOKING_ID,
    targetReference: {
      source: "current_turn",
      sourceTurnId: CURRENT_OWNERSHIP_TURN_ID,
      targetType: "historical_booking",
      targetId: COROLLA_BOOKING_ID,
    },
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: null,
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "identity",
        attributes: ["item_label"],
      },
    ],
    shouldReply: true,
    customerReply: "",
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    actionParameters: {
      extensionDays: null,
      startDate: null,
      endDate: null,
      durationDays: null,
      itemId: null,
      pickupDetails: null,
      deliveryRequested: null,
      deliveryAddress: null,
      deliveryTime: null,
    },
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    selectedBookingId: COROLLA_BOOKING_ID,
    candidateGroundings: [],
    pendingAvailabilitySelectionIndex: null,
    groundedFacts: {
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
    },
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    ...overrides,
  });
}

function availabilityDecision(message, { withCatalogEvidence = false } = {}) {
  const surface = availabilitySurface(message);
  return rawDecision({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [currentTurnReferent(message, surface)],
    targetContext: "NEW_TRANSACTION",
    targetId: null,
    selectedBookingId: null,
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    factKind: "booking_fact",
    capability: "availability_request",
    evidenceNeeds: withCatalogEvidence
      ? [{ entity: "catalog", concept: "identity", attributes: ["label", "id"] }]
      : [],
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
  });
}

test("catalog evidence cannot remap fresh availability to an active-booking answer", async () => {
  const { decision } = await runBrainContract(
    "Kia stonic 5 din k lye chyh",
    availabilityDecision("Kia stonic 5 din k lye chyh", { withCatalogEvidence: true })
  );
  assert.equal(decision.capability, "availability_request");
  assert.equal(decision.bookingSelectionMode, "none");
  assert.equal(decision.selectedBookingId, null);
});

async function runBrainContract(userMessage, raw) {
  const calls = [];
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedCorollaFacts(),
    userMessage,
    timeoutMs: 1000,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      return {
        choices: [{ message: { content: raw }, finish_reason: "stop" }],
      };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1);
  return { decision: result.decision, system: calls[0].messages[0].content };
}

const freshRequests = [
  "Kia stonic 5 din k lye chyh",
  "HONDA CIVIC 5 DIN K LYE CHYH",
  "Honda Civic kal ke liye chahiye",
  "Ek aur Civic weekend ke liye chahiye",
  "Corolla 5 din ke liye chahiye, new request",
];

for (const message of freshRequests) {
  test(`fresh availability contract releases existing focus: ${message}`, async () => {
    const { decision, system } = await runBrainContract(
      message,
      availabilityDecision(message)
    );
    assert.match(system, /INDEPENDENT fresh inventory availability/i);
    assert.match(system, /BOOKING-RELATIVE comparison/i);
    assert.match(system, /Runtime derives/i);
    assert.equal(decision.factKind, "booking_fact");
    assert.equal(decision.capability, "availability_request");
    assert.equal(decision.mutationIntent, "none");
    assert.equal(decision.bookingSelectionMode, "none");
    assert.equal(decision.selectedBookingIndex, null);
    assert.equal(decision.selectedBookingId, null);
  });
}

const focusedQuestions = [
  {
    message: "Advance kitna hoga?",
    factKind: "advance",
    capability: "answer_from_business_profile",
    evidenceNeeds: [],
  },
  {
    message: "Pickup kahan se hogi?",
    requestedInformation: "pickup_location",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "pickup",
        attributes: ["location"],
      },
    ],
  },
  {
    message: "Booking kitne din ki hai?",
    requestedInformation: "duration",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "duration",
        attributes: ["duration_days"],
      },
    ],
  },
  {
    message: "Documents kya chahiye?",
    factKind: "documents_checklist",
    capability: "answer_from_business_profile",
    evidenceNeeds: [],
  },
  {
    message: "Delivery kahan hogi?",
    requestedInformation: "delivery_location",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "delivery",
        attributes: ["location"],
      },
    ],
  },
  {
    message: "Total kitna bana?",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "price",
        attributes: ["total"],
      },
    ],
  },
];

for (const row of focusedQuestions) {
  test(`focused continuity requires explicit focused mode: ${row.message}`, async () => {
    const raw = rawDecision({
      factKind: row.factKind ?? "booking_fact",
      capability: row.capability ?? "answer_from_active_booking",
      requestedInformation: row.requestedInformation ?? null,
      evidenceNeeds: row.evidenceNeeds,
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
    });
    const { decision } = await runBrainContract(row.message, raw);
    assert.equal(decision.bookingSelectionMode, "focused");
    assert.equal(decision.selectedBookingIndex, 1);
    assert.equal(decision.selectedBookingId, COROLLA_BOOKING_ID);
  });
}

test("focused mutation retains Corolla context", async () => {
  const { decision } = await runBrainContract(
    "Isko 2 din aur extend kar do.",
    rawDecision({
      factKind: "action",
      capability: "mutation_requested",
      evidenceNeeds: [],
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
      shouldReply: false,
      mutationExecutionRequested: false,
      actionParameters: {
        extensionDays: 2,
        startDate: null,
        endDate: null,
        durationDays: null,
        itemId: null,
        pickupDetails: null,
        deliveryRequested: null,
        deliveryAddress: null,
        deliveryTime: null,
      },
    })
  );
  assert.equal(decision.bookingSelectionMode, "focused");
  assert.equal(decision.selectedBookingId, COROLLA_BOOKING_ID);
  assert.equal(decision.mutationIntent, "extend_booking");
});

test("focused cancellation retains Corolla context", async () => {
  const { decision } = await runBrainContract(
    "Booking cancel kar do.",
    rawDecision({
      factKind: "action",
      capability: "mutation_requested",
      evidenceNeeds: [],
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      shouldReply: false,
      mutationExecutionRequested: false,
    })
  );
  assert.equal(decision.bookingSelectionMode, "focused");
  assert.equal(decision.selectedBookingId, COROLLA_BOOKING_ID);
  assert.equal(decision.mutationIntent, "cancel_booking");
});

test("focused pickup mutation with structured detail survives pre-execution flags", async () => {
  const { decision } = await runBrainContract(
    "Pickup kal kar do.",
    rawDecision({
      factKind: "action",
      capability: "mutation_requested",
      evidenceNeeds: [],
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      shouldReply: false,
      action: "request_booking_mutation",
      mutationIntent: "update_pickup",
      mutationExecutionRequested: false,
      actionParameters: {
        extensionDays: null,
        startDate: null,
        endDate: null,
        durationDays: null,
        itemId: null,
        pickupDetails: "kal",
        deliveryRequested: null,
        deliveryAddress: null,
        deliveryTime: null,
      },
    })
  );
  assert.equal(decision.action, "request_booking_mutation");
  assert.equal(decision.mutationIntent, "update_pickup");
  assert.equal(decision.bookingSelectionMode, "focused");
  assert.equal(decision.selectedBookingId, COROLLA_BOOKING_ID);
  assert.equal(decision.mutationExecutionRequested, true);
});

test("mutation missing required parameters fails closed before execution", async () => {
  const raw = rawDecision({
    factKind: "action",
    capability: "mutation_requested",
    evidenceNeeds: [],
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    shouldReply: false,
    action: "request_booking_mutation",
    mutationIntent: "extend_booking",
    mutationExecutionRequested: false,
    actionParameters: {
      extensionDays: null,
      startDate: null,
      endDate: null,
      durationDays: null,
      itemId: null,
      pickupDetails: null,
      deliveryRequested: null,
      deliveryAddress: null,
      deliveryTime: null,
    },
  });
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedCorollaFacts(),
    userMessage: "Isko extend kar do.",
    timeoutMs: 1000,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: raw }, finish_reason: "stop" }],
    }),
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.decision?.action, "request_booking_mutation");
  assert.equal(result.decision?.mutationExecutionRequested, false);
});

test("unsupported mutation value cannot reach mutation execution semantics", async () => {
  const raw = rawDecision({
    factKind: "action",
    capability: "mutation_requested",
    evidenceNeeds: [],
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    shouldReply: false,
    action: "request_booking_mutation",
    mutationIntent: "delete_everything",
    mutationExecutionRequested: false,
  });
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedCorollaFacts(),
    userMessage: "Delete everything.",
    timeoutMs: 1000,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: raw }, finish_reason: "stop" }],
    }),
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.decision?.action, "request_booking_mutation");
  assert.equal(result.decision?.mutationExecutionRequested, false);
});

test("informational shouldReply false keeps existing deferred correction behavior", async () => {
  const raw = rawDecision({
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    shouldReply: false,
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
  });
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedCorollaFacts(),
    userMessage: "Booking kitne din ki hai?",
    timeoutMs: 1000,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: raw }, finish_reason: "stop" }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision?.informationalReplyDeferred, true);
  assert.equal(result.decision?.bookingSelectionMode, "focused");
  assert.notEqual(result.decision?.action, "request_booking_mutation");
  assert.equal(result.decision?.mutationExecutionRequested, false);
});

test("named Civic mileage fact cannot attach focused Corolla", async () => {
  const { decision } = await runBrainContract(
    "Mileage kitni hai Civic ki?",
    rawDecision({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "details_inquiry",
      itemScope: "specific",
      itemReferents: [currentTurnReferent("Mileage kitni hai Civic ki?", "Civic")],
      targetContext: "NEW_TRANSACTION",
      targetId: null,
      selectedBookingId: null,
      targetReference: {
        source: "none",
        sourceTurnId: null,
        targetType: "none",
        targetId: null,
      },
      factKind: "freeform_business",
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: [],
        },
      ],
      bookingSelectionMode: "none",
      selectedBookingIndex: null,
    })
  );
  assert.equal(decision.factKind, "freeform_business");
  assert.equal(decision.bookingSelectionMode, "none");
  assert.equal(decision.selectedBookingIndex, null);
  assert.equal(decision.selectedBookingId, null);
});

test("live vague/none model failure cannot deterministically attach Corolla", async () => {
  const { decision } = await runBrainContract(
    "HONDA CIVIC 5 DIN K LYE CHYH",
    rawDecision({
      turnScope: "UNCLEAR",
      semanticIntent: "unclear",
      itemScope: "none",
      itemReferents: [],
      targetContext: "NONE",
      targetId: null,
      selectedBookingId: null,
      targetReference: {
        source: "none",
        sourceTurnId: null,
        targetType: "none",
        targetId: null,
      },
      conversationAct: "unknown",
      customerIntent: "unclear",
      customerIsAskingQuestion: false,
      factKind: "vague",
      capability: null,
      evidenceNeeds: [],
      shouldReply: false,
      action: "silence",
      bookingSelectionMode: "none",
      selectedBookingIndex: null,
    })
  );
  assert.equal(decision.factKind, "vague");
  assert.equal(decision.capability, "clarification_needed");
  assert.equal(decision.bookingSelectionMode, "none");
  assert.equal(decision.selectedBookingIndex, null);
  assert.equal(decision.selectedBookingId, null);
});
