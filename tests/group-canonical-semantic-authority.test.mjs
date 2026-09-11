import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  resolveGroupCanonicalSemanticDecision,
  validateGroupCanonicalSemanticDecision,
} from "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js";
import { buildTurnContextInput } from "../src/brain/live/buildTurnContextInput.js";
import { resolveBusinessDecisionForPendingContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";

const CATALOG = Object.freeze([
  Object.freeze({ id: "item-civic", name: "Civic", displayLabel: "Honda Civic" }),
  Object.freeze({ id: "item-corolla", name: "Corolla", displayLabel: "Toyota Corolla" }),
]);

function neutralTargetReference() {
  return {
    source: "none",
    sourceTurnId: null,
    targetType: "none",
    targetId: null,
  };
}

function groupDecision({
  semanticIntent = "browse_options",
  itemScope = "broad",
  itemReferents = [],
  itemReferenceMode = "NONE",
  turnScope = "NEW_TRANSACTION",
  overrides = {},
} = {}) {
  return {
    turnScope,
    semanticIntent,
    itemScope,
    itemReferents,
    itemReferenceMode,
    temporalRequest: { startDateKind: "none", startDate: null },
    targetReference: neutralTargetReference(),
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    semanticDecisionStatus: "released",
    semanticDecisionProvenance:
      VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
    ...overrides,
  };
}

function currentTurnDecision(message, semanticIntent = "availability_inquiry") {
  const surfaceText = "Civic";
  const start = message.indexOf(surfaceText);
  return groupDecision({
    semanticIntent,
    itemScope: "specific",
    itemReferenceMode: "CURRENT_TURN",
    itemReferents: [{
      source: "current_turn",
      surfaceText,
      start,
      end: start + surfaceText.length,
      trustedItemId: null,
      sourceTurnId: null,
    }],
  });
}

function contextualDecision(semanticIntent = "availability_inquiry") {
  return groupDecision({
    semanticIntent,
    itemScope: "specific",
    itemReferenceMode: "CONTEXTUAL",
    itemReferents: [{
      source: "trusted_fresh_focus",
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: "item-civic",
      sourceTurnId: "assistant:prior-turn",
    }],
  });
}

test("Group adapter supplies neutral facts and accepts broad semantic authority", async () => {
  let capturedFacts = null;
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: "Which options are available?",
    catalogItems: CATALOG,
    trustedFreshItemFocus: {
      itemId: "item-civic",
      sourceTurnId: "assistant:prior-turn",
    },
    __executeCloudDmOwnershipDecisionFn: async ({ facts }) => {
      capturedFacts = facts;
      return {
        ok: true,
        source: "openai",
        decision: groupDecision(),
        ownershipCompletionCount: 1,
        retryable: false,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.semanticIntent, "browse_options");
  assert.equal(result.decision.itemReferenceMode, "NONE");
  assert.deepEqual(capturedFacts.bookingCandidates, []);
  assert.deepEqual(capturedFacts.pendingAvailabilityRequests, []);
  assert.deepEqual(capturedFacts.pendingOwnerCheckRequests, []);
  assert.deepEqual(capturedFacts.ownershipReferenceContext, []);
  assert.equal(capturedFacts.lastAvailabilityAssist, null);
});

test("Group adapter accepts runtime-hydrated trusted contextual identity", async () => {
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: "available?",
    catalogItems: CATALOG,
    trustedFreshItemFocus: {
      itemId: "item-civic",
      sourceTurnId: "assistant:prior-turn",
    },
    __executeCloudDmOwnershipDecisionFn: async () => ({
      ok: true,
      source: "openai",
      decision: contextualDecision(),
      ownershipCompletionCount: 1,
      retryable: false,
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.itemReferenceMode, "CONTEXTUAL");
  assert.equal(result.decision.itemReferents[0].trustedItemId, "item-civic");
});

test("Group adapter rejects protected Cloud targets and mutations", () => {
  const protectedDecision = groupDecision({
    overrides: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: "booking-1",
      mutationIntent: "cancel_booking",
      action: "request_booking_mutation",
      targetReference: {
        source: "conversation_turn",
        sourceTurnId: "user:old",
        targetType: "historical_booking",
        targetId: "booking-1",
      },
    },
  });
  const validation = validateGroupCanonicalSemanticDecision(protectedDecision, {
    customerMessage: "cancel it",
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "GROUP_PROTECTED_SEMANTIC_SCOPE_REJECTED");
});

test("Group adapter failure remains non-mutating and does not synthesize regex semantics", async () => {
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: "unclassifiable",
    __executeCloudDmOwnershipDecisionFn: async () => ({
      ok: false,
      source: "technical_fallback",
      reason: "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT",
      retryable: false,
      ownershipCompletionCount: 1,
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(result.decision, undefined);
});

test("validated Group broad scope cannot inherit a prior item", () => {
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: "biz-group",
    chatId: "group-1",
    participantKey: "participant-1",
    messageText: "Which options are available?",
    catalogItems: CATALOG,
    memorySnapshot: { lastResolvedItemId: "item-civic" },
    authoritativeSemanticIntent: "browse_options",
    authoritativeItemScope: "broad",
    canonicalItemReferents: [],
    validatedGroupCanonicalAuthority: true,
  });
  assert.equal(input.validatedGroupCanonicalAuthority, true);
  assert.equal(input.itemReferenceMode, "NONE");
  assert.equal(input.authoritativeItem, null);
  assert.equal(input._authority.priorItemUsed, false);
});

test("validated Group contextual scope uses only the trusted hydrated referent", () => {
  const input = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: "biz-group",
    chatId: "group-1",
    participantKey: "participant-1",
    messageText: "available?",
    catalogItems: CATALOG,
    memorySnapshot: { lastResolvedItemId: "item-corolla" },
    authoritativeSemanticIntent: "availability_inquiry",
    authoritativeItemScope: "specific",
    canonicalItemReferents: contextualDecision().itemReferents,
    validatedGroupCanonicalAuthority: true,
  });
  assert.equal(input.itemReferenceMode, "CONTEXTUAL");
  assert.equal(input.authoritativeItem.id, "item-civic");
  assert.equal(input._authority.priorItemUsed, true);
  assert.equal(input._authority.priorItemReason, "validated_contextual_referent");
});

test("ambiguous candidate ID is not actionable for validated Group authority", () => {
  const itemFacts = { status: "ambiguous", id: "candidate-id" };
  const decision = resolveBusinessDecisionForPendingContext({
    normalizedMessage: "the item",
    understanding: {
      authoritativeSemanticIntent: "booking_request",
      canonicalItemReferents: [{}],
      resolvedItemId: "candidate-id",
      durationDays: 3,
    },
    signals: {},
    itemFacts,
    participantFacts: { participant: { memoryAllowed: true } },
    authoritativeSemanticIntent: "booking_request",
    authoritativeItemScope: "specific",
    validatedGroupCanonicalAuthority: true,
  });
  assert.equal(decision.resolvedItemId, null);
  assert.deepEqual(decision.sideEffectsAllowed, []);

  const canonical = {
    validatedGroupCanonicalAuthority: true,
    businessId: "biz-group",
    resolvedItem: { status: "ambiguous", id: "candidate-id", displayLabel: "Candidate" },
    decision: { workflowType: "booking_request" },
    turn: { durationDays: 3 },
    actions: { availabilityOwnerCheckExecute: true },
    verified: { availability: { status: "available", isAvailable: true } },
  };
  const availabilityPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "available?" } },
    understanding: { resolvedItemId: "candidate-id", resolvedItemLabel: "Candidate", signals: {} },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
  assert.equal(
    availabilityPlan.actions.some((action) =>
      ["AVAILABILITY_OWNER_CHECK_REQUIRED", "CREATE_BOOKING", "NOTIFY_OWNER"].includes(action.type)
    ),
    false
  );
  assert.equal(availabilityPlan.actions[0].type, "NO_OP");

  const bookingPlan = buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "book it", businessId: "biz-group" } },
    turnContext: { businessId: "biz-group" },
    understanding: { resolvedItemId: "candidate-id", resolvedItemLabel: "Candidate", durationDays: 3 },
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
  assert.equal(
    bookingPlan.actions.some((action) =>
      ["AVAILABILITY_OWNER_CHECK_REQUIRED", "CREATE_BOOKING", "NOTIFY_OWNER"].includes(action.type)
    ),
    false
  );
});

