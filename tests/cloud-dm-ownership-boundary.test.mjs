import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz-ownership-boundary";

import {
  chatCompletionFromDecision,
  ownershipDecisionPayload,
  PROD_CIVIC_AVR_ID,
  PROD_CIVIC_BOOKING_ID,
  PROD_CIVIC_SAME_ITEM_NEW_DURATION,
  PROD_CIVIC_SECOND_BOOKING_ID,
  PROD_STONIC_AVR_ID,
  PROD_STONIC_BOOKING_ID,
  productionCivicHistoricalCandidate,
  productionPendingCivicAvr,
  productionRichCivicStonicFacts,
  productionRichFactsWithPendingCivic,
  productionRichThreeCivicFacts,
  productionRichTwoCivicFacts,
  productionRichTwoCivicFactsReversed,
} from "./helpers/cloudDmProductionRichOwnershipFixture.mjs";

const {
  applyPostConfirmDerivedOwnershipMechanics,
  buildCloudDmOwnershipPromptFacts,
  buildNeutralCloudDmOwnershipFacts,
  CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER,
  CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION,
  CLOUD_DM_OWNERSHIP_UNUSABLE_REASON,
  collapseIndistinguishableSameItemOwnership,
  executeCloudDmOwnershipDecision,
  parseCloudDmOwnershipDecision,
  resolveCloudDmCanonicalOwnership,
  validatePostConfirmSemanticOwnership,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const { handleAvailabilityCustomerCloudInbound } = await import(
  "../src/services/availabilityCustomerConfirmService.js"
);
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} = await import("../src/services/whatsappInboundBuffer.js");

function countingCreate(handler) {
  const state = { calls: 0, lastArgs: null };
  const create = async (args) => {
    state.calls += 1;
    state.lastArgs = args;
    return handler(args, state.calls);
  };
  return { create, state };
}

async function resolveWithDecision(decision, facts, message, extra = {}) {
  const { create, state } = countingCreate(async () =>
    chatCompletionFromDecision(decision)
  );
  const result = await resolveCloudDmCanonicalOwnership({
    facts,
    userMessage: message,
    __chatCompletionsCreateForTests: create,
    ...extra,
  });
  return { result, state };
}

