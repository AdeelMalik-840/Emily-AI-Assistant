/**
 * Golden I — burst / rapid sequencing must not leak stale item or browse-merge wrongly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

import {
  loadSyntheticCarRentalCatalogFixture,
  buildCollectDurationTurnContext,
  goldenITargetAvailabilityDecision,
  goldenITargetPricingDecision,
  goldenITargetBookingDecision,
} from "../../src/brain/golden/goldenHarness.js";
import {
  runV2SequencedTurns,
  runV2SingleTurn,
  applyCollectDurationOutcomeToTurnContext,
  evaluateMergedBurstBrainTurn,
  evaluateAdjacentBurstMergeAllowed,
} from "../../src/brain/golden/sequenceHarness.js";
import { v2OrchestratorResultToGoldenOutcome } from "../../src/brain/golden/goldenExpectations.js";
import { splitBurstMergeRuns } from "../../src/services/playwrightListener/listener.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = loadSyntheticCarRentalCatalogFixture();
const scenario = JSON.parse(
  readFileSync(join(__dirname, "fixtures/scenarios/golden-i-burst.json"), "utf8")
);

const CIVIC_ID = scenario.itemIds.civic;
const COROLLA_ID = scenario.itemIds.corolla;
const COROLLA_3DAY_TOTAL = scenario.corollaThreeDayTotal;

function mkBurstRow(text, position, dataId) {
  return {
    sender: "user",
    participantKey: fixture.participantKey,
    text,
    __position: position,
    __rowKey: `real:${dataId}#1`,
    id: { _serialized: dataId },
    sourceMessageIndex: position,
  };
}

/**
 * @param {import("../../src/brain/orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} result
 * @param {string} expectedItemId
 */
function assertAvailabilityStep(result, expectedItemId) {
  const outcome = v2OrchestratorResultToGoldenOutcome(result);

  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "browse_options");
  assert.notEqual(result.workflowDecision.workflowType, "noop");
  assert.equal(result.understanding.resolvedItemId, expectedItemId);
  assert.equal(result.understanding.itemSource, "explicit");
  assert.ok(result.actionPlan?.replyDraft, "expected item-specific availability reply");
  assert.equal(outcome.bookingPlanned, false);
  assert.equal(outcome.ownerApprovalPlanned, false);
}

test("golden I: target decisions documented", () => {
  assert.equal(goldenITargetAvailabilityDecision().workflowType, "availability_inquiry");
  assert.equal(goldenITargetPricingDecision().workflowType, "pricing_with_duration");
  assert.equal(goldenITargetBookingDecision().workflowType, "booking_request");
});

test("golden I: rapid Civic → Corolla availability turns stay item-specific", () => {
  const { steps } = runV2SequencedTurns(fixture, scenario.rapidAvailabilityForward, {
    scenarioId: "golden-i-forward",
    afterAvailability: "remember_item",
  });

  assert.equal(steps.length, 2);
  assertAvailabilityStep(steps[0].result, CIVIC_ID);
  assertAvailabilityStep(steps[1].result, COROLLA_ID);

  assert.notEqual(
    String(steps[0].result.actionPlan?.replyDraft ?? ""),
    String(steps[1].result.actionPlan?.replyDraft ?? "")
  );
  assert.match(String(steps[1].result.actionPlan?.replyDraft ?? ""), /corolla/i);
  assert.doesNotMatch(String(steps[1].result.actionPlan?.replyDraft ?? ""), /\bcivic\b.*\bcorolla\b/i);
});

test("golden I: reverse Corolla → Civic keeps explicit current item authority", () => {
  const { steps } = runV2SequencedTurns(fixture, scenario.rapidAvailabilityReverse, {
    scenarioId: "golden-i-reverse",
    afterAvailability: "remember_item",
  });

  assertAvailabilityStep(steps[0].result, COROLLA_ID);
  assertAvailabilityStep(steps[1].result, CIVIC_ID);
  assert.match(String(steps[1].result.actionPlan?.replyDraft ?? ""), /civic/i);
});

test("golden I: burst policy keeps Civic and Corolla availability rows separate", () => {
  const civicRow = mkBurstRow("Civic available?", 0, "false_gi_civic@c.us");
  const corollaRow = mkBurstRow("Corolla available?", 1, "false_gi_corolla@c.us");
  const sorted = [civicRow, corollaRow];

  assert.equal(
    evaluateAdjacentBurstMergeAllowed(civicRow, corollaRow, fixture.items),
    false
  );

  const runs = splitBurstMergeRuns(
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    fixture.groupChatKey,
    fixture.items
  );
  assert.equal(runs.length, 2);
  assert.match(runs[0][0].text, /Civic/i);
  assert.match(runs[1][0].text, /Corolla/i);
});

