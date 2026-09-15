/**
 * Live flake: after Corolla base price, "or 3 din ka?" sometimes became
 * availability duration-ask ("kitne din?") instead of 15,000 — then the
 * identical retry worked. Stabilize: prior pricing_* + resolved item +
 * exact duration (semantic or grounded rescue) + non-availability message
 * → pricing_with_duration even when Brain labeled availability_inquiry.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { promotePricingContinuationWithExactDuration } = await import(
  "../src/brain/decisions/projectSemanticIntentFromBrainDecision.js"
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

test("helper: availability label after pricing_* + days → pricing_with_duration", () => {
  assert.equal(
    promotePricingContinuationWithExactDuration({
      intent: "availability_inquiry",
      durationDays: 3,
      lastTransactionalSemanticIntent: "pricing_inquiry",
      hasResolvedItem: true,
      validatedGroupCanonicalAuthority: true,
      canonicalTransactionRetained: false,
      availabilityLikeMessage: false,
    }),
    "pricing_with_duration"
  );
  assert.equal(
    promotePricingContinuationWithExactDuration({
      intent: "pricing_with_duration",
      durationDays: 3,
      lastTransactionalSemanticIntent: "pricing_inquiry",
      hasResolvedItem: true,
      validatedGroupCanonicalAuthority: true,
      canonicalTransactionRetained: false,
      availabilityLikeMessage: true,
    }),
    "availability_inquiry",
    "mil-jye / availability compounds must demote adversarial pricing labels"
  );
});

/**
 * @param {{
 *   message: string,
 *   semanticIntent: string,
 *   durationDays?: number | null,
 *   durationEvidence?: boolean,
 *   lastTransactionalSemanticIntent?: string | null,
 * }} p
 */
async function runAfterPricingTurn(p) {
  const message = p.message;
  const durationDays = p.durationDays ?? null;
  const durationSurface = durationDays != null ? `${durationDays} din` : null;
  const durationStart =
    durationSurface != null ? message.indexOf(durationSurface) : -1;
  const useEvidence = p.durationEvidence !== false && durationStart >= 0;
  const memorySnapshot = {
    emilyPending: null,
    lastTransactionalSemanticIntent: p.lastTransactionalSemanticIntent ?? "pricing_inquiry",
    lastResolvedItemId: COROLLA.id,
    lastItem: COROLLA,
    lastFreshItemFocus: {
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:corolla-price",
      createdAt: new Date(Date.now() - 30000).toISOString(),
      expiresAt: new Date(Date.now() + 14 * 60000).toISOString(),
    },
  };
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
    chatKey: "leads",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: p.semanticIntent,
    canonicalItemReferents,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: p.semanticIntent,
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
        : { status: "none", components: [], evidence: null },
    },
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `flake-${message}-${p.semanticIntent}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: [COROLLA],
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "leads",
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
    traceId: `flake-${message}`,
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
      catalogItems: [COROLLA],
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });
  return { resolvedBusinessTurnContext, workflowDecision: result.workflowDecision, actionPlan: result.actionPlan };
}

test("flake: Brain availability_inquiry + exact duration after pricing → 3-day Corolla price", async () => {
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } =
    await runAfterPricingTurn({
      message: "or 3 din ka?",
      semanticIntent: "availability_inquiry",
      durationDays: 3,
      durationEvidence: true,
      lastTransactionalSemanticIntent: "pricing_inquiry",
    });
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 15000);
  assert.doesNotMatch(String(actionPlan?.replyDraft ?? ""), /kitne din/i);
  assert.match(String(actionPlan?.replyDraft ?? ""), /15,?000|3 din/i);
});

test("flake: Brain drops duration evidence after pricing → rescue still quotes 3 days", async () => {
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } =
    await runAfterPricingTurn({
      message: "or 3 din ka?",
      semanticIntent: "availability_inquiry",
      durationDays: 3,
      durationEvidence: false,
      lastTransactionalSemanticIntent: "pricing_with_duration",
    });
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(resolvedBusinessTurnContext.decision.durationDays, 3);
  assert.equal(resolvedBusinessTurnContext.verified?.priceQuote?.total, 15000);
  assert.doesNotMatch(String(actionPlan?.replyDraft ?? ""), /kitne din/i);
});

test("guard: mil jye after pricing stays availability, not remapped to price", async () => {
  const { workflowDecision } = await runAfterPricingTurn({
    message: "6 din k lye mil jye ge rent p?",
    semanticIntent: "availability_inquiry",
    durationDays: 6,
    durationEvidence: true,
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
});
