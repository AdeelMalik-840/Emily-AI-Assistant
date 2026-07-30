import { test } from "node:test";
import assert from "node:assert/strict";

import { parseUserDuration } from "../src/duration/parseDuration.js";
import { detectBookingEvent } from "../src/services/eventDetection.js";
import {
  applyIntentPriority,
  hasStrongBookingCommitPhrase,
  isExplicitPricingOrDetailsQuestion,
} from "../src/services/conversationRouter.js";
import {
  isDuplicateActiveBookingState,
  setStructuredBookingState,
  __shouldSuppressDuplicateAlreadyReceivedForTests,
  __isBookingContinuationShapedForTests,
} from "../src/services/messageProcessor.js";

test("pricing/detail question: detects explicit pricing or info keywords", () => {
  assert.equal(
    isExplicitPricingOrDetailsQuestion("rent kitna hai bdw per day?"),
    true
  );
  assert.equal(isExplicitPricingOrDetailsQuestion("per day rate?"), true);
  assert.equal(isExplicitPricingOrDetailsQuestion("details batao"), true);
});

test("active booking duplicate: suppress already-received for pricing-only turns", () => {
  const msg = "rent kitna hai bdw per day?";
  const events = detectBookingEvent(msg);
  assert.equal(
    __shouldSuppressDuplicateAlreadyReceivedForTests(
      msg,
      null,
      false,
      events
    ),
    true
  );

  const memory = {};
  setStructuredBookingState(memory, {
    id: "b1",
    itemId: "item-1",
    status: "pending_approval",
    durationDays: 10,
    sessionKey: "s1",
    channel: "group",
  });

  const duplicate = isDuplicateActiveBookingState(memory, {
    itemId: "item-1",
    durationDays: 10,
    sessionKey: "s1",
    channel: "group",
  });
  assert.equal(duplicate, true);

  const suppress = __shouldSuppressDuplicateAlreadyReceivedForTests(
    msg,
    null,
    false,
    events
  );
  assert.equal(duplicate && !suppress, false);
});

test("repeat booking phrase without pricing keywords: duplicate guard not suppressed", () => {
  const msg = "10 din ke liye chahiye";
  const events = detectBookingEvent(msg);
  assert.equal(
    __isBookingContinuationShapedForTests(msg, null, false, events),
    true
  );
  assert.equal(
    __shouldSuppressDuplicateAlreadyReceivedForTests(
      msg,
      null,
      false,
      events
    ),
    false
  );
});

test("mixed booking + price: booking continuation keeps duplicate path eligible", () => {
  const msg = "10 din ke liye book kar do, price bhi bata do";
  const events = detectBookingEvent(msg);
  assert.equal(
    __isBookingContinuationShapedForTests(msg, null, false, events),
    true
  );
  assert.equal(
    __shouldSuppressDuplicateAlreadyReceivedForTests(
      msg,
      null,
      false,
      events
    ),
    false
  );
});

test("applyIntentPriority: memory duration alone does not promote booking when message is pricing-only", () => {
  const priority = applyIntentPriority(
    {
      intents: { booking: false },
      primaryIntent: "price",
      askedField: "unknown",
      confidence: "high",
      reason: "test",
    },
    {
      messageText: "rent kitna hai?",
      hasDuration: true,
      hasContact: false,
    }
  );
  assert.equal(priority.priorityIntent, "price");
  assert.equal(priority.intents.booking, false);
});

test("duration parser: 2 weeks normalizes to 14 days (unchanged)", () => {
  const r = parseUserDuration("2 weeks k kitna rent ho ga?");
  assert.equal(r?.normalizedDays, 14);
});

const PRICING_WITH_DURATION = [
  "2 weeks k kitna rent ho ga?",
  "2 haftay ka total batao",
  "14 days ka rent kitna hoga?",
  "2 weeks ka overall kitna banega?",
  "per day rate kia hai?",
];

for (const msg of PRICING_WITH_DURATION) {
  test(`pricing quote shape (no booking continuation): ${msg.slice(0, 40)}…`, () => {
    assert.equal(isExplicitPricingOrDetailsQuestion(msg), true);
    assert.equal(hasStrongBookingCommitPhrase(msg), false);
    const extractedDays = parseUserDuration(msg)?.normalizedDays ?? null;
    const events = detectBookingEvent(msg);
    assert.equal(__isBookingContinuationShapedForTests(msg, extractedDays, false, events), false);
    assert.equal(detectBookingEvent(msg).bookingIntent, false);
    const priority = applyIntentPriority(
      {
        intents: { booking: false, price: true, availability: false },
        primaryIntent: "price",
        askedField: "unknown",
        confidence: "high",
        reason: "test",
      },
      {
        messageText: msg,
        hasDuration: extractedDays != null,
        hasContact: false,
        extractedDurationDays: extractedDays,
      }
    );
    assert.equal(priority.priorityIntent, "price");
    assert.equal(priority.intents.booking, false);
  });
}

test("item plus duration with bare rent remains a rental need, not a price question", () => {
  const msg = "corolla 2 weeks ka rent?";
  assert.equal(isExplicitPricingOrDetailsQuestion(msg), false);
  assert.equal(hasStrongBookingCommitPhrase(msg), false);
});

const BOOKING_WITH_DURATION = [
  "2 weeks chahiye",
  "2 weeks confirm kar do",
  "corolla 14 days ke liye book kar do",
  "haan 2 haftay ke liye kar do",
];

for (const msg of BOOKING_WITH_DURATION) {
  test(`booking continuation still shaped: ${msg.slice(0, 42)}…`, () => {
    assert.equal(hasStrongBookingCommitPhrase(msg), true);
    const extractedDays = parseUserDuration(msg)?.normalizedDays ?? null;
    const events = detectBookingEvent(msg);
    assert.equal(__isBookingContinuationShapedForTests(msg, extractedDays, false, events), true);
    assert.equal(detectBookingEvent(msg).bookingIntent, true);
  });
}
