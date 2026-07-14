import test from "node:test";
import assert from "node:assert/strict";
import {
  extractAvailabilityDeliveryErrorFields,
  handleAvailabilityCustomerNotificationStatuses,
  normalizeAvailabilityCustomerDeliveryStatus,
  stringifyWhatsAppStatusesForLog,
} from "../src/services/availabilityCustomerNotificationDeliveryStatus.js";

const BUSINESS_ID = "biz-delivery-1";

class FakeDoc {
  constructor(store, path) {
    this.store = store;
    this.path = path;
    this.id = path.split("/").pop();
  }

  collection(name) {
    return new FakeCollection(this.store, `${this.path}/${name}`);
  }

  async set(data) {
    this.store.set(this.path, { ...(data || {}) });
  }

  async update(data) {
    const prev = this.store.get(this.path) || {};
    this.store.set(this.path, { ...prev, ...(data || {}) });
  }

  async get() {
    const data = this.store.get(this.path);
    return {
      exists: data != null,
      id: this.id,
      data: () => ({ ...(data || {}) }),
    };
  }
}

class FakeCollection {
  constructor(store, path) {
    this.store = store;
    this.path = path;
    this.filters = [];
    this.limitCount = Infinity;
  }

  doc(id) {
    return new FakeDoc(this.store, `${this.path}/${id}`);
  }

  where(field, op, value) {
    const next = new FakeCollection(this.store, this.path);
    next.filters = [...this.filters, { field, op, value }];
    next.limitCount = this.limitCount;
    return next;
  }

  limit(count) {
    const next = new FakeCollection(this.store, this.path);
    next.filters = [...this.filters];
    next.limitCount = count;
    return next;
  }

  async get() {
    const prefix = `${this.path}/`;
    const docs = [];
    for (const [path, data] of this.store.entries()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      const matches = this.filters.every(
        (filter) => filter.op === "==" && data?.[filter.field] === filter.value
      );
      if (!matches) continue;
      docs.push({
        id: rest,
        ref: new FakeDoc(this.store, `${this.path}/${rest}`),
        data: () => ({ ...(data || {}) }),
      });
      if (docs.length >= this.limitCount) break;
    }
    return {
      empty: docs.length === 0,
      docs,
    };
  }
}

class FakeDb {
  constructor() {
    this.store = new Map();
  }

  collection(name) {
    return new FakeCollection(this.store, name);
  }
}

async function seedAvr(db, requestId, data = {}) {
  await db
    .collection("businesses")
    .doc(BUSINESS_ID)
    .collection("availabilityRequests")
    .doc(requestId)
    .set({
      requestId,
      businessId: BUSINESS_ID,
      approvalCustomerNotificationStatus: "sent",
      approvalCustomerNotificationMethod: "cloud_api",
      customerDeliveryStatus: "pending",
      ...data,
    });
}

async function getAvr(db, requestId) {
  const snap = await db
    .collection("businesses")
    .doc(BUSINESS_ID)
    .collection("availabilityRequests")
    .doc(requestId)
    .get();
  return snap.data();
}

test("normalize preserves sent/delivered/read/failed", () => {
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("sent"), "sent");
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("delivered"), "delivered");
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("read"), "read");
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("failed"), "failed");
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("queued"), "");
});

test("extractAvailabilityDeliveryErrorFields captures code/title/message/details", () => {
  const fields = extractAvailabilityDeliveryErrorFields({
    errors: [
      {
        code: 131026,
        title: "Message undeliverable",
        message: "Message Undeliverable.",
        error_data: { details: "Message Undeliverable" },
      },
    ],
  });
  assert.equal(fields.customerDeliveryErrorCode, "131026");
  assert.equal(fields.customerDeliveryErrorTitle, "Message undeliverable");
  assert.equal(fields.customerDeliveryErrorMessage, "Message Undeliverable.");
  assert.equal(fields.customerDeliveryErrorDetails, "Message Undeliverable");
});

test("stringifyWhatsAppStatusesForLog expands nested errors (no [Object])", () => {
  const text = stringifyWhatsAppStatusesForLog([
    {
      id: "wamid.x",
      status: "failed",
      errors: [{ code: 131026, title: "Message undeliverable" }],
    },
  ]);
  assert.match(text, /131026/);
  assert.match(text, /Message undeliverable/);
  assert.equal(text.includes("[Object]"), false);
});

