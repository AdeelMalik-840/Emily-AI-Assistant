import test from "node:test";
import assert from "node:assert/strict";

import { isActionPlan, isTurnDecisionTrace } from "../../src/brain/contracts/index.js";
import { runConversationTurn } from "../../src/brain/orchestrator/ConversationOrchestrator.js";

const CATALOG_ITEMS = [
  {
    id: "civic_2026_oriel_white",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
    color: "White",
    availability: true,
    pricing: { daily: 8000 },
  },
];

function makeAdmittedTurn(message) {
  return {
    turn: {
      turnId: `turn-${String(message).slice(0, 24).replace(/\s+/g, "-") || "msg"}`,
      businessId: "brain-orchestrator-test-business",
      channelId: "whatsapp_web",
      chatKey: "car rental queries",
      participantKey: "participant-1",
      text: message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `car rental queries::${String(message).slice(0, 24).replace(/\s+/g, "-") || "msg"}`,
    admissionReason: "real_customer_inbound",
  };
}

function makeFreshContext() {
  return {
    sessionId: "session-1",
    businessId: "brain-orchestrator-test-business",
    chatKey: "car rental queries",
    participantKey: "participant-1",
    schemaVersion: 1,
  };
}

function makeCollectDurationContext(itemId = "civic_2026_oriel_white") {
  return {
    sessionId: "session-1",
    businessId: "brain-orchestrator-test-business",
    chatKey: "car rental queries",
    participantKey: "participant-1",
    schemaVersion: 1,
    lastResolvedItemId: itemId,
    memorySnapshot: {
      lastResolvedItemId: itemId,
      pendingAction: {
        type: "collect_duration",
        itemId,
        status: "awaiting",
      },
    },
    activeWorkflowType: "collect_duration",
  };
}

function assertReplyOnlyPlan(plan) {
  assert.equal(isActionPlan(plan), true);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "REPLY");
  assert.equal(plan.actions[0].payload.execute, false);
}

test("orchestrator: pricing_with_duration yields reply-only action plan", () => {
  const turnContext = makeCollectDurationContext();
  const admittedTurn = makeAdmittedTurn("10 din k lye rent kitna hai?");
  const inputSnapshot = structuredClone({ turnContext, admittedTurn });

  const result = runConversationTurn({
    traceId: "orch-core-pricing",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: CATALOG_ITEMS },
  });

  assert.equal(isTurnDecisionTrace(result.trace), true);
  assert.equal(result.workflowDecision.workflowType, "pricing_with_duration");
  assertReplyOnlyPlan(result.actionPlan);
  assert.equal(result.actionPlan?.persistenceIntent?.execute, false);
  assert.equal(result.trace.workflowDecision?.workflowType, "pricing_with_duration");
  assert.deepEqual({ turnContext, admittedTurn }, inputSnapshot);
});

test("orchestrator: booking_request yields booking + owner + update-state plan", () => {
  const turnContext = makeCollectDurationContext();
  const admittedTurn = makeAdmittedTurn("10 din k lye book kar do");
  const inputSnapshot = structuredClone({ turnContext, admittedTurn });

  const result = runConversationTurn({
    traceId: "orch-core-booking",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: CATALOG_ITEMS },
  });

  assert.equal(result.workflowDecision.workflowType, "booking_request");
  assert.equal(isActionPlan(result.actionPlan), true);
  assert.equal(result.actionPlan.actions.length, 4);
  assert.deepEqual(
    result.actionPlan.actions.map((a) => [a.type, a.payload.execute]),
    [
      ["REPLY", false],
      ["CREATE_BOOKING", false],
      ["NOTIFY_OWNER", false],
      ["UPDATE_STATE", false],
    ]
  );
  assert.deepEqual({ turnContext, admittedTurn }, inputSnapshot);
});

test("orchestrator: availability_inquiry resolves item and stays non-booking", () => {
  const turnContext = makeFreshContext();
  const admittedTurn = makeAdmittedTurn("Civic available?");

  const result = runConversationTurn({
    traceId: "orch-core-availability",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: CATALOG_ITEMS },
  });

  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.equal(result.understanding.resolvedItemId, "civic_2026_oriel_white");
  assert.equal(result.understanding.itemSource, "explicit");
  assertReplyOnlyPlan(result.actionPlan);
  assert.equal(
    result.actionPlan?.actions.some((a) => a.type === "CREATE_BOOKING" || a.type === "NOTIFY_OWNER"),
    false
  );
});

test("orchestrator: browse_options yields browse-only reply plan", () => {
  const turnContext = makeFreshContext();
  const admittedTurn = makeAdmittedTurn("options kya hain?");

  const result = runConversationTurn({
    traceId: "orch-core-browse",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: CATALOG_ITEMS },
  });

  assert.equal(result.workflowDecision.workflowType, "browse_options");
  assertReplyOnlyPlan(result.actionPlan);
  assert.match(String(result.actionPlan?.replyDraft ?? ""), /available options/i);
});

test("orchestrator: unlisted_item yields unlisted fallback reply plan", () => {
  const turnContext = makeFreshContext();
  const admittedTurn = makeAdmittedTurn("Revo available hai?");

  const result = runConversationTurn({
    traceId: "orch-core-unlisted",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: CATALOG_ITEMS },
  });

  assert.equal(result.workflowDecision.workflowType, "unlisted_item");
  assertReplyOnlyPlan(result.actionPlan);
  assert.match(String(result.actionPlan?.replyDraft ?? ""), /hamari list mein nahi hai/i);
});
