/**
 * Post-confirm informational replies: claim-level text guard only.
 * Model-declared groundedFacts must not be a fatal acceptance channel.
 * Mutations keep decide → execute → compose unchanged.
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
const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STONIC_ITEM_ID = "test-stonic-item";
const CIVIC_ITEM_ID = "civic-2026";
const COROLLA_ITEM_ID = "corolla-grey";

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

function multiBookingFacts() {
  const civic = {
    id: "booking-civic",
    selectionIndex: 1,
    customerSafeReference: "CIVIC-5",
    status: "approved",
    itemId: CIVIC_ITEM_ID,
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
    itemId: COROLLA_ITEM_ID,
    itemLabel: "Toyota Corolla Metallic Grey",
    durationDays: 4,
    totalAmount: 20000,
    dailyRate: 5000,
    availabilityRequestId: "avr-corolla",
  };
  return {
    businessId: "test-business",
    customerPhoneDigits: "923001234567",
    business: { name: "Emily Rentals", tone: "friendly" },
    booking: corolla,
    bookingCandidates: [civic, corolla],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 2,
      selectedBookingId: corolla.id,
    },
    activeBookings: [civic, corolla],
    known: {},
    pendingAvailabilityRequests: [],
    replyGuardFacts: {
      catalogItems: [
        {
          id: CIVIC_ITEM_ID,
          name: "Honda Civic 2026",
          aliases: ["Civic"],
        },
        {
          id: COROLLA_ITEM_ID,
          name: "Toyota Corolla Metallic Grey",
          aliases: ["Corolla"],
        },
      ],
      activeBookings: [civic, corolla],
      knownPolicies: {},
    },
    policy: {
      readOnly: true,
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

test("source: informational path does not pass groundedFacts as fatal 4th arg", () => {
  const src = readFileSync(
    join(ROOT, "src/brain/decisions/decidePostConfirmCustomerDm.js"),
    "utf8"
  );
  assert.match(
    src,
    /Do not pass model groundedFacts as a 4th fatal channel/
  );
  assert.match(
    src,
    /Model-declared row\.groundedFacts is not a fatal acceptance channel/
  );
  assert.doesNotMatch(
    src,
    /validateCustomerReplyAgainstContract\(\s*replyText[\s\S]*?finalized\.groundedFacts/
  );
  assert.doesNotMatch(
    src,
    /validateCustomerReplyAgainstContract\(\s*segment[\s\S]*?row\?\.groundedFacts/
  );
});

test("1. pickup location Q: irrelevant groundedFacts.pickupTime does not reject", async () => {
  const reply = "Pickup location abhi confirm nahi hai.";
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: reply,
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
          pickupTime: "10:00 AM",
        }),
      }),
    ],
    { userMessage: "pickup k lye kahan ana ho ga" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, reply);
  assert.equal(result.decision.mutationIntent, "none");
  assert.notEqual(result.reason, "verified_booking_time_mismatch");
  assert.ok(calls.length >= 1);
});

test("2. social hello?: irrelevant pickupTime does not cause time mismatch", async () => {
  const reply = "Ji, boliye";
  const { result } = await runDecide(
    [
      decision({
        situation: "unclear",
        conversationAct: "chit_chat",
        customerIntent: "unclear",
        customerIsAskingQuestion: false,
        customerReply: reply,
        action: "reply",
        groundedFacts: groundedFacts({
          pickupTime: "09:30",
          deliveryTime: "18:00",
        }),
      }),
    ],
    { userMessage: "hello?" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, reply);
  assert.notEqual(result.reason, "verified_booking_time_mismatch");
});

test("3. Delivery ho skti hai? policy reply; mutationIntent none; no hidden-field reject", async () => {
  const reply = "Delivery selected areas mein available hai.";
  const { result } = await runDecide(
    [
      decision({
        customerReply: reply,
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
          pickupTime: "10am",
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
      userMessage: "Delivery ho skti hai?",
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "reply");
  assert.equal(result.decision.customerReply, reply);
  assert.equal(result.decision.mutationIntent, "none");
  assert.notEqual(result.reason, "verified_booking_time_mismatch");
});

test("4a. duration question: wrong duration in reply still rejected", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Kia Stonic 7 din ke liye book hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
      decision({
        customerReply: "Kia Stonic 4 din ke liye book hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { userMessage: "Kitny din k lye booking hui hai?" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, "Kia Stonic 4 din ke liye book hai.");
  assert.ok(calls.length >= 2);
});

test("4b. duration question: correct duration passes even with junk groundedFacts times", async () => {
  const reply = "Kia Stonic 4 din ke liye book hai.";
  const { result } = await runDecide(
    [
      decision({
        customerReply: reply,
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
          pickupTime: "11:00",
          deliveryTime: "19:00",
        }),
      }),
    ],
    { userMessage: "Kitny din k lye booking hui hai?" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, reply);
});

test("5. explicit unverified time claim in reply text still rejected", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Pickup 10am hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
          pickupTime: null,
        }),
      }),
      decision({
        customerReply: "Pickup time abhi confirm nahi hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          bookingStatus: "approved",
        }),
      }),
    ],
    { userMessage: "Pickup time kya hai?" }
  );
  assert.equal(result.ok, true);
  assert.equal(
    result.decision.customerReply,
    "Pickup time abhi confirm nahi hai."
  );
  assert.ok(calls.length >= 2);
});

test("6. explicit wrong price in reply text still rejected", async () => {
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: "Total 99999 PKR hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          totalAmount: 22000,
        }),
      }),
      decision({
        customerReply: "Total 22000 PKR hai.",
        groundedFacts: groundedFacts({
          itemId: STONIC_ITEM_ID,
          durationDays: 4,
          totalAmount: 22000,
        }),
      }),
    ],
    { userMessage: "Total kitna hai?" }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, "Total 22000 PKR hai.");
  assert.ok(calls.length >= 2);
});

test("7. mutation path still freezes decision and skips informational reply guard", async () => {
  let composeCalls = 0;
  let executorCalls = 0;
  const facts = focusedFacts();
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "test-business",
    customerPhone: "923001234567",
    messageText: "Delivery DHA Phase 5 pe kar do 5pm",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      reason: "MATCHED",
      facts,
    }),
    __executePostConfirmBookingMutationFn: async (args) => {
      executorCalls += 1;
      assert.equal(args?.decision?.mutationIntent, "update_delivery");
      assert.equal(
        args?.decision?.actionParameters?.deliveryAddress,
        "DHA Phase 5"
      );
      assert.equal(args?.decision?.actionParameters?.deliveryTime, "5pm");
      return {
        ok: true,
        status: "unsupported",
        intent: "update_delivery",
        changedData: false,
        actionParameters: args?.decision?.actionParameters ?? null,
      };
    },
    __composePostConfirmMutationCustomerReplyFn: async () => {
      composeCalls += 1;
      return {
        ok: true,
        reply: "Delivery change abhi support nahi — owner se confirm karte hain.",
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
                pickupTime: "10am",
                deliveryTime: "5pm",
              }),
            }),
          },
          finish_reason: "stop",
        },
      ],
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.decisionAction, "request_booking_mutation");
  assert.equal(result.mutationIntent, "update_delivery");
  assert.equal(executorCalls, 1);
  assert.equal(composeCalls, 1);
  assert.equal(result.composeCalls, 1);
  assert.match(String(result.reply), /Delivery change/i);
});

test("8a. all_candidates: wrong segment duration still rejected; selection safety holds", async () => {
  const wrong =
    "Honda Civic 2026 4 din ke liye hai. Toyota Corolla Metallic Grey 5 din ke liye hai.";
  const corrected =
    "Honda Civic 2026 5 din ke liye hai. Toyota Corolla Metallic Grey 4 din ke liye hai.";
  const grounding = (civicDays, corollaDays, reply, junkPickup = null) => {
    const [civicSegment, corollaTail] = reply.split(" Toyota");
    return [
      {
        selectionIndex: 1,
        replySegment: civicSegment,
        groundedFacts: groundedFacts({
          itemId: CIVIC_ITEM_ID,
          durationDays: civicDays,
          bookingStatus: "approved",
          pickupTime: junkPickup,
        }),
      },
      {
        selectionIndex: 2,
        replySegment: `Toyota${corollaTail}`,
        groundedFacts: groundedFacts({
          itemId: COROLLA_ITEM_ID,
          durationDays: corollaDays,
          bookingStatus: "approved",
          pickupTime: junkPickup,
        }),
      },
    ];
  };
  const { result, calls } = await runDecide(
    [
      decision({
        customerReply: wrong,
        bookingSelectionMode: "all_candidates",
        selectedBookingIndex: null,
        candidateGroundings: grounding(4, 5, wrong, "10am"),
        groundedFacts: groundedFacts({ pickupTime: "10am" }),
      }),
      decision({
        customerReply: corrected,
        bookingSelectionMode: "all_candidates",
        selectedBookingIndex: null,
        candidateGroundings: grounding(5, 4, corrected, "10am"),
        groundedFacts: groundedFacts({ pickupTime: "10am" }),
      }),
    ],
    {
      facts: multiBookingFacts(),
      userMessage: "Civic aur Corolla dono kitny din ki hain?",
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, corrected);
  assert.equal(result.decision.bookingSelectionMode, "all_candidates");
  assert.ok(calls.length >= 2);
});

test("8b. all_candidates: hidden junk candidate groundedFacts do not kill safe segments", async () => {
  const reply =
    "Honda Civic 2026 5 din ke liye hai. Toyota Corolla Metallic Grey 4 din ke liye hai.";
  const { result } = await runDecide(
    [
      decision({
        customerReply: reply,
        bookingSelectionMode: "all_candidates",
        selectedBookingIndex: null,
        candidateGroundings: [
          {
            selectionIndex: 1,
            replySegment: "Honda Civic 2026 5 din ke liye hai.",
            groundedFacts: groundedFacts({
              itemId: CIVIC_ITEM_ID,
              durationDays: 5,
              bookingStatus: "approved",
              pickupTime: "07:00",
              deliveryTime: "21:00",
              totalAmount: 999999,
            }),
          },
          {
            selectionIndex: 2,
            replySegment: "Toyota Corolla Metallic Grey 4 din ke liye hai.",
            groundedFacts: groundedFacts({
              itemId: COROLLA_ITEM_ID,
              durationDays: 4,
              bookingStatus: "approved",
              pickupTime: "08:15",
              totalAmount: 1,
            }),
          },
        ],
        groundedFacts: groundedFacts({
          pickupTime: "07:00",
          totalAmount: 999999,
        }),
      }),
    ],
    {
      facts: multiBookingFacts(),
      userMessage: "Meri sari bookings batao",
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, reply);
  assert.equal(result.decision.bookingSelectionMode, "all_candidates");
});

test("claim-level guard still rejects hidden-unrelated cases when 4th arg is used directly", () => {
  // Guard capability retained for other lanes / explicit callers.
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
  const rejected = validateCustomerReplyAgainstContract(
    "Detail confirm hai.",
    contract,
    {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    groundedFacts({ pickupTime: "10am" })
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "verified_booking_time_mismatch");

  const claimOnly = validateCustomerReplyAgainstContract(
    "Detail confirm hai.",
    contract,
    {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    }
  );
  assert.equal(claimOnly.ok, true);
});
