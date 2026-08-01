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
import {
  buildPostConfirmInformationalComposeContextForPrompt,
  buildInformationalComposeFactResolutionForPrompt,
  composePostConfirmInformationalCustomerReply,
} from "../src/services/customerBusinessPaAiReply.js";

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

test("compose context strips side-channel owner answers and policies", () => {
  const ctx = buildPostConfirmInformationalComposeContextForPrompt({
    facts: {
      business: {
        name: "Prod Rentals",
        tone: "friendly",
        deliveryPolicy: "Lahore only",
        advancePolicy: "50%",
      },
      known: {
        deliveryPolicy: "Lahore only",
        driverPolicy: "Driver on request",
      },
      booking: booking({
        pickupLocation: "DHA",
        pickupTime: "10:00 AM",
        totalAmount: 22000,
      }),
      latestClosedMissingInfoAnswers: [
        {
          requestId: "mir-1",
          missingInfoType: "other",
          ownerAnswer: "Fuel is customer responsibility",
        },
      ],
      catalogItems: [{ id: "x", name: "Corolla" }],
      activeBookings: [booking()],
      pendingAvailabilityRequests: [{ itemLabel: "Civic" }],
    },
    selectedBooking: booking({ pickupLocation: "DHA", totalAmount: 22000 }),
  });
  assert.equal(ctx.conversationContextOnly, true);
  assert.equal(ctx.business.name, "Prod Rentals");
  assert.equal(ctx.business.tone, "friendly");
  assert.equal(ctx.focusedBookingIdentity?.itemLabel, "Suzuki Stonic");
  assert.equal(ctx.known, null);
  assert.equal(ctx.knownPolicies, null);
  assert.equal(ctx.latestClosedMissingInfoAnswers, null);
  assert.equal(ctx.booking, null);
  assert.equal(ctx.catalogItems, null);
  assert.equal(ctx.activeBookings, null);
  assert.equal(ctx.pendingAvailabilityRequests, null);
  const blob = JSON.stringify(ctx);
  assert.doesNotMatch(blob, /Fuel is customer/i);
  assert.doesNotMatch(blob, /Lahore only/i);
  assert.doesNotMatch(blob, /Driver on request/i);
  assert.doesNotMatch(blob, /10:00/i);
  assert.doesNotMatch(blob, /22000/);
  assert.doesNotMatch(blob, /Corolla|Civic/i);
});

test("compose Result prompt strips values unless aggregate found", () => {
  const missing = buildInformationalComposeFactResolutionForPrompt({
    status: "missing",
    factAvailable: false,
    verifiedValue: { start: "2026-08-05" },
    items: [
      {
        entity: "active_booking",
        concept: "dates",
        attribute: "start",
        status: "found",
        verifiedValue: "2026-08-05",
        source: "booking.startDate",
      },
      {
        entity: "active_booking",
        concept: "dates",
        attribute: "end",
        status: "missing",
        verifiedValue: null,
        source: null,
      },
    ],
  });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.verifiedValue, null);
  assert.ok(missing.items.every((i) => i.verifiedValue == null));

  const conflicting = buildInformationalComposeFactResolutionForPrompt({
    status: "conflicting",
    items: [
      {
        entity: "active_booking",
        concept: "pickup",
        attribute: "location",
        status: "conflicting",
        verifiedValue: null,
        source: null,
      },
    ],
  });
  assert.equal(conflicting.status, "conflicting");
  assert.equal(conflicting.verifiedValue, null);

  const found = buildInformationalComposeFactResolutionForPrompt({
    status: "found",
    factAvailable: true,
    verifiedValue: "Fuel is customer responsibility",
    items: [
      {
        entity: "saved_owner_answer",
        concept: "other",
        attribute: "answer",
        status: "found",
        verifiedValue: "Fuel is customer responsibility",
        source: "latestClosedMissingInfoAnswers.ownerAnswer",
      },
    ],
  });
  assert.equal(found.status, "found");
  assert.equal(found.verifiedValue, "Fuel is customer responsibility");
  assert.equal(found.items[0].verifiedValue, "Fuel is customer responsibility");
});

test("unsupported fuel compose prompt cannot see closed owner answer", async () => {
  const b = booking({ pickupLocation: null, pickupTime: null });
  const facts = {
    business: { name: "Prod", deliveryPolicy: "Lahore only" },
    known: { deliveryPolicy: "Lahore only" },
    booking: b,
    latestClosedMissingInfoAnswers: [
      {
        requestId: "mir-1",
        missingInfoType: "other",
        ownerAnswer: "Fuel is customer responsibility",
      },
    ],
  };
  const prompts = [];
  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "fuel policy kya hai?",
    frozenDecision: {
      action: "reply",
      shouldReply: true,
      mutationIntent: "none",
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        {
          entity: "business_profile",
          concept: "other",
          attributes: ["answer"],
        },
      ],
      informationalReplyDeferred: true,
    },
    factResolution: {
      capability: "answer_from_business_profile",
      status: "unsupported",
      factAvailable: false,
      verifiedValue: null,
      source: null,
      items: [
        {
          entity: "business_profile",
          concept: "other",
          attribute: "answer",
          status: "unsupported",
          verifiedValue: null,
          source: null,
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply:
                  "Fuel policy abhi confirm nahi hui. Kya aur detail chahiye?",
                replySemantics: {
                  claims: [],
                  languageStyle: "roman_urdu",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(composed.ok, true);
  assert.doesNotMatch(composed.reply, /zimmedari|responsibility|bear/i);
  const userContent = String(prompts[0]?.messages?.[1]?.content || "");
  assert.match(userContent, /CONVERSATION_CONTEXT_JSON/);
  assert.doesNotMatch(userContent, /VERIFIED_BUSINESS_PA_FACTS_JSON/);
  assert.doesNotMatch(userContent, /Fuel is customer responsibility/i);
  assert.doesNotMatch(userContent, /Lahore only/i);
  assert.match(userContent, /"status":"unsupported"/);
});

test("found saved owner answer remains answerable only via Result", async () => {
  const b = booking();
  const facts = {
    business: { name: "Prod" },
    booking: b,
    latestClosedMissingInfoAnswers: [
      {
        requestId: "mir-1",
        missingInfoType: "other",
        ownerAnswer: "Fuel is customer responsibility",
      },
    ],
  };
  const prompts = [];
  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "fuel policy kya hai?",
    frozenDecision: {
      action: "reply",
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: ["answer"],
        },
      ],
      informationalReplyDeferred: true,
    },
    factResolution: {
      capability: "answer_from_saved_owner_answer",
      status: "found",
      factAvailable: true,
      verifiedValue: "Fuel is customer responsibility",
      source: "latestClosedMissingInfoAnswers.ownerAnswer",
      items: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attribute: "answer",
          status: "found",
          verifiedValue: "Fuel is customer responsibility",
          source: "latestClosedMissingInfoAnswers.ownerAnswer",
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Fuel ka kharcha aapki zimmedari hai.",
                replySemantics: {
                  claims: [],
                  languageStyle: "roman_urdu",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(composed.ok, true);
  const userContent = String(prompts[0]?.messages?.[1]?.content || "");
  assert.doesNotMatch(
    userContent.split("FACT_RESOLUTION_JSON")[0],
    /Fuel is customer responsibility/i
  );
  assert.match(userContent, /FACT_RESOLUTION_JSON/);
  assert.match(
    userContent.split("FACT_RESOLUTION_JSON")[1],
    /Fuel is customer responsibility/
  );
});
