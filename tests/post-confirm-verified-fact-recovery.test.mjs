/**
 * Post-confirm verified-fact recovery: same-lane correction for verified_*
 * claim mismatches + durable non-auto-retry after exhaustion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  executePostConfirmPaLaneDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  validateCustomerReplyAgainstContract,
  isVerifiedCustomerClaimMismatchReason,
  buildCustomerReplyGuardCorrection,
} = await import("../src/brain/guards/customerReplyGuard.js");
const {
  shouldPauseCloudPostConfirmModelContractAutoRetry,
  isPostConfirmModelContractFailureError,
  isCloudPostConfirmAutoRetryEnabled,
} = await import("../src/services/whatsappInboundBuffer.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STONIC_ITEM_ID = "test-stonic-item";

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

function focusedFacts(known = {}, bookingOverrides = {}) {
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
    pickupTime: null,
    deliveryTime: null,
    ...bookingOverrides,
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

function decision(overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: null,
    factKind: null,
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
    userMessage: options.userMessage || "Kitny din k lye booking hui hai?",
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

test("source: verified factual grounding + verified_* correction + pause list", () => {
  const decideSrc = readFileSync(
    join(ROOT, "src/brain/decisions/decidePostConfirmCustomerDm.js"),
    "utf8"
  );
  const guardSrc = readFileSync(
    join(ROOT, "src/brain/guards/customerReplyGuard.js"),
    "utf8"
  );
  const bufferSrc = readFileSync(
    join(ROOT, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  assert.match(decideSrc, /buildPostConfirmVerifiedClaimGuardCorrection/);
  assert.match(
    decideSrc,
    /capability \+ evidenceNeeds|Turn Plan capability/
  );
  assert.match(decideSrc, /resolvePostConfirmRequestedFact\.js/);
  assert.match(decideSrc, /isDeferredPostConfirmInformationalDecision/);
  assert.match(decideSrc, /FACTUAL_TURN_PLAN_REQUIRED/);
  assert.match(guardSrc, /isVerifiedCustomerClaimMismatchReason/);
  assert.match(guardSrc, /VERIFIED CLAIM MISMATCH/);
  assert.match(bufferSrc, /verified_booking_time_mismatch/);
  assert.doesNotMatch(
    decideSrc,
    /validateCustomerReplyAgainstContract\(\s*replyText[\s\S]*?finalized\.groundedFacts/
  );
});

test("verified claim mismatch reasons helper covers required set", () => {
  for (const reason of [
    "verified_item_mismatch",
    "verified_duration_mismatch",
    "verified_booking_status_mismatch",
    "verified_booking_reference_mismatch",
    "verified_price_mismatch",
    "verified_booking_date_mismatch",
    "verified_booking_time_mismatch",
    "verified_policy_mismatch",
  ]) {
    assert.equal(isVerifiedCustomerClaimMismatchReason(reason), true, reason);
  }
  assert.equal(isVerifiedCustomerClaimMismatchReason("near_echo_reply"), false);
  const correction = buildCustomerReplyGuardCorrection(
    "verified_booking_time_mismatch"
  );
  assert.match(correction, /never invent a substitute/i);
  assert.match(correction, /not confirmed/i);
  assert.match(correction, /No silence, no mutation/i);
});

function bookingEvidence(concept, attributes, extra = {}) {
  return {
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      {
        entity: "active_booking",
        concept,
        attributes,
      },
    ],
    requestedInformation: null,
    customerReply: "",
    ...extra,
  };
}

test("A. missing pickup location: invent without Turn Plan corrected to deferred plan", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Pickup office pe 10am hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          pickupTime: "10am",
        }),
      }),
      decision(
        bookingEvidence("pickup", ["location"], {
          groundedFacts: groundedFacts({
            itemId: STONIC_ITEM_ID,
            durationDays: 4,
          }),
        })
      ),
    ],
    { userMessage: "pickup k lye kahan ana ho ga?" }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_active_booking");
  assert.equal(result.decision.evidenceNeeds?.[0]?.concept, "pickup");
  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correctionPrompt, /FACTUAL_TURN_PLAN_REQUIRED|capability|evidenceNeeds|factKind/i);
  assert.match(correctionPrompt, /customerReply MUST be empty/i);
  assert.match(correctionPrompt, /factKind/i);
  assert.match(correctionPrompt, /booking_fact|Active booking fields/i);
});

test("B. missing advance/deposit fact: invent without Turn Plan corrected to deferred plan", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Advance 15000 PKR dena hoga.",
        requestedInfoType: "advance",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          advanceAmount: 15000,
        }),
      }),
      decision({
        factKind: "advance",
        capability: "answer_from_business_profile",
        evidenceNeeds: [
          {
            entity: "business_profile",
            concept: "advance",
            attributes: ["amount", "policy"],
          },
        ],
        customerReply: "",
        requestedInfoType: "advance",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
        }),
      }),
    ],
    {
      facts: focusedFacts({}),
      userMessage: "Advance kitna dena hoga?",
    }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_business_profile");
  const correctionPrompt = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correctionPrompt, /capability|evidenceNeeds|factKind/i);
  assert.match(correctionPrompt, /customerReply MUST be empty/i);
  assert.match(correctionPrompt, /factKind/i);
  assert.match(correctionPrompt, /advance|booking_fact|freeform_business/i);
});

test("C. verified pickupTime ask defers via Turn Plan (wording after resolve)", async () => {
  const { result, calls } = await runDecide(
    [
      decision(
        bookingEvidence("pickup", ["time"], {
          groundedFacts: groundedFacts({
            itemId: STONIC_ITEM_ID,
            durationDays: 4,
            pickupTime: "10am",
          }),
        })
      ),
    ],
    {
      facts: focusedFacts({}, { pickupTime: "10am" }),
      userMessage: "Pickup time kya hai?",
    }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.capability, "answer_from_active_booking");
});

test("D. factual ask without Turn Plan fails closed after correction exhaustion", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Pickup 10am hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
        }),
      }),
      decision({
        customerReply: "Pickup 11am pe aana hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
        }),
      }),
    ],
    { userMessage: "Pickup time?" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "FACTUAL_TURN_PLAN_REQUIRED");
  assert.equal(result.retryable, false);
  assert.equal(calls.length, 2);
});

test("E. price/duration invents without Turn Plan correct then defer", async () => {
  const price = await runDecide(
    [
      decision({
        customerReply: "Total 99999 PKR hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          totalAmount: 22000,
        }),
      }),
      decision(
        bookingEvidence("price", ["total", "daily"], {
          groundedFacts: groundedFacts({
            itemId: STONIC_ITEM_ID,
            durationDays: 4,
            totalAmount: 22000,
          }),
        })
      ),
    ],
    { userMessage: "Total kitna hai?" }
  );
  assert.equal(price.result.ok, true);
  assert.equal(price.calls.length, 2);
  assert.equal(price.result.decision.customerReply, "");
  assert.equal(price.result.decision.informationalReplyDeferred, true);
  assert.match(
    String(price.calls[1]?.messages?.[1]?.content || ""),
    /capability|evidenceNeeds/i
  );

  const duration = await runDecide(
    [
      decision({
        customerReply: "Kia Stonic 7 din ke liye book hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
        }),
      }),
      decision(
        bookingEvidence("duration", ["days"], {
          groundedFacts: groundedFacts({
            itemId: STONIC_ITEM_ID,
            durationDays: 4,
          }),
        })
      ),
    ],
    { userMessage: "Kitny din k lye booking hui hai?" }
  );
  assert.equal(duration.result.ok, true);
  assert.equal(duration.calls.length, 2);
  assert.equal(duration.result.decision.customerReply, "");
  assert.equal(duration.result.decision.informationalReplyDeferred, true);
});

test("F. social hello? normal reply without invented facts", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        situation: "unclear",
        conversationAct: "chit_chat",
        customerIntent: "unclear",
        customerIsAskingQuestion: false,
        capability: "social",
        evidenceNeeds: [],
        customerReply: "Ji, boliye",
        action: "reply",
        groundedFacts: groundedFacts({ pickupTime: "10am" }),
      }),
    ],
    { userMessage: "hello?" }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(result.decision.customerReply, "Ji, boliye");
});

test("G. exhausted verified_* mismatch is paused from cloud auto-retry", () => {
  const prev = process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
  try {
    delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    assert.equal(isCloudPostConfirmAutoRetryEnabled(), false);
    assert.equal(
      isPostConfirmModelContractFailureError("verified_booking_time_mismatch"),
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
        "verified_duration_mismatch"
      ),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry("socket hang up"),
      false
    );
  } finally {
    if (prev === undefined) delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    else process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = prev;
  }
});

test("H. mutation decide→execute→compose still runs after recovery changes", async () => {
  let executorCalls = 0;
  let composeCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "test-business",
    customerPhone: "923001234567",
    messageText: "2 din aur extend kar do",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts: focusedFacts(),
    }),
    __executePostConfirmBookingMutationFn: (args) => {
      executorCalls += 1;
      assert.equal(args?.decision?.mutationIntent, "extend_booking");
      assert.equal(args?.decision?.actionParameters?.extensionDays, 2);
      return {
        ok: true,
        status: "unsupported",
        intent: "extend_booking",
        changedData: false,
        actionParameters: args?.decision?.actionParameters ?? null,
      };
    },
    __composePostConfirmMutationCustomerReplyFn: async () => {
      composeCalls += 1;
      return {
        ok: true,
        reply: "Extend abhi complete nahi hua.",
        source: "openai",
      };
    },
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: decision({
              situation: "protected_action",
              conversationAct: "action_request",
              customerIntent: "ask_action",
              customerIsAskingQuestion: false,
              shouldReply: true,
              customerReply: "",
              action: "request_booking_mutation",
              mutationIntent: "extend_booking",
              mutationExecutionRequested: true,
              actionParameters: {
                extensionDays: 2,
                startDate: null,
                endDate: null,
                durationDays: null,
                itemId: null,
                pickupDetails: null,
                deliveryRequested: null,
                deliveryAddress: null,
                deliveryTime: null,
              },
            }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.decisionAction, "request_booking_mutation");
  assert.equal(result.mutationIntent, "extend_booking");
  assert.equal(executorCalls, 1);
  assert.equal(composeCalls, 1);
  assert.equal(result.reply, "Extend abhi complete nahi hua.");
});

test("claim-level guard still blocks unsupported visible clocks (no weaken)", () => {
  const contract = {
    channel: "dm",
    replyRequired: true,
    allowedClaims: [],
    forbiddenClaims: [],
    verifiedCustomerFacts: {
      catalogItems: [
        { id: STONIC_ITEM_ID, name: "Kia Stonic", aliases: ["Stonic"] },
      ],
      activeBookings: [
        {
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          status: "approved",
          totalAmount: 22000,
          pickupTime: null,
          deliveryTime: null,
        },
      ],
    },
  };
  const semantics = {
    claims: [],
    languageStyle: "roman_urdu",
    containsTimingPromise: false,
    exposesInternalProcess: false,
  };
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Pickup 10am hai.",
      contract,
      semantics
    ).reason,
    "verified_booking_time_mismatch"
  );
  assert.deepEqual(
    validateCustomerReplyAgainstContract(
      "Pickup location abhi confirm nahi hai.",
      contract,
      semantics
    ),
    { ok: true }
  );
});
