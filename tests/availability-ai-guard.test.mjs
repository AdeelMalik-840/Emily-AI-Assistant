import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailabilityContextSkeleton,
  composeStructuredAvailabilityCustomerReply,
} from "../src/services/availabilityContext.js";
import { guardAvailabilityAiReply } from "../src/services/availabilityAi.js";

function browseFreshCtx() {
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
    policy: { maxOptionsToMention: 2 },
    servicesOnlyBrowse: false,
  });
}

function itemUnavailableCtx() {
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
    policy: { maxOptionsToMention: 3 },
    alternativeSummarySkipped: false,
  });
}

test("guard: invented extra name → fallback matches composer", () => {
  const ctx = browseFreshCtx();
  const bad = "Label One available. PhantomExtraName999 also ready.";
  const g = guardAvailabilityAiReply(bad, ctx, "neutral_english");
  assert.equal(g.ok, false);
  const expected = composeStructuredAvailabilityCustomerReply(ctx, "neutral_english");
  assert.equal(g.reply, expected);
});

test("guard: requested unavailable described as available → fallback", () => {
  const ctx = itemUnavailableCtx();
  const bad = "Requested Label available hai. Pick one.";
  const g = guardAvailabilityAiReply(bad, ctx, "casual_local");
  assert.equal(g.ok, false);
});

test("guard: false no-options when availableCount > 0 → fallback", () => {
  const ctx = browseFreshCtx();
  const bad = "Sab options bilkul available nahi hain.";
  const g = guardAvailabilityAiReply(bad, ctx, "casual_local");
  assert.equal(g.ok, false);
});

test("guard: false no-options when summary missing → fallback", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
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
    policy: {},
    servicesOnlyBrowse: false,
  });
  const bad = "Sab options available nahi hain.";
  const g = guardAvailabilityAiReply(bad, ctx, "casual_local");
  assert.equal(g.ok, false);
});

test("guard: too many distinct top labels → fallback", () => {
  const ctx = browseFreshCtx();
  const bad = "Label One, Label Two, and Label One again.";
  const g = guardAvailabilityAiReply(bad, ctx, "neutral_english");
  assert.equal(g.ok, true);
  const ctx2 = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 10,
      availableCount: 5,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "1", displayLabel: "AA One", priceDaily: null, category: null, tags: [] },
        { itemId: "2", displayLabel: "BB Two", priceDaily: null, category: null, tags: [] },
        { itemId: "3", displayLabel: "CC Three", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: { maxOptionsToMention: 2 },
    servicesOnlyBrowse: false,
  });
  const bad2 = "AA One, BB Two, CC Three all here.";
  const g2 = guardAvailabilityAiReply(bad2, ctx2, "neutral_english");
  assert.equal(g2.ok, false);
});

test("guard: internal wording → fallback", () => {
  const ctx = browseFreshCtx();
  const bad = "Label One is ready per owner approval workflow.";
  const g = guardAvailabilityAiReply(bad, ctx, "neutral_english");
  assert.equal(g.ok, false);
});

test("guard: valid reply with only allowlisted names → pass", () => {
  const ctx = browseFreshCtx();
  const okText = "Label One aur Label Two dono available hain — kis ke liye dekhna hai?";
  const g = guardAvailabilityAiReply(okText, ctx, "casual_local");
  assert.equal(g.ok, true);
  assert.equal(g.reply, okText);
});

test("guard: empty AI → composer fallback", () => {
  const ctx = browseFreshCtx();
  const g = guardAvailabilityAiReply("   ", ctx, "neutral_english");
  assert.equal(g.ok, false);
  assert.equal(g.reply, composeStructuredAvailabilityCustomerReply(ctx, "neutral_english"));
});
