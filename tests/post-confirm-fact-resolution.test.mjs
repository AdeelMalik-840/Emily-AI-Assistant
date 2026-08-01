/**
 * Deterministic post-confirm fact resolver — FOUND / NOT FOUND / UNSUPPORTED.
 * Never reads customer text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePostConfirmRequestedFact,
  POST_CONFIRM_REQUESTED_INFORMATION,
} from "../src/brain/facts/resolvePostConfirmRequestedFact.js";
import {
  isDeferredPostConfirmInformationalDecision,
  parsePostConfirmCustomerDmDecision,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";

function booking(overrides = {}) {
  return {
    id: "bk-1",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Suzuki Stonic",
    itemId: "stonic-1",
    durationDays: 3,
    startDate: "2026-08-10",
    endDate: "2026-08-13",
    totalAmount: 15000,
    dailyRate: 5000,
    customerSafeReference: "REF-100",
    pickupTime: null,
    pickupLocation: null,
    deliveryTime: null,
    deliveryAddress: null,
    ...overrides,
  };
}

test("requestedInformation vocabulary is compact and frozen", () => {
  assert.ok(POST_CONFIRM_REQUESTED_INFORMATION.includes("pickup_location"));
  assert.ok(POST_CONFIRM_REQUESTED_INFORMATION.includes("unclear"));
});

test("pickup_location absent → not_found (never uses deliveryAddress or pickupTime)", () => {
  const r = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_location",
    selectedBooking: booking({
      pickupTime: "10:00 AM",
      deliveryAddress: "Gulberg office",
      pickupLocation: null,
    }),
    facts: {},
  });
  assert.equal(r.status, "not_found");
  assert.equal(r.factAvailable, false);
  assert.equal(r.verifiedValue, null);
});

test("pickup_location present → found exact value", () => {
  const r = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_location",
    selectedBooking: booking({ pickupLocation: "DHA Phase 5 gate" }),
    facts: {},
  });
  assert.equal(r.status, "found");
  assert.equal(r.verifiedValue, "DHA Phase 5 gate");
  assert.equal(r.source, "booking.pickupLocation");
});

test("pickup_location conflicting values → not_found", () => {
  const r = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_location",
    selectedBooking: booking({
      pickupLocation: "Place A",
      pickupDetails: "Place B",
    }),
    facts: {},
  });
  assert.equal(r.status, "not_found");
});

test("pickup_time absent/present", () => {
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "pickup_time",
      selectedBooking: booking({ pickupTime: null }),
    }).status,
    "not_found"
  );
  const found = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_time",
    selectedBooking: booking({ pickupTime: "11:30 AM" }),
  });
  assert.equal(found.status, "found");
  assert.equal(found.verifiedValue, "11:30 AM");
});

test("delivery_location and delivery_time", () => {
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "delivery_location",
      selectedBooking: booking(),
    }).status,
    "not_found"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "delivery_location",
      selectedBooking: booking({ deliveryAddress: "Model Town" }),
    }).verifiedValue,
    "Model Town"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "delivery_time",
      selectedBooking: booking({ deliveryTime: "5 PM" }),
    }).verifiedValue,
    "5 PM"
  );
});

test("booking duration/dates/price/status/reference/identity found", () => {
  const b = booking();
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_duration",
      selectedBooking: b,
    }).verifiedValue,
    3
  );
  assert.deepEqual(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_dates",
      selectedBooking: b,
    }).verifiedValue,
    { start: "2026-08-10", end: "2026-08-13" }
  );
  assert.deepEqual(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_price",
      selectedBooking: b,
    }).verifiedValue,
    { total: 15000, daily: 5000 }
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_status",
      selectedBooking: b,
    }).verifiedValue,
    "approved"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_reference",
      selectedBooking: b,
    }).verifiedValue,
    "REF-100"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "booking_identity",
      selectedBooking: b,
    }).verifiedValue,
    "Suzuki Stonic"
  );
});

test("policy categories absent/present", () => {
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "driver_policy",
      facts: { known: {}, business: {} },
      selectedBooking: booking(),
    }).status,
    "not_found"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "driver_policy",
      facts: { known: { driverPolicy: "Driver available on request" } },
      selectedBooking: booking(),
    }).verifiedValue,
    "Driver available on request"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "advance_policy",
      facts: { known: { advanceAmount: 5000 } },
      selectedBooking: booking(),
    }).status,
    "found"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "payment_policy",
      facts: { business: { paymentPolicy: "Cash only" } },
      selectedBooking: booking(),
    }).verifiedValue,
    "Cash only"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "documents_policy",
      facts: { known: { documentsPolicy: "CNIC required" } },
      selectedBooking: booking(),
    }).verifiedValue,
    "CNIC required"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "delivery_policy",
      facts: { known: { deliveryPolicy: "Delivery within city" } },
      selectedBooking: booking(),
    }).verifiedValue,
    "Delivery within city"
  );
});

test("other_verified_fact uses closed answers only", () => {
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "other_verified_fact",
      facts: { latestClosedMissingInfoAnswers: [] },
      selectedBooking: booking(),
    }).status,
    "not_found"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "other_verified_fact",
      facts: {
        latestClosedMissingInfoAnswers: [
          { ownerAnswer: "Fuel is customer responsibility" },
        ],
      },
      selectedBooking: booking(),
    }).verifiedValue,
    "Fuel is customer responsibility"
  );
});

test("unclear / unknown → unsupported", () => {
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "unclear",
      selectedBooking: booking(),
    }).status,
    "unsupported"
  );
  assert.equal(
    resolvePostConfirmRequestedFact({
      requestedInformation: "not_a_real_category",
      selectedBooking: booking(),
    }).status,
    "unsupported"
  );
});

test("deferred informational parse allows empty customerReply", () => {
  const decision = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "new_question",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: "pickup_location",
      capability: "answer_from_active_booking",
      evidenceNeeds: [
        {
          entity: "active_booking",
          concept: "pickup",
          attributes: ["location"],
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
    })
  );
  assert.ok(decision);
  assert.equal(decision.capability, "answer_from_active_booking");
  assert.equal(decision.evidenceNeeds?.[0]?.concept, "pickup");
  assert.equal(decision.requestedInformation, "pickup_location");
  assert.equal(decision.customerReply, "");
  assert.equal(decision.informationalReplyDeferred, true);
  assert.equal(isDeferredPostConfirmInformationalDecision(decision), true);
});

test("legacy requestedInformation alone still maps to Turn Plan on parse", () => {
  const decision = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "new_question",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: "pickup_location",
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
    })
  );
  assert.ok(decision);
  assert.equal(decision.capability, "answer_from_active_booking");
  assert.deepEqual(decision.evidenceNeeds, [
    {
      entity: "active_booking",
      concept: "pickup",
      attributes: ["location"],
    },
  ]);
  assert.equal(decision.informationalReplyDeferred, true);
});

test("acknowledgement act keeps answer_from Turn Plan evidenceNeeds", () => {
  const decision = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "acknowledgement_after_answer",
      conversationAct: "acknowledgement",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: null,
      capability: "answer_from_active_booking",
      evidenceNeeds: [
        {
          entity: "active_booking",
          concept: "duration",
          attributes: ["days"],
        },
      ],
      shouldReply: true,
      customerReply: "Aapki booking 4 din ke liye hui hai.",
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
      candidateGroundings: [],
      pendingAvailabilitySelectionIndex: null,
      groundedFacts: {
        itemId: null,
        durationDays: 4,
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
    })
  );
  assert.ok(decision);
  assert.equal(decision.conversationAct, "information_request");
  assert.equal(decision.capability, "answer_from_active_booking");
  assert.equal(decision.evidenceNeeds?.[0]?.concept, "duration");
  assert.equal(decision.customerReply, "");
  assert.equal(decision.informationalReplyDeferred, true);
  assert.equal(isDeferredPostConfirmInformationalDecision(decision), true);
});

test("ordinary empty reply without requestedInformation still fails closed", () => {
  const decision = parsePostConfirmCustomerDmDecision(
    JSON.stringify({
      situation: "new_question",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      requestedInfoType: null,
      requestedInformation: null,
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
    })
  );
  assert.equal(decision, null);
});
