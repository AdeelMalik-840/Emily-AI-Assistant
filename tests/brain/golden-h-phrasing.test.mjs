/**
 * Golden H — availability vs browse phrasing variants (v2 orchestrator path).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadSyntheticCarRentalCatalogFixture,
  buildFreshTurnContext,
  buildV2AdmittedTurn,
  goldenHTargetAvailabilityDecision,
  goldenHTargetBrowseDecision,
} from "../../src/brain/golden/goldenHarness.js";
import { v2OrchestratorResultToGoldenOutcome } from "../../src/brain/golden/goldenExpectations.js";
import { runConversationTurn } from "../../src/brain/orchestrator/ConversationOrchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = loadSyntheticCarRentalCatalogFixture();
const scenario = JSON.parse(
  readFileSync(join(__dirname, "fixtures/scenarios/golden-h-phrasing.json"), "utf8")
);

const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";

/**
 * @param {string} message
 * @param {string} [messageId]
 */
function runPhrasingTurn(message, messageId = "golden-h-turn") {
  const admittedTurn = buildV2AdmittedTurn({
    scenario: {
      scenarioId: "golden-h",
      channelId: "whatsapp_web",
      turns: [{ step: 1, message, messageId }],
    },
    fixture,
    turn: { step: 1, message, messageId },
  });

  return runConversationTurn({
    traceId: `golden-h-${messageId}`,
    admittedTurn,
    turnContext: buildFreshTurnContext(fixture),
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: fixture.conversationStyle ?? "casual_local",
    },
  });
}

/**
 * @param {ReturnType<typeof runConversationTurn>} result
 * @param {string} expectedItemId
 */
function assertAvailabilityOutcome(result, expectedItemId) {
  const outcome = v2OrchestratorResultToGoldenOutcome(result);

  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "browse_options");
  assert.notEqual(result.workflowDecision.workflowType, "noop");
  assert.notEqual(result.workflowDecision.workflowType, "booking_request");
  assert.equal(result.understanding.resolvedItemId, expectedItemId);
  assert.equal(result.understanding.itemSource, "explicit");
  assert.ok(result.actionPlan?.replyDraft, "expected item-specific availability reply draft");
  assert.match(String(result.actionPlan.replyDraft), /available/i);
  assert.equal(outcome.bookingPlanned, false);
  assert.equal(outcome.ownerApprovalPlanned, false);
}

/**
 * @param {ReturnType<typeof runConversationTurn>} result
 */
function assertBrowseOutcome(result) {
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const reply = String(result.actionPlan?.replyDraft ?? outcome.reply ?? "");

  assert.equal(result.workflowDecision.workflowType, "browse_options");
  assert.notEqual(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "noop");
  assert.match(reply, /Available options:/i);
  assert.match(reply, /Civic/i);
  assert.match(reply, /Corolla/i);
  assert.doesNotMatch(reply, /Stonic/i);
  assert.equal(outcome.bookingPlanned, false);
  assert.equal(outcome.ownerApprovalPlanned, false);
}

test("golden H: target decisions documented", () => {
  assert.equal(goldenHTargetAvailabilityDecision().workflowType, "availability_inquiry");
  assert.equal(goldenHTargetBrowseDecision().workflowType, "browse_options");
});

for (const variant of scenario.availabilityVariants) {
  test(`golden H availability: ${variant.message}`, () => {
    const result = runPhrasingTurn(variant.message, `golden-h-avail-${variant.expectedItemId}`);
    assertAvailabilityOutcome(result, variant.expectedItemId);
  });
}

for (const message of scenario.browseVariants) {
  test(`golden H browse: ${message}`, () => {
    const result = runPhrasingTurn(message, `golden-h-browse-${message.slice(0, 24)}`);
    assertBrowseOutcome(result);
  });
}

for (const variant of scenario.priorityVariants) {
  test(`golden H priority explicit item wins: ${variant.message}`, () => {
    const result = runPhrasingTurn(variant.message, `golden-h-priority-${variant.expectedItemId}`);
    assertAvailabilityOutcome(result, variant.expectedItemId);
    assert.notEqual(result.workflowDecision.workflowType, "browse_options");
  });
}

test("golden H: Civic options mein hai? no longer routes to noop", () => {
  const result = runPhrasingTurn("Civic options mein hai?", "golden-h-civic-options-noop-fix");
  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "noop");
  assert.equal(result.understanding.resolvedItemId, CIVIC_ID);
});

test("golden H: browse phrasing on fresh session does not pin an explicit item", () => {
  const result = runPhrasingTurn("options kya hain?", "golden-h-browse-no-item");
  assert.equal(result.workflowDecision.workflowType, "browse_options");
  assert.notEqual(result.understanding.itemSource, "explicit");
});

test("golden H: Corolla list mein hai? is availability not browse", () => {
  const result = runPhrasingTurn("Corolla list mein hai?", "golden-h-corolla-list");
  assertAvailabilityOutcome(result, COROLLA_ID);
});
