import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

process.env.NODE_ENV = "test";

import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";
import { buildConfirmExpiresAt } from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "owner1";
const REQUEST_ID = "avr_gate_test_001";
const ITEM_ID = "civic-1";
const CUSTOMER_PHONE = "+923001111111";

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= { data: {}, bookings: {}, bookingSourceKeys: {}, availabilityRequests: {} };
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
        const collection = this.path[i];
        const id = this.path[i + 1];
        node = node?.[collection]?.[id];
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
      if (this.path.length === 1 && this.path[0] === "businesses") {
        ensureBusiness(nextId);
      }
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
          ref: new DocRef([...this.path, id]),
          data: () => ({ ...(node?.data ?? {}) }),
        })),
      };
    }
    _collectionNode() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        if (i === this.path.length - 1) return node?.[collection] ?? null;
        const id = this.path[i + 1];
        if (collection === "businesses") ensureBusiness(id);
        node = node?.[collection]?.[id];
      }
      return null;
    }
  }

  function setDoc(ref, data) {
    const [rootCollection, rootId, subCollection, docId] = ref.path;
    if (rootCollection !== "businesses" || !rootId || !subCollection || !docId) {
      throw new Error(`unsupported fake path ${ref.path.join("/")}`);
    }
    const business = ensureBusiness(rootId);
    business[subCollection] ||= {};
    business[subCollection][docId] ||= { data: {} };
    business[subCollection][docId].data = {
      ...business[subCollection][docId].data,
      ...data,
    };
  }

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({
        get: (refOrQuery) => refOrQuery.get(),
        set: setDoc,
        create: setDoc,
      });
    },
  };

  function seedAvailabilityRequest(requestId, data) {
    setDoc(
      db.collection("businesses").doc(BUSINESS_ID).collection("availabilityRequests").doc(requestId),
      data
    );
  }

  return { db, seedAvailabilityRequest };
}

function baseWaitingConfirmRequest(overrides = {}) {
  const sentAt = new Date();
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: ITEM_ID,
    itemLabel: "Honda Civic",
    status: "approved",
    requestedDuration: 3,
    customerPhone: CUSTOMER_PHONE,
    customerDmTarget: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    ...overrides,
  };
}

function baseExecutionContext(db) {
  return {
    businessId: BUSINESS_ID,
    traceId: "availability-confirm-gate-test",
    participantPhoneForDm: CUSTOMER_PHONE,
    dbOverride: db,
  };
}

function basePayload(overrides = {}) {
  return {
    itemId: ITEM_ID,
    itemName: "Honda Civic",
    durationDays: 3,
    availabilityRequestId: REQUEST_ID,
    ...overrides,
  };
}

test("allows booking when availability request is waiting_confirm and valid", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingConfirmRequest());

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, true);
  assert.ok(result.booking);
});

test("rejects when customerConfirmationStatus is not waiting_confirm", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({ customerConfirmationStatus: "confirmed" })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_NOT_WAITING_CONFIRM");
  assert.equal(result.booking, null);
});

test("rejects when customerConfirmationStatus is processing (invalid status value)", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({ customerConfirmationStatus: "processing" })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_NOT_WAITING_CONFIRM");
  assert.equal(result.booking, null);
});

test("allows booking when customerConfirmProcessingStatus is processing but confirmation is waiting_confirm", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({
      customerConfirmationStatus: "waiting_confirm",
      customerConfirmProcessingStatus: "processing",
    })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, true);
  assert.ok(result.booking);
});

test("rejects when linkedBookingId already exists", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({ linkedBookingId: "booking-existing-1" })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_BOOKING_ALREADY_LINKED");
  assert.equal(result.booking, null);
});

test("rejects when confirmExpiresAt is in the past", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({
      confirmExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_REQUEST_EXPIRED");
  assert.equal(result.booking, null);
});

test("rejects expired Firestore Timestamp at the final booking gate", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({
      confirmExpiresAt: Timestamp.fromDate(new Date(Date.now() - 60_000)),
    })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_REQUEST_EXPIRED");
  assert.equal(result.booking, null);
});

