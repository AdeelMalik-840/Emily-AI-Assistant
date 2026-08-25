import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const {
  executeCloudDmOwnershipDecision,
  parseCloudDmOwnershipDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);
const {
  persistCloudInboundSemanticDecision,
  getCloudInboundSemanticDecision,
  __clearInboundTurnLedgerForTests,
} = await import("../src/services/inboundTurnLedger.js");
const { buildTurnContextInput } = await import(
  "../src/brain/live/buildTurnContextInput.js"
);
const { buildShadowTurnContext } = await import(
  "../src/brain/shadow/brainShadowHook.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { composeUnknownItemCustomerReply } = await import(
  "../src/brain/openai/composeUnknownItemCustomerReply.js"
);
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

const catalog = [{ id: "civic", name: "Honda Civic", displayLabel: "Honda Civic (White)", pricing: { daily: 8000 } }];

function currentReferent(message, surfaceText) {
  const start = message.indexOf(surfaceText);
  return { source: "current_turn", surfaceText, start, end: start + surfaceText.length, trustedItemId: null, sourceTurnId: null };
}

function decision(message, semanticIntent, itemScope, referents) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent,
    itemScope,
    itemReferents: referents,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
  };
}

test("one ownership completion preserves unknown availability and pricing referents", async () => {
  for (const [message, intent] of [["Revo available hai?", "availability_inquiry"], ["Revo ka rent kitna hai?", "pricing_inquiry"]]) {
    let calls = 0;
    const result = await executeCloudDmOwnershipDecision({
      facts: {},
      userMessage: message,
      __chatCompletionsCreateForTests: async () => {
        calls += 1;
        return { choices: [{ message: { content: JSON.stringify(decision(message, intent, "specific", [currentReferent(message, "Revo")])) } }] };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    assert.equal(result.decision.semanticIntent, intent);
    assert.deepEqual(result.decision.itemReferents, [currentReferent(message, "Revo")]);
  }
});

test("known, broad, and bounded multi-item referents remain structurally distinct", () => {
  const known = "Honda Civic available hai?";
  assert.equal(resolveCanonicalItemReferents([currentReferent(known, "Honda Civic")], catalog)[0].status, "MATCHED");
  assert.deepEqual(resolveCanonicalItemReferents([], catalog), []);
  const multi = "Honda Civic or Revo available hain?";
  const resolved = resolveCanonicalItemReferents([
    currentReferent(multi, "Honda Civic"),
    currentReferent(multi, "Revo"),
  ], catalog);
  assert.deepEqual(resolved.map((row) => row.status), ["MATCHED", "NOT_MATCHED"]);
});

test("invalid spans and invented trusted focus IDs fail closed", () => {
  const message = "Revo available hai?";
  assert.equal(parseCloudDmOwnershipDecision(JSON.stringify(decision(message, "availability_inquiry", "specific", [{ ...currentReferent(message, "Revo"), end: 5 }])), { customerMessage: message }), null);
  const fresh = { itemId: "civic", sourceTurnId: "assistant-turn-1" };
  const payload = decision(message, "pricing_inquiry", "specific", [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: "invented", sourceTurnId: "assistant-turn-1" }]);
  assert.equal(parseCloudDmOwnershipDecision(JSON.stringify(payload), { customerMessage: message, trustedFreshItemFocus: fresh }), null);
});

test("ledger preserves item referents write-once across resume", () => {
  __clearInboundTurnLedgerForTests();
  const message = "Revo ka rent kitna hai?";
  const itemReferents = [currentReferent(message, "Revo")];
  const identity = { chatKey: "referent-chat", stableId: "wamid.referent", guaranteeKey: "referent-chat::wamid.referent" };
  const snapshot = { ...decision(message, "pricing_inquiry", "specific", itemReferents), semanticDecisionStatus: "released", ownershipLane: "normal_routing" };
  assert.equal(persistCloudInboundSemanticDecision({ identity, decision: snapshot, semanticDecisionStatus: "released", ownershipLane: "normal_routing" }).ok, true);
  assert.deepEqual(getCloudInboundSemanticDecision({ identity })?.itemReferents, itemReferents);
  assert.equal(persistCloudInboundSemanticDecision({ identity, decision: { ...snapshot, itemReferents: [currentReferent(message, "rent")] }, semanticDecisionStatus: "released", ownershipLane: "normal_routing" }).reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
});

test("authoritative unknown pricing stays pricing and cannot become unlisted", async () => {
  const message = "Revo ka rent kitna hai?";
  const itemReferents = [currentReferent(message, "Revo")];
  const input = buildTurnContextInput({ channel: "whatsapp_cloud", chatType: "dm", businessId: "biz", chatId: "dm", messageText: message, participantKey: "customer", catalogItems: catalog, authoritativeSemanticIntent: "pricing_inquiry", canonicalItemReferents: itemReferents });
  const turnContext = buildShadowTurnContext({ businessId: "biz", sessionKey: "dm", participantKey: "customer", memorySnapshot: {} });
  turnContext.authoritativeSemanticIntent = "pricing_inquiry";
  turnContext.canonicalSemanticDecision = { ...decision(message, "pricing_inquiry", "specific", itemReferents), semanticDecisionStatus: "released" };
  turnContext.canonicalItemReferents = itemReferents;
  turnContext.canonicalItemResolutions = input.canonicalItemResolutions;
  const facts = await resolveBusinessTurnContext({ traceId: "unknown-pricing", businessId: "biz", rawMessage: message, turnContextInput: input, turnContext, catalogItems: catalog, getBookingsForItemFn: async () => [], getBusinessProfileFn: async () => ({}), log: false });
  assert.equal(facts.resolvedItem.status, "not_matched");
  assert.equal(facts.resolvedItem.displayLabel, "Revo");
  assert.equal(facts.decision.workflowType, "pricing_inquiry");
  assert.notEqual(facts.decision.workflowType, "unlisted_item");
  assert.deepEqual(facts.verified.availability.verifiedAlternatives, []);
  let prompt = "";
  const composed = await composeUnknownItemCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Revo",
    customerMessage: message,
    __chatCompletionsCreateForTests: async (args) => {
      prompt = JSON.stringify(args.messages);
      return { choices: [{ message: { content: JSON.stringify({
        customerReply: "Revo ka verified rate catalog mein available nahi hai.",
        mentionedReferents: ["Revo"],
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }] };
    },
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.reply, "Revo ka verified rate catalog mein available nahi hai.");
  assert.equal(prompt.includes('verifiedAlternatives\\":[]'), true);
  assert.doesNotMatch(prompt, /Honda Civic/);

  const frozen = {
    ...decision(message, "pricing_inquiry", "specific", itemReferents),
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
  const live = await runBrainV2LivePipeline({
    traceId: "unknown-pricing-live",
    businessId: "biz",
    message,
    messageId: "wamid.unknown-pricing",
    channel: "whatsapp_cloud",
    chatType: "dm",
    participantKey: "customer",
    catalogItems: catalog,
    canonicalSemanticDecision: frozen,
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __unknownItemComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Revo ka verified rate available facts mein nahi mila.",
      mentionedReferents: ["Revo"],
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
    }) } }] }),
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "pricing_inquiry", reason: "test" },
      actionPlan: {
        workflowType: "pricing_inquiry",
        replyDraft: "legacy draft",
        actions: [{ type: "REPLY", payload: { field: "price", text: "legacy draft", execute: false } }],
      },
      trace: {},
    }),
  });
  assert.equal(live.workflowType, "pricing_inquiry");
  assert.equal(live.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE");
  assert.equal(live.reply, "Revo ka verified rate available facts mein nahi mila.");
  assert.doesNotMatch(live.reply, /Honda Civic/);

  const availabilityMessage = "Revo available hai?";
  const availabilityReferents = [currentReferent(availabilityMessage, "Revo")];
  const availabilityLive = await runBrainV2LivePipeline({
    traceId: "unknown-availability-live",
    businessId: "biz",
    message: availabilityMessage,
    messageId: "wamid.unknown-availability",
    channel: "whatsapp_cloud",
    chatType: "dm",
    participantKey: "customer",
    catalogItems: catalog,
    canonicalSemanticDecision: {
      ...decision(availabilityMessage, "availability_inquiry", "specific", availabilityReferents),
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __unknownItemComposeChatCreate: async () => ({ choices: [{ message: { content: JSON.stringify({
      customerReply: "Revo ki availability verify nahi ho saki.",
      mentionedReferents: ["Revo"],
      replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
    }) } }] }),
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "availability_inquiry", reason: "test" },
      actionPlan: {
        workflowType: "availability_inquiry",
        replyDraft: "legacy draft",
        actions: [{ type: "REPLY", payload: { field: "availability", text: "legacy draft", execute: false } }],
      },
      trace: {},
    }),
  });
  assert.equal(availabilityLive.workflowType, "availability_inquiry");
  assert.equal(availabilityLive.reply, "Revo ki availability verify nahi ho saki.");
  assert.equal(availabilityLive.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE");
  assert.doesNotMatch(availabilityLive.reply, /Honda Civic/);
});
