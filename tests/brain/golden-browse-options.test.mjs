/**
 * Golden browse contrast — generic list ask, not item-specific availability.
 */
import test from "node:test";
import assert from "node:assert/strict";

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

const scenario = loadGoldenScenario("golden-browse.json");
const fixture = loadSyntheticCarRentalCatalogFixture();

test("golden browse: v2 target workflow is browse_options", () => {
  assert.equal(goldenBrowseTargetWorkflowDecision().workflowType, "browse_options");
});

test("golden browse: v2 orchestrator lists available catalog options", () => {
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden browse v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "browse_options");
  assert.match(String(outcome.reply ?? ""), /Available options:/i);
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
