/**
 * Post-confirm PA decide → validate/execute → compose architecture.
 * Architecture foundation only — no real mutation executors yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  resolvePostConfirmBookingSelection,
  normalizePostConfirmActionParameters,
  emptyPostConfirmActionParameters,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  executePostConfirmBookingMutation,
  POST_CONFIRM_BOOKING_MUTATION_INTENTS,
  POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS,
} = await import("../src/services/postConfirmBookingMutationExecutor.js");
const { composePostConfirmMutationCustomerReply } = await import(
  "../src/services/customerBusinessPaAiReply.js"
);
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  claimCloudInboundTurn,
} = await import("../src/services/inboundTurnLedger.js");

/** Nested↔flat parity for the post-confirm agent return contract. */
function assertPostConfirmReturnContractParity(result) {
  assert.ok(result?.outbound && typeof result.outbound === "object");
  assert.ok(result?.decision && typeof result.decision === "object");
  assert.ok(result?.evidence && typeof result.evidence === "object");
  assert.ok(result?.execution && typeof result.execution === "object");
  assert.ok(result?.replyEnvelope && typeof result.replyEnvelope === "object");
  assert.equal(result.outbound.reply, result.reply ?? "");
  assert.equal(result.outbound.action, result.action ?? null);
  assert.equal(result.outbound.handled, result.handled === true);
  assert.equal(result.outbound.terminalFailure, result.terminalFailure === true);
  assert.equal(result.outbound.retryable, result.retryable === true);
  assert.equal(
    result.outbound.finalReplySource,
    result.finalReplySource ?? null
  );
  assert.equal(result.outbound.bookingId, result.bookingId ?? null);
  assert.equal(
    result.outbound.availabilityRequestId,
    result.availabilityRequestId ?? null
  );
  assert.equal(
    result.replyEnvelope.text,
    typeof result.reply === "string" ? result.reply : ""
  );
  assert.equal(result.replyEnvelope.source, result.finalReplySource ?? null);
  assert.equal(
    result.execution.pendingAvr,
    result.pendingAvailabilityExecution ?? null
  );
  assert.equal(result.execution.mutation, result.mutationExecution ?? null);
  assert.equal("kind" in result.execution, false);
  assert.equal("result" in result.execution, false);
}

const BUSINESS_ID = "arch-business";
const CUSTOMER_PHONE = "923009998877";

