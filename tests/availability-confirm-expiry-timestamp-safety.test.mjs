import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

process.env.NODE_ENV = "test";

import {
  classifyOptionalExpiryTimestamp,
  isCloudWaitingConfirmAvailabilityRequestEligible,
  isWaitingConfirmLifecycleActive,
  pickLatestTrustedWaitingConfirmRequest,
} from "../src/services/availabilityRequestService.js";

const NOW = Date.parse("2026-08-16T00:00:00.000Z");
const FUTURE = new Date("2026-08-17T00:00:00.000Z");
const PAST = new Date("2026-08-15T00:00:00.000Z");

function trusted(overrides = {}) {
  return {
    requestId: "avr_fresh",
    businessId: "business_1",
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: new Date("2026-08-15T12:00:00.000Z"),
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    customerDmTransport: "cloud_api",
    customerDeliveryStatus: "delivered",
    lastCustomerDmPromptType: "booking_confirmation_prompt",
    linkedBookingId: null,
    supersededByAvailabilityRequestId: null,
    customerConfirmProcessingStatus: "idle",
    confirmExpiresAt: FUTURE,
    ...overrides,
  };
}

test("1. future Firestore Timestamp is active", () => {
  const request = trusted({ confirmExpiresAt: Timestamp.fromDate(FUTURE) });
  assert.equal(isWaitingConfirmLifecycleActive(request, NOW), true);
  assert.deepEqual(classifyOptionalExpiryTimestamp(request.confirmExpiresAt, NOW), {
    state: "active",
    timestampMs: FUTURE.getTime(),
  });
});

test("2. past Firestore Timestamp is rejected", () => {
  const request = trusted({ confirmExpiresAt: Timestamp.fromDate(PAST) });
  assert.equal(isWaitingConfirmLifecycleActive(request, NOW), false);
  assert.equal(
    classifyOptionalExpiryTimestamp(request.confirmExpiresAt, NOW).state,
    "expired"
  );
});

test("3. future JS Date is active", () => {
  assert.equal(isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: FUTURE }), NOW), true);
});

test("4. past JS Date is rejected", () => {
  assert.equal(isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: PAST }), NOW), false);
});

test("5. persisted ISO string is compared normally", () => {
  assert.equal(
    isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: FUTURE.toISOString() }), NOW),
    true
  );
  assert.equal(
    isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: PAST.toISOString() }), NOW),
    false
  );
});

test("6. malformed string fails closed", () => {
  const value = "not-a-timestamp";
  assert.equal(classifyOptionalExpiryTimestamp(value, NOW).state, "invalid");
  assert.equal(isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: value }), NOW), false);
});

test("7. invalid Date object fails closed", () => {
  const value = new Date("invalid");
  assert.equal(classifyOptionalExpiryTimestamp(value, NOW).state, "invalid");
  assert.equal(isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: value }), NOW), false);
});

test("8. malformed Timestamp-like object fails closed", () => {
  const value = { seconds: "bad", nanoseconds: {} };
  assert.equal(classifyOptionalExpiryTimestamp(value, NOW).state, "invalid");
  assert.equal(isWaitingConfirmLifecycleActive(trusted({ confirmExpiresAt: value }), NOW), false);
  assert.equal(
    classifyOptionalExpiryTimestamp({ seconds: FUTURE.getTime() / 1000, nanoseconds: -1 }, NOW)
      .state,
    "invalid"
  );
});

test("9. missing confirmExpiresAt preserves active lifecycle rule", () => {
  const request = trusted({ confirmExpiresAt: null });
  assert.equal(classifyOptionalExpiryTimestamp(request.confirmExpiresAt, NOW).state, "missing");
  assert.equal(isWaitingConfirmLifecycleActive(request, NOW), true);
});

test("10. live Aug 15 expiry is not selectable on Aug 16", () => {
  const oldLiveAvr = trusted({
    requestId: "avr_86bb4cccb2af7f2eb9e32e7e",
    confirmExpiresAt: Timestamp.fromDate(PAST),
  });
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(oldLiveAvr, NOW), false);
  assert.equal(pickLatestTrustedWaitingConfirmRequest([oldLiveAvr], NOW), null);
});

test("11. fresh trusted AVR remains selectable", () => {
  const fresh = trusted();
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(fresh, NOW), true);
  assert.equal(pickLatestTrustedWaitingConfirmRequest([fresh], NOW)?.requestId, "avr_fresh");
});

test("12. superseded fresh AVR remains rejected", () => {
  const superseded = trusted({ supersededByAvailabilityRequestId: "avr_newer" });
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(superseded, NOW), false);
  assert.equal(pickLatestTrustedWaitingConfirmRequest([superseded], NOW), null);
});

test("13. expired approved waiting-confirm AVR is rejected", () => {
  const expired = trusted({ confirmExpiresAt: Timestamp.fromDate(PAST) });
  assert.equal(isWaitingConfirmLifecycleActive(expired, NOW), false);
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(expired, NOW), false);
});

test("14. expired AVR plus newer fresh AVR selects the fresh AVR", () => {
  const expired = trusted({
    requestId: "avr_expired",
    confirmExpiresAt: Timestamp.fromDate(PAST),
    approvalCustomerNotificationAt: new Date("2026-08-15T13:00:00.000Z"),
  });
  const fresh = trusted({ requestId: "avr_newer_fresh" });
  assert.equal(
    pickLatestTrustedWaitingConfirmRequest([expired, fresh], NOW)?.requestId,
    "avr_newer_fresh"
  );
});

test("15. expired-only candidate set returns no trusted waiting-confirm request", () => {
  const expired = trusted({
    requestId: "avr_expired_only",
    confirmExpiresAt: Timestamp.fromDate(PAST),
  });
  assert.equal(pickLatestTrustedWaitingConfirmRequest([expired], NOW), null);
});
