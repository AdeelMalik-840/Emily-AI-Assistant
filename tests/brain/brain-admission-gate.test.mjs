import test from "node:test";
import assert from "node:assert/strict";

const envBackup = {
  PLAYWRIGHT_INBOUND_TURN_LEDGER: process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER,
  PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION: process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION,
};

process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";

const {
  evaluateAssistantLikeUserText,
} = await import("../../src/services/playwrightListener/listener.js");
const {
  evaluateInboundAdmissionContract,
  classifyAdmissionSkipCategory,
} = await import("../../src/brain/admission/admissionContract.js");
const { runBrainAdmissionGate } = await import(
  "../../src/brain/admission/brainAdmissionGate.js"
);
const {
  evaluateReplayAdmissionContract,
} = await import("../../src/brain/admission/replayAdmissionContract.js");
const {
  __clearInboundTurnLedgerForTests,
  markInboundTurnLedgerDone,
} = await import("../../src/services/inboundTurnLedger.js");
const {
  __clearPlaywrightOutboundRegistryForTests,
  registerPlaywrightOutboundChunks,
} = await import("../../src/services/playwrightOutboundRegistry.js");

const CHAT_KEY = "car rental queries";

test.after(() => {
  if (envBackup.PLAYWRIGHT_INBOUND_TURN_LEDGER === undefined) {
    delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
  } else {
    process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER =
      envBackup.PLAYWRIGHT_INBOUND_TURN_LEDGER;
  }
  if (envBackup.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION === undefined) {
    delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  } else {
    process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION =
      envBackup.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  }
  __clearPlaywrightOutboundRegistryForTests();
  __clearInboundTurnLedgerForTests();
});

test("assistant-like classification still blocks pricing, booking, templates, and outbound echoes", () => {
  const pricing = evaluateAssistantLikeUserText(
    "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga."
  );
  assert.equal(pricing.assistantLike, true);
  assert.equal(pricing.reason, "assistant_pricing_statement");

  const booking = evaluateAssistantLikeUserText(
    "Perfect 👍 Kia Stonic EX Plus 2021 (White Color) 3 days ke liye note kar liya."
  );
  assert.equal(booking.assistantLike, true);
  assert.equal(booking.reason, "assistant_booking_engagement");

  const outboundEchoText =
    "Golden F registry-only outbound echo marker — not an Emily template shape.";
  __clearPlaywrightOutboundRegistryForTests();
  registerPlaywrightOutboundChunks(CHAT_KEY, outboundEchoText, {
    guaranteeKey: `${CHAT_KEY}::wa::echo-admission-test`,
    sourceInboundMessageId: "wa::echo-admission-test",
  });

  const echo = evaluateAssistantLikeUserText(outboundEchoText, CHAT_KEY);
  assert.equal(echo.assistantLike, true);
  assert.equal(echo.reason, "outbound_echo_registry");

  const neutral = evaluateAssistantLikeUserText("Civic available?", CHAT_KEY);
  assert.equal(neutral.assistantLike, false);
  assert.equal(neutral.reason, null);
});

test("browse list templates are skipped at admission", () => {
  const decision = evaluateInboundAdmissionContract({
    text: "Hamari list mein ye options hain:",
    chatKey: CHAT_KEY,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "assistant_browse_list_template");
  assert.equal(decision.skipCategory, "assistant_template_echo");
  assert.equal(classifyAdmissionSkipCategory(decision.skipReason), "assistant_template_echo");
});

test("normal customer text is admitted through the gate", () => {
  const gate = runBrainAdmissionGate({
    text: "Civic available?",
    chatKey: CHAT_KEY,
    businessId: "business-1",
    participantKey: "participant-1",
  });

  assert.equal(gate.admission.admitted, true);
  assert.ok(gate.admission.admittedTurn);
  assert.equal(gate.admission.admittedTurn.turn.text, "Civic available?");
  assert.equal(gate.pipelineInvoked, false);
  assert.equal(gate.orchestratorCalled, false);
  assert.equal(gate.workflowCalled, false);
});

test("startup baseline and done replay rows are blocked without the golden stack", () => {
  __clearInboundTurnLedgerForTests();

  const baseline = evaluateReplayAdmissionContract({
    inbound: { text: "Civic available?", chatKey: CHAT_KEY, isStartupBaseline: true },
  });
  assert.equal(baseline.admitted, false);
  assert.equal(baseline.skipReason, "startup_baseline_visible_row");
  assert.equal(baseline.admissionLayer, "inbound_origin_guard");

  markInboundTurnLedgerDone({
    chatKey: CHAT_KEY,
    stableId: "replay-admission-test-1",
    replySent: true,
    textPreview: "Civic available?",
  });

  const done = evaluateReplayAdmissionContract({
    inbound: { text: "Civic available?", chatKey: CHAT_KEY },
    stableId: "replay-admission-test-1",
  });
  assert.equal(done.admitted, false);
  assert.equal(done.skipReason, "already_answered");
  assert.equal(done.admissionLayer, "inbound_turn_ledger");
});
