/**
 * Semantic pending-question context for availability assist follow-up.
 * Product code must not branch on exact customer phrases.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "sk-test-fake";
process.env.NODE_ENV = "test";

import {
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
  AVAILABILITY_ASSIST_TTL_MS,
  buildOfferedAlternativesAssist,
  readFreshLastAvailabilityAssist,
  withAvailabilityAssistPendingQuestion,
} from "../src/brain/availability/availabilityAssistContext.js";
import { decideAvailabilityAssistFollowUp } from "../src/brain/availability/decideAvailabilityAssistFollowUp.js";
import {
  AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION,
  buildAvailabilityInquiryActionPlan,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";

const BUSINESS_ID = "biz-pending-q";
const COROLLA_ID = "toyota_corolla";
const STONIC_ID = "kia_stonic";
const CIVIC_ID = "honda_civic";

const OFFER_QUESTION =
  "corolla 2 din ke liye abhi available nahi hai. Koi aur option dekhun?";

function baseAssist(overrides = {}) {
  return buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
    pendingQuestion: OFFER_QUESTION,
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
    participantKey: "adeel-malik::first-seen-1",
    sourceTurnKey: "leads::wa::offer1",
    ...overrides,
  });
}

function mockCompletion(decisionObj) {
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify(decisionObj),
        },
      },
    ],
  });
}

/** Captures the OpenAI messages payload for prompt assertions. */
function mockCompletionCapture(decisionObj, bag) {
  return async (args) => {
    bag.lastCreateArgs = args;
    return mockCompletion(decisionObj)();
  };
}

test("A: offer assist stores pendingQuestion / promptType / stage / TTL metadata", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: { text: "Corolla 2 din k lye available hai?", channel: "whatsapp_web" },
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      signals: { availabilityAsk: true },
      durationDays: 2,
    },
    catalogItems: [
      { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
    ],
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: {
          id: COROLLA_ID,
          name: "Toyota Corolla",
          displayLabel: "Toyota Corolla",
        },
        turn: {
          durationDays: 2,
          sourceTurnKey: "leads::wa::offer1",
          sourceMessageId: "wa::offer1",
        },
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            reason: "booking_conflict",
            confidence: "high",
            windowApplied: true,
            verifiedAlternatives: [
              { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
              { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
            ],
          },
          priceQuote: null,
        },
        actions: { availabilityOwnerCheckExecute: false },
        participant: { key: "adeel-malik::first-seen-1" },
        sourceIdentity: {
          chatId: "leads",
          chatType: "group",
          participantKey: "adeel-malik::first-seen-1",
        },
        lastAvailabilityAssist: null,
      },
    },
  });

  const assist = plan.persistenceIntent?.lastAvailabilityAssist;
  assert.ok(assist);
  assert.equal(plan.replyDraft, "");
  assert.equal(
    assist.pendingQuestion,
    AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION
  );
  assert.equal(assist.pendingPromptType, AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST);
  assert.equal(assist.assistStage, AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE);
  assert.equal(assist.participantKey, "adeel-malik::first-seen-1");
  assert.equal(assist.unavailableItemId, COROLLA_ID);
  assert.equal(assist.durationDays, 2);
  assert.equal(assist.sourceTurnKey, "leads::wa::offer1");
  assert.ok(assist.expiresAt);
  assert.ok(AVAILABILITY_ASSIST_TTL_MS <= 15 * 60 * 1000);
  assert.equal(plan.customerResponseComposition?.lane, "availability");
  assert.equal(
    plan.customerResponseComposition?.kind,
    "availability_unavailable"
  );
  assert.equal(
    plan.customerResponseComposition?.conversationStage,
    "offer_verified_alternatives"
  );
  assert.equal(plan.customerResponseComposition?.missingField, null);
  assert.deepEqual(plan.customerResponseComposition?.verifiedAlternatives, [
    { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
    { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
  ]);
});

