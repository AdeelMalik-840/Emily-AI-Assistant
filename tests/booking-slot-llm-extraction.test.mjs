import test from "node:test";
import assert from "node:assert/strict";

import { applyBookingSlotLlmExtraction } from "../src/services/messageProcessor.js";

test('LLM slots: "10 bjy rat" in awaiting_delivery_time -> deliveryTime accepted', async () => {
  const llm = async () => ({
    slots: { deliveryTime: "10 bjy rat", deliveryMethod: null, deliveryAddress: null, contactPhone: null },
    confidence: { deliveryTime: "high", deliveryMethod: "low", deliveryAddress: "low", contactPhone: "low" },
    reason: "time_phrase",
  });
  const out = await applyBookingSlotLlmExtraction({
    state: "awaiting_delivery_time",
    messageText: "10 bjy rat ko",
    booking: { deliveryTime: "" },
    llm,
  });
  assert.equal(out.accepted.deliveryTime, "10 bjy rat");
});

test('LLM slots: "12 bjy" in awaiting_delivery_time -> deliveryTime accepted', async () => {
  const llm = async () => ({
    slots: { deliveryTime: "12 bjy", deliveryMethod: null, deliveryAddress: null, contactPhone: null },
    confidence: { deliveryTime: "medium", deliveryMethod: "low", deliveryAddress: "low", contactPhone: "low" },
    reason: "time_short",
  });
  const out = await applyBookingSlotLlmExtraction({
    state: "awaiting_delivery_time",
    messageText: "12 bjy",
    booking: { deliveryTime: "" },
    llm,
  });
  assert.equal(out.accepted.deliveryTime, "12 bjy");
});

test('LLM slots: "DHA deliver krni hai" -> deliveryAddress accepted for awaiting_delivery_location', async () => {
  const llm = async () => ({
    slots: { deliveryAddress: "DHA", deliveryMethod: "delivery", deliveryTime: null, contactPhone: null },
    confidence: { deliveryAddress: "high", deliveryMethod: "medium", deliveryTime: "low", contactPhone: "low" },
    reason: "address_phrase",
  });
  const out = await applyBookingSlotLlmExtraction({
    state: "awaiting_delivery_location",
    messageText: "DHA deliver krni hai",
    booking: { deliveryAddress: "" },
    llm,
  });
  assert.equal(out.accepted.deliveryAddress, "DHA");
});

test('LLM slots: "haan" -> no accepted slots', async () => {
  const llm = async () => ({
    slots: { deliveryMethod: null, deliveryAddress: null, deliveryTime: null, contactPhone: null },
    confidence: { deliveryMethod: "low", deliveryAddress: "low", deliveryTime: "low", contactPhone: "low" },
    reason: "ack",
  });
  const out = await applyBookingSlotLlmExtraction({
    state: "awaiting_delivery_time",
    messageText: "haan",
    booking: {},
    llm,
  });
  assert.deepEqual(out.accepted, {});
});

test("LLM failure -> caller can fallback to rule-based (no throw here)", async () => {
  const llm = async () => {
    throw new Error("LLM_DOWN");
  };
  let threw = false;
  try {
    await applyBookingSlotLlmExtraction({
      state: "awaiting_delivery_time",
      messageText: "kal 5 baje",
      booking: {},
      llm,
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
});

