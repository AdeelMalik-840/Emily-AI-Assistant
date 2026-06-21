/**
 * Golden G — restart / replay rows must not reach v2 brain; fresh post-baseline rows may.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";

import {
  loadSyntheticCarRentalCatalogFixture,
  goldenGReplaySkipReasonPrefixes,
  buildFreshTurnContext,
} from "../../src/brain/golden/goldenHarness.js";
import { evaluateInboundAdmissionContract } from "../../src/brain/admission/admissionContract.js";
import {
  evaluateReplayAdmissionContract,
  evaluateGuaranteeFirstRowAdmission,
} from "../../src/brain/admission/replayAdmissionContract.js";
import {
  runBrainAdmissionGate,
  runReplayAdmissionGate,
} from "../../src/brain/admission/brainAdmissionGate.js";
import { runConversationTurn } from "../../src/brain/orchestrator/ConversationOrchestrator.js";
import {
  buildStableMessageKey,
  buildExtractedMessageId,
} from "../../src/services/playwrightListener/listener.js";
import {
  markInboundTurnLedgerDone,
  markInboundTurnLedgerBaselineAbsorbed,
  __clearInboundTurnLedgerForTests,
} from "../../src/services/inboundTurnLedger.js";

const fixture = loadSyntheticCarRentalCatalogFixture();
const CHAT = fixture.groupChatKey;

function mkRow({ text, dataId, position }) {
  return {
    sender: "user",
    participantKey: fixture.participantKey,
    text,
    prePlainText: "[11:23 AM] Customer Alpha: ",
    id: dataId ? { _serialized: dataId } : undefined,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
    sourceMessageIndex: position,
  };
}

function runOrchestratorIfAdmitted(admittedTurn) {
  const result = runConversationTurn({
    traceId: `golden-g-${admittedTurn.turn.turnId}`,
    admittedTurn,
    turnContext: buildFreshTurnContext(fixture),
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: fixture.conversationStyle ?? "casual_local",
    },
  });
  return {
    orchestratorCalled: true,
    understandingCalled: true,
    workflowCalled: true,
    result,
  };
}

function assertSkippedWithoutPipeline(admissionInput, label) {
  const gate = runBrainAdmissionGate(admissionInput, runOrchestratorIfAdmitted);
  assert.equal(gate.admission.admitted, false, `${label}: should not admit`);
  assert.equal(gate.orchestratorCalled, false, `${label}: orchestrator must not run`);
  assert.equal(gate.understandingCalled, false, `${label}: understanding must not run`);
  assert.equal(gate.workflowCalled, false, `${label}: workflow must not run`);
  return gate.admission;
}

test.after(() => {
  __clearInboundTurnLedgerForTests();
});

test("golden G: replay skip reason prefixes documented", () => {
  const prefixes = goldenGReplaySkipReasonPrefixes();
  assert.ok(prefixes.includes("startup_baseline"));
  assert.ok(prefixes.includes("ledger_done"));
  assert.ok(prefixes.includes("baseline_seen"));
});

test("golden G: startup baseline visible row is skipped", () => {
  const decision = evaluateInboundAdmissionContract({
    text: "Civic available?",
    chatKey: CHAT,
    isStartupBaseline: true,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "startup_baseline_visible_row");
  assertSkippedWithoutPipeline(
    { text: "Civic available?", chatKey: CHAT, isStartupBaseline: true },
    "startup baseline"
  );
});

test("golden G: ledger done row is skipped", () => {
  __clearInboundTurnLedgerForTests();
  const row = mkRow({
    text: "stonic available?",
    dataId: "false_done@c.us_G1",
    position: 6,
  });
  const extracted = [row];
  const stableId = buildStableMessageKey(row, extracted).id;

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
    replySent: true,
  });

  const decision = evaluateReplayAdmissionContract({
    inbound: { text: row.text, chatKey: CHAT },
    stableId,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "already_answered");
  assert.equal(decision.admissionLayer, "inbound_turn_ledger");

  const gate = runReplayAdmissionGate(
    { inbound: { text: row.text, chatKey: CHAT }, stableId },
    runOrchestratorIfAdmitted
  );
  assert.equal(gate.orchestratorCalled, false);
});

test("golden G: baseline_absorbed ledger row is skipped", () => {
  __clearInboundTurnLedgerForTests();
  const row = mkRow({
    text: "Corolla available?",
    dataId: "false_absorbed@c.us_G2",
    position: 4,
  });
  const extracted = [row];
  const stableId = buildStableMessageKey(row, extracted).id;

  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });

  const decision = evaluateReplayAdmissionContract({
    inbound: { text: row.text, chatKey: CHAT },
    stableId,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "baseline_absorbed");
});

test("golden G: baseline_seen stable id is skipped via guarantee-first filter", () => {
  const row = mkRow({
    text: "stonic available?",
    dataId: "false_baseline@c.us_G3",
    position: 8,
  });
  const extracted = [row];
  const stableId = buildStableMessageKey(row, extracted).id;
  const freshState = {
    baselineSeenStableIds: new Set([stableId]),
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
  };

  const decision = evaluateGuaranteeFirstRowAdmission({
    row,
    chatKey: CHAT,
    freshState,
    extractedList: extracted,
    acknowledgedAnchorIndex: 7,
    resolvedAnchorIndex: 7,
  });

  assert.equal(decision.admitted, false);
  assert.match(String(decision.skipReason), /baseline_seen|guarantee_first/);

  const gate = runReplayAdmissionGate(
    {
      inbound: { text: row.text, chatKey: CHAT },
      stableId,
      baselineSeenStableIds: freshState.baselineSeenStableIds,
    },
    runOrchestratorIfAdmitted
  );
  assert.equal(gate.orchestratorCalled, false);
});

test("golden G: inbound cursor already processed row is skipped", () => {
  const oldRow = mkRow({
    text: "Civic available?",
    dataId: "false_cursor_old@c.us_G4",
    position: 5,
  });
  const freshRow = mkRow({
    text: "3 din k lye",
    dataId: "false_cursor_new@c.us_G5",
    position: 9,
  });
  const participantMessages = [oldRow, freshRow];
  const extracted = participantMessages;
  const oldStableId = buildExtractedMessageId(oldRow, extracted).id;

  const decision = evaluateReplayAdmissionContract({
    inbound: { text: oldRow.text, chatKey: CHAT },
    row: oldRow,
    participantMessages,
    extractedList: extracted,
    persistedCursor: {
      lastProcessedInboundId: oldStableId,
      lastProcessedSourceMessageIndex: 5,
    },
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "inbound_cursor_already_processed");
  assert.equal(decision.admissionLayer, "inbound_cursor");
});

test("golden G: fresh post-baseline customer row is admitted", () => {
  const oldRow = mkRow({
    text: "stonic available?",
    dataId: "false_old@c.us_G6",
    position: 5,
  });
  const freshRow = mkRow({
    text: "3 din k lye",
    dataId: "false_new@c.us_G7",
    position: 9,
  });
  const extracted = [oldRow, freshRow];
  const oldStableId = buildStableMessageKey(oldRow, extracted).id;
  const freshState = {
    baselineSeenStableIds: new Set([oldStableId]),
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
  };

  const decision = evaluateGuaranteeFirstRowAdmission({
    row: freshRow,
    chatKey: CHAT,
    freshState,
    extractedList: extracted,
    acknowledgedAnchorIndex: 8,
    resolvedAnchorIndex: 8,
    inbound: {
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
    },
  });

  assert.equal(decision.admitted, true);
  assert.ok(decision.admittedTurn);

  const gate = runBrainAdmissionGate(
    {
      text: freshRow.text,
      chatKey: CHAT,
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
      turnId: "golden-g-fresh-1",
    },
    runOrchestratorIfAdmitted
  );
  assert.equal(gate.orchestratorCalled, true);
  assert.ok(gate.result?.workflowDecision);
});

test("golden G: skipped replay rows never invoke orchestrator", () => {
  const skippedCases = [
    {
      label: "startup baseline",
      run: () =>
        runReplayAdmissionGate(
          {
            inbound: {
              text: "Civic available?",
              chatKey: CHAT,
              isStartupBaseline: true,
            },
          },
          runOrchestratorIfAdmitted
        ),
    },
    {
      label: "ledger done",
      run: () => {
        __clearInboundTurnLedgerForTests();
        const row = mkRow({
          text: "done row",
          dataId: "false_done2@c.us_G8",
          position: 3,
        });
        const stableId = buildStableMessageKey(row, [row]).id;
        markInboundTurnLedgerDone({ chatKey: CHAT, stableId, replySent: true });
        return runReplayAdmissionGate(
          { inbound: { text: row.text, chatKey: CHAT }, stableId },
          runOrchestratorIfAdmitted
        );
      },
    },
  ];

  for (const skipped of skippedCases) {
    const gate = skipped.run();
    assert.equal(gate.orchestratorCalled, false, skipped.label);
    assert.equal(gate.understandingCalled, false, skipped.label);
    assert.equal(gate.workflowCalled, false, skipped.label);
  }
});