test("B: resolver prompt includes pendingQuestion even when recentConversation empty", async () => {
  const bag = {};
  const assist = baseAssist();
  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "ji",
    recentConversation: "",
    lastAvailabilityAssist: assist,
    verifiedAlternatives: [
      { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
      { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
    ],
    participantKey: "adeel-malik::first-seen-1",
    __chatCompletionsCreateForTests: mockCompletionCapture(
      {
        decision: "accept_alternative_offer",
        confidence: 0.93,
        selectedItemId: null,
        shouldClearAssist: false,
        reason: "agrees_to_pending_offer",
      },
      bag
    ),
  });
  assert.equal(decision.decision, "accept_alternative_offer");
  const userMsg = String(bag.lastCreateArgs?.messages?.[1]?.content ?? "");
  assert.match(userMsg, /LAST_EMILY_PENDING_QUESTION/);
  assert.match(userMsg, /Koi aur option dekhun/i);
  assert.match(userMsg, /RECENT_CONVERSATION:\n\(none\)/);
  assert.doesNotMatch(String(bag.lastCreateArgs?.messages?.[0]?.content ?? ""), /\bji\b|\bhaan\b/);
});

test("C: contextual acknowledgements classify accept via mocked LLM (test examples only)", async () => {
  const examples = ["ji", "haan", "ok", "yes", "bilkul dikhao"];
  for (const text of examples) {
    const decision = await decideAvailabilityAssistFollowUp({
      customerText: text,
      recentConversation: "",
      lastAvailabilityAssist: baseAssist(),
      verifiedAlternatives: [{ itemId: CIVIC_ID, itemLabel: "Honda Civic" }],
      participantKey: "adeel-malik::first-seen-1",
      __chatCompletionsCreateForTests: mockCompletion({
        decision: "accept_alternative_offer",
        confidence: 0.91,
        selectedItemId: null,
        shouldClearAssist: false,
        reason: "semantic_ack_of_pending_question",
      }),
    });
    assert.equal(decision.decision, "accept_alternative_offer", text);
  }
});

test("D: thanks / unrelated stay fail-safe (mocked unrelated)", async () => {
  for (const text of ["thanks", "ok bye", "weather is nice"]) {
    const decision = await decideAvailabilityAssistFollowUp({
      customerText: text,
      recentConversation: "",
      lastAvailabilityAssist: baseAssist(),
      participantKey: "adeel-malik::first-seen-1",
      __chatCompletionsCreateForTests: mockCompletion({
        decision: "unrelated_message",
        confidence: 0.95,
        selectedItemId: null,
        shouldClearAssist: true,
        reason: "closing_or_unrelated",
      }),
    });
    assert.equal(decision.decision, "unrelated_message", text);
    assert.equal(decision.shouldClearAssist, true);
  }
});

test("E: decline maps to unrelated/clear (mocked)", async () => {
  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "nahi options nahi chahiye",
    recentConversation: "",
    lastAvailabilityAssist: baseAssist(),
    participantKey: "adeel-malik::first-seen-1",
    __chatCompletionsCreateForTests: mockCompletion({
      decision: "unrelated_message",
      confidence: 0.92,
      selectedItemId: null,
      shouldClearAssist: true,
      reason: "declines_alternatives",
    }),
  });
  assert.equal(decision.decision, "unrelated_message");
  assert.equal(decision.shouldClearAssist, true);
});

