import test from "node:test";
import assert from "node:assert/strict";

import { detectBookingEvent } from "../src/services/eventDetection.js";
import { isExplicitPricingOrDetailsQuestion } from "../src/services/conversationRouter.js";
import {
  isPricingOrDetailsFieldQuestion,
  resolveTurnIntentShape,
} from "../src/services/intentShapeResolver.js";

function shape(message, extra = {}) {
  return resolveTurnIntentShape({
    message,
    prioritizedIntent: extra.prioritizedIntent ?? null,
    llmIntentClassification: extra.llmIntentClassification ?? null,
    hasDuration: extra.hasDuration ?? false,
    hasContact: extra.hasContact ?? false,
    itemMentioned: extra.itemMentioned ?? true,
  });
}

const pricingCases = [
  "corolla rent kitna hai?",
  "corolla per day rent?",
  "Corolla daily rate?",
  "corolla rate?",
  "civic charges?",
  "stonic price?",
];

for (const msg of pricingCases) {
  test(`pricing shape: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "pricing_question", msg);
    assert.equal(s.responsePolicy, "answer_requested_field", msg);
    assert.equal(isPricingOrDetailsFieldQuestion(msg), true, msg);
    assert.equal(isExplicitPricingOrDetailsQuestion(msg), true, msg);
    const events = detectBookingEvent(msg);
    assert.equal(events.bookingIntent, false, msg);
    assert.equal(events.transactionalIntent, false, msg);
  });
}

const bookingCases = [
  "Corolla 3 din k lye",
  "Corolla book karni hai",
  "Corolla kal chahiye",
  "Corolla 12 ghnty k lye",
];

for (const msg of bookingCases) {
  test(`booking shape: ${msg}`, () => {
    const s = shape(msg, { hasDuration: /\bdin\b|ghnty|ghante/i.test(msg) });
    assert.equal(s.primaryIntent, "booking_request", msg);
    assert.equal(s.responsePolicy, "start_or_continue_booking", msg);
    assert.equal(isPricingOrDetailsFieldQuestion(msg), false, msg);
  });
}

test("availability shape: Corolla available?", () => {
  const s = shape("Corolla available?");
  assert.equal(s.primaryIntent, "availability_check");
  assert.equal(s.responsePolicy, "check_availability");
});

test("rent+available compound is availability not pricing", () => {
  const s = shape("corolla rent pe available hai?");
  assert.equal(s.primaryIntent, "availability_check");
  assert.equal(isPricingOrDetailsFieldQuestion("corolla rent pe available hai?"), false);
});

for (const msg of ["Civic available for rent?", "Corolla available for rent?"]) {
  test(`available-for-rent remains availability: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "availability_check");
    assert.equal(s.responsePolicy, "check_availability");
    assert.equal(s.signals.priceAsk, false);
    assert.equal(s.signals.availabilityAsk, true);
  });
}

for (const msg of [
  "Corolla ka rent kitna hai?",
  "3 din ka rent kitna hoga?",
  "Corolla ka per day rate kya hai?",
  "Monthly rent kitna hai?",
]) {
  test(`explicit amount/rate request remains pricing: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "pricing_question");
    assert.equal(s.responsePolicy, "answer_requested_field");
    assert.equal(s.signals.priceAsk, true);
  });
}

test("bare rent does not become pricing from field detection alone", () => {
  const s = shape("Corolla rent?", {
    prioritizedIntent: { priorityIntent: "booking", askedField: "unknown" },
    llmIntentClassification: { primaryIntent: "booking" },
    itemMentioned: true,
  });
  assert.equal(s.primaryIntent, "booking_request");
  assert.notEqual(s.responsePolicy, "answer_requested_field");
  assert.equal(s.signals.priceAsk, false);
});

test("rental-need wording is not treated as a price question", () => {
  const s = shape("Corolla rent k lye chahiye");
  assert.equal(s.primaryIntent, "booking_request");
  assert.equal(s.responsePolicy, "start_or_continue_booking");
  assert.equal(s.signals.priceAsk, false);
});

for (const msg of [
  "Corolla 3 din k lye rent p chyh",
  "Civic 3 din ke liye chahiye",
]) {
  test(`item and duration rental need is not pricing: ${msg}`, () => {
    const s = shape(msg, { itemMentioned: true });
    assert.notEqual(s.primaryIntent, "pricing_question");
    assert.notEqual(s.responsePolicy, "answer_requested_field");
    assert.equal(s.signals.priceAsk, false);
  });
}

const imageWithWeakCommitmentCases = [
  "Civic ki picture share kr dn live image final test 1529",
  "Civic ki picture share kr dn final test",
  "Civic ki picture share kr dn",
  "Civic ki picture share kr dn no-send outbound lock test 1522",
  "Civic picture bhejo final karne se pehle",
  "Civic ki tasveer bhej do",
  "picture bhejo",
  "photo dikha do",
  "image share kr do",
  "pic bhejo",
];

for (const msg of imageWithWeakCommitmentCases) {
  test(`image shape beats weak commitment: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "photo_question", msg);
    assert.equal(s.responsePolicy, "answer_requested_field", msg);
    assert.equal(s.requestedField, "photo", msg);
    assert.equal(s.signals.photoAsk, true, msg);
    assert.equal(s.signals.bookingCommitment, false, msg);
  });
}

const strongBookingCases = [
  "Civic final kar do",
  "Civic final kr do",
  "Civic finalize kar do",
  "Civic book kar do",
  "Civic confirm kar do",
  "Civic reserve kar do",
  "Civic proceed kar do",
  "Isko book kar dein",
  "Isko confirm kar dein",
];

for (const msg of strongBookingCases) {
  test(`strong booking shape: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "booking_request", msg);
    assert.equal(s.responsePolicy, "start_or_continue_booking", msg);
    assert.equal(s.signals.bookingCommitment, true, msg);
  });
}

const finalPricingCases = [
  "Civic final price kya hai?",
  "Civic final rate?",
  "Civic ka rent kitna final hai?",
];

for (const msg of finalPricingCases) {
  test(`final pricing is not booking: ${msg}`, () => {
    const s = shape(msg);
    assert.equal(s.primaryIntent, "pricing_question", msg);
    assert.equal(s.responsePolicy, "answer_requested_field", msg);
    assert.equal(s.signals.bookingCommitment, false, msg);
  });
}
