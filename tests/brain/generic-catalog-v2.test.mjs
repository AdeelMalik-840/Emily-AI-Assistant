/**
 * Generic catalog-driven v2 proofs — not Civic/Synthetic Car Rental-specific.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSyntheticCarRentalCatalogFixture,
  loadSyntheticHotelCatalogFixture,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";
import {
  runV2GoldenScenarioFinalTurn,
  runV2GoldenScenarioSingleTurn,
} from "./helpers/v2GoldenRunner.mjs";

const carFixture = loadSyntheticCarRentalCatalogFixture();
const hotelFixture = loadSyntheticHotelCatalogFixture();
const COROLLA_ID = "toyota_corolla_metallic_grey_fixture";

test("generic A: Corolla available → availability_inquiry, Corolla-specific", () => {
  const scenario = {
    schemaVersion: 1,
    scenarioId: "generic-corolla-availability",
    channelId: "whatsapp_web",
    turns: [{ step: 1, message: "Corolla available?", messageId: "generic-corolla-a-1" }],
    expectations: {
      finalWorkflowType: "availability_inquiry",
      mustResolveItemId: COROLLA_ID,
      mustResolveItemLabelContains: "Corolla",
      mustResolveItemSource: "explicit",
      mustMentionResolvedItemInReply: true,
      mustNotMentionItemLabels: ["Civic"],
      mustNotBrowse: true,
      mustNotCreateBooking: true,
      mustNotNotifyOwner: true,
    },
  };

  const result = runV2GoldenScenarioSingleTurn(scenario, carFixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.equal(outcome.workflowType, "availability_inquiry");
  assert.match(String(outcome.reply ?? ""), /corolla/i);
  assert.doesNotMatch(String(outcome.reply ?? ""), /civic/i);
});

test("generic B: Corolla pricing with duration from catalog pricing", () => {
  const scenario = {
    schemaVersion: 1,
    scenarioId: "generic-corolla-pricing",
    channelId: "whatsapp_web",
    turns: [
      { step: 1, message: "Corolla available?", messageId: "generic-corolla-b-1" },
      { step: 2, message: "3 din k lye rent kitna hai?", messageId: "generic-corolla-b-2" },
    ],
    expectations: {
      finalWorkflowType: "pricing_with_duration",
      mustResolveItemId: COROLLA_ID,
      expectedPriceTotal: 15000,
      mustNotCreateBooking: true,
      mustNotNotifyOwner: true,
    },
  };

  const result = runV2GoldenScenarioFinalTurn(scenario, carFixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.equal(outcome.workflowType, "pricing_with_duration");
});

test("generic C: synthetic hotel Deluxe Room availability", () => {
  const scenario = {
    schemaVersion: 1,
    scenarioId: "generic-hotel-availability",
    channelId: "whatsapp_web",
    turns: [{ step: 1, message: "Deluxe Room available?", messageId: "generic-hotel-a-1" }],
    expectations: {
      finalWorkflowType: "availability_inquiry",
      mustResolveItemId: "deluxe_room_fixture_001",
      mustResolveItemLabelContains: "Deluxe Room",
      mustResolveItemSource: "explicit",
      mustMentionResolvedItemInReply: true,
      mustNotMentionItemLabels: ["Civic", "Corolla", "Toyota", "Honda"],
      mustNotBrowse: true,
      mustNotCreateBooking: true,
      mustNotNotifyOwner: true,
    },
  };

  const result = runV2GoldenScenarioSingleTurn(scenario, hotelFixture);
  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, scenario.expectations);

  assert.equal(evaluation.ok, true, evaluation.violations.join("; "));
  assert.match(String(outcome.reply ?? ""), /deluxe room/i);
});
