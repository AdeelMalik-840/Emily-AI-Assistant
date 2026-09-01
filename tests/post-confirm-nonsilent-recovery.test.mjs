/**
 * Post-confirm: empty/invalid OpenAI decide must recover or stay retryable —
 * never intentional silent / silent_noop for trusted-focus questions.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  executePostConfirmPaLaneDecision,
  classifyPostConfirmOpenAiUsabilityFailure,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  canonicalOldBookingOwnership,
  canonicalSocialOwnership,
  CANONICAL_OWNERSHIP_TURN_ID,
} = await import("./helpers/canonicalPostConfirmFixture.mjs");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  isIntentionalSilentInboundResult,
} = await import("../src/services/whatsappInboundBuffer.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STONIC_ITEM_ID = "test-stonic-item";

function focusedFacts(known = {}) {
  const stonic = {
    id: "test-booking-stonic",
    selectionIndex: 1,
    customerSafeReference: "STONIC-4",
    status: "approved",
    itemId: STONIC_ITEM_ID,
    itemLabel: "Kia Stonic",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    availabilityRequestId: "test-avr-stonic",
  };
  return {
    businessId: "test-business",
    customerPhoneDigits: "923001234567",
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: stonic,
    bookingCandidates: [stonic],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: stonic.id,
    },
    activeBookings: [stonic],
    availabilityRequest: {
      id: "test-avr-stonic",
      itemId: STONIC_ITEM_ID,
      itemLabel: "Kia Stonic",
      requestedDuration: 4,
      status: "approved",
    },
    known,
    pendingAvailabilityRequests: [],
    mutationExecution: {
      requested: false,
      status: "not_executed",
      intent: "none",
    },
    replyGuardFacts: {
      catalogItems: [
        { id: STONIC_ITEM_ID, name: "Kia Stonic", aliases: ["Stonic"] },
      ],
      activeBookings: [stonic],
      knownPolicies: { ...known },
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
    currentOwnershipTurnId: CANONICAL_OWNERSHIP_TURN_ID,
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
    ...canonicalOldBookingOwnership({ bookingId: "test-booking-stonic" }),
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

function socialSilenceDecision() {
  return decision({
    ...canonicalSocialOwnership(),
    situation: "conversation_closing",
    conversationAct: "thanks",
    customerIntent: "thanks",
    customerIsAskingQuestion: false,
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

async function runDecide(responses, options = {}) {
  const calls = [];
  let index = 0;
  const result = await executePostConfirmPaLaneDecision({
    facts: options.facts || focusedFacts(),
    userMessage: options.userMessage || "Delivery ho skti hai?",
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

test("1. trusted factual question returns deferred Turn Plan, no mutation", async () => {
  const { result, calls } = await runDecide([
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
          {
            key: "deliveryPolicy",
            value: "Delivery selected areas mein available hai.",
          },
        ],
      }),
    }),
  ], {
    facts: focusedFacts({
      deliveryPolicy: "Delivery selected areas mein available hai.",
    }),
  });
  assert.equal(calls.length, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_business_profile");
  assert.equal(result.decision.mutationIntent, "none");
});

test("2. first attempts malformed, deferred Turn Plan in recovery stays retryable", async () => {
  const { result, calls } = await runDecide(
    [
      "",
      "{bad",
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
            {
              key: "deliveryPolicy",
              value: "Delivery selected areas mein available hai.",
            },
          ],
        }),
      }),
    ],
    {
      facts: focusedFacts({
        deliveryPolicy: "Delivery selected areas mein available hai.",
      }),
    }
  );
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.retryable, false);
  assert.equal(result.usabilityClassification, "malformed_json");
});

test("3. delivery fact missing Turn Plan in recovery stays retryable", async () => {
  const clarification =
    "Delivery detail abhi confirm nahi hai. Kis area ke liye pooch rahe hain?";
  const { result } = await runDecide(
    [
      "",
      "",
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
        customerReply: clarification,
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { facts: focusedFacts({}) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.retryable, false);
  assert.equal(result.usabilityClassification, "empty_content");
});

test("4. all attempts fail → retryable, not intentionalSilent/silent_noop", async () => {
  const { result, calls } = await runDecide(["", "", ""]);
  assert.equal(calls.length, 2);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.reason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(result.usabilityClassification, "empty_content");

  const agent = await handleCustomerBusinessPaInbound({
    businessId: "test-business",
    customerPhone: "923001234567",
    messageText: "Delivery ho skti hai?",
    preResolvedBookingFacts: { ok: true, facts: focusedFacts() },
    __decideCustomerTurnFn: async () => result,
  });
  assert.equal(agent.retryable, false);
  assert.equal(agent.terminalFailure, true);
  assert.equal(agent.sentReply, false);

  assert.equal(
    isIntentionalSilentInboundResult({
      sendVia: "NONE",
      messageMeta: {
        handledWithoutOutbound: true,
        outboundTrace: { kind: "silent_noop" },
      },
    }),
    true
  );
  // Buffer must not build that meta for terminalFailure anymore.
  const bufferSrc = readFileSync(
    join(ROOT, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  const terminalBlock = bufferSrc.slice(
    bufferSrc.indexOf("if (businessPaResult.terminalFailure === true)"),
    bufferSrc.indexOf("reply = String(businessPaResult.reply")
  );
  assert.match(terminalBlock, /throw new Error/);
  assert.doesNotMatch(terminalBlock, /silent_noop/);
  assert.doesNotMatch(terminalBlock, /handledWithoutOutbound: true/);
});

test("5. explicit valid semantic silence still works", async () => {
  const { result, calls } = await runDecide(
    [socialSilenceDecision(), socialSilenceDecision()],
    { userMessage: "Thanks" }
  );
  assert.ok(calls.length >= 1 && calls.length <= 2);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "silence");
  assert.equal(result.decision.shouldReply, false);
  assert.equal(result.decision.customerReply, "");
});

test("6. usability classifier privacy-safe buckets", () => {
  assert.equal(classifyPostConfirmOpenAiUsabilityFailure(""), "empty_content");
  assert.equal(
    classifyPostConfirmOpenAiUsabilityFailure("{not json"),
    "malformed_json"
  );
  assert.equal(
    classifyPostConfirmOpenAiUsabilityFailure(
      JSON.stringify({
        action: "reply",
        shouldReply: true,
        customerReply: "",
        mutationIntent: "none",
      })
    ),
    "empty_required_reply"
  );
});

test("static: buffer no longer maps post-confirm terminalFailure to silent_noop", () => {
  const src = readFileSync(
    join(ROOT, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  assert.doesNotMatch(
    src,
    /terminalFailure === true[\s\S]{0,400}silent_noop/
  );
});