function withFreshLedger(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emily-arch-ledger-"));
  const ledgerFile = path.join(dir, "ledger.json");
  __setInboundTurnLedgerPathForTests(ledgerFile);
  __clearInboundTurnLedgerForTests();
  return Promise.resolve()
    .then(() => run({ ledgerFile }))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

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
  {
    id: "stonic-white",
    name: "Kia Stonic",
    displayLabel: "Kia Stonic EX Plus 2021 White",
    aliases: ["Stonic", "Kia Stonic"],
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
  const stonic = {
    id: "booking-stonic",
    selectionIndex: 3,
    status: "approved",
    itemId: "stonic-white",
    itemLabel: "Kia Stonic EX Plus 2021 White",
    durationDays: 3,
    totalAmount: 16500,
    dailyRate: 5500,
    availabilityRequestId: "avr-stonic",
  };
  return {
    businessId: BUSINESS_ID,
    customerPhoneDigits: CUSTOMER_PHONE,
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: withFocus ? corolla : null,
    bookingCandidates: [civic, corolla, stonic],
    bookingFocus: withFocus
      ? {
          source: "latest_confirmed_linked_avr",
          confidence: "trusted",
          selectedBookingIndex: 2,
          selectedBookingId: "booking-corolla",
        }
      : null,
    activeBookings: [civic, corolla, stonic],
    known: { deliveryPolicy: "Delivery selected areas mein available hai." },
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: CATALOG,
      activeBookings: [civic, corolla, stonic],
      bookingExecutionVerified: true,
      knownPolicies: {
        deliveryPolicy: "Delivery selected areas mein available hai.",
      },
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

function emptyParams(overrides = {}) {
  return {
    ...emptyPostConfirmActionParameters(),
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

function decisionJson(overrides = {}) {
  const selectedIndex = Number(overrides.selectedBookingIndex ?? 1);
  const targetId = selectedIndex === 3 ? "booking-stonic" : "booking-corolla";
  const payload = {
    turnScope: "OLD_BOOKING_REFERENCE",
    targetContext: "CONFIRMED_BOOKING",
    targetId,
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
    actionParameters: emptyParams(),
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
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "factKind")) {
    payload.factKind = inferTestOnlyFactKind(payload);
  }
  return JSON.stringify(payload);
}

function infoDecisionJson(reply, overrides = {}) {
  const payload = {
    turnScope: "OLD_BOOKING_REFERENCE",
    targetContext: "CONFIRMED_BOOKING",
    targetId: "booking-only",
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
    customerReply: reply,
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    actionParameters: emptyParams(),
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
    ...overrides,
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "factKind")) {
    payload.factKind = inferTestOnlyFactKind(payload);
  }
  return JSON.stringify(payload);
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
  return { choices: [{ message: { content } }] };
}

test("supported mutation intents today are none; all intents return unsupported without data change", () => {
  assert.equal(POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS.length, 0);
  const facts = multiFacts({ withFocus: true });
  for (const mutationIntent of POST_CONFIRM_BOOKING_MUTATION_INTENTS) {
    const result = executePostConfirmBookingMutation({
      businessId: BUSINESS_ID,
      messageId: `no-exec-${mutationIntent}`,
      decision: {
        action: "request_booking_mutation",
        mutationIntent,
        bookingSelectionMode: "focused",
        selectedBookingIndex: 2,
        selectedBookingId: "booking-corolla",
        actionParameters: emptyParams(
          mutationIntent === "extend_booking" ? { extensionDays: 2 } : {}
        ),
      },
      facts,
      selectedBooking: facts.bookingCandidates[1],
    });
    assert.equal(result.status, "unsupported", mutationIntent);
    assert.equal(result.changedData, false, mutationIntent);
    assert.equal(result.unsupported, true, mutationIntent);
    assert.equal(result.idempotencyAuthority, "cloud_inbound_ledger");
  }
});

test("exact: 2 din aur extend kar do → focused unsupported, no data change", async () => {
  let decideCalls = 0;
  let composeCalls = 0;
  let executorCalls = 0;
  const safeReply = "Extend abhi complete nahi hua.";
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "2 din aur extend kar do",
    messageId: "msg-extend-2d",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: multiFacts({ withFocus: true }),
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      executorCalls += 1;
      assert.equal(args.decision.mutationIntent, "extend_booking");
      assert.equal(args.decision.actionParameters.extensionDays, 2);
      return executePostConfirmBookingMutation(args);
    },
    __chatCompletionsCreateForTests: async (args) => {
      const prompt = String(args?.messages?.[1]?.content ?? "");
      if (prompt.includes("FROZEN_DECISION_JSON")) {
        composeCalls += 1;
        assert.match(prompt, /"mutationIntent":"extend_booking"/);
        assert.match(prompt, /"extensionDays":2/);
        assert.match(prompt, /"status":"unsupported"/);
        return completion(composeJson(safeReply));
      }
      decideCalls += 1;
      return completion(
        decisionJson({
          mutationIntent: "extend_booking",
          bookingSelectionMode: "focused",
          actionParameters: emptyParams({ extensionDays: 2 }),
        })
      );
    },
  });
  assert.equal(decideCalls, 1);
  assert.equal(composeCalls, 1);
  assert.equal(executorCalls, 1);
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.bookingId, "booking-corolla");
  assert.equal(result.mutationExecutionStatus, "unsupported");
  assert.equal(result.mutationExecution?.changedData, false);
  assert.equal(result.reply, safeReply);
  assert.equal(result.sentReply, false);
  assertPostConfirmReturnContractParity(result);
  assert.equal(result.execution.mutation, result.mutationExecution);
  assert.equal(result.execution.pendingAvr, null);
  assert.equal(result.execution.missingInfo, null);
  assert.equal(result.decision.mutationIntent, "extend_booking");
});

