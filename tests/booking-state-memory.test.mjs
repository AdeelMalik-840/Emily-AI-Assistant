import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildPendingQualifierState,
  clearStructuredBookingState,
  isDuplicateActiveBookingState,
  maybeHandlePendingEngagementQualifier,
  setStructuredBookingState,
} = await import("../src/services/messageProcessor.js");

function createFakeDb() {
  const updates = [];
  return {
    updates,
    db: {
      collection(collectionName) {
        return {
          doc(docId) {
            return {
              collection(childCollectionName) {
                return {
                  doc(childDocId) {
                    return {
                      async update(patch) {
                        updates.push({
                          path: [
                            collectionName,
                            docId,
                            childCollectionName,
                            childDocId,
                          ],
                          patch,
                        });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

test("old rejected booking does not block new booking", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "rejected",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s1",
      channel: "group",
    }),
    false
  );
});

test("new item clears old booking state", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });

  assert.equal(clearStructuredBookingState(memory, "EXPLICIT_NEW_ITEM"), true);
  assert.equal(memory.bookingState, undefined);
  assert.equal(memory.bookingCreated, undefined);
  assert.equal(memory.bookingStatesByItemId["item-1"].bookingId, "b1");

  setStructuredBookingState(memory, {
    id: "b2",
    itemId: "item-2",
    status: "pending_approval",
    durationDays: 5,
    sessionKey: "s1",
    channel: "group",
  });

  assert.deepEqual(
    {
      bookingId: memory.bookingState.bookingId,
      itemId: memory.bookingState.itemId,
      status: memory.bookingState.status,
      durationDays: memory.bookingState.durationDays,
    },
    {
      bookingId: "b2",
      itemId: "item-2",
      status: "pending_approval",
      durationDays: 5,
    }
  );
  assert.equal(memory.bookingStatesByItemId["item-1"].bookingId, "b1");
  assert.equal(memory.bookingStatesByItemId["item-2"].bookingId, "b2");
});

test("same active booking duplicate is still guarded", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s1",
      channel: "group",
    }),
    true
  );
});

test("different duration or item is not treated as duplicate", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "approved",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 4,
      sessionKey: "s1",
      channel: "group",
    }),
    false
  );
  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-2",
      durationDays: 3,
      sessionKey: "s1",
      channel: "group",
    }),
    false
  );
});

test("same item in another session or channel is not treated as duplicate", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s2",
      channel: "group",
    }),
    false
  );
  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s1",
      channel: "dm",
    }),
    false
  );
});

test("duplicate guard ignores stale state outside short duplicate window", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });
  const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  memory.bookingState.updatedAt = stale;
  memory.bookingStatesByItemId["item-1"].updatedAt = stale;

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s1",
      channel: "group",
    }),
    false
  );
});

test("expired booking state is cleared before duplicate guard", () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });
  const expired = new Date(Date.now() - 61 * 60 * 1000).toISOString();
  memory.bookingState.updatedAt = expired;
  memory.bookingStatesByItemId["item-1"].updatedAt = expired;

  assert.equal(
    isDuplicateActiveBookingState(memory, {
      itemId: "item-1",
      durationDays: 3,
      sessionKey: "s1",
      channel: "group",
    }),
    false
  );
  assert.equal(memory.bookingState, undefined);
  assert.equal(memory.bookingStatesByItemId["item-1"], undefined);
});

test("pending owner engagement qualifier reply is stored and short-circuits", async () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    approvalStage: "pending_owner_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });
  memory.pendingEngagementState = buildPendingQualifierState({
    bookingId: "b1",
    qualifierKey: "usage_area",
    allowedValues: ["inside_city", "outside_city"],
  });
  const { db, updates } = createFakeDb();
  const outboundCalls = [];

  const result = await maybeHandlePendingEngagementQualifier({
    db,
    userId: "owner1",
    message: "outside city",
    memory,
    routingCtx: { isGroupInbound: true },
    applyOutbound: (payload, routingCtx) => {
      outboundCalls.push({ payload, routingCtx });
      return payload;
    },
  });

  assert.ok(result);
  assert.equal(outboundCalls.length, 1);
  assert.equal(result.meta.pendingEngagementHandled, true);
  assert.equal(memory.qualifiers.usage_area, "outside_city");
  assert.equal(memory.pendingEngagementState.rawAnswer, "outside city");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].path, [
    "businesses",
    "owner1",
    "bookings",
    "b1",
  ]);
  assert.equal(updates[0].patch.qualifiers.usage_area, "outside_city");
});

test("pending owner engagement ignores non-qualifier reply", async () => {
  const memory = {};
  setStructuredBookingState(memory, {
    id: "b2",
    itemId: "item-1",
    status: "pending_approval",
    approvalStage: "pending_owner_approval",
    durationDays: 3,
    sessionKey: "s1",
    channel: "group",
  });
  memory.pendingEngagementState = buildPendingQualifierState({
    bookingId: "b2",
    qualifierKey: "usage_area",
    allowedValues: ["inside_city", "outside_city"],
  });
  const { db, updates } = createFakeDb();

  const result = await maybeHandlePendingEngagementQualifier({
    db,
    userId: "owner1",
    message: "kal chahiye",
    memory,
    routingCtx: { isGroupInbound: true },
    applyOutbound: (payload) => payload,
  });

  assert.equal(result, null);
  assert.equal(updates.length, 0);
});
