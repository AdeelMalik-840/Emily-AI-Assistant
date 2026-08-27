import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const {
  parseCloudDmOwnershipDecision,
  executeCloudDmOwnershipDecision,
  buildCloudDmOwnershipPromptFacts,
  validatePostConfirmSemanticOwnership,
  applyPostConfirmDerivedOwnershipMechanics,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const {
  applySessionMemoryFromActionPlan,
  readTrustedFreshItemFocus,
  stampRememberPresentedItemFocusForSingleVerifiedItem,
} = await import("../src/services/executors/sessionMemoryExecutor.js");
const { getEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);

const CIVIC_ID = "honda-civic";
const STONIC_ID = "kia-stonic";
const catalog = [
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic", pricing: { daily: 8000 } },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic", pricing: { daily: 7000 } },
];

function composeJson(reply, claims = []) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims,
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

function socialDecision() {
  return {
    turnScope: "SOCIAL_GENERAL",
    semanticIntent: "social",
    itemScope: "none",
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
    factKind: "non_business",
    capability: null,
    evidenceNeeds: [],
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function unclearDecision() {
  return {
    turnScope: "UNCLEAR",
    semanticIntent: "unclear",
    itemScope: "none",
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
    factKind: "vague",
    capability: null,
    evidenceNeeds: [],
  };
}

function civicDetailsDecision(message) {
  const start = message.indexOf("Civic");
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "details_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Civic",
        start,
        end: start + "Civic".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "freeform_business",
    capability: null,
    evidenceNeeds: [],
  };
}

function pricingDecision(message) {
  const start = message.indexOf("Civic");
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "pricing_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Civic",
        start,
        end: start + "Civic".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
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
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function transactionalLeak(text) {
  return /\b(available|availability|booking|booked|rent|price|owner[- ]?check)\b/i.test(
    String(text ?? "")
  );
}

test("social greetings use the Cloud social compose path without availability facts", async () => {
  const greetings = ["Hi", "Hello", "Salam", "Thanks", "Bye"];
  for (const message of greetings) {
    let composeUser = "";
    const live = await runBrainV2LivePipeline({
      traceId: `social-${message}`,
      businessId: "biz",
      message,
      channel: "whatsapp_cloud",
      chatType: "dm",
      catalogItems: catalog,
      canonicalSemanticDecision: socialDecision(),
      getBookingsForItemFn: async () => [],
      getBusinessProfileFn: async () => ({}),
      __cloudComposeChatCreate: async (args) => {
        composeUser = String(args?.messages?.[1]?.content ?? "");
        return composeJson("Salam, kya madad karun?");
      },
    });
    assert.match(composeUser, /KIND: social/);
    assert.match(composeUser, /TRUSTED_FACTS_JSON: \{\}/);
    assert.doesNotMatch(composeUser, /availabilityConfirmed/);
    assert.equal(live.customerTurnOutcome, "ANSWER");
    assert.equal(transactionalLeak(live.reply), false);
  }
});

test("social composer rejects transactional leaks and keeps AI wording only", async () => {
  const leaked = await composeCloudCanonicalCustomerReply({
    kind: "social",
    semanticIntent: "social",
    customerMessage: "Hi",
    trustedFacts: {},
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("Civic available nahi hai, rent 8000 hai."),
  });
  assert.equal(leaked.ok, false);

  const ok = await composeCloudCanonicalCustomerReply({
    kind: "social",
    semanticIntent: "social",
    customerMessage: "Hi",
    trustedFacts: {},
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("Salam, kya madad karun?"),
  });
  assert.equal(ok.ok, true);
  assert.equal(transactionalLeak(ok.reply), false);
});

test("delivered single Civic pricing reply persists trusted fresh item focus", () => {
  const sessionKey = `focus-civic-${Date.now()}`;
  const stamped = stampRememberPresentedItemFocusForSingleVerifiedItem(
    {
      actions: [
        {
          type: "REPLY",
          payload: { text: "Civic ka rent 8000 hai.", itemId: CIVIC_ID, itemLabel: "Honda Civic" },
        },
      ],
      persistenceIntent: { rememberResolvedItem: true, itemId: CIVIC_ID, execute: false },
    },
    { catalogItems: catalog, allow: true }
  );
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: stamped,
    sourceTurnId: "assistant:wamid.civic-price",
    outboundDelivered: false,
  });
  assert.equal(readTrustedFreshItemFocus(getEmilySessionState(sessionKey)), null);

  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: stamped,
    sourceTurnId: "assistant:wamid.civic-price",
    outboundDelivered: true,
  });
  const focus = readTrustedFreshItemFocus(getEmilySessionState(sessionKey));
  assert.equal(focus?.itemId, CIVIC_ID);
  assert.equal(focus?.provenance, "verified_assistant_presented_item");

  const follow = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "pricing_inquiry",
      itemScope: "specific",
      itemReferents: [
        {
          source: "trusted_fresh_focus",
          surfaceText: null,
          start: null,
          end: null,
          trustedItemId: null,
          sourceTurnId: null,
        },
      ],
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
    }),
    { customerMessage: "iska rent?", trustedFreshItemFocus: focus }
  );
  assert.equal(follow?.itemReferenceMode, "CONTEXTUAL");
  assert.equal(
    resolveCanonicalItemReferents(follow.itemReferents, catalog)[0].itemId,
    CIVIC_ID
  );
});

