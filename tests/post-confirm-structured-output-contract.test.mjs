/**
 * Post-confirm structured-output contract: token budget, empty-reply hole,
 * informational vs update_delivery guidance, PR #81 recovery preserved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  executePostConfirmPaLaneDecision,
  parsePostConfirmCustomerDmDecision,
  classifyPostConfirmOpenAiUsabilityFailure,
  POST_CONFIRM_DECISION_MAX_TOKENS,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  shouldPauseCloudPostConfirmModelContractAutoRetry,
  isCloudPostConfirmAutoRetryEnabled,
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
    startDate: "2026-08-05",
    endDate: "2026-08-09",
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
      return { choices: [{ message: { content }, finish_reason: "stop" }] };
    },
  });
  return { result, calls };
}

test("token budget constant is the harness-proven safe value", () => {
  assert.equal(POST_CONFIRM_DECISION_MAX_TOKENS, 600);
  const src = readFileSync(
    join(ROOT, "src/brain/decisions/decidePostConfirmCustomerDm.js"),
    "utf8"
  );
  assert.match(src, /max_tokens:\s*POST_CONFIRM_DECISION_MAX_TOKENS/);
  assert.doesNotMatch(src, /max_tokens:\s*300\b/);
});

test("schema/prompt close empty-reply hole and clarify informational delivery", () => {
  const src = readFileSync(
    join(ROOT, "src/brain/decisions/decidePostConfirmCustomerDm.js"),
    "utf8"
  );
  assert.match(src, /MUST be non-empty when action=reply/);
  assert.match(src, /CUSTOMER_REPLY CONTRACT/);
  assert.match(src, /INFORMATIONAL VS MUTATION/);
  assert.match(src, /yes\/no availability question is NOT a mutation/i);
  assert.match(
    src,
    /customerReply:\s*\{[\s\S]*?description:[\s\S]*?MUST be non-empty when action=reply/
  );
});

test("2. informational delivery question → reply, non-empty, mutationIntent=none", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
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
        replySemantics: {
          claims: [],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }),
    ],
    {
      facts: focusedFacts({
        deliveryPolicy: "Delivery selected areas mein available hai.",
      }),
      userMessage: "Delivery ho skti hai?",
    }
  );
  assert.ok(calls.length >= 1 && calls.length <= 3);
  assert.equal(calls[0].max_tokens, 600);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "reply");
  assert.ok(String(result.decision.customerReply).trim().length > 0);
  assert.equal(result.decision.mutationIntent, "none");
});

test("3. missing delivery fact → non-empty clarification, no invented claim", async () => {
  const clarification =
    "Delivery detail abhi confirm nahi hai. Kis area ke liye pooch rahe hain?";
  const { result } = await runDecide(
    [
      decision({
        customerReply: clarification,
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { facts: focusedFacts({}), userMessage: "Delivery ho skti hai?" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.customerReply, clarification);
  assert.equal(result.decision.mutationIntent, "none");
  assert.doesNotMatch(
    String(result.decision.customerReply),
    /available hai|ho sakti|possible/i
  );
});

test("4. real delivery-change request still classifies as update_delivery", async () => {
  const { result } = await runDecide(
    [
      decision({
        situation: "protected_action",
        conversationAct: "action_request",
        customerIntent: "ask_action",
        customerIsAskingQuestion: false,
        shouldReply: true,
        customerReply: "",
        action: "request_booking_mutation",
        mutationIntent: "update_delivery",
        mutationExecutionRequested: true,
        actionParameters: {
          extensionDays: null,
          startDate: null,
          endDate: null,
          durationDays: null,
          itemId: null,
          pickupDetails: null,
          deliveryRequested: true,
          deliveryAddress: "DHA Phase 5",
          deliveryTime: "5pm",
        },
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { userMessage: "Delivery DHA Phase 5 pe 5pm set kar do" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "request_booking_mutation");
  assert.equal(result.decision.mutationIntent, "update_delivery");
  assert.equal(result.decision.customerReply, "");
});

test("5. empty customerReply for action=reply rejected by parser validation", () => {
  const raw = decision({ customerReply: "", shouldReply: true, action: "reply" });
  assert.equal(classifyPostConfirmOpenAiUsabilityFailure(raw), "empty_required_reply");
  assert.equal(
    parsePostConfirmCustomerDmDecision(raw, {
      userMessage: "Delivery ho skti hai?",
    }),
    null
  );
});

test("6. truncation simulation → malformed_json; PR81 recovery still runs", async () => {
  const truncated =
    '{"situation":"new_question","conversationAct":"information_request","customerIntent":"ask_fact","shouldReply":true,"customerReply":"Delivery selected areas","action":"reply","mutationIntent":"none","groundedFacts":{"itemId":"x","durationDays":4';
  assert.equal(classifyPostConfirmOpenAiUsabilityFailure(truncated), "malformed_json");

  const { result, calls } = await runDecide(
    [
      truncated,
      truncated,
      decision({
        customerReply: "Delivery detail abhi confirm nahi hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { facts: focusedFacts({}), userMessage: "Delivery ho skti hai?" }
  );
  assert.equal(calls.length, 3);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "reply");
  assert.ok(String(result.decision.customerReply).trim().length > 0);
  assert.equal(result.decision.mutationIntent, "none");
  const recoveryPrompt = String(calls[2]?.messages?.[1]?.content || "");
  assert.match(recoveryPrompt, /empty\/invalid output recovery/i);
});

test("temporary auto-retry pause gate for model-contract failures", () => {
  const prev = process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
  try {
    delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    assert.equal(isCloudPostConfirmAutoRetryEnabled(), false);
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "EMPTY_OR_INVALID_OPENAI_REPLY"
      ),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "OPENAI_POST_CONFIRM_FAILED"
      ),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "verified_booking_time_mismatch"
      ),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "verified_price_mismatch"
      ),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry("network_timeout"),
      false
    );

    process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = "1";
    assert.equal(isCloudPostConfirmAutoRetryEnabled(), true);
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "EMPTY_OR_INVALID_OPENAI_REPLY"
      ),
      false
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "verified_booking_time_mismatch"
      ),
      false
    );
  } finally {
    if (prev === undefined) delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    else process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = prev;
  }
});

const hasLiveKey =
  Boolean(process.env.OPENAI_API_KEY) &&
  process.env.OPENAI_API_KEY !== "test-key" &&
  String(process.env.OPENAI_API_KEY).length > 20;

test(
  "1. live-like strict schema completes under new token budget (finish_reason != length)",
  { skip: !hasLiveKey },
  async () => {
    await import("dotenv/config");
    const { resolveOpenAiChatCompletionsCreate } = await import(
      "../src/services/openaiChatCompletionsCreate.js"
    );
    const realCreate = resolveOpenAiChatCompletionsCreate();
    assert.ok(realCreate, "expected live completion fn");

    const finishReasons = [];
    const result = await executePostConfirmPaLaneDecision({
      facts: focusedFacts({
        deliveryPolicy:
          "Delivery selected areas mein available hai. Charges location pe depend karte hain.",
      }),
      userMessage: "Delivery ho skti hai?",
      conversationHistory:
        "Assistant: Kia Stonic 4 din ke liye confirm ho chuki hai.",
      timeoutMs: 25000,
      __chatCompletionsCreateForTests: async (args) => {
        assert.equal(args.max_tokens, POST_CONFIRM_DECISION_MAX_TOKENS);
        assert.equal(args.response_format?.type, "json_schema");
        assert.equal(args.response_format?.json_schema?.strict, true);
        const resp = await realCreate(args);
        finishReasons.push(resp?.choices?.[0]?.finish_reason ?? null);
        return resp;
      },
    });

    assert.ok(finishReasons.length >= 1);
    for (const reason of finishReasons) {
      assert.notEqual(reason, "length");
    }
    assert.equal(result.ok, true);
    assert.equal(result.decision.action, "reply");
    assert.ok(String(result.decision.customerReply || "").trim().length > 0);
    assert.equal(result.decision.mutationIntent, "none");
  }
);
