import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUserFacingAvailability } from "../src/services/inventoryService.js";

const itemId = "item-1";

function booking(status, startDate = "2026-05-01", endDate = "2026-05-05") {
  return {
    itemId,
    status,
    startDate,
    endDate,
  };
}

test("no-date availability blocks pending_approval bookings", () => {
  const out = computeUserFacingAvailability([booking("pending_approval")], itemId);
  assert.equal(out.isAvailable, false);
  assert.deepEqual(out.blockingStatusesSeen, ["pending_approval"]);
});

test("no-date availability blocks approved bookings", () => {
  const out = computeUserFacingAvailability([booking("approved")], itemId);
  assert.equal(out.isAvailable, false);
  assert.deepEqual(out.blockingStatusesSeen, ["approved"]);
});

test("no-date availability blocks confirmed bookings", () => {
  const out = computeUserFacingAvailability([booking("confirmed")], itemId);
  assert.equal(out.isAvailable, false);
  assert.deepEqual(out.blockingStatusesSeen, ["confirmed"]);
});

test("no-date availability ignores non-blocking booking statuses", () => {
  const bookings = [
    booking("cancelled"),
    booking("completed"),
    booking("rejected"),
  ];
  const out = computeUserFacingAvailability(bookings, itemId);
  assert.equal(out.isAvailable, true);
  assert.deepEqual(out.blockingStatusesSeen, []);
});

test("valid date availability still blocks overlapping bookings", () => {
  const out = computeUserFacingAvailability([booking("pending_approval")], itemId, {
    requestedStart: "2026-05-03",
    requestedEnd: "2026-05-06",
  });
  assert.equal(out.isAvailable, false);
  assert.deepEqual(out.blockingStatusesSeen, ["pending_approval"]);
});

test("valid date availability allows non-overlapping bookings", () => {
  const out = computeUserFacingAvailability([booking("pending_approval")], itemId, {
    requestedStart: "2026-05-06",
    requestedEnd: "2026-05-08",
  });
  assert.equal(out.isAvailable, true);
  assert.deepEqual(out.blockingStatusesSeen, []);
});
