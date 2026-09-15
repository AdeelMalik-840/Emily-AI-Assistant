import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  resolveExpectedRentalDurationUnit,
  resolveDurationAskReplyMeaning,
  DURATION_ASK_MISSING_FIELD,
  DURATION_ASK_SEMANTIC_SHAPE_FOR_PERIOD,
} = await import("../src/brain/policies/durationAskReplyMeaning.js");
const { buildCustomerReplyPolicy } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { buildCanonicalGroupResponseContract } = await import(
  "../src/brain/contracts/canonicalGroupTurnContract.js"
);

test("Automotive / car-rental business policy resolves expectedUnit days", () => {
  assert.equal(resolveExpectedRentalDurationUnit({ businessType: "Automotive" }), "days");
  assert.equal(resolveExpectedRentalDurationUnit({ category: "car_rental" }), "days");
  assert.equal(
    resolveExpectedRentalDurationUnit({ category: "Car Rental" }),
    "days"
  );
});

test("unknown businesses do not invent days", () => {
  assert.equal(resolveExpectedRentalDurationUnit({ category: "spa" }), null);
  assert.equal(resolveExpectedRentalDurationUnit({}), null);
  assert.equal(resolveExpectedRentalDurationUnit(null), null);
});

test("duration_ask meaning is frozen only for that kind", () => {
  assert.equal(
    resolveDurationAskReplyMeaning({ kind: "temporal_clarification", business: { businessType: "Automotive" } }),
    null
  );
  const meaning = resolveDurationAskReplyMeaning({
    kind: "duration_ask",
    business: { businessType: "Automotive" },
  });
  assert.equal(meaning.missingField, DURATION_ASK_MISSING_FIELD);
  assert.equal(meaning.expectedUnit, "days");
  assert.equal(meaning.semanticShape, DURATION_ASK_SEMANTIC_SHAPE_FOR_PERIOD);
  assert.deepEqual(meaning.forbiddenMeaningDrift, ["vague_time", "clock_time", "start_date"]);
});

test("buildCustomerReplyPolicy consumes business policy and does not invent a unit", () => {
  const car = buildCustomerReplyPolicy("duration_ask", {
    itemId: "x",
    business: { businessType: "Automotive" },
  });
  assert.equal(car.replyMeaning.expectedUnit, "days");
  const spa = buildCustomerReplyPolicy("duration_ask", {
    itemId: "x",
    business: { category: "spa" },
  });
  assert.equal(spa.replyMeaning.expectedUnit, null);
  assert.equal(spa.replyMeaning.missingField, "rental_duration");
  const holding = buildCustomerReplyPolicy("owner_check_holding", {
    itemId: "x",
    business: { businessType: "Automotive" },
  });
  assert.equal(holding.replyMeaning, null);
});

test("group duration_ask contract consumes workflow-stamped meaning and does not invent days for other businesses", () => {
  const car = buildCanonicalGroupResponseContract({
    replyKind: "duration_ask",
    trustedCustomerFacts: {
      itemId: "x",
      business: { businessType: "Automotive" },
    },
  });
  assert.equal(car.replyMeaning.expectedUnit, "days");
  assert.equal(car.replyMeaning.semanticShape, "for_period");
  assert.equal(car.requestedInput, "rental_period");

  const spa = buildCanonicalGroupResponseContract({
    replyKind: "duration_ask",
    trustedCustomerFacts: {
      itemId: "x",
      business: { category: "spa" },
    },
  });
  assert.equal(spa.replyMeaning.expectedUnit, null);
  assert.equal(spa.requestedInput, "rental_period");

  const dates = buildCanonicalGroupResponseContract({
    replyKind: "temporal_clarification",
    trustedCustomerFacts: {
      itemId: "x",
      business: { businessType: "Automotive" },
    },
  });
  assert.equal(dates.replyMeaning, null);
  assert.equal(dates.requestedInput, "start_date");
});
