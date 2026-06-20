import test from "node:test";
import assert from "node:assert/strict";

import { understandTurn } from "../../src/brain/understanding/UnderstandingEngine.js";
import {
  hasOpenCollectDurationPending,
  selectWorkflow,
} from "../../src/brain/workflow/WorkflowEngine.js";

const CATALOG_ITEMS = [
  {
    id: "civic_2026_oriel_white",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
    color: "White",
    availability: true,
  },
];

function makeAdmittedTurn(message) {
  return {
    turn: {
      turnId: `turn-${String(message).slice(0, 24).replace(/\s+/g, "-") || "msg"}`,
      businessId: "brain-workflow-test-business",
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

function makeTurnContext({
  withCollectDuration = false,
  lastResolvedItemId = "civic_2026_oriel_white",
} = {}) {
  return {
    sessionId: "session-1",
    businessId: "brain-workflow-test-business",
    chatKey: "car rental queries",
    participantKey: "participant-1",
    schemaVersion: 1,
    lastResolvedItemId,
    memorySnapshot: withCollectDuration
      ? {
          lastResolvedItemId,
          pendingAction: {
            type: "collect_duration",
            itemId: lastResolvedItemId,
            status: "awaiting",
          },
        }
      : {
          lastResolvedItemId,
        },
    activeWorkflowType: withCollectDuration ? "collect_duration" : undefined,
  };
}

function makeFreshContext() {
  return {
    sessionId: "session-1",
    businessId: "brain-workflow-test-business",
    chatKey: "car rental queries",
    participantKey: "participant-1",
    schemaVersion: 1,
  };
}

test("WorkflowEngine: Civic available? → availability_inquiry", () => {
  const turnContext = makeFreshContext();
  const admittedTurn = makeAdmittedTurn("Civic available?");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "Civic available?",
  });

  assert.equal(decision.workflowType, "availability_inquiry");
  assert.equal(decision.reason, "explicit_item_availability_question");
});

test("WorkflowEngine: rent kitna with duration under collect_duration → pricing_with_duration", () => {
  const turnContext = makeTurnContext({ withCollectDuration: true });
  assert.equal(hasOpenCollectDurationPending(turnContext), true);

  const admittedTurn = makeAdmittedTurn("10 din k lye rent kitna hai?");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  assert.equal(understanding.itemSource, "memory");
  assert.equal(understanding.askedField, "price_with_duration");
  assert.equal(understanding.signals?.priceAsk, true);
  assert.equal(understanding.signals?.bookingCommitment, false);

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "10 din k lye rent kitna hai?",
  });

  assert.equal(decision.workflowType, "pricing_with_duration");
  assert.equal(decision.interruptsPendingWorkflow, true);
});

test("WorkflowEngine: duration-only under collect_duration → booking_request", () => {
  const turnContext = makeTurnContext({ withCollectDuration: true });
  const admittedTurn = makeAdmittedTurn("10 din k lye");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "10 din k lye",
  });

  assert.equal(understanding.signals?.priceAsk, false);
  assert.equal(decision.workflowType, "booking_request");
});

test("WorkflowEngine: duration + book kar do → booking_request", () => {
  const turnContext = makeTurnContext({ withCollectDuration: true });
  const admittedTurn = makeAdmittedTurn("10 din k lye book kar do");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "10 din k lye book kar do",
  });

  assert.equal(understanding.signals?.bookingCommitment, true);
  assert.equal(decision.workflowType, "booking_request");
  assert.equal(decision.reason, "duration_with_booking_commitment_after_collect_duration");
});

test("WorkflowEngine: Revo available hai? → unlisted_item", () => {
  const turnContext = makeTurnContext({ lastResolvedItemId: "" });
  const admittedTurn = makeAdmittedTurn("Revo available hai?");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "Revo available hai?",
  });

  assert.equal(understanding.unlistedMentionLabel, "Revo");
  assert.equal(decision.workflowType, "unlisted_item");
  assert.equal(decision.reason, "availability_question_for_item_not_in_catalog");
});

test("WorkflowEngine: options kya hain? → browse_options", () => {
  const turnContext = makeTurnContext({ lastResolvedItemId: "" });
  const admittedTurn = makeAdmittedTurn("options kya hain?");
  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems: CATALOG_ITEMS,
  });

  const decision = selectWorkflow({
    understanding,
    turnContext,
    message: "options kya hain?",
  });

  assert.equal(decision.workflowType, "browse_options");
  assert.equal(decision.reason, "generic_browse_request_without_explicit_item_focus");
});
