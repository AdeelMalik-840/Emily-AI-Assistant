/**
 * Stability matrix: each critical Group routing case runs 10 times with
 * injected Brain variants (including adversarial labels) so flaky semantic
 * output cannot flip the customer outcome.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { runConversationTurn } = await import(
  "../src/brain/orchestrator/ConversationOrchestrator.js"
);
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const { buildOwnerCheckActionPlan } = await import(
  "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
);
const {
  applySessionMemoryFromActionPlan,
  readTrustedFreshItemFocus,
} = await import("../src/services/executors/sessionMemoryExecutor.js");
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);

const STONIC = {
  id: "kia_stonic_1",
  name: "Stonic",
  displayLabel: "Kia Stonic EX Plus 2021",
  pricing: { daily: 7000, currency: "PKR" },
};
const CIVIC = {
  id: "honda_civic_1",
  name: "Civic",
  displayLabel: "Honda Civic 2026 Oriel",
  pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
};
const COROLLA = {
  id: "toyota_corolla_1",
  name: "Corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};
const CATALOG = [STONIC, CIVIC, COROLLA];
const RUNS = 10;

function focusFor(item, provenance = "verified_assistant_presented_item") {
  const now = Date.now();
  return {
    itemId: item.id,
    itemLabel: item.displayLabel,
    provenance,
    sourceTurnId: `assistant:${item.id}`,
    createdAt: new Date(now - 30000).toISOString(),
    expiresAt: new Date(now + 14 * 60000).toISOString(),
  };
}

function pendingFor(item) {
  const now = Date.now();
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: `Aapko ${item.name} kitne din chahiye?`,
    itemId: item.id,
    itemLabel: item.displayLabel,
    customerReference: item.name,
    participantKey: "scope::p1",
    chatScopeKey: "leads",
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "leads::wa::P1",
    createdAt: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 25 * 60000).toISOString(),
  };
}

async function runGroupTurn({
  message,
  semanticIntent,
  durationDays = null,
  durationEvidence = true,
  emilyPending = null,
  lastTransactionalSemanticIntent = null,
  lastResolvedItemId = null,
  lastFreshItemFocus = null,
  itemReferents = null,
  catalogItems = CATALOG,
}) {
  const durationSurface =
    durationDays != null && message.includes(`${durationDays} din`)
      ? `${durationDays} din`
      : durationDays != null
        ? `${durationDays} din`
        : null;
  const durationStart =
    durationSurface != null ? message.indexOf(durationSurface) : -1;
  const useEvidence =
    durationEvidence !== false && durationDays != null && durationStart >= 0;
  const canonicalItemReferents =
    itemReferents ??
    [
      {
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ];
  const memorySnapshot = {
    emilyPending,
    pendingTemporalClarification: null,
    lastTransactionalSemanticIntent,
    lastResolvedItemId,
    lastItem: lastResolvedItemId
      ? catalogItems.find((row) => row.id === lastResolvedItemId) ?? null
      : null,
    lastFreshItemFocus,
  };
  const turnContext = {
    businessId: "biz-1",
    chatKey: "leads",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: semanticIntent,
    canonicalItemReferents,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent,
      itemScope: "specific",
      itemReferents: canonicalItemReferents,
      itemReferenceMode: "CONTEXTUAL",
      temporalRequest: { startDateKind: "none", startDate: null },
      requestedDuration: useEvidence
        ? {
            status: "exact",
            components: [{ value: durationDays, unit: "days" }],
            evidence: {
              source: "current_turn",
              surfaceText: durationSurface,
              start: durationStart,
              end: durationStart + durationSurface.length,
            },
          }
        : durationDays == null
          ? { status: "none", components: [], evidence: null }
          : { status: "none", components: [], evidence: null },
    },
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `stable-${message}-${semanticIntent}-${durationEvidence}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "leads",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents,
      memorySnapshot,
      authoritativeItem: lastFreshItemFocus
        ? {
            id: lastFreshItemFocus.itemId,
            displayLabel: lastFreshItemFocus.itemLabel,
          }
        : emilyPending
          ? { id: emilyPending.itemId, displayLabel: emilyPending.itemLabel }
          : null,
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `stable-${message}`,
    admittedTurn: {
      turn: {
        turnId: "t1",
        businessId: "biz-1",
        channelId: "whatsapp_web",
        chatKey: "leads",
        participantKey: "scope::p1",
        text: message,
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: "t1",
      admissionReason: "test",
    },
    turnContext,
    businessContext: {
      catalogItems,
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });
  return {
    resolvedBusinessTurnContext,
    workflowDecision: result.workflowDecision,
    actionPlan: result.actionPlan,
  };
}

function assertNever(condition, detail) {
  assert.equal(condition, false, detail);
}

test(`10x: elliptical or 3 din ka? after pricing (Brain availability + duration drop variants)`, async () => {
  const variants = [
    { semanticIntent: "availability_inquiry", durationEvidence: true },
    { semanticIntent: "availability_inquiry", durationEvidence: false },
    { semanticIntent: "pricing_inquiry", durationEvidence: true },
    { semanticIntent: "pricing_inquiry", durationEvidence: false },
    { semanticIntent: "clarification", durationEvidence: false },
  ];
  for (let i = 0; i < RUNS; i++) {
    const variant = variants[i % variants.length];
    const { workflowDecision, resolvedBusinessTurnContext, actionPlan } =
      await runGroupTurn({
        message: "or 3 din ka?",
        semanticIntent: variant.semanticIntent,
        durationDays: 3,
        durationEvidence: variant.durationEvidence,
        lastTransactionalSemanticIntent: i % 2 === 0 ? "pricing_inquiry" : "pricing_with_duration",
        lastResolvedItemId: COROLLA.id,
        lastFreshItemFocus: focusFor(COROLLA),
      });
    assert.equal(
      workflowDecision.workflowType,
      "pricing_with_duration",
      `run ${i + 1} variant=${JSON.stringify(variant)}`
    );
    assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
    assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 15000);
    assertNever(/kitne din/i.test(String(actionPlan?.replyDraft ?? "")), `run ${i + 1}`);
    assert.match(String(actionPlan?.replyDraft ?? ""), /15,?000|3 din/i);
  }
});

test(`10x: mil-jye after pricing stays availability on Corolla (never remapped to price / never kitne-din)`, async () => {
  for (let i = 0; i < RUNS; i++) {
    const brainIntent =
      i % 3 === 0
        ? "availability_inquiry"
        : i % 3 === 1
          ? "pricing_with_duration"
          : "pricing_inquiry";
    const { workflowDecision, resolvedBusinessTurnContext, actionPlan } =
      await runGroupTurn({
        message: "3 din k lye mil jye ge rent p?",
        semanticIntent: brainIntent,
        durationDays: 3,
        durationEvidence: true,
        lastTransactionalSemanticIntent: "pricing_with_duration",
        lastResolvedItemId: COROLLA.id,
        lastFreshItemFocus: focusFor(COROLLA),
      });
    assert.equal(
      workflowDecision.workflowType,
      "availability_inquiry",
      `run ${i + 1} brain=${brainIntent}`
    );
    assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
    assert.equal(resolvedBusinessTurnContext.decision.durationDays, 3);
    assert.equal(
      resolvedBusinessTurnContext.availabilityConversationTransition.resultingState,
      "READY_FOR_OWNER_CHECK"
    );
    assertNever(/kitne din/i.test(String(actionPlan?.replyDraft ?? "")), `run ${i + 1}`);
    assertNever(
      resolvedBusinessTurnContext.decision.workflowType === "pricing_with_duration",
      `run ${i + 1} must not price mil-jye`
    );
  }
});

test(`10x: Stonic NEED_DURATION + civic 4 din kitna → Civic price, not AVR`, async () => {
  for (let i = 0; i < RUNS; i++) {
    const message = "civic ka 4 din ka kitna hai?";
    const { workflowDecision, resolvedBusinessTurnContext, actionPlan } =
      await runGroupTurn({
        message,
        semanticIntent: i % 2 === 0 ? "pricing_inquiry" : "pricing_with_duration",
        durationDays: 4,
        durationEvidence: true,
        emilyPending: pendingFor(STONIC),
        lastResolvedItemId: STONIC.id,
        lastFreshItemFocus: focusFor(STONIC, "availability_duration_pending"),
        itemReferents: [
          {
            source: "trusted_fresh_focus",
            surfaceText: null,
            start: null,
            end: null,
            trustedItemId: STONIC.id,
            sourceTurnId: "crq::wa::STONIC1",
          },
        ],
      });
    assert.equal(workflowDecision.workflowType, "pricing_with_duration", `run ${i + 1}`);
    assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
    assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 32000);
    assertNever(/availability confirm/i.test(String(actionPlan?.replyDraft ?? "")), `run ${i + 1}`);
  }
});

test(`10x: bare 4 din with Stonic NEED_DURATION stays availability`, async () => {
  for (let i = 0; i < RUNS; i++) {
    const { workflowDecision, resolvedBusinessTurnContext } = await runGroupTurn({
      message: "4 din",
      semanticIntent: i % 2 === 0 ? "pricing_with_duration" : "availability_inquiry",
      durationDays: 4,
      durationEvidence: true,
      emilyPending: pendingFor(STONIC),
      lastResolvedItemId: STONIC.id,
      lastFreshItemFocus: focusFor(STONIC, "availability_duration_pending"),
      itemReferents: [
        {
          source: "trusted_fresh_focus",
          surfaceText: null,
          start: null,
          end: null,
          trustedItemId: STONIC.id,
          sourceTurnId: "crq::wa::STONIC1",
        },
      ],
    });
    assert.equal(workflowDecision.workflowType, "availability_inquiry", `run ${i + 1}`);
    assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, STONIC.id);
    assert.equal(
      resolvedBusinessTurnContext.availabilityConversationTransition.resultingState,
      "READY_FOR_OWNER_CHECK"
    );
  }
});

test(`10x: owner-check persistence keeps Corolla focus for later 4 din rent ask`, async () => {
  for (let i = 0; i < RUNS; i++) {
    const sessionKey = `biz::leads::participant::oc-focus-${i}`;
    const plan = buildOwnerCheckActionPlan({
      canonical: {
        businessId: "biz-1",
        turn: { durationDays: 4 },
        verified: { availability: { status: "available", isAvailable: true } },
        isGroup: true,
      },
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      durationN: 4,
      execute: true,
    });
    assert.equal(plan.persistenceIntent.rememberPresentedItemFocus, true);
    assert.equal(plan.customerResponseComposition?.kind, "owner_check_holding");
    assert.equal(plan.postExecuteCustomerReply, "owner_check_result");
    applySessionMemoryFromActionPlan({
      sessionKey,
      actionPlan: plan,
      sourceTurnId: `assistant:oc-${i}`,
      outboundDelivered: true,
      authoritativeItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
    });
    const memorySnapshot = peekEmilySessionState(sessionKey);
    assert.ok(readTrustedFreshItemFocus(memorySnapshot), `run ${i + 1}`);
    assert.equal(memorySnapshot?.lastFreshItemFocus?.itemId, COROLLA.id);
    assert.equal(memorySnapshot?.lastDurationDays, 4);

    const { workflowDecision, resolvedBusinessTurnContext, actionPlan } =
      await runGroupTurn({
        message: "4 din ka rent kitna ho ga?",
        semanticIntent: i % 2 === 0 ? "pricing_inquiry" : "availability_inquiry",
        durationDays: 4,
        durationEvidence: true,
        lastTransactionalSemanticIntent: "availability_inquiry",
        lastResolvedItemId: COROLLA.id,
        lastFreshItemFocus: memorySnapshot.lastFreshItemFocus,
      });
    // Explicit amount ask after AVR: last transactional may still be availability.
    assert.equal(workflowDecision.workflowType, "pricing_with_duration", `run ${i + 1}`);
    assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id, `run ${i + 1}`);
    assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 20000, `run ${i + 1}`);
    assertNever(/Kis option/i.test(String(actionPlan?.replyDraft ?? "")), `run ${i + 1}`);
    assert.match(String(actionPlan?.replyDraft ?? ""), /20,?000|4 din/i);
  }
});
