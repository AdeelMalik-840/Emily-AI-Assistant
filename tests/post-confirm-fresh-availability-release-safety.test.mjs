import test from "node:test";
import assert from "node:assert/strict";

import { listExplicitCatalogItemIds } from "../src/services/currentTurnAuthority.js";
import { shouldReleasePostConfirmForFreshAvailability } from "../src/services/customerBusinessPaAgentService.js";

const COROLLA_ID = "toyota-corolla-metallic-grey";
const CIVIC_ID = "honda-civic";
const STONIC_ID = "kia-stonic";

const CATALOG = [
  {
    id: COROLLA_ID,
    name: "Toyota Corolla (Metallic Grey)",
    displayLabel: "Toyota Corolla (Metallic Grey)",
  },
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
];

function corollaFacts(overrides = {}) {
  return {
    booking: {
      id: "booking-corolla",
      itemId: COROLLA_ID,
      itemLabel: "Toyota Corolla (Metallic Grey)",
    },
    bookingFocus: {
      itemId: COROLLA_ID,
      itemLabel: "Toyota Corolla (Metallic Grey)",
    },
    replyGuardFacts: { catalogItems: CATALOG },
    ...overrides,
  };
}

function pr100Shape(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    targetContext: "NEW_TRANSACTION",
    targetId: null,
    factKind: "booking_fact",
    capability: "availability_request",
    action: "reply",
    mutationIntent: "none",
    pendingAvailabilitySelectionIndex: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    ...overrides,
  };
}

function release(decision, messageText, facts = corollaFacts()) {
  return shouldReleasePostConfirmForFreshAvailability(decision, {
    messageText,
    facts,
  });
}

test("listExplicitCatalogItemIds reuses explicit matcher (Stonic / compare / multi)", () => {
  assert.deepEqual(
    listExplicitCatalogItemIds("Stonic kal ke liye chahiye", CATALOG),
    [STONIC_ID]
  );
  assert.deepEqual(
    listExplicitCatalogItemIds(
      "Corolla ki jagah Civic mil sakti hai?",
      CATALOG
    ).sort(),
    [COROLLA_ID, CIVIC_ID].sort()
  );
  assert.deepEqual(
    listExplicitCatalogItemIds(
      "Civic aur Stonic dono kal ke liye chahiye",
      CATALOG
    ).sort(),
    [CIVIC_ID, STONIC_ID].sort()
  );
  assert.deepEqual(listExplicitCatalogItemIds("Pickup kahan se hogi?", CATALOG), []);
});

test("1) Stonic fresh → release true", () => {
  assert.equal(
    release(pr100Shape(), "Stonic kal ke liye chahiye"),
    true
  );
});

test("2) Civic fresh → release true", () => {
  assert.equal(
    release(pr100Shape(), "Honda Civic 5 din k lye chyh"),
    true
  );
});

test("3) Brain-owned old-booking compare scope → release false", () => {
  assert.equal(
    release(
      pr100Shape({
        turnScope: "OLD_BOOKING_REFERENCE",
        targetContext: "CONFIRMED_BOOKING",
        targetId: "booking-corolla",
      }),
      "Corolla ki jagah Civic mil sakti hai?"
    ),
    false
  );
});

test("4) Brain-owned multi-item fresh scope releases without text matching", () => {
  assert.equal(
    release(pr100Shape(), "Civic aur Stonic dono kal ke liye chahiye"),
    true
  );
});

test("5) same-item genuine fresh → release permitted when semantic shape valid", () => {
  assert.equal(
    release(pr100Shape(), "Corolla 5 din ke liye new request"),
    true
  );
});

test("6) catalog availability is not semantic ownership authority", () => {
  assert.equal(
    release(
      pr100Shape(),
      "Stonic kal ke liye chahiye",
      corollaFacts({ replyGuardFacts: {} })
    ),
    true
  );
  assert.equal(
    release(
      pr100Shape(),
      "Stonic kal ke liye chahiye",
      corollaFacts({ replyGuardFacts: { catalogItems: [] } })
    ),
    true
  );
});

test("7) stale focused + single other item (Stonic) → release true", () => {
  assert.equal(
    release(
      pr100Shape({
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      }),
      "Stonic kal ke liye chahiye"
    ),
    true
  );
});

test("8) stale focused + selectedBookingIndex + Civic → release true", () => {
  assert.equal(
    release(
      pr100Shape({
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      }),
      "Honda Civic 5 din k lye chyh"
    ),
    true
  );
});

test("9) pickup / genuine booking question shape → release false", () => {
  assert.equal(
    release(
      {
        factKind: "booking_fact",
        capability: "answer_from_active_booking",
        action: "reply",
        mutationIntent: "none",
        pendingAvailabilitySelectionIndex: null,
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      },
      "Pickup kahan se hogi?"
    ),
    false
  );
});

test("10) compare is blocked when Brain selects old-booking scope", () => {
  assert.equal(
    release(
      pr100Shape({
        turnScope: "OLD_BOOKING_REFERENCE",
        targetContext: "CONFIRMED_BOOKING",
        targetId: "booking-corolla",
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      }),
      "Corolla ki jagah Civic mil sakti hai?"
    ),
    false
  );
});

test("11) change_item mutation → release false", () => {
  assert.equal(
    release(
      {
        factKind: "action",
        capability: "mutation_requested",
        action: "request_booking_mutation",
        mutationIntent: "change_item",
        pendingAvailabilitySelectionIndex: null,
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      },
      "Civic instead of my current one"
    ),
    false
  );
});

test("12) pending AVR semantic scope is not fresh-availability release", () => {
  assert.equal(
    release(
      pr100Shape({
        turnScope: "PENDING_AVAILABILITY_REFERENCE",
        targetContext: "PENDING_AVAILABILITY",
        targetId: "avr-1",
        pendingAvailabilitySelectionIndex: 1,
      }),
      "Stonic kal ke liye chahiye"
    ),
    false
  );
});

test("13) stale selection fields cannot override Brain new-transaction scope", () => {
  assert.equal(
    release(
      pr100Shape({
        bookingSelectionMode: "focused",
        selectedBookingIndex: 1,
      }),
      "Corolla 5 din ke liye new request"
    ),
    true
  );
});

test("message text and booked item ID are not semantic ownership inputs", () => {
  assert.equal(
    shouldReleasePostConfirmForFreshAvailability(pr100Shape(), {
      messageText: "",
      facts: corollaFacts(),
    }),
    true
  );
  assert.equal(
    release(
      pr100Shape(),
      "Stonic kal ke liye chahiye",
      corollaFacts({
        booking: { id: "booking-corolla" },
        bookingFocus: {},
      })
    ),
    true
  );
});
