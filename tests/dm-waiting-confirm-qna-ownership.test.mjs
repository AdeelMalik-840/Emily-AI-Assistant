import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  evaluateWaitingConfirmDmBrainConfirmGuard,
  executeWaitingConfirmDmLaneDecision,
  isWaitingConfirmDmBookingPromptActive,
  isWaitingConfirmDmTransactionActive,
  packWaitingConfirmDmTurnContext,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const {
  availabilityRequestMatchesCloudCustomerPhone,
  isCloudWaitingConfirmAvailabilityRequestEligible,
  isFreshTrustedWaitingConfirmCloudOwnershipCandidate,
  isTrustedWaitingConfirmBookingPromptCandidate,
  pickLatestWaitingConfirmTransactionRequest,
} = await import("../src/services/availabilityRequestService.js");
const { selectAvailabilityRequestForCustomerMessage } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);

const NOW = Date.now();

function pending(overrides = {}) {
  return {
    requestId: "avr_civic_current",
    businessId: "owner-1",
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: new Date(NOW - 60_000),
    customerDeliveryStatus: "delivered",
    customerDeliveryTimestamp: new Date(NOW - 59_000),
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    customerDmTransport: "cloud_api",
    customerConfirmProcessingStatus: "idle",
    customerDmTarget: "+923001112222",
    itemId: "civic-2026-oriel",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 3,
    priceQuote: {
      status: "quoted",
      dailyRate: 8000,
      total: 24000,
      currency: "PKR",
    },
    confirmExpiresAt: new Date(NOW + 60 * 60_000),
    lastCustomerDmPromptType: "general_info",
    lastCustomerDmOutboundPreview: "Per din rent 8000 PKR hai.",
    createdAt: new Date(NOW - 120_000),
    updatedAt: new Date(NOW - 1_000),
    ...overrides,
  };
}

function confirmingDecision(overrides = {}) {
  return {
    action: "confirm_booking",
    customerIsConfirmingBooking: true,
    customerIsAskingQuestion: false,
    requiredExecutor: "confirm_booking_executor",
    confidence: 0.95,
    ...overrides,
  };
}

test("1 pricing Q&A leaves the Civic transaction fresh and ownable", () => {
  const row = pending();
  assert.equal(isTrustedWaitingConfirmBookingPromptCandidate(row, NOW), false);
  assert.equal(
    isFreshTrustedWaitingConfirmCloudOwnershipCandidate(row, {
      nowMs: NOW,
      inboundReceivedAtMs: NOW,
    }),
    true
  );
});

test("2 location Q&A does not alter lifecycle ownership", () => {
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(pending(), NOW), true);
});

test("3 social turn does not alter lifecycle ownership", () => {
  assert.equal(
    pickLatestWaitingConfirmTransactionRequest([pending()], NOW)?.requestId,
    "avr_civic_current"
  );
});

test("4 newer pending Civic wins generic transaction binding", () => {
  const older = pending({
    requestId: "avr_corolla_old",
    itemLabel: "Toyota Corolla",
    approvalCustomerNotificationAt: new Date(NOW - 600_000),
    customerDeliveryTimestamp: new Date(NOW - 599_000),
    createdAt: new Date(NOW - 700_000),
  });
  const selected = selectAvailabilityRequestForCustomerMessage(
    [older, pending()],
    "semantic turn decided later by Brain",
    { nowMs: NOW }
  );
  assert.equal(selected.reason, "LATEST_ACTIVE_TRANSACTION");
  assert.equal(selected.request.requestId, "avr_civic_current");
});

test("5 pending Civic and older confirmed Stonic are separate Brain facts", () => {
  const ctx = packWaitingConfirmDmTurnContext({
    businessId: "owner-1",
    customerPhone: "+923001112222",
    messageText: "current turn",
    request: pending(),
    historicalBookingContext: {
      booking: {
        id: "booking_stonic_old",
        itemLabel: "Kia Stonic EX Plus 2021",
        dailyRate: 5500,
        totalAmount: 16500,
        status: "approved",
      },
      bookingCandidates: [
        {
          id: "booking_stonic_old",
          itemLabel: "Kia Stonic EX Plus 2021",
          dailyRate: 5500,
          totalAmount: 16500,
          bookingStatus: "approved",
        },
      ],
    },
  });
  assert.equal(ctx.facts.pendingAvailabilityRequest.id, "avr_civic_current");
  assert.equal(ctx.facts.activeConfirmedBooking.id, "booking_stonic_old");
  assert.equal(ctx.facts.activeBookings[0].dailyRate, 5500);
  assert.deepEqual(
    ctx.facts.referentOptions.map((row) => [
      row.targetContext,
      row.targetId,
      row.lifecycleRole,
    ]),
    [
      [
        "pending_availability",
        "avr_civic_current",
        "current_pending_transaction",
      ],
      [
        "confirmed_booking",
        "booking_stonic_old",
        "older_confirmed_booking",
      ],
    ]
  );
});

test("6 semantic decline cannot pass the confirm guard", () => {
  const ctx = packWaitingConfirmDmTurnContext({ request: pending() });
  assert.equal(
    evaluateWaitingConfirmDmBrainConfirmGuard({
      turnContext: ctx,
      decision: confirmingDecision({ action: "decline_request" }),
    }).ok,
    false
  );
});

test("7 semantic change cannot pass the confirm guard", () => {
  const ctx = packWaitingConfirmDmTurnContext({ request: pending() });
  assert.equal(
    evaluateWaitingConfirmDmBrainConfirmGuard({
      turnContext: ctx,
      decision: confirmingDecision({ action: "change_request" }),
    }).ok,
    false
  );
});

