import test from "node:test";
import assert from "node:assert/strict";

import {
  __buildBrowseOfferingsReplyForTests,
  __isBrowseOptionsIntentForTests,
} from "../src/services/messageProcessor.js";

test("browse_options semantic detector: roman urdu options ask", () => {
  assert.equal(__isBrowseOptionsIntentForTests("or kon kon c options hain?"), true);
});

test("browse_options semantic detector: english what else", () => {
  assert.equal(__isBrowseOptionsIntentForTests("what else do you have?"), true);
});

test("browse_options reply builder: lists items (generic, not car-specific)", () => {
  const reply = __buildBrowseOfferingsReplyForTests({
    style: "neutral_english",
    items: [
      { name: "Item A", price: "5000 PKR/day" },
      { name: "Item B", pricing: { daily: "5500" } },
    ],
    services: [],
  });
  assert.match(reply, /Available options:/);
  assert.match(reply, /Item A/i);
  assert.match(reply, /Item B/i);
  assert.doesNotMatch(reply, /confirm\s+kar/i);
});

test("browse_options reply builder: can list services for non-catalog businesses", () => {
  const reply = __buildBrowseOfferingsReplyForTests({
    style: "neutral_english",
    items: [],
    services: [
      { label: "Deep cleaning", price: "2000" },
      { name: "AC repair" },
    ],
  });
  assert.match(reply, /Available options:/);
  assert.match(reply, /Deep cleaning/i);
  assert.match(reply, /AC repair/i);
});