test("exact: Kia Stonic ki booking cancel kar do → candidate, unsupported", async () => {
  const safeReply = "Stonic cancel abhi complete nahi hua.";
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Kia Stonic ki booking cancel kar do",
    messageId: "msg-cancel-stonic",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: multiFacts({ withFocus: true }),
    }),
    __chatCompletionsCreateForTests: async (args) => {
      const prompt = String(args?.messages?.[1]?.content ?? "");
      if (prompt.includes("FROZEN_DECISION_JSON")) {
        return completion(composeJson(safeReply));
      }
      return completion(
        decisionJson({
          mutationIntent: "cancel_booking",
          bookingSelectionMode: "candidate",
          selectedBookingIndex: 3,
          actionParameters: emptyParams(),
        })
      );
    },
  });
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.composeCalls, 1);
  assert.equal(result.bookingSelectionMode, "candidate");
  assert.equal(result.selectedBookingIndex, 3);
  assert.equal(result.bookingId, "booking-stonic");
  assert.equal(result.mutationExecutionStatus, "unsupported");
  assert.equal(result.mutationExecution?.changedData, false);
  assert.equal(result.reply, safeReply);
});

test("exact: Delivery add kar do → update_delivery unsupported, no data change", async () => {
  const safeReply = "Delivery add abhi complete nahi hua.";
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Delivery add kar do",
    messageId: "msg-delivery-add",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: multiFacts({ withFocus: true }),
    }),
    __chatCompletionsCreateForTests: async (args) => {
      const prompt = String(args?.messages?.[1]?.content ?? "");
      if (prompt.includes("FROZEN_DECISION_JSON")) {
        return completion(composeJson(safeReply));
      }
      return completion(
        decisionJson({
          mutationIntent: "update_delivery",
          bookingSelectionMode: "focused",
          actionParameters: emptyParams({
            deliveryRequested: true,
            deliveryAddress: null,
            deliveryTime: null,
          }),
        })
      );
    },
  });
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.mutationIntent, "update_delivery");
  assert.equal(result.bookingSelectionMode, "focused");
  assert.equal(result.bookingId, "booking-corolla");
  assert.equal(result.mutationExecutionStatus, "unsupported");
  assert.equal(result.mutationExecution?.changedData, false);
  assert.equal(
    result.mutationExecution?.actionParameters?.deliveryRequested,
    true
  );
  assert.equal(result.reply, safeReply);
});

test("exact: Delivery ho sakti hai? → read-only, no mutation executor", async () => {
  let executorCalls = 0;
  let informationalComposeCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Delivery ho sakti hai?",
    messageId: "msg-delivery-info",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: singleBookingFacts(),
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      executorCalls += 1;
      return executePostConfirmBookingMutation(args);
    },
    __composePostConfirmInformationalCustomerReplyFn: async (args) => {
      informationalComposeCalls += 1;
      assert.equal(args.frozenDecision.capability, "answer_from_business_profile");
      assert.equal(args.frozenDecision.customerReply, "");
      return {
        ok: true,
        reply: "Haan, selected areas mein delivery available hai.",
        source: "openai",
      };
    },
    __chatCompletionsCreateForTests: async () =>
      completion(
        infoDecisionJson("Haan, selected areas mein delivery available hai.", {
          requestedInformation: "delivery_policy",
          capability: "answer_from_business_profile",
          evidenceNeeds: [
            {
              entity: "business_profile",
              concept: "delivery",
              attributes: ["policy"],
            },
          ],
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
            policyClaims: [
              {
                key: "deliveryPolicy",
                value: "Delivery available in selected areas.",
              },
            ],
          },
        })
      ),
  });
  assert.equal(executorCalls, 0);
  assert.equal(informationalComposeCalls, 1);
  assert.equal(result.composeCalls, 1);
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal(result.mutationExecutionStatus, "not_executed");
  assert.equal(result.decisionAction, "reply");
  assert.match(result.reply, /delivery/i);
});

test("focused only with trusted current booking; none never auto-focuses; candidate for other booking", () => {
  const facts = multiFacts({ withFocus: true });
  const focused = resolvePostConfirmBookingSelection(
    {
      action: "request_booking_mutation",
      bookingSelectionMode: "focused",
      mutationIntent: "extend_booking",
    },
    facts
  );
  assert.equal(focused.ok, true);
  assert.equal(focused.mode, "focused");
  assert.equal(focused.booking?.id, "booking-corolla");

  const noneMode = resolvePostConfirmBookingSelection(
    {
      action: "request_booking_mutation",
      bookingSelectionMode: "none",
      mutationIntent: "cancel_booking",
    },
    facts
  );
  assert.equal(noneMode.ok, false);

  const candidate = resolvePostConfirmBookingSelection(
    {
      action: "request_booking_mutation",
      bookingSelectionMode: "candidate",
      selectedBookingIndex: 3,
      mutationIntent: "cancel_booking",
    },
    facts
  );
  assert.equal(candidate.ok, true);
  assert.equal(candidate.mode, "candidate");
  assert.equal(candidate.booking?.id, "booking-stonic");

  const focusedWithoutTrust = resolvePostConfirmBookingSelection(
    {
      action: "request_booking_mutation",
      bookingSelectionMode: "focused",
      mutationIntent: "cancel_booking",
    },
    multiFacts({ withFocus: false })
  );
  assert.equal(focusedWithoutTrust.ok, false);
});

