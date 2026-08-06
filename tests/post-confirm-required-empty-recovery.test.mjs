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

function decision(overrides = {}) {
  const payload = {
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: "booking_duration",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "duration",
        attributes: ["days"],
      },
    ],
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
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "factKind")) {
    payload.factKind = inferTestOnlyFactKind(payload);
  }
  return JSON.stringify(payload);
}

function silenceInformationDecision() {
  return decision({
    shouldReply: false,
    customerReply: "",
    action: "silence",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    groundedFacts: groundedFacts(),
  });
}

/** Silence on a factual ask without a Turn Plan (contract violation). */
function silenceFactualWithoutTurnPlan() {
  return decision({
    capability: null,
    evidenceNeeds: [],
    requestedInformation: null,
    requestedInfoType: null,
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
    capability: "social",
    evidenceNeeds: [],
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
    capability: "social",
    evidenceNeeds: [],
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

test("silence with factual Turn Plan normalizes to deferred without recovery", async () => {
  const { result, calls } = await runWithResponses([silenceInformationDecision()]);

  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 0);
  assert.equal(result.contentSafetyAttempts, 1);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.shouldReply, true);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.bookingSelectionMode, "focused");
  assert.equal(result.decision.selectedBookingIndex, 1);
  assert.equal(result.decision.selectedBookingId, "test-booking-stonic");
  assert.equal(result.decision.capability, "answer_from_active_booking");
});

test("silence without Turn Plan corrects to deferred factual plan", async () => {
  const { result, calls } = await runWithResponses([
    silenceFactualWithoutTurnPlan(),
    decision({ customerReply: "" }),
  ]);

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_active_booking");
  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correctionPrompt, /CORRECTIVE REGENERATION/);
  assert.match(correctionPrompt, /Turn Plan|capability|evidenceNeeds/i);
  assert.doesNotMatch(correctionPrompt, /return\s+"Kia Stonic 4 din/i);
});

test("live ack silence then Turn Plan defers without third recovery", async () => {
  const { result, calls } = await runWithResponses(
    [acknowledgementSilenceDecision(), silenceInformationDecision()],
    { userMessage: "Kitny din k lye book ki h?" }
  );

  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.shouldReply, true);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.bookingSelectionMode, "focused");
  assert.equal(result.decision.selectedBookingIndex, 1);
  assert.equal(result.decision.selectedBookingId, "test-booking-stonic");
  assert.equal(result.decision.capability, "answer_from_active_booking");
  assert.equal(result.decision.mutationIntent, "none");
  assert.equal(result.decision.mutationExecutionRequested, false);
  assert.notEqual(result.source, "technical_fallback");

  const secondPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(secondPrompt, /CORRECTIVE REGENERATION/);
  assert.match(secondPrompt, /acknowledgement\/silence/);
  assert.doesNotMatch(secondPrompt, /return\s+"Kia Stonic 4 din/i);
  assert.doesNotMatch(secondPrompt, /hardcode|canned/i);
});

test("repeated factual silence without Turn Plan fails closed (no mute success)", async () => {
  const { result, calls } = await runWithResponses([
    silenceFactualWithoutTurnPlan(),
    silenceFactualWithoutTurnPlan(),
    silenceFactualWithoutTurnPlan(),
  ]);

  assert.ok(calls.length >= 2);
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "FACTUAL_TURN_PLAN_REQUIRED");
  assert.equal(result.retryable, false);
  assert.equal(result.decision.customerReply, "");
  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correctionPrompt, /Turn Plan|capability|evidenceNeeds/i);
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

test("non-mutation ask_action silence does not unlock trusted-focus required-reply extra attempt", async () => {
  const actionSilence = decision({
    situation: "protected_action",
    conversationAct: "action_request",
    customerIntent: "ask_action",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    shouldReply: false,
    customerReply: "",
    action: "silence",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    groundedFacts: groundedFacts(),
  });
  const { result, calls } = await runWithResponses(
    [
      acknowledgementSilenceDecision(),
      actionSilence,
      decision(),
    ],
    { userMessage: "Driver ke sath change karna hai" }
  );

  assert.ok(calls.length <= 2, "ask_action silence must not unlock a third attempt");
  const prompts = calls.map((c) => String(c?.messages?.[1]?.content || ""));
  assert.ok(
    prompts.every((p) => !/required reply after silence/.test(p)),
    "must not answer action requests from booking-fact recovery"
  );
  assert.notEqual(
    String(result.decision?.customerReply || ""),
    "Kia Stonic 4 din ke liye book hai."
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

test("invalid or malformed OpenAI output gets one informational recovery then retryable failure", async () => {
  const { result, calls } = await runWithResponses(["", "", ""]);

  assert.equal(calls.length, 3);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.retryable, true);
  assert.equal(result.silenceRecoveryAttempts, 0);
  assert.equal(result.contentSafetyAttempts, 3);
  assert.equal(result.usabilityClassification, "empty_content");
  const recoveryPrompt = String(calls[2]?.messages?.[1]?.content || "");
  assert.match(recoveryPrompt, /empty\/invalid output recovery/i);
  assert.match(recoveryPrompt, /Do NOT use action=silence/i);
});

test("empty/invalid then deferred factual recovery stays retryable", async () => {
  const { result, calls } = await runWithResponses([
    "",
    "{not-json",
    decision({
      requestedInformation: "delivery_policy",
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        {
          entity: "business_profile",
          concept: "delivery",
          attributes: ["policy"],
        },
      ],
      customerReply: "Delivery selected areas mein available hai.",
      groundedFacts: groundedFacts({
        itemId: STONIC_ITEM_ID,
        durationDays: 4,
        bookingStatus: "approved",
        policyClaims: [
          { key: "deliveryPolicy", value: "Delivery selected areas mein available hai." },
        ],
      }),
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }),
  ], {
    userMessage: "Delivery ho skti hai?",
    facts: {
      ...focusedFacts(),
      known: {
        deliveryPolicy: "Delivery selected areas mein available hai.",
      },
      replyGuardFacts: {
        ...focusedFacts().replyGuardFacts,
        knownPolicies: {
          deliveryPolicy: "Delivery selected areas mein available hai.",
        },
      },
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.retryable, true);
  assert.equal(result.usabilityClassification, "schema_or_parse_failure");
});
