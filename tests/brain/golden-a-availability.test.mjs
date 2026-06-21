/**
 * Golden A — Civic availability is item-specific, not browse.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  goldenATargetWorkflowDecision,
  buildStaleMemoryTurnContext,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioSingleTurn } from "./helpers/v2GoldenRunner.mjs";

const scenario = loadGoldenScenario("golden-a.json");
const fixture = loadSyntheticCarRentalCatalogFixture();
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";

test("golden A: v2 target workflow is availability_inquiry", () => {
  assert.equal(goldenATargetWorkflowDecision().workflowType, "availability_inquiry");
});

test("golden A: v2 orchestrator path passes expectations", () => {
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden A v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "availability_inquiry");
  assert.equal(outcome.resolvedItemId, CIVIC_ID);
  assert.equal(outcome.itemSource, "explicit");
});

test("golden A: explicit Civic beats stale Corolla memory", () => {
  const staleContext = buildStaleMemoryTurnContext(fixture, COROLLA_ID);
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture, staleContext);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);

  assert.equal(outcome.resolvedItemId, CIVIC_ID);
  assert.equal(outcome.itemSource, "explicit");
  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.match(String(outcome.reply ?? ""), /civic/i);
});
