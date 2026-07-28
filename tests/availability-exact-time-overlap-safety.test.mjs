/**
 * Exact-time half-open booking overlap safety.
 *
 * Baseline (before fix): date-only normalisation incorrectly reports no overlap
 * for the Civic 01:11 PKT incident while the approved booking is still active.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeUserFacingAvailability,
  isBlockingBookingStatus,
} from "../src/services/inventoryService.js";
import {
  isConfidentInventoryUnavailable,
  resolveItemBookingAwareAvailability,
} from "../src/brain/facts/resolveItemBookingAwareAvailability.js";
import { resolveBookingDateWindowFromDuration } from "../src/brain/facts/resolveBookingDateWindow.js";

const CIVIC_ITEM_ID = "honda_civic_2026_oriel_white_7e961e31";

/** Existing approved Civic booking from the live incident. */
const EXISTING_BOOKING = Object.freeze({
  id: "rRCKkeKagLbCACEG4IVg",
  itemId: CIVIC_ITEM_ID,
  status: "approved",
  approvalStage: "owner_approved_waiting_customer_details",
  startAt: "2026-07-25T13:47:17.739Z", // 18:47:17 PKT
  endAt: "2026-07-29T13:47:17.739Z", // 18:47:17 PKT
  durationDays: 4,
});

/** Incident pipeline / AVR createdAt ≈ 2026-07-29 01:11:31 PKT */
const INCIDENT_NOW_MS = Date.parse("2026-07-28T20:11:31.199Z");

test("BASELINE/incident: overlapping approved Civic must be unavailable (exact timestamps)", () => {
  const window = resolveBookingDateWindowFromDuration(3, INCIDENT_NOW_MS);
  assert.ok(window);
  assert.equal(window.startAt.toISOString(), "2026-07-28T20:11:31.199Z");
  assert.equal(window.endAt.toISOString(), "2026-07-31T20:11:31.199Z");

  // Exact half-open overlap must be true for this pair.
  const reqStart = window.startAt.getTime();
  const reqEnd = window.endAt.getTime();
  const bStart = Date.parse(EXISTING_BOOKING.startAt);
  const bEnd = Date.parse(EXISTING_BOOKING.endAt);
  assert.equal(reqStart < bEnd && bStart < reqEnd, true, "timestamps must overlap");

  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: window.startAt,
    requestedEnd: window.endAt,
  });
  assert.equal(
    av.isAvailable,
    false,
    "incident window must be unavailable while approved booking is still active"
  );
  assert.ok(av.blockingStatusesSeen?.includes("approved"));
});

test("incident resolveItemBookingAwareAvailability is confident unavailable", async () => {
  const resolved = await resolveItemBookingAwareAvailability({
    businessId: "biz-test",
    itemId: CIVIC_ITEM_ID,
    itemName: "Honda Civic 2026 Oriel",
    catalogRow: {
      id: CIVIC_ITEM_ID,
      name: "Honda Civic 2026 Oriel",
      availability: false,
    },
    wantsAvailability: true,
    durationDays: 3,
    nowMs: INCIDENT_NOW_MS,
    getBookingsForItemFn: async () => [EXISTING_BOOKING],
  });
  assert.equal(resolved.availability.isAvailable, false);
  assert.equal(resolved.availability.status, "unavailable");
  assert.equal(resolved.availability.reason, "booking_conflict");
  assert.equal(resolved.availability.windowApplied, true);
  assert.equal(isConfidentInventoryUnavailable(resolved.availability), true);
  // Catalogue false must not be required / must not hide booking conflict.
  assert.equal(resolved.availability.staleCatalogAvailability, false);
});

test("exact end boundary: request starting at booking end does not overlap", () => {
  const bookingEnd = "2026-07-29T13:47:17.739Z";
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: bookingEnd,
    requestedEnd: "2026-08-01T13:47:17.739Z",
  });
  assert.equal(av.isAvailable, true);
});

