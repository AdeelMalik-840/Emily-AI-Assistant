import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedFactsForCloudCompose } from "../src/brain/live/brainV2LivePipeline.js";

function ownerCheckReadyActionPlan(itemId) {
  return Object.freeze({
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: "",
          field: "availability",
          itemId,
          source: "canonical_owner_check_post_execute",
          awaitPostExecuteReply: true,
          execute: false,
        }),
      }),
      Object.freeze({
        type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
        payload: Object.freeze({ itemId, execute: true }),
      }),
    ]),
  });
}

function facts(itemId, { workflowType, semanticIntent }) {
  return trustedFactsForCloudCompose({
    actionPlan: ownerCheckReadyActionPlan(itemId),
    workflowType,
    semanticIntent,
    resolvedBusinessTurnContext: {
      resolvedItem: { id: itemId, displayLabel: itemId, customerReference: itemId },
      verified: {
        pricing: { daily: 8000, currency: "PKR" },
        priceQuote: { total: 72000, durationDays: 9 },
      },
      turn: { durationDays: 9 },
    },
  });
}

for (const itemId of ["car_corolla", "car_stonic", "car_civic", "car_syn_synthetic"]) {
  test(`owner-check-ready action plan for ${itemId}: adversarial raw pricing_with_duration semanticIntent does not hijack compose kind or leak pricing`, () => {
    const result = facts(itemId, {
      workflowType: "availability_inquiry",
      semanticIntent: "pricing_with_duration",
    });
    assert.equal(result.totalAmount, undefined, "totalAmount must not be projected");
    assert.equal(result.dailyRate, undefined, "dailyRate must not be projected");
    assert.equal(result.monthlyRate, undefined, "monthlyRate must not be projected");
    assert.equal(result.durationDays, undefined, "durationDays must not be projected");
    assert.equal(result.itemId, itemId);
  });
}

test("legitimate grounded pricing switch: workflowType actually resolved to pricing_with_duration still produces a pricing reply", () => {
  const result = facts("car_corolla", {
    workflowType: "pricing_with_duration",
    semanticIntent: "pricing_with_duration",
  });
  assert.equal(result.totalAmount, 72000);
  assert.equal(result.dailyRate, 8000);
  assert.equal(result.durationDays, 9);
});

test("direct pricing turn with no canonical workflow decision still falls back to raw semanticIntent and produces a pricing reply", () => {
  const result = facts("car_corolla", {
    workflowType: "",
    semanticIntent: "pricing_with_duration",
  });
  assert.equal(result.totalAmount, 72000);
  assert.equal(result.dailyRate, 8000);
  assert.equal(result.durationDays, 9);
});

test("availability_inquiry workflow with no owner-check REPLY source still resolves to the plain availability kind (unrelated availability replies unaffected)", () => {
  const result = trustedFactsForCloudCompose({
    actionPlan: Object.freeze({
      actions: Object.freeze([
        Object.freeze({
          type: "REPLY",
          payload: Object.freeze({ itemId: "car_corolla", source: "canonical_verified_availability" }),
        }),
      ]),
    }),
    workflowType: "availability_inquiry",
    semanticIntent: "pricing_with_duration",
    resolvedBusinessTurnContext: {
      resolvedItem: { id: "car_corolla", displayLabel: "Corolla", customerReference: "Corolla" },
      verified: {
        pricing: { daily: 8000, currency: "PKR" },
        priceQuote: { total: 72000, durationDays: 9 },
      },
      turn: { durationDays: 9 },
    },
  });
  assert.equal(result.dailyRate, 8000, "non-owner-check availability replies keep their existing pricing-fact behavior");
});