test("composer cannot alter action, booking, mutationIntent, or actionParameters", async () => {
  let frozenSeen = null;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "2 din aur extend kar do",
    messageId: "msg-freeze-params",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: multiFacts({ withFocus: true }),
    }),
    __composePostConfirmMutationCustomerReplyFn: async (args) => {
      frozenSeen = args.frozenDecision;
      return {
        ok: true,
        reply: "Extend abhi complete nahi hua.",
        source: "openai",
        frozenDecision: {
          ...args.frozenDecision,
          mutationIntent: "cancel_booking",
          action: "reply",
          actionParameters: emptyParams({ extensionDays: 99 }),
          selectedBookingId: "booking-civic",
        },
      };
    },
    __chatCompletionsCreateForTests: async () =>
      completion(
        decisionJson({
          mutationIntent: "extend_booking",
          bookingSelectionMode: "focused",
          actionParameters: emptyParams({ extensionDays: 2 }),
        })
      ),
  });
  assert.equal(frozenSeen?.mutationIntent, "extend_booking");
  assert.equal(frozenSeen?.action, "request_booking_mutation");
  assert.equal(frozenSeen?.actionParameters?.extensionDays, 2);
  assert.equal(result.mutationIntent, "extend_booking");
  assert.equal(result.decisionAction, "request_booking_mutation");
  assert.equal(result.bookingId, "booking-corolla");
});

test("durable Cloud inbound ledger is the idempotency authority; executor has no process-local Map", async () => {
  assert.equal(
    typeof (
      await import("../src/services/postConfirmBookingMutationExecutor.js")
    ).__resetPostConfirmBookingMutationIdempotencyForTests,
    "undefined"
  );

  await withFreshLedger(async () => {
    const messageId = `ledger-dup-${Date.now()}`;
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId,
      recoveryContext: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: "cancel kar do",
        messageId,
      },
    });
    assert.equal(first.claimed, true);
    assert.equal(first.action, "process");
    const duplicateWhileProcessing = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId,
      recoveryContext: {
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText: "cancel kar do",
        messageId,
      },
    });
    assert.equal(duplicateWhileProcessing.claimed, false);
    assert.equal(duplicateWhileProcessing.action, "processing");

    const facts = multiFacts({ withFocus: true });
    const decision = {
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      bookingSelectionMode: "focused",
      selectedBookingIndex: 2,
      selectedBookingId: "booking-corolla",
      actionParameters: emptyParams(),
    };
    const a = executePostConfirmBookingMutation({
      businessId: BUSINESS_ID,
      messageId,
      decision,
      facts,
      selectedBooking: facts.bookingCandidates[1],
    });
    const b = executePostConfirmBookingMutation({
      businessId: BUSINESS_ID,
      messageId,
      decision,
      facts,
      selectedBooking: facts.bookingCandidates[1],
    });
    assert.equal(a.duplicateSuppressed, undefined);
    assert.equal(b.duplicateSuppressed, undefined);
    assert.equal(a.status, "unsupported");
    assert.equal(b.status, "unsupported");
    assert.equal(a.idempotencyAuthority, "cloud_inbound_ledger");
  });
});

