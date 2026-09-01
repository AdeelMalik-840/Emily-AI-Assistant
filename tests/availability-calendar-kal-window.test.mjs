/**
 * Narrow "kal" → tomorrow calendar window (Asia/Karachi fallback).
 * Duration requests must keep rolling now→now+Nd behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  resolveBusinessTurnContext,
  resolveAvailabilityCalendarRelative,
  resolveOwnerCheckAlignedDurationDays,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { resolveCalendarDateWindow } from "../src/brain/facts/resolveCalendarDateWindow.js";
import { resolveBookingDateWindowFromDuration } from "../src/brain/facts/resolveBookingDateWindow.js";
import { resolveAvailabilityOverlapWindow } from "../src/brain/facts/resolveItemBookingAwareAvailability.js";
import { isConfidentInventoryUnavailable } from "../src/brain/facts/resolveItemBookingAwareAvailability.js";

const BUSINESS_ID = "kal-calendar-biz";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
const STONIC_LABEL = "Kia Stonic EX Plus 2021 (White Color)";
const TZ = "Asia/Karachi";

/** 2026-08-07 12:00 Asia/Karachi */
const NOON_PKT_MS = Date.parse("2026-08-07T07:00:00.000Z");
/** 2026-08-07 23:50 Asia/Karachi — proves calendar ≠ +24h */
const NEAR_MIDNIGHT_PKT_MS = Date.parse("2026-08-07T18:50:00.000Z");

const CATALOG = [
  { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
];

async function resolveFacts({ message, bookings = [], duration = null, nowMs = NOON_PKT_MS }) {
  return resolveBusinessTurnContext({
    traceId: "kal-calendar",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs,
    getBookingsForItemFn: async () => bookings,
    __unavailableReplyForTests:
      "Kia Stonic EX Plus 2021 (White Color) abhi available nahi hai. Abhi koi aur option available nahi hai.",
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::905443829990`,
      participantKey: "905443829990",
      participantPhone: "905443829990",
      sourceMessageId: "wamid.kal-calendar",
      guaranteeKey: "wamid.kal-calendar",
      ...(duration != null ? { duration } : {}),
      authoritativeItem: { id: STONIC_ID, name: STONIC_LABEL },
    },
    turnContext: {
      sessionId: "kal-calendar-session",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::905443829990`,
      participantKey: "905443829990",
      schemaVersion: 1,
      lastResolvedItemId: STONIC_ID,
      memorySnapshot: {},
    },
    flags: {
      bookingExecute: false,
      ownerExecute: false,
      availabilityOwnerCheckExecute: true,
      availabilityOwnerNotifyExecute: true,
      availabilityCustomerDmExecute: false,
      dmExecute: false,
    },
  });
}

test("A: resolver + facts — kal noon PKT → tomorrow calendar absolute window", async () => {
  const resolved = resolveCalendarDateWindow({
    relative: "tomorrow",
    timeZone: TZ,
    nowMs: NOON_PKT_MS,
  });
  assert.ok(resolved);
  assert.equal(resolved.startAt.toISOString(), "2026-08-07T19:00:00.000Z");
  assert.equal(resolved.endAt.toISOString(), "2026-08-08T19:00:00.000Z");
  assert.equal(resolved.confidence, "calendar_relative");

  assert.equal(
    resolveAvailabilityCalendarRelative({
      normalizedMessage: "stonic kal ke liye chahiye",
    }),
    "tomorrow"
  );
  assert.equal(
    resolveOwnerCheckAlignedDurationDays({
      normalizedMessage: "stonic kal ke liye chahiye",
    }),
    1
  );

  const canonical = await resolveFacts({
    message: "Stonic kal ke liye chahiye",
    bookings: [],
    nowMs: NOON_PKT_MS,
  });
  const av = canonical.verified.availability;
  assert.equal(canonical.turn.durationDays ?? null, null);
  assert.equal(canonical.duration.calendarRelative, "tomorrow");
  assert.equal(av.windowApplied, true);
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-07T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-08T19:00:00.000Z");
  assert.equal(av.isAvailable, true);
});