test("production-rich Civic same-item/new-duration is NEW_TRANSACTION with one ownership completion", async () => {
  const facts = productionRichCivicStonicFacts();
  const packed = buildCloudDmOwnershipPromptFacts(facts);
  assert.equal(packed.candidateOrder, CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER);
  assert.deepEqual(
    packed.bookingCandidates.map((row) => row.id),
    [PROD_CIVIC_BOOKING_ID, PROD_STONIC_BOOKING_ID]
  );
  assert.equal(
    packed.bookingCandidates[0].itemLabel,
    "Honda Civic 2026 Oriel (White)"
  );
  assert.equal(packed.bookingCandidates[0].durationDays, 5);
  assert.equal(
    packed.bookingCandidates[0].availabilityRequestId,
    PROD_CIVIC_AVR_ID
  );
  assert.equal(packed.bookingCandidates[0].dailyRate, 8000);
  assert.equal(packed.bookingCandidates[0].totalAmount, 40000);
  assert.equal(
    packed.bookingCandidates[1].itemLabel,
    "Kia Stonic EX Plus 2021 (White Color)"
  );
  assert.equal(packed.bookingCandidates[1].durationDays, 5);
  assert.equal(
    packed.bookingCandidates[1].availabilityRequestId,
    PROD_STONIC_AVR_ID
  );
  assert.equal(packed.bookingCandidates[1].dailyRate, 5500);
  assert.equal(packed.bookingCandidates[1].totalAmount, 27500);
  assert.equal(packed.booking, null);
  assert.equal(packed.bookingFocus, null);
  assert.equal(packed.known, null);
  assert.equal(packed.replyGuardFacts, null);
  assert.equal(packed.evidenceAvailability, null);
  assert.equal(packed.bookingCandidates[0].selectionIndex, undefined);
  assert.equal(packed.bookingCandidates[1].selectionIndex, undefined);
  const internal = buildNeutralCloudDmOwnershipFacts(facts);
  assert.equal(internal.bookingCandidates[0].selectionIndex, 1);
  assert.equal(internal.bookingCandidates[1].selectionIndex, 2);
  const blob = JSON.stringify(packed);
  assert.doesNotMatch(blob, /selectionIndex/);
  assert.doesNotMatch(blob, /latest_confirmed_linked_avr/);
  assert.doesNotMatch(blob, /"confidence":"trusted"/);
  assert.doesNotMatch(blob, /current booking/i);
  assert.doesNotMatch(blob, /trusted focus/i);
  assert.doesNotMatch(blob, /primary candidate/i);
  assert.doesNotMatch(blob, /currently owned transaction/i);

  const { result, state } = await resolveWithDecision(
    {
      turnScope: "NEW_TRANSACTION",
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
    },
    facts,
    PROD_CIVIC_SAME_ITEM_NEW_DURATION
  );
  assert.equal(state.calls, 1);
  assert.equal(result.ownershipCompletionCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
  assert.equal(result.decision.targetId, null);
  assert.equal(result.decision.customerReply, "");
  assert.equal(
    result.decision.semanticDecisionVersion,
    CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION
  );
  const schema = state.lastArgs?.response_format?.json_schema?.schema;
  assert.ok(schema?.properties?.turnScope);
  assert.equal(schema?.properties?.customerReply, undefined);
  assert.deepEqual(schema?.required, [
    "turnScope",
    "targetId",
    "mutationIntent",
    "action",
    "factKind",
  ]);
});

test("A1-A4 fresh transactions with old history do not pre-own", async () => {
  const cases = [
    ["Honda Civic 3 din k liye chahiye", "NEW_TRANSACTION", null],
    ["Toyota Corolla 3 din chahiye", "NEW_TRANSACTION", null],
    ["Civic ka per day rate kya hai new booking ke liye?", "NEW_TRANSACTION", null],
    ["Civic 10 se 12 available hai?", "NEW_TRANSACTION", null],
  ];
  for (const [message, scope, targetId] of cases) {
    const { result, state } = await resolveWithDecision(
      { turnScope: scope, targetId, mutationIntent: "none", action: "reply" },
      productionRichCivicStonicFacts(),
      message
    );
    assert.equal(state.calls, 1, message);
    assert.equal(result.decision.turnScope, scope, message);
    assert.equal(result.decision.targetId, targetId, message);
    assert.equal(result.facts.booking, null, message);
    assert.equal(result.facts.bookingFocus, null, message);
  }
});

test("B5-B8 pending AVR uses exact targetId and does not pre-select by order", async () => {
  const second = productionPendingCivicAvr({
    requestId: "avr_pending_stonic_waiting_confirm",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    itemId: "kia_stonic_ex_plus_2021_white_color_1df55684",
  });
  const facts = productionRichFactsWithPendingCivic([second]);
  const packed = buildCloudDmOwnershipPromptFacts(facts);
  assert.deepEqual(
    packed.pendingAvailabilityRequests.map((row) => row.requestId),
    ["avr_pending_civic_waiting_confirm", "avr_pending_stonic_waiting_confirm"]
  );
  assert.equal(
    packed.pendingAvailabilityRequests[0].role,
    "pending_availability_candidate"
  );

  const factual = await resolveWithDecision(
    {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "reply",
    },
    facts,
    "per day kitna hai?"
  );
  assert.equal(factual.state.calls, 1);
  assert.equal(
    factual.result.decision.turnScope,
    "PENDING_AVAILABILITY_REFERENCE"
  );
  assert.equal(
    factual.result.decision.targetId,
    "avr_pending_civic_waiting_confirm"
  );

  const confirm = await resolveWithDecision(
    {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "confirm_pending_availability",
    },
    facts,
    "haan kar do"
  );
  assert.equal(confirm.result.decision.action, "confirm_pending_availability");
  assert.equal(
    confirm.result.decision.targetId,
    "avr_pending_civic_waiting_confirm"
  );

  const decline = await resolveWithDecision(
    {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "decline_pending_availability",
    },
    facts,
    "nahi cancel the offer"
  );
  assert.equal(decline.result.decision.action, "decline_pending_availability");
});

test("C9-C12 historical booking factual/mutation/explicit reference", async () => {
  const factual = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_STONIC_BOOKING_ID,
      action: "reply",
      factKind: "booking_fact",
    },
    productionRichCivicStonicFacts(),
    "Meri Stonic booking ka total rent kitna hai?"
  );
  assert.equal(factual.result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(factual.result.decision.targetId, PROD_STONIC_BOOKING_ID);
  assert.equal(factual.result.decision.bookingSelectionMode, "candidate");

  const mutation = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_STONIC_BOOKING_ID,
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      factKind: "action",
    },
    productionRichCivicStonicFacts(),
    "Meri Stonic booking cancel kar do"
  );
  assert.equal(mutation.result.decision.mutationIntent, "cancel_booking");
  assert.equal(mutation.result.ok, true);

  const civicFacts = productionRichCivicStonicFacts();
  civicFacts.bookingCandidates.push({
    ...productionCivicHistoricalCandidate(),
    id: "E99qSecondCivicSameItem0000001",
    availabilityRequestId: "avr_second_civic_same_item",
  });
  const explicit = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_BOOKING_ID,
      action: "reply",
    },
    civicFacts,
    `Meri booking ${PROD_CIVIC_BOOKING_ID} ka status kya hai?`
  );
  assert.equal(explicit.result.decision.targetId, PROD_CIVIC_BOOKING_ID);
});

