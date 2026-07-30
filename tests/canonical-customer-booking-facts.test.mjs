import test from "node:test";
import assert from "node:assert/strict";

const { compactBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);

test("trusted linked availability fills every missing customer-safe booking fact", () => {
  const booking = {
    id: "booking-stonic",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    availabilityRequestId: "avr-stonic",
  };
  const availabilityRequest = {
    id: "avr-stonic",
    itemId: "item-stonic",
    itemLabel: "Kia Stonic",
    requestedDuration: 4,
    priceQuote: { total: 22000, dailyRate: 5500 },
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    pickupTime: "10am",
    deliveryTime: "6pm",
    deliveryMethod: "pickup",
    deliveryAddress: "Blue Area",
  };

  const facts = compactBookingFacts(booking, availabilityRequest);

  assert.deepEqual(
    {
      itemId: facts.itemId,
      itemLabel: facts.itemLabel,
      durationDays: facts.durationDays,
      totalAmount: facts.totalAmount,
      dailyRate: facts.dailyRate,
      startDate: facts.startDate,
      endDate: facts.endDate,
      pickupTime: facts.pickupTime,
      deliveryTime: facts.deliveryTime,
      deliveryMethod: facts.deliveryMethod,
      deliveryAddress: facts.deliveryAddress,
      availabilityRequestId: facts.availabilityRequestId,
      priceQuote: facts.priceQuote,
    },
    {
      itemId: "item-stonic",
      itemLabel: "Kia Stonic",
      durationDays: 4,
      totalAmount: 22000,
      dailyRate: 5500,
      startDate: "2026-08-01",
      endDate: "2026-08-05",
      pickupTime: "10am",
      deliveryTime: "6pm",
      deliveryMethod: "pickup",
      deliveryAddress: "Blue Area",
      availabilityRequestId: "avr-stonic",
      priceQuote: { total: 22000, dailyRate: 5500 },
    }
  );
});

test("verified booking values win over linked availability fallback values", () => {
  const booking = {
    id: "booking-stonic",
    itemId: "booking-item",
    itemLabel: "Booking Item",
    durationDays: 6,
    totalAmount: 30000,
    dailyRate: 5000,
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    pickupTime: "9am",
    deliveryTime: "5pm",
    deliveryMethod: "delivery",
    deliveryAddress: "F-7",
    availabilityRequestId: "avr-stonic",
  };
  const availabilityRequest = {
    id: "avr-stonic",
    itemId: "avr-item",
    itemLabel: "AVR Item",
    requestedDuration: 4,
    priceQuote: { total: 22000, dailyRate: 5500 },
    startDate: "2026-08-01",
    endDate: "2026-08-05",
    pickupTime: "10am",
    deliveryTime: "6pm",
    deliveryMethod: "pickup",
    deliveryAddress: "Blue Area",
  };

  const facts = compactBookingFacts(booking, availabilityRequest);

  assert.equal(facts.itemId, "booking-item");
  assert.equal(facts.itemLabel, "Booking Item");
  assert.equal(facts.durationDays, 6);
  assert.equal(facts.totalAmount, 30000);
  assert.equal(facts.dailyRate, 5000);
  assert.equal(facts.startDate, "2026-09-01");
  assert.equal(facts.endDate, "2026-09-07");
  assert.equal(facts.pickupTime, "9am");
  assert.equal(facts.deliveryTime, "5pm");
  assert.equal(facts.deliveryMethod, "delivery");
  assert.equal(facts.deliveryAddress, "F-7");
  assert.deepEqual(facts.priceQuote, { total: 30000, dailyRate: 5000 });
});

test("missing numbers stay null while explicit verified zero is preserved", () => {
  const missing = compactBookingFacts({ id: "missing" }, null);
  assert.equal(missing.totalAmount, null);
  assert.equal(missing.dailyRate, null);
  assert.equal(missing.durationDays, null);
  assert.equal(missing.priceQuote, null);

  const zero = compactBookingFacts({
    id: "zero",
    totalAmount: 0,
    dailyRate: 0,
    durationDays: 1,
  });
  assert.equal(zero.totalAmount, 0);
  assert.equal(zero.dailyRate, 0);
  assert.equal(zero.durationDays, 1);
  assert.deepEqual(zero.priceQuote, { total: 0, dailyRate: 0 });
});
