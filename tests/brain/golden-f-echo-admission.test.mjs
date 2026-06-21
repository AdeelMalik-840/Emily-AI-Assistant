/**
 * Golden F — assistant/template echo must be rejected at admission (before v2 brain).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

import {
  loadSyntheticCarRentalCatalogFixture,
  goldenFEchoSkipCategories,
  buildFreshTurnContext,
} from "../../src/brain/golden/goldenHarness.js";
import {
  evaluateInboundAdmissionContract,
  classifyAdmissionSkipCategory,
} from "../../src/brain/admission/admissionContract.js";
import { runBrainAdmissionGate } from "../../src/brain/admission/brainAdmissionGate.js";
import { runConversationTurn } from "../../src/brain/orchestrator/ConversationOrchestrator.js";
import {
  registerPlaywrightOutboundChunks,
  __clearPlaywrightOutboundRegistryForTests,
} from "../../src/services/playwrightOutboundRegistry.js";

const fixture = loadSyntheticCarRentalCatalogFixture();
const CHAT = fixture.groupChatKey;

const PRICING_REPLY =
  "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga (5,500 PKR per din).";
const BOOKING_ENGAGEMENT =
  "Perfect 👍 Kia Stonic EX Plus 2021 (White Color) 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?";
const BROWSE_LIST_HEADING = "Hamari list mein ye options hain:";
const STRUCTURED_AVAILABILITY_HEADING =
  "Abhi ye options available hain: Honda Civic 2026 Oriel (White), Toyota corolla (Metallic Grey).";
const AVAILABLE_OPTIONS_HEADING =
  "Available options:\n- Honda Civic 2026 Oriel (White)\n- Toyota corolla (Metallic Grey)";

const ECHO_CASES = [
  {
    label: "browse list heading",
    text: BROWSE_LIST_HEADING,
    expectedReason: "assistant_browse_list_template",
    expectedCategory: "assistant_template_echo",
  },
  {
    label: "structured availability list heading",
    text: STRUCTURED_AVAILABILITY_HEADING,
    expectedReason: "assistant_browse_list_template",
    expectedCategory: "assistant_template_echo",
  },
  {
    label: "available options heading",
    text: AVAILABLE_OPTIONS_HEADING,
    expectedReason: "assistant_copy_template",
    expectedCategory: "assistant_template_echo",
  },
  {
    label: "assistant pricing statement",
    text: PRICING_REPLY,
    expectedReason: "assistant_pricing_statement",
    expectedCategory: "assistant_template_echo",
  },
  {
    label: "assistant availability follow-up template",
    text: "Ji, Honda Civic 2026 Oriel available hai. Kitne time ke liye chahiye?",
    expectedReason: "assistant_copy_template",
    expectedCategory: "assistant_template_echo",
  },
];

function runOrchestratorIfAdmitted(admittedTurn) {
  const result = runConversationTurn({
    traceId: `golden-f-${admittedTurn.turn.turnId}`,
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

test("golden F: target skip categories documented", () => {
  assert.deepEqual(goldenFEchoSkipCategories(), [
    "assistant_template_echo",
    "outbound_echo",
  ]);
});

for (const echoCase of ECHO_CASES) {
  test(`golden F: ${echoCase.label} is skipped at admission`, () => {
    const decision = evaluateInboundAdmissionContract({
      text: echoCase.text,
      chatKey: CHAT,
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
    });

    assert.equal(decision.admitted, false, `expected skip for: ${echoCase.text.slice(0, 80)}`);
    assert.equal(decision.admittedTurn, null);
    assert.equal(decision.skipReason, echoCase.expectedReason);
    assert.equal(decision.skipCategory, echoCase.expectedCategory);
    assert.ok(
      goldenFEchoSkipCategories().includes(decision.skipCategory),
      `unexpected skip category: ${decision.skipCategory}`
    );
  });
}

test("golden F: registered outbound echo is skipped", () => {
  __clearPlaywrightOutboundRegistryForTests();
  const registryOnlyEcho =
    "Golden F registry-only outbound echo marker — not an Emily template shape.";
  registerPlaywrightOutboundChunks(CHAT, registryOnlyEcho, {
    guaranteeKey: `${CHAT}::wa::echo-golden-f`,
    sourceInboundMessageId: "wa::echo-golden-f",
  });

  const decision = evaluateInboundAdmissionContract({
    text: registryOnlyEcho,
    chatKey: CHAT,
  });

  assert.equal(decision.admitted, false);
  assert.equal(decision.skipReason, "outbound_echo_registry");
  assert.equal(decision.skipCategory, "outbound_echo");
  assert.equal(classifyAdmissionSkipCategory("outbound_echo_registry"), "outbound_echo");
});

test("golden F: echo rows do not invoke orchestrator / understanding / workflow", () => {
  const gate = runBrainAdmissionGate(
    { text: BROWSE_LIST_HEADING, chatKey: CHAT },
    runOrchestratorIfAdmitted
  );

  assert.equal(gate.admission.admitted, false);
  assert.equal(gate.pipelineInvoked, false);
  assert.equal(gate.orchestratorCalled, false);
  assert.equal(gate.understandingCalled, false);
  assert.equal(gate.workflowCalled, false);
  assert.equal(gate.result, null);
});

test("golden F false positive: options kya hain? is admitted", () => {
  const decision = evaluateInboundAdmissionContract({
    text: "options kya hain?",
    chatKey: CHAT,
    businessId: fixture.businessId,
    participantKey: fixture.participantKey,
  });

  assert.equal(decision.admitted, true);
  assert.ok(decision.admittedTurn);
  assert.equal(decision.skipReason, null);
});

test("golden F false positive: options kya hain? may reach browse_options when orchestrator runs", () => {
  const gate = runBrainAdmissionGate(
    {
      text: "options kya hain?",
      chatKey: CHAT,
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
      turnId: "golden-f-fp-browse-1",
    },
    runOrchestratorIfAdmitted
  );

  assert.equal(gate.admission.admitted, true);
  assert.equal(gate.orchestratorCalled, true);
  assert.ok(gate.result?.workflowDecision);
  assert.notEqual(gate.result.workflowDecision.workflowType, "booking_request");
});

test("golden F false positive: Civic available? is admitted to availability_inquiry", () => {
  const gate = runBrainAdmissionGate(
    {
      text: "Civic available?",
      chatKey: CHAT,
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
      turnId: "golden-f-fp-civic-avail-1",
    },
    runOrchestratorIfAdmitted
  );

  assert.equal(gate.admission.admitted, true);
  assert.equal(gate.orchestratorCalled, true);
  assert.equal(gate.result.workflowDecision.workflowType, "availability_inquiry");
});

test("golden F false positive: Civic options mein hai? is admitted to availability_inquiry", () => {
  const gate = runBrainAdmissionGate(
    {
      text: "Civic options mein hai?",
      chatKey: CHAT,
      businessId: fixture.businessId,
      participantKey: fixture.participantKey,
      turnId: "golden-f-fp-civic-in-options-1",
    },
    runOrchestratorIfAdmitted
  );

  assert.equal(gate.admission.admitted, true);
  assert.equal(gate.orchestratorCalled, true);
  assert.equal(
    gate.result.understanding.resolvedItemId,
    "honda_civic_2026_oriel_white_7e961e31"
  );
  assert.equal(gate.result.understanding.itemSource, "explicit");
  assert.equal(gate.result.workflowDecision.workflowType, "availability_inquiry");
  assert.notEqual(gate.result.workflowDecision.workflowType, "noop");
});