test("D13-D14 hello and unclear do not take a historical owner", async () => {
  const hello = await resolveWithDecision(
    {
      turnScope: "SOCIAL_GENERAL",
      targetId: null,
      factKind: "non_business",
    },
    productionRichCivicStonicFacts(),
    "Hello"
  );
  assert.equal(hello.result.decision.turnScope, "SOCIAL_GENERAL");
  assert.equal(hello.result.decision.targetId, null);

  const unclear = await resolveWithDecision(
    {
      turnScope: "UNCLEAR",
      targetId: null,
      factKind: "vague",
    },
    productionRichCivicStonicFacts(),
    "wo wali booking"
  );
  assert.equal(unclear.result.decision.turnScope, "UNCLEAR");
  assert.equal(unclear.result.decision.targetId, null);
});

test("E15 malformed ownership JSON is one completion and not accepted", async () => {
  const { create, state } = countingCreate(async () => ({
    choices: [{ message: { content: "{not-json" } }],
  }));
  const result = await resolveCloudDmCanonicalOwnership({
    facts: productionRichCivicStonicFacts(),
    userMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(state.calls, 1);
  assert.equal(result.ownershipCompletionCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.reason, CLOUD_DM_OWNERSHIP_UNUSABLE_REASON);
});

test("E16 empty ownership response is one completion and not accepted", async () => {
  const { create, state } = countingCreate(async () => ({
    choices: [{ message: { content: "" } }],
  }));
  const result = await resolveCloudDmCanonicalOwnership({
    facts: productionRichCivicStonicFacts(),
    userMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(state.calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("E17 timeout before acceptance is one completion and not accepted", async () => {
  const { create, state } = countingCreate(() => new Promise(() => {}));
  const result = await resolveCloudDmCanonicalOwnership({
    facts: productionRichCivicStonicFacts(),
    userMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    timeoutMs: 25,
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(state.calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.reason, "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT");
  assert.equal(result.ownershipCompletionCount, 1);
});

test("E18 timeout after acceptance does not call ownership again", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-own-timeout-after-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  try {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: "biz-timeout-after",
      customerPhone: "905443829990",
      messageId: "wamid.timeout-after",
    });
    claimCloudInboundTurn({
      businessId: "biz-timeout-after",
      customerPhone: "905443829990",
      messageId: "wamid.timeout-after",
    });
    const persist = persistCloudInboundSemanticDecision({
      identity,
      messageId: "wamid.timeout-after",
      semanticDecisionStatus: "released",
      ownershipLane: "normal_routing",
      openaiSource: "openai",
      decision: {
        turnScope: "NEW_TRANSACTION",
        targetId: null,
        action: "reply",
        mutationIntent: "none",
      },
    });
    assert.equal(persist.ok, true);
    const snapshot = getCloudInboundSemanticDecision({ identity });
    assert.equal(snapshot.turnScope, "NEW_TRANSACTION");
    assert.equal(snapshot.targetId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E19 empty customer reply after ownership cannot change ownership", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "NEW_TRANSACTION",
      targetId: null,
      action: "reply",
      customerReply: "",
    },
    productionRichCivicStonicFacts(),
    PROD_CIVIC_SAME_ITEM_NEW_DURATION
  );
  assert.equal(state.calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
});

test("E20 reply-guard-style rejection cannot regenerate ownership in the same attempt", async () => {
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: productionRichCivicStonicFacts(),
    userMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return chatCompletionFromDecision({
        turnScope: "NEW_TRANSACTION",
        targetId: null,
        action: "reply",
        factKind: "booking_fact",
      });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.ownershipCompletionCount, 1);
  assert.equal(result.decision.customerReply, "");
});

test("accepted retry / outbound_locked recovery keep ownership completions at 0 new calls", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-own-resume-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  try {
    const identity = buildCloudInboundLifecycleIdentity({
      businessId: "biz-own-resume",
      customerPhone: "905443829990",
      messageId: "wamid.own-resume",
    });
    claimCloudInboundTurn({
      businessId: "biz-own-resume",
      customerPhone: "905443829990",
      messageId: "wamid.own-resume",
    });
    persistCloudInboundSemanticDecision({
      identity,
      messageId: "wamid.own-resume",
      semanticDecisionStatus: "accepted",
      ownershipLane: "post_confirm_pa",
      openaiSource: "openai",
      decision: {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: PROD_STONIC_BOOKING_ID,
        selectedBookingId: PROD_STONIC_BOOKING_ID,
        action: "reply",
        mutationIntent: "none",
      },
    });
    const first = getCloudInboundSemanticDecision({ identity });
    const rewrite = persistCloudInboundSemanticDecision({
      identity,
      messageId: "wamid.own-resume",
      semanticDecisionStatus: "accepted",
      ownershipLane: "post_confirm_pa",
      openaiSource: "openai",
      decision: {
        turnScope: "NEW_TRANSACTION",
        targetId: null,
        action: "reply",
        mutationIntent: "none",
      },
    });
    assert.equal(rewrite.ok, false);
    assert.equal(rewrite.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    assert.equal(
      getCloudInboundSemanticDecision({ identity }).turnScope,
      first.turnScope
    );
    assert.equal(
      getCloudInboundSemanticDecision({ identity }).targetId,
      PROD_STONIC_BOOKING_ID
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PA frozen OLD_BOOKING cannot re-decide ownership after empty compose", async () => {
  let decideCalls = 0;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "905443829990",
    messageText: "Meri Stonic booking ka total rent kitna hai?",
    messageId: "wamid.stonic-empty-compose",
    canonicalSemanticDecision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_STONIC_BOOKING_ID,
      selectedBookingId: PROD_STONIC_BOOKING_ID,
      action: "reply",
      mutationIntent: "none",
      factKind: "booking_fact",
      openaiSource: "openai",
    },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: productionRichCivicStonicFacts(),
    }),
    __decideCustomerTurnFn: async () => {
      decideCalls += 1;
      return {
        ok: true,
        source: "openai",
        decision: {
          turnScope: "NEW_TRANSACTION",
          targetId: null,
        },
      };
    },
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: false,
      reason: "INFORMATIONAL_COMPOSE_EMPTY_REPLY",
      reply: "",
    }),
  });
  assert.equal(decideCalls, 0);
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, PROD_STONIC_BOOKING_ID);
});

