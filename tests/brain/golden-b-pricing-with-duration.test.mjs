/**
 * Golden B — legacy baseline + v2 orchestrator path.
 * Live production fails golden B (booking ack instead of price).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  goldenBTargetWorkflowDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioFinalTurn } from "./helpers/v2GoldenRunner.mjs";

const scenario = loadGoldenScenario("golden-b.json");
const fixture = loadSyntheticCarRentalCatalogFixture();

test("golden B: v2 target workflow is pricing_with_duration", () => {
  assert.equal(goldenBTargetWorkflowDecision().workflowType, "pricing_with_duration");
});

test("golden B: v2 orchestrator path passes expectations", () => {
  const result = runV2GoldenScenarioFinalTurn(scenario, fixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden B v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "pricing_with_duration");
});
