import test from "node:test";
import assert from "node:assert/strict";

import {
  extractEntity,
  getEntityConfidenceThreshold,
} from "../src/services/entityExtraction.js";

test("extracts explicit availability item with high confidence", () => {
  const out = extractEntity("civic available?");
  assert.equal(out.name, "civic");
  assert.equal(out.confidence > 0.8, true);
  assert.equal(out.entityType, "item");
});

test("extracts explicit new item in follow-up switch", () => {
  const out = extractEntity("kia ka kya scene hai?");
  assert.equal(out.name, "kia");
  assert.equal(out.confidence > 0.8, true);
});

test("does not extract entity from generic color question", () => {
  const out = extractEntity("kis color mai?");
  assert.equal(out.name, null);
  assert.equal(out.confidence, 0);
});

test("does not extract entity from generic model question", () => {
  const out = extractEntity("konsa model?");
  assert.equal(out.name, null);
});

test("does not extract entity from model kyaa hai detail question", () => {
  const out = extractEntity("model kyaa hai?");
  assert.equal(out.name, null);
  assert.equal(out.confidence, 0);
});

test("does not extract entity from generic rent question", () => {
  const out = extractEntity("kitna rent?");
  assert.equal(out.name, null);
});

test("does not extract entity from kitna rent hai detail question", () => {
  const out = extractEntity("kitna rent hai?");
  assert.equal(out.name, null);
});

test("does not extract entity from generic mileage question", () => {
  const out = extractEntity("mileage kya hai?");
  assert.equal(out.name, null);
});

test("does not extract entity from mileage kitni hai detail question", () => {
  const out = extractEntity("mileage kitni hai?");
  assert.equal(out.name, null);
});

test("does not extract entity from generic condition question", () => {
  const out = extractEntity("condition?");
  assert.equal(out.name, null);
});

test("preserves explicit item switch in detail question", () => {
  const out = extractEntity("corolla ka color kya hai?");
  assert.equal(out.name, "corolla");
  assert.equal(out.confidence > 0.8, true);
});

test("preserves explicit item model question", () => {
  const out = extractEntity("civic ka model kya hai?");
  assert.equal(out.name, "civic");
  assert.equal(out.confidence > 0.8, true);
});

test("preserves multi-token explicit item mileage question", () => {
  const out = extractEntity("kia stonic ki mileage?");
  assert.equal(out.name, "kia stonic");
  assert.equal(out.confidence > 0.8, true);
});

test("low-confidence fallback stays below override threshold", () => {
  const out = extractEntity("random vague words");
  assert.equal(out.confidence < 0.8, true);
  assert.equal(out.confidence < getEntityConfidenceThreshold(out.name), true);
});