test("one millisecond before booking end overlaps", () => {
  const almostEnd = new Date(Date.parse(EXISTING_BOOKING.endAt) - 1);
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: almostEnd,
    requestedEnd: "2026-08-01T13:47:17.739Z",
  });
  assert.equal(av.isAvailable, false);
});

test("one millisecond after booking end does not overlap", () => {
  const afterEnd = new Date(Date.parse(EXISTING_BOOKING.endAt) + 1);
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: afterEnd,
    requestedEnd: "2026-08-01T13:47:17.739Z",
  });
  assert.equal(av.isAvailable, true);
});

test("booking begins exactly when request ends does not overlap", () => {
  const av = computeUserFacingAvailability(
    [
      {
        ...EXISTING_BOOKING,
        startAt: "2026-07-31T20:11:31.199Z",
        endAt: "2026-08-03T20:11:31.199Z",
      },
    ],
    CIVIC_ITEM_ID,
    {
      requestedStart: "2026-07-28T20:11:31.199Z",
      requestedEnd: "2026-07-31T20:11:31.199Z",
    }
  );
  assert.equal(av.isAvailable, true);
});

test("request fully inside booking overlaps", () => {
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: "2026-07-26T00:00:00.000Z",
    requestedEnd: "2026-07-27T00:00:00.000Z",
  });
  assert.equal(av.isAvailable, false);
});

test("booking fully inside request overlaps", () => {
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: "2026-07-24T00:00:00.000Z",
    requestedEnd: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(av.isAvailable, false);
});

test("same local calendar date with different times: timestamps control result", () => {
  // Both on 29 Jul PKT calendar day; request starts before booking ends.
  const av = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: "2026-07-28T20:11:31.199Z", // 01:11 PKT 29 Jul
    requestedEnd: "2026-07-31T20:11:31.199Z",
  });
  assert.equal(av.isAvailable, false);
});

test("UTC/PKT equivalent absolute timestamps yield the same overlap", () => {
  const bookingPktOffset = {
    ...EXISTING_BOOKING,
    // Same absolute instants written with +05:00 offset strings.
    startAt: "2026-07-25T18:47:17.739+05:00",
    endAt: "2026-07-29T18:47:17.739+05:00",
  };
  const avUtc = computeUserFacingAvailability([EXISTING_BOOKING], CIVIC_ITEM_ID, {
    requestedStart: "2026-07-28T20:11:31.199Z",
    requestedEnd: "2026-07-31T20:11:31.199Z",
  });
  const avPkt = computeUserFacingAvailability([bookingPktOffset], CIVIC_ITEM_ID, {
    requestedStart: "2026-07-29T01:11:31.199+05:00",
    requestedEnd: "2026-08-01T01:11:31.199+05:00",
  });
  assert.equal(avUtc.isAvailable, false);
  assert.equal(avPkt.isAvailable, false);
});

test("invalid or missing booking dates fail closed (unavailable)", () => {
  const av = computeUserFacingAvailability(
    [
      {
        itemId: CIVIC_ITEM_ID,
        status: "approved",
        startAt: null,
        endAt: null,
      },
    ],
    CIVIC_ITEM_ID,
    {
      requestedStart: "2026-07-28T20:11:31.199Z",
      requestedEnd: "2026-07-31T20:11:31.199Z",
    }
  );
  assert.equal(av.isAvailable, false);
});

test("approved status remains blocking", () => {
  assert.equal(isBlockingBookingStatus("approved"), true);
});

test("non-blocking statuses remain non-blocking when dates would overlap", () => {
  for (const status of ["cancelled", "completed", "rejected"]) {
    const av = computeUserFacingAvailability(
      [{ ...EXISTING_BOOKING, status }],
      CIVIC_ITEM_ID,
      {
        requestedStart: "2026-07-28T20:11:31.199Z",
        requestedEnd: "2026-07-31T20:11:31.199Z",
      }
    );
    assert.equal(av.isAvailable, true, status);
  }
});

