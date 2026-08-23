import test from "node:test";
import assert from "node:assert/strict";

const {
  CUSTOMER_SEMANTIC_INTENTS,
  cleanCustomerSemanticIntent,
  enrichSharedCustomerTurnDecision,
} = await import("../src/brain/decisions/decideCustomerTurn.js");
const { projectSemanticIntentFromBrainDecision } = await import(
  "../src/brain/decisions/projectSemanticIntentFromBrainDecision.js"
);

test("shared Brain contract preserves explicit Brain-owned semanticIntent", () => {
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

test("shared Brain contract projects already-decided social meaning without customer-text parsing", () => {
  const decision = enrichSharedCustomerTurnDecision({
    turnScope: "SOCIAL_GENERAL",
    action: "reply",
    shouldReply: true,
    customerReply: "Hi",
  });

  assert.equal(decision.semanticIntent, "social");
});

test("shared Brain contract rejects unknown semantic intent instead of routing it", () => {
  assert.ok(CUSTOMER_SEMANTIC_INTENTS.includes("availability_inquiry"));
  assert.equal(cleanCustomerSemanticIntent(" availability_inquiry "), "availability_inquiry");
  assert.equal(cleanCustomerSemanticIntent("regex_guessed_price"), null);

  const decision = enrichSharedCustomerTurnDecision({
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "regex_guessed_price",
    action: "reply",
    shouldReply: true,
    customerReply: "",
  });

  assert.equal(decision.semanticIntent, null);
});

test("semantic projection exposes availability only when Brain already declared availability capability", () => {
  assert.equal(
    projectSemanticIntentFromBrainDecision({
      turnScope: "NEW_TRANSACTION",
      factKind: "booking_fact",
      capability: "availability_request",
    }),
    "availability_inquiry"
  );
});

test("semantic projection fails closed for ambiguous booking_fact instead of guessing price or booking", () => {
  assert.equal(
    projectSemanticIntentFromBrainDecision({
      turnScope: "NEW_TRANSACTION",
      factKind: "booking_fact",
      capability: null,
    }),
    null
  );
});

test("semantic projection maps Brain-declared vague and business fact kinds without inspecting message text", () => {
  assert.equal(
    projectSemanticIntentFromBrainDecision({
      turnScope: "NEW_TRANSACTION",
      factKind: "vague",
      capability: "clarification_needed",
    }),
    "clarification"
  );
  assert.equal(
    projectSemanticIntentFromBrainDecision({
      turnScope: "NEW_TRANSACTION",
      factKind: "payment_method",
    }),
    "general_business_question"
  );
});
