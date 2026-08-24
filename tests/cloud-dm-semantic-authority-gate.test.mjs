import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "semantic-authority-biz";

const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { buildTurnContextInput } = await import(
  "../src/brain/live/buildTurnContextInput.js"
);
const { buildShadowTurnContext } = await import(
  "../src/brain/shadow/brainShadowHook.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { understandTurn } = await import(
  "../src/brain/understanding/UnderstandingEngine.js"
);
const {
  selectWorkflow,
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
} = await import(
  "../src/brain/workflow/WorkflowEngine.js"
);
const {
  applyCustomerSemanticIntentToSignals,
  workflowTypeForCustomerSemanticIntent,
} = await import(
  "../src/brain/decisions/projectSemanticIntentFromBrainDecision.js"
);

const catalogItems = [
  {
    id: "civic",
    name: "Honda Civic",
    displayLabel: "Honda Civic (White)",
    pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
    images: ["https://example.test/civic.jpg"],
    isAvailable: true,
  },
  {
    id: "corolla",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla (Grey)",
    pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
    isAvailable: true,
  },
];

function canonicalDecision(semanticIntent) {
  return {
    turnScope: "NEW_TRANSACTION",
    targetContext: "NEW_TRANSACTION",
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    semanticIntent,
    semanticDecisionStatus: "released",
    semanticDecisionVersion: 1,
    ownershipLane: "normal_routing",
    openaiSource: "openai",
  };
}

function browseResponse() {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply: "Honda Civic (White) aur Toyota Corolla (Grey) available hain.",
          mentionedAvailableItemIds: ["civic", "corolla"],
          replySemantics: {
            claims: ["resource_availability_confirmed"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }),
      },
    }],
  };
}

test("live Cloud DM browse intent cannot be replaced by availability/unlisted text heuristics", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "live-browse-authority",
    businessId: "semantic-authority-biz",
    message: "abi kon kon c gariyan available hain?",
    messageId: "wamid.semantic-browse",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantKey: "customer-1",
    catalogItems,
    memorySnapshot: { lastResolvedItemId: "civic" },
    canonicalSemanticDecision: canonicalDecision("browse_options"),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({ tone: "friendly" }),
    __browseComposeChatCreate: async () => browseResponse(),
  });

  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "browse_options");
  assert.equal(result.messageMeta?.actionPlan?.workflowType, "browse_options");
  assert.doesNotMatch(String(result.reply), /abi kon kon c gariyan filhal/i);
});

test("every semantic intent has a structural workflow family and canonical signals replace conflicts", () => {
  const expected = new Map([
    ["availability_inquiry", "availability_inquiry"],
    ["pricing_inquiry", "pricing_inquiry"],
    ["pricing_with_duration", "pricing_with_duration"],
    ["booking_request", "booking_request"],
    ["browse_options", "browse_options"],
    ["details_inquiry", "clarification"],
    ["image_catalog_request", "clarification"],
    ["general_business_question", "clarification"],
    ["clarification", "clarification"],
    ["social", "clarification"],
    ["unclear", "clarification"],
  ]);
  const conflicting = {
    priceAsk: true,
    availabilityAsk: true,
    browseAsk: true,
    bookingCommitment: true,
    detailsAsk: true,
    photoAsk: true,
    durationMentioned: true,
  };

  for (const [intent, workflowType] of expected) {
    assert.equal(workflowTypeForCustomerSemanticIntent(intent), workflowType, intent);
    const signals = applyCustomerSemanticIntentToSignals(conflicting, intent);
    assert.equal(signals.priceAsk, intent === "pricing_inquiry" || intent === "pricing_with_duration", intent);
    assert.equal(signals.availabilityAsk, intent === "availability_inquiry", intent);
    assert.equal(signals.browseAsk, intent === "browse_options", intent);
    assert.equal(signals.bookingCommitment, intent === "booking_request", intent);
    assert.equal(signals.photoAsk, intent === "image_catalog_request", intent);
    assert.equal(signals.detailsAsk, intent === "details_inquiry", intent);
    assert.equal(signals.durationMentioned, true, intent);
  }
});

