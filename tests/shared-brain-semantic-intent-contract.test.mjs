import test from "node:test";
import assert from "node:assert/strict";

const { enrichSharedCustomerTurnDecision } = await import(
  "../src/brain/decisions/decideCustomerTurn.js"
);

test("shared Brain contract preserves Brain-owned semanticIntent", () => {
  const decision = enrichSharedCustomerTurnDecision({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    action: "reply",
    shouldReply: true,
    customerReply: "",
  });

  assert.equal(decision.turnScope, "NEW_TRANSACTION");
  assert.equal(decision.semanticIntent, "availability_inquiry");
});

test("shared Brain contract defaults semanticIntent to null for existing lanes", () => {
  const decision = enrichSharedCustomerTurnDecision({
    turnScope: "SOCIAL_GENERAL",
    action: "reply",
    shouldReply: true,
    customerReply: "Hi",
  });

  assert.equal(decision.semanticIntent, null);
});
