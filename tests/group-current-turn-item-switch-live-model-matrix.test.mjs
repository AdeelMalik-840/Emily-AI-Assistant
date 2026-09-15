/**
 * Real-model regression for abbreviated Group item-switch authority.
 * Skips unless OPENAI_API_KEY is a real key (not test-key).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

await import("dotenv/config");

import { resolveGroupCanonicalSemanticDecision } from "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { resolveCanonicalItemReferents } from "../src/services/currentTurnAuthority.js";
import { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } from "../src/brain/availability/emilyPendingContext.js";
import { runConversationTurn } from "../src/brain/orchestrator/ConversationOrchestrator.js";

const hasLiveKey =
  Boolean(process.env.OPENAI_API_KEY) &&
  process.env.OPENAI_API_KEY !== "test-key" &&
  String(process.env.OPENAI_API_KEY).length > 20;

const CIVIC = { id: "honda_civic_1", name: "Civic", displayLabel: "Civic" };
const COROLLA = { id: "toyota_corolla_1", name: "Corolla", displayLabel: "Corolla" };
const CATALOG = [CIVIC, COROLLA];

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

async function runLive({
  message,
  conversationHistory,
  emilyPending = null,
  lastTransactionalSemanticIntent = null,
  trustedGroupContinuation = null,
}) {
  const semantic = await resolveGroupCanonicalSemanticDecision({
    catalogItems: CATALOG,
    userMessage: message,
    conversationHistory,
    trustedGroupContinuation,
    trustedFreshItemFocus: emilyPending
      ? {
          itemId: emilyPending.itemId,
          itemLabel: emilyPending.itemLabel,
          provenance: "availability_duration_pending",
          sourceTurnId: emilyPending.sourceTurnKey,
          expiresAt: emilyPending.expiresAt,
        }
      : null,
  });
  assert.equal(semantic.ok, true, semantic.reason);
  const refs = semantic.decision.itemReferents;
  const resolutions = resolveCanonicalItemReferents(refs, CATALOG);
  const memorySnapshot = {
    emilyPending,
    pendingTemporalClarification: null,
    lastTransactionalSemanticIntent,
  };
  const turnContext = {
    businessId: "biz-1",
    chatKey: "leads",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: semantic.decision.semanticIntent,
    canonicalItemReferents: refs,
    canonicalItemResolutions: resolutions,
    canonicalSemanticDecision: semantic.decision,
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `live-${message}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: CATALOG,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "leads",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: refs,
      canonicalItemResolutions: resolutions,
      memorySnapshot,
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `live-${message}`,
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
    businessContext: { catalogItems: CATALOG, resolvedBusinessTurnContext },
    mode: "live",
  });
  return { semantic, resolvedBusinessTurnContext, workflowDecision: result.workflowDecision, actionPlan: result.actionPlan };
}

const describeLive = hasLiveKey ? test : test.skip;

describeLive("live: Civic price → or Corolla ka? MATCHED inherited pricing", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runLive({
    message: "or Corolla ka?",
    conversationHistory:
      "User: Civic ka rent kitna hai?\nEmily: Civic ka daily rent 8000 hai.\n",
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
});

describeLive("live: Civic price → or Revo ka? NOT_MATCHED INFORM", async () => {
  const { resolvedBusinessTurnContext, workflowDecision, actionPlan } = await runLive({
    message: "or Revo ka?",
    conversationHistory:
      "User: Civic ka rent kitna hai?\nEmily: Civic ka daily rent 8000 hai.\n",
    lastTransactionalSemanticIntent: "pricing_inquiry",
  });
  assert.equal(resolvedBusinessTurnContext.resolvedItem.status, "not_matched");
  assert.equal(workflowDecision.workflowType, "item_not_in_catalog");
  assert.equal(
    actionPlan.customerResponseComposition.requiredAct,
    "INFORM_ITEM_NOT_IN_CATALOG"
  );
});

describeLive("live: Civic availability → or Corolla? item switch inherited availability", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runLive({
    message: "or Corolla?",
    conversationHistory:
      "User: Civic available?\nEmily: Aapko Civic kitne din chahiye?\n",
    emilyPending: pendingCivic(),
    trustedGroupContinuation: {
      activeTransactionType: "availability",
      activeTransactionState: "NEED_DURATION",
      expectedMissingField: "duration",
      trustedActiveItemId: CIVIC.id,
      trustedActiveItemReference: "Civic",
    },
  });
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, COROLLA.id);
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch, true);
});

describeLive("live: Civic availability → 5 din same-item continuation", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runLive({
    message: "5 din",
    conversationHistory:
      "User: Civic available?\nEmily: Aapko Civic kitne din chahiye?\n",
    emilyPending: pendingCivic(),
    trustedGroupContinuation: {
      activeTransactionType: "availability",
      activeTransactionState: "NEED_DURATION",
      expectedMissingField: "duration",
      trustedActiveItemId: CIVIC.id,
      trustedActiveItemReference: "Civic",
    },
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.currentTurnItemSwitch, false);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction, true);
});

describeLive("live: fresh Civic? does not ask which item", async () => {
  const { resolvedBusinessTurnContext, actionPlan } = await runLive({
    message: "Civic?",
    conversationHistory: "",
  });
  assert.equal(resolvedBusinessTurnContext.decision.resolvedItemId, CIVIC.id);
  assert.doesNotMatch(String(actionPlan.replyDraft ?? ""), /Kis item/i);
});

describeLive("live: ambiguous Civic catalog referent disambiguates", async () => {
  const catalogItems = [
    { id: "civic-a", name: "Civic", displayLabel: "Civic" },
    { id: "civic-b", name: "Civic", displayLabel: "Civic" },
  ];
  const semantic = await resolveGroupCanonicalSemanticDecision({
    catalogItems,
    userMessage: "Civic?",
    conversationHistory: "",
  });
  assert.equal(semantic.ok, true, semantic.reason);
  const refs = semantic.decision.itemReferents;
  const resolutions = resolveCanonicalItemReferents(refs, catalogItems);
  const memorySnapshot = { emilyPending: null, pendingTemporalClarification: null };
  const turnContext = {
    businessId: "biz-1",
    chatKey: "leads",
    participantKey: "scope::p1",
    memorySnapshot,
    authoritativeSemanticIntent: semantic.decision.semanticIntent,
    canonicalItemReferents: refs,
    canonicalItemResolutions: resolutions,
    canonicalSemanticDecision: semantic.decision,
  };
  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: "live-ambiguous-civic",
    businessId: "biz-1",
    rawMessage: "Civic?",
    catalogItems,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      participantIdentity: "stable",
      memoryAllowed: true,
      chatId: "leads",
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: refs,
      canonicalItemResolutions: resolutions,
      memorySnapshot,
    },
    turnContext,
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  assert.equal(resolvedBusinessTurnContext.decision.reason, "grounded_item_disambiguation");
});
