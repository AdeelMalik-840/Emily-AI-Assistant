/**
 * Live-proven root cause: a Group turn already inside an established
 * AVAILABILITY / NEED_DURATION transaction ("Corolla rent p mil jye ge?" ->
 * "Aapko Corolla kitne din chahiye?" -> "9 din") had its canonical facts
 * correctly compute availabilityConversationTransition.resultingState ===
 * "READY_FOR_OWNER_CHECK", yet WorkflowEngine.selectWorkflow() still routed
 * to workflowType "pricing_with_duration" because its own
 * isPricingWithDurationInterrupt() trusts understanding.signals.priceAsk --
 * itself derived purely from the model's sampled semanticIntent
 * (applyCustomerSemanticIntentToSignals), with zero grounding in the actual
 * current-turn text. The canonical transaction state was available to
 * selectWorkflow() (passed in as resolvedBusinessTurnContext) but never
 * consulted by that branch.
 *
 * Fix: resolveBusinessTurnContext.js now computes groupTransactionIntentSwitch
 * (Group-only, mirroring the existing temporalRequest.evidence grounding
 * pattern) -- an active, trusted NEED_DURATION transaction for the same item
 * owns the turn unless the model also cites a real, grounded current-turn
 * span (intentSwitchEvidence) showing the customer raised something beyond
 * just answering the pending question. WorkflowEngine.js's pricing-interrupt
 * branch now requires that grounded acceptance specifically when
 * resolvedBusinessTurnContext.validatedGroupCanonicalAuthority is true --
 * every other caller (DM, legacy, transactionless Group turns) is completely
 * unaffected.
 *
 * These tests drive the real production routing chain end to end:
 * resolveBusinessTurnContext -> runConversationTurn (understandTurn +
 * WorkflowEngine.selectWorkflow), never a bypass.
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

function pendingFor(itemId, itemLabel, nowMs, chatScopeKey = "leads") {
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: `Aapko ${itemLabel} kitne din chahiye?`,
    itemId,
    itemLabel,
    customerReference: null,
    participantKey: "scope::p1",
    chatScopeKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "leads::wa::TURN1",
    createdAt: new Date(nowMs - 60000).toISOString(),
    expiresAt: new Date(nowMs + 25 * 60000).toISOString(),
  };
}

/**
 * Runs the real chain: resolveBusinessTurnContext -> runConversationTurn.
 * @param {{
 *   itemId: string, itemLabel: string, message: string,
 *   semanticIntent: string, emilyPending?: object|null,
 *   intentSwitchEvidence?: object|null, durationDays?: number|null,
 *   groupChatKey?: string, participantKey?: string,
 * }} p
 */
async function runGroupTurn({
  itemId,
  itemLabel,
  message,
  semanticIntent,
  emilyPending = null,
  intentSwitchEvidence = null,
  durationDays = null,
  groupChatKey = "leads",
  participantKey = "scope::p1",
}) {
  const catalog = [{ id: itemId, name: itemLabel, displayLabel: itemLabel }];
  const memorySnapshot = { emilyPending, pendingTemporalClarification: null };
  const canonicalItemReferents = [
    {
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: itemId,
      sourceTurnId: "leads::wa::TURN1",
    },
  ];
  const canonicalItemResolutions = [
    {
      status: "MATCHED",
      referent: canonicalItemReferents[0],
      itemId,
      itemLabel,
      catalogRow: catalog[0],
      matchSource: "trusted_item_id",
    },
  ];

  const turnContext = {
    businessId: "biz-1",
    chatKey: groupChatKey,
    participantKey,
    memorySnapshot,
    authoritativeSemanticIntent: semanticIntent,
    canonicalItemReferents,
    canonicalItemResolutions,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent,
      temporalRequest: { startDateKind: "none", startDate: null },
      intentSwitchEvidence,
    },
  };

  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: `probe-${itemId}-${groupChatKey}`,
    businessId: "biz-1",
    rawMessage: message,
    catalogItems: catalog,
    turnContextInput: {
      chatType: "group",
      participantKey,
      chatId: groupChatKey,
      authoritativeItem: { id: itemId, displayLabel: itemLabel },
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents,
      canonicalItemResolutions,
      memorySnapshot,
      duration: durationDays,
    },
    turnContext,
    // Must never touch real Firestore/network: this file runs inside the
    // full suite alongside many others that leave a real-shaped Firebase
    // app initialized, and resolveBusinessTurnContext's own defaults
    // (getBusinessProfile / getBookingsForItem) would otherwise attempt a
    // real call and hang for minutes instead of failing fast.
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });

  const admittedTurn = {
    turn: {
      turnId: "t1",
      businessId: "biz-1",
      channelId: "whatsapp_web",
      chatKey: groupChatKey,
      participantKey,
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "t1",
    admissionReason: "test",
  };

  const result = runConversationTurn({
    traceId: `probe-${itemId}-${groupChatKey}`,
    admittedTurn,
    turnContext,
    businessContext: {
      catalogItems: catalog,
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });

  return { resolvedBusinessTurnContext, workflowDecision: result.workflowDecision };
}

const STONIC = { itemId: "kia_stonic_1", itemLabel: "Kia Stonic EX Plus 2021" };
const CIVIC = { itemId: "honda_civic_1", itemLabel: "Honda Civic 2026 Oriel" };
const COROLLA = { itemId: "toyota_corolla_1", itemLabel: "Toyota Corolla" };
const SYN_A = { itemId: "synthetic_item_a", itemLabel: "Synthetic Item A" };
const SYN_B = { itemId: "synthetic_item_b", itemLabel: "Synthetic Item B" };

test("1. Corolla: active NEED_DURATION + '9 din' + adversarial pricing_with_duration + no switch evidence -> availability continuation retained", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message: "9 din",
    semanticIntent: "pricing_with_duration",
    emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now()),
    intentSwitchEvidence: null,
    durationDays: 9,
  });
  assert.equal(
    resolvedBusinessTurnContext.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted, false);
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
});

