/**
 * Stale NEED_DURATION must not absorb a later turn that names a different
 * catalog item (live: Stonic duration ask → "or civic ka 4 din ka kitna hai?"
 * → owner-check). Catalog-name grounding only — no phrase dictionaries.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { runConversationTurn } = await import(
  "../src/brain/orchestrator/ConversationOrchestrator.js"
);
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const { applySessionMemoryFromActionPlan } = await import(
  "../src/services/executors/sessionMemoryExecutor.js"
);
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { buildPricingWithDurationActionPlan } = await import(
  "../src/brain/workflows/PricingWithDurationWorkflow.js"
);
const { hasOpenAvailabilityDurationPending } = await import(
  "../src/brain/workflow/WorkflowEngine.js"
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
  displayLabel: "Toyota corolla",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};
const CATALOG = [STONIC, CIVIC, COROLLA];

function pendingStonic(nowMs = Date.now(), chatScopeKey = "car-rental-queries") {
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Aapko Stonic kitne din chahiye?",
    itemId: STONIC.id,
    itemLabel: STONIC.displayLabel,
    customerReference: "Stonic",
    participantKey: "scope::p1",
    chatScopeKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "crq::wa::STONIC1",
    createdAt: new Date(nowMs - 60000).toISOString(),
    expiresAt: new Date(nowMs + 25 * 60000).toISOString(),
  };
}

async function runGroupTurn({
  message,
  semanticIntent,
  emilyPending = null,
  durationDays = null,
  itemReferents = null,
  intentSwitchEvidence = null,
}) {
  const durationSurface =
    durationDays != null && message.includes(`${durationDays} din`)
      ? `${durationDays} din`
      : durationDays != null
        ? message
        : null;
  const durationStart =
    durationSurface != null ? message.indexOf(durationSurface) : -1;
  const canonicalItemReferents =
    itemReferents ??
    [
      {
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: STONIC.id,
        sourceTurnId: "crq::wa::STONIC1",
      },
    ];
  const memorySnapshot = {
    emilyPending,
    pendingTemporalClarification: null,
    lastFreshItemFocus: emilyPending
      ? {
          itemId: STONIC.id,
          itemLabel: STONIC.displayLabel,
          provenance: "availability_duration_pending",
          sourceTurnId: "crq::wa::STONIC1",
          createdAt: new Date(Date.now() - 60000).toISOString(),
          expiresAt: new Date(Date.now() + 25 * 60000).toISOString(),
        }
      : null,
  };
  const turnContext = {
    businessId: "biz-1",
    chatKey: "car-rental-queries",
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
      intentSwitchEvidence,
      requestedDuration:
        durationDays != null && durationStart >= 0
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
            : null,
    },
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `stale-pending-${message}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: CATALOG,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "car-rental-queries",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents,
      memorySnapshot,
      authoritativeItem: { id: STONIC.id, displayLabel: STONIC.displayLabel },
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `stale-pending-${message}`,
    admittedTurn: {
      turn: {
        turnId: "t1",
        businessId: "biz-1",
        channelId: "whatsapp_web",
        chatKey: "car-rental-queries",
        participantKey: "scope::p1",
        text: message,
        normalizedAt: new Date().toISOString(),
      },
      idempotencyKey: "t1",
      admissionReason: "test",
    },
    turnContext,
    businessContext: {
      catalogItems: CATALOG,
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });
  return {
    turnContext,
    resolvedBusinessTurnContext,
    workflowDecision: result.workflowDecision,
    actionPlan: result.actionPlan,
  };
}

test("live defect: Stonic NEED_DURATION + civic 4 din kitna → Civic pricing, not owner-check", async () => {
  const message = "or civic ka 4 din ka kitna hai?";
  const { turnContext, resolvedBusinessTurnContext, workflowDecision, actionPlan } =
    await runGroupTurn({
      message,
      semanticIntent: "pricing_inquiry",
      emilyPending: pendingStonic(),
      durationDays: 4,
    });
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.catalogNamedOtherThanPending,
    true
  );
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch,
    true
  );
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted,
    true
  );
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction,
    false
  );
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
  assert.equal(
    resolvedBusinessTurnContext.decision.workflowType,
    "pricing_with_duration"
  );
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(
    hasOpenAvailabilityDurationPending(turnContext, resolvedBusinessTurnContext),
    false
  );
  assert.equal(
    resolvedBusinessTurnContext.verified?.priceQuote?.status,
    "resolved"
  );
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.durationDays, 4);
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 32000);
  assert.equal(actionPlan?.persistenceIntent?.clearEmilyPending, true);
  assert.match(String(actionPlan?.replyDraft ?? ""), /32,?000|4 din/i);
  assert.doesNotMatch(String(actionPlan?.replyDraft ?? ""), /availability confirm/i);
});

test("regression: bare duration with same-item NEED_DURATION still stays availability", async () => {
  const { workflowDecision, resolvedBusinessTurnContext } = await runGroupTurn({
    message: "4 din",
    semanticIntent: "pricing_with_duration",
    emilyPending: pendingStonic(),
    durationDays: 4,
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
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.catalogNamedOtherThanPending,
    false
  );
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(
    resolvedBusinessTurnContext.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
});

test("regression: same-item Stonic availability with duration in message stays availability", async () => {
  const message = "Stonic 4 din mil jye ge?";
  const { workflowDecision, resolvedBusinessTurnContext } = await runGroupTurn({
    message,
    semanticIntent: "availability_inquiry",
    emilyPending: pendingStonic(),
    durationDays: 4,
  });
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.catalogNamedOtherThanPending,
    false
  );
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, STONIC.id);
});

test("edge: other catalog item price ask without duration still leaves NEED_DURATION", async () => {
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } =
    await runGroupTurn({
      message: "Civic ka kitna hai?",
      semanticIntent: "pricing_inquiry",
      emilyPending: pendingStonic(),
      durationDays: null,
    });
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.catalogNamedOtherThanPending,
    true
  );
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
  assert.equal(actionPlan?.persistenceIntent?.clearEmilyPending, true);
});

test("edge: ambiguous two catalog names does not sole-override to one item", async () => {
  const { resolvedBusinessTurnContext } = await runGroupTurn({
    message: "Civic or Corolla ka 4 din ka kitna?",
    semanticIntent: "pricing_inquiry",
    emilyPending: pendingStonic(),
    durationDays: 4,
  });
  // Ambiguous naming must not pretend a sole leave-override resolved one car.
  assert.notEqual(
    resolvedBusinessTurnContext.sourceEvidence?.item?.itemSource,
    "catalog_named_other_than_pending_need_duration"
  );
});

test("pricing_with_duration clears emilyPending so stale NEED_DURATION cannot linger", () => {
  const sessionKey = "biz::car-rental-queries::participant::clear-pending";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: {
      persistenceIntent: {
        rememberEmilyPending: true,
        emilyPending: pendingStonic(),
      },
    },
    outboundDelivered: true,
  });
  assert.equal(
    peekEmilySessionState(sessionKey)?.emilyPending?.itemId,
    STONIC.id
  );

  const plan = buildPricingWithDurationActionPlan({
    admittedTurn: { turn: { text: "or civic ka 4 din ka kitna hai?" } },
    turnContext: {},
    understanding: {
      resolvedItemId: CIVIC.id,
      resolvedItemLabel: CIVIC.displayLabel,
      durationDays: 4,
      askedField: "price_with_duration",
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: { id: CIVIC.id, displayLabel: CIVIC.displayLabel },
        verified: {
          priceQuote: {
            status: "resolved",
            durationDays: 4,
            dailyRate: 8000,
            total: 32000,
            currency: "PKR",
            source: "catalog_daily_x_duration",
          },
        },
      },
    },
  });
  assert.equal(plan.persistenceIntent.clearEmilyPending, true);
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan,
    sourceTurnId: "assistant:civic-price",
    outboundDelivered: true,
  });
  assert.equal(peekEmilySessionState(sessionKey)?.emilyPending ?? null, null);
});
