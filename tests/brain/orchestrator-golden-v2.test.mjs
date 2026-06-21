import test from "node:test";
import assert from "node:assert/strict";

import { runConversationTurn } from "../../src/brain/orchestrator/ConversationOrchestrator.js";
import { isActionPlan, isTurnDecisionTrace } from "../../src/brain/contracts/index.js";
import {
  buildCollectDurationTurnContext,
  buildV2AdmittedTurn,
  loadSyntheticCarRentalCatalogFixture,
  loadGoldenScenario,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateV2GoldenExpectations,
  v2OrchestratorResultToGoldenOutcome,
} from "../../src/brain/golden/goldenExpectations.js";

const fixture = loadSyntheticCarRentalCatalogFixture();
const goldenB = loadGoldenScenario("golden-b.json");
const goldenC = loadGoldenScenario("golden-c.json");

test("orchestrator returns trace + plan without executing actions", () => {
  const turnContext = buildCollectDurationTurnContext({ fixture, scenario: goldenB });
  const finalTurn = goldenB.turns[1];
  const admittedTurn = buildV2AdmittedTurn({
    scenario: goldenB,
    fixture,
    turn: finalTurn,
  });

  const result = runConversationTurn({
    traceId: "orch-smoke-1",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: fixture.items },
  });

  assert.equal(isTurnDecisionTrace(result.trace), true);
  assert.equal(result.workflowDecision.workflowType, "pricing_with_duration");
  assert.ok(result.actionPlan);
  assert.equal(isActionPlan(result.actionPlan), true);

  for (const action of result.actionPlan.actions) {
    assert.equal(action.payload?.execute, false, `${action.type} must stay non-executing`);
  }
});

test("golden B v2 path: pricing_with_duration, no booking, no owner approval", () => {
  const turnContext = buildCollectDurationTurnContext({ fixture, scenario: goldenB });
  const finalTurn = goldenB.turns[1];
  const admittedTurn = buildV2AdmittedTurn({ scenario: goldenB, fixture, turn: finalTurn });

  const result = runConversationTurn({
    traceId: "golden-b-v2",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: fixture.items },
  });

  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, goldenB.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden B v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "pricing_with_duration");

  const types = (outcome.actionPlan?.actions ?? []).map((a) => a.type);
  assert.ok(types.includes("REPLY"));
  assert.ok(!types.includes("CREATE_BOOKING"));
  assert.ok(!types.includes("NOTIFY_OWNER"));
});

test("golden C v2 path: booking_request with planned booking + owner approval", () => {
  const turnContext = buildCollectDurationTurnContext({ fixture, scenario: goldenC });
  const finalTurn = goldenC.turns[1];
  const admittedTurn = buildV2AdmittedTurn({ scenario: goldenC, fixture, turn: finalTurn });

  const result = runConversationTurn({
    traceId: "golden-c-v2",
    admittedTurn,
    turnContext,
    businessContext: { catalogItems: fixture.items },
  });

  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  const evaluation = evaluateV2GoldenExpectations(outcome, goldenC.expectations);

  assert.equal(
    evaluation.ok,
    true,
    `golden C v2 failed: ${evaluation.violations.join("; ")}`
  );
  assert.equal(outcome.workflowType, "booking_request");

  const types = (outcome.actionPlan?.actions ?? []).map((a) => a.type);
  assert.ok(types.includes("CREATE_BOOKING"));
  assert.ok(types.includes("NOTIFY_OWNER"));
  assert.match(String(outcome.reply ?? ""), /note kar liya/i);
  assert.match(String(outcome.reply ?? ""), /civic/i);
});
