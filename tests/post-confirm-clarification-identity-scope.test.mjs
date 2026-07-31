import test from "node:test";
import assert from "node:assert/strict";

const { buildPostConfirmPaReplyContract } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

const catalogItems = [
  { id: "civic-2026", name: "Honda Civic 2026", aliases: ["Civic"] },
  { id: "corolla-grey", name: "Toyota Corolla", aliases: ["Corolla"] },
];

function clarificationFacts() {
  return {
    booking: null,
    activeBookings: [],
    bookingCandidates: [
      {
        selectionIndex: 1,
        itemId: "civic-2026",
        itemLabel: "Honda Civic 2026",
        customerSafeReference: "REF-A",
        status: "approved",
        durationDays: 3,
        totalAmount: 15000,
        pickupTime: "10am",
      },
      {
        selectionIndex: 2,
        itemId: "corolla-grey",
        itemLabel: "Toyota Corolla",
        customerSafeReference: "REF-B",
        status: "approved",
        durationDays: 2,
        totalAmount: 12000,
        pickupTime: "11am",
      },
    ],
    known: {},
    replyGuardFacts: {
      catalogItems,
      activeBookings: [],
      bookingSelectionRequired: true,
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
      ambiguousBookingSelection: true,
    },
  };
}

const semantics = {
  claims: [],
  languageStyle: "roman_urdu",
  containsTimingPromise: false,
  exposesInternalProcess: false,
};

const emptyGrounding = {
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
};

test("clarification contract exposes verified candidate identities only", () => {
  const contract = buildPostConfirmPaReplyContract(clarificationFacts());

  assert.equal(contract.verifiedCustomerFacts.bookingSelectionRequired, false);
  assert.deepEqual(contract.verifiedCustomerFacts.activeBookings, [
    {
      itemId: "civic-2026",
      itemLabel: "Honda Civic 2026",
      bookingReference: "REF-A",
    },
    {
      itemId: "corolla-grey",
      itemLabel: "Toyota Corolla",
      bookingReference: "REF-B",
    },
  ]);
  for (const row of contract.verifiedCustomerFacts.activeBookings) {
    assert.equal("durationDays" in row, false);
    assert.equal("totalAmount" in row, false);
    assert.equal("bookingStatus" in row, false);
    assert.equal("startDate" in row, false);
    assert.equal("pickupTime" in row, false);
  }

  const result = validateCustomerReplyAgainstContract(
    "Civic REF-A ya Corolla REF-B—kis booking ki detail chahiye?",
    { ...contract, replyRequired: true },
    semantics,
    emptyGrounding
  );
  assert.deepEqual(result, { ok: true });
});

test("clarification still blocks unselected booking details", () => {
  const contract = buildPostConfirmPaReplyContract(clarificationFacts());

  const duration = validateCustomerReplyAgainstContract(
    "Civic REF-A 3 din ki booking hai ya Corolla REF-B?",
    { ...contract, replyRequired: true },
    semantics,
    { ...emptyGrounding, durationDays: 3 }
  );
  assert.equal(duration.ok, false);
  assert.equal(duration.reason, "verified_duration_mismatch");

  const amount = validateCustomerReplyAgainstContract(
    "Civic REF-A ka total 15000 PKR hai ya Corolla REF-B?",
    { ...contract, replyRequired: true },
    semantics,
    { ...emptyGrounding, totalAmount: 15000 }
  );
  assert.equal(amount.ok, false);
  assert.equal(amount.reason, "verified_price_mismatch");
});
