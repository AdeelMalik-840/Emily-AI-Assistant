import test from "node:test";
import assert from "node:assert/strict";

const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);

function verifiedFacts(overrides = {}) {
  return {
    bookingExecutionVerified: true,
    itemId: "item-stonic",
    itemLabel: "Kia Stonic",
    durationDays: 4,
    bookingStatus: "approved",
    bookingReference: "STONIC-4",
    totalAmount: 22000,
    dailyRate: 5500,
    advanceAmount: 5000,
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    pickupTime: "10am",
    deliveryTime: "6pm",
    knownPolicies: {},
    activeBookings: [],
    pendingAvailabilityRequests: [],
    catalogItems: [
      { id: "item-stonic", name: "Kia Stonic", aliases: ["Stonic"] },
      { id: "item-civic", name: "Honda Civic", aliases: ["Civic"] },
    ],
    ...overrides,
  };
}

function contract(facts = verifiedFacts(), overrides = {}) {
  return {
    channel: "dm",
    replyRequired: true,
    verifiedCustomerFacts: facts,
    allowedClaims: [],
    forbiddenClaims: [],
    requiredMeaning: "post_confirm_facts_or_silence",
    customerLanguageStyle: "roman_urdu",
    verifiedTiming: { hasVerifiedTime: false },
    ...overrides,
  };
}

function semantics(overrides = {}) {
  return {
    claims: [],
    languageStyle: "roman_urdu",
    containsTimingPromise: false,
    exposesInternalProcess: false,
    ...overrides,
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

test("one canonical contract accepts all verified booking details together", () => {
  const result = validateCustomerReplyAgainstContract(
    "Kia Stonic ki booking approved hai, ref STONIC-4, 4 din ke liye total 22000 PKR aur daily 5500 PKR hai. Dates 2026-08-01 se 2026-08-05, pickup 10am aur delivery 6pm hai.",
    contract(),
    semantics(),
    grounded({
      itemId: "item-stonic",
      durationDays: 4,
      bookingStatus: "approved",
      bookingReference: "STONIC-4",
      totalAmount: 22000,
      dailyRate: 5500,
      advanceAmount: 5000,
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      pickupTime: "10am",
      deliveryTime: "6pm",
    })
  );

  assert.deepEqual(result, { ok: true });
});

test("a different car is rejected against the selected canonical booking", () => {
  const result = validateCustomerReplyAgainstContract(
    "Honda Civic 4 din ke liye book hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-civic", durationDays: 4 })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "verified_item_mismatch");
});

test("wrong duration, status, and reference each fail their generic fact guard", () => {
  const duration = validateCustomerReplyAgainstContract(
    "Kia Stonic 5 din ke liye book hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", durationDays: 5 })
  );
  assert.equal(duration.reason, "verified_duration_mismatch");

  const status = validateCustomerReplyAgainstContract(
    "Kia Stonic ki booking cancelled hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", bookingStatus: "cancelled" })
  );
  assert.equal(status.reason, "verified_booking_status_mismatch");

  const reference = validateCustomerReplyAgainstContract(
    "Kia Stonic booking ref WRONG-9 hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", bookingReference: "WRONG-9" })
  );
  assert.equal(reference.reason, "verified_booking_reference_mismatch");
});

test("wrong dates and pickup or delivery times fail the shared guard", () => {
  const date = validateCustomerReplyAgainstContract(
    "Kia Stonic ki date 2026-08-02 hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", startDate: "2026-08-02" })
  );
  assert.equal(date.reason, "verified_booking_date_mismatch");

  const pickup = validateCustomerReplyAgainstContract(
    "Kia Stonic ka pickup 11am hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", pickupTime: "11am" })
  );
  assert.equal(pickup.reason, "verified_booking_time_mismatch");

  const delivery = validateCustomerReplyAgainstContract(
    "Kia Stonic ki delivery 7pm hai.",
    contract(),
    semantics(),
    grounded({ itemId: "item-stonic", deliveryTime: "7pm" })
  );
  assert.equal(delivery.reason, "verified_booking_time_mismatch");
});

test("missing monetary facts never become fake zero and unsupported money fails closed", () => {
  const facts = verifiedFacts({
    totalAmount: null,
    dailyRate: null,
    advanceAmount: null,
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const result = validateCustomerReplyAgainstContract(
      "Total 22000 PKR hai.",
      contract(facts),
      semantics(),
      grounded({ totalAmount: 22000 })
    );
    assert.equal(result.reason, "verified_price_mismatch");
  } finally {
    console.error = originalError;
  }

  const diagnostic = errors.find(
    ([event]) => event === "[verified_price_mismatch_diagnostic]"
  );
  assert.ok(diagnostic);
  assert.deepEqual(diagnostic[1].allowedVerifiedValues, []);
  assert.notDeepEqual(diagnostic[1].allowedVerifiedValues, [0]);
});

test("an explicit verified zero remains a valid fact", () => {
  const facts = verifiedFacts({ totalAmount: 0, dailyRate: null, advanceAmount: null });
  const result = validateCustomerReplyAgainstContract(
    "Total 0 PKR hai.",
    contract(facts),
    semantics(),
    grounded({ totalAmount: 0 })
  );
  assert.deepEqual(result, { ok: true });
});

test("declared item, duration, amount, date, or time fails when no verified fact exists", () => {
  const emptyFacts = verifiedFacts({
    itemId: null,
    itemLabel: null,
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
    catalogItems: [],
  });

  assert.equal(
    validateCustomerReplyAgainstContract(
      "Detail confirm hai.",
      contract(emptyFacts),
      semantics(),
      grounded({ itemId: "unverified-item" })
    ).reason,
    "verified_item_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Detail confirm hai.",
      contract(emptyFacts),
      semantics(),
      grounded({ durationDays: 4 })
    ).reason,
    "verified_duration_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Detail confirm hai.",
      contract(emptyFacts),
      semantics(),
      grounded({ totalAmount: 22000 })
    ).reason,
    "verified_price_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Detail confirm hai.",
      contract(emptyFacts),
      semantics(),
      grounded({ startDate: "2026-08-01" })
    ).reason,
    "verified_booking_date_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Detail confirm hai.",
      contract(emptyFacts),
      semantics(),
      grounded({ pickupTime: "10am" })
    ).reason,
    "verified_booking_time_mismatch"
  );
});

test("availability claims remain controlled by the same verified claim contract", () => {
  const blocked = validateCustomerReplyAgainstContract(
    "Kia Stonic available hai.",
    contract(verifiedFacts(), {
      forbiddenClaims: ["resource_availability_confirmed"],
    }),
    semantics({ claims: [] }),
    grounded({ itemId: "item-stonic" })
  );
  assert.equal(blocked.reason, "unsupported_availability_confirmed_claim");

  const allowed = validateCustomerReplyAgainstContract(
    "Kia Stonic available hai.",
    contract(verifiedFacts(), {
      allowedClaims: ["resource_availability_confirmed"],
    }),
    semantics({ claims: ["resource_availability_confirmed"] }),
    grounded({ itemId: "item-stonic" })
  );
  assert.deepEqual(allowed, { ok: true });
});
