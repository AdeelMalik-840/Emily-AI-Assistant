import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "business-1";

const {
  applyAvailabilityCustomerResponse,
  buildAvailabilityInquiryActionPlan,
} = await import("../src/brain/workflows/AvailabilityInquiryWorkflow.js");
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { assertLiveActionPlanIsSafe } = await import(
  "../src/brain/live/actionRouter.js"
);
const { BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY } = await import(
  "../src/brain/live/brainRouteGate.js"
);
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

const ITEM_ID = "catalog_item_1";
const ITEM_LABEL = "Toyota Corolla";

function admitted(text = "Corolla available hai?") {
  return {
    turn: {
      turnId: "turn-1",
      businessId: "business-1",
      channelId: "whatsapp_web",
      chatKey: "group-1",
      participantKey: "participant-1",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "turn-1",
    admissionReason: "test",
  };
}

function context({
  pending = null,
  durationDays = null,
  availability = {},
  availabilityConversationTransition = null,
} = {}) {
  return {
    resolvedBusinessTurnContext: {
      participant: { key: "participant-1" },
      sourceIdentity: { participantKey: "participant-1" },
      emilyPending: pending,
      turn: { durationDays, sourceTurnKey: "source-turn-1" },
      resolvedItem: {
        status: "resolved",
        id: ITEM_ID,
        name: ITEM_LABEL,
        displayLabel: ITEM_LABEL,
      },
      verified: {
        availability: {
          status: "available",
          isAvailable: true,
          source: "computeUserFacingAvailability",
          bookingAware: true,
          blockingBookingCount: 0,
          ...availability,
        },
      },
      ...(availabilityConversationTransition
        ? { availabilityConversationTransition }
        : {}),
    },
  };
}

function buildPlan(options = {}) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted(options.message),
    understanding: {
      resolvedItemId: ITEM_ID,
      resolvedItemLabel: ITEM_LABEL,
      itemSource: "explicit",
      itemConfidence: "high",
      intentsRanked: ["availability_check"],
      askedField: "availability",
    },
    catalogItems: [{ id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL }],
    businessContext: context(options),
  });
}

test("initial duration request is structured and contains no workflow-authored reply", () => {
  const plan = buildPlan();
  assert.equal(plan.replyDraft, "");
  assert.equal(plan.actions[0].payload.text, "");
  assert.equal(plan.customerResponseComposition.kind, "duration_ask");
  assert.equal(plan.customerResponseComposition.conversationStage, "initial_request");
  assert.equal(plan.persistenceIntent.rememberEmilyPending, true);
  assertLiveActionPlanIsSafe(plan, {});

  const materialized = applyAvailabilityCustomerResponse(plan, {
    reply: "Corolla kitne din ya kin dates ke liye chahiye?",
  });
  assert.equal(materialized.actions[0].payload.text, materialized.replyDraft);
  assert.equal(
    materialized.persistenceIntent.emilyPending.pendingQuestion,
    materialized.replyDraft
  );
  assert.equal(
    materialized.persistenceIntent.pendingAction.pendingQuestion,
    materialized.replyDraft
  );
  assert.equal(materialized.persistenceIntent.emilyPending.itemId, ITEM_ID);
});

test("same participant and item is already waiting for duration: pending is renewed (freshness extended), never recreated as a new transaction", () => {
  // Live-proven fix: previously this case skipped persistence entirely
  // (rememberEmilyPending/setPendingAction stayed undefined), so the
  // durable record's TTL was never extended while Emily kept waiting --
  // if the customer took long enough to reply, it silently expired
  // mid-conversation. It must now be renewed: same identity
  // (sourceTurnKey), extended freshness (expiresAt).
  const originalExpiresAt = new Date(Date.now() + 60_000).toISOString();
  const pending = {
    type: "collect_availability_duration",
    status: "awaiting",
    pendingStage: "availability_duration",
    pendingQuestion: "Previous assistant duration question",
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    participantKey: "participant-1",
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "prior-turn",
    expiresAt: originalExpiresAt,
  };
  const plan = buildPlan({ pending, message: "available hai?" });
  assert.equal(
    plan.customerResponseComposition.conversationStage,
    "already_waiting_for_duration"
  );
  assert.equal(plan.persistenceIntent.rememberEmilyPending, true);
  assert.equal(plan.persistenceIntent.setPendingAction, true);
  assert.equal(plan.persistenceIntent.itemId, ITEM_ID);
  assert.equal(plan.persistenceIntent.emilyPending.itemId, ITEM_ID);
  // Original transaction identity preserved, never rolled forward to this
  // turn's own sourceTurnKey ("source-turn-1").
  assert.equal(plan.persistenceIntent.emilyPending.sourceTurnKey, "prior-turn");
  assert.ok(
    new Date(plan.persistenceIntent.emilyPending.expiresAt).getTime() >
      new Date(originalExpiresAt).getTime(),
    "renewal must extend expiresAt, not leave the original near-expiry value"
  );
});

