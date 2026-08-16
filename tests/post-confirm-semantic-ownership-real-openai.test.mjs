import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

const runReal =
  process.env.RUN_REAL_POST_CONFIRM_SEMANTIC_OWNERSHIP === "true" &&
  Boolean(process.env.OPENAI_API_KEY);

const { executePostConfirmPaLaneDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

function factsFor(itemId = "kia-stonic", itemLabel = "Kia Stonic") {
  const booking = {
    id: `booking-${itemId}`,
    selectionIndex: 1,
    itemId,
    itemLabel,
    status: "approved",
    durationDays: 4,
  };
  return {
    business: { name: "Test Rentals", tone: "friendly" },
    booking,
    bookingCandidates: [booking],
    activeBookings: [booking],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: booking.id,
      bookingId: booking.id,
      itemId,
      itemLabel,
    },
    pendingAvailabilityRequests: [],
    known: {},
    policy: { readOnly: true },
  };
}

async function decide(message, facts = factsFor()) {
  const result = await executePostConfirmPaLaneDecision({
    facts,
    userMessage: message,
    timeoutMs: 20000,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.source, "openai");
  return result.decision;
}

test(
  "real OpenAI: fresh Civic does not belong to old Stonic",
  { skip: !runReal },
  async () => {
    const result = await decide("Honda Civic 3 din k liye chahiye");
    assert.equal(result.turnScope, "NEW_TRANSACTION");
    assert.equal(result.targetContext, "NEW_TRANSACTION");
    assert.equal(result.targetId, null);
  }
);

test(
  "real OpenAI: explicit old Stonic fact selects exact booking",
  { skip: !runReal },
  async () => {
    const result = await decide("Meri Stonic booking ka total rent kitna hai?");
    assert.equal(result.turnScope, "OLD_BOOKING_REFERENCE");
    assert.equal(result.targetId, "booking-kia-stonic");
  }
);

test("real OpenAI: social turn has no transactional owner", { skip: !runReal }, async () => {
  const result = await decide("Hello");
  assert.equal(result.turnScope, "SOCIAL_GENERAL");
  assert.equal(result.targetId, null);
});

test(
  "real OpenAI: explicit old Stonic cancellation selects exact booking",
  { skip: !runReal },
  async () => {
    const result = await decide("Meri Stonic booking cancel kar do");
    assert.equal(result.turnScope, "OLD_BOOKING_REFERENCE");
    assert.equal(result.targetId, "booking-kia-stonic");
    assert.equal(result.mutationIntent, "cancel_booking");
  }
);

test(
  "real OpenAI: ambiguous same-item turn cannot mutate without exact old scope",
  { skip: !runReal },
  async () => {
    const civicFacts = factsFor("honda-civic", "Honda Civic");
    const result = await decide("Civic 3 din", civicFacts);
    assert.ok(["NEW_TRANSACTION", "UNCLEAR"].includes(result.turnScope));
    assert.equal(result.mutationIntent, "none");
  }
);