test("shared intervalsOverlapHalfOpen contract", async () => {
  const { intervalsOverlapHalfOpen } = await import(
    "../src/services/bookingIntervalOverlap.js"
  );
  const a = {
    start: "2026-07-28T20:11:31.199Z",
    end: "2026-07-31T20:11:31.199Z",
  };
  const b = {
    start: EXISTING_BOOKING.startAt,
    end: EXISTING_BOOKING.endAt,
  };
  assert.equal(
    intervalsOverlapHalfOpen(a.start, a.end, b.start, b.end).overlaps,
    true
  );
  assert.equal(
    intervalsOverlapHalfOpen(b.end, a.end, b.start, b.end).overlaps,
    false
  );
  assert.equal(intervalsOverlapHalfOpen(null, a.end, b.start, b.end).ok, false);
  assert.equal(
    intervalsOverlapHalfOpen(null, a.end, b.start, b.end).overlaps,
    true
  );
});

test("M: pre-AVR unavailable facts do not emit AVAILABILITY_OWNER_CHECK_REQUIRED", async () => {
  const { buildAvailabilityInquiryActionPlan } = await import(
    "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
  );
  const resolved = await resolveItemBookingAwareAvailability({
    businessId: "biz-test",
    itemId: CIVIC_ITEM_ID,
    catalogRow: { id: CIVIC_ITEM_ID, availability: false },
    wantsAvailability: true,
    durationDays: 3,
    nowMs: INCIDENT_NOW_MS,
    getBookingsForItemFn: async () => [EXISTING_BOOKING],
  });
  assert.equal(isConfidentInventoryUnavailable(resolved.availability), true);

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        turnId: "overlap-safety-turn",
        businessId: "biz-test",
        channelId: "whatsapp_web",
        chatKey: "leads",
        participantKey: "cust-1",
        text: "Civic chyh 3 din k lye",
        normalizedAt: new Date(INCIDENT_NOW_MS).toISOString(),
      },
      idempotencyKey: "overlap-safety",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: CIVIC_ITEM_ID,
      resolvedItemLabel: "Honda Civic 2026 Oriel (White)",
      itemSource: "explicit",
      askedField: "availability",
      durationDays: 3,
      signals: { availabilityAsk: true, bookingCommitment: true },
    },
    catalogItems: [
      {
        id: CIVIC_ITEM_ID,
        name: "Honda Civic 2026 Oriel",
        displayLabel: "Honda Civic 2026 Oriel (White)",
        availability: false,
      },
    ],
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: "biz-test",
        resolvedItem: {
          id: CIVIC_ITEM_ID,
          name: "Honda Civic 2026 Oriel",
          displayLabel: "Honda Civic 2026 Oriel (White)",
          status: "resolved",
        },
        turn: {
          durationDays: 3,
          sourceTurnKey: "leads::wa::3EB042C7B0684524E39E60",
          sourceMessageId: "wa::3EB042C7B0684524E39E60",
        },
        participant: { key: "cust-1", identity: "stable", memoryAllowed: true },
        verified: {
          availability: resolved.availability,
          priceQuote: { status: "not_requested" },
        },
        actions: {
          availabilityOwnerCheckExecute: true,
          bookingExecute: false,
          ownerExecute: false,
          dmExecute: false,
          blocked: [],
        },
        forbiddenClaims: [],
        replyConstraints: {},
      },
    },
  });

  assert.ok(
    !plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    "overlapping booking must not plan owner-check / AVR"
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /mai confirm kar leta hun/i);
});

