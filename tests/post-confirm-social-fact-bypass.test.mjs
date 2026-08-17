/**
 * Semantic deferral: social must not see/use full factual dumps;
 * factual asks must not bypass trusted resolve via social direct reply.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPostConfirmDecideFactsForPrompt,
  socialReplyContainsFactualBusinessClaims,
  isPostConfirmFactualInformationalSemanticDecision,
  isDeferredPostConfirmInformationalDecision,
  executePostConfirmPaLaneDecision,
  parsePostConfirmCustomerDmDecision,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";

function booking(overrides = {}) {
  return {
    id: "bk-1",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Kia Stonic",
    itemId: "stonic-1",
    durationDays: 4,
    startDate: "2026-08-05",
    endDate: "2026-08-09",
    totalAmount: 22000,
    dailyRate: 5500,
    customerSafeReference: "STONIC-PROD",
    pickupTime: "10:00 AM",
    pickupLocation: "DHA Phase 6 Gate 2",
    deliveryTime: "6:00 PM",
    deliveryAddress: "Johar Town",
    ...overrides,
  };
}

function focusedFacts(extra = {}) {
  const b = booking();
  return {
    business: {
      name: "Prod Rentals",
      tone: "friendly",
      deliveryPolicy: "Delivery within Lahore only",
      paymentPolicy: "Cash or bank transfer",
    },
    known: {
      deliveryPolicy: "Delivery within Lahore only",
      advanceAmount: 11000,
      advancePolicy: "50 percent advance",
      driverPolicy: "Driver on request",
    },
    booking: b,
    bookingCandidates: [b],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    activeBookings: [b],
    latestClosedMissingInfoAnswers: [
      {
        requestId: "mir-1",
        missingInfoType: "other",
        ownerAnswer: "Fuel is customer responsibility",
      },
    ],
    catalogItems: [{ id: "c1", name: "Corolla" }],
    pendingAvailabilityRequests: [
      {
        selectionIndex: 1,
        itemLabel: "Civic",
        priceQuote: { total: 99999 },
        requestedDates: ["2026-09-01"],
      },
    ],
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
    ...extra,
  };
}

function decisionJson(overrides = {}) {
  const social =
    overrides.factKind === "non_business" ||
    overrides.capability === "social";
  return JSON.stringify({
    turnScope: social ? "SOCIAL_GENERAL" : "OLD_BOOKING_REFERENCE",
    targetContext: social ? "NONE" : "CONFIRMED_BOOKING",
    targetId: social ? null : "bk-1",
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: null,
    factKind: null,
    capability: null,
    evidenceNeeds: [],
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
    bookingSelectionMode: social ? "none" : "focused",
    selectedBookingIndex: social ? null : 1,
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

test("decide facts prompt strips booking/business/owner answerable values", () => {
  const ctx = buildPostConfirmDecideFactsForPrompt(focusedFacts());
  assert.equal(ctx.decideContextOnly, true);
  assert.equal(ctx.noAnswerableFacts, true);
  assert.equal(ctx.business.name, "Prod Rentals");
  assert.equal(ctx.known, null);
  assert.equal(ctx.latestClosedMissingInfoAnswers, null);
  assert.equal(ctx.booking, null);
  assert.equal(ctx.catalogItems, null);
  assert.equal(ctx.evidenceAvailability.active_booking.pickup_time, "present");
  assert.equal(ctx.evidenceAvailability.active_booking.total_amount, "present");
  assert.equal(ctx.evidenceAvailability.business_profile.delivery_policy, "present");
  assert.equal(ctx.evidenceAvailability.saved_owner_answer.closedAnswerCount, 1);
  assert.deepEqual(ctx.evidenceAvailability.saved_owner_answer.closedAnswerTypes, [
    "other",
  ]);
  const blob = JSON.stringify(ctx);
  assert.doesNotMatch(blob, /22000|5500|11000|10:00|DHA|Fuel is customer|Lahore only|Corolla|99999|2026-09-01|STONIC-PROD|Johar/i);
  assert.match(blob, /Kia Stonic/);
  assert.match(blob, /historical_candidate/);
  assert.doesNotMatch(blob, /"bookingFocus":\{/);
  assert.match(blob, /evidenceAvailability/);
});

test("social reply factual claim detector", () => {
  assert.equal(socialReplyContainsFactualBusinessClaims("Hello! Kya madad chahiye?"), false);
  assert.equal(socialReplyContainsFactualBusinessClaims("Thanks!"), false);
  assert.equal(socialReplyContainsFactualBusinessClaims("Acha"), false);
  assert.equal(
    socialReplyContainsFactualBusinessClaims("Pickup DHA Phase 6 Gate 2 hai."),
    true
  );
  assert.equal(
    socialReplyContainsFactualBusinessClaims("Total rent 22000 hai."),
    true
  );
  assert.equal(
    socialReplyContainsFactualBusinessClaims("Fuel ka kharcha aapki zimmedari hai."),
    true
  );
  assert.equal(
    socialReplyContainsFactualBusinessClaims("Haan booking confirm hai."),
    true
  );
});

test("social + ask_fact semantic is treated as factual (needs Turn Plan)", () => {
  const d = parsePostConfirmCustomerDmDecision(
    decisionJson({
      capability: "social",
      customerReply: "Ji bataiye?",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
    })
  );
  assert.equal(isPostConfirmFactualInformationalSemanticDecision(d), true);
  assert.equal(isDeferredPostConfirmInformationalDecision(d), false);
});

test("genuine social without factual markers is not forced through factual gate", () => {
  const d = parsePostConfirmCustomerDmDecision(
    decisionJson({
      situation: "acknowledgement_after_answer",
      conversationAct: "chit_chat",
      customerIntent: "unclear",
      customerIsAskingQuestion: false,
      factKind: "non_business",
      capability: "social",
      evidenceNeeds: [],
      customerReply: "Hello! Kya madad chahiye?",
    })
  );
  assert.equal(isPostConfirmFactualInformationalSemanticDecision(d), false);
});

test("social dump of booking facts is corrected then fails if still factual", async () => {
  const calls = [];
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "aur booking details batao",
    timeoutMs: 2000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      const user = String(args?.messages?.[1]?.content || "");
      if (calls.length === 1) {
        assert.match(user, /POST_CONFIRM_DECIDE_CONTEXT_JSON/);
        assert.doesNotMatch(user, /VERIFIED_BUSINESS_PA_FACTS_JSON/);
        const contextBlock = user.split("CUSTOMER_MESSAGE:")[0] || "";
        assert.doesNotMatch(
          contextBlock,
          /Fuel is customer responsibility|22000|Lahore only|10:00 AM|DHA Phase/
        );
      }
      // Keep returning social + factual dump
      return {
        choices: [
          {
            message: {
              content: decisionJson({
                factKind: "non_business",
                situation: "acknowledgement_after_answer",
                conversationAct: "chit_chat",
                customerIntent: "unclear",
                customerIsAskingQuestion: false,
                capability: "social",
                evidenceNeeds: [],
                customerReply:
                  "Kia Stonic 4 din ke liye hai, total 22000, pickup DHA Phase 6.",
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "SOCIAL_REPLY_CONTAINS_FACTUAL_CLAIMS");
  assert.ok(calls.length >= 2);
  const correction = String(calls[1]?.messages?.[1]?.content || "");
  assert.match(correction, /factual business\/booking claims/i);
});

test("factual social mislabel with ask_fact forces Turn Plan correction", async () => {
  const calls = [];
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "pickup kahan hoga?",
    timeoutMs: 2000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          choices: [
            {
              message: {
                content: decisionJson({
                  capability: "social",
                  customerReply: "Ji bataiye booking ke bare mein?",
                  conversationAct: "information_request",
                  customerIntent: "ask_fact",
                  customerIsAskingQuestion: true,
                }),
              },
            },
          ],
        };
      }
      return {
        choices: [
          {
            message: {
              content: decisionJson({
                factKind: "booking_fact",
                capability: "answer_from_active_booking",
                evidenceNeeds: [
                  {
                    entity: "active_booking",
                    concept: "pickup",
                    attributes: ["location"],
                  },
                ],
                customerReply: "",
                conversationAct: "information_request",
                customerIntent: "ask_fact",
                customerIsAskingQuestion: true,
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.informationalReplyDeferred, true);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.capability, "answer_from_active_booking");
  assert.ok(calls.length >= 2);
});

test("silence + valid Turn Plan normalizes to deferred resolve (not mute)", () => {
  const parsed = parsePostConfirmCustomerDmDecision(
    decisionJson({
      factKind: "documents_checklist",
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        {
          entity: "business_profile",
          concept: "documents",
          attributes: ["policy"],
        },
      ],
      customerReply: "",
      shouldReply: false,
      action: "silence",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.action, "reply");
  assert.equal(parsed.shouldReply, true);
  assert.equal(parsed.customerReply, "");
  assert.equal(parsed.capability, "answer_from_business_profile");
  assert.equal(isDeferredPostConfirmInformationalDecision(parsed), true);
});

test("unknown act keeps Turn Plan and still defers (no wipe to social)", () => {
  const parsed = parsePostConfirmCustomerDmDecision(
    decisionJson({
      factKind: "booking_fact",
      capability: "answer_from_active_booking",
      evidenceNeeds: [
        {
          entity: "active_booking",
          concept: "pickup",
          attributes: ["time"],
        },
      ],
      customerReply: "",
      shouldReply: false,
      action: "silence",
      conversationAct: "unknown",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.conversationAct, "information_request");
  assert.equal(parsed.capability, "answer_from_active_booking");
  assert.equal(isDeferredPostConfirmInformationalDecision(parsed), true);
});

test("silence on ask_fact without Turn Plan is factual contract violation", () => {
  assert.equal(
    isPostConfirmFactualInformationalSemanticDecision({
      action: "silence",
      shouldReply: false,
      customerReply: "",
      capability: "social",
      evidenceNeeds: [],
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
      mutationIntent: "none",
    }),
    true
  );
});

test("action_request with answer_from_* normalizes to clarification_needed", () => {
  const parsed = parsePostConfirmCustomerDmDecision(
    decisionJson({
      factKind: "booking_fact",
      conversationAct: "action_request",
      customerIntent: "ask_action",
      customerIsAskingQuestion: false,
      capability: "answer_from_active_booking",
      evidenceNeeds: [
        {
          entity: "active_booking",
          concept: "status",
          attributes: ["value"],
        },
      ],
      customerReply: "",
      shouldReply: true,
      action: "reply",
    })
  );
  assert.ok(parsed);
  assert.equal(parsed.capability, "clarification_needed");
  assert.deepEqual(parsed.evidenceNeeds, []);
  assert.equal(isDeferredPostConfirmInformationalDecision(parsed), true);
});

test("pickup time Turn Plan stays pickup (not delivery)", () => {
  const parsed = parsePostConfirmCustomerDmDecision(
    decisionJson({
      factKind: "booking_fact",
      capability: "answer_from_active_booking",
      evidenceNeeds: [
        {
          entity: "active_booking",
          concept: "pickup",
          attributes: ["time"],
        },
      ],
      customerReply: "",
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      customerIsAskingQuestion: true,
    })
  );
  assert.equal(parsed.evidenceNeeds[0].concept, "pickup");
  assert.ok(parsed.evidenceNeeds[0].attributes.includes("time"));
  assert.notEqual(parsed.evidenceNeeds[0].concept, "delivery");
});

test("genuine social hello accepted and decide prompt has no fact dump", async () => {
  const calls = [];
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "hello",
    timeoutMs: 2000,
    missingInfoLoopFullyEnabled: false,
    __chatCompletionsCreateForTests: async (args) => {
      calls.push(args);
      const user = String(args?.messages?.[1]?.content || "");
      assert.match(user, /POST_CONFIRM_DECIDE_CONTEXT_JSON/);
      assert.doesNotMatch(user, /22000|Fuel is customer|Lahore only|10:00 AM/i);
      return {
        choices: [
          {
            message: {
              content: decisionJson({
                factKind: "non_business",
                situation: "acknowledgement_after_answer",
                conversationAct: "chit_chat",
                customerIntent: "unclear",
                customerIsAskingQuestion: false,
                capability: "social",
                evidenceNeeds: [],
                customerReply: "Hello! Kya aapko koi madad chahiye?",
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.capability, "social");
  assert.match(result.decision.customerReply, /Hello/i);
  assert.equal(Boolean(result.decision.informationalReplyDeferred), false);
});
