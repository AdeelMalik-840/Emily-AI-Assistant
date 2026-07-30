import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  compactPostConfirmFactsForPrompt,
  buildPostConfirmVerifiedItemMismatchCorrection,
  resolveTrustedFocusedBookingIdentity,
  resolveTrustedFocusedBookingRow,
  finiteNumberOrNull,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

const BUSINESS_ID = "dm-continuity-business";
const CUSTOMER_PHONE = "923001234567";

const CATALOG = [
  {
    id: "civic-2026",
    name: "Honda Civic 2026",
    displayLabel: "Honda Civic 2026 Oriel",
    aliases: ["Civic", "Civic Oriel"],
  },
  {
    id: "corolla-grey",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla Metallic Grey",
    aliases: ["Corolla"],
  },
  {
    id: "stonic-white",
    name: "Kia Stonic",
    displayLabel: "Kia Stonic EX Plus 2021 White",
    aliases: ["Stonic", "Stonic EX Plus"],
  },
];

const STONIC_FOCUS_CATALOG = [
  ...CATALOG,
  {
    id: "kia_stonic_ex_plus_2021_white_color_1df55684",
    name: "Kia Stonic EX Plus 2021 (White Color)",
    displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
    aliases: ["Stonic", "Kia Stonic", "Stonic EX Plus"],
  },
  {
    id: "toyota_corolla_metallic_grey_0e2cd610",
    name: "Toyota corolla (Metallic Grey)",
    displayLabel: "Toyota corolla (Metallic Grey)",
    aliases: ["Toyota corolla Metallic Grey"],
  },
];

function confirmedFacts(overrides = {}) {
  const booking = {
    id: "internal-booking-id",
    customerSafeReference: "CUST-77",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026",
    durationDays: 3,
    startDate: "2026-08-01",
    endDate: "2026-08-04",
    pickupTime: "10:00 AM",
    totalAmount: 15000,
    dailyRate: 5000,
    availabilityRequestId: "internal-avr-id",
    ...overrides.booking,
  };
  const known = {
    totalAmount: 15000,
    dailyRate: 5000,
    durationDays: 3,
    itemLabel: "Honda Civic 2026",
    documentsPolicy: "Original CNIC and driving licence are required.",
    paymentPolicy: "Payment is due at pickup.",
    ...overrides.known,
  };
  return {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking,
    activeBookings: [],
    availabilityRequest: {
      id: "internal-avr-id",
      itemLabel: booking.itemLabel,
      requestedDuration: booking.durationDays,
      status: "approved",
      priceQuote: { total: booking.totalAmount, dailyRate: booking.dailyRate },
    },
    known,
    openMissingInfoRequests: [],
    latestClosedMissingInfoAnswers: [],
    replyGuardFacts: {
      bookingExecutionVerified: true,
      itemId: booking.itemId,
      itemLabel: booking.itemLabel,
      durationDays: booking.durationDays,
      bookingStatus: booking.status,
      bookingReference: booking.customerSafeReference,
      totalAmount: booking.totalAmount,
      dailyRate: booking.dailyRate,
      startDate: booking.startDate,
      endDate: booking.endDate,
      pickupTime: booking.pickupTime,
      knownPolicies: {
        documentsPolicy: known.documentsPolicy,
        paymentPolicy: known.paymentPolicy,
      },
      catalogItems: CATALOG,
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
    ...overrides,
  };
}

function decisionJson(reply, overrides = {}) {
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

function completion(content) {
  return { choices: [{ message: { content } }] };
}

async function runOwnedTurn({
  message,
  facts = confirmedFacts(),
  responses,
  history = "User: meri booking confirm ho gayi?\nAssistant: Ji, confirm hai.",
  counters = {},
  executors = {},
}) {
  let responseIndex = 0;
  return handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: message,
    conversationHistory: history,
    sendWhatsAppMessageFn: async () => {
      counters.customerSends = (counters.customerSends || 0) + 1;
      return { ok: true };
    },
    __resolveActiveCustomerBookingFactsFn: async () => {
      counters.factHydrations = (counters.factHydrations || 0) + 1;
      return { ok: true, reason: "MATCHED", facts };
    },
    __executeAvailabilityCustomerConfirmBookingFn:
      executors.confirm ??
      (async () => {
        counters.unexpectedConfirmExecutions =
          (counters.unexpectedConfirmExecutions || 0) + 1;
        return { ok: false, reason: "UNEXPECTED_CONFIRM" };
      }),
    __executeAvailabilityCustomerDeclineFn:
      executors.decline ??
      (async () => {
        counters.unexpectedDeclineExecutions =
          (counters.unexpectedDeclineExecutions || 0) + 1;
        return { ok: false, reason: "UNEXPECTED_DECLINE" };
      }),
    __createOrGetOpenPaMissingInfoRequestFn: async () => {
      counters.missingInfoCreates = (counters.missingInfoCreates || 0) + 1;
      return { ok: false };
    },
    __sendPaMissingInfoOwnerNotificationFn: async () => {
      counters.ownerNotifications = (counters.ownerNotifications || 0) + 1;
      return { ok: false };
    },
    __chatCompletionsCreateForTests: async (args) => {
      counters.openaiCalls = (counters.openaiCalls || 0) + 1;
      counters.lastOpenAiArgs = args;
      counters.openaiPrompts = counters.openaiPrompts || [];
      counters.openaiPrompts.push(String(args?.messages?.[1]?.content ?? ""));
      const next = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return completion(next);
    },
  });
}

test("exact duration question is owned by post_confirm_pa and returns grounded OpenAI wording unchanged", async () => {
  const counters = {};
  const reply = "Honda Civic 2026 aap ke liye 3 din book hai.";
  const result = await runOwnedTurn({
    message: "kitny din k lye book ki h?",
    responses: [
      decisionJson(reply, {
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: 3,
          bookingStatus: null,
          bookingReference: null,
          totalAmount: null,
          dailyRate: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      }),
    ],
    counters,
  });

  assert.equal(counters.factHydrations, 1);
  assert.equal(counters.openaiCalls, 1);
  assert.equal(result.handled, true);
  assert.equal(result.reply, reply);
  assert.equal(result.finalReplySource, "openai_post_confirm_pa");
  assert.equal(result.openaiUsed, true);
  assert.equal(result.sentReply, false);
  assert.equal(counters.customerSends || 0, 0);
  assert.equal(counters.missingInfoCreates || 0, 0);
  assert.equal(counters.ownerNotifications || 0, 0);
  const prompt = String(counters.lastOpenAiArgs.messages[1].content);
  assert.match(prompt, /kitny din k lye book ki h/);
  assert.match(prompt, /Honda Civic 2026/);
  assert.match(prompt, /"durationDays":3/);
  assert.doesNotMatch(
    prompt,
    /internal-booking-id|internal-avr-id|dm-continuity-business|923001234567/
  );
});

