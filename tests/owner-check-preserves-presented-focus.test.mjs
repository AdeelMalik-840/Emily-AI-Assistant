/**
 * Live stability: after Corolla price → duration price → availability/owner-check
 * holding, itemless "4 din ka rent kitna ho ga?" must keep Corolla presented
 * focus and answer the 4-day total (not "Kis option…").
 *
 * Root cause: buildOwnerCheckActionPlan remembered resolved item + duration
 * without rememberPresentedItemFocus, so sessionMemoryExecutor cleared
 * lastFreshItemFocus on the AVR/holding turn.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { buildOwnerCheckActionPlan } = await import(
  "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
);
const {
  applySessionMemoryFromActionPlan,
  readTrustedFreshItemFocus,
  readVerifiedSinglePresentedItemFromActionPlan,
} = await import("../src/services/executors/sessionMemoryExecutor.js");
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { runConversationTurn } = await import(
  "../src/brain/orchestrator/ConversationOrchestrator.js"
);

const COROLLA = {
  id: "toyota_corolla_1",
  name: "Corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};

test("owner-check plan stamps presented focus so memory does not wipe it", () => {
  const plan = buildOwnerCheckActionPlan({
    canonical: {
      businessId: "biz-1",
      turn: { durationDays: 4 },
      verified: { availability: { status: "available", isAvailable: true } },
    },
    itemId: COROLLA.id,
    itemLabel: COROLLA.displayLabel,
    durationN: 4,
    execute: true,
  });
  assert.equal(plan.persistenceIntent.rememberPresentedItemFocus, true);
  assert.equal(plan.persistenceIntent.presentedItemId, COROLLA.id);
  assert.equal(plan.persistenceIntent.rememberDuration, true);
  assert.equal(plan.persistenceIntent.durationDays, 4);
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.deepEqual(reply?.payload?.presentedItemIds, [COROLLA.id]);
  assert.deepEqual(readVerifiedSinglePresentedItemFromActionPlan(plan), {
    itemId: COROLLA.id,
    itemLabel: COROLLA.displayLabel,
  });

  const sessionKey = "biz::leads::participant::owner-check-focus";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan,
    sourceTurnId: "assistant:owner-check-holding",
    outboundDelivered: true,
    authoritativeItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
  });
  const state = peekEmilySessionState(sessionKey);
  assert.equal(state?.lastResolvedItemId, COROLLA.id);
  assert.equal(state?.lastDurationDays, 4);
  assert.equal(state?.lastFreshItemFocus?.itemId, COROLLA.id);
  assert.ok(readTrustedFreshItemFocus(state));
});

test("after owner-check memory, itemless 4 din rent ask → Corolla pricing_with_duration", async () => {
  const sessionKey = "biz::car-rental-queries::participant::price-after-avr";
  const plan = buildOwnerCheckActionPlan({
    canonical: {
      businessId: "biz-1",
      turn: { durationDays: 4 },
      verified: { availability: { status: "available", isAvailable: true } },
    },
    itemId: COROLLA.id,
    itemLabel: COROLLA.displayLabel,
    durationN: 4,
    execute: true,
  });
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan,
    sourceTurnId: "assistant:owner-check-holding",
    outboundDelivered: true,
    authoritativeItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
  });
  const memorySnapshot = peekEmilySessionState(sessionKey);
  assert.equal(memorySnapshot?.lastFreshItemFocus?.itemId, COROLLA.id);

  const message = "4 din ka rent kitna ho ga?";
  const durationSurface = "4 din";
  const durationStart = message.indexOf(durationSurface);
  const canonicalItemReferents = [
    {
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: null,
      sourceTurnId: null,
    },
  ];
  const turnContext = {
    businessId: "biz-1",
    chatKey: "car-rental-queries",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: "pricing_inquiry",
    canonicalItemReferents,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "pricing_inquiry",
      itemScope: "specific",
      itemReferents: canonicalItemReferents,
      itemReferenceMode: "CONTEXTUAL",
      temporalRequest: { startDateKind: "none", startDate: null },
      requestedDuration: {
        status: "exact",
        components: [{ value: 4, unit: "days" }],
        evidence: {
          source: "current_turn",
          surfaceText: durationSurface,
          start: durationStart,
          end: durationStart + durationSurface.length,
        },
      },
    },
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: "price-after-avr",
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: [COROLLA],
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "car-rental-queries",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents,
      memorySnapshot,
      authoritativeItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: "price-after-avr",
    admittedTurn: {
      turn: {
        turnId: "t-price",
        businessId: "biz-1",
        channelId: "whatsapp_web",
        chatKey: "car-rental-queries",
        participantKey: "scope::p1",
        text: message,
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: "t-price",
      admissionReason: "test",
    },
    turnContext,
    businessContext: {
      catalogItems: [COROLLA],
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });

  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(
    resolvedBusinessTurnContext.decision.workflowType,
    "pricing_with_duration"
  );
  assert.equal(result.workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.status, "resolved");
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 20000);
  assert.doesNotMatch(
    String(result.actionPlan?.replyDraft ?? ""),
    /Kis option/i
  );
  assert.match(String(result.actionPlan?.replyDraft ?? ""), /20,?000|4 din/i);
});