for (const item of [STONIC, CIVIC, SYN_A, SYN_B]) {
  test(`2-5. same adversarial scenario for ${item.itemId} -> availability retained`, async () => {
    const { workflowDecision } = await runGroupTurn({
      ...item,
      message: "9 din",
      semanticIntent: "pricing_with_duration",
      emilyPending: pendingFor(item.itemId, item.itemLabel, Date.now()),
      intentSwitchEvidence: null,
      durationDays: 9,
    });
    assert.equal(workflowDecision.workflowType, "availability_inquiry");
  });
}

test("5b. same adversarial scenario across a different Group -> availability retained", async () => {
  const { workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message: "9 din",
    semanticIntent: "pricing_with_duration",
    emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now(), "car-rental-queries"),
    intentSwitchEvidence: null,
    durationDays: 9,
    groupChatKey: "car-rental-queries",
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
});

test("6. active availability + grounded explicit pricing switch -> pricing allowed", async () => {
  const message = "9 din ka total rent kitna hoga?";
  const surfaceText = "ka total rent kitna hoga";
  const start = message.indexOf(surfaceText);
  const end = start + surfaceText.length;
  const { resolvedBusinessTurnContext, workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message,
    semanticIntent: "pricing_with_duration",
    emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now()),
    intentSwitchEvidence: { source: "current_turn", surfaceText, start, end },
    durationDays: 9,
  });
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.evidenceGrounded, true);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted, true);
  assert.equal(workflowDecision.workflowType, "pricing_with_duration");
});

test("7. invalid/tampered switch evidence -> availability transaction retained", async () => {
  const message = "9 din";
  for (const badEvidence of [
    { source: "recentDialogue", surfaceText: "9 din", start: 0, end: 5 },
    { source: "current_turn", surfaceText: "WRONG TEXT", start: 0, end: 5 },
    { source: "current_turn", surfaceText: "9 din", start: 0, end: 500 },
    { source: "current_turn", surfaceText: "9 din", start: -1, end: 5 },
  ]) {
    const { workflowDecision } = await runGroupTurn({
      ...COROLLA,
      message,
      semanticIntent: "pricing_with_duration",
      emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now()),
      intentSwitchEvidence: badEvidence,
      durationDays: 9,
    });
    assert.equal(
      workflowDecision.workflowType,
      "availability_inquiry",
      `tampered evidence ${JSON.stringify(badEvidence)} must not switch the workflow`
    );
  }
});

test("8. first-turn direct pricing question with no active transaction -> pricing still works", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message: "Corolla ka rent kitna hai?",
    semanticIntent: "pricing_inquiry",
    emilyPending: null,
    intentSwitchEvidence: null,
    durationDays: null,
  });
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.activeTransaction, false);
  assert.equal(resolvedBusinessTurnContext.groupTransactionIntentSwitch.accepted, true);
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
});

test("9. first-turn availability + duration in the same message -> READY_FOR_OWNER_CHECK, availability workflow", async () => {
  const { resolvedBusinessTurnContext, workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message: "Corolla 9 din k lye chahiye",
    semanticIntent: "availability_inquiry",
    emilyPending: null,
    intentSwitchEvidence: null,
    durationDays: 9,
  });
  assert.equal(
    resolvedBusinessTurnContext.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
});

test("10. duration correction inside an active availability transaction -> availability transaction retained", async () => {
  const { workflowDecision } = await runGroupTurn({
    ...COROLLA,
    message: "3 nahi 5 din",
    semanticIntent: "pricing_with_duration",
    emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now()),
    intentSwitchEvidence: null,
    durationDays: 5,
  });
  assert.equal(workflowDecision.workflowType, "availability_inquiry");
});

test("no active transaction for a different item never blocks a grounded pricing switch on that different item", async () => {
  const { workflowDecision } = await runGroupTurn({
    ...STONIC,
    message: "Stonic ka rent kitna hai?",
    semanticIntent: "pricing_inquiry",
    emilyPending: pendingFor(COROLLA.itemId, COROLLA.itemLabel, Date.now()),
    intentSwitchEvidence: null,
    durationDays: null,
  });
  assert.equal(workflowDecision.workflowType, "pricing_inquiry");
});
