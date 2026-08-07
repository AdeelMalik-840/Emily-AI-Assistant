/**
 * P1 Gate A (facts-layer): date-context / duration-context timing aligned before workflow.
 * Rolling duration window (now→now+Nd), not calendar-day "kal".
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  resolveBusinessTurnContext,
  resolveOwnerCheckAlignedDurationDays,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { isConfidentInventoryUnavailable } from "../src/brain/facts/resolveItemBookingAwareAvailability.js";
import { resolveBookingDateWindowFromDuration } from "../src/brain/facts/resolveBookingDateWindow.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { createAvailabilityRequest } from "../src/services/availabilityRequestService.js";
import { detectAvailabilityRequestBookingConflict } from "../src/services/availabilityBookingConflictGuard.js";
import { shouldReleasePostConfirmForFreshAvailability } from "../src/services/customerBusinessPaAgentService.js";

const BUSINESS_ID = "gate-a-facts-biz";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
const STONIC_LABEL = "Kia Stonic EX Plus 2021 (White Color)";
const NOW_MS = Date.parse("2026-08-07T04:40:56.172Z");
const MESSAGE_KAL = "Stonic kal ke liye chahiye";

const EXISTING_STONIC_BOOKING = Object.freeze({
  id: "SfsqDyFt80ngQ3IyYMqV",
  itemId: STONIC_ID,
  status: "approved",
  startAt: "2026-08-06T11:29:42.829Z",
  endAt: "2026-08-16T11:29:42.829Z",
  durationDays: 10,
});

const CATALOG = [
  { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
];

class MemDoc {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
    this.id = String(parts.at(-1));
  }
  get path() {
    return this.parts.join("/");
  }
  async get() {
    const data = this.store.get(this.path);
    return {
      exists: data != null,
      data: () => (data ? structuredClone(data) : undefined),
    };
  }
  async set(data, options = {}) {
    const prior = this.store.get(this.path) || {};
    this.store.set(
      this.path,
      options.merge ? { ...prior, ...structuredClone(data) } : structuredClone(data)
    );
  }
  collection(name) {
    return new MemCol(this.store, [...this.parts, name]);
  }
}

class MemCol {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
  }
  doc(id) {
    return new MemDoc(this.store, [...this.parts, String(id)]);
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    return { empty: true, docs: [] };
  }
}

class MemDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new MemCol(this.docs, [name]);
  }
}

async function resolveFacts({ message, bookings = [], duration = null }) {
  return resolveBusinessTurnContext({
    traceId: "gate-a-facts",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    getBookingsForItemFn: async () => bookings,
    __unavailableReplyForTests:
      "Kia Stonic EX Plus 2021 (White Color) 1 din ke liye abhi available nahi hai. Abhi koi aur option available nahi hai.",
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::905443829990`,
      participantKey: "905443829990",
      participantPhone: "905443829990",
      sourceMessageId: "wamid.gate-a-facts",
      guaranteeKey: "wamid.gate-a-facts",
      ...(duration != null ? { duration } : {}),
      authoritativeItem: { id: STONIC_ID, name: STONIC_LABEL },
    },
    turnContext: {
      sessionId: "gate-a-session",
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

function planFromFacts(canonical, message = MESSAGE_KAL) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        turnId: "gate-a-turn",
        businessId: BUSINESS_ID,
        channelId: "whatsapp_cloud",
        chatKey: "dm",
        participantKey: "905443829990",
        text: message,
        normalizedAt: new Date(NOW_MS).toISOString(),
      },
      idempotencyKey: "gate-a",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: STONIC_LABEL,
      itemSource: "explicit",
      askedField: "availability",
      ...(canonical.turn?.durationDays != null
        ? { durationDays: canonical.turn.durationDays }
        : {}),
      signals: { availabilityAsk: false, bookingCommitment: false },
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

function hasOwnerCheck(plan) {
  return (plan.actions || []).some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
}

test("timing helper: kal / date_context → durationDays=1 (rolling, not calendar)", () => {
  assert.equal(
    resolveOwnerCheckAlignedDurationDays({
      normalizedMessage: "stonic kal ke liye chahiye",
    }),
    1
  );
  assert.equal(
    resolveOwnerCheckAlignedDurationDays({
      explicitDurationDays: 3,
      normalizedMessage: "stonic kal ke liye chahiye",
    }),
    3
  );
  const window = resolveBookingDateWindowFromDuration(1, NOW_MS);
  assert.equal(window.startAt.toISOString(), "2026-08-07T04:40:56.172Z");
  assert.equal(window.endAt.toISOString(), "2026-08-08T04:40:56.172Z");
  assert.equal(window.confidence, "duration_default_now");
});

test("A: overlapping approved Stonic + kal → facts windowApplied + unavailable plan, zero AVR action", async () => {
  const canonical = await resolveFacts({
    message: MESSAGE_KAL,
    bookings: [EXISTING_STONIC_BOOKING],
  });
  const av = canonical.verified.availability;
  assert.equal(canonical.turn.durationDays, 1);
  assert.equal(av.windowApplied, true);
  assert.equal(av.isAvailable, false);
  assert.equal(av.status, "unavailable");
  assert.equal(isConfidentInventoryUnavailable(av), true);

  const plan = planFromFacts(canonical);
  assert.equal(hasOwnerCheck(plan), false);
  assert.equal(
    (plan.actions || []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.match(String(plan.actions?.[0]?.payload?.source ?? ""), /unavailable/i);
});

test("B: no overlapping booking → owner-check still planned", async () => {
  const canonical = await resolveFacts({
    message: MESSAGE_KAL,
    bookings: [],
  });
  assert.equal(canonical.turn.durationDays, 1);
  assert.equal(canonical.verified.availability.windowApplied, true);
  assert.equal(canonical.verified.availability.isAvailable, true);
  assert.equal(isConfidentInventoryUnavailable(canonical.verified.availability), false);

  const plan = planFromFacts(canonical);
  assert.equal(hasOwnerCheck(plan), true);
  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(owner.payload.itemId, STONIC_ID);
  assert.equal(owner.payload.durationDays, 1);
});

test("B+: no-conflict owner-check still creates a pending AVR ledger entry", async () => {
  const db = new MemDb();
  const canonical = await resolveFacts({ message: MESSAGE_KAL, bookings: [] });
  const plan = planFromFacts(canonical);
  const owner = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner);

  const created = await createAvailabilityRequest({
    db,
    payload: {
      ...owner.payload,
      businessId: BUSINESS_ID,
      canonicalAvailabilityStatus: "available",
      sourceTurnKey: "wamid.gate-a-stonic-ok",
      sourceIdentity: {
        ...(owner.payload.sourceIdentity || {}),
        sourceTurnKey: "wamid.gate-a-stonic-ok",
        chatId: `${BUSINESS_ID}::905443829990`,
        chatType: "dm",
        participantPhone: "905443829990",
      },
    },
    executionContext: {
      businessId: BUSINESS_ID,
      executionGuard: { active: true },
      db,
    },
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.status, "pending");
  assert.equal(db.docs.size, 1);
});

test("C: PR #100 fresh-release predicate still true for Stonic kal shape", () => {
  const decision = {
    factKind: "booking_fact",
    capability: "availability_request",
    action: "reply",
    mutationIntent: "none",
    pendingAvailabilitySelectionIndex: null,
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
  };
  const catalog = [
    {
      id: "toyota_corolla_focused",
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla",
    },
    { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
  ];
  assert.equal(
    shouldReleasePostConfirmForFreshAvailability(decision, {
      messageText: MESSAGE_KAL,
      facts: {
        booking: { itemId: "toyota_corolla_focused" },
        bookingFocus: { itemId: "toyota_corolla_focused" },
        replyGuardFacts: { catalogItems: catalog },
      },
    }),
    true
  );
});

test("D: duration-only request still windows from explicit duration", async () => {
  const canonical = await resolveFacts({
    message: "Stonic 3 din ke liye chahiye",
    bookings: [],
    duration: 3,
  });
  // understanding may also parse 3 din; either way windowed available
  assert.ok(Number(canonical.turn.durationDays) >= 1);
  assert.equal(canonical.verified.availability.windowApplied, true);
  assert.equal(isConfidentInventoryUnavailable(canonical.verified.availability), false);
  const plan = planFromFacts(canonical, "Stonic 3 din ke liye chahiye");
  assert.equal(hasOwnerCheck(plan), true);
});

test("E: Gate B conflict guard still detects overlapping booking", async () => {
  const conflict = await detectAvailabilityRequestBookingConflict({
    businessId: BUSINESS_ID,
    request: {
      requestId: "avr_race_guard",
      itemId: STONIC_ID,
      itemLabel: STONIC_LABEL,
      requestedDuration: 1,
      createdAt: new Date(NOW_MS),
      status: "approved",
    },
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [EXISTING_STONIC_BOOKING],
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.bookingId, EXISTING_STONIC_BOOKING.id);
});

test("F: createAvailabilityRequest denies new AVR when canonical unavailable", async () => {
  const db = new MemDb();
  const result = await createAvailabilityRequest({
    db,
    payload: {
      businessId: BUSINESS_ID,
      itemId: STONIC_ID,
      itemLabel: STONIC_LABEL,
      requestedDuration: 1,
      canonicalAvailabilityStatus: "unavailable",
      sourceIdentity: {
        chatId: `${BUSINESS_ID}::905443829990`,
        chatType: "dm",
        participantPhone: "905443829990",
        sourceTurnKey: "wamid.gate-a-denied",
      },
      sourceTurnKey: "wamid.gate-a-denied",
    },
    executionContext: {
      businessId: BUSINESS_ID,
      executionGuard: { active: true },
      db,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "CANONICAL_UNAVAILABLE_NO_OWNER_CHECK");
  assert.equal(result.created, false);
  assert.equal(db.docs.size, 0);
});
