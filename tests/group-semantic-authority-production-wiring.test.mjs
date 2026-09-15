/**
 * Phase 1 wiring: validated Group canonical semantic authority through the
 * REAL production path (executeWhatsAppAiPipeline / runBrainV2LivePipeline /
 * turnContextAuthority / resolveBusinessTurnContext / workflows) — not just
 * the resolveGroupCanonicalSemanticDecision adapter unit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-wiring";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "wiring-local-test",
  client_email: "wiring-local-test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  executeWhatsAppAiPipeline,
  __clearWhatsAppInboundBufferForTests,
} = await import("../src/services/whatsappInboundBuffer.js");
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { resolveGroupCanonicalSemanticDecision } = await import(
  "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
);
const { buildAvailabilityInquiryActionPlan } = await import(
  "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
);
const { buildBookingRequestActionPlan } = await import(
  "../src/brain/workflows/BookingRequestWorkflow.js"
);

const OWNER = "owner-wiring";
const GROUP = "Wiring Test Group";
const CHAT_KEY = "wiring-test-group";
const PARTICIPANT = "scope::participant-wiring";

const CATALOG = Object.freeze([
  Object.freeze({ id: "item-civic", name: "Civic", displayLabel: "Civic", isAvailable: true }),
  Object.freeze({ id: "item-corolla", name: "Corolla", displayLabel: "Corolla", isAvailable: true }),
]);

function current(surfaceText, start, end) {
  return { source: "current_turn", surfaceText, start, end, trustedItemId: null, sourceTurnId: null };
}
function contextual(trustedItemId, sourceTurnId) {
  return { source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId, sourceTurnId };
}
function modelDecision({
  semanticIntent = "availability_inquiry",
  itemScope = "specific",
  itemReferents = [],
  itemReferenceMode = itemReferents.length > 1
    ? "MULTIPLE_CURRENT"
    : itemReferents.length === 1
      ? itemReferents[0].source === "current_turn"
        ? "CURRENT_TURN"
        : "CONTEXTUAL"
      : "NONE",
  turnScope = "NEW_TRANSACTION",
  overrides = {},
} = {}) {
  return {
    turnScope,
    semanticIntent,
    itemScope,
    itemReferents,
    itemReferenceMode,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    temporalRequest: { startDateKind: "none", startDate: null },
    ...overrides,
  };
}
function completion(payload) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

function groupPayload(overrides = {}) {
  return {
    db: { collection: () => ({}) },
    ownerUserId: OWNER,
    userPhone: "unknown",
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${PARTICIPANT}`,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    isGroupMessage: true,
    canonicalGroupBuffer: true,
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    whatsappRecipientType: "group",
    participantKey: PARTICIPANT,
    participantWaId: "22222222222222@lid",
    groupName: GROUP,
    chatName: GROUP,
    playwrightChatKey: CHAT_KEY,
    catalogItems: CATALOG,
    messageSender: "user",
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __sendOutboundMessageFn: async () => ({ ok: true, providerMessageId: "test-msg" }),
    ...overrides,
  };
}

/** Resolves a REAL validated Group decision via the real adapter, then feeds
 * it into the REAL pipeline via __testOrchestratorFn, capturing exactly what
 * turnContext / resolvedBusinessTurnContext the pipeline actually built. */
