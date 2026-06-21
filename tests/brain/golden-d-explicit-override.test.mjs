/**
 * Golden D — explicit item override beats stale memory (both directions).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
  buildStaleMemoryTurnContext,
  goldenDTargetWorkflowDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import { runV2GoldenScenarioSingleTurn } from "./helpers/v2GoldenRunner.mjs";

const fixture = loadSyntheticCarRentalCatalogFixture();
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";

const corollaScenario = loadGoldenScenario("golden-d-corolla-over-civic.json");
const civicScenario = loadGoldenScenario("golden-d-civic-over-corolla.json");

test("golden D: target workflow is availability_inquiry", () => {
  assert.equal(goldenDTargetWorkflowDecision().workflowType, "availability_inquiry");
});

test("golden D: stale Civic memory + Corolla available → Corolla wins", () => {
  const staleContext = buildStaleMemoryTurnContext(fixture, CIVIC_ID);
  const result = runV2GoldenScenarioSingleTurn(corollaScenario, fixture, staleContext);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, corollaScenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.equal(outcome.resolvedItemId, COROLLA_ID);
  assert.equal(outcome.itemSource, "explicit");
});

test("golden D: stale Corolla memory + Civic available → Civic wins", () => {
  const staleContext = buildStaleMemoryTurnContext(fixture, COROLLA_ID);
  const result = runV2GoldenScenarioSingleTurn(civicScenario, fixture, staleContext);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, civicScenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.equal(outcome.resolvedItemId, CIVIC_ID);
  assert.equal(outcome.itemSource, "explicit");
});
