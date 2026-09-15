/**
 * Golden E — unlisted item availability question.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  buildStaleMemoryTurnContext,
  goldenETargetWorkflowDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioSingleTurn } from "./helpers/v2GoldenRunner.mjs";

const scenario = loadGoldenScenario("golden-e.json");
const fixture = loadSyntheticCarRentalCatalogFixture();
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";

test("golden E: target workflow is unlisted_item", () => {
  assert.equal(goldenETargetWorkflowDecision().workflowType, "unlisted_item");
});

test("golden E: Revo available hai → unlisted_item, no catalog resolve", () => {
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.equal(outcome.workflowType, "unlisted_item");
  assert.equal(outcome.resolvedItemId, undefined);
  assert.match(String(outcome.reply ?? ""), /available nahi hai|hamari list mein nahi hai|not listed/i);
  assert.match(String(outcome.reply ?? ""), /revo/i);

  const types = (outcome.actionPlan?.actions ?? []).map((a) => a.type);
  assert.ok(!types.includes("CREATE_BOOKING"));
  assert.ok(!types.includes("NOTIFY_OWNER"));
});

test("golden E: stale Civic memory does not leak into unlisted Revo reply", () => {
  const staleContext = buildStaleMemoryTurnContext(fixture, CIVIC_ID);
  const result = runV2GoldenScenarioSingleTurn(scenario, fixture, staleContext);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);

  assert.equal(outcome.workflowType, "unlisted_item");
  assert.equal(outcome.resolvedItemId, undefined);
  assert.doesNotMatch(String(outcome.reply ?? ""), /civic/i);
});