test("F: select alternative still builds owner-check, no CREATE_BOOKING", () => {
  const assist = baseAssist();
  const listed = withAvailabilityAssistPendingQuestion(assist, {
    pendingQuestion: "Abhi ye options available hain: Honda Civic, Kia Stonic. Kaunsa dekhna hai?",
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  });
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "Stonic", channel: "whatsapp_web" } },
    understanding: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      signals: {},
      durationDays: null,
    },
    catalogItems: [
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
    ],
    businessContext: {
      __availabilityAssistFollowUpDecision: {
        decision: "select_alternative_item",
        confidence: 0.94,
        selectedItemId: STONIC_ID,
        shouldClearAssist: true,
        ok: true,
      },
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        lastAvailabilityAssist: listed,
        resolvedItem: { id: STONIC_ID, displayLabel: "Kia Stonic" },
        turn: { durationDays: 2, sourceTurnKey: "leads::wa::pick1" },
        verified: {
          availability: {
            status: "available",
            isAvailable: true,
            windowApplied: true,
            verifiedAlternatives: [
              { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
              { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
            ],
          },
          priceQuote: null,
        },
        actions: { availabilityOwnerCheckExecute: true },
        participant: { key: "adeel-malik::first-seen-1" },
        sourceIdentity: {
          chatId: "leads",
          chatType: "group",
          participantKey: "adeel-malik::first-seen-1",
        },
      },
    },
  });
  assert.ok(plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"));
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("G: accept path lists verified alternatives from booking-truth context", () => {
  const assist = baseAssist();
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "ji", channel: "whatsapp_web" } },
    understanding: { resolvedItemId: null, signals: {}, durationDays: null },
    catalogItems: [
      { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
    ],
    businessContext: {
      __availabilityAssistFollowUpDecision: {
        decision: "accept_alternative_offer",
        confidence: 0.95,
        ok: true,
      },
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        lastAvailabilityAssist: assist,
        resolvedItem: { id: COROLLA_ID, displayLabel: "Toyota Corolla" },
        turn: { durationDays: 2 },
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            windowApplied: true,
            verifiedAlternatives: [
              { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
              { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
            ],
          },
          priceQuote: null,
        },
        actions: { availabilityOwnerCheckExecute: false },
        participant: { key: "adeel-malik::first-seen-1" },
        sourceIdentity: {
          chatId: "leads",
          chatType: "group",
          participantKey: "adeel-malik::first-seen-1",
        },
      },
    },
  });
  assert.equal(plan.replyDraft, "");
  assert.equal(plan.customerResponseComposition?.lane, "availability");
  assert.equal(
    plan.customerResponseComposition?.kind,
    "availability_alternatives"
  );
  assert.equal(
    plan.customerResponseComposition?.conversationStage,
    "verified_alternatives_list"
  );
  assert.equal(plan.customerResponseComposition?.missingField, "item_selection");
  assert.deepEqual(plan.customerResponseComposition?.verifiedAlternatives, [
    { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
    { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
  ]);
  const replyAction = plan.actions.find((action) => action.type === "REPLY");
  assert.equal(replyAction?.payload?.text, "");
  assert.equal(replyAction?.payload?.field, "availability");
  assert.equal(
    replyAction?.payload?.source,
    "canonical_verified_alternatives_list"
  );
  assert.equal(
    plan.actions.some((action) => action.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.pendingPromptType,
    AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM
  );
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.assistStage,
    AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION
  );
  assert.equal(
    plan.persistenceIntent?.lastAvailabilityAssist?.pendingQuestion,
    AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION
  );
});

test("H: expired pending question is ignored", () => {
  const expired = baseAssist({
    nowMs: Date.now() - AVAILABILITY_ASSIST_TTL_MS - 60_000,
    ttlMs: AVAILABILITY_ASSIST_TTL_MS,
  });
  assert.equal(readFreshLastAvailabilityAssist(expired), null);
});

test("I: participant mismatch does not use another user's assist", async () => {
  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "ji",
    recentConversation: "",
    lastAvailabilityAssist: baseAssist({ participantKey: "adeel-malik::first-seen-1" }),
    participantKey: "other-person::first-seen-2",
    __chatCompletionsCreateForTests: mockCompletion({
      decision: "accept_alternative_offer",
      confidence: 0.99,
      shouldClearAssist: false,
      reason: "should_not_run",
    }),
  });
  assert.equal(decision.decision, "unrelated_message");
  assert.equal(decision.reason, "assist_participant_mismatch");
  assert.equal(decision.shouldClearAssist, false);
});

test("prompt instructs relative-to-pending-question semantic judgment (no phrase table)", async () => {
  const bag = {};
  await decideAvailabilityAssistFollowUp({
    customerText: "anything",
    recentConversation: null,
    lastAvailabilityAssist: baseAssist(),
    participantKey: "adeel-malik::first-seen-1",
    __chatCompletionsCreateForTests: mockCompletionCapture(
      {
        decision: "unclear",
        confidence: 0.4,
        shouldClearAssist: true,
        reason: "unsure",
      },
      bag
    ),
  });
  const system = String(bag.lastCreateArgs?.messages?.[0]?.content ?? "");
  assert.match(system, /RELATIVE TO Emily's pending question/i);
  assert.match(system, /Do not rely on exact phrase matching/i);
  assert.match(system, /Do not judge short replies in isolation/i);
});
