/**
 * Canonical Group V2: redundant layers must not retain conversational authority.
 * Asserts workflow/duration/item/continuation/reviewer/validation gates, not wording.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { understandTurn } = await import(
  "../src/brain/understanding/UnderstandingEngine.js"
);
const {
  selectWorkflow,
  canonicalGroupWorkflowFromResolvedContext,
} = await import("../src/brain/workflow/WorkflowEngine.js");
const { runConversationTurn } = await import(
  "../src/brain/orchestrator/ConversationOrchestrator.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { parseUserDuration } = await import("../src/duration/parseDuration.js");
const { buildTurnContextInput } = await import(
  "../src/brain/live/buildTurnContextInput.js"
);
const { resolveTurnContext } = await import(
  "../src/services/turnContextAuthority.js"
);
const { buildContinuationContext } = await import(
  "../src/brain/continuation/buildContinuationContext.js"
);
const { inactiveValidatedGroupContinuation } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const {
  VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  assertFrozenGroupCanonicalSemanticDecision,
  validateGroupCanonicalSemanticDecision,
} = await import(
  "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const {
  buildCanonicalGroupResponseContract,
  GROUP_RESPONSE_ACTS,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);

const ALPHA = { id: "synthetic_item_alpha", name: "Item Alpha", displayLabel: "Item Alpha" };
const BETA = { id: "synthetic_item_beta", name: "Product Beta", displayLabel: "Product Beta" };

function admitted(text) {
  return {
    turn: {
      turnId: "t1",
      businessId: "biz-auth",
      channelId: "whatsapp_web",
      chatKey: "group-auth",
      participantKey: "p1",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "t1",
    admissionReason: "test",
  };
}

function frozenDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Item Alpha",
        start: 0,
        end: 10,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    itemReferenceMode: "CURRENT_TURN",
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    semanticDecisionStatus: "released",
    semanticDecisionProvenance: VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
    ...overrides,
  };
}

test("workflow authority: Brain availability wins over regex pricing signals; selectWorkflow cannot override", () => {
  const understanding = understandTurn({
    admittedTurn: admitted("Corolla ka 2 months ka rent kitna hai?"),
    turnContext: {
      validatedGroupCanonicalAuthority: true,
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: [
        {
          source: "current_turn",
          surfaceText: "Corolla",
          start: 0,
          end: 7,
          trustedItemId: null,
          sourceTurnId: null,
        },
      ],
      canonicalItemResolutions: [
        {
          status: "MATCHED",
          itemId: ALPHA.id,
          itemLabel: ALPHA.displayLabel,
        },
      ],
    },
    catalogItems: [ALPHA],
  });
  assert.equal(understanding.signals.priceAsk, false);
  assert.equal(understanding.askedField, "availability");
  assert.equal(understanding.authoritativeSemanticIntent, "availability_inquiry");

  const adversarialUnderstanding = {
    ...understanding,
    signals: { ...understanding.signals, priceAsk: true },
    askedField: "price_with_duration",
    durationDays: 60,
  };
  const resolved = {
    validatedGroupCanonicalAuthority: true,
    decision: {
      workflowType: "availability_inquiry",
      primaryIntent: "availability_inquiry",
    },
  };
  const fromSelect = selectWorkflow({
    understanding: adversarialUnderstanding,
    turnContext: {},
    message: "Corolla ka 2 months ka rent kitna hai?",
    resolvedBusinessTurnContext: resolved,
  });
  assert.equal(fromSelect.workflowType, "availability_inquiry");
  assert.equal(fromSelect.reason, "validated_group_canonical_turn_decision");

  const orchestrated = runConversationTurn({
    traceId: "auth-wf",
    admittedTurn: admitted("Corolla ka 2 months ka rent kitna hai?"),
    turnContext: {
      businessId: "biz-auth",
      validatedGroupCanonicalAuthority: true,
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: [],
      canonicalItemResolutions: [],
    },
    businessContext: {
      catalogItems: [ALPHA],
      resolvedBusinessTurnContext: resolved,
    },
    mode: "live",
  });
  assert.equal(orchestrated.workflowDecision.workflowType, "availability_inquiry");
  assert.equal(
    canonicalGroupWorkflowFromResolvedContext(resolved).workflowType,
    "availability_inquiry"
  );
});

test("workflow engine bypass: missing Group workflowType does not fall through to regex pricing", () => {
  const understanding = {
    signals: { priceAsk: true, bookingCommitment: false },
    askedField: "price_with_duration",
    durationDays: 60,
    resolvedItemId: ALPHA.id,
    authoritativeSemanticIntent: "pricing_with_duration",
  };
  const decided = selectWorkflow({
    understanding,
    turnContext: {},
    message: "2 months ka rent?",
    resolvedBusinessTurnContext: {
      validatedGroupCanonicalAuthority: true,
      decision: { workflowType: "", primaryIntent: "availability_inquiry" },
    },
  });
  assert.equal(decided.workflowType, "clarification");
  assert.equal(decided.reason, "validated_group_missing_workflow_type");
});

test("duration authority: Brain requestedDuration exact 60 days wins over parseUserDuration", async () => {
  const message = "Item Alpha 2 maheeny ke liye chahiye";
  const regexDays = parseUserDuration(message)?.normalizedDays ?? null;
  assert.equal(regexDays, null);

  const catalog = [ALPHA];
  const referents = [
    {
      source: "current_turn",
      surfaceText: "Item Alpha",
      start: 0,
      end: 10,
      trustedItemId: null,
      sourceTurnId: null,
    },
  ];
  const resolutions = [
    {
      status: "MATCHED",
      referent: referents[0],
      itemId: ALPHA.id,
      itemLabel: ALPHA.displayLabel,
      catalogRow: ALPHA,
    },
  ];
  const start = message.indexOf("2 maheeny");
  const resolved = await resolveBusinessTurnContext({
    traceId: "auth-dur",
    businessId: "biz-auth",
    rawMessage: message,
    catalogItems: catalog,
    nowMs: Date.parse("2026-09-13T08:00:00.000Z"),
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
    turnContextInput: {
      chatType: "group",
      participantKey: "p1",
      chatId: "group-auth",
      validatedGroupCanonicalAuthority: true,
      authoritativeSemanticIntent: "availability_inquiry",
      authoritativeItem: { id: ALPHA.id, displayLabel: ALPHA.displayLabel },
      canonicalItemReferents: referents,
      canonicalItemResolutions: resolutions,
      duration: regexDays,
    },
    turnContext: {
      businessId: "biz-auth",
      authoritativeSemanticIntent: "availability_inquiry",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: referents,
      canonicalItemResolutions: resolutions,
      canonicalSemanticDecision: {
        turnScope: "NEW_TRANSACTION",
        semanticIntent: "availability_inquiry",
        requestedDuration: {
          status: "exact",
          components: [{ value: 2, unit: "months" }],
          evidence: {
            source: "current_turn",
            surfaceText: "2 maheeny",
            start,
            end: start + "2 maheeny".length,
          },
        },
        temporalRequest: { startDateKind: "none", startDate: null },
      },
    },
  });
  assert.equal(resolved.turn.durationDays, 60);
  assert.equal(resolved.decision.workflowType, "availability_inquiry");
  assert.notEqual(resolved.turn.durationDays, regexDays);
});

test("understandTurn on Group canonical does not emit regex duration or price field", () => {
  const understanding = understandTurn({
    admittedTurn: admitted("Product Beta 9 din ka rent kitna hai?"),
    turnContext: {
      validatedGroupCanonicalAuthority: true,
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalItemReferents: [
        {
          source: "current_turn",
          surfaceText: "Item Alpha",
          start: 0,
          end: 10,
        },
      ],
      canonicalItemResolutions: [
        { status: "MATCHED", itemId: ALPHA.id, itemLabel: ALPHA.displayLabel },
      ],
    },
    catalogItems: [ALPHA, BETA],
  });
  assert.equal(understanding.durationDays, undefined);
  assert.equal(understanding.askedField, "availability");
  assert.equal(understanding.signals.priceAsk, false);
  assert.equal(understanding.resolvedItemId, ALPHA.id);
});

test("item authority: canonical Item Alpha wins over fuzzy Product Beta in the message", () => {
  const authority = resolveTurnContext({
    message: "Product Beta available hai?",
    catalogItems: [ALPHA, BETA],
    participantKey: "p1",
    isGroupInbound: true,
    authoritativeSemanticIntent: "availability_inquiry",
    authoritativeItemScope: "specific",
    validatedGroupCanonicalAuthority: true,
    canonicalItemReferents: [
      {
        source: "current_turn",
        surfaceText: "Item Alpha",
        start: 0,
        end: 10,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
  });
  assert.equal(authority.validatedGroupCanonicalAuthorityActive, true);
  assert.equal(authority.authoritativeItem?.id, ALPHA.id);
  assert.notEqual(authority.authoritativeItem?.id, BETA.id);
  assert.equal(authority.shouldClarifyItem, false);

  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: "biz-auth",
    chatId: "group-auth",
    messageText: "Product Beta 9 din ke liye",
    participantKey: "p1",
    isGroupInbound: true,
    catalogItems: [ALPHA, BETA],
    authoritativeSemanticIntent: "availability_inquiry",
    authoritativeItemScope: "specific",
    validatedGroupCanonicalAuthority: true,
    canonicalItemReferents: [
      {
        source: "current_turn",
        surfaceText: "Item Alpha",
        start: 0,
        end: 10,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
  });
  assert.equal(input.duration, null);
  assert.equal(input.requestedField, "availability");
  assert.equal(input.authoritativeItem?.id, ALPHA.id);
});

test("continuation authority: trusted Group freeze wins over buildContinuationContext steal", () => {
  const memorySnapshot = {
    emilyPending: {
      pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
      itemId: ALPHA.id,
      itemLabel: ALPHA.displayLabel,
      participantKey: "other-participant",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const legacy = buildContinuationContext({
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    participantKey: "p1",
    groupChatKey: "group-auth",
    memorySnapshot,
  });
  assert.equal(legacy.active, true);
  assert.equal(legacy.safeToOwn, false);

  const frozen = inactiveValidatedGroupContinuation({
    turnScope: "NEW_TRANSACTION",
  });
  assert.equal(frozen.active, false);
  assert.equal(frozen.safeToOwn, false);
  assert.equal(frozen.bypassGenericRouting, false);
  assert.equal(frozen.source, "validated_group_canonical");
  assert.equal(frozen.itemId, null);
});

test("double validation: frozen decision asserts without re-running catalog/span rejection", () => {
  const decision = frozenDecision();
  const assertion = assertFrozenGroupCanonicalSemanticDecision(decision);
  assert.equal(assertion.ok, true);

  const full = validateGroupCanonicalSemanticDecision(decision, {
    customerMessage: "Item Alpha available hai?",
    catalogItems: [ALPHA],
  });
  assert.equal(full.ok, true);

  const corrupt = frozenDecision({
    mutationIntent: "cancel",
    action: "mutate",
  });
  const corruptAssert = assertFrozenGroupCanonicalSemanticDecision(corrupt);
  assert.equal(corruptAssert.ok, false);
  assert.equal(corruptAssert.reason, "GROUP_PROTECTED_ACTION_REJECTED");

  const missingIntent = frozenDecision({ semanticIntent: "not_a_real_intent" });
  const missing = assertFrozenGroupCanonicalSemanticDecision(missingIntent);
  assert.equal(missing.ok, false);
});

test("response authority: reviewer rewrite cannot replace ASK_FOR_DURATION candidate", async () => {
  const contract = buildCanonicalGroupResponseContract({
    replyKind: "duration_ask",
    trustedCustomerFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    customerMessageText: "Corolla available hai?",
  });
  assert.equal(contract.requiredAct, GROUP_RESPONSE_ACTS.ASK_FOR_DURATION);

  const primary = "Corolla kitne din ke liye chahiye?";
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available hai?",
    trustedFacts: { itemId: "corolla-1", itemLabel: "Corolla" },
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: primary,
              replySemantics: {
                claims: [],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
              customerInputRequested: true,
              requestedInput: "rental_period",
              availabilityCheckStarted: false,
            }),
          },
        },
      ],
    }),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              quality: reviewCalls === 1 ? "rewrite" : "pass",
              issues: reviewCalls === 1 ? ["unnatural_word_order"] : [],
              dimensionChecks: {
                naturalWordOrder: reviewCalls === 1 ? "rewrite" : "pass",
                modifierAttachment: "pass",
                spokenFluency: "pass",
                directnessAndEfficiency: "pass",
                objectiveFidelity: "pass",
                catalogDetailProportionality: "pass",
                personaConsistency: "pass",
                nativeLanguageExpression: "pass",
              },
              reply: "Aapko Corolla kitne din ke liye chahiye hogi?",
              replySemantics: {
                claims: [],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
              customerInputRequested: true,
              requestedInput: "rental_period",
              availabilityCheckStarted: false,
            }),
          },
        },
      ],
    };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, primary);
  assert.doesNotMatch(result.reply, /chahiye hogi/);
});
