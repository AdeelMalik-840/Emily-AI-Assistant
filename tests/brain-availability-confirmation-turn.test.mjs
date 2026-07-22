import test from "node:test";
import assert from "node:assert/strict";

import {
  AVAILABILITY_DM_PROMPT_TYPES,
  buildAvailabilityScopedQuestionReply,
  resolveAvailabilityConfirmationTurn,
} from "../src/brain/availabilityConfirmation/index.js";

const waitingRequest = {
  status: "approved",
  approvalCustomerNotificationStatus: "sent",
  customerConfirmationStatus: "waiting_confirm",
  itemLabel: "Honda Civic 2026",
  requestedDuration: 2,
  priceQuote: { status: "quoted", total: 16000, currency: "PKR", durationDays: 2, dailyRate: 8000 },
  lastCustomerNotifyMessage:
    "Honda Civic 2026 2 din ke liye available hai. 2 din ka rent 16,000 PKR hoga. Book kar du?",
};

const corollaWaitingRequest = {
  status: "approved",
  approvalCustomerNotificationStatus: "sent",
  customerConfirmationStatus: "waiting_confirm",
  canonicalAvailabilityStatus: "available",
  itemLabel: "Toyota corolla (Metallic Grey)",
  itemId: "corolla-1",
  requestedDuration: 2,
  priceQuote: {
    status: "quoted",
    total: 10000,
    currency: "PKR",
    durationDays: 2,
    dailyRate: 5000,
  },
  lastCustomerNotifyMessage:
    "Toyota corolla (Metallic Grey) 2 din ke liye available hai. 2 din ka rent 10,000 PKR hoga. Book kar du?",
};

function scopedReply(messageText, request = corollaWaitingRequest) {
  const turn = resolveAvailabilityConfirmationTurn({ request, messageText });
  if (turn.reply) return turn.reply;
  if (turn.needsAsyncReply && turn.questionTopic) {
    return buildAvailabilityScopedQuestionReply({
      request,
      topic: turn.questionTopic,
      messageText,
      priceQuote: request.priceQuote,
    });
  }
  return "";
}

function assertNoBookingAction(messageText, request = corollaWaitingRequest) {
  const turn = resolveAvailabilityConfirmationTurn({ request, messageText });
  assert.notEqual(turn.actionType, "confirm_booking");
  assert.notEqual(turn.intent, "confirm");
}

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
  assert.match(result.reply ?? "", /16,000 PKR|total rent/i);
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

test("facts A: Konsi car hai? reply includes Toyota Corolla item name", () => {
  const reply = scopedReply("Konsi car hai?");
  assert.match(reply, /Toyota corolla/i);
  assertNoBookingAction("Konsi car hai?");
});

test("facts B: car ka naam? reply includes Toyota Corolla", () => {
  const reply = scopedReply("car ka naam?");
  assert.match(reply, /Toyota corolla/i);
  assertNoBookingAction("car ka naam?");
});

test("facts C: model konsa hai? reply includes item/model from itemLabel", () => {
  const reply = scopedReply("model konsa hai?");
  assert.match(reply, /Toyota corolla/i);
  assertNoBookingAction("model konsa hai?");
});

test("facts D: Color konsa hai? with Metallic Grey itemLabel includes Metallic Grey", () => {
  const reply = scopedReply("Color konsa hai?");
  assert.match(reply, /Metallic Grey/i);
  assertNoBookingAction("Color konsa hai?");
});

test("facts E: Corolla ka color kon sa hai? includes Metallic Grey", () => {
  const reply = scopedReply("Corolla ka color kon sa hai?");
  assert.match(reply, /Metallic Grey/i);
  assertNoBookingAction("Corolla ka color kon sa hai?");
});

test("facts F: kitne din ke liye hai? includes 2 din", () => {
  const reply = scopedReply("kitne din ke liye hai?");
  assert.match(reply, /2 din/i);
  assertNoBookingAction("kitne din ke liye hai?");
});

test("facts G: total rent kitna hai? includes 10,000 PKR", () => {
  const reply = scopedReply("total rent kitna hai?");
  assert.match(reply, /10,000 PKR/i);
  assertNoBookingAction("total rent kitna hai?");
});

test("facts H: per day kitna hai? includes 5,000 PKR", () => {
  const reply = scopedReply("per day kitna hai?");
  assert.match(reply, /5,000 PKR/i);
  assertNoBookingAction("per day kitna hai?");
});

test("facts I: ye available hai? includes available + item + duration", () => {
  const reply = scopedReply("ye available hai?");
  assert.match(reply, /available hai/i);
  assert.match(reply, /Toyota corolla/i);
  assert.match(reply, /2 din/i);
  assertNoBookingAction("ye available hai?");
});