test("explicit Stonic after Civic focus binds Stonic, not Civic", () => {
  const civicFocus = {
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic",
    provenance: "verified_assistant_presented_item",
    sourceTurnId: "assistant:civic",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const message = "Stonic available hai?";
  const start = message.indexOf("Stonic");
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      itemScope: "specific",
      itemReferents: [
        {
          source: "current_turn",
          surfaceText: "Stonic",
          start,
          end: start + "Stonic".length,
          trustedItemId: null,
          sourceTurnId: null,
        },
      ],
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
    }),
    { customerMessage: message, trustedFreshItemFocus: civicFocus }
  );
  assert.equal(parsed?.itemReferenceMode, "CURRENT_TURN");
  assert.equal(
    resolveCanonicalItemReferents(parsed.itemReferents, catalog)[0].itemId,
    STONIC_ID
  );
});

test("multiple presented alternatives do not write arbitrary fresh focus", () => {
  const sessionKey = `focus-multi-${Date.now()}`;
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: {
      actions: [
        {
          type: "REPLY",
          payload: {
            verifiedAlternatives: [
              { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
              { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
            ],
            presentedItemIds: [CIVIC_ID, STONIC_ID],
          },
        },
      ],
      persistenceIntent: {
        rememberPresentedItemFocus: true,
        presentedItemId: CIVIC_ID,
        execute: false,
      },
    },
    outboundDelivered: true,
  });
  assert.equal(readTrustedFreshItemFocus(getEmilySessionState(sessionKey)), null);
});

