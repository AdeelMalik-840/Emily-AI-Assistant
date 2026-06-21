/**
 * Golden C — legacy baseline + v2 orchestrator path.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  goldenCTargetWorkflowDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioFinalTurn } from "./helpers/v2GoldenRunner.mjs";

const scenario = loadGoldenScenario("golden-c.json");
const fixture = loadSyntheticCarRentalCatalogFixture();

test("golden C: v2 target workflow is booking_request", () => {
  assert.equal(goldenCTargetWorkflowDecision().workflowType, "booking_request");
});

test("golden C: v2 orchestrator path passes expectations", () => {
  const result = runV2GoldenScenarioFinalTurn(scenario, fixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden C v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "booking_request");
});
