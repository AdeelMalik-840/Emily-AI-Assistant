import { test } from "node:test";
import assert from "node:assert/strict";

import { __antiRepetitionMayOverrideForTests } from "../src/services/messageProcessor.js";

test("anti-repetition never overrides composer finalAuthority (verified_catalog) answers", () => {
  const finalRoutedReply = "Civic ka per day rate 5000 hai.";
  const recentAssistantForRoute = ["Civic ka per day rate 5000 hai."];
  const composedAnswer = { finalAuthority: true, source: "verified_catalog", field: "price_daily" };

  const out = __antiRepetitionMayOverrideForTests({
    finalRoutedReply,
    recentAssistantForRoute,
    composedAnswer,
  });

  assert.equal(out.repeatsPrior, true);
  assert.equal(out.wouldOverride, false);
});

