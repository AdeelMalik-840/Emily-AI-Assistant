import test from "node:test";
import assert from "node:assert/strict";

import { extractDeliveryTime } from "../src/services/bookingSlotParsers.js";

test('extractDeliveryTime: "kal 5 baje" is high confidence', () => {
  const r = extractDeliveryTime("kal 5 baje");
  assert.equal(r.confidence, "high");
  assert.equal(r.timeText, "kal 5 baje");
});

test('extractDeliveryTime: "evening" is accepted (medium)', () => {
  const r = extractDeliveryTime("evening");
  assert.equal(r.confidence, "medium");
  assert.equal(r.timeText, "evening");
});

test('extractDeliveryTime: "haan" is unclear', () => {
  const r = extractDeliveryTime("haan");
  assert.equal(r.confidence, "low");
  assert.equal(r.timeText, null);
});

