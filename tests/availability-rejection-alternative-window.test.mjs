/**
 * Owner-rejection alternatives must be evaluated against the same trusted
 * customer-requested window that produced the rejected AVR, not the
 * no-date conservative policy. Covers:
 *  1. AVR persistence round-trip (requestedStartAt/requestedEndAt survive)
 *  2/3. findVerifiedAvailabilityAlternatives window-aware overlap correctness
 *  4. Exact window forwarded from a rejected AVR (owner-rejection notification)
 *  5. Exact window forwarded when the customer asks for alternatives after rejection
 *  6. All-alternatives-overlap keeps the existing no-option behavior
 *  7. Legacy AVR without a persisted window: no crash, no fabricated dates
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  createAvailabilityRequest,
  getAvailabilityRequest,
} from "../src/services/availabilityRequestService.js";
import { sendAvailabilityCustomerNotification as sendAvailabilityCustomerNotificationReal } from "../src/services/availabilityCustomerNotificationService.js";
import { __buildAvailabilityAlternativesReplyForTests } from "../src/services/availabilityCustomerConfirmService.js";
import { findVerifiedAvailabilityAlternatives } from "../src/services/availabilityRejectionAlternatives.js";
import { buildRejectedAvailabilityNoOptionsMessage } from "../src/services/availabilityMessageBuilder.js";
import { Timestamp } from "firebase-admin/firestore";

const BUSINESS_ID = "biz-rejection-window";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CIVIC_ID = "honda_civic";
const CIVIC_LABEL = "Honda Civic";
const STONIC_ID = "kia_stonic";
const STONIC_LABEL = "Kia Stonic";

const NOW = Date.now();
const day = (n) => new Date(NOW + n * 86400000).toISOString();

// Mirrors the live incident: customer requested a 4-day window starting ~now.
const REQUESTED_START = day(0);
const REQUESTED_END = day(4);

const CATALOG = [
  { id: CIVIC_ID, itemId: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL },
  { id: STONIC_ID, itemId: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
];

// --- Minimal in-memory Firestore fakes (AVR document store) ---
class MemDoc {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
  }
  get path() {
    return this.parts.join("/");
  }
  async get() {
    const data = this.store.get(this.path);
    return { exists: data != null, data: () => (data ? structuredClone(data) : undefined) };
  }
  async set(data, options = {}) {
    const prior = this.store.get(this.path) || {};
    this.store.set(this.path, options.merge ? { ...prior, ...structuredClone(data) } : structuredClone(data));
  }
  async update(data) {
    const prior = this.store.get(this.path) || {};
    this.store.set(this.path, { ...prior, ...structuredClone(data) });
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
}
class MemDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new MemCol(this.docs, [name]);
  }
  async runTransaction(fn) {
    return fn({ get: (ref) => ref.get(), set: (ref, data, options) => ref.set(data, options) });
  }
}

// --- catalog + booking fake, wired directly into findVerifiedAvailabilityAlternatives ---
function bookingsFn(bookingsByItemId) {
  return async (_uid, itemId) => bookingsByItemId[itemId] || [];
}

function seedRejectedAvr(db, requestId, extra = {}) {
  db.docs.set(`businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`, {
    requestId,
    businessId: BUSINESS_ID,
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    status: "rejected",
    requestedDuration: 4,
    approvalCustomerNotificationStatus: "pending",
    customerPhone: "923001234567",
    customerDmTarget: "923001234567",
    phoneExtractionStatus: "resolved",
    customerDmTransport: "cloud_api",
    sourceChatId: "dm-923001234567",
    sourceChatType: "dm",
    sourceIdentity: { chatId: "dm-923001234567", chatType: "dm", participantPhone: "923001234567" },
    ...extra,
  });
}

test("1. AVR persistence round-trip: exact requestedStartAt/requestedEndAt survive createAvailabilityRequest", async () => {
  const db = new MemDb();
  const created = await createAvailabilityRequest({
    db,
    payload: {
      businessId: BUSINESS_ID,
      itemId: COROLLA_ID,
      itemLabel: COROLLA_LABEL,
      requestedDuration: 4,
      requestedDates: ["2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31"],
      requestedStartAt: REQUESTED_START,
      requestedEndAt: REQUESTED_END,
      canonicalAvailabilityStatus: "available",
      sourceIdentity: {
        chatId: "dm-923001234567",
        chatType: "dm",
        participantPhone: "923001234567",
        sourceTurnKey: "wamid.round-trip",
      },
      sourceTurnKey: "wamid.round-trip",
    },
    executionContext: { businessId: BUSINESS_ID, executionGuard: { active: true }, db },
  });

  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.request.requestedStartAt instanceof Date, true);
  assert.equal(created.request.requestedEndAt instanceof Date, true);
  assert.equal(created.request.requestedStartAt.toISOString(), REQUESTED_START);
  assert.equal(created.request.requestedEndAt.toISOString(), REQUESTED_END);

  const fetched = await getAvailabilityRequest({ db, businessId: BUSINESS_ID, requestId: created.requestId });
  assert.equal(fetched.requestedStartAt.toISOString(), REQUESTED_START);
  assert.equal(fetched.requestedEndAt.toISOString(), REQUESTED_END);
});

test("2. findVerifiedAvailabilityAlternatives: overlapping alternative excluded for the requested window", async () => {
  const overlappingBooking = { itemId: STONIC_ID, status: "approved", startAt: day(1), endAt: day(3) };
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    limit: 3,
    requestedStart: REQUESTED_START,
    requestedEnd: REQUESTED_END,
    catalogRows: [{ id: STONIC_ID, displayLabel: STONIC_LABEL }],
    getBookingsForItemFn: bookingsFn({ [STONIC_ID]: [overlappingBooking] }),
  });
  assert.deepEqual(alts, []);
});

test("3. findVerifiedAvailabilityAlternatives: non-overlapping alternative offered for the requested window", async () => {
  // Active/future relative to "now" but entirely outside the requested window.
  const nonOverlappingBooking = { itemId: STONIC_ID, status: "approved", startAt: day(10), endAt: day(15) };
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    limit: 3,
    requestedStart: REQUESTED_START,
    requestedEnd: REQUESTED_END,
    catalogRows: [{ id: STONIC_ID, displayLabel: STONIC_LABEL }],
    getBookingsForItemFn: bookingsFn({ [STONIC_ID]: [nonOverlappingBooking] }),
  });
  assert.deepEqual(alts, [{ itemId: STONIC_ID, itemLabel: STONIC_LABEL }]);
});

// Distinguishing fixture for 4 & 5: Civic's booking starts AFTER the requested
// window ends but is still active relative to "now" — the no-date conservative
// policy (bug present) blocks it; the window-aware policy (fix applied) clears it.
// Stonic's booking genuinely overlaps the requested window and must stay excluded
// either way, proving the distinguishing behavior isn't a fluke of "offer everything".
function distinguishingCatalogDb() {
  return {
    collection(name) {
      if (name !== "businesses") throw new Error(`unexpected collection ${name}`);
      return {
        doc() {
          return {
            collection(sub) {
              if (sub === "items") {
                return {
                  async get() {
                    return { docs: CATALOG.map((c) => ({ id: c.id, data: () => ({ ...c }) })) };
                  },
                  doc(id) {
                    const row = CATALOG.find((c) => c.id === id) || { id, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL };
                    return { async get() { return { exists: true, id, data: () => ({ ...row }) }; } };
                  },
                };
              }
              if (sub === "bookings") {
                return {
                  where(field, _op, value) {
                    return {
                      async get() {
                        if (field !== "itemId") return { docs: [] };
                        const byItem = {
                          [CIVIC_ID]: [{ id: "civic-bk", itemId: CIVIC_ID, status: "approved", startAt: day(10), endAt: day(15) }],
                          [STONIC_ID]: [{ id: "stonic-bk", itemId: STONIC_ID, status: "approved", startAt: day(1), endAt: day(3) }],
                        };
                        const rows = byItem[value] || [];
                        return { docs: rows.map((b) => ({ id: b.id, data: () => ({ ...b }) })) };
                      },
                    };
                  },
                };
              }
              throw new Error(`unexpected subcollection ${sub}`);
            },
          };
        },
      };
    },
  };
}

test("4. Owner-rejection notification forwards the exact persisted window to alternatives", async (t) => {
  const firebase = await import("../src/config/firebase.js");
  const original = firebase.default.collection;
  firebase.default.collection = distinguishingCatalogDb().collection;
  t.after(() => {
    firebase.default.collection = original;
  });

  const db = new MemDb();
  seedRejectedAvr(db, "avr_reject_window_1", {
    requestedStartAt: new Date(REQUESTED_START),
    requestedEndAt: new Date(REQUESTED_END),
  });

  const sendCalls = [];
  const result = await sendAvailabilityCustomerNotificationReal({
    db,
    businessId: BUSINESS_ID,
    requestId: "avr_reject_window_1",
    sendWhatsAppMessageFn: async (to, message) => {
      sendCalls.push({ to, message });
      return { ok: true, providerMessageId: "wamid.reject1", data: { messages: [{ id: "wamid.reject1" }], contacts: [{ wa_id: to }] } };
    },
    replyPrivatelyFn: async () => {
      throw new Error("must not use Reply Privately for cloud_api");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 1);
  assert.match(sendCalls[0].message, new RegExp(CIVIC_LABEL));
  assert.doesNotMatch(sendCalls[0].message, new RegExp(STONIC_LABEL));
});

test("5. Post-rejection customer alternatives request forwards the exact persisted window", async (t) => {
  const firebase = await import("../src/config/firebase.js");
  const original = firebase.default.collection;
  firebase.default.collection = distinguishingCatalogDb().collection;
  t.after(() => {
    firebase.default.collection = original;
  });

  const reply = await __buildAvailabilityAlternativesReplyForTests({
    businessId: BUSINESS_ID,
    itemId: COROLLA_ID,
    itemLabel: COROLLA_LABEL,
    requestedStartAt: new Date(REQUESTED_START),
    requestedEndAt: new Date(REQUESTED_END),
  });

  assert.match(reply, new RegExp(CIVIC_LABEL));
  assert.doesNotMatch(reply, new RegExp(STONIC_LABEL));
});

test("6. All alternatives overlap the requested window: existing no-option behavior unchanged", async () => {
  const overlapsAll = {
    [CIVIC_ID]: [{ itemId: CIVIC_ID, status: "approved", startAt: day(1), endAt: day(3) }],
    [STONIC_ID]: [{ itemId: STONIC_ID, status: "approved", startAt: day(1), endAt: day(3) }],
  };
  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    limit: 3,
    requestedStart: REQUESTED_START,
    requestedEnd: REQUESTED_END,
    catalogRows: CATALOG,
    getBookingsForItemFn: bookingsFn(overlapsAll),
  });
  assert.deepEqual(alts, []);
  assert.equal(buildRejectedAvailabilityNoOptionsMessage(), "Sorry abi koi option available ni hai.");
});

test("7. Legacy AVR without a persisted window: no crash, no fabricated dates, fail-safe behavior retained", async (t) => {
  const firebase = await import("../src/config/firebase.js");
  const original = firebase.default.collection;
  firebase.default.collection = distinguishingCatalogDb().collection;
  t.after(() => {
    firebase.default.collection = original;
  });

  const db = new MemDb();
  // Pre-fix shaped document: no requestedStartAt/requestedEndAt at all.
  seedRejectedAvr(db, "avr_reject_legacy_1");

  const sendCalls = [];
  const result = await sendAvailabilityCustomerNotificationReal({
    db,
    businessId: BUSINESS_ID,
    requestId: "avr_reject_legacy_1",
    sendWhatsAppMessageFn: async (to, message) => {
      sendCalls.push({ to, message });
      return { ok: true, providerMessageId: "wamid.legacy1", data: { messages: [{ id: "wamid.legacy1" }], contacts: [{ wa_id: to }] } };
    },
    replyPrivatelyFn: async () => {
      throw new Error("must not use Reply Privately for cloud_api");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(sendCalls.length, 1);
  // No window persisted -> no-date conservative policy still applies -> Civic's
  // active-but-non-overlapping booking still (correctly, for this legacy record)
  // blocks it, same as pre-fix behavior. No fabricated window changed that.
  assert.doesNotMatch(sendCalls[0].message, new RegExp(CIVIC_LABEL));
  assert.doesNotMatch(sendCalls[0].message, new RegExp(STONIC_LABEL));
  assert.equal(sendCalls[0].message, buildRejectedAvailabilityNoOptionsMessage());
});

test("8. Genuine firebase-admin Firestore Timestamp requestedStart/requestedEnd resolve the exact window (no date-conversion mock)", async () => {
  // Mirrors exactly what admin.firestore()'s snap.data() returns for a Date
  // field written via .set(): a real firebase-admin Timestamp instance, not a
  // Date and not a plain {seconds,nanoseconds} stand-in. No network I/O is
  // needed to construct one — it is a pure value class.
  const requestedStartTs = Timestamp.fromDate(new Date(REQUESTED_START));
  const requestedEndTs = Timestamp.fromDate(new Date(REQUESTED_END));
  assert.equal(requestedStartTs.constructor.name, "Timestamp");
  assert.equal(typeof requestedStartTs.toMillis, "function");

  // Overlapping booking must still be excluded when the window arrives as a
  // Timestamp, not a Date/ISO string.
  const overlappingBooking = { itemId: STONIC_ID, status: "approved", startAt: day(1), endAt: day(3) };
  // Active-but-outside-window booking must still be cleared when the window
  // arrives as a Timestamp — this is the case the no-date conservative bug
  // gets wrong, so it also proves the Timestamp was actually used (not ignored).
  const nonOverlappingBooking = { itemId: CIVIC_ID, status: "approved", startAt: day(10), endAt: day(15) };

  const alts = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    limit: 3,
    requestedStart: requestedStartTs,
    requestedEnd: requestedEndTs,
    catalogRows: CATALOG,
    getBookingsForItemFn: bookingsFn({
      [STONIC_ID]: [overlappingBooking],
      [CIVIC_ID]: [nonOverlappingBooking],
    }),
  });

  assert.deepEqual(alts, [{ itemId: CIVIC_ID, itemLabel: CIVIC_LABEL }]);
});
