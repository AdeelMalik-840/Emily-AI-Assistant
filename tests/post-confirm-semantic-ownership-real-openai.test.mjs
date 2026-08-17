import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const runReal =
  process.env.RUN_REAL_POST_CONFIRM_SEMANTIC_OWNERSHIP === "true" &&
  Boolean(process.env.OPENAI_API_KEY);

const { executePostConfirmPaLaneDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
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

function stonicCivicHistoryFacts() {
  const stonic = {
    id: "MHFaQZBnBVgEeRoCIFQ3",
    selectionIndex: 1,
    itemId: "kia-stonic",
    itemLabel: "Kia Stonic",
    status: "approved",
    durationDays: 4,
  };
  const civic = {
    id: "E55qPBHJUW1NsUvNLAhH",
    selectionIndex: 2,
    itemId: "honda-civic",
    itemLabel: "Honda Civic",
    status: "approved",
    durationDays: 5,
  };
  return {
    business: { name: "Test Rentals", tone: "friendly" },
    booking: civic,
    bookingCandidates: [stonic, civic],
    activeBookings: [stonic, civic],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 2,
      selectedBookingId: civic.id,
      bookingId: civic.id,
      itemId: civic.itemId,
      itemLabel: civic.itemLabel,
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
    const result = await decide(
      "Honda Civic 3 din k liye chahiye",
      stonicCivicHistoryFacts()
    );
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

test(
  "real OpenAI accepted decision is not semantically re-decided on retry",
  { skip: !runReal },
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "emily-real-semantic-resume-"));
    __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
    __clearInboundTurnLedgerForTests();
    try {
      const identity = buildCloudInboundLifecycleIdentity({
        businessId: "biz-real-resume",
        customerPhone: "923001234567",
        messageId: "wamid.real-semantic-resume",
      });
      claimCloudInboundTurn({
        businessId: "biz-real-resume",
        customerPhone: "923001234567",
        messageId: "wamid.real-semantic-resume",
      });
      let decideCalls = 0;
      const params = {
        db: {},
        businessId: "biz-real-resume",
        customerPhone: "923001234567",
        messageText: "Honda Civic 3 din k liye chahiye",
        messageId: "wamid.real-semantic-resume",
        cloudLifecycleIdentity: identity,
        __resolveActiveCustomerBookingFactsFn: async () => ({
          ok: true,
          facts: stonicCivicHistoryFacts(),
        }),
        __decideCustomerTurnFn: async (args) => {
          decideCalls += 1;
          return executePostConfirmPaLaneDecision({
            facts: args.facts,
            userMessage: args.messageText,
            timeoutMs: 20000,
          });
        },
      };
      const first = await handleCustomerBusinessPaInbound(params);
      assert.equal(decideCalls, 1);
      assert.equal(first.decision.turnScope, "NEW_TRANSACTION");
      assert.equal(
        getCloudInboundSemanticDecision({ identity })?.semanticDecisionStatus,
        "released"
      );
      const second = await handleCustomerBusinessPaInbound(params);
      assert.equal(decideCalls, 1);
      assert.equal(second.decision.turnScope, "NEW_TRANSACTION");
      assert.equal(second.ownershipReleased, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