test("waiting-confirm frozen PENDING cannot call a referent Brain", async () => {
  let decideCalls = 0;
  const result = await handleAvailabilityCustomerCloudInbound({
    db: {},
    businessId: "business-1",
    customerPhone: "923001111111",
    messageText: "haan kar do",
    messageId: "wamid.pending-confirm",
    canonicalSemanticDecision: {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "confirm_pending_availability",
      mutationIntent: "none",
    },
    __decideCustomerTurnForTests: async () => {
      decideCalls += 1;
      return { ok: true, source: "openai", decision: { targetId: "other" } };
    },
  });
  assert.equal(decideCalls, 0);
  assert.equal(result.handled, false);
  assert.equal(result.reason, "CANONICAL_PENDING_TARGET_UNTRUSTED");
});

test("Brain V2 cannot change frozen NEW/SOCIAL/OLD ownership", async () => {
  const old = await runBrainV2LivePipeline({
    traceId: "own-old-blocked",
    businessId: "biz-ownership-boundary",
    message: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    messageId: "wamid.old-blocked",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    canonicalSemanticDecision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_BOOKING_ID,
      semanticDecisionStatus: "accepted",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => {
      throw new Error("brain_v2_must_not_run");
    },
  });
  assert.equal(old.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");

  const pending = await runBrainV2LivePipeline({
    traceId: "own-pending-blocked",
    businessId: "biz-ownership-boundary",
    message: "haan",
    messageId: "wamid.pending-blocked",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    canonicalSemanticDecision: {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      semanticDecisionStatus: "accepted",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => {
      throw new Error("brain_v2_must_not_run_pending");
    },
  });
  assert.equal(pending.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");

  const neu = await runBrainV2LivePipeline({
    traceId: "own-new-bound",
    businessId: "biz-ownership-boundary",
    message: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
    messageId: "wamid.new-bound",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    canonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      targetId: null,
      semanticDecisionStatus: "released",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (input) => {
      assert.equal(
        input.turnContext.canonicalSemanticDecision?.turnScope,
        "NEW_TRANSACTION"
      );
      return {
        workflowDecision: { workflowType: "availability_inquiry", reason: "test" },
        actionPlan: {
          replyDraft: "Check kar rahi hun.",
          actions: [{ type: "REPLY", payload: { text: "Check kar rahi hun." } }],
        },
        trace: {},
      };
    },
  });
  assert.notEqual(neu.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");
});

test("Group inbound does not consume Cloud DM frozen ownership", async () => {
  let orchestratorRan = false;
  const result = await runBrainV2LivePipeline({
    traceId: "own-group-isolated",
    businessId: "biz-ownership-boundary",
    message: "Hello group",
    messageId: "wamid.group",
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    canonicalSemanticDecision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_BOOKING_ID,
      semanticDecisionStatus: "accepted",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    __testOrchestratorFn: () => {
      orchestratorRan = true;
      return {
        workflowDecision: { workflowType: "social", reason: "test" },
        actionPlan: {
          replyDraft: "Hello",
          actions: [{ type: "REPLY", payload: { text: "Hello" } }],
        },
        trace: {},
      };
    },
  });
  assert.equal(orchestratorRan, true);
  assert.notEqual(result.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");
});

test("duplicate webhook after accepted ownership does not call ownership AI", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-own-dup-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  __clearWhatsAppInboundBufferForTests();
  try {
    let ownershipCalls = 0;
    const params = {
      db: {
        collection: () => ({
          doc: () => ({ get: async () => ({ exists: false }) }),
        }),
      },
      ownerUserId: "biz-dup",
      from: "905443829990",
      latestMessage: PROD_CIVIC_SAME_ITEM_NEW_DURATION,
      messageId: "wamid.dup-own",
      conversationHistory: "",
      sendCredentials: { phoneNumberId: "pn", accessToken: "tok" },
      __executeCloudDmOwnershipDecisionFn: async () => {
        ownershipCalls += 1;
        return {
          ok: true,
          source: "openai",
          decision: ownershipDecisionPayload(),
        };
      },
      __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
      __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
      __tryHandleCustomerBusinessPaInboundFn: async () => null,
      __tryBrainV2LiveBeforeLegacyFn: async () => ({
        handled: true,
        legacyBypassed: true,
        reply: "ok",
        sendVia: "CLOUD_API",
        messageMeta: { finalReplySource: "TEST" },
      }),
      __sendOutboundMessageFn: async () => ({
        ok: true,
        providerMessageId: "wamid.out-dup",
      }),
      __resolveActiveCustomerBookingFactsFn: async () => ({
        ok: true,
        facts: productionRichCivicStonicFacts(),
      }),
    };
    await executeWhatsAppAiPipeline(params).catch(() => {});
    const firstCalls = ownershipCalls;
    await executeWhatsAppAiPipeline(params).catch(() => {});
    assert.ok(firstCalls <= 1);
    assert.equal(ownershipCalls, firstCalls);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    __clearWhatsAppInboundBufferForTests();
  }
});

test("parseCloudDmOwnershipDecision never requires customerReply", () => {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      targetId: PROD_CIVIC_BOOKING_ID,
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
    })
  );
  assert.equal(parsed.turnScope, "NEW_TRANSACTION");
  assert.equal(parsed.targetId, null);
  assert.equal(parsed.customerReply, "");
  assert.equal(parseCloudDmOwnershipDecision("not json"), null);
  assert.equal(parseCloudDmOwnershipDecision("{}"), null);
});

test("structurally invalid OLD_BOOKING is not accepted after the single completion", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: "not-a-trusted-id",
      action: "reply",
    },
    productionRichCivicStonicFacts(),
    "booking?"
  );
  assert.equal(state.calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(String(result.reason), /OLD_BOOKING/);
});