test("pending state remains participant-isolated", () => {
  const plan = buildPlan({
    pending: {
      pendingStage: "availability_duration",
      pendingQuestion: "Other participant question",
      itemId: ITEM_ID,
      participantKey: "participant-2",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal(plan.customerResponseComposition.conversationStage, "initial_request");
  assert.equal(plan.persistenceIntent.rememberEmilyPending, true);
});

test("guarded composer receives history and structured continuation state", async () => {
  let request = null;
  const out = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    recentDialogue: "User: Corolla available hai?\nAssistant: Corolla kitne din ke liye chahiye?",
    conversationStage: "already_waiting_for_duration",
    trustedFacts: {
      itemId: ITEM_ID,
      itemLabel: ITEM_LABEL,
      missingField: "duration_or_dates",
    },
    __chatCompletionsCreateForTests: async (args) => {
      request = args;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Corolla ke liye duration ya dates bata dein.",
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }) } }],
      };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.source, "openai_group_availability_compose");
  const user = request.messages.find((row) => row.role === "user").content;
  assert.match(user, /already_waiting_for_duration/);
  assert.match(user, /Previous|Assistant: Corolla kitne din/i);
});

test("alternatives composer rejects untrusted presented IDs and accepts exact trusted alternatives", async () => {
  const alternatives = [
    { itemId: "alt-1", itemLabel: "Kia Stonic" },
    { itemId: "alt-2", itemLabel: "Honda Civic" },
  ];
  let attempt = 0;
  const out = await composeCloudCanonicalCustomerReply({
    kind: "availability_alternatives",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "aur options?",
    trustedFacts: {
      verifiedAlternatives: alternatives,
      verifiedAlternativesCount: alternatives.length,
    },
    __chatCompletionsCreateForTests: async () => {
      attempt += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Kia Stonic aur Honda Civic available options hain. Kaunsi dekhni hai?",
          presentedItemIds: attempt === 1 ? ["invented"] : ["alt-1", "alt-2"],
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }) } }],
      };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.attemptCount, 2);
  assert.deepEqual(out.presentedItemIds, ["alt-1", "alt-2"]);
});

test("temporal clarification and unavailable branches expose structured facts, not replies", () => {
  const temporal = buildPlan({
    durationDays: 3,
    availability: {
      status: "unknown",
      dateWindowConfidence: "temporal_unresolved",
      temporalUnresolvedReason: "invalid_date",
    },
    availabilityConversationTransition: {
      resultingState: "NEED_TEMPORAL_CLARIFICATION",
    },
  });
  assert.equal(temporal.replyDraft, "");
  assert.equal(temporal.customerResponseComposition.kind, "temporal_clarification");
  assert.equal(temporal.customerResponseComposition.missingField, "start_date");

  const unavailable = buildPlan({
    durationDays: 3,
    availability: {
      status: "unavailable",
      isAvailable: false,
      reason: "booking_conflict",
      windowApplied: true,
      blockingBookingCount: 1,
      verifiedAlternatives: [{ itemId: "alt-1", itemLabel: "Kia Stonic" }],
    },
  });
  assert.equal(unavailable.replyDraft, "");
  assert.equal(unavailable.customerResponseComposition.kind, "availability_unavailable");
  assert.deepEqual(unavailable.customerResponseComposition.verifiedAlternatives, [
    { itemId: "alt-1", itemLabel: "Kia Stonic" },
  ]);
  assert.equal(unavailable.actions[0].type, "REPLY");
  assert.equal(unavailable.actions[0].payload.itemId, ITEM_ID);
});