test("golden I: merged candidate uses latest explicit catalog item (Corolla)", () => {
  const { authority, result, trace } = evaluateMergedBurstBrainTurn(
    fixture,
    scenario.mergedAvailabilityCandidate
  );

  assert.equal(authority.authoritativeItemForTurn?.id, COROLLA_ID);
  assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowDecision.workflowType, "browse_options");
  assert.notEqual(result.workflowDecision.workflowType, "noop");
  assert.equal(result.understanding.resolvedItemId, COROLLA_ID);
  assert.equal(result.understanding.itemSource, "explicit");
  assert.equal(trace.authoritativeItemId, COROLLA_ID);
  assert.equal(trace.burstPolicy, "latest_explicit_catalog_item_in_merged_text");

  const outcome = v2OrchestratorResultToGoldenOutcome(result);
  assert.equal(outcome.bookingPlanned, false);
  assert.equal(outcome.ownerApprovalPlanned, false);
});

test("golden I: pricing after rapid item switch uses Corolla totals", () => {
  const { steps, finalTurnContext } = runV2SequencedTurns(
    fixture,
    scenario.pricingAfterSwitchSequence.slice(0, 2),
    {
      scenarioId: "golden-i-pricing-switch",
      afterAvailability: "remember_item",
    }
  );

  assertAvailabilityStep(steps[0].result, CIVIC_ID);
  assertAvailabilityStep(steps[1].result, COROLLA_ID);

  const lastAvailability = steps[1].result;
  const collectContext = applyCollectDurationOutcomeToTurnContext(
    fixture,
    finalTurnContext,
    steps[1].message,
    lastAvailability
  );

  const pricingResult = runV2SingleTurn(
    fixture,
    scenario.pricingAfterSwitchSequence[2],
    collectContext,
    "golden-i-pricing-switch",
    "golden-i-pricing-switch-step-3"
  );
  const outcome = v2OrchestratorResultToGoldenOutcome(pricingResult);
  const reply = String(pricingResult.actionPlan?.replyDraft ?? outcome.reply ?? "");

  assert.equal(pricingResult.workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(pricingResult.understanding.resolvedItemId, COROLLA_ID);
  assert.notEqual(pricingResult.understanding.resolvedItemId, CIVIC_ID);
  assert.match(reply, /15[,.]?000|15000/);
  assert.doesNotMatch(reply, /24[,.]?000|24000/);
  assert.equal(outcome.bookingPlanned, false);
  assert.equal(outcome.ownerApprovalPlanned, false);
});

test("golden I: duration-only booking after rapid item switch targets Corolla", () => {
  const { steps, finalTurnContext } = runV2SequencedTurns(
    fixture,
    scenario.bookingAfterSwitchSequence.slice(0, 2),
    {
      scenarioId: "golden-i-booking-switch",
      afterAvailability: "remember_item",
    }
  );

  assertAvailabilityStep(steps[1].result, COROLLA_ID);

  const collectContext = applyCollectDurationOutcomeToTurnContext(
    fixture,
    finalTurnContext,
    steps[1].message,
    steps[1].result
  );

  const bookingResult = runV2SingleTurn(
    fixture,
    scenario.bookingAfterSwitchSequence[2],
    collectContext,
    "golden-i-booking-switch",
    "golden-i-booking-switch-step-3"
  );
  const outcome = v2OrchestratorResultToGoldenOutcome(bookingResult);
  const actions = bookingResult.actionPlan?.actions ?? [];

  assert.equal(bookingResult.workflowDecision.workflowType, "booking_request");
  assert.equal(bookingResult.understanding.resolvedItemId, COROLLA_ID);
  assert.notEqual(bookingResult.understanding.resolvedItemId, CIVIC_ID);

  assert.equal(outcome.bookingPlanned, true);
  assert.equal(outcome.ownerApprovalPlanned, true);

  const bookingAction = actions.find((a) => a?.type === "CREATE_BOOKING");
  const ownerAction = actions.find((a) => a?.type === "NOTIFY_OWNER");
  assert.equal(bookingAction?.payload?.itemId, COROLLA_ID);
  assert.equal(ownerAction?.payload?.itemId, COROLLA_ID);
  assert.notEqual(bookingAction?.payload?.itemId, CIVIC_ID);
  assert.equal(bookingAction?.payload?.execute, false);
  assert.equal(ownerAction?.payload?.execute, false);
  assert.match(String(bookingResult.actionPlan?.replyDraft ?? ""), /corolla/i);
});

test("golden I: collect_duration context builder respects explicit switched item", () => {
  const context = buildCollectDurationTurnContext({
    fixture,
    firstUserMessage: "Corolla available?",
    itemId: COROLLA_ID,
  });

  const pricingResult = runV2SingleTurn(
    fixture,
    "3 din k lye rent kitna hai?",
    context,
    "golden-i-context-builder",
    "golden-i-context-builder-pricing"
  );

  assert.equal(pricingResult.workflowDecision.workflowType, "pricing_with_duration");
  assert.equal(pricingResult.understanding.resolvedItemId, COROLLA_ID);
});
