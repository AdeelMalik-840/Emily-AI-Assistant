import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  evaluateWaitingConfirmDmBrainConfirmGuard,
  executeWaitingConfirmDmLaneDecision,
  isWaitingConfirmDmTransactionActive,
  packWaitingConfirmDmTurnContext,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const {
  availabilityRequestMatchesCloudCustomerPhone,
  isCloudWaitingConfirmAvailabilityRequestEligible,
} = await import("../src/services/availabilityRequestService.js");
const { selectAvailabilityRequestForCustomerMessage } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);

const NOW = Date.now();

function civic(overrides = {}) {
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
    createdAt: new Date(NOW - 120_000),
    ...overrides,
  };
}

const historical = {
  booking: {
    id: "booking_stonic_old",
    itemId: "stonic-2021",
    itemLabel: "Kia Stonic EX Plus 2021",
    dailyRate: 5500,
    totalAmount: 16500,
    bookingStatus: "confirmed",
  },
  bookingCandidates: [
    {
      id: "booking_stonic_old",
      itemId: "stonic-2021",
      itemLabel: "Kia Stonic EX Plus 2021",
      dailyRate: 5500,
      totalAmount: 16500,
      bookingStatus: "confirmed",
    },
  ],
};

function semanticJson({
  action = "reply",
  targetContext = "pending_availability",
  targetId = "avr_civic_current",
  customerReply = "Civic ka per din rent 8000 PKR hai.",
  requestedInfoType = "price",
}) {
  const confirming = action === "confirm_booking";
  const declining = action === "decline_request";
  const changing = action === "change_request";
  return JSON.stringify({
    conversationStage: "booking_offer",
    customerMood: null,
    customerIntent: confirming
      ? "confirm_booking"
      : declining
        ? "decline"
        : changing
          ? "change_request"
          : "ask_fact",
    situation: "awaiting_confirm",
    customerIsConfirmingBooking: confirming,
    customerIsAskingQuestion: action === "reply",
    customerIsDeclining: declining,
    customerWantsChange: changing,
    requestedInfoType,
    targetContext,
    targetId,
    shouldReply: true,
    customerReply: confirming || declining || changing ? "" : customerReply,
    action,
    confidence: 0.96,
    safetyNotes: null,
    reason: "deployment_1_regression",
    asksForBookingConfirmation: false,
    replySemantics: {
      claims: action === "reply" ? ["quotation_verified"] : [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
  });
}

async function decide(ctx, payload) {
  return executeWaitingConfirmDmLaneDecision({
    turnContext: ctx,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: semanticJson(payload) } }],
    }),
  });
}

test("Deployment 1: three informational turns then semantic confirmation retain one Civic AVR", async () => {
  const request = civic();
  const before = JSON.stringify(request);
  for (const messageText of [
    "per day kitna hai?",
    "pickup kahan se hai?",
    "total kitna banay ga?",
  ]) {
    const ctx = packWaitingConfirmDmTurnContext({
      businessId: "owner-1",
      customerPhone: "+923001112222",
      messageText,
      request,
      historicalBookingContext: historical,
    });
    assert.equal(isWaitingConfirmDmTransactionActive(ctx), true);
    const result = await decide(ctx, {});
    assert.equal(result.ok, true);
    assert.equal(result.decision.action, "reply");
    assert.equal(result.decision.targetContext, "pending_availability");
    assert.equal(result.decision.targetId, "avr_civic_current");
    assert.equal(JSON.stringify(request), before);
  }

  const finalCtx = packWaitingConfirmDmTurnContext({
    businessId: "owner-1",
    customerPhone: "+923001112222",
    messageText: "haan kar do",
    request,
    historicalBookingContext: historical,
  });
  const finalDecision = await decide(finalCtx, {
    action: "confirm_booking",
    customerReply: "",
    requestedInfoType: null,
  });
  assert.equal(finalDecision.ok, true);
  assert.equal(finalDecision.decision.action, "confirm_booking");
  assert.equal(finalDecision.decision.targetId, "avr_civic_current");
  assert.deepEqual(
    evaluateWaitingConfirmDmBrainConfirmGuard({
      turnContext: finalCtx,
      decision: {
        ...finalDecision.decision,
        requiredExecutor: "confirm_booking_executor",
      },
    }),
    { ok: true, reasons: [] }
  );
  const bound = selectAvailabilityRequestForCustomerMessage(
    [request],
    "semantic authority runs after binding",
    { nowMs: NOW }
  );
  assert.equal(bound.request.requestId, "avr_civic_current");
  assert.equal(JSON.stringify(request), before);
});

test("Deployment 1: explicit Stonic and general turns do not steal pending Civic", async () => {
  const request = civic();
  const ctx = packWaitingConfirmDmTurnContext({
    request,
    historicalBookingContext: historical,
    messageText: "Stonic ka daily rent kya tha?",
  });
  const stonic = await decide(ctx, {
    targetContext: "confirmed_booking",
    targetId: "booking_stonic_old",
    customerReply: "Stonic ka daily rent 5500 PKR tha.",
  });
  assert.equal(stonic.ok, true);
  assert.equal(stonic.decision.targetContext, "confirmed_booking");
  assert.equal(stonic.decision.targetId, "booking_stonic_old");

  const social = await decide(ctx, {
    targetContext: "general",
    targetId: null,
    customerReply: "Khush aamdeed.",
    requestedInfoType: null,
  });
  assert.equal(social.ok, true);
  assert.equal(social.decision.targetContext, "general");
  assert.equal(request.customerConfirmationStatus, "waiting_confirm");
  assert.equal(request.requestId, "avr_civic_current");
});

test("Deployment 1: decline/change and deterministic lifecycle protections remain fail-safe", async () => {
  const request = civic();
  const ctx = packWaitingConfirmDmTurnContext({ request });
  for (const action of ["decline_request", "change_request"]) {
    const result = await decide(ctx, {
      action,
      customerReply: "",
      requestedInfoType: null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.decision.action, action);
    assert.equal(
      evaluateWaitingConfirmDmBrainConfirmGuard({
        turnContext: ctx,
        decision: {
          ...result.decision,
          requiredExecutor: "confirm_booking_executor",
        },
      }).ok,
      false
    );
  }

  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      civic({ confirmExpiresAt: new Date(NOW - 1) }),
      NOW
    ),
    false
  );
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      civic({ supersededByAvailabilityRequestId: "avr-new" }),
      NOW
    ),
    false
  );
  assert.equal(
    isCloudWaitingConfirmAvailabilityRequestEligible(
      civic({ linkedBookingId: "booking-existing" }),
      NOW
    ),
    false
  );
  assert.equal(
    availabilityRequestMatchesCloudCustomerPhone(
      request,
      "+923009999999"
    ),
    false
  );
});