async function runRealAdapterThenPipeline({
  message,
  modelPayload,
  trustedFreshItemFocus = null,
  memorySnapshot = {},
}) {
  const adapterResult = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    trustedFreshItemFocus,
    __chatCompletionsCreateForTests: async () => completion(modelPayload),
  });
  if (adapterResult.ok !== true) {
    return { adapterResult, captured: null, pipelineResult: null };
  }
  let captured = null;
  const pipelineResult = await runBrainV2LivePipeline({
    traceId: "wiring-test",
    businessId: OWNER,
    message,
    messageId: "wa::WIRE-1",
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    chatId: CHAT_KEY,
    playwrightChatKey: CHAT_KEY,
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${PARTICIPANT}`,
    participantKey: PARTICIPANT,
    catalogItems: CATALOG,
    memorySnapshot,
    validatedGroupCanonicalSemanticDecision: adapterResult.decision,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (orchestratorInput) => {
      captured = orchestratorInput;
      return {
        workflowDecision: { workflowType: "clarification" },
        actionPlan: { replyDraft: "", actions: [] },
      };
    },
  });
  return { adapterResult, captured, pipelineResult };
}

test.afterEach(() => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  globalThis.__ACTIVE_PIPELINE__ = false;
  globalThis.__UI_HARD_LOCK = false;
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = 0;
  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  globalThis.__messageQueue = [];
});

// --------------------------------------------------------------------
// 1. A real frozen canonical Group turn reaches Group semantic authority.
//
// scheduleBufferedWhatsAppInbound() has a fixed, explicit payload allowlist
// (verified by direct inspection) that does not forward test-only hooks
// through the buffer merge -- so this drives executeWhatsAppAiPipeline
// directly with canonicalGroupBuffer:true, exactly as the buffer's own
// flush path invokes it once a turn is frozen. This is still the real
// production entry point and the real Group semantic call site; only the
// outer (unchanged, separately and already regression-tested) fragment
// scheduling/merge layer is bypassed.
// --------------------------------------------------------------------
test("1. a real frozen canonical Group turn calls resolveGroupCanonicalSemanticDecision", async () => {
  let calls = 0;
  await executeWhatsAppAiPipeline(
    groupPayload({
      combinedMessage: "Civic available hai?",
      latestMessage: "Civic available hai?",
      messageId: "wa::PROD-1",
      sourceRowKey: "real:PROD-1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => {
        calls += 1;
        return {
          ok: true,
          source: "openai",
          decision: modelDecision({ itemReferents: [current("Civic", 0, 5)] }),
          ownershipCompletionCount: 1,
        };
      },
    })
  );
  assert.equal(calls, 1);
});

// --------------------------------------------------------------------
// 2. One already-merged canonical turn -> exactly ONE semantic call, never
// once per physical fragment.
//
// Fragment merging itself ("Civic" + "3 din ke liye" -> one canonical turn)
// is the canonical buffer's own, unchanged responsibility and is already
// proven by the existing, untouched buffer test suite (e.g.
// group-canonical-inbound-buffer-phase1.test.mjs's "pipeline normalization
// receives complete N-fragment turn" cases, re-run and passing against this
// change). What THIS test proves, directly, is the part this task actually
// changed: the new Group semantic call site executes exactly once per
// executeWhatsAppAiPipeline invocation (i.e. once per already-frozen
// canonical turn), structurally -- not in a loop, not once per fragment.
// --------------------------------------------------------------------
test("2. one canonical (already fragment-merged) turn produces exactly one semantic call", async () => {
  let calls = 0;
  await executeWhatsAppAiPipeline(
    groupPayload({
      combinedMessage: "Civic 3 din ke liye",
      latestMessage: "3 din ke liye",
      messageId: "wa::BURST-2",
      sourceRowKey: "real:BURST-2#1",
      sourceMessageIndex: 2,
      __executeGroupCanonicalSemanticDecisionFn: async () => {
        calls += 1;
        return {
          ok: true,
          source: "openai",
          decision: modelDecision({ itemReferents: [current("Civic", 0, 5)] }),
          ownershipCompletionCount: 1,
        };
      },
    })
  );
  assert.equal(calls, 1, "one canonical turn must produce exactly one semantic decision attempt");
});

// --------------------------------------------------------------------
// 3. Broad request: "Kon c gariyan available hain?" -> broad, no stale item.
// --------------------------------------------------------------------
test("3. broad request is broad scope and does not inherit a stale prior item", async () => {
  const { captured } = await runRealAdapterThenPipeline({
    message: "Kon c gariyan available hain?",
    modelPayload: modelDecision({
      semanticIntent: "browse_options",
      itemScope: "broad",
      itemReferents: [],
      itemReferenceMode: "NONE",
    }),
    memorySnapshot: { lastResolvedItemId: "item-civic", lastItem: { id: "item-civic" } },
  });
  assert.ok(captured, "orchestrator must have been invoked");
  assert.equal(captured.turnContext.authoritativeSemanticIntent, "browse_options");
  // The authoritative resolved-item field (what facts/workflows actually act
  // on) must be null for a broad request, regardless of stale session
  // memory -- this is the safety-relevant assertion. (brainTurnContext's own
  // lastResolvedItemId is an unrelated, pre-existing shadow-memory mirror
  // field populated directly from memorySnapshot by buildShadowTurnContext;
  // it is not read by fact/workflow resolution and is out of this task's
  // scope to change.)
  assert.equal(captured.businessContext.resolvedBusinessTurnContext.resolvedItem.id, null);
  assert.deepEqual(captured.turnContext.canonicalItemReferents, []);
});

// --------------------------------------------------------------------
// 4. Contextual: prior trusted Civic, then "available hai?" -> contextual Civic.
// --------------------------------------------------------------------
test("4. contextual continuation resolves to the trusted fresh focus item", async () => {
  const { captured } = await runRealAdapterThenPipeline({
    message: "available hai?",
    modelPayload: modelDecision({
      itemReferents: [contextual(null, null)],
      itemReferenceMode: "CONTEXTUAL",
    }),
    trustedFreshItemFocus: { itemId: "item-civic", sourceTurnId: "assistant:t1" },
  });
  assert.ok(captured);
  assert.equal(
    captured.businessContext.resolvedBusinessTurnContext.resolvedItem.id,
    "item-civic"
  );
  assert.equal(
    captured.businessContext.resolvedBusinessTurnContext.resolvedItem.status,
    "resolved"
  );
});

// --------------------------------------------------------------------
// 5. Explicit item overrides context: prior Civic, then "Corolla available hai?" -> Corolla.
// --------------------------------------------------------------------
test("5. an explicit current-turn item overrides stale trusted context", async () => {
  const { captured } = await runRealAdapterThenPipeline({
    message: "Corolla available hai?",
    modelPayload: modelDecision({ itemReferents: [current("Corolla", 0, 7)] }),
    trustedFreshItemFocus: { itemId: "item-civic", sourceTurnId: "assistant:t1" },
  });
  assert.ok(captured);
  assert.equal(
    captured.businessContext.resolvedBusinessTurnContext.resolvedItem.id,
    "item-corolla"
  );
});

// --------------------------------------------------------------------
// 6. Multi-item: "Civic ya Corolla me kya available hai?" -> both grounded,
//    no surface mismatch, may still hit the existing bounded-multi-item
//    clarification downstream (not collapsed silently to one item).
// --------------------------------------------------------------------
test("6. multi-item referents ground correctly and do not silently collapse to one item", async () => {
  const message = "Civic ya Corolla me kya available hai?";
  const adapterResult = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async () =>
      completion(
        modelDecision({
          itemReferents: [current("Civic", 50, 55), current("Corolla", 70, 77)],
          itemReferenceMode: "MULTIPLE_CURRENT",
        })
      ),
  });
  assert.equal(adapterResult.ok, true, "mechanical grounding must repair the wrong offsets");
  assert.deepEqual(
    adapterResult.decision.itemReferents.map((r) => [r.surfaceText, r.start, r.end]),
    [["Civic", 0, 5], ["Corolla", 9, 16]]
  );

  const { captured } = await runRealAdapterThenPipeline({
    message,
    modelPayload: modelDecision({
      itemReferents: [current("Civic", 50, 55), current("Corolla", 70, 77)],
      itemReferenceMode: "MULTIPLE_CURRENT",
    }),
  });
  assert.ok(captured);
  assert.equal(captured.turnContext.canonicalItemReferents.length, 2);
  const decision = captured.businessContext.resolvedBusinessTurnContext.decision;
  // Never silently one item: either both are carried as a bounded set, or the
  // existing bounded-multi-item clarification fires -- never a single guess.
  assert.notEqual(decision.resolvedItemId, "item-civic");
  assert.notEqual(decision.resolvedItemId, "item-corolla");
  assert.deepEqual(new Set(decision.boundedExplicitItemIds), new Set(["item-civic", "item-corolla"]));
});

// --------------------------------------------------------------------
// 7. Invalid/ambiguous item -> no AVR, no booking, no owner notification.
//
// A fully catalog-unknown current-turn item is released so the existing
// unknown-item compose lane can answer it. Workflow gates still refuse
// AVR/booking for non-resolved items (7b).
// --------------------------------------------------------------------
test("7a. a fully catalog-unknown current-turn item is released for the unknown-item lane", async () => {
  const adapterResult = await resolveGroupCanonicalSemanticDecision({
    userMessage: "Revo available hai?",
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async () =>
      completion(modelDecision({ itemReferents: [current("Revo", 0, 4)] })),
  });
  assert.equal(adapterResult.ok, true);
  assert.equal(adapterResult.decision.itemReferenceMode, "CURRENT_TURN");
  assert.equal(adapterResult.decision.itemReferents[0].surfaceText, "Revo");
});

test("7b. validated Group authority with a non-resolved item grants no owner-check/booking permission", () => {
  const resolvedBusinessTurnContext = Object.freeze({
    businessId: OWNER,
    validatedGroupCanonicalAuthority: true,
    resolvedItem: Object.freeze({ status: "ambiguous", id: "candidate-id" }),
    duration: Object.freeze({ days: 3 }),
    decision: Object.freeze({ workflowType: "booking_request" }),
  });

  const availabilityPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "Civic ya Corolla available hai?" } },
    understanding: { authoritativeSemanticIntent: "availability_inquiry" },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext },
  });
  const dangerous = new Set([
    "AVAILABILITY_OWNER_CHECK_REQUIRED",
    "CREATE_BOOKING",
    "NOTIFY_OWNER",
  ]);
  assert.ok(
    !availabilityPlan.actions.some((a) => dangerous.has(a.type)),
    "no AVR/booking/owner-notify action for a non-resolved item under validated Group authority"
  );

  const bookingPlan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "Civic ya Corolla book kar do" } },
    turnContext: { businessId: OWNER },
    understanding: { resolvedItemLabel: "candidate-id", resolvedItemId: "candidate-id" },
    businessContext: { resolvedBusinessTurnContext },
  });
  assert.ok(
    !bookingPlan.actions.some((a) => dangerous.has(a.type)),
    "no AVR/booking/owner-notify action from BookingRequestWorkflow either"
  );
});

// --------------------------------------------------------------------
// 8. Semantic OpenAI failure -> fail closed, no legacy takeover, no side effects.
// --------------------------------------------------------------------
test("8. a semantic OpenAI failure fails closed with no side effects and no legacy takeover", async () => {
  let calls = 0;
  let reachedOrchestrator = false;
  await executeWhatsAppAiPipeline(
    groupPayload({
      combinedMessage: "Civic available hai abhi bata dein?",
      latestMessage: "Civic available hai abhi bata dein?",
      messageId: "wa::FAIL-1",
      sourceRowKey: "real:FAIL-1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => {
        calls += 1;
        return { ok: false, source: "technical_fallback", reason: "GROUP_SEMANTIC_DECISION_UNUSABLE", retryable: false };
      },
      __testOrchestratorFn: () => {
        reachedOrchestrator = true;
        return { workflowDecision: { workflowType: "clarification" }, actionPlan: { replyDraft: "", actions: [] } };
      },
    })
  );
  assert.equal(calls, 1);
  assert.equal(
    reachedOrchestrator,
    false,
    "semantic failure must fail closed before any workflow/orchestrator runs"
  );
});

// --------------------------------------------------------------------
// 9. Protected action/mutation returned by the model -> rejected.
// --------------------------------------------------------------------
test("9. a protected mutation/target/action from the model is rejected before it becomes authoritative", async () => {
  const message = "Civic available hai?";
  const adapterResult = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async () =>
      completion(
        modelDecision({
          turnScope: "OLD_BOOKING_REFERENCE",
          itemReferents: [],
          itemReferenceMode: "NONE",
          overrides: {
            targetId: "booking-1",
            mutationIntent: "cancel_booking",
            action: "request_booking_mutation",
            targetReference: {
              source: "conversation_turn",
              sourceTurnId: "t-1",
              targetType: "historical_booking",
              targetId: "booking-1",
            },
          },
        })
      ),
  });
  assert.equal(adapterResult.ok, false);
  assert.equal(adapterResult.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(adapterResult.decision, undefined);

  // Defense-in-depth: even if a forged decision object claiming the right
  // provenance somehow reached the pipeline boundary, it is independently
  // re-validated and rejected there too -- never trusted on marker alone.
  const { VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE } = await import(
    "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
  );
  const forged = Object.freeze({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [current("Civic", 0, 5)],
    itemReferenceMode: "CURRENT_TURN",
    temporalRequest: null,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: "forged-booking-id",
    mutationIntent: "cancel_booking",
    action: "request_booking_mutation",
    semanticDecisionStatus: "released",
    semanticDecisionProvenance: VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  });
  let captured = null;
  await runBrainV2LivePipeline({
    traceId: "wiring-forged",
    businessId: OWNER,
    message,
    messageId: "wa::FORGE-1",
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    chatId: CHAT_KEY,
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${PARTICIPANT}`,
    participantKey: PARTICIPANT,
    catalogItems: CATALOG,
    memorySnapshot: {},
    validatedGroupCanonicalSemanticDecision: forged,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (orchestratorInput) => {
      captured = orchestratorInput;
      return { workflowDecision: { workflowType: "clarification" }, actionPlan: { replyDraft: "", actions: [] } };
    },
  });
  assert.equal(
    captured,
    null,
    "a forged decision failing re-validation must never reach the orchestrator"
  );
});

