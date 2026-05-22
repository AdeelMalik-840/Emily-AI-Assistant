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
  "Corolla rent?",
  "corolla ka rent?",
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
  "Corolla rent k lye chahiye",
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

test("pricing after civic memory context: Corolla rent?", () => {
  const s = shape("Corolla rent?", {
    prioritizedIntent: { priorityIntent: "booking", askedField: "unknown" },
    llmIntentClassification: { primaryIntent: "booking" },
    itemMentioned: true,
  });
  assert.equal(s.primaryIntent, "pricing_question");
  assert.equal(s.responsePolicy, "answer_requested_field");
});
