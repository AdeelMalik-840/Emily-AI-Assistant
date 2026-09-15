/**
 * Fix #1: Group/Cloud canonical pricing_inquiry + trusted exact duration
 * must route as pricing_with_duration (duration × rate), not base daily/monthly.
 * Must not steal active NEED_DURATION availability continuations.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { promotePricingInquiryWithExactDuration } = await import(
  "../src/brain/decisions/projectSemanticIntentFromBrainDecision.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { runConversationTurn } = await import(
  "../src/brain/orchestrator/ConversationOrchestrator.js"
);
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);

const COROLLA = {
  id: "toyota_corolla_1",
  name: "Corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};

test("helper: pricing_inquiry + exact days promotes; others unchanged", () => {
  assert.equal(
    promotePricingInquiryWithExactDuration("pricing_inquiry", 3),
    "pricing_with_duration"
  );
  assert.equal(
    promotePricingInquiryWithExactDuration("pricing_inquiry", null),
    "pricing_inquiry"
  );
  assert.equal(
    promotePricingInquiryWithExactDuration("availability_inquiry", 3),
    "availability_inquiry"
  );
  assert.equal(
    promotePricingInquiryWithExactDuration("pricing_with_duration", 3),
    "pricing_with_duration"
  );
});

/**
 * @param {{
 *   message: string,
 *   semanticIntent: string,
 *   durationDays?: number | null,
 *   emilyPending?: object | null,
 *   intentSwitchEvidence?: object | null,
 * }} p
 */
async function runGroupPricingTurn({
  message,
  semanticIntent,
  durationDays = null,
  emilyPending = null,
  intentSwitchEvidence = null,
}) {
  const catalog = [COROLLA];
  const memorySnapshot = {
    emilyPending,
    pendingTemporalClarification: null,
    lastFreshItemFocus: {
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "leads::wa::PRICE1",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 25 * 60000).toISOString(),
    },
    lastResolvedItemId: COROLLA.id,
    lastItem: COROLLA,
  };
  const durationSurface = durationDays != null ? `${durationDays} din` : null;
  const durationStart =
    durationSurface != null ? message.indexOf(durationSurface) : -1;
  const canonicalItemReferents = [
    {
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: COROLLA.id,
      sourceTurnId: "leads::wa::PRICE1",
    },
  ];
  const canonicalItemResolutions = [
    {
      status: "MATCHED",
      referent: canonicalItemReferents[0],
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      catalogRow: COROLLA,
      matchSource: "trusted_item_id",
    },
  ];
  const turnContext = {
    businessId: "biz-1",
    chatKey: "car-rental-queries",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: semanticIntent,
    canonicalItemReferents,
    canonicalItemResolutions,
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
    traceId: `fix1-${message}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: catalog,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "car-rental-queries",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents,
      canonicalItemResolutions,
      memorySnapshot,
      authoritativeItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `fix1-${message}`,
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
      catalogItems: catalog,
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });
  return { resolvedBusinessTurnContext, workflowDecision: result.workflowDecision, actionPlan: result.actionPlan };
}

test("B2 live shape: or 3 din ka? with model pricing_inquiry upgrades to duration total workflow", async () => {
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } =
    await runGroupPricingTurn({
      message: "or 3 din ka?",
      semanticIntent: "pricing_inquiry",
      durationDays: 3,
    });
  assert.equal(
    resolvedBusinessTurnContext.decision.primaryIntent,
    "pricing_with_duration"
  );
  assert.equal(
    resolvedBusinessTurnContext.decision.workflowType,
    "pricing_with_duration"
  );
  assert.equal(resolvedBusinessTurnContext.decision.durationDays, 3);
  assert.equal(
    resolvedBusinessTurnContext.decision.reason,
    "canonical_pricing_inquiry_upgraded_with_exact_duration"
  );
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
  assert.match(String(actionPlan?.replyDraft ?? ""), /15,?000|3 din/i);
});

test("pricing_inquiry without duration stays base pricing_inquiry", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } =
    await runGroupPricingTurn({
      message: "Corolla ka rent kitna hai?",
      semanticIntent: "pricing_inquiry",
      durationDays: null,
    });
  assert.equal(
    resolvedBusinessTurnContext.decision.primaryIntent,
    "pricing_inquiry"
  );
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
});

test("active NEED_DURATION + ungrounded pricing_inquiry+duration stays availability", async () => {
  const nowMs = Date.now();
  const { workflowDecision, resolvedBusinessTurnContext } =
    await runGroupPricingTurn({
      message: "3 din",
      semanticIntent: "pricing_inquiry",
      durationDays: 3,
      emilyPending: {
        pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
        pendingQuestion: "Aapko Corolla kitne din chahiye?",
        itemId: COROLLA.id,
        itemLabel: COROLLA.displayLabel,
        customerReference: "Corolla",
        participantKey: "scope::p1",
        chatScopeKey: "car-rental-queries",
        sourceWorkflow: "availability_inquiry",
        sourceTurnKey: "leads::wa::TURN1",
        createdAt: new Date(nowMs - 60000).toISOString(),
        expiresAt: new Date(nowMs + 25 * 60000).toISOString(),
      },
      intentSwitchEvidence: null,
    });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction,
    true
  );
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted,
    false
  );
});