test("Cloud Civic pricing pipeline stamps presented focus flags after a successful answer", async () => {
  const message = "Civic rent kitna hai?";
  const live = await runBrainV2LivePipeline({
    traceId: "civic-price-focus",
    businessId: "biz",
    message,
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: pricingDecision(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () =>
      composeJson("Civic ka rent 8,000 PKR per day hai.", ["quotation_verified"]),
  });
  const persistence = live.messageMeta?.actionPlan?.persistenceIntent;
  assert.equal(persistence?.rememberPresentedItemFocus, true);
  assert.equal(persistence?.presentedItemId, CIVIC_ID);
});

test("UNCLEAR with a known catalog span is rejected and ownership retries once", async () => {
  const message = "Civic mein child seat hai?";
  assert.equal(
    parseCloudDmOwnershipDecision(JSON.stringify(unclearDecision()), {
      customerMessage: message,
      catalogItems: catalog,
    }),
    null
  );
  assert.equal(
    validatePostConfirmSemanticOwnership(
      applyPostConfirmDerivedOwnershipMechanics(unclearDecision(), {
        currentCustomerMessage: message,
        catalogItems: catalog,
      }),
      { currentCustomerMessage: message, catalogItems: catalog }
    ).reason,
    "UNCLEAR_DESPITE_KNOWN_CATALOG_SPAN"
  );
  assert.ok(
    parseCloudDmOwnershipDecision(JSON.stringify(unclearDecision()), {
      customerMessage: "Hi",
      catalogItems: catalog,
    })
  );

  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: catalog },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      const payload = calls === 1 ? unclearDecision() : civicDetailsDecision(message);
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.ownershipCompletionCount, 2);
  assert.equal(result.ownershipCorrectionReason, "UNCLEAR_DESPITE_KNOWN_CATALOG_SPAN");
  assert.equal(result.decision.semanticIntent, "details_inquiry");
  assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
  assert.equal(
    resolveCanonicalItemReferents(result.decision.itemReferents, catalog)[0].itemId,
    CIVIC_ID
  );
});

test("named Stonic cannot stay CONTEXTUAL Civic focus", () => {
  const civicFocus = {
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic",
    provenance: "verified_assistant_presented_item",
    sourceTurnId: "assistant:civic",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const message = "Stonic available hai?";
  assert.equal(
    parseCloudDmOwnershipDecision(
      JSON.stringify({
        turnScope: "NEW_TRANSACTION",
        semanticIntent: "availability_inquiry",
        itemScope: "specific",
        itemReferents: [
          {
            source: "trusted_fresh_focus",
            surfaceText: null,
            start: null,
            end: null,
            trustedItemId: null,
            sourceTurnId: null,
          },
        ],
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
      }),
      {
        customerMessage: message,
        trustedFreshItemFocus: civicFocus,
        catalogItems: catalog,
      }
    ),
    null
  );
});

test("non-catalog current-turn span is rejected when a known catalog item is named", () => {
  const message = "Civic mein child seat hai?";
  assert.equal(
    parseCloudDmOwnershipDecision(
      JSON.stringify({
        turnScope: "NEW_TRANSACTION",
        semanticIntent: "details_inquiry",
        itemScope: "specific",
        itemReferents: [
          {
            source: "current_turn",
            surfaceText: "child seat",
            start: message.indexOf("child seat"),
            end: message.indexOf("child seat") + "child seat".length,
            trustedItemId: null,
            sourceTurnId: null,
          },
        ],
        targetReference: {
          source: "none",
          sourceTurnId: null,
          targetType: "none",
          targetId: null,
        },
        targetId: null,
        mutationIntent: "none",
        action: "reply",
        factKind: "freeform_business",
        capability: null,
        evidenceNeeds: [],
      }),
      { customerMessage: message, catalogItems: catalog }
    ),
    null
  );
});

test("ownership prompt keeps mutually exclusive pricing vs availability definitions", async () => {
  let system = "";
  await executeCloudDmOwnershipDecision({
    facts: { catalogItems: catalog },
    userMessage: "Hi",
    __chatCompletionsCreateForTests: async (args) => {
      system = String(args?.messages?.[0]?.content ?? "");
      return {
        choices: [{ message: { content: JSON.stringify(socialDecision()) } }],
      };
    },
  });
  assert.match(system, /semanticIntent families are mutually exclusive/i);
  assert.match(system, /pricing_inquiry: a price\/rate ask without a requested-duration total/);
  assert.match(
    system,
    /pricing_with_duration: an explicit price\/rent\/cost ask for a stated duration\/total/
  );
  assert.match(system, /availability_inquiry: an availability ask OR a weak need\/want\/chahiye/);
  assert.match(system, /booking_request: only an explicit final booking\/reserve\/confirm commitment/);
  assert.doesNotMatch(system, /child seat/i);
  const packed = buildCloudDmOwnershipPromptFacts({ catalogItems: catalog });
  assert.equal(packed.catalogItems, null);
});
