import test from "node:test";
import assert from "node:assert/strict";

const {
  completeExpiredBookingRef,
  reconcileExpiredBookings,
} = await import("../src/services/bookingCompletionService.js");

const NOW = new Date("2026-08-23T00:00:00.000Z");

function makeBooking(overrides = {}) {
  return {
    status: "approved",
    startAt: "2026-08-20T00:00:00.000Z",
    endAt: "2026-08-22T00:00:00.000Z",
    itemId: "item-1",
    itemName: "Example Item",
    customerPhone: "+923001234567",
    totalAmount: 12345,
    nested: { preserved: true },
    ...overrides,
  };
}

function makeTransactionDb(initial, beforeRead = null) {
  const state = structuredClone(initial);
  const ref = { path: "businesses/biz/bookings/booking-1" };
  let updateCount = 0;
  const connection = {
    async runTransaction(fn) {
      if (typeof beforeRead === "function") beforeRead(state);
      return fn({
        async get() {
          return { exists: true, data: () => structuredClone(state) };
        },
        update(_ref, patch) {
          updateCount += 1;
          Object.assign(state, structuredClone(patch));
        },
      });
    },
  };
  return { connection, ref, state, get updateCount() { return updateCount; } };
}

for (const status of ["approved", "confirmed"]) {
  test(`expired ${status} booking becomes completed and preserves unrelated fields`, async () => {
    const fake = makeTransactionDb(makeBooking({ status }));
    const before = structuredClone(fake.state);
    const out = await completeExpiredBookingRef({
      connection: fake.connection,
      bookingRef: fake.ref,
      nowFn: () => NOW,
    });
    assert.equal(out.completed, true);
    assert.equal(fake.state.status, "completed");
    assert.deepEqual(fake.state.completedAt, NOW);
    assert.deepEqual(fake.state.updatedAt, NOW);
    for (const key of Object.keys(before)) {
      if (key === "status") continue;
      assert.deepEqual(fake.state[key], before[key], key);
    }
    assert.equal(fake.updateCount, 1);
  });
}

test("future approved and confirmed bookings remain unchanged", async () => {
  for (const status of ["approved", "confirmed"]) {
    const fake = makeTransactionDb(
      makeBooking({ status, endAt: "2026-08-24T00:00:00.000Z" })
    );
    const out = await completeExpiredBookingRef({
      connection: fake.connection,
      bookingRef: fake.ref,
      nowFn: () => NOW,
    });
    assert.equal(out.completed, false);
    assert.equal(out.reason, "BOOKING_NOT_ENDED");
    assert.equal(fake.state.status, status);
    assert.equal(fake.updateCount, 0);
  }
});

test("endAt equal to transaction time is completed", async () => {
  const fake = makeTransactionDb(makeBooking({ endAt: NOW.toISOString() }));
  const out = await completeExpiredBookingRef({
    connection: fake.connection,
    bookingRef: fake.ref,
    nowFn: () => NOW,
  });
  assert.equal(out.completed, true);
  assert.equal(fake.state.status, "completed");
});

test("ineligible statuses are never completed", async () => {
  for (const status of [
    "pending_approval",
    "cancelled",
    "canceled",
    "rejected",
    "notification_failed",
    "completed",
    "unknown_status",
  ]) {
    const fake = makeTransactionDb(makeBooking({ status }));
    const out = await completeExpiredBookingRef({
      connection: fake.connection,
      bookingRef: fake.ref,
      nowFn: () => NOW,
    });
    assert.equal(out.completed, false, status);
    assert.equal(fake.state.status, status);
    assert.equal(fake.updateCount, 0, status);
  }
});

test("missing or invalid endAt is never completed", async () => {
  for (const endAt of [null, "", "not-a-date"]) {
    const fake = makeTransactionDb(makeBooking({ endAt }));
    const out = await completeExpiredBookingRef({
      connection: fake.connection,
      bookingRef: fake.ref,
      nowFn: () => NOW,
    });
    assert.equal(out.completed, false, String(endAt));
    assert.equal(out.reason, "END_AT_INVALID");
    assert.equal(fake.updateCount, 0);
  }
});

test("completion is idempotent", async () => {
  const fake = makeTransactionDb(makeBooking());
  const first = await completeExpiredBookingRef({
    connection: fake.connection,
    bookingRef: fake.ref,
    nowFn: () => NOW,
  });
  const second = await completeExpiredBookingRef({
    connection: fake.connection,
    bookingRef: fake.ref,
    nowFn: () => NOW,
  });
  assert.equal(first.completed, true);
  assert.equal(second.completed, false);
  assert.equal(second.reason, "STATUS_NOT_ELIGIBLE");
  assert.equal(fake.updateCount, 1);
});

test("transactional recheck respects a concurrent endAt extension", async () => {
  const fake = makeTransactionDb(makeBooking(), (state) => {
    state.endAt = "2026-08-24T00:00:00.000Z";
  });
  const out = await completeExpiredBookingRef({
    connection: fake.connection,
    bookingRef: fake.ref,
    nowFn: () => NOW,
  });
  assert.equal(out.completed, false);
  assert.equal(out.reason, "BOOKING_NOT_ENDED");
  assert.equal(fake.state.status, "approved");
});

test("transactional recheck respects a concurrent status change", async () => {
  const fake = makeTransactionDb(makeBooking(), (state) => {
    state.status = "cancelled";
  });
  const out = await completeExpiredBookingRef({
    connection: fake.connection,
    bookingRef: fake.ref,
    nowFn: () => NOW,
  });
  assert.equal(out.completed, false);
  assert.equal(out.reason, "STATUS_NOT_ELIGIBLE");
  assert.equal(fake.state.status, "cancelled");
});

test("reconciliation is bounded", async () => {
  const docs = Array.from({ length: 5 }, (_, index) => ({
    ref: { path: `businesses/biz/bookings/${index}` },
  }));
  let limitSeen = null;
  const connection = {
    collectionGroup() {
      return this;
    },
    where() {
      return this;
    },
    limit(value) {
      limitSeen = value;
      return this;
    },
    async get() {
      return { docs: docs.slice(0, limitSeen) };
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return {
            exists: true,
            data: () => makeBooking({ status: "approved", id: ref.path }),
          };
        },
        update() {},
      });
    },
  };
  const out = await reconcileExpiredBookings({
    db: connection,
    nowFn: () => NOW,
    limit: 2,
  });
  assert.equal(out.scanned, 2);
  assert.equal(out.completed, 2);
});
