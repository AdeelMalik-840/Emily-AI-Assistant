import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailabilityContextSkeleton,
  composeStructuredAvailabilityCustomerReply,
} from "../src/services/availabilityContext.js";
import { isAvailabilityAiEligible } from "../src/services/availabilityAi.js";

function baseBrowseCtx(overrides = {}) {
  return buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 5,
      availableCount: 3,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Label One", priceDaily: null, category: null, tags: [] },
        { itemId: "b2", displayLabel: "Label Two", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: {},
    servicesOnlyBrowse: false,
    ...overrides,
  });
}

function baseItemUnavailableCtx(overrides = {}) {
  return buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "a1",
      displayLabel: "Requested Label",
      availabilityStatus: "unavailable",
      blockingReason: "ALREADY_BOOKED",
    },
    inventorySummary: {
      status: "fresh",
      totalItems: 8,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Label One", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: {},
    alternativeSummarySkipped: false,
    ...overrides,
  });
}

test("Case A: unavailable + fresh alternatives + tops = eligible", () => {
  const e = isAvailabilityAiEligible(baseItemUnavailableCtx());
  assert.equal(e.eligible, true);
  assert.equal(e.caseId, "A");
});

test("Case D: browse fresh + count + tops = eligible", () => {
  const e = isAvailabilityAiEligible(baseBrowseCtx());
  assert.equal(e.eligible, true);
  assert.equal(e.caseId, "D");
});

test("not eligible when availableCount = 0", () => {
  const ctx = baseBrowseCtx({
    inventorySummary: {
      status: "fresh",
      totalItems: 2,
      availableCount: 0,
      unavailableCount: null,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
  });
  const e = isAvailabilityAiEligible(ctx);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /INELIGIBLE_ZERO/);
});

test("not eligible when summaryStatus missing", () => {
  const ctx = baseBrowseCtx({
    inventorySummary: {
      status: "missing",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Label One", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
  });
  const e = isAvailabilityAiEligible(ctx);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /NOT_FRESH/);
});

test("not eligible when summaryStatus stale", () => {
  const ctx = baseBrowseCtx({
    inventorySummary: {
      status: "stale",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Label One", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
  });
  const e = isAvailabilityAiEligible(ctx);
  assert.equal(e.eligible, false);
});

test("not eligible when alternativeSummarySkipped", () => {
  const e = isAvailabilityAiEligible(
    baseItemUnavailableCtx({ alternativeSummarySkipped: true })
  );
  assert.equal(e.eligible, false);
  assert.match(e.reason, /SKIPPED/);
});

test("not eligible when servicesOnlyBrowse", () => {
  const e = isAvailabilityAiEligible(baseBrowseCtx({ servicesOnlyBrowse: true }));
  assert.equal(e.eligible, false);
  assert.match(e.reason, /SERVICES_ONLY/);
});

test("not eligible when topAvailableItems empty", () => {
  const ctx = baseBrowseCtx({
    inventorySummary: {
      status: "fresh",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [],
      maxItemsShown: 5,
    },
  });
  const e = isAvailabilityAiEligible(ctx);
  assert.equal(e.eligible, false);
  assert.match(e.reason, /NO_TOP/);
});

test("composer-only contexts still produce structured copy", () => {
  const ctx = baseBrowseCtx({
    inventorySummary: {
      status: "missing",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "b1", displayLabel: "Label One", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
  });
  assert.equal(isAvailabilityAiEligible(ctx).eligible, false);
  const out = composeStructuredAvailabilityCustomerReply(ctx, "neutral_english");
  assert.match(out, /can.?t confirm|check/i);
});
