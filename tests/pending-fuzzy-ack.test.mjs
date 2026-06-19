import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { normalizeFuzzyTurn, resolveFuzzyCatalogOutbound } from "../src/services/fuzzyTurnNormalizer.js";
import {
  __buildPendingActionForTests,
  __buildPureAckNoOpReplyForTests,
  __isPureAckMessageForTests,
  __mapFuzzyPendingInferredIntentForTests,
  __pendingActionReplyIntentForTests,
  __validateConfirmFuzzyCatalogPayloadForTests,
  __validatePendingActionBindingForTests,
} from "../src/services/messageProcessor.js";
import { decideResponseStrategy, applyResponseStrategy } from "../src/services/responseStrategy.js";

const catalog = [
  {
    id: "corolla-1",
    name: "Toyota Corolla 2024",
    pricing: { daily: "5000 PKR" },
  },
  { id: "civic-1", name: "Honda Civic", pricing: { daily: "8000 PKR" } },
];

function baseFuzzyPending(overrides = {}) {
  return __buildPendingActionForTests({
    type: "confirm_fuzzy_catalog",
    expectedReplyType: "affirmation",
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    itemId: "corolla-1",
    itemDisplayLabel: "Toyota Corolla 2024",
    payload: {
      itemId: "corolla-1",
      itemDisplayLabel: "Toyota Corolla 2024",
      inferredIntent: "availability_check",
      requestedField: "availability",
    },
    nowMs: Date.parse("2026-05-12T15:00:00.000Z"),
    ...overrides,
  });
}

test("fuzzy confirmation maps to confirm_fuzzy_catalog pending payload", () => {
  const f = normalizeFuzzyTurn({ rawText: "lola avlbl?", catalogItems: catalog });
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.source, "FUZZY_CATALOG_CONFIRMATION");
  assert.equal(__mapFuzzyPendingInferredIntentForTests(f), "availability_check");

  const pending = baseFuzzyPending({
    payload: {
      itemId: "corolla-1",
      itemDisplayLabel: "Toyota Corolla 2024",
      inferredIntent: __mapFuzzyPendingInferredIntentForTests(f),
      requestedField: f.requestedFieldCandidate,
    },
  });
  assert.equal(__validateConfirmFuzzyCatalogPayloadForTests(pending).ok, true);
});

test("rola rent fuzzy maps pricing_question pending intent", () => {
  const f = normalizeFuzzyTurn({ rawText: "rola rent?", catalogItems: catalog });
  assert.equal(__mapFuzzyPendingInferredIntentForTests(f), "pricing_question");
});

test("5. fuzzy confirmation rejection clears via binding", () => {
  const pending = baseFuzzyPending();
  const replyIntent = __pendingActionReplyIntentForTests("nahi", pending);
  const validation = __validatePendingActionBindingForTests({
    pendingAction: pending,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });
  assert.equal(replyIntent.type, "rejection");
  assert.equal(validation.clear, true);
});

test("6. expired confirm_fuzzy_catalog pending is not executable", () => {
  const pending = baseFuzzyPending();
  const replyIntent = __pendingActionReplyIntentForTests("yes", pending);
  const validation = __validatePendingActionBindingForTests({
    pendingAction: pending,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:10:01.000Z"),
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "PENDING_ACTION_EXPIRED");
  assert.equal(validation.clear, true);
});

test("7. different participant cannot bind confirm_fuzzy_catalog", () => {
  const pending = baseFuzzyPending();
  const replyIntent = __pendingActionReplyIntentForTests("yes", pending);
  const validation = __validatePendingActionBindingForTests({
    pendingAction: pending,
    replyIntent,
    participantKey: "participant-b",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "PARTICIPANT_MISMATCH");
});

test("8. explicit new item clears confirm_fuzzy_catalog pending", () => {
  const pending = baseFuzzyPending();
  const replyIntent = __pendingActionReplyIntentForTests("Civic available?", pending);
  const validation = __validatePendingActionBindingForTests({
    pendingAction: pending,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });
  assert.equal(replyIntent.type, "new_request");
  assert.equal(validation.reason, "EXPLICIT_NEW_INTENT");
  assert.equal(validation.clear, true);
});

test("pure ack detector matches ok yes haan ji theek", () => {
  assert.equal(__isPureAckMessageForTests("ok"), true);
  assert.equal(__isPureAckMessageForTests("yes"), true);
  assert.equal(__isPureAckMessageForTests("haan"), true);
  assert.equal(__isPureAckMessageForTests("jiii"), true);
  assert.equal(__isPureAckMessageForTests("jee"), true);
  assert.equal(__isPureAckMessageForTests("g"), true);
  assert.equal(__isPureAckMessageForTests("👍"), true);
  assert.equal(__isPureAckMessageForTests("Civic available?"), false);
});

test("pure ack noop reply is short and not kis cheez clarify", () => {
  const reply = __buildPureAckNoOpReplyForTests("casual_local");
  assert.match(reply, /Theek hai/i);
  assert.doesNotMatch(reply, /Kis cheez ka confirm/i);
});

test("casual ok after terminal unavailable should use noop not responseStrategy clarify", () => {
  const decision = decideResponseStrategy({
    userMessage: "ok",
    lastAssistantMessage:
      "Sorry, Honda Civic abhi available nahi hai. Filhaal koi aur option bhi available nahi hai.",
    routeType: "CASUAL_REPLY",
  });
  assert.equal(decision.strategy, "ask_clarification");
  const noop = __buildPureAckNoOpReplyForTests("casual_local");
  assert.doesNotMatch(noop, /Kis cheez ka confirm/i);
  assert.notEqual(
    noop,
    applyResponseStrategy({
      reply: "draft",
      strategyDecision: decision,
      userMessage: "ok",
    }).reply
  );
});