test("varied post-booking questions all use the same OpenAI lane without side effects", async () => {
  const cases = [
    ["konsi gari book hai?", "Honda Civic 2026 book hai."],
    ["kitne din?", "Booking 3 din ki hai."],
    ["total rent?", "The total rent is 15000 PKR."],
    ["booking status?", "The booking is approved."],
    ["pickup kab hai?", "Pickup 10:00 AM hai."],
    ["documents kya chahye?", "Original CNIC aur driving licence required hain."],
    ["reference kya hai?", "Booking reference CUST-77 hai."],
    ["payment policy?", "Payment is due at pickup."],
    ["extend karni hai", "Extension request ke liye nayi duration bata dein."],
    ["dates change karni hain", "Nayi dates bata dein taa ke request validate ho sake."],
    ["woh wali detail?", "Aap kis booking detail ki baat kar rahe hain?"],
  ];

  for (const [message, reply] of cases) {
    const counters = {};
    const englishReply = ["total rent?", "booking status?", "payment policy?"].includes(
      message
    );
    const mutation = message.includes("extend")
      ? "extend_booking"
      : message.includes("dates change")
        ? "change_dates"
        : "none";
    const result = await runOwnedTurn({
      message,
      responses: [
        decisionJson(reply, {
          ...(englishReply
            ? {
                replySemantics: {
                  claims: [],
                  languageStyle: "english",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }
            : {}),
          ...(mutation !== "none"
            ? {
                situation: "protected_action",
                conversationAct: "action_request",
                customerIntent: "ask_action",
                customerIsAskingQuestion: false,
                action: "request_booking_mutation",
                mutationIntent: mutation,
              }
            : {}),
        }),
      ],
      counters,
    });
    assert.equal(result.handled, true, message);
    assert.equal(result.reply, reply, message);
    assert.equal(result.finalReplySource, "openai_post_confirm_pa", message);
    assert.equal(counters.openaiCalls, 1, message);
    assert.equal(counters.customerSends || 0, 0, message);
    assert.equal(counters.missingInfoCreates || 0, 0, message);
    assert.equal(counters.ownerNotifications || 0, 0, message);
    assert.match(
      String(counters.lastOpenAiArgs.messages[1].content),
      /RECENT_CONVERSATION/,
      message
    );
  }
});

test("wrong item/duration retries once in the same OpenAI lane, then delivers corrected wording", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "kitny din k lye book ki h?",
    responses: [
      decisionJson("Toyota Corolla 2 din ke liye book hai.", {
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 2,
          bookingStatus: null,
          bookingReference: null,
          totalAmount: null,
          dailyRate: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      }),
      decisionJson("Honda Civic 2026 3 din ke liye book hai.", {
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: 3,
          bookingStatus: null,
          bookingReference: null,
          totalAmount: null,
          dailyRate: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      }),
    ],
    counters,
  });

  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.reply, "Honda Civic 2026 3 din ke liye book hai.");
  assert.equal(result.finalReplySource, "openai_post_confirm_pa");
  assert.equal(counters.customerSends || 0, 0);
});