test("compose rejects success claims and follow-up/timing promises when not succeeded", async () => {
  let attempts = 0;
  const composed = await composePostConfirmMutationCustomerReply({
    facts: multiFacts({ withFocus: true }),
    userMessage: "cancel kar do",
    frozenDecision: {
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      actionParameters: emptyParams(),
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
      return completion(composeJson("Cancel abhi complete nahi hua."));
    },
  });
  assert.equal(composed.ok, true);
  assert.equal(attempts, 2);
  assert.equal(composed.reply, "Cancel abhi complete nahi hua.");
  assert.equal(composed.frozenDecision.mutationIntent, "cancel_booking");
  assert.deepEqual(
    composed.frozenDecision.actionParameters,
    emptyParams()
  );

  let followupAttempts = 0;
  const followupRejected = await composePostConfirmMutationCustomerReply({
    facts: multiFacts({ withFocus: true }),
    userMessage: "cancel kar do",
    frozenDecision: {
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      actionParameters: emptyParams(),
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
      followupAttempts += 1;
      if (followupAttempts === 1) {
        return completion(composeJson("Owner follow-up jaldi hoga."));
      }
      return completion(composeJson("Cancel abhi complete nahi hua."));
    },
  });
  assert.equal(followupRejected.ok, true);
  assert.equal(followupAttempts, 2);
  assert.equal(followupRejected.reply, "Cancel abhi complete nahi hua.");
});

test("actionParameters normalize nullable typed fields without raw-text parsing", () => {
  const normalized = normalizePostConfirmActionParameters(
    {
      extensionDays: "2",
      startDate: "2026-08-01",
      endDate: null,
      durationDays: 5,
      itemId: "stonic-white",
      pickupDetails: "10 AM gate 2",
      deliveryRequested: true,
      deliveryAddress: null,
      deliveryTime: null,
      unknownKey: "drop-me",
    },
    "extend_booking"
  );
  assert.equal(normalized.extensionDays, 2);
  assert.equal(normalized.startDate, "2026-08-01");
  assert.equal(normalized.itemId, "stonic-white");
  assert.equal(normalized.unknownKey, undefined);
  assert.deepEqual(
    normalizePostConfirmActionParameters({ extensionDays: 2 }, "none"),
    emptyParams()
  );
});

test("return contract: pending AVR confirm/decline populate execution.pendingAvr", async () => {
  const pendingRow = {
    selectionIndex: 1,
    requestId: "avr-pending-1",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026",
    requestedDuration: 3,
    priceQuote: { total: 24000, dailyRate: 8000 },
    request: { id: "avr-pending-1" },
  };
  const factsWithPending = {
    ...multiFacts({ withFocus: false }),
    booking: null,
    bookingCandidates: [],
    pendingAvailabilityRequests: [pendingRow],
  };

  let decideCalls = 0;
  const confirm = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "haan confirm kar do",
    messageId: "msg-avr-confirm",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: factsWithPending,
    }),
    __executeAvailabilityCustomerConfirmBookingFn: async () => ({
      ok: true,
      bookingId: "booking-from-avr",
    }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: "Booking confirm ho gayi.",
      source: "openai",
    }),
    __decideCustomerTurnFn: async () => {
      decideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          turnScope: "PENDING_AVAILABILITY_REFERENCE",
          targetContext: "PENDING_AVAILABILITY",
          targetId: "avr-pending-1",
          situation: "pending_availability",
          conversationAct: "confirmation",
          customerIntent: "confirm_pending",
          action: "confirm_pending_availability",
          capability: "confirm_pending_availability",
          evidenceNeeds: [],
          pendingAvailabilitySelectionIndex: 1,
          informationalReplyDeferred: false,
          shouldReply: true,
          customerReply: "",
          mutationIntent: "none",
          bookingSelectionMode: "none",
          selectedBookingId: null,
        },
      };
    },
  });
  assert.equal(decideCalls, 1);
  assert.equal(confirm.pendingAvailabilityExecution?.status, "succeeded");
  assert.equal(confirm.reply, "Booking confirm ho gayi.");
  assert.equal(confirm.sentReply, false);
  assertPostConfirmReturnContractParity(confirm);
  assert.equal(confirm.execution.pendingAvr, confirm.pendingAvailabilityExecution);
  assert.equal(confirm.execution.mutation, null);
  assert.equal(confirm.execution.missingInfo, null);

  let declineDecideCalls = 0;
  const decline = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "nahi chahiye",
    messageId: "msg-avr-decline",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: factsWithPending,
    }),
    __executeAvailabilityCustomerDeclineFn: async () => ({ ok: true }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: "Theek hai, cancel kar diya.",
      source: "openai",
    }),
    __decideCustomerTurnFn: async () => {
      declineDecideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          turnScope: "PENDING_AVAILABILITY_REFERENCE",
          targetContext: "PENDING_AVAILABILITY",
          targetId: "avr-pending-1",
          situation: "pending_availability",
          conversationAct: "confirmation",
          customerIntent: "decline_pending",
          action: "decline_pending_availability",
          capability: "decline_pending_availability",
          evidenceNeeds: [],
          pendingAvailabilitySelectionIndex: 1,
          informationalReplyDeferred: false,
          shouldReply: true,
          customerReply: "",
          mutationIntent: "none",
          bookingSelectionMode: "none",
          selectedBookingId: null,
        },
      };
    },
  });
  assert.equal(declineDecideCalls, 1);
  assert.equal(decline.pendingAvailabilityExecution?.action, "decline_pending_availability");
  assertPostConfirmReturnContractParity(decline);
  assert.equal(decline.execution.pendingAvr, decline.pendingAvailabilityExecution);
  assert.equal(decline.execution.mutation, null);
  assert.equal(decline.execution.missingInfo, null);
});

