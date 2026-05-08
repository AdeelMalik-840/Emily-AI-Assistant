import test from "node:test";
import assert from "node:assert/strict";

import { __isInformationalPriorityIntentForTests } from "../src/services/messageProcessor.js";

test("early booking informational intent gating: price/details/information", () => {
  assert.equal(__isInformationalPriorityIntentForTests("price"), true);
  assert.equal(__isInformationalPriorityIntentForTests("pricing"), true);
  assert.equal(__isInformationalPriorityIntentForTests("details"), true);
  assert.equal(__isInformationalPriorityIntentForTests("information"), true);
});

test("early booking informational intent gating: non-informational intents", () => {
  assert.equal(__isInformationalPriorityIntentForTests("availability"), false);
  assert.equal(__isInformationalPriorityIntentForTests("booking"), false);
  assert.equal(__isInformationalPriorityIntentForTests("delivery"), false);
  assert.equal(__isInformationalPriorityIntentForTests("unclear"), false);
  assert.equal(__isInformationalPriorityIntentForTests(null), false);
});