test("8 expired waiting_confirm is ineligible", () => {
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      pending({ confirmExpiresAt: new Date(NOW - 1) }),
      NOW
    ),
    false
  );
});

test("9 superseded waiting_confirm is ineligible", () => {
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      pending({ supersededByAvailabilityRequestId: "avr_replacement" }),
      NOW
    ),
    false
  );
});

test("10 already confirmed/booked AVR is ineligible", () => {
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      pending({ customerConfirmationStatus: "confirmed", linkedBookingId: "booking-1" }),
      NOW
    ),
    false
  );
});

test("11 wrong customer cannot bind", () => {
  assert.equal(
    availabilityRequestMatchesCloudCustomerPhone(pending(), "+923009999999"),
    false
  );
});

test("12 explicit delivery failure revokes transaction trust", () => {
  assert.equal(
    isFreshTrustedWaitingConfirmCloudOwnershipCandidate(
      pending({ customerDeliveryStatus: "failed" }),
      { nowMs: NOW, inboundReceivedAtMs: NOW }
    ),
    false
  );
});

test("13 missing independent semantic confirmation flag blocks execution", () => {
  const ctx = packWaitingConfirmDmTurnContext({ request: pending() });
  assert.equal(
    evaluateWaitingConfirmDmBrainConfirmGuard({
      turnContext: ctx,
      decision: confirmingDecision({ customerIsConfirmingBooking: false }),
    }).ok,
    false
  );
});

test("14 active lifecycle allows AI confirmation after general_info Q&A", () => {
  const ctx = packWaitingConfirmDmTurnContext({ request: pending() });
  assert.equal(isWaitingConfirmDmBookingPromptActive(ctx), false);
  assert.equal(isWaitingConfirmDmTransactionActive(ctx), true);
  assert.deepEqual(
    evaluateWaitingConfirmDmBrainConfirmGuard({
      turnContext: ctx,
      decision: confirmingDecision(),
    }),
    { ok: true, reasons: [] }
  );
});

test("15 repeated Q&A timestamps cannot reorder transaction ownership", () => {
  const oldWithRecentQna = pending({
    requestId: "avr_old_recent_qna",
    approvalCustomerNotificationAt: new Date(NOW - 600_000),
    customerDeliveryTimestamp: new Date(NOW - 599_000),
    lastCustomerDmOutboundAt: new Date(NOW - 10),
  });
  const newest = pending({ lastCustomerDmOutboundAt: new Date(NOW - 30_000) });
  assert.equal(
    pickLatestWaitingConfirmTransactionRequest([oldWithRecentQna, newest], NOW)
      ?.requestId,
    "avr_civic_current"
  );
});

test("16 no pending AVR produces no waiting-confirm selection", () => {
  assert.equal(
    selectAvailabilityRequestForCustomerMessage([], "semantic turn").reason,
    "NO_MATCH"
  );
});

test("17 a general turn does not mutate the pending lifecycle projection", () => {
  const row = pending();
  const before = JSON.stringify(row);
  packWaitingConfirmDmTurnContext({ request: row, messageText: "general turn" });
  assert.equal(JSON.stringify(row), before);
  assert.equal(row.customerConfirmationStatus, "waiting_confirm");
});

function semanticReply({ targetContext, targetId, customerReply }) {
  return JSON.stringify({
    conversationStage: "booking_offer",
    customerMood: null,
    customerIntent: "ask_price",
    situation: "awaiting_confirm",
    customerIsConfirmingBooking: false,
    customerIsAskingQuestion: true,
    customerIsDeclining: false,
    customerWantsChange: false,
    requestedInfoType: "price",
    targetContext,
    targetId,
    shouldReply: true,
    customerReply,
    action: "reply",
    confidence: 0.95,
    safetyNotes: null,
    reason: "verified_price_question",
    asksForBookingConfirmation: false,
    replySemantics: {
      claims: ["quotation_verified"],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
  });
}

test("18 pending Civic quotation validates against pending target facts", async () => {
  const ctx = packWaitingConfirmDmTurnContext({
    request: pending(),
    messageText: "Civic ka per day kitna hai?",
  });
  const result = await executeWaitingConfirmDmLaneDecision({
    turnContext: ctx,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: semanticReply({
              targetContext: "pending_availability",
              targetId: "avr_civic_current",
              customerReply: "Civic ka per din rent 8000 PKR hai.",
            }),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.targetContext, "pending_availability");
});

test("19 explicit old Stonic quotation validates against confirmed-booking facts", async () => {
  const historicalBookingContext = {
    booking: {
      id: "booking_stonic_old",
      itemId: "stonic-2021",
      itemLabel: "Kia Stonic EX Plus 2021",
      dailyRate: 5500,
      totalAmount: 16500,
      status: "approved",
    },
    bookingCandidates: [
      {
        id: "booking_stonic_old",
        itemId: "stonic-2021",
        itemLabel: "Kia Stonic EX Plus 2021",
        dailyRate: 5500,
        totalAmount: 16500,
        bookingStatus: "approved",
      },
    ],
  };
  const ctx = packWaitingConfirmDmTurnContext({
    request: pending(),
    historicalBookingContext,
    messageText: "Stonic ka daily rent kya tha?",
  });
  const result = await executeWaitingConfirmDmLaneDecision({
    turnContext: ctx,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: semanticReply({
              targetContext: "confirmed_booking",
              targetId: "booking_stonic_old",
              customerReply: "Stonic ka daily rent 5500 PKR tha.",
            }),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.targetContext, "confirmed_booking");
});
