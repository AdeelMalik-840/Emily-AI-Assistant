import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  __buildBookingDurationUnavailableStructuredCustomerReplyForTests,
  __composeBookingUnavailableItemAvailabilityContextReplyForTests,
} from "../src/services/messageProcessor.js";

const rowA = { id: "item-a-1", name: "Alpha Sedan 2020" };
const rowB = { id: "item-b-1", name: "Beta Hatch 2021" };

test("composer: unavailable + fresh zero alternatives → Filhaal line, not old browse ask", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-a-1",
    blockingStatusesSeen: ["approved"],
    alternativeItems: [],
    alternativeSummarySkipped: false,
    catalogLength: 1,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [rowA],
  });
  assert.match(reply, /Filhaal koi aur option bhi available nahi hai/i);
  assert.doesNotMatch(reply, /koi aur option dekhna chahenge/i);
});

test("composer: unavailable + verified alternatives → Lekin list + Kis option", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-a-1",
    blockingStatusesSeen: ["approved"],
    alternativeItems: [
      { id: "item-b-1", name: "Beta Hatch 2021" },
    ],
    alternativeSummarySkipped: false,
    catalogLength: 2,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [rowA, rowB],
  });
  assert.match(reply, /Lekin/i);
  assert.match(reply, /Beta Hatch 2021/);
  assert.match(reply, /Kis option ke liye chahiye/i);
  assert.doesNotMatch(reply, /koi aur option dekhna chahenge/i);
});

test("composer: unavailable + summary missing (skipped) → neutral check, no global no-options claim", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-a-1",
    blockingStatusesSeen: ["approved"],
    alternativeItems: [],
    alternativeSummarySkipped: true,
    catalogLength: 500,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [rowA],
  });
  assert.match(reply, /available options check karun/i);
  assert.doesNotMatch(reply, /Filhaal koi aur option bhi available nahi hai/i);
});

test("composer: English unavailable + zero alternatives", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-a-1",
    blockingStatusesSeen: ["approved"],
    alternativeItems: [],
    alternativeSummarySkipped: false,
    catalogLength: 1,
    styleKey: "neutral_english",
    normalizedCatalogForTurn: [rowA],
  });
  assert.match(reply, /don.?t see any other available options/i);
  assert.doesNotMatch(reply, /Would you like to check another option/i);
});

test("booking helper: oversized catalog skips alt scan → missing-style reply (no pickAlternative)", async () => {
  const huge = Array.from({ length: 401 }, (_, i) => ({
    id: `fill-${i}`,
    name: `Filler Model ${i}`,
  }));
  huge[0] = rowA;
  const reply = await __buildBookingDurationUnavailableStructuredCustomerReplyForTests({
    userId: "test-user-no-db",
    catalogRow: rowA,
    availabilitySnapshot: { isAvailable: false, blockingStatusesSeen: ["approved"] },
    normalizedCatalogForTurn: huge,
    styleKey: "casual_local",
    traceId: "trace-huge-catalog",
  });
  assert.match(String(reply), /check karun|check what/i);
  assert.doesNotMatch(String(reply), /koi aur option dekhna chahenge/i);
});

test("booking_blocked logKind: oversized catalog still yields neutral structured reply", async () => {
  const huge = Array.from({ length: 401 }, (_, i) => ({
    id: `fill-${i}`,
    name: `Filler Model ${i}`,
  }));
  huge[0] = rowA;
  const reply = await __buildBookingDurationUnavailableStructuredCustomerReplyForTests({
    userId: "test-user-no-db",
    catalogRow: rowA,
    availabilitySnapshot: { blockingStatusesSeen: ["approved"] },
    normalizedCatalogForTurn: huge,
    styleKey: "casual_local",
    traceId: "trace-blocked",
    logKind: "booking_blocked",
  });
  assert.match(String(reply), /check karun/i);
  assert.doesNotMatch(String(reply), /koi aur option dekhna chahenge/i);
});