test("N: owner-approved AVR with new conflict skips customer availability DM", async () => {
  const { sendAvailabilityCustomerNotification } = await import(
    "../src/services/availabilityCustomerNotificationService.js"
  );
  const { detectAvailabilityRequestBookingConflict } = await import(
    "../src/services/availabilityBookingConflictGuard.js"
  );

  const request = {
    requestId: "avr_bd3e9683f9680031453e5af8",
    businessId: "biz-test",
    itemId: CIVIC_ITEM_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    status: "approved",
    requestedDuration: 3,
    createdAt: new Date(INCIDENT_NOW_MS),
    approvalCustomerNotificationStatus: "pending",
    customerConfirmationStatus: null,
  };

  const conflict = await detectAvailabilityRequestBookingConflict({
    businessId: "biz-test",
    request,
    getBookingsForItemFn: async () => [EXISTING_BOOKING],
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.reason, "booking_conflict_detected");
  assert.equal(conflict.bookingId, EXISTING_BOOKING.id);

  const store = new Map();
  const key = `businesses/biz-test/availabilityRequests/${request.requestId}`;
  store.set(key, { ...request });
  const fakeDb = {
    collection(name) {
      return {
        doc(bid) {
          return {
            collection(child) {
              return {
                doc(rid) {
                  const k = `${name}/${bid}/${child}/${rid}`;
                  return {
                    async get() {
                      return {
                        exists: store.has(k),
                        id: rid,
                        data: () => structuredClone(store.get(k)),
                      };
                    },
                    async update(patch) {
                      const prev = store.get(k) || {};
                      store.set(k, { ...prev, ...patch });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  let sendCount = 0;
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: "biz-test",
    requestId: request.requestId,
    getBookingsForItemFn: async () => [EXISTING_BOOKING],
    sendWhatsAppMessageFn: async () => {
      sendCount += 1;
      return { ok: true, providerMessageId: "should-not-send" };
    },
    replyPrivatelyFn: async () => {
      sendCount += 1;
      return { ok: true };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.bookingConflict, true);
  assert.equal(result.reason, "booking_conflict_detected");
  assert.equal(sendCount, 0);
  const stored = store.get(key);
  assert.equal(stored.approvalCustomerNotificationStatus, "skipped");
  assert.equal(stored.approvalCustomerNotificationError, "booking_conflict_detected");
  assert.notEqual(stored.customerConfirmationStatus, "waiting_confirm");
});

test("N2: second customer-notification call after conflict skip is idempotent", async () => {
  const { sendAvailabilityCustomerNotification } = await import(
    "../src/services/availabilityCustomerNotificationService.js"
  );
  const { evaluateSemanticAvailabilityReuseEligibility } = await import(
    "../src/services/availabilityRequestService.js"
  );

  const requestId = "avr_late_conflict_idempotent_001";
  const request = {
    requestId,
    businessId: "biz-test",
    itemId: CIVIC_ITEM_ID,
    itemLabel: "Honda Civic 2026 Oriel (White)",
    status: "approved",
    requestedDuration: 3,
    createdAt: new Date(INCIDENT_NOW_MS),
    ownerNotificationStatus: "sent",
    approvalCustomerNotificationStatus: "pending",
    customerConfirmationStatus: null,
  };

  const store = new Map();
  const key = `businesses/biz-test/availabilityRequests/${requestId}`;
  store.set(key, { ...request });
  let updateCount = 0;
  const fakeDb = {
    collection(name) {
      return {
        doc(bid) {
          return {
            collection(child) {
              return {
                doc(rid) {
                  const k = `${name}/${bid}/${child}/${rid}`;
                  return {
                    async get() {
                      return {
                        exists: store.has(k),
                        id: rid,
                        data: () => structuredClone(store.get(k)),
                      };
                    },
                    async update(patch) {
                      updateCount += 1;
                      const prev = store.get(k) || {};
                      store.set(k, { ...prev, ...patch });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  let textSendCount = 0;
  let templateSendCount = 0;
  let replyPrivateCount = 0;
  const sendOpts = {
    db: fakeDb,
    businessId: "biz-test",
    requestId,
    getBookingsForItemFn: async () => [EXISTING_BOOKING],
    sendWhatsAppMessageFn: async () => {
      textSendCount += 1;
      return { ok: true, providerMessageId: "should-not-send" };
    },
    sendWhatsAppTemplateMessageFn: async () => {
      templateSendCount += 1;
      return { ok: true, providerMessageId: "should-not-send-template" };
    },
    replyPrivatelyFn: async () => {
      replyPrivateCount += 1;
      return { ok: true };
    },
  };

  const first = await sendAvailabilityCustomerNotification(sendOpts);
  assert.equal(first.ok, false);
  assert.equal(first.skipped, true);
  assert.equal(first.bookingConflict, true);
  assert.equal(first.reason, "booking_conflict_detected");
  assert.equal(updateCount, 1, "first call records skipped once");

  const afterFirst = structuredClone(store.get(key));
  assert.equal(afterFirst.approvalCustomerNotificationStatus, "skipped");
  assert.equal(afterFirst.approvalCustomerNotificationError, "booking_conflict_detected");
  assert.notEqual(afterFirst.customerConfirmationStatus, "waiting_confirm");

  const updatesAfterFirst = updateCount;
  const second = await sendAvailabilityCustomerNotification(sendOpts);

  assert.equal(second.ok, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "booking_conflict_detected");
  assert.equal(textSendCount, 0);
  assert.equal(templateSendCount, 0);
  assert.equal(replyPrivateCount, 0);
  assert.equal(updateCount, updatesAfterFirst, "second call must not mutate AVR again");
  assert.deepEqual(store.get(key), afterFirst);

  const eligibility = evaluateSemanticAvailabilityReuseEligibility(store.get(key));
  assert.equal(eligibility.reusable, false);
  assert.equal(eligibility.reason, "APPROVED_NOT_WAITING_CONFIRM");
  assert.equal(store.get(key).ownerNotificationStatus, "sent");
  assert.notEqual(store.get(key).customerConfirmationStatus, "waiting_confirm");
});

test("O: createBooking rejects overlapping approved booking (exact incident window)", async () => {
  const { executeCreateBooking } = await import(
    "../src/services/executors/createBookingExecutor.js"
  );

  const store = { businesses: {} };
  let autoId = 0;
  function ensure(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
    };
    return store.businesses[id];
  }
  class DocRef {
    constructor(path) {
      this.path = path;
      this.id = String(path[path.length - 1] ?? "");
    }
    collection(name) {
      return new CollectionRef([...this.path, name]);
    }
    async get() {
      const node = this._node();
      return { exists: Boolean(node), data: () => ({ ...(node?.data ?? {}) }) };
    }
    _node() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        node = node?.[this.path[i]]?.[this.path[i + 1]];
      }
      return node ?? null;
    }
  }
  class CollectionRef {
    constructor(path, conditions = [], resultLimit = null) {
      this.path = path;
      this.conditions = conditions;
      this.resultLimit = resultLimit;
    }
    doc(id = null) {
      const nextId = id == null ? `booking-${++autoId}` : String(id);
      if (this.path.length === 1 && this.path[0] === "businesses") ensure(nextId);
      return new DocRef([...this.path, nextId]);
    }
    where(field, op, value) {
      return new CollectionRef(
        this.path,
        [...this.conditions, { field, op, value }],
        this.resultLimit
      );
    }
    limit(n) {
      return new CollectionRef(this.path, this.conditions, n);
    }
    async get() {
      let entries = Object.entries(this._collectionNode() ?? {});
      for (const condition of this.conditions) {
        entries = entries.filter(([, node]) => {
          if (condition.op !== "==") return false;
          return node?.data?.[condition.field] === condition.value;
        });
      }
      if (this.resultLimit != null) entries = entries.slice(0, this.resultLimit);
      return {
        docs: entries.map(([id, node]) => ({
          id,
          data: () => ({ ...(node?.data ?? {}) }),
          exists: true,
        })),
      };
    }
    _collectionNode() {
      if (this.path.length === 1) return store[this.path[0]];
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        if (i + 1 >= this.path.length) {
          const biz = ensure(this.path[1]);
          if (this.path[2] === "bookings") return biz.bookings;
          if (this.path[2] === "bookingSourceKeys") return biz.bookingSourceKeys;
          return null;
        }
        node = node?.[this.path[i]]?.[this.path[i + 1]];
      }
      return null;
    }
  }
  const fakeDb = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      const tx = {
        get: async (ref) => {
          if (typeof ref.get === "function" && ref.conditions) {
            return ref.get();
          }
          return ref.get();
        },
        set(ref, data) {
          const biz = ensure(ref.path[1]);
          if (ref.path[2] === "bookings") {
            biz.bookings[ref.id] = { data: { ...data } };
          } else if (ref.path[2] === "bookingSourceKeys") {
            biz.bookingSourceKeys[ref.id] = { data: { ...data } };
          }
        },
        create(ref, data) {
          this.set(ref, data);
        },
      };
      // CollectionRef get via tx: support query refs
      tx.get = async (ref) => {
        if (ref instanceof CollectionRef || ref.conditions) return ref.get();
        return ref.get();
      };
      return fn(tx);
    },
  };

  const biz = ensure("biz-test");
  biz.bookings[EXISTING_BOOKING.id] = {
    data: {
      itemId: CIVIC_ITEM_ID,
      status: "approved",
      startAt: new Date(EXISTING_BOOKING.startAt),
      endAt: new Date(EXISTING_BOOKING.endAt),
      durationDays: 4,
    },
  };

  // Freeze "now" for createBooking window by using duration that overlaps incident.
  // createBooking uses Date.now() for start — stub via booking that overlaps any near-term window.
  const result = await executeCreateBooking({
    payload: {
      itemId: CIVIC_ITEM_ID,
      itemName: "Honda Civic 2026 Oriel",
      durationDays: 3,
      execute: true,
    },
    executionContext: {
      businessId: "biz-test",
      userId: "biz-test",
      traceId: "overlap-safety-create",
      dbOverride: fakeDb,
    },
  });

  // If wall-clock now is after booking end, this assertion may not hold.
  // Force overlap by seeding a booking that covers Date.now() ± days.
  if (Date.now() < Date.parse(EXISTING_BOOKING.endAt)) {
    assert.equal(result.ok, false);
    assert.equal(result.code, "ITEM_ALREADY_BOOKED");
  } else {
    // Deterministic alternate: overlapping future window booking
    biz.bookings["future-overlap"] = {
      data: {
        itemId: CIVIC_ITEM_ID,
        status: "approved",
        startAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 86400000 * 5),
        durationDays: 5,
      },
    };
    const result2 = await executeCreateBooking({
      payload: {
        itemId: CIVIC_ITEM_ID,
        itemName: "Honda Civic 2026 Oriel",
        durationDays: 3,
        execute: true,
      },
      executionContext: {
        businessId: "biz-test",
        userId: "biz-test",
        traceId: "overlap-safety-create-2",
        dbOverride: fakeDb,
      },
    });
    assert.equal(result2.ok, false);
    assert.equal(result2.code, "ITEM_ALREADY_BOOKED");
  }
});

test("exact end boundary remains eligible for owner-check facts (not auto-unavailable)", async () => {
  const bookingEnded = {
    ...EXISTING_BOOKING,
    endAt: "2026-07-29T13:47:17.739Z",
  };
  const resolved = await resolveItemBookingAwareAvailability({
    businessId: "biz-test",
    itemId: CIVIC_ITEM_ID,
    catalogRow: { id: CIVIC_ITEM_ID, availability: true },
    wantsAvailability: true,
    durationDays: 3,
    nowMs: Date.parse("2026-07-29T13:47:17.739Z"),
    getBookingsForItemFn: async () => [bookingEnded],
  });
  assert.equal(resolved.availability.isAvailable, true);
  assert.equal(isConfidentInventoryUnavailable(resolved.availability), false);
});
