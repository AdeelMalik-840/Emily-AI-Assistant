import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleWhatsAppNotificationStatuses,
  markBookingNotificationFailed,
  markBookingNotificationProviderAccepted,
} from "../src/services/bookingNotificationState.js";

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

async function seedBooking(db, bookingId, data = {}) {
  await db
    .collection("businesses")
    .doc("u1")
    .collection("bookings")
    .doc(bookingId)
    .set(data);
}

async function getBooking(db, bookingId) {
  const snap = await db
    .collection("businesses")
    .doc("u1")
    .collection("bookings")
    .doc(bookingId)
    .get();
  return snap.data();
}

test("send success sets sent_to_provider, not final delivered", async () => {
  const db = new FakeDb();
  await seedBooking(db, "b1");

  await markBookingNotificationProviderAccepted({
    db,
    userId: "u1",
    bookingId: "b1",
    providerMessageId: "wamid.ok",
  });

  const booking = await getBooking(db, "b1");
  assert.equal(booking.notificationStatus, "sent_to_provider");
  assert.equal(booking.notificationSent, false);
  assert.equal(booking.providerMessageId, "wamid.ok");
});

test("failed webhook sets failed", async () => {
  const db = new FakeDb();
  await seedBooking(db, "b2", { providerMessageId: "wamid.fail" });

  await handleWhatsAppNotificationStatuses({
    db,
    userId: "u1",
    statuses: [
      {
        id: "wamid.fail",
        status: "failed",
        errors: [{ message: "recipient unavailable" }],
      },
    ],
  });

  const booking = await getBooking(db, "b2");
  assert.equal(booking.notificationStatus, "failed");
  assert.equal(booking.notificationSent, false);
  assert.equal(booking.notificationError, "recipient unavailable");
});

test("delivered webhook sets delivered", async () => {
  const db = new FakeDb();
  await seedBooking(db, "b3", { providerMessageId: "wamid.sent" });

  await handleWhatsAppNotificationStatuses({
    db,
    userId: "u1",
    statuses: [{ id: "wamid.sent", status: "sent" }],
  });

  const booking = await getBooking(db, "b3");
  assert.equal(booking.notificationStatus, "delivered");
  assert.equal(booking.notificationSent, true);
});

test("send throw sets failed", async () => {
  const db = new FakeDb();
  await seedBooking(db, "b4");

  await markBookingNotificationFailed({
    db,
    userId: "u1",
    bookingId: "b4",
    notificationError: "network timeout",
  });

  const booking = await getBooking(db, "b4");
  assert.equal(booking.notificationStatus, "failed");
  assert.equal(booking.notificationSent, false);
  assert.equal(booking.notificationError, "network timeout");
});