test("neutral facts keep candidate identifying data without pre-own language", () => {
  const neutral = buildNeutralCloudDmOwnershipFacts(
    productionRichCivicStonicFacts()
  );
  const civic = neutral.bookingCandidates[0];
  assert.equal(civic.id, PROD_CIVIC_BOOKING_ID);
  assert.equal(civic.durationDays, 5);
  assert.equal(civic.dailyRate, 8000);
  assert.equal(civic.role, "historical_candidate");
  assert.equal(neutral.booking, null);
  assert.equal(neutral.bookingFocus, null);
  const validation = validatePostConfirmSemanticOwnership(
    applyPostConfirmDerivedOwnershipMechanics(
      {
        turnScope: "NEW_TRANSACTION",
        targetId: null,
        action: "reply",
        mutationIntent: "none",
      },
      neutral
    ),
    neutral
  );
  assert.equal(validation.ok, true);
});

test("unique Stonic factual stays OLD_BOOKING with exact Stonic id", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_STONIC_BOOKING_ID,
      action: "reply",
      factKind: "booking_fact",
    },
    productionRichCivicStonicFacts(),
    "Meri Stonic booking ka total rent kitna hai?"
  );
  assert.equal(state.calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, PROD_STONIC_BOOKING_ID);
  assert.equal(result.decision.mutationIntent, "none");
});

