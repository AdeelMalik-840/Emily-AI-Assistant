/**
 * Live defect: Group pricing compose delivered a bare verified daily-rate
 * numeral ("8000") because currency-marked money extraction skipped it and
 * PRESENT_VERIFIED_PRICE had no completeness check. Guard must reject
 * incomplete price presentation; same-act fallback must still be a full
 * customer-facing price sentence from trusted facts (no phrase/regex for
 * specific duration words).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);
const {
  GROUP_RESPONSE_ACTS,
  GROUP_UTTERANCE_FUNCTIONS,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const {
  sameActFallbackReply,
  buildCustomerReplyContract,
  CUSTOMER_CLAIMS,
} = await import("../src/brain/contracts/customerReplyContract.js");

const CIVIC_FACTS = Object.freeze({
  itemId: "honda_civic_2026_oriel",
  itemLabel: "Honda Civic 2026 Oriel",
  customerReference: "civic",
  dailyRate: 8000,
  monthlyRate: 192000,
  totalAmount: 720000,
  durationDays: 90,
  currency: "PKR",
});

function pricingContract(facts = CIVIC_FACTS) {
  return buildCustomerReplyContract({
    channel: "group",
    verifiedCustomerFacts: facts,
    allowedClaims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
    requiredClaims: [],
    customerInputRequired: false,
    requestedInput: null,
    requiredAct: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE,
    utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
    executionState: { availabilityCheckStarted: null },
  });
}

function priceExecutionFields() {
  return {
    customerInputRequested: false,
    requestedInput: null,
    availabilityCheckStarted: null,
    responseAct: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE,
    utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
  };
}

test("bare verified daily-rate numeral is rejected for PRESENT_VERIFIED_PRICE", () => {
  const result = validateCustomerReplyAgainstContract(
    "8000",
    pricingContract(),
    { claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] },
    null,
    priceExecutionFields()
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verified_price_presentation_incomplete");
});

test("digits-only total without currency/lexical material is rejected", () => {
  const result = validateCustomerReplyAgainstContract(
    "720,000",
    pricingContract(),
    { claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] },
    null,
    priceExecutionFields()
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verified_price_presentation_incomplete");
});

test("complete currency-marked verified price answer is accepted", () => {
  const result = validateCustomerReplyAgainstContract(
    "civic ki 90 din ki rent 720,000 PKR hogi (8,000 PKR per din).",
    pricingContract(),
    { claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] },
    null,
    priceExecutionFields()
  );
  assert.equal(result.ok, true);
});

test("pricing same-act fallback is a full sentence from trusted facts, never bare digits", () => {
  const withDuration = sameActFallbackReply("pricing_with_duration", CIVIC_FACTS);
  assert.match(withDuration, /720,000 PKR/);
  assert.match(withDuration, /8,000 PKR/);
  assert.match(withDuration, /\p{L}/u);
  assert.notEqual(withDuration.trim(), "8000");

  const dailyOnly = sameActFallbackReply("pricing", {
    itemLabel: "Honda Civic 2026 Oriel",
    dailyRate: 8000,
    monthlyRate: 192000,
  });
  assert.match(dailyOnly, /8,000 PKR/);
  assert.match(dailyOnly, /192,000 PKR/);
  assert.notEqual(dailyOnly.trim(), "8000");
});

test("non-pricing acts are unaffected by verified-price completeness", () => {
  const holding = validateCustomerReplyAgainstContract(
    "Main availability confirm kar rahi hoon.",
    buildCustomerReplyContract({
      channel: "group",
      verifiedCustomerFacts: {
        itemId: CIVIC_FACTS.itemId,
        itemLabel: CIVIC_FACTS.itemLabel,
        dailyRate: 8000,
      },
      allowedClaims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
      requiredClaims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
      customerInputRequired: false,
      requestedInput: null,
      requiredAct: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
      utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_STATUS,
      executionState: { availabilityCheckStarted: true },
    }),
    { claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED] },
    null,
    {
      customerInputRequested: false,
      requestedInput: null,
      availabilityCheckStarted: true,
      responseAct: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
      utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_STATUS,
    }
  );
  assert.equal(holding.ok, true);
});