test("return contract: pending AVR + missing-info coexistence exposes both slots", async () => {
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";

  const pendingRow = {
    selectionIndex: 1,
    requestId: "avr-pending-1",
    itemId: "civic-2026",
    itemLabel: "Honda Civic 2026",
    requestedDuration: 3,
    priceQuote: { total: 24000, dailyRate: 8000 },
    request: { id: "avr-pending-1" },
  };
  const factsWithPending = {
    ...multiFacts({ withFocus: false }),
    booking: null,
    bookingCandidates: [],
    pendingAvailabilityRequests: [pendingRow],
  };

  const advanceDecision = {
    turnScope: "OLD_BOOKING_REFERENCE",
    targetContext: "CONFIRMED_BOOKING",
    targetId: "booking-from-avr",
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    capability: "answer_from_business_profile",
    evidenceNeeds: [
      {
        entity: "business_profile",
        concept: "advance",
        attributes: ["amount", "policy"],
      },
    ],
    requestedInformation: null,
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
    selectedBookingId: "booking-from-avr",
  };

  let decideCalls = 0;
  const escalateResult = {
    missingInfoEscalated: true,
    missingInfoRequestId: "req-after-avr",
    missingInfoType: "advance",
    ownerNotifyStatus: "sent",
    ownerCheckAuthorized: true,
    ownerCheckPending: false,
  };

  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Advance kitna?",
    messageId: "msg-avr-mi-coexist",
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: factsWithPending,
    }),
    __executeAvailabilityCustomerConfirmBookingFn: async () => ({
      ok: true,
      bookingId: "booking-from-avr",
    }),
    __decideCustomerTurnFn: async () => {
      decideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          turnScope: "PENDING_AVAILABILITY_REFERENCE",
          targetContext: "PENDING_AVAILABILITY",
          targetId: "avr-pending-1",
          situation: "pending_availability",
          conversationAct: "confirmation",
          customerIntent: "confirm_pending",
          action: "confirm_pending_availability",
          capability: "confirm_pending_availability",
          evidenceNeeds: [],
          pendingAvailabilitySelectionIndex: 1,
          informationalReplyDeferred: false,
          shouldReply: true,
          customerReply: "",
          mutationIntent: "none",
          bookingSelectionMode: "none",
          selectedBookingId: null,
        },
      };
    },
    __resolvePostConfirmRequestedFactFn: () => ({
      status: "not_found",
      missingInfoType: "advance",
      verifiedValue: null,
      factAvailable: false,
    }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: true,
      reply: "Main yeh detail confirm karke batata hun.",
      source: "openai",
    }),
    __executePostConfirmPaMissingInfoOwnerCheckFn: async () => escalateResult,
  });

  assert.equal(decideCalls, 1);
  assert.ok(result.pendingAvailabilityExecution);
  assert.equal(result.missingInfoEscalated, false);
  assert.equal(result.execution.mutation, null);
  assert.equal(result.execution.pendingAvr, result.pendingAvailabilityExecution);
  assert.equal(result.semanticDecisionCount, 1);
  assert.equal("kind" in result.execution, false);
  assert.equal("result" in result.execution, false);
  assertPostConfirmReturnContractParity(result);
});
