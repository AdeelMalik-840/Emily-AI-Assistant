import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  applyPostConfirmDerivedOwnershipMechanics,
  buildCloudDmOwnershipPromptFacts,
  buildNeutralCloudDmOwnershipFacts,
  parseCloudDmOwnershipDecision,
  validatePostConfirmSemanticOwnership,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { understandTurn } = await import("../src/brain/understanding/UnderstandingEngine.js");
const { resolveCanonicalItemReferents } = await import("../src/services/currentTurnAuthority.js");
const { composeUnavailableThroughSharedGuard: composeUnavailableCustomerReplyFromFacts } = await import(
  "./helpers/availabilityCompositionTestHarness.mjs"
);
const { buildUnavailableAvailabilityFailsafeReply } = await import(
  "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const {
  applySessionMemoryFromActionPlan,
  readTrustedFreshItemFocus,
} = await import("../src/services/executors/sessionMemoryExecutor.js");
const { getEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);

const catalog = [
  { id: "corolla", name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
  { id: "stonic", name: "Kia Stonic", displayLabel: "Kia Stonic" },
  { id: "civic", name: "Honda Civic", displayLabel: "Honda Civic" },
];

function canonicalJson(overrides = {}) {
  return JSON.stringify({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: "availability_request",
    evidenceNeeds: [],
    ...overrides,
  });
}

test("bounded known item set is valid specific semantics and never collapses to one item", async () => {
  const message = "Corolla or Stonic available hain?";
  const itemReferents = [
    { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
    { source: "current_turn", surfaceText: "Stonic", start: 11, end: 17, trustedItemId: null, sourceTurnId: null },
  ];
  const parsed = parseCloudDmOwnershipDecision(canonicalJson({ itemReferents }), { customerMessage: message });
  assert.equal(parsed?.semanticIntent, "availability_inquiry");
  assert.equal(parsed?.itemScope, "specific");

  const admittedTurn = { turn: { text: message } };
  const turnContext = {
    authoritativeSemanticIntent: "availability_inquiry",
    canonicalSemanticDecision: parsed,
    canonicalItemReferents: itemReferents,
    canonicalItemResolutions: resolveCanonicalItemReferents(itemReferents, catalog),
    memorySnapshot: {},
  };
  const understanding = understandTurn({ admittedTurn, turnContext, catalogItems: catalog });
  assert.deepEqual(new Set(understanding.resolvedItemIds), new Set(["corolla", "stonic"]));
  assert.equal(understanding.resolvedItemId, undefined);
  assert.equal(understanding.unlistedMentionLabel, undefined);

  const facts = await resolveBusinessTurnContext({
    traceId: "bounded-set",
    businessId: "biz",
    rawMessage: admittedTurn.turn.text,
    turnContextInput: {
      chatType: "dm",
      channel: "whatsapp_cloud",
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: itemReferents,
      canonicalItemResolutions: resolveCanonicalItemReferents(itemReferents, catalog),
      canonicalSemanticDecision: parsed,
      memorySnapshot: {},
    },
    turnContext,
    catalogItems: catalog,
    admittedTurn,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  assert.equal(facts.decision.workflowType, "clarification");
  assert.equal(facts.decision.reason, "bounded_explicit_item_set_requires_clarification");
  assert.deepEqual(new Set(facts.decision.boundedExplicitItemIds), new Set(["corolla", "stonic"]));
});

test("bounded catalog sets remain generic across hotel inventory", async () => {
  const hotelCatalog = [
    { id: "deluxe", name: "Deluxe Room", displayLabel: "Deluxe Room" },
    { id: "suite", name: "Executive Suite", displayLabel: "Executive Suite" },
  ];
  const message = "Deluxe Room ya Executive Suite available hain?";
  const itemReferents = [
    { source: "current_turn", surfaceText: "Deluxe Room", start: 0, end: 11, trustedItemId: null, sourceTurnId: null },
    { source: "current_turn", surfaceText: "Executive Suite", start: 15, end: 30, trustedItemId: null, sourceTurnId: null },
  ];
  const parsed = parseCloudDmOwnershipDecision(canonicalJson({ itemReferents }), { customerMessage: message });
  const admittedTurn = { turn: { text: message } };
  const turnContext = {
    authoritativeSemanticIntent: "availability_inquiry",
    canonicalSemanticDecision: parsed,
    canonicalItemReferents: itemReferents,
    canonicalItemResolutions: resolveCanonicalItemReferents(itemReferents, hotelCatalog),
    memorySnapshot: {},
  };
  const understanding = understandTurn({ admittedTurn, turnContext, catalogItems: hotelCatalog });
  assert.deepEqual(new Set(understanding.resolvedItemIds), new Set(["deluxe", "suite"]));
  const facts = await resolveBusinessTurnContext({
    traceId: "bounded-hotel-set",
    businessId: "hotel",
    rawMessage: admittedTurn.turn.text,
    turnContextInput: {
      chatType: "dm",
      channel: "whatsapp_cloud",
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: itemReferents,
      canonicalItemResolutions: resolveCanonicalItemReferents(itemReferents, hotelCatalog),
      canonicalSemanticDecision: parsed,
      memorySnapshot: {},
    },
    turnContext,
    catalogItems: hotelCatalog,
    admittedTurn,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  assert.equal(facts.decision.workflowType, "clarification");
  assert.deepEqual(new Set(facts.decision.boundedExplicitItemIds), new Set(["deluxe", "suite"]));
});

test("OLD booking requires grounded structured reference provenance", () => {
  const booking = { id: "booking-stonic", itemId: "stonic", itemLabel: "Kia Stonic" };
  const facts = buildNeutralCloudDmOwnershipFacts({
    bookingCandidates: [booking],
    currentOwnershipTurnId: "user:wamid.old",
  });
  const base = applyPostConfirmDerivedOwnershipMechanics({
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "specific",
    itemReferents: [],
    targetContext: "CONFIRMED_BOOKING",
    targetId: booking.id,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [{ entity: "active_booking", concept: "dates", attributes: ["end"] }],
  }, facts);
  assert.equal(validatePostConfirmSemanticOwnership(base, facts).ok, false);
  const grounded = {
    ...base,
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:wamid.old",
      targetType: "historical_booking",
      targetId: booking.id,
    },
  };
  assert.equal(validatePostConfirmSemanticOwnership(grounded, facts).ok, true);
});

test("one verified presented alternative becomes fresh focus; multiple alternatives do not", () => {
  const sessionKey = `structured-focus-${Date.now()}`;
  const actionPlan = {
    actions: [{
      type: "REPLY",
      payload: {
        verifiedAlternatives: [{ itemId: "civic", itemLabel: "Honda Civic" }],
        presentedItemIds: ["civic"],
      },
    }],
    persistenceIntent: {
      rememberPresentedItemFocus: true,
      presentedItemId: "civic",
      presentedItemLabel: "Honda Civic",
      execute: false,
    },
  };
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan,
    sourceTurnId: "assistant:wamid.revo",
    outboundDelivered: true,
  });
  const focus = readTrustedFreshItemFocus(getEmilySessionState(sessionKey));
  assert.equal(focus?.itemId, "civic");
  assert.equal(focus?.sourceTurnId, "assistant:wamid.revo");

  const multipleSession = `${sessionKey}-multiple`;
  applySessionMemoryFromActionPlan({
    sessionKey: multipleSession,
    actionPlan: {
      ...actionPlan,
      actions: [{ payload: { verifiedAlternatives: [
        { itemId: "civic" }, { itemId: "stonic" },
      ], presentedItemIds: ["civic", "stonic"] } }],
    },
    sourceTurnId: "assistant:wamid.multi",
    outboundDelivered: true,
  });
  assert.equal(readTrustedFreshItemFocus(getEmilySessionState(multipleSession)), null);
});

test("composer returns only trusted structured presentation metadata", async () => {
  const completion = (content) => async () => ({
    choices: [{ message: { content: JSON.stringify(content) } }],
  });
  const base = {
    conversationalLabel: "Revo",
    durationDays: 1,
    alternatives: [{ itemId: "civic", itemLabel: "Honda Civic" }],
    returnPresentationMetadata: true,
  };
  const accepted = await composeUnavailableCustomerReplyFromFacts({
    ...base,
    __chatCompletionsCreateForTests: completion({
      reply: "Revo available nahi hai, Honda Civic dekh sakte hain.",
      presentedItemIds: ["civic"],
      replySemantics: {
        claims: ["resource_unavailable"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }),
  });
  assert.equal(accepted.reply.includes("Honda Civic"), true);
  assert.deepEqual(accepted.presentedItemIds, ["civic"]);

  const rejected = await composeUnavailableCustomerReplyFromFacts({
    ...base,
    __chatCompletionsCreateForTests: completion({
      reply: "Revo available nahi hai, Spaceship dekh sakte hain.",
      presentedItemIds: ["spaceship"],
      replySemantics: {
        claims: ["resource_unavailable"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }),
  });
  // Rejecting an untrusted presented item ID no longer means silence -- the
  // shared guarded composer always falls back to the deterministic
  // customer-safe failsafe rather than sending nothing.
  assert.equal(
    rejected.reply,
    buildUnavailableAvailabilityFailsafeReply(base.conversationalLabel, base.durationDays, base.alternatives)
  );
  assert.doesNotMatch(rejected.reply, /Spaceship/i);
  assert.deepEqual(rejected.presentedItemIds, []);
});

test("trusted fresh focus is supplied structurally to the same ownership prompt", () => {
  const packed = buildCloudDmOwnershipPromptFacts({
    trustedFreshItemFocus: {
      itemId: "civic",
      itemLabel: "Honda Civic",
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:wamid.revo",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    ownershipReferenceContext: [{
      turnId: "assistant:wamid.revo",
      role: "assistant",
      verifiedReferences: [{
        kind: "catalog_item",
        targetId: "civic",
        provenance: "verified_assistant_presented_item",
      }],
    }],
  });
  assert.equal(packed.trustedFreshItemFocus.itemId, "civic");
  assert.equal(packed.ownershipReferenceContext[0].turnId, "assistant:wamid.revo");
  assert.equal(packed.catalogItems, null);
});

test("fresh focus resolves a contextual price turn while an explicit current item overrides it", () => {
  const memorySnapshot = {
    lastResolvedItemId: "civic",
    lastItem: { id: "civic", itemId: "civic", displayLabel: "Honda Civic" },
    lastFreshItemFocus: {
      itemId: "civic",
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:wamid.revo",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const contextual = understandTurn({
    admittedTurn: { turn: { text: "us ka rent?" } },
    turnContext: {
      authoritativeSemanticIntent: "pricing_inquiry",
      memorySnapshot,
    },
    catalogItems: catalog,
  });
  assert.equal(contextual.resolvedItemId, "civic");
  assert.equal(contextual.itemSource, "memory");

  const explicit = understandTurn({
    admittedTurn: { turn: { text: "Corolla ka rent?" } },
    turnContext: {
      authoritativeSemanticIntent: "pricing_inquiry",
      memorySnapshot,
    },
    catalogItems: catalog,
  });
  assert.equal(explicit.resolvedItemId, "corolla");
  assert.equal(explicit.itemSource, "explicit");
});

test("conversation-turn booking provenance must match a verified structured reference", () => {
  const booking = { id: "booking-stonic", itemId: "stonic", itemLabel: "Kia Stonic" };
  const olderBooking = { id: "booking-corolla-old", itemId: "corolla", itemLabel: "Toyota Corolla" };
  const facts = buildNeutralCloudDmOwnershipFacts({
    bookingCandidates: [olderBooking, booking],
    currentOwnershipTurnId: "user:current",
    ownershipReferenceContext: [{
      turnId: "assistant:booking-summary",
      role: "assistant",
      verifiedReferences: [{
        kind: "historical_booking",
        targetId: booking.id,
        provenance: "verified_post_confirm_reply",
      }],
    }],
  });
  const parsed = applyPostConfirmDerivedOwnershipMechanics(parseCloudDmOwnershipDecision(canonicalJson({
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "specific",
    itemReferents: [],
    targetContext: "CONFIRMED_BOOKING",
    targetId: booking.id,
    targetReference: {
      source: "conversation_turn",
      sourceTurnId: "assistant:booking-summary",
      targetType: "historical_booking",
      targetId: booking.id,
    },
    capability: "answer_from_active_booking",
    evidenceNeeds: [{ entity: "active_booking", concept: "dates", attributes: ["end"] }],
  })), facts);
  assert.equal(validatePostConfirmSemanticOwnership(parsed, facts).ok, true);
  assert.equal(parsed.targetId, booking.id);
  assert.equal(parsed.action, "reply");
  assert.equal(parsed.mutationIntent, "none");
  assert.equal(validatePostConfirmSemanticOwnership({
    ...parsed,
    targetReference: { ...parsed.targetReference, sourceTurnId: "assistant:other" },
  }, facts).reason, "OLD_BOOKING_REFERENCE_SOURCE_UNTRUSTED");
  assert.equal(validatePostConfirmSemanticOwnership({
    ...parsed,
    targetId: "booking-fabricated",
    selectedBookingId: "booking-fabricated",
    targetReference: {
      ...parsed.targetReference,
      targetId: "booking-fabricated",
    },
  }, facts).reason, "OLD_BOOKING_TARGET_UNTRUSTED");
});