test("unique Stonic mutation stays OLD_BOOKING with exact Stonic id", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_STONIC_BOOKING_ID,
      action: "request_booking_mutation",
      mutationIntent: "cancel_booking",
      factKind: "action",
    },
    productionRichCivicStonicFacts(),
    "Meri Stonic booking cancel kar do"
  );
  assert.equal(state.calls, 1);
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, PROD_STONIC_BOOKING_ID);
  assert.equal(result.decision.mutationIntent, "cancel_booking");
});

test("ownership OpenAI payload omits selectionIndex while runtime facts keep it", async () => {
  const facts = productionRichTwoCivicFacts();
  const packed = buildCloudDmOwnershipPromptFacts(facts);
  const internal = buildNeutralCloudDmOwnershipFacts(facts);
  assert.equal(internal.bookingCandidates[0].selectionIndex, 1);
  assert.equal(internal.bookingCandidates[1].selectionIndex, 2);
  assert.equal(packed.bookingCandidates[0].selectionIndex, undefined);
  assert.equal(packed.bookingCandidates[1].selectionIndex, undefined);
  const { state } = await resolveWithDecision(
    {
      turnScope: "UNCLEAR",
      targetId: null,
      action: "reply",
      mutationIntent: "none",
      factKind: "vague",
    },
    facts,
    "Civic booking extend kar do"
  );
  const userContent = String(state.lastArgs?.messages?.[1]?.content ?? "");
  assert.match(userContent, /CLOUD_DM_OWNERSHIP_CANDIDATE_JSON/);
  assert.doesNotMatch(userContent, /selectionIndex/);
});

