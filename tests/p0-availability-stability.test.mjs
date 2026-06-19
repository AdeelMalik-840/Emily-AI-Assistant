import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  __collectDurationSelectionGuardForTests,
  __buildCollectDurationAvailabilityUnknownReplyForTests,
  __composeBookingUnavailableItemAvailabilityContextReplyForTests,
} = await import("../src/services/messageProcessor.js");

const sampleItemAvailable = {
  id: "item-alpha-1",
  itemId: "item-alpha-1",
  name: "Alpha Sedan 2020",
  isAvailable: true,
};

const sampleItemUnavailable = {
  id: "item-alpha-1",
  itemId: "item-alpha-1",
  name: "Alpha Sedan 2020",
  isAvailable: false,
};

const sampleItemUnknown = {
  id: "item-alpha-1",
  itemId: "item-alpha-1",
  name: "Alpha Sedan 2020",
};

const altContextBase = {
  route: "INFORMATIONAL_QUESTION",
  isAlternativeContext: true,
  hasParticipantSession: true,
};

test("collect_duration guard: verified available passes", () => {
  const d = __collectDurationSelectionGuardForTests({
    message: "alpha",
    item: sampleItemAvailable,
    ...altContextBase,
  });
  assert.equal(d.ok, true);
  assert.equal(d.reason, "OK");
  assert.equal(d.availabilityStatus, "available");
});

test("collect_duration guard: unavailable rejected", () => {
  const d = __collectDurationSelectionGuardForTests({
    message: "alpha",
    item: sampleItemUnavailable,
    ...altContextBase,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "ITEM_UNAVAILABLE");
});

test("collect_duration guard: unknown availability rejected (no available hai)", () => {
  const d = __collectDurationSelectionGuardForTests({
    message: "alpha",
    item: sampleItemUnknown,
    ...altContextBase,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, "AVAILABILITY_UNKNOWN");
  assert.equal(d.availabilityStatus, "unknown");
});

test("collect_duration unknown reply does not assert available", () => {
  const t = __buildCollectDurationAvailabilityUnknownReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    style: "casual_local",
  });
  assert.match(t, /confirm/i);
  assert.doesNotMatch(t, /\bavailable hai\b/i);
  assert.doesNotMatch(t, /Kitne time/i);
});

test("structured composer: zero alternatives uses no-other-options line not browse ask", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-alpha-1",
    blockingStatusesSeen: ["ALREADY_BOOKED"],
    alternativeItems: [],
    alternativeSummarySkipped: false,
    catalogLength: 3,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [],
  });
  assert.match(reply, /Filhaal koi aur option bhi available nahi hai/i);
  assert.doesNotMatch(reply, /dekhna chahenge/i);
});

test("structured composer: alternatives listed without false global no-options", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-alpha-1",
    blockingStatusesSeen: ["ALREADY_BOOKED"],
    alternativeItems: [{ id: "item-beta-1", name: "Beta Hatch 2021" }],
    alternativeSummarySkipped: false,
    catalogLength: 3,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [
      { id: "item-beta-1", name: "Beta Hatch 2021" },
    ],
  });
  assert.match(reply, /Lekin/i);
  assert.match(reply, /Beta Hatch/i);
  assert.doesNotMatch(reply, /Filhaal koi aur option bhi available nahi hai/i);
});

test("structured composer: summary missing uses neutral check-options copy", () => {
  const { reply } = __composeBookingUnavailableItemAvailabilityContextReplyForTests({
    itemLabel: "Alpha Sedan 2020",
    reqId: "item-alpha-1",
    blockingStatusesSeen: ["ALREADY_BOOKED"],
    alternativeItems: [],
    alternativeSummarySkipped: true,
    catalogLength: 500,
    styleKey: "casual_local",
    normalizedCatalogForTurn: [],
  });
  assert.match(reply, /available options check karun/i);
  assert.doesNotMatch(reply, /Filhaal koi aur option bhi available nahi hai/i);
});