test("facts J: details bata dein includes item + duration + total price", () => {
  const turn = resolveAvailabilityConfirmationTurn({
    request: corollaWaitingRequest,
    messageText: "details bata dein",
  });
  assert.equal(turn.intent, "question");
  assert.equal(turn.questionTopic, "request_summary");
  const reply = buildAvailabilityScopedQuestionReply({
    request: corollaWaitingRequest,
    topic: "request_summary",
    messageText: "details bata dein",
    priceQuote: corollaWaitingRequest.priceQuote,
  });
  assert.match(reply, /Toyota corolla/i);
  assert.match(reply, /2 din/i);
  assert.match(reply, /10,000 PKR/i);
  assertNoBookingAction("details bata dein");
});

test("facts K: delivery possible hai? with no delivery info uses safe fallback", () => {
  const reply = scopedReply("delivery possible hai?");
  assert.match(reply, /confirmation karni hogi/i);
  assertNoBookingAction("delivery possible hai?");
});

test("facts L: driver milega? with no driver info uses safe fallback", () => {
  const reply = scopedReply("driver milega?");
  assert.match(reply, /confirmation karni hogi/i);
  assertNoBookingAction("driver milega?");
});

test("facts M: known-detail questions A-L do not create booking", () => {
  const prompts = [
    "Konsi car hai?",
    "car ka naam?",
    "model konsa hai?",
    "Color konsa hai?",
    "Corolla ka color kon sa hai?",
    "kitne din ke liye hai?",
    "total rent kitna hai?",
    "per day kitna hai?",
    "ye available hai?",
    "details bata dein",
    "delivery possible hai?",
    "driver milega?",
  ];
  for (const messageText of prompts) {
    assertNoBookingAction(messageText);
  }
});

test("facts N: request remains waiting_confirm semantics for known-detail questions", () => {
  for (const messageText of ["Color konsa hai?", "total rent kitna hai?", "per day kitna hai?"]) {
    const turn = resolveAvailabilityConfirmationTurn({
      request: corollaWaitingRequest,
      messageText,
    });
    assert.equal(turn.ok, true);
    assert.notEqual(turn.actionType, "confirm_booking");
    assert.notEqual(turn.actionType, "decline_request");
  }
});

test("facts O: Book kar do still confirms booking", () => {
  const result = resolveAvailabilityConfirmationTurn({
    request: corollaWaitingRequest,
    messageText: "Book kar do",
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "confirm");
  assert.equal(result.actionType, "confirm_booking");
});

const bookingConfirmPromptRequest = {
  ...waitingRequest,
  lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
};

const nonBookingConfirmPromptRequest = {
  ...waitingRequest,
  lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
  lastCustomerNotifyMessage: "Honda Civic 2026 2 din ka rent 16,000 PKR hoga.",
  lastCustomerDmOutboundPreview: "Honda Civic 2026 2 din ka rent 16,000 PKR hoga.",
};

test("expanded confirms map to confirm_booking after booking_confirmation_prompt", () => {
  const phrases = [
    "booking kar do",
    "booking kr do",
    "kar dein",
    "kr dein",
    "go ahead",
    "proceed",
    "OK.",
    "Ji!",
    "Theek hai.",
    "Haan!",
  ];
  for (const messageText of phrases) {
    const result = resolveAvailabilityConfirmationTurn({
      request: bookingConfirmPromptRequest,
      messageText,
    });
    assert.equal(
      result.actionType,
      "confirm_booking",
      `expected confirm_booking for ${JSON.stringify(messageText)}, got ${result.intent}/${result.actionType}`
    );
    assert.equal(result.intent, "confirm");
  }
});

test("short positives do not confirm without booking_confirmation_prompt", () => {
  const phrases = ["ok", "okay", "haan", "ji", "theek hai", "kar do", "done"];
  for (const messageText of phrases) {
    const result = resolveAvailabilityConfirmationTurn({
      request: nonBookingConfirmPromptRequest,
      messageText,
    });
    assert.notEqual(
      result.actionType,
      "confirm_booking",
      `expected no confirm_booking for ${JSON.stringify(messageText)} without prompt`
    );
    assert.notEqual(result.intent, "confirm");
  }
});

test("neutral unclear questions and change requests never confirm booking", () => {
  const phrases = [
    "acha",
    "hmm",
    "hm",
    "wait",
    "sochta hun",
    "rent kitna hai?",
    "driver milega?",
    "3 din ke liye chahiye",
    "Civic chahiye",
  ];
  for (const messageText of phrases) {
    const withPrompt = resolveAvailabilityConfirmationTurn({
      request: bookingConfirmPromptRequest,
      messageText,
    });
    const withoutPrompt = resolveAvailabilityConfirmationTurn({
      request: nonBookingConfirmPromptRequest,
      messageText,
    });
    assert.notEqual(withPrompt.actionType, "confirm_booking", messageText);
    assert.notEqual(withPrompt.intent, "confirm", messageText);
    assert.notEqual(withoutPrompt.actionType, "confirm_booking", messageText);
    assert.notEqual(withoutPrompt.intent, "confirm", messageText);
  }
});