test("resolved Group items remain actionable and legacy/Cloud status-less contracts are unchanged", () => {
  const baseCanonical = {
    businessId: "biz-actionable",
    resolvedItem: { id: "item-civic", displayLabel: "Honda Civic" },
    decision: { workflowType: "booking_request" },
    turn: {
      durationDays: 3,
      sourceMessageId: "turn-actionable",
      sourceRowKey: "row-actionable",
      guaranteeKey: "guarantee-actionable",
      sourceTurnKey: "guarantee-actionable",
    },
    participant: { key: "participant-1", identity: "stable", memoryAllowed: true },
    sourceIdentity: {
      participantKey: "participant-1",
      participantIdentity: "stable",
      chatId: "group-1",
      chatType: "group",
      sourceMessageId: "turn-actionable",
      sourceRowKey: "row-actionable",
      guaranteeKey: "guarantee-actionable",
      sourceTurnKey: "guarantee-actionable",
    },
    actions: { availabilityOwnerCheckExecute: true },
    verified: {
      availability: {
        status: "available",
        isAvailable: true,
        requestedStartAt: "2026-09-20T00:00:00.000Z",
        requestedEndAt: "2026-09-23T00:00:00.000Z",
        windowApplied: true,
        verifiedAlternatives: [],
      },
    },
  };
  const buildPlan = (canonical) => buildBookingRequestActionPlan({
    admittedTurn: { turn: { text: "book it", businessId: "biz-actionable" } },
    turnContext: { businessId: "biz-actionable" },
    understanding: {
      resolvedItemId: "item-civic",
      resolvedItemLabel: "Honda Civic",
      durationDays: 3,
    },
    businessContext: { resolvedBusinessTurnContext: canonical },
  });

  const validatedGroupPlan = buildPlan({
    ...baseCanonical,
    validatedGroupCanonicalAuthority: true,
    resolvedItem: { ...baseCanonical.resolvedItem, status: "resolved" },
  });
  assert.equal(
    validatedGroupPlan.actions.some((action) =>
      action.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"
    ),
    true
  );

  const legacyOrCloudPlan = buildPlan(baseCanonical);
  assert.equal(
    legacyOrCloudPlan.actions.some((action) =>
      action.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"
    ),
    true
  );
});