// --------------------------------------------------------------------
// 10. Cloud-native DM is unchanged, and cannot be reached via the Group field.
// --------------------------------------------------------------------
test("10. Cloud-native DM ignores an adversarially-attached validatedGroupCanonicalSemanticDecision", async () => {
  const cloudDecision = Object.freeze({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "browse_options",
    itemScope: "broad",
    itemReferents: [],
    itemReferenceMode: "NONE",
    temporalRequest: null,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    semanticDecisionStatus: "released",
  });
  const { VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE } = await import(
    "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
  );
  const groupShapedDecision = Object.freeze({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [current("Civic", 0, 5)],
    itemReferenceMode: "CURRENT_TURN",
    temporalRequest: null,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    semanticDecisionStatus: "released",
    semanticDecisionProvenance: VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  });
  let captured = null;
  await runBrainV2LivePipeline({
    traceId: "wiring-cloud",
    businessId: OWNER,
    message: "Civic available hai?",
    messageId: "wa::CLOUD-1",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    chatId: "dm-chat",
    sessionKey: `${OWNER}::dm::923001234567`,
    participantPhoneForDm: "923001234567",
    catalogItems: CATALOG,
    memorySnapshot: {},
    canonicalSemanticDecision: cloudDecision,
    // Adversarial: a Cloud call also carries a validly-provenanced Group field.
    validatedGroupCanonicalSemanticDecision: groupShapedDecision,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (orchestratorInput) => {
      captured = orchestratorInput;
      return { workflowDecision: { workflowType: "clarification" }, actionPlan: { replyDraft: "", actions: [] } };
    },
  });
  assert.ok(captured, "Cloud DM must still reach the orchestrator normally");
  assert.equal(captured.turnContext.canonicalSemanticDecision, cloudDecision);
  assert.equal(captured.turnContext.authoritativeSemanticIntent, "browse_options");
  assert.equal(
    captured.businessContext.resolvedBusinessTurnContext.validatedGroupCanonicalAuthority,
    false
  );
});
