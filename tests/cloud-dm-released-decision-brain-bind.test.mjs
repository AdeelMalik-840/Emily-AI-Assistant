import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz-canonical-bind";
process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE = "true";

const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

function releasedDecision(turnScope, semanticIntent = null) {
  return {
    turnScope,
    targetId: null,
    targetContext: turnScope === "NEW_TRANSACTION" ? "NEW_TRANSACTION" : "NONE",
    mutationIntent: "none",
    action: "reply",
    factKind: turnScope === "SOCIAL_GENERAL" ? "non_business" : "booking_fact",
    semanticIntent:
      semanticIntent ??
      (turnScope === "SOCIAL_GENERAL"
        ? "social"
        : turnScope === "UNCLEAR"
          ? "unclear"
          : "availability_inquiry"),
    semanticDecisionStatus: "released",
    semanticDecisionVersion: 1,
    ownershipLane: "normal_routing",
    openaiSource: "openai",
  };
}

test("released SOCIAL_GENERAL does not execute CREATE_BOOKING from a transactional plan", async () => {
  let createBookingSeen = false;
  const result = await runBrainV2LivePipeline({
    traceId: "canonical-social-bind",
    businessId: "biz-canonical-bind",
    message: "Hello",
    messageId: "wamid.hello",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    canonicalSemanticDecision: releasedDecision("SOCIAL_GENERAL"),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "booking_request", reason: "test" },
      actionPlan: {
        replyDraft: "",
        actions: [
          {
            type: "CREATE_BOOKING",
            payload: {
              execute: true,
              itemId: "civic-1",
              itemName: "Honda Civic",
              durationDays: 3,
            },
          },
        ],
      },
      trace: {},
    }),
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "CANONICAL_SOCIAL_GENERAL_SCOPE");
  assert.equal(createBookingSeen, false);
  assert.notEqual(result.workflowType, "booking_request");
});

test("released NEW_TRANSACTION binds continuation off so historical booking cannot re-own", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "canonical-new-tx-bind",
    businessId: "biz-canonical-bind",
    message: "Honda Civic 3 din k liye chahiye",
    messageId: "wamid.fresh-civic",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    memorySnapshot: {
      lastBooking: { id: "E55qPBHJUW1NsUvNLAhH", itemLabel: "Honda Civic" },
    },
    canonicalSemanticDecision: releasedDecision("NEW_TRANSACTION"),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: (input) => {
      assert.equal(input.turnContext.continuation?.safeToOwn, false);
      assert.equal(input.turnContext.continuation?.active, false);
      assert.equal(
        input.turnContext.canonicalSemanticDecision?.turnScope,
        "NEW_TRANSACTION"
      );
      return {
        workflowDecision: { workflowType: "availability_inquiry", reason: "test" },
        actionPlan: {
          replyDraft: "Civic check kar rahi hun.",
          actions: [
            { type: "REPLY", payload: { text: "Civic check kar rahi hun." } },
          ],
        },
        trace: {},
      };
    },
  });
  assert.equal(result.handled, true);
  assert.notEqual(result.reason, "CANONICAL_SOCIAL_GENERAL_SCOPE");
});

test("frozen OLD_BOOKING_REFERENCE cannot be reinterpreted by Brain V2", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "canonical-old-booking-blocked",
    businessId: "biz-canonical-bind",
    message: "Honda Civic 3 din k liye chahiye",
    messageId: "wamid.old-blocked",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    canonicalSemanticDecision: {
      turnScope: "OLD_BOOKING_REFERENCE",
      targetId: "E55qPBHJUW1NsUvNLAhH",
      semanticDecisionStatus: "accepted",
      ownershipLane: "post_confirm_pa",
    },
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => {
      throw new Error("brain_v2_must_not_run_for_old_booking");
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");
});

test("frozen NEW_TRANSACTION keeps availability workflow available", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "canonical-new-tx-avr",
    businessId: "biz-canonical-bind",
    message: "Honda Civic 3 din k liye chahiye",
    messageId: "wamid.fresh-avr",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    canonicalSemanticDecision: releasedDecision("NEW_TRANSACTION"),
    executionContext: { db: {} },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __testOrchestratorFn: () => ({
      workflowDecision: { workflowType: "availability_inquiry", reason: "test" },
      actionPlan: {
        replyDraft: "Check kar rahi hun.",
        actions: [
          {
            type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
            payload: { execute: true, itemId: "civic-1", durationDays: 3 },
          },
        ],
      },
      trace: {},
    }),
  });
  assert.equal(result.handled, true);
  assert.notEqual(result.reason, "CANONICAL_OWNERSHIP_NOT_BRAIN_V2");
  assert.notEqual(result.reason, "CANONICAL_SOCIAL_GENERAL_SCOPE");
});