test("1. customer provider wamid failed → customerDeliveryStatus failed + error fields", async () => {
  const db = new FakeDb();
  await seedAvr(db, "avr_fail", {
    approvalCustomerNotificationProviderMessageId: "wamid.customer.fail",
  });

  const result = await handleAvailabilityCustomerNotificationStatuses({
    db,
    businessId: BUSINESS_ID,
    statuses: [
      {
        id: "wamid.customer.fail",
        status: "failed",
        timestamp: "1783943409",
        recipient_id: "905443829990",
        recipient_user_id: "uid-meta-1",
        errors: [
          {
            code: 131026,
            title: "Message undeliverable",
            message: "Message Undeliverable.",
            error_data: { details: "Message Undeliverable" },
          },
        ],
      },
    ],
  });

  assert.equal(result.handled, 1);
  const stored = await getAvr(db, "avr_fail");
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
  assert.equal(stored.customerDeliveryStatus, "failed");
  assert.equal(stored.customerDeliveryRecipientId, "905443829990");
  assert.equal(stored.customerDeliveryRecipientUserId, "uid-meta-1");
  assert.equal(stored.customerDeliveryErrorCode, "131026");
  assert.equal(stored.customerDeliveryErrorTitle, "Message undeliverable");
  assert.equal(stored.customerDeliveryErrorMessage, "Message Undeliverable.");
  assert.equal(stored.customerDeliveryErrorDetails, "Message Undeliverable");
  assert.ok(stored.customerDeliveryWebhookAt);
  assert.ok(stored.customerDeliveryTimestamp);
});

test("2. customer provider wamid delivered → customerDeliveryStatus delivered", async () => {
  const db = new FakeDb();
  await seedAvr(db, "avr_ok", {
    approvalCustomerNotificationProviderMessageId: "wamid.customer.ok",
    customerDeliveryStatus: "pending",
  });

  const result = await handleAvailabilityCustomerNotificationStatuses({
    db,
    businessId: BUSINESS_ID,
    statuses: [
      {
        id: "wamid.customer.ok",
        status: "delivered",
        timestamp: "1783943500",
        recipient_id: "923365149142",
      },
    ],
  });

  assert.equal(result.handled, 1);
  const stored = await getAvr(db, "avr_ok");
  assert.equal(stored.customerDeliveryStatus, "delivered");
  assert.equal(stored.customerDeliveryErrorCode, null);
  assert.equal(stored.approvalCustomerNotificationStatus, "sent");
});

test("3. owner provider wamid delivered → does not mutate customerDeliveryStatus", async () => {
  const db = new FakeDb();
  await seedAvr(db, "avr_owner", {
    ownerNotificationProviderMessageId: "wamid.owner.only",
    approvalCustomerNotificationProviderMessageId: "wamid.customer.other",
    customerDeliveryStatus: "pending",
  });

  const result = await handleAvailabilityCustomerNotificationStatuses({
    db,
    businessId: BUSINESS_ID,
    statuses: [{ id: "wamid.owner.only", status: "delivered" }],
  });

  assert.equal(result.handled, 0);
  assert.equal(result.ownerMatched, 1);
  const stored = await getAvr(db, "avr_owner");
  assert.equal(stored.customerDeliveryStatus, "pending");
  assert.equal(stored.customerDeliveryWebhookAt, undefined);
});

test("4. unknown wamid → log only, no crash", async () => {
  const db = new FakeDb();
  await seedAvr(db, "avr_other", {
    approvalCustomerNotificationProviderMessageId: "wamid.known",
    customerDeliveryStatus: "pending",
  });

  const result = await handleAvailabilityCustomerNotificationStatuses({
    db,
    businessId: BUSINESS_ID,
    statuses: [{ id: "wamid.unknown", status: "failed" }],
  });

  assert.equal(result.handled, 0);
  assert.equal(result.unknown, 1);
  const stored = await getAvr(db, "avr_other");
  assert.equal(stored.customerDeliveryStatus, "pending");
});

test("5. customer sent status writes customerDeliveryStatus=sent (not collapsed)", async () => {
  const db = new FakeDb();
  await seedAvr(db, "avr_sent", {
    approvalCustomerNotificationProviderMessageId: "wamid.sent",
    customerDeliveryStatus: "pending",
  });

  await handleAvailabilityCustomerNotificationStatuses({
    db,
    businessId: BUSINESS_ID,
    statuses: [{ id: "wamid.sent", status: "sent", recipient_id: "905443829990" }],
  });

  const stored = await getAvr(db, "avr_sent");
  assert.equal(stored.customerDeliveryStatus, "sent");
});

test("6. API 200 path still uses sent + pending delivery (cloud notify contract)", async () => {
  // Contract reminder: approvalCustomerNotificationStatus remains sent;
  // customerDeliveryStatus starts pending until webhook. Covered in cloud-notify suite.
  assert.equal(normalizeAvailabilityCustomerDeliveryStatus("pending"), "");
});
