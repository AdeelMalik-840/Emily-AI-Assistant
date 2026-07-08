import test from "node:test";
import assert from "node:assert/strict";

import {
  AVAILABILITY_DM_PROMPT_TYPES,
  resolveAvailabilityConfirmationTurn,
} from "../src/brain/availabilityConfirmation/index.js";

const waitingRequest = {
  status: "approved",
  approvalCustomerNotificationStatus: "sent",
  customerConfirmationStatus: "waiting_confirm",
  itemLabel: "Honda Civic 2026",
  requestedDuration: 2,
  lastCustomerNotifyMessage:
    "Honda Civic 2026 2 din ke liye available hai. 2 din ka rent 16,000 PKR hoga. Book kar du?",
};

test("resolveAvailabilityConfirmationTurn rejects non-waiting_confirm lifecycle", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, customerConfirmationStatus: "confirmed" },
    messageText: "ok",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_WAITING_CONFIRM");
});

test("resolveAvailabilityConfirmationTurn maps confirm intent to confirm_booking action", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "haan",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "confirm");
  assert.equal(result.actionType, "confirm_booking");
  assert.equal(result.needsAsyncReply, false);
});

test('resolveAvailabilityConfirmationTurn maps "Han book kar do" to confirm_booking', () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "Han book kar do",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "confirm");
  assert.equal(result.actionType, "confirm_booking");
});

test("resolveAvailabilityConfirmationTurn maps bare ok to acknowledge reply action", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: {
      ...waitingRequest,
      lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
    },
    messageText: "ok",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "acknowledge");
  assert.equal(result.actionType, "reply");
  assert.equal(result.outboundPromptType, AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION);
  assert.match(result.reply ?? "", /Kar doon\?/i);
});

test("resolveAvailabilityConfirmationTurn maps price question to async reply action", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "rent kitna hai?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "price");
  assert.equal(result.actionType, "reply");
  assert.equal(result.needsAsyncReply, true);
  assert.equal(result.questionTopic, "price");
});

test("resolveAvailabilityConfirmationTurn maps decline to decline_request with reply", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "nahi chahiye",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "decline");
  assert.equal(result.actionType, "decline_request");
  assert.equal(result.reply?.length > 0, true);
});
