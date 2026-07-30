import test from "node:test";
import assert from "node:assert/strict";

const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

const ITEM_ID = "test-stonic-item";

function contract() {
  return {
    channel: "dm",
    allowedClaims: [],
    forbiddenClaims: [],
    replyRequired: true,
    verifiedCustomerFacts: {
      bookingExecutionVerified: true,
      customerMessageText: "Kitny din k lye book ki h?",
      itemId: ITEM_ID,
      itemLabel: "Kia Stonic",
      durationDays: 4,
      totalAmount: 22000,
      dailyRate: 5500,
      advanceAmount: 10000,
      catalogItems: [
        {
          id: ITEM_ID,
          name: "Kia Stonic",
          aliases: ["Stonic"],
        },
      ],
      activeBookings: [],
      pendingAvailabilityRequests: [],
    },
  };
}

function semantics() {
  return {
    claims: [],
    languageStyle: "roman_urdu",
    containsTimingPromise: false,
    exposesInternalProcess: false,
  };
}

function captureErrors(run) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args);
  try {
    return { result: run(), entries };
  } finally {
    console.error = original;
  }
}

test("logs reply-text price mismatch subtype without raw reply content", () => {
  const { result, entries } = captureErrors(() =>
    validateCustomerReplyAgainstContract(
      "Kia Stonic 4 din ke liye book hai. Total Rs 40000 hai.",
      contract(),
      semantics(),
      {
        itemId: ITEM_ID,
        durationDays: 4,
        totalAmount: null,
        dailyRate: null,
        advanceAmount: null,
        policyClaims: [],
      }
    )
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "verified_price_mismatch",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "[verified_price_mismatch_diagnostic]");
  assert.deepEqual(entries[0][1], {
    failureReason: "verified_price_mismatch",
    mismatchSource: "reply_text",
    mismatchField: "explicitMoneyAmount",
    actualNumericValue: 40000,
    allowedVerifiedValues: [5500, 10000, 22000],
  });
  const serialized = JSON.stringify(entries[0][1]);
  assert.doesNotMatch(serialized, /Kia|Stonic|Kitny|book ki h/i);
});

test("logs grounded-facts price mismatch field without raw model content", () => {
  const { result, entries } = captureErrors(() =>
    validateCustomerReplyAgainstContract(
      "Kia Stonic 4 din ke liye book hai.",
      contract(),
      semantics(),
      {
        itemId: ITEM_ID,
        durationDays: 4,
        totalAmount: 40000,
        dailyRate: null,
        advanceAmount: null,
        policyClaims: [],
      }
    )
  );

  assert.deepEqual(result, {
    ok: false,
    reason: "verified_price_mismatch",
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "[verified_price_mismatch_diagnostic]");
  assert.deepEqual(entries[0][1], {
    failureReason: "verified_price_mismatch",
    mismatchSource: "grounded_facts",
    mismatchField: "totalAmount",
    actualNumericValue: 40000,
    allowedVerifiedValues: [22000],
  });
  const serialized = JSON.stringify(entries[0][1]);
  assert.doesNotMatch(serialized, /Kia|Stonic|Kitny|book ki h/i);
});

test("matching verified price keeps guard behavior and emits no diagnostic", () => {
  const { result, entries } = captureErrors(() =>
    validateCustomerReplyAgainstContract(
      "Kia Stonic 4 din ke liye book hai. Total Rs 22000 hai.",
      contract(),
      semantics(),
      {
        itemId: ITEM_ID,
        durationDays: 4,
        totalAmount: 22000,
        dailyRate: null,
        advanceAmount: null,
        policyClaims: [],
      }
    )
  );

  assert.equal(result.ok, true);
  assert.deepEqual(entries, []);
});
