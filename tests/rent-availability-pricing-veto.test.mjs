/**
 * Live defect: "civic 3 maheeny k lye mil jye ge rent p ?" is a rental
 * availability ask with duration, not a monetary price ask. The ownership
 * model sometimes labeled it pricing_with_duration and Emily answered with a
 * bare daily rate. Deterministic veto: rent+availability compounds without
 * an explicit amount ask stay availability_inquiry.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  parseCloudDmOwnershipDecision,
  applyRentAvailabilityPricingWithDurationVeto,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const { extractTurnSignals } = await import(
  "../src/services/intentShapeResolver.js"
);

const CATALOG = [
  {
    id: "honda_civic_2026_oriel",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel",
  },
];

function decisionJson(message, overrides = {}) {
  const civicAt = message.toLowerCase().indexOf("civic");
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "pricing_with_duration",
    itemScope: "specific",
    itemReferents:
      civicAt >= 0
        ? [
            {
              source: "current_turn",
              surfaceText: message.slice(civicAt, civicAt + 5),
              start: civicAt,
              end: civicAt + 5,
              trustedItemId: null,
              sourceTurnId: null,
            },
          ]
        : [],
    itemReferenceMode: civicAt >= 0 ? "CURRENT_TURN" : "NONE",
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    temporalRequest: { startDateKind: "none", startDate: null, evidence: null },
    requestedDuration: {
      status: "exact",
      components: [{ value: 3, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "3 maheeny" },
    },
    intentSwitchEvidence: null,
    ...overrides,
  };
}

test("signals: mil jye ge rent p is rent-availability compound, not priceAsk", () => {
  const signals = extractTurnSignals({
    message: "civic 3 maheeny k lye mil jye ge rent p ?",
  });
  assert.equal(signals.rentAvailabilityCompound, true);
  assert.equal(signals.availabilityAsk, true);
  assert.equal(signals.priceAsk, false);
});

test("veto: adversarial pricing_with_duration on mil jye ge rent p becomes availability", () => {
  assert.equal(
    applyRentAvailabilityPricingWithDurationVeto({
      semanticIntent: "pricing_with_duration",
      customerMessage: "civic 3 maheeny k lye mil jye ge rent p ?",
    }),
    "availability_inquiry"
  );
});

test("parse: adversarial pricing_with_duration on live Civic availability wording demotes", () => {
  const message = "civic 3 maheeny k lye mil jye ge rent p ?";
  const parsed = parseCloudDmOwnershipDecision(JSON.stringify(decisionJson(message)), {
    customerMessage: message,
    catalogItems: CATALOG,
  });
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "availability_inquiry");
});

test("veto does not touch explicit monetary duration price asks", () => {
  const message = "Civic 3 din ka rent kitna hoga?";
  assert.equal(
    applyRentAvailabilityPricingWithDurationVeto({
      semanticIntent: "pricing_with_duration",
      customerMessage: message,
    }),
    "pricing_with_duration"
  );
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(
      decisionJson(message, {
        requestedDuration: {
          status: "exact",
          components: [{ value: 3, unit: "days" }],
          evidence: { source: "current_turn", surfaceText: "3 din" },
        },
      })
    ),
    { customerMessage: message, catalogItems: CATALOG }
  );
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "pricing_with_duration");
});

test("veto leaves elliptical 'ka rent?' pricing alone (no availability verb)", () => {
  assert.equal(
    applyRentAvailabilityPricingWithDurationVeto({
      semanticIntent: "pricing_with_duration",
      customerMessage: "Civic 3 din ka rent?",
    }),
    "pricing_with_duration"
  );
});

test("veto leaves non-pricing intents unchanged", () => {
  assert.equal(
    applyRentAvailabilityPricingWithDurationVeto({
      semanticIntent: "booking_request",
      customerMessage: "civic 3 maheeny k lye mil jye ge rent p ?",
    }),
    "booking_request"
  );
  assert.equal(
    applyRentAvailabilityPricingWithDurationVeto({
      semanticIntent: "availability_inquiry",
      customerMessage: "civic 3 maheeny k lye mil jye ge rent p ?",
    }),
    "availability_inquiry"
  );
});
