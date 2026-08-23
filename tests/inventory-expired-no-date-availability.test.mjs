import test from "node:test";
import assert from "node:assert/strict";

const { computeUserFacingAvailability } = await import(
  "../src/services/inventoryService.js"
);

const ITEM_ID = "item-1";
const EVALUATION_TIME = "2026-08-23T00:00:00.000Z";

function booking(status, endAt) {
  return {
    id: `${status}-${String(endAt)}`,
    itemId: ITEM_ID,
    status,
    startAt: "2026-08-01T00:00:00.000Z",
    endAt,
  };
}

function noDateAvailability(rows) {
  return computeUserFacingAvailability(rows, ITEM_ID, {
    evaluationTime: EVALUATION_TIME,
  });
}

test("expired approved, confirmed, and pending_approval do not block no-date availability", () => {
  for (const status of ["approved", "confirmed", "pending_approval"]) {
    const out = noDateAvailability([
      booking(status, "2026-08-22T23:59:59.999Z"),
    ]);
    assert.equal(out.isAvailable, true, status);
  }
});

test("endAt equal to evaluation time is non-blocking", () => {
  const out = noDateAvailability([booking("approved", EVALUATION_TIME)]);
  assert.equal(out.isAvailable, true);
});

test("active and future approved/confirmed bookings remain blocking", () => {
  for (const status of ["approved", "confirmed"]) {
    for (const endAt of [
      "2026-08-23T00:00:00.001Z",
      "2026-09-01T00:00:00.000Z",
    ]) {
      const out = noDateAvailability([booking(status, endAt)]);
      assert.equal(out.isAvailable, false, `${status}:${endAt}`);
    }
  }
});

test("missing and invalid endAt remain conservatively blocking", () => {
  for (const endAt of [null, "", "not-a-date"]) {
    const out = noDateAvailability([booking("approved", endAt)]);
    assert.equal(out.isAvailable, false, String(endAt));
  }
});

test("completed booking remains non-blocking", () => {
  const out = noDateAvailability([
    booking("completed", "2026-09-01T00:00:00.000Z"),
  ]);
  assert.equal(out.isAvailable, true);
});

test("dated overlap calculation is unchanged", () => {
  const row = booking("approved", "2026-08-25T00:00:00.000Z");
  row.startAt = "2026-08-20T00:00:00.000Z";
  const overlap = computeUserFacingAvailability([row], ITEM_ID, {
    requestedStart: "2026-08-24T00:00:00.000Z",
    requestedEnd: "2026-08-26T00:00:00.000Z",
    evaluationTime: EVALUATION_TIME,
  });
  assert.equal(overlap.isAvailable, false);

  const boundary = computeUserFacingAvailability([row], ITEM_ID, {
    requestedStart: "2026-08-25T00:00:00.000Z",
    requestedEnd: "2026-08-26T00:00:00.000Z",
    evaluationTime: EVALUATION_TIME,
  });
  assert.equal(boundary.isAvailable, true);
});