test("rejects malformed expiry at the final booking gate", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(
    REQUEST_ID,
    baseWaitingConfirmRequest({ confirmExpiresAt: { seconds: "bad" } })
  );

  const result = await executeCreateBooking({
    payload: basePayload(),
    executionContext: baseExecutionContext(fake.db),
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "AVAILABILITY_REQUEST_EXPIRY_INVALID");
  assert.equal(result.booking, null);
});

test("rejects when required item or duration fields are missing or mismatched", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingConfirmRequest());

  const missingItem = await executeCreateBooking({
    payload: basePayload({ itemId: "" }),
    executionContext: baseExecutionContext(fake.db),
  });
  assert.equal(missingItem.ok, false);
  assert.equal(missingItem.reason, "MISSING_ITEM_ID");

  const missingDuration = await executeCreateBooking({
    payload: basePayload({ durationDays: null }),
    executionContext: baseExecutionContext(fake.db),
  });
  assert.equal(missingDuration.ok, false);
  assert.equal(missingDuration.reason, "MISSING_DURATION");

  const itemMismatch = await executeCreateBooking({
    payload: basePayload({ itemId: "corolla-1" }),
    executionContext: baseExecutionContext(fake.db),
  });
  assert.equal(itemMismatch.ok, false);
  assert.equal(itemMismatch.reason, "AVAILABILITY_ITEM_MISMATCH");

  const durationMismatch = await executeCreateBooking({
    payload: basePayload({ durationDays: 5 }),
    executionContext: baseExecutionContext(fake.db),
  });
  assert.equal(durationMismatch.ok, false);
  assert.equal(durationMismatch.reason, "AVAILABILITY_DURATION_MISMATCH");
});

test("does not affect normal booking creation without availabilityRequestId", async () => {
  const fake = createFakeDb();

  const result = await executeCreateBooking({
    payload: {
      itemId: ITEM_ID,
      itemName: "Honda Civic",
      durationDays: 1,
      sourceMessage: "Honda Civic 1 din k lye book karni hai",
    },
    executionContext: {
      businessId: BUSINESS_ID,
      traceId: "normal-booking-no-avr",
      dbOverride: fake.db,
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.booking);
  assert.equal(result.booking.status, "pending_approval");
  assert.notEqual(result.booking.approvalStage, "owner_approved_waiting_customer_details");
});

test("availability-confirm booking is created as approved with waiting customer details stage", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingConfirmRequest());

  const result = await executeCreateBooking({
    payload: basePayload({
      approvalStage: "owner_approved_waiting_customer_details",
      dmTargetSource: "availability_confirm_dm",
      dmTargetPhone: CUSTOMER_PHONE,
      canDmCustomer: true,
    }),
    executionContext: {
      ...baseExecutionContext(fake.db),
      dmTargetSource: "availability_confirm_dm",
      canDmCustomer: true,
      availabilityRequestId: REQUEST_ID,
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.booking);
  assert.equal(result.booking.status, "approved");
  assert.equal(result.booking.approvalStage, "owner_approved_waiting_customer_details");
  assert.equal(result.booking.availabilityRequestId, REQUEST_ID);
  assert.equal(result.booking.dmTargetSource, "availability_confirm_dm");
});

test("owner_approved stage alone without confirm markers stays pending_approval", async () => {
  const fake = createFakeDb();

  const result = await executeCreateBooking({
    payload: {
      itemId: ITEM_ID,
      itemName: "Honda Civic",
      durationDays: 1,
      approvalStage: "owner_approved_waiting_customer_details",
      sourceMessage: "generic booking should stay pending",
    },
    executionContext: {
      businessId: BUSINESS_ID,
      traceId: "stage-only-no-confirm-markers",
      dbOverride: fake.db,
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.booking);
  assert.equal(result.booking.status, "pending_approval");
  assert.equal(result.booking.approvalStage, "owner_approved_waiting_customer_details");
});