test("canonical semantic-intent matrix wins through understanding, facts, and workflow selection", async () => {
  const expected = new Map([
    ["availability_inquiry", "availability_inquiry"],
    ["pricing_inquiry", "pricing_inquiry"],
    ["pricing_with_duration", "pricing_with_duration"],
    ["booking_request", "booking_request"],
    ["browse_options", "browse_options"],
    ["details_inquiry", "clarification"],
    ["image_catalog_request", "clarification"],
    ["general_business_question", "clarification"],
    ["clarification", "clarification"],
    ["unclear", "clarification"],
  ]);
  const conflictingMessage = "Honda Civic available hai?";

  for (const [intent, expectedWorkflow] of expected) {
    const input = buildTurnContextInput({
      channel: "whatsapp_cloud",
      chatType: "dm",
      businessId: "semantic-authority-biz",
      chatId: `matrix-${intent}`,
      messageText: conflictingMessage,
      participantKey: "matrix-customer",
      sessionKey: `matrix-${intent}`,
      catalogItems,
      authoritativeSemanticIntent: intent,
    });
    const turnContext = buildShadowTurnContext({
      businessId: "semantic-authority-biz",
      sessionKey: `matrix-${intent}`,
      participantKey: "matrix-customer",
      memorySnapshot: {},
    });
    turnContext.authoritativeSemanticIntent = intent;
    turnContext.lastResolvedItemId = input.authoritativeItem?.id;
    const admittedTurn = {
      turn: {
        turnId: `matrix-${intent}`,
        businessId: "semantic-authority-biz",
        channelId: "whatsapp_cloud",
        chatKey: `matrix-${intent}`,
        participantKey: "matrix-customer",
        text: conflictingMessage,
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: `matrix-${intent}`,
      admissionReason: "test",
    };
    const understanding = understandTurn({ admittedTurn, turnContext, catalogItems });
    const facts = await resolveBusinessTurnContext({
      traceId: `matrix-${intent}`,
      businessId: "semantic-authority-biz",
      rawMessage: conflictingMessage,
      turnContextInput: input,
      turnContext,
      admittedTurn,
      catalogItems,
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      log: false,
    });
    const workflow = selectWorkflow({
      understanding,
      turnContext,
      message: conflictingMessage,
      resolvedBusinessTurnContext: facts,
    });
    assert.equal(understanding.intentsRanked[0], intent, intent);
    assert.equal(facts.turn.intent, intent, intent);
    assert.equal(facts.decision.primaryIntent, intent, intent);
    assert.equal(workflow.workflowType, expectedWorkflow, intent);
  }
});

test("canonical intent controls understanding, fact decision, and workflow while deterministic facts remain", async () => {
  const message = "Honda Civic kal se 3 din ke liye available hai?";
  const input = buildTurnContextInput({
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: "semantic-authority-biz",
    chatId: "dm-1",
    messageText: message,
    participantKey: "customer-1",
    sessionKey: "session-1",
    catalogItems,
    authoritativeSemanticIntent: "pricing_with_duration",
    traceId: "fact-preservation",
  });
  const turnContext = buildShadowTurnContext({
    businessId: "semantic-authority-biz",
    sessionKey: "session-1",
    participantKey: "customer-1",
    memorySnapshot: {},
  });
  turnContext.authoritativeSemanticIntent = "pricing_with_duration";
  turnContext.lastResolvedItemId = input.authoritativeItem?.id;
  const admittedTurn = {
    turn: {
      turnId: "fact-preservation",
      businessId: "semantic-authority-biz",
      channelId: "whatsapp_cloud",
      chatKey: "dm-1",
      participantKey: "customer-1",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "fact-preservation",
    admissionReason: "test",
  };
  const understanding = understandTurn({ admittedTurn, turnContext, catalogItems });
  const facts = await resolveBusinessTurnContext({
    traceId: "fact-preservation",
    businessId: "semantic-authority-biz",
    rawMessage: message,
    turnContextInput: input,
    turnContext,
    admittedTurn,
    catalogItems,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  const workflow = selectWorkflow({
    understanding,
    turnContext,
    message,
    resolvedBusinessTurnContext: facts,
  });

  assert.equal(understanding.intentsRanked[0], "pricing_with_duration");
  assert.equal(understanding.resolvedItemId, "civic");
  assert.equal(understanding.durationDays, 3);
  assert.equal(facts.turn.intent, "pricing_with_duration");
  assert.equal(facts.verified.pricing.status, "resolved");
  assert.equal(facts.verified.priceQuote.total, 24000);
  assert.equal(workflow.workflowType, "pricing_with_duration");
});

test("trusted session item resolution remains available for canonical item fact intents", () => {
  let called = 0;
  const input = buildTurnContextInput({
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: "semantic-authority-biz",
    chatId: "dm-2",
    messageText: "10 din ka rent kitna hai?",
    participantKey: "customer-2",
    sessionKey: "session-2",
    memorySnapshot: { lastResolvedItemId: "civic" },
    catalogItems,
    authoritativeSemanticIntent: "pricing_with_duration",
    resolveTrustedSessionItem: () => {
      called += 1;
      return { ok: true, item: catalogItems[0], proofSource: "trusted_test" };
    },
  });
  assert.equal(called, 1);
  assert.equal(input.authoritativeItem?.id, "civic");
});

test("canonical availability and media intents retain date-window and verified-media resolution", async () => {
  const cases = [
    {
      intent: "availability_inquiry",
      message: "Honda Civic kal se 3 din ke liye chahiye",
      verify(facts) {
        assert.equal(facts.verified.availability.status, "available");
        assert.equal(facts.verified.availability.windowApplied, true);
        assert.equal(facts.duration.days, 3);
        assert.ok(facts.verified.availability.requestedStartAt);
        assert.ok(facts.verified.availability.requestedEndAt);
      },
    },
    {
      intent: "image_catalog_request",
      message: "Honda Civic ka rate kya hai?",
      verify(facts) {
        assert.equal(facts.verified.media.status, "resolved");
        assert.equal(facts.verified.media.hasImages, true);
        assert.equal(facts.verified.media.imageCount, 1);
      },
    },
  ];

  for (const entry of cases) {
    const input = buildTurnContextInput({
      channel: "whatsapp_cloud",
      chatType: "dm",
      businessId: "semantic-authority-biz",
      chatId: `facts-${entry.intent}`,
      messageText: entry.message,
      participantKey: "facts-customer",
      sessionKey: `facts-${entry.intent}`,
      catalogItems,
      authoritativeSemanticIntent: entry.intent,
    });
    const turnContext = buildShadowTurnContext({
      businessId: "semantic-authority-biz",
      sessionKey: `facts-${entry.intent}`,
      participantKey: "facts-customer",
      memorySnapshot: {},
    });
    turnContext.authoritativeSemanticIntent = entry.intent;
    turnContext.lastResolvedItemId = input.authoritativeItem?.id;
    const facts = await resolveBusinessTurnContext({
      traceId: `facts-${entry.intent}`,
      businessId: "semantic-authority-biz",
      rawMessage: entry.message,
      turnContextInput: input,
      turnContext,
      catalogItems,
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      nowMs: Date.parse("2026-08-25T10:00:00.000Z"),
      log: false,
    });
    entry.verify(facts);
  }
});

test("genuine explicit unlisted item remains unlisted within a compatible canonical family", async () => {
  const message = "Spaceship Premium available hai?";
  const input = buildTurnContextInput({
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: "semantic-authority-biz",
    chatId: "dm-3",
    messageText: message,
    participantKey: "customer-3",
    sessionKey: "session-3",
    catalogItems,
    authoritativeSemanticIntent: "availability_inquiry",
  });
  const turnContext = buildShadowTurnContext({
    businessId: "semantic-authority-biz",
    sessionKey: "session-3",
    participantKey: "customer-3",
    memorySnapshot: {},
  });
  turnContext.authoritativeSemanticIntent = "availability_inquiry";
  const facts = await resolveBusinessTurnContext({
    traceId: "unlisted-compatible",
    businessId: "semantic-authority-biz",
    rawMessage: message,
    turnContextInput: input,
    turnContext,
    catalogItems,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  assert.equal(facts.decision.workflowType, "unlisted_item");
  assert.equal(facts.decision.reason, "canonical_semantic_intent_explicit_unlisted_item");
});

test("authority gate is not applied to Group turns", async () => {
  let captured = null;
  const result = await runBrainV2LivePipeline({
    traceId: "group-boundary",
    businessId: "semantic-authority-biz",
    message: "Honda Civic available hai?",
    messageId: "group-message-1",
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    participantKey: "group-user",
    catalogItems,
    canonicalSemanticDecision: canonicalDecision("browse_options"),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (input) => {
      captured = input;
      return {
        workflowDecision: { workflowType: "availability_inquiry", reason: "group_existing" },
        actionPlan: {
          replyDraft: "Checking availability.",
          actions: [{ type: "REPLY", payload: { text: "Checking availability." } }],
        },
        trace: {},
      };
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.workflowType, "availability_inquiry");
  assert.equal(captured.turnContext.authoritativeSemanticIntent, undefined);
  assert.equal(captured.turnContext.canonicalSemanticDecision, undefined);
});

test("released NEW_TRANSACTION without a valid canonical semantic intent fails closed", async () => {
  let orchestratorCalls = 0;
  const result = await runBrainV2LivePipeline({
    traceId: "invalid-semantic-intent",
    businessId: "semantic-authority-biz",
    message: "Honda Civic available hai?",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems,
    canonicalSemanticDecision: {
      ...canonicalDecision("availability_inquiry"),
      semanticIntent: "regex_guessed_availability",
    },
    __testOrchestratorFn: () => {
      orchestratorCalls += 1;
      throw new Error("must_not_run");
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "CANONICAL_SEMANTIC_INTENT_INVALID");
  assert.equal(result.sendVia, "NONE");
  assert.equal(orchestratorCalls, 0);
});

function selectCanonicalWorkflowWithAvailabilityPending(intent, workflowType, extra = {}) {
  return selectWorkflow({
    understanding: {
      itemConfidence: "high",
      intentsRanked: [intent],
      authoritativeSemanticIntent: intent,
      durationDays: extra.durationDays,
      signals: {
        priceAsk: intent === "pricing_inquiry" || intent === "pricing_with_duration",
        availabilityAsk: intent === "availability_inquiry",
        browseAsk: intent === "browse_options",
        bookingCommitment: intent === "booking_request",
      },
    },
    turnContext: {
      memorySnapshot: {
        pendingAction: {
          type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
          itemId: "civic",
        },
      },
    },
    message: "conflicting downstream text",
    resolvedBusinessTurnContext: {
      decision: {
        primaryIntent: intent,
        workflowType,
        reason: "canonical_semantic_intent_authoritative",
      },
    },
  });
}

test("canonical browse and pricing families outrank availability-duration pending state", () => {
  const browse = selectCanonicalWorkflowWithAvailabilityPending(
    "browse_options",
    "browse_options"
  );
  const pricing = selectCanonicalWorkflowWithAvailabilityPending(
    "pricing_inquiry",
    "pricing_inquiry"
  );
  assert.equal(browse.workflowType, "browse_options");
  assert.equal(pricing.workflowType, "pricing_inquiry");
});

test("canonical availability keeps the existing availability pending continuation", () => {
  const selected = selectCanonicalWorkflowWithAvailabilityPending(
    "availability_inquiry",
    "availability_inquiry",
    { durationDays: 3 }
  );
  assert.equal(selected.workflowType, "availability_inquiry");
  assert.equal(selected.reason, "availability_duration_pending_continuation");
});

test("availability pending metadata survives without rewriting canonical booking meaning", async () => {
  const pending = {
    type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
    status: "awaiting",
    pendingStage: "availability_duration",
    pendingQuestion: "duration required",
    itemId: "civic",
    participantKey: "pending-customer",
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const message = "3 din";
  const input = buildTurnContextInput({
    channel: "whatsapp_cloud",
    chatType: "dm",
    businessId: "semantic-authority-biz",
    chatId: "pending-booking",
    messageText: message,
    participantKey: "pending-customer",
    sessionKey: "pending-booking",
    memorySnapshot: { pendingAction: pending, emilyPending: pending },
    catalogItems,
    authoritativeSemanticIntent: "booking_request",
  });
  const turnContext = buildShadowTurnContext({
    businessId: "semantic-authority-biz",
    sessionKey: "pending-booking",
    participantKey: "pending-customer",
    memorySnapshot: { pendingAction: pending, emilyPending: pending },
  });
  turnContext.authoritativeSemanticIntent = "booking_request";
  turnContext.lastResolvedItemId = "civic";
  const facts = await resolveBusinessTurnContext({
    traceId: "pending-booking-authority",
    businessId: "semantic-authority-biz",
    rawMessage: message,
    turnContextInput: input,
    turnContext,
    catalogItems,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    log: false,
  });
  const selected = selectWorkflow({
    understanding: understandTurn({
      admittedTurn: {
        turn: {
          turnId: "pending-booking-authority",
          businessId: "semantic-authority-biz",
          channelId: "whatsapp_cloud",
          chatKey: "pending-booking",
          participantKey: "pending-customer",
          text: message,
          normalizedAt: new Date().toISOString(),
        },
        idempotencyKey: "pending-booking-authority",
        admissionReason: "test",
      },
      turnContext,
      catalogItems,
    }),
    turnContext,
    message,
    resolvedBusinessTurnContext: facts,
  });

  assert.equal(facts.emilyPending?.pendingStage, "availability_duration");
  assert.equal(facts.emilyPendingFollowUp?.workflowHint, "availability_inquiry");
  assert.equal(facts.decision.primaryIntent, "booking_request");
  assert.equal(facts.decision.workflowType, "booking_request");
  assert.equal(selected.workflowType, "booking_request");
});

test("availability pending without canonical authority keeps existing continuation behavior", () => {
  const selected = selectWorkflow({
    understanding: {
      itemConfidence: "high",
      durationDays: 3,
      signals: { priceAsk: false, bookingCommitment: false },
    },
    turnContext: {
      memorySnapshot: {
        pendingAction: { type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION },
      },
    },
    message: "3 din",
    resolvedBusinessTurnContext: {
      decision: { workflowType: "browse_options", reason: "legacy_conflict" },
    },
  });
  assert.equal(selected.workflowType, "availability_inquiry");
  assert.equal(selected.reason, "availability_duration_pending_continuation");
});

test("SOCIAL_GENERAL and UNCLEAR retain scoped safety without entering NEW_TRANSACTION authority", async () => {
  for (const [turnScope, semanticIntent] of [
    ["SOCIAL_GENERAL", "social"],
    ["UNCLEAR", "unclear"],
  ]) {
    let captured = null;
    const result = await runBrainV2LivePipeline({
      traceId: `scoped-${turnScope}`,
      businessId: "semantic-authority-biz",
      message: "hello",
      messageId: `wamid.${turnScope}`,
      channel: "whatsapp_cloud",
      chatType: "dm",
      isGroupInbound: false,
      participantKey: "scoped-customer",
      catalogItems,
      canonicalSemanticDecision: {
        ...canonicalDecision(semanticIntent),
        turnScope,
        targetContext: turnScope,
        semanticIntent,
        factKind: "non_business",
      },
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      __testOrchestratorFn: (input) => {
        captured = input;
        return {
          workflowDecision: { workflowType: "clarification", reason: "scoped_safe" },
          actionPlan: {
            replyDraft: "Hello.",
            actions: [
              { type: "CREATE_BOOKING", payload: {} },
              { type: "REPLY", payload: { text: "Hello." } },
            ],
          },
          trace: {},
        };
      },
    });
    assert.equal(captured.turnContext.authoritativeSemanticIntent, undefined);
    assert.equal(captured.turnContext.canonicalSemanticDecision.turnScope, turnScope);
    assert.equal(result.messageMeta?.actionRouter?.actions?.some(
      (action) => action.type === "CREATE_BOOKING"
    ), false);
  }
});
