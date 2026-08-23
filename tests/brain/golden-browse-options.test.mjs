/**
 * Golden browse contrast — generic list ask, not item-specific availability.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  goldenBrowseTargetWorkflowDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioSingleTurn } from "./helpers/v2GoldenRunner.mjs";
import { runBrainV2LivePipeline } from "../../src/brain/live/brainV2LivePipeline.js";

const scenario = loadGoldenScenario("golden-browse.json");
const fixture = loadSyntheticCarRentalCatalogFixture();

test("golden browse: v2 target workflow is browse_options", () => {
  assert.equal(goldenBrowseTargetWorkflowDecision().workflowType, "browse_options");
});

test("golden browse: v2 live pipeline lists booking-aware available options", async () => {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = fixture.businessId;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";

  const message = scenario.turns[0].message;
  const result = await runBrainV2LivePipeline({
    traceId: "golden-browse-live",
    businessId: fixture.businessId,
    message,
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    participantKey: fixture.participantKey,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
    __browseComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Honda Civic, Toyota Corolla aur Kia Stonic available hain. Aap kis option ko prefer karenge?",
        mentionedAvailableItemIds: [
          "honda_civic_2026_oriel_white_7e961e31",
          "toyota_corolla_metallic_grey_fixture",
          "kia_stonic_ex_plus_2021_white_fixture",
        ],
        replySemantics: {
          claims: ["resource_availability_confirmed"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }) } }],
    }),
  });

  const outcome = {
    reply: String(result.reply ?? ""),
    workflowType: result.workflowType,
    bookingPlanned: false,
    ownerApprovalPlanned: false,
  };
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden browse v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "browse_options");
  assert.match(String(outcome.reply ?? ""), /Civic/i);
  assert.match(String(outcome.reply ?? ""), /Corolla/i);
  assert.match(String(outcome.reply ?? ""), /Stonic/i);
});

test("golden browse: orchestrator fallback still excludes stale catalog:false without canonical", () => {
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture);
  const facts = result.actionPlan?.actions[0]?.payload?.trustedBrowseFacts;
  assert.equal(result.workflowDecision.workflowType, "browse_options");
  assert.equal(
    facts.availableItems.some((row) => /Stonic/i.test(row.displayLabel)),
    false
  );
});

test("golden browse: Civic availability message is not browse", () => {
  const civicScenario = {
    ...scenario,
    scenarioId: "golden-browse-contrast",
    turns: [{ step: 1, message: "Civic available?", messageId: "golden-browse-contrast-1" }],
  };
  const result = runV2GoldenScenarioSingleTurn(civicScenario, fixture);
  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "browse_options");
});
