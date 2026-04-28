import test from "node:test";
import assert from "node:assert/strict";

import {
  applyResponseStrategy,
  decideResponseStrategy,
  enforceToneStyle,
  selectVariation,
} from "../src/services/responseStrategy.js";

test("informational question uses answer only", () => {
  const decision = decideResponseStrategy({
    userMessage: "color kya hai?",
    routeType: "INFORMATIONAL_QUESTION",
    answerKnown: true,
  });
  assert.equal(decision.strategy, "answer_only");

  const out = applyResponseStrategy({
    reply: "White hai 👍",
    strategyDecision: decision,
  });
  assert.equal(out.reply, "White hai 👍");
  assert.equal(out.events.some((event) => event.type === "no_followup_decision"), true);
});

test("informational question with proceed intent adds one duration follow-up", () => {
  const decision = decideResponseStrategy({
    userMessage: "white chahiye",
    routeType: "INFORMATIONAL_QUESTION",
    answerKnown: true,
  });
  assert.equal(decision.strategy, "answer_then_guide");

  const out = applyResponseStrategy({
    reply: "White hai 👍",
    strategyDecision: decision,
    variationIndex: 0,
  });
  assert.equal(out.reply, "White hai 👍\nKitne din ke liye chahiye?");
  assert.equal(out.events.some((event) => event.type === "followup_added"), true);
});

test("repeated duration follow-up is blocked", () => {
  const decision = {
    strategy: "answer_then_guide",
    reason: "test",
  };
  const out = applyResponseStrategy({
    reply: "White hai 👍",
    strategyDecision: decision,
    lastAssistantMessage: "Kitne din ke liye chahiye?",
    variationIndex: 0,
  });
  assert.equal(out.reply, "White hai 👍");
  assert.equal(
    out.events.some((event) => event.type === "followup_blocked_due_to_repetition"),
    true
  );
});

test("casual ok after duration asks contextual clarification", () => {
  const decision = decideResponseStrategy({
    userMessage: "ok",
    lastAssistantMessage: "Kitne din ke liye chahiye?",
    routeType: "CASUAL_REPLY",
  });
  assert.equal(decision.strategy, "ask_clarification");

  const out = applyResponseStrategy({
    reply: "Ji",
    strategyDecision: decision,
    lastAssistantMessage: "Kitne din ke liye chahiye?",
    variationIndex: 0,
  });
  assert.equal(out.reply, "Kitne din ke liye chahiye?");
});

test("variation selection can be deterministic and different", () => {
  const first = selectVariation("unknown_fallback", { index: 0 }).text;
  const second = selectVariation("unknown_fallback", { index: 1 }).text;
  assert.notEqual(first, second);
});

test("tone consistency normalizes karwa deta hun style", () => {
  const out = enforceToneStyle("Iska exact confirm karwa deta hun 👍");
  assert.equal(out, "Iska exact confirm kar deta hun 👍");
});

test("non conversational route keeps booking flow unaffected", () => {
  const decision = decideResponseStrategy({
    userMessage: "2 din",
    routeType: "BOOKING_INTENT",
    answerKnown: false,
  });
  assert.equal(decision.strategy, "no_followup");
});
