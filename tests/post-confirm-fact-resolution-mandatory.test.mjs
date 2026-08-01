/**
 * Found-fact informational compose must not empty-out after guard mismatch.
 * Factual turns must defer via requestedInformation (no direct bypass).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { resolvePostConfirmRequestedFact } = await import(
  "../src/brain/facts/resolvePostConfirmRequestedFact.js"
);
const { composePostConfirmInformationalCustomerReply } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);
const {
  executePostConfirmPaLaneDecision,
  isPostConfirmFactualInformationalSemanticDecision,
  parsePostConfirmCustomerDmDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

function booking(overrides = {}) {
  return {
    id: "bk-1",
    selectionIndex: 1,
    customerSafeReference: "STONIC-PROD",
    status: "approved",
    itemId: "stonic-1",
    itemLabel: "Kia Stonic",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    startDate: "2026-08-05",
    endDate: "2026-08-09",
    pickupTime: "10:00 AM",
    deliveryTime: "6:00 PM",
    pickupLocation: null,
    deliveryAddress: null,
    ...overrides,
  };
}

/** Incomplete replyGuardFacts — reproduces live harness empty-compose defect. */
function factsWithIncompleteGuard(b) {
  return {
    businessId: "biz",
    business: {},
    booking: b,
    bookingCandidates: [b],
    bookingFocus: {
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    activeBookings: [b],
    known: {},
    replyGuardFacts: {
      activeBookings: [
        {
          itemId: b.itemId,
          itemLabel: b.itemLabel,
          durationDays: b.durationDays,
          bookingStatus: b.status,
          totalAmount: b.totalAmount,
          dailyRate: b.dailyRate,
        },
      ],
    },
    policy: { readOnly: true },
  };
}

function decisionJson(overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: null,
    shouldReply: true,
    customerReply: "Invented answer with 10am.",
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
    ...overrides,
  });
}

test("found pickup_time compose: non-empty guarded reply despite incomplete replyGuardFacts", async () => {
  const b = booking();
  const facts = factsWithIncompleteGuard(b);
  const factResolution = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_time",
    facts,
    selectedBooking: b,
  });
  assert.equal(factResolution.status, "found");

  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "kal pickup kitne baje hogi?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      requestedInformation: "pickup_time",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    factResolution,
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Pickup 10:00 AM hai.",
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
    }),
  });

  assert.equal(composed.ok, true);
  assert.match(composed.reply, /10:00\s*AM/i);
  assert.ok(composed.reply.trim().length > 0);
});

test("found delivery_time compose: non-empty guarded reply", async () => {
  const b = booking();
  const facts = factsWithIncompleteGuard(b);
  const factResolution = resolvePostConfirmRequestedFact({
    requestedInformation: "delivery_time",
    facts,
    selectedBooking: b,
  });
  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "delivery ka time kya hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      requestedInformation: "delivery_time",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    factResolution,
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Delivery 6:00 PM hai.",
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
    }),
  });
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /6:00\s*PM/i);
});

test("found booking_reference compose: non-empty guarded reply", async () => {
  const b = booking();
  const facts = factsWithIncompleteGuard(b);
  const factResolution = resolvePostConfirmRequestedFact({
    requestedInformation: "booking_reference",
    facts,
    selectedBooking: b,
  });
  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "booking reference kya hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      requestedInformation: "booking_reference",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    factResolution,
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Aapka booking reference STONIC-PROD hai.",
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
    }),
  });
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /STONIC-PROD/);
});

test("found booking_status compose does not hit pre_execution_booking_success_claim", async () => {
  const b = booking({ status: "approved" });
  const facts = factsWithIncompleteGuard(b);
  const factResolution = resolvePostConfirmRequestedFact({
    requestedInformation: "booking_status",
    facts,
    selectedBooking: b,
  });
  assert.equal(factResolution.status, "found");
  const composed = await composePostConfirmInformationalCustomerReply({
    facts,
    userMessage: "meri booking confirm hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      requestedInformation: "booking_status",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    factResolution,
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Haan, aapki booking confirm/approved hai.",
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
    }),
  });
  assert.equal(composed.ok, true, composed.reason);
  assert.match(composed.reply, /confirm|approved/i);
  assert.notEqual(composed.reason, "pre_execution_booking_success_claim");
});

test("ambiguous pickup resolves not_found — no Place A selection", () => {
  const b = booking({
    pickupLocation: "Place A",
    pickupDetails: "Place B",
    pickupTime: null,
    deliveryTime: null,
  });
  const r = resolvePostConfirmRequestedFact({
    requestedInformation: "pickup_location",
    selectedBooking: b,
    facts: {},
  });
  assert.equal(r.status, "not_found");
  assert.equal(r.verifiedValue, null);
});

test("factual ask without requestedInformation triggers correction then failure", async () => {
  const b = booking();
  const facts = factsWithIncompleteGuard(b);
  const calls = [];
  const result = await executePostConfirmPaLaneDecision({
    facts,
    userMessage: "pickup k lye kahan ana ho ga?",
    timeoutMs: 2000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      return {
        choices: [{ message: { content: decisionJson() }, finish_reason: "stop" }],
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "FACTUAL_TURN_PLAN_REQUIRED");
  assert.ok(calls.length >= 2);
  const correction = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correction, /capability|evidenceNeeds/i);
  assert.match(correction, /Do NOT answer the factual question yet/i);
});

test("factual ask with requestedInformation defers — no direct customerReply", async () => {
  const b = booking({ pickupLocation: null, pickupTime: null });
  const facts = factsWithIncompleteGuard(b);
  const result = await executePostConfirmPaLaneDecision({
    facts,
    userMessage: "pickup location kya hai?",
    timeoutMs: 2000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: decisionJson({
              requestedInformation: "pickup_location",
              customerReply: "",
            }),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.requestedInformation, "pickup_location");
});

test("social hello is not forced through factual requestedInformation gate", () => {
  const d = parsePostConfirmCustomerDmDecision(
    decisionJson({
      conversationAct: "chit_chat",
      customerIntent: "unclear",
      customerIsAskingQuestion: false,
      requestedInformation: null,
      customerReply: "Ji, bataiye?",
      situation: "unclear",
    })
  );
  assert.equal(isPostConfirmFactualInformationalSemanticDecision(d), false);
});

test("agent booking_status path uses resolver compose not direct guard path", async () => {
  const b = booking();
  const facts = factsWithIncompleteGuard(b);
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz",
    customerPhone: "923001234567",
    messageText: "meri booking confirm hai?",
    messageId: "m1",
    preResolvedBookingFacts: { ok: true, facts },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        situation: "new_question",
        conversationAct: "information_request",
        customerIntent: "ask_fact",
        customerIsAskingQuestion: true,
        capability: "answer_from_active_booking",
        evidenceNeeds: [
          {
            entity: "active_booking",
            concept: "status",
            attributes: ["value"],
          },
        ],
        requestedInformation: "booking_status",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: b.id,
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      assert.equal(p.factResolution?.status, "found");
      assert.equal(p.factResolution?.verifiedValue, "approved");
      return {
        ok: true,
        reply: "Haan, aapki booking approved/confirm hai.",
        source: "openai",
      };
    },
  });
  assert.equal(result.action, "business_pa_reply");
  assert.equal(result.factResolution?.requestedInformation, "booking_status");
  assert.match(result.reply, /confirm|approved/i);
  assert.equal(result.finalReplySource, "openai_post_confirm_pa_informational_compose");
});
