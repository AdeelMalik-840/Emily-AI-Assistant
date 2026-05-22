import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { resolveTurnIntentShape } from "../src/services/intentShapeResolver.js";
import {
  __classifyBelowMinimumTurnKindForTests,
  __isPureAckMessageForTests,
  __numericDailyRateFromItemForTests,
  __pendingActionPolicyForTests,
  __pendingActionReplyIntentForTests,
  __planBelowMinimumHoursTurnForTests,
  __shortBookingPolicyForTests,
} from "../src/services/messageProcessor.js";

const civicItem = {
  id: "civic-1",
  itemId: "civic-1",
  name: "Honda Civic",
  displayLabel: "Honda Civic",
  pricing: { daily: "8000 PKR", currency: "PKR" },
};

function plan(message, item = civicItem, overrides = {}) {
  const selection = {
    type: "below_minimum",
    requestedHours: 4,
    minimumHours: 12,
    billingUnit: "half_day",
    billingRatePercentOfDaily: 80,
  };
  const turnIntentShape =
    overrides.turnIntentShape ??
    resolveTurnIntentShape({
      message,
      itemMentioned: true,
      hasDuration: true,
    });
  return __planBelowMinimumHoursTurnForTests({
    message,
    selection,
    item,
    turnIntentShape,
    isGroupInbound: overrides.isGroupInbound ?? false,
    isAvailable: overrides.isAvailable ?? true,
    itemLabel: "Honda Civic",
    alternativeItems: overrides.alternativeItems ?? [],
    modeOverride: overrides.mode ?? null,
  });
}

test("pricing question below minimum includes 12h price without check karun", () => {
  const message = "civic ka 4 ghnty ka rent kitna hai?";
  const out = plan(message);
  assert.equal(out.kind, "informational");
  assert.match(out.reply, /4 ghantay ke liye gari rent par nahi milti/i);
  assert.match(out.reply, /Minimum 12 ghantay ka slot hai/i);
  assert.match(out.reply, /12 ghantay ka rent 6400 PKR hoga/i);
  assert.doesNotMatch(out.reply, /check karun/i);
  assert.equal(out.shouldStorePending, false);
  assert.equal(out.calculatedPrice, 6400);
});

test("pricing question below minimum + unavailable item", () => {
  const message = "civic ka 4 ghnty ka rent kitna hai?";
  const out = plan(message, civicItem, { isAvailable: false });
  assert.match(out.reply, /6400 PKR hoga, lekin Honda Civic abhi available nahi hai/i);
  assert.doesNotMatch(out.reply, /check karun/i);
  assert.equal(out.shouldStorePending, false);
});

test("booking request below minimum + available item stores pending", () => {
  const message = "civic 4 ghnty k lye chahiye";
  const out = plan(message);
  assert.equal(out.kind, "booking");
  assert.match(out.reply, /6400 PKR hoga/i);
  assert.match(out.reply, /12 ghantay ke liye check karun/i);
  assert.equal(out.shouldStorePending, true);

  const pending = __pendingActionPolicyForTests({ message, item: civicItem });
  assert.equal(pending.shouldStorePending, true);
  assert.equal(pending.pendingAction?.type, "accept_short_booking_offer");
});

test("booking request below minimum + unavailable does not ask check karun", () => {
  const message = "civic 4 ghnty k lye chahiye";
  const out = plan(message, civicItem, { isAvailable: false });
  assert.match(out.reply, /4 ghantay ke liye gari rent par nahi milti/i);
  assert.doesNotMatch(out.reply, /check karun/i);
  assert.equal(out.shouldStorePending, false);
  assert.match(
    out.reply,
    /Honda Civic abhi available nahi hai, aur filhaal koi aur option bhi available nahi hai/i
  );
});

test("numericDailyRateFromItem parses pricing.daily with currency text", () => {
  assert.equal(
    __numericDailyRateFromItemForTests({ pricing: { daily: "8000 PKR" } }),
    8000
  );
  assert.equal(
    __numericDailyRateFromItemForTests({ pricing: { daily: "PKR 8,000" } }),
    8000
  );
});

test("jiii with pending affirmation intent", () => {
  const pending = {
    type: "accept_short_booking_offer",
    expectedReplyType: "affirmation",
  };
  const intent = __pendingActionReplyIntentForTests("jiii", { pendingAction: pending });
  assert.equal(intent.type, "affirmation");
  assert.equal(intent.explicitNewIntent, false);
});

test("jiii is pure ack", () => {
  assert.equal(__isPureAckMessageForTests("jiii"), true);
  assert.equal(__isPureAckMessageForTests("jee"), true);
  assert.equal(__isPureAckMessageForTests("g"), true);
});

test("classify below-minimum pricing vs booking", () => {
  const pricingShape = resolveTurnIntentShape({
    message: "civic ka 4 ghnty ka rent kitna hai?",
    itemMentioned: true,
    hasDuration: true,
  });
  assert.equal(
    __classifyBelowMinimumTurnKindForTests("civic ka 4 ghnty ka rent kitna hai?", pricingShape),
    "informational"
  );
  const bookingShape = resolveTurnIntentShape({
    message: "civic 4 ghnty k lye chahiye",
    itemMentioned: true,
    hasDuration: true,
  });
  assert.equal(
    __classifyBelowMinimumTurnKindForTests("civic 4 ghnty k lye chahiye", bookingShape),
    "booking"
  );
});

test("regression: multi-day booking is not below-minimum hours", () => {
  const out = __shortBookingPolicyForTests("Civic 3 din k lye", civicItem);
  assert.notEqual(out.selection?.type, "below_minimum");
});

test("regression: half-day policy booking mode still calculates 80 percent", () => {
  const out = __shortBookingPolicyForTests("6 hours ke liye chahiye", { dailyRate: 8000 }, null, {
    mode: "booking",
  });
  assert.equal(out.selection.type, "below_minimum");
  assert.equal(out.calculatedPrice, 6400);
  assert.match(out.reply, /check karun/i);
});
