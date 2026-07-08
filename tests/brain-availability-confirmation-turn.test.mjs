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
  assert.match(result.reply ?? "", /Confirm karna ho to bata dein/i);
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
  assert.match(result.reply ?? "", /Confirm karna ho to bata dein/i);
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

test("Phase1: per day kitna? maps to price", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "per day kitna?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "price");
  assert.equal(result.actionType, "reply");
});

test("Phase1: total kitna hoga? maps to price", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "total kitna hoga?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "price");
});

test("Phase1: 5 din ka total hai? maps to price", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, requestedDuration: 5 },
    messageText: "5 din ka total hai?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "price");
});

test("Phase1: color konsa hai? maps to question color (not model)", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, itemLabel: "Kia Stonic White Color" },
    messageText: "color konsa hai?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "question");
  assert.equal(result.questionTopic, "color");
});

test("Phase1: model konsa hai? maps to question model", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "model konsa hai?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "question");
  assert.equal(result.questionTopic, "model");
});

test("Phase1: car ka naam? maps to question car_name", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "car ka naam?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "question");
  assert.equal(result.questionTopic, "car_name");
});

test("Phase1: Stonic available hai na? maps to question availability (not alternatives)", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, itemLabel: "Kia Stonic", requestedDuration: 5 },
    messageText: "Stonic available hai na?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "question");
  assert.equal(result.questionTopic, "availability");
});

test("Phase1: images/pictures map to question images", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "pictures/images?",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "question");
  assert.equal(result.questionTopic, "images");
});

test("Phase1: logistics maps to question delivery/dropoff/start_date", () => {
  const a = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "delivery possible hai?",
  });
  assert.equal(a.ok, true);
  assert.equal(a.intent, "question");
  assert.equal(a.questionTopic, "delivery");

  const b = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "dropoff possible?",
  });
  assert.equal(b.ok, true);
  assert.equal(b.intent, "question");
  assert.equal(b.questionTopic, "dropoff");

  const c = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "kal se mil jaye gi?",
  });
  assert.equal(c.ok, true);
  assert.equal(c.intent, "question");
  assert.equal(c.questionTopic, "start_date");
});

test("Phase1: 3 din ke liye kar do maps to change_duration (not change_car)", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, requestedDuration: 5 },
    messageText: "3 din ke liye kar do",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "change_duration");
});

test("Phase1: Civic instead maps to change_car", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "Civic chahiye instead",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "change_car");
});

test("Phase1: cancel maps to decline_request", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "cancel",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "decline");
  assert.equal(result.actionType, "decline_request");
});

test("Phase1: ok book maps to confirm_booking", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: waitingRequest,
    messageText: "ok book",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "confirm");
  assert.equal(result.actionType, "confirm_booking");
});

test("Phase1: weak haan after Book kar du prompt maps to confirm_booking", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: {
      ...waitingRequest,
      lastCustomerNotifyMessage: "Honda Civic 2026 2 din ke liye available hai. Book kar du?",
    },
    messageText: "haan",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "confirm");
  assert.equal(result.actionType, "confirm_booking");
});

test("Phase1: unrelated maps to unclear with context-aware reply (not bare Kar doon)", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: { ...waitingRequest, itemLabel: "Kia Stonic", requestedDuration: 5 },
    messageText: "hello",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "unclear");
  assert.match(result.reply ?? "", /rent|details/i);
  assert.equal(/Kar doon\?/i.test(result.reply ?? ""), false);
});
