import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { executePostConfirmPaLaneDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

const MESSAGE = "HONDA CIVIC 5 DIN K LYE CHYH";
const BUSINESS_ID = "audit-business";
const TRACE_ID = "audit-trace";

function decisionJson() {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: "item_label",
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept: "vehicle",
        attributes: ["item_label"],
      },
    ],
    shouldReply: true,
    customerReply: "",
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
  });
}

function facts() {
  const booking = {
    id: "booking-1",
    selectionIndex: 1,
    itemId: "corolla-1",
    itemLabel: "Toyota Corolla (Metallic Grey)",
    durationDays: 7,
    status: "approved",
  };
  return {
    businessId: BUSINESS_ID,
    booking,
    bookingCandidates: [booking],
    activeBookings: [booking],
    bookingFocus: {
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: booking.id,
    },
    known: {},
    replyGuardFacts: { activeBookings: [booking] },
    policy: { readOnly: true },
  };
}

function restoreEnv(name, prior) {
  if (prior === undefined) delete process.env[name];
  else process.env[name] = prior;
}

test("raw post-confirm audit is silent unless every configured exact gate matches", async () => {
  const names = [
    "POST_CONFIRM_RAW_AUDIT_MESSAGE_TEXT",
    "POST_CONFIRM_RAW_AUDIT_BUSINESS_ID",
    "POST_CONFIRM_RAW_AUDIT_TRACE_ID",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args);

  try {
    delete process.env.POST_CONFIRM_RAW_AUDIT_MESSAGE_TEXT;
    delete process.env.POST_CONFIRM_RAW_AUDIT_BUSINESS_ID;
    delete process.env.POST_CONFIRM_RAW_AUDIT_TRACE_ID;

    const run = () =>
      executePostConfirmPaLaneDecision({
        facts: facts(),
        userMessage: MESSAGE,
        businessId: BUSINESS_ID,
        traceId: TRACE_ID,
        __chatCompletionsCreateForTests: async () => ({
          choices: [
            { message: { content: decisionJson() }, finish_reason: "stop" },
          ],
        }),
      });

    assert.equal((await run()).ok, true);
    assert.equal(logs.length, 0);

    process.env.POST_CONFIRM_RAW_AUDIT_MESSAGE_TEXT = MESSAGE;
    process.env.POST_CONFIRM_RAW_AUDIT_BUSINESS_ID = "different-business";
    assert.equal((await run()).ok, true);
    assert.equal(logs.length, 0);

    process.env.POST_CONFIRM_RAW_AUDIT_BUSINESS_ID = BUSINESS_ID;
    process.env.POST_CONFIRM_RAW_AUDIT_TRACE_ID = TRACE_ID;
    assert.equal((await run()).ok, true);

    const stages = logs
      .filter(([marker]) => marker === "[post_confirm_raw_audit]")
      .map(([, payload]) => payload.stage);
    assert.deepEqual(stages, ["request", "raw_response", "parsed", "finalized"]);
    assert.equal(logs[0][1].request.messages[1].content.includes(MESSAGE), true);
    assert.equal(logs[1][1].raw, decisionJson());
  } finally {
    console.log = originalLog;
    for (const name of names) restoreEnv(name, prior[name]);
  }
});

test("release-gate audit records the finalized decision and each deterministic guard", async () => {
  const names = [
    "POST_CONFIRM_RAW_AUDIT_MESSAGE_TEXT",
    "POST_CONFIRM_RAW_AUDIT_BUSINESS_ID",
    "POST_CONFIRM_RAW_AUDIT_TRACE_ID",
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args);

  try {
    process.env.POST_CONFIRM_RAW_AUDIT_MESSAGE_TEXT = MESSAGE;
    process.env.POST_CONFIRM_RAW_AUDIT_BUSINESS_ID = BUSINESS_ID;
    process.env.POST_CONFIRM_RAW_AUDIT_TRACE_ID = TRACE_ID;

    const releaseDecision = {
      factKind: "booking_fact",
      capability: "availability_request",
      action: "reply",
      mutationIntent: "none",
      pendingAvailabilitySelectionIndex: null,
      customerReply: "",
    };
    const result = await handleCustomerBusinessPaInbound({
      businessId: BUSINESS_ID,
      customerPhone: "923001234567",
      messageText: MESSAGE,
      traceId: TRACE_ID,
      preResolvedBookingFacts: { ok: true, facts: facts() },
      __tryHandlePaMissingInfoCustomerClarificationFn: async () => null,
      __decideCustomerTurnFn: async () => ({
        ok: true,
        source: "openai",
        decision: releaseDecision,
      }),
    });

    assert.equal(result.ownershipReleased, true);
    const entry = logs.find(
      ([marker, payload]) =>
        marker === "[post_confirm_raw_audit]" && payload.stage === "release_gate"
    );
    assert.ok(entry);
    assert.deepEqual(entry[1].decision, releaseDecision);
    assert.deepEqual(entry[1].guards, {
      factKind: true,
      capability: true,
      action: true,
      mutationIntent: true,
      pendingAvailabilitySelectionIndex: true,
    });
  } finally {
    console.log = originalLog;
    for (const name of names) restoreEnv(name, prior[name]);
  }
});
