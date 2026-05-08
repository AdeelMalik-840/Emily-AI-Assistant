import test from "node:test";
import assert from "node:assert/strict";

import {
  extractLocationSlotFromDeliveryText,
  interpretDeliveryMethodMessage,
} from "../src/services/messageProcessor.js";

test('interpretDeliveryMethodMessage: "Faisal town m delivery ho jye ge?" extracts location', () => {
  const r = interpretDeliveryMethodMessage("Faisal town m delivery ho jye ge?");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal town");
});

test('interpretDeliveryMethodMessage: "Bahria phase 7 mein delivery possible hai?" extracts location', () => {
  const r = interpretDeliveryMethodMessage("Bahria phase 7 mein delivery possible hai?");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Bahria phase 7");
});

test('interpretDeliveryMethodMessage: "delivery DHA phase 2 kar dein" extracts location', () => {
  const r = interpretDeliveryMethodMessage("delivery DHA phase 2 kar dein");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "DHA phase 2");
});

test('interpretDeliveryMethodMessage: "Faisal Town deliver krni hai" extracts Faisal Town (not krni)', () => {
  const r = interpretDeliveryMethodMessage("Faisal Town deliver krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal Town");
});

test('interpretDeliveryMethodMessage: "deliver krni hai" returns delivery with no location', () => {
  const r = interpretDeliveryMethodMessage("deliver krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "DHA delivery krni hai" keeps DHA as location', () => {
  const r = interpretDeliveryMethodMessage("DHA delivery krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "DHA");
});

test('interpretDeliveryMethodMessage: "delivery" returns no location', () => {
  const r = interpretDeliveryMethodMessage("delivery");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "haan delivery" returns no location', () => {
  const r = interpretDeliveryMethodMessage("haan delivery");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "pickup" returns pickup with no location', () => {
  const r = interpretDeliveryMethodMessage("pickup");
  assert.equal(r.method, "pickup");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: short location-only reply still works ("Faisal town")', () => {
  const r = interpretDeliveryMethodMessage("Faisal town");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal town");
});

