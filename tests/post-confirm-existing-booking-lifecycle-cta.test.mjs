import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  composePostConfirmInformationalCustomerReply,
  derivePostConfirmInformationalLifecycleConstraint,
} = await import("../src/services/customerBusinessPaAiReply.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

function booking(overrides = {}) {
  return {
    id: "booking-corolla-confirmed",
    selectionIndex: 1,
    status: "approved",
    itemId: "corolla",
    itemLabel: "Toyota Corolla",
    durationDays: 3,
    totalAmount: 15000,
    dailyRate: 5000,
    ...overrides,
  };
}

function factsFor(selected = booking()) {
  return {
    businessId: "business-1",
    business: { name: "Emily Rentals" },
    booking: selected,
    bookingCandidates: [selected],
    activeBookings: [selected],
    known: {},
    replyGuardFacts: {},
    policy: { readOnly: true },
  };
}

function frozenFactDecision(overrides = {}) {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    targetContext: "CONFIRMED_BOOKING",
    targetId: "booking-corolla-confirmed",
    action: "reply",
    mutationIntent: "none",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    selectedBookingId: "booking-corolla-confirmed",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    situation: "new_question",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      { entity: "active_booking", concept: "price", attributes: ["total"] },
    ],
    informationalReplyDeferred: true,
    shouldReply: true,
    customerReply: "",
    ...overrides,
  };
}

function composeResponse(
  customerReply,
  customerInputRequested,
  requestedCustomerAction = customerInputRequested
    ? "booking_confirmation"
    : "none",
  coveredEvidenceKeys = ["active_booking.price.total"]
) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            coveredEvidenceKeys,
            customerInputRequested,
            requestedCustomerAction,
            replySemantics: {
              claims: ["quotation_verified"],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

test("confirmed booking total retries a model confirmation solicitation and accepts fact-only AI wording", async () => {
  const selected = booking();
  const replies = [
    composeResponse(
      "Total amount 15,000 PKR hai. Kya aap booking confirm karna chahte hain?",
      true
    ),
    composeResponse("Aapki booking ka total 15,000 PKR hai.", false),
  ];
  let calls = 0;
  let firstArgs = null;
  const result = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(selected),
    userMessage: "total kitna hai?",
    frozenDecision: frozenFactDecision(),
    factResolution: {
      status: "found",
      capability: "answer_from_active_booking",
      factAvailable: true,
      verifiedValue: 15000,
      items: [
        {
          entity: "active_booking",
          concept: "price",
          attribute: "total",
          status: "found",
          verifiedValue: 15000,
          source: "booking.totalAmount",
        },
      ],
    },
    selectedBooking: selected,
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      firstArgs ||= args;
      return replies[calls - 1];
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.match(result.reply, /15,000/);
  assert.doesNotMatch(result.reply, /\?/);
  const prompt = String(firstArgs?.messages?.[1]?.content ?? "");
  assert.match(prompt, /"bookingExists":true/);
  assert.match(prompt, /"bookingStatus":"approved"/);
  assert.match(prompt, /"bookingConfirmationSolicitationAllowed":false/);
});

test("confirmed booking another factual field remains natural and has no next-step question", async () => {
  const selected = booking();
  const result = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(selected),
    userMessage: "duration bata dein",
    frozenDecision: frozenFactDecision({
      evidenceNeeds: [
        { entity: "active_booking", concept: "duration", attributes: ["days"] },
      ],
    }),
    factResolution: {
      status: "found",
      capability: "answer_from_active_booking",
      factAvailable: true,
      verifiedValue: 3,
      items: [
        {
          entity: "active_booking",
          concept: "duration",
          attribute: "days",
          status: "found",
          verifiedValue: 3,
          source: "booking.durationDays",
        },
      ],
    },
    selectedBooking: selected,
    __chatCompletionsCreateForTests: async () =>
      composeResponse(
        "Aapki Corolla booking 3 din ki hai.",
        false,
        "none",
        ["active_booking.duration.days"]
      ),
  });

  assert.equal(result.ok, true);
  assert.match(result.reply, /3/);
  assert.doesNotMatch(result.reply, /\?/);
});

test("lifecycle constraint stays off for waiting-confirm and new-transaction scopes", async () => {
  const selected = booking();
  for (const turnScope of ["PENDING_AVAILABILITY_REFERENCE", "NEW_TRANSACTION"]) {
    const constraint = derivePostConfirmInformationalLifecycleConstraint({
      frozenDecision: {
        turnScope,
        action: "reply",
        mutationIntent: "none",
      },
      selectedBooking: selected,
      customerInputRequired: false,
    });
    assert.equal(constraint.bookingConfirmationSolicitationAllowed, true);
  }

  const result = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(selected),
    userMessage: "offer details",
    frozenDecision: frozenFactDecision({
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetContext: "PENDING_AVAILABILITY",
    }),
    factResolution: {
      status: "found",
      capability: "answer_from_active_booking",
      factAvailable: true,
      verifiedValue: 15000,
      items: [],
    },
    selectedBooking: selected,
    __chatCompletionsCreateForTests: async () =>
      composeResponse("Total 15,000 PKR hai. Kya aap proceed karna chahenge?", true),
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /\?/);
});

test("read-only confirmed-booking fact turn executes no confirmation or mutation", async () => {
  const selected = booking();
  const counters = { confirm: 0, decline: 0, mutation: 0 };
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "923001234567",
    messageText: "total kitna hai?",
    messageId: "wamid.read-only-total",
    preResolvedBookingFacts: { ok: true, facts: factsFor(selected) },
    __tryHandlePaMissingInfoCustomerClarificationFn: async () => ({
      handled: false,
    }),
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: frozenFactDecision(),
    }),
    __resolvePostConfirmRequestedFactFn: () => ({
      status: "found",
      capability: "answer_from_active_booking",
      factAvailable: true,
      verifiedValue: 15000,
      items: [],
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (params) => {
      assert.equal(params.frozenDecision.action, "reply");
      assert.equal(params.frozenDecision.mutationIntent, "none");
      return {
        ok: true,
        reply: "Aapki booking ka total 15,000 PKR hai.",
        source: "openai",
      };
    },
    __executeAvailabilityCustomerConfirmBookingFn: async () => {
      counters.confirm += 1;
      return { ok: false };
    },
    __executeAvailabilityCustomerDeclineFn: async () => {
      counters.decline += 1;
      return { ok: false };
    },
    __executePostConfirmBookingMutationFn: async () => {
      counters.mutation += 1;
      return { ok: false };
    },
  });

  assert.equal(result.decisionAction, "reply");
  assert.equal(result.mutationIntent, "none");
  assert.deepEqual(counters, { confirm: 0, decline: 0, mutation: 0 });
});
