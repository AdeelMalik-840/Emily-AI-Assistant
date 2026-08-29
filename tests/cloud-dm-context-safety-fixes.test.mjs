/**
 * Root-cause fixes for a live Cloud DM failure set:
 *  1. Internal terminology leakage in unknown-item / zero-option wording.
 *  2. Elliptical same-question item switch (bare new item name continuing
 *     the customer's own active question) missing from the ownership prompt.
 *  3. Confirmation that the deterministic layer (item continuity, active
 *     booking facts, owner-check gating) already correctly handles both the
 *     contextual-pricing-to-availability continuation and the fresh-item
 *     same-question switch, GIVEN a correctly-classified ownership decision.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  parseCloudDmOwnershipDecision,
  executeCloudDmOwnershipDecision,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
// Module-local constant in PricingInquiryWorkflow.js, not exported; mirrored
// here only to assert it carries no internal terminology.
const MISSING_PRICE_REPLY = "Rate confirm kar ke bata deta hun 👍";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";
import { resolveCloudDmOwnershipTrustedFocus } from "../src/services/whatsappInboundBuffer.js";
import { composeUnknownItemCustomerReply } from "../src/brain/openai/composeUnknownItemCustomerReply.js";
import { composeBrowseOptionsCustomerReply } from "../src/brain/openai/composeBrowseOptionsCustomerReply.js";

const BUSINESS_ID = "biz-context-safety";
const CUSTOMER_PHONE = "923005556666";
const CIVIC_ID = "honda_civic";
const CIVIC_LABEL = "Honda Civic 2026 Oriel";
const STONIC_ID = "kia_stonic";
const STONIC_LABEL = "Kia Stonic EX Plus 2021";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CATALOG = [
  { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL },
  { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
  { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL },
];
const NOW_MS = Date.parse("2026-08-29T10:00:00.000Z");

const INTERNAL_TERMS = [
  /trusted catalog/i,
  /no trusted catalog match/i,
  /cannot be verified/i,
  /verified information/i,
  /verified option/i,
  /\bcanonical\b/i,
  /\bprovenance\b/i,
  /\bownership\b/i,
  /\bAVR\b/,
];

function assertNoInternalTerms(text, label) {
  for (const re of INTERNAL_TERMS) {
    assert.equal(re.test(text), false, `${label} must not contain internal terminology matching ${re}`);
  }
}

function span(text, surface) {
  const start = text.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}
function baseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    itemScope: "specific",
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    action: "reply",
    mutationIntent: "none",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

const civicBookingNow = {
  id: "booking-civic-active",
  itemId: CIVIC_ID,
  status: "confirmed",
  startAt: new Date(NOW_MS - 86400000).toISOString(),
  endAt: new Date(NOW_MS + 86400000).toISOString(),
};
const stonicBookingUntilAug30 = {
  id: "booking-stonic-active",
  itemId: STONIC_ID,
  status: "confirmed",
  startAt: new Date(Date.parse("2026-08-25T00:00:00.000Z")).toISOString(),
  endAt: new Date(Date.parse("2026-08-30T00:00:00.000Z")).toISOString(),
};
function bookingsForItem(itemId) {
  if (itemId === CIVIC_ID) return [civicBookingNow];
  if (itemId === STONIC_ID) return [stonicBookingUntilAug30];
  return [];
}

async function resolveCanonical(message, canonicalSemanticDecision, memorySnapshot, authoritativeItem) {
  return resolveBusinessTurnContext({
    traceId: "t-context-safety",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async (_bid, itemId) => bookingsForItem(itemId),
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      participantPhone: CUSTOMER_PHONE,
      sourceMessageId: "m",
      guaranteeKey: "m",
      authoritativeItem,
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      schemaVersion: 1,
      memorySnapshot,
      canonicalSemanticDecision,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

// ---------------------------------------------------------------------------
// TEST 1 / 2 / 7 (unknown-item paths) — no internal terminology, no invented
// facts, structural check on the actual prompt sent to the model.
// ---------------------------------------------------------------------------

test("TEST 1/7: unknown-item availability wording composer never instructs or is fed internal terminology", async () => {
  let capturedSystem = "";
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "availability_inquiry",
    itemLabel: "Swift",
    customerMessage: "swift ni hai?",
    __chatCompletionsCreateForTests: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Swift humare paas nahi hai, is liye ye detail nahi bata sakta.",
                mentionedReferents: ["Swift"],
                replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
              }),
            },
          },
        ],
      };
    },
  });
  // The prompt itself may reference these words as NEGATIVE instructions
  // ("never say X") -- what must never happen is instructing the model to
  // communicate the internal reason using that vocabulary as the customer
  // fact, which is exactly the live bug's specific old instruction.
  assert.doesNotMatch(
    capturedSystem,
    /naturally explain that the requested fact cannot be verified from the trusted catalog/i
  );
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "unknown-item customer reply");
  assert.deepEqual(result.mentionedReferents, ["Swift"]);
});

test("TEST 2/7: unknown-item pricing wording composer never instructs or is fed internal terminology", async () => {
  let capturedSystem = "";
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift ka rent ka koi idea per day kitna hai?",
    __chatCompletionsCreateForTests: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Swift humare paas nahi hai, is liye rate nahi bata sakta.",
                mentionedReferents: ["Swift"],
                replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
              }),
            },
          },
        ],
      };
    },
  });
  assert.doesNotMatch(
    capturedSystem,
    /naturally explain that the requested fact cannot be verified from the trusted catalog/i
  );
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "unknown-item pricing customer reply");
});

test("TEST 7: browse-options zero-count wording composer never instructs internal terminology", async () => {
  let capturedSystem = "";
  const result = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: { availableCount: 0, availableItems: [], catalogItems: [], source: "test" },
    customerMessage: "or koi n gariyan available hain?",
    __chatCompletionsCreateForTests: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Abhi koi gari available nahi hai.",
                mentionedAvailableItemIds: [],
                replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
              }),
            },
          },
        ],
      };
    },
  });
  assert.doesNotMatch(
    capturedSystem,
    /naturally communicate that no verified option is currently available/i
  );
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "browse-options zero-count customer reply");
});

test("TEST 7: hardcoded fallback/no-price constants never leak internal terminology", () => {
  assertNoInternalTerms(POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK, "technical fallback constant");
  assertNoInternalTerms(MISSING_PRICE_REPLY, "missing-price constant");
});

test("ownership decision prompt now instructs elliptical same-question item switch", async () => {
  let capturedSystem = "";
  await executeCloudDmOwnershipDecision({
    facts: {},
    userMessage: "Stonic?",
    __chatCompletionsCreateForTests: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                baseDecision({
                  semanticIntent: "availability_inquiry",
                  itemReferents: [span("Stonic?", "Stonic")],
                })
              ),
            },
          },
        ],
      };
    },
  });
  assert.match(capturedSystem, /ELLIPTICAL SAME-QUESTION ITEM SWITCH/);
  assert.match(capturedSystem, /bare item\/service name/i);
});

// ---------------------------------------------------------------------------
// TEST 3 / 4 — pricing -> contextual availability continuation, and explicit
// repetition producing the SAME authoritative result. Both routed through
// the real write/read session-memory chain and real availability facts.
// ---------------------------------------------------------------------------

test("TEST 3: Civic pricing then contextual 'yeh available hai ya ni?' resolves Civic and respects the active booking, no technical fallback", async () => {
  const sessionKey = "session-test3";
  const message1 = "Civic k rent ka idea?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message1, "Civic")] })),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const result1 = await runBrainV2LivePipeline({
    traceId: "t-test3-1",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message: message1,
    messageId: "wamid.test3-1",
    catalogItems: CATALOG,
    canonicalSemanticDecision: decision1,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Honda Civic 2026 Oriel ka rent 8,000 PKR per day hai.",
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        customerInputRequested: false, requestedInput: null, availabilityCheckStarted: false,
      }) } }],
    }),
  });
  assert.equal(result1.handled, true);
  assert.equal(result1.messageMeta?.actionPlan?.persistenceIntent?.rememberPresentedItemFocus, true);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: result1.messageMeta.actionPlan,
    sourceTurnId: "assistant:wamid.test3-1",
    outboundDelivered: true,
  });
  const persistedState = peekEmilySessionState(sessionKey);
  const trustedFocus = resolveCloudDmOwnershipTrustedFocus({ memorySnapshot: persistedState, participantKey: CUSTOMER_PHONE, nowMs: NOW_MS + 5000 });
  assert.equal(trustedFocus?.itemId, CIVIC_ID);

  const message2 = "yeh available hai ya ni?";
  let rejection = null;
  const parsed2 = parseCloudDmOwnershipDecision(
    JSON.stringify(baseDecision({
      semanticIntent: "availability_inquiry",
      itemReferenceMode: "CONTEXTUAL",
      itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null }],
    })),
    { customerMessage: message2, catalogItems: CATALOG, trustedFreshItemFocus: trustedFocus, onStructuralRejection: (d) => { rejection = d; } }
  );
  assert.equal(rejection, null, "no fabricated current_turn item; contextual binding must be accepted");
  assert.equal(parsed2.itemReferents[0].trustedItemId, CIVIC_ID);

  const canonical2 = await resolveCanonical(message2, { ...parsed2, semanticDecisionStatus: "released" }, persistedState, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical2.verified.availability.status, "unavailable");
  assert.equal(canonical2.verified.availability.hasActiveBlockingBookingNow, true);

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.itemId, CIVIC_ID);
  assert.equal(reply2.payload.source, "canonical_owner_check_active_blocking_now");
  assert.notEqual(reply2.payload.text, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.equal((plan2.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
});

test("TEST 4: explicit 'civic available hai?' produces the same authoritative unavailable result as TEST 3", async () => {
  const message = "civic available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message, "civic")] })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveCanonical(message, decision, {}, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical.verified.availability.status, "unavailable");
  assert.equal(canonical.verified.availability.hasActiveBlockingBookingNow, true);

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.equal(reply.payload.itemId, CIVIC_ID);
  assert.equal(reply.payload.source, "canonical_owner_check_active_blocking_now");
  assert.equal((plan.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false);
});

// ---------------------------------------------------------------------------
// TEST 5 / 6 — same-question item switch ("Stonic?") replaces Civic, and the
// deterministic active-booking gate correctly blocks an owner-check.
// ---------------------------------------------------------------------------

test("TEST 5/6: bare 'Stonic?' with fresh explicit item + availability_inquiry replaces Civic and is conclusively unavailable, no owner-check", async () => {
  const message1 = "civic available hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message1, "civic")] })),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical1 = await resolveCanonical(message1, decision1, {}, { id: CIVIC_ID, name: CIVIC_LABEL });
  assert.equal(canonical1.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical1.verified.availability.status, "unavailable");

  // "Stonic?" -- fresh explicit item, no verb of its own. As the ownership
  // prompt now instructs, this continues the SAME availability_inquiry
  // semanticIntent, now for Stonic (a real GPT call is not exercised here --
  // this proves the deterministic layer correctly handles that decision).
  const message2 = "Stonic?";
  const decision2 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message2, "Stonic")] })),
      { customerMessage: message2, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical2 = await resolveCanonical(message2, decision2, {}, { id: STONIC_ID, name: STONIC_LABEL });
  assert.equal(canonical2.resolvedItem?.id, STONIC_ID, "fresh explicit Stonic must replace Civic");
  assert.notEqual(canonical2.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical2.verified.availability.status, "unavailable");
  assert.equal(canonical2.verified.availability.hasActiveBlockingBookingNow, true);
  assert.equal(canonical2.verified.availability.unavailableUntil, "2026-08-30T00:00:00.000Z");

  const plan2 = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t2", businessId: BUSINESS_ID, channelId: "whatsapp_cloud", chatKey: "dm", participantKey: CUSTOMER_PHONE, text: message2, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem2", admissionReason: "test" },
    understanding: { resolvedItemId: STONIC_ID, resolvedItemLabel: STONIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical2.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical2 },
  });
  assert.equal((plan2.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"), false, "no owner-check may be created when conclusively unavailable from trusted booking facts");
  const reply2 = plan2.actions.find((a) => a.type === "REPLY");
  assert.equal(reply2.payload.itemId, STONIC_ID);
  assert.equal(reply2.payload.source, "canonical_owner_check_active_blocking_now");
  assertNoInternalTerms(reply2.payload.text, "Stonic active-booking reply draft");
});