test("B/C: 3 din ke liye keeps rolling duration_default_now", async () => {
  const rolled = resolveBookingDateWindowFromDuration(3, NOON_PKT_MS);
  assert.equal(rolled.startAt.toISOString(), "2026-08-07T07:00:00.000Z");
  assert.equal(rolled.endAt.toISOString(), "2026-08-10T07:00:00.000Z");
  assert.equal(rolled.confidence, "duration_default_now");

  assert.equal(
    resolveAvailabilityCalendarRelative({
      explicitDurationDays: 3,
      normalizedMessage: "stonic 3 din ke liye chahiye",
    }),
    null
  );

  const overlap = resolveAvailabilityOverlapWindow({
    durationDays: 3,
    calendarRelative: null,
    nowMs: NOON_PKT_MS,
  });
  assert.equal(overlap.confidence, "duration_default_now");
  assert.equal(overlap.startAt.toISOString(), "2026-08-07T07:00:00.000Z");
  assert.equal(overlap.endAt.toISOString(), "2026-08-10T07:00:00.000Z");

  const canonical = await resolveFacts({
    message: "Stonic 3 din ke liye chahiye",
    bookings: [],
    duration: 3,
    nowMs: NOON_PKT_MS,
  });
  const av = canonical.verified.availability;
  assert.equal(Number(canonical.turn.durationDays), 3);
  assert.equal(av.windowApplied, true);
  assert.equal(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, "2026-08-07T07:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-10T07:00:00.000Z");
});

test("D: near-midnight PKT — calendar tomorrow, not +24h from now", () => {
  const calendar = resolveCalendarDateWindow({
    relative: "tomorrow",
    timeZone: TZ,
    nowMs: NEAR_MIDNIGHT_PKT_MS,
  });
  const rolling = resolveBookingDateWindowFromDuration(1, NEAR_MIDNIGHT_PKT_MS);
  assert.ok(calendar);
  assert.equal(calendar.startAt.toISOString(), "2026-08-07T19:00:00.000Z");
  assert.equal(calendar.endAt.toISOString(), "2026-08-08T19:00:00.000Z");
  assert.equal(rolling.startAt.toISOString(), "2026-08-07T18:50:00.000Z");
  assert.equal(rolling.endAt.toISOString(), "2026-08-08T18:50:00.000Z");
  assert.notEqual(calendar.startAt.toISOString(), rolling.startAt.toISOString());
  assert.notEqual(calendar.endAt.toISOString(), rolling.endAt.toISOString());
});

test("E: Gate A — booking overlapping tomorrow calendar → unavailable", async () => {
  const booking = {
    id: "bk_overlap_tomorrow",
    itemId: STONIC_ID,
    status: "approved",
    startAt: "2026-08-06T11:29:42.829Z",
    endAt: "2026-08-16T11:29:42.829Z",
    durationDays: 10,
  };
  const canonical = await resolveFacts({
    message: "Stonic kal ke liye chahiye",
    bookings: [booking],
    nowMs: NOON_PKT_MS,
  });
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-07T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-08T19:00:00.000Z");
  assert.equal(av.isAvailable, false);
  assert.equal(av.status, "unavailable");
  assert.equal(isConfidentInventoryUnavailable(av), true);
});

test("F: booking ending at tomorrow start must NOT block kal window", async () => {
  const bookingEndsAtTomorrowStart = {
    id: "bk_today_only",
    itemId: STONIC_ID,
    status: "approved",
    // Covers "today" PKT; ends exactly when tomorrow calendar window starts (exclusive).
    startAt: "2026-08-06T19:00:00.000Z",
    endAt: "2026-08-07T19:00:00.000Z",
    durationDays: 1,
  };
  const canonical = await resolveFacts({
    message: "Stonic kal ke liye chahiye",
    bookings: [bookingEndsAtTomorrowStart],
    nowMs: NOON_PKT_MS,
  });
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-07T19:00:00.000Z");
  assert.equal(av.isAvailable, true);
  assert.equal(isConfidentInventoryUnavailable(av), false);
});

test("explicit duration wins over kal in the same message for window math", async () => {
  const canonical = await resolveFacts({
    message: "Stonic kal 3 din ke liye chahiye",
    bookings: [],
    duration: 3,
    nowMs: NOON_PKT_MS,
  });
  const av = canonical.verified.availability;
  assert.equal(Number(canonical.turn.durationDays), 3);
  assert.equal(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, "2026-08-07T07:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-10T07:00:00.000Z");
});
