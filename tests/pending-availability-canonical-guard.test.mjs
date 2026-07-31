import test from "node:test";
import assert from "node:assert/strict";

const { buildPostConfirmPaReplyContract } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

function semantics() {
  return {
    claims: ["resource_availability_confirmed", "quotation_verified"],
    languageStyle: "roman_urdu",
    containsTimingPromise: false,
    exposesInternalProcess: false,
  };
}

function grounded(overrides = {}) {
  return {
    itemId: null,
    durationDays: null,
    bookingStatus: null,
    bookingReference: null,
    totalAmount: null,
    dailyRate: null,
    advanceAmount: null,
    startDate: null,
    endDate: null,
    pickupTime: null,
    deliveryTime: null,
    policyClaims: [],
    ...overrides,
  };
}

function pendingFacts() {
  return {
    customerMessageText: "Stonic ki availability aur price bata den",
    pendingAvailabilityRequests: [
      {
        itemId: "item-stonic",
        itemLabel: "Kia Stonic",
        requestedDuration: 4,
        priceQuote: { total: 22000, dailyRate: 5500 },
        status: "approved",
        customerConfirmationStatus: "waiting_confirm",
      },
    ],
    replyGuardFacts: {
      catalogItems: [
        { id: "item-stonic", name: "Kia Stonic", aliases: ["Stonic"] },
      ],
      activeBookings: [],
      knownPolicies: {},
    },
  };
}

test("pending availability item, duration and nested price quote use the shared canonical guard", () => {
  const contract = buildPostConfirmPaReplyContract(pendingFacts());
  contract.replyRequired = true;
  contract.allowedClaims = [
    "resource_availability_confirmed",
    "quotation_verified",
  ];

  const accepted = validateCustomerReplyAgainstContract(
    "Kia Stonic 4 din ke liye available hai. Total 22000 PKR aur daily 5500 PKR hai.",
    contract,
    semantics(),
    grounded({
      itemId: "item-stonic",
      durationDays: 4,
      totalAmount: 22000,
      dailyRate: 5500,
    })
  );
  assert.deepEqual(accepted, { ok: true });

  const wrongDuration = validateCustomerReplyAgainstContract(
    "Kia Stonic 5 din ke liye available hai.",
    contract,
    semantics(),
    grounded({ itemId: "item-stonic", durationDays: 5 })
  );
  assert.equal(wrongDuration.reason, "verified_duration_mismatch");

  const wrongPrice = validateCustomerReplyAgainstContract(
    "Kia Stonic 4 din ke liye available hai. Total 23000 PKR hai.",
    contract,
    semantics(),
    grounded({
      itemId: "item-stonic",
      durationDays: 4,
      totalAmount: 23000,
    })
  );
  assert.equal(wrongPrice.reason, "verified_price_mismatch");
});
