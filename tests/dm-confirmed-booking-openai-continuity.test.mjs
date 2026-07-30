import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

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

test("two unsupported OpenAI replies fail closed and remain retryable", async () => {
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
  assert.equal(result.retryable, true);
  assert.equal(result.action, "business_pa_retryable_failure");
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
