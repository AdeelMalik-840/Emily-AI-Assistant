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

function acknowledgementSilenceDecision() {
  return decision({
    situation: "acknowledgement_after_answer",
    conversationAct: "acknowledgement",
    customerIntent: "ack",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: false,
    customerReply: "",
    action: "silence",
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
}

function socialSilenceDecision(overrides = {}) {
  return decision({
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
    ...overrides,
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

test("live ack silence then empty required reply recovers with gated third same-Brain attempt", async () => {
  const { result, calls } = await runWithResponses(
    [
      acknowledgementSilenceDecision(),
      silenceInformationDecision(),
      decision(),
    ],
    { userMessage: "Kitny din k lye book ki h?" }
  );

  assert.equal(calls.length, 3);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 3);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.shouldReply, true);
  assert.ok(String(result.decision.customerReply || "").trim());
  assert.equal(result.decision.bookingSelectionMode, "focused");
  assert.equal(result.decision.selectedBookingIndex, 1);
  assert.equal(result.decision.selectedBookingId, "test-booking-stonic");
  // groundedFacts are stripped before return; duration must appear in the natural reply.
  assert.match(String(result.decision.customerReply || ""), /\b4\b/);
  assert.equal(result.decision.mutationIntent, "none");
  assert.equal(result.decision.mutationExecutionRequested, false);
  assert.notEqual(result.source, "technical_fallback");
  assert.doesNotMatch(
    String(result.decision.customerReply || ""),
    /Abhi ye detail confirm nahi hai/
  );

  const secondPrompt = String(calls[1]?.messages?.[1]?.content || "");
  const thirdPrompt = String(calls[2]?.messages?.[1]?.content || "");
  assert.match(secondPrompt, /CORRECTIVE REGENERATION/);
  assert.match(secondPrompt, /acknowledgement\/silence/);
  assert.match(thirdPrompt, /required reply after silence/);
  assert.match(thirdPrompt, /CURRENT_BOOKING_IN_SCOPE|Trusted focused booking identity/);
  assert.match(thirdPrompt, /test-stonic-item|"durationDays":4/);
  assert.doesNotMatch(thirdPrompt, /return\s+"Kia Stonic 4 din/i);
  assert.doesNotMatch(thirdPrompt, /hardcode|canned/i);
});

test("three required focused silences terminalize after gated extra recovery", async () => {
  const { result, calls } = await runWithResponses([
    silenceInformationDecision(),
    silenceInformationDecision(),
    silenceInformationDecision(),
  ]);

  assert.equal(calls.length, 3);
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "customer_reply_required_but_empty");
  assert.equal(result.retryable, false);
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 3);
  assert.equal(result.decision.customerReply, "");
  const thirdPrompt = String(calls[2]?.messages?.[1]?.content || "");
  assert.match(thirdPrompt, /required reply after silence/);
});

test("social silence remains a valid no-outbound result", async () => {
  const socialSilence = socialSilenceDecision();
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

for (const [label, message, act, intent, situation] of [
  ["Hello", "Hello", "chit_chat", "unclear", "acknowledgement_after_answer"],
  ["Thanks", "Thanks", "thanks", "thanks", "conversation_closing"],
  ["Okay", "Okay", "acknowledgement", "ack", "acknowledgement_after_answer"],
  ["Bye", "Bye", "chit_chat", "farewell", "conversation_closing"],
]) {
  test(`social "${label}" does not trigger trusted-focus required-reply extra attempt`, async () => {
    const social = socialSilenceDecision({
      situation,
      conversationAct: act,
      customerIntent: intent,
    });
    const { result, calls } = await runWithResponses([social, social, decision()], {
      userMessage: message,
    });
    assert.equal(calls.length, 2);
    assert.equal(result.ok, true);
    assert.equal(result.source, "openai");
    assert.equal(result.decision.action, "silence");
    assert.equal(result.decision.customerReply, "");
    const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
    assert.ok(
      prompts.every((p) => !/required reply after silence/.test(p)),
      "must not use trusted-focus required-reply extra correction for social turns"
    );
  });
}

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
    [mutation, mutation, decision()],
    { userMessage: "Cancel kar do" }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_booking_mutation_requires_candidate");
  assert.equal(result.retryable, false);
  const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
  assert.ok(prompts.every((p) => !/required reply after silence/.test(p)));
  assert.ok(prompts.every((p) => !/CORRECTIVE REGENERATION/.test(p)));
});

test("empty mutation rewritten to silence does not unlock trusted-focus required-reply extra attempt", async () => {
  const emptyMutation = decision({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: false,
    customerReply: "",
    action: "request_booking_mutation",
    mutationIntent: "cancel_booking",
    mutationExecutionRequested: true,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
  const { result, calls } = await runWithResponses(
    [emptyMutation, emptyMutation, decision()],
    { userMessage: "Cancel kar do" }
  );

  assert.ok(calls.length <= 2, "empty mutation must not unlock a third attempt");
  assert.notEqual(result.decision?.action, "reply");
  assert.notEqual(
    String(result.decision?.customerReply || ""),
    "Kia Stonic 4 din ke liye book hai."
  );
  const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
  assert.ok(
    prompts.every((p) => !/required reply after silence/.test(p)),
    "must not use trusted-focus required-reply extra correction for empty mutations"
  );
});

test("duration-extension mutation does not use trusted-focus required-reply extra attempt", async () => {
  const mutation = decision({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    shouldReply: true,
    customerReply: "Kaunsi booking extend karni hai?",
    action: "request_booking_mutation",
    mutationIntent: "extend_booking",
    mutationExecutionRequested: true,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
  const { result, calls } = await runWithResponses(
    [mutation, mutation, decision()],
    { userMessage: "2 din aur extend kar do" }
  );
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_booking_mutation_requires_candidate");
  const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
  assert.ok(prompts.every((p) => !/required reply after silence/.test(p)));
});

test("pending-availability confirm/decline do not use trusted-focus required-reply extra attempt", async () => {
  for (const [action, message, reply] of [
    [
      "confirm_pending_availability",
      "Haan book kar do",
      "Theek hai, main ye booking confirm kar deti hun.",
    ],
    [
      "decline_pending_availability",
      "Nahi chahiye",
      "Theek hai, main ye pending booking decline kar deti hun.",
    ],
  ]) {
    const pending = decision({
      situation: "protected_action",
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      shouldReply: true,
      customerReply: reply,
      action,
      bookingSelectionMode: "none",
      selectedBookingIndex: null,
      pendingAvailabilitySelectionIndex: 1,
      groundedFacts: groundedFacts(),
    });
    const facts = focusedFacts();
    facts.pendingAvailabilityRequests = [
      {
        selectionIndex: 1,
        itemLabel: "Honda Civic",
        requestedDuration: 3,
      },
    ];
    const { result, calls } = await runWithResponses(
      [pending, acknowledgementSilenceDecision(), decision()],
      { userMessage: message, facts }
    );
    assert.ok(calls.length <= 2, `${action} must not unlock a third attempt`);
    const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
    assert.ok(
      prompts.every((p) => !/required reply after silence/.test(p)),
      `${action} must not use required-reply extra correction`
    );
    assert.notEqual(result.reason, "TRUSTED_FOCUS_REQUIRED_REPLY_AFTER_SILENCE");
  }

  // Empty pending confirm can be rewritten to silence by anti-echo; still must not
  // unlock the trusted-focus required-reply extra attempt.
  const emptyPending = decision({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    shouldReply: false,
    customerReply: "",
    action: "confirm_pending_availability",
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    pendingAvailabilitySelectionIndex: 1,
    groundedFacts: groundedFacts(),
  });
  const facts = focusedFacts();
  facts.pendingAvailabilityRequests = [
    { selectionIndex: 1, itemLabel: "Honda Civic", requestedDuration: 3 },
  ];
  const emptyRun = await runWithResponses(
    [emptyPending, emptyPending, decision()],
    { userMessage: "Haan book kar do", facts }
  );
  assert.ok(emptyRun.calls.length <= 2);
  assert.ok(
    emptyRun.calls.every(
      (c) => !/required reply after silence/.test(String(c?.messages?.[1]?.content || ""))
    )
  );
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
