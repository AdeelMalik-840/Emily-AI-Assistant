import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __buildGroupWaitingEngagementForTests,
  __formatCustomerDurationForTests,
  __groupSafeRequestReceivedReplyForTests,
} from "../src/services/messageProcessor.js";

test("group waiting engagement stays public-safe and does not ask logistics", () => {
  const copy = __buildGroupWaitingEngagementForTests({
    message: "ok 2 weeks k lye chyh",
    itemName: "Civic",
    conversationStyle: "casual_local",
  });
  assert.equal(copy, "Perfect 👍 request receive ho gayi hai. Main confirm kar ke bata deta hun.");
  assert.doesNotMatch(copy, /contact|naam|address|time|pickup|delivery|inside|outside|city ke andar/i);
});

test("group owner-approval acknowledgement displays half-day hours instead of one day", () => {
  const copy = __groupSafeRequestReceivedReplyForTests({
    itemAndDurationKnown: true,
    itemName: "Honda Civic 2026 Oriel",
    durationDays: 1,
    durationHours: 12,
    billingUnit: "half_day",
  });

  assert.equal(
    copy,
    "Perfect 👍 Honda Civic 2026 Oriel 12 ghantay ke liye note kar liya. Main confirm kar ke bata deta hun."
  );
  assert.doesNotMatch(copy, /1 din/i);
  assert.doesNotMatch(copy, /contact|naam|address|time|pickup|delivery|inside|outside|city ke andar/i);
});

test("customer duration formatter preserves full-day and multi-day labels", () => {
  assert.equal(
    __formatCustomerDurationForTests({
      durationDays: 1,
      durationHours: 12,
      billingUnit: "half_day",
    }),
    "12 ghantay"
  );
  assert.equal(__formatCustomerDurationForTests({ durationDays: 1 }), "1 din");
  assert.equal(__formatCustomerDurationForTests({ durationDays: 45 }), "45 din");
});

