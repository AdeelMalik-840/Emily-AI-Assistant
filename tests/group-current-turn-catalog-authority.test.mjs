/**
 * CURRENT_TURN grounding → catalog resolve → deterministic response authority.
 * Injected semantic decisions; does not token-mine customer text in production.
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
const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const { buildClarificationActionPlan } = await import(
  "../src/brain/workflows/ClarificationWorkflow.js"
);
const {
  currentTurnReferentIsDurationEvidence,
  durationMisreadAsOnlyCurrentTurnItem,
} = await import("../src/brain/facts/groupCurrentTurnCatalogAuthority.js");

const CIVIC = { id: "honda_civic_1", name: "Civic", displayLabel: "Civic" };
const COROLLA = { id: "toyota_corolla_1", name: "Corolla", displayLabel: "Corolla" };
const CATALOG = [CIVIC, COROLLA];

function current(message, surface) {
  const start = message.indexOf(surface);
  return {
    source: "current_turn",
    surfaceText: surface,
    start,
    end: start + surface.length,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function pendingCivic(nowMs = Date.now()) {
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Aapko Civic kitne din chahiye?",
    itemId: CIVIC.id,
    itemLabel: CIVIC.displayLabel,
    customerReference: "Civic",
    participantKey: "scope::p1",
    chatScopeKey: "leads",
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "leads::wa::TURN1",
    createdAt: new Date(nowMs - 60000).toISOString(),
    expiresAt: new Date(nowMs + 25 * 60000).toISOString(),
  };
}

async function runTurn({
  message,
  semanticIntent,
  itemReferents,
  emilyPending = null,
  lastTransactionalSemanticIntent = null,
  lastResolvedItemId = null,
  lastFreshItemFocus = null,
  catalogItems = CATALOG,
  durationDays = null,
  durationEvidenceSurface = null,
}) {
  const canonicalItemReferents = itemReferents;
  const canonicalItemResolutions = resolveCanonicalItemReferents(
    canonicalItemReferents,
    catalogItems
  );
  const durationSurface =
    durationEvidenceSurface != null ? durationEvidenceSurface : message;
  const durationStart =
    durationDays != null ? message.indexOf(durationSurface) : -1;
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
    canonicalItemResolutions,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent,
      itemScope: canonicalItemReferents.length ? "specific" : "none",
      itemReferents: canonicalItemReferents,
      temporalRequest: { startDateKind: "none", startDate: null },
      requestedDuration: durationDays
        ? {
            status: "exact",
            components: [{ value: durationDays, unit: "days" }],
            evidence: {
              source: "current_turn",
              surfaceText: durationSurface,
              start: durationStart >= 0 ? durationStart : 0,
              end:
                durationStart >= 0
                  ? durationStart + durationSurface.length
                  : durationSurface.length,
            },
          }
        : null,
    },
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `probe-${message}`,
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
      canonicalItemResolutions,
      memorySnapshot,
      duration: durationDays,
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `probe-${message}`,
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
  return { resolvedBusinessTurnContext, workflowDecision: result.workflowDecision, actionPlan: result.actionPlan };
}

test("Civic price then or Corolla ka? MATCHED inherited pricing on Corolla", async () => {
  const message = "or Corolla ka?";
  const { resolvedBusinessTurnContext, workflowDecision } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Corolla")],
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.primaryIntent, "pricing_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(resolvedBusinessTurnContext.decision.durationDays, null);
  assert.equal(
    resolvedBusinessTurnContext.decision.reason,
    "grounded_current_turn_matched_inherited_intent"
  );
});

test("Civic price then Civic available uses current availability, not inherited pricing", async () => {
  const message = "Civic available hai rent k lye?";
  const { workflowDecision, resolvedBusinessTurnContext } = await runTurn({
    message,
    semanticIntent: "availability_inquiry",
    itemReferents: [current(message, "Civic")],
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.primaryIntent, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
  assert.equal(
    resolvedBusinessTurnContext.decision.reason,
    "grounded_current_turn_matched_current_intent"
  );
});

test("Civic price then or Revo ka? NOT_MATCHED INFORM with inherited pricing intent", async () => {
  const message = "or Revo ka?";
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Revo")],
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(workflowDecision.workflowType, "item_not_in_catalog");
  assert.equal(resolvedBusinessTurnContext.resolvedItem.status, "not_matched");
  assert.equal(resolvedBusinessTurnContext.decision.primaryIntent, "pricing_inquiry");
  assert.equal(
    actionPlan.customerResponseComposition.requiredAct,
    "INFORM_ITEM_NOT_IN_CATALOG"
  );
  assert.doesNotMatch(actionPlan.replyDraft, /\?/);
});

test("Civic availability then or Corolla? switches item and inherits availability only", async () => {
  const message = "or Corolla?";
  const { resolvedBusinessTurnContext, workflowDecision } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Corolla")],
    emilyPending: pendingCivic(),
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(resolvedBusinessTurnContext.decision.durationDays, null);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch, true);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction, false);
});

test("Civic availability then 5 din continues same-item transaction", async () => {
  const message = "5 din";
  const contextual = {
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId: CIVIC.id,
    sourceTurnId: "leads::wa::TURN1",
  };
  const { resolvedBusinessTurnContext, workflowDecision } = await runTurn({
    message,
    semanticIntent: "pricing_with_duration",
    itemReferents: [contextual],
    emilyPending: pendingCivic(),
    durationDays: 5,
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch, false);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction, true);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted, false);
});

test("fresh Civic? is item-scoped clarification, never which-item", async () => {
  const message = "Civic?";
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Civic")],
  });
  assert.equal(workflowDecision.workflowType, "clarification");
  assert.equal(resolvedBusinessTurnContext.decision.reason, "grounded_known_item_ask_what");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
  assert.doesNotMatch(actionPlan.replyDraft, /Kis item/i);
  assert.match(actionPlan.replyDraft, /Civic/);
});

test("ambiguous catalog referent asks which matching item", async () => {
  const message = "Civic?";
  const catalogItems = [
    { id: "civic-a", name: "Civic", displayLabel: "Civic" },
    { id: "civic-b", name: "Civic", displayLabel: "Civic" },
  ];
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Civic")],
    catalogItems,
  });
  assert.equal(workflowDecision.workflowType, "clarification");
  assert.equal(resolvedBusinessTurnContext.decision.reason, "grounded_item_disambiguation");
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, null);
  assert.match(actionPlan.replyDraft, /Kaunsa item/i);
});

test("duration span is not an off-catalog item; last Civic stays for availability", async () => {
  const message = "4 din k lye mil jye ge rent p?";
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "availability_inquiry",
    itemReferents: [current(message, "4 din")],
    lastResolvedItemId: CIVIC.id,
    lastTransactionalSemanticIntent: "pricing_with_duration",
    durationDays: 4,
    durationEvidenceSurface: "4 din",
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(workflowDecision.workflowType, "item_not_in_catalog");
  assert.equal(resolvedBusinessTurnContext.resolvedItem.status, "resolved");
  assert.equal(resolvedBusinessTurnContext.resolvedItem.id, CIVIC.id);
  assert.equal(resolvedBusinessTurnContext.turn.durationDays, 4);
  assert.equal(
    resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch,
    false
  );
  assert.doesNotMatch(String(actionPlan.replyDraft ?? ""), /4 din available nahi/i);
});

test("live: itemless mil-jye after Corolla presented focus keeps Corolla, not Kaunsa-item", async () => {
  const message = "6 din k lye mil jye ge rent p?";
  const nowMs = Date.now();
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "availability_inquiry",
    // Brain falsely emits multiple CURRENT_TURN "items" (duration + noise).
    itemReferents: [current(message, "6 din"), current(message, "rent")],
    lastResolvedItemId: COROLLA.id,
    lastTransactionalSemanticIntent: "pricing_with_duration",
    lastFreshItemFocus: {
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:corolla-price",
      createdAt: new Date(nowMs - 60000).toISOString(),
      expiresAt: new Date(nowMs + 14 * 60000).toISOString(),
    },
    durationDays: 6,
    durationEvidenceSurface: "6 din",
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(
    resolvedBusinessTurnContext.decision.reason,
    "grounded_item_disambiguation"
  );
  assert.equal(resolvedBusinessTurnContext.resolvedItem.id, COROLLA.id);
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(resolvedBusinessTurnContext.turn.durationDays, 6);
  assert.doesNotMatch(String(actionPlan.replyDraft ?? ""), /Kaunsa item/i);
});

test("guard: true multi-Civic catalog name still asks which item", async () => {
  const message = "Civic?";
  const catalogItems = [
    { id: "civic-a", name: "Civic", displayLabel: "Civic" },
    { id: "civic-b", name: "Civic", displayLabel: "Civic" },
  ];
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Civic")],
    catalogItems,
    lastResolvedItemId: COROLLA.id,
    lastFreshItemFocus: {
      itemId: COROLLA.id,
      itemLabel: COROLLA.displayLabel,
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:corolla-price",
      createdAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 14 * 60000).toISOString(),
    },
  });
  assert.equal(workflowDecision.workflowType, "clarification");
  assert.equal(resolvedBusinessTurnContext.decision.reason, "grounded_item_disambiguation");
  assert.match(String(actionPlan.replyDraft ?? ""), /Kaunsa item/i);
});

test("Civic named with 4 din still matches Civic, not duration-as-item", async () => {
  const message = "or civic ka 4 din ka kitna hai?";
  const { workflowDecision, resolvedBusinessTurnContext } = await runTurn({
    message,
    semanticIntent: "pricing_with_duration",
    itemReferents: [current(message, "civic")],
    lastResolvedItemId: COROLLA.id,
    lastTransactionalSemanticIntent: "pricing_inquiry",
    durationDays: 4,
    durationEvidenceSurface: "4 din",
  });
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(resolvedBusinessTurnContext.resolvedItem.id, CIVIC.id);
});

test("off-catalog Revo is still INFORM, not last-item continuation", async () => {
  const message = "or Revo ka?";
  assert.equal(
    durationMisreadAsOnlyCurrentTurnItem({
      referents: [current(message, "Revo")],
      message,
      requestedDuration: { status: "none", evidence: null },
      catalogItems: CATALOG,
    }),
    false
  );
  const { workflowDecision } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [current(message, "Revo")],
    lastResolvedItemId: CIVIC.id,
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(workflowDecision.workflowType, "item_not_in_catalog");
});

test("currentTurnReferentIsDurationEvidence is span overlap, not a din dictionary", () => {
  const message = "4 din k lye mil jye ge rent p?";
  const duration = {
    status: "exact",
    evidence: { source: "current_turn", surfaceText: "4 din", start: 0, end: 5 },
  };
  assert.equal(
    currentTurnReferentIsDurationEvidence(
      current(message, "4 din"),
      message,
      duration,
      CATALOG
    ),
    true
  );
  assert.equal(
    currentTurnReferentIsDurationEvidence(
      current("or Revo ka?", "Revo"),
      "or Revo ka?",
      duration,
      CATALOG
    ),
    false
  );
});

test("generic clarification remains allowed when no CURRENT_TURN item is grounded", async () => {
  const message = "ok";
  const { workflowDecision, actionPlan } = await runTurn({
    message,
    semanticIntent: "clarification",
    itemReferents: [],
  });
  assert.equal(workflowDecision.workflowType, "clarification");
  assert.match(actionPlan.replyDraft, /Kis item/i);
});

test("known-item fallback wording never asks which item", () => {
  const plan = buildClarificationActionPlan({
    reason: "grounded_known_item_ask_what",
    itemLabel: "Civic",
  });
  assert.doesNotMatch(plan.replyDraft, /Kis item/i);
  assert.match(plan.replyDraft, /Civic/);
});
