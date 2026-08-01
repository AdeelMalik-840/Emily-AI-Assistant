/**
 * Agent path: deferred informational → resolve → compose → one outbound.
 * Owner missing-info remains unwired.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { resolvePostConfirmRequestedFact } = await import(
  "../src/brain/facts/resolvePostConfirmRequestedFact.js"
);

function baseFacts(bookingOverrides = {}) {
  const booking = {
    id: "NYwhJnkhY9alSuuj9Wz1",
    selectionIndex: 1,
    status: "approved",
    approvalStage: "confirmed",
    itemLabel: "Suzuki Stonic",
    itemId: "stonic-1",
    durationDays: 2,
    startDate: "2026-08-02",
    endDate: "2026-08-04",
    totalAmount: 12000,
    dailyRate: 6000,
    customerSafeReference: "AVR-880",
    pickupTime: null,
    pickupLocation: null,
    deliveryAddress: null,
    deliveryTime: null,
    availabilityRequestId: "avr_880b7edeed14bef2f5ef0f34",
    ...bookingOverrides,
  };
  return {
    businessId: "biz-1",
    customerPhoneDigits: "923001234567",
    business: {},
    booking,
    bookingCandidates: [booking],
    bookingFocus: {
      selectedBookingIndex: 1,
      confidence: "trusted",
      source: "MATCHED_TRUSTED_FOCUS",
    },
    activeBookings: [],
    pendingAvailabilityRequests: [],
    availabilityRequest: null,
    known: {},
    openMissingInfoRequests: [],
    latestClosedMissingInfoAnswers: [],
    replyGuardFacts: { activeBookings: [] },
    policy: { readOnly: true },
  };
}

test("pickup location absent: resolve not_found → compose reply → no terminal failure", async () => {
  let resolveCalls = 0;
  let composeCalls = 0;

  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup k lye kahan ana ho ga?",
    messageId: "wamid.1",
    preResolvedBookingFacts: { ok: true, facts: baseFacts() },
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
            concept: "pickup",
            attributes: ["location"],
          },
        ],
        requestedInformation: "pickup_location",
        requestedInfoType: null,
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        actionParameters: {},
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: "NYwhJnkhY9alSuuj9Wz1",
        candidateGroundings: [],
      },
      silenceRecoveryAttempts: 0,
      contentSafetyAttempts: 1,
    }),
    __resolvePostConfirmRequestedFactFn: (p) => {
      resolveCalls += 1;
      assert.equal(p.requestedInformation, "pickup_location");
      assert.equal(p.selectedBooking?.id, "NYwhJnkhY9alSuuj9Wz1");
      return {
        requestedInformation: "pickup_location",
        status: "not_found",
        factAvailable: false,
        verifiedValue: null,
        source: null,
        missingInfoType: null,
      };
    },
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      composeCalls += 1;
      assert.equal(p.factResolution?.status, "not_found");
      assert.equal(p.frozenDecision?.requestedInformation, "pickup_location");
      return {
        ok: true,
        reply: "Pickup location abhi confirm nahi hui. Kahan se lena hai?",
        source: "openai",
        reason: null,
      };
    },
  });

  assert.equal(resolveCalls, 1);
  assert.equal(composeCalls, 1);
  assert.equal(result.handled, true);
  assert.equal(result.terminalFailure, false);
  assert.equal(result.action, "business_pa_reply");
  assert.match(result.reply, /confirm nahi/i);
  assert.equal(result.factResolution?.status, "not_found");
  assert.equal(result.missingInfoEscalated, false);
  assert.equal(result.composeCalls, 1);
  assert.equal(result.mutationExecution, null);
});

test("pickup location present: found value reaches compose", async () => {
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.2",
    preResolvedBookingFacts: {
      ok: true,
      facts: baseFacts({
        pickupLocation: "Johar Town office",
      }),
    },
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
            concept: "pickup",
            attributes: ["location"],
          },
        ],
        requestedInformation: "pickup_location",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: "NYwhJnkhY9alSuuj9Wz1",
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      assert.equal(p.factResolution?.status, "found");
      assert.equal(p.factResolution?.verifiedValue, "Johar Town office");
      return {
        ok: true,
        reply: "Pickup Johar Town office se hogi.",
        source: "openai",
      };
    },
  });

  assert.equal(result.action, "business_pa_reply");
  assert.match(result.reply, /Johar Town office/);
  assert.equal(result.factResolution?.status, "found");
});

test("social hello does not enter fact resolution compose", async () => {
  let resolveCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "hello?",
    messageId: "wamid.3",
    preResolvedBookingFacts: { ok: true, facts: baseFacts() },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        situation: "unclear",
        conversationAct: "chit_chat",
        customerIntent: "unclear",
        customerIsAskingQuestion: false,
        capability: "social",
        evidenceNeeds: [],
        requestedInformation: null,
        informationalReplyDeferred: false,
        shouldReply: true,
        customerReply: "Ji, bataiye?",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: "NYwhJnkhY9alSuuj9Wz1",
      },
    }),
    __resolvePostConfirmRequestedFactFn: () => {
      resolveCalls += 1;
      return { status: "unsupported" };
    },
  });

  assert.equal(resolveCalls, 0);
  assert.equal(result.reply, "Ji, bataiye?");
  assert.equal(result.finalReplySource, "openai_post_confirm_pa");
  assert.equal(result.composeCalls, 0);
});

test("multiple bookings: selected booking only — no cross leakage", async () => {
  const bookingA = {
    id: "bk-a",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Civic",
    pickupLocation: "Location A",
    durationDays: 1,
  };
  const bookingB = {
    id: "bk-b",
    selectionIndex: 2,
    status: "approved",
    itemLabel: "Corolla",
    pickupLocation: "Location B",
    durationDays: 5,
  };
  const facts = {
    ...baseFacts(),
    booking: bookingA,
    bookingCandidates: [bookingA, bookingB],
    bookingFocus: {
      selectedBookingIndex: 1,
      confidence: "trusted",
      source: "MATCHED_TRUSTED_FOCUS",
    },
  };

  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.4",
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
            concept: "pickup",
            attributes: ["location"],
          },
        ],
        requestedInformation: "pickup_location",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: "bk-a",
      },
    }),
    __resolvePostConfirmRequestedFactFn: ({ selectedBooking }) => {
      assert.equal(selectedBooking?.id, "bk-a");
      assert.notEqual(selectedBooking?.pickupLocation, "Location B");
      return {
        requestedInformation: "pickup_location",
        status: "found",
        factAvailable: true,
        verifiedValue: selectedBooking.pickupLocation,
        source: "booking.pickupLocation",
        missingInfoType: null,
      };
    },
    __composePostConfirmInformationalCustomerReplyFn: async (p) => ({
      ok: true,
      reply: `Pickup ${p.factResolution.verifiedValue} se hogi.`,
      source: "openai",
    }),
  });

  assert.match(result.reply, /Location A/);
  assert.doesNotMatch(result.reply, /Location B/);
});

test("not_found is not classified as technical decide failure", async () => {
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "driver mil skta hai?",
    messageId: "wamid.5",
    preResolvedBookingFacts: { ok: true, facts: baseFacts() },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        situation: "new_question",
        conversationAct: "information_request",
        customerIntent: "ask_fact",
        customerIsAskingQuestion: true,
        capability: "answer_from_business_profile",
        evidenceNeeds: [
          {
            entity: "business_profile",
            concept: "driver",
            attributes: ["policy"],
          },
        ],
        requestedInformation: "driver_policy",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
        selectedBookingId: "NYwhJnkhY9alSuuj9Wz1",
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: "Driver detail abhi confirm nahi hai.",
      source: "openai",
    }),
  });

  assert.equal(result.terminalFailure, false);
  assert.equal(result.retryable, false);
  assert.equal(result.factResolution?.status, "not_found");
  assert.ok(result.reply);
});

test("agent: explicit missing selectedBookingId does not answer from facts.booking", async () => {
  const bookingA = {
    id: "bk-a",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Kia Stonic",
    pickupLocation: "Location A SECRET",
    durationDays: 2,
    totalAmount: 12000,
    customerSafeReference: "REF-A",
    pickupTime: "10:00 AM",
  };
  const bookingB = {
    id: "bk-b",
    selectionIndex: 2,
    status: "approved",
    itemLabel: "Honda Civic",
    pickupLocation: "Location B",
    durationDays: 5,
    totalAmount: 40000,
    customerSafeReference: "REF-B",
  };
  let resolveArgs = null;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.missing-selection",
    preResolvedBookingFacts: {
      ok: true,
      facts: {
        ...baseFacts(),
        booking: bookingA,
        bookingCandidates: [bookingA],
        bookingFocus: {
          selectedBookingIndex: 1,
          confidence: "trusted",
          source: "MATCHED_TRUSTED_FOCUS",
        },
      },
    },
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
            concept: "pickup",
            attributes: ["location"],
          },
        ],
        requestedInformation: "pickup_location",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 2,
        selectedBookingId: "bk-b",
      },
    }),
    __resolvePostConfirmRequestedFactFn: (p) => {
      resolveArgs = p;
      return resolvePostConfirmRequestedFact(p);
    },
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      assert.equal(p.factResolution?.status, "unsupported");
      assert.equal(p.selectedBooking, null);
      assert.doesNotMatch(
        JSON.stringify(p.factResolution),
        /Location A SECRET|REF-A|12000|10:00/
      );
      return {
        ok: true,
        reply: "Yeh booking detail abhi clear nahi hai. Kaunsi booking?",
        source: "openai",
      };
    },
  });

  assert.equal(resolveArgs?.selectedBookingId, "bk-b");
  assert.equal(resolveArgs?.selectedBooking, null);
  assert.equal(result.factResolution?.status, "unsupported");
  assert.equal(result.factResolution?.selectionStatus, "explicit_unresolved");
  assert.doesNotMatch(result.reply, /Location A SECRET|REF-A|12000/);
  assert.equal(result.action, "business_pa_reply");
  assert.ok(result.reply);
});

test("agent: selected booking differing from facts.booking wins end-to-end", async () => {
  const bookingA = {
    id: "bk-a",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Stonic",
    pickupLocation: "Loc A",
    durationDays: 2,
  };
  const bookingB = {
    id: "bk-b",
    selectionIndex: 2,
    status: "approved",
    itemLabel: "Civic",
    pickupLocation: "Loc B ONLY",
    durationDays: 5,
  };
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.selected-wins",
    preResolvedBookingFacts: {
      ok: true,
      facts: {
        ...baseFacts(),
        booking: bookingA,
        bookingCandidates: [bookingA, bookingB],
      },
    },
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
            concept: "pickup",
            attributes: ["location"],
          },
        ],
        requestedInformation: "pickup_location",
        informationalReplyDeferred: true,
        shouldReply: true,
        customerReply: "",
        action: "reply",
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 2,
        selectedBookingId: "bk-b",
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      assert.equal(p.selectedBooking?.id, "bk-b");
      assert.equal(p.factResolution?.status, "found");
      assert.equal(p.factResolution?.verifiedValue, "Loc B ONLY");
      return {
        ok: true,
        reply: `Pickup ${p.factResolution.verifiedValue} se hogi.`,
        source: "openai",
      };
    },
  });

  assert.match(result.reply, /Loc B ONLY/);
  assert.doesNotMatch(result.reply, /Loc A/);
});
