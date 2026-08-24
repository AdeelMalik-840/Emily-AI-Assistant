import test from "node:test";
import assert from "node:assert/strict";

const { CUSTOMER_SEMANTIC_INTENTS } = await import(
  "../src/brain/decisions/decideCustomerTurn.js"
);

test("semantic authority vocabulary is narrow and executor-free", () => {
  const intents = new Set(CUSTOMER_SEMANTIC_INTENTS);

  for (const required of [
    "availability_inquiry",
    "pricing_inquiry",
    "pricing_with_duration",
    "booking_request",
    "browse_options",
    "clarification",
    "social",
    "unclear",
  ]) {
    assert.equal(intents.has(required), true, required);
  }

  for (const forbidden of [
    "create_booking",
    "approve_booking",
    "send_whatsapp",
    "notify_owner",
    "write_firestore",
  ]) {
    assert.equal(intents.has(forbidden), false, forbidden);
  }
});
