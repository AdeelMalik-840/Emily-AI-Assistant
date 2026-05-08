import { test } from "node:test";
import assert from "node:assert/strict";

import { __buildGroupWaitingEngagementForTests } from "../src/services/messageProcessor.js";

test("group waiting engagement uses original duration unit (2 weeks), not normalized days (14 din)", () => {
  const copy = __buildGroupWaitingEngagementForTests({
    message: "ok 2 weeks k lye chyh",
    itemName: "Civic",
    conversationStyle: "casual_local",
  });
  assert.match(copy, /\b2 weeks\b/i);
  assert.doesNotMatch(copy, /\b14\s+din\b/i);
});

