import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailabilityContextSkeleton,
  composeStructuredAvailabilityCustomerReply,
  enforceAvailabilityTruthOnReply,
  pickPriceDailyFromCatalogRow,
} from "../src/services/availabilityContext.js";

test("pickPriceDailyFromCatalogRow reads common fields", () => {
  assert.equal(pickPriceDailyFromCatalogRow({ dailyRate: "5000" }), "5000");
  assert.equal(pickPriceDailyFromCatalogRow({ attributes: { price: "4500" } }), "4500");
});

test("item unavailable + verified alternatives lists only top items (Urdu)", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "a1",
      displayLabel: "Alpha Sedan 2020",
      availabilityStatus: "unavailable",
      blockingReason: "ALREADY_BOOKED",
    },
    inventorySummary: {
      status: "fresh",
      totalItems: 10,
      availableCount: 2,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Beta SUV 2021", priceDaily: null, category: null, tags: [] },
        { itemId: "c1", displayLabel: "Gamma Hatch 2019", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const out = composeStructuredAvailabilityCustomerReply(ctx, "casual_local");
  assert.match(out, /Alpha Sedan 2020.*abhi available nahi hai/i);
  assert.match(out, /Beta SUV 2021/);
  assert.match(out, /Gamma Hatch 2019/);
  assert.doesNotMatch(out, /koi aur option dekhna chahenge/i);
});

test("item unavailable + zero others (fresh summary)", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "a1",
      displayLabel: "Alpha Sedan 2020",
      availabilityStatus: "unavailable",
    },
    inventorySummary: {
      status: "fresh",
      totalItems: 4,
      availableCount: 0,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const out = composeStructuredAvailabilityCustomerReply(ctx, "casual_local");
  assert.match(out, /Filhaal koi aur option bhi available nahi hai/i);
});

test("item unavailable + missing summary does not claim zero global stock", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "a1",
      displayLabel: "Alpha Sedan 2020",
      availabilityStatus: "unavailable",
    },
    inventorySummary: {
      status: "missing",
      totalItems: 0,
      availableCount: 0,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const out = composeStructuredAvailabilityCustomerReply(ctx, "casual_local");
  assert.match(out, /available options check karun/i);
  assert.doesNotMatch(out, /Filhaal koi aur option bhi available nahi/i);
});

test("browse: many available (fresh) shows count + top picks", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 12,
      availableCount: 12,
      topAvailableItems: [
        { itemId: "1", displayLabel: "One", priceDaily: null, category: null, tags: [] },
        { itemId: "2", displayLabel: "Two", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const out = composeStructuredAvailabilityCustomerReply(ctx, "casual_local");
  assert.match(out, /12 options available/);
  assert.match(out, /One/);
  assert.match(out, /Two/);
});

test("browse: zero available", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 3,
      availableCount: 0,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const out = composeStructuredAvailabilityCustomerReply(ctx, "casual_local");
  assert.match(out, /koi option available nahi/i);
});

test("enforceAvailabilityTruthOnReply corrects false global when summary missing", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "x",
      displayLabel: "Zed Model",
      availabilityStatus: "unavailable",
    },
    inventorySummary: {
      status: "missing",
      totalItems: 0,
      availableCount: 0,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
    policy: {},
  });
  const bad =
    "Sorry, Zed Model nahi hai. Filhaal koi aur gari bhi available nahi maujood.";
  const fixed = enforceAvailabilityTruthOnReply(bad, ctx, "casual_local");
  assert.notEqual(fixed, bad);
  assert.match(fixed, /check karun/i);
});
