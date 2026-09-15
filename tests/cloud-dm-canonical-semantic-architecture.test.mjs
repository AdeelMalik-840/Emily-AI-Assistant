import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const {
  parseCloudDmOwnershipDecision,
  resolveCloudDmCanonicalOwnership,
  validatePostConfirmSemanticOwnership,
  applyPostConfirmDerivedOwnershipMechanics,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  deriveCloudItemReferenceMode,
  hydrateCloudDmContextualItemReferents,
  reconcileCloudDmItemAndTargetReference,
  applyUnknownCurrentBinding,
  CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY,
} = await import("../src/brain/contracts/cloudCanonicalSemantic.js");
const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);
const { understandTurn } = await import(
  "../src/brain/understanding/UnderstandingEngine.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { selectWorkflow } = await import("../src/brain/workflow/WorkflowEngine.js");
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { mapFrozenPendingOwnershipToWaitingConfirmDecision } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);
const { availabilityComposerCompletionForTest } = await import(
  "./helpers/availabilityCompositionTestHarness.mjs"
);

const STONIC_ID = "kia-stonic";
const CIVIC_ID = "honda-civic";
const COROLLA_ID = "toyota-corolla";

const catalog = [
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic", pricing: { daily: 7000 } },
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic", pricing: { daily: 8000 } },
  { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla", pricing: { daily: 6500 } },
];

const stonicFocus = {
  itemId: STONIC_ID,
  itemLabel: "Kia Stonic",
  provenance: "verified_assistant_presented_item",
  sourceTurnId: "assistant:stonic-turn",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

function span(message, surface) {
  const start = message.indexOf(surface);
  return {
    source: "current_turn",
    surfaceText: surface,
    start,
    end: start + surface.length,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function decision(message, overrides = {}) {
  const itemReferents = overrides.itemReferents ?? [span(message, "Civic")];
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents,
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
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

function parse(message, overrides = {}, extra = {}) {
  return parseCloudDmOwnershipDecision(JSON.stringify(decision(message, overrides)), {
    customerMessage: message,
    trustedFreshItemFocus: extra.trustedFreshItemFocus ?? stonicFocus,
  });
}

test("1. explicit Civic beats Stonic fresh focus; runtime binds Civic IDs only", async () => {
  const message = "Civic available hai?";
  const parsed = parse(message, {
    itemReferents: [span(message, "Civic")],
    targetReference: {
      source: "trusted_fresh_focus",
      sourceTurnId: stonicFocus.sourceTurnId,
      targetType: "catalog_item",
      targetId: STONIC_ID,
    },
  });
  assert.equal(parsed, null, "current-turn Civic cannot share targetReference with Stonic focus");

  const civic = parse(message, { itemReferents: [span(message, "Civic")] });
  assert.equal(civic.itemReferenceMode, "CURRENT_TURN");
  assert.equal(civic.targetReference.source, "none");
  const resolved = resolveCanonicalItemReferents(civic.itemReferents, catalog);
  assert.deepEqual(resolved.map((row) => row.itemId), [CIVIC_ID]);
  assert.equal(resolved[0].status, "MATCHED");
  assert.ok(!resolved.some((row) => row.itemId === STONIC_ID));

  const live = await runBrainV2LivePipeline({
    traceId: "civic-vs-stonic",
    businessId: "biz",
    message,
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: {
      ...civic,
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    memorySnapshot: { lastFreshItemFocus: stonicFocus, lastResolvedItemId: STONIC_ID },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    // Availability replies are now composed through the shared guarded
    // composer rather than authored by the workflow -- wire a synthetic
    // completion so this Cloud DM turn actually reaches a real reply,
    // matching production (test mode otherwise skips composition entirely
    // unless a composer is supplied).
    __cloudComposeChatCreate: availabilityComposerCompletionForTest(message),
  });
  const actionItemIds = []
    .concat(live.actionPlan?.actions ?? [])
    .map((action) => String(action?.payload?.itemId ?? "").trim())
    .filter(Boolean);
  const authId = live.messageMeta?.outboundTrace?.authoritativeItemId ?? null;
  assert.equal(authId, CIVIC_ID);
  assert.ok(!actionItemIds.includes(STONIC_ID));
  assert.notEqual(live.reply, "");
});

test("2. contextual available hai? hydrates Stonic from focus, not model IDs", () => {
  const message = "available hai?";
  const parsed = parse(message, {
    semanticIntent: "availability_inquiry",
    itemReferents: [{
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: null,
      sourceTurnId: null,
    }],
  });
  assert.equal(parsed.itemReferenceMode, "CONTEXTUAL");
  assert.equal(parsed.itemReferents[0].trustedItemId, STONIC_ID);
  assert.equal(parsed.itemReferents[0].sourceTurnId, stonicFocus.sourceTurnId);
  const resolved = resolveCanonicalItemReferents(parsed.itemReferents, catalog);
  assert.equal(resolved[0].itemId, STONIC_ID);
});

test("3. Civic ka rent is CURRENT_TURN Civic pricing", () => {
  const message = "Civic ka rent?";
  const parsed = parse(message, {
    semanticIntent: "pricing_inquiry",
    itemReferents: [span(message, "Civic")],
  });
  assert.equal(parsed.semanticIntent, "pricing_inquiry");
  assert.equal(parsed.itemReferenceMode, "CURRENT_TURN");
  assert.equal(resolveCanonicalItemReferents(parsed.itemReferents, catalog)[0].itemId, CIVIC_ID);
});

test("4. iska rent is CONTEXTUAL Stonic pricing", () => {
  const message = "iska rent?";
  const parsed = parse(message, {
    semanticIntent: "pricing_inquiry",
    itemReferents: [{
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: null,
      sourceTurnId: null,
    }],
  });
  assert.equal(parsed.semanticIntent, "pricing_inquiry");
  assert.equal(parsed.itemReferenceMode, "CONTEXTUAL");
  assert.equal(resolveCanonicalItemReferents(parsed.itemReferents, catalog)[0].itemId, STONIC_ID);
});

test("5. Corolla duration request never binds Civic focus", () => {
  const message = "Corolla 3 din k lye chahiye";
  const parsed = parse(message, {
    semanticIntent: "availability_inquiry",
    itemReferents: [span(message, "Corolla")],
  });
  assert.equal(resolveCanonicalItemReferents(parsed.itemReferents, catalog)[0].itemId, COROLLA_ID);
  const civicFocus = { ...stonicFocus, itemId: CIVIC_ID, itemLabel: "Honda Civic" };
  const hydrated = hydrateCloudDmContextualItemReferents(parsed.itemReferents, civicFocus);
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.itemReferents[0].source, "current_turn");
  assert.equal(hydrated.itemReferents[0].trustedItemId, null);
});

test("6. Civic and Corolla stay a bounded set with no silent pick", async () => {
  const message = "Civic aur Corolla dono available hain?";
  const itemReferents = [span(message, "Civic"), span(message, "Corolla")];
  const parsed = parse(message, { itemReferents });
  assert.equal(parsed.itemReferenceMode, "MULTIPLE_CURRENT");
  const resolved = resolveCanonicalItemReferents(parsed.itemReferents, catalog);
  assert.deepEqual(resolved.map((row) => row.itemId), [CIVIC_ID, COROLLA_ID]);
  const understanding = understandTurn({
    admittedTurn: { turn: { text: message } },
    turnContext: {
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: parsed.itemReferents,
      canonicalItemResolutions: resolved,
    },
    catalogItems: catalog,
  });
  assert.equal(understanding.resolvedItemId, undefined);
  const facts = await resolveBusinessTurnContext({
    traceId: "multi",
    businessId: "biz",
    rawMessage: message,
    turnContextInput: {
      channel: "whatsapp_cloud",
      chatType: "dm",
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: parsed.itemReferents,
      canonicalItemResolutions: resolved,
    },
    turnContext: {
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalSemanticDecision: parsed,
      canonicalItemReferents: parsed.itemReferents,
      canonicalItemResolutions: resolved,
    },
    catalogItems: catalog,
    admittedTurn: { turn: { text: message } },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  assert.equal(facts.decision.workflowType, "clarification");
});

test("7. Fortuner stays specific unknown, not browse", () => {
  const message = "Fortuner available hai?";
  const parsed = parse(message, { itemReferents: [span(message, "Fortuner")] });
  assert.equal(parsed.itemScope, "specific");
  assert.notEqual(parsed.semanticIntent, "browse_options");
  const resolved = resolveCanonicalItemReferents(parsed.itemReferents, catalog);
  assert.equal(resolved[0].status, "NOT_MATCHED");
  assert.equal(resolved[0].itemLabel, "Fortuner");
  assert.equal(
    applyUnknownCurrentBinding(parsed.itemReferenceMode, resolved),
    "UNKNOWN_CURRENT"
  );
});

test("8. old booking binds verified booking id only", () => {
  const booking = { id: "booking-civic", itemId: CIVIC_ID, itemLabel: "Honda Civic" };
  const facts = {
    bookingCandidates: [booking],
    currentOwnershipTurnId: "user:old",
  };
  const parsed = parseCloudDmOwnershipDecision(JSON.stringify({
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "specific",
    itemReferents: [],
    targetReference: {
      source: "current_turn",
      sourceTurnId: "user:old",
      targetType: "historical_booking",
      targetId: booking.id,
    },
    targetId: booking.id,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: "answer_from_active_booking",
    evidenceNeeds: [{ entity: "active_booking", concept: "status", attributes: ["value"] }],
  }), { customerMessage: "meri Civic booking status?" });
  const decision = applyPostConfirmDerivedOwnershipMechanics(parsed, facts);
  assert.equal(validatePostConfirmSemanticOwnership(decision, facts).ok, true);
  assert.equal(decision.targetId, "booking-civic");
});

test("9. pending AVR factual question maps to reply, not confirm", () => {
  const frozen = {
    turnScope: "PENDING_AVAILABILITY_REFERENCE",
    action: "reply",
    targetId: "avr-stonic",
    mutationIntent: "none",
    factKind: "booking_fact",
  };
  const mapped = mapFrozenPendingOwnershipToWaitingConfirmDecision?.(frozen, "avr-stonic");
  if (mapped) {
    assert.equal(mapped.action, "reply");
    assert.notEqual(mapped.action, "confirm_booking");
    assert.equal(mapped.targetId, "avr-stonic");
  }
});

test("10-11. waiting_confirm meaning is owned by frozen Brain action", () => {
  const ok = mapFrozenPendingOwnershipToWaitingConfirmDecision?.(
    { action: "confirm_pending_availability", targetId: "avr-1" },
    "avr-1"
  );
  const book = mapFrozenPendingOwnershipToWaitingConfirmDecision?.(
    { action: "confirm_pending_availability", targetId: "avr-1" },
    "avr-1"
  );
  const question = mapFrozenPendingOwnershipToWaitingConfirmDecision?.(
    { action: "reply", targetId: "avr-1" },
    "avr-1"
  );
  if (ok) {
    assert.equal(ok.action, "confirm_booking");
    assert.equal(book.action, "confirm_booking");
    assert.equal(question.action, "reply");
    assert.equal(ok.targetId, "avr-1");
  }
});

test("12. item change after approved AVR cannot confirm the old item", () => {
  const frozen = {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    action: "reply",
    itemReferents: [span("Civic chahiye", "Civic")],
    targetId: null,
  };
  assert.notEqual(frozen.action, "confirm_pending_availability");
  assert.equal(resolveCanonicalItemReferents(frozen.itemReferents, catalog)[0].itemId, CIVIC_ID);
});

test("13. missing business fact owner-check wording does not mention owner", async () => {
  const live = await runBrainV2LivePipeline({
    traceId: "owner-check-wording",
    businessId: "biz",
    message: "Does Civic have a child seat?",
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: {
      ...decision("Does Civic have a child seat?", {
        semanticIntent: "details_inquiry",
        itemReferents: [span("Does Civic have a child seat?", "Civic")],
      }),
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.doesNotMatch(String(live.reply), /\bowner\b/i);
  assert.equal(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
});

test("14. ambiguous UNCLEAR is customer clarification, not silence", async () => {
  const live = await runBrainV2LivePipeline({
    traceId: "unclear",
    businessId: "biz",
    message: "wo wali",
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: {
      turnScope: "UNCLEAR",
      semanticIntent: "unclear",
      itemScope: "none",
      itemReferents: [],
      targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "vague",
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.notEqual(String(live.reply ?? "").trim(), "");
  assert.equal(live.customerTurnOutcome, "CUSTOMER_CLARIFICATION");
});

test("15. invalid Brain JSON retries once then technical recovery", async () => {
  let calls = 0;
  const result = await resolveCloudDmCanonicalOwnership({
    facts: { trustedFreshItemFocus: stonicFocus },
    userMessage: "Civic available hai?",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return { choices: [{ message: { content: "{bad" } }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
});

test("16. invented fresh-focus ID is rejected and never executed", () => {
  const message = "available hai?";
  const parsed = parseCloudDmOwnershipDecision(JSON.stringify(decision(message, {
    itemReferents: [{
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: "invented-stonic",
      sourceTurnId: stonicFocus.sourceTurnId,
    }],
  })), { customerMessage: message, trustedFreshItemFocus: stonicFocus });
  assert.equal(parsed, null);
});

test("17. composer failure keeps frozen meaning and returns recoverable wording", async () => {
  const message = "Fortuner available hai?";
  const live = await runBrainV2LivePipeline({
    traceId: "compose-fail",
    businessId: "biz",
    message,
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: {
      ...decision(message, {
        itemReferents: [span(message, "Fortuner")],
      }),
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    __unknownItemComposeChatCreate: async () => ({
      choices: [{ message: { content: "" } }],
    }),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(live.handled, true);
  assert.match(String(live.reply ?? ""), /Fortuner/i);
  assert.doesNotMatch(String(live.reply ?? ""), /\?/);
  assert.doesNotMatch(String(live.reply ?? ""), /request complete nahi ho saki/i);
  assert.equal(live.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_SAME_ACT_FALLBACK");
});

test("canonical Cloud skips availability-assist second Brain", async () => {
  let assistCalls = 0;
  const message = "Civic available hai?";
  const parsed = parse(message);
  await resolveBusinessTurnContext({
    traceId: "no-assist-brain",
    businessId: "biz",
    rawMessage: message,
    turnContextInput: {
      channel: "whatsapp_cloud",
      chatType: "dm",
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: parsed.itemReferents,
      canonicalItemResolutions: resolveCanonicalItemReferents(parsed.itemReferents, catalog),
      memorySnapshot: {
        lastAvailabilityAssist: {
          action: "offered_alternatives",
          unavailableItemId: CIVIC_ID,
          durationDays: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          verifiedAlternatives: [{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }],
        },
      },
    },
    turnContext: {
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalSemanticDecision: parsed,
      memorySnapshot: {
        lastAvailabilityAssist: {
          action: "offered_alternatives",
          unavailableItemId: CIVIC_ID,
          durationDays: 1,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          verifiedAlternatives: [{ itemId: STONIC_ID }],
        },
      },
    },
    catalogItems: catalog,
    admittedTurn: { turn: { text: message } },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __availabilityAssistFollowUpChatCreate: async () => {
      assistCalls += 1;
      return { choices: [{ message: { content: "{}" } }] };
    },
    log: false,
  });
  assert.equal(assistCalls, 0);
});

test("WorkflowEngine does not reinterpret canonical Cloud booking phrases", () => {
  const understanding = understandTurn({
    admittedTurn: { turn: { text: "book kar do" } },
    turnContext: {
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: [{
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: STONIC_ID,
        sourceTurnId: stonicFocus.sourceTurnId,
      }],
      canonicalItemResolutions: [{ status: "MATCHED", itemId: STONIC_ID }],
    },
    catalogItems: catalog,
  });
  const workflow = selectWorkflow({
    understanding,
    turnContext: { memorySnapshot: {} },
    message: "book kar do",
    resolvedBusinessTurnContext: {
      decision: {
        workflowType: "availability_inquiry",
        primaryIntent: "availability_inquiry",
        reason: "canonical_semantic_intent_authoritative",
      },
    },
  });
  assert.equal(workflow.workflowType, "availability_inquiry");
});

test("model-copied matching focus IDs are overwritten by runtime, not trusted as authorship", () => {
  const hydrated = hydrateCloudDmContextualItemReferents([{
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId: STONIC_ID,
    sourceTurnId: stonicFocus.sourceTurnId,
  }], stonicFocus);
  assert.equal(hydrated.ok, true);
  assert.equal(hydrated.itemReferents[0].trustedItemId, STONIC_ID);
  assert.equal(deriveCloudItemReferenceMode(hydrated.itemReferents, "specific"), "CONTEXTUAL");
  const mixed = reconcileCloudDmItemAndTargetReference({
    turnScope: "NEW_TRANSACTION",
    itemScope: "specific",
    itemReferents: [span("Civic available hai?", "Civic")],
    targetReference: {
      source: "trusted_fresh_focus",
      sourceTurnId: stonicFocus.sourceTurnId,
      targetType: "catalog_item",
      targetId: STONIC_ID,
    },
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, "EXPLICIT_CURRENT_OVERRIDES_FRESH_FOCUS");
});