test("shared pipeline accepts only the dedicated marked Group field and Cloud cannot enter it", async () => {
  const message = "Civic available?";
  let groupCaptured = null;
  const groupResult = await runBrainV2LivePipeline({
    traceId: "group-marker",
    businessId: "biz-group",
    message,
    messageId: "group-turn-1",
    channel: "whatsapp_web",
    chatType: "group",
    isGroupInbound: true,
    participantKey: "participant-1",
    catalogItems: CATALOG,
    validatedGroupCanonicalSemanticDecision: currentTurnDecision(message),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (input) => {
      groupCaptured = input.turnContext;
      return {
        workflowDecision: { workflowType: "greeting", reason: "focused_test" },
        actionPlan: {
          replyDraft: "ok",
          actions: [{ type: "REPLY", payload: { text: "ok", execute: false } }],
        },
        trace: {},
      };
    },
  });
  assert.equal(groupResult.handled, true);
  assert.equal(groupCaptured.canonicalSemanticDecision.semanticDecisionProvenance,
    VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE);
  assert.equal(groupCaptured.authoritativeSemanticIntent, "availability_inquiry");

  let cloudCaptured = null;
  const cloudDecision = {
    ...groupDecision(),
    semanticDecisionProvenance: undefined,
    semanticDecisionStatus: "released",
  };
  const cloudResult = await runBrainV2LivePipeline({
    traceId: "cloud-isolation",
    businessId: "biz-cloud",
    message: "show options",
    messageId: "cloud-turn-1",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems: CATALOG,
    canonicalSemanticDecision: cloudDecision,
    validatedGroupCanonicalSemanticDecision: currentTurnDecision(message),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (input) => {
      cloudCaptured = input.turnContext;
      return {
        workflowDecision: { workflowType: "greeting", reason: "focused_test" },
        actionPlan: {
          replyDraft: "ok",
          actions: [{ type: "REPLY", payload: { text: "ok", execute: false } }],
        },
        trace: {},
      };
    },
  });
  assert.equal(cloudResult.handled, true);
  assert.equal(cloudCaptured.canonicalSemanticDecision, cloudDecision);
  assert.equal(cloudCaptured.authoritativeSemanticIntent, "browse_options");
});