test("model pick of packed candidate #1 vs #2 is UNCLEAR unless a unique id is cited", async () => {
  const facts = productionRichTwoCivicFacts();
  const packed = buildCloudDmOwnershipPromptFacts(facts);
  const candidateOne = packed.bookingCandidates[0];
  const candidateTwo = packed.bookingCandidates[1];
  assert.equal(candidateOne.id, PROD_CIVIC_BOOKING_ID);
  assert.equal(candidateTwo.id, PROD_CIVIC_SECOND_BOOKING_ID);
  assert.equal(candidateOne.itemId, candidateTwo.itemId);
  const ambiguous = "Civic booking extend kar do";

  for (const guessedId of [candidateOne.id, candidateTwo.id]) {
    const collapsed = collapseIndistinguishableSameItemOwnership(
      {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: guessedId,
        action: "request_booking_mutation",
        mutationIntent: "extend_booking",
      },
      buildNeutralCloudDmOwnershipFacts(facts),
      ambiguous
    );
    assert.equal(collapsed.turnScope, "UNCLEAR", guessedId);
    assert.equal(collapsed.targetId, null, guessedId);
    assert.equal(collapsed.mutationIntent, "none", guessedId);

    const { result, state } = await resolveWithDecision(
      {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: guessedId,
        action: "request_booking_mutation",
        mutationIntent: "extend_booking",
        factKind: "action",
      },
      facts,
      ambiguous
    );
    assert.equal(state.calls, 1, guessedId);
    assert.equal(result.ok, true, guessedId);
    assert.equal(result.decision.turnScope, "UNCLEAR", guessedId);
    assert.equal(result.decision.targetId, null, guessedId);
    assert.equal(result.decision.mutationIntent, "none", guessedId);
  }

  const citedBooking = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: candidateTwo.id,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
      factKind: "action",
    },
    facts,
    `Civic booking ${candidateTwo.id} extend kar do`
  );
  assert.equal(citedBooking.result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(citedBooking.result.decision.targetId, candidateTwo.id);

  const citedAvr = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: candidateOne.id,
      action: "reply",
      mutationIntent: "none",
      factKind: "booking_fact",
    },
    facts,
    `Meri Civic ${PROD_CIVIC_AVR_ID} ka status?`
  );
  assert.equal(citedAvr.result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(citedAvr.result.decision.targetId, candidateOne.id);

  const mismatch = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: candidateOne.id,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
      factKind: "action",
    },
    facts,
    `Civic booking ${candidateTwo.id} extend kar do`
  );
  assert.equal(mismatch.result.decision.turnScope, "UNCLEAR");
  assert.equal(mismatch.result.decision.targetId, null);
});

test("ambiguous two-Civic mutation cannot be owned by first or last list position", async () => {
  const facts = productionRichTwoCivicFacts();
  const packed = buildCloudDmOwnershipPromptFacts(facts);
  const civicIds = packed.bookingCandidates
    .filter((row) => row.itemId === packed.bookingCandidates[0].itemId || row.id === PROD_CIVIC_BOOKING_ID || row.id === PROD_CIVIC_SECOND_BOOKING_ID)
    .filter((row) =>
      [PROD_CIVIC_BOOKING_ID, PROD_CIVIC_SECOND_BOOKING_ID].includes(row.id)
    )
    .map((row) => row.id);
  assert.equal(civicIds.length, 2);
  for (const guessedId of civicIds) {
    const { result, state } = await resolveWithDecision(
      {
        turnScope: "OLD_BOOKING_REFERENCE",
        targetId: guessedId,
        action: "request_booking_mutation",
        mutationIntent: "extend_booking",
        factKind: "action",
      },
      facts,
      "Civic booking extend kar do"
    );
    assert.equal(state.calls, 1, guessedId);
    assert.equal(result.ok, true, guessedId);
    assert.equal(result.decision.turnScope, "UNCLEAR", guessedId);
    assert.equal(result.decision.targetId, null, guessedId);
    assert.equal(result.decision.mutationIntent, "none", guessedId);
    assert.notEqual(result.decision.action, "request_booking_mutation", guessedId);
  }
});

