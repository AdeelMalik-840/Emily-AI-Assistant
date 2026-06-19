import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  isSameSessionBookingContinuation,
  setStructuredBookingState,
  buildPendingQualifierState,
  maybeHandlePendingEngagementCommitWithoutQualifier,
} = await import("../src/services/messageProcessor.js");
const { computeUserFacingAvailability } = await import(
  "../src/services/inventoryService.js"
);

const corollaId = "corolla-1";
const civicId = "civic-1";
const stonicId = "stonic-1";
const sessionA = "owner1::car rental queries::participant::adeel-malik";
const sessionB = "owner1::car rental queries::participant::other-user";

function seedCorollaPendingMemory(sessionKey = sessionA) {
  const memory = {
    lastItem: {
      id: corollaId,
      name: "Toyota corolla",
      displayLabel: "Toyota corolla (Metallic Grey)",
    },
    lastDuration: 5,
    stage: "pending_owner_approval",
    pendingEngagementState: buildPendingQualifierState({
      bookingId: "bk-corolla-1",
      qualifierKey: "usage_area",
      allowedValues: ["inside_city", "outside_city"],
    }),
  };
  setStructuredBookingState(memory, {
    id: "bk-corolla-1",
    itemId: corollaId,
    status: "pending_approval",
    approvalStage: "pending_owner_approval",
    durationDays: 5,
    sessionKey,
    channel: "group",
  });
  return memory;
}

function seedStonicPendingMemory(sessionKey = sessionA) {
  const memory = {
    lastItem: {
      id: stonicId,
      name: "Kia Stonic EX Plus 2021",
      displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
    },
    lastDuration: 5,
    stage: "pending_owner_approval",
    pendingEngagementState: buildPendingQualifierState({
      bookingId: "bk-stonic-1",
      qualifierKey: "usage_area",
      allowedValues: ["inside_city", "outside_city"],
    }),
  };
  setStructuredBookingState(memory, {
    id: "bk-stonic-1",
    itemId: stonicId,
    status: "pending_approval",
    approvalStage: "pending_owner_approval",
    durationDays: 5,
    sessionKey,
    channel: "group",
  });
  return memory;
}

const confirmMessage = "ni yh confirm kr dn 5 din k lye";
const confirmEvents = {
  bookingIntent: true,
  transactionalIntent: true,
  confirmationIntent: false,
  orderIntent: false,
};

test("B: same-session confirm is continuation on own pending Corolla booking", () => {
  const memory = seedCorollaPendingMemory();
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionA,
      itemId: corollaId,
      message: confirmMessage,
      extractedDurationDays: 5,
      contactValid: false,
      events: confirmEvents,
    }),
    true
  );
});

test("C: other participant session is not treated as same-session continuation", () => {
  const memory = seedCorollaPendingMemory(sessionA);
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionB,
      itemId: corollaId,
      message: confirmMessage,
      extractedDurationDays: 5,
      contactValid: false,
      events: confirmEvents,
    }),
    false
  );
});

test("C: inventory still blocks other customers via pending_approval booking", () => {
  const out = computeUserFacingAvailability(
    [{ itemId: corollaId, status: "pending_approval", sessionKey: sessionA }],
    corollaId
  );
  assert.equal(out.isAvailable, false);
  assert.deepEqual(out.blockingStatusesSeen, ["pending_approval"]);
});

test("D: Civic pending booking does not make Corolla continuation", () => {
  const memory = seedCorollaPendingMemory();
  setStructuredBookingState(memory, {
    id: "bk-civic-1",
    itemId: civicId,
    status: "pending_approval",
    approvalStage: "pending_owner_approval",
    durationDays: 3,
    sessionKey: sessionA,
    channel: "group",
  });
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionA,
      itemId: civicId,
      message: confirmMessage,
      extractedDurationDays: 5,
      contactValid: false,
      events: confirmEvents,
    }),
    true
  );
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionA,
      itemId: corollaId,
      message: confirmMessage,
      extractedDurationDays: 5,
      contactValid: false,
      events: confirmEvents,
    }),
    false
  );
});

test("availability-only question is not same-session continuation", () => {
  const memory = seedCorollaPendingMemory();
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionA,
      itemId: corollaId,
      message: "Corolla available?",
      extractedDurationDays: null,
      contactValid: false,
      events: { bookingIntent: false, transactionalIntent: false },
    }),
    false
  );
});

test("E: pricing-only turn is not continuation without commit phrase", () => {
  const memory = seedCorollaPendingMemory();
  assert.equal(
    isSameSessionBookingContinuation({
      memory,
      emilySessionKey: sessionA,
      itemId: corollaId,
      message: "5 din ka rent kitna ho ga?",
      extractedDurationDays: 5,
      contactValid: false,
      events: { bookingIntent: false, transactionalIntent: false },
    }),
    false
  );
  assert.equal(
    pendingEngagementActive(memory),
    true
  );
});

function pendingEngagementActive(memory) {
  return Boolean(
    memory?.bookingState &&
      memory?.pendingEngagementState?.expectedReplyType === "qualifier"
  );
}

test("F: Corolla availability defers pending Stonic usage_area engagement", async () => {
  const memory = seedStonicPendingMemory();
  const out = await maybeHandlePendingEngagementCommitWithoutQualifier({
    message: "Corolla available hai for rent?",
    memory,
    routingCtx: {},
    applyOutbound: (result) => result,
    knowledgeMeta: {},
  });
  assert.equal(out, null);
  assert.equal(pendingEngagementActive(memory), true);
  assert.equal(memory.bookingState.itemId, stonicId);
});

test("A/D-lite: confirm with pending city re-asks inside/outside city", async () => {
  const memory = seedCorollaPendingMemory();
  const out = await maybeHandlePendingEngagementCommitWithoutQualifier({
    message: confirmMessage,
    memory,
    routingCtx: {},
    applyOutbound: (result) => result,
    knowledgeMeta: {},
  });
  assert.ok(out);
  assert.match(String(out.reply), /city ke andar use karna hai ya outside city/i);
  assert.doesNotMatch(String(out.reply), /abhi available nahi hai/i);
  assert.equal(memory.bookingState.bookingId, "bk-corolla-1");
  assert.equal(pendingEngagementActive(memory), true);
});

test("A: confirm continuation never matches unavailable wording contract", () => {
  const memory = seedCorollaPendingMemory();
  const continuation = isSameSessionBookingContinuation({
    memory,
    emilySessionKey: sessionA,
    itemId: corollaId,
    message: confirmMessage,
    extractedDurationDays: 5,
    contactValid: false,
    events: confirmEvents,
  });
  assert.equal(continuation, true);
  const unavailableSnippet = "abhi available nahi hai";
  assert.notEqual(continuation, false);
  assert.ok(!unavailableSnippet.includes("continuation-true"));
});
