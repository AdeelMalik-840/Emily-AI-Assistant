/**
 * Test-only v2 golden runner — no live side effects.
 */
import { runConversationTurn } from "../../../src/brain/orchestrator/ConversationOrchestrator.js";
import {
  buildCollectDurationTurnContext,
  buildFreshTurnContext,
  buildV2AdmittedTurn,
} from "../../../src/brain/golden/goldenHarness.js";

/**
 * Run a single-turn golden scenario through v2 orchestrator on a fresh session.
 *
 * @param {import("../../../src/brain/golden/goldenHarness.js").GoldenScenario} scenario
 * @param {import("../../../src/brain/golden/goldenHarness.js").SyntheticCarRentalCatalogFixture} fixture
 * @param {import("../../../src/brain/contracts/workflow.js").TurnContext} [turnContext]
 */
export function runV2GoldenScenarioSingleTurn(scenario, fixture, turnContext = null) {
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  if (turns.length < 1) {
    throw new Error(`golden scenario ${scenario.scenarioId} needs at least 1 turn`);
  }

  const finalTurn = turns[turns.length - 1];
  const context = turnContext ?? buildFreshTurnContext(fixture);
  const admittedTurn = buildV2AdmittedTurn({ scenario, fixture, turn: finalTurn });

  return runConversationTurn({
    traceId: `${scenario.scenarioId}-v2-${finalTurn.messageId}`,
    admittedTurn,
    turnContext: context,
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: fixture.conversationStyle ?? "casual_local",
    },
  });
}

/**
 * Run the final golden turn (step 2) through v2 orchestrator with simulated post-turn-1 context.
 *
 * @param {import("../../../src/brain/golden/goldenHarness.js").GoldenScenario} scenario
 * @param {import("../../../src/brain/golden/goldenHarness.js").SyntheticCarRentalCatalogFixture} fixture
 */
export function runV2GoldenScenarioFinalTurn(scenario, fixture) {
  const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
  if (turns.length < 2) {
    throw new Error(`golden scenario ${scenario.scenarioId} needs at least 2 turns for v2 harness`);
  }

  const finalTurn = turns[turns.length - 1];
  const turnContext = buildCollectDurationTurnContext({ fixture, scenario });
  const admittedTurn = buildV2AdmittedTurn({ scenario, fixture, turn: finalTurn });

  return runConversationTurn({
    traceId: `${scenario.scenarioId}-v2-${finalTurn.messageId}`,
    admittedTurn,
    turnContext,
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: fixture.conversationStyle ?? "casual_local",
    },
  });
}