test("unavailable composer cannot promote a model-invented alternative ID", async () => {
  let attempts = 0;
  const out = await composeCloudCanonicalCustomerReply({
    kind: "availability_unavailable",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla 3 din ke liye available hai?",
    trustedFacts: {
      itemId: ITEM_ID,
      itemLabel: ITEM_LABEL,
      durationDays: 3,
      availabilityStatus: "unavailable",
      verifiedAlternatives: [],
      verifiedAlternativesCount: 0,
    },
    fallbackReply: "Maazrat, abhi yeh maloomat share nahi kar pa rahi.",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Corolla available nahi hai; invented option dekh lein.",
          presentedItemIds: ["invented-id"],
          offersAlternatives: true,
          replySemantics: {
            claims: ["resource_unavailable"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 2);
  assert.notEqual(out.source, "openai_group_availability_compose");
  assert.deepEqual(out.presentedItemIds, []);
});

test("emergency customer fallback exposes no implementation internals", () => {
  assert.doesNotMatch(
    BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY,
    /system|\bAI\b|model|database|technical|owner|approval|manual review/i
  );
});

test("Group and Cloud availability each send one guarded composed reply", async () => {
  for (const channelCase of [
    { channel: "whatsapp_web", chatType: "group", isGroupInbound: true },
    { channel: "whatsapp_cloud", chatType: "dm", isGroupInbound: false },
  ]) {
    let composeCalls = 0;
    const result = await runBrainV2LivePipeline({
      traceId: `stage1-${channelCase.chatType}`,
      businessId: "business-1",
      message: "Corolla available hai?",
      messageId: `message-${channelCase.chatType}`,
      participantKey: "participant-1",
      sessionKey: `session-${channelCase.chatType}`,
      conversationHistory: "Customer: Corolla available hai?",
      catalogItems: [
        {
          id: ITEM_ID,
          name: ITEM_LABEL,
          displayLabel: ITEM_LABEL,
          availability: true,
          isAvailable: true,
        },
      ],
      getBusinessProfileFn: async () => null,
      getBookingsForItemFn: async () => [],
      __cloudComposeChatCreate: async () => {
        composeCalls += 1;
        return {
          choices: [{ message: { content: JSON.stringify({
            customerReply: "Corolla kitne din ya kin dates ke liye chahiye?",
            customerInputRequested: true,
            requestedInput: "rental_period",
            availabilityCheckStarted: false,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }) } }],
        };
      },
      ...channelCase,
    });
    assert.equal(result.handled, true, channelCase.chatType);
    assert.equal(result.reply, "Corolla kitne din ya kin dates ke liye chahiye?");
    assert.equal(composeCalls, 1, channelCase.chatType);
    assert.equal(result.workflowType, "availability_inquiry");
  }
});

test("normal active-blocking availability wording is composed once from verified facts", async () => {
  let composeCalls = 0;
  const result = await runBrainV2LivePipeline({
    traceId: "stage1-active-blocking",
    businessId: "business-1",
    message: "Corolla available hai?",
    messageId: "message-active",
    participantKey: "participant-1",
    sessionKey: "session-active",
    catalogItems: [
      { id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL, isAvailable: true },
    ],
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [
      {
        id: "booking-1",
        itemId: ITEM_ID,
        status: "approved",
        startAt: new Date(Date.now() - 60_000),
        endAt: new Date(Date.now() + 60_000),
      },
    ],
    __cloudComposeChatCreate: async () => {
      composeCalls += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Corolla is waqt booked hai.",
          replySemantics: {
            claims: ["resource_unavailable"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }) } }],
      };
    },
  });
  assert.equal(result.reply, "Corolla is waqt booked hai.");
  assert.equal(composeCalls, 1);
  assert.equal(result.workflowType, "availability_inquiry");
});
