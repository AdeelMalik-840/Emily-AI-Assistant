/**
 * Post-confirm PA decide → validate/execute → compose architecture.
 * Scope: cloud_dm post_confirm_pa only.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  resolvePostConfirmBookingSelection,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  executePostConfirmBookingMutation,
  __resetPostConfirmBookingMutationIdempotencyForTests,
  POST_CONFIRM_BOOKING_MUTATION_INTENTS,
  POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS,
} = await import("../src/services/postConfirmBookingMutationExecutor.js");
const { composePostConfirmMutationCustomerReply } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);

const BUSINESS_ID = "arch-business";
const CUSTOMER_PHONE = "923009998877";

const CATALOG = [
  {
    id: "civic-2026",
    name: "Honda Civic 2026",
    displayLabel: "Honda Civic 2026",
    aliases: ["Civic"],
  },
  {
    id: "corolla-grey",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla",
    aliases: ["Corolla"],
  },
];

function multiFacts({ withFocus = true } = {}) {
  const civic = {
    id: "booking-civic",
    selectionIndex: 1,
    status: "approved",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026",
    durationDays: 5,
    totalAmount: 40000,
    dailyRate: 8000,
    availabilityRequestId: "avr-civic",
  };
  const corolla = {
    id: "booking-corolla",
    selectionIndex: 2,
    status: "approved",
    itemId: "corolla-grey",
    itemLabel: "Toyota Corolla",
    durationDays: 4,
    totalAmount: 20000,
    dailyRate: 5000,
    availabilityRequestId: "avr-corolla",
  };
  return {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: withFocus ? corolla : null,
    bookingCandidates: [civic, corolla],
    bookingFocus: withFocus
      ? {
          source: "latest_confirmed_linked_avr",
          confidence: "trusted",
          selectedBookingIndex: 2,
          selectedBookingId: "booking-corolla",
        }
      : null,
    activeBookings: [civic, corolla],
    known: {},
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: CATALOG,
      activeBookings: [civic, corolla],
      bookingExecutionVerified: true,
    },
    policy: {
      readOnly: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: !withFocus,
    },
  };
}

function singleBookingFacts() {
  const booking = {
    id: "booking-only",
    selectionIndex: 1,
    status: "approved",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026",
    durationDays: 3,
    totalAmount: 15000,
    dailyRate: 5000,
    availabilityRequestId: "avr-only",
  };
  return {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking,
    bookingCandidates: [booking],
    bookingFocus: null,
    activeBookings: [booking],
    known: { deliveryPolicy: "Delivery available in selected areas." },
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: CATALOG,
      activeBookings: [booking],
      bookingExecutionVerified: true,
      knownPolicies: {
        deliveryPolicy: "Delivery available in selected areas.",
      },
    },
    policy: { readOnly: true, doNotMutateBooking: true },
  };
}

function decisionJson(overrides = {}) {
  return JSON.stringify({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: true,
    customerReply: "",
    action: "request_booking_mutation",
    mutationIntent: "cancel_booking",
    mutationExecutionRequested: true,
    mutationExecutionStatus: "not_executed",
    bookingSelectionMode: "focused",
    selectedBookingIndex: null,
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

function infoDecisionJson(reply, overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    shouldReply: true,
    customerReply: reply,
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
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

function composeJson(reply) {
  return JSON.stringify({
    customerReply: reply,
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
  });
}

function completion(content) {
  return {
    choices: [{ message: { content } }],
  };
}

test("focused extend/cancel select trusted booking; all mutation intents share architecture", async () => {
  __resetPostConfirmBookingMutationIdempotencyForTests();
  assert.equal(POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS.length, 0);

  for (const mutationIntent of POST_CONFIRM_BOOKING_MUTATION_INTENTS) {
    let decideCalls = 0;
    let composeCalls = 0;
    let executorCalls = 0;
    const result = await handleCustomerBusinessPaInbound({
      db: {},
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: `${mutationIntent} kar do`,
      messageId: `msg-${mutationIntent}`,
      __resolveActiveCustomerBookingFactsFn: async () => ({
        ok: true,
        reason: "MATCHED",
        facts: multiFacts({ withFocus: true }),
      }),
      __executePostConfirmBookingMutationFn: (args) => {
        executorCalls += 1;
        return executePostConfirmBookingMutation(args);
      },
      __executeAvailabilityCustomerConfirmBookingFn: async () => {
        throw new Error("confirm must not run");
      },
      __executeAvailabilityCustomerDeclineFn: async () => {
        throw new Error("decline must not run");
      },
      __chatCompletionsCreateForTests: async (args) => {
        const prompt = String(args?.messages?.[1]?.content ?? "");
        if (prompt.includes("FROZEN_DECISION_JSON")) {
          composeCalls += 1;
          assert.match(prompt, new RegExp(`"mutationIntent":"${mutationIntent}"`));
          assert.match(prompt, /"status":"unsupported"/);
          // Composer must not be able to reinterpret frozen fields via schema —
          // only customerReply is consumed.
          return completion(
            composeJson(
              `${mutationIntent} abhi yahan auto complete nahi ho sakti, thori der baad follow up hoga.`
            )
          );
        }
        decideCalls += 1;
        return completion(
          decisionJson({
            mutationIntent,
            bookingSelectionMode: "focused",
          })
        );
      },
    });

    assert.equal(decideCalls, 1, mutationIntent);
    assert.equal(composeCalls, 1, mutationIntent);
    assert.equal(executorCalls, 1, mutationIntent);
    assert.equal(result.semanticDecisionCount, 1, mutationIntent);
    assert.equal(result.composeCalls, 1, mutationIntent);
    assert.equal(result.bookingId, "booking-corolla", mutationIntent);
    assert.equal(result.bookingSelectionMode, "focused", mutationIntent);
    assert.equal(result.selectedBookingIndex, 2, mutationIntent);
    assert.equal(result.mutationExecutionStatus, "unsupported", mutationIntent);
    assert.equal(result.mutationExecution?.changedData, false, mutationIntent);
    assert.equal(result.mutationExecution?.unsupported, true, mutationIntent);
  }
});

test("exactly one semantic decision; compose cannot reinterpret frozen decision", async () => {
  __resetPostConfirmBookingMutationIdempotencyForTests();
  let frozenSeen = null;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "extend kar do",
    messageId: "msg-freeze",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: multiFacts({ withFocus: true }),
    }),
    __composePostConfirmMutationCustomerReplyFn: async (args) => {
      frozenSeen = args.frozenDecision;
      // Attempt to smuggle a reinterpreted decision through compose output fields
      // that the composer must ignore.
      return {
        ok: true,
        reply: "Extend abhi auto nahi ho sakti.",
        source: "openai",
        frozenDecision: {
          ...args.frozenDecision,
          mutationIntent: "cancel_booking",
          action: "reply",
        },
      };
    },
    __chatCompletionsCreateForTests: async () =>
      completion(
        decisionJson({
          mutationIntent: "extend_booking",
          bookingSelectionMode: "focused",
        })
      ),
  });

  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.composeCalls, 1);
  assert.equal(frozenSeen?.mutationIntent, "extend_booking");
  assert.equal(frozenSeen?.action, "request_booking_mutation");
  assert.equal(result.mutationIntent, "extend_booking");
  assert.equal(result.decisionAction, "request_booking_mutation");
  assert.equal(result.reply, "Extend abhi auto nahi ho sakti.");
});

test("stale, ambiguous, or missing selection does not execute", async () => {
  __resetPostConfirmBookingMutationIdempotencyForTests();
  const facts = multiFacts({ withFocus: true });

  assert.equal(
    resolvePostConfirmBookingSelection(
      {
        action: "request_booking_mutation",
        bookingSelectionMode: "none",
        mutationIntent: "cancel_booking",
      },
      facts
    ).ok,
    false
  );
  assert.equal(
    resolvePostConfirmBookingSelection(
      {
        action: "request_booking_mutation",
        bookingSelectionMode: "clarification_required",
        mutationIntent: "extend_booking",
      },
      facts
    ).ok,
    false
  );
  assert.equal(
    resolvePostConfirmBookingSelection(
      {
        action: "request_booking_mutation",
        bookingSelectionMode: "candidate",
        selectedBookingIndex: 99,
        mutationIntent: "cancel_booking",
      },
      facts
    ).ok,
    false
  );
  assert.equal(
    resolvePostConfirmBookingSelection(
      {
        action: "request_booking_mutation",
        bookingSelectionMode: "focused",
        mutationIntent: "cancel_booking",
      },
      multiFacts({ withFocus: false })
    ).ok,
    false
  );

  let executorCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "cancel kar do",
    messageId: "msg-ambiguous",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts,
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      executorCalls += 1;
      return executePostConfirmBookingMutation(args);
    },
    __chatCompletionsCreateForTests: async () =>
      completion(
        decisionJson({
          customerReply: "Kaunsi booking — Civic ya Corolla?",
          action: "reply",
          mutationIntent: "none",
          mutationExecutionRequested: false,
          bookingSelectionMode: "clarification_required",
          situation: "new_question",
          conversationAct: "information_request",
          customerIntent: "ask_fact",
          customerIsAskingQuestion: true,
        })
      ),
  });
  assert.equal(executorCalls, 0);
  assert.equal(result.mutationExecutionStatus, "not_executed");
  assert.equal(result.composeCalls, 0);
  assert.equal(result.bookingSelectionMode, "clarification_required");
});

test("unsupported mutations do not change data; duplicate inbound cannot execute twice", async () => {
  __resetPostConfirmBookingMutationIdempotencyForTests();
  const facts = multiFacts({ withFocus: true });
  const decision = {
    action: "request_booking_mutation",
    mutationIntent: "cancel_booking",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 2,
    selectedBookingId: "booking-corolla",
  };
  const selected = facts.bookingCandidates[1];
  const first = executePostConfirmBookingMutation({
    businessId: BUSINESS_ID,
    messageId: "dup-1",
    decision,
    facts,
    selectedBooking: selected,
  });
  const second = executePostConfirmBookingMutation({
    businessId: BUSINESS_ID,
    messageId: "dup-1",
    decision,
    facts,
    selectedBooking: selected,
  });
  assert.equal(first.status, "unsupported");
  assert.equal(first.changedData, false);
  assert.equal(second.duplicateSuppressed, true);
  assert.equal(second.changedData, false);
  assert.equal(second.status, "unsupported");
});

test("information questions stay read-only and never call mutation executor", async () => {
  __resetPostConfirmBookingMutationIdempotencyForTests();
  let executorCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Delivery ho sakti hai?",
    messageId: "msg-info",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: singleBookingFacts(),
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      executorCalls += 1;
      return executePostConfirmBookingMutation(args);
    },
    __chatCompletionsCreateForTests: async () =>
      completion(
        infoDecisionJson("Haan, selected areas mein delivery available hai.", {
          groundedFacts: {
            itemId: "civic-2026",
            durationDays: 3,
            bookingStatus: "approved",
            bookingReference: null,
            totalAmount: null,
            dailyRate: null,
            advanceAmount: null,
            startDate: null,
            endDate: null,
            pickupTime: null,
            deliveryTime: null,
            policyClaims: ["deliveryPolicy"],
          },
        })
      ),
  });
  assert.equal(executorCalls, 0);
  assert.equal(result.composeCalls, 0);
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.mutationExecutionStatus, "not_executed");
  assert.equal(result.decisionAction, "reply");
  assert.match(result.reply, /delivery/i);
});

test("compose rejects success claims when execution did not succeed", async () => {
  let attempts = 0;
  const composed = await composePostConfirmMutationCustomerReply({
    facts: multiFacts({ withFocus: true }),
    userMessage: "cancel kar do",
    frozenDecision: {
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 2,
      selectedBookingId: "booking-corolla",
      conversationAct: "action_request",
      customerIntent: "ask_action",
      situation: "protected_action",
    },
    mutationExecution: {
      status: "unsupported",
      intent: "cancel_booking",
      reason: "MUTATION_EXECUTOR_UNSUPPORTED",
      bookingId: "booking-corolla",
      changedData: false,
      unsupported: true,
    },
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      if (attempts === 1) {
        return completion(composeJson("Booking has been cancelled."));
      }
      return completion(
        composeJson("Cancel abhi auto complete nahi ho sakti — follow-up chahiye.")
      );
    },
  });
  assert.equal(composed.ok, true);
  assert.equal(attempts, 2);
  assert.match(composed.reply, /nahi/);
  assert.equal(composed.frozenDecision.mutationIntent, "cancel_booking");
});

test("candidate selection still used for explicitly named other booking", async () => {
  const selection = resolvePostConfirmBookingSelection(
    {
      action: "request_booking_mutation",
      bookingSelectionMode: "candidate",
      selectedBookingIndex: 1,
      mutationIntent: "update_delivery",
    },
    multiFacts({ withFocus: true })
  );
  assert.equal(selection.ok, true);
  assert.equal(selection.mode, "candidate");
  assert.equal(selection.booking?.id, "booking-civic");
});