test("reversed two-Civic candidate array still refuses ambiguous mutation", async () => {
  const facts = productionRichTwoCivicFactsReversed();
  const collapsed = collapseIndistinguishableSameItemOwnership(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: facts.bookingCandidates[0].id,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
    },
    buildNeutralCloudDmOwnershipFacts(facts),
    "Civic booking extend kar do"
  );
  assert.equal(collapsed.turnScope, "UNCLEAR");
  assert.equal(collapsed.targetId, null);
  assert.equal(collapsed.mutationIntent, "none");
  const { result } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_SECOND_BOOKING_ID,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
    },
    facts,
    "Civic booking extend kar do"
  );
  assert.equal(result.decision.turnScope, "UNCLEAR");
  assert.equal(result.decision.targetId, null);
});

test("three Civic candidates stay UNCLEAR on ambiguous extend", async () => {
  const { result } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_BOOKING_ID,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
    },
    productionRichThreeCivicFacts(),
    "Civic booking extend kar do"
  );
  assert.equal(result.decision.turnScope, "UNCLEAR");
  assert.equal(result.decision.targetId, null);
  assert.equal(result.decision.mutationIntent, "none");
});

test("explicit distinguishing Civic id selects that exact booking", async () => {
  const { result } = await resolveWithDecision(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: PROD_CIVIC_BOOKING_ID,
      action: "reply",
    },
    productionRichTwoCivicFacts(),
    `Meri booking ${PROD_CIVIC_BOOKING_ID} ka status kya hai?`
  );
  assert.equal(result.decision.turnScope, "OLD_BOOKING_REFERENCE");
  assert.equal(result.decision.targetId, PROD_CIVIC_BOOKING_ID);
});

test("fresh Civic with old Civic history remains NEW_TRANSACTION", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "NEW_TRANSACTION",
      targetId: null,
      action: "reply",
    },
    productionRichCivicStonicFacts(),
    PROD_CIVIC_SAME_ITEM_NEW_DURATION
  );
  assert.equal(state.calls, 1);
  assert.equal(result.decision.turnScope, "NEW_TRANSACTION");
  assert.equal(result.decision.targetId, null);
});

test("pending AVR factual and confirm keep the exact pending id", async () => {
  const facts = productionRichFactsWithPendingCivic();
  const factual = await resolveWithDecision(
    {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "reply",
    },
    facts,
    "per day kitna hai?"
  );
  assert.equal(
    factual.result.decision.targetId,
    "avr_pending_civic_waiting_confirm"
  );
  const confirm = await resolveWithDecision(
    {
      turnScope: "PENDING_AVAILABILITY_REFERENCE",
      targetId: "avr_pending_civic_waiting_confirm",
      action: "confirm_pending_availability",
    },
    facts,
    "haan kar do"
  );
  assert.equal(
    confirm.result.decision.action,
    "confirm_pending_availability"
  );
});

test("UNCLEAR cannot keep a mutation owner", async () => {
  const { result, state } = await resolveWithDecision(
    {
      turnScope: "UNCLEAR",
      targetId: null,
      action: "request_booking_mutation",
      mutationIntent: "extend_booking",
      factKind: "vague",
    },
    productionRichTwoCivicFacts(),
    "Civic booking extend kar do"
  );
  assert.equal(state.calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.turnScope, "UNCLEAR");
  assert.equal(result.decision.targetId, null);
  assert.equal(result.decision.mutationIntent, "none");
});

test("Hello remains SOCIAL_GENERAL with null target", async () => {
  const { result } = await resolveWithDecision(
    {
      turnScope: "SOCIAL_GENERAL",
      targetId: null,
      factKind: "non_business",
    },
    productionRichCivicStonicFacts(),
    "Hello"
  );
  assert.equal(result.decision.turnScope, "SOCIAL_GENERAL");
  assert.equal(result.decision.targetId, null);
});