test("overlong OpenAI output regenerates once in the same lane without truncation", async () => {
  const counters = {};
  const overlong = `Honda Civic 2026 3 din ke liye book hai. ${"detail ".repeat(
    180
  )}`;
  const corrected = "Honda Civic 2026 3 din ke liye book hai.";
  const result = await runOwnedTurn({
    message: "meri booking ki detail?",
    responses: [decisionJson(overlong), decisionJson(corrected)],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.reply, corrected);
  assert.notEqual(result.reply, overlong.slice(0, 500));
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("unverified booking mutations cannot be claimed complete", async () => {
  const cases = [
    ["cancel_booking", "Booking has been cancelled."],
    ["extend_booking", "Booking has been extended."],
    ["change_dates", "Booking dates have been changed."],
    ["change_duration", "Booking duration has been changed."],
    ["change_item", "Booking vehicle has been changed."],
    ["cancel_booking", "Cancel complete hai"],
    ["extend_booking", "Do din aur add ho gaye hain"],
    ["change_duration", "Duration barha di gayi hai"],
    ["change_item", "Everything has been updated"],
    ["cancel_booking", "Request complete ho gayi hai"],
    ["change_dates", "Change apply ho gaya hai"],
    ["change_dates", "Booking update ho chuki hai"],
    ["change_pickup", "Pickup shift complete hai"],
    ["change_item", "Car replace ho gayi hai"],
    ["change_dates", "Dates modify kar di gayi hain"],
  ];
  for (const [mutationIntent, falseCompletion] of cases) {
    const counters = {};
    const safeReply =
      "Aap ki request samajh aa gayi hai, lekin yeh change abhi complete nahi hua.";
    const mutationShape = {
      situation: "protected_action",
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      action: "request_booking_mutation",
      mutationIntent,
      mutationExecutionRequested: true,
      mutationExecutionStatus: "succeeded",
    };
    const result = await runOwnedTurn({
      message: "meri booking update kar dein",
      responses: [
        decisionJson(falseCompletion, mutationShape),
        decisionJson(safeReply, mutationShape),
      ],
      counters,
    });
    assert.equal(counters.openaiCalls, 2, mutationIntent);
    assert.equal(result.reply, safeReply, mutationIntent);
    assert.equal(result.mutationExecutionStatus, "not_executed", mutationIntent);
    assert.equal(counters.unexpectedConfirmExecutions || 0, 0, mutationIntent);
    assert.equal(counters.unexpectedDeclineExecutions || 0, 0, mutationIntent);
  }
});

test("active booking plus pending availability action stays in one OpenAI lane and executes once", async () => {
  const counters = {};
  const facts = confirmedFacts({
    pendingAvailabilityRequests: [
      {
        request: {
          requestId: "avr-pending-stonic",
          businessId: BUSINESS_ID,
          customerPhone: CUSTOMER_PHONE,
          itemId: "stonic-white",
          itemLabel: "Kia Stonic EX Plus 2021 White",
          requestedDuration: 3,
          status: "approved",
          customerConfirmationStatus: "waiting_confirm",
        },
        requestId: "avr-pending-stonic",
        selectionIndex: 1,
        itemId: "stonic-white",
        itemLabel: "Kia Stonic EX Plus 2021 White",
        requestedDuration: 3,
        priceQuote: { total: 16500, dailyRate: 5500 },
        status: "approved",
        customerConfirmationStatus: "waiting_confirm",
      },
    ],
  });
  const result = await runOwnedTurn({
    message: "Stonic wali request confirm kar do",
    facts,
    responses: [
      decisionJson("Ji, Stonic wali request samajh aa gayi.", {
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        action: "confirm_pending_availability",
        pendingAvailabilitySelectionIndex: 1,
      }),
      decisionJson("Kia Stonic 3 din ke liye book ho gayi.", {
        groundedFacts: {
          itemId: "stonic-white",
          durationDays: 3,
          bookingStatus: "approved",
          bookingReference: null,
          totalAmount: 16500,
          dailyRate: 5500,
          advanceAmount: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      }),
    ],
    counters,
    executors: {
      confirm: async ({ brainAuthorizedConfirm, request }) => {
        counters.confirmExecutions = (counters.confirmExecutions || 0) + 1;
        assert.equal(brainAuthorizedConfirm, true);
        assert.equal(request.requestId, "avr-pending-stonic");
        return { ok: true, bookingId: "booking-stonic" };
      },
    },
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(counters.confirmExecutions, 1);
  assert.equal(result.reply, "Kia Stonic 3 din ke liye book ho gayi.");
  assert.equal(result.finalReplySource, "openai_post_confirm_pa");
});

test("two unsupported OpenAI replies fail closed and become terminal (not Cloud-retryable)", async () => {
  const counters = {};
  const wrong = decisionJson("Toyota Corolla 2 din ke liye book hai.", {
    groundedFacts: {
      itemId: "corolla-grey",
      durationDays: 2,
      bookingStatus: null,
      bookingReference: null,
      totalAmount: null,
      dailyRate: null,
      startDate: null,
      endDate: null,
      pickupTime: null,
      deliveryTime: null,
      policyClaims: [],
    },
  });
  const result = await runOwnedTurn({
    message: "kitny din k lye book ki h?",
    responses: [wrong, wrong],
    counters,
  });

  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.handled, true);
  assert.equal(result.retryable, false);
  assert.equal(result.terminalFailure, true);
  assert.equal(result.action, "business_pa_terminal_model_failure");
  assert.equal(result.reply, "");
  assert.equal(result.sentReply, false);
  assert.equal(counters.customerSends || 0, 0);
});

test("multiple active bookings stay in the same OpenAI lane and expose only safe candidate facts", async () => {
  const counters = {};
  const facts = {
    business: { name: "Emily Rentals" },
    booking: null,
    activeBookings: [
      {
        customerSafeReference: "REF-A",
        status: "approved",
        itemLabel: "Honda Civic 2026",
        durationDays: 3,
      },
      {
        customerSafeReference: "REF-B",
        status: "approved",
        itemLabel: "Toyota Corolla",
        durationDays: 2,
      },
    ],
    known: {},
    replyGuardFacts: { catalogItems: CATALOG },
    policy: {
      readOnly: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: true,
    },
  };
  const reply = "Civic REF-A ya Corolla REF-B—kis booking ki detail chahiye?";
  const result = await runOwnedTurn({
    message: "booking kitny din ki hai?",
    facts,
    responses: [decisionJson(reply)],
    counters,
  });
  assert.equal(result.reply, reply);
  assert.equal(result.bookingId, null);
  assert.equal(counters.openaiCalls, 1);
  const prompt = String(counters.lastOpenAiArgs.messages[1].content);
  assert.match(prompt, /REF-A/);
  assert.match(prompt, /REF-B/);
  assert.doesNotMatch(prompt, /internal-booking-id|customerPhoneDigits|businessId/);
});

function trustedMultiBookingFacts({ withFocus = true } = {}) {
  const civic = {
    id: "booking-civic",
    selectionIndex: 1,
    customerSafeReference: "CIVIC-5",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
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
    customerSafeReference: "COROLLA-4",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "corolla-grey",
    itemLabel: "Toyota Corolla Metallic Grey",
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
    activeBookings: [civic, corolla].map(
      ({ id: _id, itemId: _itemId, availabilityRequestId: _avr, ...safe }) =>
        safe
    ),
    known: {},
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: CATALOG,
      activeBookings: [civic, corolla],
    },
    policy: {
      readOnly: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: !withFocus,
    },
  };
}

test("trusted latest-confirmed focus answers generic duration from Corolla only", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson("Toyota Corolla 4 din ke liye book hai.", {
        bookingSelectionMode: "focused",
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 4,
          bookingStatus: "approved",
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
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 1);
  assert.equal(result.reply, "Toyota Corolla 4 din ke liye book hai.");
  assert.equal(result.bookingId, "booking-corolla");
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.selectedBookingIndex, 2);
  const prompt = String(counters.lastOpenAiArgs.messages[1].content);
  assert.match(prompt, /"selectedBookingIndex":2/);
  assert.match(prompt, /"bookingId":"booking-corolla"/);
  assert.match(prompt, /"itemId":"corolla-grey"/);
  assert.match(prompt, /CURRENT_BOOKING_IN_SCOPE/);
  assert.match(prompt, /OUT_OF_SCOPE_CONTEXT_ONLY/);
  assert.match(prompt, /Honda Civic 2026/);
  assert.doesNotMatch(prompt, /"totalAmount":40000/);
  assert.doesNotMatch(prompt, /"itemId":"civic-2026"/);
});

test("OpenAI can explicitly select Civic instead of the trusted Corolla focus", async () => {
  const result = await runOwnedTurn({
    message: "Civic wali kitny din ki hai?",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson("Honda Civic 2026 5 din ke liye book hai.", {
        bookingSelectionMode: "candidate",
        selectedBookingIndex: 1,
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: 5,
          bookingStatus: "approved",
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
      }),
    ],
  });
  assert.equal(result.bookingId, "booking-civic");
  assert.equal(result.selectedBookingIndex, 1);
  assert.equal(result.reply, "Honda Civic 2026 5 din ke liye book hai.");
});

test("all_candidates grounds Civic and Corolla claims against their exact bookings", async () => {
  const reply =
    "Honda Civic 2026 5 din ke liye hai. Toyota Corolla Metallic Grey 4 din ke liye hai.";
  const result = await runOwnedTurn({
    message: "Meri sari bookings batao",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson(reply, {
        bookingSelectionMode: "all_candidates",
        candidateGroundings: [
          {
            selectionIndex: 1,
            replySegment: "Honda Civic 2026 5 din ke liye hai.",
            groundedFacts: {
              itemId: "civic-2026",
              durationDays: 5,
              bookingStatus: "approved",
              bookingReference: "CIVIC-5",
              totalAmount: 40000,
              dailyRate: 8000,
              advanceAmount: null,
              startDate: null,
              endDate: null,
              pickupTime: null,
              deliveryTime: null,
              policyClaims: [],
            },
          },
          {
            selectionIndex: 2,
            replySegment:
              "Toyota Corolla Metallic Grey 4 din ke liye hai.",
            groundedFacts: {
              itemId: "corolla-grey",
              durationDays: 4,
              bookingStatus: "approved",
              bookingReference: "COROLLA-4",
              totalAmount: 20000,
              dailyRate: 5000,
              advanceAmount: null,
              startDate: null,
              endDate: null,
              pickupTime: null,
              deliveryTime: null,
              policyClaims: [],
            },
          },
        ],
      }),
    ],
  });
  assert.equal(result.reply, reply);
  assert.equal(result.bookingSelectionMode, "all_candidates");
  assert.equal(result.bookingId, null);
});

test("all_candidates rejects cross-booking duration swaps and regenerates once", async () => {
  const counters = {};
  const wrong =
    "Honda Civic 2026 4 din ke liye hai. Toyota Corolla Metallic Grey 5 din ke liye hai.";
  const corrected =
    "Honda Civic 2026 5 din ke liye hai. Toyota Corolla Metallic Grey 4 din ke liye hai.";
  const grounding = (civicDays, corollaDays, reply) => {
    const [civicSegment, corollaTail] = reply.split(" Toyota");
    return [
      {
        selectionIndex: 1,
        replySegment: civicSegment,
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: civicDays,
          bookingStatus: "approved",
          bookingReference: "CIVIC-5",
          totalAmount: 40000,
          dailyRate: 8000,
          advanceAmount: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      },
      {
        selectionIndex: 2,
        replySegment: `Toyota${corollaTail}`,
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: corollaDays,
          bookingStatus: "approved",
          bookingReference: "COROLLA-4",
          totalAmount: 20000,
          dailyRate: 5000,
          advanceAmount: null,
          startDate: null,
          endDate: null,
          pickupTime: null,
          deliveryTime: null,
          policyClaims: [],
        },
      },
    ];
  };
  const result = await runOwnedTurn({
    message: "Civic aur Corolla dono kitny din ki hain?",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson(wrong, {
        bookingSelectionMode: "all_candidates",
        candidateGroundings: grounding(4, 5, wrong),
      }),
      decisionJson(corrected, {
        bookingSelectionMode: "all_candidates",
        candidateGroundings: grounding(5, 4, corrected),
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.reply, corrected);
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("customer-indistinguishable bookings cannot be selected by index", async () => {
  const facts = trustedMultiBookingFacts();
  const original = {
    ...facts.bookingCandidates[1],
    selectionIndex: 2,
    customerSafeReference: null,
  };
  const identical = {
    ...original,
    id: "booking-corolla-second",
    selectionIndex: 1,
  };
  facts.bookingCandidates = [identical, original];
  facts.activeBookings = facts.bookingCandidates.map(
    ({ id: _id, itemId: _itemId, availabilityRequestId: _avr, ...safe }) =>
      safe
  );
  facts.booking = original;
  facts.bookingFocus = {
    source: "latest_confirmed_linked_avr",
    confidence: "trusted",
    selectedBookingIndex: 2,
    selectedBookingId: original.id,
  };
  facts.replyGuardFacts.activeBookings = facts.bookingCandidates;

  const counters = {};
  const result = await runOwnedTurn({
    message: "Corolla booking kitny din ki hai?",
    facts,
    responses: [
      decisionJson("Toyota Corolla Metallic Grey 4 din ki hai.", {
        bookingSelectionMode: "candidate",
        selectedBookingIndex: 1,
      }),
      decisionJson(
        "Aapki do milti-julti bookings hain. Kis booking ki baat hai, koi pehchan wali tafseel bata dein.",
        {
          bookingSelectionMode: "clarification_required",
        }
      ),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.ok(result.reply, JSON.stringify(result));
  assert.match(result.reply, /do milti-julti bookings/i);
  assert.equal(result.bookingId, null);
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("selected Corolla rejects Civic duration and regenerates without repeating actions", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson("Toyota Corolla 5 din ke liye book hai.", {
        bookingSelectionMode: "focused",
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 5,
          bookingStatus: "approved",
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
      }),
      decisionJson("Toyota Corolla 4 din ke liye book hai.", {
        bookingSelectionMode: "focused",
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 4,
          bookingStatus: "approved",
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
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.reply, "Toyota Corolla 4 din ke liye book hai.");
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("no trusted focus asks OpenAI clarification and generic mutation cannot select implicitly", async () => {
  const noFocus = trustedMultiBookingFacts({ withFocus: false });
  const clarified = await runOwnedTurn({
    message: "Booking kitny din ki hai?",
    facts: noFocus,
    responses: [
      decisionJson("Civic wali ya Corolla wali booking?", {
        bookingSelectionMode: "clarification_required",
      }),
    ],
  });
  assert.equal(clarified.bookingId, null);
  assert.equal(clarified.reply, "Civic wali ya Corolla wali booking?");

  const counters = {};
  const mutation = await runOwnedTurn({
    message: "Cancel kar do",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson("Corolla cancel kar deta hun.", {
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        action: "request_booking_mutation",
        mutationIntent: "cancel_booking",
        bookingSelectionMode: "focused",
      }),
      decisionJson("Civic wali ya Corolla wali booking cancel karni hai?", {
        bookingSelectionMode: "clarification_required",
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(mutation.decisionAction, "reply");
  assert.equal(
    mutation.reply,
    "Civic wali ya Corolla wali booking cancel karni hai?"
  );
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("explicit multi-booking mutation maps to the exact candidate but remains unexecuted", async () => {
  const result = await runOwnedTurn({
    message: "Civic wali cancel kar do",
    facts: trustedMultiBookingFacts(),
    responses: [
      decisionJson("Civic cancellation request abhi execute nahi hui.", {
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        action: "request_booking_mutation",
        mutationIntent: "cancel_booking",
        bookingSelectionMode: "candidate",
        selectedBookingIndex: 1,
      }),
    ],
  });
  assert.equal(result.bookingId, "booking-civic");
  assert.equal(result.mutationExecutionStatus, "not_executed");
  assert.equal(result.selectedBookingIndex, 1);
});

test("no active booking leaves the existing general path unclaimed", async () => {
  let openaiCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "price?",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: false,
      reason: "NO_ACTIVE_BOOKING",
      facts: null,
    }),
    __chatCompletionsCreateForTests: async () => {
      openaiCalls += 1;
      return completion(decisionJson("should not run"));
    },
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "NO_ACTIVE_BOOKING");
  assert.equal(openaiCalls, 0);
});

test("trusted focus + ask_fact + bookingSelectionMode none auto-selects focused booking", async () => {
  const counters = {};
  const reply = "Toyota Corolla 4 din ke liye book hai.";
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedMultiBookingFacts({ withFocus: true }),
    responses: [
      decisionJson(reply, {
        bookingSelectionMode: "none",
        selectedBookingIndex: null,
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 4,
          bookingStatus: "approved",
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
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 1);
  assert.equal(result.reply, reply);
  assert.equal(result.bookingId, "booking-corolla");
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.selectedBookingIndex, 2);
  assert.equal(result.retryable, false);
  assert.equal(result.terminalFailure, false);
});

test("trusted focus auto-select covers rent, pickup, and status ask_fact with mode none", async () => {
  const cases = [
    [
      "4 din ka total rent kitna hoga?",
      "Corolla ka total rent 20000 PKR hai.",
      { totalAmount: 20000, itemId: "corolla-grey", durationDays: 4 },
    ],
    [
      "pickup ho jye ga?",
      "Toyota Corolla Metallic Grey booking approved hai; pickup detail abhi confirm nahi.",
      { bookingStatus: "approved", itemId: "corolla-grey", durationDays: 4 },
    ],
    [
      "booking status?",
      "Booking approved hai.",
      { bookingStatus: "approved", itemId: "corolla-grey", durationDays: 4 },
    ],
  ];
  for (const [message, reply, grounded] of cases) {
    const counters = {};
    const result = await runOwnedTurn({
      message,
      facts: trustedMultiBookingFacts({ withFocus: true }),
      responses: [
        decisionJson(reply, {
          bookingSelectionMode: "none",
          groundedFacts: {
            itemId: grounded.itemId ?? null,
            durationDays: grounded.durationDays ?? null,
            bookingStatus: grounded.bookingStatus ?? null,
            bookingReference: null,
            totalAmount: grounded.totalAmount ?? null,
            dailyRate: null,
            advanceAmount: null,
            startDate: null,
            endDate: null,
            pickupTime: grounded.pickupTime ?? null,
            deliveryTime: null,
            policyClaims: [],
          },
          replySemantics: {
            claims:
              grounded.totalAmount != null ? ["quotation_verified"] : [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }),
      ],
      counters,
    });
    assert.equal(result.bookingSelectionMode, "focused", message);
    assert.equal(result.selectedBookingIndex, 2, message);
    assert.equal(result.reply, reply, message);
    assert.equal(counters.openaiCalls, 1, message);
  }
});

test("live semantic-drift silence recovers with one corrective Brain regeneration", async () => {
  const counters = {};
  const finalReply = "Toyota Corolla 4 din ke liye book hai.";
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedMultiBookingFacts({ withFocus: true }),
    history:
      "User: kar do\nAssistant: Booking confirm ho gayi. Toyota Corolla 4 din ke liye.",
    responses: [
      decisionJson("", {
        situation: "acknowledgement_after_answer",
        conversationAct: "acknowledgement",
        customerIntent: "ack",
        customerIsAskingQuestion: false,
        shouldReply: false,
        action: "silence",
        bookingSelectionMode: "none",
      }),
      decisionJson(finalReply, {
        bookingSelectionMode: "none",
        groundedFacts: {
          itemId: "corolla-grey",
          durationDays: 4,
          bookingStatus: "approved",
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
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.reply, finalReply);
  assert.equal(result.bookingId, "booking-corolla");
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.action, "business_pa_reply");
  assert.notEqual(result.failureReason, "booking_selection_required");
  assert.notEqual(result.reason, "OPENAI_POST_CONFIRM_FAILED");
  const corrective = String(counters.lastOpenAiArgs.messages[1].content);
  assert.match(corrective, /CORRECTIVE REGENERATION/);
  assert.match(corrective, /Kitny din k lye book ki h/);
});

test("pure social acknowledgement may stay silence after corrective Brain pass", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "ok shukriya",
    facts: trustedMultiBookingFacts({ withFocus: true }),
    responses: [
      decisionJson("", {
        situation: "acknowledgement_after_answer",
        conversationAct: "acknowledgement",
        customerIntent: "ack",
        customerIsAskingQuestion: false,
        shouldReply: false,
        action: "silence",
      }),
      decisionJson("", {
        situation: "acknowledgement_after_answer",
        conversationAct: "acknowledgement",
        customerIntent: "thanks",
        customerIsAskingQuestion: false,
        shouldReply: false,
        action: "silence",
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.action, "business_pa_silence");
  assert.equal(result.reply, "");
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  assert.equal(counters.unexpectedDeclineExecutions || 0, 0);
});

test("trusted focus does not auto-select for multi-booking mutation without candidate", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "cancel kar do",
    facts: trustedMultiBookingFacts({ withFocus: true }),
    responses: [
      decisionJson("Cancel request received.", {
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        action: "request_booking_mutation",
        mutationIntent: "cancel_booking",
        bookingSelectionMode: "none",
      }),
      decisionJson("Kaunsi booking cancel karni hai — Civic ya Corolla?", {
        bookingSelectionMode: "clarification_required",
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.match(String(result.reply || result.reason || ""), /./);
  assert.notEqual(result.bookingSelectionMode, "focused");
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
});

test("model-contract failure after regeneration is terminal (not Cloud-retryable)", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedMultiBookingFacts({ withFocus: false }),
    responses: [
      decisionJson("Honda Civic 5 din aur Corolla 4 din book hain.", {
        bookingSelectionMode: "none",
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: 5,
          bookingStatus: "approved",
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
      }),
      decisionJson("Honda Civic 5 din aur Corolla 4 din book hain.", {
        bookingSelectionMode: "none",
        groundedFacts: {
          itemId: "civic-2026",
          durationDays: 5,
          bookingStatus: "approved",
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
      }),
    ],
    counters,
  });
  assert.equal(result.handled, true);
  assert.equal(result.retryable, false);
  assert.equal(result.terminalFailure, true);
  assert.equal(result.action, "business_pa_terminal_model_failure");
  assert.equal(result.reply, "");
  assert.ok(counters.openaiCalls >= 1);
});

test("buffer default routeGate reason is POST_CONFIRM_PA_OWNERSHIP_HANDLED after PA", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(
      new URL("../src/services/whatsappInboundBuffer.js", import.meta.url),
      "utf8"
    )
  );
  assert.match(src, /POST_CONFIRM_PA_OWNERSHIP_HANDLED/);
  assert.match(src, /postConfirmPaOwnershipHandled/);
  assert.match(src, /postConfirmTerminalFailure/);
  assert.match(src, /markCloudInboundTurnTerminalTechnicalFailure/);
});

function trustedStonicFocusFacts() {
  const stonic = {
    id: "CdqHuG0ZJpIZW3DDPlbI",
    selectionIndex: 1,
    customerSafeReference: null,
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    availabilityRequestId: "avr_f45af5f434e2f71cf33a1f2c",
  };
  const civic = {
    id: "booking-civic",
    selectionIndex: 2,
    customerSafeReference: "CIVIC-5",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    durationDays: 5,
    totalAmount: 40000,
    dailyRate: 8000,
    availabilityRequestId: "avr-civic",
  };
  const corolla = {
    id: "booking-corolla",
    selectionIndex: 3,
    customerSafeReference: "COROLLA-4",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Toyota corolla (Metallic Grey)",
    durationDays: 4,
    totalAmount: 20000,
    dailyRate: 5000,
    availabilityRequestId: "avr-corolla",
  };
  return {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: stonic,
    bookingCandidates: [stonic, civic, corolla],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: "CdqHuG0ZJpIZW3DDPlbI",
    },
    activeBookings: [stonic, civic, corolla].map(
      ({ id: _id, itemId: _itemId, availabilityRequestId: _avr, ...safe }) =>
        safe
    ),
    availabilityRequest: {
      id: "avr_f45af5f434e2f71cf33a1f2c",
      itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
      itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
      requestedDuration: 4,
      status: "approved",
      priceQuote: { total: 22000, dailyRate: 5500 },
    },
    known: {},
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: STONIC_FOCUS_CATALOG,
      activeBookings: [stonic, civic, corolla],
    },
    policy: {
      readOnly: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: false,
    },
  };
}

test("trusted focus compact facts include Stonic identity and mark others out-of-scope", () => {
  const compact = JSON.parse(
    compactPostConfirmFactsForPrompt(trustedStonicFocusFacts())
  );
  assert.equal(compact.bookingFocus.scope, "CURRENT_BOOKING_IN_SCOPE");
  assert.equal(
    compact.bookingFocus.itemId,
    "kia_stonic_ex_plus_2021_white_color_1df55684"
  );
  assert.equal(
    compact.bookingFocus.itemLabel,
    "Kia Stonic EX Plus 2021 (White Color)"
  );
  assert.equal(compact.bookingFocus.bookingId, "CdqHuG0ZJpIZW3DDPlbI");
  assert.equal(
    compact.bookingFocus.availabilityRequestId,
    "avr_f45af5f434e2f71cf33a1f2c"
  );
  assert.equal(compact.bookingFocus.durationDays, 4);
  assert.equal(compact.bookingFocus.totalAmount, 22000);
  assert.equal(compact.bookingFocus.dailyRate, 5500);
  assert.equal(compact.bookingFocus.bookingStatus, "approved");
  assert.equal(compact.booking.itemId, "kia_stonic_ex_plus_2021_white_color_1df55684");
  assert.equal(compact.booking.scope, "CURRENT_BOOKING_IN_SCOPE");
  const focused = compact.bookingCandidates.find(
    (row) => row.scope === "CURRENT_BOOKING_IN_SCOPE"
  );
  const outOfScope = compact.bookingCandidates.filter(
    (row) => row.scope === "OUT_OF_SCOPE_CONTEXT_ONLY"
  );
  assert.equal(focused.itemId, "kia_stonic_ex_plus_2021_white_color_1df55684");
  assert.equal(outOfScope.length, 2);
  assert.ok(outOfScope.every((row) => row.itemId == null));
  assert.ok(outOfScope.every((row) => row.totalAmount == null));
  assert.ok(
    outOfScope.some((row) => /Civic/i.test(String(row.itemLabel || "")))
  );
  assert.ok(
    outOfScope.some((row) => /[Cc]orolla/.test(String(row.itemLabel || "")))
  );
});

test("finiteNumberOrNull preserves nullish emptiness and explicit zero", () => {
  assert.equal(finiteNumberOrNull(null), null);
  assert.equal(finiteNumberOrNull(undefined), null);
  assert.equal(finiteNumberOrNull(""), null);
  assert.equal(finiteNumberOrNull("   "), null);
  assert.equal(finiteNumberOrNull(4), 4);
  assert.equal(finiteNumberOrNull("22000"), 22000);
  assert.equal(finiteNumberOrNull(0), 0);
  assert.equal(finiteNumberOrNull("0"), 0);
  assert.equal(finiteNumberOrNull("not-a-number"), null);
});

test("trusted focus identity keeps missing numeric fields null instead of zero", () => {
  const facts = trustedStonicFocusFacts();
  facts.booking = {
    ...facts.booking,
    durationDays: null,
    totalAmount: "",
    dailyRate: undefined,
  };
  facts.bookingCandidates = facts.bookingCandidates.map((row) =>
    row.selectionIndex === 1
      ? {
          ...row,
          durationDays: null,
          totalAmount: "",
          dailyRate: undefined,
        }
      : row
  );
  facts.availabilityRequest = {
    ...facts.availabilityRequest,
    requestedDuration: null,
    priceQuote: { total: null, dailyRate: "" },
  };
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  assert.equal(identity.durationDays, null);
  assert.equal(identity.totalAmount, null);
  assert.equal(identity.dailyRate, null);
  assert.notEqual(identity.durationDays, 0);
  assert.notEqual(identity.totalAmount, 0);
  assert.notEqual(identity.dailyRate, 0);
});

test("trusted focus identity preserves explicit zero numeric values", () => {
  const facts = trustedStonicFocusFacts();
  facts.booking = {
    ...facts.booking,
    durationDays: 0,
    totalAmount: 0,
    dailyRate: 0,
  };
  facts.bookingCandidates = facts.bookingCandidates.map((row) =>
    row.selectionIndex === 1
      ? { ...row, durationDays: 0, totalAmount: 0, dailyRate: 0 }
      : row
  );
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  assert.equal(identity.durationDays, 0);
  assert.equal(identity.totalAmount, 0);
  assert.equal(identity.dailyRate, 0);
});

test("compact booking uses focused Stonic row even when facts.booking is Corolla", () => {
  const facts = trustedStonicFocusFacts();
  facts.booking = {
    id: "booking-corolla",
    selectionIndex: 3,
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Toyota corolla (Metallic Grey)",
    durationDays: 9,
    totalAmount: 99999,
    dailyRate: 1111,
    availabilityRequestId: "avr-corolla",
  };
  facts.availabilityRequest = {
    id: "avr-corolla",
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Toyota corolla (Metallic Grey)",
    requestedDuration: 9,
    status: "approved",
    priceQuote: { total: 99999, dailyRate: 1111 },
  };
  const compact = JSON.parse(compactPostConfirmFactsForPrompt(facts));
  assert.equal(compact.bookingFocus.bookingId, "CdqHuG0ZJpIZW3DDPlbI");
  assert.equal(
    compact.bookingFocus.itemId,
    "kia_stonic_ex_plus_2021_white_color_1df55684"
  );
  assert.equal(
    compact.bookingFocus.itemLabel,
    "Kia Stonic EX Plus 2021 (White Color)"
  );
  assert.equal(compact.bookingFocus.durationDays, 4);
  assert.equal(compact.bookingFocus.totalAmount, 22000);
  assert.equal(compact.bookingFocus.dailyRate, 5500);
  assert.equal(
    compact.bookingFocus.availabilityRequestId,
    "avr_f45af5f434e2f71cf33a1f2c"
  );
  assert.equal(compact.booking.scope, "CURRENT_BOOKING_IN_SCOPE");
  assert.equal(compact.booking.itemId, "kia_stonic_ex_plus_2021_white_color_1df55684");
  assert.equal(
    compact.booking.itemLabel,
    "Kia Stonic EX Plus 2021 (White Color)"
  );
  assert.equal(compact.booking.durationDays, 4);
  assert.equal(compact.booking.totalAmount, 22000);
  assert.equal(compact.booking.dailyRate, 5500);
  assert.doesNotMatch(
    JSON.stringify(compact.booking),
    /Corolla|99999|1111|avr-corolla|"durationDays":9/
  );
  assert.doesNotMatch(
    JSON.stringify(compact.bookingFocus),
    /Corolla|99999|1111|avr-corolla/
  );
  assert.doesNotMatch(
    JSON.stringify(compact.availabilityRequest),
    /Corolla|99999|1111|avr-corolla/
  );
  assert.equal(
    compact.availabilityRequest.itemId,
    "kia_stonic_ex_plus_2021_white_color_1df55684"
  );
  assert.equal(compact.availabilityRequest.requestedDuration, 4);
});

test("stale trusted focus index does not fall back to facts.booking", () => {
  const facts = trustedStonicFocusFacts();
  facts.bookingFocus = {
    source: "latest_confirmed_linked_avr",
    confidence: "trusted",
    selectedBookingIndex: 99,
    selectedBookingId: "booking-corolla",
  };
  facts.booking = {
    id: "booking-corolla",
    selectionIndex: 3,
    status: "approved",
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Toyota corolla (Metallic Grey)",
    durationDays: 9,
    totalAmount: 99999,
    dailyRate: 1111,
    availabilityRequestId: "avr-corolla",
  };
  facts.availabilityRequest = {
    id: "avr-corolla",
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Toyota corolla (Metallic Grey)",
    requestedDuration: 9,
    status: "approved",
    priceQuote: { total: 99999, dailyRate: 1111 },
  };
  assert.equal(resolveTrustedFocusedBookingRow(facts), null);
  assert.equal(resolveTrustedFocusedBookingIdentity(facts), null);
  const compact = JSON.parse(compactPostConfirmFactsForPrompt(facts));
  assert.equal(compact.bookingFocus, null);
  assert.equal(compact.booking?.scope, undefined);
  assert.ok(
    !(compact.bookingCandidates || []).some(
      (row) => row?.scope === "CURRENT_BOOKING_IN_SCOPE"
    )
  );
  assert.doesNotMatch(
    JSON.stringify(compact.booking || {}),
    /CURRENT_BOOKING_IN_SCOPE/
  );
  assert.equal(compact.bookingFocus, null);
  assert.doesNotMatch(
    JSON.stringify({
      bookingFocus: compact.bookingFocus,
      scopes: (compact.bookingCandidates || []).map((row) => row?.scope),
    }),
    /CURRENT_BOOKING_IN_SCOPE/
  );
});

test("valid single-booking trusted focus index 1 still resolves facts.booking candidate", () => {
  const booking = {
    id: "booking-only",
    status: "approved",
    itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    availabilityRequestId: "avr_f45af5f434e2f71cf33a1f2c",
  };
  const facts = {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking,
    bookingCandidates: undefined,
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: "booking-only",
    },
    activeBookings: [],
    availabilityRequest: {
      id: "avr_f45af5f434e2f71cf33a1f2c",
      itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
      itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
      requestedDuration: 4,
      status: "approved",
      priceQuote: { total: 22000, dailyRate: 5500 },
    },
    known: {},
    replyGuardFacts: { catalogItems: STONIC_FOCUS_CATALOG },
    policy: { readOnly: true, doNotMutateBooking: true },
  };
  const row = resolveTrustedFocusedBookingRow(facts);
  assert.equal(row?.id, "booking-only");
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  assert.equal(identity?.itemId, "kia_stonic_ex_plus_2021_white_color_1df55684");
  assert.equal(identity?.durationDays, 4);
  const compact = JSON.parse(compactPostConfirmFactsForPrompt(facts));
  assert.equal(compact.booking.scope, "CURRENT_BOOKING_IN_SCOPE");
  assert.equal(compact.bookingFocus.bookingId, "booking-only");
  assert.equal(compact.bookingFocus.durationDays, 4);
});

test("valid Stonic candidate trusted focus still works after stale-index fail-closed", () => {
  const facts = trustedStonicFocusFacts();
  const row = resolveTrustedFocusedBookingRow(facts);
  assert.equal(row?.id, "CdqHuG0ZJpIZW3DDPlbI");
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  assert.equal(
    identity?.itemId,
    "kia_stonic_ex_plus_2021_white_color_1df55684"
  );
  const compact = JSON.parse(compactPostConfirmFactsForPrompt(facts));
  assert.equal(compact.booking.scope, "CURRENT_BOOKING_IN_SCOPE");
  assert.equal(compact.bookingFocus.selectedBookingIndex, 1);
  assert.equal(compact.bookingFocus.totalAmount, 22000);
});

test("verified_item_mismatch correction pins trusted Stonic identity", () => {
  const text = buildPostConfirmVerifiedItemMismatchCorrection(
    trustedStonicFocusFacts(),
    "verified_item_mismatch"
  );
  assert.match(text, /verified_item_mismatch/);
  assert.match(text, /kia_stonic_ex_plus_2021_white_color_1df55684/);
  assert.match(text, /Kia Stonic EX Plus 2021 \(White Color\)/);
  assert.match(text, /CdqHuG0ZJpIZW3DDPlbI/);
  assert.match(text, /selectedBookingIndex: 1/);
  assert.match(text, /groundedFacts\.itemId MUST refer only/);
});

test("trusted Stonic focus recovers duration ask after Corolla verified_item_mismatch", async () => {
  const counters = {};
  const wrong = decisionJson("Toyota Corolla 4 din ke liye book hai.", {
    bookingSelectionMode: "none",
    groundedFacts: {
      itemId: "toyota_corolla_metallic_grey_0e2cd610",
      durationDays: 4,
      bookingStatus: "approved",
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
  });
  const right = decisionJson("Kia Stonic 4 din ke liye book hai.", {
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    groundedFacts: {
      itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
      durationDays: 4,
      bookingStatus: "approved",
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
  });
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedStonicFocusFacts(),
    responses: [wrong, right],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.action, "business_pa_reply");
  assert.equal(result.reply, "Kia Stonic 4 din ke liye book hai.");
  assert.equal(result.bookingId, "CdqHuG0ZJpIZW3DDPlbI");
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.selectedBookingIndex, 1);
  assert.equal(result.terminalFailure, false);
  assert.equal(result.retryable, false);
  assert.equal(counters.customerSends || 0, 0);
  const corrective = String(counters.openaiPrompts[1] || "");
  assert.match(corrective, /verified_item_mismatch/);
  assert.match(corrective, /kia_stonic_ex_plus_2021_white_color_1df55684/);
  assert.match(corrective, /Kia Stonic EX Plus 2021 \(White Color\)/);
  assert.match(corrective, /CdqHuG0ZJpIZW3DDPlbI/);
  assert.match(corrective, /CURRENT_BOOKING_IN_SCOPE/);
  assert.match(corrective, /OUT_OF_SCOPE_CONTEXT_ONLY/);
});

test("trusted Stonic focus recovers rent, pickup, and status after wrong-item attempt", async () => {
  const cases = [
    [
      "4 din ka total rent kitna hoga?",
      "Corolla ka total rent 22000 PKR hai.",
      "Kia Stonic ka total rent 22000 PKR hai.",
      {
        wrong: {
          itemId: "toyota_corolla_metallic_grey_0e2cd610",
          totalAmount: 22000,
          durationDays: 4,
        },
        right: {
          itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
          totalAmount: 22000,
          durationDays: 4,
        },
        claims: ["quotation_verified"],
      },
    ],
    [
      "pickup ho jye ga?",
      "Toyota corolla (Metallic Grey) booking approved hai; pickup detail abhi confirm nahi.",
      "Kia Stonic booking approved hai; pickup detail abhi confirm nahi.",
      {
        wrong: {
          itemId: "toyota_corolla_metallic_grey_0e2cd610",
          bookingStatus: "approved",
          durationDays: 4,
        },
        right: {
          itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
          bookingStatus: "approved",
          durationDays: 4,
        },
        claims: [],
      },
    ],
    [
      "booking status?",
      "Toyota corolla (Metallic Grey) booking approved hai.",
      "Kia Stonic booking approved hai.",
      {
        wrong: {
          itemId: "toyota_corolla_metallic_grey_0e2cd610",
          bookingStatus: "approved",
          durationDays: 4,
        },
        right: {
          itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
          bookingStatus: "approved",
          durationDays: 4,
        },
        claims: [],
      },
    ],
  ];
  for (const [message, wrongReply, rightReply, meta] of cases) {
    const counters = {};
    const result = await runOwnedTurn({
      message,
      facts: trustedStonicFocusFacts(),
      responses: [
        decisionJson(wrongReply, {
          bookingSelectionMode: "none",
          groundedFacts: {
            itemId: meta.wrong.itemId,
            durationDays: meta.wrong.durationDays ?? null,
            bookingStatus: meta.wrong.bookingStatus ?? null,
            bookingReference: null,
            totalAmount: meta.wrong.totalAmount ?? null,
            dailyRate: null,
            advanceAmount: null,
            startDate: null,
            endDate: null,
            pickupTime: null,
            deliveryTime: null,
            policyClaims: [],
          },
          replySemantics: {
            claims: meta.claims,
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }),
        decisionJson(rightReply, {
          bookingSelectionMode: "focused",
          selectedBookingIndex: 1,
          groundedFacts: {
            itemId: meta.right.itemId,
            durationDays: meta.right.durationDays ?? null,
            bookingStatus: meta.right.bookingStatus ?? null,
            bookingReference: null,
            totalAmount: meta.right.totalAmount ?? null,
            dailyRate: null,
            advanceAmount: null,
            startDate: null,
            endDate: null,
            pickupTime: null,
            deliveryTime: null,
            policyClaims: [],
          },
          replySemantics: {
            claims: meta.claims,
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }),
      ],
      counters,
    });
    assert.equal(counters.openaiCalls, 2, message);
    assert.equal(result.reply, rightReply, message);
    assert.equal(result.bookingId, "CdqHuG0ZJpIZW3DDPlbI", message);
    assert.equal(result.terminalFailure, false, message);
    assert.match(
      String(counters.openaiPrompts[1] || ""),
      /verified_item_mismatch/,
      message
    );
  }
});

test("two wrong-item attempts on trusted Stonic focus are terminal with zero outbound", async () => {
  const counters = {};
  const wrong = decisionJson("Toyota Corolla 4 din ke liye book hai.", {
    bookingSelectionMode: "none",
    groundedFacts: {
      itemId: "toyota_corolla_metallic_grey_0e2cd610",
      durationDays: 4,
      bookingStatus: "approved",
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
  });
  const result = await runOwnedTurn({
    message: "Kitny din k lye book ki h?",
    facts: trustedStonicFocusFacts(),
    responses: [wrong, wrong],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.equal(result.handled, true);
  assert.equal(result.retryable, false);
  assert.equal(result.terminalFailure, true);
  assert.equal(result.action, "business_pa_terminal_model_failure");
  assert.equal(result.reply, "");
  assert.equal(result.failureReason, "verified_item_mismatch");
  assert.equal(counters.customerSends || 0, 0);
  assert.match(String(counters.openaiPrompts[1] || ""), /verified_item_mismatch/);
});

test("trusted focus mutation still requires explicit candidate after prompt dominance", async () => {
  const counters = {};
  const result = await runOwnedTurn({
    message: "cancel kar do",
    facts: trustedStonicFocusFacts(),
    responses: [
      decisionJson("Cancel request received.", {
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        action: "request_booking_mutation",
        mutationIntent: "cancel_booking",
        bookingSelectionMode: "none",
      }),
      decisionJson("Kaunsi booking cancel karni hai — Stonic, Civic, ya Corolla?", {
        bookingSelectionMode: "clarification_required",
      }),
    ],
    counters,
  });
  assert.equal(counters.openaiCalls, 2);
  assert.notEqual(result.bookingSelectionMode, "focused");
  assert.equal(counters.unexpectedConfirmExecutions || 0, 0);
  const firstPrompt = String(counters.openaiPrompts[0] || "");
  assert.match(firstPrompt, /OUT_OF_SCOPE_CONTEXT_ONLY/);
  assert.match(firstPrompt, /CURRENT_BOOKING_IN_SCOPE/);
});
